"""Recovery actions reachable from the same screen as the error (FR-81)."""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .coordinator import KinoCoordinator, KinoRuntimeData
from .entity import KinoEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    runtime: KinoRuntimeData = entry.runtime_data
    async_add_entities(
        [
            KinoRetryButton(runtime.coordinator),
            KinoAllOffButton(runtime.coordinator),
            KinoRefreshLibraryButton(runtime.coordinator),
        ]
    )


class KinoRetryButton(KinoEntity, ButtonEntity):
    """Retry — re-runs the activity the user actually wanted."""

    _attr_translation_key = "retry"
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "retry")

    async def async_press(self) -> None:
        snapshot = self.snapshot
        key = (
            (snapshot.target_activity or snapshot.activity)
            if snapshot
            else self.coordinator.config.off_activity
        )
        await self.coordinator.async_activate(key)


class KinoAllOffButton(KinoEntity, ButtonEntity):
    """Turn everything off — always available, even from an error state."""

    _attr_translation_key = "all_off"
    _attr_icon = "mdi:power"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "all_off")

    async def async_press(self) -> None:
        key = self.coordinator.config.off_activity
        await self.coordinator.async_activate(key)
        await self.coordinator.async_apply_light_scene(key)


class KinoRefreshLibraryButton(KinoEntity, ButtonEntity):
    """FR-44: the retry for a NAS that had spun down."""

    _attr_translation_key = "refresh_library"
    _attr_icon = "mdi:database-refresh"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "refresh_library")

    @property
    def available(self) -> bool:
        return self.coordinator.media is not None

    async def async_press(self) -> None:
        if self.coordinator.media is not None:
            await self.coordinator.media.refresh()
