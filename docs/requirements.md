# Requirements — Custom Home Assistant Integration "Kino"

**Status:** Draft v0.8 — requirements collection
**Date:** 2026-08-08
**Owner:** Patrick

---

## 1. Purpose

Replace the current script-and-helper-based home theater control with a custom Home
Assistant integration (`custom_components/kino`) **plus a custom Lovelace card**, together
owning:

- a **generic activity engine** — arbitrary activities, each with its own device set,
  inputs and profiles, with intelligent transitions between them,
- the **device drivers** (Barco, Trinnov, Zidoo, madVR, Shield, Apple TV),
- **Zidoo media control** — library browsing, advanced search and filtering, playback,
  audio and subtitle tracks,
- the **browsing UI**, responsive across phone and tablet,
- an **admin panel in the HA sidebar** where all of the above is configured and diagnosed.

The success criterion is not feature count. It is: **a second person can run the cinema
end-to-end from a phone, without help, without prior knowledge, and without breaking
anything.**

### 1.1 Non-goals

- Room lighting and climate orchestration stay where they are (existing `Kino –` automations).
  The integration **publishes** state and events; the automations keep consuming them.
- No external media server. The Zidoo's own library API is the single source of truth.
- No replacement of the media library itself (NFS share stays as-is).
- Content control *inside* streaming apps is out of scope — Netflix on the Shield is driven
  by the Shield's own physical remote. The integration gets you to the app, correctly
  configured; from there the remote takes over.
- No voice control in this iteration.

---

## 2. Decisions taken

| # | Decision |
|---|---|
| D1 | The integration owns the activity engine, the device drivers **and** Zidoo control — the `start_*` scripts are replaced, not wrapped |
| D2 | ~~Zidoo library API only~~ → **Jellyfin as a headless catalogue + Jellystat for history** (§6). Jellyfin is deployed and connected |
| D3 | A **custom Lovelace card** is in scope |
| D4 | Operated from the **phone dashboard**; the card must also render well on **tablets** |
| D5 | Operating concept is **full browsing**, not a single "watch a film" button |
| D6 | **Activities are generic**, not hardcoded. Film/Zidoo, Netflix, Musik, Steam are configuration, not code |
| D7 | **No cache in the integration.** Jellyfin is the index and the artwork server — cold-starting a title from a browse-while-off state comes back for free |
| D8 | Caching is nevertheless permitted **where it buys smoothness** — thumbnails in particular |
| D9 | Configuration is ultimately edited in a **custom admin panel in the HA sidebar** (HACS / VS Code Server style) — but the panel is **deferred**: Phase 1 reads a config file (§10.3, §14) |
| D10 | The **hard** volume limit is configured in the **Trinnov itself**. Home Assistant's clamp is UX safety only |
| D11 | The Barco integration is **Patrick's own** (`piemkay/barco-pulse-homeassistant`) — projector shortcomings get fixed upstream rather than worked around |
| D12 | Watch history is tracked centrally in **Jellyfin**, surfaced by **Jellystat**; the Zidoo is the first play-state source, others follow |

---

## 3. Personas

| | **Patrick (owner)** | **Second user (primary target)** |
|---|---|---|
| Knowledge | Full stack, entity IDs, YAML | None. Does not know what a "Trinnov" is |
| Device | Phone + HA admin | Phone dashboard |
| Tolerance for silence | Knows the Barco takes 6 min | Assumes broken after 10 seconds |
| Recovery when stuck | Reads traces | Gives up, waits for Patrick |
| Needs | Everything | Pick an activity, browse, search, filter, play, volume, subtitles, off |

**Design rule:** every requirement below is judged against the second persona. If a
feature only works when you already know how it works, it does not meet the bar.

---

## 4. As-is inventory

### 4.1 Devices and entities

| Role | Entities |
|---|---|
| Projector | `switch.hodr_cs_power`, `sensor.hodr_cs_state`, `select.hodr_cs_profile`, `sensor.hodr_cs_current_source`, `sensor.hodr_cs_laser_power`, `binary_sensor.hodr_cs_power` |
| Processor | `remote.trinnov_altitude_14683197`, `media_player.…`, `select.…_source` / `_preset` / `_upmixer`, `switch.…_mute`, `sensor.…_decoder` / `_volume` |
| Player | `media_player.uhd8000`, `remote.uhd8000`, `rest_command.zidoo_api` |
| Video processor | `remote.madvr_envy` |
| Other sources | `media_player.shield_kino_2`, `media_player.shield_kino_3`, `media_player.appletv` |
| Light | `light.kino_vorhang`, `light.kino_decken_led`, `light.kino_screen_led`, `light.kino_deckenspots`; `scene.dark`, `scene.low_ambience`, `scene.bright_ambience` |
| Climate / air | `climate.kino_heizung`, `sensor.kino_temperatur`, `sensor.kino_luftfeuchte`, `sensor.kino_co2`, `sensor.kino_voc_cast` |
| Presence | `binary_sensor.kino_prasenz` |
| Aggregate | `media_player.kino_is_playing_state` |

### 4.2 Logic

- **Scripts:** `activate_zidoo_activity`, `activate_gaming_activity`, `turn_theater_off`,
  `start_trinnov`, `start_barco`, `start_zidoo`, `start_madvr`, `kino_tracks_einlesen`,
  `kino_untertitel_aus`
- **Helpers:** `input_select.theater_activity`, `input_select.kino_untertitel`,
  `input_select.kino_tonspur`, `input_boolean.kino_tracks_sync`, `input_text.kino_suche`
- **Automations (11):** light on play / pause / on entering, ventilation boost + re-boost,
  three track-sync automations, runtime warning (6 h / 10 h), shutdown from notification

### 4.3 Findings — why this needs replacing

