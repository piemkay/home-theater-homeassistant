"""
madVR Envy driver: power and profile.

The Envy is woken over the network rather than switched on, so "start" is a
Wake-on-LAN button press when one is configured and a plain ``remote.turn_on``
otherwise. Readiness comes from the Envy's own power-state binary sensor.

**Profiles matter per source.** A 5K profile works for the Zidoo but produces
a black screen on the Shield and the Apple TV — an HDMI/EDID difference — so
each activity has to select the right one. The HA madvr integration exposes no
profile entity; profiles are activated through ``remote.send_command`` with a
comma-separated command addressing a slot number::

    ActivateProfile,SOURCE,1

The command string is a device option so it can be adjusted without touching
code. Like the Barco's profile, the Envy cannot report which profile is
active, so the driver keeps a shadow value and drops it on every power cycle —
the same reasoning as FR-143.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, ClassVar

from ..core.model import DeviceObservation, DeviceSpec, Power
from .base import EntityBackedDriver
from .bridge import Bridge

_LOGGER = logging.getLogger(__name__)

DEFAULT_PROFILE_COMMAND = "ActivateProfile,SOURCE,{value}"


class MadvrDriver(EntityBackedDriver):
    """Video processor: power, plus the per-source profile."""

    required_entities = ("power",)
    entity_roles: ClassVar[dict[str, tuple[str, ...]]] = {
        "power": ("remote", "switch"),
        "power_state": ("binary_sensor",),
        "wake": ("button",),
    }
    #: The Envy cannot enumerate its profiles, so this is a slot number the
    #: panel renders as a number field rather than a dropdown.
    setting_roles: ClassVar[dict[str, str | None]] = {"profile": None}

    def __init__(self, bridge: Bridge, spec: DeviceSpec) -> None:
        super().__init__(bridge, spec)
        self._profile: Any = None

    @property
    def _profile_command(self) -> str:
        return str(self.spec.options.get("profile_command", DEFAULT_PROFILE_COMMAND))

    @property
    def active_profile(self) -> Any:
        """The slot last selected, or None after a power cycle.

        The Envy cannot report this, so it is a shadow value — good enough to
        restore after a demo, never good enough to skip re-applying.
        """
        return self._profile

    async def observe(self) -> DeviceObservation:
        power_state = self.state_of("power_state")
        if power_state is not None and power_state.state == "unavailable":
            return DeviceObservation(
                device=self.spec.key, power=Power.UNAVAILABLE, available=False
            )
        if power_state is not None and power_state.state in ("on", "off"):
            power = Power.ON if power_state.state == "on" else Power.OFF
        else:
            power = self._power_from_entity()

        if power is not Power.ON:
            # A power cycle invalidates whatever profile we last selected.
            self._profile = None

        settings: dict[str, Any] = {}
        if self._profile is not None:
            settings["profile"] = self._profile

        return DeviceObservation(device=self.spec.key, power=power, settings=settings)

    async def start(self) -> None:
        if self.entity("wake"):
            await self.call("button", "press", role="wake")
            return
        await self.call("remote", "turn_on", role="power")

    async def stop(self) -> None:
        self._profile = None
        await self.call("remote", "turn_off", role="power")

    async def apply(self, settings: Mapping[str, Any]) -> None:
        profile = settings.get("profile")
        if profile is None:
            return
        command = self._profile_command.format(value=profile)
        _LOGGER.debug("madVR: Profil wird aktiviert (%s)", command)
        await self.call(
            "remote",
            "send_command",
            role="power",
            data={"command": [command], "num_repeats": 1},
        )
        self._profile = profile
