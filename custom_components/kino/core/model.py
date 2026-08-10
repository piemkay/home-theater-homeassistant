"""Core domain model for the Kino activity engine.

This module is deliberately free of any Home Assistant import so the whole
engine can be unit-tested without hardware and without a Home Assistant
runtime (NFR-6).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Mapping

# --------------------------------------------------------------------------
# Enumerations
# --------------------------------------------------------------------------


class PowerTarget(str, Enum):
    """What an activity wants a device's power to be."""

    ON = "on"
    OFF = "off"


class Power(str, Enum):
    """Observed power state of a device.

    ``TRANSITIONING`` covers both directions; drivers that can tell the
    difference report it through :attr:`DeviceObservation.phase` instead.
    """

    ON = "on"
    OFF = "off"
    TRANSITIONING = "transitioning"
    UNAVAILABLE = "unavailable"
    UNKNOWN = "unknown"


class DeviceHealth(str, Enum):
    """Per-device status surfaced to the UI (FR-33)."""

    OFF = "off"
    STARTING = "starting"
    READY = "ready"
    STOPPING = "stopping"
    DEGRADED = "degraded"
    UNREACHABLE = "unreachable"
    ERROR = "error"
    UNKNOWN = "unknown"


class ActivityState(str, Enum):
    """Primary state machine (FR-30)."""

    OFF = "off"
    STARTING = "starting"
    SWITCHING = "switching"
    ON = "on"
    STOPPING = "stopping"
    ERROR = "error"


class ControlClass(str, Enum):
    """How much content control the card actually has (FR-47d)."""

    FULL = "full"
    HANDOFF = "handoff"
    MIXED = "mixed"
    ROOM = "room"
    OFF = "off"


class ActionKind(str, Enum):
    """The four outcomes of the differential planner (FR-10)."""

    START = "start"
    STOP = "stop"
    RECONFIGURE = "reconfigure"
    KEEP = "keep"


class DriftClass(str, Enum):
    """Classification of out-of-band state changes (FR-37)."""

    BENIGN = "benign"
    DELIBERATE = "deliberate"
    TRANSPORT = "transport"
    FATAL = "fatal"


# --------------------------------------------------------------------------
# Configuration objects
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DeviceSpec:
    """Static definition of a logical device."""

    key: str
    driver: str
    name: str
    entities: Mapping[str, str] = field(default_factory=dict)
    #: Settings whose value the device cannot report back. The planner treats
    #: these as unknown unless a shadow value is supplied (FR-143).
    unverifiable_settings: frozenset[str] = frozenset()
    #: Devices that must be ready before this one can be configured (FR-21).
    depends_on: tuple[str, ...] = ()
    startup_timeout: float = 180.0
    shutdown_timeout: float = 120.0
    reconfigure_timeout: float = 30.0
    #: Fallback estimate used before any duration has been learned (FR-24).
    default_startup_seconds: float = 30.0
    default_shutdown_seconds: float = 20.0
    #: Devices whose loss should not fail a transition.
    required: bool = True
    #: This device plays media and must be stopped cleanly before power-off.
    is_media: bool = False
    options: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class DeviceRequirement:
    """What one activity wants from one device."""

    device: str
    power: PowerTarget = PowerTarget.ON
    settings: Mapping[str, Any] = field(default_factory=dict)
    #: Override the device-level ``required`` flag for this activity.
    required: bool | None = None


@dataclass(frozen=True)
class ActivityDef:
    """A named target state of the room (FR-1)."""

    key: str
    name: str
    devices: Mapping[str, DeviceRequirement] = field(default_factory=dict)
    control_class: ControlClass = ControlClass.ROOM
    media: str | None = None
    light_scene: str | None = None
    icon: str | None = None
    handoff_text: str | None = None

    def requires(self, device_key: str) -> bool:
        """Return True when this activity wants ``device_key`` powered on."""
        req = self.devices.get(device_key)
        return req is not None and req.power is PowerTarget.ON


