"""
The demo replay engine, against an in-memory room.

The fake runtime models the two things that actually matter for sequencing:
the player reports a position that advances by itself, and the processor
takes a moment to confirm a preset. Timings are scaled down so the whole
file runs in well under a second.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from custom_components.kino.demo import engine as engine_module
from custom_components.kino.demo.engine import DemoEngine
from custom_components.kino.demo.model import Clip, DemoSettings, Showcase


class FakeRuntime:
    """A room that answers instantly, and remembers what it was asked."""

    def __init__(self) -> None:
        self.clock = 0.0
        self.calls: list[str] = []
        self.opened: list[str] = []
        self.seeks: list[float] = []
        self.events: list[dict[str, Any]] = []
        self.looks: list[dict[str, Any]] = []
        self.volumes: list[float] = []
        self.tracks: list[tuple[str | None, str | None]] = []

        self.open_clip_id: str | None = None
        #: The position the player reports, in seconds. Advances by
        #: `position_step` on every read, which is what lets the engine's
        #: predictive stop converge without waiting in real time.
        self._position: float | None = None
        self.position_step = 1.0
        self.volume = -30.0
        self.look: dict[str, Any] = {"preset": "Kino Referenz"}
        #: Preset confirmation is refused this many times before it lands.
        self.confirm_after = 0
        self._confirm_calls = 0
        self.fail_play = False
        self.playing = False
        #: What `apply_tracks` complains about, if anything.
        self.track_complaint: str | None = None

    # -- clock --------------------------------------------------------------

    def now(self) -> float:
        return asyncio.get_running_loop().time()

    def wall_ms(self) -> float:
        return 1_700_000_000_000.0

    # -- activity and playback ---------------------------------------------

    async def ensure_activity(self) -> None:
        self.calls.append("ensure_activity")

    def has_file_open(self, clip: Clip) -> bool:
        return self.open_clip_id == clip.id

    async def play_clip(self, clip: Clip) -> None:
        if self.fail_play:
            self.playing = False
            return
        self.calls.append("play")
        self.opened.append(clip.id)
        self.open_clip_id = clip.id
        self.playing = True
        self._position = clip.start_ms / 1000

    async def wait_for_playing(self, timeout: float) -> bool:
        return self.playing

    async def apply_tracks(
        self, audio: str | None, subtitle: str | None
    ) -> tuple[bool, str | None]:
        self.tracks.append((audio, subtitle))
        if self.track_complaint:
            return False, self.track_complaint
        return bool(audio or subtitle), None

    async def seek(self, seconds: float) -> None:
        self.calls.append("seek")
        self.seeks.append(seconds)
        self._position = seconds

    def position(self) -> float | None:
        if self._position is None:
            return None
        current = self._position
        self._position = current + self.position_step
        return current

    async def pause(self) -> None:
        self.calls.append("pause")

    async def resume(self) -> None:
        self.calls.append("resume")

    async def stop_playback(self) -> None:
        self.calls.append("stop_playback")

    # -- sound --------------------------------------------------------------

    def volume_db(self) -> float | None:
        return self.volume

    async def set_volume_db(self, db: float) -> None:
        self.volume = db
        self.volumes.append(db)

    async def set_mute(self, muted: bool) -> None:
        self.calls.append(f"mute:{muted}")

    def reported_audio_format(self) -> str | None:
        return "DTS-HD MA 5.1"

    # -- look ---------------------------------------------------------------

    def current_look(self) -> dict[str, Any]:
        return dict(self.look)

    async def apply_look(self, look) -> None:
        self.looks.append(dict(look))
        self.look.update(look)

    def look_confirmed(self, look) -> bool:
        self._confirm_calls += 1
        return self._confirm_calls > self.confirm_after

    # -- plumbing -----------------------------------------------------------

    def emit(self, data) -> None:
        self.events.append(dict(data))

    def changed(self) -> None:
        pass


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    """Scale the engine's own waits down so tests run in milliseconds."""
    monkeypatch.setattr(engine_module, "POLL_SECONDS", 0.001)
    monkeypatch.setattr(engine_module, "FIRST_SLATE_SECONDS", 0.0)
    monkeypatch.setattr(engine_module, "IDLE_PARK_SECONDS", 0.05)
    monkeypatch.setattr(engine_module, "OVERRUN_GRACE_SECONDS", 0.5)


