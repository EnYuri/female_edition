import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const narratorSource = readFileSync(new URL("../scripts/fe-narrator.js", import.meta.url), "utf8");
const chatSource = readFileSync(new URL("../scripts/fe-chat-enhance.js", import.meta.url), "utf8");
const extract = (source, name) => {
  const fn = source.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(fn, `${name} exists`);
  return fn;
};

function cgmpHarness({ enabled = true, narratorTools = false, bareHooks = false, guardMode = "auto" } = {}) {
  const handled = [];
  const ChatResolver = {
    _parseChatMessage: () => {},
    _resolvePCToken: () => handled.push("cgmp-precreate"),
    CHAT_MESSAGE_SUB_TYPES: { DESC: 1 },
  };
  const entries = { chatMessage: [], preCreateChatMessage: [] };
  let nextId = 0;
  const Hooks = {
    events: entries,
    on(name, fn) {
      entries[name].push(bareHooks ? fn : { id: ++nextId, fn });
      return nextId;
    },
    off(name, id) {
      const i = entries[name].findIndex(entry => entry.id === id);
      if (i >= 0) entries[name].splice(i, 1);
    },
    call(name, ...args) {
      for (const entry of [...entries[name]]) {
        if ((bareHooks ? entry : entry.fn)(...args) === false) return false;
      }
      return true;
    },
  };
  function onChatMessage(_log, message) {
    ChatResolver._parseChatMessage(message);
    if (ChatResolver.CHAT_MESSAGE_SUB_TYPES.DESC && /^\/(?:desc|as|ooc)\b/i.test(message)) {
      handled.push("cgmp");
      return false;
    }
    return true;
  }
  function onPreCreateChatMessage(message) {
    ChatResolver._resolvePCToken(message);
  }
  Hooks.on("chatMessage", onChatMessage);
  Hooks.on("preCreateChatMessage", onPreCreateChatMessage);

  const context = vm.createContext({
    Hooks, console: { warn: text => assert.fail(text) },
    _fnEnabled: enabled,
    _fnCgmpOrdered: false,
    _fnCgmpSpeakersProtected: false,
    feCgMode: () => guardMode,
    _fnPermAs: 4, _fnPermDescribe: 4, _fnPermNarrate: 4,
    _fn: { character: "" },
    _FN_MODULE: "female_edition",
    _fnCreateMessage: (kind, body) => handled.push([kind, body]),
    game: {
      user: { role: 4 },
      modules: new Map([
        ["CautiousGamemastersPack", { active: true }],
        ["narrator-tools", { active: narratorTools }],
      ]),
    },
    CONFIG: { ui: { chat: { CHAT_COMMANDS: narratorTools ? { "narrator-description": {} } : {} } } },
    document: { getElementById: () => null },
  });
  vm.runInContext([
    extract(narratorSource, "_fnOnChatMessage"),
    extract(narratorSource, "_fnProtectCgmpSpeakers"),
    extract(narratorSource, "_fnOrderChatCommandsWithCgmp"),
    'Hooks.on("chatMessage", _fnOnChatMessage);',
    "_fnProtectCgmpSpeakers();",
    "_fnOrderChatCommandsWithCgmp();",
  ].join("\n"), context);
  return {
    Hooks, handled,
    enable() {
      context._fnEnabled = true;
      vm.runInContext("_fnOrderChatCommandsWithCgmp()", context);
    },
  };
}

test("our /desc and /as win before CGMP, while CGMP /ooc remains available", () => {
  const h = cgmpHarness();
  assert.equal(h.Hooks.call("chatMessage", {}, "/desc test", {}), false);
  assert.deepEqual(h.handled, [["description", "test"]]);
  assert.equal(h.Hooks.call("chatMessage", {}, "<p>/desc formatted</p>", {}), false);
  assert.deepEqual(h.handled, [["description", "test"], ["description", "formatted"]]);
  assert.equal(h.Hooks.call("chatMessage", {}, "/as Example", {}), false);
  assert.deepEqual(h.handled, [["description", "test"], ["description", "formatted"]]);
  assert.equal(h.Hooks.call("chatMessage", {}, "/ooc test", {}), false);
  assert.deepEqual(h.handled, [["description", "test"], ["description", "formatted"], "cgmp"]);
  h.Hooks.call("preCreateChatMessage", { flags: { female_edition: { isNarrator: true } } });
  h.Hooks.call("preCreateChatMessage", { flags: { female_edition: { plainAlias: true } } });
  h.Hooks.call("preCreateChatMessage", { flags: {} });
  assert.equal(h.handled.filter(value => value === "cgmp-precreate").length, 1);
});

