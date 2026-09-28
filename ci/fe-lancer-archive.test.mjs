import test from "node:test";
import assert from "node:assert/strict";

// LANCER in the chat archive. Both failures guarded here are silent: a card that
// reads as "plain" is still exported, just through the fallback renderer with its
// layout flattened, and a collapsed section is still in the DOM, just invisible.

globalThis.Hooks = { once() {}, on() {}, callAll() {}, call() {} };
globalThis.game = {
  settings: { get: () => undefined, register() {}, registerMenu() {} },
  i18n: { localize: (k) => k, format: (k) => k },
  user: { isGM: true },
};
globalThis.foundry = { utils: {} };
globalThis.CONFIG = {};
globalThis.ui = {};

const {
  feArchiveMessageLooksComplex,
  feArchiveShouldUseStandardFallback,
  feExpandCollapsedArchiveSections,
} = await import("../scripts/fe-archive-message.js");

// An activation card: no rolls, no <img>, no .chat-card — the case that used to
// be classified as a plain text message.
const ACTIVATION_CARD = `<div class="card clipped-bot" style="margin: 0px;"><div class="lancer-header lancer-primary"><span>Boost</span></div><div class="effect-text">Move your speed.</div></div>`;

test("a roll-less LANCER card is complex, so it never takes the plain fallback", () => {
  const msg = { content: ACTIVATION_CARD, rolls: [] };
  assert.equal(feArchiveMessageLooksComplex(msg), true);
  assert.equal(feArchiveShouldUseStandardFallback(msg), false);
});

test("plain text and a bare .card stay plain", () => {
  assert.equal(feArchiveMessageLooksComplex({ content: "<p>hello</p>", rolls: [] }), false);
  assert.equal(feArchiveMessageLooksComplex({ content: `<div class="card">x</div>`, rolls: [] }), false);
});

function fakeEl(classes) {
  const set = new Set(classes);
  const props = new Map();
  return {
    nodeType: 1,
    classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) },
    style: {
      getPropertyValue: (p) => props.get(p) ?? "",
      setProperty: (p, v) => props.set(p, v),
      removeProperty: (p) => props.delete(p),
      get display() { return props.get("display") ?? ""; },
    },
  };
}

test("a LANCER section the user collapsed is exported open, mirrored hide styles included", () => {
  const section = fakeEl(["collapse", "collapsed"]);
  // What feMirrorLiveMessageStyles bakes inline from the collapsed computed state.
  for (const [p, v] of [["opacity", "0"], ["max-height", "0px"], ["padding", "0px"], ["overflow", "hidden"]]) {
    section.style.setProperty(p, v, "important");
  }
  const root = {
    nodeType: 1,
    querySelectorAll: (sel) => (sel === ".collapse.collapsed" ? [section] : []),
  };

  feExpandCollapsedArchiveSections(root);

  assert.equal(section.classList.contains("collapsed"), false);
  for (const p of ["opacity", "max-height", "padding", "overflow"]) {
    assert.equal(section.style.getPropertyValue(p), "", `${p} still pinned`);
  }
});
