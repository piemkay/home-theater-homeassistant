"""
Serve and auto-register the custom card (FR-77).

HACS installs one repository as one category, so this repo ships as an
*integration* and the integration itself serves the card and registers it as a
Lovelace resource. Nobody has to add a resource by hand.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN

_LOGGER = logging.getLogger(__name__)

CARD_FILENAME = "kino-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"


async def async_register_card(hass: HomeAssistant) -> None:
    """Serve the card bundle and add it to the Lovelace resources."""
    if hass.data.get(f"{DOMAIN}_frontend"):
        return

    source = Path(__file__).parent / "www" / CARD_FILENAME
    if not source.exists():
        _LOGGER.warning(
            "Kino-Karte nicht gefunden (%s) — die Integration läuft, "
            "aber die Karte muss manuell eingebunden werden",
            source,
        )
        return

    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(source), cache_headers=False)]
    )
    hass.data[f"{DOMAIN}_frontend"] = True

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

    version = _card_version()
    wanted = f"{CARD_URL}?v={version}"
    for item in resources.async_items():
        url = item.get("url", "")
        if url.split("?")[0] != CARD_URL:
            continue
        if url == wanted:
            return
        await resources.async_update_item(item["id"], {"url": wanted})
        _LOGGER.info("Kino-Karte auf %s aktualisiert", wanted)
        return

    await resources.async_create_item({"res_type": "module", "url": wanted})
    _LOGGER.info("Kino-Karte als Lovelace-Ressource registriert: %s", wanted)


def _card_version() -> str:
    """Cache-bust on every release so browsers pick the new card up."""
    manifest = Path(__file__).parent / "manifest.json"
    try:
        return json.loads(manifest.read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return "0"
