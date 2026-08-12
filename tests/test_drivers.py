"""
Driver behaviour against a fake Home Assistant state machine.

The Barco cases are transcribed from ten days of recorded `sensor.hodr_cs_state`
history, so they assert what the projector actually does rather than what the
manual implies.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from custom_components.kino.core.model import DeviceSpec, Power
from custom_components.kino.devices import build_driver
from custom_components.kino.devices.barco import (
    PHASE_COOLING,
    PHASE_OFF,
    PHASE_ON,
    PHASE_WARMING,
    RETRY_POWER_OFF_AFTER,
    RETRY_REJECTED_AFTER,
)
from custom_components.kino.devices.bridge import StateSnapshot
from custom_components.kino.devices.trinnov import VOLUME_CONFIRM_SECONDS
from custom_components.kino.devices.zidoo import SEEK_CONFIRM_SECONDS


class FakeBridge:
    """In-memory entity states plus a service-call recorder."""

    def __init__(self, states: Mapping[str, Any] | None = None) -> None:
        self.states: dict[str, StateSnapshot] = {}
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.clock = 0.0
        #: Raised by the next service call, after recording it — how a real
        #: integration rejects a command it cannot carry out right now.
        self.raise_on_call: Exception | None = None
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
        if self.raise_on_call is not None:
            error, self.raise_on_call = self.raise_on_call, None
            raise error

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
        "power_status": "sensor.trinnov_altitude_14683197_power_status",
        "source": "select.trinnov_altitude_14683197_source",
        "volume": "sensor.trinnov_altitude_14683197_volume",
        "mute": "switch.trinnov_altitude_14683197_mute",
    },
)

#: The real option list, read off the live Altitude on 2026-08-10.
LIVE_SOURCES = [
    "shield",
    "appletv",
    "zidoo",
    "steam",
    "pc",
    "HDMI 6",
    "HDMI 7",
    "HDMI 8",
    "NETWORK",
    "Roon Ready",
    "S/PDIF IN 1",
    "S/PDIF IN 2",
    "Optical IN 3",
    "Optical IN 4",
    "ANALOG BAL IN 1",
    "ANALOG SE2 IN",
    "MIC IN",
]


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

    async def test_stop_reissues_the_off_in_the_cooling_ready_window(
        self, bridge, driver
    ):
        """Observed live (2026-08-11): a second off skips the ready window.

        `deconditioning` is mandatory lamp cooling and gets no extra command;
        the ~5-minute cooling-`ready` idle afterwards is what the second off
        cuts to nothing — the vendor app proved it by dropping the projector
        to standby the instant its off arrived there.
        """
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()

        await driver.stop()
        assert bridge.calls == [
            ("switch", "turn_off", {"entity_id": "switch.hodr_cs_power"})
        ]

        bridge.set("sensor.hodr_cs_state", "deconditioning")
        await driver.observe()
        assert len(bridge.calls) == 1  # mandatory cooling: nothing to hurry

        bridge.set("sensor.hodr_cs_state", "ready")
        await driver.observe()
        assert bridge.calls[-1] == (
            "switch",
            "turn_off",
            {"entity_id": "switch.hodr_cs_power"},
        )
        assert len(bridge.calls) == 2

        # Rate-limited while the window persists…
        await driver.observe()
        assert len(bridge.calls) == 2
        bridge.clock += RETRY_POWER_OFF_AFTER + 1.0
        await driver.observe()
        assert len(bridge.calls) == 3

        # …and finished for good once the projector confirms standby.
        bridge.set("sensor.hodr_cs_state", "standby")
        observation = await driver.observe()
        assert observation.power is Power.OFF
        bridge.clock += RETRY_POWER_OFF_AFTER + 1.0
        await driver.observe()
        assert len(bridge.calls) == 3

    async def test_a_declined_second_off_does_not_abort_the_shutdown(
        self, bridge, driver
    ):
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()
        await driver.stop()
        bridge.set("sensor.hodr_cs_state", "deconditioning")
        await driver.observe()
        bridge.set("sensor.hodr_cs_state", "ready")

        bridge.raise_on_call = RuntimeError("busy")
        observation = await driver.observe()  # must not raise
        assert observation.phase == PHASE_COOLING

    async def test_a_new_start_cancels_the_standing_off(self, bridge, driver):
        bridge.set("sensor.hodr_cs_state", "on")
        await driver.observe()
        await driver.stop()
        bridge.set("sensor.hodr_cs_state", "deconditioning")
        await driver.observe()

        await driver.start()  # changed their mind mid-cooldown
        bridge.set("sensor.hodr_cs_state", "ready")
        await driver.observe()

        # The ready window gets the power-*on*, not a lingering off.
        on = ("switch", "turn_on", {"entity_id": "switch.hodr_cs_power"})
        off = ("switch", "turn_off", {"entity_id": "switch.hodr_cs_power"})
        assert on in bridge.calls
        assert bridge.calls.count(off) == 1

    async def test_a_busy_projector_is_retried_rather_than_failing(
        self, bridge, driver
    ):
        """Observed live: the projector refuses a power-on mid-transition.

        `_turn_on failed - projector not ready: Ignored POWER_ON event, busy
        transitioning to ready` used to abort the whole activity and put a red
        error on the card seconds before the projector came up anyway.
        """
        bridge.raise_on_call = RuntimeError(
            "Projector not ready: Ignored POWER_ON event, busy transitioning to ready"
        )

        await driver.start()  # must not raise
        assert len(bridge.calls) == 1

        bridge.clock += RETRY_REJECTED_AFTER + 1.0
        await driver.observe()
        assert len(bridge.calls) == 2

    async def test_a_real_failure_still_fails(self, bridge, driver):
        bridge.raise_on_call = RuntimeError("Connection refused")
        with pytest.raises(RuntimeError, match="Connection refused"):
            await driver.start()


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

    async def test_the_level_just_set_is_reported_at_once(self, bridge, driver):
        """The processor's sensor lags the command by a second or two.

        Reporting the stale value in the meantime is what made the card sit on
        the old dB reading — and made the next step compute from it, so two
        quick taps moved one step.
        """
        bridge.set("sensor.trinnov_altitude_14683197_volume", "-30.0")

        assert await driver.set_volume(-32.0) == -32.0

        bridge.set("sensor.trinnov_altitude_14683197_volume", "-32.0")
        assert driver.volume_db() == -32.0

    async def test_the_trinnov_wins_when_it_clamps(self, bridge, driver):
        """FR-64a: the Trinnov is authoritative, a clamp is not an error."""
        bridge.set("sensor.trinnov_altitude_14683197_volume", "-40.0")

        assert await driver.set_volume(-10.0) == -10.0

        # It never accepted -10, so once the confirmation window closes its
        # own value is the truth again.
        bridge.clock += VOLUME_CONFIRM_SECONDS + 1.0
        assert driver.volume_db() == -40.0

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


class TestTrinnovPowerStatus:
    """The Altitude's own power_status is the authoritative signal.

    Transcribed from ten days of live history: off -> waking -> ready,
    consistently 63-122 s.
    """

    @pytest.fixture
    def driver(self, bridge):
        bridge.set("remote.trinnov_altitude_14683197", "off")
        bridge.set("media_player.trinnov_altitude_14683197", "off")
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "off")
        bridge.set("select.trinnov_altitude_14683197_source", "unknown", options=[])
        return build_driver(bridge, TRINNOV_SPEC)

    async def test_off_is_off(self, driver):
        observation = await driver.observe()
        assert observation.power is Power.OFF

    async def test_waking_is_transitioning_not_ready(self, bridge, driver):
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "waking")
        bridge.set("media_player.trinnov_altitude_14683197", "on")

        observation = await driver.observe()

        assert observation.power is Power.TRANSITIONING
        assert not driver.is_ready(observation)

    async def test_ready_without_sources_is_still_not_usable(self, bridge, driver):
        """The exact state the live Altitude sat in for ~2 minutes."""
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "ready")
        bridge.set("media_player.trinnov_altitude_14683197", "on")

        observation = await driver.observe()

        assert observation.power is Power.TRANSITIONING
        assert not driver.is_ready(observation)

    async def test_ready_with_sources_is_usable(self, bridge, driver):
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "ready")
        bridge.set(
            "select.trinnov_altitude_14683197_source", "steam", options=LIVE_SOURCES
        )
        bridge.set("sensor.trinnov_altitude_14683197_volume", "-39.5")

        observation = await driver.observe()

        assert observation.power is Power.ON
        assert driver.is_ready(observation)
        assert observation.settings["source"] == "steam"
        assert observation.settings["volume"] == -39.5

    async def test_falls_back_to_the_media_player_when_unknown(self, bridge, driver):
        """Not every Trinnov integration exposes power_status."""
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "unknown")
        bridge.set("media_player.trinnov_altitude_14683197", "on")
        bridge.set(
            "select.trinnov_altitude_14683197_source", "zidoo", options=LIVE_SOURCES
        )

        observation = await driver.observe()

        assert observation.power is Power.ON

    async def test_every_configured_activity_source_really_exists(self, bridge, driver):
        """The shipped config must not name a source the Altitude lacks."""
        bridge.set("sensor.trinnov_altitude_14683197_power_status", "ready")
        bridge.set(
            "select.trinnov_altitude_14683197_source", "steam", options=LIVE_SOURCES
        )
        for source in ("zidoo", "shield", "steam"):
            await driver.apply({"source": source})
        assert [c[2]["option"] for c in bridge.calls] == ["zidoo", "shield", "steam"]


MADVR_SPEC = DeviceSpec(
    key="madvr",
    driver="madvr",
    name="madVR",
    entities={
        "power": "remote.madvr_envy",
        "power_state": "binary_sensor.madvr_envy_power_state",
        "wake": "button.kino_wake_on_lan_madvr",
    },
    unverifiable_settings=frozenset({"profile"}),
    options={"profile_command": "ActivateProfile,SOURCE,{value}"},
)


class TestMadvrProfile:
    """A 5K profile blacks out the Shield, so each activity picks its own."""

    @pytest.fixture
    def driver(self, bridge):
        bridge.set("remote.madvr_envy", "off")
        bridge.set("binary_sensor.madvr_envy_power_state", "on")
        return build_driver(bridge, MADVR_SPEC)

    async def test_profile_is_unknown_until_we_set_it(self, driver):
        observation = await driver.observe()
        assert "profile" not in observation.settings

    async def test_applying_a_profile_sends_the_envy_command(self, bridge, driver):
        await driver.apply({"profile": 2})

        assert bridge.calls == [
            (
                "remote",
                "send_command",
                {
                    "entity_id": "remote.madvr_envy",
                    "command": ["ActivateProfile,SOURCE,2"],
                    "num_repeats": 1,
                },
            )
        ]
        observation = await driver.observe()
        assert observation.settings["profile"] == 2

    async def test_command_template_is_configurable(self, bridge):
        spec = DeviceSpec(
            key="madvr",
            driver="madvr",
            name="madVR",
            entities={"power": "remote.madvr_envy"},
            options={"profile_command": "ActivateProfile,DISPLAY,{value}"},
        )
        bridge.set("remote.madvr_envy", "on")
        driver = build_driver(bridge, spec)

        await driver.apply({"profile": 7})

        assert bridge.calls[0][2]["command"] == ["ActivateProfile,DISPLAY,7"]

    async def test_shadow_profile_is_dropped_on_power_cycle(self, bridge, driver):
        await driver.apply({"profile": 1})
        await driver.observe()

        bridge.set("binary_sensor.madvr_envy_power_state", "off")
        observation = await driver.observe()

        assert "profile" not in observation.settings

    async def test_switching_source_reconfigures_rather_than_restarts(self, config_doc):
        """Film -> Netflix must change the madVR profile without a power cycle."""
        from custom_components.kino.core.model import ActionKind, DeviceObservation
        from custom_components.kino.core.planner import plan_transition
        from custom_components.kino.core.schema import validate

        config_doc["devices"]["madvr"]["unverifiable_settings"] = ["profile"]
        config_doc["activities"]["film"]["devices"]["madvr"] = {
            "power": True,
            "profile": 1,
        }
        config_doc["activities"]["netflix"]["devices"]["madvr"] = {
            "power": True,
            "profile": 2,
        }
        config = validate(config_doc)

        observations = {
            "barco": DeviceObservation(
                device="barco", power=Power.ON, settings={"profile": "HDR 260 HDMI"}
            ),
            "trinnov": DeviceObservation(
                device="trinnov",
                power=Power.ON,
                settings={"source": "zidoo", "volume": -30.0},
            ),
            "madvr": DeviceObservation(
                device="madvr", power=Power.ON, settings={"profile": 1}
            ),
            "zidoo": DeviceObservation(device="zidoo", power=Power.ON),
            "shield": DeviceObservation(device="shield", power=Power.OFF),
        }

        plan = plan_transition(
            devices=config.devices,
            observations=observations,
            target=config.activities["netflix"],
            current_activity="film",
        )

        madvr = next(a for a in plan.actions if a.device == "madvr")
        assert madvr.kind is ActionKind.RECONFIGURE
        assert madvr.settings == {"profile": 2}
        assert "madvr" not in {a.device for a in plan.stops}


class TestSettingOptions:
    """FR-112: the panel's dropdowns come from the live devices."""

    async def test_trinnov_reports_its_live_lists(self, bridge):
        bridge.set(
            "select.trinnov_altitude_14683197_source", "zidoo", options=LIVE_SOURCES
        )
        driver = build_driver(bridge, TRINNOV_SPEC)

        described = driver.setting_options()

        assert described["source"]["type"] == "select"
        assert described["source"]["options"] == LIVE_SOURCES
        assert described["source"]["available"] is True
        assert described["volume"]["type"] == "number"

    async def test_an_off_device_reports_no_options_rather_than_lying(self, bridge):
        bridge.set("select.trinnov_altitude_14683197_source", "unknown", options=[])
        driver = build_driver(bridge, TRINNOV_SPEC)

        described = driver.setting_options()

        assert described["source"]["options"] == []
        assert described["source"]["available"] is False

    async def test_media_player_source_list_is_understood(self, bridge):
        """The Shield's app list lives in `source_list`, not `options`."""
        spec = DeviceSpec(
            key="shield",
            driver="generic",
            name="Shield",
            entities={"media_player": "media_player.shield_kino_3"},
        )
        bridge.set(
            "media_player.shield_kino_3",
            "off",
            source_list=["Netflix", "Prime Video", "YouTube"],
        )
        driver = build_driver(bridge, spec)

        assert driver.setting_options()["app"]["options"] == [
            "Netflix",
            "Prime Video",
            "YouTube",
        ]


