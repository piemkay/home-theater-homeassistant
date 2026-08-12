"""State machine behaviour: reconciliation, idempotence, interruption, drift."""

from __future__ import annotations

import asyncio

import pytest

from custom_components.kino.core.machine import ActivityEngine
from custom_components.kino.core.model import (
    ActivityState,
    DeviceHealth,
    DriftClass,
    Power,
)


def _engine(config, drivers, clock):
    return ActivityEngine(
        config=config,
        drivers=drivers,
        poll_interval=1.0,
        time_fn=clock.time,
        sleep_fn=clock.sleep,
    )


async def _activate(engine, clock, key):
    async def _run():
        await engine.activate(key)
        await engine.wait_for_transition()

    return await clock.run(_run(), max_steps=50_000)


async def test_cold_start_reaches_on(config, drivers, clock):
    engine = _engine(config, drivers, clock)

    await _activate(engine, clock, "film")

    snapshot = engine.snapshot()
    assert snapshot.state is ActivityState.ON
    assert snapshot.activity == "film"
    assert snapshot.progress is None
    assert snapshot.status_text() == "Bereit"


async def test_state_is_derived_from_devices_after_a_restart(config, drivers, clock):
    """NFR-3 / FR-31: a fresh engine reconciles to whatever the room is doing."""
    for key in ("barco", "trinnov", "madvr", "zidoo"):
        drivers[key].power = Power.ON
    drivers["barco"].settings = {"profile": "HDR 260 HDMI"}
    drivers["trinnov"].settings = {"source": "zidoo", "volume": -30.0}

    engine = _engine(config, drivers, clock)
    assert engine.snapshot().activity == "aus"  # nothing observed yet

    await clock.run(engine.reconcile())

    snapshot = engine.snapshot()
    assert snapshot.activity == "film"
    assert snapshot.state is ActivityState.ON
    assert snapshot.device_health["barco"] is DeviceHealth.READY


async def test_idle_room_never_shows_a_starting_device(config, drivers, clock):
    """F1: a reconnecting integration must not pulse "starting" in a dark room.

    The Trinnov integration idles in a connecting loop while the processor is
    unpowered; whatever movement it reports is only surfaced while Kino has an
    intent for the device. Idle room ⇒ every chip grey within one poll.
    """
    drivers["trinnov"].power = Power.TRANSITIONING

    engine = _engine(config, drivers, clock)
    await clock.run(engine.reconcile())

    snapshot = engine.snapshot()
    assert snapshot.activity == "aus"
    assert snapshot.device_health["trinnov"] is DeviceHealth.OFF


async def test_a_required_device_of_the_active_activity_may_show_starting(
    config, drivers, clock
):
    """The same movement is real news while the activity wants the device on."""
    for key in ("trinnov", "zidoo"):
        drivers[key].power = Power.ON
    drivers["trinnov"].settings = {"source": "zidoo", "volume": -35.0}
    engine = _engine(config, drivers, clock)
    await clock.run(engine.reconcile())
    assert engine.snapshot().activity == "musik"

    drivers["zidoo"].power = Power.TRANSITIONING
    await clock.run(engine.reconcile())

    assert engine.snapshot().device_health["zidoo"] is DeviceHealth.STARTING


async def test_selecting_the_active_activity_does_nothing(config, drivers, clock):
    """FR-32 / A10: repeat taps are safe and are not silently discarded."""
    engine = _engine(config, drivers, clock)
    await _activate(engine, clock, "film")
    for driver in drivers.values():
        driver.calls.clear()

    await _activate(engine, clock, "film")

    assert all(driver.calls == [] for driver in drivers.values())
    assert engine.snapshot().state is ActivityState.ON


async def test_double_tap_during_startup_does_not_start_twice(config, drivers, clock):
    """A10: an impatient second tap on the same activity is absorbed."""
    engine = _engine(config, drivers, clock)

    async def _run():
        await engine.activate("film")
        await asyncio.sleep(0)
        await engine.activate("film")
        await engine.wait_for_transition()

    await clock.run(_run(), max_steps=50_000)

    assert drivers["barco"].calls.count("start") == 1
    assert engine.snapshot().activity == "film"


