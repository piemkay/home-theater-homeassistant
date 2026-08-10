"""Config validation must fail loudly and name the offending field (A17)."""

from __future__ import annotations

import pytest

from custom_components.kino.core.model import ControlClass, PowerTarget
from custom_components.kino.core.schema import ConfigErrors, validate


def test_valid_document_round_trips(config_doc):
    config = validate(config_doc)

    assert set(config.activities) == {"aus", "film", "netflix", "musik", "steam"}
    assert config.off_activity == "aus"
    assert config.activities["film"].control_class is ControlClass.FULL
    assert config.activities["film"].devices["barco"].settings == {
        "profile": "HDR 260 HDMI"
    }
    assert config.devices["barco"].unverifiable_settings == frozenset({"profile"})
    assert config.devices["shield"].required is False
    assert config.volume_device == "trinnov"


def test_inline_settings_and_nested_settings_are_equivalent(config_doc):
    config_doc["activities"]["film"]["devices"]["trinnov"] = {
        "power": True,
        "settings": {"source": "zidoo", "volume": -30.0},
    }
    config = validate(config_doc)
    assert config.activities["film"].devices["trinnov"].settings == {
        "source": "zidoo",
        "volume": -30.0,
    }


def test_power_off_requirement_is_understood(config_doc):
    config_doc["activities"]["musik"]["devices"]["barco"] = {"power": False}
    config = validate(config_doc)
    requirement = config.activities["musik"].devices["barco"]
    assert requirement.power is PowerTarget.OFF
    assert config.activities["musik"].requires("barco") is False


def test_unknown_device_in_activity_names_activity_device_and_path(config_doc):
    config_doc["activities"]["film"]["devices"]["beamer"] = {"power": True}

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    paths = [error.path for error in excinfo.value.errors]
    assert "activities.film.devices.beamer" in paths
    assert "unbekanntes Gerät" in str(excinfo.value)


def test_unknown_driver_is_rejected(config_doc):
    config_doc["devices"]["barco"]["driver"] = "beamer9000"

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "devices.barco.driver" for e in excinfo.value.errors)


def test_typo_in_field_name_is_not_silently_accepted(config_doc):
    config_doc["devices"]["trinnov"]["startup_timout"] = 30

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "devices.trinnov.startup_timout" for e in excinfo.value.errors
    )


def test_off_activity_may_not_power_anything_on(config_doc):
    config_doc["activities"]["aus"]["devices"] = {"barco": {"power": True}}

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any("Aus-Aktivität" in e.message for e in excinfo.value.errors)


def test_device_used_by_no_activity_is_flagged(config_doc):
    config_doc["devices"]["appletv"] = {
        "driver": "generic",
        "name": "Apple TV",
        "entities": {"media_player": "media_player.appletv"},
    }

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "devices.appletv" and "keiner Aktivität" in e.message
        for e in excinfo.value.errors
    )


def test_dependency_cycles_are_rejected(config_doc):
    config_doc["devices"]["barco"]["depends_on"] = ["madvr"]
    config_doc["devices"]["madvr"]["depends_on"] = ["barco"]

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any("zyklische Abhängigkeit" in e.message for e in excinfo.value.errors)


def test_invalid_entity_id_is_rejected(config_doc):
    config_doc["devices"]["madvr"]["entities"]["power"] = "madvr_envy"

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "devices.madvr.entities.power" for e in excinfo.value.errors
    )


def test_light_scene_must_be_a_scene_entity(config_doc):
    config_doc["activities"]["film"]["light_scene"] = "script.dark"

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "activities.film.light_scene" for e in excinfo.value.errors
    )


def test_volume_bounds_must_be_ordered(config_doc):
    config_doc["settings"]["volume"]["min_db"] = -10
    config_doc["settings"]["volume"]["max_db"] = -40

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "settings.volume" for e in excinfo.value.errors)


def test_all_errors_are_reported_in_one_pass(config_doc):
    config_doc["devices"]["barco"]["driver"] = "nope"
    config_doc["activities"]["film"]["light_scene"] = "light.dark"
    config_doc["settings"]["off_activity"] = "offline"

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert len(excinfo.value.errors) >= 3
