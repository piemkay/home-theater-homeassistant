# Release 0.3 — "Klar & Konsistent"

**Status:** Plan v1.0 — from the 2026-08-12 live UX review
**Baseline:** 0.2.2 (`30c8110`), reviewed hands-on against the live system
(desktop 1373px and phone 414px, full start → play → switch → resume →
shutdown cycle driven through the real hardware).

---

## 1. Where the product stands

The core promise **works, and works impressively**. Measured live:

- Cold start `aus → film`: **1:06 min**, honest progress, correct bottleneck
  ("Beamer startet"), every device chip confirming in turn.
- Differential switch `film → netflix`: **7.3 s** — projector and madVR kept,
  Trinnov reconfigured in 0.5 s, Shield started, Zidoo stopped. This number is
  the product.
- Shutdown: ETA **"noch ca. 8 Min."** — the projector's real cooldown, not a
  guess. Nothing lied during the whole session.
- Resume from the card: "Fortsetzen bei 31:48" → playback at 31:48. Volume,
  mute, seek, pause, track selects: all correct against the real Trinnov and
  Zidoo.
- Filters, favorites, search, six view modes, infinite scroll: all functional
  on both form factors; the phone filter sheet wraps correctly (the 0.2.2 fix
  holds).

0.3 is therefore **not a features release. It is a trust, clarity and
consistency release** — the gap between "works" and "feels finished". Guiding
persona, unchanged: *the second user, on a phone, with no prior knowledge.*

## 2. Findings from the live review

Severity: **A** = actively misleads or blocks the second user · **B** = friction
or inconsistency an attentive user notices · **C** = polish.

| # | Sev | Finding (evidence) |
|---|---|---|
| F1 | **A** | **Phantom device state while the room is off.** The Trinnov integration idles in a `connecting` loop when the device is unpowered; Kino maps this to health `starting`. Live: `sensor.…_trinnov` = "starting" for hours in an idle room. A device chip that pulses "starting" in a dark cinema is exactly the false signal the drift system was built to avoid |
| F2 | **A** | **The Serien section is a dead end.** 121 shows browse beautifully, but there is no season/episode level anywhere (card or WS API), and `playable: true` on a show promises a play that cannot pick an episode |
| F3 | **A** | **No synopsis anywhere.** `overview` and `genres` are fetched, modeled and never rendered — the detail sheet shows title, meta, formats, tagline, button. The second user picks films by poster alone |
| F4 | **B** | **The filter CTA lies until it is pressed.** With 4K + Action toggled, the footer button still read "579 Titel anzeigen"; the real count (194) only appears after closing. The one number on the sheet is stale precisely when it matters |
| F5 | **B** | **Starting a film loses its subject.** After "Kino starten und wiedergeben" the detail sheet closes into the library; during the ~1 min transition nothing names the film that is about to play. The progress card knows the target activity but not the queued title |
| F6 | **B** | **Stops are invisible during a switch.** `film → netflix` shows only the target's devices; the Zidoo being stopped (4 s) and, on the way to Aus, the Shield never appear. During shutdown the outgoing devices *are* shown — inconsistent with switching |
| F7 | **B** | **Keys leak into the UI.** Panel: "aktive Aktivität **netflix**" (card says "Streaming"), Planer/Verlauf rows say `barco`, `film → netflix`. Card and panel must both speak display names |
| F8 | **B** | **Mixed language.** Planner reasons are English ("already correct") in an otherwise German UI; upmixer state renders raw `none`; track selects show raw player strings ("0: English Dolby TrueHD…", "0: Off") |
| F9 | **B** | **"TRINNOV · PRESET" labels the brand, not the function.** The persona does not know what a Trinnov is (requirements §3). Same class: "UPMIXER" |
| F10 | **B** | **Desktop is a stretched phone.** Full-width sort select, full-bleed 640px backdrops in the detail/playing sheets, sparse text-only activity tiles, one thin line of hand-off text in an empty viewport. Usable, unloved |
| F11 | **B** | **Matrix editor noise.** With the room off, half the matrix is the sentence "Gerät aus — Werte nicht abrufbar, gesetzt: X" repeated per cell; volume fields are unitless numbers; every activity column carries a prominent red ✕ |
| F12 | **C** | Age-rating chips in Jellyfin's alphabetical order ("FSK-18" before "FSK-6"), FSK mixed with MPAA/TV systems |
| F13 | **C** | "Wechsel zu Aus…" as shutdown label; footer shows a dead volume row ("—") while shutting down |
| F14 | **C** | "1 Messungen" (Verlauf); native `prompt()`/`confirm()` dialogs in the panel vs. the card's styled dialog |
| F15 | **C** | Two sidebar entries both named "Kino" (dashboard + admin panel) — indistinguishable for the admin |
| F16 | **C** | Configured activity icons (`mdi:movie-open`, …) are never rendered on the activity tiles |

## 3. Release scope — four workstreams

### WS-1 · Truthful status (F1, F5, F6) — *the trust workstream*

1. **Off means off.** A device whose integration is merely reconnecting while
   the room expects it off reports `off`, not `starting`. Rule: `TRANSITIONING`
   from the underlying integration is only surfaced while Kino itself has an
   intent for that device (transition in flight or activity expects it on);
   otherwise it degrades to `off`/`unknown`. Trinnov driver first (gate on
   `power_status`/remote state), same review for madVR and Zidoo.
   *Accept: idle room ⇒ every chip grey within one poll, no "starting" anywhere.*
