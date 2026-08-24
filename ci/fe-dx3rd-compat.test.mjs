import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FE_DX3RD_SYSTEM_IDS, S, feIsDx3rdSystemId } from "../scripts/fe-constants.js";
import { feMessageHasChatCardContent } from "../scripts/fe-render-state.js";
import { feApplyDoubleCrossLegacyPixiTheme, feSetRetroThemeClass } from "../scripts/fe-style.js";
import { feIsSystemCombatNoticeContent } from "../scripts/fe-util.js";

const ORIGINAL_GAME = globalThis.game;
const ORIGINAL_CANVAS = globalThis.canvas;
const ORIGINAL_PIXI = globalThis.PIXI;
const DX3RD_COMPAT_CSS = readFileSync(new URL("../styles/fe-dx3rd-compat.css", import.meta.url), "utf8");

afterEach(() => {
  if (ORIGINAL_GAME === undefined) delete globalThis.game;
  else globalThis.game = ORIGINAL_GAME;
  if (ORIGINAL_CANVAS === undefined) delete globalThis.canvas;
  else globalThis.canvas = ORIGINAL_CANVAS;
  if (ORIGINAL_PIXI === undefined) delete globalThis.PIXI;
  else globalThis.PIXI = ORIGINAL_PIXI;
});

function fakeClassList(initial = []) {
  const values = new Set(initial);
  return {
    contains: (value) => values.has(value),
    toggle(value, force) {
      if (force) values.add(value);
      else values.delete(value);
    },
  };
}

test("the DX3rd family includes the maintained fork and both upstream package IDs", () => {
  assert.deepEqual(FE_DX3RD_SYSTEM_IDS, ["dx3rd-emanim", "double-cross-3rd", "dx3rd"]);
  for (const systemId of FE_DX3RD_SYSTEM_IDS) assert.equal(feIsDx3rdSystemId(systemId), true);
  assert.equal(feIsDx3rdSystemId("dnd5e"), false);
  assert.equal(feIsDx3rdSystemId(null), false);
});

test("both modern and original DX3rd item wrappers are classified as chat cards", () => {
  assert.equal(feMessageHasChatCardContent('<div class="dx3rd-item-chat"></div>'), true);
  assert.equal(feMessageHasChatCardContent('<div class="dx3rd-item-info"></div>'), true);
  assert.equal(feMessageHasChatCardContent('<div class="dx3rd-roll"></div>'), false);
});

