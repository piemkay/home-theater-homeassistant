"""
The one seam between the drivers and Home Assistant.

Drivers read entity state and call services through this narrow interface, so
every driver can be exercised against an in-memory fake — no Home Assistant,
no hardware (NFR-6). :class:`HassBridge` is the only implementation that
touches ``homeassistant``.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True)
class StateSnapshot:
    """The parts of a Home Assistant ``State`` a driver actually needs."""

    entity_id: str
    state: str
    attributes: Mapping[str, Any] = field(default_factory=dict)

    @property
    def is_unavailable(self) -> bool:
        return self.state == "unavailable"

    @property
    def is_unknown(self) -> bool:
        return self.state == "unknown"


class Bridge(Protocol):
    """What a driver may do to the outside world."""

    def get_state(self, entity_id: str) -> StateSnapshot | None:
        """Return the entity state, or None when it does not exist."""

    async def call_service(
        self, domain: str, service: str, data: Mapping[str, Any]
    ) -> None:
        """Call a Home Assistant service and wait for it to finish."""

    def now(self) -> float:
        """Monotonic seconds, used for rate limiting."""


class HassBridge:
    """Bridge backed by a live Home Assistant instance."""

    def __init__(self, hass: Any) -> None:
        self._hass = hass

    def get_state(self, entity_id: str) -> StateSnapshot | None:
        state = self._hass.states.get(entity_id)
        if state is None:
            return None
        return StateSnapshot(
            entity_id=entity_id,
            state=state.state,
            attributes=dict(state.attributes),
        )

    async def call_service(
        self, domain: str, service: str, data: Mapping[str, Any]
    ) -> None:
        await self._hass.services.async_call(domain, service, dict(data), blocking=True)

    def now(self) -> float:
        return self._hass.loop.time()
