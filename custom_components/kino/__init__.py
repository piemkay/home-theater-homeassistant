"""The Kino integration: activity engine, media catalogue and custom card."""

from __future__ import annotations

import logging

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import ConfigEntryNotReady, HomeAssistantError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .config_store import ConfigNotFoundError, ConfigStore
from .const import (
    CONF_JELLYFIN_URL,
    CONF_JELLYFIN_USER_ID,
    CONF_VERIFY_SSL,
    DOMAIN,
    SERVICE_ACTIVATE,
    SERVICE_DRY_RUN,
    SERVICE_REFRESH_LIBRARY,
    SERVICE_RELOAD,
    SERVICE_RESTORE_DEVICE,
)
from .coordinator import KinoCoordinator, KinoRuntimeData
from .core.schema import ConfigErrors
from .frontend import async_register_card
from .http import async_register_http
from .media.jellyfin import JellyfinClient
from .websocket_api import async_register_websocket_api

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.BINARY_SENSOR,
    Platform.BUTTON,
    Platform.MEDIA_PLAYER,
    Platform.NUMBER,
    Platform.SELECT,
    Platform.SENSOR,
]

CONF_TOKEN = "token"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Kino from a config entry."""
    store = ConfigStore(hass)
    try:
        config = await store.async_load()
    except ConfigNotFoundError:
        await store.async_write_default()
        try:
            config = await store.async_load()
        except ConfigErrors as err:
            raise ConfigEntryNotReady(str(err)) from err
    except ConfigErrors as err:
        # A typo must fail loudly and specifically, never silently fall back
        # to a default (A17).
        _LOGGER.exception("Kino-Konfiguration ist ungültig")
        raise ConfigEntryNotReady(str(err)) from err

    media = None
    if entry.data.get(CONF_JELLYFIN_URL):
        media = JellyfinClient(
            async_get_clientsession(
                hass, verify_ssl=entry.data.get(CONF_VERIFY_SSL, True)
            ),
            base_url=entry.data[CONF_JELLYFIN_URL],
            token=entry.data.get(CONF_TOKEN),
            user_id=entry.data.get(CONF_JELLYFIN_USER_ID),
            device_id=entry.entry_id,
        )

    coordinator = KinoCoordinator(hass, entry, config, media)
    await coordinator.async_prepare()
    await coordinator.async_config_entry_first_refresh()

    entry.runtime_data = KinoRuntimeData(coordinator=coordinator, media=media)
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = entry.runtime_data

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    async_register_http(hass)
    async_register_websocket_api(hass)
    await async_register_card(hass)
    _async_register_services(hass)

    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry."""
    runtime: KinoRuntimeData = entry.runtime_data
    await runtime.coordinator.async_persist_durations()
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return unloaded


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


def _coordinators(hass: HomeAssistant) -> list[KinoCoordinator]:
    return [runtime.coordinator for runtime in hass.data.get(DOMAIN, {}).values()]


def _async_register_services(hass: HomeAssistant) -> None:  # noqa: C901
    """Register the Kino services once, regardless of entry count."""
    if hass.services.has_service(DOMAIN, SERVICE_RELOAD):
        return

    async def _reload(_call: ServiceCall) -> None:
        """Re-read the config document without restarting HA (FR-93)."""
        store = ConfigStore(hass)
        try:
            config = await store.async_load()
        except (ConfigErrors, ConfigNotFoundError) as err:
            raise HomeAssistantError(str(err)) from err
        for coordinator in _coordinators(hass):
            await coordinator.async_reload_config(config)
        _LOGGER.info("Kino-Konfiguration neu geladen")

    async def _activate(call: ServiceCall) -> None:
        key = call.data["activity"]
        for coordinator in _coordinators(hass):
            try:
                await coordinator.async_activate(key)
            except KeyError as err:
                raise HomeAssistantError(str(err)) from err

    async def _dry_run(call: ServiceCall) -> dict:
        key = call.data["activity"]
        for coordinator in _coordinators(hass):
            plan = await coordinator.engine.dry_run(key)
            return {
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
            }
        return {}

    async def _restore_device(call: ServiceCall) -> None:
        device = call.data["device"]
        for coordinator in _coordinators(hass):
            try:
                await coordinator.engine.restore_device(device)
            except (KeyError, ValueError) as err:
                raise HomeAssistantError(str(err)) from err

    async def _refresh_library(_call: ServiceCall) -> None:
        for runtime in hass.data.get(DOMAIN, {}).values():
            if runtime.media is not None:
                await runtime.media.refresh()

    hass.services.async_register(DOMAIN, SERVICE_RELOAD, _reload)
    hass.services.async_register(
        DOMAIN,
        SERVICE_ACTIVATE,
        _activate,
        schema=vol.Schema({vol.Required("activity"): cv.string}),
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_DRY_RUN,
        _dry_run,
        schema=vol.Schema({vol.Required("activity"): cv.string}),
        supports_response="only",
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_RESTORE_DEVICE,
        _restore_device,
        schema=vol.Schema({vol.Required("device"): cv.string}),
    )
    hass.services.async_register(DOMAIN, SERVICE_REFRESH_LIBRARY, _refresh_library)
