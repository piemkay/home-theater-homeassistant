/**
 * Card logic tests. Run with `node --test tests/frontend`.
 *
 * These cover the pure helpers and the query translation — the parts where a
 * mistake silently produces wrong results rather than an obvious blank screen.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { helpers, KinoCard } from "../../custom_components/kino/www/kino-card.js";

describe("formatTime", () => {
  test("renders minutes and seconds below an hour", () => {
    assert.equal(helpers.formatTime(0), "0:00");
    assert.equal(helpers.formatTime(65), "1:05");
    assert.equal(helpers.formatTime(599), "9:59");
  });

  test("renders hours above an hour", () => {
    assert.equal(helpers.formatTime(3600), "1:00:00");
    assert.equal(helpers.formatTime(7385), "2:03:05");
  });

  test("survives missing or nonsense values", () => {
    assert.equal(helpers.formatTime(null), "0:00");
    assert.equal(helpers.formatTime(undefined), "0:00");
    assert.equal(helpers.formatTime(NaN), "0:00");
    assert.equal(helpers.formatTime(-10), "0:00");
  });
});

describe("heroBadges", () => {
  /**
   * Real payloads, straight off the live library — the engineering strings
   * are what the hero must not show.
   */
  const BOHEMIAN = {
    res4k: true,
    officialRating: "FSK-6",
    videoFormat: "3840×2160 · @23.976Hz · HDR",
    audioFormat: "TRUEHD · 7.1 · eng",
    audioTracks: [
      { codec: "TRUEHD", channelLayout: "7.1", title: "TrueHD Atmos 7.1", default: true },
      { codec: "AC3", channelLayout: "5.1", title: "AC3 5.1-EX", default: false },
    ],
  };

  test("the disc, not the stream dump", () => {
    assert.deepEqual(helpers.heroBadges(BOHEMIAN), [
      "4K HDR",
      "TrueHD Atmos 7.1",
      "FSK 6",
    ]);
  });

  test("a dumped track description is rebuilt from its fields", () => {
    // "The Order" on the live server names its track like this.
    const badges = helpers.heroBadges({
      res4k: true,
      videoFormat: "3840×2160 · @24.000Hz · SDR",
      audioTracks: [
        {
          codec: "PCM_S24LE",
          channelLayout: null,
          title: "English - PCM_S24LE - 6 ch - Default",
          default: true,
        },
      ],
    });
    assert.deepEqual(badges, ["4K", "PCM"]);
  });

  test("Dolby Vision wins over the HDR the same disc also reports", () => {
    assert.equal(
      helpers.heroBadges({ videoFormat: "3840×2160 · DV · HDR10Plus" })[0],
      "DV"
    );
    assert.equal(
      helpers.heroBadges({ videoFormat: "3840×2160 · HDR10Plus" })[0],
      "HDR10+"
    );
  });

  test("a bare SDR file gets no picture chip at all", () => {
    assert.deepEqual(helpers.heroBadges({ videoFormat: "720×576 · @25Hz · SDR" }), []);
  });

  test("no item, no chips", () => {
    assert.deepEqual(helpers.heroBadges(null), []);
    assert.deepEqual(helpers.heroBadges({}), []);
  });

  test("without a track list the one-line summary is all there is", () => {
    assert.deepEqual(helpers.heroBadges({ audioFormat: "EAC3 · 5.1 · eng" }), ["DD+"]);
  });
});

describe("runtimeLabel", () => {
  test("reads a film's length in hours, the way it gets said", () => {
    assert.equal(helpers.runtimeLabel(113), "1 Std 53 Min");
    assert.equal(helpers.runtimeLabel(120), "2 Std");
    assert.equal(helpers.runtimeLabel(47), "47 Min");
  });

  test("an unknown length is left out rather than shown as zero", () => {
    assert.equal(helpers.runtimeLabel(0), "");
    assert.equal(helpers.runtimeLabel(null), "");
    assert.equal(helpers.runtimeLabel(undefined), "");
  });
});

describe("remainingLabel", () => {
  test("says how much film is left", () => {
    assert.equal(helpers.remainingLabel(1282, 6809), "noch 1:32:07");
  });

  test("never counts past the end", () => {
    assert.equal(helpers.remainingLabel(7000, 6809), "noch 0:00");
  });

  test("is empty until the player reports a duration", () => {
    assert.equal(helpers.remainingLabel(120, 0), "");
    assert.equal(helpers.remainingLabel(120, null), "");
  });
});

describe("formatEta", () => {
  test("is empty when nothing is pending", () => {
    assert.equal(helpers.formatEta(0), "");
    assert.equal(helpers.formatEta(null), "");
  });

  test("says less than a minute rather than a misleading zero", () => {
    assert.equal(helpers.formatEta(30), "noch weniger als 1 Min.");
  });

  test("rounds to whole minutes for a long projector warm-up", () => {
    assert.equal(helpers.formatEta(492), "noch ca. 8 Min.");
  });
});

describe("formatVolume", () => {
  test("shows one decimal in dB", () => {
    assert.equal(helpers.formatVolume(-30, false), "-30.0 dB");
  });

  test("mute wins over the value", () => {
    assert.equal(helpers.formatVolume(-30, true), "Stumm");
  });

  test("unknown volume is not rendered as 0 dB", () => {
    assert.equal(helpers.formatVolume(null, false), "—");
  });

  test("a transitioning entity's 'unknown' state never prints NaN dB", () => {
    // Number.isNaN("unknown") is false — the value must be coerced first.
    assert.equal(helpers.formatVolume("unknown", false), "—");
    assert.equal(helpers.formatVolume("unavailable", false), "—");
    assert.equal(helpers.formatVolume("", false), "—");
    assert.equal(helpers.formatVolume("-30.0", false), "-30.0 dB");
  });
});

describe("yearRangeLabel", () => {
  test("labels every shape of range", () => {
    assert.equal(helpers.yearRangeLabel(null, null), null);
    assert.equal(helpers.yearRangeLabel(2020, 2024), "2020–2024");
    assert.equal(helpers.yearRangeLabel(2020, 2020), "2020");
    assert.equal(helpers.yearRangeLabel(2020, null), "ab 2020");
    assert.equal(helpers.yearRangeLabel(null, 1999), "bis 1999");
  });
});

describe("metaLine", () => {
  test("joins what exists and skips what does not", () => {
    assert.equal(
      helpers.metaLine({ year: 2016, runtime: 106, rating: 7.2 }),
      "2016 · 106 Min · ★7.2"
    );
    assert.equal(helpers.metaLine({ year: 2016 }), "2016");
    assert.equal(helpers.metaLine({}), "");
  });
});

describe("playLabel", () => {
  test("offers a resume position when there is one", () => {
    assert.equal(
      helpers.playLabel({ continueWatching: 30, resumeSeconds: 1908 }),
      "Fortsetzen bei 31:48"
    );
  });

  test("falls back to a plain start", () => {
    assert.equal(helpers.playLabel({}), "Wiedergabe starten");
    assert.equal(helpers.playLabel(null), "Wiedergabe starten");
    // Watched-from-the-start items must not claim a resume point.
    assert.equal(
      helpers.playLabel({ continueWatching: 0, resumeSeconds: 0 }),
      "Wiedergabe starten"
    );
  });

  test("says the theater will be started when no media activity runs", () => {
    assert.equal(helpers.playLabel({}, false), "Kino starten und wiedergeben");
    assert.equal(
      helpers.playLabel({ continueWatching: 30, resumeSeconds: 1908 }, false),
      "Kino starten und fortsetzen (31:48)"
    );
  });
});

describe("defaultSortDir", () => {
  test("titles read A to Z, everything else newest/biggest first", () => {
    assert.equal(helpers.defaultSortDir("title"), "asc");
    assert.equal(helpers.defaultSortDir("added"), "desc");
    assert.equal(helpers.defaultSortDir("year"), "desc");
    assert.equal(helpers.defaultSortDir("rating"), "desc");
    assert.equal(helpers.defaultSortDir("runtime"), "desc");
    assert.equal(helpers.defaultSortDir("played"), "desc");
    assert.equal(helpers.defaultSortDir("critics"), "desc");
    assert.equal(helpers.defaultSortDir("random"), "desc");
  });
});

