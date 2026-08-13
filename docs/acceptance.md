# Acceptance scenarios — coverage and how to verify

Requirements §13. "Automated" means an executable test asserts the behaviour;
"live" means it needs the room powered on and a person watching.

| # | Scenario | Status | Where |
|---|---|---|---|
| A1 | Cold start, second user alone: phone → Film → find a title → watch it | **live** | needs the room on |
| A2 | Film → Netflix, no full power-cycle | ✅ automated | `test_planner.py::test_film_to_netflix_keeps_the_projector_and_only_reconfigures` |
| A3 | Film → Musik, no waiting on the projector | ✅ automated | `test_planner.py::test_film_to_musik_drops_projector_and_madvr`, `test_executor.py::test_musik_does_not_wait_on_the_projector` |
| A4 | Musik → Film, projector from cold, nothing else cycles | ✅ automated | `test_planner.py::test_musik_to_film_starts_the_projector_and_cycles_nothing_else` |
| A5 | Browse and filter on a tablet | partial | filter translation covered by `kino-card.test.js`; layout is **live** |
| A6 | Subtitles mid-film, two taps | partial | `select.kino_untertitel` exists with an explicit "Aus"; **live** |
| A7 | Volume during Netflix (no media control) | partial | volume works in every activity by construction; **live** |
| A8 | One tap "Aus", lights up, nothing left on | ✅ automated (engine) | `test_planner.py::test_turning_off_stops_everything_that_is_on`; light scene is **live** |
| A9 | Projector unplugged: message names it, retry works, others unaffected | ✅ automated | `test_executor.py::test_required_device_failure_aborts_with_a_named_device`, `::test_unverified_shutdown_raises_but_does_not_block_others` |
| A10 | Impatient double-tap during startup | ✅ automated | `test_machine.py::test_double_tap_during_startup_does_not_start_twice`, `::test_switching_mid_transition_retargets` |
| A11 | Add a whole new activity | partial | config-only, no restart (`kino.reload`); the **panel** is deferred |
| A12 | "A transition felt slow yesterday" | ✅ automated | `test_machine.py::test_transition_log_records_per_step_timings` |
| A13 | Second user sees no "Kino" entry in her sidebar | n/a | no panel is registered yet, so nothing to hide |
| A14 | Shield sleeps by itself during paused Netflix | ✅ automated | `test_machine.py::TestDrift::test_dormant_optional_device_is_benign` |
| A15 | Projector switched off by its own remote mid-film | ✅ automated | `test_machine.py::TestDrift::test_device_switched_off_by_hand_is_reported_not_repowered` |
| A16 | First library read after days idle (NAS spun down) | ✅ automated | `test_jellyfin.py::TestFailureModes`, `::test_refresh_hits_the_library_endpoint`; card renders the message + retry |
| A17 | Typo in a Trinnov preset name | ✅ automated | `test_schema.py` (11 cases), including `test_all_errors_are_reported_in_one_pass` |
| A18 | Half a film, resume next evening | partial | resume read-back and progress reporting covered by `test_jellyfin.py::TestPlayState`; end-to-end is **live** |
| A19 | A month of viewing shows up in Jellystat | **blocked** | Jellystat is not deployed yet |
| A20 | Idle room shows no phantom device state (0.3/F1) | ✅ automated | `test_machine.py::test_idle_room_never_shows_a_starting_device`, `test_drivers.py::TestTrinnovPowerStatus::test_reconnect_probe_while_off_is_off`; the live check is one glance: room off ⇒ every chip grey |
| A21 | The queued title stays on screen during start-then-play (0.3/F5) | partial | payload and render covered by `kino-card.test.js` ("pending item"); end-to-end is **live**: pick a title from cold, the progress card must name it until the playing sheet opens itself |
| A22 | A switch shows the devices being stopped (0.3/F6) | partial | `kino-card.test.js` ("device chips" union case); **live**: `film → netflix` must show the Zidoo going down |
| A23 | Series resume mid-season, from the phone (0.3/F2) | partial | `test_jellyfin.py::TestSeries`, episode naming in `kino-card.test.js`; **live**: open a series, the season with unwatched episodes is preselected, tap the row with the resume bar |
| A24 | Find every film with a given actor without knowing how to spell the catalogue's ID (0.6) | ✅ automated + **verified live** | `test_jellyfin.py::TestPersons`, `kino-card.test.js` "cast and crew filter"; live 2026-08-13: "pacino" → Al Pacino → 6 Titel |
| A25 | One language is one chip, however the file spells it (0.6) | ✅ automated + **verified live** | `test_jellyfin.py::TestLanguageCodes`, `::TestTracks::test_a_commentary_is_not_a_language_the_film_exists_in`; live: `en`/`th`/`vi`/`zh-hans`/`id` no longer appear beside their three-letter twins |
| A26 | A series can be filtered by the languages its episodes carry (0.6) | ✅ automated + **verified live** | `test_jellyfin.py::TestSeriesLanguages`; live: Serien → Tonspur → Deutsch 21 ⇒ 21 Titel (the group was empty before) |
| A27 | Decide whether tonight works: every audio and subtitle track, before starting anything (0.6) | ✅ automated + **verified live** | `kino-card.test.js` "audio and subtitle tracks"; live: *Heat* lists 2 audio and 21 subtitle tracks, commentaries marked |
| A28 | Watch the trailer on the phone with the room off (0.6) | partial | render covered by `kino-card.test.js` "trailers"; live 2026-08-13: *DTF St. Louis* → "Trailer ansehen" opened the official trailer |
| A29 | Mark a film, an episode or a whole season gesehen — and undo it (0.6) | ✅ automated + **verified live** | `test_jellyfin.py::TestWatched`, `kino-card.test.js` "marking gesehen"; live: episode ⇒ season strip 7→6; season ⇒ all seven episodes ticked; both reversed cleanly |
| A30 | Two stacked names mean "with both of them" (0.6.2) | ✅ automated + **verified live** | `test_jellyfin.py::TestSeveralPeople`; live: Tom Holland + Zendaya returned 643 of 620 films before the fix, the three Spider-Man films after |
| A31 | Choose from the wall without opening anything: both scores on every tile (0.6.2) | ✅ automated + **verified live** | `kino-card.test.js` "critics score on the wall"; live: fresh and rotten tomatoes render in all five layouts, and a title without a critics score grows no badge |
| A32 | A 21-track remux does not bury the rest of the detail sheet (0.6.2) | ✅ automated + **verified live** | `kino-card.test.js` "a long list is cut to three"; live: *Heat* shows 3 of 21 subtitles with "+ 18 weitere", cast row still on screen, commentaries last once expanded |

