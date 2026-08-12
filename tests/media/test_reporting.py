"""Play-state reporting: start, cadence, pause, stop, and FR-49c."""

from __future__ import annotations

import pytest

from custom_components.kino.media.base import MediaBackendError
from custom_components.kino.media.reporting import PlaybackReporter


class FakeBackend:
    """Records report calls; can be told to fail the next one."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, float, bool | None]] = []
        self.fail_next = False

    def _record(self, kind: str, item_id: str, position: float, paused=None):
        if self.fail_next:
            self.fail_next = False
            raise MediaBackendError("Bibliothek nicht erreichbar")
        self.calls.append((kind, item_id, position, paused))

    async def report_start(self, item_id: str, *, position_seconds: float = 0.0):
        self._record("start", item_id, position_seconds)

    async def report_progress(
        self, item_id: str, *, position_seconds: float, paused: bool = False
    ):
        self._record("progress", item_id, position_seconds, paused)

    async def report_stop(self, item_id: str, *, position_seconds: float):
        self._record("stop", item_id, position_seconds)


class FakeTime:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def time() -> FakeTime:
    return FakeTime()


@pytest.fixture
def reporter(backend, time) -> PlaybackReporter:
    return PlaybackReporter(backend, time_fn=time)


def _kinds(backend: FakeBackend) -> list[str]:
    return [call[0] for call in backend.calls]


async def test_playback_start_opens_a_session(reporter, backend):
    await reporter.update(item_id="abc", state="playing", position=0.0)
    assert backend.calls == [("start", "abc", 0.0, None)]


async def test_start_carries_the_resume_position(reporter, backend):
    await reporter.update(item_id="abc", state="playing", position=1908.0)
    assert backend.calls == [("start", "abc", 1908.0, None)]


async def test_progress_follows_the_cadence_not_every_poll(reporter, backend, time):
    """FR-49: ~10s, like a real client — not one POST per coordinator poll."""
    await reporter.update(item_id="abc", state="playing", position=0.0)
    for seconds in (5.0, 9.0):
        time.now = seconds
        await reporter.update(item_id="abc", state="playing", position=seconds)
    assert _kinds(backend) == ["start"]

    time.now = 10.0
    await reporter.update(item_id="abc", state="playing", position=10.0)
    assert _kinds(backend) == ["start", "progress"]
    assert backend.calls[-1] == ("progress", "abc", 10.0, False)


async def test_pause_is_reported_immediately(reporter, backend, time):
    await reporter.update(item_id="abc", state="playing", position=0.0)
    time.now = 2.0
    await reporter.update(item_id="abc", state="paused", position=2.0)
    assert backend.calls[-1] == ("progress", "abc", 2.0, True)

    time.now = 3.0
    await reporter.update(item_id="abc", state="playing", position=2.0)
    assert backend.calls[-1] == ("progress", "abc", 2.0, False)


async def test_stop_closes_the_session_at_the_last_seen_position(
    reporter, backend, time
):
    await reporter.update(item_id="abc", state="playing", position=0.0)
    time.now = 30.0
    await reporter.update(item_id="abc", state="playing", position=30.0)

    # The player is idle again and no longer reports a position.
    time.now = 35.0
    await reporter.update(item_id=None, state="idle", position=None)

    assert backend.calls[-1] == ("stop", "abc", 30.0, None)


async def test_switching_titles_stops_the_old_session_first(reporter, backend, time):
    await reporter.update(item_id="abc", state="playing", position=100.0)
    time.now = 20.0
    await reporter.update(item_id="xyz", state="playing", position=0.0)

    assert _kinds(backend) == ["start", "stop", "start"]
    stop = backend.calls[1]
    assert stop[1] == "abc"
    assert stop[2] == pytest.approx(100.0)
    assert backend.calls[2][1] == "xyz"


async def test_unresolved_file_produces_no_session(reporter, backend):
    """FR-49c: no catalogue entry, no session — never a fabricated one."""
    await reporter.update(item_id=None, state="playing", position=12.0)
    assert backend.calls == []


async def test_a_failed_report_is_retried_on_the_next_observation(
    reporter, backend, time
):
    backend.fail_next = True
    await reporter.update(item_id="abc", state="playing", position=0.0)
    assert backend.calls == []  # swallowed, playback unaffected

    time.now = 1.0
    await reporter.update(item_id="abc", state="playing", position=1.0)
    assert _kinds(backend) == ["start"]


async def test_a_failed_stop_is_retried_not_lost(reporter, backend, time):
    await reporter.update(item_id="abc", state="playing", position=50.0)
    backend.fail_next = True
    await reporter.update(item_id=None, state="idle", position=None)
    assert _kinds(backend) == ["start"]

    await reporter.update(item_id=None, state="idle", position=None)
    assert backend.calls[-1] == ("stop", "abc", 50.0, None)


async def test_buffering_counts_as_an_open_session(reporter, backend):
    await reporter.update(item_id="abc", state="buffering", position=0.0)
    assert _kinds(backend) == ["start"]


async def test_nothing_is_reported_while_nothing_plays(reporter, backend):
    await reporter.update(item_id=None, state=None, position=None)
    await reporter.update(item_id=None, state="off", position=None)
    assert backend.calls == []
