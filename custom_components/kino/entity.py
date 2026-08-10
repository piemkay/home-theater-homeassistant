"""Shared entity base for every Kino platform."""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, NAME
from .coordinator import KinoCoordinator
from .core.machine import EngineSnapshot


class KinoEntity(CoordinatorEntity[KinoCoordinator]):
    """All Kino entities hang off one device, so the room reads as one thing."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: KinoCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, coordinator.entry.entry_id)},
            name=NAME,
            manufacturer="Patrick",
            model="Heimkino",
            entry_type=None,
        )

    @property
    def snapshot(self) -> EngineSnapshot | None:
        """Return the latest engine snapshot, or None before the first poll."""
        return self.coordinator.data
