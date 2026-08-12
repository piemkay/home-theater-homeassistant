"""
`media_player.kino` — transport and volume through the standard interface.

Exposing the standard interface means the existing dashboard cards keep
working (FR-63, NFR-7) while the custom card gets its richer surface over
WebSocket.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from homeassistant.components.media_player import (
    MediaPlayerDeviceClass,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import KinoCoordinator, KinoRuntimeData
from .core.model import ActivityState
from .devices.trinnov import TrinnovDriver
from .devices.zidoo import ZidooDriver
from .entity import KinoEntity
from .http import async_artwork_url
from .media.base import Category, MediaBackendError, MediaItem, MediaQuery
from .media.naming import provider_ids_from_path, title_from_path
from .media.reporting import PlaybackReporter

_LOGGER = logging.getLogger(__name__)

#: `media_content_type` values that mean "this is already a player path, do
#: not look it up in the catalogue".
_PATH_MEDIA_TYPES = frozenset({"file", "path"})

#: How long to wait for the player to actually start before seeking to a
#: resume position. Long enough for a spun-down NAS disk, short enough that a
#: title that never starts does not hang the service call.
_PLAYBACK_START_TIMEOUT = 30.0

#: Below this, "resume" is not worth a seek — the player is already there.
_MIN_RESUME_SECONDS = 30.0

#: How long a catalogue lookup that *failed* is left alone before retrying.
_LOOKUP_RETRY_SECONDS = 60.0

_STATE_MAP = {
    "playing": MediaPlayerState.PLAYING,
    "paused": MediaPlayerState.PAUSED,
    "buffering": MediaPlayerState.BUFFERING,
    "idle": MediaPlayerState.IDLE,
    "on": MediaPlayerState.ON,
    "off": MediaPlayerState.OFF,
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    runtime: KinoRuntimeData = entry.runtime_data
    async_add_entities([KinoMediaPlayer(runtime.coordinator)])


class KinoMediaPlayer(KinoEntity, MediaPlayerEntity):
    """One player for the room: transport from the active media device."""

    _attr_translation_key = "kino"
    _attr_device_class = MediaPlayerDeviceClass.RECEIVER
    _attr_supported_features = (
        MediaPlayerEntityFeature.TURN_ON
        | MediaPlayerEntityFeature.TURN_OFF
        | MediaPlayerEntityFeature.PLAY
        | MediaPlayerEntityFeature.PAUSE
        | MediaPlayerEntityFeature.STOP
        | MediaPlayerEntityFeature.NEXT_TRACK
        | MediaPlayerEntityFeature.PREVIOUS_TRACK
        | MediaPlayerEntityFeature.SEEK
        | MediaPlayerEntityFeature.VOLUME_STEP
        | MediaPlayerEntityFeature.VOLUME_SET
        | MediaPlayerEntityFeature.VOLUME_MUTE
        | MediaPlayerEntityFeature.SELECT_SOURCE
        | MediaPlayerEntityFeature.PLAY_MEDIA
    )

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "player")
        #: The catalogue entry behind the file the player currently has open:
        #: ``{"uri", "id", "title"}``. The Zidoo only knows the path, so this
        #: is what supplies a poster and a title fit to read.
        self._playing: dict[str, Any] | None = None
        self._resolving: str | None = None
        self._lookup_failed_at: float = 0.0
        #: Reports Zidoo playback to Jellyfin as a real session (FR-48).
        self._reporter: PlaybackReporter | None = None
        self._report_task: asyncio.Task[None] | None = None

    # -- the device currently carrying media --------------------------------

    @property
    def _media_driver(self) -> ZidooDriver | None:
        # Read the engine rather than the coordinator's last poll: playback is
        # started right after a transition finishes, and one stale poll would
        # mean "this activity has no media player" a moment after it does.
        snapshot = self.coordinator.engine.snapshot()
        activity = self.coordinator.config.activities.get(snapshot.activity)
        if activity is None:
            return None
        for key in activity.devices:
            if not activity.requires(key):
                continue
            driver = self.coordinator.engine.drivers.get(key)
            if isinstance(driver, ZidooDriver):
                return driver
        return None

    @property
    def _volume_driver(self) -> TrinnovDriver | None:
        key = self.coordinator.config.volume_device
        driver = self.coordinator.engine.drivers.get(key) if key else None
        return driver if isinstance(driver, TrinnovDriver) else None

    # -- state --------------------------------------------------------------

    @property
    def state(self) -> MediaPlayerState | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
        if snapshot.state is ActivityState.OFF:
            return MediaPlayerState.OFF
        driver = self._media_driver
        if driver is not None:
            playing = driver.now_playing().get("state")
            if playing in _STATE_MAP:
                return _STATE_MAP[playing]
        return MediaPlayerState.ON

    @property
    def source_list(self) -> list[str]:
        return [a.name for a in self.coordinator.config.activities.values()]

    @property
    def source(self) -> str | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
        activity = self.coordinator.config.activities.get(snapshot.activity)
        return activity.name if activity else None

    async def async_select_source(self, source: str) -> None:
        key = self.coordinator.activity_by_name(source)
        if key is None:
            raise HomeAssistantError(f"Unbekannte Aktivität '{source}'")
        await self.coordinator.async_activate(key)
        await self.coordinator.async_apply_light_scene(key)

    # -- media metadata -----------------------------------------------------

    def _now(self) -> dict:
        driver = self._media_driver
        return driver.now_playing() if driver else {}

    def _catalogue_entry(self) -> dict[str, Any] | None:
        """Return the catalogue entry for whatever is open, if we know it."""
        playing = self._playing
        if playing is None or playing["uri"] != self._now().get("uri"):
            return None
        return playing

    @callback
    def _handle_coordinator_update(self) -> None:
        self._sync_catalogue_entry()
        self._report_playback()
        super()._handle_coordinator_update()

    @callback
    def _report_playback(self) -> None:
        """Report what the player is doing to the catalogue (FR-48, FR-49).

        One observation per coordinator poll; the reporter decides whether
        the catalogue needs to hear about it. Only a resolved catalogue
        entry is reported — a file the library could not match produces no
        session at all (FR-49c).
        """
        media = self.coordinator.media
        if media is None:
            return
        if self._reporter is None:
            self._reporter = PlaybackReporter(media, time_fn=self.hass.loop.time)
        if self._report_task is not None and not self._report_task.done():
            # The previous report is still on the wire; this poll's
            # observation is not worth queueing behind it.
            return
        now = self._now()
        entry = self._catalogue_entry()
        self._report_task = self.hass.async_create_task(
            self._reporter.update(
                item_id=(entry or {}).get("id"),
                state=now.get("state"),
                position=now.get("position"),
            )
        )

    def _sync_catalogue_entry(self) -> None:
        """Look the open file up in the catalogue when it changes.

        A title started from the card comes with its entry attached. One
        started on the player's own remote — or before a restart — arrives as
        a bare path, and this is what turns it back into a poster and a name.
        """
        uri = self._now().get("uri")
        if not uri:
            self._playing = None
            self.coordinator.playing_item = None
            return
        if (self._playing and self._playing["uri"] == uri) or self._resolving == uri:
            return
        if self.coordinator.media is None:
            return
        if self.hass.loop.time() - self._lookup_failed_at < _LOOKUP_RETRY_SECONDS:
            return
        self._resolving = uri
        self.hass.async_create_task(self._async_resolve(uri))

    async def _async_resolve(self, uri: str) -> None:
        try:
            item = await self._lookup(uri)
        except MediaBackendError as err:
            # A catalogue that is briefly unreachable — a DNS blip is enough —
            # is not an answer. Recording it as "no match" would cost the
            # poster until the film changes, so try again shortly instead.
            _LOGGER.debug("Titel zu '%s' nicht auflösbar: %s", uri, err)
            self._lookup_failed_at = self.hass.loop.time()
            return
        finally:
            self._resolving = None
        # A real "nothing matched" *is* recorded, so one unmatched file does
        # not re-query the catalogue on every poll.
        self._playing = {
            "uri": uri,
            "id": item.id if item else None,
            "title": item.title if item else None,
        }
        self.coordinator.playing_item = self._playing
        self.async_write_ha_state()

    async def _lookup(self, uri: str) -> MediaItem | None:
        media = self.coordinator.media
        title = title_from_path(uri)
        if media is None or not title:
            return None
        wanted = provider_ids_from_path(uri)

        candidates: list[MediaItem] = []
        for category in (Category.MOVIES, Category.SHOWS):
            page = await media.search(
                MediaQuery(category=category, search=title, limit=10)
            )
            candidates.extend(page.items)
            if candidates and wanted:
                break

        for item in candidates:
            if any(item.provider_ids.get(k) == v for k, v in wanted.items()):
                return item
        # Without a provider ID, only an exact title counts. A near-miss puts
        # the wrong poster on the screen, which is worse than no poster.
        return next(
            (i for i in candidates if i.title.casefold() == title.casefold()), None
        )

    @property
    def media_title(self) -> str | None:
        entry = self._catalogue_entry()
        if entry and entry["title"]:
            return entry["title"]
        return self._now().get("title")

    @property
    def media_duration(self) -> int | None:
        return self._now().get("duration")

    @property
    def media_position(self) -> int | None:
        return self._now().get("position")

    @property
    def media_position_updated_at(self) -> datetime | None:
        return self._now().get("position_updated_at")

    @property
    def media_image_url(self) -> str | None:
        now = self._now()
        entry = self._catalogue_entry()
        item_id = now.get("jellyfin_id") or (entry or {}).get("id")
        if item_id and self.coordinator.media is not None:
            return async_artwork_url(self.hass, str(item_id), "Primary")
        return now.get("image")

    @property
    def extra_state_attributes(self) -> dict:
        now = self._now()
        return {
            key: now[key]
            for key in ("imdb_id", "tmdb_id", "video_format", "audio_format", "tagline")
            if now.get(key)
        }

    # -- transport ----------------------------------------------------------

    async def _media(self, service: str, **data: Any) -> None:
        driver = self._media_driver
        if driver is None:
            raise HomeAssistantError(
                "Die aktuelle Aktivität hat keine Medienwiedergabe"
            )
        await driver.async_media_command(service, **data)

    async def async_media_play(self) -> None:
        await self._media("media_play")

    async def async_media_pause(self) -> None:
        await self._media("media_pause")

    async def async_media_stop(self) -> None:
        await self._media("media_stop")
        self._playing = None
        self.coordinator.playing_item = None

    async def async_media_next_track(self) -> None:
        await self._media("media_next_track")

    async def async_media_previous_track(self) -> None:
        await self._media("media_previous_track")

    async def async_media_seek(self, position: float) -> None:
        await self._media("media_seek", seek_position=position)
        # The driver now carries the target as a pending position; publish it
        # at once so the next ⟲10/10⟳ computes from where this one landed
        # instead of from the player's not-yet-updated report.
        self.async_write_ha_state()

    # -- playback (FR-54, FR-55) --------------------------------------------

    async def async_play_media(
        self, media_type: str, media_id: str, **kwargs: Any
    ) -> None:
        """
        Play a catalogue entry — starting the activity first if need be.

        FR-55: picking a title while the media activity is not running is one
        user action, not two. The activity is started here and the file is
        only opened once the room has actually settled, so the play does not
        land on a player that is still powering up.
        """
        if media_type in _PATH_MEDIA_TYPES or media_id.startswith("/"):
            item = None
            path = media_id
        else:
            item = await self._resolve_item(media_id)
            if not item.path:
                raise HomeAssistantError(
                    f"'{item.title}' hat keinen Dateipfad in der Bibliothek "
                    "und kann nicht abgespielt werden"
                )
            path = item.path

        if item is not None:
            # The queued title stays on screen (F5): the card reads this out
            # of the state payload for as long as the start-then-play arc
            # runs, so the ~1 min transition never loses its subject.
            self.coordinator.pending_item = {"id": item.id, "title": item.title}
        try:
            await self._ensure_media_activity()

            driver = self._media_driver
            if driver is None:
                raise HomeAssistantError(
                    "Die aktuelle Aktivität hat keine Medienwiedergabe"
                )

            await driver.play_path(path)
            # Started from the card, so the catalogue entry needs no looking up.
            self._playing = {
                "uri": driver.resolve_path(path) or path,
                "id": item.id if item else None,
                "title": item.title if item else None,
            }
            self.async_write_ha_state()

            extra = kwargs.get("extra") or {}
            if item is not None and extra.get("resume", True):
                await self._resume_at(driver, item)
        finally:
            self.coordinator.pending_item = None

        await self.coordinator.async_request_refresh()

    async def _resolve_item(self, media_id: str) -> MediaItem:
        media = self.coordinator.media
        if media is None:
            raise HomeAssistantError("Keine Bibliothek verbunden")
        try:
            item = await media.item(media_id)
        except MediaBackendError as err:
            raise HomeAssistantError(str(err)) from err
        if item is None:
            raise HomeAssistantError(
                f"Der Titel {media_id} ist nicht (mehr) in der Bibliothek"
            )
        return item

    async def _ensure_media_activity(self) -> None:
        """Make sure a media-capable activity is running, and wait for it."""
        engine = self.coordinator.engine
        config = self.coordinator.config
        snapshot = engine.snapshot()
        activity = config.activities.get(snapshot.activity)

        if activity is None or not activity.media or self._media_driver is None:
            key = next((k for k, a in config.activities.items() if a.media), None)
            if key is None:
                raise HomeAssistantError(
                    "Keine Aktivität mit einer Medienquelle konfiguriert"
                )
            await self.coordinator.async_activate(key)
            await self.coordinator.async_apply_light_scene(key)

        await engine.wait_for_transition()

        snapshot = engine.snapshot()
        if snapshot.state is ActivityState.ERROR:
            raise HomeAssistantError(
                snapshot.last_error or "Die Aktivität konnte nicht gestartet werden"
            )

    async def _resume_at(self, driver: ZidooDriver, item: MediaItem) -> None:
        """Seek to the position Jellyfin remembers (FR-49a, FR-49b).

        Jellyfin is the system of record for how far a title was watched, so
        the position travels with the catalogue entry rather than with the
        player that happens to open the file.
        """
        seconds = item.resume_seconds or 0.0
        if seconds < _MIN_RESUME_SECONDS:
            return
        if not await self._wait_for_playback(driver):
            _LOGGER.debug(
                "Wiedergabe von '%s' hat nicht rechtzeitig begonnen — "
                "keine Fortsetzung gesetzt",
                item.title,
            )
            return
        await driver.seek(seconds)

    async def _wait_for_playback(self, driver: ZidooDriver) -> bool:
        deadline = self.hass.loop.time() + _PLAYBACK_START_TIMEOUT
        while self.hass.loop.time() < deadline:
            if driver.now_playing().get("state") == "playing":
                return True
            await asyncio.sleep(1.0)
        return False

    async def async_turn_on(self) -> None:
        snapshot = self.snapshot
        config = self.coordinator.config
        key = next(
            (k for k in config.activities if k != config.off_activity),
            config.off_activity,
        )
        if snapshot and snapshot.activity != config.off_activity:
            key = snapshot.activity
        await self.coordinator.async_activate(key)

    async def async_turn_off(self) -> None:
        key = self.coordinator.config.off_activity
        await self.coordinator.async_activate(key)
        await self.coordinator.async_apply_light_scene(key)

    # -- volume, in every activity (FR-65) ----------------------------------

    @property
    def volume_level(self) -> float | None:
        driver = self._volume_driver
        if driver is None:
            return None
        db = driver.volume_db()
        if db is None:
            return None
        config = self.coordinator.config
        span = config.volume_max_db - config.volume_min_db
        if span <= 0:
            return None
        return min(1.0, max(0.0, (db - config.volume_min_db) / span))

    @property
    def is_volume_muted(self) -> bool | None:
        driver = self._volume_driver
        if driver is None:
            return None
        state = driver.state_of("mute")
        return state.state == "on" if state else None

    async def async_set_volume_level(self, volume: float) -> None:
        driver = self._volume_driver
        if driver is None:
            raise HomeAssistantError("Kein Lautstärke-Gerät konfiguriert")
        config = self.coordinator.config
        span = config.volume_max_db - config.volume_min_db
        await driver.set_volume(config.volume_min_db + volume * span)
        self._write_volume_state()

    async def async_volume_up(self) -> None:
        await self._step_volume(+1)

    async def async_volume_down(self) -> None:
        await self._step_volume(-1)

    async def _step_volume(self, direction: int) -> None:
        driver = self._volume_driver
        if driver is None:
            raise HomeAssistantError("Kein Lautstärke-Gerät konfiguriert")
        config = self.coordinator.config
        current = driver.volume_db()
        if current is None:
            raise HomeAssistantError("Aktuelle Lautstärke ist unbekannt")
        target = current + direction * config.volume_step_db
        target = min(max(target, config.volume_min_db), config.volume_max_db)
        await driver.set_volume(target)
        self._write_volume_state()

    async def async_mute_volume(self, mute: bool) -> None:
        driver = self._volume_driver
        if driver is None:
            raise HomeAssistantError("Kein Lautstärke-Gerät konfiguriert")
        await driver.set_mute(mute)
        self._write_volume_state()

    def _write_volume_state(self) -> None:
        """Publish the new level at once, and let the engine catch up after.

        `async_request_refresh` is debounced by ten seconds, which is why the
        card sat on the old dB value long after the processor had moved. The
        driver already holds the value it just set, so the entity can say so
        immediately; the coordinator's own poll reconciles it later.
        """
        self.async_write_ha_state()
        self.coordinator.async_update_listeners()