@pytest.fixture
def runtime() -> FakeRuntime:
    return FakeRuntime()


@pytest.fixture
def settings() -> DemoSettings:
    # No lead-in by default: the tests that care about it set their own.
    return DemoSettings(lead_in_seconds=0.0, confirm_timeout_seconds=0.05)


def make_clip(clip_id: str, start: int, end: int, **extra: Any) -> Clip:
    return Clip(
        id=clip_id,
        item_id=f"item-{clip_id}",
        path=f"/media/{clip_id}.mkv",
        title="Sturmwarnung",
        name=clip_id,
        start_ms=start,
        end_ms=end,
        **extra,
    )


async def drain(engine: DemoEngine, timeout: float = 2.0) -> None:
    """Wait for the engine's task to finish, failing loudly if it hangs."""
    deadline = asyncio.get_running_loop().time() + timeout
    while engine.active:
        if asyncio.get_running_loop().time() > deadline:
            await engine.stop()
            raise AssertionError("the demo never finished")
        await asyncio.sleep(0.005)


class TestShowcasePlayback:
    async def test_plays_every_clip_in_order(self, runtime, settings):
        clips = [make_clip("c1", 0, 2000), make_clip("c2", 10_000, 12_000)]
        engine = DemoEngine(runtime, settings)
        await engine.start_showcase(
            Showcase(id="s1", name="Gäste", gap_seconds=0), clips
        )
        await drain(engine)
        assert runtime.opened == ["c1", "c2"]

    async def test_requests_the_activity_before_touching_the_player(
        self, runtime, settings
    ):
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 1000))
        await drain(engine)
        assert runtime.calls[0] == "ensure_activity"

    async def test_seeks_the_lead_in_before_the_artistic_start(self, runtime):
        # The stored timestamp marks the artistic start; the engine starts
        # early so the HDMI handshake burns off before it arrives (spec 4.1).
        engine = DemoEngine(runtime, DemoSettings(lead_in_seconds=0.02))
        await engine.start_clip(make_clip("c1", 30_000, 32_000))
        await drain(engine)
        assert runtime.seeks[0] == pytest.approx(29.98)

    async def test_a_lead_in_never_seeks_before_the_file_starts(self, runtime):
        # A clip two seconds in cannot be given an eight-second run-up.
        engine = DemoEngine(runtime, DemoSettings(lead_in_seconds=8.0))
        await engine.start_clip(make_clip("c1", 2000, 4000))
        await asyncio.sleep(0.02)
        assert runtime.seeks[0] == 0.0
        await engine.stop()

    async def test_applies_the_clips_tracks(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(
            make_clip("c1", 0, 1000, audio_track="1: EN TrueHD", subtitle_track="Aus")
        )
        await drain(engine)
        assert runtime.tracks == [("1: EN TrueHD", "Aus")]

    async def test_a_track_the_player_refuses_warns_but_plays_on(
        self, runtime, settings
    ):
        # Found live: a stored label the player's list no longer offers used
        # to abort the whole showcase. The clip still plays, in whatever the
        # file defaults to; the complaint is shown, not thrown.
        runtime.track_complaint = "Tonspur „2: EN DTS“ bietet der Player nicht an"
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 2000, audio_track="2: EN DTS"))
        seen = None
        for _ in range(60):
            state = engine.state()
            if state and state["warning"]:
                seen = state["warning"]
                break
            await asyncio.sleep(0.005)
        await drain(engine)
        assert seen == "Tonspur „2: EN DTS“ bietet der Player nicht an"
        # It played anyway: the file was opened and the clip ran to its end.
        assert runtime.opened == ["c1"]
        assert "pause" in runtime.calls

    async def test_pauses_at_the_end_of_a_clip(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 2000))
        await drain(engine)
        assert "pause" in runtime.calls

    async def test_does_not_reopen_a_file_that_is_already_playing(
        self, runtime, settings
    ):
        clip = make_clip("c1", 0, 2000)
        runtime.open_clip_id = clip.id
        runtime.playing = True
        runtime._position = 0.0
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(clip)
        await drain(engine)
        assert runtime.opened == []
        assert "resume" in runtime.calls

    async def test_a_player_that_never_starts_is_reported_not_hung(
        self, runtime, settings
    ):
        runtime.fail_play = True
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 1000))
        await asyncio.sleep(0.02)
        state = engine.state()
        assert state is not None
        assert state["phase"] == "error"
        assert "konnte nicht gestartet werden" in state["warning"]
        await engine.stop()