| # | Finding | Evidence |
|---|---|---|
| F1 | **No progress feedback during long transitions.** A tap can be followed by up to 8 minutes of nothing | `start_barco` waits up to `00:08:00` for cooldown, then `00:02:00` for `on` |
| F2 | **Repeat taps are silently discarded.** Looks broken precisely when it is working | `mode: single`, `max_exceeded: silent` on all activity scripts |
| F3 | **Activity state is recorded, not observed.** Set at the *end* of the script; a restart, a failure, or a device switched on by its own remote leaves it lying | `input_select.select_option` is the last step of each activity script |
| F4 | **Transitions are not differential.** Switching activities re-runs a full start sequence rather than computing what actually needs to change | `activate_*_activity` scripts call the same `start_*` scripts unconditionally |
| F5 | **Waiting is partly time-based.** Fixed delays sit alongside genuine state waits | `delay: 500 ms` in `kino_tracks_einlesen`; fixed settle waits in the start scripts |
| F6 | **Errors are invisible to the person in the room** | `persistent_notification.create` in `turn_theater_off`; `notify.notify` in the runtime warning |
| F7 | **Track selection is race-prone by construction** | `input_boolean.kino_tracks_sync` mutex + fixed delay |
| F8 | **Search is a text field plus URL templating.** No results in the dashboard; it deep-links into HA's media browser modal | markdown card templating `/media-browser/…{{ q \| urlencode }}*` |
| F9 | **Only two activities exist.** Netflix, music and the Apple TV have no activity at all | `input_select.theater_activity` options |
| F10 | **Shutdown does not restore the room** | `turn_theater_off` touches no lights |
| F11 | **Adding a source touches four places** | script + input_select options + dashboard cards + light automations |
| F12 | **Duplicate Shield entities; the aggregate and the dashboard disagree** | group references `shield_kino_3`, dashboard tile shows `shield_kino_2`; both exist, both `off` |
| F13 | **The remote and library sections vanish when the player is off** | `visibility:` conditions on `remote.uhd8000` |

---

## 5. The activity model

This is the heart of the integration.

### 5.1 Concept

An **activity** is a named, declaratively configured target state of the room:

```yaml
activities:
  film:
    name: "Film"
    devices:
      barco:    { power: on, profile: "HDR 260 HDMI" }
      trinnov:  { power: on, source: <TBD>, preset: <TBD>, upmixer: <TBD>, volume: -30.0 }
      madvr:    { power: on }
      zidoo:    { power: on }
    light_scene: scene.dark
    media: zidoo          # this activity owns a browsable library
  netflix:
    name: "Netflix"
    devices:
      barco:    { power: on, profile: <TBD> }
      trinnov:  { power: on, source: <TBD>, preset: <TBD>, volume: <TBD> }
      madvr:    { power: on }
      shield:   { power: on, app: netflix }
    light_scene: scene.dark
    media: none           # controlled by the Shield's own remote
  musik:
    name: "Musik"
    devices:
      trinnov:  { power: on, source: <TBD>, preset: <TBD>, upmixer: <TBD> }
      # projector and madVR deliberately absent
    light_scene: scene.low_ambience
    media: <TBD>
  steam:
    name: "Steam"
    devices:
      barco:    { power: on, profile: "HDR 260 DP" }
      trinnov:  { power: on, source: <TBD>, preset: <TBD> }
      # madVR bypassed on DP
    light_scene: scene.dark
    media: none
```

- **FR-1** Activities SHALL be **defined in configuration**, not code. Adding one SHALL
  require no Python changes and no new scripts.
- **FR-2** Each activity SHALL define, per device: whether it is required, its power target,
  and its **per-activity settings** — Trinnov source / preset / upmixer / reference volume,
  Barco profile, madVR profile, Shield app, and so on.
- **FR-3** The activity set at launch SHALL be: **Film (Zidoo)**, **Netflix (Shield)**,
  **Musik**, **Steam**, **Aus**. The Apple TV is a candidate — see §10 Q1.
- **FR-4** The **activity matrix in §5.5 SHALL be filled in before implementation.** It is the
  actual specification; everything else is machinery.

### 5.2 Differential transitions

- **FR-10** On an activity change the integration SHALL compute a **delta** between the
  current observed state and the target activity, and then:
  - **stop** devices the target activity does not need,
  - **keep** devices needed by both, without power-cycling them,
  - **reconfigure** kept devices whose settings differ (input, profile, preset, volume),
  - **start** devices the target activity needs that are not yet running.
- **FR-11** A device already in the correct state SHALL be **skipped entirely** — no redundant
  commands, no unnecessary waiting.
- **FR-12** Stops, reconfigurations and starts SHALL run **concurrently** wherever no real
  dependency forces ordering.
- **FR-13** Switching from a cold state (`Aus`) SHALL use the same code path as switching
  between two active activities — a start is just a delta from the empty set.
- **FR-14** Playback on an outgoing media device SHALL be stopped cleanly before that device
  is powered down.

### 5.3 Intelligent startup orchestration

Explicitly **not** a sequence of fixed waits.

- **FR-20** Readiness SHALL be determined from **observed device state**, never from a timer.
  Timers exist only as **timeouts**, not as the success path.
- **FR-21** The integration SHALL model per-device **dependencies** and honour only real ones
  (e.g. the Trinnov must be on before its source can be set). Independent devices start in parallel.
- **FR-22** The **critical path SHALL be started first.** The Barco dominates every transition
  it participates in (cooldown up to ~6 min, warm-up ~1–2 min); it must be kicked off before
  faster devices, not in list order.
- **FR-23** The integration SHALL wait only for devices the **target activity actually requires**.
  A Musik activity SHALL NOT wait on the projector.
- **FR-24** The integration SHALL **learn actual durations** from observed history per device and
  transition type, and use them for the ETA shown to the user — rather than hardcoded estimates.
- **FR-25** The Barco's **`ready` ambiguity SHALL be preserved as a first-class driver concern**:
  the device reports `ready` during both warm-up and shutdown. The driver must resolve the
  true phase before acting. This is the single most bug-prone behaviour in the system.
- **FR-26** If a device is already warm or already correct, the transition SHALL complete
  correspondingly faster — no artificial floor.

### 5.4 State machine

- **FR-30** The integration SHALL expose one primary entity with an explicit state:
  `off`, `starting`, `switching`, `on`, `stopping`, `error`.
- **FR-31** State SHALL be **derived from observed device state**, not written after the fact.
  After an HA restart mid-transition, state SHALL reconcile to reality within one poll cycle.
- **FR-32** Transitions SHALL be **idempotent and interruptible**: selecting the active activity
  is a no-op; selecting a different one mid-transition SHALL re-target, not queue or drop.
