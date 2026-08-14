"""Coordinator: polls the devices, drives reconciliation, owns the engine."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .const import (
    DOMAIN,
    EVENT_ACTIVITY_CHANGED,
    EVENT_DEVICE_DRIFT,
    EVENT_TRANSITION_FINISHED,
    EVENT_TRANSITION_STARTED,
    STORAGE_KEY_DURATIONS,
    STORAGE_VERSION,
    UPDATE_INTERVAL_ACTIVE,
    UPDATE_INTERVAL_IDLE,
    UPDATE_INTERVAL_TRANSITION,
)
from .core.estimator import DurationEstimator
from .core.machine import ActivityEngine, EngineSnapshot
from .core.model import ActivityState, KinoConfig
from .demo.engine import DemoEngine
from .demo.runtime import HassDemoRuntime
from .demo.store import DemoStore
from .devices import HassBridge, build_drivers
from .media.base import MediaBackend

_LOGGER = logging.getLogger(__name__)


@dataclass
class KinoRuntimeData:
    """Everything a platform needs, hung off the config entry."""

    coordinator: KinoCoordinator
    media: MediaBackend | None = None
    unsubscribes: list[Any] = field(default_factory=list)


class KinoCoordinator(DataUpdateCoordinator[EngineSnapshot]):
    """Bridges the hardware-free engine to Home Assistant."""

    def __init__(
        self,
        hass: HomeAssistant,
        entry: ConfigEntry,
        config: KinoConfig,
        media: MediaBackend | None = None,
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            name=DOMAIN,
            update_interval=UPDATE_INTERVAL_IDLE,
        )
        self.entry = entry
        self.config = config
        self.media = media
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_DURATIONS)
        self._bridge = HassBridge(hass)
        self.estimator = DurationEstimator()
        self.engine = self._build_engine(config)
        self._previous_activity: str | None = None
        self._previous_state: ActivityState | None = None
        #: The catalogue entry behind the file the media device has open, as
        #: resolved by the media player. Room-level, so the card's state
        #: payload can carry it without going through the entity.
        self.playing_item: dict[str, Any] | None = None
        #: The catalogue entry queued to play once the room is ready:
        #: ``{"id", "title"}``. Held for the whole start-then-play arc so the
        #: card keeps naming the film during the ~1 min transition (F5).
        self.pending_item: dict[str, Any] | None = None
        #: Devices whose current drift episode has already been announced, so
        #: a standing finding fires `kino_device_drift` once — not once per
        #: poll for as long as it stands.
        self._announced_drift: set[str] = set()
        #: Demo mode: the stored clips and showcases, and the engine that
        #: replays them through this coordinator's own activity layer.
        self.demo_store = DemoStore(hass)
        self.demo = DemoEngine(
            HassDemoRuntime(hass, self), self.demo_store.settings
        )
        self.engine.add_listener(self._on_engine_change)

    def _build_engine(self, config: KinoConfig) -> ActivityEngine:
        return ActivityEngine(
            config=config,
            drivers=build_drivers(self._bridge, config.devices),
            estimator=self.estimator,
            poll_interval=1.0,
            time_fn=self.hass.loop.time,
        )

    # -- lifecycle ----------------------------------------------------------

    async def async_prepare(self) -> None:
        """Restore learned durations before the first transition (FR-24)."""
        stored = await self._store.async_load()
        if stored:
            self.estimator.restore(stored)
            _LOGGER.debug("%d gelernte Dauern wiederhergestellt", len(stored))
        await self.demo_store.async_load()
        self.demo.update_settings(self.demo_store.settings)

    @property
    def demo_active(self) -> bool:
        """True while a showcase or an A/B comparison is running.

        Playback during a demo carries `demo=true` and is deliberately kept
        out of the catalogue's history — a showcase must never "watch" ten
        films (spec §4.4).
        """
        return self.demo.active

    async def async_persist_durations(self) -> None:
        await self._store.async_save(self.estimator.as_dict())

    # -- polling ------------------------------------------------------------

    async def _async_update_data(self) -> EngineSnapshot:
        snapshot = await self.engine.reconcile()
        self.update_interval = _interval_for(snapshot)
        return snapshot

    # -- events for the existing `Kino –` automations (FR-84) ---------------

    def _on_engine_change(self, snapshot: EngineSnapshot) -> None:
        self.async_set_updated_data(snapshot)

        if self._previous_state != snapshot.state:
            if snapshot.is_transitioning and not (
                self._previous_state
                and self._previous_state
                in (
                    ActivityState.STARTING,
                    ActivityState.SWITCHING,
                    ActivityState.STOPPING,
                )
            ):
                self.hass.bus.async_fire(
                    EVENT_TRANSITION_STARTED,
                    {
                        "from_activity": self._previous_activity,
                        "to_activity": snapshot.target_activity,
                    },
                )
            elif (
                self._previous_state
                and self._previous_state
                in (
                    ActivityState.STARTING,
                    ActivityState.SWITCHING,
                    ActivityState.STOPPING,
                )
                and not snapshot.is_transitioning
            ):
                self.hass.bus.async_fire(
                    EVENT_TRANSITION_FINISHED,
                    {
                        "activity": snapshot.activity,
                        "succeeded": snapshot.state is not ActivityState.ERROR,
                        "error": snapshot.last_error,
                    },
                )
                # Write the just-learned durations to disk now: Home Assistant
                # does not unload entries on a core restart, so waiting for
                # async_unload_entry silently lost everything a session had
                # learned (found live, 2026-08-12).
                self.hass.async_create_task(self.async_persist_durations())
            self._previous_state = snapshot.state

        if self._previous_activity != snapshot.activity:
            self.hass.bus.async_fire(
                EVENT_ACTIVITY_CHANGED,
                {
                    "from_activity": self._previous_activity,
                    "to_activity": snapshot.activity,
                    "control_class": self.config.activities[
                        snapshot.activity
                    ].control_class.value,
                },
            )
            self._previous_activity = snapshot.activity

        current_drift = {f.device for f in snapshot.drift}
        for finding in snapshot.drift:
            if finding.device in self._announced_drift:
                continue
            self.hass.bus.async_fire(
                EVENT_DEVICE_DRIFT,
                {
                    "device": finding.device,
                    "classification": finding.classification.value,
                    "detail": finding.detail,
                },
            )
        # A device that came back into line re-fires if it drifts again.
        self._announced_drift = current_drift

    # -- actions ------------------------------------------------------------

    async def async_activate(self, activity_key: str) -> None:
        await self.engine.activate(activity_key)

    async def async_apply_light_scene(self, activity_key: str) -> None:
        """Restore the room's light state on activity change (FR-35)."""
        activity = self.config.activities.get(activity_key)
        scene = activity.light_scene if activity else None
        if activity_key == self.config.off_activity:
            scene = self.config.shutdown_light_scene or scene
        if not scene:
            return
        await self.hass.services.async_call(
            "scene", "turn_on", {"entity_id": scene}, blocking=False
        )

    @property
    def activity_options(self) -> list[str]:
        return [a.name for a in self.config.activities.values()]

    def activity_by_name(self, name: str) -> str | None:
        for key, activity in self.config.activities.items():
            if activity.name == name:
                return key
        return None


def _interval_for(snapshot: EngineSnapshot) -> Any:
    if snapshot.is_transitioning:
        return UPDATE_INTERVAL_TRANSITION
    if snapshot.state is ActivityState.OFF:
        return UPDATE_INTERVAL_IDLE
    return UPDATE_INTERVAL_ACTIVE