class TestOverridesAndRestore:
    async def test_applies_the_reference_level_plus_the_clip_offset(
        self, runtime, settings
    ):
        engine = DemoEngine(runtime, settings)
        showcase = Showcase(
            id="s1", name="Bass", gap_seconds=0, reference_volume_db=-24.0
        )
        await engine.start_showcase(
            showcase, [make_clip("c1", 0, 1000, volume_offset_db=-2.0)]
        )
        await drain(engine)
        assert -26.0 in runtime.volumes

    async def test_puts_volume_and_look_back_afterwards(self, runtime, settings):
        runtime.volume = -30.0
        runtime.look = {"preset": "Kino Referenz"}
        engine = DemoEngine(runtime, settings)
        showcase = Showcase(
            id="s1", name="Bass", gap_seconds=0, reference_volume_db=-18.0
        )
        await engine.start_showcase(
            showcase, [make_clip("c1", 0, 1000, trinnov_preset="Nacht")]
        )
        await drain(engine)
        assert runtime.volume == -30.0
        assert runtime.look["preset"] == "Kino Referenz"

    async def test_proceeds_when_a_preset_is_never_confirmed(self, runtime):
        # A missed confirmation must warn, not hang (spec 5 gap gating).
        runtime.confirm_after = 10_000
        settings = DemoSettings(lead_in_seconds=0.0, confirm_timeout_seconds=0.01)
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 1000, trinnov_preset="Nacht"))
        await drain(engine)
        assert any(e["action"] == "stop" for e in runtime.events)


class TestWatchHistory:
    async def test_playback_is_marked_as_a_demo(self, runtime, settings):
        # A showcase must never "watch" ten films (spec 4.4).
        engine = DemoEngine(runtime, settings)
        await engine.start_clip(make_clip("c1", 0, 1000))
        await drain(engine)
        assert runtime.events
        assert all(event["demo"] is True for event in runtime.events)
        assert [e["action"] for e in runtime.events] == ["start", "stop"]