2. **The queued title stays on screen.** When play starts an activity, the
   progress card carries the poster thumb and "**The Beekeeper** startet
   gleich…" until the playing sheet opens. The state payload gets the pending
   item (id + title) so any client can show it.
   *Accept: tap "Kino starten und wiedergeben" ⇒ title visible during the
   whole transition, then the playing sheet opens itself.*
3. **Show every action of the plan.** Device chips during a transition list
   the union of touched devices — stops included, with the existing gold pulse
   and "fährt herunter" semantics that shutdown already has.
   *Accept: `film → netflix` shows the Zidoo stopping.*

### WS-2 · Content depth (F2, F3, F12) — *the library workstream*

4. **Series drill-down.** New WS commands `kino/library/seasons` and
   `kino/library/episodes` (Jellyfin `/Shows/{id}/Seasons` / `/Episodes`);
   card: show detail → season strip → episode list (thumb, `S03E08 · Titel`,
   runtime, watched tick, resume bar) → play/resume per episode. "Weitersehen"
   surfaces episode items with their series name.
   *Accept: second user resumes a series mid-season from the phone without
   knowing which episode they were on.*
5. **The detail sheet says what the film is.** Render `overview` (clamped to
   ~4 lines with "mehr"), genre chips, and the rating that exists. Desktop: put
   poster left, text right (see WS-3).
   *Accept: no detail sheet without a synopsis when Jellyfin has one.*
6. **Facet hygiene.** Sort ratings by system then rank (FSK-0…18 first),
   genres alphabetically but German-first when Jellyfin carries translations;
   drop single-item facet groups.

### WS-3 · One design language (F7–F10, F13, F16) — *the consistency workstream*

7. **Names, never keys.** One rule everywhere (card, panel, logs shown to
   users): activities and devices render display names; keys appear only in
   the Datei tab and validation errors.
8. **German, everywhere a human reads.** Planner reasons localized ("bereits
   korrekt"), `none` → "—", subtitle off → "Aus", track labels prettified
   (strip index, map language codes: "Englisch · TrueHD Atmos"), "Wird
   ausgeschaltet…" instead of "Wechsel zu Aus…", "1 Messung".
9. **Function over brand.** "Klang" instead of "TRINNOV · PRESET", "Raumklang"
   instead of "UPMIXER" (wording final per mockup review). The entity stays
   the same; only the label changes.
10. **Desktop layout pass.** Sheets get `max-width` (~720px, centered, dimmed
    scrim); detail sheet becomes two-column ≥900px (poster + text); toolbar
    proportions fixed (sort select shrinks to content); activity tiles render
    their configured `mdi:` icons and get a subtle two-line layout; hand-off
    body becomes a proper card with icon + text instead of a floating line.
    *Accept: no control wider than 720px unless it is a grid.*
11. **Footer honesty.** While shutting down: no volume stepper, show
    "Wird ausgeschaltet…" instead.

### WS-4 · Panel ergonomics (F11, F14, F15) — *the admin workstream*

12. **Quiet matrix.** The "Gerät aus" sentence collapses to a compact
    `aus · gesetzt: HDR 260 HDMI` chip with a tooltip; empty-option selects and
    text hints unified into one rendering; volume inputs labeled "dB";
    destructive ✕ demoted to an overflow menu per column.
13. **Styled dialogs.** Replace `prompt()`/`confirm()` with the card-style
    dialog (new activity name, delete confirmation, durations reset).
14. **Tell the two "Kino"s apart.** Panel registers as "Kino Admin" with
    `mdi:movie-edit` (or equivalent) so sidebar entries differ.
15. **Small paydowns while in there:** per-device duration reset (backend
    already supports it), use `errorsByPath` to group validation errors under
    their activity/device heading.

## 4. Out of scope for 0.3

- Voice control, Apple-TV/AirPlay activity, Jellystat dashboards (unchanged
  non-goals).
- Persisting library filters across reloads (view mode persists today; filters
  reset — acceptable, revisit after series land).
- In-card climate/lighting control — Dim is the Trinnov's own -20 dB audio
  dim (rewired post-review, no light involvement), and the
  `Kino –` automations stay the owner of the room.
- Music search inside the Musik body (mockup leftover; needs a real source
  first).

## 5. Sequencing & verification

Order: **WS-1 → WS-3 → WS-2 → WS-4.** Trust fixes first (small, high value),
then the consistency pass (mostly frontend, no schema changes), then series
(the one item with backend surface area — new WS commands and card views),
panel last. F4 (live filter count via a `count`-only query, debounced) rides
with WS-3.

Each workstream ships as one deployable slice over the existing loop:
`git push` → HACS `update_information` → download → restart → drive the same
live script used for this review (start from title, switch, resume, shutdown —
phone width and desktop width). The acceptance lines above are the checklist;
`docs/acceptance.md` gets the new scenarios (series resume, queued-title
visibility, idle-room chip check).

**Definition of done for the release:** the second user can (a) pick a series
episode by poster and synopsis, (b) never see a device do something the room
is not doing, and (c) read every word of the UI in German — on a phone, with
the room off, without asking Patrick anything.