describe("toggleTag", () => {
  test("plain toggling adds and removes", () => {
    assert.deepEqual(helpers.toggleTag([], "Favoriten"), ["Favoriten"]);
    assert.deepEqual(helpers.toggleTag(["Favoriten"], "Favoriten"), []);
  });

  test("a title has one resolution tier", () => {
    assert.deepEqual(helpers.toggleTag(["4K"], "HD"), ["HD"]);
    assert.deepEqual(helpers.toggleTag(["HD"], "SD"), ["SD"]);
    assert.deepEqual(helpers.toggleTag(["SD", "Favoriten"], "4K"), ["Favoriten", "4K"]);
  });

  test("Gesehen and Nicht gesehen contradict each other", () => {
    assert.deepEqual(helpers.toggleTag(["Nicht gesehen"], "Gesehen"), ["Gesehen"]);
    assert.deepEqual(helpers.toggleTag(["Gesehen"], "Nicht gesehen"), ["Nicht gesehen"]);
  });

  test("independent tags stack with exclusive ones", () => {
    assert.deepEqual(helpers.toggleTag(["4K", "Weitersehen"], "3D"), [
      "4K",
      "Weitersehen",
      "3D",
    ]);
  });
});

describe("artworkTypeFor", () => {
  test("poster modes and the list always use the primary image", () => {
    for (const mode of ["poster", "posterCard", "list"]) {
      assert.deepEqual(helpers.artworkTypeFor({}, mode), ["Primary", null]);
    }
  });

  test("thumb modes prefer a real thumb and fall back to the backdrop", () => {
    assert.deepEqual(helpers.artworkTypeFor({ thumbTag: "t" }, "thumb"), [
      "Thumb",
      "Primary",
    ]);
    assert.deepEqual(helpers.artworkTypeFor({}, "thumbCard"), ["Backdrop", "Primary"]);
  });

  test("banner prefers a real banner and degrades twice", () => {
    assert.deepEqual(helpers.artworkTypeFor({ bannerTag: "b" }, "banner"), [
      "Banner",
      "Backdrop",
    ]);
    assert.deepEqual(helpers.artworkTypeFor({}, "banner"), ["Backdrop", "Primary"]);
  });
});

describe("activeFilterCount", () => {
  const empty = {
    tags: [],
    genres: [],
    countries: [],
    ratings: [],
    yearFrom: null,
    yearTo: null,
  };

  test("is zero when nothing is applied", () => {
    assert.equal(helpers.activeFilterCount(empty), 0);
  });

  test("counts every bucket", () => {
    assert.equal(
      helpers.activeFilterCount({
        ...empty,
        tags: ["4K"],
        genres: ["Drama", "Thriller"],
        countries: ["Deutschland"],
        ratings: ["FSK-16"],
      }),
      5
    );
  });

  test("counts a year range as one filter", () => {
    assert.equal(
      helpers.activeFilterCount({ ...empty, yearFrom: 2020, yearTo: 2024 }),
      1
    );
  });
});

describe("queryFromFilters", () => {
  const none = {
    tags: [],
    genres: [],
    countries: [],
    ratings: [],
    yearFrom: null,
    yearTo: null,
  };
  const filters = {
    ...none,
    tags: ["4K", "Nicht gesehen"],
    genres: ["Drama"],
    countries: ["Deutschland"],
    ratings: ["FSK-16"],
    yearFrom: 2020,
    yearTo: 2024,
  };

  test("translates chips into the WebSocket command", () => {
    const msg = helpers.queryFromFilters(filters, "movies", "nord", "year");

    assert.equal(msg.type, "kino/library/search");
    assert.equal(msg.category, "movies");
    assert.equal(msg.search, "nord");
    assert.equal(msg.sort, "year");
    assert.equal(msg.sort_dir, null);
    assert.equal(msg.only_4k, true);
    assert.equal(msg.only_hd, false);
    assert.equal(msg.only_sd, false);
    assert.equal(msg.only_3d, false);
    assert.equal(msg.only_unwatched, true);
    assert.equal(msg.only_watched, false);
    assert.equal(msg.only_resumable, false);
    assert.equal(msg.only_favorites, false);
    assert.deepEqual(msg.genres, ["Drama"]);
    assert.deepEqual(msg.countries, ["Deutschland"]);
    assert.deepEqual(msg.ratings, ["FSK-16"]);
    assert.equal(msg.year_from, 2020);
    assert.equal(msg.year_to, 2024);
  });

  test("translates the new status chips", () => {
    const msg = helpers.queryFromFilters(
      { ...none, tags: ["SD", "3D", "Gesehen", "Favoriten"] },
      "movies",
      "",
      "added"
    );
    assert.equal(msg.only_sd, true);
    assert.equal(msg.only_3d, true);
    assert.equal(msg.only_watched, true);
    assert.equal(msg.only_favorites, true);
  });

  test("carries an explicit sort direction", () => {
    const msg = helpers.queryFromFilters(none, "movies", "", "title", 0, 60, "desc");
    assert.equal(msg.sort_dir, "desc");
  });

  test("sends null rather than an empty search string", () => {
    const msg = helpers.queryFromFilters(none, "shows", "", "added");
    assert.equal(msg.search, null);
    assert.equal(msg.category, "shows");
  });

  test("survives an old filters object without a ratings bucket", () => {
    const legacy = { tags: [], genres: [], countries: [], yearFrom: null, yearTo: null };
    assert.deepEqual(helpers.queryFromFilters(legacy, "movies", "", "added").ratings, []);
    assert.equal(helpers.activeFilterCount(legacy), 0);
  });

  test("paginates", () => {
    const msg = helpers.queryFromFilters(none, "movies", "", "added", 60, 30);
    assert.equal(msg.offset, 60);
    assert.equal(msg.limit, 30);
  });
});

describe("deviceColor", () => {
  test("maps health to the mockup's tokens", () => {
    assert.equal(helpers.deviceColor("ready"), "var(--kino-teal)");
    assert.equal(helpers.deviceColor("starting"), "var(--kino-gold)");
    assert.equal(helpers.deviceColor("degraded"), "var(--kino-red)");
    assert.equal(helpers.deviceColor("unreachable"), "var(--kino-red)");
    assert.equal(helpers.deviceColor("off"), "var(--kino-text3)");
    assert.equal(helpers.deviceColor("anything-else"), "var(--kino-text3)");
  });
});

describe("bodyFor", () => {
  test("picks a body per control class (FR-47d)", () => {
    assert.equal(helpers.bodyFor(null), "aus");
    assert.equal(helpers.bodyFor({ key: "aus", controlClass: "off" }), "aus");
    assert.equal(
      helpers.bodyFor({ key: "film", controlClass: "full", media: "jellyfin" }),
      "library"
    );
    assert.equal(
      helpers.bodyFor({ key: "musik", controlClass: "mixed" }),
      "musik"
    );
    // A hand-off activity must say so, not render an empty browser.
    assert.equal(
      helpers.bodyFor({ key: "netflix", controlClass: "handoff" }),
      "handoff"
    );
    assert.equal(helpers.bodyFor({ key: "steam", controlClass: "room" }), "handoff");
  });
});

describe("card escaping", () => {
  test("titles from the catalogue cannot inject markup", () => {
    const card = Object.create(KinoCard.prototype);
    assert.equal(
      card._esc('<img src=x onerror="alert(1)">'),
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
    assert.equal(card._esc(null), "");
    assert.equal(card._esc("Ohne & mit"), "Ohne &amp; mit");
  });
});

describe("artworkUrl", () => {
  test("carries the signature an <img> cannot send as a header", () => {
    assert.equal(
      helpers.artworkUrl("abc123", "Primary", "1799.deadbeef"),
      "/api/kino/artwork/abc123/Primary?sig=1799.deadbeef"
    );
  });

  test("item ids and signatures are encoded, not concatenated", () => {
    const url = helpers.artworkUrl("a/b c", "Backdrop", "1799.dead+beef");
    assert.equal(url, "/api/kino/artwork/a%2Fb%20c/Backdrop?sig=1799.dead%2Bbeef");
  });

  test("without a signature the plain path is still produced", () => {
    assert.equal(
      helpers.artworkUrl("abc", "Primary", null),
      "/api/kino/artwork/abc/Primary"
    );
  });
});

describe("entity resolution", () => {
  /**
   * Regression: the card used to pick "the media_player whose id contains
   * kino", which in the real house matched a media-player *group*. Every
   * volume_down then failed inside the group helper with KeyError
   * 'volume_level'.
   */
  test("uses the ids the integration reports, never a name match", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      entities: {
        player: "media_player.kino_kino_control_kino",
        volume: "number.kino_kino_control_volume",
      },
    };

    assert.equal(card._playerEntity, "media_player.kino_kino_control_kino");
    assert.equal(card._volumeEntity, "number.kino_kino_control_volume");
    assert.equal(card._entity("audioTrack"), null);
  });

  test("an older integration without the map degrades to no player", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {};
    assert.equal(card._playerEntity, null);
  });
});