test("DX3rd retro dice glyphs keep a 1px print-safe outline", () => {
  const start = DX3RD_COMPAT_CSS.indexOf("/* Chat-tooltip dice number glyphs.");
  const end = DX3RD_COMPAT_CSS.indexOf("body.fe-retro-theme :is(.double-cross-3rd", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const rule = DX3RD_COMPAT_CSS.slice(start, end);
  assert.match(rule, /body\.fe-retro-theme\.fe-retro-system-dx3rd \.chat-message/);
  assert.match(rule, /\.roll:is\(\.dice, \.d4, \.d6, \.d8, \.d10, \.d12, \.d20, \.d100\)/);
  assert.match(rule, /\.dice-face/);
  assert.match(rule, /-webkit-text-stroke:\s*1px #000000 !important/);
  assert.match(rule, /paint-order:\s*stroke fill !important/);
});

test("double-cross-3rd receives the shared DX3rd retro scope marker", () => {
  globalThis.game = {
    system: { id: "double-cross-3rd" },
    user: { isGM: true },
    settings: { get: (_moduleId, key) => key === S.UI_RETRO_THEME },
  };
  const classList = fakeClassList();
  feSetRetroThemeClass({ body: { classList } });

  assert.equal(classList.contains("fe-retro-theme"), true);
  assert.equal(classList.contains("fe-retro-system-dx3rd"), true);
  assert.equal(classList.contains("fe-retro-system-dnd5e"), false);
});

test("double-cross-3rd legacy PIXI combat buttons use the retro accent without replacing system input", () => {
  let accentOverride = true;
  const listeners = {};
  const text = { text: "Body", style: { fill: 0xffffff } };
  const button = {
    children: [text],
    userData: {},
    getLocalBounds: () => ({ x: 0, y: 0, width: 96, height: 24 }),
    getChildByName(name) { return this.children.find((child) => child.name === name); },
    getChildIndex(child) { return this.children.indexOf(child); },
    addChildAt(child, index) { this.children.splice(index, 0, child); },
    setChildIndex(child, index) {
      this.children.splice(this.children.indexOf(child), 1);
      this.children.splice(index, 0, child);
    },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    on(type, handler) { listeners[type] = handler; },
  };
  class FakeGraphics {
    clear() { this.commands = []; }
    lineStyle(...args) { this.commands.push(["lineStyle", ...args]); }
    beginFill(...args) { this.commands.push(["beginFill", ...args]); }
    drawRect(...args) { this.commands.push(["drawRect", ...args]); }
    endFill() { this.commands.push(["endFill"]); }
    destroy() { this.destroyed = true; }
  }

  globalThis.game = {
    system: { id: "double-cross-3rd" },
    user: { isGM: true },
    settings: {
      get: (_moduleId, key) => {
        if (key === S.DX3RD_PIXEL_ACCENT) return "#33cc99";
        if (key === S.ACCENT_TEXT_OVERRIDE) return accentOverride;
        return true;
      },
    },
  };
  globalThis.PIXI = { Graphics: FakeGraphics };
  globalThis.canvas = {
    interface: {
      getChildByName: (name) => name === "dx3rd-combat-buttons" ? { children: [button] } : null,
    },
  };
  const classList = fakeClassList(["fe-retro-theme", "fe-retro-system-dx3rd"]);
  const doc = { body: { classList } };

  feApplyDoubleCrossLegacyPixiTheme(doc);
  const overlay = button.children[0];
  assert.equal(overlay.name, "fe-double-cross-retro-overlay");
  assert.deepEqual(overlay.commands[0], ["lineStyle", 1, 0x33cc99, 1]);
  assert.deepEqual(overlay.commands[1], ["beginFill", 0x000000, 1]);
  assert.equal(text.style.fill, 0x33cc99);
  assert.equal(typeof listeners.pointerover, "function");

  listeners.pointerover();
  assert.deepEqual(overlay.commands[0], ["lineStyle", 2, 0x33cc99, 1]);
  assert.deepEqual(overlay.commands[1], ["beginFill", 0x33cc99, 1]);
  assert.equal(text.style.fill, 0x000000);

  classList.toggle("fe-retro-theme", false);
  feApplyDoubleCrossLegacyPixiTheme(doc);
  assert.equal(button.children.includes(overlay), false);
  assert.equal(overlay.destroyed, true);
  assert.equal(text.style.fill, 0xffbb00);

  // The saved swatch is dormant when the accent override is off, matching the
  // CSS variables produced by feApplyStyleVarsFromSettings.
  accentOverride = false;
  button.userData.feDoubleCrossRetroHover = false;
  classList.toggle("fe-retro-theme", true);
  feApplyDoubleCrossLegacyPixiTheme(doc);
  assert.deepEqual(button.children[0].commands[0], ["lineStyle", 1, 0xffffff, 1]);
  assert.equal(text.style.fill, 0xffffff);
});

test("modern DX3rd combat notices keep their explicit marker classification", () => {
  globalThis.game = { system: { id: "double-cross-3rd" } };
  assert.equal(feIsSystemCombatNoticeContent('<h3 class="dx3rd-combat-msg">Round 2</h3>'), true);
  assert.equal(feIsSystemCombatNoticeContent('<h3 class="dx3rd-combat-start-msg">Combat Start</h3>'), true);
  assert.equal(feIsSystemCombatNoticeContent('<h3 class="dx3rd-combat-end-msg">Combat End</h3>'), true);
});

test("original dx3rd round and phase notices are recognized without treating ordinary rolls as notices", () => {
  const translations = {
    "DX3rd.Round": "Round",
    "DX3rd.Process": "Process",
    "DX3rd.Setup": "Setup",
    "DX3rd.Initiative": "Initiative",
    "DX3rd.Main": "Main",
    "DX3rd.Cleanup": "Cleanup",
  };
  globalThis.game = {
    system: { id: "dx3rd" },
    i18n: { localize: (key) => translations[key] ?? key },
  };

  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-roll"><h2>Round 7</h2></div>'), true);
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-roll"><h2>Main Process</h2></div>'), true);
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-roll">12DX + 4</div>'), false);
});

test("the original dx3rd notice heuristic is package-gated", () => {
  globalThis.game = {
    system: { id: "dnd5e" },
    i18n: { localize: (key) => ({ "DX3rd.Round": "Round" })[key] ?? key },
  };
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-roll"><h2>Round 7</h2></div>'), false);
});
