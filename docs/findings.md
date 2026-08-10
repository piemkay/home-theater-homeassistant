# Findings from the live system

Collected 2026-08-10 while building `custom_components/kino`, by reading the
running Home Assistant instance (2026.8.1) rather than the requirements
document. Where the two disagree, the live system wins and the requirements
need updating.

---

## 1. The entity inventory in §4.1 is out of date

| Requirements says | Actually exists | Notes |
|---|---|---|
| `light.kino_vorhang` | `light.wled_top_right` (friendly name "Vorhang") | Also `light.wled_top_right_segment_1`, same name |
| `light.kino_decken_led` | `light.wled_top_left` (friendly name "Decke") | |
| `light.kino_screen_led` | `light.wled_front` ("Kino vorne links"), `light.wled_front_segment_1` ("Kino vorne rechts") | |
| `light.kino_deckenspots` | ✅ exists | |
| `sensor.kino_co2`, `sensor.kino_voc_cast` | not found in the Kino area | Only `sensor.kino_temperatur` and `sensor.kino_luftfeuchte` |
| `switch.…_mute`, `sensor.…_volume` (Trinnov) | ✅ `switch.trinnov_altitude_14683197_mute`, `sensor.trinnov_altitude_14683197_volume` | |

The Kino config ships with the entity IDs that actually exist. Anything wrong
fails loudly at load with the offending device and field named, rather than
silently doing nothing.

## 2. There is an HDFury VERTEX2-18 in the chain, and it is not in the spec

Not mentioned anywhere in the requirements, but present in the Kino area:

- `select.hdfury_vertex2_18_port_select_tx0` = `0`
- `select.hdfury_vertex2_18_port_select_tx1` = `4`
- `switch.hdfury_vertex2_18_mute_audio_tx0` / `tx1` — both currently **on**
- `switch.hdfury_vertex2_18_auto_switch_inputs` = off
- plus EDID/audio/output sensors

**Open question (Q24):** does any activity need the HDFury switched? If it is
doing input routing for Steam-over-DP vs Zidoo-over-HDMI, it must become a
Kino device with a `port_select` setting per activity. If it is a passive
splitter, it can stay out. Until this is answered, activities that rely on it
may appear to succeed while producing no picture.

## 3. Duplicate Shield entities — F12 confirmed, and worse than described

Four entities, all referring to something called "shield kino":

| Entity | State |
|---|---|
| `media_player.shield_kino_2` | off |
| `media_player.shield_kino_3` | off |
| `remote.shield_kino` | off |
| `remote.shield_kino_2` | unknown |

`media_player.kino_is_playing_state` groups `shield_kino_3`; the dashboard
tile shows `shield_kino_2`. The shipped config uses `shield_kino_3` to match
the aggregate, but **this needs a decision (Q3)**: one of these is a stale
registry entry and should be deleted rather than worked around.

## 4a. Trinnov option lists — read live, Q1 partially answered

The Altitude was powered on during this session specifically to read its real
option lists. Recorded 2026-08-10, `power_status: ready`:

**Sources** (17):

```
shield · appletv · zidoo · steam · pc
HDMI 6 · HDMI 7 · HDMI 8 · NETWORK · Roon Ready
S/PDIF IN 1 · S/PDIF IN 2 · Optical IN 3 · Optical IN 4
ANALOG BAL IN 1 · ANALOG SE2 IN · MIC IN
```

So `zidoo`, `shield` and `steam` are all real, and **the shipped config's
guess of `shield` for Netflix is correct**. `appletv` and `pc` also exist,
which settles half of Q4.

**Presets** (9):

```
Builtin · Base · Base + WF · Base + WF + top xover 130hz · MLP Flat
Front Bass Boost · Front musical · Front musical er correctiom
Front+Back Bass Boost
```

**Upmixers** (7): `auto`, `auro3d`, `dts`, `dolby`, `native`, `legacy`,
`upmix on native`. Note the *state* can read `none`, which is not in the
options list — so "no upmixer" cannot be selected through the select entity.

**State at the time of reading:** source `steam`, preset `Front Bass Boost`,
upmixer `none`, volume **−39.5 dB**, decoder `PCM`.

**Deliberately not guessed:** the shipped `kino.yaml` sets only `source` and
`volume` per activity, exactly as the old scripts did. Presets and upmixers
are audio decisions, not integration decisions — picking one would silently
change how the room sounds. Fill them in per activity when you want them:

```yaml
trinnov: { power: true, source: zidoo, preset: "MLP Flat", upmixer: auto, volume: -30.0 }
```

Also discovered: **`sensor.trinnov_altitude_14683197_power_status`** is a much
better readiness signal than the media player. Ten days of history show a
clean `off → waking → ready` in 63–122 s (mean ~86 s), whereas the media
player reports `on` almost immediately and the source list stays empty for up
to two minutes. The driver now prefers it, and the config's startup estimate
was corrected from 60 s to 90 s.

## 4. The activity matrix (§5.5), as far as it is observable

Recovered from the existing scripts — these are the values in production use:

