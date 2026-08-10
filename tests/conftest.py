"""
Shared fixtures: a fake device rig that behaves like the real room.

The fakes model the awkward parts on purpose — the projector's slow cooldown
and its `ready`-means-two-things quirk, the Trinnov's source list arriving
late — because those are exactly the behaviours the engine has to get right.
"""

from __future__ import annotations

import asyncio
import sys
import types
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))


def _stub_package(name: str, path: Path) -> None:
    """Register a namespace-only stand-in for a package.

    ``custom_components/kino/__init__.py`` is a Home Assistant entry point and
    imports ``homeassistant`` at module scope. Importing anything beneath it —
    including the deliberately HA-free ``core`` package — would drag that in.
    Pre-registering the parents as bare namespace modules means Python never
    executes their ``__init__``, so ``core``, ``devices`` and ``media`` stay
    importable on a plain Python install with no Home Assistant present.
    """
    module = types.ModuleType(name)
    module.__path__ = [str(path)]  # type: ignore[attr-defined]
    sys.modules.setdefault(name, module)


_stub_package("custom_components", _ROOT / "custom_components")
_stub_package("custom_components.kino", _ROOT / "custom_components" / "kino")

from custom_components.kino.core.model import (
    DeviceObservation,
    DeviceSpec,
    Power,
)
from custom_components.kino.core.schema import validate


