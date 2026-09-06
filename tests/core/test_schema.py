"""Config validation must fail loudly and name the offending field (A17)."""

from __future__ import annotations

import pytest

from custom_components.kino.core.model import (
    ControlClass,
    LightPosition,
    PowerTarget,
)
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

    assert any(e.path == "devices.trinnov.startup_timout" for e in excinfo.value.errors)


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

    assert any(e.path == "devices.madvr.entities.power" for e in excinfo.value.errors)


def test_light_scene_must_be_a_scene_entity(config_doc):
    config_doc["activities"]["film"]["light_scene"] = "script.dark"

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "activities.film.light_scene" for e in excinfo.value.errors)


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


def test_no_lights_configured_means_no_light_row(config_doc):
    config = validate(config_doc)

    assert config.lights.controls == ()
    assert config.lights.position is LightPosition.BELOW


def test_lights_accept_the_short_hand_list(config_doc):
    config_doc["settings"]["lights"] = ["scene.dark", "light.kino_deckenspots"]

    config = validate(config_doc)

    assert [c.entity for c in config.lights.controls] == [
        "scene.dark",
        "light.kino_deckenspots",
    ]
    assert config.lights.controls[0].momentary is True
    assert config.lights.controls[1].momentary is False
    assert config.lights.title == "Licht"


def test_lights_keep_their_configured_order_and_labels(config_doc):
    config_doc["settings"]["lights"] = {
        "title": "Beleuchtung",
        "position": "above",
        "controls": [
            {"entity": "scene.low_ambience", "name": "Gedimmt", "icon": "mdi:lamp"},
            "switch.kino_led",
        ],
    }

    config = validate(config_doc)

    assert config.lights.position is LightPosition.ABOVE
    assert config.lights.title == "Beleuchtung"
    first, second = config.lights.controls
    assert (first.entity, first.name, first.icon) == (
        "scene.low_ambience",
        "Gedimmt",
        "mdi:lamp",
    )
    assert (second.entity, second.name) == ("switch.kino_led", None)


def test_a_light_entity_nothing_can_switch_is_rejected(config_doc):
    config_doc["settings"]["lights"] = ["sensor.kino_temperatur"]

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "settings.lights.controls[0].entity" for e in excinfo.value.errors
    )


def test_a_light_listed_twice_is_a_typo_not_two_buttons(config_doc):
    config_doc["settings"]["lights"] = ["scene.dark", "scene.dark"]

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "settings.lights.controls[1]" for e in excinfo.value.errors)


def test_an_empty_light_title_is_written_as_a_string(config_doc):
    """The row without a heading — the spelling the README documents.

    A bare ``title:`` is YAML null, which this schema rejects the way it
    rejects null in eleven other fields. So the way to ask for no heading is
    an explicit empty string, and that has to keep working.
    """
    config_doc["settings"]["lights"] = {"title": "  ", "controls": ["scene.dark"]}

    assert validate(config_doc).lights.title == ""


def test_a_null_light_title_is_rejected_by_name(config_doc):
    config_doc["settings"]["lights"] = {"title": None, "controls": ["scene.dark"]}

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "settings.lights.title" for e in excinfo.value.errors)


def test_an_unknown_light_position_names_the_field(config_doc):
    config_doc["settings"]["lights"] = {"position": "links", "controls": []}

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(e.path == "settings.lights.position" for e in excinfo.value.errors)


def test_a_misspelled_light_field_is_named(config_doc):
    config_doc["settings"]["lights"] = {
        "controls": [{"entity": "scene.dark", "lable": "x"}]
    }

    with pytest.raises(ConfigErrors) as excinfo:
        validate(config_doc)

    assert any(
        e.path == "settings.lights.controls[0].lable" for e in excinfo.value.errors
    )


def test_shipped_default_document_is_valid():
    """
    The starter config we write on first setup must load cleanly.

    YAML 1.1 turns bare `off` into False, which would silently mangle
    `control_class: off` — this test is what catches that.
    """
    import yaml

    from custom_components.kino.config_store import DEFAULT_DOCUMENT

    config = validate(yaml.safe_load(DEFAULT_DOCUMENT))

    assert config.off_activity == "aus"
    assert config.activities["aus"].control_class is ControlClass.OFF
    assert config.activities["film"].devices["barco"].settings == {
        "profile": "HDR 260 HDMI"
    }
    assert config.activities["musik"].requires("barco") is False
    assert config.devices["shield"].required is False
    # The light row ships configured — it is what makes the card usable with
    # the theater off.
    assert [c.entity for c in config.lights.controls] == [
        "scene.dark",
        "scene.low_ambience",
        "scene.bright_ambience",
        "light.kino_deckenspots",
    ]
