"""
Concurrent, dependency-aware execution of a transition plan.

Design rules this file implements:

* Readiness comes from observed device state; timers exist only as timeouts,
  never as the success path (FR-20).
* Only real dependencies serialise work — everything else runs concurrently
  (FR-12, FR-21).
* The critical path is kicked off first, because the projector dominates every
  transition it takes part in (FR-22).
* We wait only on devices the target activity actually requires (FR-23).
* Shutdown is best-effort per device but explicitly verified, so one dead
  device cannot block the rest and an unverified stop still raises (FR-34).
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from .estimator import DurationEstimator
from .model import (
    ActionKind,
    DeviceAction,
    DeviceHealth,
    DeviceObservation,
    DeviceSpec,
    Power,
    TransitionPlan,
)

_LOGGER = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL = 1.0


class DeviceDriver(Protocol):
    """What the executor needs from a device, and nothing more."""

    spec: DeviceSpec

    async def observe(self) -> DeviceObservation:
        """Read the device's current state."""

    async def start(self) -> None:
        """Ask the device to power on. Must not block on readiness."""

    async def stop(self) -> None:
        """Ask the device to power off. Must not block on readiness."""

    async def apply(self, settings: Mapping[str, Any]) -> None:
        """Write per-activity settings."""

    async def stop_playback(self) -> None:
        """Stop playing media cleanly, if this device plays any."""

    def is_ready(self, observation: DeviceObservation) -> bool:
        """Return True when the device can be configured and used."""


class TransitionAborted(Exception):
    """A required device failed, so the transition cannot complete."""

    def __init__(self, device: str, reason: str) -> None:
        self.device = device
        self.reason = reason
        super().__init__(f"{device}: {reason}")


@dataclass
class StepState:
    """Live state of one device action, for the progress display."""

    action: DeviceAction
    health: DeviceHealth = DeviceHealth.UNKNOWN
    started_at: float | None = None
    finished_at: float | None = None
    estimate: float = 0.0
    error: str | None = None

    @property
    def done(self) -> bool:
        return self.finished_at is not None

    def elapsed(self, now: float) -> float:
        if self.started_at is None:
            return 0.0
        return (self.finished_at or now) - self.started_at

    def fraction(self, now: float) -> float:
        if self.done:
            return 1.0
        if self.started_at is None or self.estimate <= 0:
            return 0.0
        return min(0.99, self.elapsed(now) / self.estimate)


@dataclass
class TransitionProgress:
    """What the card renders while a transition runs (FR-73, FR-82)."""

    to_activity: str
    from_activity: str | None
    percent: int
    eta_seconds: float
    #: The device currently holding everything up, in plain German.
    bottleneck: str | None
    bottleneck_device: str | None
    device_health: Mapping[str, DeviceHealth] = field(default_factory=dict)
    finished: bool = False
    failed: bool = False
    error: str | None = None


ProgressCallback = Callable[[TransitionProgress], Awaitable[None] | None]


@dataclass
class TransitionResult:
    """Outcome of one execution, recorded in the transition log (FR-122)."""

    to_activity: str
    from_activity: str | None
    succeeded: bool
    duration_seconds: float
    steps: Sequence[StepState]
    error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "to_activity": self.to_activity,
            "from_activity": self.from_activity,
            "succeeded": self.succeeded,
            "duration_seconds": round(self.duration_seconds, 2),
            "error": self.error,
            "steps": [
                {
                    "device": step.action.device,
                    "kind": step.action.kind.value,
                    "health": step.health.value,
                    "seconds": round(step.elapsed(step.finished_at or 0.0), 2)
                    if step.started_at is not None and step.finished_at is not None
                    else None,
                    "estimate": round(step.estimate, 2),
                    "error": step.error,
                }
                for step in self.steps
            ],
        }


