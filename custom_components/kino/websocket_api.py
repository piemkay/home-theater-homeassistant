"""
WebSocket commands backing the custom card (and later the admin panel).

The card never talks to Jellyfin directly — it asks Home Assistant, which
holds the credentials. That keeps FR-42a honest and means the card works
unchanged whether Jellyfin is reachable from the browser or not.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .media.base import (
    Category,
    MediaBackendError,
    MediaQuery,
    SortOrder,
)

_LOGGER = logging.getLogger(__name__)


def _runtimes(hass: HomeAssistant) -> list[Any]:
    return list(hass.data.get(DOMAIN, {}).values())


def _first_media(hass: HomeAssistant) -> Any:
    for runtime in _runtimes(hass):
        if runtime.media is not None:
            return runtime.media
    return None


def _first_coordinator(hass: HomeAssistant) -> Any:
    for runtime in _runtimes(hass):
        return runtime.coordinator
    return None


@callback
def async_register_websocket_api(hass: HomeAssistant) -> None:
    if hass.data.setdefault(f"{DOMAIN}_ws", False):
        return
    hass.data[f"{DOMAIN}_ws"] = True
    websocket_api.async_register_command(hass, ws_search)
    websocket_api.async_register_command(hass, ws_item)
    websocket_api.async_register_command(hass, ws_resume)
    websocket_api.async_register_command(hass, ws_facets)
    websocket_api.async_register_command(hass, ws_refresh)
    websocket_api.async_register_command(hass, ws_state)
    websocket_api.async_register_command(hass, ws_activate)
    websocket_api.async_register_command(hass, ws_dry_run)
    websocket_api.async_register_command(hass, ws_restore_device)
    websocket_api.async_register_command(hass, ws_dismiss_drift)
    websocket_api.async_register_command(hass, ws_transition_log)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/library/search",
        vol.Optional("category", default="movies"): str,
        vol.Optional("search"): vol.Any(str, None),
        vol.Optional("genres", default=[]): [str],
        vol.Optional("countries", default=[]): [str],
        vol.Optional("year_from"): vol.Any(int, None),
        vol.Optional("year_to"): vol.Any(int, None),
        vol.Optional("only_4k", default=False): bool,
        vol.Optional("only_hd", default=False): bool,
        vol.Optional("only_unwatched", default=False): bool,
        vol.Optional("only_resumable", default=False): bool,
        vol.Optional("sort", default="added"): str,
        vol.Optional("limit", default=60): vol.All(int, vol.Range(1, 200)),
        vol.Optional("offset", default=0): vol.All(int, vol.Range(min=0)),
    }
)
@websocket_api.async_response
async def ws_search(hass, connection, msg) -> None:
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        query = MediaQuery(
            category=Category(msg["category"]),
            search=msg.get("search") or None,
            genres=tuple(msg["genres"]),
            countries=tuple(msg["countries"]),
            year_from=msg.get("year_from"),
            year_to=msg.get("year_to"),
            only_4k=msg["only_4k"],
            only_hd=msg["only_hd"],
            only_unwatched=msg["only_unwatched"],
            only_resumable=msg["only_resumable"],
            sort=SortOrder(msg["sort"]),
            limit=msg["limit"],
            offset=msg["offset"],
        )
    except ValueError as err:
        connection.send_error(msg["id"], "bad_query", str(err))
        return

    try:
        page = await media.search(query)
    except MediaBackendError as err:
        # Never a blank grid: the card gets a message it can show (FR-45).
        connection.send_error(msg["id"], "library_error", str(err))
        return

    connection.send_result(
        msg["id"],
        {
            "items": [item.as_dict() for item in page.items],
            "total": page.total,
            "offset": page.offset,
            "hasMore": page.has_more,
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/library/item", vol.Required("item_id"): str}
)
@websocket_api.async_response
async def ws_item(hass, connection, msg) -> None:
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        item = await media.item(msg["item_id"])
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], item.as_dict() if item else None)


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/library/resume",
        vol.Optional("limit", default=12): vol.All(int, vol.Range(1, 50)),
    }
)
@websocket_api.async_response
async def ws_resume(hass, connection, msg) -> None:
    media = _first_media(hass)
    if media is None:
        connection.send_result(msg["id"], {"items": []})
        return
    try:
        items = await media.resume(msg["limit"])
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"items": [item.as_dict() for item in items]})


@websocket_api.websocket_command({vol.Required("type"): "kino/library/facets"})
@websocket_api.async_response
async def ws_facets(hass, connection, msg) -> None:
    media = _first_media(hass)
    if media is None:
        connection.send_result(msg["id"], {"genres": [], "countries": []})
        return
    try:
        facets = await media.facets()
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "genres": list(facets.genres),
            "countries": list(facets.countries),
            "yearMin": facets.year_min,
            "yearMax": facets.year_max,
        },
    )


@websocket_api.websocket_command({vol.Required("type"): "kino/library/refresh"})
@websocket_api.async_response
async def ws_refresh(hass, connection, msg) -> None:
    """FR-44/FR-75a: the second user's retry after a NAS spin-up."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        await media.refresh()
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "kino/state"})
@websocket_api.async_response
async def ws_state(hass, connection, msg) -> None:
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    connection.send_result(msg["id"], _state_payload(coordinator))


