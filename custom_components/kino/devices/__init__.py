"""Device driver registry."""

from __future__ import annotations

from collections.abc import Mapping

from ..core.model import DeviceSpec
from .barco import BarcoDriver
from .base import EntityBackedDriver
from .bridge import Bridge, HassBridge, StateSnapshot
from .generic import GenericDriver
from .madvr import MadvrDriver
from .trinnov import TrinnovDriver
from .zidoo import ZidooDriver

DRIVERS: dict[str, type[EntityBackedDriver]] = {
    "barco": BarcoDriver,
    "trinnov": TrinnovDriver,
    "madvr": MadvrDriver,
    "zidoo": ZidooDriver,
    "generic": GenericDriver,
}


class UnknownDriverError(Exception):
    """The config names a driver that does not exist."""


def build_driver(bridge: Bridge, spec: DeviceSpec) -> EntityBackedDriver:
    """Instantiate the driver named by ``spec.driver``."""
    try:
        factory = DRIVERS[spec.driver]
    except KeyError as err:
        raise UnknownDriverError(
            f"Unbekannter Treiber '{spec.driver}' für Gerät '{spec.key}' "
            f"(bekannt: {', '.join(sorted(DRIVERS))})"
        ) from err
    return factory(bridge, spec)


def build_drivers(
    bridge: Bridge, specs: Mapping[str, DeviceSpec]
) -> dict[str, EntityBackedDriver]:
    """Instantiate every configured device driver."""
    return {key: build_driver(bridge, spec) for key, spec in specs.items()}


__all__ = [
    "DRIVERS",
    "BarcoDriver",
    "Bridge",
    "EntityBackedDriver",
    "GenericDriver",
    "HassBridge",
    "MadvrDriver",
    "StateSnapshot",
    "TrinnovDriver",
    "UnknownDriverError",
    "ZidooDriver",
    "build_driver",
    "build_drivers",
]
