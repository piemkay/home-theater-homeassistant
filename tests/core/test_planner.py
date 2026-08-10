"""The differential planner is the heart of FR-10 .. FR-14 and A2/A3/A4."""

from __future__ import annotations

from custom_components.kino.core.model import (
    ActionKind,
    DeviceObservation,
    Power,
)
from custom_components.kino.core.planner import infer_active_activity, plan_transition


def _obs(device, power=Power.OFF, settings=None, unverified=()):
    return DeviceObservation(
        device=device,
        power=power,
        settings=settings or {},
        unverified=frozenset(unverified),
    )


def _all_off(config):
    return {key: _obs(key) for key in config.devices}


def _film_running(config):
    """Everything the Film activity needs, already correct."""
    return {
        "barco": _obs("barco", Power.ON, {"profile": "HDR 260 HDMI"}),
        "trinnov": _obs("trinnov", Power.ON, {"source": "zidoo", "volume": -30.0}),
        "madvr": _obs("madvr", Power.ON),
        "zidoo": _obs("zidoo", Power.ON),
        "shield": _obs("shield", Power.OFF),
    }


def test_cold_start_is_just_a_delta_from_the_empty_set(config):
    plan = plan_transition(
        devices=config.devices,
        observations=_all_off(config),
        target=config.activities["film"],
        current_activity="aus",
    )

    assert {a.device for a in plan.starts} == {"barco", "trinnov", "madvr", "zidoo"}
    assert plan.stops == ()
    assert plan.keeps == ()
    # Settings ride along with the start so nothing needs a second pass.
    start = next(a for a in plan.starts if a.device == "barco")
    assert start.settings == {"profile": "HDR 260 HDMI"}


def test_selecting_the_active_activity_is_a_no_op(config):
    plan = plan_transition(
        devices=config.devices,
        observations=_film_running(config),
        target=config.activities["film"],
        current_activity="film",
    )

    assert plan.is_empty
    assert {a.device for a in plan.keeps} == {
        "barco",
        "trinnov",
        "madvr",
        "zidoo",
    }


def test_film_to_netflix_keeps_the_projector_and_only_reconfigures(config):
    """A2: Barco and Trinnov stay on; Zidoo stops; Shield starts."""
    plan = plan_transition(
        devices=config.devices,
        observations=_film_running(config),
        target=config.activities["netflix"],
        current_activity="film",
    )

    kinds = {a.device: a.kind for a in plan.actions}
    assert kinds["barco"] is ActionKind.KEEP
    assert kinds["madvr"] is ActionKind.KEEP
    assert kinds["trinnov"] is ActionKind.RECONFIGURE
    assert kinds["zidoo"] is ActionKind.STOP
    assert kinds["shield"] is ActionKind.START
    # No power cycling of anything shared.
    assert "barco" not in {a.device for a in plan.stops}
    # Only the setting that actually differs gets written.
    trinnov = next(a for a in plan.reconfigures if a.device == "trinnov")
    assert trinnov.settings == {"source": "shield"}


def test_film_to_musik_drops_projector_and_madvr(config):
    """A3: no waiting on the projector for a no-projector activity."""
    plan = plan_transition(
        devices=config.devices,
        observations=_film_running(config),
        target=config.activities["musik"],
        current_activity="film",
    )

    assert {a.device for a in plan.stops} == {"barco", "madvr"}
    assert {a.device for a in plan.keeps} == {"zidoo"}
    trinnov = next(a for a in plan.reconfigures if a.device == "trinnov")
    assert trinnov.settings == {"volume": -35.0}


def test_musik_to_film_starts_the_projector_and_cycles_nothing_else(config):
    """A4: projector starts from cold, nothing else power-cycles."""
    observations = {
        "barco": _obs("barco", Power.OFF),
        "trinnov": _obs("trinnov", Power.ON, {"source": "zidoo", "volume": -35.0}),
        "madvr": _obs("madvr", Power.OFF),
        "zidoo": _obs("zidoo", Power.ON),
        "shield": _obs("shield", Power.OFF),
    }

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="musik",
    )

    assert {a.device for a in plan.starts} == {"barco", "madvr"}
    assert plan.stops == ()
    assert {a.device for a in plan.keeps} == {"zidoo"}
    assert {a.device for a in plan.reconfigures} == {"trinnov"}