describe("playback position", () => {
  const card = Object.create(KinoCard.prototype);
  const at = (seconds) =>
    new Date(Date.now() - seconds * 1000).toISOString();

  test("carries the position forward between the player's updates", () => {
    const position = card._position({
      state: "playing",
      attributes: {
        media_position: 100,
        media_duration: 6000,
        media_position_updated_at: at(5),
      },
    });
    assert.ok(position >= 104 && position <= 106, `got ${position}`);
  });

  test("a paused player stays exactly where it is", () => {
    assert.equal(
      card._position({
        state: "paused",
        attributes: {
          media_position: 100,
          media_duration: 6000,
          media_position_updated_at: at(30),
        },
      }),
      100
    );
  });

  test("never runs past the end of the film", () => {
    assert.equal(
      card._position({
        state: "playing",
        attributes: {
          media_position: 5990,
          media_duration: 6000,
          media_position_updated_at: at(600),
        },
      }),
      6000
    );
  });

  test("a player that reports no update time is taken at its word", () => {
    assert.equal(
      card._position({ state: "playing", attributes: { media_position: 42 } }),
      42
    );
  });
});

describe("off-state body", () => {
  const card = () => {
    const c = Object.create(KinoCard.prototype);
    c._kino = {
      activity: "aus",
      targetActivity: null,
      offActivity: "aus",
      progress: null,
      activities: [{ key: "aus", name: "Aus", controlClass: "off" }],
    };
    c._view = { main: "home" };
    c._library = { items: [], total: 0 };
    c._resume = [];
    c._recent = [{ id: "r1", title: "Neu", year: 2026 }];
    c._homeRowsAt = Date.now(); // suppress the fetch — no hass in this test
    return c;
  };

  test("the library home is reachable while the theater is off (FR-41)", () => {
    const html = card()._renderBody();
    assert.match(html, /Kino ist ausgeschaltet/);
    assert.match(html, /data-act="open-library"/);
    assert.match(html, /Zuletzt hinzugefügt/);
  });

  test("favourites get their own row, with a way into the full list (0.6.0)", () => {
    const c = card();
    c._favorites = [{ id: "f1", title: "Heat", year: 1995 }];
    const html = c._renderBody();
    assert.match(html, /Favoriten/);
    assert.match(html, /data-act="open-detail" data-key="f1"/);
    assert.match(html, /data-act="open-favorites"/);
  });

  test("no favourites, no row", () => {
    assert.doesNotMatch(card()._renderBody(), /Favoriten/);
  });

  test("an open library view survives regardless of power", () => {
    const c = card();
    c._view = {
      main: "library",
      category: "movies",
      query: "",
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      filters: { tags: [], genres: [], countries: [], ratings: [], yearFrom: null, yearTo: null },
    };
    c._library = { items: [], total: 0, hasMore: false, loading: true, error: null };
    assert.match(c._renderBody(), /Wird geladen/);
  });
});

describe("view modes", () => {
  const card = () => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._view = { viewMode: "poster" };
    return c;
  };
  const item = {
    id: "abc",
    title: "Film",
    year: 2020,
    res4k: true,
    favorite: true,
    watched: true,
    continueWatching: 40,
  };

  test("every mode renders the item as an open-detail target", () => {
    const c = card();
    for (const mode of ["poster", "posterCard", "thumb", "thumbCard", "banner", "list"]) {
      c._view.viewMode = mode;
      const html = c._renderItems([item]);
      assert.match(html, /data-act="open-detail"/, mode);
      assert.match(html, /data-key="abc"/, mode);
    }
  });

  test("card modes carry the card frame, bare modes do not", () => {
    const c = card();
    c._view.viewMode = "posterCard";
    assert.match(c._renderItems([item]), /tilecard/);
    c._view.viewMode = "poster";
    assert.doesNotMatch(c._renderItems([item]), /tilecard/);
  });

  test("a banner without banner art falls back and gets a caption", () => {
    const c = card();
    c._view.viewMode = "banner";
    const html = c._renderItems([item]);
    assert.match(html, /\/api\/kino\/artwork\/abc\/Backdrop/);
    assert.match(html, /class="caption">Film</);
  });

  test("the list row shows the watched and favorite flags", () => {
    const c = card();
    c._view.viewMode = "list";
    const html = c._renderItems([item]);
    assert.match(html, /class="seen"/);
    assert.match(html, /class="fav"/);
  });
});

describe("filter sheet layout", () => {
  test("chip groups wrap instead of scrolling, and the sheet is keyed", () => {
    const c = Object.create(KinoCard.prototype);
    c._view = {
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      filters: { tags: [], genres: [], countries: [], ratings: [], yearFrom: null, yearTo: null },
    };
    c._facets = { genres: ["Drama"], countries: [], ratings: ["FSK-16"], yearMin: 1957, yearMax: 2026 };
    c._library = { total: 42 };
    const html = c._renderFilterSheet();
    assert.match(html, /data-sheet="filter"/);
    assert.match(html, /class="chipwrap"/);
    // The flex-shrink workaround made rows clip on phones — never again.
    assert.doesNotMatch(html, /posterrow hscroll" style="flex-wrap/);
  });
});

describe("device chips", () => {
  const kino = {
    activity: "film",
    targetActivity: "aus",
    offActivity: "aus",
    progress: { percent: 20 },
    activities: [
      { key: "film", name: "Film", devices: ["beamer", "zidoo"] },
      { key: "aus", name: "Aus", devices: [] },
    ],
    devices: [
      { key: "beamer", name: "Beamer", health: "stopping" },
      { key: "zidoo", name: "Zidoo", health: "off" },
    ],
  };

  test("shutting down still shows the devices being stopped", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = kino;
    const html = card._renderDeviceChips();
    assert.match(html, /Beamer/);
    assert.match(html, /Zidoo/);
  });

  test("once off, there are no chips", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { ...kino, activity: "aus", targetActivity: null, progress: null };
    assert.equal(card._renderDeviceChips(), "");
  });

  test("a switch shows the union of touched devices, stops included (F6)", () => {
    // film -> netflix: the Zidoo is being stopped and is not a device of the
    // target activity — it must still get a chip while it goes down.
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      activity: "film",
      targetActivity: "netflix",
      offActivity: "aus",
      progress: { percent: 40, devices: ["beamer", "zidoo", "shield"] },
      activities: [
        { key: "film", name: "Film", devices: ["beamer", "zidoo"] },
        { key: "netflix", name: "Streaming", devices: ["beamer", "shield"] },
        { key: "aus", name: "Aus", devices: [] },
      ],
      devices: [
        { key: "beamer", name: "Beamer", health: "ready" },
        { key: "zidoo", name: "Zidoo", health: "stopping" },
        { key: "shield", name: "Shield", health: "starting" },
      ],
    };
    const html = card._renderDeviceChips();
    assert.match(html, /Zidoo/);
    assert.match(html, /Shield/);
    assert.match(html, /Beamer/);
  });
});

describe("pending item (F5)", () => {
  test("the queued title stays on screen during the transition", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      activity: "aus",
      targetActivity: "film",
      offActivity: "aus",
      artworkSignature: "sig",
      pendingItem: { id: "abc", title: "The Beekeeper" },
      progress: { percent: 10, etaSeconds: 60, bottleneck: "Beamer startet" },
      activities: [
        { key: "film", name: "Film", devices: [] },
        { key: "aus", name: "Aus", devices: [] },
      ],
    };
    const html = card._renderProgress();
    assert.match(html, /The Beekeeper/);
    assert.match(html, /startet gleich/);
    assert.match(html, /artwork\/abc\/Primary/);
  });

  test("the title also survives the gap when no progress is reported", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      activity: "film",
      targetActivity: null,
      offActivity: "aus",
      artworkSignature: "sig",
      pendingItem: { id: "abc", title: "The Beekeeper" },
      progress: null,
      activities: [{ key: "film", name: "Film", devices: [] }],
    };
    assert.match(card._renderProgress(), /The Beekeeper/);
  });

  test("nothing renders without a pending item", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { pendingItem: null, progress: null };
    assert.equal(card._renderProgress(), "");
  });
});

describe("displayLabel (F8)", () => {
  test("player track strings are prettified, values untouched", () => {
    assert.equal(
      helpers.displayLabel("0: English Dolby TrueHD with Dolby Atmos 48.0KHz"),
      "Englisch · TrueHD Atmos"
    );
    assert.equal(
      helpers.displayLabel("1: English Dolby Digital Plus with Dolby Atmos 48.0KHz"),
      "Englisch · Dolby Digital Plus Atmos"
    );
    assert.equal(helpers.displayLabel("0: Off"), "Aus");
    assert.equal(helpers.displayLabel("2: German Forced"), "Deutsch · erzwungen");
  });

  test("processor states pass through, none reads as a dash", () => {
    assert.equal(helpers.displayLabel("none"), "—");
    assert.equal(helpers.displayLabel(null), "—");
    assert.equal(helpers.displayLabel("auto"), "auto");
    assert.equal(helpers.displayLabel("Kino Referenz"), "Kino Referenz");
  });

  test("an unparseable track label still says something", () => {
    assert.equal(helpers.displayLabel("3: Klingon"), "Klingon");
  });
});