test("when our narrator yields to narrator-tools, CGMP does not eat its /desc", () => {
  const h = cgmpHarness({ enabled: false, narratorTools: true });
  assert.equal(h.Hooks.call("chatMessage", {}, "<p>/desc test</p>", {}), true);
  assert.deepEqual(h.handled, []);
});

test("without either narrator, CGMP keeps /desc", () => {
  const h = cgmpHarness({ enabled: false });
  assert.equal(h.Hooks.call("chatMessage", {}, "/desc test", {}), false);
  assert.deepEqual(h.handled, ["cgmp"]);
  h.Hooks.call("preCreateChatMessage", { flags: { female_edition: { stageId: "actor" } } });
  assert.deepEqual(h.handled, ["cgmp"]);
});

test("guard warn, yield and off do not override CGMP hooks", () => {
  for (const guardMode of ["warn", "yield", "off"]) {
    const h = cgmpHarness({ guardMode });
    assert.equal(h.Hooks.call("chatMessage", {}, "/desc test", {}), false);
    assert.deepEqual(h.handled, ["cgmp"]);
    h.Hooks.call("preCreateChatMessage", { flags: { female_edition: { isNarrator: true } } });
    assert.deepEqual(h.handled, ["cgmp", "cgmp-precreate"]);
  }
});

test("enabling narrator after setup yields CGMP /desc without wrapping it twice", () => {
  const h = cgmpHarness({ enabled: false });
  h.enable();
  h.enable();
  assert.equal(h.Hooks.call("chatMessage", {}, "/desc later", {}), false);
  assert.equal(h.Hooks.call("chatMessage", {}, "/ooc later", {}), false);
  h.Hooks.call("preCreateChatMessage", { flags: {} });
  assert.deepEqual(h.handled, [["description", "later"], "cgmp", "cgmp-precreate"]);
  assert.match(narratorSource, /feRegisterSetting\("narratorEnabled"[\s\S]*?else _fnOrderChatCommandsWithCgmp\(\)/);
});

test("v13 bare-function hook entries keep the same command ownership", () => {
  const h = cgmpHarness({ bareHooks: true });
  assert.equal(h.Hooks.call("chatMessage", {}, "/desc test", {}), false);
  assert.deepEqual(h.handled, [["description", "test"]]);
  h.Hooks.call("preCreateChatMessage", { flags: { female_edition: { isNarrator: true } } });
  assert.deepEqual(h.handled, [["description", "test"]]);
});

test("GM speak-as-self detects the selected token actor and excludes staged and system cards", () => {
  const context = vm.createContext({
    S: { GM_SPEAK_AS_SELF: "ceGmSpeakAsSelf" },
    MODULE_ID: "female_edition",
    feSetting: () => true,
    document: { querySelector: () => ({ value: "__none__" }) },
    game: {
      user: { id: "gm", isGM: true, name: "GM" },
      actors: new Map([["pc", { hasPlayerOwner: false }]]),
      scenes: new Map([["scene", { tokens: new Map([["token", { actor: { hasPlayerOwner: true } }]]) }]]),
    },
  });
  const apply = vm.runInContext(`${extract(chatSource, "feApplyGmSpeakAsSelf")}\nfeApplyGmSpeakAsSelf`, context);
  const create = () => ({
    speaker: { scene: "scene", actor: "pc", token: "token", alias: "PC" },
    rolls: [],
    updateSource(change) { Object.assign(this, change); },
  });
  const msg = create();
  apply(msg, { speaker: msg.speaker, flags: {} }, "gm");
  assert.equal(msg.speaker.alias, "GM");
  assert.equal(msg.speaker.actor, null);

  for (const flags of [
    { "midi-qol": { enabled: true } },
    { female_edition: { stageId: "stage-actor" } },
    { female_edition: { isNarrator: true } },
    { female_edition: { plainAlias: true } },
  ]) {
    const excluded = create();
    apply(excluded, { speaker: excluded.speaker, flags }, "gm");
    assert.equal(excluded.speaker.alias, "PC");
  }
  const roll = create();
  apply(roll, { speaker: roll.speaker, rolls: [{}], flags: {} }, "gm");
  assert.equal(roll.speaker.alias, "PC");

  const overwritten = create();
  apply(overwritten, { speaker: overwritten.speaker, flags: {} }, "gm");
  overwritten.speaker = { actor: "pc", alias: "PC" };
  context.game.actors.set("pc", { hasPlayerOwner: true });
  apply(overwritten, { flags: {} }, "gm");
  assert.equal(overwritten.speaker.alias, "GM");
  assert.match(chatSource, /Hooks\.once\("setup",[\s\S]*?queueMicrotask\([\s\S]*?feApplyGmSpeakAsSelf\(message, data, userId\)/);
});
