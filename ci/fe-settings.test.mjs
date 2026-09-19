import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  S, CP, FE_DEFAULTS, FE_MENU_DEFAULTS, FE_MENU_RANGES,
  FE_SETTING_DEFINITIONS, FE_RELOAD_REQUIRED_KEYS, feRegisterSetting,
} from "../scripts/fe-settings-data.js";
import * as constants from "../scripts/fe-constants.js";
import {
  CI_DEFAULT_MAX_UPLOAD_MB, CI_MIN_MAX_UPLOAD_MB, CI_MAX_MAX_UPLOAD_MB,
} from "../scripts/fe-chat-image-upload.js";

test("settings entry and its transitive imports exist and have no circular dependency", () => {
  const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8"));
  assert.ok(manifest.esmodules.includes("scripts/fe-settings.js"));
  assert.ok(!manifest.esmodules.includes("scripts/fe-settings-menu.js"));
  for (const path of manifest.esmodules) readFileSync(new URL(`../${path}`, import.meta.url));
  const visited = new Set();
  function visit(url, stack = []) {
    assert.ok(!stack.includes(url.href), `circular import: ${[...stack, url.href].join(" → ")}`);
    if (visited.has(url.href)) return;
    const source = readFileSync(url, "utf8");
    for (const [, relative] of source.matchAll(/(?:import|export)\s[^;]*?\bfrom\s*["'](\.[^"']+)["']/g)) {
      visit(new URL(relative, url), [...stack, url.href]);
    }
    visited.add(url.href);
  }
  visit(new URL("../scripts/fe-settings.js", import.meta.url));
});

test("every setting key and menu reset value has a central registration definition", () => {
  assert.equal(Object.keys(FE_SETTING_DEFINITIONS).length, 172);
  assert.deepEqual(Object.keys(FE_DEFAULTS).sort(), Object.keys(FE_SETTING_DEFINITIONS).sort());
  for (const key of [...Object.values(S), ...Object.values(CP), ...FE_RELOAD_REQUIRED_KEYS]) {
    assert.ok(FE_SETTING_DEFINITIONS[key], key);
  }
  for (const [key, value] of Object.entries(FE_MENU_DEFAULTS)) {
    assert.ok(FE_SETTING_DEFINITIONS[key], key);
    assert.deepEqual(value, FE_DEFAULTS[key], key);
  }
  assert.equal(FE_DEFAULTS[S.CHAT_CARD_ICON_CROP], true);
  assert.equal(FE_MENU_DEFAULTS[S.CHAT_CARD_ICON_CROP], true);
  assert.equal(FE_SETTING_DEFINITIONS[S.CHAT_CARD_ICON_CROP].scope, "client");
  assert.ok(!constants.FE_GM_PRIORITY_EXCLUDED_KEYS.has(S.CHAT_CARD_ICON_CROP));
  for (const key of ["feGmPriorityOverrides", "feGmPriorityBackup", "feWorldSettings", "narratorState", "ceMusicAutoInitDone"]) {
    assert.equal(Object.hasOwn(FE_MENU_DEFAULTS, key), false, key);
  }
});