- **FR-33** Per-device status SHALL be individually observable (`starting` / `ready` / `error`)
  so the UI can show which device is holding things up.
- **FR-34** Shutdown SHALL be **best-effort per device with explicit verification** — one
  unreachable device SHALL NOT block the others, and an unverified shutdown SHALL raise a
  visible error.
- **FR-35** Shutdown SHALL restore the room to a defined light state.

### 5.5 Activity matrix — TO BE COMPLETED

| | **Film (Zidoo)** | **Netflix (Shield)** | **Musik** | **Steam** | **Aus** |
|---|---|---|---|---|---|
| Barco power | on | on | **off** | on | off |
| Barco profile | HDR 260 HDMI | **TBD** | – | HDR 260 DP | – |
| Trinnov power | on | on | on | on | off |
| Trinnov source | **TBD** | **TBD** | **TBD** | **TBD** | – |
| Trinnov preset | **TBD** | **TBD** | **TBD** | **TBD** | – |
| Trinnov upmixer | **TBD** | **TBD** | **TBD** | **TBD** | – |
| Reference volume | −30.0 (current) | **TBD** | **TBD** | **TBD** | – |
| madVR | on | **TBD** | off | bypassed (DP) | off |
| Zidoo | on | off | **on** (streamer role) | off | off |
| Shield | off | on | off | off | off |
| Apple TV | off | off | off | off | off |
| Light scene | dark | dark | **TBD** | dark | **TBD** |
| Control class | full | hand-off | mixed | room only | – |
| Media browsing | yes (Jellyfin) | no (own remote) | Spotify yes / Tidal no | no | – |

### 5.6 State drift and out-of-band changes

Reconciliation is not only a boot-time concern. Devices change state on their own.

- **FR-36** The coordinator SHALL monitor for drift **continuously while an activity is active**,
  not only at startup.
- **FR-37** Drift SHALL be **classified**, not treated uniformly:

  | Class | Example | Response |
  |---|---|---|
  | **Benign** | Shield idle-sleeps with nothing playing | Stay `on`; mark the device dormant; wake on demand |
  | **Deliberate** | Someone powers a device off with its own remote | Follow the user: `on (degradiert)`, name the device, offer restore. **Never** silently re-power |
  | **Transport** | Device becomes `unavailable` (network/host down) | `on (gestört)`, retry with backoff, surface after N failures |
  | **Fatal in transition** | A required device fails mid-start | `error` plus recovery action |

- **FR-38** **The integration SHALL NOT fight the user.** It SHALL NOT automatically re-apply a
  state a person has just deliberately changed. Per-device auto-correction MAY exist but SHALL
  be opt-in and off by default. (This is the difference between reconciliation and enforcement —
  enforcement is how smart homes become haunted houses.)
- **FR-39** `degraded` SHALL be a **visible sub-state** that names the affected device, with a
  one-tap "Wiederherstellen" action.
- **FR-39a** Drift detection SHALL be **debounced**, so a device's own transient states do not
  flap the activity state.

---

## 6. Media source — Jellyfin (headless) + Jellystat

**Direction:** deploy Jellyfin on Proxmox as a **catalogue, metadata and artwork API** — not as
a player. Note that Jellyfin has no true headless mode; the web UI is always installed and is
needed for initial setup. "Headless" here means *nobody in the household ever opens it*. The
Kino card is the only frontend anyone sees.

This resolves the tension in v0.5: the catalogue becomes independent of whether the Zidoo is
powered, which restores browse-while-off and cold-start, and removes the need for the
integration to build its own index or thumbnail cache.

### 6.1 Current state — verified

Jellyfin is running at `jellyfin.local.7labs.dev` and connected to Home Assistant via the
official `jellyfin` integration (config entry loaded). Verified live:

| Finding | Detail | Consequence |
|---|---|---|
| Three libraries exist | **Movies**, **Music**, **Shows** | Music was not expected — see §6.5 |
| Music is fully scanned | ~200 artists, most with artwork | Ready to use |
| **Movies shows only 2 items** | "10 Cloverfield Lane" and one other | **Scan still in progress** — not a fault. Re-verify once it finishes |
| One movie has no artwork | The Guardians of the Galaxy Holiday Special (2022) | Metadata match failure — the kind of gap FR-47 must flag |
| **`can_search: false`** on every node | HA's Jellyfin media source exposes browse only | Confirms the custom integration needs its own Jellyfin API client |
| The integration exposes one entity | `sensor.jellyfin_active_clients` (0) | Plus `media_player` entities per connected Jellyfin *client* — none exist yet |
| Thumbnail URLs embed the API key | `…/Items/{id}/Images/Primary?…&api_key=…` | **Security:** these URLs must not be surfaced in a shared or externally reachable dashboard. The card SHALL proxy artwork rather than embed keyed URLs (FR-42a) |

**Architectural consequence:** the official HA Jellyfin integration is useful for connectivity
and diagnostics, but not as the data path. Its media source cannot search, and its
`media-source://jellyfin/...` content IDs address *Jellyfin* playback — whereas playback here
goes to the Zidoo. The Kino integration SHALL therefore hold its **own Jellyfin API client**
and treat the official integration as coexisting, not load-bearing.

- **FR-39z** The Kino integration SHALL NOT depend on the official `jellyfin` integration for
  catalogue, search, artwork or play-state. It MAY coexist with it.
- **FR-42a** Artwork SHALL be served through an authenticated proxy in the integration. Keyed
  Jellyfin image URLs SHALL NOT be embedded in card markup.

### 6.2 Deployment on Proxmox

Both pieces exist as community scripts:

| | Script | Notes |
|---|---|---|
| Jellyfin | `community-scripts.org/scripts/jellyfin` — LXC, updateable | Needs the NAS share mounted into the container. No GPU/transcoding needed: nothing streams through it |
| Jellystat | `tools/addon/jellystat.sh` — an **addon**, not its own LXC | Installs into an existing container. Needs Node 20+ and PostgreSQL (auto-installed), listens on **3000** |

