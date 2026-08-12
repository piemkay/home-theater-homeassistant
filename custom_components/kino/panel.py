"""Sidebar panel registration (FR-100, FR-101).

Served by the integration itself — no add-on, no separate install. The panel
is admin-only, so the second user never sees a "Kino" entry in her sidebar
(A13); her surface is the card and nothing else.
"""

from __future__ import annotations

import logging

from homeassistant.components import frontend, panel_custom
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .frontend import PANEL_MODULE_URL, async_card_version

_LOGGER = logging.getLogger(__name__)

PANEL_URL_PATH = "kino"
# Not plain "Kino": the dashboard already claims that name, and two identical
# sidebar entries are indistinguishable even for the admin (F15).
PANEL_TITLE = "Kino Admin"
PANEL_ICON = "mdi:movie-edit"
PANEL_COMPONENT = "kino-panel"

_REGISTERED = f"{DOMAIN}_panel"


async def async_register_panel(hass: HomeAssistant) -> None:
    """Add the Kino entry to the sidebar, for admins only."""
    if hass.data.get(_REGISTERED):
        return

    # The version query is the cache-buster: without it a browser keeps the
    # old panel module across updates — the card's Lovelace resource already
    # works this way.
    module_url = f"{PANEL_MODULE_URL}?v={await async_card_version(hass)}"
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_COMPONENT,
        module_url=module_url,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        embed_iframe=False,
    )
    hass.data[_REGISTERED] = True
    _LOGGER.debug("Kino-Panel registriert unter /%s", PANEL_URL_PATH)


def async_remove_panel(hass: HomeAssistant) -> None:
    """Take the sidebar entry away again when the entry is removed."""
    if not hass.data.pop(_REGISTERED, False):
        return
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
