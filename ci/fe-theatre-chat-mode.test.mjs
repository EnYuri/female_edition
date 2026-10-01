import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/fe-theatre.js", import.meta.url), "utf8");
const extract = (name) => {
  const fn = source.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(fn, `${name} exists`);
  return fn;
};
const modeCode = [
  extract("_fetSetChatMode"),
  extract("_fetSyncChatMode"),
  extract("_fetSetSpeakingAs"),
  source.match(/^Hooks.on\("controlToken"[\s\S]*?^\}\);/m)?.[0],
].join("\n");

function harness({ generation = 14, enabled = false, ready = true, mode = "ic",
  speaker = {}, configured = enabled, speakingAs = "__none__" } = {}) {
  const writes = [];
  const state = { enabled, ready, mode, speaker, configured, selected: [] };
  const context = vm.createContext({
    Promise,
    console: { warn: err => assert.fail(String(err)) },
    _FET_MODULE: "female_edition",
    _FET_NONE: "__none__",
    _fet: { speakingAs, inserts: new Map([["stage-actor", { actorId: "stage-actor" }]]) },
    _fetEnabled: enabled,
    _fetIsUserStageInsert: () => true,
    _fetCanSpeakAs: () => true,
    _fetUpdateActiveStates: () => {},
    _fetScheduleSaveUserState: () => {},
    game: {
      release: { generation },
      ready,
      settings: {
        get: (namespace, key) => {
          if (namespace === "core" && key === "messageMode") return state.mode;
          if (namespace === "female_edition" && key === "stageEnabled") return state.configured;
          assert.fail(`Unexpected setting ${namespace}.${key}`);
        },
        set: async (namespace, key, value) => {
          assert.deepEqual([namespace, key], ["core", "messageMode"]);
          state.mode = value;
          writes.push(value);
          context.Hooks.handlers.clientSettingChanged?.("core.messageMode");
        },
      },
    },
    canvas: { tokens: { controlled: state.selected } },
    ChatMessage: { getSpeaker: () => state.speaker },
    Hooks: {
      handlers: {},
      on(name, fn) { this.handlers[name] = fn; },
    },
  });
  vm.runInContext(`let _fetManualChatMode = false;
let _fetWritingChatMode = false;
let _fetChatModeUpdate = Promise.resolve();
${modeCode}`, context);
  return {
    state, writes,
    sync: async () => {
      context.Hooks.handlers.controlToken();
      await vm.runInContext("_fetChatModeUpdate", context);
    },
    select: async value => {
      vm.runInContext("_fetSetSpeakingAs", context)(value);
      await vm.runInContext("_fetChatModeUpdate", context);
    },
    setManually: async value => {
      state.mode = value;
      context.Hooks.handlers.clientSettingChanged("core.messageMode");
      await vm.runInContext("_fetChatModeUpdate", context);
    },
  };
}

test("stage off or on with no actor repairs unusable IC, but preserves valid IC", async () => {
  for (const enabled of [false, true]) {
    const h = harness({ enabled });
    await h.sync();
    assert.deepEqual(h.writes, ["public"]);
    for (const speaker of [{ actor: "pc" }, { token: "token" }]) {
      const valid = harness({ enabled, speaker });
      await valid.sync();
      assert.deepEqual(valid.writes, []);
    }
  }
});

test("selecting none or self after stage speech repairs IC without a core speaker", async () => {
  for (const selection of ["__none__", null]) {
    const h = harness({ enabled: true, speakingAs: "stage-actor" });
    await h.select(selection);
    assert.deepEqual(h.writes, ["public"]);
  }
});

test("stage actor provides its own IC speaker; selecting none restores token speech", async () => {
  const h = harness({ enabled: true, mode: "public", speakingAs: "stage-actor",
    speaker: { actor: "npc" } });
  h.state.selected.push({ actor: "npc" });
  await h.sync();
  assert.deepEqual(h.writes, []);
  await h.select("__none__");
  assert.deepEqual(h.writes, ["ic"]);
});

test("a stale stage actor cannot strand speakerless IC", async () => {
  const h = harness({ enabled: true, speakingAs: "removed-actor" });
  await h.sync();
  assert.deepEqual(h.writes, ["public"]);
});

test("selected NPC switches public to IC, releasing the token returns to public", async () => {
  const h = harness({ mode: "public" });
  h.state.selected.push({ actor: "npc" });
  h.state.speaker = { actor: "npc", token: "token" };
  await h.sync();
  h.state.selected.pop();
  h.state.speaker = {};
  await h.sync();
  assert.deepEqual(h.writes, ["ic", "public"]);
});

