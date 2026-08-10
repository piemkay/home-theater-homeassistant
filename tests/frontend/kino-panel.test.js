/**
 * Panel logic tests.
 *
 * The matrix editor reads and writes the config *document*, so these cover
 * the round-trip: a cell edited in the UI must produce a document the schema
 * still accepts, in the same inline shape a hand-written file uses.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  panelHelpers,
  KinoPanel,
} from "../../custom_components/kino/www/kino-panel.js";

const DOC = () => ({
  version: 1,
  settings: { off_activity: "aus" },
  devices: {
    barco: { driver: "barco", name: "Beamer", entities: {} },
    trinnov: { driver: "trinnov", name: "Trinnov", entities: {} },
    madvr: { driver: "madvr", name: "madVR", entities: {} },
  },
  activities: {
    aus: { name: "Aus", control_class: "off", devices: {} },
    film: {
      name: "Bibliothek",
      control_class: "full",
      devices: {
        barco: { power: true, profile: "HDR 260 HDMI" },
        trinnov: { power: true, source: "zidoo", volume: -30.0 },
      },
    },
    netflix: {
      name: "Streaming",
      control_class: "handoff",
      devices: { trinnov: { power: true, settings: { source: "shield" } } },
    },
  },
});

describe("requirement", () => {
  test("reads inline settings", () => {
    const req = panelHelpers.requirement(DOC(), "film", "barco");
    assert.equal(req.present, true);
    assert.equal(req.power, true);
    assert.deepEqual(req.settings, { profile: "HDR 260 HDMI" });
  });

  test("reads nested settings identically", () => {
    const req = panelHelpers.requirement(DOC(), "netflix", "trinnov");
    assert.deepEqual(req.settings, { source: "shield" });
  });

  test("an absent device is absent, not off-with-settings", () => {
    const req = panelHelpers.requirement(DOC(), "film", "madvr");
    assert.equal(req.present, false);
    assert.deepEqual(req.settings, {});
  });

  test("power: false is respected", () => {
    const doc = DOC();
    doc.activities.film.devices.madvr = { power: false };
    assert.equal(panelHelpers.requirement(doc, "film", "madvr").power, false);
  });
});

describe("setRequirement", () => {
  test("writes the inline shape a hand-written file uses", () => {
    const doc = DOC();
    panelHelpers.setRequirement(doc, "film", "madvr", {
      present: true,
      power: true,
      settings: { profile: 1 },
    });
    assert.deepEqual(doc.activities.film.devices.madvr, {
      power: true,
      profile: 1,
    });
  });

  test("unchecking a device removes it entirely", () => {
    const doc = DOC();
    panelHelpers.setRequirement(doc, "film", "barco", {
      present: false,
      power: false,
      settings: {},
    });
    assert.equal("barco" in doc.activities.film.devices, false);
  });

  test("empty values are dropped rather than written as blanks", () => {
    const doc = DOC();
    panelHelpers.setRequirement(doc, "film", "madvr", {
      present: true,
      power: true,
      settings: { profile: "", other: null },
    });
    assert.deepEqual(doc.activities.film.devices.madvr, { power: true });
  });

  test("round-trips through requirement unchanged", () => {
    const doc = DOC();
    const before = panelHelpers.requirement(doc, "film", "trinnov");
    panelHelpers.setRequirement(doc, "film", "trinnov", before);
    const after = panelHelpers.requirement(doc, "film", "trinnov");
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.power, before.power);
  });

  test("normalises a nested-settings activity into the inline shape", () => {
    const doc = DOC();
    const req = panelHelpers.requirement(doc, "netflix", "trinnov");
    panelHelpers.setRequirement(doc, "netflix", "trinnov", req);
    assert.deepEqual(doc.activities.netflix.devices.trinnov, {
      power: true,
      source: "shield",
    });
  });
});

describe("slugify / uniqueKey", () => {
  test("makes a usable config key from a German name", () => {
    assert.equal(panelHelpers.slugify("Musik"), "musik");
    assert.equal(panelHelpers.slugify("Große Küche"), "grosse_kueche");
    assert.equal(panelHelpers.slugify("Film & Serien"), "film_serien");
    assert.equal(panelHelpers.slugify("   "), "aktivitaet");
  });

  test("never collides with an existing activity", () => {
    const doc = DOC();
    assert.equal(panelHelpers.uniqueKey(doc, "musik"), "musik");
    assert.equal(panelHelpers.uniqueKey(doc, "film"), "film_2");
    doc.activities.film_2 = {};
    assert.equal(panelHelpers.uniqueKey(doc, "film"), "film_3");
  });
});

describe("errorsByPath", () => {
  test("groups validation errors by the thing they belong to", () => {
    const grouped = panelHelpers.errorsByPath([
      { path: "activities.film.light_scene", message: "a" },
      { path: "activities.film.devices.x", message: "b" },
      { path: "devices.barco.driver", message: "c" },
    ]);
    assert.equal(grouped["activities.film"].length, 2);
    assert.equal(grouped["devices.barco"].length, 1);
  });

  test("survives an empty list", () => {
    assert.deepEqual(panelHelpers.errorsByPath(undefined), {});
  });
});

describe("settingMatches", () => {
  test("compares numbers numerically", () => {
    assert.equal(panelHelpers.settingMatches("-30.0", -30), true);
    assert.equal(panelHelpers.settingMatches("-35.0", -30), false);
  });

  test("compares strings exactly", () => {
    assert.equal(panelHelpers.settingMatches("zidoo", "zidoo"), true);
    assert.equal(panelHelpers.settingMatches("shield", "zidoo"), false);
  });

  test("an unreported value never counts as matching", () => {
    assert.equal(panelHelpers.settingMatches(null, "zidoo"), false);
    assert.equal(panelHelpers.settingMatches(undefined, 1), false);
  });

  test("nothing expected means nothing to disagree with", () => {
    assert.equal(panelHelpers.settingMatches(null, null), true);
  });
});

describe("formatDuration", () => {
  test("seconds below a minute", () => {
    assert.equal(panelHelpers.formatDuration(2.34), "2.3 s");
  });

  test("minutes above one", () => {
    assert.equal(panelHelpers.formatDuration(112), "1:52 min");
    assert.equal(panelHelpers.formatDuration(492), "8:12 min");
  });

  test("missing values are not rendered as zero", () => {
    assert.equal(panelHelpers.formatDuration(null), "—");
  });
});

describe("powerColor", () => {
  test("ready wins over the raw power value", () => {
    assert.equal(panelHelpers.powerColor("on", true), "var(--kino-teal)");
    assert.equal(panelHelpers.powerColor("transitioning", false), "var(--kino-gold)");
    assert.equal(panelHelpers.powerColor("unavailable", false), "var(--kino-red)");
    assert.equal(panelHelpers.powerColor("off", false), "var(--kino-text3)");
  });
});

describe("actionLabel", () => {
  test("translates planner verbs", () => {
    assert.equal(panelHelpers.actionLabel("start"), "starten");
    assert.equal(panelHelpers.actionLabel("reconfigure"), "umkonfigurieren");
    assert.equal(panelHelpers.actionLabel("keep"), "behalten");
    assert.equal(panelHelpers.actionLabel("weird"), "weird");
  });
});

describe("panel escaping", () => {
  test("entity ids and names cannot inject markup", () => {
    const panel = Object.create(KinoPanel.prototype);
    assert.equal(panel._esc('<script>x</script>'), "&lt;script&gt;x&lt;/script&gt;");
    assert.equal(panel._esc(null), "");
  });
});
