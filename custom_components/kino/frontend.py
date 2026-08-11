"""
Serve and auto-register the frontend assets (FR-77, FR-103).

HACS installs one repository as one category, so this repo ships as an
*integration* and the integration itself serves both the Lovelace card and the
admin panel, and registers the card as a Lovelace resource. Nobody has to add
a resource by hand.

The assets live under ``/kino_frontend/`` rather than ``/kino/`` because the
panel claims ``/kino`` as a frontend route.
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.loader import async_get_integration

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

ASSET_BASE = "/kino_frontend"
CARD_FILENAME = "kino-card.js"
PANEL_FILENAME = "kino-panel.js"
CARD_URL = f"{ASSET_BASE}/{CARD_FILENAME}"
PANEL_MODULE_URL = f"{ASSET_BASE}/{PANEL_FILENAME}"

_REGISTERED = f"{DOMAIN}_frontend"


def _asset_dir() -> Path:
    return Path(__file__).parent / "www"


async def async_register_frontend(hass: HomeAssistant) -> None:
    """Serve the asset directory and register the card resource."""
    if hass.data.get(_REGISTERED):
        return

    directory = _asset_dir()
    if not (directory / CARD_FILENAME).exists():
        _LOGGER.warning(
            "Kino-Frontend nicht gefunden (%s) — die Integration läuft, "
            "aber Karte und Panel fehlen",
            directory,
        )
        return

    await hass.http.async_register_static_paths(
        [StaticPathConfig(ASSET_BASE, str(directory), cache_headers=False)]
    )
    hass.data[_REGISTERED] = True

    await _async_add_lovelace_resource(hass)


async def _async_add_lovelace_resource(hass: HomeAssistant) -> None:
    """Register the card as a module resource, if it is not already there."""
    lovelace = hass.data.get("lovelace")
    resources = getattr(lovelace, "resources", None)
    if resources is None:
        _LOGGER.debug(
            "Lovelace läuft im YAML-Modus — die Ressource %s bitte manuell eintragen",
            CARD_URL,
        )
        return

    if not resources.loaded:
        await resources.async_load()
        resources.loaded = True

    wanted = f"{CARD_URL}?v={await async_card_version(hass)}"
    for item in resources.async_items():
        url = item.get("url", "")
        # Match on the filename so a moved asset base updates the existing
        # resource in place instead of leaving a dead one behind.
        if not url.split("?")[0].endswith(CARD_FILENAME):
            continue
        if url == wanted:
            return
        await resources.async_update_item(item["id"], {"url": wanted})
        _LOGGER.info("Kino-Karte auf %s aktualisiert", wanted)
        return

    await resources.async_create_item({"res_type": "module", "url": wanted})
    _LOGGER.info("Kino-Karte als Lovelace-Ressource registriert: %s", wanted)


async def async_card_version(hass: HomeAssistant) -> str:
    """Cache-bust on every release so browsers pick the new assets up.

    Read through the loader rather than off the disk: the manifest is already
    parsed and cached there, and reading a file from the event loop is a
    blocking call Home Assistant rightly complains about.
    """
    try:
        integration = await async_get_integration(hass, DOMAIN)
    except Exception:  # noqa: BLE001 - a cache-buster is never worth failing on
        _LOGGER.debug("Kino-Version nicht ermittelbar", exc_info=True)
        return "0"
    return str(integration.manifest.get("version") or "0")
