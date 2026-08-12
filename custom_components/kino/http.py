"""
Authenticated artwork proxy (FR-42a).

Jellyfin's own image URLs carry the API key as a query parameter. Embedding
those in card markup would leak a server credential into anything that can read
the dashboard, so the card asks Home Assistant instead and the integration
fetches the image with credentials that never leave the server.

The proxy is reached from an ``<img>`` tag, and an image request carries no
`Authorization` header, so it is authorised by the short-lived signature in
:mod:`.core.signing` instead — see that module for why.
"""

from __future__ import annotations

import logging
from urllib.parse import quote

from aiohttp import web
from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant, callback

from .const import ARTWORK_URL_FORMAT, DOMAIN
from .core.signing import ArtworkSigner
from .media.base import MediaBackendError

_LOGGER = logging.getLogger(__name__)

_ALLOWED_IMAGE_TYPES = frozenset({"Primary", "Backdrop", "Thumb", "Banner", "Logo"})

#: Posters are immutable for a given item; let the browser keep them so the
#: grid stays smooth on a phone (D8, NFR-1).
_CACHE_CONTROL = "private, max-age=86400"

_SIGNER_KEY = f"{DOMAIN}_artwork_signer"


@callback
def async_get_signer(hass: HomeAssistant) -> ArtworkSigner:
    """Return the signer for this Home Assistant, creating it on first use."""
    signer = hass.data.get(_SIGNER_KEY)
    if signer is None:
        signer = ArtworkSigner()
        hass.data[_SIGNER_KEY] = signer
    return signer


@callback
def async_artwork_url(hass: HomeAssistant, item_id: str, image_type: str) -> str:
    """Build a signed, browser-loadable URL for one image."""
    path = ARTWORK_URL_FORMAT.format(
        item_id=quote(item_id, safe=""), image_type=quote(image_type, safe="")
    )
    return f"{path}?sig={async_get_signer(hass).signature()}"


class KinoArtworkView(HomeAssistantView):
    """`/api/kino/artwork/<item_id>/<image_type>?sig=<signature>`."""

    url = "/api/kino/artwork/{item_id}/{image_type}"
    name = "api:kino:artwork"
    # Authorised by the signature below — see the module docstring.
    requires_auth = False

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass

    async def get(
        self, request: web.Request, item_id: str, image_type: str
    ) -> web.StreamResponse:
        if not async_get_signer(self.hass).verify(request.query.get("sig")):
            return web.Response(status=401, text="Signatur fehlt oder ist abgelaufen")
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
    async_get_signer(hass)
    hass.http.register_view(KinoArtworkView(hass))
