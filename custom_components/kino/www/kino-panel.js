/**
 * Kino – admin panel.
 *
 * The single place where the theater is configured and diagnosed (§10).
 * Admin-only, registered in the sidebar by the integration itself.
 *
 * It edits the *document*, not the validated objects, and posts the whole
 * document back for validation — so `kino.yaml` stays the one contract
 * (FR-94) and a file that currently fails validation can still be opened
 * and repaired.
 *
 * The layout follows the "Kino Admin Mobile" design (claude.ai/design
 * project "Home Theater Admin Mobile UI"): a phone-style app with five
 * bottom tabs — Aktivitäten, Geräte, Status, Planer, Mehr — and pushed
 * edit screens instead of the old activity matrix. On desktop the same
 * app renders as a centered column; the navigation model never changes.
 */

const PANEL_VERSION = "0.4.0";

/* ------------------------------------------------------------------ *
 * Pure helpers — no DOM, so they can be unit-tested.                  *
 * ------------------------------------------------------------------ */

export const panelHelpers = {
  /** Deep clone that survives structuredClone being unavailable. */
  clone(value) {
    return JSON.parse(JSON.stringify(value ?? null));
  },

  /** Devices a document defines, in a stable order. */
  deviceKeys(document) {
    return Object.keys(document?.devices || {});
  },

  /** Activities a document defines, in a stable order. */
  activityKeys(document) {
    return Object.keys(document?.activities || {});
  },

  /**
   * The per-activity requirement for one device, normalised.
   *
   * The schema accepts settings inline (`{power: true, source: zidoo}`) or
   * nested under `settings:`. The editor always works with the normalised
   * shape and writes back the inline form.
   */
  requirement(document, activityKey, deviceKey) {
    const raw = document?.activities?.[activityKey]?.devices?.[deviceKey];
    if (!raw) return { present: false, power: false, settings: {} };
    const reserved = new Set(["power", "required", "settings"]);
    const settings = raw.settings
      ? { ...raw.settings }
      : Object.fromEntries(
          Object.entries(raw).filter(([k]) => !reserved.has(k))
        );
    return {
      present: true,
      power: raw.power !== false,
      required: raw.required,
      settings,
    };
  },

  /** Write a requirement back into the document, in inline form. */
  setRequirement(document, activityKey, deviceKey, requirement) {
    const activity = document.activities[activityKey];
    activity.devices = activity.devices || {};
    if (!requirement.present) {
      delete activity.devices[deviceKey];
      return document;
    }
    const entry = { power: requirement.power !== false };
    if (requirement.required != null) entry.required = requirement.required;
    for (const [key, value] of Object.entries(requirement.settings || {})) {
      if (value !== "" && value != null) entry[key] = value;
    }
    activity.devices[deviceKey] = entry;
    return document;
  },

  /** A blank activity, ready to be filled in. */
  blankActivity(name) {
    return { name, control_class: "room", devices: {} };
  },

  /** Turn a display name into a usable config key. */
  slugify(name) {
    const slug = String(name || "")
      .toLowerCase()
      .replace(/ä/g, "ae")
      .replace(/ö/g, "oe")
      .replace(/ü/g, "ue")
      .replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || "aktivitaet";
  },

  /** A key that does not collide with anything already in the document. */
  uniqueKey(document, base) {
    const existing = new Set(panelHelpers.activityKeys(document));
    if (!existing.has(base)) return base;
    let n = 2;
    while (existing.has(`${base}_${n}`)) n += 1;
    return `${base}_${n}`;
  },

  /** Group validation errors by the activity or device they belong to. */
  errorsByPath(errors) {
    const grouped = {};
    for (const error of errors || []) {
      const segments = error.path.split(".");
      const scope =
        segments.length >= 2 ? `${segments[0]}.${segments[1]}` : segments[0];
      (grouped[scope] = grouped[scope] || []).push(error);
    }
    return grouped;
  },

  /**
   * The entities a role may be wired to, filtered by domain.
   *
   * An empty domain list means "the driver does not say", so everything is
   * offered rather than nothing.
   */
  entityOptions(catalogue, domains) {
    const source = catalogue || {};
    const wanted =
      domains && domains.length ? domains : Object.keys(source).sort();
    const out = [];
    for (const domain of wanted) {
      for (const entry of source[domain] || []) {
        // Older payloads were plain ID strings; tolerate both.
        out.push(typeof entry === "string" ? { id: entry, name: entry } : entry);
      }
    }
    return out;
  },

  /** Colour token for a device-board power value. */
  powerColor(power, ready) {
    if (ready) return "var(--kino-teal)";
    switch (power) {
      case "transitioning":
        return "var(--kino-gold)";
      case "unavailable":
      case "unknown":
        return "var(--kino-red)";
      default:
        return "var(--kino-text3)";
    }
  },

  /** Does the observed value match what the activity expects? */
  settingMatches(observed, expected) {
    if (expected == null) return true;
    if (observed == null) return false;
    const a = Number(observed);
    const b = Number(expected);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return Math.abs(a - b) < 1e-6;
    return String(observed) === String(expected);
  },

  /** Seconds -> `2,3 s` / `1:52 min`, for the transition log. */
  formatDuration(seconds) {
    if (seconds == null) return "—";
    if (seconds < 60) return `${Number(seconds).toFixed(1)} s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}:${String(s).padStart(2, "0")} min`;
  },

  /** Label for a planner action, in German. */
  actionLabel(kind) {
    return (
      {
        start: "starten",
        stop: "stoppen",
        reconfigure: "umkonfigurieren",
        keep: "behalten",
      }[kind] || kind
    );
  },

  /** Display name for an activity key — names, never keys (F7). */
  activityName(document, key) {
    if (key == null || key === "") return "—";
    return document?.activities?.[key]?.name || key;
  },

  /** Display name for a device key (F7). */
  deviceName(document, key) {
    return document?.devices?.[key]?.name || key;
  },

  /** "1 Messung", "12 Messungen" — no more "1 Messungen" (F8). */
  countLabel(count, singular, plural) {
    return `${count} ${count === 1 ? singular : plural}`;
  },

  /** German one-liner for a dry-run plan, built from display names (F7). */
  planSummary(actions, nameFn) {
    const parts = [];
    for (const kind of ["stop", "start", "reconfigure", "keep"]) {
      const names = (actions || [])
        .filter((a) => a.kind === kind)
        .map((a) => nameFn(a.device));
      if (names.length) {
        parts.push(`${panelHelpers.actionLabel(kind)}: ${names.join(", ")}`);
      }
    }
    return parts.length ? parts.join(" · ") : "nichts zu tun";
  },
};

/* ------------------------------------------------------------------ *
 * Static markup fragments.                                            *
 * ------------------------------------------------------------------ */

const SVG_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

/** The five tab icons from the mockup. */
const TAB_ICONS = {
  activities: `<svg width="20" height="20" ${SVG_ATTRS}><rect x="3" y="3" width="8" height="8" rx="2"></rect><rect x="13" y="3" width="8" height="8" rx="2"></rect><rect x="3" y="13" width="8" height="8" rx="2"></rect><rect x="13" y="13" width="8" height="8" rx="2"></rect></svg>`,
  devices: `<svg width="20" height="20" ${SVG_ATTRS}><rect x="4" y="4" width="16" height="12" rx="2"></rect><line x1="9" y1="20" x2="15" y2="20"></line></svg>`,
  board: `<svg width="20" height="20" ${SVG_ATTRS}><polyline points="3 12 8 12 10 7 14 17 16 12 21 12"></polyline></svg>`,
  planner: `<svg width="20" height="20" ${SVG_ATTRS}><circle cx="6" cy="6" r="2.5"></circle><circle cx="18" cy="18" r="2.5"></circle><path d="M8.5 6 H15 a3 3 0 0 1 3 3 v6"></path></svg>`,
  more: `<svg width="20" height="20" ${SVG_ATTRS}><circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle></svg>`,
};

const CHEVRON = `<svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 4 17 12 9 20"></polyline></svg>`;
const BACK_ARROW = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 4 7 12 15 20"></polyline></svg>`;

const TABS = [
  ["activities", "Aktivitäten"],
  ["devices", "Geräte"],
  ["board", "Status"],
  ["planner", "Planer"],
  ["more", "Mehr"],
];

const PLAN_BADGES = {
  stop: "STOPPEN",
  start: "STARTEN",
  reconfigure: "UMKONFIG.",
  keep: "BEHALTEN",
};

/* ------------------------------------------------------------------ *
 * Styles — the mockup's tokens, shared with the card.                 *
 * ------------------------------------------------------------------ */

