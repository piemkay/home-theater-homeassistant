"""
Generic media_player-backed device: Shield, Apple TV, and friends.

These are hand-off devices. The integration gets them powered and, where the
platform allows it, into the right app; from there the person uses the
device's own remote (§1.1).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from ..core.model import DeviceObservation, Power
from .base import EntityBackedDriver

_LOGGER = logging.getLogger(__name__)


class GenericDriver(EntityBackedDriver):
    """Power and app selection through the standard media_player interface."""

    required_entities = ("media_player",)

    async def observe(self) -> DeviceObservation:
        media = self.state_of("media_player")
        if media is None:
            return DeviceObservation(
                device=self.spec.key, power=Power.UNKNOWN, available=False
            )
        if media.state == "unavailable":
            return DeviceObservation(
                device=self.spec.key, power=Power.UNAVAILABLE, available=False
            )
        settings: dict[str, Any] = {}
        app = media.attributes.get("app_id") or media.attributes.get("app_name")
        if app:
            settings["app"] = app
        source = media.attributes.get("source")
        if source:
            settings["source"] = source
        return DeviceObservation(
            device=self.spec.key,
            power=Power.OFF if media.state in ("off", "standby") else Power.ON,
            settings=settings,
        )

    async def start(self) -> None:
        role = "power" if self.entity("power") else "media_player"
        domain = (self.entity(role) or "media_player.").split(".", 1)[0]
        await self.call(domain, "turn_on", role=role)

    async def stop(self) -> None:
        role = "power" if self.entity("power") else "media_player"
        domain = (self.entity(role) or "media_player.").split(".", 1)[0]
        await self.call(domain, "turn_off", role=role)

    async def apply(self, settings: Mapping[str, Any]) -> None:
        app = settings.get("app")
        if app:
            await self.call(
                "media_player",
                "select_source",
                role="media_player",
                data={"source": str(app)},
            )
        for key in settings:
            if key != "app":
                _LOGGER.debug("%s: Einstellung '%s' ignoriert", self.spec.name, key)
