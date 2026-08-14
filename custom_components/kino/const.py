"""Constants for the Kino integration."""

from __future__ import annotations

from datetime import timedelta

DOMAIN = "kino"
NAME = "Kino"

# Config entry / options keys
CONF_CONFIG_FILE = "config_file"
CONF_JELLYFIN_URL = "jellyfin_url"
CONF_JELLYFIN_API_KEY = "jellyfin_api_key"
CONF_JELLYFIN_USER_ID = "jellyfin_user_id"
CONF_VERIFY_SSL = "verify_ssl"

DEFAULT_CONFIG_FILE = "kino.yaml"

# Coordinator
UPDATE_INTERVAL_IDLE = timedelta(seconds=15)
UPDATE_INTERVAL_ACTIVE = timedelta(seconds=5)
UPDATE_INTERVAL_TRANSITION = timedelta(seconds=2)

# Services
SERVICE_RELOAD = "reload"
SERVICE_ACTIVATE = "activate"
SERVICE_DRY_RUN = "dry_run"
SERVICE_RESTORE_DEVICE = "restore_device"
SERVICE_REFRESH_LIBRARY = "refresh_library"
SERVICE_DEMO_CAPTURE = "demo_capture"
SERVICE_DEMO_PLAY_CLIP = "demo_play_clip"
SERVICE_DEMO_PLAY_PLAYLIST = "demo_play_playlist"
SERVICE_DEMO_SKIP = "demo_skip"
SERVICE_DEMO_REPLAY = "demo_replay"
SERVICE_DEMO_STOP = "demo_stop"
SERVICE_DEMO_AB_START = "demo_ab_start"

# Events fired for the existing `Kino -` automations (FR-84)
EVENT_ACTIVITY_CHANGED = "kino_activity_changed"
EVENT_TRANSITION_STARTED = "kino_transition_started"
EVENT_TRANSITION_FINISHED = "kino_transition_finished"
EVENT_DEVICE_DRIFT = "kino_device_drift"
#: Fired around demo playback, always carrying ``demo: true`` so watch-history
#: consumers can filter it out. A showcase must never "watch" ten films.
EVENT_DEMO_PLAYBACK = "kino_demo_playback"

# Storage
STORAGE_KEY_DURATIONS = "kino.durations"
STORAGE_KEY_DEMO = "kino.demo"
STORAGE_VERSION = 1

# Artwork proxy
ARTWORK_URL_FORMAT = "/api/kino/artwork/{item_id}/{image_type}"

ATTR_ACTIVITY = "activity"
ATTR_DEVICE = "device"
ATTR_FROM_ACTIVITY = "from_activity"
ATTR_TO_ACTIVITY = "to_activity"