describe("episode naming (F2)", () => {
  const episode = {
    id: "ep1",
    title: "Der Drachenritt",
    kind: "episode",
    seriesName: "House of the Dragon",
    episodeCode: "S03E08",
    year: 2026,
    runtime: 56,
  };

  test("an episode row is recognised by its series", () => {
    assert.equal(helpers.itemTitle(episode), "House of the Dragon");
    assert.equal(helpers.itemMeta(episode), "S03E08 · Der Drachenritt");
  });

  test("movies keep their own title and meta", () => {
    const movie = { id: "m", title: "Heat", kind: "movie", year: 1995, runtime: 170, rating: 8.3 };
    assert.equal(helpers.itemTitle(movie), "Heat");
    assert.equal(helpers.itemMeta(movie), "1995 · 170 Min · ★8.3");
  });
});

describe("single-value facet groups (F12)", () => {
  test("a group with one lone value is not offered", () => {
    const c = Object.create(KinoCard.prototype);
    c._view = {
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      filters: { tags: [], genres: [], countries: [], ratings: [], yearFrom: null, yearTo: null },
    };
    c._facets = { genres: ["Drama", "Action"], countries: ["Deutschland"], ratings: ["FSK-16"], yearMin: 1957, yearMax: 2026 };
    c._library = { total: 42 };
    const html = c._renderFilterSheet();
    assert.match(html, /Drama/);
    assert.doesNotMatch(html, /Deutschland/);
    assert.doesNotMatch(html, /FSK-16/);
  });
});

describe("shutdown honesty (F13)", () => {
  const kino = {
    state: "stopping",
    activity: "film",
    targetActivity: "aus",
    offActivity: "aus",
    progress: { percent: 10 },
    activities: [
      { key: "film", name: "Film", devices: [] },
      { key: "aus", name: "Aus", devices: [] },
    ],
    entities: {},
    controls: {},
  };

  test("the footer shows no dead volume row while shutting down", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = kino;
    card._view = {};
    const html = card._renderFooter();
    assert.match(html, /Wird ausgeschaltet…/);
    assert.doesNotMatch(html, /data-act="vol"/);
  });

  test("the activity chip says 'Wird ausgeschaltet…', not 'Wechsel zu Aus…'", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = kino;
    card._view = { activityMenu: false };
    const html = card._renderActivitySelector();
    assert.match(html, /Wird ausgeschaltet…/);
    assert.doesNotMatch(html, /Wechsel zu Aus/);
  });
});

describe("entity select block", () => {
  const card = Object.create(KinoCard.prototype);

  test("filters options the device rejects, but shows the state honestly", () => {
    // The Trinnov reports upmixer "none" but refuses it as a choice —
    // selecting it failed with "Unknown upmixer option: none".
    card._hass = {
      states: {
        "select.upmixer": {
          state: "none",
          attributes: { options: ["none", "auto", "dolby"] },
        },
      },
    };
    const html = card._entitySelectBlock("select.upmixer", "Upmixer", ["none"]);
    assert.doesNotMatch(html, /value="none"/);
    // Raw `none` never reaches the screen — it reads "—" (F8).
    assert.match(html, /disabled selected>—</);
    assert.match(html, /value="auto"/);
  });

  test("a selectable current state needs no orphan entry", () => {
    card._hass = {
      states: {
        "select.upmixer": {
          state: "auto",
          attributes: { options: ["none", "auto"] },
        },
      },
    };
    const html = card._entitySelectBlock("select.upmixer", "Upmixer", ["none"]);
    assert.doesNotMatch(html, /disabled/);
    assert.match(html, /value="auto" selected/);
  });
});

describe("playing sheet", () => {
  test("'Wiedergabe beenden' closes the sheet, not just the film", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      entities: { player: "media_player.kino" },
      controls: {},
      nowPlaying: null,
    };
    card._view = {};
    card._hass = {
      states: {
        "media_player.kino": {
          state: "playing",
          attributes: { media_title: "X", media_duration: 100, media_position: 10 },
        },
      },
    };
    const html = card._renderPlayingSheet();
    assert.match(html, /data-act="stop-playing"/);
    assert.doesNotMatch(html, /data-act="transport" data-key="media_stop"/);
  });

  /**
   * The playback view shows the film, not just the transport: the catalogue
   * entry behind `nowPlaying` supplies the poster, the meta line, the format
   * badges, the synopsis, the cast and the similar row.
   */
  const ITEM = {
    id: "m1",
    title: "Edge of Tomorrow",
    kind: "movie",
    year: 2014,
    runtime: 113,
    genres: ["Sci-Fi", "Action"],
    // Shaped like the live payload, not like the mockup: the formats arrive
    // as engineering strings and a track list.
    res4k: true,
    officialRating: "FSK-12",
    videoFormat: "3840×2160 · @23.976Hz · HDR",
    audioFormat: "DTS · 7.1 · eng",
    audioTracks: [
      { codec: "DTS", channelLayout: "7.1", title: "DTS-HD MA 7.1", default: true },
    ],
    overview: "Cage stirbt und erwacht wieder.",
    people: [{ id: "p1", name: "Tom Cruise", role: "Cage", type: "Actor" }],
  };

  const playingCard = (overrides = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      entities: { player: "media_player.kino" },
      controls: {},
      artworkSignature: "sig",
      demo: {},
      nowPlaying: overrides.nowPlaying !== undefined ? overrides.nowPlaying : { id: "m1" },
    };
    card._view = {
      playingItemId: "m1",
      playingItem: overrides.item !== undefined ? overrides.item : ITEM,
      playingSimilar: overrides.similar || null,
    };
    card._hass = {
      states: {
        "media_player.kino": {
          state: "playing",
          attributes: {
            media_title: "edge.of.tomorrow.2014.mkv",
            media_duration: 6809,
            media_position: 1282,
          },
        },
      },
    };
    return card;
  };

  test("the hero carries the film's own title, length and formats", () => {
    const html = playingCard()._renderPlayingSheet();
    assert.match(html, /Edge of Tomorrow/);
    // Not the filename the player reports.
    assert.doesNotMatch(html, /edge\.of\.tomorrow/);
    assert.match(html, /2014 · 1 Std 53 Min · Sci-Fi, Action/);
    assert.match(html, /4K HDR/);
    assert.match(html, /DTS-HD MA 7\.1/);
    assert.match(html, /FSK 12/);
  });

  test("Handlung, Besetzung and Mehr wie dieser Titel follow the controls", () => {
    const html = playingCard({
      similar: [{ id: "s1", title: "Oblivion", year: 2013 }],
    })._renderPlayingSheet();
    const at = (needle) => html.indexOf(needle);
    assert.ok(at("Handlung") > at('class="transport"'));
    assert.ok(at("Besetzung &amp; Crew") > at("Handlung"));
    assert.ok(at("Mehr wie dieser Titel") > at("Besetzung &amp; Crew"));
    assert.match(html, /Oblivion/);
  });

  /**
   * A file Kino could not match still has to play, pause and seek — the view
   * falls back to what the player entity itself reports and simply leaves the
   * film's own material out.
   */
  test("an unmatched file keeps the transport and drops the material", () => {
    const html = playingCard({ nowPlaying: null, item: null })._renderPlayingSheet();
    assert.match(html, /edge\.of\.tomorrow\.2014\.mkv/);
    assert.match(html, /data-act="transport"/);
    assert.match(html, /data-act="seek-to"/);
    assert.doesNotMatch(html, /Handlung/);
    assert.doesNotMatch(html, /Besetzung/);
  });

  test("the scrubber shows the remaining time, not just the two ends", () => {
    const html = playingCard()._renderPlayingSheet();
    assert.match(html, /data-time="elapsed">21:22/);
    assert.match(html, /data-time="remaining">noch 1:32:07/);
    assert.match(html, /data-time="duration">1:53:29/);
  });

  /**
   * Tapping the bar is measured against the track, and the last second is
   * kept — landing exactly on the end would stop the film.
   */
  test("tapping the scrubber seeks to that fraction of the film", async () => {
    const card = playingCard();
    const calls = [];
    card._player = async (...args) => calls.push(args);
    const strip = {
      querySelector: () => ({ getBoundingClientRect: () => ({ left: 20, width: 200 }) }),
    };
    await card._seekToFraction(strip, { clientX: 120 });
    assert.deepEqual(calls, [["media_seek", { seek_position: 3404.5 }]]);

    calls.length = 0;
    await card._seekToFraction(strip, { clientX: 9999 });
    assert.deepEqual(calls, [["media_seek", { seek_position: 6808 }]]);
  });

  test("a title with no duration is not seekable", async () => {
    const card = playingCard();
    card._hass.states["media_player.kino"].attributes.media_duration = 0;
    const calls = [];
    card._player = async (...args) => calls.push(args);
    await card._seekToFraction(
      { querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, width: 200 }) }) },
      { clientX: 100 }
    );
    assert.deepEqual(calls, []);
  });

  /**
   * The player view and the detail sheet can both be open, so one shared
   * "mehr" flag would expand the synopsis nobody tapped.
   */
  test("each sheet's synopsis expands on its own flag", () => {
    const card = Object.create(KinoCard.prototype);
    const long = "x".repeat(400);
    card._view = { overviewOpen: false, playingOverviewOpen: true };
    const detail = card._renderOverview({ overview: long });
    const playing = card._renderOverview({ overview: long }, "playingOverviewOpen");
    assert.match(detail, /class="overview clamped"/);
    assert.match(detail, /data-key="overviewOpen"/);
    assert.doesNotMatch(playing, /clamped/);
    assert.match(playing, /data-key="playingOverviewOpen"/);
  });
});