test("centralized settings window registers synchronously and supplies shared defaults and ranges", async () => {
  const previousGame = globalThis.game;
  const previousFoundry = globalThis.foundry;
  const previousHooks = globalThis.Hooks;
  const previousUi = globalThis.ui;
  const previousFDE = globalThis.FormDataExtended;
  const hooks = [];
  globalThis.Hooks = { once: (name, callback) => hooks.push({ name, callback }) };
  let registered;
  globalThis.game = {
    user: { isGM: true }, system: { id: "dnd5e" },
    modules: { get: () => null },
    settings: { registerMenu: (namespace, key, options) => { registered = { namespace, key, options }; } },
  };
  globalThis.foundry = { applications: { api: {
    ApplicationV2: class { async _prepareContext() { return {}; } },
    HandlebarsApplicationMixin: base => base,
  } } };
  try {
    const { feRegisterSettingsMenu } = await import("../scripts/fe-settings.js");
    const initHooks = hooks.filter(hook => hook.name === "init");
    assert.equal(initHooks.length, 1);
    initHooks[0].callback();
    assert.equal(registered.key, "settingsMenu");
    assert.equal(typeof registered.options.type, "function");
    const Menu = feRegisterSettingsMenu({
      MODULE_ID: "female_edition", feIsDx3rdSystemId: () => false,
      feSetting: () => undefined, feCaptureWorldSettings: async () => {},
      feRegisterModuleFolderFonts: async () => [], feQueryLocalFonts: async () => [],
      feLocalFontsSupported: () => false, feListCorePriorityKeys: () => [],
    });
    assert.equal(registered.namespace, "female_edition");
    assert.equal(registered.key, "settingsMenu");
    assert.equal(registered.options.type, Menu);
    assert.equal(registered.options.restricted, false);
    assert.equal(Menu.PARTS.body.template, "modules/female_edition/templates/fe-settings-menu.hbs");
    const context = await new Menu()._prepareContext();
    assert.equal(context.values.chatImagesMaxUploadMB, 20);
    assert.equal(context.values[S.MUSIC_MAX_MB], 27);
    assert.equal(context.ranges, FE_MENU_RANGES);
    assert.equal(context.isDnd5e, true);
    assert.equal(context.isGM, true);

    // Exercise the public save action with v13's global FormDataExtended fallback.
    // Keep saved values different from defaults to detect accidental reset on open/save.
    const stored = new Map();
    const writes = [];
    globalThis.game.settings.settings = new Map();
    globalThis.game.settings.register = (namespace, key, options) => {
      const id = `${namespace}.${key}`;
      assert.equal(globalThis.game.settings.settings.has(id), false, id);
      globalThis.game.settings.settings.set(id, options);
      stored.set(key, structuredClone(options.default));
    };
    for (const key of Object.keys(FE_SETTING_DEFINITIONS)) feRegisterSetting(key);
    stored.set(CP.SIZE, 96);
    stored.set(S.MUSIC_MAX_MB, 25);
    globalThis.game.settings.get = (_namespace, key) => stored.get(key);
    globalThis.game.settings.set = async (namespace, key, value) => {
      assert.equal(namespace, "female_edition");
      assert.ok(FE_SETTING_DEFINITIONS[key], key);
      assert.ok(game.user.isGM || FE_SETTING_DEFINITIONS[key].scope === "client", key);
      writes.push(key);
      stored.set(key, value);
    };
    globalThis.ui = { notifications: { info() {}, warn(message) { assert.fail(message); } } };
    globalThis.foundry.utils = { expandObject: object => object };
    globalThis.foundry.applications.settings = { SettingsConfig: { reloadConfirm: async () => {} } };
    let captures = 0;
    const SaveMenu = feRegisterSettingsMenu({
      MODULE_ID: "female_edition", feIsDx3rdSystemId: id => id === "dx3rd-emanim",
      feSetting: key => stored.get(key), feCaptureWorldSettings: async () => { captures++; },
      feRegisterModuleFolderFonts: async () => [], feQueryLocalFonts: async () => [],
      feLocalFontsSupported: () => false, feListCorePriorityKeys: () => [],
    });
    const menu = new SaveMenu();
    const prepared = await menu._prepareContext();
    assert.equal(prepared.values[CP.SIZE], 96);
    assert.equal(prepared.values[S.MUSIC_MAX_MB], 25);
    const template = readFileSync(new URL("../templates/fe-settings-menu.hbs", import.meta.url), "utf8");
    const inputNames = [...template.matchAll(/\bname="([^"]+)"/g)].map(match => match[1]);
    for (const key of inputNames.filter(key => !key.includes("{{"))) {
      assert.ok(FE_SETTING_DEFINITIONS[key], `template registration: ${key}`);
      assert.ok(Object.hasOwn(prepared.values, key), `template context: ${key}`);
    }
    for (const [, key, field] of template.matchAll(/{{ranges\.([^.}]+)\.([^}]+)}}/g)) {
      assert.equal(typeof FE_MENU_RANGES[key]?.[field], "number", `template range: ${key}.${field}`);
    }
    globalThis.FormDataExtended = class { constructor() { this.object = prepared.values; } };
    menu.element = { querySelector: () => ({}) };
    menu.close = async () => {};
    await SaveMenu.DEFAULT_OPTIONS.actions.feSave.call(menu, { preventDefault() {} });
    assert.equal(captures, 1);
    assert.equal(stored.get(CP.SIZE), 96);
    assert.equal(stored.get(S.MUSIC_MAX_MB), 25);
    game.system.id = "dx3rd-emanim";
    await SaveMenu.DEFAULT_OPTIONS.actions.feSave.call(menu, { preventDefault() {} });
    assert.equal(captures, 2);
    for (const key of inputNames.filter(key => !key.includes("{{"))) {
      assert.ok(writes.includes(key), `template save: ${key}`);
    }

    // Non-GMs must never write world settings; missing system settings are skipped.
    game.user.isGM = false;
    for (const [id, options] of game.settings.settings) {
      if (options.scope === "world") game.settings.settings.delete(id);
    }
    writes.length = 0;
    await SaveMenu.DEFAULT_OPTIONS.actions.feSave.call(menu, { preventDefault() {} });
    assert.equal(captures, 3);
    assert.ok(writes.length > 0);
    assert.ok(writes.every(key => FE_SETTING_DEFINITIONS[key].scope === "client"));
  } finally {
    globalThis.game = previousGame;
    globalThis.foundry = previousFoundry;
    globalThis.Hooks = previousHooks;
    globalThis.ui = previousUi;
    globalThis.FormDataExtended = previousFDE;
  }
});

