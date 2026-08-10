"""Hardware- and Home-Assistant-free core of the Kino activity engine.

Nothing in this package may import ``homeassistant``. That is what lets the
planner, executor, state machine and config schema be unit-tested without a
projector, a Trinnov, or a running Home Assistant (NFR-6).
"""

from __future__ import annotations

from .drift import DriftDetector, DriftFinding
from .estimator import DurationEstimator
from .executor import (
    DeviceDriver,
    TransitionAborted,
    TransitionExecutor,
    TransitionProgress,
    TransitionResult,
)
from .machine import ActivityEngine, EngineSnapshot
from .model import (
    ActionKind,
    ActivityDef,
    ActivityState,
    ControlClass,
    DeviceAction,
    DeviceHealth,
    DeviceObservation,
    DeviceRequirement,
    DeviceSpec,
    DriftClass,
    KinoConfig,
    Power,
    PowerTarget,
    TransitionPlan,
)
from .planner import infer_active_activity, plan_transition
from .schema import ConfigError, ConfigErrors, validate

__all__ = [
    "ActionKind",
    "ActivityDef",
    "ActivityEngine",
    "ActivityState",
    "ConfigError",
    "ConfigErrors",
    "ControlClass",
    "DeviceAction",
    "DeviceDriver",
    "DeviceHealth",
    "DeviceObservation",
    "DeviceRequirement",
    "DeviceSpec",
    "DriftClass",
    "DriftDetector",
    "DriftFinding",
    "DurationEstimator",
    "EngineSnapshot",
    "KinoConfig",
    "Power",
    "PowerTarget",
    "TransitionAborted",
    "TransitionExecutor",
    "TransitionPlan",
    "TransitionProgress",
    "TransitionResult",
    "infer_active_activity",
    "plan_transition",
    "validate",
]
