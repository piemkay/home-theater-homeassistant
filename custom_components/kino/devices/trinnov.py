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

from ..core.model import DeviceObservation, DeviceSpec, Power
from .base import EntityBackedDriver, select_option
from .bridge import Bridge

_LOGGER = logging.getLogger(__name__)

_READY_MEDIA_STATES = frozenset({"on", "idle", "playing", "paused"})

#: How long a volume we just set is trusted over the processor's own sensor.
#: The Altitude reports the new level a second or two later, and until it does
#: the card would otherwise show the old value and count the next step from
#: it — so two taps in a row moved one step (FR-64).
VOLUME_CONFIRM_SECONDS = 8.0

#: dB difference at which the sensor is considered to have caught up.
VOLUME_EPSILON = 0.05

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
    entity_roles: ClassVar[dict[str, tuple[str, ...]]] = {
        "power": ("remote", "switch"),
        "media_player": ("media_player",),
        "source": ("select",),
        "preset": ("select",),
        "upmixer": ("select",),
        "mute": ("switch",),
        "dim": ("switch",),
        "volume": ("sensor", "number"),
        "volume_number": ("number",),
        "power_status": ("sensor",),
    }
    setting_roles: ClassVar[dict[str, str | None]] = {
        "source": "source",
        "preset": "preset",
        "upmixer": "upmixer",
        "volume": None,
    }

    def __init__(self, bridge: Bridge, spec: DeviceSpec) -> None:
        super().__init__(bridge, spec)
        #: The level we last asked for, held until the processor confirms it.
        self._volume_target: float | None = None
        self._volume_target_at: float = 0.0

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
        """Return the current level: the one just set until the Trinnov agrees.

        The processor's sensor lags a command by a second or two. Reporting
        the stale value in the meantime made the card look broken and, worse,
        made the *next* step compute from the old level, so a quick double-tap
        moved one step instead of two.
        """
        reported = self._reported_volume_db()
        pending = self._pending_volume(reported)
        return reported if pending is None else pending

    def _reported_volume_db(self) -> float | None:
        for role in ("volume", "volume_number"):
            raw = self.value_of(role)
            if raw is None:
                continue
            try:
                return float(raw)
            except (TypeError, ValueError):
                continue
        return None

    def _pending_volume(self, reported: float | None) -> float | None:
        """Return the unconfirmed target, or None once it lands or times out."""
        target = self._volume_target
        if target is None:
            return None
        if reported is not None and abs(reported - target) < VOLUME_EPSILON:
            self._volume_target = None
            return None
        if self.bridge.now() - self._volume_target_at > VOLUME_CONFIRM_SECONDS:
            # The Trinnov clamped or ignored it; its own value is the truth.
            self._volume_target = None
            return None
        return target

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
        self._volume_target = db
        self._volume_target_at = self.bridge.now()
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
