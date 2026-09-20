import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// feCollapseRepeatedItemDescriptions keys item-description collapsibles by
// ITEM identity: first occurrence of each item expands, repeats collapse.
// These tests exercise the real exported functions against a minimal DOM
// stub — no jsdom dependency in this repo.

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
  feCollapseRepeatedItemDescriptions,
  feExpandCollapsedArchiveSections,
} = await import("../scripts/fe-archive-message.js");

// ---- minimal DOM stub ------------------------------------------------------
class El {
  constructor(tag, classes = [], attrs = {}) {
    this.nodeType = 1;
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("data-")) {
        const dk = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[dk] = v;
      }
    }
    const set = new Set(classes);
    this.classList = {
      add: (c) => set.add(c),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
    };
    this._classes = set;
    const props = new Map();
    this.style = {
      getPropertyValue: (p) => props.get(p)?.value ?? "",
      setProperty: (p, v, pr) => props.set(p, { value: v, priority: pr }),
      removeProperty: (p) => props.delete(p),
      get display() { return props.get("display")?.value ?? ""; },
    };
  }
  add(child) { child.parent = this; this.children.push(child); return child; }
  *walk() { yield this; for (const c of this.children) yield* c.walk(); }
  matchesSimple(sel) {
    if (sel.startsWith("[")) {
      const name = sel.slice(1, -1);
      return name.startsWith("data-")
        ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== undefined
        : false;
    }
    if (sel.startsWith(".")) {
      return sel.slice(1).split(".").every((c) => this._classes.has(c));
    }
    return false;
  }
  querySelectorAll(sel) {
    const out = [];
    for (const part of sel.split(",").map((s) => s.trim())) {
      const segs = part.split(/\s+/);
      for (const el of this.walk()) {
        if (!el.matchesSimple(segs[segs.length - 1])) continue;
        let node = el.parent, ok = true;
        for (let i = segs.length - 2; i >= 0; i--) {
          while (node && !node.matchesSimple(segs[i])) node = node.parent;
          if (!node) { ok = false; break; }
          node = node.parent;
        }
        if (ok && !out.includes(el)) out.push(el);
      }
    }
    return out;
  }
  closest(sel) {
    let node = this;
    while (node) {
      for (const part of sel.split(",").map((s) => s.trim())) {
        if (node.matchesSimple(part)) return node;
      }
      node = node.parent;
    }
    return null;
  }
}
const el = (tag, cls, attrs, ...kids) => {
  const e = new El(tag, cls, attrs);
  kids.forEach((k) => e.add(k));
  return e;
};

// Mirrors the real dnd5e/midi card: a description collapsible arriving with
// the live-collapsed computed state baked inline by the style mirror.
const mkCard = (attrs) => {
  const card = el("div", ["chat-card", "midi-chat-card"], attrs);
  const header = card.add(el("section", ["card-header", "description", "collapsible"]));
  header.add(el("header", ["summary"]));
  const details = header.add(el("section", ["details", "collapsible-content", "card-content"]));
  details.style.setProperty("opacity", "0", "important");
  details.style.setProperty("grid", "0px / 255px", "important");
  details.add(el("div", ["wrapper"]));
  return card;
};
const li = (...kids) => el("li", ["chat-message"], {}, ...kids);
const descOf = (msg) => msg.querySelectorAll(".collapsible-content")[0];

test("item description expands on first occurrence and collapses on repeats", () => {
  const seen = new Set();
  const msgs = [
    li(mkCard({ "data-item-uuid": "Actor.AAA.Item.111" })),
    li(mkCard({ "data-item-uuid": "Actor.AAA.Item.111" })),
    li(mkCard({ "data-item-uuid": "Actor.BBB.Item.222" })),
  ];
  for (const m of msgs) feExpandCollapsedArchiveSections(m);
  assert.equal(feCollapseRepeatedItemDescriptions(msgs[0], seen), 0);
  assert.equal(descOf(msgs[0]).style.getPropertyValue("display"), "");
  assert.equal(feCollapseRepeatedItemDescriptions(msgs[1], seen), 1);
  assert.equal(descOf(msgs[1]).style.getPropertyValue("display"), "none");
  assert.equal(feCollapseRepeatedItemDescriptions(msgs[2], seen), 0);
  assert.equal(descOf(msgs[2]).style.getPropertyValue("display"), "");
});

test("token-scoped uuid normalizes to the actor's item document", () => {
  const seen = new Set();
  const world = li(mkCard({ "data-item-uuid": "Actor.AAA.Item.111" }));
  const viaToken = li(mkCard({ "data-item-uuid": "Scene.S1.Token.T1.Actor.AAA.Item.111" }));
  const viaOtherToken = li(mkCard({ "data-item-uuid": "Scene.S1.Token.T2.Actor.AAA.Item.111" }));
  assert.equal(feCollapseRepeatedItemDescriptions(world, seen), 0);
  assert.equal(feCollapseRepeatedItemDescriptions(viaToken, seen), 1);
  assert.equal(feCollapseRepeatedItemDescriptions(viaOtherToken, seen), 1);
});

test("data-item-id falls back to actor-scoped key", () => {
  const seen = new Set();
  const a1 = li(mkCard({ "data-item-id": "x9", "data-actor-uuid": "Actor.CCC" }));
  const a2 = li(mkCard({ "data-item-id": "x9", "data-actor-uuid": "Actor.CCC" }));
  const b1 = li(mkCard({ "data-item-id": "x9", "data-actor-uuid": "Actor.DDD" }));
  assert.equal(feCollapseRepeatedItemDescriptions(a1, seen), 0);
  assert.equal(feCollapseRepeatedItemDescriptions(a2, seen), 1);
  assert.equal(feCollapseRepeatedItemDescriptions(b1, seen), 0);
});

test("cards with no item identity are never hidden", () => {
  const seen = new Set();
  const m1 = li(mkCard({}));
  const m2 = li(mkCard({}));
  assert.equal(feCollapseRepeatedItemDescriptions(m1, seen), 0);
  assert.equal(feCollapseRepeatedItemDescriptions(m2, seen), 0);
  assert.equal(descOf(m1).style.getPropertyValue("display"), "");
  assert.equal(descOf(m2).style.getPropertyValue("display"), "");
});

test("expand pass clears mirrored collapse state (opacity/grid/display)", () => {
  const m = li(mkCard({ "data-item-uuid": "Actor.AAA.Item.111" }));
  const d = descOf(m);
  d.style.setProperty("display", "none", "important");
  feExpandCollapsedArchiveSections(m);
  assert.equal(d.style.getPropertyValue("display"), "");
  assert.equal(d.style.getPropertyValue("opacity"), "");
  assert.equal(d.style.getPropertyValue("grid"), "");
});

// Source-level tripwires: the registry must live in the ordered commit loop,
// not the parallel renderOne pass — "first" is a document-order decision.
test("registry is per-export and consumed in document order", () => {
  const src = readFileSync(new URL("../scripts/fe-archive-message.js", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export async function feRenderMessagesIntoLog"));
  assert.match(fn, /const itemDescriptionRegistry = new Set\(\);/);
  const loopIdx = fn.indexOf("feCollapseRepeatedItemDescriptions(node, itemDescriptionRegistry)");
  assert.ok(loopIdx > fn.indexOf("Promise.all"), "must run after the parallel render batch");
  assert.ok(loopIdx > fn.indexOf("feOptimizeArchiveNodeImages"), "must run in the ordered commit loop");
});