**Verify before committing (§15 Q14):** a January 2026 issue reported the Jellystat script
failing on Debian 13, and there are community reports of Jellystat's full sync misbehaving
against newer Jellyfin releases. Jellyfin 12.x also changed enough that the install script
carries migration warnings. **Streamystats** is the fallback if Jellystat won't cooperate.

### 6.3 Division of responsibility

| Concern | Owner |
|---|---|
| Catalogue, metadata, artwork, facets | **Jellyfin** |
| Playback | **Zidoo** (unchanged) |
| Watch history, resume points | **Jellyfin** (written by the integration) |
| Historical statistics, dashboards | **Jellystat** |
| Orchestration, UI | **Kino integration + card** |

- **FR-40** The media source SHALL sit behind an **internal interface**. Jellyfin is the chosen
  implementation, not an assumption baked into the card or the activity engine.
- **FR-41** Jellyfin SHALL be reachable independently of the theater's power state; browse,
  search and filter SHALL work with everything off. The card SHALL show the library home in
  its off state, and the detail view's play button SHALL read as "start the theater and play"
  (the FR-55 flow) rather than pretending playback alone is possible.
- **FR-42** Artwork SHALL be served from Jellyfin. The integration SHALL NOT build a thumbnail
  cache of its own.
- **FR-43** No transcoding path SHALL be relied upon — Jellyfin never touches the video.
- **FR-44** A **force-refresh / rescan** action SHALL be exposed. NAS disks spin down and a first
  read can fail; the second user needs a retry that does not involve an admin.
- **FR-45** A failed or stale catalogue read SHALL degrade to a plain-German message plus that
  refresh action — never a blank grid.

### 6.4 The join key — better than expected

Both sides already carry provider IDs:

- The Zidoo entity exposes `media_imdb_id` (`tt1179933`) and `media_tmdb_id` (`333371`) as
  attributes, alongside `media_uri` (`/mnt/nfs/192.168.50.10#entertainment/movies/…`).
- Jellyfin items carry `ProviderIds` and `Path`.

- **FR-46** Catalogue entries SHALL join to a Zidoo-playable target on **provider ID first**
  (TMDB/IMDb), falling back to file path. Provider ID is the more stable key — it survives a
  mount-point change; the path does not.
- **FR-47** Unmatched items SHALL be **visibly flagged**, never silently unplayable. An entry the
  card offers must actually play.

### 6.5 Musik — resolved

Music is normally streamed from **Tidal or Spotify with the Zidoo as the playback device**; the
local library is the secondary path. The UHD8000 is a competent streamer in its own right: it
<cite index="38-1">supports Tidal Connect, Spotify Connect, AirPlay, Qobuz Connect, DLNA, Roon and
UPnP</cite>, and — decisively for this activity — <cite index="38-1">its streaming services are
available at boot without any interaction, so it can be used with no TV at all</cite>.

**Consequences:**

- Musik needs **no projector and no madVR**. Trinnov + Zidoo only. It is the fastest activity in
  the system and the cleanest proof that the differential planner works (A3/A4).
- **Spotify** is drivable from the card: Home Assistant's Spotify integration can browse and
  search, and Connect lets the Zidoo be selected as the playback target. Real in-card control.
- **Tidal** has no Home Assistant integration. It follows the Netflix pattern — the integration
  prepares the room, the person casts from the Tidal app on their phone.
- Neither produces Jellyfin history. FR-49c already forbids fabricating entries; Spotify keeps
  its own.

- **FR-47a** Musik SHALL support **multiple sources within one activity** — Spotify, Tidal and the
  local Jellyfin library — rather than being split into separate activities.
- **FR-47b** Where a source is Connect-based, the integration SHALL ensure the Zidoo is the
  selected playback target as part of activating Musik, so no manual device-picking is needed.
- **FR-47c** Play state from Connect sources SHALL NOT be reported into Jellyfin.

### 6.5.1 A control-class model for every activity

The Musik split generalises. Each activity falls into one of three honest classes, and the card
must say plainly which one applies rather than implying control it does not have:

| Class | Meaning | Activities |
|---|---|---|
| **Full control** | The card browses, searches and plays | Film (Zidoo/Jellyfin), Musik via Spotify |
| **Hand-off** | The integration prepares the room; content is driven elsewhere | Netflix (Shield remote), Musik via Tidal (phone app) |
| **Room only** | No content control at all, by nature | Steam |

- **FR-47d** Each activity SHALL declare its control class in configuration, and the card SHALL
  render accordingly — a hand-off activity SHALL show a clear "weiter auf der Fernbedienung /
  in der App" state instead of an empty or broken-looking browser.

### 6.6 Play-state sync

The integration acts as a **synthetic Jellyfin client on behalf of the Zidoo**, reporting through
the same endpoints every real client uses (`POST /Sessions/Playing`, `/Sessions/Playing/Progress`,
`/Sessions/Playing/Stopped`). Third-party apps do exactly this today; the pattern is standard.

| Source | How play state is captured | Effort |
|---|---|---|
| **Zidoo** | Synthetic reporting from the HA entity's `media_position`, `media_uri` and provider IDs | The work below |
| Shield / Apple TV running the **Jellyfin app** | Native. Reports itself | Free |
| **Netflix, Disney+, streaming** | Impossible — no API, no data | Coarse HA-side record only |
| Steam | Out of scope | – |

- **FR-48** The integration SHALL report Zidoo playback to Jellyfin under a distinct device
  identity (e.g. "Kino – Zidoo"), covering **start, progress, pause/resume and stop**, so watch
  history, resume points and Jellystat all see it as a first-class session.
- **FR-49** Progress SHALL be reported on a cadence frequent enough for Jellystat's session
  polling to sample it (~10 s, matching what real clients do). An item SHALL be marked watched at
  the configured completion threshold.
- **FR-49a** Resume position SHALL be read back from Jellyfin so "Weitersehen" works across
  sources — this is what makes multi-platform sync meaningful rather than cosmetic.
