"""
madVR Envy driver.

The Envy is woken over the network rather than switched on, so "start" is a
Wake-on-LAN button press when one is configured and a plain ``remote.turn_on``
otherwise. Readiness comes from the Envy's own power-state binary sensor.
"""

from __future__ import annotations

from ..core.model import DeviceObservation, Power
from .base import EntityBackedDriver


class MadvrDriver(EntityBackedDriver):
    """Video processor: power only — it carries no per-activity settings."""

    required_entities = ("power",)

    async def observe(self) -> DeviceObservation:
        power_state = self.state_of("power_state")
        if power_state is not None:
            if power_state.state == "unavailable":
                return DeviceObservation(
                    device=self.spec.key,
                    power=Power.UNAVAILABLE,
                    available=False,
                )
            if power_state.state in ("on", "off"):
                return DeviceObservation(
                    device=self.spec.key,
                    power=Power.ON if power_state.state == "on" else Power.OFF,
                )
        return DeviceObservation(device=self.spec.key, power=self._power_from_entity())

    async def start(self) -> None:
        if self.entity("wake"):
            await self.call("button", "press", role="wake")
            return
        await self.call("remote", "turn_on", role="power")

    async def stop(self) -> None:
        await self.call("remote", "turn_off", role="power")