#: A real file, as the Zidoo reported it while playing (`media_uri`), and the
#: same file as Jellyfin indexes it. The `#` in the NFS mount is exactly why
#: the path has to reach the player percent-encoded.
ZIDOO_PATH = (
    "/mnt/nfs/192.168.50.10#entertainment/series/House of the Dragon/"
    "Season 3/House of the Dragon (2022) - S03E08.mkv"
)
LIBRARY_PATH = (
    "/media/entertainment/series/House of the Dragon/"
    "Season 3/House of the Dragon (2022) - S03E08.mkv"
)

ZIDOO_SPEC = DeviceSpec(
    key="zidoo",
    driver="zidoo",
    name="Zidoo",
    entities={
        "power": "remote.uhd8000",
        "media_player": "media_player.uhd8000",
    },
    is_media=True,
    options={
        "path_map": {"/media/entertainment/": "/mnt/nfs/192.168.50.10#entertainment/"}
    },
)


class TestZidooPlayback:
    """FR-54: opening a title on the player, verified against the UHD8000."""

    @pytest.fixture
    def driver(self, bridge):
        bridge.set("media_player.uhd8000", "idle")
        return build_driver(bridge, ZIDOO_SPEC)

    async def test_library_path_is_rewritten_for_the_player(self, driver):
        assert driver.resolve_path(LIBRARY_PATH) == ZIDOO_PATH

    async def test_play_sends_a_fully_encoded_path(self, bridge, driver):
        await driver.play_path(LIBRARY_PATH)

        domain, service, data = bridge.calls[0]
        assert (domain, service) == ("media_player", "play_media")
        assert data["entity_id"] == "media_player.uhd8000"
        assert data["media_content_type"] == "file"
        # An unencoded `#` would truncate the player's URL at the fragment,
        # and a space would break the query outright.
        assert "%23entertainment" in data["media_content_id"]
        assert " " not in data["media_content_id"]

    async def test_an_unmapped_path_names_itself(self, bridge, driver):
        with pytest.raises(RuntimeError, match=re.escape("/somewhere/else/film.mkv")):
            await driver.play_path("/somewhere/else/film.mkv")
        assert bridge.calls == []

    async def test_without_a_map_the_path_is_used_as_is(self, bridge):
        bridge.set("media_player.uhd8000", "idle")
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={"media_player": "media_player.uhd8000"},
        )
        driver = build_driver(bridge, spec)

        assert driver.resolve_path(ZIDOO_PATH) == ZIDOO_PATH

    async def test_the_longest_matching_prefix_wins(self, bridge):
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={"media_player": "media_player.uhd8000"},
            options={
                "path_map": {
                    "/media/": "/mnt/general/",
                    "/media/entertainment/": "/mnt/nfs/x#entertainment/",
                }
            },
        )
        driver = build_driver(bridge, spec)

        assert driver.resolve_path("/media/entertainment/a.mkv").startswith(
            "/mnt/nfs/x#entertainment/"
        )
        assert driver.resolve_path("/media/other/a.mkv") == "/mnt/general/other/a.mkv"


