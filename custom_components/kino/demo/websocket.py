"""
WebSocket commands behind the card's Demos tab.

Reachable by any signed-in user, like the library commands: capturing and
replaying a reference clip is a household action, not an admin one. The two
that reshape the install — settings and import/export — are admin-only.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.util import dt as dt_util

from ..const import DOMAIN
from .model import VOCABULARY, Clip, DemoSettings, Showcase
from .runtime import HassDemoRuntime


@callback
def register_demo_commands(hass: HomeAssistant) -> None:
    for command in (
        ws_demo_data,
        ws_demo_clip_save,
        ws_demo_clip_delete,
        ws_demo_showcase_save,
        ws_demo_showcase_delete,
        ws_demo_play,
        ws_demo_control,
        ws_demo_ab_start,
        ws_demo_preview,
        ws_demo_settings,
        ws_demo_transfer,
    ):
        websocket_api.async_register_command(hass, command)


def _coordinator(hass: HomeAssistant) -> Any:
    for runtime in hass.data.get(DOMAIN, {}).values():
        return runtime.coordinator
    return None


def _require(hass, connection, msg) -> Any:
    coordinator = _coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return None
    return coordinator


def _options(coordinator: Any) -> dict[str, Any]:
    """Return what the A/B sheet may offer, read from the live devices.

    The card must not show a preset the processor would reject, so the lists
    come from the entities themselves. The Envy addresses profiles by slot
    number it cannot enumerate, and the projector's profile is a shadow value,
    so those two are described by kind rather than by list.
    """
    presets: list[str] = []
    barco_profiles: list[str] = []
    for key, driver in coordinator.engine.drivers.items():
        spec = coordinator.config.devices.get(key)
        if spec is None:
            continue
        if spec.driver == "trinnov" or key == coordinator.config.volume_device:
            presets = driver.options_of("preset") or presets
        if spec.driver == "barco":
            barco_profiles = driver.options_of("profile") or barco_profiles
    return {
        "presets": presets,
        "barcoProfiles": barco_profiles,
        "madvrProfileKind": "number",
    }


def _payload(coordinator: Any) -> dict[str, Any]:
    store = coordinator.demo_store
    return {
        "clips": [clip.as_dict() for clip in store.clips],
        "showcases": [showcase.as_dict() for showcase in store.showcases],
        "vocabulary": [{"key": key, "label": label} for key, label in VOCABULARY],
        "settings": store.settings.as_dict(),
        "options": _options(coordinator),
        "running": coordinator.demo.state(),
    }


@websocket_api.websocket_command({vol.Required("type"): "kino/demo/data"})
@websocket_api.async_response
async def ws_demo_data(hass, connection, msg) -> None:
    """Return the whole dataset: clips, showcases, vocabulary and settings."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    connection.send_result(msg["id"], _payload(coordinator))


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/demo/clip/save", vol.Required("clip"): dict}
)
@websocket_api.async_response
async def ws_demo_clip_save(hass, connection, msg) -> None:
    """Create or update one clip."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    try:
        clip = Clip.from_dict(msg["clip"])
    except (TypeError, ValueError) as err:
        connection.send_error(msg["id"], "bad_clip", str(err))
        return
    if clip.end_ms <= clip.start_ms:
        connection.send_error(
            msg["id"], "bad_clip", "Das Ende muss nach dem Start liegen."
        )
        return
    if not clip.created_at:
        clip = replace(clip, created_at=dt_util.utcnow().isoformat())
    saved = await coordinator.demo_store.async_put_clip(clip)
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"clip": saved.as_dict()})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/demo/clip/delete", vol.Required("clip_id"): str}
)
@websocket_api.async_response
async def ws_demo_clip_delete(hass, connection, msg) -> None:
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    deleted = await coordinator.demo_store.async_delete_clip(msg["clip_id"])
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"deleted": deleted})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/demo/showcase/save", vol.Required("showcase"): dict}
)
@websocket_api.async_response
async def ws_demo_showcase_save(hass, connection, msg) -> None:
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    try:
        showcase = Showcase.from_dict(msg["showcase"])
    except (TypeError, ValueError) as err:
        connection.send_error(msg["id"], "bad_showcase", str(err))
        return
    if not showcase.name:
        connection.send_error(
            msg["id"], "bad_showcase", "Der Showcase braucht einen Namen."
        )
        return
    saved = await coordinator.demo_store.async_put_showcase(showcase)
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"showcase": saved.as_dict()})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/showcase/delete",
        vol.Required("showcase_id"): str,
    }
)
@websocket_api.async_response
async def ws_demo_showcase_delete(hass, connection, msg) -> None:
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    deleted = await coordinator.demo_store.async_delete_showcase(msg["showcase_id"])
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"deleted": deleted})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/play",
        vol.Optional("clip_id"): vol.Any(str, None),
        vol.Optional("showcase_id"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_demo_play(hass, connection, msg) -> None:
    """Start one clip or one showcase.

    The engine requests the library activity itself, so this returns as soon
    as the demo is armed. A cold start takes minutes, and the card follows the
    room's own progress meanwhile — exactly as it does for a title.
    """
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    store = coordinator.demo_store
    try:
        if msg.get("showcase_id"):
            showcase = store.showcase(msg["showcase_id"])
            if showcase is None:
                connection.send_error(
                    msg["id"], "unknown_showcase", "Showcase nicht gefunden."
                )
                return
            clips = store.resolve(showcase.clip_ids)
            if not clips:
                connection.send_error(
                    msg["id"], "empty_showcase", "Der Showcase enthält keine Clips."
                )
                return
            await coordinator.demo.start_showcase(showcase, clips)
        elif msg.get("clip_id"):
            clip = store.clip(msg["clip_id"])
            if clip is None:
                connection.send_error(
                    msg["id"], "unknown_clip", "Clip nicht gefunden."
                )
                return
            await coordinator.demo.start_clip(clip)
        else:
            connection.send_error(
                msg["id"], "bad_request", "Weder Clip noch Showcase angegeben."
            )
            return
    except (ValueError, RuntimeError) as err:
        connection.send_error(msg["id"], "demo_error", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/control",
        vol.Required("action"): vol.In(
            [
                "pause",
                "resume",
                "skip",
                "replay",
                "next",
                "stop",
                "jump",
                "pick",
                "replay-side",
            ]
        ),
        vol.Optional("index"): vol.Any(int, None),
    }
)
@websocket_api.async_response
async def ws_demo_control(hass, connection, msg) -> None:
    """Skip, replay, pause, jump, stop — and the A/B verdict (spec §4.3)."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    if msg["action"] == "stop":
        await coordinator.demo.stop()
    else:
        coordinator.demo.control(msg["action"], msg.get("index"))
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/ab_start",
        vol.Required("clip_id"): str,
        vol.Optional("a", default={}): dict,
        vol.Optional("b", default={}): dict,
        vol.Optional("blind", default=True): bool,
    }
)
@websocket_api.async_response
async def ws_demo_ab_start(hass, connection, msg) -> None:
    """Play one clip twice, switching configuration in the gap (spec §5)."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    clip = coordinator.demo_store.clip(msg["clip_id"])
    if clip is None:
        connection.send_error(msg["id"], "unknown_clip", "Clip nicht gefunden.")
        return
    try:
        await coordinator.demo.start_ab(clip, msg["a"], msg["b"], msg["blind"])
    except (ValueError, RuntimeError) as err:
        connection.send_error(msg["id"], "demo_error", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/preview",
        vol.Required("item_id"): str,
        vol.Required("position_ms"): int,
        vol.Optional("path"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_demo_preview(hass, connection, msg) -> None:
    """Seek across a cut so it can be checked without scrubbing (spec §3).

    The file is opened first when it is not the one already playing, so the
    trim editor works whether it was reached from the player or from the clip
    list.
    """
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    runtime = HassDemoRuntime(hass, coordinator)
    probe = Clip(id="preview", item_id=msg["item_id"], path=msg.get("path"))
    seconds = max(0.0, msg["position_ms"] / 1000)
    try:
        if runtime.has_file_open(probe):
            await runtime.resume()
        else:
            await runtime.ensure_activity()
            await runtime.play_clip(probe)
            if not await runtime.wait_for_playing(30.0):
                connection.send_error(
                    msg["id"], "not_playing", "Der Player hat die Datei nicht geöffnet."
                )
                return
        await runtime.seek(seconds)
    except (RuntimeError, ValueError) as err:
        connection.send_error(msg["id"], "preview_failed", str(err))
        return
    connection.send_result(msg["id"], {"ok": True, "position": seconds})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/demo/settings", vol.Required("settings"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_demo_settings(hass, connection, msg) -> None:
    """Lead-in, retro-capture window and the optional flags (admin only)."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    settings = DemoSettings.from_dict(msg["settings"])
    await coordinator.demo_store.async_set_settings(settings)
    coordinator.demo.update_settings(settings)
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"settings": settings.as_dict()})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/demo/transfer",
        vol.Required("action"): vol.In(["export", "import"]),
        vol.Optional("document"): vol.Any(dict, None),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_demo_transfer(hass, connection, msg) -> None:
    """JSON dump and restore of the dataset, for personal backup (spec §8)."""
    coordinator = _require(hass, connection, msg)
    if coordinator is None:
        return
    store = coordinator.demo_store
    if msg["action"] == "export":
        connection.send_result(msg["id"], {"document": store.as_document()})
        return
    document = msg.get("document")
    if not isinstance(document, dict):
        connection.send_error(msg["id"], "bad_document", "Kein gültiges Dokument.")
        return
    await store.async_import(document)
    coordinator.demo.update_settings(store.settings)
    coordinator.async_update_listeners()
    connection.send_result(msg["id"], {"imported": True})