def _state_payload(coordinator) -> dict[str, Any]:
    snapshot = coordinator.engine.snapshot()
    config = coordinator.config
    progress = snapshot.progress
    return {
        "state": snapshot.state.value,
        "activity": snapshot.activity,
        "targetActivity": snapshot.target_activity,
        "statusText": snapshot.status_text(),
        "degraded": snapshot.degraded,
        "activities": [
            {
                "key": key,
                "name": activity.name,
                "icon": activity.icon,
                "controlClass": activity.control_class.value,
                "media": activity.media,
                "handoffText": activity.handoff_text,
                "devices": sorted(d for d in activity.devices if activity.requires(d)),
            }
            for key, activity in config.activities.items()
        ],
        "devices": [
            {
                "key": key,
                "name": spec.name,
                "health": (
                    health.value
                    if (health := snapshot.device_health.get(key)) is not None
                    else "unknown"
                ),
            }
            for key, spec in config.devices.items()
        ],
        "drift": [
            {
                "device": f.device,
                "classification": f.classification.value,
                "detail": f.detail,
                "restorable": f.restorable,
            }
            for f in snapshot.drift
        ],
        "progress": None
        if progress is None
        else {
            "percent": progress.percent,
            "etaSeconds": round(progress.eta_seconds),
            "bottleneck": progress.bottleneck,
            "bottleneckDevice": progress.bottleneck_device,
        },
        "volume": {
            "device": config.volume_device,
            "minDb": config.volume_min_db,
            "maxDb": config.volume_max_db,
            "stepDb": config.volume_step_db,
        },
        "offActivity": config.off_activity,
    }


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/activate", vol.Required("activity"): str}
)
@websocket_api.async_response
async def ws_activate(hass, connection, msg) -> None:
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    try:
        await coordinator.async_activate(msg["activity"])
    except KeyError as err:
        connection.send_error(msg["id"], "unknown_activity", str(err))
        return
    await coordinator.async_apply_light_scene(msg["activity"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/dry_run", vol.Required("activity"): str}
)
@websocket_api.async_response
async def ws_dry_run(hass, connection, msg) -> None:
    """FR-121: show the delta without executing it."""
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    try:
        plan = await coordinator.engine.dry_run(msg["activity"])
    except KeyError as err:
        connection.send_error(msg["id"], "unknown_activity", str(err))
        return
    connection.send_result(
        msg["id"],
        {
            "summary": plan.describe(),
            "actions": [
                {
                    "device": a.device,
                    "kind": a.kind.value,
                    "settings": dict(a.settings),
                    "reason": a.reason,
                }
                for a in plan.actions
            ],
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/restore_device", vol.Required("device"): str}
)
@websocket_api.async_response
async def ws_restore_device(hass, connection, msg) -> None:
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    try:
        await coordinator.engine.restore_device(msg["device"])
    except (KeyError, ValueError) as err:
        connection.send_error(msg["id"], "unknown_device", str(err))
        return
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/dismiss_drift", vol.Required("device"): str}
)
@websocket_api.async_response
async def ws_dismiss_drift(hass, connection, msg) -> None:
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    coordinator.engine.dismiss_drift(msg["device"])
    connection.send_result(msg["id"], {"ok": True})


@websocket_api.websocket_command({vol.Required("type"): "kino/transition_log"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_transition_log(hass, connection, msg) -> None:
    """FR-122/FR-123: diagnostics, admin only."""
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    connection.send_result(
        msg["id"],
        {
            "transitions": coordinator.engine.transition_log,
            "durations": coordinator.estimator.report(),
        },
    )