class TestRuntimeControls:
    async def test_skip_moves_to_the_next_clip(self, runtime, settings):
        clips = [make_clip("c1", 0, 60_000), make_clip("c2", 0, 1000)]
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0  # the first clip would otherwise run long
        await engine.start_showcase(Showcase(id="s", name="x", gap_seconds=0), clips)
        await asyncio.sleep(0.02)
        engine.control("skip")
        await asyncio.sleep(0.02)
        runtime.position_step = 1.0
        await drain(engine)
        assert runtime.opened == ["c1", "c2"]

    async def test_replay_starts_the_same_clip_again(self, runtime, settings):
        clip = make_clip("c1", 0, 60_000)
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0
        await engine.start_showcase(Showcase(id="s", name="x", gap_seconds=0), [clip])
        await asyncio.sleep(0.02)
        engine.control("replay")
        await asyncio.sleep(0.02)
        assert runtime.seeks.count(0.0) >= 2
        await engine.stop()

    async def test_jump_selects_a_clip_by_index(self, runtime, settings):
        clips = [
            make_clip("c1", 0, 60_000),
            make_clip("c2", 0, 60_000),
            make_clip("c3", 0, 1000),
        ]
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0
        await engine.start_showcase(Showcase(id="s", name="x", gap_seconds=0), clips)
        await asyncio.sleep(0.02)
        engine.control("jump", 2)
        await asyncio.sleep(0.02)
        assert runtime.opened[-1] == "c3"
        await engine.stop()

    async def test_stop_ends_the_demo_and_clears_the_state(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0
        await engine.start_clip(make_clip("c1", 0, 60_000))
        await asyncio.sleep(0.02)
        await engine.stop()
        assert not engine.active
        assert engine.state() is None

    async def test_pause_holds_and_resume_continues(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0
        await engine.start_clip(make_clip("c1", 0, 60_000))
        await asyncio.sleep(0.02)
        engine.control("pause")
        await asyncio.sleep(0.02)
        assert engine.state()["paused"] is True
        engine.control("resume")
        await asyncio.sleep(0.02)
        assert engine.state()["paused"] is False
        await engine.stop()

    async def test_tap_advance_waits_for_the_tap(self, runtime, settings):
        clips = [make_clip("c1", 0, 1000), make_clip("c2", 0, 1000)]
        engine = DemoEngine(runtime, settings)
        await engine.start_showcase(
            Showcase(id="s", name="x", advance="tap", gap_seconds=0), clips
        )
        await asyncio.sleep(0.03)
        assert engine.state()["phase"] == "wait"
        assert runtime.opened == ["c1"]
        engine.control("next")
        await drain(engine)
        assert runtime.opened == ["c1", "c2"]


class TestState:
    async def test_reports_the_position_in_the_showcase(self, runtime, settings):
        clips = [make_clip("c1", 0, 60_000), make_clip("c2", 0, 1000)]
        engine = DemoEngine(runtime, settings)
        runtime.position_step = 0.0
        await engine.start_showcase(Showcase(id="s", name="Gäste", gap_seconds=0), clips)
        await asyncio.sleep(0.02)
        state = engine.state()
        assert state["name"] == "Gäste"
        assert state["index"] == 0
        assert state["count"] == 2
        assert [c["name"] for c in state["clips"]] == ["c1", "c2"]
        await engine.stop()

    async def test_is_none_when_nothing_runs(self, runtime, settings):
        assert DemoEngine(runtime, settings).state() is None


class TestABComparison:
    async def test_plays_the_clip_twice_and_switches_configuration(
        self, runtime, settings
    ):
        engine = DemoEngine(runtime, settings)
        await engine.start_ab(
            make_clip("c1", 0, 1000),
            {"preset": "Kino Referenz"},
            {"preset": "Nacht"},
            blind=False,
        )
        await asyncio.sleep(0.15)
        applied = [look.get("preset") for look in runtime.looks]
        assert "Kino Referenz" in applied
        assert "Nacht" in applied
        # Both sides opened the same clip, once each.
        assert runtime.opened == ["c1"]
        await engine.stop()

    async def test_blind_hides_the_running_configuration(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        await engine.start_ab(
            make_clip("c1", 0, 1000), {"preset": "A"}, {"preset": "B"}, blind=True
        )
        await asyncio.sleep(0.02)
        assert engine.state()["currentConfig"] is None
        await engine.stop()

    async def test_a_pick_records_the_winner_and_reveals_the_order(
        self, runtime, settings
    ):
        engine = DemoEngine(runtime, settings)
        await engine.start_ab(
            make_clip("c1", 0, 1000), {"preset": "A"}, {"preset": "B"}, blind=True
        )
        await asyncio.sleep(0.02)
        engine.control("pick", 1)
        await asyncio.sleep(0.05)
        state = engine.state()
        assert state is not None
        assert state["winner"] == state["order"][0]
        assert state["currentConfig"] is not None
        await engine.stop()

    async def test_not_blind_names_the_running_configuration(self, runtime, settings):
        engine = DemoEngine(runtime, settings)
        await engine.start_ab(
            make_clip("c1", 0, 1000), {"preset": "A"}, {"preset": "B"}, blind=False
        )
        await asyncio.sleep(0.02)
        assert engine.state()["currentConfig"] == {"preset": "A"}
        await engine.stop()
