"""
Config flow: connection only (FR-90).

Jellyfin authentication goes through QuickConnect rather than a password or a
pasted API key. The user approves a six-digit code inside Jellyfin itself and
Home Assistant receives a real user access token — which is what the
play-state endpoints need (FR-49d), and which means this flow never handles a
password.
"""

from __future__ import annotations

import logging
from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_JELLYFIN_URL,
    CONF_JELLYFIN_USER_ID,
    CONF_VERIFY_SSL,
    DOMAIN,
    NAME,
)
from .media.base import MediaBackendError
from .media.jellyfin import JellyfinClient

_LOGGER = logging.getLogger(__name__)

CONF_TOKEN = "token"

_CONNECTION_SCHEMA = vol.Schema(
    {
        vol.Optional(CONF_JELLYFIN_URL, default=""): str,
        vol.Optional(CONF_VERIFY_SSL, default=True): bool,
    }
)


class KinoConfigFlow(ConfigFlow, domain=DOMAIN):
    """Set up Kino."""

    VERSION = 1

    def __init__(self) -> None:
        self._url: str = ""
        self._verify_ssl: bool = True
        self._secret: str | None = None
        self._code: str | None = None

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        errors: dict[str, str] = {}
        if user_input is not None:
            self._url = (user_input.get(CONF_JELLYFIN_URL) or "").strip()
            self._verify_ssl = user_input.get(CONF_VERIFY_SSL, True)

            if not self._url:
                # The activity engine works without a catalogue; media is
                # simply unavailable until Jellyfin is configured.
                return self.async_create_entry(title=NAME, data={})

            try:
                await self._client().system_info()
            except MediaBackendError:
                errors["base"] = "cannot_connect"
            else:
                return await self.async_step_quick_connect()

        return self.async_show_form(
            step_id="user", data_schema=_CONNECTION_SCHEMA, errors=errors
        )

    async def async_step_quick_connect(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Show a QuickConnect code and wait for the user to approve it."""
        client = self._client()
        errors: dict[str, str] = {}

        if self._secret is None:
            try:
                started = await client.quick_connect_initiate()
            except MediaBackendError as err:
                _LOGGER.debug("QuickConnect nicht verfügbar: %s", err)
                return self.async_abort(reason="quick_connect_unavailable")
            self._secret = started.get("Secret")
            self._code = started.get("Code")

        if user_input is not None:
            client = self._client()
            try:
                result = await client.quick_connect_authenticate(self._secret or "")
            except MediaBackendError:
                errors["base"] = "not_authorized"
            else:
                return self.async_create_entry(
                    title=NAME,
                    data={
                        CONF_JELLYFIN_URL: self._url,
                        CONF_VERIFY_SSL: self._verify_ssl,
                        CONF_TOKEN: result["AccessToken"],
                        CONF_JELLYFIN_USER_ID: (result.get("User") or {}).get("Id"),
                    },
                )

        return self.async_show_form(
            step_id="quick_connect",
            data_schema=vol.Schema({}),
            errors=errors,
            description_placeholders={"code": self._code or "?"},
        )

    def _client(self) -> JellyfinClient:
        return JellyfinClient(
            async_get_clientsession(self.hass, verify_ssl=self._verify_ssl),
            base_url=self._url,
            device_id=f"kino-{self.flow_id[:8]}",
        )
