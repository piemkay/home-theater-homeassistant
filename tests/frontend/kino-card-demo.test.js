/**
 * Demo mode in the card: timecodes, the clip library, the trim editor and
 * the two runtime overlays.
 *
 * The rule these tests exist to hold: milliseconds are the storage format
 * and never the display format, and every number the user sees is one they
 * could have typed themselves.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { helpers, KinoCard } from "../../custom_components/kino/www/kino-card.js";

describe("timecodes", () => {
  test("the three spellings of the same moment all resolve", () => {
    assert.equal(helpers.parseTimecode("1:12:04"), 4324000);
    assert.equal(helpers.parseTimecode("72:04"), 4324000);
    assert.equal(helpers.parseTimecode("4324"), 4324000);
  });

  test("stray whitespace is forgiven", () => {
    assert.equal(helpers.parseTimecode(" 1 : 12 : 04 "), 4324000);
  });

  test("what is not a timecode returns null, not a wrong number", () => {
    for (const bad of ["", "abc", "1:2:x", "--", null, undefined]) {
      assert.equal(helpers.parseTimecode(bad), null);
    }
  });

  test("rendering matches the integration's own spelling", () => {
    assert.equal(helpers.formatTimecode(62000), "1:02");
    assert.equal(helpers.formatTimecode(4324000), "1:12:04");
    assert.equal(helpers.formatTimecode(-5000), "0:00");
  });

  test("a timecode survives the round trip", () => {
    assert.equal(helpers.parseTimecode(helpers.formatTimecode(4324000)), 4324000);
  });

  test("a tag falls back to the free-text tag itself", () => {
    const vocabulary = [{ key: "bass_heavy", label: "Bass" }];
    assert.equal(helpers.tagLabel("bass_heavy", vocabulary), "Bass");
    assert.equal(helpers.tagLabel("kirchenorgel", vocabulary), "kirchenorgel");
  });
});

const clip = (over = {}) => ({
  id: "c1",
  itemId: "m1",
  title: "Sturmwarnung",
  name: "Deichbruch",
  start: "1:02:00",
  end: "1:02:45",
  duration: "0:45",
  startMs: 3720000,
  endMs: 3765000,
  durationMs: 45000,
  tags: ["bass_heavy"],
  notes: "Subbass beim Deichbruch.",
  audioTrack: "1: English TrueHD",
  subtitleTrack: null,
  ...over,
});

const VOCABULARY = [
  { key: "bass_heavy", label: "Bass" },
  { key: "guest_safe", label: "Gästetauglich" },
];

describe("the Demos tab", () => {
  const demoCard = (demo = {}, view = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      artworkSignature: "sig",
      demo: { running: null, retroCaptureSeconds: 60 },
    };
    card._demo = {
      clips: [],
      showcases: [],
      vocabulary: VOCABULARY,
      settings: {},
      options: {},
      ...demo,
    };
    card._view = {
      demoTab: "clips",
      demoTagFilter: [],
      trim: null,
      scEdit: null,
      abSetup: null,
      ...view,
    };
    return card;
  };

  test("an empty library explains where clips come from", () => {
    const html = demoCard()._renderDemos();
    assert.match(html, /Noch keine Demo-Clips/);
    assert.match(html, /Demo erstellen/);
  });

  test("a clip shows its span, its length and its notes", () => {
    const html = demoCard({ clips: [clip()] })._renderDemos();
    assert.match(html, /Deichbruch/);
    assert.match(html, /1:02:00–1:02:45/);
    assert.match(html, /Subbass beim Deichbruch/);
  });

  test("milliseconds never reach the screen", () => {
    const html = demoCard({ clips: [clip()] })._renderDemos();
    assert.doesNotMatch(html, /3720000|3765000|45000/);
  });

  test("tag chips carry their own count", () => {
    const html = demoCard({
      clips: [clip(), clip({ id: "c2", tags: ["bass_heavy", "guest_safe"] })],
    })._renderDemos();
    assert.match(html, /Bass<span class="chipcount">2<\/span>/);
    assert.match(html, /Gästetauglich<span class="chipcount">1<\/span>/);
  });

  test("a tag filter narrows the list, and says when nothing matches", () => {
    const html = demoCard({ clips: [clip()] }, { demoTagFilter: ["guest_safe"] })
      ._renderDemos();
    assert.doesNotMatch(html, /Deichbruch/);
    assert.match(html, /Kein Clip trägt alle gewählten Tags/);
  });

  test("every clip offers play and A/B", () => {
    const html = demoCard({ clips: [clip()] })._renderDemos();
    assert.match(html, /data-act="demo-play-clip" data-key="c1"/);
    assert.match(html, /data-act="demo-ab" data-key="c1"/);
  });

  test("a clip links back to the title it came from", () => {
    const html = demoCard({ clips: [clip()] })._renderDemos();
    assert.match(html, /data-act="demo-open-title" data-key="m1"/);
  });

  test("a showcase names its length, its mode and its reference level", () => {
    const html = demoCard(
      {
        clips: [clip()],
        showcases: [
          {
            id: "s1",
            name: "Gäste-Demo",
            clips: ["c1"],
            advance: "tap",
            gapSeconds: 8,
            referenceVolumeDb: -18,
          },
        ],
      },
      { demoTab: "showcases" }
    )._renderDemos();
    assert.match(html, /Gäste-Demo/);
    assert.match(html, /1 Clip · ~1 Min · Per Tipp · Referenz -18 dB/);
    assert.match(html, /data-act="demo-play-showcase" data-key="s1"/);
  });

  test("a showcase with no reference level does not invent one", () => {
    const html = demoCard(
      {
        showcases: [
          {
            id: "s1",
            name: "Rest",
            clips: [],
            advance: "auto",
            gapSeconds: 8,
            referenceVolumeDb: null,
          },
        ],
      },
      { demoTab: "showcases" }
    )._renderDemos();
    assert.match(html, /0 Clips/);
    assert.doesNotMatch(html, /Referenz/);
  });

  test("markup in a clip name cannot inject", () => {
    const html = demoCard({
      clips: [clip({ name: '<img src=x onerror="alert(1)">' })],
    })._renderDemos();
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });
});

describe("the trim editor", () => {
  const trimCard = (over = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = {
      artworkSignature: "sig",
      demo: { running: null, leadInSeconds: 8 },
      entities: {},
    };
    card._hass = { states: {} };
    card._demo = {
      clips: [],
      showcases: [],
      vocabulary: VOCABULARY,
      options: {},
    };
    card._view = {
      trim: {
        id: null,
        itemId: "m1",
        path: null,
        title: "Sturmwarnung",
        start: "1:02:00",
        end: "1:02:45",
        name: "",
        tags: [],
        notes: "",
        tagInput: "",
        audioTrack: null,
        subtitleTrack: null,
        anchorMs: 3765000,
        previewAt: null,
        previewing: false,
        ...over,
      },
    };
    card._render = () => {};
    return card;
  };

  test("the span shows as a timecode and a readable length", () => {
    const html = trimCard()._renderTrimSheet();
    assert.match(html, /value="1:02:00"/);
    assert.match(html, /value="1:02:45"/);
    assert.match(html, /Länge: 0:45/);
  });

  test("a reversed span is refused rather than saved", () => {
    const card = trimCard({ start: "1:02:45", end: "1:02:00" });
    assert.equal(card._trimSpan.valid, false);
    assert.match(card._renderTrimSheet(), /data-act="trim-save"[^>]*disabled/);
  });

  test("nonsense in a field disables saving instead of guessing", () => {
    const card = trimCard({ end: "spät" });
    assert.equal(card._trimSpan.valid, false);
    assert.match(card._renderTrimSheet(), /Länge: —/);
  });

  test("both ends nudge by five and by one second", () => {
    const html = trimCard()._renderTrimSheet();
    assert.match(html, /data-act="trim-nudge" data-key="start:-5"/);
    assert.match(html, /data-act="trim-nudge" data-key="end:1"/);
  });

  test("nudging the start moves only the start", () => {
    const card = trimCard();
    card._nudgeTrim("start", -5);
    assert.equal(card._view.trim.start, "1:01:55");
    assert.equal(card._view.trim.end, "1:02:45");
  });

  test("shifting moves the whole span, keeping its length", () => {
    const card = trimCard();
    card._shiftTrim(-60);
    assert.equal(card._view.trim.start, "1:01:00");
    assert.equal(card._view.trim.end, "1:01:45");
  });

  test("a shift never drags the start below zero", () => {
    const card = trimCard({ start: "0:10", end: "0:40" });
    card._shiftTrim(-60);
    assert.equal(card._view.trim.start, "0:00");
    assert.equal(card._view.trim.end, "0:30");
  });

  test("the keyframe limitation is stated, not hidden", () => {
    assert.match(trimCard()._renderTrimSheet(), /nächsten Keyframe/);
  });

  test("without a catalogue entry there is no preview to offer", () => {
    const html = trimCard({ itemId: null })._renderTrimSheet();
    assert.doesNotMatch(html, /data-act="trim-preview"/);
    assert.match(html, /keine Vorschau möglich/);
  });

  test("an existing clip offers deletion, a fresh one does not", () => {
    assert.match(trimCard({ id: "c1" })._renderTrimSheet(), /data-act="trim-delete"/);
    assert.doesNotMatch(trimCard()._renderTrimSheet(), /data-act="trim-delete"/);
  });

  test("the placeholder name carries the title and the span", () => {
    assert.match(
      trimCard()._renderTrimSheet(),
      /placeholder="Sturmwarnung — 1:02:00–1:02:45"/
    );
  });

  test("the vocabulary and any free tag both render as chips", () => {
    const html = trimCard({ tags: ["bass_heavy", "kirchenorgel"] })._renderTrimSheet();
    assert.match(html, /data-act="trim-tag" data-key="bass_heavy"[^>]*aria-pressed="true"/);
    assert.match(html, /data-act="trim-tag" data-key="kirchenorgel"/);
  });
});

describe("the demo runtime overlay", () => {
  const runCard = (running) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { artworkSignature: "sig", demo: { running, leadInSeconds: 8 } };
    card._demo = { clips: [], showcases: [], vocabulary: [], options: {} };
    card._view = {};
    return card;
  };
  const base = {
    mode: "showcase",
    name: "Gäste-Demo",
    phase: "playing",
    index: 0,
    count: 2,
    paused: false,
    warning: null,
    phaseStartedAt: 1000,
    phaseEndsAt: 46000,
    advance: "auto",
    clip: {
      name: "Deichbruch",
      notes: "Subbass.",
      start: "1:02:00",
      startMs: 3720000,
      endMs: 3765000,
    },
    clips: [
      { id: "c1", name: "Deichbruch", duration: "0:45" },
      { id: "c2", name: "Treppenhaus", duration: "0:50" },
    ],
    totalRemainingMs: 95000,
  };

  test("the header counts the clip and the showcase's remaining time", () => {
    const html = runCard(base)._renderDemoRun();
    assert.match(html, /Demo · Gäste-Demo/);
    assert.match(html, /Clip 1 von 2/);
    assert.match(html, /Showcase: noch ~1:35/);
  });

  test("what to notice is on the phone while the clip runs", () => {
    const html = runCard(base)._renderDemoRun();
    assert.match(html, /Worauf achten/);
    assert.match(html, /Subbass\./);
  });

  test("the slate names the clip that is coming and counts down", () => {
    const html = runCard({ ...base, phase: "slate" })._renderDemoRun();
    assert.match(html, /Als Nächstes/);
    assert.match(html, /data-demo="countdown"/);
  });

  test("waiting for a tap offers the tap, not a countdown", () => {
    const html = runCard({ ...base, phase: "wait" })._renderDemoRun();
    assert.match(html, /data-act="demo-next"/);
    assert.doesNotMatch(html, /data-demo="countdown"/);
  });

  test("the lead-in explains itself in seconds, not in jargon", () => {
    const html = runCard({ ...base, phase: "leadin" })._renderDemoRun();
    assert.match(html, /Vorlauf läuft/);
    assert.match(html, /Start 8 s vor dem/);
  });

  test("every clip can be jumped to, and the running one is marked", () => {
    const html = runCard(base)._renderDemoRun();
    assert.match(html, /aria-current="true"[\s\S]*?data-key="0"/);
    assert.match(html, /data-act="demo-jump" data-key="1"/);
  });

  test("a paused demo offers play, a running one pause", () => {
    assert.match(runCard({ ...base, paused: true })._renderDemoRun(), /demo-pause">▶/);
    assert.match(runCard(base)._renderDemoRun(), /demo-pause">⏸/);
  });

  test("the finished summary says the room was put back", () => {
    const html = runCard({ ...base, phase: "done" })._renderDemoRun();
    assert.match(html, /Showcase beendet/);
    assert.match(html, /zurückgesetzt/);
    assert.doesNotMatch(html, /data-act="demo-skip"/);
  });

  test("a failure names itself instead of hanging", () => {
    const html = runCard({
      ...base,
      phase: "error",
      warning: "Der Player meldet nichts.",
    })._renderDemoRun();
    assert.match(html, /abgebrochen/);
    assert.match(html, /Der Player meldet nichts\./);
  });

  test("a warning during playback is shown without stopping anything", () => {
    const html = runCard({
      ...base,
      warning: "Konfiguration nicht bestätigt.",
    })._renderDemoRun();
    assert.match(html, /class="warnbox"/);
    assert.match(html, /Konfiguration nicht bestätigt\./);
    assert.match(html, /data-act="demo-skip"/);
  });

  test("the history marker is stated on screen", () => {
    assert.match(runCard(base)._renderDemoRun(), /demo=true/);
  });

  test("an A/B run is not rendered as a showcase", () => {
    assert.equal(runCard({ ...base, mode: "ab" })._renderDemoRun(), "");
  });

  test("the transport offers what the playback view offers", () => {
    const html = runCard({ ...base, index: 1 })._renderDemoRun();
    assert.match(html, /data-act="demo-prev"/);
    assert.match(html, /data-act="seek" data-key="-10"/);
    assert.match(html, /data-act="seek" data-key="10"/);
    assert.match(html, /data-act="demo-pause"/);
    assert.match(html, /data-act="demo-skip"/);
    assert.match(html, /data-act="demo-replay"/);
    assert.match(html, /data-act="mute"/);
  });

  test("the ends of the showcase disable the clip steps", () => {
    const firstClip = runCard(base)._renderDemoRun();
    assert.match(firstClip, /data-act="demo-prev"[\s\S]{0,80}disabled/);
    const lastClip = runCard({ ...base, index: 1 })._renderDemoRun();
    assert.match(lastClip, /data-act="demo-skip"[\s\S]{0,80}disabled/);
  });

  test("a paused demo offers no seek — the player refuses one", () => {
    const html = runCard({ ...base, paused: true })._renderDemoRun();
    assert.match(html, /data-act="seek" data-key="10"\n?\s*title="10 Sekunden vor" disabled/);
  });
});

describe("the running clip's progress", () => {
  const progressCard = (over = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._demoBar = null;
    card._kino = {
      demo: {
        running: {
          mode: "showcase",
          phase: "playing",
          index: 0,
          count: 1,
          paused: false,
          gapSeconds: 8,
          clip: { id: "c1", name: "Deichbruch", startMs: 60000, endMs: 100000 },
          clips: [{ id: "c1", name: "Deichbruch", durationMs: 40000 }],
          positionMs: 80000,
          positionAtMs: Date.now(),
          ...over,
        },
      },
    };
    return card;
  };

  test("the bar comes from the player's position, not from the phase's end", () => {
    // Halfway through a forty-second clip.
    const progress = progressCard()._demoClipProgress();
    assert.equal(progress.fraction, 0.5);
    assert.equal(progress.positionMs, 80000);
    assert.equal(progress.remainingMs, 20000);
  });

  test("the position is carried forward between the engine's samples", () => {
    const progress = progressCard({ positionAtMs: Date.now() - 10000 })
      ._demoClipProgress();
    assert.equal(progress.positionMs, 90000);
    assert.equal(progress.fraction, 0.75);
  });

  test("a paused demo is a still frame", () => {
    const progress = progressCard({
      paused: true,
      positionAtMs: Date.now() - 10000,
    })._demoClipProgress();
    assert.equal(progress.positionMs, 80000);
  });

  test("a player repeating itself does not walk the bar backwards", () => {
    // The engine samples, the clock runs on, then the same number arrives
    // again: without the hold the second reading is behind the first.
    const card = progressCard();
    const run = card._kino.demo.running;
    run.positionAtMs = Date.now() - 900;
    const first = card._demoClipProgress().fraction;
    run.positionAtMs = Date.now();
    const second = card._demoClipProgress().fraction;
    assert.equal(second, first);
  });

  test("a real seek backwards does move the bar back", () => {
    const card = progressCard();
    const run = card._kino.demo.running;
    const before = card._demoClipProgress().fraction;
    run.positionMs = 65000; // ten seconds back, by hand
    const after = card._demoClipProgress().fraction;
    assert.ok(after < before, `${after} should be behind ${before}`);
  });

  test("a new clip starts its own bar rather than inheriting the last one", () => {
    const card = progressCard();
    card._demoClipProgress();
    const run = card._kino.demo.running;
    run.index = 1;
    run.clip = { id: "c2", name: "Treppenhaus", startMs: 0, endMs: 40000 };
    run.positionMs = 4000;
    assert.equal(card._demoClipProgress().fraction, 0.1);
  });

  test("A/B measures the stretch the engine cut, not the whole clip", () => {
    // A/B truncates a long clip; the bar has to span what is actually played.
    const progress = progressCard({
      clip: { id: "c1", name: "x", startMs: 60000, endMs: 300000 },
      spanStartMs: 60000,
      spanEndMs: 100000,
    })._demoClipProgress();
    assert.equal(progress.fraction, 0.5);
  });

  test("what is left of the showcase counts the clips still to come", () => {
    const card = progressCard({
      index: 0,
      count: 2,
      clips: [
        { id: "c1", name: "a", durationMs: 40000 },
        { id: "c2", name: "b", durationMs: 50000 },
      ],
    });
    // Twenty seconds of this clip, then an eight-second gap and fifty more.
    assert.equal(card._demoShowcaseRemaining(20000), 78000);
  });

  test("nothing is claimed before the engine has reported a position", () => {
    assert.equal(
      progressCard({ positionMs: null, phaseEndsAt: 0 })._demoClipProgress(),
      null
    );
  });
});

describe("the A/B comparison", () => {
  const abCard = (running) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { artworkSignature: "sig", demo: { running } };
    card._demo = { clips: [], showcases: [], vocabulary: [], options: {} };
    card._view = {};
    return card;
  };
  const base = {
    mode: "ab",
    name: "Deichbruch",
    phase: "play",
    index: 0,
    count: 1,
    side: 1,
    blind: true,
    order: ["B", "A"],
    configs: { A: { preset: "Kino Referenz" }, B: { preset: "Nacht" } },
    winner: null,
    currentConfig: null,
    clip: { name: "Deichbruch" },
    clips: [],
    totalRemainingMs: 0,
    warning: null,
  };

  test("a blind round hides which configuration is playing", () => {
    const html = abCard(base)._renderAbRun();
    assert.match(html, /Durchgang 1/);
    assert.match(html, /Konfiguration verborgen/);
    assert.doesNotMatch(html, /Nacht|Kino Referenz/);
  });

  test("a sighted round names it", () => {
    const html = abCard({
      ...base,
      blind: false,
      currentConfig: { preset: "Nacht" },
    })._renderAbRun();
    assert.match(html, /Nacht/);
  });

  test("the gap says it is waiting for the hardware", () => {
    const html = abCard({ ...base, phase: "gap" })._renderAbRun();
    assert.match(html, /Konfiguration wird angewendet/);
    assert.match(html, /bestätigtem Preset/);
  });

  test("the verdict offers both rounds, and replaying either", () => {
    const html = abCard({ ...base, phase: "decide" })._renderAbRun();
    assert.match(html, /data-act="ab-pick" data-key="1"/);
    assert.match(html, /data-act="ab-pick" data-key="2"/);
    assert.match(html, /data-act="ab-replay" data-key="2"/);
  });

  test("the result reveals the blind assignment", () => {
    const html = abCard({ ...base, phase: "result", winner: "B" })._renderAbRun();
    assert.match(html, /Gewinner: Konfiguration B — Nacht/);
    assert.match(html, /Durchgang 1 war B/);
    assert.match(html, /Durchgang 2 war A/);
  });

  test("a sighted comparison needs no reveal", () => {
    const html = abCard({
      ...base,
      phase: "result",
      winner: "A",
      blind: false,
    })._renderAbRun();
    assert.match(html, /Gewinner: Konfiguration A/);
    assert.doesNotMatch(html, /Blind-Zuordnung/);
  });

  test("a madVR slot reads as a slot, not as a bare number", () => {
    const html = abCard({
      ...base,
      phase: "result",
      winner: "A",
      blind: false,
      configs: { A: { preset: "Nacht", madvr: "2" }, B: {} },
    })._renderAbRun();
    assert.match(html, /Nacht · madVR 2/);
  });
});

describe("the showcase editor", () => {
  const editorCard = (edit = {}) => {
    const card = Object.create(KinoCard.prototype);
    card._kino = { artworkSignature: "sig", demo: { running: null } };
    card._demo = {
      clips: [clip(), clip({ id: "c2", name: "Treppenhaus" })],
      showcases: [],
      vocabulary: VOCABULARY,
      options: {},
    };
    card._view = {
      scEdit: {
        id: null,
        name: "",
        clips: [],
        advance: "auto",
        gapSeconds: 8,
        referenceVolumeDb: -18,
        ...edit,
      },
    };
    return card;
  };

  test("a nameless, empty showcase cannot be saved", () => {
    assert.match(editorCard()._renderShowcaseEditor(), /data-act="sc-save"[^>]*disabled/);
  });

  test("a named showcase with one clip can", () => {
    const html = editorCard({ name: "Gäste", clips: ["c1"] })._renderShowcaseEditor();
    assert.doesNotMatch(html, /data-act="sc-save"[^>]*disabled/);
  });

  test("chosen clips are ordered and movable, the rest are addable", () => {
    const html = editorCard({ name: "Gäste", clips: ["c1"] })._renderShowcaseEditor();
    assert.match(html, /data-act="sc-move" data-key="0:1"/);
    assert.match(html, /data-act="sc-remove" data-key="0"/);
    assert.match(html, /data-act="sc-add" data-key="c2"/);
    assert.doesNotMatch(html, /data-act="sc-add" data-key="c1"/);
  });

  test("gap and reference level read in their own units", () => {
    const html = editorCard()._renderShowcaseEditor();
    assert.match(html, /8 s/);
    assert.match(html, /-18 dB/);
  });

  test("only an existing showcase can be deleted", () => {
    assert.doesNotMatch(editorCard()._renderShowcaseEditor(), /data-act="sc-delete"/);
    assert.match(
      editorCard({ id: "s1", name: "Gäste", clips: ["c1"] })._renderShowcaseEditor(),
      /data-act="sc-delete"/
    );
  });
});
