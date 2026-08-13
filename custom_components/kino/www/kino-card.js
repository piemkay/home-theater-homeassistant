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

const CARD_VERSION = "0.6.2";

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

  /** Grid/row title: an episode is recognised by its series, not by
   *  "Regen des Feuers" alone (F2). */
  itemTitle(item) {
    if (item && item.kind === "episode" && item.seriesName) return item.seriesName;
    return item ? item.title : "";
  },

  /** Grid/row meta: episodes carry their code and own title. */
  itemMeta(item) {
    if (item && item.kind === "episode" && item.episodeCode) {
      return [item.episodeCode, item.title].filter(Boolean).join(" · ");
    }
    return helpers.metaLine(item);
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
      (filters.people || []).length +
      (filters.audioLangs || []).length +
      (filters.subtitleLangs || []).length +
      (filters.minRating != null ? 1 : 0) +
      (filters.minCritic != null ? 1 : 0) +
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
      person_ids: (filters.people || []).map((p) => p.id),
      audio_langs: filters.audioLangs || [],
      subtitle_langs: filters.subtitleLangs || [],
      ratings: filters.ratings || [],
      min_rating: filters.minRating ?? null,
      min_critic: filters.minCritic ?? null,
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

  /**
   * Which filter groups are folded, given what the user has stored.
   *
   * Folded is the default for every group — eleven open ones is a page of
   * chips to scroll past before reaching the one you came for. What is
   * stored is only the deviations, so a group opened last night is open
   * again tonight and one never touched is still folded.
   */
  filterCollapse(stored) {
    const all = Object.fromEntries(FILTER_GROUPS.map((key) => [key, true]));
    return stored && typeof stored === "object" ? { ...all, ...stored } : all;
  },

  /** A pristine filter set — the single source of that shape. */
  emptyFilters() {
    return {
      tags: [],
      genres: [],
      countries: [],
      ratings: [],
      people: [],
      audioLangs: [],
      subtitleLangs: [],
      minRating: null,
      minCritic: null,
      yearFrom: null,
      yearTo: null,
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

  /** German display name for an ISO-639-2 audio-track code. */
  langLabel(code) {
    if (!code) return "—";
    const names = {
      ger: "Deutsch",
      eng: "Englisch",
      fre: "Französisch",
      ita: "Italienisch",
      spa: "Spanisch",
      jpn: "Japanisch",
      kor: "Koreanisch",
      chi: "Chinesisch",
      rus: "Russisch",
      por: "Portugiesisch",
      dut: "Niederländisch",
      pol: "Polnisch",
      swe: "Schwedisch",
      dan: "Dänisch",
      nor: "Norwegisch",
      fin: "Finnisch",
      cze: "Tschechisch",
      tur: "Türkisch",
      ara: "Arabisch",
      heb: "Hebräisch",
      hin: "Hindi",
      tha: "Thailändisch",
      hun: "Ungarisch",
      ukr: "Ukrainisch",
      vie: "Vietnamesisch",
      rum: "Rumänisch",
      gre: "Griechisch",
      ice: "Isländisch",
      per: "Persisch",
      cat: "Katalanisch",
      srp: "Serbisch",
      hrv: "Kroatisch",
      bul: "Bulgarisch",
      slo: "Slowakisch",
      slv: "Slowenisch",
      est: "Estnisch",
      lav: "Lettisch",
      lit: "Litauisch",
      ind: "Indonesisch",
      may: "Malaiisch",
      tam: "Tamil",
      tel: "Telugu",
      ben: "Bengalisch",
      urd: "Urdu",
      und: "Unbekannt",
      // The long tail the live library turned out to carry — an uppercased
      // "MKD" on a chip tells nobody anything.
      mac: "Mazedonisch",
      bos: "Bosnisch",
      alb: "Albanisch",
      baq: "Baskisch",
      glg: "Galicisch",
      cym: "Walisisch",
      wel: "Walisisch",
      gle: "Irisch",
      geo: "Georgisch",
      arm: "Armenisch",
      aze: "Aserbaidschanisch",
      kaz: "Kasachisch",
      kir: "Kirgisisch",
      mon: "Mongolisch",
      khm: "Khmer",
      bur: "Birmanisch",
      lao: "Laotisch",
      nep: "Nepalesisch",
      sin: "Singhalesisch",
      mal: "Malayalam",
      kan: "Kannada",
      mar: "Marathi",
      pan: "Panjabi",
      guj: "Gujarati",
      tgl: "Tagalog",
      fil: "Filipino",
      swa: "Suaheli",
      afr: "Afrikaans",
      amh: "Amharisch",
      yid: "Jiddisch",
      lat: "Latein",
      haw: "Hawaiianisch",
      fur: "Friaulisch",
      div: "Dhivehi",
      enm: "Mittelenglisch",
      fao: "Färöisch",
      ltz: "Luxemburgisch",
      mlt: "Maltesisch",
      epo: "Esperanto",
      bre: "Bretonisch",
      tib: "Tibetisch",
      mao: "Maori",
      zxx: "Ohne Sprache",
    };
    return names[String(code).toLowerCase()] || String(code).toUpperCase();
  },

  /**
   * One audio or subtitle track, as a line a person can read.
   *
   * The language leads, because that is what anyone scanning the list is
   * looking for; the technical bits follow. A commentary says so — otherwise
   * three "Englisch" entries look like a mistake.
   */
  trackLabel(track) {
    if (!track) return "";
    const bits = [helpers.langLabel(track.language)];
    if (track.channelLayout) bits.push(track.channelLayout);
    if (track.codec) bits.push(track.codec);
    if (track.commentary) bits.push("Kommentar");
    if (track.forced) bits.push("erzwungen");
    return bits.join(" · ");
  },

  /**
   * Which tracks a person should see first: the default one, then the ways
   * to actually watch it, then the commentaries, then file order.
   *
   * The list is cut to its first few, so a commentary sitting at index 2
   * would otherwise spend one of those slots on something nobody picked.
   */
  sortTracks(tracks) {
    return (tracks || [])
      .slice()
      .sort(
        (a, b) =>
          Number(!!b.default) - Number(!!a.default) ||
          Number(!!a.commentary) - Number(!!b.commentary) ||
          a.index - b.index
      );
  },

  /**
   * Is this entry watched? A season or series counts as watched when nothing
   * below it is still unwatched — Jellyfin never sets `Played` on those.
   */
  isWatched(item) {
    if (!item) return false;
    if (item.kind === "season" || item.kind === "show") {
      return item.unplayedCount === 0;
    }
    return !!item.watched;
  },

  /** German label for the mark-watched control of one entry. */
  watchedLabel(item) {
    const kind = item && item.kind;
    const subject =
      kind === "season" ? "Staffel" : kind === "show" ? "Serie" : null;
    const done = helpers.isWatched(item);
    if (subject) {
      return done
        ? `${subject} als ungesehen markieren`
        : `${subject} als gesehen markieren`;
    }
    return done ? "Als ungesehen markieren" : "Als gesehen markieren";
  },

  /** "94 %" for a critics score, or null when there is none. */
  criticLabel(critic) {
    if (critic == null || Number.isNaN(Number(critic))) return null;
    return `${Math.round(Number(critic))} %`;
  },

  /** German label for a crew credit; actors show their character instead. */
  personRole(person) {
    if (!person) return "";
    const jobs = {
      Director: "Regie",
      Writer: "Drehbuch",
      Producer: "Produktion",
      Composer: "Musik",
      GuestStar: "Gastauftritt",
    };
    if (person.type === "Actor") return person.role || "";
    return jobs[person.type] || person.role || person.type || "";
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

  /**
   * Human display text for a raw processor/player option string (F8).
   *
   * The *value* sent to the entity stays raw — only what the person reads
   * changes: `none` → "—", `0: Off` → "Aus", `1: English Dolby TrueHD with
   * Dolby Atmos 48.0KHz` → "Englisch · TrueHD Atmos".
   */
  displayLabel(raw) {
    if (raw == null) return "—";
    const s = String(raw).trim();
    if (!s || s === "none" || s === "unknown") return "—";
    const stripped = s.replace(/^\d+\s*:\s*/, "");
    if (stripped !== s) return helpers.prettyTrack(stripped);
    return s;
  },

  /** One player track entry, index already stripped. */
  prettyTrack(label) {
    if (/^off$/i.test(label)) return "Aus";
    const languages = {
      english: "Englisch",
      german: "Deutsch",
      deutsch: "Deutsch",
      french: "Französisch",
      spanish: "Spanisch",
      italian: "Italienisch",
      japanese: "Japanisch",
      korean: "Koreanisch",
      chinese: "Chinesisch",
      mandarin: "Mandarin",
      cantonese: "Kantonesisch",
      russian: "Russisch",
      portuguese: "Portugiesisch",
      dutch: "Niederländisch",
      polish: "Polnisch",
      swedish: "Schwedisch",
      danish: "Dänisch",
      norwegian: "Norwegisch",
      finnish: "Finnisch",
      czech: "Tschechisch",
      turkish: "Türkisch",
      arabic: "Arabisch",
      hebrew: "Hebräisch",
      hindi: "Hindi",
      thai: "Thailändisch",
    };
    const words = label.split(/\s+/);
    const language = languages[(words[0] || "").toLowerCase()];
    let rest = (language ? words.slice(1) : words).join(" ");
    rest = rest
      .replace(/\b\d+(\.\d+)?\s*k?hz\b/gi, "")
      .replace(/\bdolby truehd\b/gi, "TrueHD")
      .replace(/\bdts-hd master audio\b/gi, "DTS-HD MA")
      .replace(/\bwith\s+dolby\s+atmos\b/gi, "Atmos")
      .replace(/\bdolby\s+atmos\b/gi, "Atmos")
      .replace(/\bforced\b/gi, "erzwungen")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (language && rest) return `${language} · ${rest}`;
    return language || rest || label;
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
.tile {
  padding: 14px 16px; border-radius: 14px; text-align: left; font-size: 13px; min-height: 48px;
  display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
}
.tile .tileicon { color: var(--kino-text3); --mdc-icon-size: 20px; }
.tile[aria-pressed="true"] { background: var(--kino-gold); color: var(--kino-goldText); }
.tile[aria-pressed="true"] .tileicon { color: var(--kino-goldText); }
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
/* A column flexbox compresses its children once the content is taller than
   the sheet (any phone): every row shrinks and clips instead of scrolling. */
.sheet > * { flex-shrink: 0; }
.chipwrap { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
.backdrop { position: relative; width: 100%; aspect-ratio: 16/9; border-radius: 14px; overflow: hidden; background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 10px, var(--kino-surface) 10px, var(--kino-surface) 20px); }
.backdrop img { width: 100%; height: 100%; object-fit: cover; display: block; }
.dialog { position: absolute; inset: 0; z-index: 40; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; padding: 28px; box-sizing: border-box; }
.dialog > div { width: 100%; max-width: 420px; background: var(--kino-surface); border: 1px solid var(--kino-border); border-radius: 18px; padding: 22px; }

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

/* Detail sheet: community star and critics tomato in one row. */
.scorerow { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.score { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--kino-text2); }
/* The same badge inside a tile's meta line, where it rides with the text. */
.score.tiny { gap: 3px; font-size: inherit; font-weight: inherit; color: inherit; vertical-align: -1px; }

/* Cast & crew: round portraits that scroll sideways, like Jellyfin's row. */
.personrow { display: flex; gap: 12px; overflow-x: auto; padding: 4px 0 6px; }
.person { flex: 0 0 84px; min-width: 0; cursor: pointer; text-align: center; border: none; background: transparent; color: var(--kino-text); padding: 0; font-family: inherit; }
.personart { position: relative; width: 72px; height: 72px; border-radius: 50%; margin: 0 auto; overflow: hidden; background: var(--kino-surface2); display: flex; align-items: center; justify-content: center; }
.personart img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
.personart .initials { font-size: 20px; font-weight: 800; color: var(--kino-text3); }
.person .name { font-size: 11px; font-weight: 700; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.person .role { font-size: 10px; color: var(--kino-text3); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Filter sheet: collapsible groups with a live count on every chip. */
.grouphead {
  width: 100%; display: flex; align-items: center; gap: 8px; border: none;
  background: transparent; color: var(--kino-text); cursor: pointer;
  padding: 10px 0; margin: 0; font-family: inherit; text-align: left;
}
.grouphead .label { margin: 0; flex: 1; }
.groupbadge {
  min-width: 18px; height: 18px; border-radius: 9px; padding: 0 5px;
  background: var(--kino-gold); color: var(--kino-goldText);
  font-size: 10px; font-weight: 800; display: flex; align-items: center;
  justify-content: center; box-sizing: border-box;
}
.groupbadge:empty { display: none; }
.grouphead .chev { color: var(--kino-text3); font-size: 11px; transition: transform .15s ease; }
.grouphead[aria-expanded="false"] .chev { transform: rotate(-90deg); }
.chipcount { font-weight: 600; opacity: .65; font-size: 11px; }
.chipcount:empty { display: none; }
.pill.emptying { opacity: .4; }

/* Cast & crew filter: a search field with its suggestions right under it. */
.personsearch { position: relative; margin-bottom: 12px; }
.personhits {
  list-style: none; margin: 6px 0 0; padding: 0;
  border: 1px solid var(--kino-border); border-radius: 12px;
  background: var(--kino-surface); overflow: hidden;
}
.personhits:empty { display: none; border: none; }
.personhits li + li { border-top: 1px solid var(--kino-border); }
.personhits button {
  width: 100%; display: flex; align-items: center; gap: 10px;
  padding: 9px 12px; border: none; background: transparent; cursor: pointer;
  color: var(--kino-text); font: inherit; font-size: 13px; text-align: left;
}
.personhits button:hover { background: var(--kino-surface2); }
.personhits .hitart {
  width: 26px; height: 26px; border-radius: 13px; flex-shrink: 0;
  background: var(--kino-surface2); overflow: hidden; position: relative;
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 800; color: var(--kino-text3);
}
.personhits .hitart img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.searchnote { font-size: 11px; color: var(--kino-text3); margin: 6px 0 0; }

/* Detail sheet: the tracks a file actually carries. */
.tracklist { list-style: none; margin: 6px 0 0; padding: 0; }
.tracklist li {
  display: flex; align-items: center; gap: 8px; padding: 5px 0;
  font-size: 12px; color: var(--kino-text2);
}
.tracklist li + li { border-top: 1px solid var(--kino-border); }
.tracklist .std { color: var(--kino-gold); font-size: 10px; font-weight: 800; }
.trackcol { flex: 1; min-width: 0; }
.trackcol h4 {
  margin: 0; font-size: 11px; font-weight: 800; letter-spacing: .04em;
  text-transform: uppercase; color: var(--kino-text3);
}
.trackcols { display: flex; gap: 20px; flex-wrap: wrap; }
.trackmore {
  border: none; background: transparent; padding: 6px 0 0; margin: 0;
  font-family: inherit; font-size: 12px; cursor: pointer;
}

/* The CTA stays reachable however long the sheet grows. */
.filtercta {
  position: sticky; bottom: -24px; z-index: 2;
  margin: 14px -20px -24px; padding: 12px 20px 20px;
  background: linear-gradient(0deg, var(--kino-bg) 78%, transparent);
}

/* Detail sheet: synopsis and episode list (F2, F3). */
.overview { font-size: 13px; color: var(--kino-text2); line-height: 1.55; margin: 0; }
.overview.clamped {
  display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4;
  -webkit-box-orient: vertical; overflow: hidden; cursor: pointer;
}
.eprow { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--kino-border); cursor: pointer; }
.eprow .epthumb { width: 128px; flex-shrink: 0; border-radius: 8px; }
.eprow .title { font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eprow .meta { font-size: 11px; color: var(--kino-text3); margin-top: 2px; }
.eprow .seen { color: var(--kino-teal); font-weight: 800; font-size: 13px; }

.empty { text-align: center; padding: 40px 12px; color: var(--kino-text2); }
.empty .sub { font-size: 12px; color: var(--kino-text3); margin-top: 6px; }
.error { color: var(--kino-red); font-size: 13px; }

/* The sort select fills the toolbar row on a phone… */
.sortsel { flex: 1; min-width: 0; }

/* Detail sheet: one column with a backdrop on a phone; the poster column
   only exists on a wide screen (F10). */
.detail-poster { display: none; }

/* Desktop scrim behind a centered sheet — phone keeps the full-bleed sheet. */
.scrim { display: none; }

/* Tile sizes: on a phone, "Klein" fits a third poster column. */
.postergrid.size-s { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.postergrid.size-s .poster .title { font-size: 11px; }
.postergrid.size-s .poster .meta { font-size: 10px; }
.thumbgrid.size-s { gap: 10px; }

/* Tablet: the same card, denser (FR-71). */
@media (min-width: 640px) {
  .tilegrid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .postergrid.size-s { grid-template-columns: repeat(auto-fill, minmax(105px, 1fr)); }
  .postergrid.size-l { grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); }
  .thumbgrid.size-s { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .thumbgrid.size-l { grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
  .body { padding: 0 24px 24px; }
  /* …and shrinks to its content once there is room (F10). */
  .sortsel { flex: 0 1 auto; width: auto; }
}
/* Desktop: no control wider than 720px unless it is a grid (F10). Sheets
   become centered panels over a dimmed scrim instead of full-bleed pages. */
@media (min-width: 760px) {
  .maxcol { max-width: 720px; margin-inline: auto; }
  .scrim { display: block; position: absolute; inset: 0; background: rgba(0,0,0,.55); z-index: 24; }
  .sheet {
    top: 20px; bottom: 20px; left: 0; right: 0;
    width: 720px; max-width: calc(100% - 48px); margin-inline: auto;
    border: 1px solid var(--kino-border); border-radius: 18px;
    box-shadow: 0 24px 80px rgba(0,0,0,.55);
  }
}
@media (min-width: 900px) {
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .postergrid.size-s { grid-template-columns: repeat(auto-fill, minmax(115px, 1fr)); }
  .postergrid.size-l { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .thumbgrid.size-s { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .thumbgrid.size-l { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  /* Detail sheet: poster left, text right (F10). */
  .detailcols { display: flex; gap: 20px; align-items: flex-start; }
  .detail-poster { display: block; flex: 0 0 200px; }
  .detailmain { flex: 1; min-width: 0; }
  .detail-backdrop { display: none; }
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

const CHECK_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9" stroke-width="1.6"></circle><path d="M8 12.4l2.6 2.6L16 9.5"></path></svg>`;

const VIEW_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
  <rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="3" width="8" height="8" rx="1.5"></rect>
  <rect x="3" y="13" width="8" height="8" rx="1.5"></rect><rect x="13" y="13" width="8" height="8" rx="1.5"></rect></svg>`;

// Rotten Tomatoes: the red tomato from 60 % up, the green splat below.
const TOMATO_FRESH_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="14" r="9" fill="#fa320a"></circle>
  <path d="M12 2c-2 .3-3.6 1.4-4.4 2.9 1.5-.2 3 .2 4.4 1 1.4-.8 2.9-1.2 4.4-1C15.6 3.4 14 2.3 12 2z" fill="#0ac855"></path></svg>`;
const TOMATO_ROTTEN_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="#0ac855" d="M12 3l1.8 3.6 3.9-1.9-.9 3.9 4.7 1-3.7 2.7 2.8 3.9-4.7-1 .1 4.8-3-3.1-3 3.1.1-4.8-4.7 1 2.8-3.9L4.5 9.6l4.7-1-.9-3.9 3.9 1.9L12 3z"></path></svg>`;

// The same two at grid size, where they sit inside an 11px meta line.
const TOMATO_FRESH_SMALL = TOMATO_FRESH_ICON.replace(/width="13" height="13"/, 'width="10" height="10"');
const TOMATO_ROTTEN_SMALL = TOMATO_ROTTEN_ICON.replace(/width="13" height="13"/, 'width="10" height="10"');

/** The critics badge for one item, or "" when no score is on file. */
function criticBadge(item, compact = false) {
  const label = helpers.criticLabel(item && item.criticRating);
  if (!label) return "";
  const fresh = item.criticRating >= 60;
  const icon = compact
    ? fresh
      ? TOMATO_FRESH_SMALL
      : TOMATO_ROTTEN_SMALL
    : fresh
      ? TOMATO_FRESH_ICON
      : TOMATO_ROTTEN_ICON;
  return `<span class="score${compact ? " tiny" : ""}" title="Kritikerwertung (Rotten Tomatoes)">${icon}${label}</span>`;
}

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

// Chip label -> the flag name `kino/library/facet_counts` keys its tag counts by.
const TAG_FLAGS = {
  "4K": "only_4k",
  HD: "only_hd",
  SD: "only_sd",
  "3D": "only_3d",
  Weitersehen: "only_resumable",
  "Nicht gesehen": "only_unwatched",
  Gesehen: "only_watched",
  Favoriten: "only_favorites",
};

// Minimum-rating chips: community is 0–10, critics 0–100 (Rotten Tomatoes).
const MIN_RATING_STEPS = [6, 7, 8, 9];
const MIN_CRITIC_STEPS = [60, 70, 80, 90];

// Jellyfin's six grid layouts, with Jellyfin's own German labels.
const VIEW_MODES = [
  ["poster", "Poster"],
  ["posterCard", "Posterkarte"],
  ["thumb", "Vorschau"],
  ["thumbCard", "Vorschaukarte"],
  ["banner", "Banner"],
  ["list", "Liste"],
];

// How many chips a facet group shows before it offers "+ N weitere". Sized
// so the common values fit on a phone screen without a scroll of their own.
const FACET_CHIP_LIMIT = 14;

// How many audio or subtitle tracks the detail sheet shows before it offers
// the rest. Enough to answer "is it there", short enough that a 21-track
// remux does not bury the cast row underneath it.
const TRACK_PREVIEW = 3;

// The filter sheet's groups, in the order they are rendered.
const FILTER_GROUPS = [
  "tags",
  "genres",
  "people",
  "ratings",
  "langs",
  "sublangs",
  "score",
  "countries",
  "year",
  "sort",
  "view",
];

const VIEW_MODE_STORAGE_KEY = "kino-card-view-mode";
const GRID_SIZE_STORAGE_KEY = "kino-card-grid-size";
const FILTER_COLLAPSE_STORAGE_KEY = "kino-card-filter-collapsed";

// Tile sizes for the poster/thumb walls: "Mittel" is the classic
// look, "Klein" fits one more column on a phone, "Groß" spreads out.
const GRID_SIZES = [
  ["s", "Klein"],
  ["m", "Mittel"],
  ["l", "Groß"],
];

/** localStorage is absent under the test runner and may be blocked in kiosks. */
function readStored(key, fallback, valid = null) {
  try {
    const stored = localStorage.getItem(key);
    if (stored == null) return fallback;
    return valid && !valid(stored) ? fallback : stored;
  } catch (err) {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    /* best effort — the setting still applies for this session */
  }
}

function readStoredViewMode() {
  return readStored(VIEW_MODE_STORAGE_KEY, "poster", (v) =>
    VIEW_MODES.some(([key]) => key === v)
  );
}

function readStoredGridSize() {
  return readStored(GRID_SIZE_STORAGE_KEY, "m", (v) =>
    GRID_SIZES.some(([key]) => key === v)
  );
}

/** Which filter groups the user keeps folded, remembered across sessions. */
function readStoredCollapse() {
  try {
    return helpers.filterCollapse(
      JSON.parse(readStored(FILTER_COLLAPSE_STORAGE_KEY, "{}"))
    );
  } catch (err) {
    return helpers.filterCollapse(null);
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
      gridSize: readStoredGridSize(),
      // Which facet groups have been asked to show their whole list.
      facetsExpanded: {},
      filters: helpers.emptyFilters(),
      filterSheet: false,
      filterCollapsed: readStoredCollapse(),
      personQuery: "",
      detailId: null,
      detail: null,
      seasons: null,
      seasonId: null,
      episodes: null,
      similar: null,
      overviewOpen: false,
      // Which track column has been asked to show its whole list.
      tracksExpanded: {},
      playingOpen: false,
      powerConfirm: false,
      activityMenu: false,
      musikSource: "spotify",
      refreshing: false,
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
    this._favorites = [];
    this._homeRowsAt = 0;
    this._facets = {
      genres: [],
      countries: [],
      ratings: [],
      audioLanguages: [],
      subtitleLanguages: [],
      yearMin: null,
      yearMax: null,
    };
    this._searchTimer = null;
    // Cast-and-crew suggestions for the filter sheet, and the pending lookup.
    this._personHits = null;
    this._personTimer = null;
    // The filter sheet's CTA count, kept live while filters change (F4).
    this._filterPreview = null;
    this._previewTimer = null;
    // Per-value result counts for the filter sheet's chips.
    this._facetCounts = null;
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
      controls.dim,
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
    if (this._previewTimer) clearTimeout(this._previewTimer);
    if (this._personTimer) clearTimeout(this._personTimer);
  }

  /**
   * Refresh the filter sheet's CTA count and the per-chip counts (F4).
   *
   * The results are written into the open sheet's DOM directly — a full
   * re-render here used to land mid-scroll, replace the markup under the
   * finger and snap the sheet back to its recorded position.
   */
  _previewFilterCount() {
    if (!this._view.filterSheet) return;
    if (this._previewTimer) clearTimeout(this._previewTimer);
    this._previewTimer = setTimeout(async () => {
      const message = helpers.queryFromFilters(
        this._view.filters,
        this._view.category,
        this._view.query,
        this._view.sort,
        0,
        1,
        this._view.sortDir
      );
      const [page, counts] = await Promise.all([
        this._ws(message).catch(() => null),
        this._ws({ ...message, type: "kino/library/facet_counts" }).catch(() => null),
      ]);
      this._filterPreview = page ? page.total : null;
      if (counts) this._facetCounts = counts;
      if (this._view.filterSheet) this._patchFilterSheet();
    }, 250);
  }

  /** The count one chip should wear, or null while nothing is known yet. */
  _facetCount(kind, key) {
    const counts = this._facetCounts;
    if (!counts) return null;
    const group = {
      tag: counts.tags,
      genre: counts.genres,
      rating: counts.ratings,
      lang: counts.audioLangs,
      sublang: counts.subtitleLangs,
    }[kind];
    if (!group) return null;
    const value = group[kind === "tag" ? TAG_FLAGS[key] : key];
    // A value the scan never saw (a series-only genre while browsing films)
    // would match nothing — that is a real zero, not an unknown.
    return typeof value === "number" ? value : 0;
  }

  /**
   * Write the fresh preview into the open filter sheet without rebuilding it.
   *
   * Chip counts, dimming of chips that would empty the grid, the group
   * headers' active badges and the CTA label all update in place, so an
   * ongoing scroll is never interrupted.
   */
  _patchFilterSheet() {
    const sheet =
      this._container &&
      this._container.querySelector('.sheet[data-sheet="filter"]');
    if (!sheet) return;
    for (const chip of sheet.querySelectorAll("[data-count-kind]")) {
      const count = this._facetCount(chip.dataset.countKind, chip.dataset.key);
      const span = chip.querySelector(".chipcount");
      if (span) span.textContent = count == null ? "" : count;
      chip.classList.toggle(
        "emptying",
        count === 0 && chip.getAttribute("aria-pressed") !== "true"
      );
    }
    const cta = sheet.querySelector("[data-role='filter-cta']");
    if (cta) {
      cta.textContent = `${this._filterPreview ?? this._library.total} Titel anzeigen`;
    }
    for (const head of sheet.querySelectorAll("[data-group]")) {
      const badge = head.querySelector(".groupbadge");
      if (badge) {
        const active = this._activeInGroup(head.dataset.group);
        badge.textContent = active ? String(active) : "";
      }
    }
  }

  /** How many selections one filter group currently holds. */
  _activeInGroup(group) {
    const f = this._view.filters;
    switch (group) {
      case "tags":
        return f.tags.length;
      case "genres":
        return f.genres.length;
      case "ratings":
        return (f.ratings || []).length;
      case "people":
        return (f.people || []).length;
      case "langs":
        return (f.audioLangs || []).length;
      case "sublangs":
        return (f.subtitleLangs || []).length;
      case "countries":
        return (f.countries || []).length;
      case "score":
        return (f.minRating != null ? 1 : 0) + (f.minCritic != null ? 1 : 0);
      case "year":
        return f.yearFrom != null || f.yearTo != null ? 1 : 0;
      default:
        return 0;
    }
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
      this._facets = {
        genres: [],
        countries: [],
        ratings: [],
        audioLanguages: [],
        subtitleLanguages: [],
        yearMin: null,
        yearMax: null,
      };
    }
  }

  /**
   * Look up cast and crew for the filter sheet's name field.
   *
   * The hits are written straight into the open sheet — a re-render would
   * rebuild the input under the caret and lose the rest of the word.
   */
  _searchPeople() {
    if (this._personTimer) clearTimeout(this._personTimer);
    const query = this._view.personQuery.trim();
    if (query.length < 2) {
      this._personHits = null;
      this._patchPersonSearch();
      return;
    }
    this._personTimer = setTimeout(async () => {
      let hits;
      try {
        const result = await this._ws({
          type: "kino/library/persons",
          query,
          limit: 12,
        });
        hits = result.items || [];
      } catch (err) {
        hits = [];
      }
      // The person may have typed on, or closed the sheet entirely.
      if (this._view.personQuery.trim() !== query) return;
      this._personHits = hits;
      this._patchPersonSearch();
    }, 250);
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
    // The capture listener hears every scroll in the card — including an
    // open sheet's. Paging in more titles mid-scroll there rebuilt the DOM
    // under the finger: the filter sheet stuttered and snapped back.
    if (!el.classList || !el.classList.contains("scroller")) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) {
      this._loadLibrary(true);
    }
  }

  /** Load the season strip of one series, then its most relevant season (F2). */
  async _loadSeasons(seriesId) {
    try {
      const result = await this._ws({
        type: "kino/library/seasons",
        series_id: seriesId,
      });
      this._view.seasons = result.items || [];
      // Start where the person left off: the first season that still has
      // something unwatched, otherwise the first season.
      const active =
        this._view.seasons.find((s) => s.unplayedCount) || this._view.seasons[0];
      this._view.seasonId = active ? active.id : null;
    } catch (err) {
      this._view.seasons = [];
      this._actionError = err.message;
    }
    this._render();
    if (this._view.seasonId) await this._loadEpisodes();
  }

  async _loadEpisodes() {
    const seriesId = this._view.detailId;
    this._view.episodes = null;
    this._render();
    try {
      const result = await this._ws({
        type: "kino/library/episodes",
        series_id: seriesId,
        season_id: this._view.seasonId,
      });
      this._view.episodes = result.items || [];
    } catch (err) {
      this._view.episodes = [];
      this._actionError = err.message;
    }
    this._render();
  }

  /** Fetch the detail sheet's "Mehr wie dieser Titel" row. */
  async _loadSimilar(itemId) {
    try {
      const result = await this._ws({
        type: "kino/library/similar",
        item_id: itemId,
        limit: 12,
      });
      // The person may already be two sheets further — only the still-open
      // detail gets the row.
      if (this._view.detailId !== itemId) return;
      this._view.similar = result.items || [];
    } catch (err) {
      this._view.similar = [];
    }
    this._render();
  }

  /** Forget everything the open detail sheet loaded. */
  _closeDetail() {
    const view = this._view;
    view.detailId = null;
    view.detail = null;
    view.seasons = null;
    view.seasonId = null;
    view.episodes = null;
    view.similar = null;
    view.tracksExpanded = {};
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

  /** The favourites row: films and series together, newest first. */
  async _loadFavorites() {
    try {
      const page = await this._ws({
        type: "kino/library/search",
        category: "favorites",
        limit: 12,
        offset: 0,
      });
      this._favorites = page.items || [];
    } catch (err) {
      this._favorites = [];
    }
    this._render();
  }

  /**
   * Fetch the home rows (Weitersehen, Zuletzt hinzugefügt, Favoriten —
   * FR-70) at most once a minute. Called from render, so the timestamp guard
   * is what keeps the fetch → render → fetch loop from spinning.
   */
  _ensureHomeRows() {
    if (Date.now() - this._homeRowsAt < 60000) return;
    this._homeRowsAt = Date.now();
    this._loadResume();
    this._loadRecent();
    this._loadFavorites();
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

  /** Every copy of one entry the card is currently holding. */
  _findItem(itemId) {
    const lists = [
      this._view.detail ? [this._view.detail] : [],
      this._library.items,
      this._resume,
      this._recent,
      this._favorites,
      this._view.episodes || [],
      this._view.seasons || [],
      this._view.similar || [],
    ];
    for (const list of lists) {
      const found = list.find((i) => i && i.id === itemId);
      if (found) return found;
    }
    return null;
  }

  /** Write one change into every copy of an entry the card is holding. */
  _patchItem(itemId, patch) {
    const flip = (it) => (it && it.id === itemId ? { ...it, ...patch } : it);
    if (this._view.detail && this._view.detail.id === itemId) {
      this._view.detail = { ...this._view.detail, ...patch };
    }
    this._library.items = this._library.items.map(flip);
    this._resume = this._resume.map(flip);
    this._recent = this._recent.map(flip);
    this._favorites = this._favorites.map(flip);
    if (this._view.episodes) this._view.episodes = this._view.episodes.map(flip);
    if (this._view.seasons) this._view.seasons = this._view.seasons.map(flip);
    if (this._view.similar) this._view.similar = this._view.similar.map(flip);
  }

  /**
   * Flip a favourite optimistically in every copy of the item the card
   * holds, then write it back to the catalogue; on failure, flip back.
   */
  async _toggleFavorite(itemId) {
    const current = !!(this._findItem(itemId) || {}).favorite;
    const apply = (favorite) => {
      this._patchItem(itemId, { favorite });
      this._render();
    };
    apply(!current);
    try {
      await this._ws({
        type: "kino/library/favorite",
        item_id: itemId,
        favorite: !current,
      });
      // The Favoriten row is a query result, not a flag — rebuild it so a
      // title just added appears there and one just removed leaves.
      this._loadFavorites();
    } catch (err) {
      apply(current);
      this._actionError = err.message;
      this._render();
    }
  }

  /**
   * Mark one film, episode, season or series as watched — or undo that.
   *
   * Optimistic like the heart, but a season cascades down in Jellyfin, so
   * anything below the toggled entry is re-read rather than guessed at.
   */
  async _toggleWatched(itemId) {
    const item = this._findItem(itemId);
    if (!item) return;
    const current = helpers.isWatched(item);
    const cascades = item.kind === "season" || item.kind === "show";
    const apply = (watched) => {
      const patch = { watched };
      // Season and series rows show a "still to watch" count, not a tick.
      if (item.unplayedCount != null) {
        patch.unplayedCount = watched ? 0 : item.unplayedCount || 1;
      }
      if (watched) patch.continueWatching = null;
      this._patchItem(itemId, patch);
      this._render();
    };
    apply(!current);
    try {
      await this._ws({
        type: "kino/library/watched",
        item_id: itemId,
        watched: !current,
      });
    } catch (err) {
      apply(current);
      this._actionError = err.message;
      this._render();
      return;
    }
    // An episode changes its season's count; a season changes its episodes.
    if (cascades && this._view.seasonId) {
      await this._loadEpisodes();
    }
    if (this._view.detailId && (cascades || item.kind === "episode")) {
      await this._reloadSeasons();
    }
  }

  /** Refresh the season strip's watched counts, keeping the open season. */
  async _reloadSeasons() {
    if (!this._view.seasons) return;
    try {
      const result = await this._ws({
        type: "kino/library/seasons",
        series_id: this._view.detailId,
      });
      this._view.seasons = result.items || [];
    } catch (err) {
      /* the strip keeps the counts it had */
    }
    this._render();
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
   * The processor's own Dim: the Trinnov drops its output by 20 dB and
   * brings it back. An audio feature — the lights are not involved. The
   * switch entity arrives via `controls.dim`, so the button disappears
   * when the processor has no dim switch wired.
   */
  async _toggleDim() {
    const entityId = (this._kino.controls || {}).dim;
    if (!entityId) return;
    const state = this._hass.states[entityId];
    const service = state && state.state === "on" ? "turn_off" : "turn_on";
    try {
      await this._callService("switch", service, { entity_id: entityId });
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
    // Sheets are rebuilt from scratch on every render. Without carrying the
    // scroll position over and suppressing the slide-in replay, every chip
    // tap makes an open sheet visibly "close and reopen".
    const openSheets = {};
    this._container.querySelectorAll(".sheet[data-sheet]").forEach((el) => {
      openSheets[el.dataset.sheet] = el.scrollTop;
    });
    // Re-rendering the whole card would otherwise drop the caret out of the
    // search box mid-word.
    const focused = this.shadowRoot.activeElement;
    const focusField = focused && focused.dataset ? focused.dataset.field : null;
    const caret = focused && focused.selectionStart != null ? focused.selectionStart : null;
    const sheetOpen =
      this._view.detailId || this._view.playingOpen || this._view.filterSheet;
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
      // On a desktop the sheets are centered panels; the scrim dims the card
      // behind them (F10). On a phone it stays hidden.
      sheetOpen ? '<div class="scrim"></div>' : "",
      this._view.detailId ? this._renderDetailSheet() : "",
      this._view.playingOpen ? this._renderPlayingSheet() : "",
      this._view.filterSheet ? this._renderFilterSheet() : "",
      this._view.powerConfirm ? this._renderPowerConfirm() : "",
    ].join("");
    this._signature = this._renderSignature();
    const scroller = this._container.querySelector(".scroller");
    if (scroller) scroller.scrollTop = scrollTop;
    this._container.querySelectorAll(".sheet[data-sheet]").forEach((el) => {
      const previous = openSheets[el.dataset.sheet];
      if (previous !== undefined) {
        // Was already open before this render: no entry animation, same spot.
        el.style.animation = "none";
        el.scrollTop = previous;
      }
    });
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
    // The configured mdi icons finally render (F16); two lines give the
    // tiles some presence on a wide screen without changing the phone.
    const tiles = k.activities
      .filter((a) => a.key !== k.offActivity)
      .map(
        (a) => `<button class="tile" data-act="activate" data-key="${a.key}"
          aria-pressed="${current && current.key === a.key}">
          ${a.icon ? `<ha-icon class="tileicon" icon="${this._esc(a.icon)}"></ha-icon>` : ""}
          <span>${this._esc(a.name)}</span>
        </button>`
      )
      .join("");
    const compact = !isOff
      ? `<button class="chipbtn" data-act="toggle-menu">
           <span>${this._esc(
             k.progress && k.targetActivity === k.offActivity
               ? "Wird ausgeschaltet…"
               : k.progress && current
                 ? `Wechsel zu ${current.name}…`
                 : current
                   ? current.name
                   : "—"
           )}</span>
           <span style="font-size:10px;color:var(--kino-text3)">${this._view.activityMenu ? "▴" : "▾"}</span>
         </button>`
      : "";
    return `<div class="maxcol" style="padding:0 20px 12px">
      ${compact}
      ${showGrid ? `<div class="tilegrid" style="margin-top:${compact ? 10 : 0}px">${tiles}</div>` : ""}
    </div>`;
  }

  _renderDeviceChips() {
    const k = this._kino;
    // During a transition the chips list every device the plan touches —
    // stops included, so `film → netflix` shows the Zidoo going down (F6).
    // The union arrives with the progress payload; outside a transition the
    // active activity's devices are the list.
    const progressDevices =
      k.progress && Array.isArray(k.progress.devices) && k.progress.devices.length
        ? k.progress.devices
        : null;
    // While shutting down, the target ("Aus") has no devices — but the ones
    // being stopped are exactly what the user wants to watch, chip by chip,
    // as each confirms it is off.
    const current =
      k.progress && k.targetActivity === k.offActivity
        ? this._activityByKey(k.activity)
        : this._currentActivity;
    const keys = progressDevices || (current ? current.devices : []);
    if (!keys.length) return "";
    const byKey = Object.fromEntries(k.devices.map((d) => [d.key, d]));
    const chips = keys
      .map((key) => {
        const device = byKey[key] || { name: key, health: "unknown" };
        const pulsing = device.health === "starting" || device.health === "stopping";
        return `<div class="devicechip">
          <span class="dot${pulsing ? " pulsing" : ""}" style="width:7px;height:7px;background:${helpers.deviceColor(device.health)}"></span>
          <span>${this._esc(device.name)}</span>
        </div>`;
      })
      .join("");
    return `<div class="devicechips maxcol" style="padding:0 20px">${chips}</div>`;
  }

  _renderActionError() {
    if (!this._actionError) return "";
    return `<div class="maxcol" style="padding:0 20px"><div class="banner">
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
    return `<div class="maxcol" style="padding:0 20px"><div class="banner">
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
    const pending = this._renderPendingItem();
    if (!p) {
      // Between the transition finishing and playback starting there is no
      // progress, but the queued title must not vanish in that gap (F5).
      return pending
        ? `<div class="maxcol" style="padding:0 20px"><div class="progress">${pending}</div></div>`
        : "";
    }
    const current = this._currentActivity;
    const toOff = this._kino.targetActivity === this._kino.offActivity;
    return `<div class="maxcol" style="padding:0 20px"><div class="progress">
      <div class="head">
        <b>${this._esc(toOff ? "Kino wird ausgeschaltet" : `Wechsel zu ${current ? current.name : "…"}`)}</b>
        <span>${this._esc(helpers.formatEta(p.etaSeconds))}</span>
      </div>
      <div class="bar"><div style="width:${p.percent}%"></div></div>
      <span class="hint">${this._esc(p.bottleneck || "Geräte werden vorbereitet…")}</span>
      ${pending}
    </div></div>`;
  }

  /** The film that will play once the room is ready (F5). */
  _renderPendingItem() {
    const pending = this._kino.pendingItem;
    if (!pending || !pending.title) return "";
    const art = pending.id
      ? helpers.artworkUrl(pending.id, "Primary", this._kino.artworkSignature)
      : null;
    return `<div class="footrow" style="margin-top:12px">
      <div class="footthumb">
        ${art ? `<img src="${art}" alt="" onerror="this.style.display='none'">` : ""}
      </div>
      <div style="flex:1;min-width:0;font-size:12px;color:var(--kino-text2)">
        <b style="color:var(--kino-text)">${this._esc(pending.title)}</b> startet gleich…
      </div>
    </div>`;
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
        return `<div class="maxcol">
          <div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
                      background:var(--kino-surface);border:1px solid var(--kino-border);margin-bottom:16px">
            <span style="color:var(--kino-text3);display:flex">${POWER_ICON}</span>
            <div>
              <div style="font-size:13px;font-weight:700">Kino ist ausgeschaltet</div>
              <div style="font-size:11px;color:var(--kino-text3)">Aktivität oben wählen, um zu starten — die Bibliothek ist trotzdem verfügbar.</div>
            </div>
          </div>
          ${this._renderLibraryHome()}
        </div>`;
      case "library":
        this._ensureHomeRows();
        return `<div class="maxcol">${this._renderLibraryHome()}</div>`;
      case "musik":
        return `<div class="maxcol">${this._renderMusik()}</div>`;
      default:
        // A proper card with icon and text instead of one floating line in
        // an otherwise empty viewport (F10).
        return `<div class="maxcol" style="display:flex;align-items:center;gap:14px;padding:16px;border-radius:14px;
                    background:var(--kino-surface);border:1px solid var(--kino-border);box-sizing:border-box">
          <ha-icon icon="${this._esc(current.icon || "mdi:remote-tv")}"
            style="color:var(--kino-gold);flex-shrink:0;--mdc-icon-size:26px"></ha-icon>
          <p style="font-size:13px;color:var(--kino-text2)">${this._esc(
            current.handoffText || "Weiter auf der Fernbedienung des Geräts."
          )}</p>
        </div>`;
    }
  }

  /** One home row, or nothing at all when the row would be empty. */
  _homeRow(title, items, showResume, extra = "") {
    if (!items || !items.length) return "";
    return `<div class="section">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <h3 style="margin:0">${title}</h3>
        ${extra}
      </div>
      <div class="posterrow hscroll">${items
        .map((t) => this._poster(t, showResume))
        .join("")}</div>
    </div>`;
  }

  _renderLibraryHome() {
    const resumeRow = this._homeRow("Weitersehen", this._resume, true);
    const recentRow = this._homeRow("Zuletzt hinzugefügt", this._recent, false);
    // Favourites are a filter, so this row can hand the whole list over to
    // the library rather than stopping at the twelve that fit.
    const favoriteRow = this._homeRow(
      "Favoriten",
      this._favorites,
      true,
      '<a class="link" data-act="open-favorites">Alle anzeigen</a>'
    );
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
      ${favoriteRow}
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

  /**
   * The meta line under a tile: `2016 · 106 Min · ★7.2 · 🍅84 %`.
   *
   * The critics score belongs on the wall, not only in the detail sheet —
   * a community 7.2 and a critics 40 % are two different evenings, and the
   * point of a grid is to choose without opening anything.
   */
  _metaLine(item) {
    const text = helpers.itemMeta(item);
    const critic = criticBadge(item, true);
    if (!text && !critic) return '<div class="meta"></div>';
    return `<div class="meta">${this._esc(text)}${critic ? ` ${critic}` : ""}</div>`;
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
      <div class="title">${this._esc(helpers.itemTitle(item))}</div>
      ${this._metaLine(item)}
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
          <div class="title">${this._esc(helpers.itemTitle(item))}</div>
          ${this._metaLine(item)}
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
      <div class="title">${this._esc(helpers.itemTitle(item))}</div>
      ${this._metaLine(item)}
    </div>`;
  }

  _renderItems(items) {
    const mode = this._view.viewMode;
    const size = ` size-${this._view.gridSize || "m"}`;
    const tiles = items.map((t) => this._tile(t, mode)).join("");
    if (mode === "list") return `<div class="listrows">${tiles}</div>`;
    if (mode === "banner") return `<div class="bannerlist">${tiles}</div>`;
    if (mode === "thumb" || mode === "thumbCard")
      return `<div class="thumbgrid${size}">${tiles}</div>`;
    return `<div class="postergrid${size}">${tiles}</div>`;
  }

  _renderLibrary() {
    const lib = this._library;
    const filters = this._view.filters;
    const count = helpers.activeFilterCount(filters);
    const yearLabel = helpers.yearRangeLabel(filters.yearFrom, filters.yearTo);
    const chips = [
      ...filters.tags.map((t) => ["tag", t, t]),
      ...filters.genres.map((g) => ["genre", g, g]),
      ...(filters.ratings || []).map((r) => ["rating", r, r]),
      ...(filters.people || []).map((p) => ["person", p.id, p.name]),
      ...(filters.audioLangs || []).map((l) => ["lang", l, helpers.langLabel(l)]),
      ...(filters.subtitleLangs || []).map((l) => [
        "sublang",
        l,
        `UT ${helpers.langLabel(l)}`,
      ]),
      ...(filters.minRating != null
        ? [["minRating", String(filters.minRating), `★ ${filters.minRating}+`]]
        : []),
      ...(filters.minCritic != null
        ? [["minCritic", String(filters.minCritic), `Kritiker ${filters.minCritic} %+`]]
        : []),
      ...filters.countries.map((c) => ["country", c, c]),
      ...(yearLabel ? [["year", yearLabel, yearLabel]] : []),
    ]
      .map(
        ([kind, value, label]) =>
          `<button class="pill" style="height:30px;font-size:11px;background:transparent;border:1px solid var(--kino-border)"
             data-act="remove-filter" data-kind="${kind}" data-key="${this._esc(value)}">${this._esc(label)} ✕</button>`
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
      <div class="maxcol">
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
          <select data-field="sort" class="sortsel">
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
      </div>
      ${grid}`;
  }

  /** One collapsible filter group: header with active badge, foldable body. */
  _filterGroup(groupKey, title, body) {
    if (!body) return "";
    const collapsed = !!(this._view.filterCollapsed || {})[groupKey];
    const active = this._activeInGroup(groupKey);
    return `<div>
      <button class="grouphead" data-act="toggle-group" data-key="${groupKey}"
        data-group="${groupKey}" aria-expanded="${!collapsed}">
        <div class="label" style="margin:0">${title}</div>
        <span class="groupbadge">${active || ""}</span>
        <span class="chev">▼</span>
      </button>
      <div data-group-body="${groupKey}"${collapsed ? " hidden" : ""}>${body}</div>
    </div>`;
  }

  _renderFilterSheet() {
    const f = this._view.filters;
    const chip = (kind, value, label = value, selected = false) => {
      const count = this._facetCount(kind, value);
      return `<button class="pill${count === 0 && !selected ? " emptying" : ""}"
        data-act="toggle-filter" data-kind="${kind}" data-key="${this._esc(value)}"
        data-count-kind="${kind}" aria-pressed="${selected}">${this._esc(label)}
        <span class="chipcount">${count == null ? "" : count}</span></button>`;
    };
    // A facet group with one lone value cannot narrow anything (F12) — but
    // it must not disappear while its only value is still selected.
    //
    // The long groups are cut to their most common values, with everything
    // still one tap away: this library carries 61 subtitle languages, and
    // nobody scrolls past Bosnisch to reach Deutsch.
    const multi = (values, kind, selected, labelFor = (v) => v) => {
      if (values.length <= 1 && !selected.length) return "";
      const expanded = (this._view.facetsExpanded || {})[kind];
      const shown =
        expanded || values.length <= FACET_CHIP_LIMIT
          ? values
          : values.filter((v, i) => i < FACET_CHIP_LIMIT || selected.includes(v));
      const rest = values.length - shown.length;
      return `<div class="chipwrap">${shown
        .map((v) => chip(kind, v, labelFor(v), selected.includes(v)))
        .join("")}${
        rest > 0
          ? `<button class="pill" style="border-style:dashed"
               data-act="expand-facet" data-key="${kind}">+ ${rest} weitere</button>`
          : ""
      }</div>`;
    };

    const scoreChips = (act, steps, current, labelFor) =>
      `<div class="chipwrap">${steps
        .map(
          (step) =>
            `<button class="pill" data-act="${act}" data-key="${step}"
               aria-pressed="${current === step}">${labelFor(step)}</button>`
        )
        .join("")}</div>`;
    const scoreBody = `
      <div style="font-size:11px;color:var(--kino-text3);font-weight:700;margin-bottom:6px">Community</div>
      ${scoreChips("min-rating", MIN_RATING_STEPS, f.minRating, (s) => `★ ${s}+`)}
      <div style="font-size:11px;color:var(--kino-text3);font-weight:700;margin:2px 0 6px">Kritiker (Rotten Tomatoes)</div>
      ${scoreChips("min-critic", MIN_CRITIC_STEPS, f.minCritic, (s) => `${s} %+`)}`;

    const effectiveDir = this._view.sortDir || helpers.defaultSortDir(this._view.sort);
    const sortBody = `
      <select data-field="sort" style="width:100%;margin-bottom:10px">
        ${SORT_OPTIONS.map(
          ([value, label]) =>
            `<option value="${value}"${this._view.sort === value ? " selected" : ""}>${label}</option>`
        ).join("")}
      </select>
      <div class="row" style="margin-bottom:14px">
        <button class="pill" style="flex:1;height:34px" data-act="sort-dir-set" data-key="asc"
          aria-pressed="${effectiveDir === "asc"}">Aufsteigend</button>
        <button class="pill" style="flex:1;height:34px" data-act="sort-dir-set" data-key="desc"
          aria-pressed="${effectiveDir === "desc"}">Absteigend</button>
      </div>`;

    const viewBody = `
      <div class="chipwrap" style="margin-bottom:10px">
        ${VIEW_MODES.map(
          ([key, label]) =>
            `<button class="pill" data-act="view-mode-set" data-key="${key}"
               aria-pressed="${this._view.viewMode === key}">${label}</button>`
        ).join("")}
      </div>
      <div style="font-size:11px;color:var(--kino-text3);font-weight:700;margin-bottom:6px">Kachelgröße</div>
      <div class="chipwrap">
        ${GRID_SIZES.map(
          ([key, label]) =>
            `<button class="pill" data-act="grid-size-set" data-key="${key}"
               aria-pressed="${this._view.gridSize === key}">${label}</button>`
        ).join("")}
      </div>`;

    // A series has no streams of its own, but the catalogue lends it its
    // episodes' languages — so both groups mean something in either category.
    const langLabel = (v) => helpers.langLabel(v);

    return `<div class="sheet" data-sheet="filter" style="z-index:35">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <a class="link" data-act="close-filters">‹ Zurück</a>
        <h2 style="flex:1">Filter</h2>
        <a class="link" style="color:var(--kino-text2)" data-act="reset-filters">Zurücksetzen</a>
      </div>
      ${this._filterGroup("tags", "Format &amp; Status", multi(TAGS, "tag", f.tags))}
      ${this._filterGroup("genres", "Genre", multi(this._facets.genres || [], "genre", f.genres))}
      ${this._filterGroup("people", "Besetzung &amp; Crew", this._renderPersonFilter())}
      ${this._filterGroup("ratings", "Altersfreigabe", multi(this._facets.ratings || [], "rating", f.ratings || []))}
      ${this._filterGroup("langs", "Tonspur", multi(this._facets.audioLanguages || [], "lang", f.audioLangs || [], langLabel))}
      ${this._filterGroup("sublangs", "Untertitel", multi(this._facets.subtitleLanguages || [], "sublang", f.subtitleLangs || [], langLabel))}
      ${this._filterGroup("score", "Bewertung", scoreBody)}
      ${this._filterGroup("countries", "Land", multi(this._facets.countries || [], "country", f.countries))}
      ${this._filterGroup("year", "Erscheinungsjahr", this._renderYearRange())}
      ${this._filterGroup("sort", "Sortierung", sortBody)}
      ${this._filterGroup("view", "Ansicht", viewBody)}
      <div class="filtercta">
        <button class="primary" data-role="filter-cta" data-act="close-filters">${this._filterPreview ?? this._library.total} Titel anzeigen</button>
      </div>
    </div>`;
  }

  /**
   * The cast-and-crew filter: chosen names, a search field, its suggestions.
   *
   * A free-text name would be a guess — `/Persons` only ever offers people
   * the catalogue actually credits, so a chosen name always returns titles.
   */
  _renderPersonFilter() {
    return `<div class="personsearch">
      <div class="chipwrap" data-role="person-chips">${this._renderPersonChips()}</div>
      <input type="text" data-field="person-search" placeholder="Name suchen…"
        value="${this._esc(this._view.personQuery || "")}" autocomplete="off">
      <div data-role="person-hits">${this._renderPersonHits()}</div>
    </div>`;
  }

  /** The people already filtered on: tap one to drop it again. */
  _renderPersonChips() {
    return (this._view.filters.people || [])
      .map(
        (p) => `<button class="pill" aria-pressed="true" data-act="toggle-person"
          data-key="${this._esc(p.id)}" data-name="${this._esc(p.name)}"
          title="${this._esc(p.name)} entfernen">${this._esc(p.name)} ✕</button>`
      )
      .join("");
  }

  /** Name suggestions under the field, minus the ones already chosen. */
  _renderPersonHits() {
    const hits = this._personHits;
    if (hits == null) {
      return (this._view.personQuery || "").trim().length
        ? '<p class="searchnote">Mindestens zwei Buchstaben eingeben.</p>'
        : "";
    }
    const chosen = new Set((this._view.filters.people || []).map((p) => p.id));
    const rest = hits.filter((p) => !chosen.has(p.id));
    if (!rest.length) {
      return '<p class="searchnote">Keine passenden Namen in der Bibliothek.</p>';
    }
    const sig = this._kino ? this._kino.artworkSignature : null;
    return `<ul class="personhits">${rest
      .map((p) => {
        const initials = (p.name || "")
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0] || "")
          .join("")
          .toUpperCase();
        const img = p.imageTag
          ? `<img loading="lazy" src="${helpers.artworkUrl(p.id, "Primary", sig)}" alt="" onerror="this.remove()">`
          : "";
        return `<li><button data-act="toggle-person" data-key="${this._esc(p.id)}"
          data-name="${this._esc(p.name)}">
          <span class="hitart">${this._esc(initials)}${img}</span>
          <span>${this._esc(p.name)}</span>
        </button></li>`;
      })
      .join("")}</ul>`;
  }

  /**
   * Refresh the chosen names and the suggestions without a re-render.
   *
   * Rebuilding the sheet here would replace the input the user is typing in.
   */
  _patchPersonSearch() {
    const sheet =
      this._container && this._container.querySelector('.sheet[data-sheet="filter"]');
    if (!sheet) return;
    const chips = sheet.querySelector('[data-role="person-chips"]');
    if (chips) chips.innerHTML = this._renderPersonChips();
    const hits = sheet.querySelector('[data-role="person-hits"]');
    if (hits) hits.innerHTML = this._renderPersonHits();
  }

  /**
   * Re-stamp every chip's pressed state from the filters, in place.
   *
   * The alternative — re-rendering the sheet — replaces the DOM under an
   * ongoing scroll and makes it stutter and jump; this loop touches only
   * attributes.
   */
  _syncFilterChips() {
    const sheet =
      this._container &&
      this._container.querySelector('.sheet[data-sheet="filter"]');
    if (!sheet) return;
    const f = this._view.filters;
    const selected = {
      tag: f.tags,
      genre: f.genres,
      rating: f.ratings || [],
      lang: f.audioLangs || [],
      sublang: f.subtitleLangs || [],
      country: f.countries,
    };
    for (const el of sheet.querySelectorAll('[data-act="toggle-filter"]')) {
      const pressed = (selected[el.dataset.kind] || []).includes(el.dataset.key);
      el.setAttribute("aria-pressed", String(pressed));
      if (pressed) el.classList.remove("emptying");
    }
    for (const el of sheet.querySelectorAll('[data-act="min-rating"]')) {
      el.setAttribute("aria-pressed", String(Number(el.dataset.key) === f.minRating));
    }
    for (const el of sheet.querySelectorAll('[data-act="min-critic"]')) {
      el.setAttribute("aria-pressed", String(Number(el.dataset.key) === f.minCritic));
    }
    this._patchFilterSheet();
  }

  /** The mockup's "… bis …" year pair, bounded by the facets. */
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
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <select data-field="year-from" style="flex:1">${options(f.yearFrom)}</select>
        <span style="color:var(--kino-text3);font-size:13px">bis</span>
        <select data-field="year-to" style="flex:1">${options(f.yearTo)}</select>
      </div>`;
  }

  _renderDetailSheet() {
    const item = this._view.detail;
    if (!item)
      return '<div class="sheet" data-sheet="detail"><p class="empty">Wird geladen…</p></div>';
    const backdrop = helpers.artworkUrl(
      item.id,
      "Backdrop",
      this._kino.artworkSignature
    );
    const poster = helpers.artworkUrl(
      item.id,
      "Primary",
      this._kino.artworkSignature
    );
    // While no media activity runs, playing also powers the theater on
    // (FR-55) — the label must say so instead of pretending it just plays.
    const mediaActive =
      helpers.bodyFor(this._currentActivity) === "library" && !this._kino.progress;
    return `<div class="sheet" data-sheet="detail">
      <div style="display:flex;align-items:center;gap:10px">
        <a class="link" style="flex:1" data-act="close-detail">‹ Zurück</a>
        ${this._watchedButton(item)}
        <button class="iconbtn" data-act="toggle-favorite" data-key="${this._esc(item.id)}"
          aria-pressed="${!!item.favorite}"
          title="${item.favorite ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}">${HEART_ICON}</button>
      </div>
      <div class="detailcols" style="margin-top:12px">
        <div class="art detail-poster">
          <img loading="lazy" src="${poster}" alt="" onerror="this.style.display='none'">
        </div>
        <div class="detailmain">
          <div class="backdrop detail-backdrop">
            <img src="${backdrop}" alt="" onerror="this.style.display='none'">
          </div>
          ${
            item.kind === "episode" && item.seriesName
              ? `<div style="font-size:12px;color:var(--kino-text3);margin-top:14px">${this._esc(item.seriesName)}</div>
                 <h2 style="margin:2px 0 4px;font-size:20px">${this._esc(
                   [item.episodeCode, item.title].filter(Boolean).join(" · ")
                 )}</h2>`
              : `<h2 style="margin:14px 0 4px;font-size:20px">${this._esc(item.title)}</h2>`
          }
          <div style="font-size:12px;color:var(--kino-text2)">${this._esc(
            [
              item.year,
              item.runtime ? `${item.runtime} Min` : null,
              item.officialRating,
            ]
              .filter(Boolean)
              .join(" · ")
          )}</div>
          ${this._renderScores(item)}
          ${
            item.videoFormat
              ? `<div style="font-size:11px;color:var(--kino-text3);font-family:ui-monospace,monospace;margin-top:8px">${this._esc(
                  [item.videoFormat, item.audioFormat].filter(Boolean).join(" · ")
                )}</div>`
              : ""
          }
          ${
            item.tagline
              ? `<p style="font-size:13px;color:var(--kino-text2);font-style:italic;margin:14px 0 0">${this._esc(item.tagline)}</p>`
              : ""
          }
          ${this._renderOverview(item)}
          ${
            (item.genres || []).length
              ? `<div class="chipwrap" style="margin:12px 0 0">${item.genres
                  .map(
                    (g) =>
                      `<button class="pill" style="display:inline-flex;align-items:center" data-act="genre-jump" data-key="${this._esc(g)}"
                         title="Alle Titel im Genre ${this._esc(g)}">${this._esc(g)}</button>`
                  )
                  .join("")}</div>`
              : ""
          }
          ${this._renderTrailer(item)}
          ${
            item.kind === "show"
              ? this._renderSeriesBody()
              : item.playable === false
                ? `<p class="error" style="margin:14px 0">${this._esc(item.unplayableReason || "Dieser Titel ist nicht abspielbar.")}</p>`
                : `<button class="primary" style="margin-top:18px" data-act="play" data-key="${this._esc(item.id)}">${this._esc(helpers.playLabel(item, mediaActive))}</button>
                   ${
                     item.continueWatching
                       ? `<button class="ghost" style="width:100%;margin-top:8px" data-act="play-from-start" data-key="${this._esc(item.id)}">Von Anfang abspielen</button>`
                       : ""
                   }`
          }
          ${this._renderTracks(item)}
          ${this._renderPeople(item)}
          ${this._renderSimilar()}
        </div>
      </div>
    </div>`;
  }

  /** The "gesehen" toggle for one entry, as a labelled tick. */
  _watchedButton(item) {
    if (!item || item.kind === "show") return "";
    const done = helpers.isWatched(item);
    return `<button class="iconbtn" data-act="toggle-watched" data-key="${this._esc(item.id)}"
      aria-pressed="${done}" title="${this._esc(helpers.watchedLabel(item))}"
      style="color:${done ? "var(--kino-teal)" : "var(--kino-text3)"}">${CHECK_ICON}</button>`;
  }

  /**
   * The trailer, watchable on the phone before the room is even on.
   *
   * Jellyfin's trailers are links to YouTube and the like, so this opens a
   * tab rather than pretending Kino can stream them.
   */
  _renderTrailer(item) {
    const trailers = item.trailers || [];
    if (!trailers.length) return "";
    // One trailer needs no name; several do, or they are three identical
    // buttons.
    return trailers
      .slice(0, 3)
      .map(
        (trailer, index) => `<button class="ghost" style="width:100%;margin-top:10px"
          data-act="trailer" data-key="${index}">▶ ${this._esc(
            trailers.length > 1 ? trailer.name || "Trailer" : "Trailer ansehen"
          )}</button>`
      )
      .join("");
  }

  /**
   * Every audio and subtitle track the file carries (F17).
   *
   * The one-line `audioFormat` above names the first stream only; a disc with
   * a German and an English mix, plus four subtitle tracks, is a different
   * proposition, and that is exactly what decides whether tonight works.
   */
  _renderTracks(item) {
    const audio = helpers.sortTracks(item.audioTracks);
    const subs = helpers.sortTracks(item.subtitleTracks);
    if (!audio.length && !subs.length) return "";
    // A remux with 21 subtitle tracks would otherwise push the cast, the
    // similar titles and everything below them off the bottom of the sheet.
    // Three is what answers "can we watch this tonight"; the rest is one tap.
    const expanded = this._view.tracksExpanded || {};
    const column = (kind, title, tracks, empty) => {
      const shown = expanded[kind] ? tracks : tracks.slice(0, TRACK_PREVIEW);
      const rest = tracks.length - shown.length;
      return `<div class="trackcol">
        <h4>${title}</h4>
        ${
          tracks.length
            ? `<ul class="tracklist">${shown
                .map(
                  (t) => `<li>
                    <span style="flex:1;min-width:0">${this._esc(helpers.trackLabel(t))}</span>
                    ${t.default ? '<span class="std" title="Standardspur">STD</span>' : ""}
                  </li>`
                )
                .join("")}</ul>
               ${
                 rest > 0
                   ? `<button class="link trackmore" data-act="expand-tracks" data-key="${kind}">
                        + ${rest} weitere
                      </button>`
                   : ""
               }`
            : `<p class="searchnote">${empty}</p>`
        }
      </div>`;
    };
    return `<div class="section" style="margin-top:22px">
      <h3>Tonspuren &amp; Untertitel</h3>
      <div class="trackcols">
        ${column("audio", `Ton (${audio.length})`, audio, "Keine Tonspur.")}
        ${column("subtitle", `Untertitel (${subs.length})`, subs, "Keine Untertitel.")}
      </div>
    </div>`;
  }

  /** Community star and critics tomato, side by side. */
  _renderScores(item) {
    const community = item.rating
      ? `<span class="score" title="Community-Bewertung">
           <span style="color:var(--kino-gold)">★</span>${Number(item.rating).toFixed(1)}
         </span>`
      : "";
    const critic = criticBadge(item);
    if (!community && !critic) return "";
    return `<div class="scorerow" style="margin-top:8px">${community}${critic}</div>`;
  }

  /** Besetzung & Crew, Jellyfin-style: tap a face to browse that person. */
  _renderPeople(item) {
    const people = item.people || [];
    if (!people.length) return "";
    const sig = this._kino.artworkSignature;
    const cards = people
      .map((p) => {
        const initials = p.name
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0] || "")
          .join("")
          .toUpperCase();
        const img = p.imageTag
          ? `<img loading="lazy" src="${helpers.artworkUrl(p.id, "Primary", sig)}" alt="" onerror="this.remove()">`
          : "";
        return `<button class="person" data-act="person-jump" data-key="${this._esc(p.id)}"
          data-name="${this._esc(p.name)}" title="Alle Titel mit ${this._esc(p.name)}">
          <div class="personart"><span class="initials">${this._esc(initials)}</span>${img}</div>
          <div class="name">${this._esc(p.name)}</div>
          <div class="role">${this._esc(helpers.personRole(p))}</div>
        </button>`;
      })
      .join("");
    return `<div class="section" style="margin-top:22px">
      <h3>Besetzung &amp; Crew</h3>
      <div class="personrow hscroll">${cards}</div>
    </div>`;
  }

  /** "Mehr wie dieser Titel" — Jellyfin's similar list, tap to drill on. */
  _renderSimilar() {
    const similar = this._view.similar;
    if (!similar || !similar.length) return "";
    return `<div class="section" style="margin-top:22px">
      <h3>Mehr wie dieser Titel</h3>
      <div class="posterrow hscroll">${similar.map((t) => this._poster(t, false)).join("")}</div>
    </div>`;
  }

  /** The synopsis, clamped to ~4 lines with a "mehr" toggle (F3). */
  _renderOverview(item) {
    if (!item.overview) return "";
    const long = item.overview.length > 220;
    const open = !!this._view.overviewOpen;
    return `<div style="margin:14px 0 0">
      <p class="overview${long && !open ? " clamped" : ""}" data-act="toggle-overview">${this._esc(item.overview)}</p>
      ${long ? `<a class="link" data-act="toggle-overview" style="display:inline-block;margin-top:4px">${open ? "weniger" : "mehr"}</a>` : ""}
    </div>`;
  }

  /** Season strip and episode list of the series drill-down (F2). */
  _renderSeriesBody() {
    const seasons = this._view.seasons;
    if (!seasons) {
      return '<p style="padding:18px 0;color:var(--kino-text3);font-size:13px">Staffeln werden geladen…</p>';
    }
    if (!seasons.length) {
      return '<p style="padding:18px 0;color:var(--kino-text3);font-size:13px">Keine Staffeln gefunden.</p>';
    }
    const strip = `<div class="posterrow hscroll" style="margin:16px 0 6px">${seasons
      .map(
        (s) => `<button class="pill" data-act="select-season" data-key="${this._esc(s.id)}"
          aria-pressed="${s.id === this._view.seasonId}">${this._esc(s.title)}${
            s.unplayedCount ? ` · ${s.unplayedCount}` : ""
          }</button>`
      )
      .join("")}</div>`;
    // The open season can be ticked off in one go — Jellyfin cascades that
    // down to every episode, which is what "Staffel gesehen" has to mean.
    const season = seasons.find((s) => s.id === this._view.seasonId);
    const seasonAction = season
      ? `<button class="ghost" style="width:100%;margin:4px 0 10px"
           data-act="toggle-watched" data-key="${this._esc(season.id)}">
           ${this._esc(helpers.watchedLabel(season))}
         </button>`
      : "";
    const episodes = this._view.episodes;
    let list;
    if (!episodes) {
      list = '<p style="padding:12px 0;color:var(--kino-text3);font-size:13px">Folgen werden geladen…</p>';
    } else if (!episodes.length) {
      list = '<p style="padding:12px 0;color:var(--kino-text3);font-size:13px">Keine Folgen in dieser Staffel.</p>';
    } else {
      list = `<div>${episodes.map((ep) => this._episodeRow(ep)).join("")}</div>`;
    }
    return strip + seasonAction + list;
  }

  /** One tappable episode row: thumb, code · title, runtime, tick, resume. */
  _episodeRow(ep) {
    const src = helpers.artworkUrl(ep.id, "Primary", this._kino.artworkSignature);
    const resumable = ep.continueWatching && ep.resumeSeconds;
    const meta = [
      ep.runtime ? `${ep.runtime} Min` : null,
      resumable ? `Fortsetzen bei ${helpers.formatTime(ep.resumeSeconds)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `<div class="eprow" data-act="play-episode" data-key="${this._esc(ep.id)}">
      <div class="art wide epthumb">
        <img loading="lazy" src="${src}" alt="" onerror="this.style.display='none'">
        ${
          ep.continueWatching
            ? `<div class="resume"><div style="width:${ep.continueWatching}%"></div></div>`
            : ""
        }
      </div>
      <div style="flex:1;min-width:0">
        <div class="title">${this._esc([ep.episodeCode, ep.title].filter(Boolean).join(" · "))}</div>
        <div class="meta">${this._esc(meta)}</div>
      </div>
      <div class="flags" style="display:flex;align-items:center;gap:8px">
        <button class="iconbtn" data-act="toggle-watched" data-key="${this._esc(ep.id)}"
          aria-pressed="${!!ep.watched}" title="${this._esc(helpers.watchedLabel(ep))}"
          style="color:${ep.watched ? "var(--kino-teal)" : "var(--kino-text3)"}">${CHECK_ICON}</button>
        <span class="round" style="display:flex;align-items:center;justify-content:center">▶</span>
      </div>
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

    return `<div class="sheet" data-sheet="playing" style="z-index:30">
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

  /** Mute, the Trinnov's -20 dB Dim, and the dB stepper. */
  _renderVolumeRow(withDim) {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    const muted = state && state.attributes.is_volume_muted;
    const volumeEntity = this._volumeEntity;
    const db = volumeEntity ? this._hass.states[volumeEntity]?.state : null;
    const dimEntity = (this._kino.controls || {}).dim;
    const dimmed = dimEntity && this._hass.states[dimEntity]?.state === "on";
    return `<div class="volrow" style="${withDim ? "justify-content:flex-start" : ""}">
      <button class="pill" data-act="mute" aria-pressed="${!!muted}">Stumm</button>
      ${
        withDim && dimEntity
          ? `<button class="pill" data-act="dim" aria-pressed="${!!dimmed}">Dim</button>`
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
    // Labels name the function, not the brand (F9): the second user does not
    // know what a Trinnov is.
    const blocks = [
      [controls.preset, "Klang", []],
      [controls.upmixer, "Raumklang", ["none"]],
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
    // Values stay raw — they are what the entity accepts. Only the visible
    // text is prettified (F8): "0: Off" reads "Aus", "none" reads "—".
    return `<div style="margin-bottom:12px">
      <div class="label">${this._esc(label)}</div>
      <select data-field="entity-select" data-key="${entityId}">
        ${orphan ? `<option value="" disabled selected>${this._esc(helpers.displayLabel(current))}</option>` : ""}
        ${options
          .map(
            (o) =>
              `<option value="${this._esc(o)}"${current === o ? " selected" : ""}>${this._esc(helpers.displayLabel(o))}</option>`
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
    // While shutting down there is nothing to hear and nothing to adjust —
    // a dead volume row ("—") would only pretend otherwise (F13).
    if (k.progress && k.targetActivity === k.offActivity) {
      return `<footer>
        <div class="footrow">
          <div style="flex:1;font-size:12px;font-weight:700;color:var(--kino-text2)">
            Wird ausgeschaltet…
          </div>
        </div>
      </footer>`;
    }
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
      case "open-favorites": {
        // The row shows twelve; the library shows all of them, filterable.
        const filters = helpers.emptyFilters();
        filters.tags = ["Favoriten"];
        view.main = "library";
        view.category = "movies";
        view.query = "";
        view.filters = filters;
        this._filterPreview = null;
        this._facetCounts = null;
        this._render();
        await this._loadLibrary();
        break;
      }
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
        this._filterPreview = null;
        view.personQuery = "";
        this._personHits = null;
        this._render();
        // Counts and the CTA total straight away, not first after a toggle.
        this._previewFilterCount();
        break;
      case "close-filters":
        view.filterSheet = false;
        this._filterPreview = null;
        this._render();
        await this._loadLibrary();
        break;
      case "reset-filters":
        view.filters = helpers.emptyFilters();
        view.personQuery = "";
        this._personHits = null;
        this._render();
        this._previewFilterCount();
        break;
      case "toggle-person": {
        // Adding a name clears the field, so the next one starts fresh.
        const people = view.filters.people || [];
        const has = people.some((p) => p.id === key);
        view.filters.people = has
          ? people.filter((p) => p.id !== key)
          : [...people, { id: key, name: target.dataset.name || "?" }];
        if (!has) {
          view.personQuery = "";
          this._personHits = null;
          const field = this._container.querySelector('[data-field="person-search"]');
          if (field) {
            field.value = "";
            // The caret has to go back into the field: without it the next
            // keystroke is a Home Assistant hotkey, and typing a second name
            // opens the global search instead (found live).
            field.focus();
          }
        }
        this._patchPersonSearch();
        this._syncFilterChips();
        this._previewFilterCount();
        break;
      }
      case "expand-facet":
        view.facetsExpanded = { ...view.facetsExpanded, [key]: true };
        this._render();
        break;
      case "expand-tracks":
        view.tracksExpanded = { ...view.tracksExpanded, [key]: true };
        this._render();
        break;
      case "toggle-group": {
        // Fold in place — a re-render mid-scroll is exactly what made the
        // sheet jump.
        const collapsed = { ...view.filterCollapsed };
        collapsed[key] = !collapsed[key];
        view.filterCollapsed = collapsed;
        store(FILTER_COLLAPSE_STORAGE_KEY, JSON.stringify(collapsed));
        target.setAttribute("aria-expanded", String(!collapsed[key]));
        const body = this._container.querySelector(`[data-group-body="${key}"]`);
        if (body) body.hidden = !!collapsed[key];
        break;
      }
      case "min-rating":
      case "min-critic": {
        const field = act === "min-rating" ? "minRating" : "minCritic";
        const value = Number(key);
        view.filters[field] = view.filters[field] === value ? null : value;
        this._syncFilterChips();
        this._previewFilterCount();
        break;
      }
      case "toggle-filter":
      case "remove-filter": {
        const f = view.filters;
        if (kind === "year") {
          f.yearFrom = null;
          f.yearTo = null;
        } else if (kind === "person") {
          f.people = (f.people || []).filter((p) => p.id !== key);
        } else if (kind === "minRating") {
          f.minRating = null;
        } else if (kind === "minCritic") {
          f.minCritic = null;
        } else {
          const bucket = {
            tag: "tags",
            genre: "genres",
            country: "countries",
            rating: "ratings",
            lang: "audioLangs",
            sublang: "subtitleLangs",
          }[kind];
          const list = f[bucket] || [];
          if (act === "toggle-filter" && bucket === "tags") {
            // Resolution tiers and watch states are mutually exclusive.
            f.tags = helpers.toggleTag(list, key);
          } else {
            f[bucket] = list.includes(key)
              ? list.filter((v) => v !== key)
              : [...list, key];
          }
        }
        if (act === "remove-filter") {
          this._render();
          await this._loadLibrary();
        } else {
          // Attribute-only updates keep an ongoing scroll alive.
          this._syncFilterChips();
          this._previewFilterCount();
        }
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
        store(VIEW_MODE_STORAGE_KEY, view.viewMode);
        this._render();
        break;
      }
      case "view-mode-set":
        view.viewMode = key;
        store(VIEW_MODE_STORAGE_KEY, view.viewMode);
        this._render();
        break;
      case "grid-size-set":
        view.gridSize = key;
        store(GRID_SIZE_STORAGE_KEY, view.gridSize);
        this._render();
        break;
      case "toggle-favorite":
        await this._toggleFavorite(key);
        break;
      case "toggle-watched":
        await this._toggleWatched(key);
        break;
      case "trailer": {
        const trailer = ((view.detail || {}).trailers || [])[Number(key)];
        // A trailer lives on YouTube, not on the NAS — the browser plays it.
        if (trailer) window.open(trailer.url, "_blank", "noopener,noreferrer");
        break;
      }
      case "force-refresh":
        await this._forceRefresh();
        break;
      case "open-detail":
        view.detailId = key;
        view.detail = null;
        view.seasons = null;
        view.seasonId = null;
        view.episodes = null;
        view.similar = null;
        view.overviewOpen = false;
        view.tracksExpanded = {};
        this._render();
        // Runs alongside the item fetch; it re-checks the open detail ID.
        this._loadSimilar(key);
        try {
          view.detail = await this._ws({ type: "kino/library/item", item_id: key });
        } catch (err) {
          view.detail = null;
          this._actionError = err.message;
        }
        this._render();
        // A show browses on: season strip, then that season's episodes (F2).
        if (view.detail && view.detail.kind === "show") {
          await this._loadSeasons(view.detail.id);
        }
        break;
      case "close-detail":
        this._closeDetail();
        this._render();
        break;
      case "genre-jump":
      case "person-jump": {
        // From the detail sheet straight into the library, with exactly this
        // one filter active.
        const detail = view.detail;
        const fromShow = !!detail && detail.kind !== "movie";
        const filters = helpers.emptyFilters();
        if (act === "genre-jump") filters.genres = [key];
        else filters.people = [{ id: key, name: target.dataset.name || "?" }];
        this._closeDetail();
        view.main = "library";
        view.category = fromShow ? "shows" : "movies";
        view.query = "";
        view.filters = filters;
        this._filterPreview = null;
        this._facetCounts = null;
        this._render();
        await this._loadLibrary();
        break;
      }
      case "toggle-overview":
        view.overviewOpen = !view.overviewOpen;
        this._render();
        break;
      case "select-season":
        view.seasonId = key;
        await this._loadEpisodes();
        break;
      case "play-episode":
        await this._play(key, false);
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
      if (this._view.filterSheet) {
        // The grid is invisible behind the sheet — closing it reloads anyway.
        this._render();
        this._previewFilterCount();
      } else {
        this._render();
        this._loadLibrary();
      }
    } else if (field === "year-from" || field === "year-to") {
      const value = event.target.value ? Number(event.target.value) : null;
      this._view.filters[field === "year-from" ? "yearFrom" : "yearTo"] = value;
      // The select shows its own new value — only the badges and counts move.
      this._syncFilterChips();
      this._previewFilterCount();
    } else if (field === "entity-select") {
      this._callService("select", "select_option", {
        entity_id: event.target.dataset.key,
        option: event.target.value,
      });
    }
  }

  _onInput(event) {
    const field = event.target.dataset.field;
    if (field === "person-search") {
      this._view.personQuery = event.target.value;
      this._searchPeople();
      return;
    }
    if (field !== "query") return;
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
