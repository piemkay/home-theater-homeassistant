"""
Entity-backed device drivers.

Every logical device is driven through the Home Assistant entities that the
existing integrations already expose. That keeps one protocol implementation
per device — in its own integration, where it belongs — and makes the Kino
drivers thin, uniform and testable through :mod:`.bridge`.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any, ClassVar

from ..core.model import DeviceObservation, DeviceSpec, Power
from .bridge import Bridge, StateSnapshot

_LOGGER = logging.getLogger(__name__)

STATE_ON = "on"
STATE_OFF = "off"
STATE_UNAVAILABLE = "unavailable"
STATE_UNKNOWN = "unknown"

#: media_player states that mean "powered and usable".
ACTIVE_MEDIA_STATES = frozenset({"on", "idle", "playing", "paused", "buffering"})
PLAYING_STATES = frozenset({"playing", "paused", "buffering"})


class EntityBackedDriver:
    """Base driver: observe entity state, act through services."""

    #: Roles this driver needs in ``devices.<key>.entities``.
    required_entities: tuple[str, ...] = ()

    #: Every role this driver understands, mapped to the Home Assistant
    #: domains a value may legitimately come from. The admin panel builds one
    #: searchable picker per role from this and filters the entity list to
    #: those domains, so a role can never be wired to the wrong kind of
    #: entity (FR-130).
    entity_roles: ClassVar[Mapping[str, tuple[str, ...]]] = {}

    def __init__(self, bridge: Bridge, spec: DeviceSpec) -> None:
        self.bridge = bridge
        self.spec = spec

    # -- entity helpers -----------------------------------------------------

    def entity(self, role: str) -> str | None:
        return self.spec.entities.get(role)

    def state_of(self, role: str) -> StateSnapshot | None:
        entity_id = self.entity(role)
        if not entity_id:
            return None
        return self.bridge.get_state(entity_id)

    def value_of(self, role: str) -> str | None:
        state = self.state_of(role)
        if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return None
        return state.state

    def options_of(self, role: str) -> list[str]:
        """Legal values for a role, from whichever attribute carries them.

        ``select`` entities use ``options``; ``media_player`` uses
        ``source_list``. The editor needs both.
        """
        state = self.state_of(role)
        if state is None:
            return []
        attributes = state.attributes
        return list(attributes.get("options") or attributes.get("source_list") or [])

    def missing_entities(self) -> list[str]:
        return [
            role for role in self.required_entities if not self.spec.entities.get(role)
        ]

    def role_catalogue(self) -> list[dict[str, Any]]:
        """Describe every wireable role, in the order the panel should show it.

        Roles the driver declares come first; anything the document wires up
        that this driver does not know about follows, so an unknown role is
        visible and editable rather than silently dropped on the next save.
        """
        roles: dict[str, tuple[str, ...]] = dict(self.entity_roles)
        for role in self.spec.entities:
            roles.setdefault(role, ())
        return [
            {
                "role": role,
                "domains": list(domains),
                "required": role in self.required_entities,
                "known": role in self.entity_roles,
            }
            for role, domains in roles.items()
        ]

    async def call(
        self,
        domain: str,
        service: str,
        *,
        role: str | None = None,
        data: Mapping[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = dict(data or {})
        if role is not None:
            entity_id = self.entity(role)
            if not entity_id:
                raise RuntimeError(
                    f"{self.spec.name}: keine Entity für '{role}' konfiguriert"
                )
            payload["entity_id"] = entity_id
        await self.bridge.call_service(domain, service, payload)

    def domain_of(self, role: str, fallback: str) -> str:
        entity_id = self.entity(role)
        if not entity_id or "." not in entity_id:
            return fallback
        return entity_id.split(".", 1)[0]

    def _power_from_entity(self, role: str = "power") -> Power:
        state = self.state_of(role)
        if state is None:
            return Power.UNKNOWN
        if state.is_unavailable:
            return Power.UNAVAILABLE
        if state.is_unknown:
            return Power.UNKNOWN
        if state.state == STATE_ON:
            return Power.ON
        if state.state == STATE_OFF:
            return Power.OFF
        if state.state in ACTIVE_MEDIA_STATES:
            return Power.ON
        return Power.UNKNOWN

    # -- editor support (FR-112) -------------------------------------------

    #: Settings this driver understands, mapped to the entity role whose
    #: option list supplies the legal values. ``None`` means the value is a
    #: free number rather than a choice.
    setting_roles: ClassVar[Mapping[str, str | None]] = {}

    def setting_options(self) -> dict[str, dict[str, Any]]:
        """Describe the per-activity settings this device accepts.

        The admin panel builds its dropdowns from this, so a profile or a
        source is always picked from what the device really offers rather
        than typed in free-hand.
        """
        described: dict[str, dict[str, Any]] = {}
        for setting, role in self.setting_roles.items():
            if role is None:
                described[setting] = {"type": "number", "options": None}
                continue
            options = self.options_of(role)
            described[setting] = {
                "type": "select",
                "options": options,
                # An empty list means the device is off, not that the setting
                # is invalid — the panel must say so rather than show nothing.
                "available": bool(options),
                "entity": self.entity(role),
            }
        return described

    # -- DeviceDriver protocol ---------------------------------------------

    async def observe(self) -> DeviceObservation:
        return DeviceObservation(device=self.spec.key, power=self._power_from_entity())

    async def start(self) -> None:
        await self.call(self.domain_of("power", "switch"), "turn_on", role="power")

    async def stop(self) -> None:
        await self.call(self.domain_of("power", "switch"), "turn_off", role="power")

    async def apply(self, settings: Mapping[str, Any]) -> None:
        for key, value in settings.items():
            _LOGGER.debug(
                "%s: Einstellung '%s' wird von diesem Treiber ignoriert (%r)",
                self.spec.name,
                key,
                value,
            )

    async def stop_playback(self) -> None:
        state = self.state_of("media_player")
        if state is None or state.state not in PLAYING_STATES:
            return
        await self.call("media_player", "media_stop", role="media_player")

    def is_ready(self, observation: DeviceObservation) -> bool:
        return observation.power is Power.ON and observation.available


async def select_option(driver: EntityBackedDriver, role: str, option: Any) -> None:
    """
    Set a ``select`` entity, failing loudly when the option is unknown.

    The old scripts died with "Option steam is not valid" whenever the option
    list had not loaded yet. Naming the device, the role and what *is*
    available turns that into a diagnosable message.
    """
    entity_id = driver.entity(role)
    if not entity_id:
        raise RuntimeError(
            f"{driver.spec.name}: keine Entity für '{role}' konfiguriert"
        )
    wanted = str(option)
    options = driver.options_of(role)
    if options and wanted not in options:
        raise RuntimeError(
            f"{driver.spec.name}: '{wanted}' ist keine gültige Auswahl für "
            f"{role} (verfügbar: {', '.join(options) or 'noch keine'})"
        )
    await driver.call("select", "select_option", role=role, data={"option": wanted})