class TestZidooTrackSelects:
    """FR-60: the player exposes no track entities, so helpers stand in."""

    @pytest.fixture
    def driver(self, bridge):
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={
                "media_player": "media_player.uhd8000",
                # What this house really has: input_select helpers an
                # automation fills from the player's own track list.
                "audio_select": "input_select.kino_tonspur",
                "subtitle_select": "input_select.kino_untertitel",
            },
        )
        bridge.set("media_player.uhd8000", "playing")
        bridge.set(
            "input_select.kino_tonspur",
            "0: English Dolby Digital Plus with Dolby Atmos 48.0KHz",
            options=["0: English Dolby Digital Plus with Dolby Atmos 48.0KHz"],
        )
        bridge.set(
            "input_select.kino_untertitel", "0: Off", options=["0: Off", "1: English"]
        )
        return build_driver(bridge, spec)

    async def test_a_helper_is_driven_through_its_own_domain(self, bridge, driver):
        await driver.select_subtitle_track("1: English")

        assert bridge.calls == [
            (
                "input_select",
                "select_option",
                {
                    "entity_id": "input_select.kino_untertitel",
                    "option": "1: English",
                },
            )
        ]

    async def test_a_real_select_entity_still_works(self, bridge):
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={
                "media_player": "media_player.uhd8000",
                "audio_select": "select.zidoo_audio",
            },
        )
        bridge.set("media_player.uhd8000", "playing")
        bridge.set("select.zidoo_audio", "eng", options=["eng", "ger"])
        driver = build_driver(bridge, spec)

        await driver.select_audio_track("ger")

        assert bridge.calls[0][0] == "select"

    async def test_aus_is_translated_to_the_players_own_off_entry(
        self, bridge, driver
    ):
        """FR-62's "Aus" is the list's own off entry, not a phantom option.

        The injected literal "Aus" was rejected by the underlying select with
        "Invalid option: Aus (possible options: 0: Off, …)" — the off that
        works has always been there.
        """
        await driver.select_subtitle_track("Aus")

        assert bridge.calls == [
            (
                "input_select",
                "select_option",
                {"entity_id": "input_select.kino_untertitel", "option": "0: Off"},
            )
        ]

    async def test_without_a_helper_it_says_so(self, bridge):
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={"media_player": "media_player.uhd8000"},
        )
        bridge.set("media_player.uhd8000", "playing")
        driver = build_driver(bridge, spec)

        with pytest.raises(RuntimeError, match="subtitle_select"):
            await driver.select_subtitle_track("Aus")


