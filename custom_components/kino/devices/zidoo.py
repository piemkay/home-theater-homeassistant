"""
Zidoo UHD8000 driver: power, transport, and audio/subtitle tracks.

Track lists come straight off the player and are exposed as live values —
no mirror helpers, no sync mutex, no fixed delays (FR-60). Note the player's
own quirk: ``getAudioList`` returns its entries under a ``subtitles`` key too.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, ClassVar
from urllib.parse import quote

from ..core.model import DeviceObservation, DeviceSpec, Power
from .base import EntityBackedDriver
from .bridge import Bridge

_LOGGER = logging.getLogger(__name__)

SUBTITLE_OFF_LABEL = "Aus"

_PLAYING_STATES = frozenset({"playing", "paused", "buffering"})

#: How long a just-issued seek outranks the player's own position report.
#: The upstream integration re-reads the position only on its poll, so for a
#: few seconds after a seek the entity still carries the old value — the
#: progress bar snapped back, and a second ⟲10 computed from that old value
#: landed where the first one already had (the volume double-tap bug, FR-64,
#: in transport form).
SEEK_CONFIRM_SECONDS = 10.0

#: A position report this much newer than the seek is the player speaking
#: for itself again — earlier ones may still predate the jump.
SEEK_REPORT_MARGIN_SECONDS = 2.0

#: The Zidoo integration routes `media_content_type: "file"` to the player's
#: ``ZidooFileControl/openFile`` endpoint, which takes the path as a *query
#: parameter that is never encoded for us*. An unencoded `#` — and the NFS
#: mount points are full of them — would truncate the URL at the fragment, so
#: the path has to arrive fully percent-encoded. Verified live against the
#: UHD8000.
MEDIA_TYPE_FILE = "file"


class ZidooDriver(EntityBackedDriver):
    """Media player: the Film activity's source and the Musik streamer."""

    required_entities = ("power", "media_player")
    entity_roles: ClassVar[dict[str, tuple[str, ...]]] = {
        "power": ("remote", "switch"),
        "media_player": ("media_player",),
        # The player exposes no track entities of its own, so these are
        # usually helpers an automation fills from the player's track list.
        "audio_select": ("select", "input_select"),
        "subtitle_select": ("select", "input_select"),
    }

    def __init__(self, bridge: Bridge, spec: DeviceSpec) -> None:
        super().__init__(bridge, spec)
        self._audio_tracks: list[dict[str, Any]] = []
        self._subtitle_tracks: list[dict[str, Any]] = []
        #: The position we last seeked to, trusted over the entity until the
        #: player reports a position of its own (see SEEK_CONFIRM_SECONDS).
        self._seek_position: float | None = None
        self._seek_monotonic: float = 0.0
        self._seek_wall: datetime | None = None

    async def observe(self) -> DeviceObservation:
        media = self.state_of("media_player")
        if media is None:
            return DeviceObservation(
                device=self.spec.key, power=Power.UNKNOWN, available=False
            )
        if media.state == "unavailable":
            return DeviceObservation(
                device=self.spec.key, power=Power.UNAVAILABLE, available=False
            )
        if media.state == "unknown":
            # A reconnecting integration reports "unknown" before it has
            # spoken to the player — that is not evidence the Zidoo is on.
            return DeviceObservation(device=self.spec.key, power=Power.UNKNOWN)
        power = Power.OFF if media.state in ("off", "standby") else Power.ON
        return DeviceObservation(
            device=self.spec.key,
            power=power,
            settings={"playing": media.state in _PLAYING_STATES},
        )

    async def start(self) -> None:
        await self.call("remote", "turn_on", role="power")

    async def stop(self) -> None:
        await self.call("remote", "turn_off", role="power")

    async def apply(self, settings: Mapping[str, Any]) -> None:
        for key, value in settings.items():
            if key == "audio_track":
                await self.select_audio_track(value)
            elif key == "subtitle_track":
                await self.select_subtitle_track(value)
            elif key != "playing":
                _LOGGER.debug("Zidoo: Einstellung '%s' ignoriert", key)

    async def stop_playback(self) -> None:
        media = self.state_of("media_player")
        if media is None or media.state not in _PLAYING_STATES:
            return
        await self.call("media_player", "media_stop", role="media_player")

    # -- media -------------------------------------------------------------

    def now_playing(self) -> dict[str, Any]:
        """Rich metadata for the detail view (FR-56)."""
        media = self.state_of("media_player")
        if media is None:
            return {}
        attributes = media.attributes
        payload = {
            "state": media.state,
            "title": attributes.get("media_title"),
            "duration": attributes.get("media_duration"),
            "position": attributes.get("media_position"),
            "position_updated_at": attributes.get("media_position_updated_at"),
            "image": attributes.get("entity_picture"),
            "imdb_id": attributes.get("media_imdb_id"),
            "tmdb_id": attributes.get("media_tmdb_id"),
            "uri": attributes.get("media_uri"),
            "video_format": attributes.get("media_video_format"),
            "audio_format": attributes.get("media_audio_format"),
            "tagline": attributes.get("media_tagline"),
        }
        pending = self._pending_position(payload["position_updated_at"])
        if pending is not None:
            payload["position"] = pending
            payload["position_updated_at"] = self._seek_wall
        return payload

    def _pending_position(self, reported_at: Any) -> float | None:
        """Return the seek target, until the player reports its own position."""
        if self._seek_position is None:
            return None
        if self.bridge.now() - self._seek_monotonic > SEEK_CONFIRM_SECONDS:
            self._seek_position = None
            return None
        reported = _as_datetime(reported_at)
        if (
            reported is not None
            and reported.tzinfo is not None
            and self._seek_wall is not None
            and (reported - self._seek_wall).total_seconds()
            > SEEK_REPORT_MARGIN_SECONDS
        ):
            # The player has re-read its position since the jump; its word wins.
            self._seek_position = None
            return None
        return self._seek_position

    async def async_media_command(self, service: str, **data: Any) -> None:
        if service == "media_seek" and "seek_position" in data:
            self._seek_position = float(data["seek_position"])
            self._seek_monotonic = self.bridge.now()
            self._seek_wall = datetime.now(timezone.utc)
        await self.call("media_player", service, role="media_player", data=data)

    # -- playback (FR-46, FR-54) -------------------------------------------

    @property
    def path_map(self) -> list[tuple[str, str]]:
        """Prefix rewrites from catalogue paths to what the player can open.

        Jellyfin and the Zidoo both see the same NAS share, but through
        different mount points — `/media/entertainment/…` against
        `/mnt/nfs/192.168.50.10#entertainment/…`. Longest prefix wins, so a
        specific rule can override a general one.
        """
        raw = self.spec.options.get("path_map") or {}
        if not isinstance(raw, Mapping):
            return []
        return sorted(
            ((str(k), str(v)) for k, v in raw.items()),
            key=lambda pair: len(pair[0]),
            reverse=True,
        )

    def resolve_path(self, path: str) -> str | None:
        """Translate a catalogue path, or None when no rule covers it."""
        rules = self.path_map
        if not rules:
            # Nothing configured: the mounts may well coincide, and trying is
            # more useful than refusing.
            return path
        for source, target in rules:
            if path.startswith(source):
                return f"{target}{path[len(source) :]}"
        return None

    async def play_path(self, path: str) -> None:
        """Open a file on the player by path (FR-54)."""
        target = self.resolve_path(path)
        if target is None:
            raise RuntimeError(
                f"{self.spec.name}: für den Pfad '{path}' ist keine Zuordnung "
                "hinterlegt — bitte im Kino-Panel unter Geräte eine "
                "Pfad-Zuordnung eintragen"
            )
        _LOGGER.debug("Zidoo spielt '%s' (aus '%s')", target, path)
        await self.call(
            "media_player",
            "play_media",
            role="media_player",
            data={
                "media_content_type": MEDIA_TYPE_FILE,
                "media_content_id": quote(target, safe=""),
            },
        )

    async def seek(self, seconds: float) -> None:
        await self.async_media_command("media_seek", seek_position=seconds)

    async def select_audio_track(self, label: str) -> None:
        await self._select_track("audio", label)

    async def select_subtitle_track(self, label: str) -> None:
        # FR-62's "Aus" is the player's own off entry — every real track list
        # carries one ("0: Off"), and the underlying select rejects a literal
        # "Aus". Translate it so a stored setting or an old automation that
        # still says "Aus" keeps working.
        if label == SUBTITLE_OFF_LABEL:
            label = self._subtitle_off_option() or label
        await self._select_track("subtitle", label)

    def _subtitle_off_option(self) -> str | None:
        state = self.state_of("subtitle_select")
        options = list(state.attributes.get("options") or []) if state else []
        return next(
            (o for o in options if str(o).strip().casefold().endswith("off")),
            None,
        )

    # -- helpers -------------------------------------------------------------

    async def _select_track(self, kind: str, label: str) -> None:
        role = f"{kind}_select"
        if self.entity(role):
            # `select` or `input_select` — the service name is the same, the
            # domain is not.
            await self.call(
                self.domain_of(role, "select"),
                "select_option",
                role=role,
                data={"option": label},
            )
            return
        raise RuntimeError(
            f"Zidoo: keine {kind}_select-Entity konfiguriert — "
            "Spurauswahl ist nicht verfügbar"
        )


def _as_datetime(value: Any) -> datetime | None:
    """Return a datetime from whatever the state machine carries — or None."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return None
    return None
