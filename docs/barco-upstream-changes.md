# Upstream changes needed in `barco-pulse-homeassistant`

**Status:** collected 2026-08-10 while building `custom_components/kino`
**Target repo:** `piemkay/barco-pulse-homeassistant` (branch at time of writing:
`fix/laser-power-property-names`)
**Covers:** requirements §14, FR-140 … FR-144

Everything below is worked around today inside `custom_components/kino/devices/barco.py`.
The workarounds are correct but they live in the wrong place: every consumer of the
projector has to repeat them, and two of them (the profile shadow and the phase
history) are lost across a Home Assistant restart because they are in-memory state
in a downstream integration. Moving them upstream fixes that for good.

---

## Evidence base

All timings below come from ten days of recorded `sensor.hodr_cs_state` history on
the live Hodr CS (firmware 2.3.19, serial 2590381267), read out of the HA recorder
on 2026-08-10 — not from the manual.

**Warm-up** (7 observed runs):

```
standby ──► ready ──► on                     3–7 s total
standby ──► ready ──► conditioning ──► on    12 s (observed once, 2026-08-03)
```

**Cooldown** (9 observed runs, remarkably consistent):

```
on ──► deconditioning ──► ready ──► standby
        └── 3:00 ──────┘ └── 5:12 ─┘        = 8:12 total
```

**The important one** — 2026-08-05, a power-on issued during the cooling `ready`
window took effect and the projector returned to `on` without ever reaching
standby:

```
20:11:37  deconditioning
20:14:37  ready            ← cooling
20:18:55  on               ← power-on landed here, 4:18 into the cooling-ready window
```

Two consequences:

1. `ready` genuinely means two different things, and the *only* thing that
   distinguishes them is the state it was entered from.
2. `script.start_barco`'s "wait out any in-progress cooldown, up to 8 minutes"
   is pessimistic. A restart during cooling-`ready` works. Only `deconditioning`
   has to be waited out, and that is 3 minutes, not 8.

---

## FR-140 — Expose an unambiguous phase

**Priority: highest.** Everything else in this document is downstream of it.

Add a `sensor.<name>_phase` (or an attribute on the existing state sensor) with
values `off / warming / on / cooling / error`, derived inside the coordinator
where the previous raw state is already known:

| Raw `system.state` | Phase |
|---|---|
| `standby`, `eco`, `boot` | `off` |
| `conditioning` | `warming` |
| `on` | `on` |
| `deconditioning` | `cooling` |
| `ready` **entered from** `standby` / `eco` / `boot` / `conditioning` | `warming` |
| `ready` **entered from** `on` / `deconditioning` | `cooling` |
| `ready` with no known predecessor (integration just started) | `cooling` — the safe reading |

That last row matters: assuming `warming` on an unknown `ready` makes the
integration declare a projector ready that is actually four minutes from standby.

Reference implementation: `custom_components/kino/devices/barco.py::_resolve_phase`,
tested in `tests/test_drivers.py::TestBarcoPhase`.

**Why it can only be done upstream:** the coordinator is the only place that sees
every state change. A downstream integration polling every 5 s can miss the
`deconditioning → ready` edge entirely and then mis-classify the whole window.

---

## FR-141 — Expose remaining cooldown / warm-up time

Add `sensor.<name>_phase_remaining` (seconds, `None` when not transitioning).

The Pulse API may expose this directly — worth checking
`system.remainingcooldowntime` / equivalent before deriving it. If it does not,
derive it from the phase entry timestamp plus the measured constants:

```python
DECONDITIONING_SECONDS = 180.0   # deconditioning -> ready
COOLING_READY_SECONDS  = 312.0   # ready(cooling) -> standby
COOLDOWN_TOTAL_SECONDS = 492.0
WARMUP_SECONDS         = 7.0     # standby -> on
```

This feeds the ETA the second user sees (FR-24/FR-82). Today the Kino integration
carries these constants as literals, which means they are wrong for anyone else's
projector; upstream can measure them per device and learn them over time.

---

## FR-142 — Use property subscriptions instead of polling

`specs/barco_pulse_api_json_rpc_reference.md` documents `property.subscribe` and
`property.unsubscribe` (§4.3), and `specs/ARCHITECTURE.md` already sketches this as
the roadmap. It is not implemented — `coordinator.py` polls on an interval that
ranges from 2 s (`on`) to 30 s (`standby`).

Subscribing to at minimum `system.state` would:

