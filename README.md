# Kino — custom home theater integration for Home Assistant

[![Validate](https://github.com/pkern90/home-theater-homeassistant/actions/workflows/validate.yml/badge.svg)](https://github.com/pkern90/home-theater-homeassistant/actions/workflows/validate.yml)
[![hacs](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://hacs.xyz)

A generic **activity engine** for a home cinema, plus a responsive Lovelace
card. It replaces a pile of `start_*` scripts and mirror helpers with one
integration that computes what actually needs to change and says, in plain
German, what it is doing.

The bar it is built to: *a second person can run the cinema end-to-end from a
phone, without help, without prior knowledge, and without breaking anything.*

---

## What it does

**A differential activity engine.** Switching from Film to Netflix does not
re-run a start sequence. It computes a delta — keep the projector and the
processor, reconfigure the processor's input, stop the Zidoo, start the Shield
— and runs the independent parts concurrently. A device already in the right
state is skipped entirely.

**Readiness from observed state, never from a timer.** Timeouts exist only as
failure paths. The Barco's `ready`-means-two-things quirk is resolved from the
transition it was entered through, so the projector is never declared ready
while it is actually shutting down.

**State derived, not recorded.** After a Home Assistant restart — even
mid-transition — the activity reconciles to whatever the room is really doing
on the next poll.

**It reconciles; it does not enforce.** If somebody switches the projector off
with its own remote, the card says so, names the device and offers a one-tap
restore. It never quietly switches anything back on.

**A media catalogue that works with the cinema switched off.** Browse, search,
filter and sort come from Jellyfin over the Home Assistant WebSocket API.
Picking a title while the Film activity is off starts the activity *and then*
plays, as one action, with progress shown throughout.

## Installation

### HACS (recommended)

1. HACS → ⋮ → **Custom repositories**
2. Add `https://github.com/pkern90/home-theater-homeassistant`, category
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

## Entities

| Entity | What it is for |
|---|---|
| `select.kino_aktivitat` | Activity selection; idempotent and interruptible |
| `sensor.kino_status` | Plain-German status ("Beamer startet", "Bereit") |
| `sensor.kino_fortschritt` | Percent complete, with ETA and the bottleneck device |
| `sensor.kino_<device>` | Per-device readiness and expected settings |
| `binary_sensor.kino_fehler` | Something failed |
| `binary_sensor.kino_degradiert` | A device drifted; names it, offers a restore |
| `number.kino_lautstarke` | Volume in dB, with a soft ceiling |
| `media_player.kino` | Standard transport, so existing cards keep working |
| `select.kino_tonspur` / `_untertitel` | Live track selection, no mirror helpers |
| `button.kino_*` | Retry, turn everything off, refresh library |

## Services

| Service | |
|---|---|
| `kino.reload` | Re-read `kino.yaml` without restarting |
| `kino.activate` | Switch to an activity |
| `kino.dry_run` | Show the computed delta **without executing it** |
| `kino.restore_device` | Bring one drifted device back into line |
| `kino.refresh_library` | Force a Jellyfin rescan |

## Events

The existing `Kino –` automations can trigger on these instead of on
`input_select.theater_activity`:

`kino_activity_changed`, `kino_transition_started`,
`kino_transition_finished`, `kino_device_drift`.

## Development

The activity engine has no `homeassistant` import anywhere, so the planner,
executor, state machine, drift classifier and config schema are all testable
on a plain Python install with no hardware:

```bash
python -m venv .venv && .venv/bin/pip install -r requirements-test.txt
pytest -q          # engine, drivers, Jellyfin client
npm test           # card logic
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

Phase 1 (activity engine) and Phase 3 (media + card) are implemented. The
admin panel (Phase 4) is deliberately deferred — `kino.yaml` is the contract,
and the panel will be an editor over exactly that schema.

## Licence

MIT
