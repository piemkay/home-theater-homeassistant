"""
Volume as a dB number with a soft ceiling (FR-64, FR-64a).

The clamp here is UX safety only. The authoritative hard limit belongs in the
Trinnov's own configuration (D10) — a software clamp in Home Assistant is
defence in depth, not the defence.
"""

from __future__ import annotations

import logging

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import KinoCoordinator, KinoRuntimeData
from .devices.trinnov import TrinnovDriver
from .entity import KinoEntity

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    runtime: KinoRuntimeData = entry.runtime_data
    coordinator = runtime.coordinator
    if coordinator.config.volume_device:
        async_add_entities([KinoVolumeNumber(coordinator)])


class KinoVolumeNumber(KinoEntity, NumberEntity):
    """`number.kino_lautstarke`, in dB, working in every activity (FR-65)."""

    _attr_translation_key = "volume"
    _attr_icon = "mdi:volume-high"
    _attr_native_unit_of_measurement = "dB"
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "volume")
        self._attr_native_min_value = coordinator.config.volume_min_db
        self._attr_native_max_value = coordinator.config.volume_max_db
        self._attr_native_step = coordinator.config.volume_step_db

    @property
    def _driver(self) -> TrinnovDriver | None:
        key = self.coordinator.config.volume_device
        driver = self.coordinator.engine.drivers.get(key) if key else None
        return driver if isinstance(driver, TrinnovDriver) else None

    @property
    def native_value(self) -> float | None:
        driver = self._driver
        return driver.volume_db() if driver else None

    @property
    def available(self) -> bool:
        return self._driver is not None and self.native_value is not None

    async def async_set_native_value(self, value: float) -> None:
        driver = self._driver
        if driver is None:
            raise HomeAssistantError("Kein Lautstärke-Gerät konfiguriert")

        config = self.coordinator.config
        clamped = min(max(value, config.volume_min_db), config.volume_max_db)
        if clamped != value:
            _LOGGER.debug(
                "Lautstärke %.1f dB auf das Soft-Limit %.1f dB begrenzt",
                value,
                clamped,
            )

        # The Trinnov is authoritative: whatever it reports back is the truth,
        # and a value it clamps is a graceful bounce-back, not an error.
        actual = await driver.set_volume(clamped)
        if actual is not None and abs(actual - clamped) > 0.05:
            _LOGGER.debug("Trinnov hat %.1f dB auf %.1f dB korrigiert", clamped, actual)
        await self.coordinator.async_request_refresh()