* remove up to 30 s of latency from every "the projector is up" decision, which is
  pure dead time in every Kino transition;
* make the `deconditioning → ready` edge impossible to miss, which is what FR-140's
  correctness rests on.

Suggested scope: subscribe to `system.state`, `illumination.sources.laser.power`
and the active-source property; keep polling as a slow safety net (90 s) rather
than removing it.

---

## FR-143 — Shadow value for the active profile

**This is the one that unblocks differential planning.**

`select.hodr_cs_profile.current_option` returns `None`
(`custom_components/barco_pulse/select.py:130`), and the entity is `unavailable`
whenever the projector is not `on`/`ready` (`select.py:143`). Live check on
2026-08-10 with the projector in standby:

```
select.hodr_cs_profile  → unavailable   options: ["No profiles configured"]
```

That is honest — the projector really cannot report which profile is active,
because activating one just applies a bundle of settings — but it is useless to a
planner. Without a value, "this device is already correct, keep it" (FR-11) can
never be decided for the projector, so **every** transition has to blind-re-apply
the profile.

Requested behaviour:

1. Track the last profile the integration successfully activated.
2. Return it from `current_option`.
3. Mark it unverified — e.g. `attributes: {"verified": false}` — so consumers know
   it is a shadow and not a readback.
4. Clear it on every power cycle (`state` reaching `standby`/`eco`/`boot`) and on
   integration restart.

The same applies to `BarcoPresetSelect.current_option` (`select.py:88`).

Kino implements exactly this today in `BarcoDriver._profile`, but its shadow dies
with the Home Assistant process. Upstream can persist it in the config entry and
survive restarts.

---

## FR-144 — Distinguish "ready for input" from "powered"

`state == "on"` is reached 3–7 s after a power-on, long before the projector is
actually displaying a stable image. Nothing currently distinguishes the two, so a
downstream orchestrator that switches an input at `on` may do so too early.

If the Pulse API exposes a signal/lock indication for the active input, expose it
as `binary_sensor.<name>_input_locked`. If it does not, this can be dropped —
but it should be dropped explicitly rather than left ambiguous.

---

## Smaller findings, not in the original requirements

### B1 — `select.hodr_cs_profile` is unavailable in standby, which forces ordering

Because the entity is `unavailable` below `on`/`ready`, a profile cannot be
pre-staged: the orchestrator must wait for the projector to be fully up before it
can select a profile. That is currently unavoidable and Kino's executor handles it
(settings are applied only after readiness), but if the Pulse API accepts a
profile activation in standby it would be worth exposing the entity as available
and queueing the command.

### B2 — `options` returns the sentinel string `"No profiles configured"`

`select.py:141` returns `["No profiles configured"]` when the profile list is
empty. A consumer validating an option against that list gets a confusing
`'HDR 260 HDMI' is not a valid option ... valid options are: No profiles
configured`. Returning an empty list and letting the entity be `unavailable`
would be clearer. Same pattern in `BarcoSourceSelect.options` with `["Unknown"]`
(`select.py:48`).

### B3 — Laser power is exposed twice with different types

Both `sensor.hodr_cs_laser_power` and `number.hodr_cs_laser_power` exist and both
read `unknown` in standby. That is fine, but the sensor duplicates the number's
value and could be dropped, or the number could be made the single source.

### B4 — There is an HDFury VERTEX2-18 in the signal chain

Not a Barco issue, but worth recording: `switch.hdfury_vertex2_18_*` and
`select.hdfury_vertex2_18_port_select_tx0/tx1` exist in the Kino area and are not
mentioned anywhere in the requirements document. `select.…_port_select_tx1` is
currently `4`. If the HDFury is doing input switching for any activity, it needs
to become a Kino device; if it is a passive splitter, it can be ignored. **Needs a
decision** — see the open questions in `docs/findings.md`.

---

## Suggested order of work

1. **FR-143** (profile shadow) — smallest change, biggest planner win.
2. **FR-140** (phase) — removes the `ready` ambiguity from every consumer.
3. **FR-141** (remaining time) — needs FR-140.
4. **FR-142** (subscriptions) — largest change, biggest latency win.
5. **B2** — trivial, improves every error message.
6. **FR-144** — only if the API supports it.

Once FR-140 and FR-143 land, `custom_components/kino/devices/barco.py` collapses to
roughly the size of `madvr.py`: read the phase sensor, read the profile select,
done.