class TestZidooSeek:
    """A seek must count from where the last one landed (FR-64's lesson).

    The upstream integration re-reads the position only on its poll, so right
    after a seek the entity still carries the old value — the bar snapped
    back, and a second ⟲10 landed where the first one already had.
    """

    @pytest.fixture
    def driver(self, bridge):
        spec = DeviceSpec(
            key="zidoo",
            driver="zidoo",
            name="Zidoo",
            entities={
                "power": "remote.uhd8000",
                "media_player": "media_player.uhd8000",
            },
        )
        bridge.set(
            "media_player.uhd8000",
            "playing",
            media_position=100.0,
            media_position_updated_at=datetime(
                2026, 8, 11, 21, 0, 0, tzinfo=timezone.utc
            ),
        )
        return build_driver(bridge, spec)

    async def test_the_target_is_reported_until_the_player_catches_up(
        self, bridge, driver
    ):
        await driver.async_media_command("media_seek", seek_position=90.0)

        now = driver.now_playing()
        assert now["position"] == 90.0
        # The timestamp is the seek's own, so extrapolation starts from it.
        assert now["position_updated_at"] is not None
        assert now["position_updated_at"] != datetime(
            2026, 8, 11, 21, 0, 0, tzinfo=timezone.utc
        )

    async def test_a_newer_report_from_the_player_wins(self, bridge, driver):
        await driver.async_media_command("media_seek", seek_position=90.0)

        bridge.set(
            "media_player.uhd8000",
            "playing",
            media_position=91.0,
            media_position_updated_at=datetime.now(timezone.utc)
            + timedelta(seconds=5),
        )
        assert driver.now_playing()["position"] == 91.0

    async def test_the_pending_position_expires_rather_than_lying(
        self, bridge, driver
    ):
        await driver.async_media_command("media_seek", seek_position=90.0)

        bridge.clock += SEEK_CONFIRM_SECONDS + 1.0
        assert driver.now_playing()["position"] == 100.0
