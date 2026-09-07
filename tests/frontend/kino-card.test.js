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

describe("runtimeRangeLabel", () => {
  test("labels every shape of window", () => {
    assert.equal(helpers.runtimeRangeLabel(null, null), null);
    assert.equal(helpers.runtimeRangeLabel(90, 120), "90–120 Min");
    assert.equal(helpers.runtimeRangeLabel(90, 90), "90 Min");
    assert.equal(helpers.runtimeRangeLabel(120, null), "ab 120 Min");
    assert.equal(helpers.runtimeRangeLabel(null, 90), "bis 90 Min");
  });
});

describe("runtimeSteps", () => {
  test("ten-minute rungs across the library's own bounds", () => {
    const steps = helpers.runtimeSteps(88, 201);
    assert.equal(steps[0], 80);
    assert.equal(steps.at(-1), 210);
    assert.ok(steps.includes(90));
    assert.ok(steps.includes(120));
    assert.equal(steps[1] - steps[0], 10);
  });

  test("falls back to a sane ladder when the library reports no bounds", () => {
    const steps = helpers.runtimeSteps(null, null);
    assert.equal(steps[0], 30);
    assert.equal(steps.at(-1), 240);
  });

  test("a five-hour outlier coarsens the rungs instead of flooding the list", () => {
    const steps = helpers.runtimeSteps(3, 600);
    assert.ok(steps.length < 30, `${steps.length} rungs is a wall of numbers`);
    assert.equal(steps.at(-1), 600);
    assert.equal(steps[1] - steps[0], 30);
  });

  test("never offers a zero-minute rung", () => {
    assert.ok(!helpers.runtimeSteps(4, 200).includes(0));
  });

  test("keeps a chosen value on the ladder when the bounds moved under it", () => {
    const steps = helpers.runtimeSteps(90, 180, [95, null]);
    assert.ok(steps.includes(95));
    assert.deepEqual([...steps].sort((a, b) => a - b), steps);
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

  test("counts a runtime window as one filter, open end included", () => {
    assert.equal(
      helpers.activeFilterCount({ ...empty, runtimeFrom: 90, runtimeTo: 120 }),
      1
    );
    assert.equal(helpers.activeFilterCount({ ...empty, runtimeTo: 90 }), 1);
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

  test("translates the runtime window", () => {
    const msg = helpers.queryFromFilters(
      { ...none, runtimeFrom: 90, runtimeTo: 120 },
      "movies",
      "",
      "added"
    );
    assert.equal(msg.runtime_from, 90);
    assert.equal(msg.runtime_to, 120);
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

describe("statusTitle (FR-78)", () => {
  const FILM = { key: "film", name: "Bibliothek" };
  const base = (over) => ({
    state: "on",
    activity: "film",
    targetActivity: null,
    offActivity: "aus",
    degraded: false,
    progress: null,
    statusText: "Bereit",
    ...over,
  });

  test("an idle room names what is on, not that something is", () => {
    assert.equal(helpers.statusTitle(base(), FILM), "Bibliothek läuft");
  });

  test("an off room says so, in the words the design uses", () => {
    const k = base({ state: "off", activity: "aus", statusText: "Ausgeschaltet" });
    assert.equal(helpers.statusTitle(k, null), "Kino ist ausgeschaltet");
  });

  test("a transition names its direction", () => {
    const k = base({ progress: { percent: 10, bottleneck: null }, targetActivity: "film" });
    assert.equal(helpers.statusTitle(k, FILM), "Wechsel zu Bibliothek…");
  });

  test("shutting down is its own sentence, not a switch to Aus", () => {
    const k = base({ progress: { percent: 10, bottleneck: null }, targetActivity: "aus" });
    assert.equal(helpers.statusTitle(k, { key: "aus", name: "Aus" }), "Wird ausgeschaltet…");
  });

  /**
   * The bottleneck names the device everyone is actually waiting for. It is
   * the whole reason the line is worth 12px of the heading, so it outranks
   * both the direction and the engine's generic text.
   */
  test("a bottleneck outranks the direction", () => {
    const k = base({
      progress: { percent: 40, bottleneck: "Beamer wärmt auf…" },
      targetActivity: "film",
    });
    assert.equal(helpers.statusTitle(k, FILM), "Beamer wärmt auf…");
  });

  test("an error and a drift both defer to what the engine says", () => {
    assert.equal(
      helpers.statusTitle(base({ state: "error", statusText: "Trinnov antwortet nicht" })),
      "Trinnov antwortet nicht"
    );
    assert.equal(
      helpers.statusTitle(base({ degraded: true, statusText: "Beamer steht auf HDR 260 DP" }), FILM),
      "Beamer steht auf HDR 260 DP"
    );
  });

  test("no state at all is an empty line, never the word undefined", () => {
    assert.equal(helpers.statusTitle(null), "");
    assert.equal(helpers.statusTitle(base({ activity: "film" }), null), "Bereit");
  });
});

describe("statusColor", () => {
  const k = (over) => ({ activity: "film", offActivity: "aus", progress: null, ...over });

  test("gold while busy beats red and teal both", () => {
    assert.equal(helpers.statusColor(k({ progress: {}, degraded: true })), "var(--kino-gold)");
  });

  test("wrong is red, off is grey, running is teal", () => {
    assert.equal(helpers.statusColor(k({ degraded: true })), "var(--kino-red)");
    assert.equal(helpers.statusColor(k({ state: "error" })), "var(--kino-red)");
    assert.equal(helpers.statusColor(k({ activity: "aus" })), "var(--kino-text3)");
    assert.equal(helpers.statusColor(k({})), "var(--kino-teal)");
    assert.equal(helpers.statusColor(null), "var(--kino-text3)");
  });
});

describe("titleCount", () => {
  test("counts a row's own titles, singular included", () => {
    assert.equal(helpers.titleCount(3), "3 Titel");
    assert.equal(helpers.titleCount(1), "1 Titel");
    assert.equal(helpers.titleCount(0), "0 Titel");
    assert.equal(helpers.titleCount(null), "0 Titel");
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
    assert.match(html, /data-act="open-library"/);
    assert.match(html, /Zuletzt hinzugefügt/);
    // The body no longer explains that the theater is off: that line is the
    // status beside "Aktivität" now, one section up, and a banner repeating
    // it cost a fifth of the phone (FR-78).
    assert.doesNotMatch(html, /Kino ist ausgeschaltet/);
  });

  test("being off is said once, beside Aktivität (FR-78)", () => {
    const html = card()._renderActivitySelector();
    assert.match(html, /class="st-h">Aktivität</);
    assert.match(html, /Kino ist ausgeschaltet/);
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

/**
 * The Start screen, as design/kino-start.dc.html draws it: every activity on
 * screen at once with the room's status beside the heading, Ausschalten as a
 * row of its own, and one segmented control standing in for three tiles.
 */
describe("the Start screen (FR-78)", () => {
  const ACTIVITIES = [
    { key: "aus", name: "Aus", controlClass: "off", icon: "mdi:power" },
    { key: "film", name: "Bibliothek", controlClass: "full", icon: "mdi:movie-open" },
    { key: "netflix", name: "Streaming", controlClass: "handoff", icon: "mdi:television-play" },
    { key: "musik", name: "Musik", controlClass: "mixed", icon: "mdi:music" },
    { key: "steam", name: "Steam", controlClass: "room", icon: "mdi:controller" },
  ];
  const card = (kino = {}, view = {}) => {
    const c = Object.create(KinoCard.prototype);
    c._kino = {
      activity: "aus",
      targetActivity: null,
      offActivity: "aus",
      progress: null,
      degraded: false,
      statusText: "Ausgeschaltet",
      activities: ACTIVITIES,
      lights: null,
      ...kino,
    };
    c._view = { main: "home", startTab: "movies", ...view };
    c._library = { items: [], total: 0 };
    c._resume = [];
    c._recent = [];
    c._favorites = [];
    c._homeRowsAt = Date.now();
    return c;
  };

  test("every activity is on screen, and Aus is not one of them", () => {
    const html = card()._renderActivitySelector();
    assert.equal((html.match(/data-act="activate"/g) || []).length, 4);
    assert.match(html, /data-key="film"[\s\S]*?Bibliothek/);
    assert.match(html, /data-key="steam"[\s\S]*?Steam/);
    assert.doesNotMatch(html, /data-act="activate" data-key="aus"/);
    // No chip to open first: the dropdown was a tap that only revealed taps.
    assert.doesNotMatch(html, /data-act="toggle-menu"/);
  });

  test("the running activity is the pressed tile", () => {
    const html = card({ activity: "film" })._renderActivitySelector();
    assert.match(html, /data-key="film"[\s\S]{0,80}?aria-pressed="true"/);
    assert.match(html, /data-key="musik"[\s\S]{0,80}?aria-pressed="false"/);
    // The label is clipped at 52px, so the tooltip carries the whole name.
    assert.match(html, /title="Bibliothek"/);
  });

  /**
   * The card draws no header of its own — the bar above it is Home
   * Assistant's. Ausschalten therefore has to live in the body, and it is
   * there only when there is something to switch off.
   */
  test("Ausschalten is a row under the tiles, once there is something to switch off", () => {
    assert.doesNotMatch(card()._renderActivitySelector(), /data-act="ask-power-off"/);
    const on = card({ activity: "film" })._renderActivitySelector();
    assert.match(on, /class="st-row" data-act="ask-power-off"/);
    assert.match(on, /Ausschalten/);
  });

  test("a transition keeps the tiles tappable and says what is happening", () => {
    const html = card({
      activity: "film",
      targetActivity: "netflix",
      progress: { percent: 30, bottleneck: "Beamer wärmt auf…" },
    })._renderActivitySelector();
    assert.equal((html.match(/data-act="activate"/g) || []).length, 4);
    assert.match(html, /Beamer wärmt auf…/);
    assert.match(html, /class="dot pulsing"/);
  });

  test("every other screen keeps the compact chip", () => {
    const html = card({ activity: "film" }, { main: "library" })._renderActivitySelector();
    assert.match(html, /data-act="toggle-menu"/);
    assert.doesNotMatch(html, /class="st-grid"/);
  });

  /**
   * A switch takes up to two minutes in this room, and picking the wrong
   * activity is exactly what you notice during them. The chip used to answer
   * the tap by flipping its chevron and opening nothing (FR-78a).
   */
  test("the compact dropdown opens during a transition too", () => {
    const busy = { activity: "film", targetActivity: "netflix", progress: { percent: 30 } };
    const html = card(busy, { main: "library", activityMenu: true })._renderActivitySelector();
    assert.equal((html.match(/data-act="activate"/g) || []).length, 4);
    assert.match(html, /data-act="ask-power-off"/);
  });

  /**
   * A failed shutdown reports the off activity while the room is still in
   * whatever half-state the failure left it (machine.py::_fail). That is
   * precisely when the retry has to be on screen — and with the card's
   * header gone, this row is the only place it can be.
   */
  test("Ausschalten survives a failed shutdown", () => {
    for (const main of ["home", "library"]) {
      const html = card(
        { state: "error", activity: "aus", statusText: "Trinnov antwortet nicht" },
        { main }
      )._renderActivitySelector();
      assert.match(html, /data-act="ask-power-off"/, `missing on ${main}`);
    }
  });

  test("a shutdown already running has nothing left to offer", () => {
    const html = card({
      activity: "film",
      targetActivity: "aus",
      progress: { percent: 20, bottleneck: null },
    })._renderActivitySelector();
    assert.doesNotMatch(html, /data-act="ask-power-off"/);
    assert.match(html, /Wird ausgeschaltet…/);
  });

  test("a room that is cleanly off offers no Ausschalten", () => {
    assert.doesNotMatch(card()._renderActivitySelector(), /data-act="ask-power-off"/);
  });

  test("three tiles become one segmented control", () => {
    const html = card()._renderLibraryHome();
    assert.match(html, /class="st-seg"/);
    assert.equal((html.match(/class="st-segbtn"/g) || []).length, 3);
    assert.match(html, /data-act="open-library" data-key="movies" aria-pressed="true"/);
    assert.match(html, /data-act="open-library" data-key="shows" aria-pressed="false"/);
    assert.match(html, /data-act="open-demos" aria-pressed="false"/);
  });

  /** The highlight is a promise about the link beside it, not a tab. */
  test("Erkunden opens whichever segment is lit", () => {
    const shows = card({}, { startTab: "shows" })._renderLibraryHome();
    assert.match(shows, /data-act="open-start-tab">Erkunden</);
    assert.match(shows, /data-key="shows" aria-pressed="true"/);
    assert.match(card({}, { startTab: "demos" })._renderLibraryHome(), /data-act="open-demos" aria-pressed="true"/);
  });

  test("a poster row's heading counts its own titles", () => {
    const c = card();
    c._resume = [{ id: "a", title: "Heat" }, { id: "b", title: "Dune" }];
    const html = c._renderLibraryHome();
    assert.match(html, /class="st-h">Weitersehen<\/div>[\s\S]*?class="st-meta">2 Titel</);
    // Favoriten keeps its way into the full list instead of a count.
    c._favorites = [{ id: "f", title: "Alien" }];
    assert.match(c._renderLibraryHome(), /data-act="open-favorites"/);
  });

  test("all three rows survive the redesign (FR-70, FR-70a)", () => {
    const c = card();
    c._resume = [{ id: "a", title: "Heat" }];
    c._favorites = [{ id: "f", title: "Alien" }];
    c._recent = [{ id: "r", title: "Neu" }];
    const html = c._renderLibraryHome();
    for (const row of ["Weitersehen", "Favoriten", "Zuletzt hinzugefügt"]) {
      assert.match(html, new RegExp(`class="st-h">${row}<`));
    }
    assert.equal((html.match(/class="posterrow hscroll"/g) || []).length, 3);
  });

  /**
   * The two minutes the beamer warms up are exactly when somebody is looking
   * for what to watch, and the library never needed the theater (FR-41).
   */
  test("a transition no longer blanks the library", () => {
    const c = card({
      activity: "aus",
      targetActivity: "film",
      progress: { percent: 40, bottleneck: "Beamer wärmt auf…" },
    });
    c._recent = [{ id: "n1", title: "The Order", year: 2024 }];
    const html = c._renderBody();
    assert.match(html, /Zuletzt hinzugefügt/);
    assert.match(html, /class="st-seg"/);
  });

  /** The target's own body still waits: it would be describing a lie. */
  test("a handoff card waits until the handoff is real", () => {
    const c = card({
      activity: "aus",
      targetActivity: "netflix",
      progress: { percent: 40, bottleneck: null },
    });
    assert.doesNotMatch(c._renderBody(), /Fernbedienung der Shield/);
  });

  /**
   * The Start screen is the card's face now, and searching from it used to
   * mean opening the library first and finding the box there.
   */
  test("the Start screen has a search box", () => {
    const html = card()._renderLibraryHome();
    assert.match(html, /class="st-search"/);
    assert.match(html, /data-field="query"/);
    assert.match(html, /placeholder="Titel suchen…"/);
  });

  /**
   * One field name across both screens: `_render` restores the caret by
   * `data-field`, so the word and the caret follow the user into the
   * library instead of being retyped there.
   */
  test("the third letter opens the library, the first two do not", async () => {
    const c = card();
    c._container = { querySelector: () => null };
    c._appliedQuery = "";
    const opened = [];
    c._openLibrary = async (cat) => opened.push(cat);
    c._loadLibrary = async () => opened.push("load");
    const type = (value) =>
      c._onInput({ target: { dataset: { field: "query" }, value } });

    type("Du");
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(opened, [], "two letters is not a search");

    type("Dun");
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(opened, ["movies"]);
    assert.equal(c._view.query, "Dun");
  });

  /**
   * A back step out of the library restores the word that opened it, so the
   * Start box comes back filled. Clearing it must not count as a search and
   * open the library again on nothing.
   */
  test("emptying the box on Start opens nothing", async () => {
    const c = card();
    c._container = { querySelector: () => null };
    c._appliedQuery = "Dun";
    c._view.query = "Dun";
    const opened = [];
    c._openLibrary = async (cat) => opened.push(cat);
    c._onInput({ target: { dataset: { field: "query" }, value: "" } });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(opened, []);
    assert.equal(c._view.query, "");
  });

  test("the search follows the lit segment into Serien", async () => {
    const c = card({}, { startTab: "shows" });
    c._container = { querySelector: () => null };
    c._appliedQuery = "";
    const opened = [];
    c._openLibrary = async (cat) => opened.push(cat);
    c._onInput({ target: { dataset: { field: "query" }, value: "Dun" } });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(opened, ["shows"]);
  });

  /** Inside the library the same field searches in place, as it always did. */
  test("in the library the field does not navigate", async () => {
    const c = card({}, { main: "library" });
    c._container = { querySelector: () => null };
    c._appliedQuery = "";
    const opened = [];
    c._openLibrary = async (cat) => opened.push(cat);
    c._loadLibrary = async () => opened.push("load");
    c._onInput({ target: { dataset: { field: "query" }, value: "Dun" } });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(opened, ["load"]);
  });

  test("a grid where no tile has an icon grows no icon gutter", () => {
    const bare = ACTIVITIES.map(({ icon, ...rest }) => rest);
    assert.doesNotMatch(card({ activities: bare })._renderActivitySelector(), /class="ic"/);
    assert.equal(
      (card()._renderActivitySelector().match(/class="ic"/g) || []).length,
      4
    );
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

  test("a banner without banner art falls back and gets title and meta", () => {
    const c = card();
    c._view.viewMode = "banner";
    const html = c._renderItems([item]);
    assert.match(html, /\/api\/kino\/artwork\/abc\/Backdrop/);
    assert.match(html, /class="captiontitle">Film</);
    assert.match(html, /class="meta">2020</);
  });

  test("real banner art keeps its own lettering but still gets the meta", () => {
    const c = card();
    c._view.viewMode = "banner";
    const html = c._renderItems([{ ...item, bannerTag: "t" }]);
    assert.match(html, /\/api\/kino\/artwork\/abc\/Banner/);
    assert.doesNotMatch(html, /captiontitle/);
    assert.match(html, /class="meta">2020</);
  });

  test("the banner frame does not borrow the alert strip's class", () => {
    // .banner is the red alert strip; its padding and border framed every
    // banner tile in grey until the view mode got a name of its own.
    const c = card();
    c._view.viewMode = "banner";
    const html = c._renderItems([item]);
    assert.match(html, /class="art wide bannerart"/);
    assert.doesNotMatch(html, /class="art wide banner"/);
  });

  test("every layout carries the chosen tile size", () => {
    const c = card();
    c._view.gridSize = "xs";
    for (const [mode, cls] of [
      ["poster", "postergrid"],
      ["thumb", "thumbgrid"],
      ["banner", "bannerlist"],
      ["list", "listrows"],
    ]) {
      c._view.viewMode = mode;
      assert.match(c._renderItems([item]), new RegExp(`class="${cls} size-xs"`), mode);
    }
  });

  test("the list row shows the watched and favorite flags", () => {
    const c = card();
    c._view.viewMode = "list";
    const html = c._renderItems([item]);
    assert.match(html, /class="seen"/);
    assert.match(html, /class="fav"/);
  });
});

/**
 * The three places the Start screen's segmented control leads to. They kept
 * 0.8's capsules and a 19px title while the screen above them was redrawn,
 * which read as two different apps one tap apart (FR-78).
 */
describe("the screens under the segmented control speak one language", () => {
  const library = () => {
    const c = Object.create(KinoCard.prototype);
    c._view = {
      main: "library",
      category: "movies",
      query: "",
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      gridSize: "m",
      refreshing: false,
      filters: helpers.emptyFilters(),
    };
    c._facets = { genres: [], countries: [], ratings: [], yearMin: 1957, yearMax: 2026 };
    c._library = { items: [], total: 0, hasMore: false, loading: false, error: null };
    c._kino = { artworkSignature: "sig" };
    return c;
  };

  test("the library's category control is the same segmented control", () => {
    const html = library()._renderLibrary();
    assert.match(html, /class="st-seg"/);
    assert.equal((html.match(/class="st-segbtn"/g) || []).length, 2);
    assert.match(html, /data-act="category" data-key="movies"\n?\s*aria-pressed="true"/);
    // Gold means "this is running" everywhere else on the card; a selected
    // tab borrowing it was the loudest of the mismatches.
    assert.doesNotMatch(html, /class="pill"[^>]*data-act="category"/);
  });

  test("the library carries the same search box as the Start screen", () => {
    const html = library()._renderLibrary();
    assert.match(html, /class="st-search"/);
    assert.match(html, /data-field="query"/);
  });

  test("both screens use the same header", () => {
    const c = library();
    assert.match(c._renderLibrary(), /class="st-screenhead"/);
    assert.match(c._renderLibrary(), /class="st-back" data-act="back-home"/);
    const demos = Object.create(KinoCard.prototype);
    demos._view = { demoTab: "clips", demoTagFilter: [] };
    demos._demo = { clips: [], showcases: [], vocabulary: [] };
    const html = demos._renderDemos();
    assert.match(html, /class="st-screenhead"/);
    assert.match(html, /class="st-seg"/);
    assert.doesNotMatch(html, /class="pill" data-act="demo-tab"/);
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
    card._view = { main: "home" };
    const html = card._renderDeviceChips();
    assert.match(html, /Beamer/);
    assert.match(html, /Zidoo/);
  });

  test("once off, there are no chips", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { ...kino, activity: "aus", targetActivity: null, progress: null };
    card._view = { main: "home" };
    assert.equal(card._renderDeviceChips(), "");
  });

  /**
   * Four green dots between two sections of the Start screen say only
   * "nothing to see" — and cost a band of the phone to say it (FR-78).
   */
  test("a healthy idle room shows no chips on the Start screen", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      ...kino,
      activity: "film",
      targetActivity: null,
      progress: null,
      devices: [
        { key: "beamer", name: "Beamer", health: "ready" },
        { key: "zidoo", name: "Zidoo", health: "ready" },
      ],
    };
    card._view = { main: "home" };
    assert.equal(card._renderDeviceChips(), "");
    // One device off its perch, and the row is back.
    card._kino = {
      ...card._kino,
      devices: [
        { key: "beamer", name: "Beamer", health: "degraded" },
        { key: "zidoo", name: "Zidoo", health: "ready" },
      ],
    };
    assert.match(card._renderDeviceChips(), /Beamer/);
    // And on every other screen they are the only device status there is.
    card._kino = { ...card._kino, devices: kino.devices };
    card._view = { main: "library" };
    assert.match(card._renderDeviceChips(), /Beamer/);
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
    card._view = { main: "home" };
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
    assert.equal(empty.runtimeFrom, null);
    assert.equal(empty.runtimeTo, null);
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
    assert.equal(msg.runtime_from, null);
    assert.equal(msg.runtime_to, null);
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

describe("typing in the search field", () => {
  const searchCard = (view = {}) => {
    const c = Object.create(KinoCard.prototype);
    c._kino = { artworkSignature: "sig" };
    c._library = { items: [], total: 120, hasMore: false, loading: false, error: null };
    c._appliedQuery = "";
    c._searchTimer = null;
    c._lastTypedAt = 0;
    c._renderPending = false;
    c._renders = 0;
    c._render = () => {
      c._renders += 1;
    };
    c._view = {
      main: "library",
      category: "movies",
      query: "",
      sort: "added",
      sortDir: null,
      viewMode: "poster",
      gridSize: "m",
      filters: helpers.emptyFilters(),
      trim: null,
      scEdit: null,
      abSetup: null,
      ...view,
    };
    c._nodes = { count: { innerHTML: "" }, grid: { innerHTML: "" } };
    c._container = {
      querySelector: (sel) => {
        if (sel.includes("library-count")) return c._nodes.count;
        if (sel.includes("library-grid")) return c._nodes.grid;
        return null;
      },
    };
    return c;
  };
  const typed = (value) => ({ target: { value, dataset: { field: "query" } } });

  test("one or two letters are not a search yet", () => {
    assert.equal(searchCard({ query: "a" })._searchQuery(), "");
    assert.equal(searchCard({ query: "no" })._searchQuery(), "");
    assert.equal(searchCard({ query: "  n " })._searchQuery(), "");
  });

  test("the third letter makes it one", () => {
    assert.equal(searchCard({ query: "nor" })._searchQuery(), "nor");
    assert.equal(searchCard({ query: " nord " })._searchQuery(), "nord");
  });

  test("a short query goes out as no search at all", async () => {
    const c = searchCard({ query: "no" });
    const sent = [];
    c._ws = async (msg) => {
      sent.push(msg);
      return { items: [], total: 120, hasMore: false };
    };
    await c._loadLibrary();
    assert.equal(sent[0].search, null);
    assert.equal(c._appliedQuery, "");
  });

  test("a real query goes out as itself", async () => {
    const c = searchCard({ query: "nord" });
    const sent = [];
    c._ws = async (msg) => {
      sent.push(msg);
      return { items: [], total: 1, hasMore: false };
    };
    await c._loadLibrary();
    assert.equal(sent[0].search, "nord");
    assert.equal(c._appliedQuery, "nord");
  });

  test("an overtaken answer never lands on top of a newer one", async () => {
    const c = searchCard({ query: "nord" });
    let release;
    const slow = new Promise((r) => {
      release = r;
    });
    c._ws = async (msg) => {
      if (msg.search === "nord") {
        await slow;
        return { items: [{ id: "slow" }], total: 1, hasMore: false };
      }
      return { items: [{ id: "fast" }], total: 2, hasMore: false };
    };
    const first = c._loadLibrary();
    c._view.query = "nordwand";
    await c._loadLibrary();
    release();
    await first;
    assert.deepEqual(
      c._library.items.map((i) => i.id),
      ["fast"]
    );
    assert.equal(c._library.total, 2);
  });

  test("typing never re-renders the card around the caret", () => {
    const c = searchCard();
    c._onInput(typed("n"));
    c._onInput(typed("no"));
    c._onInput(typed("nor"));
    assert.equal(c._renders, 0);
    assert.equal(c._view.query, "nor");
    clearTimeout(c._searchTimer);
  });

  test("the first two letters send nothing", () => {
    const c = searchCard();
    c._onInput(typed("n"));
    assert.equal(c._searchTimer, null);
    c._onInput(typed("no"));
    assert.equal(c._searchTimer, null);
  });

  test("the third letter schedules the search", () => {
    const c = searchCard();
    c._onInput(typed("nor"));
    assert.notEqual(c._searchTimer, null);
    clearTimeout(c._searchTimer);
  });

  test("deleting back below three letters brings the full list back", () => {
    const c = searchCard({ query: "nord" });
    c._appliedQuery = "nord";
    c._onInput(typed("no"));
    assert.notEqual(c._searchTimer, null);
    clearTimeout(c._searchTimer);
  });

  test("a letter typed and taken back costs no request", () => {
    const c = searchCard({ query: "nord" });
    c._appliedQuery = "nord";
    c._onInput(typed("nordi"));
    assert.notEqual(c._searchTimer, null);
    c._onInput(typed("nord"));
    assert.equal(c._searchTimer, null);
  });

  test("the count line says why two letters changed nothing", () => {
    const c = searchCard({ query: "no" });
    assert.match(c._renderLibraryCount(), /ab 3 Zeichen/);
    assert.match(c._renderLibraryCount(), /120 Titel/);
  });

  test("a search long enough to run gets the plain count", () => {
    const c = searchCard({ query: "nord" });
    assert.doesNotMatch(c._renderLibraryCount(), /Zeichen/);
  });

  test("results are painted into the grid, not rendered over the field", () => {
    const c = searchCard({ query: "nord" });
    c._library = {
      items: [{ id: "m1", title: "Nordwand", year: 2008 }],
      total: 1,
      hasMore: false,
      loading: false,
      error: null,
    };
    c._paintLibrary();
    assert.equal(c._renders, 0);
    assert.match(c._nodes.grid.innerHTML, /data-key="m1"/);
    assert.match(c._nodes.count.innerHTML, /1 Titel/);
  });

  test("with no grid on screen there is nothing to paint into", () => {
    const c = searchCard();
    c._container = { querySelector: () => null };
    c._paintLibrary();
    assert.equal(c._renders, 1);
  });

  test("a poll waits for the word to be finished", () => {
    const c = searchCard();
    c.shadowRoot = { activeElement: { tagName: "INPUT" } };
    c._lastTypedAt = Date.now();
    c._renderPassive();
    assert.equal(c._renders, 0);
    assert.equal(c._renderPending, true);
    // Still mid-word: the flush from the poll leaves it alone.
    c._flushPendingRender();
    assert.equal(c._renders, 0);
    // The caret left the field.
    c.shadowRoot = { activeElement: null };
    c._flushPendingRender();
    assert.equal(c._renders, 1);
  });

  test("a field left focused does not freeze the card for ever", () => {
    const c = searchCard();
    c.shadowRoot = { activeElement: { tagName: "INPUT" } };
    c._lastTypedAt = Date.now() - 60000;
    c._renderPassive();
    assert.equal(c._renders, 1);
  });

  test("with the caret elsewhere a poll draws straight away", () => {
    const c = searchCard();
    c.shadowRoot = { activeElement: { tagName: "BUTTON" } };
    c._lastTypedAt = Date.now();
    c._renderPassive();
    assert.equal(c._renders, 1);
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

describe("the light card", () => {
  const SCENES = [
    { entity: "scene.dark", name: "Dunkel", icon: "mdi:weather-night", momentary: true },
    { entity: "scene.low_ambience", name: "Gedimmt", icon: null, momentary: true },
  ];
  const LAMPS = [
    { entity: "light.kino_deckenspots", name: "Spots", icon: null, momentary: false },
    { entity: "light.kino_vorhang", name: null, icon: null, momentary: false },
  ];
  const LIGHTS = { title: "Licht", position: "below", controls: [...SCENES, ...LAMPS] };

  // A dimmable, colour-capable strip and a dimmable-only downlight — which is
  // exactly what the room has.
  const STATES = {
    "scene.dark": { state: "2026-09-06T20:00:00+00:00", attributes: {} },
    "scene.low_ambience": { state: "2026-09-06T19:00:00+00:00", attributes: {} },
    "light.kino_deckenspots": {
      state: "off",
      last_changed: "2026-09-06T19:59:00+00:00",
      attributes: { supported_color_modes: ["brightness"] },
    },
    "light.kino_vorhang": {
      state: "on",
      last_changed: "2026-09-06T20:00:03+00:00",
      attributes: {
        friendly_name: "Kino Vorhang LED",
        supported_color_modes: ["rgbw"],
        brightness: 128,
        rgb_color: [255, 217, 160],
      },
    },
  };

  const makeCard = (lights = LIGHTS, states = STATES, view = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { lights };
    card._view = view;
    card._hass = { states };
    return card;
  };

  test("nothing configured is no card at all", () => {
    assert.equal(makeCard(null)._renderLights(), "");
    assert.equal(makeCard({ controls: [] })._renderLights(), "");
  });

  test("scenes are tiles, lamps are not", () => {
    const html = makeCard()._renderLights();
    assert.equal((html.match(/class="st-tile"/g) || []).length, 2);
    assert.match(html, /data-key="scene\.dark"/);
    assert.doesNotMatch(html, /class="st-tile"[^>]*data-key="light\./);
    assert.match(html, /icon="mdi:weather-night"/);
  });

  /**
   * A scene has no "on" state in Home Assistant — only the moment it was last
   * applied. The newest one is the room's, until a lamp is moved by hand.
   */
  test("the most recently applied scene is the active one", () => {
    const html = makeCard()._renderLights();
    assert.match(html, /data-key="scene\.dark" aria-pressed="true"/);
    assert.match(html, /data-key="scene\.low_ambience" aria-pressed="false"/);
    assert.match(html, /class="st-meta"[^>]*>Dunkel</);
  });

  test("a lamp settling right after the scene does not un-mark it", () => {
    // The strip changed 3 s after the scene landed — that was the scene.
    assert.equal(makeCard()._activeScene().entity, "scene.dark");
  });

  test("a lamp moved by hand afterwards does un-mark it", () => {
    const states = {
      ...STATES,
      "light.kino_vorhang": {
        ...STATES["light.kino_vorhang"],
        last_changed: "2026-09-06T20:05:00+00:00",
      },
    };
    const card = makeCard(LIGHTS, states);
    assert.equal(card._activeScene(), null);
    assert.match(card._renderLights(), /class="st-meta"[^>]*>Manuell</);
    assert.doesNotMatch(card._renderLights(), /aria-pressed="true"/);
  });

  test("a scene never applied is never the active one", () => {
    // After a restart a scene reads "unknown" until something applies it, so
    // the one that *has* landed is the room's — here with the lamps quiet
    // since before it, so nothing has overtaken it.
    const states = {
      ...STATES,
      "scene.dark": { state: "unknown", attributes: {} },
      "light.kino_deckenspots": {
        ...STATES["light.kino_deckenspots"],
        last_changed: "2026-09-06T18:30:00+00:00",
      },
      "light.kino_vorhang": {
        ...STATES["light.kino_vorhang"],
        last_changed: "2026-09-06T18:30:00+00:00",
      },
    };
    assert.equal(makeCard(LIGHTS, states)._activeScene().entity, "scene.low_ambience");
  });

  test("the lamp list folds away, and says how many are on", () => {
    const folded = makeCard()._renderLights();
    assert.match(folded, /aria-expanded="false"/);
    assert.match(folded, /<span class="ct">1 an<\/span>/);
    assert.doesNotMatch(folded, /class="lightrow"/);

    const open = makeCard(LIGHTS, STATES, { lightsOpen: true })._renderLights();
    assert.match(open, /aria-expanded="true"/);
    assert.equal((open.match(/class="lightrow"/g) || []).length, 2);
  });

  test("with every lamp off the count says so rather than '0 an'", () => {
    const states = {
      ...STATES,
      "light.kino_vorhang": { ...STATES["light.kino_vorhang"], state: "off" },
    };
    assert.match(makeCard(LIGHTS, states)._renderLights(), /<span class="ct">alle aus<\/span>/);
  });

  test("a lamp shows its switch, its level and Home Assistant's name", () => {
    const row = makeCard()._renderLightRow(LAMPS[1]);
    assert.match(row, /role="switch" aria-checked="true"/);
    assert.match(row, /<span class="nm">Kino Vorhang LED<\/span>/);
    assert.match(row, /<span class="st">50%<\/span>/);
    assert.match(row, /value="50"/);
  });

  test("controls appear only for what the lamp can actually do", () => {
    // On, dimmable and colour-capable: slider and swatches.
    const strip = makeCard()._renderLightRow(LAMPS[1]);
    assert.match(strip, /class="dim"/);
    assert.equal((strip.match(/class="swatch"/g) || []).length, 6);
    // The colour it is already showing is the marked one.
    assert.match(strip, /data-value="#ffd9a0" aria-pressed="true"/);

    // Off: nothing to adjust until it is on.
    const spots = makeCard()._renderLightRow(LAMPS[0]);
    assert.match(spots, /aria-checked="false"/);
    assert.match(spots, /<span class="st">Aus<\/span>/);
    assert.doesNotMatch(spots, /class="dim"/);

    // On but brightness-only: a slider, never swatches.
    const on = makeCard(LIGHTS, {
      ...STATES,
      "light.kino_deckenspots": {
        state: "on",
        last_changed: "2026-09-06T20:00:01+00:00",
        attributes: { supported_color_modes: ["brightness"], brightness: 255 },
      },
    })._renderLightRow(LAMPS[0]);
    assert.match(on, /class="dim"/);
    assert.doesNotMatch(on, /class="swatch"/);
  });

  test("a switch is not a dimmer", () => {
    const card = makeCard(
      { controls: [{ entity: "switch.kino_led", name: "LED", momentary: false }] },
      { "switch.kino_led": { state: "on", last_changed: "x", attributes: {} } }
    );
    const row = card._renderLightRow({ entity: "switch.kino_led", name: "LED" });
    assert.match(row, /<span class="st">An<\/span>/);
    assert.doesNotMatch(row, /class="dim"/);
    assert.doesNotMatch(row, /class="swatch"/);
  });

  test("an entity that is gone stays visible, greyed out", () => {
    const html = makeCard(LIGHTS, {})._renderLights();
    assert.equal((html.match(/aria-disabled="true"/g) || []).length, 2);
    const row = makeCard(LIGHTS, {})._renderLightRow(LAMPS[1]);
    assert.match(row, /aria-disabled="true"/);
    assert.match(row, /<span class="st">Nicht verfügbar<\/span>/);
    // Nothing else to call it by.
    assert.match(row, /<span class="nm">light\.kino_vorhang<\/span>/);
  });

  /**
   * The bug this suite was written blind to: Home Assistant only moves
   * `last_changed` when the state *string* changes. A dim or a recolour is an
   * attribute-only change, so the lamp stays "on" and `last_changed` stands
   * still — and those are exactly the two controls this card added.
   */
  test("dimming a lamp withdraws the scene mark, though its state string never moved", () => {
    const states = {
      ...STATES,
      "light.kino_vorhang": {
        ...STATES["light.kino_vorhang"],
        state: "on",
        last_changed: "2026-09-06T20:00:03+00:00", // the scene's own settle
        last_updated: "2026-09-06T20:04:00+00:00", // the user dragged the slider
        attributes: { ...STATES["light.kino_vorhang"].attributes, brightness: 255 },
      },
    };
    const card = makeCard(LIGHTS, states);
    assert.equal(card._activeScene(), null);
    assert.match(card._renderLights(), /class="st-meta"[^>]*>Manuell</);
  });

  test("a lamp that has not moved keeps the mark, on either timestamp", () => {
    const states = {
      ...STATES,
      "light.kino_vorhang": {
        ...STATES["light.kino_vorhang"],
        last_changed: "2026-09-06T20:00:02+00:00",
        last_updated: "2026-09-06T20:00:02+00:00",
      },
      "light.kino_deckenspots": {
        ...STATES["light.kino_deckenspots"],
        last_updated: "2026-09-06T19:59:00+00:00",
      },
    };
    assert.equal(makeCard(LIGHTS, states)._activeScene().entity, "scene.dark");
  });

  /**
   * Tapping a scene and then changing your mind a second later is the normal
   * flow, not a race — and a clock-based grace window would have credited
   * that change to the scene for the rest of the evening.
   */
  test("a lamp driven from the card un-marks the scene immediately, inside the grace window", () => {
    const card = makeCard();
    assert.equal(card._activeScene().entity, "scene.dark");
    card._noteManualLight();
    assert.equal(card._activeScene(), null);
    assert.match(card._renderLights(), /class="st-meta"[^>]*>Manuell</);
  });

  test("...and applying a scene again takes the mark back", () => {
    const card = makeCard();
    card._noteManualLight();
    assert.equal(card._activeScene(), null);
    card._hass.states = {
      ...card._hass.states,
      "scene.low_ambience": { state: "2026-09-06T20:30:00+00:00", attributes: {} },
    };
    assert.equal(card._activeScene().entity, "scene.low_ambience");
  });

  /** A bulb blinking out and back is not somebody reaching for a switch. */
  test("an unreachable lamp does not withdraw the mark", () => {
    const states = {
      ...STATES,
      "light.kino_vorhang": {
        state: "unavailable",
        last_changed: "2026-09-06T21:30:00+00:00",
        last_updated: "2026-09-06T21:30:00+00:00",
        attributes: {},
      },
    };
    assert.equal(makeCard(LIGHTS, states)._activeScene().entity, "scene.dark");
  });

  test("an empty title means no label, as the config documents", () => {
    const html = makeCard({ ...LIGHTS, title: "" })._renderLights();
    assert.match(html, /<div class="st-h"><\/div>/);
    assert.doesNotMatch(html, /<div class="st-h">Licht<\/div>/);
    // Absent still falls back, so an untouched config is unchanged.
    const fallback = makeCard({ controls: LIGHTS.controls })._renderLights();
    assert.match(fallback, /<div class="st-h">Licht<\/div>/);
  });

  /**
   * The card restores focus after a re-render by looking a field up by name.
   * One name shared by every slider put the caret on the wrong lamp — and the
   * next arrow key on the wrong lamp's brightness.
   */
  test("each lamp's slider carries its own field name", () => {
    const open = makeCard(LIGHTS, {
      ...STATES,
      "light.kino_deckenspots": {
        state: "on",
        last_changed: "2026-09-06T20:00:01+00:00",
        attributes: { supported_color_modes: ["brightness"], brightness: 200 },
      },
    }, { lightsOpen: true })._renderLights();
    const fields = [...open.matchAll(/data-field="(light-brightness[^"]*)"/g)].map((m) => m[1]);
    assert.equal(fields.length, 2);
    assert.equal(new Set(fields).size, 2, "two sliders must not share one name");
    assert.ok(fields.every((f) => f.includes(".")), "the name carries the entity");
  });

  /**
   * A card filled from an area has no configured icons at all, so the one
   * Home Assistant already gives the entity is what has to show.
   */
  test("an entity's own icon stands in when none is configured", () => {
    const html = makeCard(
      { controls: [{ entity: "scene.kino_gaming", momentary: true }] },
      {
        "scene.kino_gaming": {
          state: "2026-09-06T20:00:00+00:00",
          attributes: { friendly_name: "Kino Gaming", icon: "mdi:controller" },
        },
      }
    )._renderLights();
    assert.match(html, /icon="mdi:controller"/);
    assert.match(html, /<span class="nm">Kino Gaming<\/span>/);
  });

  test("a configured icon still wins over the entity's own", () => {
    const html = makeCard(
      { controls: [{ entity: "scene.dark", icon: "mdi:weather-night", momentary: true }] },
      { "scene.dark": { state: "x", attributes: { icon: "mdi:palette" } } }
    )._renderLights();
    assert.match(html, /icon="mdi:weather-night"/);
    assert.doesNotMatch(html, /mdi:palette/);
  });

  test("a tile without an icon still lines its label up with the others", () => {
    const html = makeCard({
      controls: [
        { entity: "scene.dark", name: "Dunkel", momentary: true },
        { entity: "scene.low_ambience", name: "Gedimmt", icon: "mdi:lamp", momentary: true },
      ],
    })._renderLights();
    // The slot is what keeps the baselines together, so both tiles have one.
    assert.equal((html.match(/class="ic"/g) || []).length, 2);
  });

  test("a scene is applied, a lamp is toggled", async () => {
    const card = makeCard();
    const calls = [];
    card._callService = async (...args) => calls.push(args);
    await card._light("scene.dark");
    await card._light("light.kino_vorhang");
    assert.deepEqual(calls, [
      ["scene", "turn_on", { entity_id: "scene.dark" }],
      ["light", "toggle", { entity_id: "light.kino_vorhang" }],
    ]);
  });

  test("brightness goes as a percentage, colour as rgb", async () => {
    const card = makeCard();
    const calls = [];
    card._callService = async (...args) => calls.push(args);
    await card._lightBrightness("light.kino_vorhang", "42");
    await card._lightColor("light.kino_vorhang", "#4b8bff");
    assert.deepEqual(calls, [
      ["light", "turn_on", { entity_id: "light.kino_vorhang", brightness_pct: 42 }],
      ["light", "turn_on", { entity_id: "light.kino_vorhang", rgb_color: [75, 139, 255] }],
    ]);
  });

  test("the slider never asks for a level that would switch the lamp off", async () => {
    const card = makeCard();
    const calls = [];
    card._callService = async (...args) => calls.push(args);
    await card._lightBrightness("light.kino_vorhang", "0");
    await card._lightBrightness("light.kino_vorhang", "500");
    assert.deepEqual(
      calls.map((c) => c[2].brightness_pct),
      [1, 100]
    );
  });

  /** "Alles aus" is about the lamps — it must never touch the activity. */
  test("all-off switches off every lamp, grouped by domain, and no scene", async () => {
    const card = makeCard({
      controls: [
        ...SCENES,
        { entity: "light.a", momentary: false },
        { entity: "light.b", momentary: false },
        { entity: "switch.c", momentary: false },
      ],
    });
    const calls = [];
    card._callService = async (...args) => calls.push(args);
    await card._lightsAllOff();
    assert.deepEqual(calls, [
      ["light", "turn_off", { entity_id: ["light.a", "light.b"] }],
      ["switch", "turn_off", { entity_id: ["switch.c"] }],
    ]);
  });

  test("a refused call is reported, not swallowed", async () => {
    const card = makeCard();
    card._callService = async () => {
      throw new Error("Szene nicht gefunden");
    };
    card._render = () => {};
    await card._light("scene.dark");
    assert.equal(card._actionError, "Szene nicht gefunden");
  });

  /**
   * The active tile is derived from a scene's timestamp, so unlike the old
   * chip row that timestamp now has to force a redraw.
   */
  test("a scene landing redraws the card", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { entities: {}, controls: {}, lights: LIGHTS };
    card._hass = { states: JSON.parse(JSON.stringify(STATES)) };
    const before = card._renderSignature();
    card._hass.states["scene.dark"].state = "2026-09-06T20:10:00+00:00";
    assert.notEqual(card._renderSignature(), before);
  });

  test("a dimmed lamp redraws the card", () => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { entities: {}, controls: {}, lights: LIGHTS };
    card._hass = { states: JSON.parse(JSON.stringify(STATES)) };
    const before = card._renderSignature();
    card._hass.states["light.kino_vorhang"].attributes.brightness = 200;
    assert.notEqual(card._renderSignature(), before);
    const dimmed = card._renderSignature();
    card._hass.states["light.kino_vorhang"].attributes.rgb_color = [0, 0, 255];
    assert.notEqual(card._renderSignature(), dimmed);
  });
});

describe("light capabilities", () => {
  const light = (modes, extra = {}) => ({
    state: "on",
    attributes: { supported_color_modes: modes, ...extra },
  });

  test("what can be dimmed", () => {
    assert.equal(helpers.isDimmable(light(["brightness"])), true);
    assert.equal(helpers.isDimmable(light(["rgbw"])), true);
    assert.equal(helpers.isDimmable(light(["onoff"])), false);
    // A switch reports no colour modes at all.
    assert.equal(helpers.isDimmable({ state: "on", attributes: {} }), false);
    assert.equal(helpers.isDimmable(null), false);
  });

  test("what can be coloured", () => {
    assert.equal(helpers.isColorCapable(light(["rgbw"])), true);
    assert.equal(helpers.isColorCapable(light(["hs"])), true);
    assert.equal(helpers.isColorCapable(light(["brightness"])), false);
    assert.equal(helpers.isColorCapable(light(["color_temp"])), false);
    assert.equal(helpers.isColorCapable(null), false);
  });

  test("colours round-trip between the swatch and the service call", () => {
    assert.equal(helpers.rgbHex([255, 217, 160]), "#ffd9a0");
    assert.equal(helpers.rgbHex([0, 0, 0]), "#000000");
    assert.equal(helpers.rgbHex(null), null);
    assert.equal(helpers.rgbHex([1, 2]), null);
    assert.deepEqual(helpers.hexToRgb("#ffd9a0"), [255, 217, 160]);
    assert.deepEqual(helpers.hexToRgb("4b8bff"), [75, 139, 255]);
    assert.equal(helpers.hexToRgb("nonsense"), null);
  });

  test("the status line says what the lamp is doing", () => {
    assert.equal(helpers.lightStatus(light(["brightness"], { brightness: 128 })), "50%");
    assert.equal(helpers.lightStatus({ state: "on", attributes: {} }), "An");
    assert.equal(helpers.lightStatus({ state: "off", attributes: {} }), "Aus");
    assert.equal(helpers.lightStatus({ state: "unavailable", attributes: {} }), "Nicht verfügbar");
    assert.equal(helpers.lightStatus(null), "Nicht verfügbar");
  });
});

describe("brightnessPercent", () => {
  test("a light that is on never reads as switched off", () => {
    assert.equal(helpers.brightnessPercent({ attributes: { brightness: 1 } }), 1);
    assert.equal(helpers.brightnessPercent({ attributes: { brightness: 255 } }), 100);
    assert.equal(helpers.brightnessPercent({ attributes: { brightness: 128 } }), 50);
  });

  test("a light without a dimmer says nothing at all", () => {
    assert.equal(helpers.brightnessPercent({ attributes: {} }), null);
    assert.equal(helpers.brightnessPercent(null), null);
    assert.equal(helpers.brightnessPercent({ attributes: { brightness: "x" } }), null);
  });
});
