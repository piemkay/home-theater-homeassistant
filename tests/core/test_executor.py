"""Execution semantics: concurrency, dependencies, readiness and failure."""

from __future__ import annotations

import pytest

from custom_components.kino.core.estimator import DurationEstimator
from custom_components.kino.core.executor import (
    TransitionExecutor,
    TransitionProgress,
)
from custom_components.kino.core.model import DeviceHealth, Power
from custom_components.kino.core.planner import plan_transition


def _executor(drivers, clock, estimator=None):
    return TransitionExecutor(
        drivers=drivers,
        estimator=estimator or DurationEstimator(),
        poll_interval=1.0,
        time_fn=clock.time,
        sleep_fn=clock.sleep,
    )


def _plan(config, drivers, target_key, current="aus", observations=None):
    if observations is None:
        observations = {
            key: driver_observation(driver) for key, driver in drivers.items()
        }
    return plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities[target_key],
        current_activity=current,
    )


def driver_observation(driver):
    from custom_components.kino.core.model import DeviceObservation

    return DeviceObservation(
        device=driver.spec.key,
        power=driver.power,
        settings=dict(driver.settings),
        available=driver.available,
    )


async def test_cold_start_runs_devices_concurrently(config, drivers, clock):
    """FR-12: total time is the slowest device, not the sum of all of them."""
    plan = _plan(config, drivers, "film")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert result.succeeded
    # Barco 120s dominates; trinnov 40 + madvr 25 + zidoo 20 would be 205s if
    # anything were serialised.
    assert result.duration_seconds == pytest.approx(120.0, abs=2.0)
    for key in ("barco", "trinnov", "madvr", "zidoo"):
        assert drivers[key].power is Power.ON


async def test_settings_are_applied_after_the_device_is_ready(config, drivers, clock):
    plan = _plan(config, drivers, "film")

    await clock.run(_executor(drivers, clock).execute(plan))

    assert drivers["barco"].calls == ["start", "apply"]
    assert drivers["barco"].applied == [{"profile": "HDR 260 HDMI"}]
    assert drivers["trinnov"].applied == [{"source": "zidoo", "volume": -30.0}]
    # madVR has no per-activity settings, so it is never written to.
    assert drivers["madvr"].calls == ["start"]


async def test_device_already_ready_is_not_restarted(config, drivers, clock):
    """FR-11 / FR-26: a warm device costs nothing and adds no floor."""
    drivers["trinnov"].power = Power.ON
    drivers["trinnov"].settings = {"source": "zidoo", "volume": -30.0}
    plan = _plan(config, drivers, "film")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert result.succeeded
    assert drivers["trinnov"].calls == []


async def test_dependencies_serialise_only_where_real(config_doc, clock):
    """FR-21: the Trinnov must be up before its source can be selected."""
    from custom_components.kino.core.schema import validate
    from tests.conftest import FakeDriver

    config_doc["devices"]["zidoo"]["depends_on"] = ["trinnov"]
    config = validate(config_doc)
    drivers = {
        key: FakeDriver(spec, clock, start_seconds=10.0)
        for key, spec in config.devices.items()
    }
    drivers["trinnov"].start_seconds = 40.0

    order: list[str] = []
    for key, driver in drivers.items():
        original = driver.apply

        async def _apply(settings, _key=key, _original=original):
            order.append(_key)
            await _original(settings)

        driver.apply = _apply  # type: ignore[method-assign]

    plan = _plan(config, drivers, "musik")
    await clock.run(_executor(drivers, clock).execute(plan))

    assert drivers["zidoo"].power is Power.ON
    # Zidoo waited for the Trinnov rather than racing it.
    assert order and order[0] == "trinnov"


async def test_critical_path_device_is_started_first(config, drivers, clock):
    """FR-22: the projector is kicked off before the fast devices."""
    started: list[str] = []
    for key, driver in drivers.items():
        original = driver.start

        async def _start(_key=key, _original=original):
            started.append(_key)
            await _original()

        driver.start = _start  # type: ignore[method-assign]

    plan = _plan(config, drivers, "film")
    await clock.run(_executor(drivers, clock).execute(plan))

    assert started[0] == "barco"


