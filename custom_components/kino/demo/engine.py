"""
The demo replay engine.

It sequences clips; it does not drive hardware. Everything it needs from the
room arrives through :class:`DemoRuntime` - one narrow port, exactly like the
device drivers' `Bridge` - so the sequencing (lead-in padding, predictive
stop scheduling, gap gating, A/B ordering) is unit-testable against an
in-memory fake with no Home Assistant and no cinema attached (NFR-6).

Two behaviours are worth naming, because they are the reason this is an
engine and not a for-loop:

*Lead-in padding* (spec 4.1). The signal chain needs several seconds after a
seek before picture and sound are locked. Rather than shifting every stored
timestamp, the engine seeks to ``start - lead_in`` and lets the handshake burn
off, so the stored numbers always mark the artistic start and a change to the
chain is one setting, not a re-trim of every clip. A mid-stream track switch
makes the processor renegotiate and drop lock, so when a switch was actually
issued the lead-in is re-anchored to the switch, not to play-start.

*Predictive stop scheduling* (spec 4.2). Playback advances at 1x wall clock,
so each position poll yields ``predicted_end = now + (end - position)``. The
cut is scheduled for that instant instead of waiting to observe ``position >=
end``, which drops the error from the polling interval to command latency.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
from collections.abc import Coroutine, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from .model import ADVANCE_TAP, Clip, DemoSettings, Showcase, format_timecode

_LOGGER = logging.getLogger(__name__)

#: How often the position is sampled while a clip runs. The stop is scheduled
#: predictively, so this bounds the *prediction* refresh, not the cut error.
POLL_SECONDS = 0.5

#: The slate before the very first clip is short - the room is already waiting.
FIRST_SLATE_SECONDS = 3.0

#: How long a clip may overrun its predicted end before the engine stops
#: believing the player and cuts anyway.
OVERRUN_GRACE_SECONDS = 20.0

#: How long to wait for the player to actually start a file.
PLAY_START_TIMEOUT = 30.0

#: A/B: how long each side plays before the gap, when the clip is longer.
AB_MAX_SIDE_SECONDS = 45.0

#: How long a phase that waits for a person is allowed to stand.
IDLE_PARK_SECONDS = 3600.0


class DemoRuntime(Protocol):
    """Everything the engine needs from the room."""

    def now(self) -> float:
        """Return monotonic seconds, for scheduling."""

    def wall_ms(self) -> float:
        """Return wall-clock epoch milliseconds, for the UI's own countdowns."""

    async def ensure_activity(self) -> None:
        """Request the media activity and wait for the room to settle."""

    def has_file_open(self, clip: Clip) -> bool:
        """Return True when the player already has this clip's file open.

        The player knows its own resolved path and the clip knows the
        catalogue path, so the comparison belongs on that side of the port.
        """

    async def play_clip(self, clip: Clip) -> None:
        """Open the clip's file on the player."""

    async def wait_for_playing(self, timeout: float) -> bool:
        """Wait for a confirmed playing state."""

    async def apply_tracks(
        self, audio: str | None, subtitle: str | None
    ) -> tuple[bool, str | None]:
        """Select tracks.

        Returns whether a switch was actually issued, and a complaint to show
        when a stored track could not be selected — never an exception: the
        clip still plays in whatever the file defaults to.
        """

    async def seek(self, seconds: float) -> None:
        """Jump the player to an absolute position."""

    def position(self) -> float | None:
        """Return the player's reported position in seconds, or None."""

    async def pause(self) -> None:
        """Hold playback."""

    async def resume(self) -> None:
        """Let playback continue."""

    async def stop_playback(self) -> None:
        """Close whatever the player has open."""

    def volume_db(self) -> float | None:
        """Return the reference level in dB, or None."""

    async def set_volume_db(self, db: float) -> None:
        """Set the reference level."""

    async def set_mute(self, muted: bool) -> None:
        """Mute or unmute."""

    def current_look(self) -> dict[str, Any]:
        """Return the Trinnov preset and the two profiles as they stand."""

    async def apply_look(self, look: Mapping[str, Any]) -> None:
        """Apply any of preset / madvr / barco that the mapping names."""

    def look_confirmed(self, look: Mapping[str, Any]) -> bool:
        """Return True once the hardware reports the requested look active."""

    def reported_audio_format(self) -> str | None:
        """Return what the chain says is arriving, for the pre-flight check."""

    def emit(self, data: Mapping[str, Any]) -> None:
        """Fire the demo-playback event."""

    def changed(self) -> None:
        """Signal that the runtime state moved and should be re-read."""


