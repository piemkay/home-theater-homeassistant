"""
Binds the demo engine to Home Assistant.

Everything Home-Assistant-shaped about demo playback lives here: the engine
above it stays a sequencer. The runtime never talks to hardware directly
either — it goes through the same activity engine and the same device drivers
the rest of Kino uses, which is what keeps "the demo engine consumes the
activity layer" true rather than merely intended.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Mapping
from typing import Any

from homeassistant.core import HomeAssistant

from ..const import DOMAIN, EVENT_DEMO_PLAYBACK
from ..core.model import ActivityState
from ..devices.madvr import MadvrDriver
from ..devices.trinnov import TrinnovDriver
from ..devices.zidoo import ZidooDriver
from .model import Clip

_LOGGER = logging.getLogger(__name__)

#: Headroom on top of the slowest device's own startup timeout, so waiting for
#: the room to settle never gives up before the engine driving it would.
ACTIVITY_TIMEOUT_HEADROOM = 60.0

#: Floor for the same, for an install whose devices are all quick.
ACTIVITY_TIMEOUT_MIN = 120.0


class HassDemoRuntime:
    """The engine's view of the room, in Home Assistant terms."""

    def __init__(self, hass: HomeAssistant, coordinator: Any) -> None:
        self._hass = hass
        self._coordinator = coordinator
        self._listeners: list[Any] = []

    # -- clock --------------------------------------------------------------

    def now(self) -> float:
        return self._hass.loop.time()

    def wall_ms(self) -> float:
        return time.time() * 1000

    # -- devices ------------------------------------------------------------

    def _driver_of(self, kind: type) -> Any:
        for driver in self._coordinator.engine.drivers.values():
            if isinstance(driver, kind):
                return driver
        return None

    @property
    def _zidoo(self) -> ZidooDriver | None:
        """The media device of the *running* activity, not just any Zidoo."""
        snapshot = self._coordinator.engine.snapshot()
        activity = self._coordinator.config.activities.get(snapshot.activity)
        if activity is not None:
            for key in activity.devices:
                if not activity.requires(key):
                    continue
                driver = self._coordinator.engine.drivers.get(key)
                if isinstance(driver, ZidooDriver):
                    return driver
        return self._driver_of(ZidooDriver)

    @property
    def _trinnov(self) -> TrinnovDriver | None:
        key = self._coordinator.config.volume_device
        driver = self._coordinator.engine.drivers.get(key) if key else None
        if isinstance(driver, TrinnovDriver):
            return driver
        return self._driver_of(TrinnovDriver)

    @property
    def _madvr(self) -> MadvrDriver | None:
        return self._driver_of(MadvrDriver)

    def _driver_by_driver_name(self, name: str) -> Any:
        for key, spec in self._coordinator.config.devices.items():
            if spec.driver == name:
                return self._coordinator.engine.drivers.get(key)
        return None

    # -- the activity layer -------------------------------------------------

    def _activity_timeout(self) -> float:
        """How long to wait for the room, from what the devices are allowed.

        A cold projector here takes minutes, and its own driver is given a
        ten-minute budget — a flat timeout shorter than that would abandon a
        start the engine was still perfectly happy with.
        """
        devices = self._coordinator.config.devices.values()
        slowest = max((spec.startup_timeout for spec in devices), default=0.0)
        return max(ACTIVITY_TIMEOUT_MIN, slowest + ACTIVITY_TIMEOUT_HEADROOM)

    async def ensure_activity(self) -> None:
        """Request the media activity and wait for the room to actually settle."""
        engine = self._coordinator.engine
        config = self._coordinator.config
        snapshot = engine.snapshot()
        activity = config.activities.get(snapshot.activity)

        if activity is None or not activity.media or self._zidoo is None:
            key = next((k for k, a in config.activities.items() if a.media), None)
            if key is None:
                raise RuntimeError(
                    "Keine Aktivität mit einer Medienquelle konfiguriert."
                )
            await self._coordinator.async_activate(key)
            await self._coordinator.async_apply_light_scene(key)

        try:
            await asyncio.wait_for(
                engine.wait_for_transition(), self._activity_timeout()
            )
        except asyncio.TimeoutError as err:
            raise RuntimeError(
                "Das Kino ist nicht rechtzeitig bereit geworden."
            ) from err

        snapshot = engine.snapshot()
        if snapshot.state is ActivityState.ERROR:
            raise RuntimeError(
                snapshot.last_error or "Die Aktivität konnte nicht gestartet werden."
            )
        if self._zidoo is None:
            raise RuntimeError("Die aktuelle Aktivität hat keine Medienwiedergabe.")

    # -- playback -----------------------------------------------------------

    def has_file_open(self, clip: Clip) -> bool:
        """Return True when the player already has this clip's file open.

        The catalogue entry is the better signal — it survives a path mapping
        change — with the resolved path as the fallback for a file the
        catalogue never matched.
        """
        playing = self._coordinator.playing_item or {}
        if clip.item_id and playing.get("id"):
            return str(playing["id"]) == str(clip.item_id)
        driver = self._zidoo
        if driver is None or not clip.path:
            return False
        open_uri = driver.now_playing().get("uri")
        return bool(open_uri) and open_uri == driver.resolve_path(clip.path)

    async def play_clip(self, clip: Clip) -> None:
        driver = self._zidoo
        if driver is None:
            raise RuntimeError("Die aktuelle Aktivität hat keine Medienwiedergabe.")
        path = clip.path
        if not path:
            path = await self._path_from_catalogue(clip)
        if not path:
            raise RuntimeError(
                f"„{clip.name}“ hat keinen Dateipfad — der Titel ist in der "
                "Bibliothek nicht (mehr) auffindbar."
            )
        await driver.play_path(path)
        # A clip started here is a known catalogue entry: say so, so the
        # card's now-playing keeps its poster and its real title.
        self._coordinator.playing_item = {
            "uri": driver.resolve_path(path) or path,
            "id": clip.item_id,
            "title": clip.title or clip.name,
        }

    async def _path_from_catalogue(self, clip: Clip) -> str | None:
        """Re-resolve a clip whose stored path has gone stale (§2.1)."""
        media = self._coordinator.media
        if media is None or not clip.item_id:
            return None
        try:
            item = await media.item(clip.item_id)
        except Exception:  # noqa: BLE001 - a lookup failure is not a crash
            _LOGGER.debug("Clip-Auflösung fehlgeschlagen", exc_info=True)
            return None
        return item.path if item else None

    async def wait_for_playing(self, timeout: float) -> bool:
        driver = self._zidoo
        if driver is None:
            return False
        deadline = self.now() + timeout
        while self.now() < deadline:
            if driver.now_playing().get("state") == "playing":
                return True
            await asyncio.sleep(0.5)
        return False

    async def apply_tracks(self, audio: str | None, subtitle: str | None) -> bool:
        """Select tracks, and report whether anything was actually switched."""
        driver = self._zidoo
        if driver is None:
            return False
        switched = False
        if audio and driver.value_of("audio_select") != audio:
            try:
                await driver.select_audio_track(audio)
                switched = True
            except RuntimeError as err:
                _LOGGER.warning("Tonspur '%s' nicht gesetzt: %s", audio, err)
        if subtitle and driver.value_of("subtitle_select") != subtitle:
            try:
                await driver.select_subtitle_track(subtitle)
                switched = True
            except RuntimeError as err:
                _LOGGER.warning("Untertitel '%s' nicht gesetzt: %s", subtitle, err)
        return switched

    async def seek(self, seconds: float) -> None:
        driver = self._zidoo
        if driver is not None:
            await driver.seek(max(0.0, seconds))

    def position(self) -> float | None:
        driver = self._zidoo
        if driver is None:
            return None
        now = driver.now_playing()
        position = now.get("position")
        if position is None:
            return None
        # The player reports a position and the moment it read it; playback
        # advances at 1× in between, which is exactly what makes the
        # predictive stop possible.
        return float(position)

    async def pause(self) -> None:
        driver = self._zidoo
        if driver is None:
            return
        if driver.now_playing().get("state") == "playing":
            await driver.async_media_command("media_pause")

    async def resume(self) -> None:
        driver = self._zidoo
        if driver is None:
            return
        if driver.now_playing().get("state") == "paused":
            await driver.async_media_command("media_play")

    async def stop_playback(self) -> None:
        driver = self._zidoo
        if driver is not None:
            await driver.stop_playback()

    # -- sound --------------------------------------------------------------

    def volume_db(self) -> float | None:
        driver = self._trinnov
        return driver.volume_db() if driver else None

    async def set_volume_db(self, db: float) -> None:
        driver = self._trinnov
        if driver is None:
            return
        config = self._coordinator.config
        clamped = min(max(db, config.volume_min_db), config.volume_max_db)
        await driver.set_volume(clamped)

    async def set_mute(self, muted: bool) -> None:
        driver = self._trinnov
        if driver is not None:
            await driver.set_mute(muted)

    def reported_audio_format(self) -> str | None:
        driver = self._zidoo
        return driver.now_playing().get("audio_format") if driver else None

    # -- look (preset / profile) --------------------------------------------

    def current_look(self) -> dict[str, Any]:
        look: dict[str, Any] = {}
        trinnov = self._trinnov
        if trinnov is not None:
            preset = trinnov.value_of("preset")
            if preset:
                look["preset"] = preset
        madvr = self._madvr
        if madvr is not None and madvr.active_profile is not None:
            look["madvr"] = madvr.active_profile
        barco = self._driver_by_driver_name("barco")
        if barco is not None:
            profile = barco.value_of("profile")
            if profile:
                look["barco"] = profile
        return look

    async def apply_look(self, look: Mapping[str, Any]) -> None:
        """Apply any of preset / madvr / barco that the mapping names."""
        trinnov = self._trinnov
        if look.get("preset") and trinnov is not None:
            await self._safely(trinnov.apply({"preset": look["preset"]}), "Preset")
        madvr = self._madvr
        if look.get("madvr") and madvr is not None:
            await self._safely(
                madvr.apply({"profile": look["madvr"]}), "madVR-Profil"
            )
        barco = self._driver_by_driver_name("barco") if look.get("barco") else None
        if barco is not None:
            await self._safely(
                barco.apply({"profile": look["barco"]}), "Beamer-Profil"
            )

    async def _safely(self, awaitable: Any, what: str) -> None:
        try:
            await awaitable
        except Exception as err:  # noqa: BLE001 - one refused setting is not fatal
            _LOGGER.warning("%s konnte nicht gesetzt werden: %s", what, err)

    def look_confirmed(self, look: Mapping[str, Any]) -> bool:
        """Return True once every named part of the look reads back as active.

        A device that cannot report the value at all counts as confirmed —
        waiting for a signal that will never arrive is how a demo hangs. The
        Envy's and the projector's profiles are shadow values by design
        (FR-143), so only the processor's preset can actually block here.
        """
        trinnov = self._trinnov
        preset = look.get("preset")
        return not (
            preset
            and trinnov is not None
            and trinnov.value_of("preset") not in (None, preset)
        )

    # -- plumbing -----------------------------------------------------------

    def emit(self, data: Mapping[str, Any]) -> None:
        """Fire the demo-playback event."""
        self._hass.bus.async_fire(EVENT_DEMO_PLAYBACK, dict(data))

    def changed(self) -> None:
        """Push the new runtime state to whatever is watching.

        The card polls `kino/state`, which carries the demo block, so an
        immediate listener update is what makes the overlay move at phase
        boundaries instead of at the next two-second poll.
        """
        self._coordinator.async_update_listeners()
        self._hass.data.setdefault(f"{DOMAIN}_demo_seq", 0)
        self._hass.data[f"{DOMAIN}_demo_seq"] += 1
