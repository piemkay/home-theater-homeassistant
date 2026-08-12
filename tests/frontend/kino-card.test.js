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
    assert.match(html, /disabled selected>none</);
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
      lightScenes: {},
    };
    card._view = { dimmed: false };
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