describe("the playing view's catalogue entry", () => {
  const makeCard = (nowPlaying) => {
    const card = Object.create(KinoCard.prototype);
    const asked = [];
    card._kino = { nowPlaying };
    card._view = { playingItemId: null, playingItem: null, playingSimilar: null };
    card._render = () => {};
    card._ws = async (msg) => {
      asked.push(msg.type);
      if (msg.type === "kino/library/item") return { id: msg.item_id, title: "X" };
      return { items: [{ id: "s1" }] };
    };
    return [card, asked];
  };

  test("one fetch per title, not one per state poll", async () => {
    const [card, asked] = makeCard({ id: "m1" });
    await card._syncPlayingItem();
    await card._syncPlayingItem();
    await card._syncPlayingItem();
    assert.deepEqual(asked.sort(), ["kino/library/item", "kino/library/similar"]);
    assert.equal(card._view.playingItem.id, "m1");
  });

  test("the next film drops the last one's material before its own arrives", async () => {
    const [card] = makeCard({ id: "m1" });
    await card._syncPlayingItem();
    card._view.playingSimilar = [{ id: "s1" }];
    card._kino.nowPlaying = { id: "m2" };
    const pending = card._syncPlayingItem();
    // Synchronously, before either request comes back.
    assert.equal(card._view.playingItem, null);
    assert.equal(card._view.playingSimilar, null);
    await pending;
    assert.equal(card._view.playingItem.id, "m2");
  });

  test("a file with no catalogue entry asks for nothing", async () => {
    const [card, asked] = makeCard(null);
    await card._syncPlayingItem();
    assert.deepEqual(asked, []);
    assert.equal(card._view.playingItemId, null);
  });

  /** A catalogue that cannot answer must not take the transport down. */
  test("a failed lookup leaves the view renderable", async () => {
    const [card] = makeCard({ id: "m1" });
    card._ws = async () => {
      throw new Error("Bibliothek nicht erreichbar");
    };
    await card._syncPlayingItem();
    assert.equal(card._view.playingItem, null);
    assert.equal(card._actionError, undefined);
  });
});

describe("dim", () => {
  /**
   * Dim is the Trinnov's own -20 dB switch, not a light scene — the pill
   * mirrors and drives `controls.dim` and vanishes when none is wired.
   */
  const makeCard = (controls, states = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { entities: { player: "media_player.kino" }, controls };
    card._view = {};
    card._hass = {
      states: {
        "media_player.kino": { state: "playing", attributes: {} },
        ...states,
      },
    };
    return card;
  };

  test("no dim switch wired — no Dim pill", () => {
    const html = makeCard({})._renderVolumeRow(true);
    assert.doesNotMatch(html, /data-act="dim"/);
  });

  test("the pill mirrors the processor's own switch state", () => {
    const card = makeCard(
      { dim: "switch.trinnov_dim" },
      { "switch.trinnov_dim": { state: "on", attributes: {} } }
    );
    assert.match(card._renderVolumeRow(true), /data-act="dim" aria-pressed="true"/);
    card._hass.states["switch.trinnov_dim"].state = "off";
    assert.match(card._renderVolumeRow(true), /data-act="dim" aria-pressed="false"/);
  });

  test("toggling drives the switch, never a scene", async () => {
    const card = makeCard(
      { dim: "switch.trinnov_dim" },
      { "switch.trinnov_dim": { state: "off", attributes: {} } }
    );
    const calls = [];
    card._callService = async (...args) => calls.push(args);
    await card._toggleDim();
    assert.deepEqual(calls, [
      ["switch", "turn_on", { entity_id: "switch.trinnov_dim" }],
    ]);
  });
});

describe("re-render signature", () => {
  /**
   * A playing media_player republishes its position constantly. Rebuilding
   * the markup for that recreates every <img>, which is what made the
   * playback view flicker — so a moved position must not count as a change.
   */
  const card = Object.create(KinoCard.prototype);
  card._kino = {
    entities: { player: "media_player.kino", volume: "number.kino_volume" },
    controls: {},
  };
  const hass = (overrides = {}) => ({
    states: {
      "media_player.kino": {
        state: overrides.state || "playing",
        attributes: {
          media_position: overrides.position ?? 10,
          media_position_updated_at: "2026-08-11T21:00:00+00:00",
          media_title: overrides.title || "The Death of Robin Hood",
          media_duration: 7314,
          entity_picture: overrides.picture || "/api/media_player_proxy/x?token=1",
          is_volume_muted: overrides.muted || false,
        },
      },
      "number.kino_volume": { state: overrides.volume || "-30.0", attributes: {} },
    },
  });
  const signatureOf = (overrides) => {
    card._hass = hass(overrides);
    return card._renderSignature();
  };

  test("a moved position is not a re-render", () => {
    assert.equal(signatureOf({ position: 10 }), signatureOf({ position: 4000 }));
  });

  test("pausing is", () => {
    assert.notEqual(signatureOf({}), signatureOf({ state: "paused" }));
  });

  test("a new title is", () => {
    assert.notEqual(signatureOf({}), signatureOf({ title: "Gravity" }));
  });

  test("a volume step is", () => {
    assert.notEqual(signatureOf({}), signatureOf({ volume: "-32.0" }));
  });

  test("muting is", () => {
    assert.notEqual(signatureOf({}), signatureOf({ muted: true }));
  });

  test("a new poster is", () => {
    assert.notEqual(signatureOf({}), signatureOf({ picture: "/other.jpg" }));
  });
});

describe("new filter buckets (0.5.0)", () => {
  const empty = helpers.emptyFilters();

  test("emptyFilters carries every bucket the sheet offers", () => {
    assert.deepEqual(empty.tags, []);
    assert.deepEqual(empty.people, []);
    assert.deepEqual(empty.audioLangs, []);
    assert.equal(empty.minRating, null);
    assert.equal(empty.minCritic, null);
  });

  test("people, languages and minimum ratings count as active filters", () => {
    assert.equal(
      helpers.activeFilterCount({
        ...empty,
        people: [{ id: "p1", name: "Gene Hackman" }],
        audioLangs: ["ger"],
        minRating: 7,
        minCritic: 80,
      }),
      4
    );
  });

  test("queryFromFilters translates them into the WebSocket command", () => {
    const msg = helpers.queryFromFilters(
      {
        ...empty,
        people: [{ id: "p1", name: "Gene Hackman" }],
        audioLangs: ["ger", "eng"],
        minRating: 7,
        minCritic: 80,
      },
      "movies",
      "",
      "added"
    );
    assert.deepEqual(msg.person_ids, ["p1"]);
    assert.deepEqual(msg.audio_langs, ["ger", "eng"]);
    assert.equal(msg.min_rating, 7);
    assert.equal(msg.min_critic, 80);
  });

  test("subtitle languages are their own filter (0.6.0)", () => {
    const filters = { ...empty, audioLangs: ["eng"], subtitleLangs: ["ger"] };
    assert.equal(helpers.activeFilterCount(filters), 2);
    const msg = helpers.queryFromFilters(filters, "movies", "", "added");
    assert.deepEqual(msg.audio_langs, ["eng"]);
    assert.deepEqual(msg.subtitle_langs, ["ger"]);
  });

  test("absent buckets translate to neutral values", () => {
    const legacy = { tags: [], genres: [], countries: [], yearFrom: null, yearTo: null };
    const msg = helpers.queryFromFilters(legacy, "movies", "", "added");
    assert.deepEqual(msg.person_ids, []);
    assert.deepEqual(msg.audio_langs, []);
    assert.deepEqual(msg.subtitle_langs, []);
    assert.equal(msg.min_rating, null);
    assert.equal(msg.min_critic, null);
  });
});

