"""Demo mode: reference clips, showcases and the engine that replays them.

A feature module inside the integration, not a subsystem beside it. The
engine consumes the activity state machine and the media device through one
narrow runtime port; it never talks to hardware itself.

Only the Home-Assistant-free half is re-exported here, so the engine and its
model stay importable on a plain Python install (NFR-6). The store, the
runtime adapter, the services and the WebSocket commands all need a Home
Assistant runtime and are imported from their own modules.
"""

from __future__ import annotations

from .engine import DemoEngine, DemoRuntime
from .model import VOCABULARY, Clip, DemoSettings, Showcase

__all__ = [
    "VOCABULARY",
    "Clip",
    "DemoEngine",
    "DemoRuntime",
    "DemoSettings",
    "Showcase",
]