@dataclass
class _Run:
    """One demo in flight."""

    mode: str  # "showcase" | "ab"
    name: str
    clips: list[Clip]
    advance: str = "auto"
    gap_seconds: int = 8
    reference_volume_db: float | None = None
    index: int = 0
    phase: str = "slate"
    phase_started_ms: float = 0.0
    phase_ends_ms: float | None = None
    paused: bool = False
    warning: str | None = None
    #: A/B only, from here down.
    order: tuple[str, str] = ("A", "B")
    configs: Mapping[str, Any] = field(default_factory=dict)
    blind: bool = True
    side: int = 1
    winner: str | None = None
    picked_side: int | None = None
    reached_decide: bool = False


class DemoEngine:
    """Runs one showcase, one clip or one A/B comparison at a time."""

    def __init__(self, runtime: DemoRuntime, settings: DemoSettings) -> None:
        self._runtime = runtime
        self._settings = settings
        self._run: _Run | None = None
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._pending: str | None = None
        #: Volume / preset / profile as they were before the demo touched them.
        self._restore: dict[str, Any] | None = None

    def update_settings(self, settings: DemoSettings) -> None:
        """Adopt new install-wide settings for the next demo."""
        self._settings = settings

    @property
    def active(self) -> bool:
        """Return True while a demo is running."""
        return self._run is not None

    # -- starting -----------------------------------------------------------

    async def start_showcase(self, showcase: Showcase, clips: Sequence[Clip]) -> None:
        """Play a showcase, clip after clip."""
        if not clips:
            raise ValueError("Der Showcase enthält keine Clips.")
        await self._cancel()
        self._run = _Run(
            mode="showcase",
            name=showcase.name or "Showcase",
            clips=list(clips),
            advance=showcase.advance,
            gap_seconds=showcase.gap_seconds,
            reference_volume_db=showcase.reference_volume_db,
        )
        self._launch(self._run_showcase())

    async def start_clip(self, clip: Clip) -> None:
        """Play one clip on its own."""
        await self._cancel()
        self._run = _Run(
            mode="showcase",
            name=clip.name or "Einzelclip",
            clips=[clip],
            gap_seconds=3,
        )
        self._launch(self._run_showcase())

    async def start_ab(
        self,
        clip: Clip,
        config_a: Mapping[str, Any],
        config_b: Mapping[str, Any],
        blind: bool = True,
    ) -> None:
        """Play one clip twice, switching configuration in the gap (spec 5)."""
        await self._cancel()
        order: tuple[str, str] = ("A", "B")
        if blind and random.random() < 0.5:  # noqa: S311 - a coin toss, not a key
            order = ("B", "A")
        self._run = _Run(
            mode="ab",
            name=clip.name or "A/B",
            clips=[clip],
            gap_seconds=max(4, int(self._settings.confirm_timeout_seconds // 2)),
            order=order,
            configs={"A": dict(config_a), "B": dict(config_b)},
            blind=blind,
            phase="lead",
        )
        self._launch(self._run_ab())

    def _launch(self, coro: Coroutine[Any, Any, None]) -> None:
        self._pending = None
        self._wake.clear()
        self._task = asyncio.get_running_loop().create_task(coro)

    # -- controls -----------------------------------------------------------

    def control(self, action: str, index: int | None = None) -> None:
        """Queue a runtime control; the loop picks it up at its next wait."""
        if self._run is None:
            return
        if index is not None and action in ("jump", "pick", "replay-side"):
            self._pending = f"{action}:{index}"
        else:
            self._pending = action
        self._wake.set()

    async def stop(self) -> None:
        """End the demo and put the room back the way it was."""
        self.control("stop")
        await self._cancel()

    async def _cancel(self) -> None:
        task, self._task = self._task, None
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self._run is not None:
            await self._restore_room()
        self._run = None
        self._pending = None
        self._wake.clear()
        self._runtime.changed()

    def _take(self) -> str | None:
        command, self._pending = self._pending, None
        return command

    # -- the showcase loop --------------------------------------------------

    async def _run_showcase(self) -> None:
        run = self._run
        if run is None:
            return
        try:
            self._phase("preparing", None)
            await self._runtime.ensure_activity()
            self._remember_room()
            self._emit_playback("start")
            await self._showcase_loop(run)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # a failed demo must not take the room with it
            _LOGGER.exception("Demo abgebrochen")
            await self._park_on_error(err)
        finally:
            await self._finish()

    async def _showcase_loop(self, run: _Run) -> None:
        index = 0
        while 0 <= index < len(run.clips):
            run.index = index
            outcome = await self._play_clip(run, run.clips[index], first=index == 0)
            if outcome == "stop":
                return
            if outcome == "replay":
                continue
            if outcome and outcome.startswith("jump:"):
                index = self._clamp(int(outcome.split(":", 1)[1]), len(run.clips))
                continue
            index += 1

        self._phase("done", None)
        await self._runtime.pause()
        await self._restore_room()
        # Park on the summary until somebody closes it.
        while True:
            command = await self._wait(IDLE_PARK_SECONDS)
            if command in (None, "stop", "next", "skip"):
                return

    async def _play_clip(self, run: _Run, clip: Clip, first: bool) -> str | None:
        outcome = await self._slate(run, first=first)
        if outcome is not None:
            return outcome

        outcome = await self._arm(run, clip)
        if outcome is not None:
            return outcome

        command = await self._await_clip_end(clip)
        if command:
            return self._loop_outcome(command)
        await self._runtime.pause()
        return None

    async def _slate(self, run: _Run, first: bool) -> str | None:
        """Show what is coming next, and hold for the gap (spec 6)."""
        if run.advance == ADVANCE_TAP and not first:
            self._phase("wait", None)
            await self._runtime.pause()
            command = await self._wait(IDLE_PARK_SECONDS)
            return None if command in (None, "next") else self._loop_outcome(command)

        gap = FIRST_SLATE_SECONDS if first else float(run.gap_seconds)
        if gap <= 0:
            return None
        self._phase("slate", gap)
        if not first:
            await self._runtime.pause()
        command = await self._wait(gap)
        return self._loop_outcome(command) if command else None

    async def _arm(self, run: _Run, clip: Clip) -> str | None:
        """Open the file, set tracks and burn off the lead-in (spec 4.1)."""
        self._phase("leadin", None)
        await self._apply_overrides(run, clip)

        if self._needs_open(clip):
            await self._runtime.play_clip(clip)
            if not await self._runtime.wait_for_playing(PLAY_START_TIMEOUT):
                raise RuntimeError(
                    f"„{clip.name}“ konnte nicht gestartet werden — der Player "
                    "meldet keine Wiedergabe."
                )
        else:
            await self._runtime.resume()

        # A mid-stream switch to a different bitstream makes the processor
        # renegotiate and drop lock, so the lead-in is re-anchored to the
        # switch rather than to play-start. When the wanted tracks are already
        # active - the common case with a remux whose default is the lossless
        # track - nothing is issued and nothing is re-anchored.
        _, complaint = await self._runtime.apply_tracks(
            clip.audio_track, clip.subtitle_track
        )
        if complaint:
            self._warn(complaint)

        lead_in = float(self._settings.lead_in_seconds)
        await self._runtime.seek(max(0.0, clip.start_ms / 1000 - lead_in))
        if self._settings.mute_during_lead_in and lead_in > 0:
            await self._runtime.set_mute(True)

        self._preflight(clip)

        command = None
        if lead_in > 0:
            self._phase("leadin", lead_in)
            command = await self._wait(lead_in)

        if self._settings.mute_during_lead_in:
            await self._runtime.set_mute(False)
        return self._loop_outcome(command) if command else None

    def _loop_outcome(self, command: str) -> str | None:
        """Translate a control that arrived mid-clip into a loop outcome."""
        if command in ("skip", "next"):
            return None  # advance to the next clip
        if command in ("replay", "stop") or command.startswith("jump:"):
            return command
        return None

    async def _await_clip_end(self, clip: Clip) -> str | None:
        """Wait out the clip, scheduling the cut rather than observing it."""
        end_seconds = clip.end_ms / 1000
        deadline = self._runtime.now() + (
            clip.duration_ms / 1000 + OVERRUN_GRACE_SECONDS
        )
        while True:
            position = self._runtime.position()
            if position is None:
                # Nothing to predict from; fall back to plain polling.
                command = await self._wait(POLL_SECONDS)
                if command:
                    return command
                if self._runtime.now() > deadline:
                    return None
                continue

            remaining = end_seconds - position
            if remaining <= 0:
                return None
            self._phase_playing(remaining)
            if remaining <= POLL_SECONDS:
                # The scheduled instant: wait exactly that long, then cut.
                if self._settings.ramp_out:
                    await self._ramp_out()
                return await self._wait(remaining)
            command = await self._wait(POLL_SECONDS)
            if command:
                return command
            if self._runtime.now() > deadline:
                return None

    async def _ramp_out(self) -> None:
        """Soften a hard cut out of loud material (optional, spec 4.2)."""
        current = self._runtime.volume_db()
        if current is None:
            return
        try:
            await self._runtime.set_volume_db(current - 6.0)
        except Exception:  # noqa: BLE001 - cosmetic; never fail a clip for it
            _LOGGER.debug("Ausblenden fehlgeschlagen", exc_info=True)

    # -- the A/B loop -------------------------------------------------------

    async def _run_ab(self) -> None:
        run = self._run
        if run is None:
            return
        try:
            self._phase("preparing", None)
            await self._runtime.ensure_activity()
            self._remember_room()
            self._emit_playback("start")
            await self._ab_loop(run, run.clips[0])
        except asyncio.CancelledError:
            raise
        except Exception as err:
            _LOGGER.exception("A/B-Vergleich abgebrochen")
            await self._park_on_error(err)
        finally:
            await self._finish()

    async def _ab_loop(self, run: _Run, clip: Clip) -> None:
        side = 1
        while True:
            run.side = side
            outcome = await self._ab_side(run, clip, run.order[side - 1])
            if outcome is None and side == 1 and not run.reached_decide:
                # The gap: the B-side arms only once the gap has elapsed *and*
                # the hardware confirms the new configuration, so it does not
                # burn its lead-in on a processor that is still loading.
                outcome = await self._ab_gap(run, run.order[1])
                if outcome is None:
                    side = 2
                    continue
            if outcome is None:
                outcome = await self._ab_decide(run)

            if outcome == "stop":
                return
            if outcome.startswith("replay-side:"):
                side = int(outcome.split(":", 1)[1])
                continue
            if outcome.startswith("pick:"):
                self._record_verdict(run, int(outcome.split(":", 1)[1]))
                await self._wait(IDLE_PARK_SECONDS)
            return

    async def _ab_side(self, run: _Run, clip: Clip, letter: str) -> str | None:
        await self._runtime.apply_look(run.configs.get(letter, {}))

        if self._needs_open(clip):
            await self._runtime.play_clip(clip)
            if not await self._runtime.wait_for_playing(PLAY_START_TIMEOUT):
                raise RuntimeError(
                    f"„{clip.name}“ konnte nicht gestartet werden — der Player "
                    "meldet keine Wiedergabe."
                )
        else:
            await self._runtime.resume()
        _, complaint = await self._runtime.apply_tracks(
            clip.audio_track, clip.subtitle_track
        )
        if complaint:
            self._warn(complaint)

        lead_in = float(self._settings.lead_in_seconds)
        await self._runtime.seek(max(0.0, clip.start_ms / 1000 - lead_in))
        if lead_in > 0:
            self._phase("lead", lead_in)
            command = await self._wait(lead_in)
            if command:
                return self._ab_outcome(command, run)

        # A long clip is cut short for A/B: the point is the comparison, and
        # nobody holds three minutes of sound in their head anyway.
        end_ms = min(clip.end_ms, clip.start_ms + int(AB_MAX_SIDE_SECONDS * 1000))
        self._phase("play", None)
        command = await self._await_clip_end(
            Clip(id=clip.id, start_ms=clip.start_ms, end_ms=end_ms)
        )
        await self._runtime.pause()
        return self._ab_outcome(command, run) if command else None

    def _ab_outcome(self, command: str | None, run: _Run) -> str | None:
        if command in (None, "skip", "next"):
            return None
        if command == "replay":
            return f"replay-side:{run.side}"
        return command

    async def _ab_gap(self, run: _Run, letter: str) -> str | None:
        """Hold between the two sides until the hardware has caught up."""
        target = run.configs.get(letter, {})
        await self._runtime.apply_look(target)
        minimum = float(run.gap_seconds)
        timeout = float(self._settings.confirm_timeout_seconds)
        started = self._runtime.now()
        self._phase("gap", minimum)
        while True:
            elapsed = self._runtime.now() - started
            if elapsed >= minimum and self._runtime.look_confirmed(target):
                return None
            if elapsed >= timeout:
                # Never hang a demo on a confirmation that never comes.
                self._warn(
                    "Konfiguration nicht bestätigt — es wird trotzdem fortgefahren."
                )
                return None
            command = await self._wait(min(POLL_SECONDS, max(0.1, minimum - elapsed)))
            if command:
                return None if command in ("skip", "next") else command

    async def _ab_decide(self, run: _Run) -> str:
        run.reached_decide = True
        self._phase("decide", None)
        await self._runtime.pause()
        return await self._wait(IDLE_PARK_SECONDS) or "stop"

    def _record_verdict(self, run: _Run, side: int) -> None:
        run.picked_side = side
        run.winner = run.order[side - 1]
        run.phase = "result"
        run.phase_ends_ms = None
        run.phase_started_ms = self._runtime.wall_ms()
        self._runtime.changed()

    # -- room state ---------------------------------------------------------

    def _remember_room(self) -> None:
        self._restore = {
            "volume": self._runtime.volume_db(),
            "look": dict(self._runtime.current_look()),
        }

    async def _restore_room(self) -> None:
        """Put volume, preset and profile back the way they were (spec 4.2)."""
        restore, self._restore = self._restore, None
        if not restore:
            return
        try:
            if restore.get("volume") is not None:
                await self._runtime.set_volume_db(float(restore["volume"]))
            if restore.get("look"):
                await self._runtime.apply_look(restore["look"])
            await self._runtime.set_mute(False)
        except Exception:  # noqa: BLE001
            _LOGGER.warning("Zurücksetzen nach der Demo fehlgeschlagen", exc_info=True)

    async def _apply_overrides(self, run: _Run, clip: Clip) -> None:
        """Apply the reference level plus the clip's own offset, then the look."""
        if run.reference_volume_db is not None or clip.volume_offset_db is not None:
            base = run.reference_volume_db
            if base is None:
                base = self._runtime.volume_db() or 0.0
            try:
                await self._runtime.set_volume_db(
                    float(base) + (clip.volume_offset_db or 0.0)
                )
            except Exception:  # noqa: BLE001
                _LOGGER.warning("Lautstärke der Demo nicht gesetzt", exc_info=True)

        look = {
            key: value
            for key, value in (
                ("preset", clip.trinnov_preset),
                ("madvr", clip.madvr_profile),
                ("barco", clip.barco_profile),
            )
            if value
        }
        if not look:
            return
        await self._runtime.apply_look(look)
        # The same gate as the A/B gap: a preset still loading would eat the
        # clip's lead-in budget.
        timeout = float(self._settings.confirm_timeout_seconds)
        started = self._runtime.now()
        while not self._runtime.look_confirmed(look):
            if self._runtime.now() - started >= timeout:
                self._warn(
                    "Konfiguration nicht bestätigt — es wird trotzdem fortgefahren."
                )
                break
            if await self._wait(POLL_SECONDS):
                break

    def _preflight(self, clip: Clip) -> None:
        """Warn when what is arriving is not what the clip expects (spec 8)."""
        if not self._settings.preflight_format_check or not clip.expected_format:
            return
        reported = self._runtime.reported_audio_format()
        if reported and clip.expected_format.casefold() not in reported.casefold():
            self._warn(f"Erwartet {clip.expected_format}, gemeldet {reported}.")

    def _needs_open(self, clip: Clip) -> bool:
        return not self._runtime.has_file_open(clip)

    async def _park_on_error(self, err: Exception) -> None:
        if self._run is None:
            return
        self._run.warning = str(err)
        self._phase("error", None)
        await self._wait(IDLE_PARK_SECONDS)

    async def _finish(self) -> None:
        self._emit_playback("stop")
        await self._restore_room()
        self._run = None
        self._task = None
        self._pending = None
        self._wake.clear()
        self._runtime.changed()

    # -- waiting ------------------------------------------------------------

    async def _wait(self, seconds: float) -> str | None:
        """Sleep - unless a control command arrives first, or a pause holds."""
        remaining = max(0.0, seconds)
        while True:
            command = self._take()
            if command == "pause":
                await self._pause_now()
                continue
            if command == "resume":
                await self._resume_now(remaining)
                continue
            if command is not None:
                return command
            if self._run is not None and self._run.paused:
                await self._wake.wait()
                self._wake.clear()
                continue
            if remaining <= 0:
                return None
            started = self._runtime.now()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=remaining)
            except asyncio.TimeoutError:
                return None
            self._wake.clear()
            remaining = max(0.0, remaining - (self._runtime.now() - started))

    async def _pause_now(self) -> None:
        if self._run is None or self._run.paused:
            return
        self._run.paused = True
        self._run.phase_ends_ms = None
        await self._runtime.pause()
        self._runtime.changed()

    async def _resume_now(self, remaining: float) -> None:
        if self._run is None or not self._run.paused:
            return
        self._run.paused = False
        self._run.phase_started_ms = self._runtime.wall_ms()
        self._run.phase_ends_ms = (
            self._run.phase_started_ms + remaining * 1000 if remaining > 0 else None
        )
        if self._run.phase in ("playing", "play", "leadin", "lead"):
            await self._runtime.resume()
        self._runtime.changed()

    # -- state for the UI ---------------------------------------------------

    def _phase(self, phase: str, duration: float | None) -> None:
        run = self._run
        if run is None:
            return
        run.phase = phase
        run.phase_started_ms = self._runtime.wall_ms()
        run.phase_ends_ms = run.phase_started_ms + duration * 1000 if duration else None
        self._runtime.changed()

    def _phase_playing(self, remaining: float) -> None:
        """Refresh the predicted end, damped so it does not churn the UI."""
        run = self._run
        if run is None:
            return
        rounded = round((self._runtime.wall_ms() + remaining * 1000) / 1000) * 1000
        changed = run.phase != "playing"
        if changed:
            run.phase = "playing"
            run.phase_started_ms = self._runtime.wall_ms()
        if run.phase_ends_ms is None or abs(run.phase_ends_ms - rounded) >= 1000:
            run.phase_ends_ms = rounded
            changed = True
        if changed:
            self._runtime.changed()

    def _warn(self, message: str) -> None:
        if self._run is not None:
            self._run.warning = message
            self._runtime.changed()

    def _emit_playback(self, action: str) -> None:
        run = self._run
        clip = run.clips[run.index] if run and run.clips else None
        self._runtime.emit(
            {
                "action": action,
                # The marker every watch-history consumer filters on. A
                # showcase must never "watch" ten films (spec 4.4).
                "demo": True,
                "mode": run.mode if run else None,
                "showcase": run.name if run else None,
                "clip": clip.name if clip else None,
                "item_id": clip.item_id if clip else None,
            }
        )

    @staticmethod
    def _clamp(index: int, length: int) -> int:
        return max(0, min(length - 1, index))

    def state(self) -> dict[str, Any] | None:
        """Return what the card renders the runtime overlay from."""
        run = self._run
        if run is None:
            return None
        clip = run.clips[run.index] if run.index < len(run.clips) else None
        payload: dict[str, Any] = {
            "mode": run.mode,
            "name": run.name,
            "phase": run.phase,
            "index": run.index,
            "count": len(run.clips),
            "paused": run.paused,
            "warning": run.warning,
            "phaseStartedAt": run.phase_started_ms,
            "phaseEndsAt": run.phase_ends_ms,
            "advance": run.advance,
            "clip": clip.as_dict() if clip else None,
            "clips": [
                {
                    "id": c.id,
                    "name": c.name,
                    "duration": format_timecode(c.duration_ms),
                    "durationMs": c.duration_ms,
                }
                for c in run.clips
            ],
            "totalRemainingMs": self._remaining_ms(run),
        }
        if run.mode == "ab":
            payload.update(self._ab_state(run))
        return payload

    def _ab_state(self, run: _Run) -> dict[str, Any]:
        return {
            "side": run.side,
            "blind": run.blind,
            "order": list(run.order),
            "configs": {k: dict(v) for k, v in run.configs.items()},
            "winner": run.winner,
            "pickedSide": run.picked_side,
            # The running side's configuration is withheld while a blind
            # comparison is undecided - revealing it is the point of the
            # reveal.
            "currentConfig": None
            if run.blind and run.winner is None
            else dict(run.configs.get(run.order[run.side - 1], {})),
        }

    def _remaining_ms(self, run: _Run) -> int:
        """Return roughly what is left of the whole showcase, for the header."""
        if run.phase == "done":
            return 0
        total = 0
        for position, clip in enumerate(run.clips):
            if position < run.index:
                continue
            if position == run.index and run.phase_ends_ms and run.phase == "playing":
                total += max(0, int(run.phase_ends_ms - self._runtime.wall_ms()))
            else:
                total += clip.duration_ms + run.gap_seconds * 1000
        return total