describe("langLabel", () => {
  test("names the household languages in German", () => {
    assert.equal(helpers.langLabel("ger"), "Deutsch");
    assert.equal(helpers.langLabel("eng"), "Englisch");
    assert.equal(helpers.langLabel("jpn"), "Japanisch");
  });

  test("an unknown code still says something", () => {
    assert.equal(helpers.langLabel("xxx"), "XXX");
    assert.equal(helpers.langLabel(null), "—");
  });
});

describe("criticLabel", () => {
  test("renders a rounded percentage", () => {
    assert.equal(helpers.criticLabel(93), "93 %");
    assert.equal(helpers.criticLabel(59.6), "60 %");
  });

  test("says nothing when no score is on file", () => {
    assert.equal(helpers.criticLabel(null), null);
    assert.equal(helpers.criticLabel(undefined), null);
    assert.equal(helpers.criticLabel("keine"), null);
  });
});

describe("personRole", () => {
  test("actors show their character", () => {
    assert.equal(helpers.personRole({ type: "Actor", role: "Michelle" }), "Michelle");
    assert.equal(helpers.personRole({ type: "Actor" }), "");
  });

  test("crew shows a German job title", () => {
    assert.equal(helpers.personRole({ type: "Director" }), "Regie");
    assert.equal(helpers.personRole({ type: "Writer" }), "Drehbuch");
    assert.equal(helpers.personRole({ type: "GuestStar" }), "Gastauftritt");
  });

  test("an unknown credit falls back to what Jellyfin sent", () => {
    assert.equal(helpers.personRole({ type: "Grip", role: "Key Grip" }), "Key Grip");
    assert.equal(helpers.personRole(null), "");
  });
});

