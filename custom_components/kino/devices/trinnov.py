"""
Trinnov Altitude driver: source, preset, upmixer, volume and mute.

Readiness is deliberately stricter than "the media player answered". The
media player reports `on` almost immediately, while the source list arrives up
to two minutes later — and selecting a source against an empty option list is
what used to abort the whole activity script with `Option steam is not valid`.
So a Trinnov is ready only once its option lists have actually loaded.

The processor's own `power_status` sensor is the better power signal where it
exists. Ten days of recorded history shows a clean, fast state machine::

    off ──► waking ──► ready        63-122 s, mean ~86 s

We prefer that sensor and fall back to the media player only when it is not
configured or is reporting `unknown`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, ClassVar

from ..core.model import DeviceObservation, Power
from .base import EntityBackedDriver, select_option

_LOGGER = logging.getLogger(__name__)

_READY_MEDIA_STATES = frozenset({"on", "idle", "playing", "paused"})

#: Values seen on `sensor.<name>_power_status`.
_POWER_STATUS = {
    "off": Power.OFF,
    "waking": Power.TRANSITIONING,
    "ready": Power.ON,
    "on": Power.ON,
}

#: Settings this driver knows how to write, in the order they must be applied.
_SETTING_ORDER = ("source", "preset", "upmixer", "volume")


class TrinnovDriver(EntityBackedDriver):
    """The processor. It is in every activity, so it is never the bottleneck."""

    required_entities = ("power", "media_player")
    setting_roles: ClassVar[dict[str, str | None]] = {
        "source": "source",
        "preset": "preset",
        "upmixer": "upmixer",
        "volume": None,
    }

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

        sources_loaded = bool(self.options_of("source"))
        reported = _POWER_STATUS.get(self.value_of("power_status") or "")

        if reported is not None:
            power = reported
        else:
            responsive = media.state in _READY_MEDIA_STATES
            power = (
                Power.ON
                if responsive
                else Power.TRANSITIONING
                if remote is not None and remote.state == "on"
                else Power.OFF
            )

        if power is Power.ON and not sources_loaded:
            # Powered, but not yet usable — keep it "starting" so nothing
            # writes a source into an empty option list.
            power = Power.TRANSITIONING

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