const STYLES = `
:host {
  --kino-bg: oklch(0.15 0.015 265);
  --kino-surface: oklch(0.205 0.016 265);
  --kino-surface2: oklch(0.25 0.017 265);
  --kino-border: oklch(1 0 0 / 0.08);
  --kino-text: oklch(0.97 0.005 265);
  --kino-text2: oklch(0.72 0.01 265);
  --kino-text3: oklch(0.5 0.01 265);
  --kino-gold: oklch(0.78 0.15 75);
  --kino-goldText: oklch(0.18 0.03 75);
  --kino-teal: oklch(0.72 0.12 190);
  --kino-red: oklch(0.65 0.19 25);
  display: block;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  background: var(--kino-bg);
  color: var(--kino-text);
  font-family: Manrope, var(--primary-font-family, system-ui), sans-serif;
  /* The panel sits beside Home Assistant's sidebar, so the viewport width
     lies about the space it actually has — the breakpoint queries the
     panel itself. */
  container-type: inline-size;
}
@media (prefers-color-scheme: light) {
  :host {
    --kino-bg: oklch(0.97 0.004 265);
    --kino-surface: oklch(1 0 0);
    --kino-surface2: oklch(0.93 0.006 265);
    --kino-border: oklch(0 0 0 / 0.1);
    --kino-text: oklch(0.22 0.01 265);
    --kino-text2: oklch(0.42 0.01 265);
    --kino-text3: oklch(0.58 0.01 265);
  }
}
* { -webkit-tap-highlight-color: transparent; }
:focus-visible { outline: 2px solid var(--kino-gold); outline-offset: 2px; }
@keyframes kino-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
@keyframes kino-sheet-in { from{transform:translateY(24px);opacity:0} to{transform:translateY(0);opacity:1} }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}

/* The app frame: header and tab bar pinned, the middle scrolls. */
:host > div { height: 100%; }
.app { display: flex; flex-direction: column; height: 100%; position: relative; }
.content {
  flex: 1 1 auto; overflow-y: auto; min-height: 0;
  scrollbar-width: none; overscroll-behavior: contain;
}
.content::-webkit-scrollbar { display: none; }
/* One column that reads like a big phone on a desktop monitor. */
.page {
  max-width: 720px; margin: 0 auto; width: 100%;
  padding: 2px 20px 32px; box-sizing: border-box;
}

/* -- header ---------------------------------------------------------- */
header { flex-shrink: 0; }
.hrow {
  max-width: 720px; margin: 0 auto; box-sizing: border-box;
  padding: 12px 20px 10px; min-height: 42px;
  display: flex; align-items: center; gap: 10px;
}
.iconbtn {
  width: 34px; height: 34px; border-radius: 17px; border: none;
  background: var(--kino-surface2); color: var(--kino-text2);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; flex-shrink: 0; font: inherit; font-size: 15px;
}
.iconbtn:hover { color: var(--kino-text); }
.titles { flex: 1; min-width: 0; }
.titlerow { display: flex; align-items: baseline; gap: 8px; }
.title {
  font-weight: 800; font-size: 15px; letter-spacing: 1.2px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.badge {
  font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 9px;
  background: var(--kino-surface2); color: var(--kino-text2); letter-spacing: .5px;
  flex-shrink: 0;
}
.keysub { font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--kino-text3); }
.dirtymark { font-size: 11px; color: var(--kino-gold); font-weight: 700; white-space: nowrap; }

/* -- notices and errors ---------------------------------------------- */
.noticewrap { max-width: 720px; margin: 0 auto; padding: 0 20px; box-sizing: border-box; }
.notice {
  margin-bottom: 10px; padding: 10px 14px; border-radius: 12px;
  font-size: 12.5px; font-weight: 600; border: 1px solid;
}
.notice.ok { border-color: var(--kino-teal); background: oklch(0.72 0.12 190 / 0.12); }
.notice.error { border-color: var(--kino-red); background: oklch(0.65 0.19 25 / 0.12); }
.errors {
  border: 1px solid var(--kino-red); background: oklch(0.65 0.19 25 / 0.12);
  border-radius: 12px; padding: 12px 14px; margin-bottom: 14px;
}
.errors strong { font-size: 12.5px; }
.errors .escope { margin-top: 8px; font-size: 12px; font-weight: 700; }
.errors .eline { font-size: 11.5px; color: var(--kino-text2); margin-top: 3px; line-height: 1.5; }

/* -- shared bits ------------------------------------------------------ */
.sub { font-size: 12px; color: var(--kino-text2); margin: 0 0 14px; line-height: 1.5; }
.mono { font-family: ui-monospace, monospace; }
.muted { color: var(--kino-text2); }
.faint { color: var(--kino-text3); }
.bad { color: var(--kino-red); }
.good { color: var(--kino-teal); }
.stack { display: flex; flex-direction: column; gap: 12px; }
.list { display: flex; flex-direction: column; gap: 10px; }
.seclabel {
  font-size: 12px; font-weight: 800; color: var(--kino-text2);
  letter-spacing: .4px; margin: 4px 2px 0;
}
.secrow { display: flex; align-items: center; gap: 10px; margin: 4px 2px 0; }
.secrow .seclabel { flex: 1; margin: 0; }

.card {
  border: 1px solid var(--kino-border); border-radius: 14px;
  background: var(--kino-surface); padding: 14px; box-sizing: border-box;
}

button { font-family: inherit; }
.primary, .ghost, .danger, .dashed {
  font: inherit; font-weight: 700; font-size: 13px; cursor: pointer;
  border-radius: 11px; padding: 11px 16px; min-height: 42px; border: none;
  box-sizing: border-box;
}
.primary { background: var(--kino-gold); color: var(--kino-goldText); font-weight: 800; }
.primary:hover { filter: brightness(1.06); }
.ghost { background: transparent; color: var(--kino-text2); border: 1px solid var(--kino-border); }
.ghost:hover { color: var(--kino-text); border-color: var(--kino-text3); }
.danger { background: transparent; color: var(--kino-red); border: 1px solid var(--kino-red); }
.dashed {
  background: transparent; color: var(--kino-text2);
  border: 1px dashed var(--kino-border); width: 100%;
}
.dashed:hover { color: var(--kino-text); border-color: var(--kino-text3); }
button:disabled { opacity: .45; cursor: not-allowed; }
.small { min-height: 34px; padding: 7px 12px; font-size: 12px; border-radius: 9px; }
.hactions { display: flex; gap: 10px; margin-top: 6px; }
.hactions > * { flex: 1; }

/* -- list rows (activities, devices, more) ---------------------------- */
.rowbtn {
  display: flex; align-items: center; gap: 12px; padding: 14px;
  border-radius: 14px; border: 1px solid var(--kino-border);
  background: var(--kino-surface); color: var(--kino-text);
  cursor: pointer; text-align: left; font: inherit;
  width: 100%; box-sizing: border-box;
}
.rowbtn:hover { border-color: var(--kino-text3); }
.glyph {
  width: 38px; height: 38px; border-radius: 11px; background: var(--kino-surface2);
  color: var(--kino-gold); display: flex; align-items: center; justify-content: center;
  font-weight: 800; font-size: 15px; flex-shrink: 0;
}
.rowbody { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rowtitle { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.rowname { font-weight: 800; font-size: 14px; }
.rowkey {
  font-family: ui-monospace, monospace; font-size: 10.5px; color: var(--kino-text3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.rowsub { font-size: 11.5px; color: var(--kino-text2); }
.drvbadge {
  font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 10px;
  background: var(--kino-surface2); color: var(--kino-text2);
  font-family: ui-monospace, monospace; flex-shrink: 0;
}
.chev { color: var(--kino-text3); flex-shrink: 0; }

/* -- forms ------------------------------------------------------------ */
input, select, textarea {
  font: inherit; font-size: 13px; width: 100%; box-sizing: border-box;
  padding: 9px 11px; border-radius: 9px; min-height: 38px;
  border: 1px solid var(--kino-border);
  background: var(--kino-bg); color: var(--kino-text);
}
input.mono, textarea { font-family: ui-monospace, monospace; font-size: 12px; }
textarea { min-height: 420px; line-height: 1.55; resize: vertical; border-radius: 12px; padding: 12px; }
/* Below 16px iOS zooms into every focused field. */
@media (pointer: coarse) {
  input, select, textarea { font-size: 16px; }
  input.mono, textarea { font-size: 14px; }
}
.formcard { display: flex; flex-direction: column; gap: 11px; }
.frow { display: grid; grid-template-columns: 110px 1fr; gap: 10px; align-items: center; }
.frow > span { font-size: 12px; color: var(--kino-text2); }
.frow.narrowval { grid-template-columns: 1fr 110px; }
.unitrow { display: flex; align-items: center; gap: 8px; }
.unit { font-size: 11px; color: var(--kino-text3); flex-shrink: 0; }

.role { display: flex; flex-direction: column; gap: 5px; }
.rolelabel { font-size: 11.5px; font-weight: 700; color: var(--kino-text2); }
.rolewarn { font-size: 11px; color: var(--kino-red); }

/* -- device blocks inside the activity editor ------------------------- */
.devhead { display: flex; align-items: center; gap: 10px; }
.statelabel { font-size: 11.5px; font-weight: 700; flex-shrink: 0; }
.switch {
  width: 46px; height: 28px; border-radius: 14px; border: none; padding: 2px;
  cursor: pointer; background: var(--kino-surface2);
  display: flex; justify-content: flex-start; flex-shrink: 0;
  transition: background .15s ease;
}
.switch[aria-checked="true"] { background: var(--kino-gold); justify-content: flex-end; }
.knob {
  width: 24px; height: 24px; border-radius: 12px; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.4); display: block;
}
.devsettings {
  margin-top: 12px; display: flex; flex-direction: column; gap: 9px;
  border-top: 1px solid var(--kino-border); padding-top: 12px;
}
.devsettings .frow { grid-template-columns: 88px 1fr; }
.devsettings .frow > span { font-size: 11.5px; }
.chip {
  justify-self: start; font-size: 11px; padding: 5px 10px; border-radius: 12px;
  background: var(--kino-surface2); color: var(--kino-text2);
}

/* -- path map ---------------------------------------------------------- */
.pathrow {
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid var(--kino-border); border-radius: 10px; padding: 10px;
}
.pathto { display: flex; align-items: center; gap: 8px; }
.pathto .arrow { font-size: 11px; color: var(--kino-text3); flex-shrink: 0; }
.pathto input { flex: 1; }
.removebtn {
  width: 36px; height: 36px; border-radius: 9px; border: 1px solid var(--kino-red);
  background: transparent; color: var(--kino-red); cursor: pointer; flex-shrink: 0;
  font: inherit;
}

/* -- device board ------------------------------------------------------ */
.boardhead { display: flex; align-items: center; gap: 9px; }
.dot { width: 9px; height: 9px; border-radius: 5px; flex-shrink: 0; }
.dot.pulse { animation: kino-pulse 1.4s ease-in-out infinite; }
.boardname { font-weight: 800; font-size: 13.5px; flex: 1; min-width: 0; }
.boardpower { margin-top: 6px; font-size: 11.5px; color: var(--kino-text2); }
.boarderror { margin-top: 5px; font-size: 11.5px; color: var(--kino-red); }
.compare {
  margin-top: 9px; border-top: 1px solid var(--kino-border); padding-top: 9px;
  display: flex; flex-direction: column; gap: 4px;
}
.compare .crow { display: flex; gap: 8px; font-family: ui-monospace, monospace; font-size: 11px; }
.compare .ckey { color: var(--kino-text3); min-width: 64px; flex-shrink: 0; }

/* -- planner ----------------------------------------------------------- */
.pills {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  margin: 0 -20px 14px; padding: 2px 20px;
}
.pills::-webkit-scrollbar { display: none; }
.pill {
  flex-shrink: 0; padding: 9px 16px; border-radius: 18px; border: none;
  font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer;
  background: var(--kino-surface2); color: var(--kino-text); min-height: 36px;
}
.pill:hover { filter: brightness(1.1); }
.pill.active { background: var(--kino-gold); color: var(--kino-goldText); }
.plansummary { font-size: 12.5px; font-weight: 700; margin: 0 0 12px; line-height: 1.5; }
.acard { padding: 12px 14px; border-radius: 12px; }
.ahead { display: flex; align-items: center; gap: 8px; }
.ahead .rowname { font-size: 13px; flex: 1; min-width: 0; }
.abadge {
  font-size: 10.5px; font-weight: 800; padding: 3px 9px; border-radius: 10px;
  letter-spacing: .3px; flex-shrink: 0;
  background: var(--kino-surface2); color: var(--kino-text2);
}
.abadge.stop { background: oklch(0.65 0.19 25 / 0.18); color: var(--kino-red); }
.abadge.start { background: oklch(0.72 0.12 190 / 0.16); color: var(--kino-teal); }
.abadge.reconfigure { background: oklch(0.78 0.15 75 / 0.16); color: var(--kino-gold); }
.asettings { margin-top: 6px; font-size: 11px; color: var(--kino-text2); }
.areason { margin-top: 5px; font-size: 11.5px; color: var(--kino-text3); }

/* -- log ---------------------------------------------------------------- */
.tsteps { margin-top: 6px; font-size: 10.5px; color: var(--kino-text2); line-height: 1.6; }
.terror { margin-top: 5px; font-size: 11.5px; color: var(--kino-red); }
.tdur { font-size: 11px; color: var(--kino-text3); flex-shrink: 0; }
.tstatus { font-size: 11px; font-weight: 800; flex-shrink: 0; }
.drow { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border-radius: 12px; }
.dtitle { font-weight: 700; font-size: 12.5px; }
.ddetail { font-size: 11px; color: var(--kino-text3); }
.destimate { font-weight: 800; font-size: 13px; color: var(--kino-gold); flex-shrink: 0; }
.resetbtn {
  width: 34px; height: 34px; border-radius: 9px; border: 1px solid var(--kino-border);
  background: transparent; color: var(--kino-text2); cursor: pointer; flex-shrink: 0;
  font: inherit;
}
.resetbtn:hover { color: var(--kino-text); }

/* -- more --------------------------------------------------------------- */
.morefoot {
  margin-top: 8px; font-size: 11px; color: var(--kino-text3);
  text-align: center; font-family: ui-monospace, monospace;
}

/* -- save bar and tab bar ------------------------------------------------ */
.savebar { flex-shrink: 0; border-top: 1px solid var(--kino-border); background: var(--kino-surface); }
.savebar .inner {
  max-width: 720px; margin: 0 auto; box-sizing: border-box;
  display: flex; gap: 10px; padding: 10px 20px;
}
.savebar .grow { flex: 1; }

nav { flex-shrink: 0; border-top: 1px solid var(--kino-border); background: var(--kino-surface); }
.tabs {
  max-width: 720px; margin: 0 auto; box-sizing: border-box; display: flex;
  padding: 6px 8px calc(8px + env(safe-area-inset-bottom, 0px));
}
.tabbtn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  padding: 7px 0 5px; border: none; background: transparent; border-radius: 10px;
  color: var(--kino-text3); cursor: pointer; font: inherit; min-height: 44px;
}
.tabbtn:hover { color: var(--kino-text2); }
.tabbtn.active, .tabbtn.active:hover { color: var(--kino-gold); }
.tabbtn .ticon { display: flex; width: 22px; height: 22px; align-items: center; justify-content: center; }
.tabbtn .tlbl { font-size: 9.5px; font-weight: 700; letter-spacing: .2px; }

/* -- dialogs: bottom sheet on a phone, centered modal on a desktop ------- */
/* Absolute against the .app frame, so a sheet covers exactly the panel. */
.overlay {
  position: absolute; inset: 0; z-index: 50; background: rgba(0,0,0,.55);
  display: flex; align-items: flex-end; justify-content: center;
}
.sheet {
  width: 100%; background: var(--kino-surface);
  border-top: 1px solid var(--kino-border); border-radius: 20px 20px 0 0;
  padding: 20px 20px calc(24px + env(safe-area-inset-bottom, 0px));
  box-sizing: border-box; animation: kino-sheet-in .18s ease;
}
.sheet .handle { width: 36px; height: 4px; border-radius: 2px; background: var(--kino-surface2); margin: 0 auto 16px; }
.sheet h3 { margin: 0 0 8px; font-size: 15px; font-weight: 800; }
.sheet .sub { margin-bottom: 14px; }
.sheet input { min-height: 44px; font-size: 14px; border-radius: 10px; margin-bottom: 14px; }
.dactions { display: flex; gap: 10px; }
.dactions > * { flex: 1; }

@container (min-width: 760px) {
  .hrow { padding-top: 18px; }
  .overlay { align-items: center; padding: 24px; }
  .sheet {
    max-width: 420px; border-radius: 16px; border: 1px solid var(--kino-border);
    padding: 22px; animation: none;
  }
  .sheet .handle { display: none; }
  .pills { flex-wrap: wrap; overflow-x: visible; }
}
`;

