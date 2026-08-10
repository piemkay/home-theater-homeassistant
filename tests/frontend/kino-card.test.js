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
});

describe("activeFilterCount", () => {
  const empty = { tags: [], genres: [], countries: [], yearFrom: null, yearTo: null };

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
      }),
      4
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
  const filters = {
    tags: ["4K", "Nicht gesehen"],
    genres: ["Drama"],
    countries: ["Deutschland"],
    yearFrom: 2020,
    yearTo: 2024,
  };

  test("translates chips into the WebSocket command", () => {
    const msg = helpers.queryFromFilters(filters, "movies", "nord", "year");

    assert.equal(msg.type, "kino/library/search");
    assert.equal(msg.category, "movies");
    assert.equal(msg.search, "nord");
    assert.equal(msg.sort, "year");
    assert.equal(msg.only_4k, true);
    assert.equal(msg.only_hd, false);
    assert.equal(msg.only_unwatched, true);
    assert.equal(msg.only_resumable, false);
    assert.deepEqual(msg.genres, ["Drama"]);
    assert.deepEqual(msg.countries, ["Deutschland"]);
    assert.equal(msg.year_from, 2020);
    assert.equal(msg.year_to, 2024);
  });

  test("sends null rather than an empty search string", () => {
    const msg = helpers.queryFromFilters(
      { tags: [], genres: [], countries: [], yearFrom: null, yearTo: null },
      "shows",
      "",
      "added"
    );
    assert.equal(msg.search, null);
    assert.equal(msg.category, "shows");
  });

  test("paginates", () => {
    const msg = helpers.queryFromFilters(
      { tags: [], genres: [], countries: [], yearFrom: null, yearTo: null },
      "movies",
      "",
      "added",
      60,
      30
    );
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