async def test_switching_mid_transition_retargets(config, drivers, clock):
    """FR-32: a different activity re-targets rather than queuing."""
    engine = _engine(config, drivers, clock)

    async def _run():
        await engine.activate("film")
        # Let the projector get going, then change our mind.
        for _ in range(20):
            await asyncio.sleep(0)
        await engine.activate("musik")
        await engine.wait_for_transition()

    await clock.run(_run(), max_steps=50_000)

    snapshot = engine.snapshot()
    assert snapshot.activity == "musik"
    assert snapshot.state is ActivityState.ON
    assert drivers["trinnov"].power is Power.ON
    assert drivers["barco"].power is Power.OFF


async def test_shutdown_cancels_a_running_transition(config, drivers, clock):
    """An unloaded or replaced engine must not keep driving hardware."""
    engine = _engine(config, drivers, clock)
    notifications = []
    engine.add_listener(notifications.append)

    async def _run():
        await engine.activate("film")
        for _ in range(20):
            await asyncio.sleep(0)
        await engine.async_shutdown()

    await clock.run(_run(), max_steps=50_000)

    # The start was issued but the wait was cancelled mid-flight.
    assert drivers["barco"].calls.count("start") == 1
    assert drivers["barco"].power is not Power.ON

    # Listeners are detached: further engine activity notifies nobody.
    before = len(notifications)
    await clock.run(engine.reconcile())
    assert len(notifications) == before


async def test_transition_log_records_per_step_timings(config, drivers, clock):
    """FR-122 / A12: a slow switch can be diagnosed afterwards."""
    engine = _engine(config, drivers, clock)

    await _activate(engine, clock, "film")

    assert len(engine.transition_log) == 1
    entry = engine.transition_log[0]
    assert entry["succeeded"] is True
    assert entry["to_activity"] == "film"
    barco = next(s for s in entry["steps"] if s["device"] == "barco")
    assert barco["seconds"] == pytest.approx(120.0, abs=2.0)


async def test_failure_goes_to_error_with_a_plain_german_message(
    config, drivers, clock
):
    """A9 / FR-80."""
    drivers["barco"].fail_start = True
    engine = _engine(config, drivers, clock)

    await _activate(engine, clock, "film")

    snapshot = engine.snapshot()
    assert snapshot.state is ActivityState.ERROR
    assert "Beamer antwortet nicht" in snapshot.status_text()


async def test_error_state_survives_reconciliation(config, drivers, clock):
    """A failed transition must not be polled away into "Bereit" (FR-80/A9)."""
    drivers["barco"].fail_start = True
    engine = _engine(config, drivers, clock)

    await _activate(engine, clock, "film")
    assert engine.snapshot().state is ActivityState.ERROR

    # What the coordinator does a few polls later.
    clock.now += 30.0
    await clock.run(engine.reconcile())

    snapshot = engine.snapshot()
    assert snapshot.state is ActivityState.ERROR
    assert "Beamer antwortet nicht" in snapshot.status_text()


async def test_error_clears_when_the_room_reaches_the_target_by_hand(
    config, drivers, clock
):
    """The error is memory, not dogma: a coherent room makes it stale."""
    drivers["barco"].fail_start = True
    engine = _engine(config, drivers, clock)
    await _activate(engine, clock, "film")
    assert engine.snapshot().state is ActivityState.ERROR

    # Somebody powers the projector with its own remote; the other three
    # devices already came up during the failed attempt.
    drivers["barco"].power = Power.ON
    await clock.run(engine.reconcile())

    snapshot = engine.snapshot()
    assert snapshot.state is ActivityState.ON
    assert snapshot.activity == "film"
    assert snapshot.last_error is None


