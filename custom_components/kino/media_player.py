"""
`media_player.kino` — transport and volume through the standard interface.

Exposing the standard interface means the existing dashboard cards keep
working (FR-63, NFR-7) while the custom card gets its richer surface over
WebSocket.
"""

from __future__ import annotations

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
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import ARTWORK_URL_FORMAT
from .coordinator import KinoCoordinator, KinoRuntimeData
from .core.model import ActivityState
from .devices.trinnov import TrinnovDriver
from .devices.zidoo import ZidooDriver
from .entity import KinoEntity

_LOGGER = logging.getLogger(__name__)

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
    )

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "player")

    # -- the device currently carrying media --------------------------------

    @property
    def _media_driver(self) -> ZidooDriver | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
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

    @property
    def media_title(self) -> str | None:
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
        item_id = now.get("jellyfin_id")
        if item_id:
            return ARTWORK_URL_FORMAT.format(item_id=item_id, image_type="Primary")
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

    async def async_media_next_track(self) -> None:
        await self._media("media_next_track")

    async def async_media_previous_track(self) -> None:
        await self._media("media_previous_track")

    async def async_media_seek(self, position: float) -> None:
        await self._media("media_seek", seek_position=position)

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
        await self.coordinator.async_request_refresh()

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
        await self.coordinator.async_request_refresh()

    async def async_mute_volume(self, mute: bool) -> None:
        driver = self._volume_driver
        if driver is None:
            raise HomeAssistantError("Kein Lautstärke-Gerät konfiguriert")
        await driver.set_mute(mute)
        await self.coordinator.async_request_refresh()