describe("collapsible filter sheet (0.5.0)", () => {
  const sheetCard = (overrides = {}) => {
    const c = Object.create(KinoCard.prototype);
    c._view = {
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      gridSize: "m",
      category: "movies",
      filters: helpers.emptyFilters(),
      filterCollapsed: {},
      ...overrides,
    };
    c._facets = {
      genres: ["Action", "Crime"],
      countries: [],
      ratings: ["FSK-16", "FSK-18"],
      audioLanguages: ["ger", "eng"],
      subtitleLanguages: ["ger", "eng", "fre"],
      yearMin: 1957,
      yearMax: 2026,
    };
    c._library = { total: 42 };
    return c;
  };

  test("every facet group folds and the CTA sticks", () => {
    const html = sheetCard()._renderFilterSheet();
    assert.match(html, /data-act="toggle-group" data-key="genres"/);
    assert.match(html, /data-act="toggle-group" data-key="tags"/);
    assert.match(html, /class="filtercta"/);
    assert.match(html, /data-role="filter-cta"/);
    assert.match(html, /42 Titel anzeigen/);
  });

  test("a collapsed group hides its body but keeps its badge", () => {
    const c = sheetCard({
      filterCollapsed: { genres: true },
      filters: { ...helpers.emptyFilters(), genres: ["Action"] },
    });
    const html = c._renderFilterSheet();
    assert.match(html, /data-group-body="genres" hidden/);
    assert.match(html, /aria-expanded="false"/);
    // The badge says one selection is folded away in there.
    assert.match(html, /<span class="groupbadge">1<\/span>/);
  });

  test("chips wear the counts from the preview", () => {
    const c = sheetCard();
    c._facetCounts = {
      total: 2,
      genres: { Action: 3, Crime: 0 },
      ratings: {},
      audioLangs: { ger: 2 },
      tags: { only_4k: 1 },
    };
    const html = c._renderFilterSheet();
    assert.match(html, /Action\s*<span class="chipcount">3<\/span>/);
    // A value that would empty the grid is dimmed, not hidden.
    assert.match(html, /emptying[\s\S]{0,200}?data-kind="genre" data-key="Crime"/);
    assert.match(html, /Deutsch\s*<span class="chipcount">2<\/span>/);
  });

  test("a long facet list is cut down, with the rest one tap away", () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const c = sheetCard();
    c._facets = { ...c._facets, subtitleLanguages: many };
    const html = c._renderFilterSheet();
    assert.match(html, /data-act="expand-facet" data-key="sublang"/);
    assert.match(html, /\+ 26 weitere/);
    assert.doesNotMatch(html, /data-kind="sublang" data-key="l39"/);
  });

  test("a chosen value is never cut away, however far down the list", () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const c = sheetCard({
      filters: { ...helpers.emptyFilters(), subtitleLangs: ["l39"] },
    });
    c._facets = { ...c._facets, subtitleLanguages: many };
    assert.match(c._renderFilterSheet(), /data-kind="sublang" data-key="l39"/);
  });

  test("an expanded group shows everything", () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i}`);
    const c = sheetCard({ facetsExpanded: { sublang: true } });
    c._facets = { ...c._facets, subtitleLanguages: many };
    const html = c._renderFilterSheet();
    assert.match(html, /data-kind="sublang" data-key="l39"/);
    assert.doesNotMatch(html, /weitere/);
  });

  test("both language groups exist, in either category", () => {
    for (const category of ["movies", "shows"]) {
      const html = sheetCard({ category })._renderFilterSheet();
      assert.match(html, /Tonspur/);
      assert.match(html, /data-kind="lang" data-key="ger"/);
      assert.match(html, /Untertitel/);
      assert.match(html, /data-kind="sublang" data-key="eng"/);
    }
  });

  test("rating thresholds and tile sizes are offered", () => {
    const html = sheetCard()._renderFilterSheet();
    assert.match(html, /data-act="min-rating" data-key="7"/);
    assert.match(html, /data-act="min-critic" data-key="80"/);
    assert.match(html, /Kachelgröße/);
    assert.match(html, /data-act="grid-size-set" data-key="s"/);
  });
});

describe("critics score on the wall (0.6.2)", () => {
  const card = () => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._view = { viewMode: "poster", gridSize: "m" };
    return c;
  };
  const item = { id: "m1", title: "Heat", year: 1995, runtime: 170, rating: 7.9 };

  test("the meta line carries the critics score beside the community one", () => {
    const html = card()._metaLine({ ...item, criticRating: 84 });
    assert.match(html, /1995 · 170 Min · ★7\.9/);
    assert.match(html, /84 %/);
    assert.match(html, /Kritikerwertung/);
  });

  test("a fresh score and a rotten one get different tomatoes", () => {
    const fresh = card()._metaLine({ ...item, criticRating: 84 });
    const rotten = card()._metaLine({ ...item, criticRating: 31 });
    assert.notEqual(fresh, rotten);
    assert.match(rotten, /31 %/);
  });

  test("no critics score, no badge — and the text is untouched", () => {
    const html = card()._metaLine(item);
    assert.match(html, /1995 · 170 Min · ★7\.9/);
    assert.doesNotMatch(html, /%/);
  });

  test("every grid layout shows it", () => {
    const scored = { ...item, criticRating: 84 };
    for (const mode of ["poster", "posterCard", "thumb", "thumbCard", "list"]) {
      assert.match(card()._tile(scored, mode), /84 %/, `missing in ${mode}`);
    }
  });

  test("a title is still escaped around the badge", () => {
    const html = card()._metaLine({
      id: "x",
      kind: "episode",
      episodeCode: "S01E01",
      title: "<script>",
      criticRating: 84,
    });
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });
});

describe("grid size", () => {
  const item = { id: "abc", title: "Film", year: 2020 };

  test("the chosen size classes the grid", () => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._view = { viewMode: "poster", gridSize: "s" };
    assert.match(c._renderItems([item]), /postergrid size-s/);
    c._view.gridSize = "l";
    c._view.viewMode = "thumb";
    assert.match(c._renderItems([item]), /thumbgrid size-l/);
  });

  test("an unset size falls back to the classic look", () => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._view = { viewMode: "poster" };
    assert.match(c._renderItems([item]), /postergrid size-m/);
  });
});

describe("detail sheet extras (0.5.0)", () => {
  const detailCard = (detail, similar = null) => {
    const c = Object.create(KinoCard.prototype);
    c._kino = {
      artworkSignature: "sig",
      activity: "film",
      targetActivity: null,
      offActivity: "aus",
      progress: null,
      activities: [
        { key: "film", name: "Film", media: true, controlClass: "media" },
      ],
    };
    c._view = {
      detailId: detail.id,
      detail,
      seasons: null,
      seasonId: null,
      episodes: null,
      similar,
      overviewOpen: false,
    };
    return c;
  };
  const movie = {
    id: "m1",
    kind: "movie",
    title: "Heat",
    year: 1995,
    runtime: 170,
    rating: 8.3,
    criticRating: 89,
    officialRating: "FSK-16",
    genres: ["Crime", "Drama"],
    playable: true,
    people: [
      { id: "p1", name: "Al Pacino", type: "Actor", role: "Vincent Hanna", imageTag: "t" },
      { id: "p2", name: "Michael Mann", type: "Director", role: null, imageTag: null },
    ],
  };

  test("genres are buttons that jump into the library", () => {
    const html = detailCard(movie)._renderDetailSheet();
    assert.match(html, /data-act="genre-jump" data-key="Crime"/);
  });

  test("the critics tomato appears next to the community star", () => {
    const html = detailCard(movie)._renderDetailSheet();
    assert.match(html, /89 %/);
    assert.match(html, /★<\/span>8\.3/);
  });

  test("below 60 the tomato goes rotten", () => {
    const fresh = detailCard(movie)._renderDetailSheet();
    const rotten = detailCard({ ...movie, criticRating: 41 })._renderDetailSheet();
    assert.match(fresh, /circle cx="12" cy="14"/);
    assert.doesNotMatch(rotten, /circle cx="12" cy="14"/);
    assert.match(rotten, /41 %/);
  });

  test("cast and crew are tappable person filters", () => {
    const html = detailCard(movie)._renderDetailSheet();
    assert.match(html, /Besetzung &amp; Crew/);
    assert.match(html, /data-act="person-jump" data-key="p1"/);
    assert.match(html, /data-name="Al Pacino"/);
    assert.match(html, /Vincent Hanna/);
    assert.match(html, /Regie/);
    // No portrait on file: initials stand in.
    assert.match(html, /<span class="initials">MM<\/span>/);
  });

  test("similar titles render as open-detail posters", () => {
    const html = detailCard(movie, [
      { id: "s1", title: "Collateral", year: 2004 },
    ])._renderDetailSheet();
    assert.match(html, /Mehr wie dieser Titel/);
    assert.match(html, /data-act="open-detail" data-key="s1"/);
  });

  test("no people, no similar — no empty sections", () => {
    const html = detailCard({ ...movie, people: [] }, [])._renderDetailSheet();
    assert.doesNotMatch(html, /Besetzung/);
    assert.doesNotMatch(html, /Mehr wie dieser Titel/);
  });

  describe("audio and subtitle tracks (0.6.0)", () => {
    const tracked = {
      ...movie,
      audioTracks: [
        { index: 2, language: "eng", codec: "AC3", channelLayout: "5.1" },
        {
          index: 1,
          language: "ger",
          codec: "DTS",
          channelLayout: "7.1",
          default: true,
        },
        { index: 3, language: "eng", codec: "AC3", commentary: true },
      ],
      subtitleTracks: [
        { index: 4, language: "ger", codec: "PGSSUB", forced: true },
        { index: 5, language: "fre", codec: "SUBRIP" },
      ],
    };

    test("every track is listed, default first, in German", () => {
      const html = detailCard(tracked)._renderDetailSheet();
      assert.match(html, /Tonspuren &amp; Untertitel/);
      assert.match(html, /Ton \(3\)/);
      assert.match(html, /Untertitel \(2\)/);
      // The default track leads, whatever its index.
      const order = [...html.matchAll(/Deutsch · 7\.1 · DTS|Englisch · 5\.1 · AC3/g)];
      assert.equal(order[0][0], "Deutsch · 7.1 · DTS");
      assert.match(html, /class="std"/);
    });

    test("a long list is cut to three, with the rest one tap away", () => {
      const many = {
        ...movie,
        audioTracks: [{ index: 1, language: "ger", default: true }],
        subtitleTracks: Array.from({ length: 21 }, (_, i) => ({
          index: i + 2,
          language: "eng",
          codec: `C${i}`,
        })),
      };
      const html = detailCard(many)._renderDetailSheet();
      assert.match(html, /Untertitel \(21\)/);
      assert.match(html, /data-act="expand-tracks" data-key="subtitle"/);
      assert.match(html, /\+ 18 weitere/);
      assert.match(html, /Englisch · C2/);
      assert.doesNotMatch(html, /Englisch · C20/);
      // One audio track needs no expander of its own.
      assert.doesNotMatch(html, /data-key="audio"/);
    });

    test("an expanded column shows everything", () => {
      const many = {
        ...movie,
        subtitleTracks: Array.from({ length: 21 }, (_, i) => ({
          index: i + 2,
          language: "eng",
          codec: `C${i}`,
        })),
      };
      const c = detailCard(many);
      c._view.tracksExpanded = { subtitle: true };
      const html = c._renderDetailSheet();
      assert.match(html, /Englisch · C20/);
      assert.doesNotMatch(html, /weitere/);
    });

    test("a commentary never takes one of the three preview slots", () => {
      const withEarlyCommentary = {
        ...movie,
        audioTracks: [
          { index: 1, language: "eng", commentary: true },
          { index: 2, language: "ger", codec: "DTS" },
          { index: 3, language: "fre", codec: "AC3" },
          { index: 4, language: "ita", codec: "AC3" },
        ],
      };
      const html = detailCard(withEarlyCommentary)._renderDetailSheet();
      assert.match(html, /Deutsch · DTS/);
      assert.match(html, /Italienisch · AC3/);
      assert.doesNotMatch(html, /Kommentar/);
    });

    test("a commentary says so, and a forced subtitle too", () => {
      const html = detailCard(tracked)._renderDetailSheet();
      assert.match(html, /Englisch · AC3 · Kommentar/);
      assert.match(html, /Deutsch · PGSSUB · erzwungen/);
    });

    test("a title with no stream data grows no empty section", () => {
      const html = detailCard(movie)._renderDetailSheet();
      assert.doesNotMatch(html, /Tonspuren/);
    });
  });

  describe("trailers (0.6.0)", () => {
    test("one trailer gets one plain button", () => {
      const html = detailCard({
        ...movie,
        trailers: [{ name: "Trailer", url: "https://youtu.be/x" }],
      })._renderDetailSheet();
      assert.match(html, /data-act="trailer" data-key="0"/);
      assert.match(html, /Trailer ansehen/);
    });

    test("several trailers are told apart by name", () => {
      const html = detailCard({
        ...movie,
        trailers: [
          { name: "Teaser", url: "https://youtu.be/a" },
          { name: "Offizieller Trailer", url: "https://youtu.be/b" },
        ],
      })._renderDetailSheet();
      assert.match(html, /data-act="trailer" data-key="1"/);
      assert.match(html, /Offizieller Trailer/);
    });

    test("no trailer, no button", () => {
      assert.doesNotMatch(detailCard(movie)._renderDetailSheet(), /data-act="trailer"/);
    });
  });

  describe("marking gesehen (0.6.0)", () => {
    test("a film carries a watched toggle next to the heart", () => {
      const html = detailCard(movie)._renderDetailSheet();
      assert.match(html, /data-act="toggle-watched" data-key="m1"/);
      assert.match(html, /Als gesehen markieren/);
    });

    test("a watched film offers the way back", () => {
      const html = detailCard({ ...movie, watched: true })._renderDetailSheet();
      assert.match(html, /Als ungesehen markieren/);
      assert.match(html, /data-act="toggle-watched"[^>]*aria-pressed="true"/);
    });

    test("a series header has no toggle — its seasons do", () => {
      const c = detailCard({ ...movie, kind: "show" });
      c._view.seasons = [
        { id: "s1", title: "Staffel 1", kind: "season", unplayedCount: 3 },
        { id: "s2", title: "Staffel 2", kind: "season", unplayedCount: 0 },
      ];
      c._view.seasonId = "s1";
      c._view.episodes = [];
      const html = c._renderDetailSheet();
      assert.doesNotMatch(html, /data-act="toggle-watched" data-key="m1"/);
      assert.match(html, /data-act="toggle-watched"\s+data-key="s1"/);
      assert.match(html, /Staffel als gesehen markieren/);
    });

    test("a fully watched season offers to undo that", () => {
      const c = detailCard({ ...movie, kind: "show" });
      c._view.seasons = [
        { id: "s2", title: "Staffel 2", kind: "season", unplayedCount: 0 },
      ];
      c._view.seasonId = "s2";
      c._view.episodes = [];
      assert.match(c._renderDetailSheet(), /Staffel als ungesehen markieren/);
    });

    test("every episode row is its own toggle", () => {
      const c = detailCard({ ...movie, kind: "show" });
      c._view.seasons = [{ id: "s1", title: "Staffel 1", kind: "season" }];
      c._view.seasonId = "s1";
      c._view.episodes = [
        { id: "e1", title: "Pilot", episodeCode: "S01E01", watched: true },
        { id: "e2", title: "Zwei", episodeCode: "S01E02" },
      ];
      const html = c._renderDetailSheet();
      assert.match(html, /data-act="toggle-watched" data-key="e1"[\s\S]*?aria-pressed="true"/);
      assert.match(html, /data-act="toggle-watched" data-key="e2"[\s\S]*?aria-pressed="false"/);
    });
  });
});

describe("watched state", () => {
  test("a film is watched when Jellyfin says so", () => {
    assert.equal(helpers.isWatched({ kind: "movie", watched: true }), true);
    assert.equal(helpers.isWatched({ kind: "movie" }), false);
    assert.equal(helpers.isWatched(null), false);
  });

  test("a season is watched when nothing below it is left", () => {
    // Jellyfin never sets `Played` on a season — the count is the truth.
    assert.equal(helpers.isWatched({ kind: "season", unplayedCount: 0 }), true);
    assert.equal(helpers.isWatched({ kind: "season", unplayedCount: 2 }), false);
    assert.equal(helpers.isWatched({ kind: "season" }), false);
  });

  test("the label names what is being marked", () => {
    assert.equal(
      helpers.watchedLabel({ kind: "season", unplayedCount: 3 }),
      "Staffel als gesehen markieren"
    );
    assert.equal(
      helpers.watchedLabel({ kind: "episode", watched: true }),
      "Als ungesehen markieren"
    );
  });
});

describe("track labels", () => {
  test("the language leads, the technical bits follow", () => {
    assert.equal(
      helpers.trackLabel({ language: "ger", codec: "DTS", channelLayout: "7.1" }),
      "Deutsch · 7.1 · DTS"
    );
    assert.equal(helpers.trackLabel({ language: "fre" }), "Französisch");
    assert.equal(helpers.trackLabel(null), "");
  });

  test("an unnamed language is not silently dropped", () => {
    assert.equal(helpers.trackLabel({ language: null, codec: "AC3" }), "— · AC3");
  });

  test("the default track sorts to the top, the rest keep file order", () => {
    const sorted = helpers.sortTracks([
      { index: 3 },
      { index: 1 },
      { index: 2, default: true },
    ]);
    assert.deepEqual(
      sorted.map((t) => t.index),
      [2, 1, 3]
    );
    assert.deepEqual(helpers.sortTracks(null), []);
  });
});

describe("filter groups fold by default (0.6.0)", () => {
  test("a user who has never touched the sheet sees every group folded", () => {
    const collapsed = helpers.filterCollapse(null);
    assert.equal(collapsed.tags, true);
    assert.equal(collapsed.genres, true);
    assert.equal(collapsed.people, true);
    assert.equal(collapsed.sublangs, true);
    assert.equal(collapsed.view, true);
  });

  test("a group the user unfolded stays unfolded", () => {
    const collapsed = helpers.filterCollapse({ genres: false });
    assert.equal(collapsed.genres, false);
    assert.equal(collapsed.tags, true);
  });
});

describe("cast and crew filter (0.6.0)", () => {
  const personCard = (overrides = {}) => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._view = {
      personQuery: "",
      filters: helpers.emptyFilters(),
      ...overrides,
    };
    return c;
  };

  test("chosen names render as chips that drop themselves", () => {
    const c = personCard({
      filters: {
        ...helpers.emptyFilters(),
        people: [{ id: "p1", name: "Guillermo del Toro" }],
      },
    });
    const html = c._renderPersonChips();
    assert.match(html, /data-act="toggle-person"\s+data-key="p1"/);
    assert.match(html, /Guillermo del Toro ✕/);
  });

  test("a short query asks for more letters instead of searching", () => {
    const c = personCard({ personQuery: "d" });
    assert.match(c._renderPersonHits(), /Mindestens zwei Buchstaben/);
  });

  test("hits are offered, minus the names already chosen", () => {
    const c = personCard({
      filters: { ...helpers.emptyFilters(), people: [{ id: "p1", name: "A" }] },
      personQuery: "del",
    });
    c._personHits = [
      { id: "p1", name: "A" },
      { id: "p2", name: "Benicio del Toro", imageTag: "t" },
    ];
    const html = c._renderPersonHits();
    assert.match(html, /data-act="toggle-person" data-key="p2"/);
    assert.doesNotMatch(html, /data-key="p1"/);
  });

  test("a search with nothing behind it says so", () => {
    const c = personCard({ personQuery: "xyzzy" });
    c._personHits = [];
    assert.match(c._renderPersonHits(), /Keine passenden Namen/);
  });

  test("an untouched field offers nothing at all", () => {
    assert.equal(personCard()._renderPersonHits(), "");
  });
});

describe("going back", () => {
  const navCard = (view = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._nav = [];
    card._browserTokens = [];
    card._navToken = 0;
    card._skipPop = 0;
    card._container = null;
    card._restoreScrollTo = null;
    card._library = { items: [], total: 0, hasMore: false, loading: false, error: null };
    card._view = {
      main: "home",
      category: "movies",
      query: "",
      filters: helpers.emptyFilters(),
      detailId: null,
      playingOpen: false,
      filterSheet: false,
      trim: null,
      scEdit: null,
      abSetup: null,
      demoTab: "clips",
      powerConfirm: false,
      activityMenu: false,
      ...view,
    };
    card._renders = 0;
    card._render = () => {
      card._renders += 1;
    };
    return card;
  };

  test("a title opened from the Demos tab closes back onto it", () => {
    const c = navCard({ main: "demos", demoTab: "clips" });
    c._navPush();
    c._view.detailId = "m1";
    c._navBack();
    assert.equal(c._view.main, "demos");
    assert.equal(c._view.detailId, null);
  });

  test("the library's results come back with the view that fetched them", () => {
    const c = navCard({ main: "library" });
    c._library = { items: [{ id: "a" }], total: 1, hasMore: false };
    c._navPush();
    c._view.main = "demos";
    c._library = { items: [], total: 0, hasMore: false };
    c._navBack();
    assert.equal(c._view.main, "library");
    assert.deepEqual(c._library.items, [{ id: "a" }]);
  });

  test("steps unwind one at a time, in the order they were taken", () => {
    const c = navCard();
    c._navPush();
    c._view.main = "library";
    c._navPush();
    c._view.detailId = "m1";
    c._navBack();
    assert.equal(c._view.main, "library");
    assert.equal(c._view.detailId, null);
    c._navBack();
    assert.equal(c._view.main, "home");
  });

  test("the filter sheet applies on the way out instead of reverting", () => {
    // It is a form, not a place: backing out of it is the same as its own
    // close button, which is what shows the selection.
    const c = navCard({ main: "library" });
    let closed = false;
    c._navPush(() => {
      closed = true;
      c._view.filterSheet = false;
    });
    c._view.filterSheet = true;
    c._view.filters.genres = ["Sci-Fi"];
    c._navBack();
    assert.equal(closed, true);
    assert.equal(c._view.filterSheet, false);
    assert.deepEqual(c._view.filters.genres, ["Sci-Fi"]);
  });

  test("a menu is dismissed before any step is spent on it", () => {
    const c = navCard({ main: "library" });
    c._navPush();
    c._view.detailId = "m1";
    c._view.activityMenu = true;
    c._navBack();
    assert.equal(c._view.activityMenu, false);
    assert.equal(c._view.detailId, "m1", "the sheet stays; only the menu closed");
    c._navBack();
    assert.equal(c._view.detailId, null);
  });

  test("the power confirmation closes before the activity menu under it", () => {
    const c = navCard({ activityMenu: true, powerConfirm: true });
    c._navBack();
    assert.equal(c._view.powerConfirm, false);
    assert.equal(c._view.activityMenu, true);
  });

  test("saving an editor removes the step back into it", () => {
    const c = navCard({ main: "demos" });
    c._navPush();
    c._view.trim = { id: "c1" };
    c._navDrop();
    c._view.trim = null;
    assert.equal(c._navBack(), false, "nothing left to go back to");
  });

  test("the first view falls back instead of going nowhere", () => {
    const c = navCard({ main: "library" });
    let fell = false;
    c._navClose(() => {
      fell = true;
      c._view.main = "home";
    });
    assert.equal(fell, true);
    assert.equal(c._view.main, "home");
  });

  test("the trail is bounded, and drops its oldest end", () => {
    const c = navCard();
    for (let i = 0; i < 60; i += 1) c._navPush();
    assert.equal(c._nav.length, 50);
  });
});
