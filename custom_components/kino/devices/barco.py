"""
Barco Pulse projector driver — the bug-prone one (FR-25).

`sensor.hodr_cs_state` reports ``ready`` on the way up *and* on the way down,
so the raw value alone can never tell you which is happening. Ten days of
recorded history from the Hodr CS shows the two paths clearly::

    up:    standby -> [conditioning] -> ready -> on          ~3-7 s
    down:  on -> deconditioning -> ready -> standby          3:00 then 5:12

The disambiguator is therefore the state we came *from*, not the state we are
in. This driver tracks that transition and exposes an unambiguous phase, which
is exactly what FR-140 asks the upstream integration to do — see
``docs/barco-upstream-changes.md``. Once that lands, this class reads the
upstream phase instead of deriving it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from ..core.model import DeviceObservation, DeviceSpec, Power
from .base import EntityBackedDriver, select_option
from .bridge import Bridge

_LOGGER = logging.getLogger(__name__)

PHASE_OFF = "off"
PHASE_WARMING = "warming"
PHASE_COOLING = "cooling"
PHASE_ON = "on"
PHASE_UNKNOWN = "unknown"

_OFF_STATES = frozenset({"standby", "eco", "boot"})
_WARMING_STATES = frozenset({"conditioning"})
_COOLING_STATES = frozenset({"deconditioning"})

#: Observed on the Hodr CS: deconditioning 3:00, then cooling-ready 5:12.
COOLDOWN_TOTAL_SECONDS = 492.0
COOLING_READY_SECONDS = 312.0
DECONDITIONING_SECONDS = 180.0

#: A power-on issued during the cooling `ready` window has been observed to
#: take effect directly. If it does not, we fall back to waiting for standby.
RETRY_POWER_ON_AFTER = 45.0


class BarcoDriver(EntityBackedDriver):
    """Projector power, phase resolution and profile selection."""

    required_entities = ("power", "state")

    def __init__(self, bridge: Bridge, spec: DeviceSpec) -> None:
        super().__init__(bridge, spec)
        self._last_raw: str | None = None
        self._phase: str = PHASE_UNKNOWN
        #: Shadow value for the active profile. The projector cannot report
        #: it — selecting a profile merely applies settings — so we remember
        #: what we set and drop it on every power cycle (FR-143).
        self._profile: str | None = None
        #: Standing intent, so a power-on swallowed by a cooldown is retried
        #: as soon as the projector is in a state that accepts it.
        self._want_on = False
        self._last_power_on_at: float | None = None

    # -- phase resolution ---------------------------------------------------

    def _raw_state(self) -> str | None:
        return self.value_of("state")

    def _resolve_phase(self, raw: str | None) -> str:
        """Map the raw Pulse state onto an unambiguous phase."""
        if raw is None:
            return PHASE_UNKNOWN
        if raw in _OFF_STATES:
            return PHASE_OFF
        if raw in _WARMING_STATES:
            return PHASE_WARMING
        if raw in _COOLING_STATES:
            return PHASE_COOLING
        if raw == "on":
            return PHASE_ON
        if raw == "ready":
            # The whole point of this module: `ready` inherits its meaning
            # from where it was entered.
            if self._last_raw in _COOLING_STATES or self._phase == PHASE_COOLING:
                return PHASE_COOLING
            if self._last_raw in _OFF_STATES or self._last_raw in _WARMING_STATES:
                return PHASE_WARMING
            if self._phase in (PHASE_WARMING, PHASE_COOLING):
                return self._phase
            # No history at all — an HA restart mid-cooldown lands here.
            # Treating it as cooling is the safe reading: we wait rather than
            # declare a projector ready that is actually shutting down.
            return PHASE_COOLING
        return PHASE_UNKNOWN

    @property
    def phase(self) -> str:
        return self._phase

    def remaining_seconds(self) -> float | None:
        """Best estimate of time left in the current phase (FR-141)."""
        raw = self._raw_state()
        if raw in _COOLING_STATES:
            return COOLDOWN_TOTAL_SECONDS
        if raw == "ready" and self._phase == PHASE_COOLING:
            return COOLING_READY_SECONDS
        if raw == "ready" and self._phase == PHASE_WARMING:
            return 10.0
        return None

    # -- DeviceDriver protocol ---------------------------------------------

    async def observe(self) -> DeviceObservation:
        raw = self._raw_state()
        phase = self._resolve_phase(raw)
        if raw != self._last_raw:
            _LOGGER.debug("Beamer: %s -> %s (Phase %s)", self._last_raw, raw, phase)
            self._last_raw = raw
        self._phase = phase

        if self._want_on and phase not in (PHASE_ON, PHASE_WARMING):
            await self._try_power_on(raw)

        if phase == PHASE_OFF:
            # A power cycle invalidates whatever profile we thought was live.
            self._profile = None
            power = Power.OFF
        elif phase == PHASE_ON:
            power = Power.ON
        elif phase in (PHASE_WARMING, PHASE_COOLING):
            power = Power.TRANSITIONING
        else:
            power = Power.UNKNOWN

        state = self.state_of("state")
        if state is not None and state.state == "unavailable":
            power = Power.UNAVAILABLE

        settings: dict[str, Any] = {}
        if self._profile is not None:
            settings["profile"] = self._profile

        return DeviceObservation(
            device=self.spec.key,
            power=power,
            settings=settings,
            phase=phase,
            available=state is not None,
        )

    async def start(self) -> None:
        """
        Power on, coping with an in-progress cooldown.

        During `deconditioning` the projector does not accept a power-on, so
        the command is held as a standing intent and re-issued from
        :meth:`observe` once the state permits it. During the cooling `ready`
        window a power-on *has* been observed to land, so we try it there
        rather than burning five minutes waiting for standby.
        """
        self._want_on = True
        await self._try_power_on(self._raw_state())

    async def _try_power_on(self, raw: str | None) -> None:
        if raw in _COOLING_STATES:
            _LOGGER.debug("Beamer kühlt ab (%s) — Einschalten wird nachgeholt", raw)
            return
        now = self.bridge.now()
        if (
            self._last_power_on_at is not None
            and now - self._last_power_on_at < RETRY_POWER_ON_AFTER
        ):
            return
        self._last_power_on_at = now
        await self.call("switch", "turn_on", role="power")

    async def stop(self) -> None:
        self._want_on = False
        self._last_power_on_at = None
        self._profile = None
        await self.call("switch", "turn_off", role="power")

    async def apply(self, settings: Mapping[str, Any]) -> None:
        profile = settings.get("profile")
        if profile is None:
            return
        if not self.entity("profile"):
            raise RuntimeError(
                "Beamer: keine Profil-Entity konfiguriert, "
                f"'{profile}' kann nicht gesetzt werden"
            )
        await select_option(self, "profile", profile)
        self._profile = str(profile)

    def is_ready(self, observation: DeviceObservation) -> bool:
        """Ready means genuinely `on` — never merely `ready`."""
        return observation.phase == PHASE_ON