- **FR-49b** **Jellyfin is the system of record** for watched state and resume position. Where the
  Zidoo keeps its own progress, Jellyfin wins. (This reverses v0.5's FR-42.)
- **FR-49c** Activities that cannot be tracked (Netflix, Steam) SHALL NOT produce fabricated
  Jellyfin entries. A coarse activity log in Home Assistant is acceptable; fake sessions are not.
- **FR-49d** **Spike required:** confirm what authentication the reporting endpoints accept.
  An API key may not be sufficient — some play-state endpoints require a real user token or a
  registered device session. This is the one genuine unknown in the design.

---

## 7. Media browsing, search and filtering

- **FR-50** The library SHALL be browsable by: Movies, TV Shows, Recently Added,
  Continue Watching, Unwatched, 4K.
- **FR-51** **Advanced search** SHALL return results with poster, title and year, incrementally
  as the user types, with sensible handling of partial and multi-word queries.
- **FR-51a** Every grid tile SHALL carry both scores that exist for it — the community
  rating and the critics rating — in its meta line. A community 7.2 and a critics 40 % are
  two different evenings, and the point of a grid is to choose without opening anything.
- **FR-52** **Advanced filtering** SHALL be available and combinable. Baseline:
  watched/unwatched, resolution, recently added. Further facets (genre, collection, year,
  rating, runtime, audio format) are **subject to the API spike** — included if the Zidoo API
  supports them, explicitly dropped if not. Shipped: watched/unwatched/resumable, favorites,
  resolution tiers (4K/HD/SD, mutually exclusive) plus 3D, genres, FSK parental ratings
  (`OfficialRatings`), and a year from–to range. Countries stay dormant — Jellyfin has no
  server-side parameter and a client-side cut breaks pagination.
- **FR-52a** Cast and crew SHALL be filterable by name, offered from the catalogue's own
  `/Persons` rather than as free text, with several names combinable and individually
  removable. Several people narrow (AND), like stacked genre chips — and Jellyfin can
  express neither AND nor OR here: asked for two `|`-joined `PersonIds` the live server
  dropped the filter and answered with 643 of 620 films. One name goes server-side, where
  it is exact; several are asked for one at a time and intersected.
- **FR-52b** Audio-track **and** subtitle-track languages SHALL each be their own filter, and
  SHALL be honest about what a title can be watched in: every track counts, not just the
  first; a title with two German mixes is German once; a commentary or audio-description
  track is not a language the title exists in; and `ger`/`deu`/`de`/`de-DE` are one value.
  A series carries no streams of its own, so it is lent the union of its episodes'
  languages (one sweep, cached far longer than a page scan, with its own timeout budget;
  a failed sweep degrades to no series languages, never to a broken filter).
- **FR-52c** A facet group SHALL show its most common values first and keep the long tail
  behind one tap — this library has 63 subtitle languages. Every group SHALL start folded,
  remembering only which ones the user unfolds.
- **FR-53** Sorting SHALL be available (title, year, date added, at minimum). Shipped: title,
  year, date added, community rating, runtime, last played, critics rating and random, each
  with an ascending/descending override (per-field default direction otherwise). Random
  re-randomises per page — repeats under infinite scroll are accepted.
- **FR-53a** Favorites SHALL round-trip: `IsFavorite` is read with every item, surfaced in the
  card, and written back to Jellyfin via `kino/library/favorite`
  (`POST`/`DELETE /Users/{userId}/FavoriteItems/{itemId}`) — per Jellyfin account, not per
  HA user.
- **FR-54** Playback SHALL be startable from any browse or search result in **one tap**.
- **FR-55** Selecting a title while the Film activity is not running SHALL **start the activity
  and then play** — a single user action, with progress shown throughout.
- **FR-56** Rich metadata from the player (title, poster, duration, position, video format
  e.g. `3840X2160P @ 23.976Hz … HDR10`, audio format, TMDB/IMDB id, tagline) SHALL be
  surfaced in a detail view.
- **FR-56a** The detail view SHALL list **every** audio and subtitle track the file carries —
  language, channel layout, codec, the default one first, commentaries and forced subtitles
  marked — because the one-line audio format names the first stream only, and whether a
  disc has a German mix is what decides whether tonight works. Each column SHALL show its
  first three and keep the rest one tap away: a 21-track remux otherwise pushes the cast
  row and everything under it off the bottom of the sheet. A commentary SHALL never take
  one of those three slots.
- **FR-56b** A trailer, where the catalogue knows one, SHALL be watchable from the detail
  view on the phone, with the room off. Jellyfin's trailers are links to YouTube and the
  like, so this opens a browser tab rather than pretending Kino can stream them.
- **FR-56c** Watched state SHALL be settable and unsettable from the card for a film, for a
  single episode and for a whole season (`POST`/`DELETE /Users/{userId}/PlayedItems/{itemId}`,
  which Jellyfin cascades from a season to its episodes). The season strip's remaining-count
  and the episode rows SHALL both reflect the change without a reload.
- **FR-57** **Thumbnail caching/proxying SHALL be implemented** if it is needed for a smooth
  grid — this is explicitly permitted (D8). Metadata caching is optional and performance-driven
  only; there is no offline-browsing requirement (D7).
- **FR-58** Library queries SHALL be paginated / lazily loaded so the first screen renders fast
  regardless of library size.

---

## 8. Playback, tracks and volume

- **FR-60** Audio track and subtitle track SHALL be exposed as **`select` entities backed by
  live player state** — no mirror helpers, no sync mutex, no fixed delays.
- **FR-61** Track lists SHALL refresh automatically on playback start and on media change.
- **FR-62** Subtitles SHALL have an explicit, always-present **"Aus"** option.
- **FR-63** Transport controls (play/pause, seek, next/previous, stop) SHALL be exposed via
  the standard `media_player` interface so standard cards keep working.
- **FR-64** Volume SHALL be adjustable in **relative steps**, shown in human-readable form.
  Home Assistant SHALL apply a **soft ceiling** as UX safety — but the **authoritative hard limit
  belongs in the Trinnov's own configuration** (D10). Given the output capability of the Theory /
  Perlisten array, a software clamp in HA is defence in depth, not the defence.
- **FR-64a** Trinnov volume SHALL be treated as **authoritative**: after every set the integration
  SHALL read back the actual value. A request the Trinnov rejects or clamps SHALL NOT leave the UI
  showing the requested value, and SHALL NOT be surfaced as an error — a graceful bounce-back is
  correct behaviour, not a fault.
- **FR-65** Volume and mute SHALL work in **every** activity, including those with no media
  control (Netflix, Steam) — this is the one control the second user will always reach for.

---

## 9. The custom card

- **FR-70a** The library home SHALL carry a **Favoriten** row beside Weitersehen and Zuletzt
  hinzugefügt, films and series together, with a way into the full filtered list.
- **FR-70** A custom Lovelace card SHALL provide in one place: activity selection, poster grid,
  search field, filter and sort controls, detail view with play button, and a "Weitersehen" row.
  The library home additionally carries a "Zuletzt hinzugefügt" row.
- **FR-71** The card SHALL be **responsive**: a one-handed single-column layout on a phone,
  a denser multi-column grid on a tablet. Same card, same code, breakpoint-driven.
- **FR-71a** The grid SHALL offer Jellyfin's six view modes (Poster, Posterkarte, Vorschau,
  Vorschaukarte, Banner, Liste), persisted per browser in localStorage. Banner falls back
  Banner→Backdrop→Primary since movie banner art is rare.