class TransitionExecutor:
    """Runs one :class:`TransitionPlan` to completion."""

    def __init__(
        self,
        *,
        drivers: Mapping[str, DeviceDriver],
        estimator: DurationEstimator,
        poll_interval: float = DEFAULT_POLL_INTERVAL,
        time_fn: Callable[[], float] | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._drivers = drivers
        self._estimator = estimator
        self._poll = poll_interval
        self._time = time_fn or asyncio.get_event_loop().time
        self._sleep = sleep_fn or asyncio.sleep

    async def execute(  # noqa: C901 - linear: set up, run, collect, report
        self,
        plan: TransitionPlan,
        *,
        on_progress: ProgressCallback | None = None,
    ) -> TransitionResult:
        """Execute ``plan``; return once every required device has settled."""
        started = self._time()
        steps = self._build_steps(plan)
        ready_events: dict[str, asyncio.Event] = {
            step.action.device: asyncio.Event() for step in steps
        }

        # Devices that stay untouched are ready from the start, so anything
        # depending on them is not gated behind work that will never run.
        for device in self._drivers:
            if device not in ready_events:
                ready_events[device] = asyncio.Event()
                ready_events[device].set()
        for step in steps:
            if step.action.kind is ActionKind.KEEP:
                step.health = DeviceHealth.READY
                step.finished_at = started
                step.started_at = started
                ready_events[step.action.device].set()

        await self._stop_outgoing_playback(plan)

        # Longest job first: creating the projector's task before the fast
        # devices' tasks is what makes it the critical path rather than a
        # list-order accident (FR-22).
        runnable = [s for s in steps if s.action.kind is not ActionKind.KEEP]
        runnable.sort(key=lambda s: s.estimate, reverse=True)

        reporter = asyncio.ensure_future(self._report_loop(plan, steps, on_progress))
        tasks = [
            asyncio.ensure_future(self._run_step(step, ready_events))
            for step in runnable
        ]

        failure: TransitionAborted | None = None
        try:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for outcome in results:
                if isinstance(outcome, TransitionAborted) and failure is None:
                    failure = outcome
                elif isinstance(outcome, BaseException) and not isinstance(
                    outcome, TransitionAborted
                ):
                    _LOGGER.error("Unerwarteter Fehler im Übergang", exc_info=outcome)
                    if failure is None:
                        failure = TransitionAborted("?", str(outcome))
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            reporter.cancel()
            raise
        finally:
            reporter.cancel()

        duration = self._time() - started
        result = TransitionResult(
            to_activity=plan.to_activity,
            from_activity=plan.from_activity,
            succeeded=failure is None,
            duration_seconds=duration,
            steps=steps,
            error=None if failure is None else str(failure),
        )
        await self._emit(
            on_progress,
            self._snapshot(plan, steps, finished=True, failure=failure),
        )
        _LOGGER.debug(
            "Übergang nach '%s' %s in %.1fs (%s)",
            plan.to_activity,
            "erfolgreich" if failure is None else "fehlgeschlagen",
            duration,
            plan.describe(),
        )
        return result

    # -- individual steps ---------------------------------------------------

    async def _run_step(
        self, step: StepState, ready_events: Mapping[str, asyncio.Event]
    ) -> None:
        action = step.action
        driver = self._drivers.get(action.device)
        if driver is None:
            step.health = DeviceHealth.ERROR
            step.error = "kein Treiber konfiguriert"
            step.finished_at = self._time()
            if action.required:
                raise TransitionAborted(action.device, step.error)
            return

        spec = driver.spec
        step.started_at = self._time()
        try:
            if action.kind is ActionKind.STOP:
                await self._do_stop(driver, step)
            elif action.kind is ActionKind.START:
                await self._await_dependencies(spec, ready_events)
                await self._do_start(driver, step)
            elif action.kind is ActionKind.RECONFIGURE:
                await self._await_dependencies(spec, ready_events)
                await self._do_reconfigure(driver, step)
        except TransitionAborted:
            step.finished_at = self._time()
            ready_events[action.device].set()
            raise
        except Exception as err:
            step.health = DeviceHealth.ERROR
            step.error = str(err)
            step.finished_at = self._time()
            ready_events[action.device].set()
            if action.required:
                raise TransitionAborted(action.device, str(err)) from err
            _LOGGER.warning(
                "Optionales Gerät %s ist fehlgeschlagen: %s", action.device, err
            )
            return

        step.finished_at = self._time()
        ready_events[action.device].set()

    async def _await_dependencies(
        self, spec: DeviceSpec, ready_events: Mapping[str, asyncio.Event]
    ) -> None:
        for dependency in spec.depends_on:
            event = ready_events.get(dependency)
            if event is not None:
                await event.wait()

    async def _do_start(self, driver: DeviceDriver, step: StepState) -> None:
        spec = driver.spec
        step.health = DeviceHealth.STARTING
        observation = await driver.observe()

        if not driver.is_ready(observation):
            await driver.start()
            observation = await self._wait_until(
                driver,
                predicate=driver.is_ready,
                timeout=spec.startup_timeout,
                step=step,
                what="startet",
            )
            self._estimator.record(
                spec.key,
                "start",
                step.elapsed(self._time()),
                from_cold=True,
            )

        if step.action.settings:
            await driver.apply(dict(step.action.settings))
        step.health = DeviceHealth.READY

    async def _do_reconfigure(self, driver: DeviceDriver, step: StepState) -> None:
        step.health = DeviceHealth.STARTING
        await driver.apply(dict(step.action.settings))
        step.health = DeviceHealth.READY
        self._estimator.record(
            driver.spec.key,
            "reconfigure",
            step.elapsed(self._time()),
            from_cold=False,
        )

    async def _do_stop(self, driver: DeviceDriver, step: StepState) -> None:
        spec = driver.spec
        step.health = DeviceHealth.STOPPING
        await driver.stop()
        try:
            await self._wait_until(
                driver,
                predicate=lambda obs: obs.power in (Power.OFF, Power.UNAVAILABLE),
                timeout=spec.shutdown_timeout,
                step=step,
                what="fährt herunter",
            )
        except TimeoutError as err:
            # One unreachable device must not block the others, but an
            # unverified shutdown is still an error the user gets to see.
            step.health = DeviceHealth.ERROR
            step.error = f"{spec.name} hat das Ausschalten nicht bestätigt"
            raise TransitionAborted(spec.key, step.error) from err
        step.health = DeviceHealth.OFF
        # Learned like the start durations, so the shutdown ETA reflects what
        # this projector actually does rather than the configured worst case.
        self._estimator.record(
            spec.key, "stop", step.elapsed(self._time()), from_cold=True
        )

    async def _wait_until(
        self,
        driver: DeviceDriver,
        *,
        predicate: Callable[[DeviceObservation], bool],
        timeout: float,
        step: StepState,
        what: str,
    ) -> DeviceObservation:
        deadline = self._time() + timeout
        while True:
            observation = await driver.observe()
            if observation.error:
                step.error = observation.error
            if predicate(observation):
                return observation
            if self._time() >= deadline:
                raise TimeoutError(
                    f"{driver.spec.name} {what} nicht innerhalb von {int(timeout)}s"
                )
            await self._sleep(self._poll)

    async def _stop_outgoing_playback(self, plan: TransitionPlan) -> None:
        """Stop media cleanly before its player is powered down (FR-14)."""
        for action in plan.stops:
            driver = self._drivers.get(action.device)
            if driver is None or not driver.spec.is_media:
                continue
            try:
                await driver.stop_playback()
            except Exception as err:  # noqa: BLE001
                _LOGGER.warning(
                    "Wiedergabe auf %s konnte nicht sauber beendet werden: %s",
                    action.device,
                    err,
                )

    # -- progress reporting -------------------------------------------------

    def _build_steps(self, plan: TransitionPlan) -> list[StepState]:
        steps: list[StepState] = []
        for action in plan.actions:
            driver = self._drivers.get(action.device)
            spec = driver.spec if driver else None
            if action.kind is ActionKind.START:
                default = spec.default_startup_seconds if spec else 30.0
                estimate = self._estimator.estimate(
                    action.device, "start", default, from_cold=True
                )
            elif action.kind is ActionKind.STOP:
                default = spec.default_shutdown_seconds if spec else 20.0
                estimate = self._estimator.estimate(
                    action.device, "stop", default, from_cold=True
                )
            elif action.kind is ActionKind.RECONFIGURE:
                estimate = self._estimator.estimate(
                    action.device, "reconfigure", 3.0, from_cold=False
                )
            else:
                estimate = 0.0
            steps.append(StepState(action=action, estimate=estimate))
        return steps

    async def _report_loop(
        self,
        plan: TransitionPlan,
        steps: Sequence[StepState],
        on_progress: ProgressCallback | None,
    ) -> None:
        if on_progress is None:
            return
        try:
            while True:
                await self._emit(on_progress, self._snapshot(plan, steps))
                await self._sleep(self._poll)
        except asyncio.CancelledError:
            return

    def _snapshot(
        self,
        plan: TransitionPlan,
        steps: Sequence[StepState],
        *,
        finished: bool = False,
        failure: TransitionAborted | None = None,
    ) -> TransitionProgress:
        now = self._time()
        weights = [max(step.estimate, 0.1) for step in steps]
        total = sum(weights) or 1.0
        done = sum(
            weight * step.fraction(now)
            for weight, step in zip(weights, steps, strict=True)
        )

        bottleneck_step: StepState | None = None
        remaining = 0.0
        for step in steps:
            if step.done:
                continue
            left = max(0.0, step.estimate - step.elapsed(now))
            if bottleneck_step is None or left > remaining:
                bottleneck_step = step
                remaining = left

        driver = (
            self._drivers.get(bottleneck_step.action.device)
            if bottleneck_step
            else None
        )
        name = driver.spec.name if driver else None

        return TransitionProgress(
            to_activity=plan.to_activity,
            from_activity=plan.from_activity,
            percent=100 if finished else int(min(99.0, done / total * 100.0)),
            eta_seconds=0.0 if finished else remaining,
            bottleneck=None if finished else _bottleneck_text(name, bottleneck_step),
            bottleneck_device=(
                None
                if finished or not bottleneck_step
                else bottleneck_step.action.device
            ),
            device_health={s.action.device: s.health for s in steps},
            finished=finished,
            failed=failure is not None,
            error=None if failure is None else str(failure),
        )

    @staticmethod
    async def _emit(
        callback: ProgressCallback | None, progress: TransitionProgress
    ) -> None:
        if callback is None:
            return
        result = callback(progress)
        if asyncio.iscoroutine(result):
            await result


def _bottleneck_text(name: str | None, step: StepState | None) -> str | None:
    if step is None or name is None:
        return None
    if step.action.kind is ActionKind.STOP:
        return f"{name} fährt herunter"
    if step.action.kind is ActionKind.RECONFIGURE:
        return f"{name} wird umkonfiguriert"
    return f"{name} startet"
