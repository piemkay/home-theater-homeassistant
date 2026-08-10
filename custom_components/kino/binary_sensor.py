"""`binary_sensor.kino_fehler` — one place to see that something is wrong."""

from __future__ import annotations

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import KinoCoordinator, KinoRuntimeData
from .core.model import ActivityState
from .entity import KinoEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    runtime: KinoRuntimeData = entry.runtime_data
    async_add_entities(
        [KinoErrorSensor(runtime.coordinator), KinoDegradedSensor(runtime.coordinator)]
    )


class KinoErrorSensor(KinoEntity, BinarySensorEntity):
    """`binary_sensor.kino_fehler` — something needs a human."""

    _attr_translation_key = "error"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "error")

    @property
    def is_on(self) -> bool:
        snapshot = self.snapshot
        return bool(snapshot and snapshot.state is ActivityState.ERROR)

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        return {"message": snapshot.last_error if snapshot else None}


class KinoDegradedSensor(KinoEntity, BinarySensorEntity):
    """`degradiert` is a visible sub-state, not a hidden flag (FR-39)."""

    _attr_translation_key = "degraded"
    _attr_device_class = BinarySensorDeviceClass.PROBLEM

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "degraded")

    @property
    def is_on(self) -> bool:
        snapshot = self.snapshot
        return bool(snapshot and snapshot.degraded)

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        if snapshot is None:
            return {}
        return {
            "devices": [f.device for f in snapshot.drift],
            "message": snapshot.drift[0].detail if snapshot.drift else None,
        }
