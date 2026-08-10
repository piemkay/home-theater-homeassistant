"""
Differential transition planner (FR-10 .. FR-14).

Given what the room *is* (observations straight off the devices) and what an
activity *wants*, produce the smallest set of operations that closes the gap.
A cold start is not a special case: it is the delta from "everything off"
(FR-13).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .model import (
    ActionKind,
    ActivityDef,
    DeviceAction,
    DeviceObservation,
    DeviceSpec,
    Power,
    PowerTarget,
    TransitionPlan,
)


def _wanted_settings(activity: ActivityDef, device_key: str) -> Mapping[str, Any]:
    req = activity.devices.get(device_key)
    return dict(req.settings) if req else {}


def _is_required(activity: ActivityDef, spec: DeviceSpec, device_key: str) -> bool:
    req = activity.devices.get(device_key)
    if req is not None and req.required is not None:
        return req.required
    return spec.required


def _drifted_settings(
    obs: DeviceObservation,
    wanted: Mapping[str, Any],
    spec: DeviceSpec,
) -> dict[str, Any]:
    """Return only the settings that actually need writing."""
    out: dict[str, Any] = {}
    for key, value in wanted.items():
        if key in spec.unverifiable_settings and key not in obs.settings:
            # The device cannot report this back and no shadow value exists,
            # so we cannot claim it is already correct (FR-143).
            out[key] = value
            continue
        if not obs.setting_matches(key, value):
            out[key] = value
    return out


def plan_transition(
    *,
    devices: Mapping[str, DeviceSpec],
    observations: Mapping[str, DeviceObservation],
    target: ActivityDef,
    current_activity: str | None = None,
) -> TransitionPlan:
    """
    Compute the delta between the observed room and ``target``.

    Devices absent from ``observations`` are treated as unknown, which forces
    a start when the activity needs them and no action when it does not.
    """
    actions: list[DeviceAction] = []

    for key in _relevant_devices(devices, observations, target):
        spec = devices[key]
        obs = observations.get(key) or DeviceObservation(device=key)
        req = target.devices.get(key)
        wants_on = req is not None and req.power is PowerTarget.ON
        required = _is_required(target, spec, key)

        if not wants_on:
            if obs.power in (Power.ON, Power.TRANSITIONING):
                actions.append(
                    DeviceAction(
                        device=key,
                        kind=ActionKind.STOP,
                        reason=f"not needed by '{target.key}'",
                        required=False,
                    )
                )
            # Off / unavailable / unknown-and-unwanted: nothing to do.
            continue

        wanted = _wanted_settings(target, key)

        if obs.power is Power.ON:
            drift = _drifted_settings(obs, wanted, spec)
            if drift:
                actions.append(
                    DeviceAction(
                        device=key,
                        kind=ActionKind.RECONFIGURE,
                        settings=drift,
                        reason="settings differ: " + ", ".join(sorted(drift)),
                        required=required,
                    )
                )
            else:
                actions.append(
                    DeviceAction(
                        device=key,
                        kind=ActionKind.KEEP,
                        reason="already correct",
                        required=required,
                    )
                )
            continue

        # Off, unknown, unavailable or mid-transition: bring it up and apply
        # the full setting set — nothing about it can be trusted yet.
        actions.append(
            DeviceAction(
                device=key,
                kind=ActionKind.START,
                settings=wanted,
                reason=f"needed by '{target.key}', observed {obs.power.value}",
                required=required,
            )
        )

    actions.sort(key=lambda a: (a.kind.value, a.device))
    return TransitionPlan(
        from_activity=current_activity,
        to_activity=target.key,
        actions=tuple(actions),
    )


def _relevant_devices(
    devices: Mapping[str, DeviceSpec],
    observations: Mapping[str, DeviceObservation],
    target: ActivityDef,
) -> Iterable[str]:
    """Devices the target mentions, plus anything currently powered."""
    keys = set(target.devices) | {
        key
        for key, obs in observations.items()
        if obs.power in (Power.ON, Power.TRANSITIONING)
    }
    return sorted(k for k in keys if k in devices)


def infer_active_activity(
    *,
    devices: Mapping[str, DeviceSpec],
    observations: Mapping[str, DeviceObservation],
    activities: Mapping[str, ActivityDef],
    off_activity: str,
) -> tuple[str, list[str]]:
    """
    Derive the active activity from observed state alone (FR-31).

    Returns the best-matching activity key and the list of devices that
    deviate from it. The off activity wins only when nothing is powered, so a
    room that is half-up after a restart reconciles to the activity it most
    closely resembles rather than to "off".
    """
    powered = {
        key
        for key, obs in observations.items()
        if obs.power is Power.ON and key in devices
    }
    if not powered:
        return off_activity, []

    best_key = off_activity
    best_score = -1.0
    best_deviations: list[str] = []

    for key, activity in activities.items():
        if key == off_activity:
            continue
        wanted = {d for d in activity.devices if activity.requires(d)}
        if not wanted:
            continue
        matched = wanted & powered
        extra = powered - wanted
        missing = wanted - powered
        # Jaccard-style score: reward overlap, punish both kinds of mismatch.
        score = len(matched) / float(len(wanted | powered))
        # Settings that disagree count as partial deviations.
        setting_misses: list[str] = []
        for device_key in matched:
            spec = devices[device_key]
            obs = observations[device_key]
            drift = _drifted_settings(obs, _wanted_settings(activity, device_key), spec)
            # Unverifiable settings cannot argue against a match.
            hard_drift = {k for k in drift if k not in spec.unverifiable_settings}
            if hard_drift:
                setting_misses.append(device_key)
        score -= 0.05 * len(setting_misses)
        if score > best_score:
            best_score = score
            best_key = key
            best_deviations = sorted(extra | missing | set(setting_misses))

    return best_key, best_deviations
