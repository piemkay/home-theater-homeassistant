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
 */

const PANEL_VERSION = "0.1.8";

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

/* ------------------------------------------------------------------ */

const STYLES = `
:host {
  --kino-bg: var(--primary-background-color, #111318);
  --kino-surface: var(--card-background-color, #1b1e24);
  --kino-surface2: rgba(127,127,127,.14);
  --kino-border: var(--divider-color, rgba(127,127,127,.28));
  --kino-text: var(--primary-text-color, #e9eaee);
  --kino-text2: var(--secondary-text-color, #a9adb6);
  --kino-text3: rgba(127,127,127,.9);
  --kino-gold: oklch(0.78 0.15 75);
  --kino-goldText: oklch(0.18 0.03 75);
  --kino-teal: oklch(0.72 0.12 190);
  --kino-red: oklch(0.65 0.19 25);
  display: block;
  background: var(--kino-bg);
  color: var(--kino-text);
  min-height: 100vh;
  font-family: var(--primary-font-family, system-ui), sans-serif;
}
/* One row, exactly as tall as Home Assistant's own header, so the panel does
   not look bolted on. Everything scrolls sideways rather than wrapping into
   a second row. */
.bar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 8px;
  height: var(--header-height, 56px);
  box-sizing: border-box;
  padding: 0 12px;
  background: var(--app-header-background-color, var(--kino-surface));
  color: var(--app-header-text-color, var(--kino-text));
  border-bottom: 1px solid var(--kino-border);
  overflow-x: auto; overflow-y: hidden;
  scrollbar-width: none;
}
.bar::-webkit-scrollbar { display: none; }
.bar h1 { margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 1px; white-space: nowrap; }
.menu {
  border: none; background: transparent; color: inherit; cursor: pointer;
  padding: 0 6px 0 0; font-size: 20px; line-height: 1; flex-shrink: 0;
}
.tabs { display: flex; gap: 4px; flex: 1; flex-wrap: nowrap; }
.tab {
  border: none; background: transparent; color: var(--kino-text2);
  font: inherit; font-weight: 700; font-size: 13px; cursor: pointer;
  padding: 6px 12px; border-radius: 16px; min-height: 32px; white-space: nowrap;
}
.tab[aria-selected="true"] { background: var(--kino-gold); color: var(--kino-goldText); }
.bar .actions { flex-wrap: nowrap; flex-shrink: 0; }
.bar button.primary, .bar button.ghost {
  min-height: 32px; padding: 6px 12px; white-space: nowrap;
}
.dirty { font-size: 12px; color: var(--kino-gold); font-weight: 700; white-space: nowrap; }
main { padding: 20px; max-width: 1400px; }
section { margin-bottom: 28px; }
h2 { font-size: 15px; font-weight: 800; margin: 0 0 4px; }
.sub { font-size: 12px; color: var(--kino-text2); margin: 0 0 14px; line-height: 1.5; }

button.primary, button.ghost, button.danger {
  font: inherit; font-weight: 700; font-size: 13px; cursor: pointer;
  border-radius: 10px; padding: 9px 14px; min-height: 38px; border: none;
}
button.primary { background: var(--kino-gold); color: var(--kino-goldText); }
button.ghost { background: transparent; color: var(--kino-text2); border: 1px solid var(--kino-border); }
button.danger { background: transparent; color: var(--kino-red); border: 1px solid var(--kino-red); }
button:disabled { opacity: .5; cursor: not-allowed; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td {
  border: 1px solid var(--kino-border); padding: 8px 10px;
  text-align: left; vertical-align: top;
}
th { background: var(--kino-surface); font-weight: 700; position: sticky; top: 0; }
th.rowhead, td.rowhead {
  position: sticky; left: 0; background: var(--kino-surface);
  min-width: 150px; z-index: 2;
}
td.off { color: var(--kino-text3); }
.cellhead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.cellhead label { font-size: 12px; font-weight: 700; }
.setting { display: grid; grid-template-columns: 88px 1fr; gap: 6px; align-items: center; margin-top: 5px; }
.setting span { font-size: 11px; color: var(--kino-text2); }

input, select, textarea {
  font: inherit; font-size: 13px; width: 100%; box-sizing: border-box;
  padding: 7px 9px; border-radius: 8px; min-height: 34px;
  border: 1px solid var(--kino-border);
  background: var(--kino-bg); color: var(--kino-text);
}
textarea { font-family: ui-monospace, monospace; font-size: 12px; min-height: 420px; line-height: 1.5; }
input[type="checkbox"] { width: auto; min-height: 0; }

.pill { display: inline-flex; align-items: center; gap: 6px; font-size: 11px;
  padding: 3px 8px; border-radius: 12px; background: var(--kino-surface2); }
.dot { width: 8px; height: 8px; border-radius: 5px; display: inline-block; }
.mono { font-family: ui-monospace, monospace; font-size: 12px; }
.muted { color: var(--kino-text2); }
.bad { color: var(--kino-red); }
.good { color: var(--kino-teal); }

.errors {
  border: 1px solid var(--kino-red); background: oklch(0.65 0.19 25 / 0.12);
  border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
}
.errors ul { margin: 8px 0 0; padding-left: 18px; }
.errors li { font-size: 12px; margin-bottom: 4px; }
.errors code { font-family: ui-monospace, monospace; }
.ok { border: 1px solid var(--kino-teal); background: oklch(0.72 0.12 190 / 0.1);
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.card { border: 1px solid var(--kino-border); border-radius: 12px; padding: 14px; background: var(--kino-surface); }
.card h3 { margin: 0 0 8px; font-size: 14px; font-weight: 800; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; font-size: 12px; }
.kv dt { color: var(--kino-text2); }
.kv dd { margin: 0; }
`;