async def test_musik_does_not_wait_on_the_projector(config, drivers, clock):
    """A3/FR-23: an activity without a projector is fast."""
    plan = _plan(config, drivers, "musik")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert result.succeeded
    assert result.duration_seconds == pytest.approx(40.0, abs=2.0)
    assert drivers["barco"].calls == []


async def test_playback_is_stopped_before_its_player_powers_down(
    config, drivers, clock
):
    """FR-14."""
    for key in ("barco", "trinnov", "madvr", "zidoo"):
        drivers[key].power = Power.ON
    drivers["trinnov"].settings = {"source": "zidoo", "volume": -30.0}
    plan = _plan(config, drivers, "musik", current="film")

    await clock.run(_executor(drivers, clock).execute(plan))

    assert drivers["zidoo"].calls == []  # kept, so never touched
    assert "stop_playback" not in drivers["barco"].calls  # not a media device

    # Now switch to an activity that drops the Zidoo entirely.
    plan = _plan(config, drivers, "netflix", current="musik")
    await clock.run(_executor(drivers, clock).execute(plan))
    assert drivers["zidoo"].calls[:2] == ["stop_playback", "stop"]


async def test_unverified_shutdown_raises_but_does_not_block_others(
    config, drivers, clock
):
    """FR-34: best-effort per device, with explicit verification."""
    for key in ("barco", "trinnov", "madvr", "zidoo"):
        drivers[key].power = Power.ON
    drivers["barco"].never_stops = True
    plan = _plan(config, drivers, "aus", current="film")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert not result.succeeded
    assert "Beamer" in (result.error or "")
    # The others still went down.
    for key in ("trinnov", "madvr", "zidoo"):
        assert drivers[key].power is Power.OFF


async def test_optional_device_failure_does_not_fail_the_transition(
    config, drivers, clock
):
    drivers["shield"].fail_start = True
    plan = _plan(config, drivers, "netflix")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert result.succeeded
    shield_step = next(s for s in result.steps if s.action.device == "shield")
    assert shield_step.health is DeviceHealth.ERROR
    assert drivers["barco"].power is Power.ON


async def test_required_device_failure_aborts_with_a_named_device(
    config, drivers, clock
):
    """A9: the message names the device."""
    drivers["barco"].fail_start = True
    plan = _plan(config, drivers, "film")

    result = await clock.run(_executor(drivers, clock).execute(plan))

    assert not result.succeeded
    assert "barco" in (result.error or "")
    assert "Beamer antwortet nicht" in (result.error or "")


async def test_startup_timeout_is_reported_not_hung(config, drivers, clock):
    """NFR-2: a stuck transition times out rather than wedging."""
    drivers["madvr"].start_seconds = 10_000.0
    plan = _plan(config, drivers, "film")

    result = await clock.run(
        _executor(drivers, clock).execute(plan),
        max_steps=50_000,
    )

    assert not result.succeeded
    assert "madVR" in (result.error or "")


async def test_progress_reports_a_named_bottleneck(config, drivers, clock):
    updates: list[TransitionProgress] = []
    plan = _plan(config, drivers, "film")

    await clock.run(_executor(drivers, clock).execute(plan, on_progress=updates.append))

    assert updates
    assert updates[0].percent < updates[-1].percent
    assert updates[-1].percent == 100
    assert updates[-1].finished
    mid = updates[len(updates) // 2]
    assert mid.bottleneck == "Beamer startet"
    assert mid.bottleneck_device == "barco"
    assert 0 <= mid.percent <= 99


async def test_durations_are_learned_from_observed_runs(config, drivers, clock):
    """FR-24: the ETA comes from what actually happened."""
    estimator = DurationEstimator()
    plan = _plan(config, drivers, "musik")

    await clock.run(_executor(drivers, clock, estimator).execute(plan))

    sample = next(
        row
        for row in estimator.report()
        if row["device"] == "trinnov" and row["kind"] == "start"
    )
    assert sample["last_seconds"] == pytest.approx(40.0, abs=2.0)
    # A single sample is blended with the configured default rather than
    # trusted outright, so the first ETA after install is not wildly wrong.
    blended = estimator.estimate("trinnov", "start", default=100.0)
    assert 40.0 < blended < 100.0