test("assigned character retains IC after token release", async () => {
  const h = harness({ mode: "public" });
  h.state.selected.push({ actor: "npc" });
  h.state.speaker = { actor: "npc" };
  await h.sync();
  h.state.selected.pop();
  h.state.speaker = { actor: "pc" };
  await h.sync();
  assert.deepEqual(h.writes, ["ic"]);
});

test("self speaker does not adopt an NPC token's IC mode", async () => {
  const h = harness({ enabled: true, speakingAs: null, mode: "public",
    speaker: { actor: "npc" } });
  h.state.selected.push({ actor: "npc" });
  await h.sync();
  assert.deepEqual(h.writes, []);
});

test("manual mode choices and non-public modes are preserved", async () => {
  for (const mode of ["gm", "blind", "self"]) {
    const h = harness({ enabled: true, mode });
    await h.sync();
    assert.deepEqual(h.writes, []);
  }
  const h = harness({ mode: "public" });
  h.state.selected.push({ actor: "npc" });
  h.state.speaker = { actor: "npc" };
  await h.setManually("public");
  await h.sync();
  assert.deepEqual(h.writes, []);
  h.state.speaker = {};
  await h.setManually("ic");
  assert.deepEqual(h.writes, ["public"]);
  h.state.speaker = { actor: "npc" };
  await h.sync();
  assert.deepEqual(h.writes, ["public", "ic"]);
});

test("non-v14 clients and incomplete boot never switch modes", async () => {
  for (const options of [{ generation: 13 }, { ready: false }]) {
    const h = harness(options);
    await h.sync();
    assert.deepEqual(h.writes, []);
  }
});

test("theatre routing leaves vanilla and narrator messages alone, but styles its own speech", () => {
  const handlers = {};
  const context = vm.createContext({
    _fetEnabled: true,
    _fet: { speakingAs: "__none__", inserts: new Map([["stage-actor",
      { actorId: "stage-actor", name: "Actor", src: "actor.webp" }]]) },
    _FET_NONE: "__none__",
    _FET_MODULE: "female_edition",
    _fetNavEl: {},
    _fetExcludeSystemMessages: false,
    _fetCanSpeakAs: () => true,
    CONST: { CHAT_MESSAGE_STYLES: { IC: 1, OOC: 2 } },
    game: { user: { id: "gm", isGM: true, name: "GM" } },
    Hooks: { on: (name, fn) => { handlers[name] = fn; } },
  });
  const hooks = [
    source.match(/^Hooks.on\("chatMessage"[\s\S]*?^}\);/m)?.[0],
    source.match(/^Hooks.on\("preCreateChatMessage"[\s\S]*?^}\);/m)?.[0],
  ];
  assert.ok(hooks.every(Boolean));
  vm.runInContext(hooks.join("\n"), context);
  const data = { flags: {} };
  const updates = [];
  const message = { rolls: [], updateSource: update => updates.push(update) };
  handlers.chatMessage(null, "hello", { speaker: {} });
  handlers.preCreateChatMessage(message, data, {}, "gm");
  assert.deepEqual(updates, []);
  context._fet.speakingAs = null;
  handlers.preCreateChatMessage(message, data, {}, "gm");
  assert.equal(updates.pop().style, 2);
  context._fet.speakingAs = "stage-actor";
  handlers.preCreateChatMessage(message, { flags: { female_edition: { isNarrator: true } } }, {}, "gm");
  handlers.preCreateChatMessage(message, { flags: { female_edition: { plainAlias: true } } }, {}, "gm");
  assert.deepEqual(updates, []);
  handlers.preCreateChatMessage(message, data, {}, "gm");
  assert.equal(updates.pop().speaker.actor, "stage-actor");
  context._fetEnabled = false;
  handlers.chatMessage(null, "hello", { speaker: {} });
  handlers.preCreateChatMessage(message, data, {}, "gm");
  assert.deepEqual(updates, []);
});

test("chat mode sync runs on stage settings, speaker selection, token changes and ready", () => {
  assert.match(source, /feRegisterSetting\("stageEnabled"[\s\S]*?if \(game\.ready\) _fetSyncChatMode\(\)/);
  assert.match(source, /Hooks\.on\("ready",[\s\S]*?_fetSyncChatMode\(\)/);
  assert.match(source, /Hooks\.on\("controlToken", _fetSyncChatMode\)/);
  assert.doesNotMatch(source, /chatData\.(?:style|type) = CONST\.CHAT_MESSAGE_(?:STYLES|TYPES)\.OOC/);
});