---

## Running the live scenarios

The engine has never been run against the real room — everything was cold
during development (see `docs/findings.md` §7). Do these in order; each builds
on the last.

### 0. Before anything, dry-run every pair

`kino.dry_run` computes the delta **without touching a device**. Run it for
every activity from every starting state and read the summary:

```yaml
action: kino.dry_run
data:
  activity: netflix
```

Expect, from Film: `stop: zidoo; start: shield; reconfigure: trinnov; keep: barco, madvr`.
If a device shows up as `start` that you expect to be `keep`, the planner is
seeing something you are not — check `sensor.kino_<device>`.

### 1. Musik first — it is the fastest and cannot damage anything

No projector, so a failure costs seconds rather than eight minutes. This is
the cleanest proof that the differential planner works.

- [ ] `select.kino_aktivitat` → Musik
- [ ] Trinnov comes up; `sensor.kino_status` reads "Trinnov startet" then "Bereit"
- [ ] the Trinnov source really is what the config says
- [ ] volume reads back a real dB value in the card footer

### 2. Film from cold

- [ ] the ETA is roughly right, and the bottleneck names the Beamer
- [ ] the projector profile is applied **after** it reports `on`, not before
- [ ] `sensor.kino_fortschritt` reaches 100 and the state lands on `on`
- [ ] the transition log shows per-device timings that look sane

### 3. Film → Netflix (A2)

- [ ] the projector does **not** power-cycle
- [ ] the Trinnov source changes and nothing else is written
- [ ] noticeably faster than a cold start

⚠️ The Trinnov source name for the Shield is a **guess** in the shipped
config. If it is wrong you will get
`Trinnov: 'shield' ist keine gültige Auswahl für source (verfügbar: …)` —
which prints the correct answer. Put it in `kino.yaml` and `kino.reload`.

### 4. Shutdown and the projector's real cooldown (A8)

- [ ] "Aus" stops everything; the light scene comes up
- [ ] the projector is **not** reported as failed while it is still lit —
      cooldown is 8:12 and that is normal

### 5. The one to test deliberately: restart during cooldown

This is the behaviour that differs from the old script. Turn the projector
off, wait until `sensor.hodr_cs_state` reads `ready` (about 3 minutes in),
then start Film.

- [ ] the power-on is accepted and the projector returns to `on` without
      first reaching `standby`
- [ ] if it is **not** accepted, the driver retries once the projector reaches
      standby — the transition should still complete, just slower

If the retry path is what fires, say so: it means the 2026-08-05 observation
was a one-off and `RETRY_POWER_ON_AFTER` in `devices/barco.py` is doing the
real work.

### 6. Drift (A15)

With Film running, switch the projector off with its own remote.

- [ ] after the debounce, `binary_sensor.kino_degradiert` turns on
- [ ] the card names the Beamer and offers "Wiederherstellen"
- [ ] **nothing switches it back on by itself** — this is the important one
- [ ] "Wiederherstellen" brings it back and re-applies the profile