const TABS = [
  ["activities", "Aktivitäten"],
  ["devices", "Geräte"],
  ["board", "Gerätestatus"],
  ["planner", "Planer"],
  ["log", "Verlauf"],
  ["raw", "Datei"],
];

const PanelBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class KinoPanel extends PanelBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._narrow = false;
    this._tab = "activities";
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

  disconnectedCallback() {}

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

  async _validate() {
    try {
      const result = await this._ws({
        type: "kino/config/validate",
        document: this._document,
      });
      this._errors = result.errors;
      this._notice = result.valid
        ? { kind: "ok", text: "Konfiguration ist gültig." }
        : null;
    } catch (err) {
      this._notice = { kind: "error", text: err.message };
    }
    this._render();
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
        this._notice = {
          kind: "ok",
          text: "Gespeichert und übernommen — kein Neustart nötig.",
        };
        await this._load();
      } else {
        this._notice = {
          kind: "error",
          text: "Nicht gespeichert — die bestehende Konfiguration läuft weiter.",
        };
      }
    } catch (err) {
      this._notice = { kind: "error", text: err.message };
    }
    this._saving = false;
    this._render();
  }

  _revert() {
    this._document = panelHelpers.clone(this._original);
    this._notice = null;
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
    try {
      const result = await this._ws({ type: "kino/device_test", device, action });
      this._notice = {
        kind: "ok",
        text: `${device}: ${action} → ${result.power}${result.ready ? " (bereit)" : ""}`,
      };
    } catch (err) {
      this._notice = { kind: "error", text: `${device}: ${err.message}` };
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
    }

    if (!this._document) {
      this._root.innerHTML = `<main><p class="sub">${this._esc(
        this._notice ? this._notice.text : "Konfiguration wird geladen…"
      )}</p></main>`;
      return;
    }

    this._root.innerHTML = `
      <div class="bar">
        ${
          this._narrow
            ? '<button class="menu" data-act="toggle-sidebar" title="Menü">☰</button>'
            : ""
        }
        <h1>KINO</h1>
        <div class="tabs">
          ${TABS.map(
            ([key, label]) =>
              `<button class="tab" data-act="tab" data-key="${key}"
                 aria-selected="${this._tab === key}">${label}</button>`
          ).join("")}
        </div>
        ${this._dirty ? '<span class="dirty">● Ungespeichert</span>' : ""}
        <div class="actions">
          <button class="ghost" data-act="validate">Prüfen</button>
          <button class="ghost" data-act="revert" ${this._dirty ? "" : "disabled"}>Verwerfen</button>
          <button class="primary" data-act="save" ${
            this._dirty && !this._saving ? "" : "disabled"
          }>${this._saving ? "Speichert…" : "Speichern"}</button>
        </div>
      </div>
      <main>
        ${this._renderNotice()}
        ${this._renderErrors()}
        ${this._renderTab()}
      </main>`;
  }

  _renderNotice() {
    if (!this._notice) return "";
    const cls = this._notice.kind === "ok" ? "ok" : "errors";
    return `<div class="${cls}">${this._esc(this._notice.text)}</div>`;
  }

  _renderErrors() {
    if (!this._errors.length) return "";
    return `<div class="errors">
      <strong>${this._errors.length} Fehler in der Konfiguration</strong>
      <ul>${this._errors
        .map(
          (e) =>
            `<li><code>${this._esc(e.path)}</code> — ${this._esc(e.message)}</li>`
        )
        .join("")}</ul>
    </div>`;
  }

  _renderTab() {
    switch (this._tab) {
      case "devices":
        return this._renderDevices();
      case "board":
        return this._renderBoard();
      case "planner":
        return this._renderPlanner();
      case "log":
        return this._renderLog();
      case "raw":
        return this._renderRaw();
      default:
        return this._renderMatrix();
    }
  }

  /* -- 10.1 activity matrix (FR-110 .. FR-114) ----------------------- */

  _renderMatrix() {
    const doc = this._document;
    const activities = panelHelpers.activityKeys(doc);
    const devices = panelHelpers.deviceKeys(doc);
    const offActivity = doc.settings?.off_activity || "aus";

    const header = activities
      .map(
        (key) => `<th>
          <div class="cellhead">
            <input data-field="activity-name" data-activity="${key}"
              value="${this._esc(doc.activities[key].name || key)}">
          </div>
          <div class="mono muted">${this._esc(key)}</div>
          <div class="actions" style="margin-top:6px">
            <button class="ghost" data-act="duplicate-activity" data-key="${key}" title="Duplizieren">⧉</button>
            <button class="danger" data-act="delete-activity" data-key="${key}"
              ${key === offActivity ? "disabled" : ""} title="Löschen">✕</button>
          </div>
        </th>`
      )
      .join("");

    const metaRow = (label, render) =>
      `<tr><td class="rowhead">${label}</td>${activities
        .map((key) => `<td>${render(key)}</td>`)
        .join("")}</tr>`;

    const rows = [
      metaRow(
        "Steuerungsklasse",
        (key) => `<select data-field="control-class" data-activity="${key}">
          ${this._meta.controlClasses
            .map(
              (c) =>
                `<option value="${c}"${
                  (doc.activities[key].control_class || "room") === c ? " selected" : ""
                }>${c}</option>`
            )
            .join("")}
        </select>`
      ),
      metaRow(
        "Medien",
        (key) => `<select data-field="media" data-activity="${key}">
          <option value=""${!doc.activities[key].media ? " selected" : ""}>keine</option>
          <option value="jellyfin"${
            doc.activities[key].media === "jellyfin" ? " selected" : ""
          }>jellyfin</option>
        </select>`
      ),
      metaRow(
        "Lichtszene",
        (key) =>
          this._entitySelect(
            "light-scene",
            key,
            doc.activities[key].light_scene || "",
            ["scene"]
          )
      ),
      metaRow(
        "Icon",
        (key) =>
          `<input data-field="icon" data-activity="${key}" placeholder="mdi:…"
             value="${this._esc(doc.activities[key].icon || "")}">`
      ),
      ...devices.map(
        (device) =>
          `<tr>
            <td class="rowhead">
              <div style="font-weight:700">${this._esc(
                doc.devices[device].name || device
              )}</div>
              <div class="mono muted">${this._esc(device)}</div>
            </td>
            ${activities
              .map((key) => this._renderMatrixCell(key, device))
              .join("")}
          </tr>`
      ),
    ];

    return `<section>
      <h2>Aktivitäten</h2>
      <p class="sub">
        Aktivitäten als Spalten, Geräte als Zeilen. Werte kommen aus den echten
        Geräten — ist ein Gerät aus, ist seine Auswahlliste leer und das steht
        auch da. Änderungen greifen nach dem Speichern ohne Neustart.
      </p>
      <div class="actions" style="margin-bottom:12px">
        <button class="ghost" data-act="add-activity">+ Aktivität</button>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="rowhead">Gerät</th>${header}</tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table></div>
    </section>`;
  }

  _renderMatrixCell(activityKey, deviceKey) {
    const requirement = panelHelpers.requirement(
      this._document,
      activityKey,
      deviceKey
    );
    const catalogue = this._meta.drivers[deviceKey];
    const settings = catalogue ? catalogue.settings : {};

    const checkbox = `<div class="cellhead">
      <input type="checkbox" data-field="device-power"
        data-activity="${activityKey}" data-device="${deviceKey}"
        ${requirement.present && requirement.power ? "checked" : ""}>
      <label>${requirement.present && requirement.power ? "an" : "aus"}</label>
    </div>`;

    if (!requirement.present || !requirement.power) {
      return `<td class="off">${checkbox}</td>`;
    }

    const inputs = Object.entries(settings)
      .map(([name, described]) => {
        const value = requirement.settings[name];
        if (described.type === "number") {
          return `<div class="setting"><span>${name}</span>
            <input type="number" step="0.5" data-field="device-setting"
              data-activity="${activityKey}" data-device="${deviceKey}"
              data-setting="${name}" value="${
                value == null ? "" : this._esc(value)
              }"></div>`;
        }
        const options = described.options || [];
        if (!options.length) {
          // FR-112 says never free-text — but an off device has no list, so
          // say why rather than silently offering nothing.
          return `<div class="setting"><span>${name}</span>
            <span class="muted">Gerät aus — Werte nicht abrufbar${
              value ? `, gesetzt: ${this._esc(value)}` : ""
            }</span></div>`;
        }
        return `<div class="setting"><span>${name}</span>
          <select data-field="device-setting" data-activity="${activityKey}"
            data-device="${deviceKey}" data-setting="${name}">
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

    return `<td>${checkbox}${inputs}</td>`;
  }

  _entitySelect(field, activityKey, value, domains) {
    const options = this._entityOptions(domains);
    const known = !value || options.some((o) => o.id === value);
    return `<select data-field="${field}" data-activity="${activityKey}">
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
    return `<div class="setting">
      <span class="${missing ? "bad" : ""}">${this._esc(role.role)}${
        role.required ? " *" : ""
      }</span>
      <div>
        <input class="mono" list="${listId}" placeholder="${this._esc(hint)}"
          data-field="device-entity" data-device="${deviceKey}" data-role="${role.role}"
          value="${this._esc(value)}">
        <datalist id="${listId}">
          ${options
            .map(
              (o) =>
                `<option value="${this._esc(o.id)}" label="${this._esc(o.name)}"></option>`
            )
            .join("")}
        </datalist>
        ${
          unknown
            ? '<div class="bad" style="font-size:11px;margin-top:3px">Diese Entity existiert nicht</div>'
            : ""
        }
      </div>
    </div>`;
  }

  /** Prefix rewrites from catalogue paths to player paths (FR-46). */
  _renderPathMap(deviceKey) {
    const device = this._document.devices[deviceKey];
    const map = (device.options && device.options.path_map) || {};
    const rows = Object.entries(map)
      .map(
        ([from, to]) => `<div class="setting" style="grid-template-columns:1fr 1fr auto">
          <input class="mono" data-field="path-map-from" data-device="${deviceKey}"
            data-key="${this._esc(from)}" value="${this._esc(from)}">
          <input class="mono" data-field="path-map-to" data-device="${deviceKey}"
            data-key="${this._esc(from)}" value="${this._esc(to)}">
          <button class="danger" data-act="path-map-remove" data-key="${deviceKey}"
            data-mode="${this._esc(from)}" title="Entfernen">✕</button>
        </div>`
      )
      .join("");
    return `<div style="margin-top:12px;border-top:1px solid var(--kino-border);padding-top:10px">
      <div style="font-size:12px;font-weight:700;margin-bottom:2px">Pfad-Zuordnung</div>
      <p class="sub" style="margin-bottom:8px">
        Links der Pfad aus der Bibliothek, rechts der Pfad, unter dem der
        Player dieselbe Datei öffnet. Ohne passenden Eintrag lässt sich ein
        Titel nicht abspielen — die Karte nennt dann den Pfad.
      </p>
      ${rows || '<p class="sub">Noch keine Zuordnung.</p>'}
      <button class="ghost" data-act="path-map-add" data-key="${deviceKey}"
        style="margin-top:6px">+ Zuordnung</button>
    </div>`;
  }

  _renderDevices() {
    const doc = this._document;
    const cards = panelHelpers.deviceKeys(doc).map((key) => {
      const device = doc.devices[key];
      const catalogue = this._meta.drivers[key] || {};
      const missing = catalogue.missingEntities || [];
      const roles =
        catalogue.roles && catalogue.roles.length
          ? catalogue.roles
          : Object.keys(device.entities || {}).map((role) => ({
              role,
              domains: [],
              required: false,
            }));
      return `<div class="card">
        <h3>${this._esc(device.name || key)} <span class="mono muted">${this._esc(key)}</span></h3>
        ${
          missing.length
            ? `<p class="bad" style="font-size:12px">Fehlende Entities: ${missing
                .map((r) => this._esc(r))
                .join(", ")}</p>`
            : ""
        }
        <div class="setting"><span>Treiber</span>
          <select data-field="device-driver" data-device="${key}">
            ${this._meta.knownDrivers
              .map(
                (d) =>
                  `<option value="${d}"${device.driver === d ? " selected" : ""}>${d}</option>`
              )
              .join("")}
          </select></div>
        <div class="setting"><span>Name</span>
          <input data-field="device-name" data-device="${key}" value="${this._esc(
            device.name || ""
          )}"></div>
        ${roles.map((role) => this._entityPicker(key, role)).join("")}
        <div class="setting"><span>Start-Timeout</span>
          <input type="number" data-field="device-number" data-device="${key}"
            data-key="startup_timeout" value="${device.startup_timeout ?? 180}"></div>
        <div class="setting"><span>Startdauer ≈</span>
          <input type="number" data-field="device-number" data-device="${key}"
            data-key="default_startup_seconds" value="${
              device.default_startup_seconds ?? 30
            }"></div>
        ${device.driver === "zidoo" ? this._renderPathMap(key) : ""}
      </div>`;
    });

    return `<section>
      <h2>Geräte</h2>
      <p class="sub">
        Welche Home-Assistant-Entity welches logische Gerät bedient. Jede Rolle
        bietet nur Entities des passenden Typs an; mit <strong>*</strong>
        markierte Rollen braucht der Treiber zwingend.
      </p>
      <div class="grid">${cards.join("")}</div>
    </section>`;
  }

  /* -- 10.2 diagnostics ---------------------------------------------- */

  _renderBoard() {
    if (!this._board) {
      this._loadBoard();
      return '<p class="sub">Gerätestatus wird geladen…</p>';
    }
    const rows = (this._board.devices || [])
      .map((device) => {
        const keys = new Set([
          ...Object.keys(device.expected || {}),
          ...Object.keys(device.observed || {}),
        ]);
        const comparison = [...keys]
          .map((key) => {
            const observed = device.observed[key];
            const expected = device.expected[key];
            if (expected == null) return "";
            const ok = panelHelpers.settingMatches(observed, expected);
            return `<div class="${ok ? "good" : "bad"}">${this._esc(key)}:
              ${this._esc(observed ?? "—")} / soll ${this._esc(expected)}</div>`;
          })
          .join("");
        return `<tr>
          <td class="rowhead">
            <span class="dot" style="background:${panelHelpers.powerColor(
              device.power,
              device.ready
            )}"></span>
            ${this._esc(device.name)}
          </td>
          <td>${this._esc(device.power)}${
            device.phase ? ` <span class="muted">(${this._esc(device.phase)})</span>` : ""
          }</td>
          <td>${device.ready ? '<span class="good">bereit</span>' : '<span class="muted">nein</span>'}</td>
          <td class="mono">${comparison || '<span class="muted">—</span>'}</td>
          <td class="bad">${this._esc(device.error || device.drift || "")}</td>
          <td class="actions">
            <button class="ghost" data-act="device-test" data-key="${device.key}" data-mode="start">Start</button>
            <button class="ghost" data-act="device-test" data-key="${device.key}" data-mode="stop">Stopp</button>
          </td>
        </tr>`;
      })
      .join("");

    // "Aktive Aktivität film" while everything shuts down reads like a lie —
    // say what the comparison is actually against. Names, never keys (F7).
    const target = this._board.targetActivity;
    const nameOf = (key) => panelHelpers.activityName(this._document, key);
    let context;
    if (this._board.state === "off") {
      context = "Das Kino ist ausgeschaltet — erwartet ist: alle Geräte aus.";
    } else if (target && target !== this._board.activity) {
      context = `Wechsel zu <strong>${this._esc(nameOf(target))}</strong> läuft —
        verglichen wird noch mit <strong>${this._esc(nameOf(this._board.activity))}</strong>.`;
    } else {
      context = `Beobachteter gegen erwarteten Zustand für die aktive Aktivität
        <strong>${this._esc(nameOf(this._board.activity))}</strong>.`;
    }
    return `<section>
      <h2>Gerätestatus</h2>
      <p class="sub">
        ${context}
        Start und Stopp wirken nur auf dieses eine Gerät.
      </p>
      <div class="actions" style="margin-bottom:12px">
        <button class="ghost" data-act="reload-board">Aktualisieren</button>
      </div>
      <div class="scroll"><table>
        <thead><tr>
          <th class="rowhead">Gerät</th><th>Zustand</th><th>Bereit</th>
          <th>Ist / Soll</th><th>Fehler</th><th>Test</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
  }

  _renderPlanner() {
    const activities = panelHelpers.activityKeys(this._document);
    const actions = this._plan
      ? (this._plan.actions || [])
          .map(
            (a) => `<tr>
              <td class="rowhead">${this._esc(panelHelpers.deviceName(this._document, a.device))}</td>
              <td><strong>${this._esc(panelHelpers.actionLabel(a.kind))}</strong></td>
              <td class="mono">${this._esc(
                Object.entries(a.settings || {})
                  .map(([k, v]) => `${k}=${v}`)
                  .join(", ") || "—"
              )}</td>
              <td class="muted">${this._esc(a.reason)}</td>
            </tr>`
          )
          .join("")
      : "";

    return `<section>
      <h2>Planer</h2>
      <p class="sub">
        Zeigt den berechneten Unterschied vom aktuellen Zustand zu einer
        Aktivität — ohne irgendetwas auszuführen. So lässt sich eine neue
        Aktivität prüfen, bevor sie zum ersten Mal läuft.
      </p>
      <div class="actions" style="margin-bottom:14px">
        ${activities
          .map(
            (key) =>
              `<button class="${
                this._plannerTarget === key ? "primary" : "ghost"
              }" data-act="dry-run" data-key="${key}">${this._esc(
                this._document.activities[key].name || key
              )}</button>`
          )
          .join("")}
      </div>
      ${
        this._plan
          ? `<p class="${this._plan.error ? "bad" : ""}">${this._esc(
              this._plan.error
                ? this._plan.summary
                : panelHelpers.planSummary(this._plan.actions, (key) =>
                    panelHelpers.deviceName(this._document, key)
                  )
            )}</p>
             <div class="scroll"><table>
               <thead><tr><th class="rowhead">Gerät</th><th>Aktion</th><th>Einstellungen</th><th>Grund</th></tr></thead>
               <tbody>${actions}</tbody>
             </table></div>`
          : '<p class="sub">Eine Aktivität wählen.</p>'
      }
    </section>`;
  }

  _renderLog() {
    if (!this._log) {
      this._loadLog();
      return '<p class="sub">Verlauf wird geladen…</p>';
    }
    const activityName = (key) => panelHelpers.activityName(this._document, key);
    const deviceName = (key) => panelHelpers.deviceName(this._document, key);
    const transitions = (this._log.transitions || [])
      .slice()
      .reverse()
      .map(
        (t) => `<tr>
          <td class="rowhead">${this._esc(activityName(t.from_activity))} → ${this._esc(
            activityName(t.to_activity)
          )}</td>
          <td class="${t.succeeded ? "good" : "bad"}">${
            t.succeeded ? "ok" : "Fehler"
          }</td>
          <td>${panelHelpers.formatDuration(t.duration_seconds)}</td>
          <td class="mono">${(t.steps || [])
            .map(
              (s) =>
                `${this._esc(deviceName(s.device))} ${this._esc(
                  panelHelpers.actionLabel(s.kind)
                )} ${panelHelpers.formatDuration(s.seconds)}`
            )
            .join(" · ")}</td>
          <td class="bad">${this._esc(t.error || "")}</td>
        </tr>`
      )
      .join("");

    const durations = (this._log.durations || [])
      .map(
        (d) => `<tr>
          <td class="rowhead">${this._esc(deviceName(d.device))}</td>
          <td>${this._esc(d.kind)} / ${this._esc(d.from)}</td>
          <td>${panelHelpers.formatDuration(d.seconds)}</td>
          <td class="muted">${panelHelpers.countLabel(
            d.samples,
            "Messung",
            "Messungen"
          )}, ${panelHelpers.formatDuration(
            d.min_seconds
          )}–${panelHelpers.formatDuration(d.max_seconds)}</td>
        </tr>`
      )
      .join("");

    return `<section>
      <h2>Übergänge</h2>
      <p class="sub">Die letzten Wechsel mit Zeiten je Gerät — hier steht, was gebremst hat.</p>
      <div class="actions" style="margin-bottom:12px">
        <button class="ghost" data-act="reload-log">Aktualisieren</button>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="rowhead">Wechsel</th><th></th><th>Dauer</th><th>Schritte</th><th>Fehler</th></tr></thead>
        <tbody>${transitions || '<tr><td colspan="5" class="muted">Noch keine Übergänge.</td></tr>'}</tbody>
      </table></div>
    </section>
    <section>
      <h2>Gelernte Dauern</h2>
      <p class="sub">Grundlage der angezeigten Restzeit. Nach einem Gerätetausch zurücksetzen.</p>
      <div class="actions" style="margin-bottom:12px">
        <button class="danger" data-act="reset-durations">Alle zurücksetzen</button>
      </div>
      <div class="scroll"><table>
        <thead><tr><th class="rowhead">Gerät</th><th>Art</th><th>Schätzung</th><th>Streuung</th></tr></thead>
        <tbody>${durations || '<tr><td colspan="4" class="muted">Noch nichts gelernt.</td></tr>'}</tbody>
      </table></div>
    </section>`;
  }

  /* -- 10.3 export / import (FR-134) --------------------------------- */

  _renderRaw() {
    return `<section>
      <h2>Datei</h2>
      <p class="sub">
        Das komplette Dokument als JSON — zum Sichern, Versionieren oder für
        eine Änderung, die der Editor nicht abbildet. Gespeichert wird als
        YAML nach <code class="mono">${this._esc(this._path || "kino.yaml")}</code>;
        die vorherige Fassung bleibt als <code class="mono">.bak</code> liegen.
      </p>
      <div class="actions" style="margin-bottom:12px">
        <button class="ghost" data-act="copy-raw">In die Zwischenablage</button>
        <button class="ghost" data-act="apply-raw">Übernehmen</button>
      </div>
      <textarea data-field="raw" spellcheck="false">${this._esc(
        JSON.stringify(this._document, null, 2)
      )}</textarea>
    </section>`;
  }

  /* -- events -------------------------------------------------------- */

  async _onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const { act, key, mode } = target.dataset;

    switch (act) {
      case "toggle-sidebar":
        this.dispatchEvent(
          new CustomEvent("hass-toggle-menu", { bubbles: true, composed: true })
        );
        break;
      case "tab":
        this._tab = key;
        this._notice = null;
        this._render();
        break;
      case "validate":
        await this._validate();
        break;
      case "save":
        await this._save();
        break;
      case "revert":
        this._revert();
        break;
      case "add-activity": {
        const name = prompt("Name der neuen Aktivität?");
        if (!name) return;
        const newKey = panelHelpers.uniqueKey(
          this._document,
          panelHelpers.slugify(name)
        );
        this._document.activities[newKey] = panelHelpers.blankActivity(name);
        this._render();
        break;
      }
      case "duplicate-activity": {
        const source = this._document.activities[key];
        const newKey = panelHelpers.uniqueKey(this._document, `${key}_kopie`);
        this._document.activities[newKey] = panelHelpers.clone(source);
        this._document.activities[newKey].name = `${source.name || key} (Kopie)`;
        this._render();
        break;
      }
      case "delete-activity":
        if (!confirm(`Aktivität "${key}" löschen?`)) return;
        delete this._document.activities[key];
        this._render();
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
        if (!confirm("Alle gelernten Dauern zurücksetzen?")) return;
        await this._resetDurations(null);
        break;
      case "path-map-add":
        this._pathMap(key)[""] = "";
        this._render();
        break;
      case "path-map-remove":
        delete this._pathMap(key)[mode];
        this._render();
        break;
      case "copy-raw":
        await navigator.clipboard
          .writeText(JSON.stringify(this._document, null, 2))
          .then(() => {
            this._notice = { kind: "ok", text: "Kopiert." };
            this._render();
          })
          .catch(() => {});
        break;
      case "apply-raw": {
        const textarea = this._root.querySelector('[data-field="raw"]');
        try {
          this._document = JSON.parse(textarea.value);
          this._notice = { kind: "ok", text: "Übernommen — jetzt prüfen und speichern." };
        } catch (err) {
          this._notice = { kind: "error", text: `Kein gültiges JSON: ${err.message}` };
        }
        this._render();
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
    if (!field) return;
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
      case "device-power": {
        const requirement = panelHelpers.requirement(doc, activity, device);
        panelHelpers.setRequirement(doc, activity, device, {
          ...requirement,
          present: el.checked,
          power: el.checked,
        });
        break;
      }
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
