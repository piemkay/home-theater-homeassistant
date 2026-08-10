"""
Driver behaviour against a fake Home Assistant state machine.

The Barco cases are transcribed from ten days of recorded `sensor.hodr_cs_state`
history, so they assert what the projector actually does rather than what the
manual implies.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

from custom_components.kino.core.model import DeviceSpec, Power
from custom_components.kino.devices import build_driver
from custom_components.kino.devices.barco import (
    PHASE_COOLING,
    PHASE_OFF,
    PHASE_ON,
    PHASE_WARMING,
)
from custom_components.kino.devices.bridge import StateSnapshot


class FakeBridge:
    """In-memory entity states plus a service-call recorder."""

    def __init__(self, states: Mapping[str, Any] | None = None) -> None:
        self.states: dict[str, StateSnapshot] = {}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.clock = 0.0
        for entity_id, value in (states or {}).items():
            self.set(entity_id, value)

    def set(self, entity_id: str, state: Any, **attributes: Any) -> None:
        if isinstance(state, StateSnapshot):
            self.states[entity_id] = state
            return
        self.states[entity_id] = StateSnapshot(
            entity_id=entity_id, state=str(state), attributes=attributes
        )

    def get_state(self, entity_id: str) -> StateSnapshot | None:
        return self.states.get(entity_id)

    async def call_service(
        self, domain: str, service: str, data: Mapping[str, Any]
    ) -> None:
        self.calls.append((domain, service, dict(data)))

    def now(self) -> float:
        return self.clock


BARCO_SPEC = DeviceSpec(
    key="barco",
    driver="barco",
    name="Beamer",
    entities={
        "power": "switch.hodr_cs_power",
        "state": "sensor.hodr_cs_state",
        "profile": "select.hodr_cs_profile",
    },
    unverifiable_settings=frozenset({"profile"}),
)

TRINNOV_SPEC = DeviceSpec(
    key="trinnov",
    driver="trinnov",
    name="Trinnov",
    entities={
        "power": "remote.trinnov_altitude_14683197",
        "media_player": "media_player.trinnov_altitude_14683197",
        "source": "select.trinnov_altitude_14683197_source",
        "volume": "sensor.trinnov_altitude_14683197_volume",
        "mute": "switch.trinnov_altitude_14683197_mute",
    },
)


@pytest.fixture
def bridge() -> FakeBridge:
    return FakeBridge()


class TestBarcoPhase:
    """FR-25 / FR-140: `ready` must never be read on its own."""

    @pytest.fixture
    def driver(self, bridge):
        bridge.set("sensor.hodr_cs_state", "standby")
        bridge.set("switch.hodr_cs_power", "off")
        return build_driver(bridge, BARCO_SPEC)

    async def test_standby_is_off(self, driver):
        observation = await driver.observe()
        assert observation.power is Power.OFF
        assert observation.phase == PHASE_OFF

    async def test_warm_up_sequence_from_standby(self, bridge, driver):
        """Standby -> ready -> on: `ready` here means warming."""
        await driver.observe()

        bridge.set("sensor.hodr_cs_state", "ready")
        observation = await driver.observe()
        assert observation.phase == PHASE_WARMING
        assert observation.power is Power.TRANSITIONING
        assert not driver.is_ready(observation)

        bridge.set("sensor.hodr_cs_state", "on")
        observation = await driver.observe()
        assert observation.phase == PHASE_ON
        assert driver.is_ready(observation)

    async def test_cooldown_sequence_from_on(self, bridge, driver):
        """On -> deconditioning -> ready -> standby: `ready` means cooling."""
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()

        bridge.set("sensor.hodr_cs_state", "deconditioning")
        observation = await driver.observe()
        assert observation.phase == PHASE_COOLING

        bridge.set("sensor.hodr_cs_state", "ready")
        observation = await driver.observe()
        # This is the trap the old script had to work around.
        assert observation.phase == PHASE_COOLING
        assert not driver.is_ready(observation)

        bridge.set("sensor.hodr_cs_state", "standby")
        observation = await driver.observe()
        assert observation.phase == PHASE_OFF

    async def test_ready_without_history_is_assumed_cooling(self, bridge):
        """After an HA restart mid-cooldown, the safe reading wins."""
        bridge.set("sensor.hodr_cs_state", "ready")
        driver = build_driver(bridge, BARCO_SPEC)

        observation = await driver.observe()

        assert observation.phase == PHASE_COOLING
        assert not driver.is_ready(observation)

    async def test_conditioning_is_warming(self, bridge, driver):
        bridge.set("sensor.hodr_cs_state", "conditioning")
        observation = await driver.observe()
        assert observation.phase == PHASE_WARMING

    async def test_remaining_time_is_reported_for_the_eta(self, bridge, driver):
        """FR-141: cooldown is 8:12 total, of which 5:12 is cooling-`ready`."""
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()
        bridge.set("sensor.hodr_cs_state", "deconditioning")
        await driver.observe()
        assert driver.remaining_seconds() == pytest.approx(492.0)

        bridge.set("sensor.hodr_cs_state", "ready")
        await driver.observe()
        assert driver.remaining_seconds() == pytest.approx(312.0)


class TestBarcoPower:
    @pytest.fixture
    def driver(self, bridge):
        bridge.set("sensor.hodr_cs_state", "standby")
        bridge.set("switch.hodr_cs_power", "off")
        return build_driver(bridge, BARCO_SPEC)

    async def test_start_from_standby_switches_on(self, bridge, driver):
        await driver.start()
        assert bridge.calls == [
            ("switch", "turn_on", {"entity_id": "switch.hodr_cs_power"})
        ]

    async def test_start_during_deconditioning_is_deferred_then_retried(
        self, bridge, driver
    ):
        """The projector will not accept a power-on while deconditioning."""
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()
        bridge.set("sensor.hodr_cs_state", "deconditioning")
        await driver.observe()

        await driver.start()
        assert bridge.calls == []  # held, not lost

        # Once it reaches the cooling `ready` window a power-on does land.
        bridge.set("sensor.hodr_cs_state", "ready")
        await driver.observe()
        assert bridge.calls == [
            ("switch", "turn_on", {"entity_id": "switch.hodr_cs_power"})
        ]

    async def test_retry_is_rate_limited(self, bridge, driver):
        await driver.start()
        bridge.calls.clear()
        await driver.observe()
        await driver.observe()
        assert bridge.calls == []

        bridge.clock += 60.0
        await driver.observe()
        assert len(bridge.calls) == 1

    async def test_stop_clears_the_standing_intent(self, bridge, driver):
        await driver.start()
        bridge.calls.clear()
        await driver.stop()
        bridge.clock += 120.0
        await driver.observe()

        assert bridge.calls == [
            ("switch", "turn_off", {"entity_id": "switch.hodr_cs_power"})
        ]


class TestBarcoProfile:
    """FR-143: the shadow value is what makes "keep" decidable."""

    @pytest.fixture
    def driver(self, bridge):
        bridge.set("sensor.hodr_cs_state", "on")
        bridge.set(
            "select.hodr_cs_profile",
            "unknown",
            options=["HDR 260 HDMI", "HDR 260 DP"],
        )
        return build_driver(bridge, BARCO_SPEC)

    async def test_profile_is_unknown_until_we_set_it(self, driver):
        observation = await driver.observe()
        assert "profile" not in observation.settings

    async def test_applied_profile_becomes_the_shadow_value(self, bridge, driver):
        await driver.apply({"profile": "HDR 260 HDMI"})

        assert bridge.calls[-1] == (
            "select",
            "select_option",
            {
                "entity_id": "select.hodr_cs_profile",
                "option": "HDR 260 HDMI",
            },
        )
        observation = await driver.observe()
        assert observation.settings["profile"] == "HDR 260 HDMI"

    async def test_shadow_value_is_dropped_on_power_cycle(self, bridge, driver):
        await driver.apply({"profile": "HDR 260 HDMI"})
        await driver.observe()

        bridge.set("sensor.hodr_cs_state", "standby")
        observation = await driver.observe()

        assert "profile" not in observation.settings

    async def test_unknown_profile_fails_with_the_available_options(
        self, bridge, driver
    ):
        with pytest.raises(RuntimeError) as excinfo:
            await driver.apply({"profile": "HDR 260 SDI"})

        assert "HDR 260 HDMI" in str(excinfo.value)
        assert "Beamer" in str(excinfo.value)


class TestTrinnov:
    @pytest.fixture
    def driver(self, bridge):
        bridge.set("remote.trinnov_altitude_14683197", "off")
        bridge.set("media_player.trinnov_altitude_14683197", "off")
        bridge.set("select.trinnov_altitude_14683197_source", "unknown", options=[])
        return build_driver(bridge, TRINNOV_SPEC)

    async def test_media_player_up_but_source_list_empty_is_not_ready(
        self, bridge, driver
    ):
        """The failure mode that used to abort the whole activity script."""
        bridge.set("media_player.trinnov_altitude_14683197", "on")
        bridge.set("remote.trinnov_altitude_14683197", "on")

        observation = await driver.observe()

        assert observation.power is Power.TRANSITIONING
        assert not driver.is_ready(observation)

    async def test_ready_once_the_source_list_has_loaded(self, bridge, driver):
        bridge.set("media_player.trinnov_altitude_14683197", "on")
        bridge.set(
            "select.trinnov_altitude_14683197_source",
            "zidoo",
            options=["zidoo", "shield", "steam"],
        )

        observation = await driver.observe()

        assert observation.power is Power.ON
        assert driver.is_ready(observation)
        assert observation.settings["source"] == "zidoo"

    async def test_settings_are_applied_in_a_safe_order(self, bridge, driver):
        bridge.set("media_player.trinnov_altitude_14683197", "on")
        bridge.set(
            "select.trinnov_altitude_14683197_source",
            "shield",
            options=["zidoo", "shield", "steam"],
        )
        bridge.set("sensor.trinnov_altitude_14683197_volume", "-40.0")

        await driver.apply({"volume": -30.0, "source": "zidoo"})

        services = [(domain, service) for domain, service, _ in bridge.calls]
        # Source before volume: changing input can move the reference level.
        assert services == [("select", "select_option"), ("remote", "send_command")]
        assert bridge.calls[-1][2]["command"] == ["volume_set -30.0"]

    async def test_volume_is_read_back_after_setting(self, bridge, driver):
        """FR-64a: the Trinnov is authoritative, a clamp is not an error."""
        bridge.set("sensor.trinnov_altitude_14683197_volume", "-40.0")

        actual = await driver.set_volume(-10.0)

        assert actual == -40.0

    async def test_invalid_source_names_the_available_options(self, bridge, driver):
        bridge.set(
            "select.trinnov_altitude_14683197_source",
            "zidoo",
            options=["zidoo", "shield"],
        )

        with pytest.raises(RuntimeError) as excinfo:
            await driver.apply({"source": "steam"})

        assert "zidoo, shield" in str(excinfo.value)

    async def test_unavailable_trinnov_is_reported_not_guessed(self, bridge, driver):
        bridge.set("media_player.trinnov_altitude_14683197", "unavailable")

        observation = await driver.observe()

        assert observation.power is Power.UNAVAILABLE
        assert not observation.available
