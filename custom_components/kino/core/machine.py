"""
The activity state machine (FR-30 .. FR-35).

State is *derived* from observed device state, never written after the fact.
That is the whole point: a restart mid-transition, a device switched on by its
own remote, or a failed step all reconcile to reality on the next poll rather
than leaving a stale value lying around (F3, FR-31).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections import deque
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .drift import DriftDetector, DriftFinding
from .estimator import DurationEstimator
from .executor import (
    DeviceDriver,
    TransitionExecutor,
    TransitionProgress,
    TransitionResult,
)
from .model import (
    ActivityDef,
    ActivityState,
    DeviceHealth,
    DeviceObservation,
    DriftClass,
    KinoConfig,
    Power,
    TransitionPlan,
)
from .planner import infer_active_activity, plan_transition

_LOGGER = logging.getLogger(__name__)

TRANSITION_LOG_SIZE = 25


@dataclass
class EngineSnapshot:
    """Everything the entities and the card need, in one immutable read."""

    state: ActivityState
    activity: str
    target_activity: str | None
    progress: TransitionProgress | None
    drift: Sequence[DriftFinding] = field(default_factory=tuple)
    device_health: Mapping[str, DeviceHealth] = field(default_factory=dict)
    last_error: str | None = None

    @property
    def is_transitioning(self) -> bool:
        return self.state in (
            ActivityState.STARTING,
            ActivityState.SWITCHING,
            ActivityState.STOPPING,
        )

    @property
    def degraded(self) -> bool:
        return bool(self.drift) and not self.is_transitioning

    def status_text(self) -> str:
        """Plain-German status for `sensor.kino_status` (FR-80)."""
        if self.state is ActivityState.ERROR:
            return self.last_error or "Fehler"
        if self.progress and self.is_transitioning:
            if self.progress.bottleneck:
                return self.progress.bottleneck
            return "Wird umgeschaltet…"
        if self.state is ActivityState.OFF:
            return "Ausgeschaltet"
        if self.degraded:
            return self.drift[0].detail
        return "Bereit"


class ActivityEngine:
    """Owns the current activity and every transition between activities."""

    def __init__(
        self,
        *,
        config: KinoConfig,
        drivers: Mapping[str, DeviceDriver],
        estimator: DurationEstimator | None = None,
        poll_interval: float = 1.0,
        time_fn: Callable[[], float] | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self.config = config
        self.drivers = drivers
        self.estimator = estimator or DurationEstimator()
        self._drift = DriftDetector(config.drift_debounce_seconds)
        self._time = time_fn or asyncio.get_event_loop().time
        self._executor = TransitionExecutor(
            drivers=drivers,
            estimator=self.estimator,
            poll_interval=poll_interval,
            time_fn=self._time,
            sleep_fn=sleep_fn,
        )

        self._state = ActivityState.OFF
        self._activity = config.off_activity
        self._target: str | None = None
        self._progress: TransitionProgress | None = None
        self._drift_findings: tuple[DriftFinding, ...] = ()
        self._device_health: dict[str, DeviceHealth] = {}
        self._last_error: str | None = None
        self._task: asyncio.Task[None] | None = None
        self._log: deque[dict[str, Any]] = deque(maxlen=TRANSITION_LOG_SIZE)
        self._listeners: list[Callable[[EngineSnapshot], Any]] = []
        self._lock = asyncio.Lock()

    # -- observation --------------------------------------------------------

    def snapshot(self) -> EngineSnapshot:
        return EngineSnapshot(
            state=self._state,
            activity=self._activity,
            target_activity=self._target,
            progress=self._progress,
            drift=self._drift_findings,
            device_health=dict(self._device_health),
            last_error=self._last_error,
        )

    @property
    def transition_log(self) -> list[dict[str, Any]]:
        return list(self._log)

    def add_listener(
        self, callback: Callable[[EngineSnapshot], Any]
    ) -> Callable[[], None]:
        self._listeners.append(callback)

        def _remove() -> None:
            if callback in self._listeners:
                self._listeners.remove(callback)

        return _remove

    def _notify(self) -> None:
        snapshot = self.snapshot()
        for callback in list(self._listeners):
            try:
                callback(snapshot)
            except Exception:
                _LOGGER.exception("Kino-Listener hat eine Ausnahme geworfen")

    async def observe_all(self) -> dict[str, DeviceObservation]:
        """Read every device concurrently."""
        keys = list(self.drivers)
        results = await asyncio.gather(
            *(self.drivers[key].observe() for key in keys),
            return_exceptions=True,
        )
        observations: dict[str, DeviceObservation] = {}
        for key, result in zip(keys, results, strict=True):
            if isinstance(result, BaseException):
                _LOGGER.debug("Konnte %s nicht auslesen: %s", key, result)
                observations[key] = DeviceObservation(
                    device=key,
                    power=Power.UNAVAILABLE,
                    available=False,
                    error=str(result),
                )
            else:
                observations[key] = result
        return observations

    # -- reconciliation -----------------------------------------------------

    async def reconcile(self) -> EngineSnapshot:
        """Derive state from the devices (FR-31, FR-36). Safe to call always."""
        observations = await self.observe_all()
        transitioning = self._state in (
            ActivityState.STARTING,
            ActivityState.SWITCHING,
            ActivityState.STOPPING,
        )

        if not transitioning:
            inferred, _deviations = infer_active_activity(
                devices=self.config.devices,
                observations=observations,
                activities=self.config.activities,
                off_activity=self.config.off_activity,
            )
            if inferred != self._activity:
                _LOGGER.debug(
                    "Aktivität aus Gerätezustand abgeleitet: %s -> %s",
                    self._activity,
                    inferred,
                )
                self._activity = inferred
            self._state = (
                ActivityState.OFF
                if inferred == self.config.off_activity
                else ActivityState.ON
            )
            self._device_health = {
                key: _health_of(obs) for key, obs in observations.items()
            }

        findings = self._drift.evaluate(
            activity=self.config.activities[self._activity],
            devices=self.config.devices,
            observations=observations,
            now=self._time(),
            transitioning=transitioning,
        )
        self._drift_findings = tuple(findings)
        fatal = any(f.classification is DriftClass.FATAL for f in findings)
        if fatal and not transitioning:
            self._state = ActivityState.ERROR
            self._last_error = findings[0].detail
        elif self._state is ActivityState.ERROR and not findings:
            self._last_error = None
            self._state = (
                ActivityState.OFF
                if self._activity == self.config.off_activity
                else ActivityState.ON
            )

        self._notify()
        return self.snapshot()

    # -- transitions --------------------------------------------------------

    async def dry_run(self, activity_key: str) -> TransitionPlan:
        """Compute a plan without executing it (FR-121)."""
        target = self._activity_or_raise(activity_key)
        observations = await self.observe_all()
        return plan_transition(
            devices=self.config.devices,
            observations=observations,
            target=target,
            current_activity=self._activity,
        )

    async def activate(self, activity_key: str) -> None:
        """
        Switch to ``activity_key``.

        Selecting the active activity is a no-op; selecting a different one
        mid-transition re-targets rather than queueing or dropping (FR-32).
        """
        target = self._activity_or_raise(activity_key)

        if (
            activity_key == self._activity
            and self._task is None
            and self._state in (ActivityState.ON, ActivityState.OFF)
            and not self._drift_findings
        ):
            _LOGGER.debug("'%s' ist bereits aktiv — nichts zu tun", activity_key)
            return

        if self._task is not None and not self._task.done():
            if self._target == activity_key:
                _LOGGER.debug(
                    "Übergang nach '%s' läuft bereits — Tastendruck ignoriert",
                    activity_key,
                )
                return
            _LOGGER.debug(
                "Ziel wird von '%s' auf '%s' geändert", self._target, activity_key
            )
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001 - the retarget must not inherit it
                # The abandoned transition's failure is not this one's
                # problem, but it should still show up in the log.
                _LOGGER.debug(
                    "Abgebrochener Übergang endete mit einem Fehler",
                    exc_info=True,
                )

        self._task = asyncio.ensure_future(self._run_transition(target.key))

    async def wait_for_transition(self) -> None:
        """Await the running transition, if any. Used by tests and services."""
        task = self._task
        if task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await task

    async def _run_transition(self, activity_key: str) -> None:
        async with self._lock:
            target = self.config.activities[activity_key]
            previous = self._activity
            self._target = activity_key
            self._last_error = None
            self._drift.clear()
            self._drift_findings = ()
            self._state = (
                ActivityState.STOPPING
                if activity_key == self.config.off_activity
                else ActivityState.STARTING
                if previous == self.config.off_activity
                else ActivityState.SWITCHING
            )
            self._notify()

            observations = await self.observe_all()
            plan = plan_transition(
                devices=self.config.devices,
                observations=observations,
                target=target,
                current_activity=previous,
            )

            if plan.is_empty:
                _LOGGER.debug("'%s' ist bereits im Zielzustand", activity_key)
                self._finish(activity_key)
                return

            try:
                result = await self._executor.execute(
                    plan, on_progress=self._on_progress
                )
            except asyncio.CancelledError:
                _LOGGER.debug("Übergang nach '%s' abgebrochen", activity_key)
                self._progress = None
                raise
            except Exception as err:
                _LOGGER.exception("Übergang nach '%s' fehlgeschlagen", activity_key)
                self._log.append(
                    {
                        "to_activity": activity_key,
                        "from_activity": previous,
                        "succeeded": False,
                        "error": str(err),
                    }
                )
                self._fail(str(err))
                return

            self._log.append(result.as_dict())
            if result.succeeded:
                self._finish(activity_key, result=result)
            else:
                self._fail(result.error or "Unbekannter Fehler", activity=activity_key)

    def _on_progress(self, progress: TransitionProgress) -> None:
        self._progress = progress
        self._device_health.update(progress.device_health)
        self._notify()

    def _finish(
        self,
        activity_key: str,
        result: TransitionResult | None = None,
    ) -> None:
        self._activity = activity_key
        self._target = None
        self._progress = None
        self._task = None
        self._state = (
            ActivityState.OFF
            if activity_key == self.config.off_activity
            else ActivityState.ON
        )
        if result is not None:
            for step in result.steps:
                self._device_health[step.action.device] = step.health
        self._notify()

    def _fail(self, error: str, *, activity: str | None = None) -> None:
        self._state = ActivityState.ERROR
        self._last_error = error
        self._target = None
        self._progress = None
        self._task = None
        if activity is not None:
            # The room really is in whatever half-state the failure left it,
            # so record the attempted activity rather than pretending we are
            # still on the old one.
            self._activity = activity
        self._notify()

    # -- drift actions ------------------------------------------------------

    async def restore_device(self, device_key: str) -> None:
        """One-tap "Wiederherstellen" for a drifted device (FR-39)."""
        driver = self.drivers.get(device_key)
        if driver is None:
            raise KeyError(device_key)
        activity = self.config.activities[self._activity]
        requirement = activity.devices.get(device_key)
        if requirement is None:
            raise ValueError(
                f"{device_key} gehört nicht zur Aktivität '{self._activity}'"
            )
        self._drift.clear(device_key)
        observation = await driver.observe()
        if not driver.is_ready(observation):
            await driver.start()
        if requirement.settings:
            await driver.apply(dict(requirement.settings))
        await self.reconcile()

    def dismiss_drift(self, device_key: str) -> None:
        self._drift.dismiss(device_key)
        self._drift_findings = tuple(
            f for f in self._drift_findings if f.device != device_key
        )
        self._notify()

    def _activity_or_raise(self, key: str) -> ActivityDef:
        try:
            return self.config.activities[key]
        except KeyError as err:
            raise KeyError(
                f"Unbekannte Aktivität '{key}' "
                f"(bekannt: {', '.join(sorted(self.config.activities))})"
            ) from err


def _health_of(observation: DeviceObservation) -> DeviceHealth:
    if not observation.available or observation.power is Power.UNAVAILABLE:
        return DeviceHealth.UNREACHABLE
    if observation.error:
        return DeviceHealth.ERROR
    if observation.power is Power.ON:
        return DeviceHealth.READY
    if observation.power is Power.OFF:
        return DeviceHealth.OFF
    if observation.power is Power.TRANSITIONING:
        return DeviceHealth.STARTING
    return DeviceHealth.UNKNOWN
