# Kino — custom home theater integration for Home Assistant

[![Validate](https://github.com/piemkay/home-theater-homeassistant/actions/workflows/validate.yml/badge.svg)](https://github.com/piemkay/home-theater-homeassistant/actions/workflows/validate.yml)
[![hacs](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)

A generic **activity engine** for a home cinema, plus a responsive Lovelace
card and an admin panel. It replaces a pile of `start_*` scripts and mirror
helpers with one integration that computes what actually needs to change and
says, in plain German, what it is doing.

The bar it is built to: *a second person can run the cinema end-to-end from a
phone, without help, without prior knowledge, and without breaking anything.*

---

## What it does

**A differential activity engine.** Switching from Film to Netflix does not
re-run a start sequence. It computes a delta — keep the projector and the
processor, reconfigure the processor's input, stop the Zidoo, start the Shield
— and runs the independent parts concurrently, longest step first, so the
projector is never waiting behind a fast device. A device already in the right
state is skipped entirely.

**Readiness from observed state, never from a timer.** Timeouts exist only as
failure paths. The Barco's `ready`-means-two-things quirk is resolved from the
transition it was entered through, so the projector is never declared ready
while it is actually shutting down. A power-on refused during the projector's
deconditioning window becomes a standing intent and is re-issued automatically;
a second power-off in the right cooldown window drops it to standby early and
saves five minutes.

**Progress you can trust.** During a transition the card shows a percent bar,
an ETA and the current bottleneck by name ("Beamer startet"). The ETA comes
from *learned* durations — every start, stop and reconfigure is measured, cold
and warm separately, and folded into a decaying average that survives restarts.

**State derived, not recorded.** After a Home Assistant restart — even
mid-transition — the activity reconciles to whatever the room is really doing
on the next poll.

**It reconciles; it does not enforce.** If somebody switches the projector off
with its own remote, the card says so, names the device and offers a one-tap
restore (or a one-tap "Ignorieren"). It never quietly switches anything back
on. Volume and mute are the user's — they are never reported as drift.

**A media catalogue that works with the cinema switched off.** Browse, search,
filter and sort come from Jellyfin over the Home Assistant WebSocket API.
Picking a title while the Film activity is off starts the activity *and then*
plays, as one action, with progress shown throughout.

**Playback flows back into the catalogue.** What the Zidoo plays is reported
to Jellyfin as a real playback session — start, progress, pause, stop — so
watched state, resume points and Jellystat history stay correct no matter how
playback was started. Only titles that resolve to a real catalogue entry are
reported; a guess never fabricates history.

## Installation

### HACS (recommended)

1. HACS → ⋮ → **Custom repositories**
2. Add `https://github.com/piemkay/home-theater-homeassistant`, category
   **Integration**
3. Install **Kino**, then restart Home Assistant
4. **Settings → Devices & Services → Add Integration → Kino**

The Lovelace card is served and registered by the integration itself — there
is no separate resource to add.

### Manual

Copy `custom_components/kino` into your Home Assistant `config/custom_components/`
directory and restart.

## Setup

The config flow covers the connection only.

* Leave the Jellyfin address blank to run the activity engine without a media
  catalogue.
* Enter it, and the flow shows a **QuickConnect code**. Approve it in Jellyfin
  under *Settings → QuickConnect*. Home Assistant receives a real user access
  token — no password is transmitted, and that token is what Jellyfin's
  play-state endpoints require.

Everything else lives in **`config/kino.yaml`**, which the integration writes
with a working starter document on first setup:

```yaml
version: 1

devices:
  barco:
    driver: barco
    name: Beamer
    entities:
      power: switch.hodr_cs_power
      state: sensor.hodr_cs_state
      profile: select.hodr_cs_profile
    unverifiable_settings: [profile]   # the projector cannot report its profile

activities:
  film:
    name: Bibliothek
    control_class: full
    media: jellyfin
    light_scene: scene.dark
    devices:
      barco:   { power: true, profile: "HDR 260 HDMI" }
      trinnov: { power: true, source: zidoo, volume: -30.0 }
      madvr:   { power: true }
      zidoo:   { power: true }
```

Adding an activity needs no Python and no new scripts. Call **`kino.reload`**
to apply changes without restarting Home Assistant.

### Device drivers

| Driver | Device | Quirks it owns |
|---|---|---|
| `barco` | Barco projector (via `barco-pulse-homeassistant`) | The ambiguous `ready` state, cooldown/deconditioning windows, standing power intents, profile as an unverifiable shadow value |
| `trinnov` | Trinnov Altitude | `power_status`-based readiness, refusing to write a source into an unloaded option list, dB volume with confirm-shadowing so a double-tap moves two steps |
| `madvr` | madVR Envy | Wake-on-LAN start, per-source profile slots via `remote.send_command`, profile as a shadow value |
| `zidoo` | Zidoo player | Path mapping, percent-encoding of `#`-laden NFS paths, seek shadowing, audio/subtitle track selects, subtitle "Aus" translation |
| `generic` | Hand-off devices (Shield, Apple TV) | App observation via `app_id`/`source`, power through whatever role is wired |

Every driver reads and acts through Home Assistant entities only — there is no
direct network I/O in the integration.

### Playback needs one path mapping

Jellyfin indexes the library through its own mount, the player opens the file
through another. Tell the media device how one becomes the other — in the admin
panel under *Geräte*, or directly:

```yaml
devices:
  zidoo:
    options:
      path_map:
        /media/entertainment/: "/mnt/nfs/192.168.50.10#entertainment/"
```

The longest matching prefix wins. Without a matching rule the card names the
path it could not translate instead of failing silently.

Validation names the offending activity, device and field:

```
Kino-Konfiguration ungültig (2 Fehler):
  - activities.film.devices.beamer: unbekanntes Gerät 'beamer' (definiert: barco, madvr, shield, trinnov, zidoo)
  - devices.trinnov.startup_timout: unbekanntes Feld (erlaubt: default_shutdown_seconds, …)
```

## The card

Add a **Kino** card to any dashboard. It is one card at every size: a
one-handed single column on a phone, a denser grid on a tablet.

```yaml
type: custom:kino-card
```

The card is a **fixed-height frame** — header and transport bar stay put while
the library scrolls between them, which is what keeps volume and playback
reachable in a 300-title grid. It fills the viewport by default; `height:`
takes any CSS length if you want something else:

```yaml
type: custom:kino-card
height: 70vh
```

### Activities and status

Activity tiles to start or switch; a compact chip once something runs. During
a transition the card shows the progress bar, the learned ETA and the
bottleneck device; each device of the activity is a chip with a live health
dot — including during shutdown, so you can watch each device confirm. Errors
and drift arrive as banners with the recovery action attached ("Wiederherstellen"
/ "Ignorieren"); turning everything off asks once, in words ("Alles ausschalten?").

### The library

* **Browse while off.** The library home (continue-watching and
  recently-added rows, Filme/Serien) renders with the room dark; the play
  button becomes "Kino starten und wiedergeben" and does both in one tap.
* **Search** (debounced), **eight sort orders** (added, title, year, rating,
  runtime, last played, critics rating, random) with an explicit
  ascending/descending toggle.
* **Filters**: 4K / HD / SD / 3D, watched / unwatched / continue-watching,
  favorites, genres, age ratings (FSK & Co.), release-year range — combined
  freely, applied server-side so pagination never lies, shown as removable
  chips above the grid.
* **Six view modes** (Poster, Posterkarte, Vorschau, Vorschaukarte, Banner,
  Liste), remembered per browser.
* **Favorites** are written back to Jellyfin from the heart toggle and
  filterable like everything else.
* Tiles carry 4K badges, resume bars, watched ticks, favorite hearts, and a
  red mark with a reason when a title is missing the data it needs to play.
* Infinite scroll plus an explicit "Weitere Titel laden" button; a failed page
  append never throws away the titles already on screen.
* Artwork comes through an authenticated Home Assistant proxy with signed,
  cache-friendly URLs — the Jellyfin API key never reaches the browser.

### Playback

A full playing sheet (and a mini-player in the footer): backdrop and real
title for whatever is open — even if playback was started on the player itself
— transport with ⟲10 / 10⟳ relative seek, position advanced client-side
between polls, dB volume stepper with mute, a **Dim** toggle for the Trinnov's
own -20 dB dim, Trinnov preset and upmixer selects, and audio/subtitle track
selects that appear only when the player actually offers tracks. Every option
list is read live from the device — the card never shows a choice the hardware
would reject.

Dim is an audio feature, not a light scene: the button drives the processor's
dim switch and appears once that entity is wired to the volume device:

```yaml
devices:
  trinnov:
    entities:
      dim: switch.trinnov_altitude_14683197_dim
```

### Music and hand-off activities

A `mixed` activity (Musik) gets source pills and explanatory text; a `handoff`
or `room` activity (Streaming, Steam) shows its configured hand-off text —
"Bild und Ton sind vorbereitet, weiter auf der Fernbedienung."

## Admin panel

An admin-only **Kino** entry appears in the sidebar (the second user never
sees it). Six tabs:

| Tab | |
|---|---|
| **Aktivitäten** | The matrix editor: activities as columns, devices as rows. Every value is picked from what the device really offers — profiles, sources, presets and upmixers come from the live option lists, never free text. Add, duplicate, rename and delete activities |
| **Geräte** | Which Home Assistant entity backs each logical device — pickers filtered to the domains each driver role accepts — plus timeouts, duration estimates and the Zidoo's path mapping. Missing entities are flagged |
| **Gerätestatus** | Observed against expected, per device and per setting (Ist / Soll), plus start/stop for one device in isolation |
| **Planer** | The computed delta for any activity — stop / keep / reconfigure / start, with the reason per device — **without executing it** |
| **Verlauf** | Recent transitions with per-step timings, and the learned durations behind the ETA (resettable) |
| **Datei** | The whole document as JSON — copy to clipboard, paste back, apply |

Saving validates first: a rejected edit is never written, so the running
configuration keeps working. The previous file is kept as `kino.yaml.bak`.
Changes apply without a Home Assistant restart.

> Editing through the panel rewrites `kino.yaml`, which does not preserve
> inline comments from a hand-edited file. The backup does.

## Entities

Entity IDs derive from the config entry's device name — on a default install
they look like `select.kino_aktivitat`, on a renamed device like
`select.kino_kino_control_activity`. What exists:

| Entity | What it is for |
|---|---|
| Activity `select` | Activity selection; idempotent and interruptible — a new choice mid-transition re-targets instead of queueing |
| Status `sensor` | Plain-German status ("Beamer startet", "Bereit") with drift details as attributes |
| Progress `sensor` | Percent complete, with ETA, the bottleneck device and from/to activities |
| One `sensor` per device | Health (`off / starting / ready / stopping / degraded / unreachable / error`) plus expected settings and drift |
| Error / Degraded `binary_sensor` | Something failed / a device drifted (with device names and message) |
| Volume `number` | Volume in dB with a soft ceiling — the processor stays authoritative |
| `media_player` | Standard transport, source list = activities, artwork, IMDb/TMDb and format attributes — existing cards keep working |
| Audio/subtitle `select` per Zidoo | Live track selection, no mirror helpers, no placeholder options |
| `button` ×3 | Retry, turn everything off, refresh library |

## Services

| Service | |
|---|---|
| `kino.reload` | Re-read `kino.yaml` without restarting; an invalid file is rejected whole and the running config keeps working |
| `kino.activate` | Switch to an activity |
| `kino.dry_run` | Return the computed delta **without executing it** (responds with the action list) |
| `kino.restore_device` | Bring one drifted device back into line |
| `kino.refresh_library` | Force a Jellyfin rescan |

## Events

The existing `Kino –` automations can trigger on these instead of on
`input_select.theater_activity`:

`kino_activity_changed`, `kino_transition_started`,
`kino_transition_finished`, `kino_device_drift` (fired once per drift episode,
not once per poll).

## WebSocket API

The card and panel talk to the integration over `hass.callWS`; the same
commands are available to anything else that speaks the HA WebSocket API.
Library and room-state commands (`kino/state`, `kino/activate`,
`kino/library/search|item|resume|facets|favorite|refresh`, `kino/dry_run`,
`kino/restore_device`, `kino/dismiss_drift`) are available to any signed-in
user; the panel's commands (`kino/config/*`, `kino/device_board`,
`kino/device_test`, `kino/transition_log`, `kino/durations/reset`) require an
admin.

## Development

The activity engine has no `homeassistant` import anywhere, so the planner,
executor, state machine, drift classifier, duration estimator, config schema
and artwork signer are all testable on a plain Python install with no
hardware:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-test.txt
pytest -q          # engine, drivers, Jellyfin client, reporting
npm test           # card and panel logic
ruff check custom_components tests
```

Device drivers reach Home Assistant through one narrow `Bridge` interface, so
they are exercised against an in-memory fake state machine — including the
projector's cooldown behaviour, transcribed from ten days of recorded history.

## Documentation

* [`docs/requirements.md`](docs/requirements.md) — the requirements this is built against
* [`docs/findings.md`](docs/findings.md) — what the live system actually looks like, and the open questions
* [`docs/barco-upstream-changes.md`](docs/barco-upstream-changes.md) — changes needed in `barco-pulse-homeassistant`
* [`docs/acceptance.md`](docs/acceptance.md) — the acceptance scenarios and how to run them

## Status

Phases 1 (activity engine), 3 (media + card) and 4 (admin panel) are
implemented, including favorites, six library view modes, richer filters and
Jellyfin playback-session reporting. The panel edits the same `kino.yaml`
schema the loader reads — one format, no migration.

## Licence

MIT
