import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.Hooks = { once() {}, on() {}, callAll() {}, call() {} };
globalThis.game = {
  settings: { get() {}, register() {}, registerMenu() {} },
  i18n: { localize: k => k, format: k => k },
  user: { isGM: true },
};
globalThis.foundry = { utils: {} };
globalThis.CONFIG = {};
globalThis.ui = {};
const {
  feArchiveMessageLooksComplex,
  feArchiveShouldTrySystemRender,
  feArchiveShouldUseStandardFallback,
  feExpandCollapsedArchiveSections,
} = await import("../scripts/fe-archive-message.js");
const { feNormalizeArchiveMessageLayout } = await import("../scripts/fe-archive-output.js");

// Minimal stored markup from the installed DX3rd card builders. Fixed-value
// judgments have no Roll and only fill dx3rd-info__text in the render hook.
for (const cls of ["dx3rd-item-chat", "dx3rd-item-info", "dx3rd-box", "dx3rd-info"]) {
  test(`roll-less ${cls} cards retain the system rendering path`, () => {
    const msg = { content: `<div class="${cls}"><span></span></div>`, rolls: [] };
    assert.equal(feArchiveShouldTrySystemRender(msg), true);
    assert.equal(feArchiveShouldUseStandardFallback(msg), false);
    const live = { querySelector: selector => selector.split(", ").includes(`.${cls}`) ? {} : null };
    assert.equal(feArchiveMessageLooksComplex({ content: "" }, live), true);
  });
}

test("dnd5e model-generated cards render even with empty stored content and no rolls", () => {
  for (const type of ["item", "rest", "usage"]) {
    const msg = { type, content: "", rolls: [], system: { getHTML() {} } };
    assert.equal(feArchiveShouldTrySystemRender(msg), true, type);
    assert.equal(feArchiveShouldUseStandardFallback(msg), false, type);
  }
  assert.equal(feArchiveMessageLooksComplex({ content: "hello", type: "base", system: {} }), false);
});

test("DX3rd system notifications run the hook which adds their root styling class", () => {
  const msg = {
    content: '<div class="dx3rd-system"><span>HP</span></div>', rolls: [],
    flags: { "dx3rd-fvtt": { systemChat: true } },
  };
  assert.equal(feArchiveShouldTrySystemRender(msg), true);
});

function element(classes = [], tagName = "DIV") {
  const names = new Set(classes);
  const props = new Map();
  const attrs = new Map();
  return {
    nodeType: 1, tagName, dataset: {},
    classList: { contains: c => names.has(c), add: c => names.add(c), remove: c => names.delete(c) },
    style: {
      setProperty: (p, v) => props.set(p, v),
      getPropertyValue: p => props.get(p) ?? "",
      removeProperty: p => props.delete(p),
    },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: k => attrs.delete(k),
    hasAttribute: k => attrs.has(k),
    querySelectorAll: () => [],
  };
}

test("native details and dnd5e popover breakdowns are exported open in normal flow", () => {
  const details = element([], "DETAILS");
  const breakdown = element(["roll-breakdown"]);
  const row = element(["icon-row"]);
  breakdown.parentElement = row;
  breakdown.setAttribute("popover", "");
  for (const [p, v] of [["display", "none"], ["position", "fixed"], ["top", "120px"], ["width", "300px"], ["opacity", "0"]]) {
    breakdown.style.setProperty(p, v);
  }
  const root = element();
  root.querySelectorAll = selector => selector === "details" ? [details]
    : selector === ".roll-breakdown[popover]" ? [breakdown] : [];
  feExpandCollapsedArchiveSections(root);
  assert.equal(details.hasAttribute("open"), true);
  assert.equal(breakdown.hasAttribute("popover"), false);
  assert.equal(breakdown.style.getPropertyValue("position"), "static");
  assert.equal(breakdown.style.getPropertyValue("inset"), "auto");
  assert.equal(breakdown.style.getPropertyValue("display"), "block");
  assert.equal(breakdown.style.getPropertyValue("width"), "auto");
  assert.equal(breakdown.style.getPropertyValue("opacity"), "");
  assert.equal(row.style.getPropertyValue("flex-wrap"), "wrap");
  assert.equal(breakdown.style.getPropertyValue("flex"), "0 0 100%");
});

test("LANCER outer cards fit their margins without changing the flex display", () => {
  const card = element(["card", "clipped"]);
  card.style.setProperty("display", "flex");
  card.style.setProperty("margin", "3px 10px");
  const content = element(["message-content"]);
  card.parentElement = content;
  const msg = element(["chat-message"], "LI");
  msg.matches = () => true;
  msg.querySelectorAll = () => [card];
  feNormalizeArchiveMessageLayout(msg);
  assert.equal(card.style.getPropertyValue("width"), "auto");
  assert.equal(card.style.getPropertyValue("inline-size"), "auto");
  assert.equal(card.style.getPropertyValue("display"), "flex");
  assert.equal(card.style.getPropertyValue("margin"), "3px 10px");
});

test("generic archive child rules do not flatten system card flex/grid displays", () => {
  const css = readFileSync(new URL("../styles/fe-chat-archive.css", import.meta.url), "utf8");
  const rule = css.match(/#fe-chat-export-container \.chat-message > \.message-content > :is\(div,[\s\S]*?\{([^}]+)\}/);
  assert.ok(rule);
  assert.doesNotMatch(rule[1], /display\s*:\s*block/);
});
