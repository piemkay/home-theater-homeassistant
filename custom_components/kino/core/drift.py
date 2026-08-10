"""
Out-of-band state change detection and classification (FR-36 .. FR-39a).

The rule this module exists to enforce: the integration reconciles, it does
not enforce. When a person switches a device off with its own remote, we
follow them and say so — we never quietly switch it back on (FR-38).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from .model import (
    ActivityDef,
    DeviceObservation,
    DeviceSpec,
    DriftClass,
    Power,
)


@dataclass(frozen=True)
class DriftFinding:
    """One device deviating from what the active activity expects."""

    device: str
    classification: DriftClass
    detail: str
    #: True when the card should offer a one-tap "Wiederherstellen" (FR-39).
    restorable: bool = False

    @property
    def is_blocking(self) -> bool:
        return self.classification is DriftClass.FATAL


class DriftDetector:
    """
    Debounced drift detection over a stream of observations (FR-39a).

    A finding is only reported once the same deviation has been seen for
    ``debounce_seconds``; a device's own transient states therefore cannot
    flap the activity state.
    """

    def __init__(self, debounce_seconds: float = 20.0) -> None:
        self._debounce = max(0.0, debounce_seconds)
        #: device -> (signature, first_seen_monotonic)
        self._pending: dict[str, tuple[str, float]] = {}
        self._confirmed: dict[str, DriftFinding] = {}
        self._dismissed: set[str] = set()

    def dismiss(self, device: str) -> None:
        """Stop surfacing a finding the user has explicitly ignored."""
        self._dismissed.add(device)

    def clear(self, device: str | None = None) -> None:
        if device is None:
            self._pending.clear()
            self._confirmed.clear()
            self._dismissed.clear()
            return
        self._pending.pop(device, None)
        self._confirmed.pop(device, None)
        self._dismissed.discard(device)

    def evaluate(  # noqa: C901 - one flat pass over the FR-37 table
        self,
        *,
        activity: ActivityDef,
        devices: Mapping[str, DeviceSpec],
        observations: Mapping[str, DeviceObservation],
        now: float,
        transitioning: bool = False,
    ) -> list[DriftFinding]:
        """Return the confirmed findings for the current observation set."""
        if transitioning:
            # Everything looks wrong mid-transition; that is the executor's
            # business, not drift.
            self._pending.clear()
            return []

        candidates: dict[str, DriftFinding] = {}
        for key, spec in devices.items():
            obs = observations.get(key)
            if obs is None:
                continue
            finding = _classify(activity, spec, obs)
            if finding is not None:
                candidates[key] = finding

        # Devices that came back into line drop out of every bucket.
        for key in list(self._pending):
            if key not in candidates:
                del self._pending[key]
        for key in list(self._confirmed):
            if key not in candidates:
                del self._confirmed[key]
                self._dismissed.discard(key)

        for key, finding in candidates.items():
            signature = f"{finding.classification.value}:{finding.detail}"
            previous = self._pending.get(key)
            if previous is None or previous[0] != signature:
                self._pending[key] = (signature, now)
                # A device that failed while we needed it is not a flap;
                # report it immediately.
                if finding.classification is DriftClass.FATAL:
                    self._confirmed[key] = finding
                continue
            if now - previous[1] >= self._debounce:
                self._confirmed[key] = finding

        return [
            finding
            for key, finding in sorted(self._confirmed.items())
            if key not in self._dismissed
        ]


def _classify(
    activity: ActivityDef,
    spec: DeviceSpec,
    obs: DeviceObservation,
) -> DriftFinding | None:
    """Map one deviating observation onto the FR-37 table."""
    wanted_on = activity.requires(spec.key)

    if not wanted_on:
        # The activity does not care about this device. A device that is on
        # when it should be off is a leftover, not a fault.
        if obs.power is Power.ON:
            return DriftFinding(
                device=spec.key,
                classification=DriftClass.BENIGN,
                detail=f"{spec.name} läuft, wird aber nicht benötigt",
            )
        return None

    if obs.power is Power.UNAVAILABLE or not obs.available:
        return DriftFinding(
            device=spec.key,
            classification=DriftClass.TRANSPORT,
            detail=f"{spec.name} ist nicht erreichbar",
            restorable=True,
        )

    if obs.error:
        return DriftFinding(
            device=spec.key,
            classification=DriftClass.FATAL if spec.required else DriftClass.TRANSPORT,
            detail=f"{spec.name}: {obs.error}",
            restorable=True,
        )

    if obs.power is Power.OFF:
        if not spec.required:
            # A Shield that idle-sleeps with nothing playing is expected.
            return DriftFinding(
                device=spec.key,
                classification=DriftClass.BENIGN,
                detail=f"{spec.name} ist im Ruhezustand",
                restorable=True,
            )
        return DriftFinding(
            device=spec.key,
            classification=DriftClass.DELIBERATE,
            detail=(
                f"{spec.name} wurde vermutlich per eigener Fernbedienung ausgeschaltet"
            ),
            restorable=True,
        )

    if obs.power is Power.TRANSITIONING:
        return None

    # Powered on but configured differently — again, follow the user.
    requirement = activity.devices.get(spec.key)
    if requirement:
        changed = [
            key
            for key, value in requirement.settings.items()
            if key not in spec.unverifiable_settings
            and key in obs.settings
            and not obs.setting_matches(key, value)
        ]
        if changed:
            return DriftFinding(
                device=spec.key,
                classification=DriftClass.DELIBERATE,
                detail=(
                    f"{spec.name}: {', '.join(sorted(changed))} weicht von der "
                    "Aktivität ab"
                ),
                restorable=True,
            )
    return None