- **FR-72** Primary actions SHALL be thumb-reachable on a phone; no horizontal scrolling;
  no tap targets below platform minimums.
- **FR-73** The card SHALL show theater status, the active activity and transition progress
  **inline**, including which device is currently the bottleneck.
- **FR-74** The card SHALL expose volume, mute, subtitles and audio track during playback
  without navigating away.
- **FR-75** The card SHALL degrade gracefully: when the library is unreachable or an activity
  has no media, it says so in plain German rather than rendering blank.
- **FR-75a** The card SHALL expose the **force-refresh** action (FR-44) directly, so a failed
  first library read after NAS spin-up is recoverable by the second user without help.
- **FR-76** The card SHALL fit the existing `dashboard-mobile` style (Mushroom-based, sections
  layout, German labels).
- **FR-77** Distribution: installable alongside the integration (single repo; registered as a
  Lovelace resource by the integration where possible).

---

## 10. Admin panel

A dedicated **admin panel in the Home Assistant sidebar**, in the style of HACS or the
VS Code Server add-on — the single place where the theater is configured and diagnosed.

*Rationale:* HA's options flow is a stepwise dialog. It cannot express the activity matrix
(§5.5) — a grid of activities × devices × settings — nor live diagnostics or a transition
log. The panel is not decoration: without it, FR-1 ("activities are configuration, not code")
has no usable editor.

- **FR-100** The integration SHALL register a **custom panel** in the HA sidebar (own icon,
  German title), served by the integration itself — no add-on, no separate installation.
- **FR-101** The panel SHALL be **admin-only** (`require_admin`). The second user SHALL never
  see it; her surface is the card and nothing else.
- **FR-102** The panel SHALL talk to the integration over the HA **WebSocket API** with live
  updates — no polling, no page reloads.
- **FR-103** The panel SHALL share its component library and design language with the custom
  card (§8) — one repository, one build, one visual style.

### 10.1 Activity editor — the primary function

- **FR-110** The panel SHALL provide a **matrix editor** for §5.5: activities as columns,
  devices and settings as rows. Add, rename, reorder, duplicate and delete activities.
- **FR-111** For each activity × device it SHALL configure: required or not, power target, and
  every per-activity setting (Trinnov source / preset / upmixer / reference volume, Barco
  profile, madVR profile, Shield app, …).
- **FR-112** Settings SHALL be chosen from **live device values** — dropdowns populated from the
  actual `select` option lists and source lists. Never free-text entry of a profile name.
- **FR-113** The editor SHALL configure the **expected state** per device: which entity and which
  value constitute "ready", the timeout, and where relevant the ambiguity rule (the Barco's
  `ready`-during-cooldown case, FR-25).
- **FR-114** It SHALL configure per-activity light scene, media backend (Zidoo / none), icon and
  display name.
- **FR-115** Changes SHALL be validated before saving (unknown entity, impossible profile, device
  required by no activity, unreachable expected state) and SHALL apply **without an HA restart**.

### 10.2 Diagnostics and testing

- **FR-120** A **live device board** SHALL show per device: observed state, expected state for the
  active activity, readiness, and last error.
- **FR-121** A **dry-run planner** SHALL show the computed delta for any "from activity → to
  activity" pair — stop / keep / reconfigure / start — **without executing it**. This is how
  FR-10 gets verified, and how a new activity is sanity-checked before first use.
- **FR-122** A **transition log** SHALL record recent transitions with per-step timings and
  outcomes, so a slow or failed switch can be diagnosed afterwards.
- **FR-123** **Learned durations** (FR-24) SHALL be visible per device and transition type, and
  resettable.
- **FR-124** A **single-device test** action SHALL start, stop or reconfigure one device in
  isolation.

### 10.3 Everything else that belongs here

- **FR-130** Device connection settings: endpoints, credentials, timeouts, and which HA entity
  backs each logical device.
- **FR-131** Safety and UX settings: maximum volume ceiling (FR-64), volume step size, preferred
  audio and subtitle language (§15 Q6), shutdown light scene.
- **FR-132** Card settings: default sort, which filters are exposed, grid density per breakpoint.
- **FR-133** A **Zidoo API explorer**: issue a call, inspect the response, confirm which facets
  exist. Serves the Phase 0 spike and every later debugging session.
- **FR-134** **Export and import** of the entire configuration as YAML/JSON — for backup and for
  keeping it under version control.

---

## 11. Cross-cutting requirements

### 11.1 Feedback and errors

- **FR-80** Every failure SHALL surface **on the entity and in the card**, in German, in plain
  language ("Beamer antwortet nicht"), not only as a notification to Patrick's phone.
- **FR-81** Every error state SHALL offer a **recovery action** ("Nochmal versuchen",
  "Alles ausschalten") reachable from the same screen.
- **FR-82** Slow operations SHALL communicate expected duration up front, using learned
  estimates (FR-24).
- **FR-83** The integration SHALL log enough detail for diagnosis without the user seeing it.

### 11.2 Existing automations

- **FR-84** The integration SHALL fire events / expose state transitions the existing `Kino –`
  automations can trigger on, replacing their dependence on
  `media_player.kino_is_playing_state` and `input_select.theater_activity`.
