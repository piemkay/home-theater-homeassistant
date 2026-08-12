"""Activity selection, plus live audio and subtitle track selects (FR-60)."""

from __future__ import annotations

import logging

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import KinoCoordinator, KinoRuntimeData
from .devices.bridge import StateSnapshot
from .devices.zidoo import ZidooDriver
from .entity import KinoEntity

_LOGGER = logging.getLogger(__name__)

#: Shown when there is no track list yet — a player that is not playing has
#: nothing to offer, and saying so beats an empty dropdown (FR-60).
PLACEHOLDER = "—"


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    runtime: KinoRuntimeData = entry.runtime_data
    coordinator = runtime.coordinator
    entities: list[SelectEntity] = [KinoActivitySelect(coordinator)]

    for key, driver in coordinator.engine.drivers.items():
        if isinstance(driver, ZidooDriver):
            entities.append(KinoTrackSelect(coordinator, key, "audio"))
            entities.append(KinoTrackSelect(coordinator, key, "subtitle"))
    async_add_entities(entities)


class KinoActivitySelect(KinoEntity, SelectEntity):
    """`select.kino_aktivitat` — the one control that starts everything."""

    _attr_translation_key = "activity"
    _attr_icon = "mdi:theater"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "activity")

    @property
    def options(self) -> list[str]:
        return [a.name for a in self.coordinator.config.activities.values()]

    @property
    def current_option(self) -> str | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
        # During a transition the target is what the user asked for, and that
        # is what the UI should reflect.
        key = snapshot.target_activity or snapshot.activity
        activity = self.coordinator.config.activities.get(key)
        return activity.name if activity else None

    async def async_select_option(self, option: str) -> None:
        key = self.coordinator.activity_by_name(option)
        if key is None:
            raise HomeAssistantError(
                f"Unbekannte Aktivität '{option}' "
                f"(verfügbar: {', '.join(self.options)})"
            )
        await self.coordinator.async_activate(key)
        await self.coordinator.async_apply_light_scene(key)

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        if snapshot is None:
            return {}
        key = snapshot.target_activity or snapshot.activity
        activity = self.coordinator.config.activities.get(key)
        return {
            "activity_key": key,
            "state": snapshot.state.value,
            "control_class": activity.control_class.value if activity else None,
            "media": activity.media if activity else None,
        }


class KinoTrackSelect(KinoEntity, SelectEntity):
    """Audio / subtitle track, backed by live player state — no mirror helper."""

    def __init__(
        self, coordinator: KinoCoordinator, device_key: str, kind: str
    ) -> None:
        super().__init__(coordinator, f"{device_key}_{kind}")
        self._device_key = device_key
        self._kind = kind
        self._attr_translation_key = (
            "audio_track" if kind == "audio" else "subtitle_track"
        )
        self._attr_icon = "mdi:volume-high" if kind == "audio" else "mdi:subtitles"

    @property
    def _driver(self) -> ZidooDriver | None:
        driver = self.coordinator.engine.drivers.get(self._device_key)
        return driver if isinstance(driver, ZidooDriver) else None

    def _source_state(self) -> StateSnapshot | None:
        driver = self._driver
        if driver is None:
            return None
        return driver.state_of(f"{self._kind}_select")

    @property
    def options(self) -> list[str]:
        state = self._source_state()
        raw = list(state.attributes.get("options") or []) if state else []
        # A helper waiting for a track list holds a placeholder, not a track;
        # passing it on would offer "—" as something to select.
        options = [option for option in raw if option != PLACEHOLDER]
        if not options:
            return [PLACEHOLDER]
        # FR-62's "Aus" is the player's own off entry ("0: Off"), which every
        # real track list carries. Injecting a literal "Aus" on top offered an
        # option the underlying select rejects with "Invalid option: Aus".
        return options

    @property
    def current_option(self) -> str | None:
        state = self._source_state()
        if state is None or state.state in ("unknown", "unavailable"):
            return None
        # Home Assistant rejects a current option that is not in the list.
        return state.state if state.state in self.options else None

    @property
    def available(self) -> bool:
        return self._source_state() is not None

    async def async_select_option(self, option: str) -> None:
        driver = self._driver
        if driver is None:
            raise HomeAssistantError("Zidoo-Treiber nicht verfügbar")
        if self._kind == "audio":
            await driver.select_audio_track(option)
        else:
            await driver.select_subtitle_track(option)
        await self.coordinator.async_request_refresh()
