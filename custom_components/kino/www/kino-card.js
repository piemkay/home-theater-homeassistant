/**
 * Kino – custom Lovelace card.
 *
 * Single file, no build step: the integration serves it and registers it as a
 * Lovelace resource, so HACS installs one thing and the card is just there.
 *
 * All library data comes over the Home Assistant WebSocket API — the card
 * never talks to Jellyfin and never sees a Jellyfin credential (FR-42a).
 * Artwork comes through /api/kino/artwork/..., authorised by the short-lived
 * signature the state payload carries, because an <img> request cannot send
 * an Authorization header.
 */

const CARD_VERSION = "0.2.1";

/* ------------------------------------------------------------------ *
 * Pure helpers — kept free of DOM so they can be unit-tested (NFR-6). *
 * ------------------------------------------------------------------ */

export const helpers = {
  /** Seconds -> `1:23:45` / `4:05`. */
  formatTime(seconds) {
    if (seconds == null || Number.isNaN(seconds)) return "0:00";
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  },

  /** Remaining seconds -> a German ETA the second user can act on. */
  formatEta(seconds) {
    if (seconds == null || seconds <= 0) return "";
    if (seconds < 60) return "noch weniger als 1 Min.";
    const minutes = Math.round(seconds / 60);
    return `noch ca. ${minutes} Min.`;
  },

  /**
   * dB value -> display string, or "Stumm" when muted.
   *
   * During power transitions the entity's state is the literal string
   * "unknown", which `Number.isNaN` does not coerce — hence the explicit
   * `Number()` before the check, so no "NaN dB" ever reaches the screen.
   */
  formatVolume(db, muted) {
    if (muted) return "Stumm";
    const value = Number(db);
    if (db == null || db === "" || Number.isNaN(value)) return "—";
    return `${value.toFixed(1)} dB`;
  },

  /** The meta line under a poster: `2016 · 106 Min · ★7.2`. */
  metaLine(item) {
    const bits = [];
    if (item.year) bits.push(String(item.year));
    if (item.runtime) bits.push(`${item.runtime} Min`);
    if (item.rating) bits.push(`★${Number(item.rating).toFixed(1)}`);
    return bits.join(" · ");
  },

  /**
   * Play button label: resume position or a plain start. When no media
   * activity is running the button also powers the theater on (FR-55),
   * and the label says so.
   */
  playLabel(item, mediaActive = true) {
    const resumable = item && item.continueWatching && item.resumeSeconds;
    if (!mediaActive) {
      return resumable
        ? `Kino starten und fortsetzen (${helpers.formatTime(item.resumeSeconds)})`
        : "Kino starten und wiedergeben";
    }
    if (resumable) {
      return `Fortsetzen bei ${helpers.formatTime(item.resumeSeconds)}`;
    }
    return "Wiedergabe starten";
  },

  /** Count of filters the user has actually applied. */
  activeFilterCount(filters) {
    const yearActive =
      (filters.yearFrom != null || filters.yearTo != null) &&
      !(filters.yearFrom == null && filters.yearTo == null);
    return (
      filters.tags.length +
      filters.genres.length +
      filters.countries.length +
      (filters.ratings || []).length +
      (yearActive ? 1 : 0)
    );
  },

  /** Translate the card's tag chips into WebSocket query flags. */
  queryFromFilters(filters, category, search, sort, offset = 0, limit = 60, sortDir = null) {
    return {
      type: "kino/library/search",
      category,
      search: search || null,
      genres: filters.genres,
      countries: filters.countries,
      ratings: filters.ratings || [],
      year_from: filters.yearFrom,
      year_to: filters.yearTo,
      only_4k: filters.tags.includes("4K"),
      only_hd: filters.tags.includes("HD"),
      only_sd: filters.tags.includes("SD"),
      only_3d: filters.tags.includes("3D"),
      only_unwatched: filters.tags.includes("Nicht gesehen"),
      only_watched: filters.tags.includes("Gesehen"),
      only_resumable: filters.tags.includes("Weitersehen"),
      only_favorites: filters.tags.includes("Favoriten"),
      sort,
      sort_dir: sortDir,
      offset,
      limit,
    };
  },

  /** The direction each sort field uses when the user has not chosen one. */
  defaultSortDir(sort) {
    return sort === "title" ? "asc" : "desc";
  },

  /** Chip label for the year range, or null when none is set. */
  yearRangeLabel(yearFrom, yearTo) {
    if (yearFrom == null && yearTo == null) return null;
    if (yearFrom != null && yearTo != null) {
      return yearFrom === yearTo ? String(yearFrom) : `${yearFrom}–${yearTo}`;
    }
    return yearFrom != null ? `ab ${yearFrom}` : `bis ${yearTo}`;
  },

  /**
   * Toggle one Format-&-Status chip, honouring exclusivity: a title has one
   * resolution tier, and Gesehen/Nicht gesehen contradict each other.
   */
  toggleTag(tags, tag) {
    if (tags.includes(tag)) return tags.filter((t) => t !== tag);
    const exclusive = [
      ["4K", "HD", "SD"],
      ["Gesehen", "Nicht gesehen"],
    ].find((group) => group.includes(tag));
    const cleared = exclusive ? tags.filter((t) => !exclusive.includes(t)) : tags.slice();
    return [...cleared, tag];
  },

  /**
   * Which artwork the grid should request for a view mode: `[type, fallback]`.
   * The tags say which images actually exist, so the primary pick rarely 404s;
   * the fallback keeps the wall filled when it does.
   */
  artworkTypeFor(item, mode) {
    if (mode === "thumb" || mode === "thumbCard") {
      return item && item.thumbTag ? ["Thumb", "Primary"] : ["Backdrop", "Primary"];
    }
    if (mode === "banner") {
      return item && item.bannerTag ? ["Banner", "Backdrop"] : ["Backdrop", "Primary"];
    }
    return ["Primary", null];
  },

  /**
   * A poster URL the browser can actually load.
   *
   * An `<img>` request carries no Authorization header, so the proxy is
   * authorised by a short-lived signature that arrives with the state
   * payload. It stays stable for hours on purpose — the URL is the browser's
   * cache key, and a signature that changed every poll would re-download the
   * whole grid.
   */
  artworkUrl(itemId, imageType, signature) {
    const path = `/api/kino/artwork/${encodeURIComponent(itemId)}/${imageType}`;
    return signature ? `${path}?sig=${encodeURIComponent(signature)}` : path;
  },

  /** Colour token for a per-device health value. */
  deviceColor(health) {
    switch (health) {
      case "ready":
        return "var(--kino-teal)";
      case "starting":
      case "stopping":
        return "var(--kino-gold)";
      case "degraded":
      case "error":
      case "unreachable":
        return "var(--kino-red)";
      default:
        return "var(--kino-text3)";
    }
  },

  /** Which body the card should render for an activity. */
  bodyFor(activity) {
    if (!activity) return "aus";
    if (activity.key === "aus" || activity.controlClass === "off") return "aus";
    if (activity.media) return "library";
    if (activity.controlClass === "mixed") return "musik";
    return "handoff";
  },
};

/* ------------------------------------------------------------------ *
 * Styles — the mockup's tokens, adapted to Home Assistant's theming.  *
 * ------------------------------------------------------------------ */

