"""
Learned duration model (FR-24, FR-82, FR-123).

The ETA shown to the person in the room comes from what the devices have
actually done before, not from a hardcoded guess. Estimates are a decaying
average so a projector that gets slower with lamp age is tracked rather than
averaged into irrelevance, and a single freak run cannot dominate.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: Weight of the newest sample. 0.3 converges in a handful of runs while
#: still smoothing out one-off network stalls.
_ALPHA = 0.3

#: Below this many samples the learned value is blended with the configured
#: default, so the first ETA after a fresh install is not wildly wrong.
_CONFIDENCE_SAMPLES = 3


@dataclass
class DurationSample:
    """Decaying average plus the raw bookkeeping the panel displays."""

    seconds: float
    samples: int = 0
    last_seconds: float | None = None
    min_seconds: float | None = None
    max_seconds: float | None = None

    def observe(self, value: float) -> None:
        value = max(0.0, float(value))
        if self.samples == 0:
            self.seconds = value
        else:
            self.seconds = (1.0 - _ALPHA) * self.seconds + _ALPHA * value
        self.samples += 1
        self.last_seconds = value
        self.min_seconds = (
            value if self.min_seconds is None else min(self.min_seconds, value)
        )
        self.max_seconds = (
            value if self.max_seconds is None else max(self.max_seconds, value)
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "seconds": round(self.seconds, 2),
            "samples": self.samples,
            "last_seconds": self.last_seconds,
            "min_seconds": self.min_seconds,
            "max_seconds": self.max_seconds,
        }

    @classmethod
    def from_dict(cls, raw: Mapping[str, Any]) -> DurationSample:
        return cls(
            seconds=float(raw.get("seconds", 0.0)),
            samples=int(raw.get("samples", 0)),
            last_seconds=raw.get("last_seconds"),
            min_seconds=raw.get("min_seconds"),
            max_seconds=raw.get("max_seconds"),
        )


class DurationEstimator:
    """Per device and transition kind, how long things really take."""

    def __init__(self, data: Mapping[str, Any] | None = None) -> None:
        self._samples: dict[str, DurationSample] = {}
        if data:
            self.restore(data)

    @staticmethod
    def _key(device: str, kind: str, *, from_cold: bool = True) -> str:
        # A projector started from standby and one nudged out of `ready`
        # behave nothing alike, so they are learned separately (FR-26).
        suffix = "cold" if from_cold else "warm"
        return f"{device}:{kind}:{suffix}"

    def record(
        self, device: str, kind: str, seconds: float, *, from_cold: bool = True
    ) -> None:
        key = self._key(device, kind, from_cold=from_cold)
        sample = self._samples.get(key)
        if sample is None:
            sample = DurationSample(seconds=seconds)
            self._samples[key] = sample
        sample.observe(seconds)

    def estimate(
        self,
        device: str,
        kind: str,
        default: float,
        *,
        from_cold: bool = True,
    ) -> float:
        """Best estimate in seconds, blended with ``default`` while young."""
        sample = self._samples.get(self._key(device, kind, from_cold=from_cold))
        if sample is None or sample.samples == 0:
            return default
        if sample.samples >= _CONFIDENCE_SAMPLES:
            return sample.seconds
        weight = sample.samples / float(_CONFIDENCE_SAMPLES)
        return weight * sample.seconds + (1.0 - weight) * default

    def reset(self, device: str | None = None) -> None:
        if device is None:
            self._samples.clear()
            return
        prefix = f"{device}:"
        for key in [k for k in self._samples if k.startswith(prefix)]:
            del self._samples[key]

    def as_dict(self) -> dict[str, Any]:
        return {key: sample.as_dict() for key, sample in self._samples.items()}

    def restore(self, data: Mapping[str, Any]) -> None:
        for key, raw in data.items():
            if isinstance(raw, Mapping):
                self._samples[key] = DurationSample.from_dict(raw)

    def report(self) -> list[dict[str, Any]]:
        """Flat listing for the diagnostics panel (FR-123)."""
        out = []
        for key, sample in sorted(self._samples.items()):
            device, kind, temperature = key.split(":", 2)
            out.append(
                {
                    "device": device,
                    "kind": kind,
                    "from": temperature,
                    **sample.as_dict(),
                }
            )
        return out