- **FR-85** A migration path SHALL be defined for the 11 existing automations: absorbed,
  rewired, or retired.
- **FR-86** The runtime-warning automation (6 h / 10 h with shutdown action) SHALL keep
  working, ideally driven by the integration's own uptime sensor.

### 11.3 Configuration

- **FR-90** Initial setup SHALL use a **config flow** covering connection only.
- **FR-91** The activity matrix and device definitions SHALL be held in a **single declarative
  config document** (JSON or YAML) with a **formally specified schema**. The schema is the
  contract; the admin panel (§10) is later just an editor over it.
- **FR-92** The config SHALL be **validated on load** against that schema, with errors naming the
  offending activity, device and field. Without a GUI, a typo must fail loudly and specifically.
- **FR-93** A **`kino.reload` service** SHALL re-read the config without an HA restart.
- **FR-94** Once the admin panel exists, it SHALL read and write **this same schema** — no second
  format, no migration.

### 11.4 Non-functional

- **NFR-1 Responsiveness.** Any tap SHALL produce visible UI feedback in **< 500 ms**, even
  when the underlying operation takes minutes. Poster grid scrolling SHALL stay smooth.
- **NFR-2 Robustness.** No unhandled exception SHALL leave the state machine stuck. A stuck
  transition SHALL time out into `error` with a recovery action.
- **NFR-3 Restart safety.** State SHALL be reconstructed from devices after an HA restart.
- **NFR-4 No blocking.** Fully async; no blocking I/O in the event loop.
- **NFR-5 Language.** All user-visible strings in **German**; product names unchanged
  (Barco, Trinnov, Zidoo, madVR).
- **NFR-6 Testability.** Device clients SHALL be mockable; the activity engine SHALL be
  unit-testable without hardware — including the delta logic and every transition pair.
- **NFR-7 Dashboard compatibility.** The existing `dashboard-mobile` structure and style
  SHALL be preserved.

---

## 12. Architecture sketch

```
kino/
  custom_components/kino/
    __init__.py          config entry, coordinator setup
    config_flow.py       UI setup + options (activity definitions)
    coordinator.py       polling + state reconciliation
    activity/
      model.py           activity definitions, device requirements
      planner.py         delta computation: stop / keep / reconfigure / start
      executor.py        concurrent execution, dependency ordering, readiness waits
      estimator.py       learned duration model for ETAs
      machine.py         off/starting/switching/on/stopping/error
    devices/
      base.py            readiness protocol: is_ready(), apply(settings), stop()
      barco.py           power, profile (incl. the ready-during-cooldown quirk)
      trinnov.py         source, preset, upmixer, volume, mute
      zidoo.py           API client: library, search, playback, audio/subtitle tracks
      madvr.py           power
      generic.py         Shield / Apple TV via existing media_player entities
    library.py           browse, search, filter, sort; thumbnail proxy/cache
    media_source.py      standard HA browse surface
    schema.py            formal config schema + validation (the contract, FR-91)
    panel.py             sidebar panel registration + static asset serving  [Phase 4]
    websocket_api.py     WS commands backing the admin panel (config CRUD, dry-run, log)
    entities:
      media_player.kino        transport, volume, browse, search
      select.kino_aktivitat    activity selection
      select.kino_tonspur      audio track
      select.kino_untertitel   subtitle track
      sensor.kino_status       plain-German status text
      sensor.kino_fortschritt  transition progress + ETA
      sensor.kino_<device>     per-device readiness
      binary_sensor.kino_fehler
      button.kino_erneut_versuchen
  frontend/
    shared/                design tokens + shared components (Lit + TS)
    card/                  responsive custom Lovelace card
    panel/                 admin panel: activity matrix editor, device board,   [Phase 4]
                           dry-run planner, transition log, API explorer
```

---

## 13. Acceptance scenarios

| # | Scenario | Pass condition |
|---|---|---|
| A1 | Cold start, second user alone: open phone → Film → find a title by name → watch it | Playing, correct audio, no help asked, visible progress throughout |
| A2 | Film → Netflix | Barco and Trinnov stay on and are only reconfigured; Zidoo stops and powers off; Shield starts. No full power-cycle. Noticeably faster than a cold start |
| A3 | Film → Musik | Projector and madVR shut down, Trinnov reconfigured, lights change. No waiting on the projector |
| A4 | Musik → Film | Projector starts from cold; ETA shown and roughly correct; nothing else power-cycles |
| A5 | Browse and filter on a tablet | Multi-column grid, thumbnails load smoothly, filters combine |
| A6 | Subtitles needed mid-film | Two taps, correct track, no restart |
| A7 | Too loud, during Netflix | Volume drops immediately even though the activity has no media control |
| A8 | Done watching | One tap "Aus", lights come up, nothing left powered on |
| A9 | Projector unplugged | Plain-German message naming the device and what to do; retry works; other devices unaffected |
| A10 | Impatient double-tap during startup | No breakage, no duplicate startup, no stuck state |
| A11 | Patrick adds a whole new activity from the admin panel | It appears in the card and transitions correctly — no file edited, no restart |
| A12 | A transition felt slow yesterday | The transition log identifies which device consumed the time |
| A13 | Second user logs in | No "Kino" entry in her sidebar |
| A14 | Shield sleeps by itself during a paused Netflix session | Activity stays `on`, device shown dormant, wakes on next interaction — no error, no auto-repower |
| A15 | Someone switches the projector off with its own remote mid-film | `on (degradiert)`, projector named, one-tap restore offered, nothing fights back |
| A16 | First library read after days idle (NAS disks spun down) | Plain-German message plus a working refresh button; second use succeeds |
| A17 | Config file has a typo in a Trinnov preset name | Load fails with the activity, device and field named — not a silent fallback |
| A18 | Watch half a film on the Zidoo, stop, come back next evening | "Weitersehen" offers it at the right position, sourced from Jellyfin |
| A19 | A month of viewing | Jellystat shows an accurate history including Zidoo sessions — not just app-based ones |

---

## 14. Upstream work — `barco-pulse-homeassistant`