def test_turning_off_stops_everything_that_is_on(config):
    plan = plan_transition(
        devices=config.devices,
        observations=_film_running(config),
        target=config.activities["aus"],
        current_activity="film",
    )

    assert {a.device for a in plan.stops} == {
        "barco",
        "trinnov",
        "madvr",
        "zidoo",
    }
    assert plan.starts == ()


def test_device_already_correct_is_skipped_entirely(config):
    """FR-11: no redundant commands for a device that is already right."""
    observations = _film_running(config)
    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="film",
    )

    assert all(a.kind is ActionKind.KEEP for a in plan.actions)
    assert plan.describe() == "keep: barco, madvr, trinnov, zidoo"


def test_unverifiable_profile_forces_a_reconfigure(config):
    """FR-143: without a shadow value the projector profile must be re-applied."""
    observations = _film_running(config)
    observations["barco"] = _obs("barco", Power.ON)  # no profile reported at all

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="film",
    )

    barco = next(a for a in plan.reconfigures if a.device == "barco")
    assert barco.settings == {"profile": "HDR 260 HDMI"}


def test_shadow_value_lets_the_projector_be_kept(config):
    """With FR-143 implemented upstream, "keep" becomes decidable."""
    observations = _film_running(config)

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="film",
    )

    barco = next(a for a in plan.actions if a.device == "barco")
    assert barco.kind is ActionKind.KEEP


def test_unverified_setting_is_never_assumed_correct(config):
    observations = _film_running(config)
    observations["barco"] = _obs(
        "barco", Power.ON, {"profile": "HDR 260 HDMI"}, unverified={"profile"}
    )

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="film",
    )

    assert next(a for a in plan.actions if a.device == "barco").kind is (
        ActionKind.RECONFIGURE
    )


def test_unavailable_device_is_started_not_assumed_on(config):
    observations = _all_off(config)
    observations["trinnov"] = DeviceObservation(
        device="trinnov", power=Power.UNAVAILABLE, available=False
    )

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["musik"],
        current_activity="aus",
    )

    assert {a.device for a in plan.starts} == {"trinnov", "zidoo"}


def test_stray_device_not_in_target_is_stopped(config):
    """Something left running by an earlier activity gets cleaned up."""
    observations = _all_off(config)
    observations["shield"] = _obs("shield", Power.ON)

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["musik"],
        current_activity="aus",
    )

    assert {a.device for a in plan.stops} == {"shield"}


def test_float_volume_comparison_tolerates_representation(config):
    observations = _film_running(config)
    observations["trinnov"] = _obs(
        "trinnov", Power.ON, {"source": "zidoo", "volume": -30.000000001}
    )

    plan = plan_transition(
        devices=config.devices,
        observations=observations,
        target=config.activities["film"],
        current_activity="film",
    )

    assert next(a for a in plan.actions if a.device == "trinnov").kind is (
        ActionKind.KEEP
    )


class TestInferActivity:
    """FR-31: state is derived from the devices, not from a stored value."""

    def test_nothing_powered_means_off(self, config):
        activity, deviations = infer_active_activity(
            devices=config.devices,
            observations=_all_off(config),
            activities=config.activities,
            off_activity="aus",
        )
        assert activity == "aus"
        assert deviations == []

    def test_film_devices_powered_infers_film(self, config):
        activity, deviations = infer_active_activity(
            devices=config.devices,
            observations=_film_running(config),
            activities=config.activities,
            off_activity="aus",
        )
        assert activity == "film"
        assert deviations == []

    def test_partial_room_reconciles_to_closest_activity(self, config):
        observations = _film_running(config)
        observations["madvr"] = _obs("madvr", Power.OFF)

        activity, deviations = infer_active_activity(
            devices=config.devices,
            observations=observations,
            activities=config.activities,
            off_activity="aus",
        )
        assert activity == "film"
        assert deviations == ["madvr"]

    def test_only_trinnov_and_zidoo_powered_infers_musik(self, config):
        observations = _all_off(config)
        observations["trinnov"] = _obs(
            "trinnov", Power.ON, {"source": "zidoo", "volume": -35.0}
        )
        observations["zidoo"] = _obs("zidoo", Power.ON)

        activity, _ = infer_active_activity(
            devices=config.devices,
            observations=observations,
            activities=config.activities,
            off_activity="aus",
        )
        assert activity == "musik"