const STYLES = `
:host {
  --kino-bg: var(--ha-card-background, var(--card-background-color, oklch(0.15 0.015 265)));
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
}
@media (prefers-color-scheme: light) {
  :host {
    --kino-surface: oklch(0.96 0.004 265);
    --kino-surface2: oklch(0.92 0.006 265);
    --kino-border: oklch(0 0 0 / 0.1);
    --kino-text: oklch(0.22 0.01 265);
    --kino-text2: oklch(0.42 0.01 265);
    --kino-text3: oklch(0.58 0.01 265);
    --kino-goldText: oklch(0.18 0.03 75);
  }
}
/* The mockup's frame: header and footer pinned, the middle scrolls. A card
   that simply grew with its content put the transport bar at the bottom of
   the *page*, which on a 300-title grid is nowhere near the screen. */
.wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  height: var(--kino-card-height, calc(100dvh - var(--header-height, 56px) - 24px));
  min-height: 420px;
  font-family: Manrope, var(--primary-font-family, system-ui), sans-serif;
  background: var(--kino-bg);
  color: var(--kino-text);
  border-radius: var(--ha-card-border-radius, 12px);
  overflow: hidden;
}
.scroller {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: none;
  overscroll-behavior: contain;
}
.scroller::-webkit-scrollbar { display: none; }
@keyframes kino-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
@keyframes kino-sheet-in { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
.hscroll::-webkit-scrollbar { display: none; }
.hscroll { scrollbar-width: none; }

header {
  padding: 14px 20px 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: space-between;
}
.brand { font-weight: 800; font-size: 15px; letter-spacing: 1.5px; }
.statuswrap { display: flex; align-items: center; gap: 10px; }
.status { display: flex; align-items: center; gap: 7px; }
.dot { width: 8px; height: 8px; border-radius: 5px; }
.dot.pulsing { animation: kino-pulse 1.2s ease-in-out infinite; }
.status span { font-size: 12px; color: var(--kino-text2); font-weight: 600; }
.iconbtn {
  width: 36px; height: 36px; border-radius: 18px; border: none;
  background: var(--kino-surface2); color: var(--kino-text);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; padding: 0; flex-shrink: 0;
}
.body { padding: 0 20px 20px; }
.section { margin-bottom: 18px; }
h3 { margin: 0 0 10px; font-size: 15px; font-weight: 800; }
h2 { margin: 0; font-size: 19px; font-weight: 800; }
p { margin: 0; line-height: 1.5; }
a.link { font-size: 12px; font-weight: 700; cursor: pointer; color: var(--kino-gold); }

button { font-family: inherit; }
.tile, .chipbtn, .pill, .primary, .ghost {
  border: none; cursor: pointer; font-weight: 700;
  font-family: inherit; color: var(--kino-text2);
  background: var(--kino-surface2);
}
.tilegrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.tile { padding: 16px; border-radius: 14px; text-align: left; font-size: 13px; min-height: 48px; }
.tile[aria-pressed="true"] { background: var(--kino-gold); color: var(--kino-goldText); }
.chipbtn { padding: 10px 14px; border-radius: 20px; display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--kino-text); min-height: 40px; }
.pill { height: 36px; padding: 0 13px; border-radius: 18px; font-size: 12px; flex-shrink: 0; }
.pill[aria-pressed="true"] { background: var(--kino-gold); color: var(--kino-goldText); }
.primary { padding: 15px; border-radius: 14px; background: var(--kino-gold); color: var(--kino-goldText); font-size: 14px; font-weight: 800; width: 100%; min-height: 48px; }
.ghost { padding: 12px; border-radius: 12px; border: 1px solid var(--kino-border); background: transparent; font-size: 13px; }

.devicechips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.devicechip {
  padding: 7px 10px; border-radius: 14px; background: var(--kino-surface);
  border: 1px solid var(--kino-border); display: flex; align-items: center; gap: 6px;
}
.devicechip span:last-child { font-size: 11px; color: var(--kino-text2); font-weight: 600; }

.banner {
  margin-bottom: 12px; padding: 14px; border-radius: 14px;
  background: oklch(0.65 0.19 25 / 0.14);
  border: 1px solid oklch(0.65 0.19 25 / 0.4);
  display: flex; flex-direction: column; gap: 8px;
}
.banner strong { font-size: 13px; }
.banner p { font-size: 12px; color: var(--kino-text2); }
.row { display: flex; gap: 8px; }
.row > * { flex: 1; }

.progress { margin-bottom: 14px; padding: 16px; border-radius: 16px; background: var(--kino-surface); border: 1px solid var(--kino-border); }
.progress .head { display: flex; justify-content: space-between; align-items: baseline; }
.progress .head b { font-size: 14px; }
.progress .head span { font-size: 11px; color: var(--kino-text3); }
.bar { height: 6px; border-radius: 3px; background: var(--kino-surface2); overflow: hidden; margin: 10px 0; }
.bar > div { height: 100%; background: var(--kino-gold); border-radius: 3px; transition: width .4s ease; }
.progress .hint { font-size: 11px; color: var(--kino-text3); }

.posterrow { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 2px; }
.poster { flex-shrink: 0; width: 120px; cursor: pointer; min-width: 0; }
/* A plain 1fr means minmax(auto, 1fr), so a poster's intrinsic width can blow
   its column out and the two columns end up different sizes on a phone.
   minmax(0, 1fr) is what actually makes them equal. */
.postergrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.postergrid .poster { width: auto; }
.art {
  position: relative; aspect-ratio: 2/3; border-radius: 10px; overflow: hidden;
  background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 8px, var(--kino-surface) 8px, var(--kino-surface) 16px);
}
.art img { width: 100%; height: 100%; object-fit: cover; display: block; }
.art .badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,.6); color: #fff; font-size: 9px; font-weight: 800; padding: 2px 5px; border-radius: 4px; }
.art .warn { position: absolute; top: 6px; right: 6px; background: var(--kino-red); color: #fff; font-size: 9px; font-weight: 800; padding: 2px 5px; border-radius: 4px; }
.art .resume { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,.4); }
.art .resume > div { height: 100%; background: var(--kino-gold); }
.art .fav { position: absolute; right: 6px; bottom: 8px; color: var(--kino-gold); display: flex; filter: drop-shadow(0 0 2px rgba(0,0,0,.7)); }
.poster .title { font-size: 12px; font-weight: 700; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.poster .meta { font-size: 11px; color: var(--kino-text3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { display: flex; justify-content: center; padding: 18px 0 4px; }

/* View modes (FR-71a) — same tiles, different frames. */
.art.wide { aspect-ratio: 16/9; }
.art.banner { aspect-ratio: 4.5/1; border-radius: 12px; }
.art .caption {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px;
  font-weight: 800; font-size: 14px; box-sizing: border-box; color: #fff;
  background: linear-gradient(0deg, rgba(0,0,0,.65), transparent);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.thumbgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.thumbgrid .poster { width: auto; }
.tilecard { background: var(--kino-surface); border: 1px solid var(--kino-border); border-radius: 12px; overflow: hidden; }
.tilecard .art { border-radius: 0; }
.tilecard .title { padding: 0 10px; }
.tilecard .meta { padding: 0 10px 10px; }
.bannerlist { display: flex; flex-direction: column; gap: 12px; }
.bannertile { cursor: pointer; }
.listrows { display: flex; flex-direction: column; }
.listrow { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--kino-border); cursor: pointer; }
.listrow .art { width: 44px; aspect-ratio: 2/3; border-radius: 6px; flex-shrink: 0; }
.listrow .title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.listrow .meta { font-size: 11px; color: var(--kino-text3); margin-top: 2px; }
.listrow .flags { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
.listrow .flags .badge { background: var(--kino-surface2); color: var(--kino-text2); font-size: 9px; font-weight: 800; padding: 2px 5px; border-radius: 4px; }
.listrow .flags .seen { color: var(--kino-teal); font-weight: 800; font-size: 13px; }
.listrow .flags .fav { color: var(--kino-gold); display: flex; }
.listrow .flags .warn { background: var(--kino-red); color: #fff; font-size: 9px; font-weight: 800; padding: 2px 5px; border-radius: 4px; }

.iconbtn {
  width: 36px; height: 36px; border-radius: 18px; border: none; cursor: pointer;
  background: var(--kino-surface2); color: var(--kino-text2);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.iconbtn[aria-pressed="true"] { background: var(--kino-gold); color: var(--kino-goldText); }

input[type="text"], select {
  width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 12px;
  border: 1px solid var(--kino-border); background: var(--kino-surface);
  color: var(--kino-text); font-size: 13px; font-family: inherit; font-weight: 600;
  min-height: 44px;
}
.label { font-size: 11px; color: var(--kino-text3); font-weight: 700; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; }

.sheet {
  position: absolute; inset: 0; background: var(--kino-bg); z-index: 25;
  display: flex; flex-direction: column; overflow-y: auto;
  animation: kino-sheet-in .2s ease-out; padding: 16px 20px 24px; box-sizing: border-box;
}
.backdrop { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 10px, var(--kino-surface) 10px, var(--kino-surface) 20px); }
.backdrop img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dialog { position: absolute; inset: 0; z-index: 40; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 28px; box-sizing: border-box; }
.dialog > div { width: 100%; background: var(--kino-surface); border: 1px solid var(--kino-border); border-radius: 18px; padding: 22px; }

footer {
  flex-shrink: 0; padding: 10px 16px 14px;
  border-top: 1px solid var(--kino-border); background: var(--kino-surface);
}
.footrow { display: flex; align-items: center; gap: 10px; }
.footthumb {
  width: 36px; height: 36px; border-radius: 8px; flex-shrink: 0; overflow: hidden;
  background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 5px, var(--kino-surface) 5px, var(--kino-surface) 10px);
}
.footthumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.volrow { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.volval { font-size: 11px; color: var(--kino-text2); width: 62px; text-align: center; font-variant-numeric: tabular-nums; }
.round { width: 36px; height: 36px; border-radius: 18px; border: none; background: var(--kino-surface2); color: var(--kino-text2); font-size: 15px; cursor: pointer; flex-shrink: 0; }
.round.ghosted { background: transparent; }
.seek { border: none; background: transparent; color: var(--kino-text2); font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
.backdrop .caption {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 14px;
  font-weight: 800; font-size: 15px; box-sizing: border-box;
  background: linear-gradient(0deg, rgba(0,0,0,.65), transparent);
}

.empty { text-align: center; padding: 40px 12px; color: var(--kino-text2); }
.empty .sub { font-size: 12px; color: var(--kino-text3); margin-top: 6px; }
.error { color: var(--kino-red); font-size: 13px; }

/* Tablet: the same card, denser (FR-71). */
@media (min-width: 640px) {
  .tilegrid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .body { padding: 0 24px 24px; }
}
@media (min-width: 900px) {
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
}
`;

/* ------------------------------------------------------------------ *
 * The card                                                            *
 * ------------------------------------------------------------------ */

const POWER_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
  <circle cx="12" cy="13" r="8"></circle><line x1="12" y1="2" x2="12" y2="12"></line></svg>`;

const HEART_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
  <path d="M12 21s-7.5-4.7-10-9.3C.6 8.6 2.6 5 6.1 5c2 0 3.5 1 4.4 2.5.4.7 1.4.7 1.8 0C13.2 6 14.7 5 16.7 5c3.5 0 5.5 3.6 4.1 6.7C18.3 16.3 12 21 12 21z"></path></svg>`;