The Barco integration is Patrick's own, so the projector's awkwardness can be fixed **at the
source** instead of worked around in the Kino driver. This upgrades FR-25 from a workaround to
an upstream feature, and it is probably the highest-leverage work in the whole project: every
transition involving the projector is gated on it.

- **FR-140** The integration SHALL expose an **unambiguous phase** — `off / cooling / warming /
  on / error` — so that `ready` never has to be disambiguated downstream.
- **FR-141** It SHALL expose **remaining cooldown / warm-up time** where the Pulse API provides
  it, or a derived estimate otherwise, feeding the ETA in FR-24.
- **FR-142** It SHOULD use **Pulse property subscriptions** (push) rather than polling, if the
  API supports them. This is the single biggest reduction in readiness latency available.
- **FR-143** It SHALL expose a **shadow value for the active profile.** The projector cannot
  report it — selecting a profile merely applies settings — so the integration SHALL track the
  last profile it set, mark it unverified, and clear it on power cycle.
  *Why this matters:* today `select.hodr_cs_profile` reads `unknown`, which is honest but useless
  to the planner. Without a shadow value, every transition must re-apply the profile blindly, and
  "keep, no reconfigure needed" (FR-11) can never be decided for the projector.
- **FR-144** It SHOULD distinguish **ready for input** from merely powered.

---

## 15. Remaining open questions

| # | Question | Why it matters |
|---|---|---|
| Q1 | **Fill in the §5.5 activity matrix** — Trinnov source/preset/upmixer per activity, Barco profile for Netflix, what Musik actually uses | This *is* the spec. Nothing can be built without it |
| Q2 | What plays music? Zidoo (Music Player / TIDAL / Spotify app), the Shield, or something else — and does Musik need the projector at all? | Determines whether Musik has a media browser and whether it's a fast, no-projector activity |
| Q3 | Which Shield entity is real — `shield_kino_2` or `shield_kino_3`? Can the integration launch the Netflix app directly? | F12; and whether "Netflix" means "Shield on" or "Shield on, Netflix open" |
| Q4 | Apple TV: an activity, or drop it? It currently reports `unavailable` | FR-3 |
| Q5 | Maximum volume ceiling in dB? (reference is currently −30.0) | FR-64 |
| Q6 | Auto-select preferred audio/subtitle language on playback start? | Removes a class of "why is it in English" problems |
| Q7 | Replace the existing Zidoo integration entirely, or run alongside it? | Affects entity IDs and every existing automation reference |
| Q8 | Distribution: private repo, or HACS-installable? | Affects structure, translations, CI, polish level |
| Q9 | Library size (titles) and Zidoo API response times? | Drives pagination strategy and whether thumbnail caching is mandatory |
| Q10 | Does the second user have her own HA account/device? | Notifications, presence, per-user defaults; and FR-101 needs a non-admin account to be verifiable |
| Q11 | Should the panel eventually absorb the config flow entirely, or stay complementary? | Affects how thin FR-90 can be |
| Q12 | Transition log: persisted across restarts, and retained how long? | FR-122 storage design |
| Q13 | Should the panel also surface the existing `Kino –` automations, or stay strictly integration-scoped? | Scope creep risk vs. one place for everything |
| Q14 | **Verify the Jellystat script and its Jellyfin version compatibility** before committing | Known breakage reports; Streamystats is the fallback |
| Q23 | Spotify Connect vs Tidal Connect as the primary Musik path — which one does the card drive? | Spotify has an HA integration; Tidal does not (§6.5) |
| Q15 | Does a Radarr/Sonarr stack already exist on the Proxmox host? | If so, Jellyfin's library setup is trivial and naming is already guaranteed |
| Q19 | Which Jellyfin auth mode works for play-state reporting (FR-49d)? | The one real unknown; gates §6.4 |
| Q20 | One Jellyfin user for the household, or per-person? | Per-person gives meaningful Jellystat data but adds a "who's watching" step for the second user — friction against the design rule |
| Q21 | Do the Shield and Apple TV get the Jellyfin app, or stay streaming-only? | Determines whether multi-platform sync is real or aspirational |
| Q16 | Does the Pulse API support property subscriptions? | FR-142; determines whether readiness is push or polled |
| Q17 | Trinnov: what is the hard max volume currently set to in its own config? | D10 — the soft ceiling should sit below it, not above |
| Q18 | Is the Shield's idle-sleep behaviour configurable, or must FR-37 absorb it? | Affects how much drift handling is really needed |

---

## 16. Suggested phasing

Revised: **the engine proves itself before any bespoke GUI gets built.** Coupling a concurrent
Python state machine, a custom WebSocket API and a Lit/TS matrix editor into one phase is how
projects stall — the frontend work is unbounded and the backend is the risky part.

0. **Phase 0 — Spike and decisions.** Stand up Jellyfin + Jellystat on Proxmox and verify the
   pair actually works together (Q14). Confirm play-state reporting auth (Q19). Document the
   Zidoo API surface. Fill in the §5.5 matrix. Confirm Pulse subscription support.
   *Nothing else can be estimated until this is done.*
1. **Phase 1 — Activity engine, file-configured.** Config schema and validation (FR-90 to FR-94),
   coordinator, device drivers with a common readiness protocol, planner / executor / state
   machine, drift handling, per-device status entities. FR-1 to FR-39a, FR-80 to FR-83.
   **No GUI editor.** Validated against the existing dashboard plus a minimal card slice
   (activity selection, status, volume) so it is usable end-to-end from day one.
2. **Phase 2 — Barco upstream.** FR-140 to FR-144 in `barco-pulse-homeassistant`. Can run in
   parallel with Phase 1; FR-143 in particular unblocks proper differential planning.
3. **Phase 3 — Media and the full card.** Jellyfin behind the media interface, browse, advanced
   search and filtering, play-state reporting, track selects, the responsive card. FR-40 to FR-77.
   Retire `kino_tracks_einlesen`, the sync mutex and the search text-field hack.
4. **Phase 4 — Admin panel.** Matrix editor over the *same* schema (FR-100 to FR-115), then
   diagnostics: device board, dry-run planner, transition log, learned durations, API explorer
   (FR-120 to FR-134).
5. **Phase 5 — Cleanup.** Retire superseded scripts, helpers and automations per FR-85.