/* ------------------------------------------------------------------ */

const PanelBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class KinoPanel extends PanelBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._tab = "activities";
    //: The pushed detail screen: {screen: "activity"|"device"|"log"|"raw", key?}.
    this._push = null;
    this._document = null;
    this._original = null;
    this._meta = { drivers: {}, entities: {}, knownDrivers: [], controlClasses: [] };
    this._errors = [];
    this._notice = null;
    this._board = null;
    this._log = null;
    this._plan = null;
    this._plannerTarget = "";
    this._saving = false;
    this._rawText = "";
    //: The styled dialog replacing prompt()/confirm() (F14).
    this._dialog = null;
  }

  set hass(hass) {
    const first = this._hass === null;
    this._hass = hass;
    if (first) this._load();
  }

  set narrow(value) {
    const changed = this._narrow !== value;
    this._narrow = value;
    // A custom panel draws its own toolbar, so it also owns the only way
    // back to the sidebar on a phone.
    if (changed && this._document) this._render();
  }

  connectedCallback() {
    this._render();
  }

  disconnectedCallback() {
    clearTimeout(this._noticeTimer);
    clearTimeout(this._validateTimer);
  }

  get _dirty() {
    return JSON.stringify(this._document) !== JSON.stringify(this._original);
  }

  /* -- data ---------------------------------------------------------- */

  _ws(message) {
    return this._hass.callWS(message);
  }

  async _load() {
    try {
      const result = await this._ws({ type: "kino/config/get" });
      this._document = result.document || { version: 1, devices: {}, activities: {} };
      this._original = panelHelpers.clone(this._document);
      this._meta = {
        drivers: result.drivers || {},
        entities: result.entities || {},
        knownDrivers: result.knownDrivers || [],
        controlClasses: result.controlClasses || [],
      };
      this._errors = result.errors || [];
      this._path = result.path;
      this._rawText = JSON.stringify(this._document, null, 2);
    } catch (err) {
      this._notice = { kind: "error", text: err.message || String(err) };
    }
    this._render();
  }

  /**
   * Validate quietly after every edit, so the error card is always current
   * without a "Prüfen" button. Debounced — typing a name is not ten calls.
   */
  _scheduleValidate() {
    clearTimeout(this._validateTimer);
    this._validateTimer = setTimeout(async () => {
      try {
        const result = await this._ws({
          type: "kino/config/validate",
          document: this._document,
        });
        this._errors = result.errors || [];
        this._render();
      } catch (err) {
        // Keep the last known errors; a broken connection is not "valid".
      }
    }, 600);
  }

  async _save() {
    this._saving = true;
    this._render();
    try {
      const result = await this._ws({
        type: "kino/config/save",
        document: this._document,
      });
      this._errors = result.errors;
      if (result.saved) {
        this._original = panelHelpers.clone(this._document);
        this._notify("ok", "Gespeichert und übernommen — kein Neustart nötig.");
        await this._load();
      } else {
        this._notify(
          "error",
          "Nicht gespeichert — die bestehende Konfiguration läuft weiter."
        );
      }
    } catch (err) {
      this._notify("error", err.message);
    }
    this._saving = false;
    this._render();
  }

  _revert() {
    this._document = panelHelpers.clone(this._original);
    this._rawText = JSON.stringify(this._document, null, 2);
    this._notice = null;
    this._scheduleValidate();
    this._render();
  }

  async _loadBoard() {
    try {
      this._board = await this._ws({ type: "kino/device_board" });
    } catch (err) {
      this._board = { devices: [], error: err.message };
    }
    this._render();
  }

  async _loadLog() {
    try {
      this._log = await this._ws({ type: "kino/transition_log" });
    } catch (err) {
      this._log = { transitions: [], durations: [], error: err.message };
    }
    this._render();
  }

  async _dryRun(activity) {
    this._plannerTarget = activity;
    try {
      this._plan = await this._ws({ type: "kino/dry_run", activity });
    } catch (err) {
      this._plan = { summary: err.message, actions: [], error: true };
    }
    this._render();
  }

  async _deviceTest(device, action) {
    const name = panelHelpers.deviceName(this._document, device);
    try {
      const result = await this._ws({ type: "kino/device_test", device, action });
      this._notify(
        "ok",
        `${name}: ${action} → ${result.power}${result.ready ? " (bereit)" : ""}`
      );
    } catch (err) {
      this._notify("error", `${name}: ${err.message}`);
    }
    await this._loadBoard();
  }

  async _resetDurations(device) {
    await this._ws({ type: "kino/durations/reset", device: device || null }).catch(
      () => {}
    );
    await this._loadLog();
  }

  /* -- rendering ----------------------------------------------------- */

  _esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  /** Ok-notices dissolve on their own; errors stay until the next action. */
  _notify(kind, text) {
    this._notice = { kind, text };
    clearTimeout(this._noticeTimer);
    if (kind === "ok") {
      this._noticeTimer = setTimeout(() => {
        this._notice = null;
        this._render();
      }, 3200);
    }
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    if (!this._styleEl) {
      this._styleEl = document.createElement("style");
      this._styleEl.textContent = STYLES;
      this.shadowRoot.appendChild(this._styleEl);
      this._root = document.createElement("div");
      this.shadowRoot.appendChild(this._root);
      this._root.addEventListener("click", (e) => this._onClick(e));
      this._root.addEventListener("change", (e) => this._onChange(e));
      this._root.addEventListener("input", (e) => {
        // The raw textarea keeps its state without a re-render per keystroke.
        if (e.target?.dataset?.field === "raw") this._rawText = e.target.value;
      });
      this._root.addEventListener("keydown", (e) => this._onKeydown(e));
    }

    if (!this._document) {
      this._root.innerHTML = `<div class="app"><div class="content"><div class="page">
        <p class="sub" style="margin-top:24px">${this._esc(
          this._notice ? this._notice.text : "Konfiguration wird geladen…"
        )}</p>
      </div></div></div>`;
      return;
    }

    // A pushed screen whose subject was deleted (raw edit, revert) pops.
    const push = this._push;
    if (push?.screen === "activity" && !this._document.activities[push.key]) {
      this._push = null;
    } else if (push?.screen === "device" && !this._document.devices[push.key]) {
      this._push = null;
    }

    this._root.innerHTML = `<div class="app">
      ${this._renderHeader()}
      <div class="noticewrap">${this._renderNotice()}</div>
      <div class="content"><div class="page">${this._renderScreen()}</div></div>
      ${this._renderSaveBar()}
      ${this._renderTabBar()}
      ${this._renderDialog()}
    </div>`;

    // A fresh innerHTML drops focus to the body; put it back where the
    // keyboard can do something. The safe button gets it in confirm dialogs,
    // so Enter never destroys and Escape always closes.
    if (this._dialog && !this.shadowRoot.activeElement) {
      const target =
        this._root.querySelector('[data-field="dialog-input"]') ||
        this._root.querySelector('.dactions [data-act="dialog-cancel"]');
      if (target) target.focus();
    }
  }

  _renderHeader() {
    const push = this._push;
    let title = "KINO";
    let sub = "";
    if (push?.screen === "activity") {
      title = panelHelpers.activityName(this._document, push.key);
      sub = push.key;
    } else if (push?.screen === "device") {
      title = panelHelpers.deviceName(this._document, push.key);
      sub = push.key;
    } else if (push?.screen === "log") {
      title = "Verlauf";
    } else if (push?.screen === "raw") {
      title = "Datei";
    }

    const lead = push
      ? `<button class="iconbtn" data-act="back" aria-label="Zurück">${BACK_ARROW}</button>`
      : this._narrow
        ? '<button class="iconbtn" data-act="toggle-sidebar" aria-label="Menü">☰</button>'
        : "";

    return `<header><div class="hrow">
      ${lead}
      <div class="titles">
        <div class="titlerow">
          <span class="title">${this._esc(title)}</span>
          ${push ? "" : '<span class="badge">ADMIN</span>'}
        </div>
        ${sub ? `<div class="keysub">${this._esc(sub)}</div>` : ""}
      </div>
      ${this._dirty ? '<span class="dirtymark">● Ungespeichert</span>' : ""}
    </div></header>`;
  }

  _renderNotice() {
    if (!this._notice) return "";
    const cls = this._notice.kind === "ok" ? "ok" : "error";
    return `<div class="notice ${cls}" role="status">${this._esc(this._notice.text)}</div>`;
  }

  /**
   * Validation errors, grouped under the activity or device they belong to,
   * so ten errors in one activity read as one problem, not ten (WS-4).
   * With a scope only that subject's errors show — the edit screens stay
   * about the thing being edited.
   */
  _renderErrors(scope = null) {
    let errors = this._errors;
    if (scope) {
      errors = errors.filter(
        (e) => e.path === scope || e.path.startsWith(`${scope}.`)
      );
    }
    if (!errors.length) return "";
    const grouped = panelHelpers.errorsByPath(errors);
    const scopeLabel = (group) => {
      const [head, key] = group.split(".");
      if (head === "activities" && key) {
        return `Aktivität „${this._esc(panelHelpers.activityName(this._document, key))}“`;
      }
      if (head === "devices" && key) {
        return `Gerät „${this._esc(panelHelpers.deviceName(this._document, key))}“`;
      }
      return `<span class="mono">${this._esc(group)}</span>`;
    };
    return `<div class="errors">
      <strong>${errors.length} Fehler in der Konfiguration</strong>
      ${Object.entries(grouped)
        .map(
          ([group, list]) => `
        <div class="escope">${scopeLabel(group)}</div>
        ${list
          .map(
            (e) =>
              `<div class="eline"><span class="mono">${this._esc(e.path)}</span> — ${this._esc(e.message)}</div>`
          )
          .join("")}`
        )
        .join("")}
    </div>`;
  }

  _renderSaveBar() {
    if (!this._dirty) return "";
    return `<div class="savebar"><div class="inner">
      <button class="ghost" data-act="revert">Verwerfen</button>
      <button class="primary grow" data-act="save" ${this._saving ? "disabled" : ""}>
        ${this._saving ? "Speichert…" : "Speichern"}
      </button>
    </div></div>`;
  }

  _renderTabBar() {
    return `<nav><div class="tabs">
      ${TABS.map(([key, label]) => {
        const active = this._tab === key;
        return `<button class="tabbtn ${active ? "active" : ""}" data-act="tab"
          data-key="${key}" ${active ? 'aria-current="page"' : ""}>
          <span class="ticon">${TAB_ICONS[key]}</span>
          <span class="tlbl">${label}</span>
        </button>`;
      }).join("")}
    </div></nav>`;
  }

  _renderScreen() {
    const push = this._push;
    if (push?.screen === "activity") return this._renderActivityEdit(push.key);
    if (push?.screen === "device") return this._renderDeviceEdit(push.key);
    if (push?.screen === "log") return this._renderLog();
    if (push?.screen === "raw") return this._renderRaw();
    switch (this._tab) {
      case "devices":
        return this._renderDevices();
      case "board":
        return this._renderBoard();
      case "planner":
        return this._renderPlanner();
      case "more":
        return this._renderMore();
      default:
        return this._renderActivities();
    }
  }

  /* -- 10.1 activities (FR-110 .. FR-114) ----------------------------- */

  _renderActivities() {
    const doc = this._document;
    const rows = panelHelpers.activityKeys(doc).map((key) => {
      const activity = doc.activities[key];
      const name = activity.name || key;
      const n = Object.keys(activity.devices || {}).length;
      const parts = [activity.control_class || "room"];
      if (activity.media) parts.push("Jellyfin");
      parts.push(n === 0 ? "keine Geräte" : n === 1 ? "1 Gerät" : `${n} Geräte`);
      return `<button class="rowbtn" data-act="open-activity" data-key="${this._esc(key)}">
        <span class="glyph" aria-hidden="true">${this._esc(name.charAt(0).toUpperCase())}</span>
        <span class="rowbody">
          <span class="rowtitle">
            <span class="rowname">${this._esc(name)}</span>
            <span class="rowkey">${this._esc(key)}</span>
          </span>
          <span class="rowsub">${this._esc(parts.join(" · "))}</span>
        </span>
        ${CHEVRON}
      </button>`;
    });

    return `
      <p class="sub">Jede Aktivität einzeln bearbeiten. Werte kommen aus den
        echten Geräten. Änderungen greifen nach dem Speichern ohne Neustart.</p>
      ${this._renderErrors()}
      <div class="list">${rows.join("")}</div>
      <button class="dashed" data-act="add-activity" style="margin-top:14px">+ Aktivität</button>`;
  }

  _renderActivityEdit(key) {
    const doc = this._document;
    const activity = doc.activities[key];
    const offActivity = doc.settings?.off_activity || "aus";
    const deleteDisabled = key === offActivity;

    const devices = panelHelpers
      .deviceKeys(doc)
      .map((deviceKey) => this._renderActivityDevice(key, deviceKey));

    return `<div class="stack">
      ${this._renderErrors(`activities.${key}`)}
      <div class="card formcard">
        <div class="frow"><span>Name</span>
          <input data-field="activity-name" data-activity="${this._esc(key)}"
            value="${this._esc(activity.name || "")}"></div>
        <div class="frow"><span>Steuerungsklasse</span>
          <select data-field="control-class" data-activity="${this._esc(key)}">
            ${this._meta.controlClasses
              .map(
                (c) =>
                  `<option value="${c}"${
                    (activity.control_class || "room") === c ? " selected" : ""
                  }>${c}</option>`
              )
              .join("")}
          </select></div>
        <div class="frow"><span>Medien</span>
          <select data-field="media" data-activity="${this._esc(key)}">
            <option value=""${!activity.media ? " selected" : ""}>keine</option>
            <option value="jellyfin"${
              activity.media === "jellyfin" ? " selected" : ""
            }>jellyfin</option>
          </select></div>
        <div class="frow"><span>Lichtszene</span>
          ${this._entitySelect("light-scene", key, activity.light_scene || "", ["scene"])}</div>
        <div class="frow"><span>Icon</span>
          <input class="mono" data-field="icon" data-activity="${this._esc(key)}"
            placeholder="mdi:…" value="${this._esc(activity.icon || "")}"></div>
      </div>

      <div class="seclabel">GERÄTE</div>
      ${devices.join("")}

      <div class="hactions">
        <button class="ghost" data-act="duplicate-activity" data-key="${this._esc(key)}">⧉ Duplizieren</button>
        <button class="danger" data-act="delete-activity" data-key="${this._esc(key)}"
          ${deleteDisabled ? 'disabled title="Die Aus-Aktivität kann nicht gelöscht werden"' : ""}>✕ Löschen</button>
      </div>
    </div>`;
  }

  /** One device block in the activity editor: toggle plus live settings. */
  _renderActivityDevice(activityKey, deviceKey) {
    const requirement = panelHelpers.requirement(
      this._document,
      activityKey,
      deviceKey
    );
    const on = requirement.present && requirement.power;
    const name = panelHelpers.deviceName(this._document, deviceKey);
    const catalogue = this._meta.drivers[deviceKey];
    const settings = (catalogue && catalogue.settings) || {};

    const inputs = Object.entries(settings)
      .map(([settingName, described]) => {
        const value = requirement.settings[settingName];
        if (described.type === "number") {
          // A bare number reads like a mystery; the volume is dB (F11).
          const unit = settingName === "volume" ? "dB" : null;
          return `<div class="frow"><span>${this._esc(settingName)}</span>
            <div class="unitrow">
              <input type="number" step="0.5" data-field="device-setting"
                data-activity="${this._esc(activityKey)}" data-device="${this._esc(deviceKey)}"
                data-setting="${this._esc(settingName)}" value="${
                  value == null ? "" : this._esc(value)
                }">${unit ? `<span class="unit">${unit}</span>` : ""}
            </div></div>`;
        }
        const options = described.options || [];
        if (!options.length) {
          // FR-112 says never free-text — but an off device has no list. A
          // compact chip says so once; the sentence lives in the tooltip.
          return `<div class="frow"><span>${this._esc(settingName)}</span>
            <span class="chip" title="Gerät aus — Werte nicht abrufbar. Der gesetzte Wert wird beim Start angewendet.">aus · ${
              value ? `gesetzt: ${this._esc(value)}` : "—"
            }</span></div>`;
        }
        return `<div class="frow"><span>${this._esc(settingName)}</span>
          <select data-field="device-setting" data-activity="${this._esc(activityKey)}"
            data-device="${this._esc(deviceKey)}" data-setting="${this._esc(settingName)}">
            <option value="">—</option>
            ${options
              .map(
                (o) =>
                  `<option value="${this._esc(o)}"${
                    String(value) === String(o) ? " selected" : ""
                  }>${this._esc(o)}</option>`
              )
              .join("")}
          </select></div>`;
      })
      .join("");

    return `<div class="card">
      <div class="devhead">
        <span class="rowbody">
          <span class="rowname" style="font-size:13.5px">${this._esc(name)}</span>
          <span class="rowkey">${this._esc(deviceKey)}</span>
        </span>
        <span class="statelabel ${on ? "good" : "faint"}">${on ? "an" : "aus"}</span>
        <button class="switch" role="switch" aria-checked="${on}"
          aria-label="${this._esc(name)} in dieser Aktivität"
          data-act="toggle-device" data-activity="${this._esc(activityKey)}"
          data-device="${this._esc(deviceKey)}"><span class="knob"></span></button>
      </div>
      ${on && inputs ? `<div class="devsettings">${inputs}</div>` : ""}
    </div>`;
  }

  _entitySelect(field, activityKey, value, domains) {
    const options = this._entityOptions(domains);
    const known = !value || options.some((o) => o.id === value);
    return `<select data-field="${field}" data-activity="${this._esc(activityKey)}">
      <option value=""${!value ? " selected" : ""}>—</option>
      ${!known ? `<option value="${this._esc(value)}" selected>${this._esc(value)} (fehlt!)</option>` : ""}
      ${options
        .map(
          (o) =>
            `<option value="${this._esc(o.id)}"${value === o.id ? " selected" : ""}>${this._esc(
              o.name
            )}</option>`
        )
        .join("")}
    </select>`;
  }

  /* -- 10.3 device wiring (FR-130) ----------------------------------- */

  /** Entities the picker for a role may offer, filtered by domain. */
  _entityOptions(domains) {
    return panelHelpers.entityOptions(this._meta.entities, domains);
  }

  _renderDevices() {
    const doc = this._document;
    const rows = panelHelpers.deviceKeys(doc).map((key) => {
      const device = doc.devices[key];
      const catalogue = this._meta.drivers[key] || {};
      const missing = catalogue.missingEntities || [];
      const wired = Object.keys(device.entities || {}).length;
      const summary = missing.length
        ? `Fehlende Entities: ${missing.join(", ")}`
        : `${panelHelpers.countLabel(wired, "Entity", "Entities")} verdrahtet`;
      return `<button class="rowbtn" data-act="open-device" data-key="${this._esc(key)}">
        <span class="rowbody">
          <span class="rowtitle">
            <span class="rowname">${this._esc(device.name || key)}</span>
            <span class="rowkey">${this._esc(key)}</span>
          </span>
          <span class="rowsub ${missing.length ? "bad" : ""}">${this._esc(summary)}</span>
        </span>
        <span class="drvbadge">${this._esc(device.driver)}</span>
        ${CHEVRON}
      </button>`;
    });

    return `
      <p class="sub">Welche Home-Assistant-Entity welches logische Gerät
        bedient. Mit <strong>*</strong> markierte Rollen braucht der Treiber
        zwingend.</p>
      ${this._renderErrors()}
      <div class="list">${rows.join("")}</div>`;
  }

  _renderDeviceEdit(key) {
    const doc = this._document;
    const device = doc.devices[key];
    const catalogue = this._meta.drivers[key] || {};
    const roles =
      catalogue.roles && catalogue.roles.length
        ? catalogue.roles
        : Object.keys(device.entities || {}).map((role) => ({
            role,
            domains: [],
            required: false,
          }));

    return `<div class="stack">
      ${this._renderErrors(`devices.${key}`)}
      <div class="card formcard">
        <div class="frow"><span>Treiber</span>
          <select data-field="device-driver" data-device="${this._esc(key)}">
            ${this._meta.knownDrivers
              .map(
                (d) =>
                  `<option value="${d}"${device.driver === d ? " selected" : ""}>${d}</option>`
              )
              .join("")}
          </select></div>
        <div class="frow"><span>Name</span>
          <input data-field="device-name" data-device="${this._esc(key)}"
            value="${this._esc(device.name || "")}"></div>
      </div>

      <div class="seclabel">ENTITIES</div>
      <div class="card formcard" style="gap:12px">
        ${roles.map((role) => this._entityPicker(key, role)).join("")}
      </div>

      <div class="card formcard">
        <div class="frow narrowval"><span>Start-Timeout (s)</span>
          <input type="number" data-field="device-number" data-device="${this._esc(key)}"
            data-key="startup_timeout" value="${device.startup_timeout ?? 180}"></div>
        <div class="frow narrowval"><span>Startdauer ≈ (s)</span>
          <input type="number" data-field="device-number" data-device="${this._esc(key)}"
            data-key="default_startup_seconds" value="${device.default_startup_seconds ?? 30}"></div>
      </div>

      ${device.driver === "zidoo" ? this._renderPathMap(key) : ""}
    </div>`;
  }

  /**
   * One role, wired through a searchable, type-filtered picker (FR-130).
   *
   * A `<datalist>` gives the browser's own search-as-you-type over a list
   * that only contains entities of the domains the driver can actually use —
   * a `power` role never offers a sensor. The field stays a text input, so an
   * entity that is currently unavailable can still be typed in, and is
   * flagged rather than silently dropped.
   */
  _entityPicker(deviceKey, role) {
    const entities = this._document.devices[deviceKey].entities || {};
    const value = entities[role.role] || "";
    const options = this._entityOptions(role.domains);
    const listId = `entities-${deviceKey}-${role.role}`;
    const missing = role.required && !value;
    const unknown = value && !options.some((o) => o.id === value);
    const hint = (role.domains || []).length
      ? role.domains.map((d) => `${d}.…`).join(" / ")
      : "entity_id";
    return `<div class="role">
      <span class="rolelabel ${missing ? "bad" : ""}">${this._esc(role.role)}${
        role.required ? " *" : ""
      }</span>
      <input class="mono" list="${listId}" placeholder="${this._esc(hint)}"
        data-field="device-entity" data-device="${this._esc(deviceKey)}"
        data-role="${this._esc(role.role)}" value="${this._esc(value)}">
      <datalist id="${listId}">
        ${options
          .map(
            (o) =>
              `<option value="${this._esc(o.id)}" label="${this._esc(o.name)}"></option>`
          )
          .join("")}
      </datalist>
      ${unknown ? '<span class="rolewarn">Diese Entity existiert nicht</span>' : ""}
    </div>`;
  }

  /** Prefix rewrites from catalogue paths to player paths (FR-46). */
  _renderPathMap(deviceKey) {
    const device = this._document.devices[deviceKey];
    const map = (device.options && device.options.path_map) || {};
    const rows = Object.entries(map)
      .map(
        ([from, to]) => `<div class="pathrow">
          <input class="mono" data-field="path-map-from" data-device="${this._esc(deviceKey)}"
            data-key="${this._esc(from)}" value="${this._esc(from)}"
            aria-label="Pfad in der Bibliothek">
          <div class="pathto">
            <span class="arrow">→</span>
            <input class="mono" data-field="path-map-to" data-device="${this._esc(deviceKey)}"
              data-key="${this._esc(from)}" value="${this._esc(to)}"
              aria-label="Pfad auf dem Player">
            <button class="removebtn" data-act="path-map-remove" data-key="${this._esc(deviceKey)}"
              data-mode="${this._esc(from)}" title="Entfernen" aria-label="Zuordnung entfernen">✕</button>
          </div>
        </div>`
      )
      .join("");
    return `<div class="card">
      <div style="font-size:12.5px;font-weight:800;margin-bottom:4px">Pfad-Zuordnung</div>
      <p class="sub" style="margin-bottom:10px">
        Links der Pfad aus der Bibliothek, rechts der Pfad, unter dem der
        Player dieselbe Datei öffnet. Ohne passenden Eintrag lässt sich ein
        Titel nicht abspielen — die Karte nennt dann den Pfad.
      </p>
      <div class="list">${rows || '<p class="sub" style="margin:0">Noch keine Zuordnung.</p>'}</div>
      <button class="dashed small" data-act="path-map-add" data-key="${this._esc(deviceKey)}"
        style="margin-top:10px">+ Zuordnung</button>
    </div>`;
  }

  /* -- 10.2 diagnostics ---------------------------------------------- */

  _renderBoard() {
    if (!this._board) {
      return '<p class="sub">Gerätestatus wird geladen…</p>';
    }
    const board = this._board;
    const nameOf = (key) => panelHelpers.activityName(this._document, key);

    // "Aktive Aktivität film" while everything shuts down reads like a lie —
    // say what the comparison is actually against. Names, never keys (F7).
    const target = board.targetActivity;
    let context;
    if (board.error) {
      context = "";
    } else if (board.state === "off") {
      context = "Das Kino ist ausgeschaltet — erwartet ist: alle Geräte aus.";
    } else if (target && target !== board.activity) {
      context = `Wechsel zu <strong>${this._esc(nameOf(target))}</strong> läuft —
        verglichen wird noch mit <strong>${this._esc(nameOf(board.activity))}</strong>.`;
    } else {
      context = `Beobachteter gegen erwarteten Zustand für die aktive Aktivität
        <strong>${this._esc(nameOf(board.activity))}</strong>.`;
    }

    const cards = (board.devices || []).map((device) => {
      const color = panelHelpers.powerColor(device.power, device.ready);
      const transitioning = device.power === "transitioning";
      const readyLabel = device.ready
        ? "bereit"
        : transitioning
          ? device.phase || "startet"
          : device.power === "unavailable" || device.power === "unknown"
            ? device.power
            : "aus";
      const readyClass = device.ready
        ? "good"
        : transitioning
          ? ""
          : device.power === "unavailable" || device.power === "unknown"
            ? "bad"
            : "faint";
      const idleButUnneeded =
        board.state === "on" && !device.requiredByActivity && device.power === "off";
      // Some drivers report the power value again as their phase — saying
      // "off (off)" helps nobody.
      const phase =
        device.phase && device.phase !== device.power ? ` (${device.phase})` : "";
      const powerLabel = idleButUnneeded
        ? `wird von „${nameOf(board.activity)}“ nicht benötigt`
        : `Zustand: ${device.power}${phase}`;

      const keys = new Set([
        ...Object.keys(device.expected || {}),
        ...Object.keys(device.observed || {}),
      ]);
      const comparison = [...keys]
        .map((key) => {
          const expected = (device.expected || {})[key];
          if (expected == null) return "";
          const observed = (device.observed || {})[key];
          const ok = panelHelpers.settingMatches(observed, expected);
          return `<div class="crow">
            <span class="ckey">${this._esc(key)}</span>
            <span class="${ok ? "good" : "bad"}">${this._esc(observed ?? "—")} / soll ${this._esc(expected)}</span>
          </div>`;
        })
        .join("");

      const problem = device.error || device.drift;

      return `<div class="card">
        <div class="boardhead">
          <span class="dot ${transitioning ? "pulse" : ""}" style="background:${color}"></span>
          <span class="boardname">${this._esc(device.name)}</span>
          <span class="statelabel ${readyClass}" ${
            transitioning ? 'style="color:var(--kino-gold)"' : ""
          }>${this._esc(readyLabel)}</span>
        </div>
        <div class="boardpower">${this._esc(powerLabel)}</div>
        ${problem ? `<div class="boarderror">${this._esc(problem)}</div>` : ""}
        ${comparison ? `<div class="compare">${comparison}</div>` : ""}
        <div class="hactions" style="margin-top:11px">
          <button class="ghost small" data-act="device-test" data-key="${this._esc(device.key)}" data-mode="start">Start</button>
          <button class="ghost small" data-act="device-test" data-key="${this._esc(device.key)}" data-mode="stop">Stopp</button>
        </div>
      </div>`;
    });

    return `
      <p class="sub">${context} Start und Stopp wirken nur auf dieses eine Gerät.</p>
      ${board.error ? `<div class="notice error">${this._esc(board.error)}</div>` : ""}
      <button class="ghost small" data-act="reload-board" style="margin-bottom:12px">↻ Aktualisieren</button>
      <div class="list">${cards.join("")}</div>`;
  }

  _renderPlanner() {
    const activities = panelHelpers.activityKeys(this._document);
    const pills = activities
      .map(
        (key) =>
          `<button class="pill ${this._plannerTarget === key ? "active" : ""}"
            data-act="dry-run" data-key="${this._esc(key)}">${this._esc(
              panelHelpers.activityName(this._document, key)
            )}</button>`
      )
      .join("");

    let result = '<p class="sub faint">Eine Aktivität wählen.</p>';
    if (this._plan) {
      const actions = (this._plan.actions || [])
        .map((a) => {
          const settings = Object.entries(a.settings || {})
            .map(([k, v]) => `${k}=${v}`)
            .join(", ");
          const badge = PLAN_BADGES[a.kind] || this._esc(String(a.kind).toUpperCase());
          return `<div class="card acard">
            <div class="ahead">
              <span class="rowname">${this._esc(
                panelHelpers.deviceName(this._document, a.device)
              )}</span>
              <span class="abadge ${this._esc(a.kind)}">${badge}</span>
            </div>
            ${settings ? `<div class="asettings mono">${this._esc(settings)}</div>` : ""}
            <div class="areason">${this._esc(a.reason)}</div>
          </div>`;
        })
        .join("");
      const summary = this._plan.error
        ? this._plan.summary
        : panelHelpers.planSummary(this._plan.actions, (key) =>
            panelHelpers.deviceName(this._document, key)
          );
      result = `<p class="plansummary ${this._plan.error ? "bad" : ""}">${this._esc(summary)}</p>
        <div class="list">${actions}</div>`;
    }

    return `
      <p class="sub">Zeigt den berechneten Unterschied vom aktuellen Zustand zu
        einer Aktivität — ohne irgendetwas auszuführen. So lässt sich eine neue
        Aktivität prüfen, bevor sie zum ersten Mal läuft.</p>
      <div class="pills hscroll">${pills}</div>
      ${result}`;
  }

  _renderMore() {
    const file = (this._path || "kino.yaml").split(/[\\/]/).pop();
    return `<div class="list">
      <button class="rowbtn" data-act="open-log">
        <span class="rowbody">
          <span class="rowname">Verlauf</span>
          <span class="rowsub">Übergänge und gelernte Dauern</span>
        </span>
        ${CHEVRON}
      </button>
      <button class="rowbtn" data-act="open-raw">
        <span class="rowbody">
          <span class="rowname">Datei</span>
          <span class="rowsub">Das Dokument als JSON — sichern und einspielen</span>
        </span>
        ${CHEVRON}
      </button>
    </div>
    <div class="morefoot">kino-panel ${PANEL_VERSION} · ${this._esc(file)} · .bak wird behalten</div>`;
  }

  _renderLog() {
    if (!this._log) {
      return '<p class="sub">Verlauf wird geladen…</p>';
    }
    const activityName = (key) => panelHelpers.activityName(this._document, key);
    const deviceName = (key) => panelHelpers.deviceName(this._document, key);

    const transitions = (this._log.transitions || [])
      .slice()
      .reverse()
      .map((t) => {
        const steps = (t.steps || [])
          .map(
            (s) =>
              `${deviceName(s.device)} ${panelHelpers.actionLabel(s.kind)} ${panelHelpers.formatDuration(s.seconds)}`
          )
          .join(" · ");
        return `<div class="card acard">
          <div class="ahead">
            <span class="rowname">${this._esc(activityName(t.from_activity))} → ${this._esc(
              activityName(t.to_activity)
            )}</span>
            <span class="tstatus ${t.succeeded ? "good" : "bad"}">${
              t.succeeded ? "ok" : "Fehler"
            }</span>
            <span class="tdur">${panelHelpers.formatDuration(t.duration_seconds)}</span>
          </div>
          ${steps ? `<div class="tsteps mono">${this._esc(steps)}</div>` : ""}
          ${t.error ? `<div class="terror">${this._esc(t.error)}</div>` : ""}
        </div>`;
      })
      .join("");

    const durations = (this._log.durations || [])
      .map(
        (d) => `<div class="card drow">
          <span class="rowbody" style="gap:1px">
            <span class="dtitle">${this._esc(deviceName(d.device))} · ${this._esc(d.kind)}${
              d.from ? ` (${this._esc(d.from)})` : ""
            }</span>
            <span class="ddetail">${panelHelpers.countLabel(
              d.samples,
              "Messung",
              "Messungen"
            )}, ${panelHelpers.formatDuration(d.min_seconds)}–${panelHelpers.formatDuration(
              d.max_seconds
            )}</span>
          </span>
          <span class="destimate">${panelHelpers.formatDuration(d.seconds)}</span>
          <button class="resetbtn" data-act="reset-durations" data-key="${this._esc(d.device)}"
            title="Zurücksetzen" aria-label="Gelernte Dauern für ${this._esc(
              deviceName(d.device)
            )} zurücksetzen">↺</button>
        </div>`
      )
      .join("");

    return `
      ${this._log.error ? `<div class="notice error">${this._esc(this._log.error)}</div>` : ""}
      <div class="secrow" style="margin-bottom:10px">
        <span class="seclabel">ÜBERGÄNGE</span>
        <button class="ghost small" data-act="reload-log">↻ Aktualisieren</button>
      </div>
      <div class="list">${transitions || '<p class="sub" style="margin:0">Noch keine Übergänge.</p>'}</div>
      <div class="secrow" style="margin:20px 2px 10px">
        <span class="seclabel">GELERNTE DAUERN</span>
        <button class="danger small" data-act="reset-durations">Alle zurücksetzen</button>
      </div>
      <div class="list" style="gap:8px">${
        durations || '<p class="sub" style="margin:0">Noch nichts gelernt.</p>'
      }</div>`;
  }

  /* -- 10.3 export / import (FR-134) --------------------------------- */

  _renderRaw() {
    return `<div class="stack">
      <p class="sub" style="margin:0">
        Das komplette Dokument als JSON — zum Sichern, Versionieren oder für
        eine Änderung, die der Editor nicht abbildet. Gespeichert wird als
        YAML nach <span class="mono">${this._esc(this._path || "kino.yaml")}</span>;
        die vorherige Fassung bleibt als <span class="mono">.bak</span> liegen.
      </p>
      <div class="hactions" style="margin-top:0">
        <button class="ghost" data-act="copy-raw">In die Zwischenablage</button>
        <button class="primary" data-act="apply-raw">Übernehmen</button>
      </div>
      <textarea data-field="raw" spellcheck="false"
        aria-label="Konfiguration als JSON">${this._esc(this._rawText)}</textarea>
    </div>`;
  }

  /* -- dialogs --------------------------------------------------------- */

  /** The sheet-style dialog that replaced prompt()/confirm() (F14). */
  _renderDialog() {
    const d = this._dialog;
    if (!d) return "";
    let title;
    let body = "";
    let input = "";
    let confirmLabel = "OK";
    let danger = false;
    if (d.kind === "add-activity") {
      title = "Neue Aktivität";
      body =
        "Der Schlüssel wird aus dem Namen abgeleitet. Wirksam wird das erst mit „Speichern“.";
      input =
        '<input data-field="dialog-input" placeholder="Name der Aktivität" autocomplete="off">';
      confirmLabel = "Anlegen";
    } else if (d.kind === "delete-activity") {
      title = `Aktivität „${this._esc(
        panelHelpers.activityName(this._document, d.key)
      )}“ löschen?`;
      body =
        "Die Aktivität und ihre Geräteeinstellungen werden entfernt. Wirksam wird das erst mit „Speichern“.";
      confirmLabel = "Löschen";
      danger = true;
    } else if (d.kind === "reset-durations") {
      title = d.key
        ? `Gelernte Dauern für „${this._esc(
            panelHelpers.deviceName(this._document, d.key)
          )}“ zurücksetzen?`
        : "Alle gelernten Dauern zurücksetzen?";
      body =
        "Die Restzeit-Anzeige beginnt danach wieder bei den konfigurierten Standardwerten.";
      confirmLabel = "Zurücksetzen";
      danger = true;
    }
    return `<div class="overlay" data-act="dialog-cancel">
      <div class="sheet" data-act="dialog-noop" role="dialog" aria-modal="true"
        aria-label="${title.replace(/"/g, "&quot;")}">
        <div class="handle"></div>
        <h3>${title}</h3>
        <p class="sub">${body}</p>
        ${input}
        <div class="dactions">
          <button class="ghost" data-act="dialog-cancel">Abbrechen</button>
          <button class="${danger ? "danger" : "primary"}" data-act="dialog-confirm">${confirmLabel}</button>
        </div>
      </div>
    </div>`;
  }

  async _confirmDialog() {
    const dialog = this._dialog;
    const input = this._root.querySelector('[data-field="dialog-input"]');
    this._dialog = null;
    if (!dialog) return;
    if (dialog.kind === "add-activity") {
      const name = input && input.value.trim();
      if (!name) {
        this._render();
        return;
      }
      const newKey = panelHelpers.uniqueKey(
        this._document,
        panelHelpers.slugify(name)
      );
      this._document.activities[newKey] = panelHelpers.blankActivity(name);
      // Straight into the editor — a new activity is created to be filled in.
      this._tab = "activities";
      this._push = { screen: "activity", key: newKey };
      this._scheduleValidate();
      this._render();
    } else if (dialog.kind === "delete-activity") {
      delete this._document.activities[dialog.key];
      if (this._push?.screen === "activity" && this._push.key === dialog.key) {
        this._push = null;
      }
      this._scheduleValidate();
      this._render();
    } else if (dialog.kind === "reset-durations") {
      this._render();
      await this._resetDurations(dialog.key || null);
    }
  }

  /* -- events -------------------------------------------------------- */

  _onKeydown(event) {
    if (event.key === "Escape" && this._dialog) {
      this._dialog = null;
      this._render();
    } else if (
      event.key === "Enter" &&
      event.target?.dataset?.field === "dialog-input"
    ) {
      this._confirmDialog();
    }
  }

  async _onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const { act, key, mode, activity, device } = target.dataset;

    switch (act) {
      case "toggle-sidebar":
        this.dispatchEvent(
          new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })
        );
        break;
      case "tab":
        this._tab = key;
        this._push = null;
        this._notice = null;
        // The board is live data — refresh it on the way in.
        if (key === "board") this._loadBoard();
        this._render();
        break;
      case "back":
        this._push = null;
        this._render();
        break;
      case "open-activity":
        this._push = { screen: "activity", key };
        this._notice = null;
        this._render();
        break;
      case "open-device":
        this._push = { screen: "device", key };
        this._notice = null;
        this._render();
        break;
      case "open-log":
        this._push = { screen: "log" };
        this._notice = null;
        this._loadLog();
        this._render();
        break;
      case "open-raw":
        this._push = { screen: "raw" };
        this._notice = null;
        this._rawText = JSON.stringify(this._document, null, 2);
        this._render();
        break;
      case "save":
        await this._save();
        break;
      case "revert":
        this._revert();
        break;
      case "add-activity":
        this._dialog = { kind: "add-activity" };
        this._render();
        break;
      case "duplicate-activity": {
        const source = this._document.activities[key];
        const newKey = panelHelpers.uniqueKey(this._document, `${key}_kopie`);
        this._document.activities[newKey] = panelHelpers.clone(source);
        this._document.activities[newKey].name = `${source.name || key} (Kopie)`;
        // Straight into the copy — duplicated to be changed.
        this._push = { screen: "activity", key: newKey };
        this._scheduleValidate();
        this._notify("ok", "Aktivität dupliziert — wirksam nach dem Speichern.");
        break;
      }
      case "delete-activity":
        this._dialog = { kind: "delete-activity", key };
        this._render();
        break;
      case "toggle-device": {
        const requirement = panelHelpers.requirement(
          this._document,
          activity,
          device
        );
        const on = requirement.present && requirement.power;
        panelHelpers.setRequirement(this._document, activity, device, {
          present: !on,
          power: !on,
          settings: {},
        });
        this._scheduleValidate();
        this._render();
        break;
      }
      case "dialog-cancel":
        this._dialog = null;
        this._render();
        break;
      case "dialog-noop":
        break;
      case "dialog-confirm":
        await this._confirmDialog();
        break;
      case "dry-run":
        await this._dryRun(key);
        break;
      case "reload-board":
        await this._loadBoard();
        break;
      case "reload-log":
        await this._loadLog();
        break;
      case "device-test":
        await this._deviceTest(key, mode);
        break;
      case "reset-durations":
        this._dialog = { kind: "reset-durations", key: key || null };
        this._render();
        break;
      case "path-map-add":
        this._pathMap(key)[""] = "";
        this._scheduleValidate();
        this._render();
        break;
      case "path-map-remove":
        delete this._pathMap(key)[mode];
        this._scheduleValidate();
        this._render();
        break;
      case "copy-raw":
        await navigator.clipboard
          .writeText(this._rawText || JSON.stringify(this._document, null, 2))
          .then(() => this._notify("ok", "In die Zwischenablage kopiert."))
          .catch(() => this._notify("error", "Kopieren nicht möglich."));
        break;
      case "apply-raw": {
        try {
          this._document = JSON.parse(this._rawText);
          this._notify("ok", "Übernommen — wirksam nach dem Speichern.");
          this._scheduleValidate();
        } catch (err) {
          this._notify("error", `Kein gültiges JSON: ${err.message}`);
        }
        break;
      }
      default:
        break;
    }
  }

  /** The live `path_map` object for a device, created on first use. */
  _pathMap(deviceKey) {
    const device = this._document.devices[deviceKey];
    device.options = device.options || {};
    device.options.path_map = device.options.path_map || {};
    return device.options.path_map;
  }

  _onChange(event) {
    const el = event.target;
    const { field, activity, device, setting, role, key } = el.dataset;
    if (!field || field === "raw" || field === "dialog-input") return;
    const doc = this._document;

    switch (field) {
      case "path-map-from": {
        // Renaming the key has to preserve order and value, so rebuild the
        // object rather than delete-and-append.
        const map = this._pathMap(device);
        const rebuilt = {};
        for (const [from, to] of Object.entries(map)) {
          if (from === key) {
            if (el.value) rebuilt[el.value] = to;
          } else {
            rebuilt[from] = to;
          }
        }
        doc.devices[device].options.path_map = rebuilt;
        break;
      }
      case "path-map-to":
        this._pathMap(device)[key] = el.value;
        break;
      case "activity-name":
        doc.activities[activity].name = el.value;
        break;
      case "control-class":
        doc.activities[activity].control_class = el.value;
        break;
      case "media":
        if (el.value) doc.activities[activity].media = el.value;
        else delete doc.activities[activity].media;
        break;
      case "light-scene":
        if (el.value) doc.activities[activity].light_scene = el.value;
        else delete doc.activities[activity].light_scene;
        break;
      case "icon":
        if (el.value) doc.activities[activity].icon = el.value;
        else delete doc.activities[activity].icon;
        break;
      case "device-setting": {
        const requirement = panelHelpers.requirement(doc, activity, device);
        const value =
          el.type === "number" && el.value !== "" ? Number(el.value) : el.value;
        requirement.settings[setting] = value;
        if (value === "" || value == null) delete requirement.settings[setting];
        panelHelpers.setRequirement(doc, activity, device, requirement);
        break;
      }
      case "device-driver":
        doc.devices[device].driver = el.value;
        break;
      case "device-name":
        doc.devices[device].name = el.value;
        break;
      case "device-entity": {
        const target = doc.devices[device];
        target.entities = target.entities || {};
        if (el.value) target.entities[role] = el.value;
        else delete target.entities[role];
        break;
      }
      case "device-number":
        doc.devices[device][key] = Number(el.value);
        break;
      default:
        return;
    }
    this._scheduleValidate();
    this._render();
  }
}

if (typeof customElements !== "undefined" && !customElements.get("kino-panel")) {
  customElements.define("kino-panel", KinoPanel);
}

if (typeof window !== "undefined") {
  console.info(
    `%c KINO-PANEL %c ${PANEL_VERSION} `,
    "background:#c8952c;color:#111;font-weight:700",
    ""
  );
}

export { KinoPanel };
