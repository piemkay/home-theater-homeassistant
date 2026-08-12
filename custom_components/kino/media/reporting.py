"""
Play-state reporting to the catalogue (FR-48, FR-49).

The Zidoo opens files it was handed by path and reports nothing to anyone.
This module closes the loop: whatever the room's media device is doing gets
reported to Jellyfin as a first-class session — start, progress, pause and
stop — so watch history, resume points and Jellystat see the Zidoo like any
other Jellyfin client (FR-48).

Only a *resolved* catalogue entry is ever reported. A file the catalogue
could not match produces no session at all, because a fabricated entry is
worse than a missing one (FR-49c).

No Home Assistant import, so the decision logic is unit-testable (NFR-6).
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from .base import MediaBackend, MediaBackendError

_LOGGER = logging.getLogger(__name__)

#: Player states that constitute an open session.
_ACTIVE_STATES = frozenset({"playing", "paused", "buffering"})

#: FR-49: frequent enough for Jellystat's session polling to sample it,
#: matching what real clients do. State changes report immediately.
PROGRESS_INTERVAL_SECONDS = 10.0


class PlaybackReporter:
    """Reconciles one reported session with observations of the player.

    Fed one observation per coordinator poll; decides which report the
    catalogue needs, if any. A failed report is logged and retried on the
    next observation — playback must never suffer for its bookkeeping.
    """

    def __init__(
        self,
        backend: MediaBackend,
        *,
        time_fn: Callable[[], float],
        progress_interval: float = PROGRESS_INTERVAL_SECONDS,
    ) -> None:
        self._backend = backend
        self._time = time_fn
        self._interval = progress_interval
        #: The item the open session belongs to, or None when no session is
        #: open. Survives a failed stop so the stop is retried, not lost.
        self._item_id: str | None = None
        self._paused = False
        self._last_report = 0.0
        self._last_position = 0.0

    async def update(
        self,
        *,
        item_id: str | None,
        state: str | None,
        position: float | None,
    ) -> None:
        """Reconcile the session with one observation of the player."""
        active = state in _ACTIVE_STATES
        try:
            if self._item_id is not None and (not active or item_id != self._item_id):
                # The film ended, or a different one is open: close the old
                # session at the last position it was seen at.
                await self._backend.report_stop(
                    self._item_id, position_seconds=self._last_position
                )
                self._item_id = None
            if not active or item_id is None:
                return

            paused = state == "paused"
            if position is not None:
                self._last_position = float(position)

            if self._item_id is None:
                await self._backend.report_start(
                    item_id, position_seconds=self._last_position
                )
                self._item_id = item_id
                self._paused = paused
                self._last_report = self._time()
            elif (
                paused != self._paused
                or self._time() - self._last_report >= self._interval
            ):
                await self._backend.report_progress(
                    item_id, position_seconds=self._last_position, paused=paused
                )
                self._paused = paused
                self._last_report = self._time()
        except MediaBackendError as err:
            _LOGGER.debug("Wiedergabemeldung an die Bibliothek fehlgeschlagen: %s", err)