@dataclass(frozen=True)
class KinoConfig:
    """The whole validated configuration document (FR-91)."""

    devices: Mapping[str, DeviceSpec]
    activities: Mapping[str, ActivityDef]
    off_activity: str = "aus"
    volume_device: str | None = None
    volume_min_db: float = -60.0
    volume_max_db: float = -20.0
    volume_step_db: float = 2.0
    shutdown_light_scene: str | None = None
    drift_debounce_seconds: float = 20.0
    preferred_audio_language: str | None = None
    preferred_subtitle_language: str | None = None

    @property
    def off(self) -> ActivityDef:
        """Return the activity that represents "everything off"."""
        return self.activities[self.off_activity]


# --------------------------------------------------------------------------
# Runtime observations
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DeviceObservation:
    """A point-in-time reading of one device, derived from device state only."""

    device: str
    power: Power = Power.UNKNOWN
    settings: Mapping[str, Any] = field(default_factory=dict)
    #: Settings whose observed value cannot be trusted this instant.
    unverified: frozenset[str] = frozenset()
    #: Driver-specific unambiguous phase, e.g. the Barco's cooling/warming.
    phase: str | None = None
    available: bool = True
    error: str | None = None

    @property
    def is_on(self) -> bool:
        return self.power is Power.ON

    @property
    def is_off(self) -> bool:
        return self.power is Power.OFF

    def setting_matches(self, key: str, wanted: Any) -> bool:
        """Return True when the device demonstrably already has ``wanted``.

        Unknown or unverified values never match — an unverifiable setting
        must be re-applied rather than assumed correct.
        """
        if key in self.unverified:
            return False
        if key not in self.settings:
            return False
        current = self.settings[key]
        if current is None:
            return False
        if isinstance(wanted, float) or isinstance(current, float):
            try:
                return abs(float(current) - float(wanted)) < 1e-6
            except (TypeError, ValueError):
                return False
        return bool(current == wanted)


# --------------------------------------------------------------------------
# Plan objects
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class DeviceAction:
    """One planned operation against one device."""

    device: str
    kind: ActionKind
    settings: Mapping[str, Any] = field(default_factory=dict)
    reason: str = ""
    required: bool = True

    @property
    def is_noop(self) -> bool:
        return self.kind is ActionKind.KEEP


@dataclass(frozen=True)
class TransitionPlan:
    """The delta between the observed room and a target activity (FR-10)."""

    from_activity: str | None
    to_activity: str
    actions: tuple[DeviceAction, ...]

    def of_kind(self, kind: ActionKind) -> tuple[DeviceAction, ...]:
        return tuple(a for a in self.actions if a.kind is kind)

    @property
    def starts(self) -> tuple[DeviceAction, ...]:
        return self.of_kind(ActionKind.START)

    @property
    def stops(self) -> tuple[DeviceAction, ...]:
        return self.of_kind(ActionKind.STOP)

    @property
    def reconfigures(self) -> tuple[DeviceAction, ...]:
        return self.of_kind(ActionKind.RECONFIGURE)

    @property
    def keeps(self) -> tuple[DeviceAction, ...]:
        return self.of_kind(ActionKind.KEEP)

    @property
    def is_empty(self) -> bool:
        """True when nothing at all has to happen (FR-32 idempotence)."""
        return all(a.is_noop for a in self.actions)

    def describe(self) -> str:
        """Human-readable one-liner, used by the dry-run planner (FR-121)."""
        parts = []
        for kind, label in (
            (ActionKind.STOP, "stop"),
            (ActionKind.START, "start"),
            (ActionKind.RECONFIGURE, "reconfigure"),
            (ActionKind.KEEP, "keep"),
        ):
            names = [a.device for a in self.of_kind(kind)]
            if names:
                parts.append(f"{label}: {', '.join(sorted(names))}")
        return "; ".join(parts) if parts else "nothing to do"
