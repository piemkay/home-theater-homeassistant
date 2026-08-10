"""
Authenticated artwork proxy (FR-42a).

Jellyfin's own image URLs carry the API key as a query parameter. Embedding
those in card markup would leak a server credential into anything that can read
the dashboard, so the card asks Home Assistant instead and the integration
fetches the image with credentials that never leave the server.
"""

from __future__ import annotations

import logging

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN
from .media.base import MediaBackendError

_LOGGER = logging.getLogger(__name__)

_ALLOWED_IMAGE_TYPES = frozenset({"Primary", "Backdrop", "Thumb", "Logo"})

#: Posters are immutable for a given item; let the browser keep them so the
#: grid stays smooth on a phone (D8, NFR-1).
_CACHE_CONTROL = "private, max-age=86400"


class KinoArtworkView(HomeAssistantView):
    """`/api/kino/artwork/<item_id>/<image_type>`."""

    url = "/api/kino/artwork/{item_id}/{image_type}"
    name = "api:kino:artwork"
    requires_auth = True

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(
        self, request: web.Request, item_id: str, image_type: str
    ) -> web.StreamResponse:
        if image_type not in _ALLOWED_IMAGE_TYPES:
            return web.Response(status=400, text="Unbekannter Bildtyp")

        for runtime in self.hass.data.get(DOMAIN, {}).values():
            media = runtime.media
            if media is None:
                continue
            try:
                payload, content_type = await media.artwork(item_id, image_type)
            except MediaBackendError as err:
                _LOGGER.debug("Artwork %s nicht verfügbar: %s", item_id, err)
                continue
            return web.Response(
                body=payload,
                content_type=content_type.split(";")[0],
                headers={"Cache-Control": _CACHE_CONTROL},
            )
        return web.Response(status=404, text="Kein Bild gefunden")


@callback
def async_register_http(hass: HomeAssistant) -> None:
    """Register the artwork view once."""
    if hass.data.setdefault(f"{DOMAIN}_http", False):
        return
    hass.data[f"{DOMAIN}_http"] = True
    hass.http.register_view(KinoArtworkView(hass))