class FakeClock:
    """
    A virtual clock, so timing behaviour is exact instead of merely fast.

    Sleepers register a wake-up time and block. :meth:`run` drives the real
    event loop until nothing can make progress, then jumps virtual time to the
    next wake-up. Concurrent sleeps therefore overlap the way they would in
    wall-clock time rather than each advancing the clock on their own.
    """

    def __init__(self) -> None:
        self.now = 0.0
        self._waiters: list[tuple[float, asyncio.Future[None]]] = []

    def time(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        future: asyncio.Future[None] = asyncio.get_event_loop().create_future()
        self._waiters.append((self.now + seconds, future))
        try:
            await future
        except asyncio.CancelledError:
            self._waiters = [(t, f) for t, f in self._waiters if f is not future]
            raise

    async def run(self, coro, *, max_steps: int = 10_000):
        """Run ``coro`` to completion under virtual time."""
        task = asyncio.ensure_future(coro)
        for _ in range(max_steps):
            for _ in range(8):
                if task.done():
                    break
                await asyncio.sleep(0)
            if task.done():
                break
            if not self._waiters:
                await asyncio.sleep(0)
                continue
            self.now = max(self.now, min(t for t, _ in self._waiters))
            pending = []
            for wake_at, future in self._waiters:
                if wake_at <= self.now and not future.done():
                    future.set_result(None)
                else:
                    pending.append((wake_at, future))
            self._waiters = pending
        else:  # pragma: no cover - a hung engine is a test failure, not a hang
            task.cancel()
            raise AssertionError("virtual clock ran out of steps")
        return await task


class FakeDriver:
    """A device that takes a configurable number of poll ticks to settle."""

    def __init__(
        self,
        spec: DeviceSpec,
        clock: FakeClock,
        *,
        power: Power = Power.OFF,
        settings: Mapping[str, Any] | None = None,
        start_seconds: float = 0.0,
        stop_seconds: float = 0.0,
        fail_start: bool = False,
        never_stops: bool = False,
    ) -> None:
        self.spec = spec
        self._clock = clock
        self.power = power
        self.settings: dict[str, Any] = dict(settings or {})
        self.start_seconds = start_seconds
        self.stop_seconds = stop_seconds
        self.fail_start = fail_start
        self.never_stops = never_stops
        self.unverified: set[str] = set()
        self.error: str | None = None
        self.available = True

        self.calls: list[str] = []
        self.applied: list[dict[str, Any]] = []
        self._switch_at: float | None = None
        self._switch_to: Power | None = None

    # -- DeviceDriver protocol ---------------------------------------------

    async def observe(self) -> DeviceObservation:
        if (
            self._switch_at is not None
            and self._clock.now >= self._switch_at
            and self._switch_to is not None
        ):
            self.power = self._switch_to
            self._switch_at = None
            self._switch_to = None
        return DeviceObservation(
            device=self.spec.key,
            power=Power.UNAVAILABLE if not self.available else self.power,
            settings=dict(self.settings),
            unverified=frozenset(self.unverified),
            available=self.available,
            error=self.error,
        )

    async def start(self) -> None:
        self.calls.append("start")
        if self.fail_start:
            raise RuntimeError(f"{self.spec.name} antwortet nicht")
        self.power = Power.TRANSITIONING
        self._switch_at = self._clock.now + self.start_seconds
        self._switch_to = Power.ON

    async def stop(self) -> None:
        self.calls.append("stop")
        if self.never_stops:
            return
        self.power = Power.TRANSITIONING
        self._switch_at = self._clock.now + self.stop_seconds
        self._switch_to = Power.OFF

    async def apply(self, settings: Mapping[str, Any]) -> None:
        self.calls.append("apply")
        self.applied.append(dict(settings))
        self.settings.update(settings)
        self.unverified -= set(settings)

    async def stop_playback(self) -> None:
        self.calls.append("stop_playback")

    def is_ready(self, observation: DeviceObservation) -> bool:
        return observation.power is Power.ON and observation.available


CONFIG_DOC: dict[str, Any] = {
    "version": 1,
    "settings": {
        "off_activity": "aus",
        "volume": {"device": "trinnov", "min_db": -60, "max_db": -20, "step_db": 2},
        "shutdown_light_scene": "scene.low_ambience",
        "drift_debounce_seconds": 20,
    },
    "devices": {
        "barco": {
            "driver": "barco",
            "name": "Beamer",
            "entities": {
                "power": "switch.hodr_cs_power",
                "state": "sensor.hodr_cs_state",
                "profile": "select.hodr_cs_profile",
            },
            "unverifiable_settings": ["profile"],
            "startup_timeout": 600,
            "shutdown_timeout": 480,
            "default_startup_seconds": 120,
            "default_shutdown_seconds": 360,
        },
        "trinnov": {
            "driver": "trinnov",
            "name": "Trinnov",
            "entities": {
                "power": "remote.trinnov_altitude_14683197",
                "media_player": "media_player.trinnov_altitude_14683197",
                "source": "select.trinnov_altitude_14683197_source",
                "preset": "select.trinnov_altitude_14683197_preset",
                "upmixer": "select.trinnov_altitude_14683197_upmixer",
            },
            "default_startup_seconds": 40,
        },
        "madvr": {
            "driver": "madvr",
            "name": "madVR",
            "entities": {"power": "remote.madvr_envy"},
            "default_startup_seconds": 25,
        },
        "zidoo": {
            "driver": "zidoo",
            "name": "Zidoo",
            "entities": {
                "power": "remote.uhd8000",
                "media_player": "media_player.uhd8000",
            },
            "is_media": True,
            "default_startup_seconds": 20,
        },
        "shield": {
            "driver": "generic",
            "name": "Shield",
            "entities": {"media_player": "media_player.shield_kino_3"},
            "required": False,
            "is_media": True,
            "default_startup_seconds": 10,
        },
    },
    "activities": {
        "aus": {"name": "Aus", "control_class": "off", "devices": {}},
        "film": {
            "name": "Bibliothek",
            "control_class": "full",
            "media": "jellyfin",
            "light_scene": "scene.dark",
            "devices": {
                "barco": {"power": True, "profile": "HDR 260 HDMI"},
                "trinnov": {"power": True, "source": "zidoo", "volume": -30.0},
                "madvr": {"power": True},
                "zidoo": {"power": True},
            },
        },
        "netflix": {
            "name": "Streaming",
            "control_class": "handoff",
            "light_scene": "scene.dark",
            "devices": {
                "barco": {"power": True, "profile": "HDR 260 HDMI"},
                "trinnov": {"power": True, "source": "shield", "volume": -30.0},
                "madvr": {"power": True},
                "shield": {"power": True},
            },
        },
        "musik": {
            "name": "Musik",
            "control_class": "mixed",
            "light_scene": "scene.low_ambience",
            "devices": {
                "trinnov": {"power": True, "source": "zidoo", "volume": -35.0},
                "zidoo": {"power": True},
            },
        },
        "steam": {
            "name": "Steam",
            "control_class": "room",
            "light_scene": "scene.dark",
            "devices": {
                "barco": {"power": True, "profile": "HDR 260 DP"},
                "trinnov": {"power": True, "source": "steam", "volume": -30.0},
            },
        },
    },
}


@pytest.fixture
def config_doc() -> dict[str, Any]:
    import copy

    return copy.deepcopy(CONFIG_DOC)


@pytest.fixture
def config(config_doc):
    return validate(config_doc)


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def drivers(config, clock) -> dict[str, FakeDriver]:
    """Every device off and cold, with realistic settle times."""
    settle = {
        "barco": (120.0, 360.0),
        "trinnov": (40.0, 5.0),
        "madvr": (25.0, 5.0),
        "zidoo": (20.0, 5.0),
        "shield": (10.0, 3.0),
    }
    return {
        key: FakeDriver(
            spec,
            clock,
            start_seconds=settle[key][0],
            stop_seconds=settle[key][1],
        )
        for key, spec in config.devices.items()
    }