test("legacy imports, transport and reset share the intended 20MB image and 27MB music defaults", () => {
  assert.equal(constants.S, S);
  assert.equal(constants.FE_DEFAULTS, FE_DEFAULTS);
  assert.equal(FE_DEFAULTS.chatImagesMaxUploadMB, 20);
  assert.equal(FE_MENU_DEFAULTS.chatImagesMaxUploadMB, 20);
  assert.equal(CI_DEFAULT_MAX_UPLOAD_MB, 20);
  assert.equal(CI_MIN_MAX_UPLOAD_MB, FE_MENU_RANGES.chatImagesMaxUploadMB.min);
  assert.equal(CI_MAX_MAX_UPLOAD_MB, FE_MENU_RANGES.chatImagesMaxUploadMB.max);
  assert.equal(FE_DEFAULTS[S.MUSIC_MAX_MB], 27);
  assert.equal(FE_MENU_DEFAULTS[S.MUSIC_MAX_MB], 27);
});

test("registration retains callbacks and isolates mutable defaults, ranges and choices", () => {
  const previousGame = globalThis.game;
  const calls = [];
  globalThis.game = { settings: { register: (...args) => { calls.push(args); return args[2]; } } };
  try {
    const onChange = () => {};
    const portrait = feRegisterSetting(CP.SIZE, onChange);
    assert.equal(portrait.type, Number);
    assert.equal(portrait.onChange, onChange);
    assert.equal(portrait.scope, "client");
    assert.equal(portrait.default, 64);
    portrait.range.min = -100;
    assert.equal(feRegisterSetting(CP.SIZE).range.min, 16);
    const mode = feRegisterSetting(S.MERGE_MODE);
    mode.choices.standard = "changed";
    assert.notEqual(feRegisterSetting(S.MERGE_MODE).choices.standard, "changed");
    const state = feRegisterSetting("narratorState");
    assert.equal(Object.hasOwn(state, "type"), false);
    state.default.narration.display = true;
    assert.equal(feRegisterSetting("narratorState").default.narration.display, false);
    assert.ok(calls.every(([namespace]) => namespace === "female_edition"));
    assert.throws(() => feRegisterSetting("missing"), /Unknown/);
  } finally {
    globalThis.game = previousGame;
  }
});
