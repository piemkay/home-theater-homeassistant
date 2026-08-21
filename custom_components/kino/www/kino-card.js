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

const CARD_VERSION = "0.7.3";

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

  /**
   * `noch 1:32:07` — how much film is left.
   *
   * The number people actually ask for mid-film. Empty while the player has
   * not reported a duration yet, so the row shows nothing rather than a
   * countdown from zero.
   */
  remainingLabel(position, duration) {
    if (!duration) return "";
    const left = Math.max(0, duration - position);
    return `noch ${this.formatTime(left)}`;
  },

  /**
   * Minutes -> `1 Std 53 Min`, the way a film's length gets said out loud.
   *
   * The poster grids stay on the compact `106 Min` — there the number is a
   * sorting aid. In the player's hero it is the answer to "how long is this",
   * and nobody counts 113 minutes into hours in their head.
   */
  runtimeLabel(minutes) {
    if (!minutes) return "";
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    if (!h) return `${m} Min`;
    return m ? `${h} Std ${m} Min` : `${h} Std`;
  },

  /** Stream codec ids -> what the box says. */
  codecLabel(codec) {
    const raw = String(codec || "").toUpperCase();
    const map = {
      TRUEHD: "TrueHD",
      EAC3: "DD+",
      AC3: "DD",
      DTS: "DTS",
      DTSHD: "DTS-HD",
      FLAC: "FLAC",
      AAC: "AAC",
      OPUS: "Opus",
      MP3: "MP3",
    };
    if (map[raw]) return map[raw];
    // PCM_S24LE, PCM_S16BE, … — the width is not what anyone reads.
    if (raw.startsWith("PCM")) return "PCM";
    return codec || "";
  },

  /**
   * `TrueHD Atmos 7.1` — the sound, the way a disc case states it.
   *
   * A careful rip names its own default track exactly right, so that name is
   * used when it looks like a name. A dumped stream description ("English -
   * PCM_S24LE - 6 ch - Default") is not one, and gets rebuilt from the codec
   * and channel layout instead.
   */
  soundBadge(item) {
    const tracks = item.audioTracks || [];
    const track = tracks.find((t) => t.default) || tracks[0];
    if (track) {
      const title = String(track.title || "").trim();
      if (title && title.length <= 22 && !title.includes(" - ")) return title;
      const atmos = /atmos/i.test(title) ? " Atmos" : "";
      return [helpers.codecLabel(track.codec) + atmos, track.channelLayout]
        .filter(Boolean)
        .join(" ");
    }
    // No track list at all: the one-line summary is everything there is.
    const first = String(item.audioFormat || "").split(" · ")[0];
    return first ? helpers.codecLabel(first) : "";
  },

  /**
   * The chips beside the title in the player's hero.
   *
   * `videoFormat` and `audioFormat` are engineering strings — "3840×2160 ·
   * @23.976Hz · HDR", "TRUEHD · 7.1 · eng". They earn their place in the
   * detail sheet's track list; here they get one line beside a 104px poster,
   * so each is reduced to what someone would read off the case.
   */
  heroBadges(item) {
    if (!item) return [];
    const badges = [];
    const video = String(item.videoFormat || "");
    const picture = [];
    if (item.res4k) picture.push("4K");
    else if (/1920|1280/.test(video)) picture.push("HD");
    // Most specific first: a Dolby Vision disc also reports HDR.
    const range = /dolby ?vision|(?:^|[^a-z])dv(?:[^a-z]|$)/i.test(video)
      ? "DV"
      : /hdr10\+|hdr10plus/i.test(video)
        ? "HDR10+"
        : /hdr/i.test(video)
          ? "HDR"
          : null;
    if (range) picture.push(range);
    if (item.is3d) picture.push("3D");
    if (picture.length) badges.push(picture.join(" "));
    const sound = helpers.soundBadge(item);
    if (sound) badges.push(sound);
    // "FSK-6" is how Jellyfin stores it; "FSK 6" is how it is read.
    if (item.officialRating) {
      badges.push(String(item.officialRating).replace(/^FSK-/, "FSK "));
    }
    return badges;
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
      (yearActive ? 1 : 0) +
      (filters.runtimeFrom != null || filters.runtimeTo != null ? 1 : 0)
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
      runtime_from: filters.runtimeFrom ?? null,
      runtime_to: filters.runtimeTo ?? null,
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
      runtimeFrom: null,
      runtimeTo: null,
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

  /** Chip label for the runtime window, or null when none is set. */
  runtimeRangeLabel(runtimeFrom, runtimeTo) {
    if (runtimeFrom == null && runtimeTo == null) return null;
    if (runtimeFrom != null && runtimeTo != null) {
      return runtimeFrom === runtimeTo
        ? `${runtimeFrom} Min`
        : `${runtimeFrom}–${runtimeTo} Min`;
    }
    return runtimeFrom != null ? `ab ${runtimeFrom} Min` : `bis ${runtimeTo} Min`;
  },

  /**
   * The rungs the runtime pair offers, between the library's own bounds.
   *
   * Ten-minute rungs are how a person says it — "neunzig Minuten", "zwei
   * Stunden" — and both land on one. A library with a five-hour concert film
   * in it would turn that into a wall of numbers, so a wide span coarsens to
   * half-hours. Whatever is already chosen stays on the ladder even if the
   * bounds moved under it, or the select would show a dash while the filter
   * is plainly active.
   */
  runtimeSteps(runtimeMin, runtimeMax, chosen = []) {
    const low = runtimeMin > 0 ? runtimeMin : 30;
    const high = runtimeMax > low ? runtimeMax : Math.max(240, low + 60);
    const step = high - low > 400 ? 30 : 10;
    const first = Math.max(step, Math.floor(low / step) * step);
    const last = Math.ceil(high / step) * step;
    const steps = new Set();
    for (let m = first; m <= last; m += step) steps.add(m);
    for (const value of chosen) if (value != null) steps.add(value);
    return [...steps].sort((a, b) => a - b);
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

  /**
   * Milliseconds as `H:MM:SS` — the only spelling a demo clip ever shows.
   *
   * Clips are stored in milliseconds and never displayed in them; this and
   * `parseTimecode` are the only two places that translation happens, on
   * this side exactly as in the integration's own model.
   */
  formatTimecode(milliseconds) {
    const total = Math.max(0, Math.round((milliseconds || 0) / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  },

  /**
   * A hand-typed timecode as milliseconds, forgivingly.
   *
   * `1:12:04`, `72:04` and a bare `4324` all resolve to the same instant, so
   * the user can type roughly and nudge precisely. Anything that is not a
   * timecode returns null rather than a wrong number.
   */
  parseTimecode(text) {
    if (text == null) return null;
    const parts = String(text).trim().split(":").map((p) => p.trim());
    if (!parts.length || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
    let seconds = 0;
    for (const part of parts) seconds = seconds * 60 + parseFloat(part);
    return Math.max(0, Math.round(seconds * 1000));
  },

  /** A tag's German label, falling back to the free-text tag itself. */
  tagLabel(key, vocabulary) {
    const entry = (vocabulary || []).find((v) => v.key === key);
    return entry ? entry.label : key;
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
/* Deliberately not .art.banner: .banner is the alert strip at the top of the
   card, and its padding and border landed on every banner tile as a grey
   frame around the artwork. A view mode must not borrow a component's name. */
.art.bannerart { aspect-ratio: 4.5/1; border-radius: 12px; }
.art .caption {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px;
  box-sizing: border-box; color: #fff;
  background: linear-gradient(0deg, rgba(0,0,0,.75), transparent);
}
.art .caption > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.art .captiontitle { font-weight: 800; font-size: 14px; }
/* The shared .meta is a dim grey that vanishes against a backdrop still. */
.art .caption .meta { font-size: 11px; color: rgba(255,255,255,.85); }
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
/* One labelled select. A class, not an inline margin, so a grid can drop it. */
.selblock { margin-bottom: 12px; }

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
/* The dB reading is one line, never two: the row shrinks the spacer beside
   it rather than the number itself. */
.volval { font-size: 11px; color: var(--kino-text2); width: 62px; flex-shrink: 0; white-space: nowrap; text-align: center; font-variant-numeric: tabular-nums; }
.round { width: 36px; height: 36px; border-radius: 18px; border: none; background: var(--kino-surface2); color: var(--kino-text2); font-size: 15px; cursor: pointer; flex-shrink: 0; }
.round.ghosted { background: transparent; }
.seek { border: none; background: transparent; color: var(--kino-text2); font-size: 12px; font-weight: 700; cursor: pointer; font-family: inherit; }
button:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
.backdrop .caption {
  position: absolute; left: 0; right: 0; bottom: 0; padding: 12px 14px;
  font-weight: 800; font-size: 15px; box-sizing: border-box;
  background: linear-gradient(0deg, rgba(0,0,0,.65), transparent);
}

/* -- Player view -----------------------------------------------------
   The film leads: a full-bleed backdrop, its poster set into the bottom
   edge, and the transport directly under it. Everything the title itself
   carries — synopsis, cast, similar — follows below the controls, so the
   view answers "what is this" without leaving the playback screen. */
.sheet.hero { padding: 0; }
.playhero {
  position: relative; width: 100%; height: 200px; flex-shrink: 0;
  background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 10px, var(--kino-surface) 10px, var(--kino-surface) 20px);
}
.playhero img { width: 100%; height: 100%; object-fit: cover; display: block; }
/* Darkens the top for the two links and fades the bottom into the page, so
   the poster and title sit on the card's own background, not on the still. */
.playhero .veil {
  position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,.5) 0%, transparent 35%, var(--kino-bg) 100%);
}
.playhero .links {
  position: absolute; top: 14px; left: 16px; right: 16px;
  display: flex; justify-content: space-between; align-items: center;
}
/* These two sit on the darkened top of the artwork in either theme, so they
   are light regardless of it — the theme's own text colour would be black on
   black in light mode. The shadow covers the bright stills. */
.playhero .links a { color: oklch(0.97 0.005 265); text-shadow: 0 1px 3px rgba(0,0,0,.65); }
.playhero .links a.quiet { color: oklch(0.82 0.01 265); }
.playbody { position: relative; padding: 0 20px 28px; margin-top: -64px; }
.playhead { display: flex; gap: 14px; align-items: flex-end; margin-bottom: 16px; }
.playposter {
  position: relative; width: 104px; aspect-ratio: 2/3; flex-shrink: 0;
  border-radius: 12px; overflow: hidden; border: 1px solid var(--kino-border);
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  background: repeating-linear-gradient(135deg, var(--kino-surface2), var(--kino-surface2) 8px, var(--kino-surface) 8px, var(--kino-surface) 16px);
}
.playposter img { width: 100%; height: 100%; object-fit: cover; display: block; }
.playtitle { min-width: 0; padding-bottom: 4px; }
.playtitle h2 { font-size: 20px; line-height: 1.15; margin: 0 0 5px; }
.playtitle .line { font-size: 11px; font-weight: 600; color: var(--kino-text2); margin-bottom: 6px; }
.formats { display: flex; gap: 5px; flex-wrap: wrap; }
.formats span {
  font-size: 9px; font-weight: 800; padding: 3px 7px; border-radius: 5px;
  border: 1px solid var(--kino-border); color: var(--kino-text2);
}

/* The scrubber. The 24px strip, not the 5px track, is what the thumb has to
   hit; touch-action none keeps a stray drag from scrolling the sheet. */
.scrub { position: relative; height: 24px; display: flex; align-items: center; cursor: pointer; touch-action: none; }
.scrub .track { position: relative; width: 100%; height: 5px; border-radius: 3px; background: var(--kino-surface2); }
.scrub .track > div { height: 100%; background: var(--kino-gold); border-radius: 3px; }
.scrub .knob {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  width: 14px; height: 14px; border-radius: 7px; background: var(--kino-gold);
  box-shadow: 0 0 0 4px oklch(0.78 0.15 75 / .25);
}
.times {
  display: flex; justify-content: space-between; margin-bottom: 12px;
  font-size: 11px; color: var(--kino-text3); font-variant-numeric: tabular-nums;
}
.times .rest { color: var(--kino-text2); }
.transport { display: flex; align-items: center; justify-content: center; gap: 20px; margin-bottom: 18px; }
.transport .round { width: 44px; height: 44px; border-radius: 22px; background: transparent; font-size: 19px; }
.transport .seek { width: 44px; height: 44px; font-size: 13px; }
.transport .play {
  width: 60px; height: 60px; border-radius: 30px; border: none; cursor: pointer;
  background: var(--kino-gold); color: var(--kino-goldText); font-size: 21px;
}
/* Mute, Dim and the dB stepper read as one instrument, apart from the
   selects below them. */
.audiopanel {
  padding: 14px; border-radius: 16px; margin-bottom: 14px;
  background: var(--kino-surface); border: 1px solid var(--kino-border);
}
.audiopanel .volrow { margin-top: 0; }
.audiopanel .volval { font-size: 13px; font-weight: 700; width: 70px; color: var(--kino-text); }
.selgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 22px; }
.selgrid .selblock { margin-bottom: 0; }
.playsection { margin-bottom: 20px; }
.playsection.divided { border-top: 1px solid var(--kino-border); padding-top: 18px; }
.playsection h3 { margin-bottom: 8px; }

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
.overviewwrap { margin: 14px 0 0; }
/* In the player view the heading above it already provides the gap. */
.playsection .overviewwrap { margin-top: 0; }
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

/* Tile sizes: on a phone, "Klein" fits a third poster column and
   "Sehr klein" a fourth. Every layout answers to the size, so the toolbar
   control is never a dud — a banner gets a shallower strip, a list row a
   smaller thumbnail. */
.postergrid.size-s { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.postergrid.size-s .poster .title { font-size: 11px; }
.postergrid.size-s .poster .meta { font-size: 10px; }
.postergrid.size-xs { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.postergrid.size-xs .poster .title { font-size: 10px; margin-top: 4px; }
.postergrid.size-xs .poster .meta { font-size: 9px; }
.thumbgrid.size-s { gap: 10px; }
.thumbgrid.size-xs { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.thumbgrid.size-xs .poster .title { font-size: 10px; margin-top: 4px; }
.thumbgrid.size-xs .poster .meta { font-size: 9px; }

/* A banner's size is the depth of the strip. */
.bannerlist.size-xs .art.bannerart { aspect-ratio: 7/1; }
.bannerlist.size-s .art.bannerart { aspect-ratio: 5.5/1; }
.bannerlist.size-l .art.bannerart { aspect-ratio: 3.2/1; }
.bannerlist.size-xs { gap: 8px; }
.bannerlist.size-s { gap: 10px; }
.bannerlist.size-xs .art .captiontitle { font-size: 12px; }
.bannerlist.size-xs .art .caption { padding: 5px 9px; }
.bannerlist.size-l .art .captiontitle { font-size: 16px; }

/* A list row's size is the thumbnail beside the text. */
.listrows.size-xs .listrow .art { width: 32px; }
.listrows.size-xs .listrow .title { font-size: 12px; }
.listrows.size-s .listrow .art { width: 38px; }
.listrows.size-l .listrow .art { width: 60px; }
.listrows.size-l .listrow .title { font-size: 14px; }

/* Tablet: the same card, denser (FR-71). */
@media (min-width: 640px) {
  .tilegrid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .postergrid.size-xs { grid-template-columns: repeat(auto-fill, minmax(78px, 1fr)); }
  .postergrid.size-s { grid-template-columns: repeat(auto-fill, minmax(105px, 1fr)); }
  .postergrid.size-l { grid-template-columns: repeat(auto-fill, minmax(175px, 1fr)); }
  .thumbgrid.size-xs { grid-template-columns: repeat(auto-fill, minmax(125px, 1fr)); }
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
  /* 200px of a 720px-wide panel is a letterbox strip, not a hero. */
  .playhero { height: 260px; }
}
@media (min-width: 900px) {
  .postergrid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
  .thumbgrid { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .postergrid.size-xs { grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); }
  .postergrid.size-s { grid-template-columns: repeat(auto-fill, minmax(115px, 1fr)); }
  .postergrid.size-l { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .thumbgrid.size-xs { grid-template-columns: repeat(auto-fill, minmax(135px, 1fr)); }
  .thumbgrid.size-s { grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .thumbgrid.size-l { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
  /* Detail sheet: poster left, text right (F10). */
  .detailcols { display: flex; gap: 20px; align-items: flex-start; }
  .detail-poster { display: block; flex: 0 0 200px; }
  .detailmain { flex: 1; min-width: 0; }
  .detail-backdrop { display: none; }
}

/* -- demo mode ------------------------------------------------------- */

.clipcard {
  padding: 12px; border-radius: 14px; background: var(--kino-surface);
  border: 1px solid var(--kino-border); cursor: pointer;
}
.clipcard .head { display: flex; gap: 12px; }
.clipcard .art {
  flex: 0 0 44px; width: 44px; height: 66px; border-radius: 8px;
}
.clipcard .body { flex: 1; min-width: 0; }
.clipcard .name { font-size: 13px; font-weight: 800; }
.clipcard .range {
  font-size: 11px; color: var(--kino-text3); margin-top: 3px;
  font-variant-numeric: tabular-nums;
}
.clipcard .notes {
  margin: 8px 0 0; font-size: 12px; color: var(--kino-text2); line-height: 1.5;
}
.tagchip {
  height: 22px; display: inline-flex; align-items: center; padding: 0 9px;
  border-radius: 11px; background: var(--kino-surface2);
  color: var(--kino-text2); font-size: 10px; font-weight: 700;
}
.sclist { display: flex; flex-direction: column; gap: 10px; }
.scrow {
  padding: 16px; border-radius: 14px; background: var(--kino-surface);
  border: 1px solid var(--kino-border); display: flex; align-items: center;
  gap: 12px; cursor: pointer;
}
.scrow .name { font-size: 14px; font-weight: 800; }
.scrow .meta { font-size: 11px; color: var(--kino-text3); margin-top: 3px; }
.dashed {
  width: 100%; padding: 12px; border-radius: 12px;
  border: 1px dashed var(--kino-border); background: transparent;
  color: var(--kino-text2); font-weight: 700; font-size: 12px; cursor: pointer;
}
.timefield {
  width: 100%; box-sizing: border-box; padding: 11px 12px; border-radius: 12px;
  border: 1px solid var(--kino-border); background: var(--kino-surface);
  color: var(--kino-text); font-size: 15px; font-weight: 700;
  font-family: ui-monospace, monospace; text-align: center;
}
.nudges { display: flex; gap: 6px; margin-top: 6px; }
.nudges button {
  flex: 1; height: 30px; border-radius: 8px; border: none;
  background: var(--kino-surface2); color: var(--kino-text2);
  font-size: 11px; font-weight: 700; cursor: pointer;
}
.preview {
  padding: 12px; border-radius: 12px; background: var(--kino-surface);
  border: 1px solid var(--kino-border);
}
.preview .transport {
  display: flex; align-items: center; justify-content: center; gap: 14px;
}
.hint { margin: 8px 0 0; font-size: 10px; color: var(--kino-text3); line-height: 1.5; }
.slate {
  padding: 22px; border-radius: 16px; background: var(--kino-surface);
  border: 1px solid var(--kino-border); margin-bottom: 16px;
}
.slate .next { font-size: 18px; font-weight: 800; line-height: 1.3; }
.slate p { margin: 10px 0 0; font-size: 13px; color: var(--kino-text2); }
.demorows { display: flex; flex-direction: column; gap: 6px; margin-bottom: 16px; }
.demorow {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-radius: 12px; border: 1px solid var(--kino-border); cursor: pointer;
  background: transparent;
}
.demorow[aria-current="true"] { background: var(--kino-surface2); }
/* Wanted, but the engine has not arrived yet — the tap is acknowledged
   before the room can answer it. */
.demorow[aria-busy="true"] { border-color: var(--kino-gold); opacity: 0.75; }
.demorow .n { width: 18px; font-size: 11px; font-weight: 800; color: var(--kino-text3); }
.demorow[aria-current="true"] .n { color: var(--kino-gold); }
.demorow .nm {
  flex: 1; font-size: 12px; font-weight: 700; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; text-align: left;
}
.demorow .du { font-size: 10px; color: var(--kino-text3); }
.stepper { display: flex; align-items: center; gap: 8px; }
.stepper .val {
  font-size: 12px; font-weight: 700; width: 56px; text-align: center;
  font-variant-numeric: tabular-nums;
}
.steprow {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 10px;
}
.steprow > span { font-size: 12px; color: var(--kino-text2); font-weight: 700; }
.abbox {
  padding: 16px; border-radius: 14px; background: var(--kino-surface);
  border: 1px solid var(--kino-border); margin-bottom: 10px;
}
.abfield { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.abfield > span {
  width: 56px; flex-shrink: 0; font-size: 10px; color: var(--kino-text3);
  font-weight: 700;
}
.abfield select, .abfield input { flex: 1; min-width: 0; }
.abmid { flex: 1; display: flex; flex-direction: column; justify-content: center; }
.warnbox {
  margin: 0 0 14px; padding: 10px 12px; border-radius: 10px;
  background: oklch(0.78 0.15 75 / 0.14);
  border: 1px solid oklch(0.78 0.15 75 / 0.4);
  font-size: 12px; color: var(--kino-text);
}
.okbox {
  margin-top: 10px; padding: 10px 12px; border-radius: 10px;
  background: oklch(0.72 0.12 190 / 0.15);
  border: 1px solid oklch(0.72 0.12 190 / 0.4);
  font-size: 12px; color: var(--kino-text); font-weight: 600;
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

// Tile size: three columns of decreasing width, the density it sets.
const SIZE_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
  <rect x="3" y="6" width="5" height="12" rx="1.2"></rect>
  <rect x="10" y="8" width="4" height="10" rx="1.1"></rect>
  <rect x="16" y="10" width="3" height="8" rx="1"></rect></svg>`;

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
  "runtime",
  "sort",
  "view",
];

const VIEW_MODE_STORAGE_KEY = "kino-card-view-mode";
const GRID_SIZE_STORAGE_KEY = "kino-card-grid-size";
const FILTER_COLLAPSE_STORAGE_KEY = "kino-card-filter-collapsed";

// Tile sizes for the poster/thumb walls: "Mittel" is the classic
// look, "Klein" fits one more column on a phone, "Groß" spreads out.
const GRID_SIZES = [
  ["xs", "Sehr klein"],
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
/**
 * Everything in `_view` that says *where you are standing*.
 *
 * A back step restores exactly these. What the card has merely loaded — the
 * state poll, the demo dataset, the facet lists — is not a place and does not
 * belong in a snapshot.
 */
const NAV_KEYS = [
  "main",
  "category",
  "query",
  "sort",
  "sortDir",
  "filters",
  "facetsExpanded",
  "personQuery",
  "detailId",
  "detail",
  "seasons",
  "seasonId",
  "episodes",
  "similar",
  "overviewOpen",
  "tracksExpanded",
  "playingOpen",
  "filterSheet",
  "trim",
  "scEdit",
  "abSetup",
  "demoTab",
  "demoTagFilter",
];

/** Overlays that a back step dismisses rather than steps out of. */
const TRANSIENT_KEYS = ["powerConfirm", "activityMenu"];

/** How many steps back the card remembers. Far more than anyone walks. */
const NAV_DEPTH = 50;

const PAGE_SIZE = 60;

// A search starts at three letters. "A" or "Al" match half the catalogue, so
// the two requests before "Ali" cost a full round trip each and tell nobody
// anything — and every answer that comes back repaints the grid under the
// person still typing.
const SEARCH_MIN_CHARS = 3;

// How long the field stays quiet before the search goes out. Long enough that
// a typed word is one request, short enough to still feel immediate.
const SEARCH_DEBOUNCE_MS = 300;

// How long after the last keystroke the card still treats a focused field as
// being written in, and holds back the redraws that would replace it.
const TYPING_QUIET_MS = 2500;

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
    // A poll wanted to redraw while someone was typing — see `_renderPassive`.
    this._renderPending = false;
    // When the last letter went into a field of this card.
    this._lastTypedAt = 0;
    // The search the grid on screen was fetched with, so a keystroke that
    // does not change it (a third letter typed and taken back) sends nothing.
    this._appliedQuery = "";
    // Which library load is the current one — see `_loadLibrary`.
    this._libraryToken = 0;
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
      // The playback view's own copy of the film: which title it was fetched
      // for, the catalogue entry, its similar row, and its "mehr" toggle.
      // Derived from what is playing rather than from where the user is, so
      // deliberately outside NAV_KEYS — a back step must not undo it.
      playingItemId: null,
      playingItem: null,
      playingSimilar: null,
      playingOverviewOpen: false,
      powerConfirm: false,
      activityMenu: false,
      musikSource: "spotify",
      refreshing: false,
      // -- demo mode ---------------------------------------------------
      demoTab: "clips",
      demoTagFilter: [],
      // The trim editor's working copy: nothing is written until "speichern".
      trim: null,
      // The showcase editor's working copy, same rule.
      scEdit: null,
      // The A/B setup sheet's working copy.
      abSetup: null,
    };
    //: Clips, showcases, vocabulary and settings, fetched on demand.
    this._demo = {
      clips: [],
      showcases: [],
      vocabulary: [],
      settings: {},
      options: {},
    };
    this._demoAt = 0;
    // Capture confirmations, shown briefly under the capture button.
    this._demoToast = "";
    this._demoToastTimer = null;
    // The clip bar's last width, so the player's own rounding cannot make it
    // twitch backwards. See `_demoBarFraction`.
    this._demoBar = null;
    // The clip a tap asked for, held until the engine reports it running, so
    // the list answers the tap immediately rather than at the next poll.
    this._demoJumpTo = null;
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
      runtimeMin: null,
      runtimeMax: null,
    };
    // Where we have been, newest last. See `_navPush`.
    this._nav = [];
    // The scroll position a back step is putting back, consumed by the next
    // render.
    this._restoreScrollTo = null;
    // One entry per browser-history entry this card pushed, so a back gesture
    // from the phone or the browser can be told apart from HA's own.
    this._browserTokens = [];
    this._navToken = 0;
    // Pops we caused ourselves and must not act on twice.
    this._skipPop = 0;
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
      // The tag vocabulary and the clip list are needed by the trim editor
      // and the title detail, both of which are reached without ever
      // visiting the Demos tab — so they cannot wait for it.
      this._loadDemo();
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
      this._renderPassive();
    } else {
      this._tick();
    }
  }

  /**
   * A redraw nobody asked for: the state poll, a hass update, a row arriving.
   *
   * Rebuilding the card replaces the field under the caret — and a keyboard
   * that is halfway through a word does not survive having its input element
   * swapped out from under it, which is what made every other letter of a
   * search term disappear. Nothing the poll carries is worth a dropped letter,
   * so while a field has the focus the redraw waits for the caret to leave.
   */
  _renderPassive() {
    if (this._isTyping()) {
      this._renderPending = true;
      return;
    }
    this._render();
  }

  /**
   * Is somebody writing in a field of this card right now?
   *
   * A focused field alone is not enough: one tapped and then left alone would
   * freeze every poll behind it. It counts as typing only while the letters
   * are still coming — a few seconds after the last one the card catches up on
   * its own, and the render that lands then puts the caret back where it was.
   */
  _isTyping() {
    const active = this.shadowRoot && this.shadowRoot.activeElement;
    if (!active) return false;
    if (active.tagName !== "INPUT" && active.tagName !== "TEXTAREA") return false;
    return Date.now() - (this._lastTypedAt || 0) < TYPING_QUIET_MS;
  }

  /** The caret has left a field: let the redraw the poll owed us through. */
  _flushPendingRender() {
    if (!this._renderPending || this._isTyping()) return;
    this._render();
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
    if (!this._container || !this._hass) return;
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
    // The player view's scrubber: a filled length and the knob riding on it.
    for (const fill of this._container.querySelectorAll("[data-fill='media']")) {
      fill.style.width = `${pct}%`;
    }
    for (const knob of this._container.querySelectorAll("[data-knob='media']")) {
      knob.style.left = `${pct}%`;
    }
    for (const el of this._container.querySelectorAll("[data-time='elapsed']")) {
      el.textContent = helpers.formatTime(position);
    }
    for (const el of this._container.querySelectorAll("[data-time='remaining']")) {
      el.textContent = helpers.remainingLabel(position, duration);
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
      // A redraw held back during typing must not wait for the next change
      // in the house to be allowed through.
      this._flushPendingRender();
    }, 2000);
    // A demo's countdowns move faster than the state poll. The engine sends
    // the phase's start and end as timestamps, so the numbers in between are
    // arithmetic — no extra traffic, no re-render.
    this._demoTimer = setInterval(() => this._tickDemo(), 250);
    // The phone's back gesture and the browser's back button arrive here.
    this._popListener = () => this._onPopState();
    this._keyListener = (event) => this._onKeyDown(event);
    window.addEventListener("popstate", this._popListener);
    window.addEventListener("keydown", this._keyListener);
  }

  disconnectedCallback() {
    if (this._timer) clearInterval(this._timer);
    if (this._demoTimer) clearInterval(this._demoTimer);
    if (this._searchTimer) clearTimeout(this._searchTimer);
    if (this._previewTimer) clearTimeout(this._previewTimer);
    if (this._personTimer) clearTimeout(this._personTimer);
    if (this._demoToastTimer) clearTimeout(this._demoToastTimer);
    if (this._popListener) window.removeEventListener("popstate", this._popListener);
    if (this._keyListener) window.removeEventListener("keydown", this._keyListener);
    // The card is off screen; the trail it left is no longer anybody's back
    // button, and the entries it pushed now belong to whatever replaced it.
    this._nav = [];
    this._browserTokens = [];
    this._skipPop = 0;
  }

  /**
   * Advance a running demo's countdown and clip bar between state polls.
   *
   * Only the nodes that carry a number are touched; rebuilding the overlay
   * four times a second would fight every tap.
   */
  _tickDemo() {
    if (!this._container) return;
    const run = this._runningDemo;
    if (!run) return;
    const now = Date.now();
    const ends = run.phaseEndsAt;
    for (const el of this._container.querySelectorAll("[data-demo='countdown']")) {
      const left = ends ? Math.max(0, Math.ceil((ends - now) / 1000)) : 0;
      el.textContent = ends ? `Weiter in ${left} s` : "";
    }
    const clip = this._demoClipProgress();
    if (!clip) return;
    for (const bar of this._container.querySelectorAll("[data-demo='bar'] > div")) {
      bar.style.width = `${clip.fraction * 100}%`;
    }
    for (const el of this._container.querySelectorAll("[data-demo='pos']")) {
      el.textContent = helpers.formatTimecode(clip.positionMs);
    }
    for (const el of this._container.querySelectorAll("[data-demo='left']")) {
      el.textContent = `noch ${helpers.formatTimecode(clip.remainingMs)}`;
    }
    for (const el of this._container.querySelectorAll("[data-demo='total']")) {
      el.textContent = `Showcase: noch ~${helpers.formatTimecode(
        this._demoShowcaseRemaining(clip.remainingMs)
      )}`;
    }
  }

  /**
   * Where the running clip stands, from the player's own position.
   *
   * Not from the phase's predicted end: that end is re-derived from every
   * position sample, so a player repeating the same number for a second
   * pushes it forward — and a fraction measured against a receding end walks
   * backwards, which is exactly the bar that would not sit still. The
   * position and the instant it was read do not move on their own; the clock
   * in here carries them, the same way the film's own bar is carried.
   */
  _demoClipProgress() {
    const run = this._runningDemo;
    if (!run) return null;
    const clip = run.clip || {};
    // In A/B a long clip is cut short, so the stretch being played is the
    // engine's, not the clip's own.
    const start = run.spanStartMs != null ? run.spanStartMs : clip.startMs;
    const end = run.spanEndMs != null ? run.spanEndMs : clip.endMs;
    if (!(end > start)) return null;
    const span = end - start;

    let positionMs;
    if (run.positionMs != null) {
      // A paused demo is a still frame: nothing to carry forward.
      const since =
        run.paused || !run.positionAtMs ? 0 : Math.max(0, Date.now() - run.positionAtMs);
      positionMs = run.positionMs + since;
    } else if (run.phase === "playing" && run.phaseEndsAt > Date.now()) {
      // Playing, but no sample has come back yet. The predicted end is the
      // only thing to go on until one does.
      positionMs = end - (run.phaseEndsAt - Date.now());
    } else {
      return null;
    }

    const elapsed = Math.min(span, Math.max(0, positionMs - start));
    return {
      positionMs: start + elapsed,
      remainingMs: span - elapsed,
      fraction: this._demoBarFraction(run, elapsed / span, span),
    };
  }

  /**
   * The bar's width, held against the player's own small corrections.
   *
   * A position that arrives a beat lower than the last one is the player
   * rounding, not a jump; letting that through makes the bar twitch. A real
   * seek — replaying the clip, nudging back ten seconds — moves further than
   * that and is meant to be seen.
   */
  _demoBarFraction(run, fraction, span) {
    const clip = run.clip || {};
    const key = `${run.index}:${clip.id || ""}:${run.spanStartMs}`;
    const last = this._demoBar;
    if (!last || last.key !== key) {
      this._demoBar = { key, fraction };
      return fraction;
    }
    const backwardsMs = (last.fraction - fraction) * span;
    const held = backwardsMs > 0 && backwardsMs < 1500 ? last.fraction : fraction;
    this._demoBar = { key, fraction: held };
    return held;
  }

  /** What is left of the whole showcase: this clip, then the ones after it. */
  _demoShowcaseRemaining(clipRemainingMs) {
    const run = this._runningDemo;
    if (!run) return 0;
    const gap = (run.gapSeconds || 0) * 1000;
    const rest = (run.clips || [])
      .slice(run.index + 1)
      .reduce((sum, c) => sum + (c.durationMs || 0) + gap, 0);
    return clipRemainingMs + rest;
  }

  /** The demo the engine reports as running, or null. */
  get _runningDemo() {
    return (this._kino && this._kino.demo && this._kino.demo.running) || null;
  }

  /** Ask for a clip, and mark it as wanted until the engine gets there. */
  async _demoJump(index) {
    const run = this._runningDemo;
    if (!run || index < 0 || index >= run.count) return;
    this._demoJumpTo = index;
    this._demoJumpAt = Date.now();
    this._render();
    await this._demoControl("jump", index);
  }

  /**
   * Drop the optimistic highlight once the engine has caught up.
   *
   * Returns whether anything changed, because the state payload around it may
   * be identical and this still needs to reach the screen.
   */
  _settleDemoJump() {
    if (this._demoJumpTo == null) return false;
    const run = this._runningDemo;
    const arrived = !run || run.index === this._demoJumpTo;
    // A wanted clip that never arrives must not stay lit for ever.
    const staleAfterMs = 20000;
    if (!arrived && Date.now() - (this._demoJumpAt || 0) < staleAfterMs) return false;
    this._demoJumpTo = null;
    return true;
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
        this._searchQuery(),
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
      case "runtime":
        return f.runtimeFrom != null || f.runtimeTo != null ? 1 : 0;
      default:
        return 0;
    }
  }

  /* -- navigation ------------------------------------------------------ */

  /**
   * Remember where we are standing, before going somewhere else.
   *
   * Every forward move calls this, which is what lets "Zurück", "Schließen",
   * "Beenden", the phone's back gesture and Escape all be the same operation:
   * put back what was on screen a moment ago. The card used to send each of
   * them to a fixed starting point instead, so reaching a title from the
   * Demos tab and closing it dropped you on the home screen.
   */
  _navPush(onBack = null) {
    const snapshot = {};
    for (const key of NAV_KEYS) {
      const value = this._view[key];
      // `filters` is plain data that the filter sheet edits in place, so
      // keeping the reference would not be a snapshot of anything. The rest
      // is either replaced wholesale or read-only from here.
      snapshot[key] =
        key === "filters" && value ? JSON.parse(JSON.stringify(value)) : value;
    }
    this._nav.push({
      view: snapshot,
      // The grid's results belong to the view that fetched them: returning to
      // a filtered library must not show the next view's results under the
      // previous view's filters.
      library: { ...this._library },
      scrollTop: this._scrollTop(),
      // A view whose changes are meant to outlive it says how to leave. The
      // filter sheet is a form: backing out of it applies the selection, so
      // putting the snapshot back would undo the very thing it is for.
      onBack,
    });
    if (this._nav.length > NAV_DEPTH) this._nav.shift();
    this._pushBrowserEntry();
  }

  /**
   * Forget the step back into the current view, because it was left another
   * way — "speichern" and "löschen" close their editor themselves.
   */
  _navDrop() {
    if (!this._nav.length) return;
    this._nav.pop();
    this._consumeBrowserEntry();
  }

  _scrollTop() {
    const scroller = this._container && this._container.querySelector(".scroller");
    return scroller ? scroller.scrollTop : 0;
  }

  /**
   * Step back one view.
   *
   * Returns false when there is nowhere to go — the caller's own fallback
   * then decides what "back" means from the very first screen.
   */
  _navBack(fromPopState = false) {
    if (this._closeTransient()) {
      // A menu or a confirmation is dismissed by the gesture, not stepped out
      // of, so the history entry it borrowed goes straight back.
      if (fromPopState) this._pushBrowserEntry();
      this._render();
      return true;
    }
    const previous = this._nav.pop();
    if (!previous) return false;
    if (previous.onBack) {
      previous.onBack();
    } else {
      Object.assign(this._view, previous.view);
      this._library = previous.library;
      this._restoreScrollTo = previous.scrollTop;
    }
    if (!fromPopState) this._consumeBrowserEntry();
    this._render();
    return true;
  }

  /** Dismiss the topmost of the activity menu and the power confirmation. */
  _closeTransient() {
    for (const key of TRANSIENT_KEYS) {
      if (this._view[key]) {
        this._view[key] = false;
        return true;
      }
    }
    return false;
  }

  /**
   * Leave the current view, or do `fallback` when it is the only one.
   *
   * This is what every close button calls. The fallback is where that button
   * used to go unconditionally.
   */
  _navClose(fallback) {
    if (this._navBack()) return;
    if (fallback) fallback();
    this._render();
  }

  /**
   * Claim one browser history entry per forward move.
   *
   * The URL is deliberately unchanged — Home Assistant owns the address bar.
   * The entry exists so the phone's back gesture has something of ours to
   * pop instead of leaving the dashboard.
   */
  _pushBrowserEntry() {
    if (typeof window === "undefined" || !window.history) return;
    this._navToken += 1;
    try {
      window.history.pushState(
        { kinoCard: this._navToken },
        "",
        window.location.href
      );
    } catch (err) {
      // Some embeddings forbid it. The in-card back buttons still work.
      return;
    }
    this._browserTokens.push(this._navToken);
  }

  /** Give back the entry belonging to a step the card itself just undid. */
  _consumeBrowserEntry() {
    const token = this._browserTokens.pop();
    if (token == null || typeof window === "undefined" || !window.history) return;
    const state = window.history.state;
    // Somebody navigated on top of ours; going back would undo their move.
    if (!state || state.kinoCard !== token) return;
    this._skipPop += 1;
    try {
      window.history.back();
    } catch (err) {
      this._skipPop -= 1;
    }
  }

  _onPopState() {
    if (this._skipPop > 0) {
      this._skipPop -= 1;
      return;
    }
    // Not one of ours: Home Assistant's own routing, left well alone.
    if (!this._browserTokens.length) return;
    this._browserTokens.pop();
    this._navBack(true);
  }

  /** Close the filter sheet and show what was chosen — see `_navPush`. */
  async _closeFilters() {
    this._view.filterSheet = false;
    this._filterPreview = null;
    this._render();
    await this._loadLibrary();
  }

  /** Escape leaves the sheet on screen — but only when one is on screen. */
  _onKeyDown(event) {
    if (event.key !== "Escape") return;
    const view = this._view;
    const open =
      view.detailId ||
      view.playingOpen ||
      view.filterSheet ||
      view.trim ||
      view.scEdit ||
      view.abSetup ||
      view.powerConfirm ||
      view.activityMenu;
    if (!open) return;
    event.preventDefault();
    this._navBack();
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
      // Deliberately not short-circuited: the highlight has to be settled
      // against the new state whether or not anything else moved.
      const settled = this._settleDemoJump();
      if (changed || settled) this._renderPassive();
      // Fetches only when the title changed, so the poll stays one request.
      this._syncPlayingItem();
    } catch (err) {
      this._error = err.message || "Kino ist nicht erreichbar";
      this._renderPassive();
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
        runtimeMin: null,
        runtimeMax: null,
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
    this._appliedQuery = this._searchQuery();
    // Which load this is. A search typed on while the NAS wakes its disks can
    // have two of them in flight, and the older answer must not land last and
    // put the earlier word's titles under the later word.
    const token = (this._libraryToken || 0) + 1;
    this._libraryToken = token;
    this._paintLibrary();
    const offset = append ? this._library.items.length : 0;
    try {
      const message = helpers.queryFromFilters(
        this._view.filters,
        this._view.category,
        this._appliedQuery,
        this._view.sort,
        offset,
        PAGE_SIZE,
        this._view.sortDir
      );
      const page = await this._ws(message);
      if (this._libraryToken !== token) return;
      this._library = {
        items: append ? [...this._library.items, ...page.items] : page.items,
        total: page.total,
        hasMore: page.hasMore,
        loading: false,
        error: null,
      };
    } catch (err) {
      if (this._libraryToken !== token) return;
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
    this._paintLibrary();
  }

  /**
   * What the library is actually searched for.
   *
   * One or two letters are not a search — the grid keeps showing everything
   * until the third one arrives (`SEARCH_MIN_CHARS`), and deleting back down
   * to two brings the whole catalogue back.
   */
  _searchQuery() {
    const typed = (this._view.query || "").trim();
    return typed.length >= SEARCH_MIN_CHARS ? typed : "";
  }

  /**
   * Show the results without rebuilding the card around them.
   *
   * The search field sits above the grid, and every page of results used to
   * arrive as a full re-render — which replaced the input mid-word. Only the
   * grid and its count line ever change here, so only those are rewritten;
   * the field, its caret and the keyboard attached to it are never touched.
   *
   * Everything else that loads the library (a category, a filter, a sort)
   * renders the whole view itself first, so the toolbar above is already
   * current by the time the results land.
   */
  _paintLibrary() {
    const grid =
      this._container && this._container.querySelector('[data-role="library-grid"]');
    if (!grid || this._view.main !== "library") {
      this._render();
      return;
    }
    grid.innerHTML = this._renderLibraryGrid();
    const count = this._container.querySelector('[data-role="library-count"]');
    if (count) count.innerHTML = this._renderLibraryCount();
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

  /**
   * Keep the playback view's catalogue entry in step with what is playing.
   *
   * `nowPlaying` carries only what the player could match — an id and a
   * title. Handlung, Besetzung and the format badges live on the catalogue
   * entry, so it is fetched once per title and then left alone: the state
   * poll runs every two seconds and must not turn into three requests.
   *
   * A film Kino could not match has no id, and the view falls back to what
   * the player entity itself reports.
   */
  async _syncPlayingItem() {
    const id = ((this._kino && this._kino.nowPlaying) || {}).id || null;
    if (id === this._view.playingItemId) return;
    this._view.playingItemId = id;
    this._view.playingItem = null;
    this._view.playingSimilar = null;
    this._view.playingOverviewOpen = false;
    if (!id) {
      this._renderPassive();
      return;
    }
    this._loadPlayingSimilar(id);
    try {
      const item = await this._ws({ type: "kino/library/item", item_id: id });
      // The film may already have ended while this was on the wire.
      if (this._view.playingItemId !== id) return;
      this._view.playingItem = item;
    } catch (err) {
      // Not fatal: the transport is what this view is for, and it needs
      // nothing from the catalogue.
      this._view.playingItem = null;
    }
    this._renderPassive();
  }

  /** The playback view's "Mehr wie dieser Titel" row. */
  async _loadPlayingSimilar(itemId) {
    try {
      const result = await this._ws({
        type: "kino/library/similar",
        item_id: itemId,
        limit: 12,
      });
      if (this._view.playingItemId !== itemId) return;
      this._view.playingSimilar = result.items || [];
    } catch (err) {
      this._view.playingSimilar = [];
    }
    this._renderPassive();
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
  /** Open one title's detail sheet and fetch what it needs. */
  async _openDetail(itemId) {
    const view = this._view;
    view.detailId = itemId;
    view.detail = null;
    view.seasons = null;
    view.seasonId = null;
    view.episodes = null;
    view.similar = null;
    view.overviewOpen = false;
    view.tracksExpanded = {};
    this._render();
    // Runs alongside the item fetch; it re-checks the open detail ID.
    this._loadSimilar(itemId);
    try {
      view.detail = await this._ws({ type: "kino/library/item", item_id: itemId });
    } catch (err) {
      view.detail = null;
      this._actionError = err.message;
    }
    this._render();
    // A show browses on: season strip, then that season's episodes (F2).
    if (view.detail && view.detail.kind === "show") {
      await this._loadSeasons(view.detail.id);
    }
  }

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
    this._renderPassive();
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
    this._renderPassive();
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
    this._renderPassive();
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
   * Jump to the spot on the scrubber that was tapped.
   *
   * The whole 24px strip is the target, not the 5px track, so a thumb hits
   * it; the fraction is measured against the track inside it, which is what
   * the fill and the knob are drawn against.
   *
   * Landing exactly on the end would stop the film, so the last second is
   * kept — same guard as the ±10 s buttons.
   */
  async _seekToFraction(strip, event) {
    const track = strip.querySelector(".track") || strip;
    const box = track.getBoundingClientRect();
    if (!box.width) return;
    const state = this._hass.states[this._playerEntity];
    const duration = state && state.attributes.media_duration;
    if (!duration) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    await this._player("media_seek", {
      seek_position: Math.min(duration * fraction, duration - 1),
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

  /* -- demo mode ------------------------------------------------------ */

  /**
   * Fetch clips, showcases and the tag vocabulary.
   *
   * The two-second state poll carries only the running demo and the two
   * numbers the capture button needs; the dataset itself is asked for when
   * something is about to show it.
   */
  async _loadDemo(force = false) {
    if (!force && Date.now() - this._demoAt < 30000) return;
    try {
      const data = await this._ws({ type: "kino/demo/data" });
      this._demo = data;
      this._demoAt = Date.now();
    } catch (err) {
      this._actionError = err.message || "Demos sind nicht erreichbar";
    }
    this._render();
  }

  /**
   * The demo dataset, empty until it has been fetched.
   *
   * The detail sheet renders long before anything asks for clips, so every
   * reader goes through here rather than assuming the fetch has happened.
   */
  get _demoData() {
    return this._demo || { clips: [], showcases: [], vocabulary: [], options: {} };
  }

  _clipById(clipId) {
    return (this._demoData.clips || []).find((c) => c.id === clipId) || null;
  }

  /** Every clip of one title — the detail sheet's own entry point. */
  _clipsOf(itemId) {
    return (this._demoData.clips || []).filter((c) => c.itemId === itemId);
  }

  async _demoWs(message, failure) {
    try {
      return await this._ws(message);
    } catch (err) {
      this._actionError = err.message || failure;
      this._render();
      return null;
    }
  }

  _toast(text) {
    this._demoToast = text;
    if (this._demoToastTimer) clearTimeout(this._demoToastTimer);
    this._demoToastTimer = setTimeout(() => {
      this._demoToast = "";
      this._render();
    }, 4000);
  }

  /**
   * Open the trim editor on a span of the title that is playing.
   *
   * The retro capture is the path that gets used: a scene only reveals
   * itself as demo material once it is over, so the span ends at the
   * current position and reaches back the configured window.
   */
  _captureFromPlayer() {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    if (!state) return;
    const position = this._position(state);
    const window = (this._kino.demo && this._kino.demo.retroCaptureSeconds) || 60;
    const item = this._kino.nowPlaying || {};
    this._openTrim({
      itemId: item.id || null,
      title: state.attributes.media_title || item.title || "",
      startMs: Math.max(0, Math.round((position - window) * 1000)),
      endMs: Math.max(2000, Math.round(position * 1000)),
    });
  }

  /** Take a whole title as one clip — the detail sheet's entry point. */
  _captureWholeTitle(item) {
    if (!item) return;
    this._openTrim({
      itemId: item.id,
      title: item.title,
      path: item.path || null,
      startMs: 0,
      endMs: Math.max(2000, (item.runtime || 1) * 60000),
    });
  }

  /**
   * Seed the trim editor.
   *
   * Audio and subtitle default to whatever the player has selected right
   * now, because that is nearly always what the clip wants — the common
   * case needs no input at all.
   */
  _openTrim(seed) {
    const audio = this._entity("audioTrack");
    const subtitle = this._entity("subtitleTrack");
    const currentOf = (id) => {
      const state = id ? this._hass.states[id] : null;
      return state && state.state !== "unknown" && state.state !== "unavailable"
        ? state.state
        : null;
    };
    const existing = seed.id ? this._clipById(seed.id) : null;
    this._view.trim = {
      id: seed.id || null,
      itemId: seed.itemId || null,
      path: seed.path || null,
      title: seed.title || "",
      start: helpers.formatTimecode(seed.startMs || 0),
      end: helpers.formatTimecode(seed.endMs || 0),
      name: existing ? existing.name : "",
      tags: existing ? [...existing.tags] : [],
      notes: existing ? existing.notes || "" : "",
      tagInput: "",
      audioTrack: existing ? existing.audioTrack : currentOf(audio),
      subtitleTrack: existing ? existing.subtitleTrack : currentOf(subtitle),
      // The scope chips nudge relative to the end the capture arrived with.
      anchorMs: seed.endMs || 0,
      previewAt: null,
      previewing: false,
    };
    this._render();
  }

  _openClipEdit(clipId) {
    const clip = this._clipById(clipId);
    if (!clip) return;
    this._openTrim({
      id: clip.id,
      itemId: clip.itemId,
      path: clip.path,
      title: clip.title,
      startMs: clip.startMs,
      endMs: clip.endMs,
    });
  }

  get _trimSpan() {
    const trim = this._view.trim;
    if (!trim) return { start: null, end: null, valid: false };
    const start = helpers.parseTimecode(trim.start);
    const end = helpers.parseTimecode(trim.end);
    return { start, end, valid: start != null && end != null && end > start };
  }

  _setTrimSpan(startMs, endMs) {
    const trim = this._view.trim;
    if (!trim) return;
    trim.start = helpers.formatTimecode(Math.max(0, startMs));
    trim.end = helpers.formatTimecode(Math.max(0, endMs));
    this._render();
  }

  /** ±5 s / ±1 s on one end — the same value the text field writes. */
  _nudgeTrim(which, deltaSeconds) {
    const { start, end } = this._trimSpan;
    const current = which === "start" ? start : end;
    if (current == null) return;
    const next = Math.max(0, current + deltaSeconds * 1000);
    if (which === "start") this._setTrimSpan(next, end ?? next);
    else this._setTrimSpan(start ?? 0, next);
  }

  /** Move the whole span without changing its length. */
  _shiftTrim(deltaSeconds) {
    const { start, end, valid } = this._trimSpan;
    if (!valid) return;
    const offset = Math.max(deltaSeconds * 1000, -start);
    this._setTrimSpan(start + offset, end + offset);
  }

  async _saveClip() {
    const trim = this._view.trim;
    const { start, end, valid } = this._trimSpan;
    if (!trim || !valid) return;
    const payload = {
      id: trim.id || undefined,
      itemId: trim.itemId,
      path: trim.path,
      title: trim.title,
      startMs: start,
      endMs: end,
      name: trim.name,
      tags: trim.tags,
      notes: trim.notes,
      audioTrack: trim.audioTrack,
      subtitleTrack: trim.subtitleTrack,
    };
    const result = await this._demoWs(
      { type: "kino/demo/clip/save", clip: payload },
      "Clip konnte nicht gespeichert werden"
    );
    if (!result) return;
    // Saved, so the editor is gone for good: the step back into it goes too.
    this._navDrop();
    this._view.trim = null;
    this._toast(
      trim.id ? "Clip aktualisiert." : "Clip gespeichert — zu finden unter Demos."
    );
    await this._loadDemo(true);
  }

  async _deleteClip() {
    const trim = this._view.trim;
    if (!trim || !trim.id) return;
    const result = await this._demoWs(
      { type: "kino/demo/clip/delete", clip_id: trim.id },
      "Clip konnte nicht gelöscht werden"
    );
    if (!result) return;
    this._navDrop();
    this._view.trim = null;
    await this._loadDemo(true);
  }

  /**
   * Play across the cut so it can be checked without scrubbing.
   *
   * Seeks are keyframe-bound, so this is what tells you whether the start
   * actually landed where the number says.
   */
  async _previewCut(positionMs) {
    const trim = this._view.trim;
    if (!trim || !trim.itemId) return;
    trim.previewing = true;
    trim.previewAt = positionMs;
    this._render();
    const result = await this._demoWs(
      {
        type: "kino/demo/preview",
        item_id: trim.itemId,
        position_ms: Math.max(0, Math.round(positionMs)),
        path: trim.path || null,
      },
      "Die Vorschau konnte nicht gestartet werden"
    );
    if (this._view.trim) this._view.trim.previewing = false;
    if (result) this._render();
  }

  _openShowcaseEditor(showcaseId) {
    const showcase = (this._demoData.showcases || []).find((s) => s.id === showcaseId);
    this._view.scEdit = showcase
      ? {
          id: showcase.id,
          name: showcase.name,
          clips: [...showcase.clips],
          advance: showcase.advance,
          gapSeconds: showcase.gapSeconds,
          referenceVolumeDb:
            showcase.referenceVolumeDb == null ? -18 : showcase.referenceVolumeDb,
        }
      : {
          id: null,
          name: "",
          clips: [],
          advance: "auto",
          gapSeconds: 8,
          referenceVolumeDb: -18,
        };
    this._render();
  }

  async _saveShowcase() {
    const edit = this._view.scEdit;
    if (!edit || !edit.name.trim() || !edit.clips.length) return;
    const result = await this._demoWs(
      {
        type: "kino/demo/showcase/save",
        showcase: {
          id: edit.id || undefined,
          name: edit.name.trim(),
          clips: edit.clips,
          advance: edit.advance,
          gapSeconds: edit.gapSeconds,
          referenceVolumeDb: edit.referenceVolumeDb,
        },
      },
      "Showcase konnte nicht gespeichert werden"
    );
    if (!result) return;
    this._navDrop();
    this._view.scEdit = null;
    await this._loadDemo(true);
  }

  async _deleteShowcase() {
    const edit = this._view.scEdit;
    if (!edit || !edit.id) return;
    const result = await this._demoWs(
      { type: "kino/demo/showcase/delete", showcase_id: edit.id },
      "Showcase konnte nicht gelöscht werden"
    );
    if (!result) return;
    this._navDrop();
    this._view.scEdit = null;
    await this._loadDemo(true);
  }

  async _playDemo(message) {
    const result = await this._demoWs(message, "Die Demo konnte nicht starten");
    if (result) await this._refreshState();
  }

  async _demoControl(action, index) {
    await this._demoWs(
      { type: "kino/demo/control", action, ...(index == null ? {} : { index }) },
      "Die Steuerung ist nicht angekommen"
    );
    await this._refreshState();
  }

  _openAbSetup(clipId) {
    const options = this._demoData.options || {};
    const presets = options.presets || [];
    this._view.abSetup = {
      clipId,
      blind: true,
      a: { preset: presets[0] || "", madvr: "", barco: "" },
      b: { preset: presets[1] || presets[0] || "", madvr: "", barco: "" },
    };
    this._render();
  }

  /** Drop the empty fields: an unset side must not be "applied" as blank. */
  _abConfig(side) {
    const out = {};
    for (const [key, value] of Object.entries(side)) {
      if (value !== "" && value != null) out[key] = value;
    }
    return out;
  }

  async _startAb() {
    const setup = this._view.abSetup;
    if (!setup) return;
    const result = await this._demoWs(
      {
        type: "kino/demo/ab_start",
        clip_id: setup.clipId,
        a: this._abConfig(setup.a),
        b: this._abConfig(setup.b),
        blind: setup.blind,
      },
      "Der Vergleich konnte nicht starten"
    );
    if (!result) return;
    this._navDrop();
    this._view.abSetup = null;
    await this._refreshState();
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
      // Focus moves after `focusout` fires, so ask on the next turn where it
      // ended up: leaving one field for another is still typing.
      this._container.addEventListener("focusout", () => {
        setTimeout(() => this._flushPendingRender(), 0);
      });
      // Scroll does not bubble, so listen in the capture phase — the
      // scroller element itself is replaced on every render.
      this._container.addEventListener("scroll", (e) => this._onScroll(e), true);
    }
    this._renderPending = false;

    if (!this._kino) {
      this._container.innerHTML = `
        <div class="empty">
          <p>${this._error ? this._esc(this._error) : "Kino wird geladen…"}</p>
          ${this._error ? '<p class="sub">Ist die Kino-Integration eingerichtet?</p>' : ""}
        </div>`;
      return;
    }

    // A back step puts its own scroll position back; every other render keeps
    // the one already on screen.
    const scrollTop =
      this._restoreScrollTo != null ? this._restoreScrollTo : this._scrollTop();
    this._restoreScrollTo = null;
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
    const demoRun = this._runningDemo;
    const sheetOpen =
      this._view.detailId ||
      this._view.playingOpen ||
      this._view.filterSheet ||
      this._view.trim ||
      this._view.scEdit ||
      this._view.abSetup ||
      demoRun;
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
      // A running demo owns the screen: it sits above the detail and playing
      // sheets, so tapping a clip's title while one runs cannot bury it.
      demoRun ? this._renderDemoRun() : "",
      demoRun ? this._renderAbRun() : "",
      this._view.trim ? this._renderTrimSheet() : "",
      this._view.scEdit ? this._renderShowcaseEditor() : "",
      this._view.abSetup ? this._renderAbSetup() : "",
      this._view.powerConfirm ? this._renderPowerConfirm() : "",
    ].join("");
    this._signature = this._renderSignature();
    // Every render rebuilds the bars from the last state payload, which is up
    // to two seconds old. Writing the live numbers back in the same frame is
    // what keeps a re-render from being visible as a stutter.
    this._tick();
    this._tickDemo();
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
    if (this._view.main === "demos") return this._renderDemos();
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
          <button class="tile" style="text-align:center" data-act="open-demos">Demos</button>
        </div>
      </div>
      ${resumeRow}
      ${favoriteRow}
      ${recentRow}`;
  }

  /* -- demo mode: the Demos tab --------------------------------------- */

  _renderDemos() {
    const tab = this._view.demoTab;
    const chip = (key, label) =>
      `<button class="pill" data-act="demo-tab" data-key="${key}"
         aria-pressed="${tab === key}">${label}</button>`;
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <a class="link" data-act="back-home">‹ Zurück</a>
        <h2 style="margin:0;flex:1">Demos</h2>
      </div>
      <div class="row" style="margin-bottom:12px;justify-content:flex-start">
        ${chip("clips", "Clips")}${chip("showcases", "Showcases")}
      </div>
      ${tab === "clips" ? this._renderClipList() : this._renderShowcaseList()}`;
  }

  /**
   * The clip library, filtered by tag.
   *
   * Tags carry their own count, and a chip that would empty the list is not
   * offered at all — the same honesty the library's facets follow.
   */
  _renderClipList() {
    const selected = this._view.demoTagFilter;
    const clips = (this._demoData.clips || []).filter((c) =>
      selected.every((tag) => c.tags.includes(tag))
    );
    const counts = {};
    for (const clip of this._demoData.clips || []) {
      for (const tag of clip.tags) counts[tag] = (counts[tag] || 0) + 1;
    }
    const vocabulary = this._demoData.vocabulary || [];
    const known = vocabulary.map((v) => v.key);
    const keys = [...known, ...Object.keys(counts).filter((k) => !known.includes(k))]
      .filter((k) => counts[k] || selected.includes(k))
      .sort((a, b) => (counts[b] || 0) - (counts[a] || 0));

    if (!(this._demoData.clips || []).length) {
      return `<div class="empty">
        <p>Noch keine Demo-Clips.</p>
        <p class="sub">Während der Wiedergabe auf „Demo erstellen“ tippen — der
          Ausschnitt wird rückwirkend übernommen.</p>
      </div>`;
    }

    return `
      <div style="margin-bottom:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <span class="label" style="margin:0">Nach Tags filtern</span>
          ${selected.length ? '<a class="link" data-act="demo-tags-clear">Zurücksetzen</a>' : ""}
        </div>
        <div class="chipwrap">
          ${keys
            .map(
              (key) => `<button class="pill" data-act="demo-tag" data-key="${this._esc(key)}"
                 aria-pressed="${selected.includes(key)}">${this._esc(
                   helpers.tagLabel(key, vocabulary)
                 )}<span class="chipcount">${counts[key] || 0}</span></button>`
            )
            .join("")}
        </div>
      </div>
      <div style="font-size:11px;color:var(--kino-text3);margin-bottom:12px">
        ${clips.length} ${clips.length === 1 ? "Clip" : "Clips"}
      </div>
      <div class="sclist">
        ${clips.map((clip) => this._clipCard(clip)).join("") ||
          '<p class="empty">Kein Clip trägt alle gewählten Tags.</p>'}
      </div>`;
  }

  _clipCard(clip) {
    const art = clip.itemId
      ? helpers.artworkUrl(clip.itemId, "Primary", this._kino.artworkSignature)
      : null;
    const vocabulary = this._demoData.vocabulary || [];
    return `<div class="clipcard" data-act="demo-clip-edit" data-key="${this._esc(clip.id)}">
      <div class="head">
        <div class="art">
          ${art ? `<img loading="lazy" src="${art}" alt="" onerror="this.style.display='none'">` : ""}
        </div>
        <div class="body">
          <div class="name">${this._esc(clip.name)}</div>
          <div class="range">${this._esc(
            [clip.start + "–" + clip.end, clip.duration, helpers.displayLabel(clip.audioTrack)]
              .filter((p) => p && p !== "—")
              .join(" · ")
          )}</div>
          ${
            clip.itemId
              ? `<a class="link" style="display:inline-block;margin-top:4px"
                   data-act="demo-open-title" data-key="${this._esc(clip.itemId)}"
                   >${this._esc(clip.title || "Titel")} ›</a>`
              : ""
          }
        </div>
      </div>
      ${
        clip.tags.length
          ? `<div class="chipwrap" style="margin-top:10px">${clip.tags
              .map((t) => `<span class="tagchip">${this._esc(helpers.tagLabel(t, vocabulary))}</span>`)
              .join("")}</div>`
          : ""
      }
      ${clip.notes ? `<p class="notes">${this._esc(clip.notes)}</p>` : ""}
      <div class="row" style="margin-top:12px">
        <button class="primary" style="flex:1;padding:10px;font-size:12px"
          data-act="demo-play-clip" data-key="${this._esc(clip.id)}">▶ Abspielen</button>
        <button class="ghost" style="width:auto;padding:10px 14px;font-size:12px"
          data-act="demo-ab" data-key="${this._esc(clip.id)}">A/B</button>
      </div>
    </div>`;
  }

  _renderShowcaseList() {
    const showcases = this._demoData.showcases || [];
    return `<div class="sclist">
      ${showcases.map((sc) => this._showcaseRow(sc)).join("")}
      <button class="dashed" data-act="demo-showcase-new">＋ Neuer Showcase</button>
      <p class="hint">Showcase antippen, um Name, Reihenfolge und Wiedergabe zu bearbeiten.</p>
    </div>`;
  }

  _showcaseRow(showcase) {
    const clips = showcase.clips
      .map((id) => this._clipById(id))
      .filter(Boolean);
    const total = clips.reduce((sum, c) => sum + c.durationMs, 0);
    const minutes = Math.max(
      1,
      Math.round((total + clips.length * showcase.gapSeconds * 1000) / 60000)
    );
    const meta = [
      `${showcase.clips.length} ${showcase.clips.length === 1 ? "Clip" : "Clips"}`,
      `~${minutes} Min`,
      showcase.advance === "auto" ? "Automatisch" : "Per Tipp",
      showcase.referenceVolumeDb == null
        ? null
        : `Referenz ${showcase.referenceVolumeDb} dB`,
    ]
      .filter(Boolean)
      .join(" · ");
    return `<div class="scrow" data-act="demo-showcase-edit" data-key="${this._esc(showcase.id)}">
      <div style="flex:1;min-width:0">
        <div class="name">${this._esc(showcase.name)}</div>
        <div class="meta">${this._esc(meta)}</div>
      </div>
      <button class="round" style="width:44px;height:44px;border-radius:22px;background:var(--kino-gold);color:var(--kino-goldText);font-size:15px"
        data-act="demo-play-showcase" data-key="${this._esc(showcase.id)}"
        title="Showcase abspielen">▶</button>
    </div>`;
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
      // Real banner art carries its own title lettering, so the caption
      // drops the title there and keeps the meta line — the year, runtime
      // and scores every other layout shows. A fallback backdrop carries no
      // lettering at all and gets both.
      const caption = `<div class="caption">${
        item.bannerTag
          ? ""
          : `<div class="captiontitle">${this._esc(helpers.itemTitle(item))}</div>`
      }${this._metaLine(item)}</div>`;
      return `<div class="bannertile" data-act="open-detail" data-key="${this._esc(item.id)}">
        <div class="art wide bannerart">${img}${caption}${this._artOverlays(item, true)}</div>
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
    if (mode === "list") return `<div class="listrows${size}">${tiles}</div>`;
    if (mode === "banner") return `<div class="bannerlist${size}">${tiles}</div>`;
    if (mode === "thumb" || mode === "thumbCard")
      return `<div class="thumbgrid${size}">${tiles}</div>`;
    return `<div class="postergrid${size}">${tiles}</div>`;
  }

  _renderLibrary() {
    const lib = this._library;
    const filters = this._view.filters;
    const count = helpers.activeFilterCount(filters);
    const yearLabel = helpers.yearRangeLabel(filters.yearFrom, filters.yearTo);
    const runtimeLabel = helpers.runtimeRangeLabel(
      filters.runtimeFrom,
      filters.runtimeTo
    );
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
      ...(runtimeLabel ? [["runtime", runtimeLabel, runtimeLabel]] : []),
    ]
      .map(
        ([kind, value, label]) =>
          `<button class="pill" style="height:30px;font-size:11px;background:transparent;border:1px solid var(--kino-border)"
             data-act="remove-filter" data-kind="${kind}" data-key="${this._esc(value)}">${this._esc(label)} ✕</button>`
      )
      .join("");

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
        <input type="text" data-field="query" placeholder="Titel suchen…"
          value="${this._esc(this._view.query)}" autocomplete="off" spellcheck="false"
          inputmode="search" enterkeyhint="search" style="margin-bottom:12px">
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
          <button class="pill" style="flex:0 0 auto;width:40px;height:40px;padding:0" data-act="grid-size"
            title="Kachelgröße: ${(GRID_SIZES.find(([k]) => k === this._view.gridSize) || GRID_SIZES[2])[1]}">
            ${SIZE_ICON}
          </button>
        </div>
        ${chips ? `<div class="posterrow hscroll" style="margin-bottom:10px">${chips}</div>` : ""}
        <div data-role="library-count"
          style="font-size:11px;color:var(--kino-text3);margin-bottom:12px">${this._renderLibraryCount()}</div>
      </div>
      <div data-role="library-grid">${this._renderLibraryGrid()}</div>`;
  }

  /**
   * How many titles the grid is showing — and, while the field holds one or
   * two letters, why it is still showing all of them.
   */
  _renderLibraryCount() {
    const lib = this._library;
    const typed = (this._view.query || "").trim();
    if (typed.length && typed.length < SEARCH_MIN_CHARS) {
      return `Suche ab ${SEARCH_MIN_CHARS} Zeichen · ${lib.total} Titel`;
    }
    return lib.items.length && lib.items.length < lib.total
      ? `${lib.items.length} von ${lib.total} Titeln`
      : `${lib.total} Titel`;
  }

  /** The titles themselves: the grid, its paging button, or why neither. */
  _renderLibraryGrid() {
    const lib = this._library;
    if (lib.loading && !lib.items.length) {
      return '<p class="empty">Wird geladen…</p>';
    }
    if (lib.error && !lib.items.length) {
      return `<div class="empty">
        <p class="error">${this._esc(lib.error)}</p>
        <p class="sub">Die Festplatten der NAS schlafen vielleicht noch.</p>
        <button class="primary" style="margin-top:14px;max-width:260px" data-act="force-refresh">
          ${this._view.refreshing ? "Wird aktualisiert…" : "Erneut versuchen"}
        </button>
      </div>`;
    }
    if (!lib.items.length) {
      return `<div class="empty"><p>${
        this._view.category === "shows" && !this._searchQuery()
          ? "Noch keine Serien in der Bibliothek."
          : "Keine Treffer"
      }</p></div>`;
    }
    const more = lib.hasMore
      ? `<div class="more">
           <button class="ghost" data-act="load-more" ${lib.loading ? "disabled" : ""}>
             ${lib.loading ? "Wird geladen…" : "Weitere Titel laden"}
           </button>
         </div>`
      : "";
    return `${this._renderItems(lib.items)}${more}
      ${lib.error ? `<p class="error" style="margin-top:12px">${this._esc(lib.error)}</p>` : ""}`;
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
      ${this._filterGroup("runtime", "Laufzeit", this._renderRuntimeRange())}
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

  /** The "… bis …" runtime pair, in minutes, bounded by the facets. */
  _renderRuntimeRange() {
    const f = this._view.filters;
    const steps = helpers.runtimeSteps(this._facets.runtimeMin, this._facets.runtimeMax, [
      f.runtimeFrom,
      f.runtimeTo,
    ]);
    const options = (selected) =>
      `<option value="">–</option>` +
      steps
        .map(
          (m) =>
            `<option value="${m}"${selected === m ? " selected" : ""}>${m} Min</option>`
        )
        .join("");
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <select data-field="runtime-from" style="flex:1">${options(f.runtimeFrom)}</select>
        <span style="color:var(--kino-text3);font-size:13px">bis</span>
        <select data-field="runtime-to" style="flex:1">${options(f.runtimeTo)}</select>
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
          ${this._renderDetailClips(item)}
          ${this._renderTracks(item)}
          ${this._renderPeople(item)}
          ${this._renderSimilar()}
        </div>
      </div>
    </div>`;
  }

  /**
   * The clips this title already has, plus the way to add another.
   *
   * A second natural entry point (spec §7): while browsing, playing one
   * remembered scene should not mean going round by the Demos tab.
   */
  _renderDetailClips(item) {
    if (!item || item.kind === "show" || item.kind === "season") return "";
    const clips = this._clipsOf(item.id);
    const vocabulary = this._demoData.vocabulary || [];
    const rows = clips
      .map(
        (clip) => `<div class="eprow" style="cursor:default">
          <div style="flex:1;min-width:0">
            <div class="title">${this._esc(`${clip.name} · ${clip.start}–${clip.end}`)}</div>
            <div class="meta">${this._esc(
              clip.tags.map((t) => helpers.tagLabel(t, vocabulary)).join(" · ") || "Ohne Tags"
            )}</div>
          </div>
          <button class="round" data-act="demo-play-clip" data-key="${this._esc(clip.id)}"
            title="Clip abspielen">▶</button>
        </div>`
      )
      .join("");
    return `
      ${clips.length ? `<div class="label" style="margin-top:20px">Demo-Clips</div>${rows}` : ""}
      <div style="text-align:center;margin-top:14px">
        <a class="link" style="color:var(--kino-text3);font-size:11px"
          data-act="demo-capture-title" data-key="${this._esc(item.id)}"
          >＋ Ganzen Titel als Demo-Clip übernehmen</a>
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

  /**
   * "Mehr wie dieser Titel" — Jellyfin's similar list, tap to drill on.
   *
   * The detail sheet and the player view each keep their own list, because
   * both can be on screen at once: opening a similar title from the player
   * stacks its detail sheet on top, and that sheet's row must not be the row
   * underneath it.
   */
  _renderSimilar(similar = this._view.similar) {
    if (!similar || !similar.length) return "";
    return `<div class="section" style="margin-top:22px">
      <h3>Mehr wie dieser Titel</h3>
      <div class="posterrow hscroll">${similar.map((t) => this._poster(t, false)).join("")}</div>
    </div>`;
  }

  /**
   * The synopsis, clamped to ~4 lines with a "mehr" toggle (F3).
   *
   * `key` names the flag the toggle writes. The detail sheet and the player
   * view both show a synopsis and can both be open, so one shared flag would
   * expand the one nobody tapped.
   */
  _renderOverview(item, key = "overviewOpen") {
    if (!item.overview) return "";
    const long = item.overview.length > 220;
    const open = !!this._view[key];
    return `<div class="overviewwrap">
      <p class="overview${long && !open ? " clamped" : ""}" data-act="toggle-overview" data-key="${key}">${this._esc(item.overview)}</p>
      ${long ? `<a class="link" data-act="toggle-overview" data-key="${key}" style="display:inline-block;margin-top:4px">${open ? "weniger" : "mehr"}</a>` : ""}
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

  /**
   * The playback view.
   *
   * The film leads: its backdrop is the hero, its poster is set into the
   * bottom edge of that hero, and the transport sits directly beneath. Below
   * the controls comes what the title itself carries — Handlung, Besetzung &
   * Crew, Mehr wie dieser Titel — so "what are we actually watching" is
   * answered without leaving the playback screen.
   *
   * Two sources feed it. The player entity gives the live parts (position,
   * play state, volume); the catalogue entry behind `nowPlaying` gives the
   * material. When the player is on a file Kino could not match, the entry is
   * absent and the hero falls back to the entity's own title and picture —
   * the transport works either way.
   */
  _renderPlayingSheet() {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    if (!state) return "";
    const attrs = state.attributes;
    const duration = attrs.media_duration || 0;
    const position = this._position(state);
    const pct = duration ? Math.min(100, (position / duration) * 100) : 0;
    const playing = state.state === "playing";
    const playingId = (this._kino.nowPlaying || {}).id || null;
    // The catalogue entry, once it has arrived — see `_syncPlayingItem`.
    const item =
      this._view.playingItem && this._view.playingItem.id === playingId
        ? this._view.playingItem
        : null;
    const title =
      (item && helpers.itemTitle(item)) || attrs.media_title || "Wiedergabe";
    // A 16:9 frame showing a 2:3 poster crops two thirds of it away, so ask
    // for the real backdrop and keep the poster as the fallback.
    const picture = attrs.entity_picture;
    const sig = this._kino.artworkSignature;
    const art = playingId
      ? helpers.artworkUrl(playingId, "Backdrop", sig)
      : picture;
    const fallback =
      art && picture && art !== picture
        ? `this.onerror=null;this.src='${this._esc(picture)}'`
        : "this.style.display='none'";
    const poster = playingId
      ? helpers.artworkUrl(playingId, "Primary", sig)
      : picture;

    return `<div class="sheet hero" data-sheet="playing" style="z-index:30">
      <div class="playhero">
        ${art ? `<img src="${this._esc(art)}" alt="" onerror="${fallback}">` : ""}
        <div class="veil"></div>
        <div class="links">
          <a class="link" style="font-size:13px" data-act="collapse-playing">⌄ Minimieren</a>
          <a class="link quiet" data-act="stop-playing">Wiedergabe beenden</a>
        </div>
      </div>
      <div class="playbody">
        <div class="playhead">
          <div class="playposter">
            ${poster ? `<img src="${this._esc(poster)}" alt="" onerror="this.style.display='none'">` : ""}
          </div>
          <div class="playtitle">
            <h2>${this._esc(title)}</h2>
            ${this._playerMetaLine(item)}
            ${this._playerFormats(item)}
          </div>
        </div>
        <div class="scrub" data-act="seek-to" title="Zu dieser Stelle springen">
          <div class="track">
            <div data-fill="media" style="width:${pct}%"></div>
            <div class="knob" data-knob="media" style="left:${pct}%"></div>
          </div>
        </div>
        <div class="times">
          <span data-time="elapsed">${helpers.formatTime(position)}</span>
          <span class="rest" data-time="remaining">${this._esc(helpers.remainingLabel(position, duration))}</span>
          <span data-time="duration">${helpers.formatTime(duration)}</span>
        </div>
        <div class="transport">
          <button class="round" data-act="transport" data-key="media_previous_track" title="Vorheriger Titel">⏮</button>
          <button class="seek" data-act="seek" data-key="-${SEEK_STEP_SECONDS}" title="10 Sekunden zurück">⟲${SEEK_STEP_SECONDS}</button>
          <button class="play" data-act="transport" data-key="${playing ? "media_pause" : "media_play"}"
            title="${playing ? "Pause" : "Weiter"}">${playing ? "⏸" : "▶"}</button>
          <button class="seek" data-act="seek" data-key="${SEEK_STEP_SECONDS}" title="10 Sekunden vor">${SEEK_STEP_SECONDS}⟳</button>
          <button class="round" data-act="transport" data-key="media_next_track" title="Nächster Titel">⏭</button>
        </div>
        <div class="audiopanel">${this._renderVolumeRow(true)}</div>
        ${this._renderPlayerSelects()}
        ${this._renderPlayingOverview(item)}
        ${this._renderPeople(item || {})}
        ${this._renderSimilar(this._view.playingSimilar)}
        ${this._renderCaptureBlock()}
      </div>
    </div>`;
  }

  /** `2014 · 1 Std 53 Min · Sci-Fi, Action` under the title. */
  _playerMetaLine(item) {
    if (!item) return "";
    const line = [
      item.year,
      helpers.runtimeLabel(item.runtime),
      (item.genres || []).slice(0, 2).join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
    return line ? `<div class="line">${this._esc(line)}</div>` : "";
  }

  /**
   * What the disc actually is: picture, sound, age rating.
   *
   * Outlined rather than filled — they label the file, they are not controls,
   * and the only filled thing on this screen should be the play button.
   */
  _playerFormats(item) {
    const badges = helpers
      .heroBadges(item)
      .map((text) => `<span>${this._esc(text)}</span>`)
      .join("");
    return badges ? `<div class="formats">${badges}</div>` : "";
  }

  /** Klang, Raumklang, Tonspur and Untertitel as one 2×2 block. */
  _renderPlayerSelects() {
    const controls = this._kino.controls || {};
    // "none" is what the Trinnov reports when nothing is upmixed, but it
    // refuses it as a choice — see `_renderSoundSelects`.
    const blocks = [
      [controls.preset, "Klang", []],
      [controls.upmixer, "Raumklang", ["none"]],
      [this._entity("audioTrack"), "Tonspur", []],
      [this._entity("subtitleTrack"), "Untertitel", []],
    ]
      .map(([entityId, label, hidden]) =>
        this._entitySelectBlock(entityId, label, hidden)
      )
      .filter(Boolean);
    if (!blocks.length) return "";
    return `<div class="selgrid">${blocks.join("")}</div>`;
  }

  /** The synopsis, under its own heading and above the cast. */
  _renderPlayingOverview(item) {
    if (!item || !item.overview) return "";
    return `<div class="playsection divided">
      <h3>Handlung</h3>
      ${this._renderOverview(item, "playingOverviewOpen")}
    </div>`;
  }

  /**
   * "That was demo-worthy", from the player view.
   *
   * One button, because that is how it actually happens: a scene reveals
   * itself as reference material only once it is over, so the capture
   * reaches backwards and the trim editor opens on the result.
   *
   * It closes the playback view — the last thing on the screen, under the
   * film's own material, where it reads as an afterthought to watching
   * rather than a second way to start something.
   */
  _renderCaptureBlock() {
    const player = this._playerEntity;
    const state = player ? this._hass.states[player] : null;
    if (!state || !["playing", "paused"].includes(state.state)) return "";
    // No caption: the trim editor opens on the captured span and shows the
    // scope, so what it took is answered there rather than promised here.
    return `<div>
      <button class="ghost" style="width:100%" data-act="demo-capture">⏺ Demo erstellen</button>
      ${this._demoToast ? `<div class="okbox">${this._esc(this._demoToast)}</div>` : ""}
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
    return `<div class="selblock">
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

  /* -- demo mode: the sheets ------------------------------------------ */

  /**
   * The trim editor.
   *
   * Scope chips and nudges write the same two values the text fields do, so
   * the user can type roughly and correct precisely — and the note about
   * keyframes is stated rather than hidden, because seeks land on the
   * nearest one and the start really can be a second or two out.
   */
  _renderTrimSheet() {
    const trim = this._view.trim;
    if (!trim) return "";
    const { start, end, valid } = this._trimSpan;
    const nudges = (which) =>
      [-5, -1, 1, 5]
        .map(
          (d) => `<button data-act="trim-nudge" data-key="${which}:${d}"
             >${d > 0 ? "+" : "−"}${Math.abs(d)} s</button>`
        )
        .join("");
    const vocabulary = this._demoData.vocabulary || [];
    const free = trim.tags.filter((t) => !vocabulary.some((v) => v.key === t));
    const chip = (key, label) =>
      `<button class="pill" data-act="trim-tag" data-key="${this._esc(key)}"
         aria-pressed="${trim.tags.includes(key)}">${this._esc(label)}</button>`;

    return `<div class="sheet" data-sheet="trim" style="z-index:45">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <a class="link" style="color:var(--kino-text3)" data-act="trim-close">Verwerfen</a>
        <h2 style="margin:0;flex:1;text-align:right">${
          trim.id ? "Clip bearbeiten" : "Clip zuschneiden"
        }</h2>
      </div>
      <div style="font-size:12px;color:var(--kino-text2);margin-bottom:14px;text-align:right">
        ${this._esc(trim.title)}
      </div>

      <div class="label">Umfang</div>
      <div class="chipwrap" style="margin-bottom:10px">
        ${[
          ["30", "Letzte 30 s"],
          ["60", "Letzte 60 s"],
          ["120", "Letzte 2 Min"],
        ]
          .map(
            ([key, label]) =>
              `<button class="pill" data-act="trim-scope" data-key="${key}">${label}</button>`
          )
          .join("")}
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:16px">
        <span style="font-size:10px;color:var(--kino-text3);flex-shrink:0">Verschieben</span>
        ${[-60, -30, -10, 10, 30, 60]
          .map(
            (d) => `<button class="pill" style="flex:1;height:28px;padding:0;font-size:10px"
               data-act="trim-shift" data-key="${d}">${d > 0 ? "+" : "−"}${Math.abs(d)}</button>`
          )
          .join("")}
      </div>

      <div class="row" style="margin-bottom:10px">
        <div style="flex:1">
          <div class="label">Start</div>
          <input type="text" class="timefield" data-field="trim-start"
            value="${this._esc(trim.start)}" inputmode="numeric">
          <div class="nudges">${nudges("start")}</div>
        </div>
        <div style="flex:1">
          <div class="label">Ende</div>
          <input type="text" class="timefield" data-field="trim-end"
            value="${this._esc(trim.end)}" inputmode="numeric">
          <div class="nudges">${nudges("end")}</div>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px">
        <span style="font-size:12px;color:var(--kino-text2);font-weight:700"
          data-role="trim-length">Länge: ${
            valid ? helpers.formatTimecode(end - start) : "—"
          }</span>
        <span style="font-size:10px;color:var(--kino-text3)">Eingabe frei: 1:12:04, 72:04 oder Sekunden</span>
      </div>

      ${
        trim.itemId
          ? `<div class="preview">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
                <span class="label" style="margin:0">Wiedergabe prüfen</span>
                <span style="font-size:11px;color:var(--kino-text2);font-family:ui-monospace,monospace">${
                  trim.previewAt == null ? "—" : helpers.formatTimecode(trim.previewAt)
                }</span>
              </div>
              <div class="transport">
                <a class="link" data-act="trim-preview" data-key="start">Start −3 s</a>
                <button class="seek" data-act="trim-preview-seek" data-key="-10">⟲10</button>
                <button class="round" style="background:var(--kino-gold);color:var(--kino-goldText)"
                  data-act="trim-preview" data-key="here" title="Ab hier abspielen">▶</button>
                <button class="seek" data-act="trim-preview-seek" data-key="10">10⟳</button>
                <a class="link" data-act="trim-preview" data-key="end">Ende −3 s</a>
              </div>
            </div>
            <p class="hint" style="margin-bottom:20px">
              Sprünge landen auf dem nächsten Keyframe — der effektive Start kann
              um 1–2 s abweichen.
            </p>`
          : `<p class="hint" style="margin-bottom:20px">Ohne Bibliothekseintrag ist keine Vorschau möglich.</p>`
      }

      <div class="label">Name</div>
      <input type="text" data-field="trim-name" value="${this._esc(trim.name)}"
        placeholder="${this._esc(this._defaultClipName(trim))}">
      <p class="hint" style="margin-bottom:16px">
        Start und Ende werden automatisch am Clip geführt — sie gehören nicht in den Namen.
      </p>

      <div class="label">Tags</div>
      <div class="chipwrap" style="margin-bottom:8px">
        ${vocabulary.map((v) => chip(v.key, v.label)).join("")}
        ${free.map((t) => chip(t, t)).join("")}
      </div>
      <div class="row" style="margin-bottom:16px">
        <input type="text" data-field="trim-tag" value="${this._esc(trim.tagInput)}"
          placeholder="Eigenes Tag…" style="flex:1">
        <button class="ghost" style="width:auto;padding:0 14px" data-act="trim-add-tag">Hinzufügen</button>
      </div>

      <div class="label">Notizen — worauf achten?</div>
      <textarea data-field="trim-notes" rows="3"
        placeholder="z. B. Subbass beim Deichbruch…"
        style="width:100%;box-sizing:border-box;padding:11px 14px;border-radius:12px;border:1px solid var(--kino-border);background:var(--kino-surface);color:var(--kino-text);font-size:13px;margin-bottom:16px;font-family:inherit;resize:none">${this._esc(
          trim.notes
        )}</textarea>

      <div class="row" style="margin-bottom:6px">
        <div style="flex:1">${this._trimTrackSelect("audioTrack", "Tonspur")}</div>
        <div style="flex:1">${this._trimTrackSelect("subtitleTrack", "Untertitel")}</div>
      </div>
      <p class="hint" style="margin-bottom:18px">Vorbelegt mit der aktuellen Auswahl des Players.</p>

      <button class="primary" data-act="trim-save"
        ${valid ? "" : "disabled style=\"opacity:0.5\""}>${
          trim.id ? "Änderungen speichern" : "Clip speichern"
        }</button>
      ${
        trim.id
          ? `<button class="ghost" style="width:100%;margin-top:10px;color:var(--kino-red);border-color:oklch(0.65 0.19 25 / 0.4)"
               data-act="trim-delete">Clip löschen</button>`
          : ""
      }
    </div>`;
  }

  _defaultClipName(trim) {
    const { start, end, valid } = this._trimSpan;
    if (!valid) return trim.title || "Clip";
    const span = `${helpers.formatTimecode(start)}–${helpers.formatTimecode(end)}`;
    return trim.title ? `${trim.title} — ${span}` : span;
  }

  /**
   * A track dropdown for the trim editor.
   *
   * The options come off the player's own live list, so a clip can never
   * store a track the file does not carry. A clip that already names one the
   * player is not offering right now keeps it, as a disabled entry.
   */
  _trimTrackSelect(field, label) {
    const trim = this._view.trim;
    const entityId = this._entity(field);
    const state = entityId ? this._hass.states[entityId] : null;
    const options = state ? (state.attributes.options || []).filter((o) => o !== "—") : [];
    const current = trim[field];
    if (!options.length) {
      return `<div class="label">${label}</div>
        <p class="hint" style="margin:0">${
          current ? this._esc(helpers.displayLabel(current)) : "Der Player bietet keine Liste."
        }</p>`;
    }
    const orphan = current && !options.includes(current);
    return `<div class="label">${label}</div>
      <select data-field="trim-${field}">
        <option value=""${!current ? " selected" : ""}>Unverändert</option>
        ${orphan ? `<option value="${this._esc(current)}" selected>${this._esc(helpers.displayLabel(current))}</option>` : ""}
        ${options
          .map(
            (o) =>
              `<option value="${this._esc(o)}"${current === o ? " selected" : ""}>${this._esc(
                helpers.displayLabel(o)
              )}</option>`
          )
          .join("")}
      </select>`;
  }

  _renderShowcaseEditor() {
    const edit = this._view.scEdit;
    if (!edit) return "";
    const inList = new Set(edit.clips);
    const valid = !!edit.name.trim() && edit.clips.length > 0;
    const rows = edit.clips.map((id, index) => {
      const clip = this._clipById(id);
      return `<div class="demorow" style="cursor:default">
        <span class="n">${index + 1}</span>
        <div style="flex:1;min-width:0">
          <div class="nm">${this._esc(clip ? clip.name : "—")}</div>
          <div class="du">${this._esc(clip ? clip.duration : "")}</div>
        </div>
        <button class="round" style="width:28px;height:28px" data-act="sc-move" data-key="${index}:-1" title="Nach oben">↑</button>
        <button class="round" style="width:28px;height:28px" data-act="sc-move" data-key="${index}:1" title="Nach unten">↓</button>
        <button class="round" style="width:28px;height:28px;color:var(--kino-red)" data-act="sc-remove" data-key="${index}" title="Entfernen">✕</button>
      </div>`;
    });
    const addable = (this._demoData.clips || []).filter((c) => !inList.has(c.id));
    return `<div class="sheet" data-sheet="scedit" style="z-index:46">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">
        <a class="link" style="color:var(--kino-text3)" data-act="sc-close">Verwerfen</a>
        <h2 style="margin:0;flex:1;text-align:right">${
          edit.id ? "Showcase bearbeiten" : "Neuer Showcase"
        }</h2>
      </div>

      <div class="label">Name</div>
      <input type="text" data-field="sc-name" value="${this._esc(edit.name)}"
        placeholder="z. B. Gäste-Demo" style="margin-bottom:16px">

      <div class="label">Weiterschalten</div>
      <div class="row" style="margin-bottom:16px">
        <button class="pill" style="flex:1;height:36px" data-act="sc-advance" data-key="auto"
          aria-pressed="${edit.advance === "auto"}">Automatisch</button>
        <button class="pill" style="flex:1;height:36px" data-act="sc-advance" data-key="tap"
          aria-pressed="${edit.advance === "tap"}">Per Tipp</button>
      </div>

      <div class="steprow">
        <span>Pause zwischen Clips</span>
        <div class="stepper">
          <button class="round" data-act="sc-step" data-key="gapSeconds:-1">–</button>
          <span class="val">${edit.gapSeconds} s</span>
          <button class="round" data-act="sc-step" data-key="gapSeconds:1">+</button>
        </div>
      </div>
      <div class="steprow" style="margin-bottom:20px">
        <span>Referenzpegel</span>
        <div class="stepper">
          <button class="round" data-act="sc-step" data-key="referenceVolumeDb:-1">–</button>
          <span class="val">${edit.referenceVolumeDb} dB</span>
          <button class="round" data-act="sc-step" data-key="referenceVolumeDb:1">+</button>
        </div>
      </div>

      <div class="label">Reihenfolge</div>
      <div class="demorows">
        ${rows.join("") || '<p class="hint" style="margin:0">Noch kein Clip gewählt.</p>'}
      </div>

      ${
        addable.length
          ? `<div class="label">Clip hinzufügen</div>
             <div class="demorows">
               ${addable
                 .map(
                   (clip) => `<button class="dashed" style="text-align:left;display:flex;align-items:center;gap:10px"
                     data-act="sc-add" data-key="${this._esc(clip.id)}">
                     <span style="flex:1;min-width:0">
                       <span style="display:block;font-size:12px;font-weight:700;color:var(--kino-text)">${this._esc(clip.name)}</span>
                       <span style="display:block;font-size:10px;color:var(--kino-text3)">${this._esc(
                         [clip.title, clip.duration].filter(Boolean).join(" · ")
                       )}</span>
                     </span>
                     <span style="color:var(--kino-gold);font-size:15px;font-weight:800">＋</span>
                   </button>`
                 )
                 .join("")}
             </div>`
          : ""
      }

      <button class="primary" data-act="sc-save" ${valid ? "" : 'disabled style="opacity:0.5"'}>
        ${edit.id ? "Änderungen speichern" : "Showcase anlegen"}
      </button>
      ${
        edit.id
          ? `<button class="ghost" style="width:100%;margin-top:10px;color:var(--kino-red);border-color:oklch(0.65 0.19 25 / 0.4)"
               data-act="sc-delete">Showcase löschen</button>`
          : ""
      }
    </div>`;
  }

  /**
   * The A/B setup sheet.
   *
   * Presets and projector profiles come from the devices' own option lists;
   * the Envy addresses its profiles by slot number and cannot enumerate
   * them, so that one is a number field rather than a dropdown.
   */
  _renderAbSetup() {
    const setup = this._view.abSetup;
    if (!setup) return "";
    const clip = this._clipById(setup.clipId);
    const options = this._demoData.options || {};
    const side = (letter) => {
      const values = setup[letter];
      const pick = (field, label, list) =>
        !list || !list.length
          ? ""
          : `<div class="abfield">
              <span>${label}</span>
              <select data-field="ab-${letter}-${field}">
                <option value=""${!values[field] ? " selected" : ""}>—</option>
                ${list
                  .map(
                    (o) =>
                      `<option value="${this._esc(o)}"${values[field] === o ? " selected" : ""}>${this._esc(o)}</option>`
                  )
                  .join("")}
              </select>
            </div>`;
      return `<div class="abbox">
        <div class="label" style="margin-bottom:10px">Konfiguration ${letter.toUpperCase()}</div>
        ${pick("preset", "Klang", options.presets)}
        <div class="abfield">
          <span>madVR</span>
          <input type="text" inputmode="numeric" placeholder="Profil-Nr."
            data-field="ab-${letter}-madvr" value="${this._esc(values.madvr || "")}">
        </div>
        ${pick("barco", "Beamer", options.barcoProfiles)}
      </div>`;
    };
    return `<div class="sheet" data-sheet="absetup" style="z-index:47">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <a class="link" data-act="ab-close">‹ Abbrechen</a>
        <h2 style="margin:0;flex:1;text-align:right">A/B-Vergleich</h2>
      </div>
      <div style="font-size:12px;color:var(--kino-text2);margin-bottom:18px;text-align:right">
        ${this._esc(clip ? clip.name : "")} — wird zweimal hintereinander abgespielt.
      </div>
      ${side("a")}
      ${side("b")}
      <div style="display:flex;align-items:center;gap:12px;margin:14px 0 20px">
        <button class="pill" data-act="ab-blind" aria-pressed="${setup.blind}"
          style="flex-shrink:0">Blind-Vergleich</button>
        <span style="font-size:11px;color:var(--kino-text3);line-height:1.4">
          Reihenfolge wird zufällig zugewiesen und erst nach der Wahl aufgedeckt.
        </span>
      </div>
      <button class="primary" data-act="ab-start">Vergleich starten</button>
    </div>`;
  }

  /* -- demo mode: the runtime overlays --------------------------------- */

  _renderDemoRun() {
    const run = this._runningDemo;
    if (!run || run.mode === "ab") return "";
    const clip = run.clip || {};
    const phase = run.phase;
    const controls = !["done", "wait", "error"].includes(phase);
    const progress = this._demoClipProgress();
    const body = {
      preparing: () => `<div class="slate">
          <div class="label" style="margin-bottom:8px">Kino wird vorbereitet</div>
          <p>Der Raum wird gestartet — die Demo beginnt, sobald Bild und Ton bereit sind.</p>
        </div>`,
      slate: () => `<div class="slate">
          <div class="label" style="margin-bottom:8px">Als Nächstes</div>
          <div class="next">${this._esc(clip.name || "")}</div>
          <p>${this._esc(clip.notes || "Keine Notizen.")}</p>
          <div style="margin-top:14px;font-size:11px;color:var(--kino-gold);font-weight:700"
            data-demo="countdown"></div>
        </div>`,
      wait: () => `<div class="slate">
          <div class="label" style="margin-bottom:8px">Als Nächstes</div>
          <div class="next">${this._esc(clip.name || "")}</div>
          <p>${this._esc(clip.notes || "Keine Notizen.")}</p>
          <button class="primary" style="margin-top:16px" data-act="demo-next">Weiter — Clip starten</button>
        </div>`,
      leadin: () => `<div class="slate" style="display:flex;align-items:center;gap:12px">
          <span class="dot pulsing" style="background:var(--kino-gold);flex-shrink:0"></span>
          <div>
            <div style="font-size:13px;font-weight:700">Vorlauf läuft — Signalkette synchronisiert</div>
            <div style="font-size:11px;color:var(--kino-text3);margin-top:3px">
              Start ${Math.round((this._kino.demo || {}).leadInSeconds || 8)} s vor dem
              Clip-Anfang, damit Bild und Ton verriegelt sind.
            </div>
          </div>
        </div>`,
      playing: () => `<div style="margin-bottom:16px">
          <div style="font-size:18px;font-weight:800;line-height:1.3;margin-bottom:10px">${this._esc(
            clip.name || ""
          )}</div>
          ${
            clip.notes
              ? `<div style="padding:12px 14px;border-radius:12px;background:var(--kino-surface);border:1px solid var(--kino-border);margin-bottom:14px">
                   <div class="label" style="margin-bottom:4px">Worauf achten</div>
                   <p style="margin:0;font-size:12px;color:var(--kino-text2);line-height:1.5">${this._esc(clip.notes)}</p>
                 </div>`
              : ""
          }
          <div class="bar" data-demo="bar"><div style="width:${
            (progress ? progress.fraction : 0) * 100
          }%"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--kino-text3);margin-top:6px">
            <span data-demo="pos">${this._esc(
              progress ? helpers.formatTimecode(progress.positionMs) : clip.start || ""
            )}</span>
            <span data-demo="left">${
              progress ? `noch ${helpers.formatTimecode(progress.remainingMs)}` : ""
            }</span>
          </div>
        </div>`,
      done: () => `<div class="slate" style="text-align:center">
          <div style="font-size:15px;font-weight:800">Showcase beendet</div>
          <p style="margin:8px 0 16px">Lautstärke, Preset und Profil wurden auf die
            vorherigen Werte zurückgesetzt.</p>
          <button class="primary" data-act="demo-stop">Schließen</button>
        </div>`,
      error: () => `<div class="slate" style="text-align:center">
          <div style="font-size:15px;font-weight:800">Die Demo wurde abgebrochen</div>
          <p style="margin:8px 0 16px">${this._esc(run.warning || "")}</p>
          <button class="primary" data-act="demo-stop">Schließen</button>
        </div>`,
    };
    return `<div class="sheet" data-sheet="demorun" style="z-index:32">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
        <span style="font-size:11px;color:var(--kino-gold);font-weight:800;letter-spacing:1px;text-transform:uppercase">
          Demo · ${this._esc(run.name)}
        </span>
        <a class="link" style="color:var(--kino-text3)" data-act="demo-stop">Beenden</a>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--kino-text3);margin-bottom:16px">
        <span>Clip ${run.index + 1} von ${run.count}</span>
        <span data-demo="total">${
          ["done", "error"].includes(phase)
            ? ""
            : // The engine's own figure until the clip reports a position;
              // after that the card counts it down itself, smoothly.
              `Showcase: noch ~${helpers.formatTimecode(
                progress
                  ? this._demoShowcaseRemaining(progress.remainingMs)
                  : run.totalRemainingMs
              )}`
        }</span>
      </div>
      ${run.warning && phase !== "error" ? `<div class="warnbox">${this._esc(run.warning)}</div>` : ""}
      ${(body[phase] || body.slate)()}
      ${controls ? this._renderDemoTransport(run) : ""}
      <div class="label">Clips im Showcase</div>
      <div class="demorows">
        ${(run.clips || [])
          .map((c, index) => {
            // A tap is answered here, not two seconds later when the engine
            // has caught up — otherwise the list looks like it ignored it.
            const wanted = this._demoJumpTo != null ? this._demoJumpTo : run.index;
            return `<button class="demorow" aria-current="${index === wanted}"
              aria-busy="${index === wanted && index !== run.index}"
              data-act="demo-jump" data-key="${index}">
              <span class="n">${index + 1}</span>
              <span class="nm">${this._esc(c.name)}</span>
              <span class="du">${this._esc(c.duration)}</span>
            </button>`;
          })
          .join("")}
      </div>
      <p class="hint">Wiedergabe trägt demo=true — sie erscheint nicht im Verlauf.</p>
    </div>`;
  }

  /**
   * The running demo's transport, built to the same shape as the film's.
   *
   * Play/pause goes through the engine rather than straight at the player:
   * the engine is the one holding the clip's schedule, and a player paused
   * behind its back would be resumed by the next phase as if nothing had
   * happened. Everything else — the seek, the level, the tracks — is the
   * room's, and is the same control the playback view offers.
   */
  _renderDemoTransport(run) {
    const first = run.index <= 0;
    const last = run.index >= (run.count || 1) - 1;
    // The Zidoo refuses a seek while it is not playing, so a paused demo
    // offers no seek rather than an error.
    const seekable = !run.paused && ["playing", "leadin"].includes(run.phase);
    const ghost =
      "width:auto;border:none;background:transparent;padding:6px 8px;font-size:12px";
    return `<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin:6px 0 14px">
        <button class="ghost" style="${ghost};font-size:17px" data-act="demo-prev"
          title="Vorheriger Clip" ${first ? "disabled" : ""}>⏮</button>
        <button class="seek" data-act="seek" data-key="-${SEEK_STEP_SECONDS}"
          title="10 Sekunden zurück" ${seekable ? "" : "disabled"}>⟲${SEEK_STEP_SECONDS}</button>
        <button class="round" style="width:52px;height:52px;border-radius:26px;background:var(--kino-gold);color:var(--kino-goldText);font-size:18px"
          data-act="demo-pause">${run.paused ? "▶" : "⏸"}</button>
        <button class="seek" data-act="seek" data-key="${SEEK_STEP_SECONDS}"
          title="10 Sekunden vor" ${seekable ? "" : "disabled"}>${SEEK_STEP_SECONDS}⟳</button>
        <button class="ghost" style="${ghost};font-size:17px" data-act="demo-skip"
          title="Nächster Clip" ${last ? "disabled" : ""}>⏭</button>
      </div>
      <div style="display:flex;justify-content:center;margin-bottom:18px">
        <a class="link" data-act="demo-replay">⟲ Clip von vorn</a>
      </div>
      ${this._renderVolumeRow(true)}
      ${this._renderSoundSelects()}
      ${this._renderTrackSelects()}`;
  }

  _renderAbRun() {
    const run = this._runningDemo;
    if (!run || run.mode !== "ab") return "";
    const phase = run.phase;
    const clip = run.clip || {};
    const describe = (config) =>
      Object.entries(config || {})
        .map(([key, value]) =>
          key === "madvr" ? `madVR ${value}` : key === "barco" ? `Beamer ${value}` : value
        )
        .join(" · ");
    const round = ["lead", "play"].includes(phase);
    const body = round
      ? `<div style="text-align:center">
          <div style="font-size:26px;font-weight:800">Durchgang ${run.side}</div>
          <div style="font-size:12px;color:var(--kino-text2);margin-top:6px">${
            run.blind
              ? "Konfiguration verborgen"
              : this._esc(describe(run.currentConfig))
          }</div>
          ${
            phase === "lead"
              ? `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:18px">
                   <span class="dot pulsing" style="background:var(--kino-gold)"></span>
                   <span style="font-size:11px;color:var(--kino-text3)">Vorlauf — Signalkette synchronisiert</span>
                 </div>`
              : `<div class="bar" data-demo="bar" style="margin-top:18px"><div style="width:${
                  (this._demoClipProgress() || { fraction: 0 }).fraction * 100
                }%"></div></div>`
          }
        </div>`
      : phase === "gap"
        ? `<div style="text-align:center">
            <span class="dot pulsing" style="background:var(--kino-gold);display:inline-block"></span>
            <div style="font-size:14px;font-weight:700;margin-top:10px">Konfiguration wird angewendet…</div>
            <div style="font-size:11px;color:var(--kino-text3);margin-top:6px">
              Der zweite Durchgang startet erst nach bestätigtem Preset.
            </div>
          </div>`
        : phase === "decide"
          ? `<div style="text-align:center">
              <div style="font-size:16px;font-weight:800;margin-bottom:16px">Welcher Durchgang war besser?</div>
              <div class="row">
                <button class="ghost" style="flex:1;padding:20px;font-size:15px;font-weight:800"
                  data-act="ab-pick" data-key="1">Durchgang 1</button>
                <button class="ghost" style="flex:1;padding:20px;font-size:15px;font-weight:800"
                  data-act="ab-pick" data-key="2">Durchgang 2</button>
              </div>
              <div style="display:flex;gap:20px;justify-content:center;margin-top:14px">
                <a class="link" data-act="ab-replay" data-key="1">1 erneut hören</a>
                <a class="link" data-act="ab-replay" data-key="2">2 erneut hören</a>
              </div>
            </div>`
          : phase === "result"
            ? `<div style="text-align:center">
                <div style="font-size:16px;font-weight:800">Gewinner: Konfiguration ${this._esc(
                  run.winner || ""
                )} — ${this._esc(describe((run.configs || {})[run.winner]))}</div>
                ${
                  run.blind
                    ? `<div style="font-size:12px;color:var(--kino-text2);margin-top:8px;line-height:1.5">
                         Blind-Zuordnung: Durchgang 1 war ${this._esc(run.order[0])},
                         Durchgang 2 war ${this._esc(run.order[1])}.
                       </div>`
                    : ""
                }
                <button class="primary" style="margin-top:20px" data-act="demo-stop">Schließen</button>
              </div>`
            : `<div style="text-align:center">
                <span class="dot pulsing" style="background:var(--kino-gold);display:inline-block"></span>
                <div style="font-size:14px;font-weight:700;margin-top:10px">Kino wird vorbereitet…</div>
              </div>`;

    return `<div class="sheet" data-sheet="abrun" style="z-index:37;display:flex;flex-direction:column">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <span style="font-size:11px;color:var(--kino-gold);font-weight:800;letter-spacing:1px;text-transform:uppercase">A/B-Vergleich</span>
        <a class="link" style="color:var(--kino-text3)" data-act="demo-stop">Beenden</a>
      </div>
      <div style="font-size:12px;color:var(--kino-text2)">${this._esc(clip.name || "")}</div>
      ${run.warning ? `<div class="warnbox" style="margin-top:14px">${this._esc(run.warning)}</div>` : ""}
      <div class="abmid">${body}</div>
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
        this._navBack();
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
        this._navPush();
        view.main = "library";
        view.category = key || "movies";
        this._render();
        await this._loadLibrary();
        break;
      case "open-favorites": {
        // The row shows twelve; the library shows all of them, filterable.
        const filters = helpers.emptyFilters();
        filters.tags = ["Favoriten"];
        this._navPush();
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
        this._navClose(() => {
          view.main = "home";
        });
        break;

      /* -- demo mode --------------------------------------------------- */
      case "open-demos":
        this._navPush();
        view.main = "demos";
        view.demoTab = "clips";
        this._render();
        await this._loadDemo(true);
        break;
      case "demo-tab":
        view.demoTab = key;
        this._render();
        break;
      case "demo-tag":
        view.demoTagFilter = helpers.toggleTag(view.demoTagFilter, key);
        this._render();
        break;
      case "demo-tags-clear":
        view.demoTagFilter = [];
        this._render();
        break;
      case "demo-clip-edit":
        this._navPush();
        this._openClipEdit(key);
        break;
      case "demo-open-title":
        // The clip card's title link: straight into the title's own sheet,
        // which closes back onto the clip list it was opened from.
        this._navPush();
        await this._openDetail(key);
        break;
      case "demo-capture":
        // The vocabulary has to be there before the chips are drawn.
        await this._loadDemo();
        this._navPush();
        this._captureFromPlayer();
        break;
      case "demo-capture-title":
        await this._loadDemo();
        this._navPush();
        this._captureWholeTitle(view.detail);
        break;
      case "demo-play-clip":
        // Whatever is on screen stays on screen: the demo overlay sits above
        // it and ending the demo puts the view back rather than the start.
        await this._playDemo({ type: "kino/demo/play", clip_id: key });
        break;
      case "demo-play-showcase":
        await this._playDemo({ type: "kino/demo/play", showcase_id: key });
        break;
      case "demo-pause": {
        const run = this._runningDemo;
        await this._demoControl(run && run.paused ? "resume" : "pause");
        break;
      }
      case "demo-skip":
        await this._demoControl("skip");
        break;
      case "demo-prev": {
        const run = this._runningDemo;
        if (run) await this._demoJump(run.index - 1);
        break;
      }
      case "demo-replay":
        await this._demoControl("replay");
        break;
      case "demo-next":
        await this._demoControl("next");
        break;
      case "demo-jump":
        await this._demoJump(Number(key));
        break;
      case "demo-stop":
        await this._demoControl("stop");
        break;

      /* -- the trim editor --------------------------------------------- */
      case "trim-close":
        this._navClose(() => {
          view.trim = null;
        });
        break;
      case "trim-scope": {
        // Scope chips reach back from the end the capture arrived with, so
        // tapping two of them in a row does not compound.
        const trim = view.trim;
        if (!trim) break;
        const anchor = trim.anchorMs || this._trimSpan.end || 0;
        this._setTrimSpan(Math.max(0, anchor - Number(key) * 1000), anchor);
        break;
      }
      case "trim-shift":
        this._shiftTrim(Number(key));
        break;
      case "trim-nudge": {
        const [which, delta] = key.split(":");
        this._nudgeTrim(which, Number(delta));
        break;
      }
      case "trim-tag":
        view.trim.tags = helpers.toggleTag(view.trim.tags, key);
        this._render();
        break;
      case "trim-add-tag": {
        const value = (view.trim.tagInput || "").trim();
        if (!value) break;
        if (!view.trim.tags.includes(value)) view.trim.tags = [...view.trim.tags, value];
        view.trim.tagInput = "";
        this._render();
        break;
      }
      case "trim-preview": {
        const { start, end } = this._trimSpan;
        const at =
          key === "start"
            ? Math.max(0, (start || 0) - 3000)
            : key === "end"
              ? Math.max(0, (end || 0) - 3000)
              : view.trim.previewAt != null
                ? view.trim.previewAt
                : Math.max(0, (start || 0) - 3000);
        await this._previewCut(at);
        break;
      }
      case "trim-preview-seek": {
        const base = view.trim.previewAt != null ? view.trim.previewAt : this._trimSpan.start || 0;
        await this._previewCut(Math.max(0, base + Number(key) * 1000));
        break;
      }
      case "trim-save":
        await this._saveClip();
        break;
      case "trim-delete":
        await this._deleteClip();
        break;

      /* -- the showcase editor ------------------------------------------ */
      case "demo-showcase-new":
        this._navPush();
        this._openShowcaseEditor(null);
        break;
      case "demo-showcase-edit":
        this._navPush();
        this._openShowcaseEditor(key);
        break;
      case "sc-close":
        this._navClose(() => {
          view.scEdit = null;
        });
        break;
      case "sc-advance":
        view.scEdit.advance = key;
        this._render();
        break;
      case "sc-step": {
        const [field, delta] = key.split(":");
        const bounds = { gapSeconds: [0, 60], referenceVolumeDb: [-60, 0] }[field];
        view.scEdit[field] = Math.max(
          bounds[0],
          Math.min(bounds[1], view.scEdit[field] + Number(delta))
        );
        this._render();
        break;
      }
      case "sc-move": {
        const [index, direction] = key.split(":").map(Number);
        const clips = [...view.scEdit.clips];
        const target = index + direction;
        if (target < 0 || target >= clips.length) break;
        [clips[index], clips[target]] = [clips[target], clips[index]];
        view.scEdit.clips = clips;
        this._render();
        break;
      }
      case "sc-remove":
        view.scEdit.clips = view.scEdit.clips.filter((_, i) => i !== Number(key));
        this._render();
        break;
      case "sc-add":
        view.scEdit.clips = [...view.scEdit.clips, key];
        this._render();
        break;
      case "sc-save":
        await this._saveShowcase();
        break;
      case "sc-delete":
        await this._deleteShowcase();
        break;

      /* -- A/B ----------------------------------------------------------- */
      case "demo-ab":
        this._navPush();
        this._openAbSetup(key);
        break;
      case "ab-close":
        this._navClose(() => {
          view.abSetup = null;
        });
        break;
      case "ab-blind":
        view.abSetup.blind = !view.abSetup.blind;
        this._render();
        break;
      case "ab-start":
        await this._startAb();
        break;
      case "ab-pick":
        await this._demoControl("pick", Number(key));
        break;
      case "ab-replay":
        await this._demoControl("replay-side", Number(key));
        break;
      case "open-filters":
        this._navPush(() => this._closeFilters());
        view.filterSheet = true;
        this._filterPreview = null;
        view.personQuery = "";
        this._personHits = null;
        this._render();
        // Counts and the CTA total straight away, not first after a toggle.
        this._previewFilterCount();
        break;
      case "close-filters":
        this._navBack();
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
        } else if (kind === "runtime") {
          f.runtimeFrom = null;
          f.runtimeTo = null;
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
      case "grid-size": {
        const idx = GRID_SIZES.findIndex(([k]) => k === view.gridSize);
        view.gridSize = GRID_SIZES[(idx + 1) % GRID_SIZES.length][0];
        store(GRID_SIZE_STORAGE_KEY, view.gridSize);
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
        this._navPush();
        await this._openDetail(key);
        break;
      case "close-detail":
        this._navClose(() => this._closeDetail());
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
        this._navPush();
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
      case "toggle-overview": {
        // The key names which sheet's synopsis was tapped — both can be open.
        const flag = key || "overviewOpen";
        view[flag] = !view[flag];
        this._render();
        break;
      }
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
        this._navPush();
        view.playingOpen = true;
        this._render();
        break;
      case "collapse-playing":
        this._navClose(() => {
          view.playingOpen = false;
        });
        break;
      case "transport":
        await this._transport(key);
        break;
      case "stop-playing":
        // Ending the film is also leaving the playback view — staying on a
        // dead transport screen helps nobody.
        this._navClose(() => {
          view.playingOpen = false;
        });
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
      case "seek-to":
        await this._seekToFraction(target, event);
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
    // The detail sheet is traded for the playback sheet rather than stacked
    // under it, so the entry the detail was opened with is the one playback
    // closes back through — onto the library, or wherever the title came
    // from. Nothing to push, nothing to drop.
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
    } else if (field === "runtime-from" || field === "runtime-to") {
      const value = event.target.value ? Number(event.target.value) : null;
      this._view.filters[field === "runtime-from" ? "runtimeFrom" : "runtimeTo"] = value;
      this._syncFilterChips();
      this._previewFilterCount();
    } else if (field === "entity-select") {
      this._callService("select", "select_option", {
        entity_id: event.target.dataset.key,
        option: event.target.value,
      });
    } else if (field === "trim-audioTrack" || field === "trim-subtitleTrack") {
      const which = field === "trim-audioTrack" ? "audioTrack" : "subtitleTrack";
      this._view.trim[which] = event.target.value || null;
    } else if (field && field.startsWith("ab-")) {
      const [, side, key] = field.split("-");
      this._view.abSetup[side][key] = event.target.value;
    }
  }

  _onInput(event) {
    const field = event.target.dataset.field;
    // Every field of the card: while these keep arriving, no poll redraws it.
    this._lastTypedAt = Date.now();
    if (field === "person-search") {
      this._view.personQuery = event.target.value;
      this._searchPeople();
      return;
    }
    // Demo fields are written straight into the working copy and never
    // re-rendered from here: a re-render mid-word would move the caret, and
    // nothing else on screen depends on the half-typed value.
    const trim = this._view.trim;
    if (trim && field === "trim-start") {
      trim.start = event.target.value;
      this._patchTrimLength();
      return;
    }
    if (trim && field === "trim-end") {
      trim.end = event.target.value;
      this._patchTrimLength();
      return;
    }
    if (trim && field === "trim-name") {
      trim.name = event.target.value;
      return;
    }
    if (trim && field === "trim-tag") {
      trim.tagInput = event.target.value;
      return;
    }
    if (trim && field === "trim-notes") {
      trim.notes = event.target.value;
      return;
    }
    if (this._view.scEdit && field === "sc-name") {
      this._view.scEdit.name = event.target.value;
      return;
    }
    if (this._view.abSetup && field && field.startsWith("ab-")) {
      const [, side, key] = field.split("-");
      this._view.abSetup[side][key] = event.target.value;
      return;
    }
    if (field !== "query") return;
    // The field is never re-rendered from here: it owns what it shows, and
    // the search runs behind it. Only the count line follows along, so the
    // "ab 3 Zeichen" hint appears and disappears while typing.
    this._view.query = event.target.value;
    const count = this._container.querySelector('[data-role="library-count"]');
    if (count) count.innerHTML = this._renderLibraryCount();
    if (this._searchTimer) clearTimeout(this._searchTimer);
    // Nothing to fetch when the letters on screen mean the same search as the
    // one the grid already shows — typing a third letter and taking it back
    // must not cost two round trips.
    if (this._searchQuery() === this._appliedQuery) {
      this._searchTimer = null;
      return;
    }
    // Incremental results as the user types, without a request per keystroke.
    this._searchTimer = setTimeout(() => {
      this._searchTimer = null;
      this._loadLibrary();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Keep the length and the save button honest while a timecode is typed. */
  _patchTrimLength() {
    const sheet = this._container.querySelector('.sheet[data-sheet="trim"]');
    if (!sheet) return;
    const { start, end, valid } = this._trimSpan;
    const label = sheet.querySelector("[data-role='trim-length']");
    if (label) {
      label.textContent = `Länge: ${valid ? helpers.formatTimecode(end - start) : "—"}`;
    }
    const save = sheet.querySelector('[data-act="trim-save"]');
    if (save) {
      save.disabled = !valid;
      save.style.opacity = valid ? "" : "0.5";
    }
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