async def test_retry_after_failure_clears_the_error(config, drivers, clock):
    """FR-81: the retry button re-runs the wanted activity out of ERROR."""
    drivers["barco"].fail_start = True
    engine = _engine(config, drivers, clock)
    await _activate(engine, clock, "film")
    assert engine.snapshot().state is ActivityState.ERROR

    drivers["barco"].fail_start = False
    await _activate(engine, clock, "film")

    snapshot = engine.snapshot()
    assert snapshot.state is ActivityState.ON
    assert snapshot.last_error is None


async def test_dry_run_computes_a_plan_without_touching_anything(
    config, drivers, clock
):
    """FR-121."""
    engine = _engine(config, drivers, clock)

    plan = await clock.run(engine.dry_run("film"))

    assert {a.device for a in plan.starts} == {
        "barco",
        "trinnov",
        "madvr",
        "zidoo",
    }
    assert all(driver.calls == [] for driver in drivers.values())


class TestDrift:
    """FR-36 .. FR-39a: reconcile, never enforce."""

    async def test_device_switched_off_by_hand_is_reported_not_repowered(
        self, config, drivers, clock
    ):
        """A15: `on (degradiert)`, projector named, nothing fights back."""
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "film")
        drivers["barco"].calls.clear()

        drivers["barco"].power = Power.OFF
        await clock.run(engine.reconcile())  # first sighting, still debouncing
        assert engine.snapshot().drift == ()

        clock.now += 30.0
        await clock.run(engine.reconcile())

        snapshot = engine.snapshot()
        assert snapshot.degraded
        finding = snapshot.drift[0]
        assert finding.device == "barco"
        assert finding.classification is DriftClass.DELIBERATE
        assert "Beamer" in finding.detail
        assert finding.restorable
        # The crucial part: we did not switch it back on.
        assert drivers["barco"].calls == []
        assert snapshot.state is ActivityState.ON

    async def test_transient_flap_is_debounced_away(self, config, drivers, clock):
        """FR-39a."""
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "film")

        drivers["barco"].power = Power.TRANSITIONING
        await clock.run(engine.reconcile())
        clock.now += 5.0
        drivers["barco"].power = Power.ON
        await clock.run(engine.reconcile())

        assert engine.snapshot().drift == ()

    async def test_dormant_optional_device_is_benign(self, config, drivers, clock):
        """A14: the Shield idle-sleeping is not an error."""
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "netflix")

        drivers["shield"].power = Power.OFF
        await clock.run(engine.reconcile())
        clock.now += 30.0
        await clock.run(engine.reconcile())

        snapshot = engine.snapshot()
        assert snapshot.state is ActivityState.ON
        finding = next(f for f in snapshot.drift if f.device == "shield")
        assert finding.classification is DriftClass.BENIGN
        assert drivers["shield"].calls.count("start") == 1  # not re-powered

    async def test_unreachable_device_is_transport_class(self, config, drivers, clock):
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "film")

        drivers["madvr"].available = False
        await clock.run(engine.reconcile())
        clock.now += 30.0
        await clock.run(engine.reconcile())

        finding = next(f for f in engine.snapshot().drift if f.device == "madvr")
        assert finding.classification is DriftClass.TRANSPORT

    async def test_restore_brings_the_device_back(self, config, drivers, clock):
        """FR-39: one-tap "Wiederherstellen"."""
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "film")
        drivers["barco"].power = Power.OFF
        drivers["barco"].start_seconds = 0.0
        drivers["barco"].calls.clear()

        await clock.run(engine.restore_device("barco"), max_steps=50_000)

        assert drivers["barco"].power is Power.ON
        assert drivers["barco"].applied[-1] == {"profile": "HDR 260 HDMI"}
        assert engine.snapshot().drift == ()

    async def test_dismissed_drift_stops_being_reported(self, config, drivers, clock):
        engine = _engine(config, drivers, clock)
        await _activate(engine, clock, "film")
        drivers["barco"].power = Power.OFF
        await clock.run(engine.reconcile())
        clock.now += 30.0
        await clock.run(engine.reconcile())
        assert engine.snapshot().drift

        engine.dismiss_drift("barco")
        await clock.run(engine.reconcile())

        assert engine.snapshot().drift == ()
