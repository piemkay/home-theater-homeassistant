"""
Persistence for clips, showcases, tag vocabulary and demo settings.

Home Assistant's own `Store` (JSON under `.storage`), so the whole demo
dataset is backed up with Home Assistant and depends on nothing outside it
(spec §9). The same document is what export and import move around.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import replace
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from ..const import STORAGE_KEY_DEMO, STORAGE_VERSION
from .model import VOCABULARY, Clip, DemoSettings, Showcase

_LOGGER = logging.getLogger(__name__)


class DemoStore:
    """Reads and writes the demo dataset, and keeps it in memory in between."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store = Store(hass, STORAGE_VERSION, STORAGE_KEY_DEMO)
        self._clips: dict[str, Clip] = {}
        self._showcases: dict[str, Showcase] = {}
        self._vocabulary: list[str] = [key for key, _ in VOCABULARY]
        self._settings = DemoSettings()
        self._loaded = False

    # -- lifecycle ----------------------------------------------------------

    async def async_load(self) -> None:
        if self._loaded:
            return
        stored = await self._store.async_load()
        self._apply(stored or {})
        self._loaded = True

    def _apply(self, raw: Mapping[str, Any]) -> None:
        self._clips = {}
        for entry in raw.get("clips") or []:
            try:
                clip = Clip.from_dict(entry)
            except (TypeError, ValueError):
                _LOGGER.warning("Demo-Clip übersprungen: %s", entry)
                continue
            self._clips[clip.id] = clip

        self._showcases = {}
        known = set(self._clips)
        for entry in raw.get("showcases") or []:
            try:
                showcase = Showcase.from_dict(entry)
            except (TypeError, ValueError):
                _LOGGER.warning("Showcase übersprungen: %s", entry)
                continue
            # A showcase never points at a clip that is gone: a deleted clip
            # would otherwise leave a hole the runtime has to skip past.
            showcase = replace(
                showcase,
                clip_ids=tuple(c for c in showcase.clip_ids if c in known),
            )
            self._showcases[showcase.id] = showcase

        vocabulary = raw.get("vocabulary")
        if isinstance(vocabulary, list) and vocabulary:
            self._vocabulary = [str(v) for v in vocabulary]
        self._settings = DemoSettings.from_dict(raw.get("settings"))

    async def async_save(self) -> None:
        await self._store.async_save(self.as_document())

    # -- reading ------------------------------------------------------------

    @property
    def settings(self) -> DemoSettings:
        return self._settings

    @property
    def clips(self) -> list[Clip]:
        return list(self._clips.values())

    @property
    def showcases(self) -> list[Showcase]:
        return list(self._showcases.values())

    @property
    def vocabulary(self) -> list[str]:
        return list(self._vocabulary)

    def clip(self, clip_id: str) -> Clip | None:
        return self._clips.get(clip_id)

    def showcase(self, showcase_id: str) -> Showcase | None:
        return self._showcases.get(showcase_id)

    def clips_for_item(self, item_id: str) -> list[Clip]:
        """Every clip of one title — the detail view's second entry point."""
        return [c for c in self._clips.values() if c.item_id == item_id]

    def resolve(self, clip_ids: Iterable[str]) -> list[Clip]:
        """Clips in the given order, silently dropping ones that are gone."""
        found = (self._clips.get(c) for c in clip_ids)
        return [c for c in found if c is not None]

    def as_document(self) -> dict[str, Any]:
        return {
            "clips": [clip.as_dict() for clip in self._clips.values()],
            "showcases": [sc.as_dict() for sc in self._showcases.values()],
            "vocabulary": list(self._vocabulary),
            "settings": self._settings.as_dict(),
        }

    # -- writing ------------------------------------------------------------

    async def async_put_clip(self, clip: Clip) -> Clip:
        self._clips[clip.id] = clip
        await self.async_save()
        return clip

    async def async_delete_clip(self, clip_id: str) -> bool:
        if self._clips.pop(clip_id, None) is None:
            return False
        # Drop it from every showcase too, rather than leaving a dangling id.
        for key, showcase in list(self._showcases.items()):
            if clip_id in showcase.clip_ids:
                self._showcases[key] = replace(
                    showcase,
                    clip_ids=tuple(c for c in showcase.clip_ids if c != clip_id),
                )
        await self.async_save()
        return True

    async def async_put_showcase(self, showcase: Showcase) -> Showcase:
        known = set(self._clips)
        showcase = replace(
            showcase, clip_ids=tuple(c for c in showcase.clip_ids if c in known)
        )
        self._showcases[showcase.id] = showcase
        await self.async_save()
        return showcase

    async def async_delete_showcase(self, showcase_id: str) -> bool:
        if self._showcases.pop(showcase_id, None) is None:
            return False
        await self.async_save()
        return True

    async def async_set_settings(self, settings: DemoSettings) -> DemoSettings:
        self._settings = settings
        await self.async_save()
        return settings

    async def async_import(self, document: Mapping[str, Any]) -> None:
        """Replace the whole dataset — the other half of export (spec §8)."""
        self._apply(document)
        await self.async_save()