| | Film (Zidoo) | Netflix (Shield) | Musik | Steam | Aus |
|---|---|---|---|---|---|
| Barco power | on | on | **off** | on | off |
| Barco profile | `HDR 260 HDMI` | **unknown** | – | `HDR 260 DP` | – |
| Trinnov source | `zidoo` | `shield` ✅ §4a | `zidoo` (assumed) | `steam` | – |
| Trinnov preset | not set by any script | not set | not set | not set | – |
| Trinnov upmixer | not set by any script | not set | not set | not set | – |
| Reference volume | −30.0 | −30.0 (assumed) | −35.0 (assumed) | −30.0 | – |
| Light scene | `scene.dark`¹ | – | – | `scene.low_ambience` | – |

¹ The Zidoo activity script sets **no** scene at all; the light change comes
from the separate `Kino – Licht dunkel bei Wiedergabe` automation. The Steam
script does set `scene.low_ambience`.

**Still needed before Netflix and Musik are fully trustworthy:** the Barco
profile for Netflix, and confirmation of the reference volumes. Source names
are now settled (§4a).

If a source name ever *is* wrong, activation fails with
`'x' ist keine gültige Auswahl für source (verfügbar: …)`, which prints the
valid options — so the first attempt tells you the answer.

Note the scene entity for gaming is `scene.kini_gaming` — a typo in the entity
ID that has to be reproduced verbatim in config until it is renamed.

## 5. Projector timings, measured

See `docs/barco-upstream-changes.md` for the full evidence. Summary:

- warm-up `standby → on`: **3–7 seconds** (the requirements' "1–2 min" is
  wrong for the *state*; picture stability may still lag)
- cooldown `on → standby`: **8:12**, split 3:00 `deconditioning` + 5:12
  `ready`
- a power-on during the cooling `ready` window **does** take effect, so the
  existing script's "wait out the full cooldown" is pessimistic by ~5 minutes

This changes the ETA story: the projector dominates *shutdown-then-restart*,
not a cold start.

## 6. Jellyfin

- Version **10.11.11** (not 12.x — the Jellystat compatibility warning in
  §6.2 may not apply)
- Reachable directly at `https://jellyfin.local.7labs.dev`
- `Users/Public` is empty → users are hidden from the login screen
- **QuickConnect is enabled** — verified by initiating a request and receiving
  a code. This answers **Q19 / FR-49d**: the integration obtains a real *user
  access token* via QuickConnect, which is what `/Sessions/Playing*` needs,
  and setup never handles a password.
- `sensor.jellyfin_active_clients` from the official integration was
  `unavailable` at the time of writing — consistent with the library scan
  still running. The Kino integration does not depend on it (FR-39z).

## 7. What was and was not exercised live

The room was cold at the start of this session: Barco `standby`, Trinnov
timing out ("Is it powered on?"), madVR off, Zidoo off.

**Done live:** the Trinnov was powered on and off through Home Assistant to
read its real option lists (§4a) and to confirm the boot sequence. The
observed behaviour — media player `on` while the source list stayed empty for
~2 minutes — is exactly the failure mode the driver's readiness rule exists
for, and it is now covered by `TestTrinnovPowerStatus`. The Trinnov was
switched back off afterwards, leaving the room as it was found.

**Not done live:** the projector was deliberately left alone. Its behaviour is
already pinned down by ten days of recorded history, and each start commits
the room to an 8:12 cooldown for information already in hand. Every
transition, drift and shutdown path is therefore validated against recorded
history and the fake device rig, not against live hardware.

**The live end-to-end runs in `docs/acceptance.md` still need to be performed
with the room on** — start with §1 (Musik), which needs no projector.

---

## Open questions, updated

Answered by this pass:

- **Q1** (partially) — the Trinnov source names are confirmed live: `zidoo`,
  `shield`, `steam`, `appletv`, `pc` all exist. See §4a.
- **Q2** (what plays music) — the shipped config uses Trinnov + Zidoo, no
  projector, per §6.5.
- **Q9** (library size / response times) — Movies had only 2 items mid-scan;
  re-measure once the scan finishes. Pagination is implemented regardless.
- **Q14** (Jellystat compatibility) — Jellyfin is 10.11.11, so the 12.x
  migration warnings do not apply. Jellystat itself is still not deployed.
- **Q16** (Pulse subscriptions) — the API reference documents
  `property.subscribe`; the integration does not implement it. See FR-142.
- **Q19** (Jellyfin auth for play state) — QuickConnect user token. Done.

Still open, and each one blocks something:

| # | Question | Blocks |
|---|---|---|
| Q1 | Trinnov **preset/upmixer** and reference volume per activity; Barco profile for Netflix | Sources are now confirmed (§4a). Presets/upmixers are deliberately unset — they are audio decisions |
| Q3 | Which Shield entity is real; can Netflix be launched directly? | The Netflix activity being more than "Shield on" |
| Q4 | Apple TV: activity or drop? Currently `off`/`unavailable` | FR-3 |
| Q5 | Maximum volume ceiling in dB | Shipped default is −25.0 dB, chosen conservatively — needs confirming |
| Q17 | Trinnov's own hard limit | The soft ceiling should sit below it |
| Q24 | **New:** is the HDFury part of any activity? | Whether Steam/Film produce a picture at all |
| Q7 | Replace the Zidoo integration or coexist? | Currently coexisting; the Kino drivers drive its entities |
| Q10 | Does the second user have her own HA account? | FR-101 cannot be verified without one |
| Q21 | Jellyfin app on Shield/Apple TV? | Whether multi-platform sync is real |
