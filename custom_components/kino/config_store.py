"""Loading and reloading the declarative config document (FR-91 … FR-93)."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

from .core.model import KinoConfig
from .core.schema import ConfigError, ConfigErrors, validate

_LOGGER = logging.getLogger(__name__)

DEFAULT_FILENAME = "kino.yaml"


class ConfigNotFoundError(Exception):
    """The config document does not exist yet."""


def _read(path: Path) -> Any:
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError as err:
        raise ConfigNotFoundError(
            f"Konfigurationsdatei nicht gefunden: {path}"
        ) from err
    try:
        return yaml.safe_load(text)
    except yaml.YAMLError as err:
        raise ConfigErrors(
            [ConfigError(str(path), f"YAML konnte nicht gelesen werden: {err}")]
        ) from err


class ConfigStore:
    """Reads ``<config>/kino.yaml`` and validates it on every load."""

    def __init__(self, hass: Any, filename: str = DEFAULT_FILENAME) -> None:
        self._hass = hass
        self._filename = filename
        self._config: KinoConfig | None = None

    @property
    def path(self) -> Path:
        return Path(self._hass.config.path(self._filename))

    @property
    def config(self) -> KinoConfig:
        if self._config is None:
            raise RuntimeError("Konfiguration wurde noch nicht geladen")
        return self._config

    async def async_load(self) -> KinoConfig:
        """Read and validate. Raises with every problem named (FR-92)."""
        path = self.path
        document = await self._hass.async_add_executor_job(_read, path)
        config = validate(document)
        _LOGGER.debug(
            "Kino-Konfiguration geladen: %d Geräte, %d Aktivitäten aus %s",
            len(config.devices),
            len(config.activities),
            path,
        )
        self._config = config
        return config

    async def async_write_default(self) -> None:
        """Drop a starter document in place on first setup."""
        path = self.path
        if path.exists():
            return
        await self._hass.async_add_executor_job(
            path.write_text, DEFAULT_DOCUMENT, "utf-8"
        )
        _LOGGER.info("Beispiel-Konfiguration geschrieben: %s", path)


DEFAULT_DOCUMENT = """\
# Kino – Konfiguration
#
# Diese Datei ist der Vertrag (FR-91). Der spätere Admin-Panel-Editor
# schreibt genau dieses Format.
#
# Nach jeder Änderung:  Aktion  kino.reload  aufrufen — kein Neustart nötig.
version: 1

settings:
  off_activity: aus
  shutdown_light_scene: scene.low_ambience
  drift_debounce_seconds: 20
  volume:
    device: trinnov
    min_db: -60.0
    max_db: -25.0     # Soft-Limit; das harte Limit gehört in den Trinnov (D10)
    step_db: 2.0

devices:
  barco:
    driver: barco
    name: Beamer
    entities:
      power: switch.hodr_cs_power
      state: sensor.hodr_cs_state
      profile: select.hodr_cs_profile
    # Der Beamer kann sein aktives Profil nicht melden (FR-143).
    unverifiable_settings: [profile]
    startup_timeout: 600
    shutdown_timeout: 600
    default_startup_seconds: 20
    default_shutdown_seconds: 492   # gemessen: 8:12 von "on" bis "standby"

  trinnov:
    driver: trinnov
    name: Trinnov
    entities:
      power: remote.trinnov_altitude_14683197
      media_player: media_player.trinnov_altitude_14683197
      source: select.trinnov_altitude_14683197_source
      preset: select.trinnov_altitude_14683197_preset
      upmixer: select.trinnov_altitude_14683197_upmixer
      mute: switch.trinnov_altitude_14683197_mute
      volume: sensor.trinnov_altitude_14683197_volume
    startup_timeout: 180
    default_startup_seconds: 60

  madvr:
    driver: madvr
    name: madVR
    entities:
      power: remote.madvr_envy
      power_state: binary_sensor.madvr_envy_power_state
      wake: button.kino_wake_on_lan_madvr
    startup_timeout: 120
    default_startup_seconds: 30

  zidoo:
    driver: zidoo
    name: Zidoo
    entities:
      power: remote.uhd8000
      media_player: media_player.uhd8000
    is_media: true
    startup_timeout: 120
    default_startup_seconds: 25

  shield:
    driver: generic
    name: Shield
    entities:
      media_player: media_player.shield_kino_3
    # Die Shield schläft von selbst ein — das ist kein Fehler (FR-37).
    required: false
    is_media: true
    default_startup_seconds: 15

activities:
  aus:
    name: Aus
    control_class: "off"
    icon: mdi:power
    devices: {}

  film:
    name: Bibliothek
    icon: mdi:movie-open
    control_class: full
    media: jellyfin
    light_scene: scene.dark
    devices:
      barco:   { power: true, profile: "HDR 260 HDMI" }
      trinnov: { power: true, source: zidoo, volume: -30.0 }
      madvr:   { power: true }
      zidoo:   { power: true }

  netflix:
    name: Streaming
    icon: mdi:television-play
    control_class: handoff
    light_scene: scene.dark
    handoff_text: >-
      Weiter auf der Fernbedienung der Shield — Netflix, Prime, YouTube.
      Bild und Ton sind vorbereitet.
    devices:
      barco:   { power: true, profile: "HDR 260 HDMI" }
      trinnov: { power: true, source: shield, volume: -30.0 }
      madvr:   { power: true }
      shield:  { power: true }

  musik:
    name: Musik
    icon: mdi:music
    control_class: mixed
    light_scene: scene.low_ambience
    # Kein Beamer, kein madVR — die schnellste Aktivität im System.
    devices:
      trinnov: { power: true, source: zidoo, volume: -35.0 }
      zidoo:   { power: true }

  steam:
    name: Steam
    icon: mdi:controller
    control_class: room
    light_scene: scene.kini_gaming
    handoff_text: >-
      Nur Raumsteuerung. Bild und Ton werden vorbereitet,
      Steam läuft über den PC.
    devices:
      barco:   { power: true, profile: "HDR 260 DP" }
      trinnov: { power: true, source: steam, volume: -30.0 }
"""
