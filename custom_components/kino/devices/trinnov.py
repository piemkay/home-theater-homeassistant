"""
Trinnov Altitude driver: source, preset, upmixer, volume and mute.

Readiness is deliberately stricter than "the media player answered". The
source list arrives well after the media player comes up, and selecting a
source against an empty option list is what used to abort the whole activity
script with `Option steam is not valid`. So a Trinnov is ready only when its
option lists have actually loaded.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from ..core.model import DeviceObservation, Power
from .base import EntityBackedDriver, select_option

_LOGGER = logging.getLogger(__name__)

_READY_MEDIA_STATES = frozenset({"on", "idle", "playing", "paused"})

#: Settings this driver knows how to write, in the order they must be applied.
_SETTING_ORDER = ("source", "preset", "upmixer", "volume")


class TrinnovDriver(EntityBackedDriver):
    """The processor. It is in every activity, so it is never the bottleneck."""

    required_entities = ("power", "media_player")

    async def observe(self) -> DeviceObservation:
        media = self.state_of("media_player")
        remote = self.state_of("power")

        if media is None:
            return DeviceObservation(
                device=self.spec.key, power=Power.UNKNOWN, available=False
            )
        if media.state == "unavailable":
            return DeviceObservation(
                device=self.spec.key, power=Power.UNAVAILABLE, available=False
            )

        responsive = media.state in _READY_MEDIA_STATES
        sources_loaded = bool(self.options_of("source"))

        if responsive and sources_loaded:
            power = Power.ON
        elif responsive or (remote is not None and remote.state == "on"):
            # Up, but not yet usable — treat as still starting rather than
            # ready, so nothing writes to an empty option list.
            power = Power.TRANSITIONING
        else:
            power = Power.OFF

        settings: dict[str, Any] = {}
        for role in ("source", "preset", "upmixer"):
            value = self.value_of(role)
            if value is not None:
                settings[role] = value
        volume = self.volume_db()
        if volume is not None:
            settings["volume"] = volume
        mute = self.value_of("mute")
        if mute is not None:
            settings["mute"] = mute == "on"

        return DeviceObservation(
            device=self.spec.key,
            power=power,
            settings=settings,
            phase="ready" if power is Power.ON else None,
        )

    def volume_db(self) -> float | None:
        for role in ("volume", "volume_number"):
            raw = self.value_of(role)
            if raw is None:
                continue
            try:
                return float(raw)
            except (TypeError, ValueError):
                continue
        return None

    async def start(self) -> None:
        await self.call("remote", "turn_on", role="power")

    async def stop(self) -> None:
        await self.call("remote", "turn_off", role="power")

    async def apply(self, settings: Mapping[str, Any]) -> None:
        for key in _SETTING_ORDER:
            if key not in settings:
                continue
            value = settings[key]
            if key == "volume":
                await self.set_volume(float(value))
            else:
                await select_option(self, key, value)
        for key in settings:
            if key not in _SETTING_ORDER and key != "mute":
                _LOGGER.warning(
                    "Trinnov: unbekannte Einstellung '%s' wird ignoriert", key
                )
        if "mute" in settings:
            await self.set_mute(bool(settings["mute"]))

    # -- volume -------------------------------------------------------------

    async def set_volume(self, db: float) -> float | None:
        """
        Set the reference level, then read back what the Trinnov did.

        The processor is authoritative: it may clamp or reject a value, and a
        graceful bounce-back is correct behaviour rather than an error
        (FR-64a). The caller gets the value that actually took effect.
        """
        await self.call(
            "remote",
            "send_command",
            role="power",
            data={"command": [f"volume_set {db:.1f}"], "num_repeats": 1},
        )
        return self.volume_db()

    async def set_mute(self, muted: bool) -> None:
        if self.entity("mute"):
            await self.call("switch", "turn_on" if muted else "turn_off", role="mute")
            return
        await self.call(
            "media_player",
            "volume_mute",
            role="media_player",
            data={"is_volume_muted": muted},
        )

    def is_ready(self, observation: DeviceObservation) -> bool:
        return observation.power is Power.ON
