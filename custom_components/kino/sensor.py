"""Status, progress and per-device readiness sensors (FR-33, FR-73, FR-80)."""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity
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
    coordinator = runtime.coordinator
    entities: list[SensorEntity] = [
        KinoStatusSensor(coordinator),
        KinoProgressSensor(coordinator),
        KinoDemoSensor(coordinator),
    ]
    entities.extend(
        KinoDeviceSensor(coordinator, key) for key in coordinator.config.devices
    )
    async_add_entities(entities)


class KinoStatusSensor(KinoEntity, SensorEntity):
    """`sensor.kino_status` — plain German, readable by anyone."""

    _attr_translation_key = "status"
    _attr_icon = "mdi:information-outline"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "status")

    @property
    def native_value(self) -> str | None:
        snapshot = self.snapshot
        return snapshot.status_text() if snapshot else None

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        if snapshot is None:
            return {}
        return {
            "state": snapshot.state.value,
            "activity": snapshot.activity,
            "degraded": snapshot.degraded,
            "drift": [
                {
                    "device": f.device,
                    "classification": f.classification.value,
                    "detail": f.detail,
                    "restorable": f.restorable,
                }
                for f in snapshot.drift
            ],
            "last_error": snapshot.last_error,
        }


class KinoProgressSensor(KinoEntity, SensorEntity):
    """`sensor.kino_fortschritt` — percent complete, with the ETA attached."""

    _attr_translation_key = "progress"
    _attr_icon = "mdi:progress-clock"
    _attr_native_unit_of_measurement = "%"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "progress")

    @property
    def native_value(self) -> int | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
        if snapshot.progress is None:
            return 100 if not snapshot.is_transitioning else 0
        return snapshot.progress.percent

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        if snapshot is None or snapshot.progress is None:
            return {"transitioning": False}
        progress = snapshot.progress
        return {
            "transitioning": True,
            "eta_seconds": round(progress.eta_seconds),
            "bottleneck": progress.bottleneck,
            "bottleneck_device": progress.bottleneck_device,
            "to_activity": progress.to_activity,
            "from_activity": progress.from_activity,
        }


class KinoDemoSensor(KinoEntity, SensorEntity):
    """`sensor.kino_demo` — idle, or which clip of which showcase is running."""

    _attr_translation_key = "demo"
    _attr_icon = "mdi:play-box-multiple-outline"

    def __init__(self, coordinator: KinoCoordinator) -> None:
        super().__init__(coordinator, "demo")

    @property
    def native_value(self) -> str:
        running = self.coordinator.demo.state()
        if running is None:
            return "idle"
        return "ab" if running["mode"] == "ab" else "playing"

    @property
    def extra_state_attributes(self) -> dict:
        store = self.coordinator.demo_store
        running = self.coordinator.demo.state()
        attributes: dict = {
            "clips": len(store.clips),
            "showcases": len(store.showcases),
            "lead_in_seconds": store.settings.lead_in_seconds,
        }
        if running is None:
            return attributes
        clip = running.get("clip") or {}
        attributes.update(
            {
                "showcase": running.get("name"),
                "phase": running.get("phase"),
                "paused": running.get("paused"),
                "clip_name": clip.get("name"),
                "clip_index": running.get("index", 0) + 1,
                "clip_count": running.get("count"),
                "remaining_seconds": round(
                    (running.get("totalRemainingMs") or 0) / 1000
                ),
                "warning": running.get("warning"),
            }
        )
        return attributes


class KinoDeviceSensor(KinoEntity, SensorEntity):
    """`sensor.kino_<device>` — which device is holding things up."""

    _attr_translation_key = "device_status"

    def __init__(self, coordinator: KinoCoordinator, device_key: str) -> None:
        super().__init__(coordinator, f"device_{device_key}")
        self._device_key = device_key
        spec = coordinator.config.devices[device_key]
        self._attr_translation_placeholders = {"device": spec.name}
        self._attr_name = spec.name

    @property
    def native_value(self) -> str | None:
        snapshot = self.snapshot
        if snapshot is None:
            return None
        health = snapshot.device_health.get(self._device_key)
        return health.value if health else "unknown"

    @property
    def extra_state_attributes(self) -> dict:
        snapshot = self.snapshot
        if snapshot is None:
            return {}
        activity = self.coordinator.config.activities.get(snapshot.activity)
        requirement = activity.devices.get(self._device_key) if activity else None
        finding = next(
            (f for f in snapshot.drift if f.device == self._device_key), None
        )
        return {
            "required_by_activity": bool(requirement),
            "expected_settings": dict(requirement.settings) if requirement else {},
            "drift": finding.detail if finding else None,
            "drift_class": finding.classification.value if finding else None,
        }