const VIEW_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
  <rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="3" width="8" height="8" rx="1.5"></rect>
  <rect x="3" y="13" width="8" height="8" rx="1.5"></rect><rect x="13" y="13" width="8" height="8" rx="1.5"></rect></svg>`;

const SORT_OPTIONS = [
  ["added", "Neu hinzugefügt"],
  ["title", "Titel"],
  ["year", "Jahr"],
  ["rating", "Bewertung"],
  ["runtime", "Laufzeit"],
  ["played", "Zuletzt gesehen"],
  ["critics", "Kritikerwertung"],
  ["random", "Zufällig"],
];

const TAGS = ["4K", "HD", "SD", "3D", "Weitersehen", "Nicht gesehen", "Gesehen", "Favoriten"];

// Jellyfin's six grid layouts, with Jellyfin's own German labels.
const VIEW_MODES = [
  ["poster", "Poster"],
  ["posterCard", "Posterkarte"],
  ["thumb", "Vorschau"],
  ["thumbCard", "Vorschaukarte"],
  ["banner", "Banner"],
  ["list", "Liste"],
];

const VIEW_MODE_STORAGE_KEY = "kino-card-view-mode";

/** localStorage is absent under the test runner and may be blocked in kiosks. */
function readStoredViewMode() {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return VIEW_MODES.some(([key]) => key === stored) ? stored : "poster";
  } catch (err) {
    return "poster";
  }
}

function storeViewMode(mode) {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch (err) {
    /* best effort — the mode still applies for this session */
  }
}

// Titles per request. Small enough that the first screen is quick, large
// enough that scrolling does not fetch constantly (FR-58).
const PAGE_SIZE = 60;

// What the ⟲10 / 10⟳ buttons move by.
const SEEK_STEP_SECONDS = 10;

/**
 * Home Assistant always provides HTMLElement; Node does not. Deriving from a
 * stand-in when it is absent keeps this file importable by the test runner,
 * so the card's logic is testable without a browser or a DOM shim.
 */
const CardBase = typeof HTMLElement !== "undefined" ? HTMLElement : class {};

class KinoCard extends CardBase {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._hass = null;
    this._config = {};
    this._kino = null;
    this._error = null;
    // An action that failed. Kept apart from `_error` (which tracks whether
    // the integration answers at all) so the next successful state poll, two
    // seconds later, does not wipe it off the screen unread.
    this._actionError = null;
    // What the last render was built from — see `_renderSignature`.
    this._signature = "";
    this._unsub = null;

    this._view = {
      main: "home",
      category: "movies",
      query: "",
      sort: "added",
      sortDir: null,
      viewMode: readStoredViewMode(),
      filters: { tags: [], genres: [], countries: [], ratings: [], yearFrom: null, yearTo: null },
      filterSheet: false,
      detailId: null,
      detail: null,
      playingOpen: false,
      powerConfirm: false,
      activityMenu: false,
      musikSource: "spotify",
      refreshing: false,
      dimmed: false,
    };
    this._library = {
      items: [],
      total: 0,
      hasMore: false,
      loading: false,
      error: null,
    };
    this._resume = [];
    this._recent = [];
    this._homeRowsAt = 0;
    this._facets = { genres: [], countries: [], ratings: [], yearMin: null, yearMax: null };
    this._searchTimer = null;
  }

  static getStubConfig() {
    return {};
  }

  setConfig(config) {
    this._config = config || {};
    // The card is a fixed-height frame so the transport bar stays on screen;
    // `height:` in the card config overrides how tall that frame is.
    if (this._config.height) {
      this.style.setProperty("--kino-card-height", this._config.height);
    } else {
      this.style.removeProperty("--kino-card-height");
    }
  }

  getCardSize() {
    return 12;
  }

  set hass(hass) {
    const previous = this._hass;
    this._hass = hass;
    if (previous === null) {
      this._refreshState();
      this._loadFacets();
      return;
    }
    // Volume, transport and track state live in entities, not in the state
    // payload, so a card that only re-rendered on payload changes showed a
    // stale dB value until something else happened to change.
    //
    // But a playing media_player republishes its position constantly, and
    // rebuilding the markup for that recreates every <img> — which is what
    // made the playback view flicker. So only a change that alters what the
    // card *renders* is worth a re-render; a moved position is a number to
    // write into two nodes.
    const signature = this._renderSignature();
    if (signature !== this._signature) {
      this._signature = signature;
      this._render();
    } else {
      this._tick();
    }
  }

  /** Everything the card renders as structure, as one comparable string. */
  _renderSignature() {
    if (!this._hass || !this._kino) return "";
    const states = this._hass.states;
    const player = states[this._playerEntity];
    const parts = [
      player && player.state,
      player && player.attributes.media_title,
      player && player.attributes.entity_picture,
      player && player.attributes.is_volume_muted,
      player && player.attributes.media_duration,
      states[this._volumeEntity] && states[this._volumeEntity].state,
    ];
    const controls = this._kino.controls || {};
    for (const id of [
      this._entity("audioTrack"),
      this._entity("subtitleTrack"),
      controls.preset,
      controls.upmixer,
    ]) {
      const state = id ? states[id] : null;
      parts.push(state && `${state.state}/${(state.attributes.options || []).length}`);
    }
    return parts.join("|");
  }

  /**
   * Advance the moving parts without touching the rest of the DOM.
   *
   * Rebuilding the markup would recreate the poster image every two seconds.
   */
  _tick() {
    if (!this._container) return;
    const state = this._hass.states[this._playerEntity];
    if (!state) return;
    const duration = state.attributes.media_duration || 0;
    const position = this._position(state);
    const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
    // Only the playback bars — the transition bar shows how far the room is
    // from being ready, which has nothing to do with the film's position.
    for (const bar of this._container.querySelectorAll('[data-bar="media"] > div')) {
      bar.style.width = `${pct}%`;
    }
    for (const el of this._container.querySelectorAll("[data-time='elapsed']")) {
      el.textContent = helpers.formatTime(position);
    }
    for (const el of this._container.querySelectorAll("[data-time='duration']")) {
      el.textContent = helpers.formatTime(duration);
    }
  }

  connectedCallback() {
    this._render();
    if (this._hass) this._refreshState();
    // The engine pushes through the coordinator, which updates the entities;
    // polling the compact state object keeps the card in step without needing
    // a bespoke subscription.
    this._timer = setInterval(() => {
      this._refreshState();
      // The player reports a position only now and then; the clock carries it
      // between updates, written straight into the two nodes that show it.
      this._tick();
    }, 2000);
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._searchTimer) clearTimeout(this._searchTimer);
  }

  /* -- data ---------------------------------------------------------- */

  async _ws(message) {
    if (!this._hass) throw new Error("Home Assistant ist nicht verbunden");
    return this._hass.callWS(message);
  }

  async _refreshState() {
    if (!this._hass) return;
    try {
      const next = await this._ws({ type: "kino/state" });
      const changed = JSON.stringify(next) !== JSON.stringify(this._kino);
      this._kino = next;
      this._error = null;
      if (changed) this._render();
    } catch (err) {
      this._error = err.message || "Kino ist nicht erreichbar";
      this._render();
    }
  }

  async _loadFacets() {
    try {
      this._facets = await this._ws({ type: "kino/library/facets" });
    } catch (err) {
      this._facets = { genres: [], countries: [], ratings: [], yearMin: null, yearMax: null };
    }
  }

  /**
   * Load a page of the library (FR-58).
   *
   * `append` keeps what is already on screen and asks for the next page, so
   * a 300-title library arrives in screenfuls instead of one 60-item slab
   * with no way to reach title 61.
   */
  async _loadLibrary(append = false) {
    if (append && (this._library.loading || !this._library.hasMore)) return;
    this._library.loading = true;
    if (!append) this._library.error = null;
    this._render();
    const offset = append ? this._library.items.length : 0;
    try {
      const message = helpers.queryFromFilters(
        this._view.filters,
        this._view.category,
        this._view.query,
        this._view.sort,
        offset,
        PAGE_SIZE,
        this._view.sortDir
      );
      const page = await this._ws(message);
      this._library = {
        items: append ? [...this._library.items, ...page.items] : page.items,
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        error: null,
      };
    } catch (err) {
      // Never a blank grid — say what happened and offer the retry (FR-45).
      // An failed *append* keeps the titles already on screen.
      this._library = {
        items: append ? this._library.items : [],
        total: append ? this._library.total : 0,
        hasMore: false,
        loading: false,
        error: err.message || "Die Bibliothek ist nicht erreichbar.",
      };
    }
    this._render();
  }

  /** Load the next page once the grid is scrolled close to its end. */
  _onScroll(event) {
    if (this._view.main !== "library" || !this._library.hasMore) return;
    const el = event.target;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
      this._loadLibrary(true);
    }
  }

  async _loadResume() {
    try {
      const result = await this._ws({ type: "kino/library/resume", limit: 12 });
      this._resume = result.items || [];
    } catch (err) {
      this._resume = [];
    }
    this._render();
  }

  async _loadRecent() {
    try {
      const page = await this._ws({
        type: "kino/library/search",
        category: "recent",
        limit: 12,
        offset: 0,
      });
      this._recent = page.items || [];
    } catch (err) {
      this._recent = [];
    }
    this._render();
  }

  /**
   * Fetch the home rows (Weitersehen, Zuletzt hinzugefügt — FR-70) at most
   * once a minute. Called from render, so the timestamp guard is what keeps
   * the fetch → render → fetch loop from spinning.
   */
  _ensureHomeRows() {
    if (Date.now() - this._homeRowsAt < 60000) return;
    this._homeRowsAt = Date.now();
    this._loadResume();
    this._loadRecent();
  }

  /* -- actions ------------------------------------------------------- */

  async _activate(key) {
    this._view.activityMenu = false;
    this._view.powerConfirm = false;
    this._render();
    try {
      await this._ws({ type: "kino/activate", activity: key });
    } catch (err) {
      this._actionError = err.message;
    }
    await this._refreshState();
  }

  async _restoreDevice(device) {
    try {
      await this._ws({ type: "kino/restore_device", device });
    } catch (err) {
      this._actionError = err.message;
    }
    await this._refreshState();
  }

  async _dismissDrift(device) {
    await this._ws({ type: "kino/dismiss_drift", device }).catch(() => {});
    await this._refreshState();
  }

  /**
   * Flip a favourite optimistically in every copy of the item the card
   * holds, then write it back to the catalogue; on failure, flip back.
   */
  async _toggleFavorite(itemId) {
    const current =
      (this._view.detail && this._view.detail.id === itemId
        ? this._view.detail.favorite
        : (this._library.items.find((i) => i.id === itemId) || {}).favorite) || false;
    const apply = (favorite) => {
      const flip = (it) => (it && it.id === itemId ? { ...it, favorite } : it);
      if (this._view.detail && this._view.detail.id === itemId) {
        this._view.detail = { ...this._view.detail, favorite };
      }
      this._library.items = this._library.items.map(flip);
      this._resume = this._resume.map(flip);
      this._recent = this._recent.map(flip);
      this._render();
    };
    apply(!current);
    try {
      await this._ws({
        type: "kino/library/favorite",
        item_id: itemId,
        favorite: !current,
      });
    } catch (err) {
      apply(current);
      this._actionError = err.message;
      this._render();
    }
  }

  async _forceRefresh() {
    if (this._view.refreshing) return;
    this._view.refreshing = true;
    this._render();
    try {
      await this._ws({ type: "kino/library/refresh" });
      await this._loadLibrary();
    } catch (err) {
      this._library.error = err.message;
    }
    this._view.refreshing = false;
    this._render();
  }

  _callService(domain, service, data) {
    return this._hass.callService(domain, service, data);
  }

  /**
   * Kino's own entity IDs, as reported by the integration.
   *
   * Never guessed from the entity list: "the media_player whose ID contains
   * kino" also matches a media-player group in this house, and calling
   * `volume_down` on that one fails inside the group helper.
   */
  _entity(role) {
    return (this._kino && this._kino.entities && this._kino.entities[role]) || null;
  }

  get _volumeEntity() {
    return this._entity("volume");
  }

  get _playerEntity() {
    return this._entity("player");
  }

  /** Call a service on Kino's own player, surfacing whatever comes back. */
  async _player(service, data = {}) {
    const player = this._playerEntity;
    if (!player) {
      this._actionError = "Die Kino-Player-Entity wurde nicht gefunden.";
      this._render();
      return;
    }
    try {
      await this._callService("media_player", service, {
        entity_id: player,
        ...data,
      });
    } catch (err) {
      this._actionError = err.message || String(err);
      this._render();
    }
  }

  async _stepVolume(direction) {
    await this._player(direction > 0 ? "volume_up" : "volume_down");
  }

  async _toggleMute() {
    const state = this._hass.states[this._playerEntity];
    await this._player("volume_mute", {
      is_volume_muted: !(state && state.attributes.is_volume_muted),
    });
  }

  async _transport(service) {
    await this._player(service);
  }

  /** Jump ±10 s, relative to where the player says it is right now. */
  async _seekBy(seconds) {
    const state = this._hass.states[this._playerEntity];
    if (!state) return;
    const duration = state.attributes.media_duration || 0;
    const target = Math.max(0, this._position(state) + seconds);
    await this._player("media_seek", {
      seek_position: duration ? Math.min(target, duration - 1) : target,
    });
  }

  /**
   * Dim the room and back again.
   *
   * Both scenes come from the configuration — the dim one from
   * `settings.dim_light_scene`, the other from the running activity — so the
   * button does nothing surprising and disappears when nothing is set.
   */
  async _toggleDim() {
    const scenes = this._kino.lightScenes || {};
    const target = this._view.dimmed ? scenes.activity : scenes.dim;
    this._view.dimmed = !this._view.dimmed;
    this._render();
    if (!target) return;
    try {
      await this._callService("scene", "turn_on", { entity_id: target });
    } catch (err) {
      this._actionError = err.message || String(err);
      this._render();
    }
  }

  /* -- rendering ----------------------------------------------------- */

  _activityByKey(key) {
    if (!this._kino) return null;
    return this._kino.activities.find((a) => a.key === key) || null;
  }

  get _currentActivity() {
    if (!this._kino) return null;
    return this._activityByKey(this._kino.targetActivity || this._kino.activity);
  }

  _render() {
    if (!this.shadowRoot) return;
    const root = this.shadowRoot;
    if (!this._styleEl) {
      this._styleEl = document.createElement("style");
      this._styleEl.textContent = STYLES;
      root.appendChild(this._styleEl);
      this._container = document.createElement("div");
      this._container.className = "wrap";
      root.appendChild(this._container);
      this._container.addEventListener("click", (e) => this._onClick(e));
      this._container.addEventListener("change", (e) => this._onChange(e));
      this._container.addEventListener("input", (e) => this._onInput(e));
      // Scroll does not bubble, so listen in the capture phase — the
      // scroller element itself is replaced on every render.
      this._container.addEventListener("scroll", (e) => this._onScroll(e), true);
    }

    if (!this._kino) {
      this._container.innerHTML = `
        <div class="empty">
          <p>${this._error ? this._esc(this._error) : "Kino wird geladen…"}</p>
          ${this._error ? '<p class="sub">Ist die Kino-Integration eingerichtet?</p>' : ""}
        </div>`;
      return;
    }

    const scrollTop = this._container.querySelector(".scroller")?.scrollTop || 0;
    // Re-rendering the whole card would otherwise drop the caret out of the
    // search box mid-word.
    const focused = this.shadowRoot.activeElement;
    const focusField = focused && focused.dataset ? focused.dataset.field : null;
    const caret = focused && focused.selectionStart != null ? focused.selectionStart : null;
    this._container.innerHTML = [
      this._renderHeader(),
      '<div class="scroller">',
      this._renderActivitySelector(),
      this._renderDeviceChips(),
      this._renderActionError(),
      this._renderDriftBanner(),
      this._renderProgress(),
      `<div class="body">${this._renderBody()}</div>`,
      "</div>",
      this._renderFooter(),
      this._view.detailId ? this._renderDetailSheet() : "",
      this._view.playingOpen ? this._renderPlayingSheet() : "",
      this._view.filterSheet ? this._renderFilterSheet() : "",
      this._view.powerConfirm ? this._renderPowerConfirm() : "",
    ].join("");
    this._signature = this._renderSignature();
    const scroller = this._container.querySelector(".scroller");
    if (scroller) scroller.scrollTop = scrollTop;
    if (focusField) {
      const next = this._container.querySelector(`[data-field="${focusField}"]`);
      if (next) {
        next.focus();
        if (caret != null && next.setSelectionRange) {
          next.setSelectionRange(caret, caret);
        }
      }
    }
  }

  _esc(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
    );
  }

  _renderHeader() {
    const k = this._kino;
    const transitioning = !!k.progress;
    const color = transitioning
      ? "var(--kino-gold)"
      : k.degraded || k.state === "error"
        ? "var(--kino-red)"
        : k.state === "off"
          ? "var(--kino-text3)"
          : "var(--kino-teal)";
    return `
      <header>
        <span class="brand">KINO</span>
        <div class="statuswrap">
          <div class="status">
            <span class="dot${transitioning ? " pulsing" : ""}" style="background:${color}"></span>
            <span>${this._esc(k.statusText)}</span>
          </div>
          <button class="iconbtn" data-act="ask-power-off" title="Kino ausschalten"
            style="color:${k.state === "off" ? "var(--kino-text3)" : "var(--kino-text)"}">
            ${POWER_ICON}
          </button>
        </div>
      </header>`;
  }

  _renderActivitySelector() {
    const k = this._kino;
    const current = this._currentActivity;
    const isOff = k.activity === k.offActivity && !k.progress;
    const showGrid = isOff || (this._view.activityMenu && !k.progress);
    const tiles = k.activities
      .filter((a) => a.key !== k.offActivity)
      .map(
        (a) => `<button class="tile" data-act="activate" data-key="${a.key}"
          aria-pressed="${current && current.key === a.key}">${this._esc(a.name)}</button>`
      )
      .join("");
    const compact = !isOff
      ? `<button class="chipbtn" data-act="toggle-menu">
           <span>${this._esc(
             k.progress && current ? `Wechsel zu ${current.name}…` : current ? current.name : "—"
           )}</span>
           <span style="font-size:10px;color:var(--kino-text3)">${this._view.activityMenu ? "▴" : "▾"}</span>
         </button>`
      : "";
    return `<div style="padding:0 20px 12px">
      ${compact}
      ${showGrid ? `<div class="tilegrid" style="margin-top:${compact ? 10 : 0}px">${tiles}</div>` : ""}
    </div>`;
  }

  _renderDeviceChips() {
    const k = this._kino;
    // While shutting down, the target ("Aus") has no devices — but the ones
    // being stopped are exactly what the user wants to watch, chip by chip,
    // as each confirms it is off.
    const current =
      k.progress && k.targetActivity === k.offActivity
        ? this._activityByKey(k.activity)
        : this._currentActivity;
    if (!current || !current.devices.length) return "";
    const byKey = Object.fromEntries(k.devices.map((d) => [d.key, d]));
    const chips = current.devices
      .map((key) => {
        const device = byKey[key] || { name: key, health: "unknown" };
        const pulsing = device.health === "starting" || device.health === "stopping";
        return `<div class="devicechip">
          <span class="dot${pulsing ? " pulsing" : ""}" style="width:7px;height:7px;background:${helpers.deviceColor(device.health)}"></span>
          <span>${this._esc(device.name)}</span>
        </div>`;
      })
      .join("");
    return `<div class="devicechips" style="padding:0 20px">${chips}</div>`;
  }

  _renderActionError() {
    if (!this._actionError) return "";
    return `<div style="padding:0 20px"><div class="banner">
      <strong>${this._esc(this._actionError)}</strong>
      <div class="row">
        <button class="ghost" data-act="dismiss-error">Verstanden</button>
      </div>
    </div></div>`;
  }

  _renderDriftBanner() {
    const drift = (this._kino.drift || []).filter((d) => d.classification !== "benign");
    if (!drift.length) return "";
    const finding = drift[0];
    return `<div style="padding:0 20px"><div class="banner">
      <strong>${this._esc(finding.detail)}</strong>
      <p>Die Aktivität bleibt aktiv — es wird nichts automatisch zurückgesetzt.</p>
      <div class="row">
        ${
          finding.restorable
            ? `<button class="primary" style="padding:10px;font-size:12px" data-act="restore" data-key="${finding.device}">Wiederherstellen</button>`
            : ""
        }
        <button class="ghost" data-act="dismiss-drift" data-key="${finding.device}">Ignorieren</button>
      </div>
    </div></div>`;
  }

  _renderProgress() {
    const p = this._kino.progress;
    if (!p) return "";
    const current = this._currentActivity;
    const toOff = this._kino.targetActivity === this._kino.offActivity;
    return `<div style="padding:0 20px"><div class="progress">
      <div class="head">
        <b>${this._esc(toOff ? "Kino wird ausgeschaltet" : `Wechsel zu ${current ? current.name : "…"}`)}</b>
        <span>${this._esc(helpers.formatEta(p.etaSeconds))}</span>
      </div>
      <div class="bar"><div style="width:${p.percent}%"></div></div>
      <span class="hint">${this._esc(p.bottleneck || "Geräte werden vorbereitet…")}</span>
    </div></div>`;
  }

  _renderBody() {
    if (this._view.main === "library") return this._renderLibrary();
    const k = this._kino;
    const current = this._currentActivity;
    if (k.progress) return "";

    switch (helpers.bodyFor(current)) {
      case "aus":
        // FR-41: the library does not need the theater. Browsing, filtering
        // and even the play button (which powers everything on, FR-55) work
        // from here.
        this._ensureHomeRows();
        return `
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
                      background:var(--kino-surface);border:1px solid var(--kino-border);margin-bottom:16px">
            <span style="color:var(--kino-text3);display:flex">${POWER_ICON}</span>
            <div>
              <div style="font-size:13px;font-weight:700">Kino ist ausgeschaltet</div>
              <div style="font-size:11px;color:var(--kino-text3)">Aktivität oben wählen, um zu starten — die Bibliothek ist trotzdem verfügbar.</div>
            </div>
          </div>
          ${this._renderLibraryHome()}`;
      case "library":
        this._ensureHomeRows();
        return this._renderLibraryHome();
      case "musik":
        return this._renderMusik();
      default:
        return `<div class="empty">
          <p>${this._esc(current.handoffText || "Weiter auf der Fernbedienung des Geräts.")}</p>
        </div>`;
    }
  }

  _renderLibraryHome() {
    const resumeRow = this._resume.length
      ? `<div class="section">
           <h3>Weitersehen</h3>
           <div class="posterrow hscroll">${this._resume.map((t) => this._poster(t, true)).join("")}</div>
         </div>`
      : "";
    const recentRow = this._recent.length
      ? `<div class="section">
           <h3>Zuletzt hinzugefügt</h3>
           <div class="posterrow hscroll">${this._recent.map((t) => this._poster(t, false)).join("")}</div>
         </div>`
      : "";
    return `
      <div class="section">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <h3 style="margin:0">Filme &amp; Serien</h3>
          <a class="link" data-act="open-library" data-key="movies">Erkunden</a>
        </div>
        <p style="font-size:12px;color:var(--kino-text2);margin-bottom:12px">
          Durchsuchen, filtern und sortieren.
        </p>
        <div class="row">
          <button class="tile" style="text-align:center" data-act="open-library" data-key="movies">Filme</button>
          <button class="tile" style="text-align:center" data-act="open-library" data-key="shows">Serien</button>
        </div>
      </div>
      ${resumeRow}
      ${recentRow}`;
  }

  _renderMusik() {
    const src = this._view.musikSource;
    return `
      <div class="row" style="margin-bottom:14px">
        <button class="pill" style="flex:1;height:40px" data-act="musik-source" data-key="spotify" aria-pressed="${src === "spotify"}">Spotify</button>
        <button class="pill" style="flex:1;height:40px" data-act="musik-source" data-key="tidal" aria-pressed="${src === "tidal"}">Tidal</button>
      </div>
      <div style="padding:18px;border-radius:16px;background:var(--kino-surface);border:1px solid var(--kino-border)">
        ${
          src === "spotify"
            ? `<div class="label">Spotify Connect · Zidoo</div>
               <p style="font-size:13px;color:var(--kino-text2)">Der Zidoo ist als Wiedergabeziel vorbereitet. Titelwahl über die Spotify-Integration.</p>`
            : `<p style="font-size:13px;color:var(--kino-text2);text-align:center">Weiter in der Tidal-App auf deinem Handy — der Zidoo ist als Wiedergabeziel vorbereitet.</p>`
        }
      </div>`;
  }

  /** The badges and the resume bar that every layout shares. */
  _artOverlays(item, showResume) {
    return `
      ${item.res4k ? '<span class="badge">4K</span>' : ""}
      ${item.playable === false ? '<span class="warn" title="Nicht abspielbar">!</span>' : ""}
      ${item.favorite ? `<span class="fav">${HEART_ICON}</span>` : ""}
      ${
        showResume && item.continueWatching
          ? `<div class="resume"><div style="width:${item.continueWatching}%"></div></div>`
          : ""
      }`;
  }

  _poster(item, showResume) {
    const src = helpers.artworkUrl(item.id, "Primary", this._kino.artworkSignature);
    return `<div class="poster" data-act="open-detail" data-key="${this._esc(item.id)}">
      <div class="art">
        <img loading="lazy" src="${src}" alt="" onerror="this.style.display='none'">
        ${this._artOverlays(item, showResume)}
      </div>
      <div class="title">${this._esc(item.title)}</div>
      <div class="meta">${this._esc(helpers.metaLine(item))}</div>
    </div>`;
  }

  /** One grid entry in the current view mode (FR-71a: Jellyfin's six layouts). */
  _tile(item, mode) {
    const sig = this._kino.artworkSignature;
    const [type, fallbackType] = helpers.artworkTypeFor(item, mode);
    const src = helpers.artworkUrl(item.id, type, sig);
    const fallback = fallbackType
      ? `this.onerror=null;this.src='${this._esc(helpers.artworkUrl(item.id, fallbackType, sig))}'`
      : "this.style.display='none'";
    const img = `<img loading="lazy" src="${src}" alt="" onerror="${fallback}">`;

    if (mode === "list") {
      return `<div class="listrow" data-act="open-detail" data-key="${this._esc(item.id)}">
        <div class="art">${img}${
          item.continueWatching
            ? `<div class="resume"><div style="width:${item.continueWatching}%"></div></div>`
            : ""
        }</div>
        <div style="flex:1;min-width:0">
          <div class="title">${this._esc(item.title)}</div>
          <div class="meta">${this._esc(helpers.metaLine(item))}</div>
        </div>
        <div class="flags">
          ${item.res4k ? '<span class="badge">4K</span>' : ""}
          ${item.watched ? '<span class="seen" title="Gesehen">✓</span>' : ""}
          ${item.favorite ? `<span class="fav">${HEART_ICON}</span>` : ""}
          ${item.playable === false ? '<span class="warn" title="Nicht abspielbar">!</span>' : ""}
        </div>
      </div>`;
    }

    if (mode === "banner") {
      // Real banner art carries its own title lettering; the fallback
      // backdrop does not, so it gets the caption overlay.
      const caption = item.bannerTag
        ? ""
        : `<div class="caption">${this._esc(item.title)}</div>`;
      return `<div class="bannertile" data-act="open-detail" data-key="${this._esc(item.id)}">
        <div class="art wide banner">${img}${caption}${this._artOverlays(item, true)}</div>
      </div>`;
    }

    const wide = mode === "thumb" || mode === "thumbCard";
    const card = mode === "posterCard" || mode === "thumbCard";
    return `<div class="poster${card ? " tilecard" : ""}" data-act="open-detail" data-key="${this._esc(item.id)}">
      <div class="art${wide ? " wide" : ""}">
        ${img}
        ${this._artOverlays(item, true)}
      </div>
      <div class="title">${this._esc(item.title)}</div>
      <div class="meta">${this._esc(helpers.metaLine(item))}</div>
    </div>`;
  }

  _renderItems(items) {
    const mode = this._view.viewMode;
    const tiles = items.map((t) => this._tile(t, mode)).join("");
    if (mode === "list") return `<div class="listrows">${tiles}</div>`;
    if (mode === "banner") return `<div class="bannerlist">${tiles}</div>`;
    if (mode === "thumb" || mode === "thumbCard")
      return `<div class="thumbgrid">${tiles}</div>`;
    return `<div class="postergrid">${tiles}</div>`;
  }

  _renderLibrary() {
    const lib = this._library;
    const filters = this._view.filters;
    const count = helpers.activeFilterCount(filters);
    const yearLabel = helpers.yearRangeLabel(filters.yearFrom, filters.yearTo);
    const chips = [
      ...filters.tags.map((t) => ["tag", t]),
      ...filters.genres.map((g) => ["genre", g]),
      ...(filters.ratings || []).map((r) => ["rating", r]),
      ...filters.countries.map((c) => ["country", c]),
      ...(yearLabel ? [["year", yearLabel]] : []),
    ]
      .map(
        ([kind, value]) =>
          `<button class="pill" style="height:30px;font-size:11px;background:transparent;border:1px solid var(--kino-border)"
             data-act="remove-filter" data-kind="${kind}" data-key="${this._esc(value)}">${this._esc(value)} ✕</button>`
      )
      .join("");

    let grid;
    if (lib.loading && !lib.items.length) {
      grid = '<p class="empty">Wird geladen…</p>';
    } else if (lib.error && !lib.items.length) {
      grid = `<div class="empty">
        <p class="error">${this._esc(lib.error)}</p>
        <p class="sub">Die Festplatten der NAS schlafen vielleicht noch.</p>
        <button class="primary" style="margin-top:14px;max-width:260px" data-act="force-refresh">
          ${this._view.refreshing ? "Wird aktualisiert…" : "Erneut versuchen"}
        </button>
      </div>`;
    } else if (!lib.items.length) {
      grid = `<div class="empty"><p>${
        this._view.category === "shows"
          ? "Noch keine Serien in der Bibliothek."
          : "Keine Treffer"
      }</p></div>`;
    } else {
      const more = lib.hasMore
        ? `<div class="more">
             <button class="ghost" data-act="load-more" ${lib.loading ? "disabled" : ""}>
               ${lib.loading ? "Wird geladen…" : "Weitere Titel laden"}
             </button>
           </div>`
        : "";
      grid = `${this._renderItems(lib.items)}${more}
        ${lib.error ? `<p class="error" style="margin-top:12px">${this._esc(lib.error)}</p>` : ""}`;
    }

    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <a class="link" data-act="back-home">‹ Zurück</a>
        <h2 style="flex:1">Bibliothek · ${this._view.category === "shows" ? "Serien" : "Filme"}</h2>
        <a class="link" style="color:var(--kino-text2)" data-act="force-refresh">${
          this._view.refreshing ? "Wird aktualisiert…" : "Aktualisieren"
        }</a>
      </div>
      <div class="row" style="margin-bottom:10px">
        <button class="pill" style="flex:1;height:40px" data-act="category" data-key="movies" aria-pressed="${this._view.category === "movies"}">Filme</button>
        <button class="pill" style="flex:1;height:40px" data-act="category" data-key="shows" aria-pressed="${this._view.category === "shows"}">Serien</button>
      </div>
      <input type="text" data-field="query" placeholder="Titel suchen…" value="${this._esc(this._view.query)}" style="margin-bottom:12px">
      <div class="row" style="margin-bottom:10px">
        <button class="pill" style="flex:0 0 auto;height:40px" data-act="open-filters" aria-pressed="${count > 0}">
          ${count ? `Filter · ${count}` : "Filter"}
        </button>
        <select data-field="sort" style="flex:1;min-width:0">
          ${SORT_OPTIONS.map(
            ([value, label]) =>
              `<option value="${value}"${this._view.sort === value ? " selected" : ""}>${label}</option>`
          ).join("")}
        </select>
        <button class="pill" style="flex:0 0 auto;width:40px;height:40px;padding:0" data-act="sort-dir"
          aria-pressed="${!!this._view.sortDir}" title="Sortierrichtung umkehren">
          ${(this._view.sortDir || helpers.defaultSortDir(this._view.sort)) === "asc" ? "↑" : "↓"}
        </button>
        <button class="pill" style="flex:0 0 auto;width:40px;height:40px;padding:0" data-act="view-mode"
          title="Ansicht: ${(VIEW_MODES.find(([k]) => k === this._view.viewMode) || VIEW_MODES[0])[1]}">
          ${VIEW_ICON}
        </button>
      </div>
      ${chips ? `<div class="posterrow hscroll" style="margin-bottom:10px">${chips}</div>` : ""}
      <div style="font-size:11px;color:var(--kino-text3);margin-bottom:12px">${
        lib.items.length && lib.items.length < lib.total
          ? `${lib.items.length} von ${lib.total} Titeln`
          : `${lib.total} Titel`
      }</div>
      ${grid}`;
  }

  _renderFilterSheet() {
    const f = this._view.filters;
    const group = (title, values, kind, selected) =>
      values.length
        ? `<div class="label">${title}</div>
           <div class="posterrow hscroll" style="flex-wrap:wrap;margin-bottom:20px">
             ${values
               .map(
                 (v) =>
                   `<button class="pill" data-act="toggle-filter" data-kind="${kind}" data-key="${this._esc(v)}"
                      aria-pressed="${selected.includes(v)}">${this._esc(v)}</button>`
               )
               .join("")}
           </div>`
        : "";
    const effectiveDir = this._view.sortDir || helpers.defaultSortDir(this._view.sort);
    return `<div class="sheet" style="z-index:35">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
        <a class="link" data-act="close-filters">‹ Zurück</a>
        <h2 style="flex:1">Filter</h2>
        <a class="link" style="color:var(--kino-text2)" data-act="reset-filters">Zurücksetzen</a>
      </div>
      ${group("Format &amp; Status", TAGS, "tag", f.tags)}
      ${group("Genre", this._facets.genres || [], "genre", f.genres)}
      ${group("Altersfreigabe", this._facets.ratings || [], "rating", f.ratings || [])}
      ${group("Land", this._facets.countries || [], "country", f.countries)}
      ${this._renderYearRange()}
      <div class="label">Sortierung</div>
      <select data-field="sort" style="width:100%;margin-bottom:10px">
        ${SORT_OPTIONS.map(
          ([value, label]) =>
            `<option value="${value}"${this._view.sort === value ? " selected" : ""}>${label}</option>`
        ).join("")}
      </select>
      <div class="row" style="margin-bottom:20px">
        <button class="pill" style="flex:1;height:34px" data-act="sort-dir-set" data-key="asc"
          aria-pressed="${effectiveDir === "asc"}">Aufsteigend</button>
        <button class="pill" style="flex:1;height:34px" data-act="sort-dir-set" data-key="desc"
          aria-pressed="${effectiveDir === "desc"}">Absteigend</button>
      </div>
      <div class="label">Ansicht</div>
      <div class="posterrow hscroll" style="flex-wrap:wrap;margin-bottom:20px">
        ${VIEW_MODES.map(
          ([key, label]) =>
            `<button class="pill" data-act="view-mode-set" data-key="${key}"
               aria-pressed="${this._view.viewMode === key}">${label}</button>`
        ).join("")}
      </div>
      <button class="primary" data-act="close-filters">${this._library.total} Titel anzeigen</button>
    </div>`;
  }

  /** The mockup's "Erscheinungsjahr … bis …" pair, bounded by the facets. */
  _renderYearRange() {
    const f = this._view.filters;
    const maxYear = this._facets.yearMax || new Date().getFullYear();
    const minYear = this._facets.yearMin || 1930;
    const years = [];
    for (let y = maxYear; y >= minYear; y--) years.push(y);
    const options = (selected) =>
      `<option value="">–</option>` +
      years
        .map((y) => `<option value="${y}"${selected === y ? " selected" : ""}>${y}</option>`)
        .join("");
    return `
      <div class="label">Erscheinungsjahr</div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
        <select data-field="year-from" style="flex:1">${options(f.yearFrom)}</select>
        <span style="color:var(--kino-text3);font-size:13px">bis</span>
        <select data-field="year-to" style="flex:1">${options(f.yearTo)}</select>
      </div>`;
  }

  _renderDetailSheet() {
    const item = this._view.detail;
    if (!item) return '<div class="sheet"><p class="empty">Wird geladen…</p></div>';
    const backdrop = helpers.artworkUrl(
      item.id,
      "Backdrop",
      this._kino.artworkSignature
    );
    // While no media activity runs, playing also powers the theater on
    // (FR-55) — the label must say so instead of pretending it just plays.
    const mediaActive =
      helpers.bodyFor(this._currentActivity) === "library" && !this._kino.progress;
    return `<div class="sheet">
      <div style="display:flex;align-items:center;gap:10px">
        <a class="link" style="flex:1" data-act="close-detail">‹ Zurück</a>
        <button class="iconbtn" data-act="toggle-favorite" data-key="${this._esc(item.id)}"
          aria-pressed="${!!item.favorite}"
          title="${item.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}">${HEART_ICON}</button>
      </div>
      <div class="backdrop" style="margin-top:12px">
        <img src="${backdrop}" alt="" onerror="this.style.display='none'">
      </div>
      <h2 style="margin:14px 0 4px;font-size:20px">${this._esc(item.title)}</h2>
      <div style="font-size:12px;color:var(--kino-text2)">${this._esc(
        [helpers.metaLine(item), item.officialRating].filter(Boolean).join(" · ")
      )}</div>
      ${
        item.videoFormat
          ? `<div style="font-size:11px;color:var(--kino-text3);font-family:ui-monospace,monospace;margin-top:8px">${this._esc(
              [item.videoFormat, item.audioFormat].filter(Boolean).join(" · ")
            )}</div>`
          : ""
      }
      ${
        item.tagline
          ? `<p style="font-size:13px;color:var(--kino-text2);font-style:italic;margin:14px 0">${this._esc(item.tagline)}</p>`
          : ""
      }
      ${
        item.playable === false
          ? `<p class="error" style="margin:14px 0">${this._esc(item.unplayableReason || "Dieser Titel ist nicht abspielbar.")}</p>`
          : `<button class="primary" style="margin-top:18px" data-act="play" data-key="${this._esc(item.id)}">${this._esc(helpers.playLabel(item, mediaActive))}</button>
             ${
               item.continueWatching
                 ? `<button class="ghost" style="width:100%;margin-top:8px" data-act="play-from-start" data-key="${this._esc(item.id)}">Von Anfang abspielen</button>`
                 : ""
             }`
      }
    </div>`;
  }

  /** The full playback view from the mockup. */
  _renderPlayingSheet() {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    if (!state) return "";
    const attrs = state.attributes;
    const duration = attrs.media_duration || 0;
    const position = this._position(state);
    const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
    const playing = state.state === "playing";
    const title = attrs.media_title || "Wiedergabe";
    // A 16:9 frame showing a 2:3 poster crops two thirds of it away, so ask
    // for the real backdrop and keep the poster as the fallback.
    const poster = attrs.entity_picture;
    const item = this._kino.nowPlaying;
    const art =
      item && item.id
        ? helpers.artworkUrl(item.id, "Backdrop", this._kino.artworkSignature)
        : poster;
    const fallback =
      art && poster && art !== poster
        ? `this.onerror=null;this.src='${this._esc(poster)}'`
        : "this.style.display='none'";

    return `<div class="sheet" style="z-index:30">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <a class="link" data-act="collapse-playing">⌄ Minimieren</a>
        <a class="link" style="color:var(--kino-text3)" data-act="stop-playing">Wiedergabe beenden</a>
      </div>
      <div class="backdrop">
        ${art ? `<img src="${this._esc(art)}" alt="" onerror="${fallback}">` : ""}
        <div class="caption">${this._esc(title)}</div>
      </div>
      <div class="bar" data-bar="media" style="margin:16px 0 6px"><div style="width:${pct}%"></div></div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--kino-text3);margin-bottom:20px">
        <span data-time="elapsed">${helpers.formatTime(position)}</span>
        <span data-time="duration">${helpers.formatTime(duration)}</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:center;gap:16px;margin-bottom:22px">
        <button class="round ghosted" data-act="transport" data-key="media_previous_track" title="Vorheriger Titel">⏮</button>
        <button class="seek" data-act="seek" data-key="-${SEEK_STEP_SECONDS}" title="10 Sekunden zurück">⟲${SEEK_STEP_SECONDS}</button>
        <button class="round" style="width:52px;height:52px;border-radius:26px;background:var(--kino-gold);color:var(--kino-goldText)"
          data-act="transport" data-key="${playing ? "media_pause" : "media_play"}">
          ${playing ? "⏸" : "▶"}
        </button>
        <button class="seek" data-act="seek" data-key="${SEEK_STEP_SECONDS}" title="10 Sekunden vor">${SEEK_STEP_SECONDS}⟳</button>
        <button class="round ghosted" data-act="transport" data-key="media_next_track" title="Nächster Titel">⏭</button>
      </div>
      ${this._renderVolumeRow(true)}
      ${this._renderSoundSelects()}
      ${this._renderTrackSelects()}
    </div>`;
  }

  /** Position, advanced by the clock between the player's own updates. */
  _position(state) {
    const attrs = state.attributes;
    const base = attrs.media_position || 0;
    if (state.state !== "playing" || !attrs.media_position_updated_at) return base;
    const since = (Date.now() - Date.parse(attrs.media_position_updated_at)) / 1000;
    const duration = attrs.media_duration || 0;
    const position = base + Math.max(0, since);
    return duration ? Math.min(position, duration) : position;
  }

  /** Mute, the optional Dim scene, and the dB stepper. */
  _renderVolumeRow(withDim) {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    const muted = state && state.attributes.is_volume_muted;
    const volumeEntity = this._volumeEntity;
    const db = volumeEntity ? this._hass.states[volumeEntity]?.state : null;
    const dimScene = (this._kino.lightScenes || {}).dim;
    return `<div class="volrow" style="${withDim ? "justify-content:flex-start" : ""}">
      <button class="pill" data-act="mute" aria-pressed="${!!muted}">Stumm</button>
      ${
        withDim && dimScene
          ? `<button class="pill" data-act="dim" aria-pressed="${this._view.dimmed}">Dim</button>`
          : ""
      }
      ${withDim ? '<div style="flex:1"></div>' : ""}
      <button class="round" data-act="vol" data-key="down">–</button>
      <span class="volval">${this._esc(helpers.formatVolume(db, muted))}</span>
      <button class="round" data-act="vol" data-key="up">+</button>
    </div>`;
  }

  /** Preset and upmixer, straight off the processor's own option lists. */
  _renderSoundSelects() {
    const controls = this._kino.controls || {};
    // The Trinnov reports "none" as its upmixer when nothing is upmixed, but
    // refuses it as a *choice* — selecting it fails with "Unknown upmixer
    // option". "auto" is the settable equivalent, and it is already listed.
    const blocks = [
      [controls.preset, "Trinnov · Preset", []],
      [controls.upmixer, "Upmixer", ["none"]],
    ]
      .map(([entityId, label, hidden]) =>
        this._entitySelectBlock(entityId, label, hidden)
      )
      .filter(Boolean);
    if (!blocks.length) return "";
    return `<div style="display:flex;gap:10px;margin-bottom:16px">
      ${blocks.map((block) => `<div style="flex:1;min-width:0">${block}</div>`).join("")}
    </div>`;
  }

  _renderTrackSelects() {
    return (
      this._entitySelectBlock(this._entity("audioTrack"), "Tonspur") +
      this._entitySelectBlock(this._entity("subtitleTrack"), "Untertitel")
    );
  }

  /**
   * One labelled select over a `select.*` entity, or nothing at all.
   *
   * `hidden` lists option values the entity reports but rejects when set —
   * they are kept out of the menu. When the *current* state is one of them
   * (or is otherwise not offered), it still shows, as a disabled entry: the
   * display must not claim a setting the device does not have.
   */
  _entitySelectBlock(entityId, label, hidden = []) {
    if (!entityId) return "";
    const state = this._hass.states[entityId];
    if (!state || state.state === "unavailable") return "";
    const options = (state.attributes.options || []).filter(
      (o) => o !== "—" && !hidden.includes(o)
    );
    // A device that reports no list gets no empty dropdown (FR-60).
    if (!options.length) return "";
    const current = state.state;
    const orphan =
      current && current !== "unknown" && !options.includes(current);
    return `<div style="margin-bottom:12px">
      <div class="label">${this._esc(label)}</div>
      <select data-field="entity-select" data-key="${entityId}">
        ${orphan ? `<option value="" disabled selected>${this._esc(current)}</option>` : ""}
        ${options
          .map(
            (o) =>
              `<option value="${this._esc(o)}"${current === o ? " selected" : ""}>${this._esc(o)}</option>`
          )
          .join("")}
      </select>
    </div>`;
  }

  _renderPowerConfirm() {
    return `<div class="dialog"><div>
      <h3 style="margin:0 0 8px;font-size:16px">Kino ausschalten?</h3>
      <p style="margin:0 0 18px;font-size:13px;color:var(--kino-text2)">
        Alle Geräte werden heruntergefahren und das Licht wird wiederhergestellt.
      </p>
      <div class="row">
        <button class="ghost" data-act="cancel-power-off">Abbrechen</button>
        <button class="primary" style="padding:12px;font-size:13px" data-act="confirm-power-off">Ausschalten</button>
      </div>
    </div></div>`;
  }

  _renderFooter() {
    const k = this._kino;
    if (k.state === "off" || this._view.detailId || this._view.playingOpen) return "";
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    const playing = state && ["playing", "paused"].includes(state.state);
    const volume = this._renderVolumeRow(false);

    if (!playing) {
      const current = this._currentActivity;
      return `<footer>
        <div class="footrow">
          <div style="flex:1;font-size:12px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${this._esc(current ? current.name : "")}
          </div>
        </div>
        ${volume}
      </footer>`;
    }

    const attrs = state.attributes;
    const duration = attrs.media_duration || 0;
    const position = this._position(state);
    const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
    const art = attrs.entity_picture;
    return `<footer>
      <div class="footrow">
        <div class="footthumb" data-act="expand-playing">
          ${art ? `<img src="${this._esc(art)}" alt="" onerror="this.style.display='none'">` : ""}
        </div>
        <div style="flex:1;overflow:hidden;cursor:pointer;min-width:0" data-act="expand-playing">
          <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${this._esc(attrs.media_title || "Wiedergabe")}
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:5px">
            <span data-time="elapsed" style="font-size:10px;color:var(--kino-text3);flex-shrink:0">${helpers.formatTime(position)}</span>
            <div class="bar" data-bar="media" style="flex:1;height:3px;margin:0"><div style="width:${pct}%"></div></div>
            <span data-time="duration" style="font-size:10px;color:var(--kino-text3);flex-shrink:0">${helpers.formatTime(duration)}</span>
          </div>
        </div>
        <button class="round" style="background:var(--kino-gold);color:var(--kino-goldText)"
          data-act="transport" data-key="${state.state === "playing" ? "media_pause" : "media_play"}">
          ${state.state === "playing" ? "⏸" : "▶"}
        </button>
        <button class="round ghosted" data-act="expand-playing" title="Wiedergabe öffnen">⌃</button>
      </div>
      ${volume}
    </footer>`;
  }

  /* -- events -------------------------------------------------------- */

  async _onClick(event) {
    const target = event.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    const key = target.dataset.key;
    const kind = target.dataset.kind;
    const view = this._view;

    switch (act) {
      case "activate":
        await this._activate(key);
        break;
      case "toggle-menu":
        view.activityMenu = !view.activityMenu;
        this._render();
        break;
      case "ask-power-off":
        view.powerConfirm = true;
        this._render();
        break;
      case "cancel-power-off":
        view.powerConfirm = false;
        this._render();
        break;
      case "confirm-power-off":
        await this._activate(this._kino.offActivity);
        break;
      case "restore":
        await this._restoreDevice(key);
        break;
      case "dismiss-drift":
        await this._dismissDrift(key);
        break;
      case "dismiss-error":
        this._actionError = null;
        this._render();
        break;
      case "open-library":
        view.main = "library";
        view.category = key || "movies";
        this._render();
        await this._loadLibrary();
        break;
      case "category":
        view.category = key;
        this._render();
        await this._loadLibrary();
        break;
      case "back-home":
        view.main = "home";
        this._render();
        break;
      case "open-filters":
        view.filterSheet = true;
        this._render();
        break;
      case "close-filters":
        view.filterSheet = false;
        this._render();
        await this._loadLibrary();
        break;
      case "reset-filters":
        view.filters = { tags: [], genres: [], countries: [], ratings: [], yearFrom: null, yearTo: null };
        this._render();
        break;
      case "toggle-filter":
      case "remove-filter": {
        if (kind === "year") {
          view.filters.yearFrom = null;
          view.filters.yearTo = null;
          this._render();
          await this._loadLibrary();
          break;
        }
        const bucket = { tag: "tags", genre: "genres", country: "countries", rating: "ratings" }[kind];
        const list = view.filters[bucket] || [];
        if (act === "toggle-filter" && bucket === "tags") {
          // Resolution tiers and watch states are mutually exclusive.
          view.filters.tags = helpers.toggleTag(list, key);
        } else {
          view.filters[bucket] = list.includes(key)
            ? list.filter((v) => v !== key)
            : [...list, key];
        }
        this._render();
        if (act === "remove-filter") await this._loadLibrary();
        break;
      }
      case "sort-dir": {
        const effective = view.sortDir || helpers.defaultSortDir(view.sort);
        const flipped = effective === "desc" ? "asc" : "desc";
        view.sortDir = flipped === helpers.defaultSortDir(view.sort) ? null : flipped;
        this._render();
        await this._loadLibrary();
        break;
      }
      case "sort-dir-set":
        // Normalised against the default, so the toolbar arrow only reads as
        // "overridden" when the user actually deviated.
        view.sortDir = key === helpers.defaultSortDir(view.sort) ? null : key;
        this._render();
        break;
      case "view-mode": {
        const idx = VIEW_MODES.findIndex(([k]) => k === view.viewMode);
        view.viewMode = VIEW_MODES[(idx + 1) % VIEW_MODES.length][0];
        storeViewMode(view.viewMode);
        this._render();
        break;
      }
      case "view-mode-set":
        view.viewMode = key;
        storeViewMode(view.viewMode);
        this._render();
        break;
      case "toggle-favorite":
        await this._toggleFavorite(key);
        break;
      case "force-refresh":
        await this._forceRefresh();
        break;
      case "open-detail":
        view.detailId = key;
        view.detail = null;
        this._render();
        try {
          view.detail = await this._ws({ type: "kino/library/item", item_id: key });
        } catch (err) {
          view.detail = null;
          this._actionError = err.message;
        }
        this._render();
        break;
      case "close-detail":
        view.detailId = null;
        view.detail = null;
        this._render();
        break;
      case "play":
      case "play-from-start":
        await this._play(key, act === "play-from-start");
        break;
      case "expand-playing":
        view.playingOpen = true;
        this._render();
        break;
      case "collapse-playing":
        view.playingOpen = false;
        this._render();
        break;
      case "transport":
        await this._transport(key);
        break;
      case "stop-playing":
        // Ending the film is also leaving the playback view — staying on a
        // dead transport screen helps nobody.
        view.playingOpen = false;
        this._render();
        await this._transport("media_stop");
        break;
      case "vol":
        await this._stepVolume(key === "up" ? 1 : -1);
        break;
      case "mute":
        await this._toggleMute();
        break;
      case "seek":
        await this._seekBy(Number(key));
        break;
      case "dim":
        await this._toggleDim();
        break;
      case "load-more":
        await this._loadLibrary(true);
        break;
      case "musik-source":
        view.musikSource = key;
        this._render();
        break;
      default:
        break;
    }
  }

  /**
   * FR-55: picking a title while Film is not running starts the activity and
   * then plays — one user action, with progress shown throughout.
   *
   * Both halves happen in the integration: it starts the activity, waits for
   * the room to settle and only then opens the file. The card does not await
   * that — the projector alone takes minutes — it just shows the progress the
   * state poll is already delivering.
   */
  async _play(itemId, fromStart) {
    const player = this._playerEntity;
    this._view.detailId = null;
    this._view.detail = null;
    this._render();
    if (!player) {
      this._actionError = "Die Kino-Player-Entity wurde nicht gefunden.";
      this._render();
      return;
    }
    // Until it really plays, the transition progress is the more useful
    // thing to look at than an empty playback sheet.
    this._callService("media_player", "play_media", {
      entity_id: player,
      media_content_id: itemId,
      media_content_type: "movie",
      extra: { resume: !fromStart },
    })
      .then(() => {
        this._view.playingOpen = true;
      })
      .catch((err) => {
        this._actionError = err.message || String(err);
      })
      .finally(() => {
        this._render();
        this._refreshState();
      });
  }

  _onChange(event) {
    const field = event.target.dataset.field;
    if (field === "sort") {
      // A direction chosen for one field must not silently invert another.
      this._view.sortDir = null;
      this._view.sort = event.target.value;
      this._render();
      this._loadLibrary();
    } else if (field === "year-from" || field === "year-to") {
      const value = event.target.value ? Number(event.target.value) : null;
      this._view.filters[field === "year-from" ? "yearFrom" : "yearTo"] = value;
      this._render();
    } else if (field === "entity-select") {
      this._callService("select", "select_option", {
        entity_id: event.target.dataset.key,
        option: event.target.value,
      });
    }
  }

  _onInput(event) {
    if (event.target.dataset.field !== "query") return;
    this._view.query = event.target.value;
    // Incremental results as the user types, without a request per keystroke.
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this._loadLibrary(), 250);
  }
}

if (typeof customElements !== "undefined" && !customElements.get("kino-card")) {
  customElements.define("kino-card", KinoCard);
}

if (typeof window !== "undefined") {
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "kino-card")) {
    window.customCards.push({
      type: "kino-card",
      name: "Kino",
      description:
        "Heimkino-Steuerung: Aktivitäten, Status, Bibliothek, Wiedergabe und Lautstärke.",
      preview: true,
    });
  }
  console.info(
    `%c KINO-CARD %c ${CARD_VERSION} `,
    "background:#c8952c;color:#111;font-weight:700",
    ""
  );
}

export { KinoCard };
