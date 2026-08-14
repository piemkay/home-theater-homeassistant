"""
The `kino.demo_*` services (spec §9).

The card drives demo mode over WebSocket; these exist so an automation or a
physical button can too — capturing "that was demo-worthy" is exactly the
kind of thing that wants to hang off a remote key.
"""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING, Any

import voluptuous as vol
from homeassistant.core import HomeAssistant, ServiceCall, SupportsResponse, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import config_validation as cv

from ..const import (
    DOMAIN,
    SERVICE_DEMO_AB_START,
    SERVICE_DEMO_CAPTURE,
    SERVICE_DEMO_PLAY_CLIP,
    SERVICE_DEMO_PLAY_PLAYLIST,
    SERVICE_DEMO_REPLAY,
    SERVICE_DEMO_SKIP,
    SERVICE_DEMO_STOP,
)
from ..devices.zidoo import ZidooDriver
from .model import Clip, format_timecode, new_id, parse_timecode

if TYPE_CHECKING:
    from ..coordinator import KinoCoordinator


def _coordinators(hass: HomeAssistant) -> list[Any]:
    return [runtime.coordinator for runtime in hass.data.get(DOMAIN, {}).values()]


def _zidoo_of(coordinator: KinoCoordinator) -> ZidooDriver | None:
    """Return the media device of the running activity, if it has one."""
    snapshot = coordinator.engine.snapshot()
    activity = coordinator.config.activities.get(snapshot.activity)
    if activity is None:
        return None
    for key in activity.devices:
        if not activity.requires(key):
            continue
        driver = coordinator.engine.drivers.get(key)
        if isinstance(driver, ZidooDriver):
            return driver
    return None


async def _capture(hass: HomeAssistant, call: ServiceCall) -> dict[str, Any]:
    """Turn "that was demo-worthy" into a stored clip (spec §3).

    Without an explicit span this is the retro capture: by the time a scene
    reveals itself as demo material it is already over, so the clip ends at
    the current position and reaches back the configured window.
    """
    for coordinator in _coordinators(hass):
        settings = coordinator.demo_store.settings
        driver = _zidoo_of(coordinator)
        position = (driver.now_playing().get("position") if driver else None)
        if position is None and not call.data.get("end"):
            raise HomeAssistantError(
                "Es läuft nichts, dessen Position übernommen werden könnte."
            )

        end_ms = parse_timecode(call.data.get("end"))
        if end_ms is None:
            end_ms = int(float(position) * 1000)
        start_raw = call.data.get("start")
        start_ms = (
            parse_timecode(start_raw)
            if start_raw is not None
            else max(0, end_ms - settings.retro_capture_seconds * 1000)
        )
        if start_ms is None or end_ms <= start_ms:
            raise HomeAssistantError("Start und Ende ergeben keinen Clip.")

        item = coordinator.playing_item or {}
        clip = Clip(
            id=new_id("c"),
            item_id=item.get("id"),
            path=call.data.get("path"),
            title=str(item.get("title") or ""),
            start_ms=start_ms,
            end_ms=end_ms,
            name=call.data.get("name") or "",
            tags=tuple(call.data.get("tags") or ()),
            notes=call.data.get("notes") or "",
            audio_track=driver.value_of("audio_select") if driver else None,
            subtitle_track=driver.value_of("subtitle_select") if driver else None,
            capture_meta=_capture_meta(coordinator, driver),
        )
        if not clip.name:
            clip = replace(clip, name=clip.default_name())
        saved = await coordinator.demo_store.async_put_clip(clip)
        coordinator.async_update_listeners()
        return {
            "clip_id": saved.id,
            "name": saved.name,
            "start": format_timecode(saved.start_ms),
            "end": format_timecode(saved.end_ms),
        }
    return {}


def _capture_meta(
    coordinator: KinoCoordinator, driver: ZidooDriver | None
) -> dict[str, Any]:
    """Record what the room was doing when the clip was grabbed (§2.1)."""
    now = driver.now_playing() if driver else {}
    volume = coordinator.config.volume_device
    volume_driver = (
        coordinator.engine.drivers.get(volume) if volume else None
    )
    return {
        "audio_format": now.get("audio_format"),
        "video_format": now.get("video_format"),
        "activity": coordinator.engine.snapshot().activity,
        "preset": (
            volume_driver.value_of("preset") if volume_driver is not None else None
        ),
        "volume": (
            volume_driver.volume_db()
            if volume_driver is not None and hasattr(volume_driver, "volume_db")
            else None
        ),
    }


@callback
def register_demo_services(hass: HomeAssistant) -> None:  # noqa: C901
    """Register every `kino.demo_*` service once."""

    async def capture(call: ServiceCall) -> dict[str, Any]:
        return await _capture(hass, call)

    async def play_clip(call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            clip = coordinator.demo_store.clip(call.data["clip_id"])
            if clip is None:
                raise HomeAssistantError(f"Unbekannter Clip: {call.data['clip_id']}")
            await coordinator.demo.start_clip(clip)

    async def play_playlist(call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            store = coordinator.demo_store
            showcase = store.showcase(call.data["showcase_id"])
            if showcase is None:
                raise HomeAssistantError(
                    f"Unbekannter Showcase: {call.data['showcase_id']}"
                )
            clips = store.resolve(showcase.clip_ids)
            if not clips:
                raise HomeAssistantError("Der Showcase enthält keine Clips.")
            await coordinator.demo.start_showcase(showcase, clips)

    async def skip(_call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            coordinator.demo.control("skip")

    async def replay_clip(_call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            coordinator.demo.control("replay")

    async def stop(_call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            await coordinator.demo.stop()

    async def ab_start(call: ServiceCall) -> None:
        for coordinator in _coordinators(hass):
            clip = coordinator.demo_store.clip(call.data["clip_id"])
            if clip is None:
                raise HomeAssistantError(f"Unbekannter Clip: {call.data['clip_id']}")
            await coordinator.demo.start_ab(
                clip,
                call.data.get("a") or {},
                call.data.get("b") or {},
                call.data.get("blind", True),
            )

    hass.services.async_register(
        DOMAIN,
        SERVICE_DEMO_CAPTURE,
        capture,
        schema=vol.Schema(
            {
                vol.Optional("start"): cv.string,
                vol.Optional("end"): cv.string,
                vol.Optional("name"): cv.string,
                vol.Optional("notes"): cv.string,
                vol.Optional("path"): cv.string,
                vol.Optional("tags"): vol.All(cv.ensure_list, [cv.string]),
            }
        ),
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_DEMO_PLAY_CLIP,
        play_clip,
        schema=vol.Schema({vol.Required("clip_id"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_DEMO_PLAY_PLAYLIST,
        play_playlist,
        schema=vol.Schema({vol.Required("showcase_id"): cv.string}),
    )
    hass.services.async_register(DOMAIN, SERVICE_DEMO_SKIP, skip)
    hass.services.async_register(DOMAIN, SERVICE_DEMO_REPLAY, replay_clip)
    hass.services.async_register(DOMAIN, SERVICE_DEMO_STOP, stop)
    hass.services.async_register(
        DOMAIN,
        SERVICE_DEMO_AB_START,
        ab_start,
        schema=vol.Schema(
            {
                vol.Required("clip_id"): cv.string,
                vol.Optional("a"): dict,
                vol.Optional("b"): dict,
                vol.Optional("blind", default=True): cv.boolean,
            }
        ),
    )
