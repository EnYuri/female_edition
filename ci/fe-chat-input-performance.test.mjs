import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/fe-chat-enhance.js", import.meta.url), "utf8");
const installer = source.match(/^function feInstallChatMenuTypingFastPath\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(installer, "chat menu typing fast path exists");

function harness(generation = 14) {
  let originalCalls = 0;
  let renders = 0;
  const states = { bold: false, heading: false };
  const bold = { key: "bold", active: false };
  const heading = { key: "heading", active: false };
  const button = { disabled: false };
  const badge = { childElementCount: 0 };
  const menu = {
    querySelector: selector => selector === "button" ? button : badge,
  };
  const doc = { getElementById: () => menu };
  const view = {
    dom: { closest: selector => selector === "prose-mirror#chat-message" ? {} : null, ownerDocument: doc },
    state: { doc: {} },
    editable: true,
  };
  const previous = { doc: {} };
  const instance = {
    id: "chat-menu",
    dropdowns: [{ forEachItem: fn => fn(bold) }],
    items: [heading],
    _isItemActive: item => states[item.key],
    render: () => { renders++; },
  };
  class Menu {}
  Menu.prototype.update = () => { originalCalls++; };
  const context = vm.createContext({
    game: { release: { generation } },
    foundry: { prosemirror: { ProseMirrorMenu: Menu } },
  });
  vm.runInContext(`${installer}\nfeInstallChatMenuTypingFastPath()`, context);
  const update = () => Menu.prototype.update.call(instance, view, previous);
  return {
    update, states, button, badge, doc, view, previous,
    get originalCalls() { return originalCalls; },
    get renders() { return renders; },
    installAgain: () => vm.runInContext("feInstallChatMenuTypingFastPath()", context),
  };
}

test("plain chat typing skips the toolbar rebuild when formatting is unchanged", () => {
  const h = harness();
  h.update();
  h.update();
  assert.equal(h.originalCalls, 0);
  assert.equal(h.renders, 0);
  h.installAgain();
  h.update();
  assert.equal(h.originalCalls, 0);
});

test("format changes still redraw the toolbar", () => {
  const h = harness();
  h.states.bold = true;
  h.update();
  assert.equal(h.renders, 1);
  h.update();
  assert.equal(h.renders, 1);
  h.states.heading = true;
  h.update();
  assert.equal(h.renders, 2);
});

test("selection-only updates, other editors, and missing menus use core", () => {
  const h = harness();
  h.previous.doc = h.view.state.doc;
  h.update();
  h.previous.doc = {};
  h.view.dom.closest = () => null;
  h.update();
  h.view.dom.closest = () => ({});
  h.doc.getElementById = () => null;
  h.update();
  assert.equal(h.originalCalls, 3);
});

test("editable changes and collaborator badges keep core rendering", () => {
  const h = harness();
  h.view.editable = false;
  h.update();
  h.view.editable = true;
  h.badge.childElementCount = 1;
  h.update();
  assert.equal(h.originalCalls, 2);
});

test("older Foundry generations are not patched", () => {
  const h = harness(13);
  h.update();
  assert.equal(h.originalCalls, 1);
});
