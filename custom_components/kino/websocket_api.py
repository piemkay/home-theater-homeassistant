"""
WebSocket commands backing the custom card and the admin panel (FR-102).

The card never talks to Jellyfin directly — it asks Home Assistant, which
holds the credentials. That keeps FR-42a honest and means the card works
unchanged whether Jellyfin is reachable from the browser or not.

Panel commands are all `require_admin`: the second user never sees the panel
and cannot reach its commands either (FR-101).
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

import voluptuous as vol
from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .config_store import ConfigNotFoundError, ConfigStore
from .const import DOMAIN
from .core.model import ControlClass
from .core.schema import KNOWN_DRIVERS, ConfigErrors, validate
from .devices.zidoo import ZidooDriver
from .http import async_get_signer
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
    websocket_api.async_register_command(hass, ws_similar)
    websocket_api.async_register_command(hass, ws_seasons)
    websocket_api.async_register_command(hass, ws_episodes)
    websocket_api.async_register_command(hass, ws_resume)
    websocket_api.async_register_command(hass, ws_facets)
    websocket_api.async_register_command(hass, ws_facet_counts)
    websocket_api.async_register_command(hass, ws_favorite)
    websocket_api.async_register_command(hass, ws_refresh)
    websocket_api.async_register_command(hass, ws_state)
    websocket_api.async_register_command(hass, ws_activate)
    websocket_api.async_register_command(hass, ws_dry_run)
    websocket_api.async_register_command(hass, ws_restore_device)
    websocket_api.async_register_command(hass, ws_dismiss_drift)
    websocket_api.async_register_command(hass, ws_transition_log)
    websocket_api.async_register_command(hass, ws_config_get)
    websocket_api.async_register_command(hass, ws_config_save)
    websocket_api.async_register_command(hass, ws_config_validate)
    websocket_api.async_register_command(hass, ws_device_board)
    websocket_api.async_register_command(hass, ws_device_test)
    websocket_api.async_register_command(hass, ws_durations_reset)


#: One schema for everything that speaks in filters — search and the
#: facet-count preview take exactly the same query.
_QUERY_SCHEMA = {
    vol.Optional("category", default="movies"): str,
    vol.Optional("search"): vol.Any(str, None),
    vol.Optional("genres", default=[]): [str],
    vol.Optional("countries", default=[]): [str],
    vol.Optional("person_ids", default=[]): [str],
    vol.Optional("audio_langs", default=[]): [str],
    vol.Optional("year_from"): vol.Any(int, None),
    vol.Optional("year_to"): vol.Any(int, None),
    vol.Optional("only_4k", default=False): bool,
    vol.Optional("only_hd", default=False): bool,
    vol.Optional("only_sd", default=False): bool,
    vol.Optional("only_3d", default=False): bool,
    vol.Optional("only_unwatched", default=False): bool,
    vol.Optional("only_watched", default=False): bool,
    vol.Optional("only_resumable", default=False): bool,
    vol.Optional("only_favorites", default=False): bool,
    vol.Optional("ratings", default=[]): [str],
    vol.Optional("min_rating"): vol.Any(vol.Coerce(float), None),
    vol.Optional("min_critic"): vol.Any(vol.Coerce(float), None),
    vol.Optional("sort", default="added"): str,
    vol.Optional("sort_dir"): vol.Any(vol.In(["asc", "desc"]), None),
    vol.Optional("limit", default=60): vol.All(int, vol.Range(1, 200)),
    vol.Optional("offset", default=0): vol.All(int, vol.Range(min=0)),
}


def _query_from_msg(msg: Mapping[str, Any]) -> MediaQuery:
    """Translate one validated message into a :class:`MediaQuery`."""
    return MediaQuery(
        category=Category(msg["category"]),
        search=msg.get("search") or None,
        genres=tuple(msg["genres"]),
        countries=tuple(msg["countries"]),
        person_ids=tuple(msg["person_ids"]),
        audio_langs=tuple(msg["audio_langs"]),
        year_from=msg.get("year_from"),
        year_to=msg.get("year_to"),
        only_4k=msg["only_4k"],
        only_hd=msg["only_hd"],
        only_sd=msg["only_sd"],
        only_3d=msg["only_3d"],
        only_unwatched=msg["only_unwatched"],
        only_watched=msg["only_watched"],
        only_resumable=msg["only_resumable"],
        only_favorites=msg["only_favorites"],
        ratings=tuple(msg["ratings"]),
        min_rating=msg.get("min_rating"),
        min_critic=msg.get("min_critic"),
        sort=SortOrder(msg["sort"]),
        sort_dir=msg.get("sort_dir"),
        limit=msg["limit"],
        offset=msg["offset"],
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/library/search", **_QUERY_SCHEMA}
)
@websocket_api.async_response
async def ws_search(hass, connection, msg) -> None:
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        query = _query_from_msg(msg)
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
    {vol.Required("type"): "kino/library/facet_counts", **_QUERY_SCHEMA}
)
@websocket_api.async_response
async def ws_facet_counts(hass, connection, msg) -> None:
    """Per filter value: the result count after tapping that chip."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        query = _query_from_msg(msg)
    except ValueError as err:
        connection.send_error(msg["id"], "bad_query", str(err))
        return
    try:
        counts = await media.facet_counts(query)
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], counts)


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
        vol.Required("type"): "kino/library/similar",
        vol.Required("item_id"): str,
        vol.Optional("limit", default=12): vol.All(int, vol.Range(1, 50)),
    }
)
@websocket_api.async_response
async def ws_similar(hass, connection, msg) -> None:
    """Serve the detail sheet's "Mehr wie dieser Titel" row."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        items = await media.similar(msg["item_id"], msg["limit"])
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"items": [item.as_dict() for item in items]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/library/seasons",
        vol.Required("series_id"): str,
    }
)
@websocket_api.async_response
async def ws_seasons(hass, connection, msg) -> None:
    """Return the season strip of the series drill-down (F2)."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        items = await media.seasons(msg["series_id"])
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"items": [item.as_dict() for item in items]})


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/library/episodes",
        vol.Required("series_id"): str,
        vol.Optional("season_id"): vol.Any(str, None),
    }
)
@websocket_api.async_response
async def ws_episodes(hass, connection, msg) -> None:
    """Return the episode list of one season (F2)."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        items = await media.episodes(msg["series_id"], msg.get("season_id"))
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"items": [item.as_dict() for item in items]})


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
            "ratings": list(facets.ratings),
            "audioLanguages": list(facets.audio_languages),
            "yearMin": facets.year_min,
            "yearMax": facets.year_max,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/library/favorite",
        vol.Required("item_id"): str,
        vol.Required("favorite"): bool,
    }
)
@websocket_api.async_response
async def ws_favorite(hass, connection, msg) -> None:
    """Write a favourite back to the catalogue — a household action, like play."""
    media = _first_media(hass)
    if media is None:
        connection.send_error(msg["id"], "no_media", "Keine Bibliothek verbunden.")
        return
    try:
        await media.set_favorite(msg["item_id"], msg["favorite"])
    except MediaBackendError as err:
        connection.send_error(msg["id"], "library_error", str(err))
        return
    connection.send_result(msg["id"], {"ok": True, "favorite": msg["favorite"]})


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
    connection.send_result(msg["id"], _state_payload(hass, coordinator))


def _own_entities(hass: HomeAssistant, coordinator) -> dict[str, str]:
    """Resolve Kino's own entity IDs, by unique ID rather than by guessing.

    The card needs to call services on the player and read the volume, and
    "the media_player whose entity_id contains kino" is not that entity — in
    this house it matched a media-player *group*, whose `volume_down` walked
    into its own members and failed. The registry knows exactly which entity
    this integration created, so the card is told rather than left to guess.
    """
    registry = er.async_get(hass)
    entry_id = coordinator.entry.entry_id
    wanted: dict[str, tuple[str, str]] = {
        "player": ("media_player", "player"),
        "volume": ("number", "volume"),
        "activity": ("select", "activity"),
        "status": ("sensor", "status"),
        "progress": ("sensor", "progress"),
    }
    for key, driver in coordinator.engine.drivers.items():
        if isinstance(driver, ZidooDriver):
            wanted["audioTrack"] = ("select", f"{key}_audio")
            wanted["subtitleTrack"] = ("select", f"{key}_subtitle")
            break

    resolved: dict[str, str] = {}
    for name, (domain, suffix) in wanted.items():
        entity_id = registry.async_get_entity_id(domain, DOMAIN, f"{entry_id}_{suffix}")
        if entity_id:
            resolved[name] = entity_id
    return resolved


def _sound_controls(coordinator) -> dict[str, str]:
    """Entities the playback view drives directly (preset, upmixer, dim).

    They belong to the processor, not to Kino, so the card is told which ones
    they are instead of pattern-matching entity IDs. `dim` is the Trinnov's
    own -20 dB switch — an audio feature, nothing to do with the lights.
    """
    key = coordinator.config.volume_device
    driver = coordinator.engine.drivers.get(key) if key else None
    entities = dict(driver.spec.entities) if driver else {}
    return {
        role: entities[role]
        for role in ("preset", "upmixer", "dim")
        if entities.get(role)
    }


def _state_payload(hass: HomeAssistant, coordinator) -> dict[str, Any]:
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
            # Every device the plan touches — stops included — so the card
            # chips the whole union, not just the target's devices (F6).
            "devices": [key for key in config.devices if key in progress.device_health],
        },
        "volume": {
            "device": config.volume_device,
            "minDb": config.volume_min_db,
            "maxDb": config.volume_max_db,
            "stepDb": config.volume_step_db,
        },
        "offActivity": config.off_activity,
        "entities": _own_entities(hass, coordinator),
        "controls": _sound_controls(coordinator),
        # The catalogue entry behind the open file, so the playback view can
        # ask for a 16:9 backdrop rather than crop a portrait poster.
        "nowPlaying": coordinator.playing_item,
        # The title queued to play once the room is ready (F5).
        "pendingItem": coordinator.pending_item,
        # One signature covers every poster until it expires, so the browser
        # can cache images by URL (see http.py).
        "artworkSignature": async_get_signer(hass).signature(),
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


# --------------------------------------------------------------------------
# Admin panel (FR-110 .. FR-134)
# --------------------------------------------------------------------------


def _errors_payload(err: ConfigErrors) -> list[dict[str, str]]:
    """Turn validation failures into something the editor can anchor on."""
    return [{"path": e.path, "message": e.message} for e in err.errors]


def _driver_catalogue(coordinator: Any) -> dict[str, Any]:
    """Per configured device: which settings it accepts, and their values.

    This is what makes FR-112 possible — every dropdown in the matrix editor
    is populated from the live device, never from free text.
    """
    if coordinator is None:
        return {}
    catalogue: dict[str, Any] = {}
    for key, driver in coordinator.engine.drivers.items():
        spec = coordinator.config.devices.get(key)
        catalogue[key] = {
            "driver": spec.driver if spec else None,
            "name": spec.name if spec else key,
            "settings": driver.setting_options(),
            "missingEntities": driver.missing_entities(),
            # Which roles this driver understands and what kind of entity may
            # fill each of them, so the panel offers a filtered picker rather
            # than a free-text field (FR-130).
            "roles": driver.role_catalogue(),
        }
    return catalogue


_EDITABLE_DOMAINS = (
    "switch",
    "remote",
    "select",
    "input_select",
    "sensor",
    "binary_sensor",
    "media_player",
    "button",
    "number",
    "scene",
)


def _entity_catalogue(hass: HomeAssistant) -> dict[str, list[dict[str, str]]]:
    """Entities the editor offers when wiring a device up (FR-130).

    Friendly names travel with the IDs: picking `switch.hodr_cs_power` out of
    a list of a few hundred switches is a very different job when the list
    reads "Hodr CS Power" as well.
    """
    catalogue: dict[str, list[dict[str, str]]] = {
        domain: [] for domain in _EDITABLE_DOMAINS
    }
    for state in hass.states.async_all(_EDITABLE_DOMAINS):
        catalogue[state.domain].append(
            {
                "id": state.entity_id,
                "name": str(state.attributes.get("friendly_name") or state.entity_id),
            }
        )
    return {
        domain: sorted(entries, key=lambda entry: entry["name"].lower())
        for domain, entries in catalogue.items()
    }


@websocket_api.websocket_command({vol.Required("type"): "kino/config/get"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_config_get(hass, connection, msg) -> None:
    """Return the raw config document plus what the editor needs around it.

    The *document* is returned rather than the validated objects, so a file
    that currently fails validation can still be opened and fixed (FR-110).
    """
    store = ConfigStore(hass)
    try:
        document = await store.async_read_raw()
    except ConfigNotFoundError:
        document = None
    except ConfigErrors as err:
        connection.send_error(msg["id"], "unreadable_config", str(err))
        return

    errors: list[dict[str, str]] = []
    if document is not None:
        try:
            validate(document)
        except ConfigErrors as err:
            errors = _errors_payload(err)

    coordinator = _first_coordinator(hass)
    connection.send_result(
        msg["id"],
        {
            "document": document,
            "path": str(store.path),
            "errors": errors,
            "drivers": _driver_catalogue(coordinator),
            "entities": _entity_catalogue(hass),
            "knownDrivers": sorted(KNOWN_DRIVERS),
            "controlClasses": [c.value for c in ControlClass],
        },
    )


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/config/validate", vol.Required("document"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_config_validate(hass, connection, msg) -> None:
    """Validate without saving, so the editor can flag errors before you commit."""
    try:
        validate(msg["document"])
    except ConfigErrors as err:
        connection.send_result(
            msg["id"], {"valid": False, "errors": _errors_payload(err)}
        )
        return
    connection.send_result(msg["id"], {"valid": True, "errors": []})


@websocket_api.websocket_command(
    {vol.Required("type"): "kino/config/save", vol.Required("document"): dict}
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_config_save(hass, connection, msg) -> None:
    """Validate, write and apply — without a Home Assistant restart (FR-115)."""
    store = ConfigStore(hass)
    try:
        await store.async_save(msg["document"])
    except ConfigErrors as err:
        # Nothing was written, so the running configuration is untouched.
        connection.send_result(
            msg["id"], {"saved": False, "errors": _errors_payload(err)}
        )
        return
    except OSError as err:
        connection.send_error(msg["id"], "write_failed", str(err))
        return

    # A real entry reload, not an engine hot-swap: entities are built from
    # the config (per-device sensors, track selects, volume bounds), so this
    # is what makes an added device appear and a removed one go away. It also
    # cancels any transition the old engine still had in flight.
    for entry_id in list(hass.data.get(DOMAIN, {})):
        await hass.config_entries.async_reload(entry_id)

    connection.send_result(msg["id"], {"saved": True, "errors": []})


@websocket_api.websocket_command({vol.Required("type"): "kino/device_board"})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_device_board(hass, connection, msg) -> None:
    """Observed against expected, per device, live (FR-120)."""
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return

    snapshot = coordinator.engine.snapshot()
    observations = await coordinator.engine.observe_all()
    activity = coordinator.config.activities.get(snapshot.activity)

    rows = []
    for key, spec in coordinator.config.devices.items():
        observation = observations.get(key)
        driver = coordinator.engine.drivers.get(key)
        requirement = activity.devices.get(key) if activity else None
        finding = next((f for f in snapshot.drift if f.device == key), None)
        rows.append(
            {
                "key": key,
                "name": spec.name,
                "driver": spec.driver,
                "power": observation.power.value if observation else "unknown",
                "phase": observation.phase if observation else None,
                "ready": bool(driver and observation and driver.is_ready(observation)),
                "observed": dict(observation.settings) if observation else {},
                "expected": dict(requirement.settings) if requirement else {},
                "requiredByActivity": bool(requirement),
                "entities": dict(spec.entities),
                "missingEntities": driver.missing_entities() if driver else [],
                "error": observation.error if observation else None,
                "drift": finding.detail if finding else None,
            }
        )

    connection.send_result(
        msg["id"],
        {
            "activity": snapshot.activity,
            "targetActivity": snapshot.target_activity,
            "state": snapshot.state.value,
            "devices": rows,
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/device_test",
        vol.Required("device"): str,
        vol.Required("action"): vol.In(["start", "stop", "apply"]),
        vol.Optional("settings", default={}): dict,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_device_test(hass, connection, msg) -> None:
    """Start, stop or reconfigure one device in isolation (FR-124)."""
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    device = msg["device"]
    driver = coordinator.engine.drivers.get(device)
    if driver is None:
        connection.send_error(
            msg["id"], "unknown_device", f"Unbekanntes Gerät: {device}"
        )
        return

    action = msg["action"]
    try:
        if action == "start":
            await driver.start()
        elif action == "stop":
            await driver.stop()
        else:
            await driver.apply(msg["settings"])
    except Exception as err:  # noqa: BLE001 - diagnosing is the point here
        connection.send_error(msg["id"], "device_error", str(err))
        return

    observation = await driver.observe()
    connection.send_result(
        msg["id"],
        {
            "ok": True,
            "power": observation.power.value,
            "phase": observation.phase,
            "ready": driver.is_ready(observation),
        },
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): "kino/durations/reset",
        vol.Optional("device"): vol.Any(str, None),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_durations_reset(hass, connection, msg) -> None:
    """Throw away learned durations, per device or entirely (FR-123)."""
    coordinator = _first_coordinator(hass)
    if coordinator is None:
        connection.send_error(msg["id"], "not_ready", "Kino ist nicht bereit.")
        return
    coordinator.estimator.reset(msg.get("device"))
    await coordinator.async_persist_durations()
    connection.send_result(msg["id"], {"ok": True})
