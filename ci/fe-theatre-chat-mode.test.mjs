import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../scripts/fe-theatre.js", import.meta.url), "utf8");
const helper = source.match(/^async function _fetRestoreVanillaChatMode\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(helper, "stage chat-mode restoration helper exists");

function run({ enabled = false, configured = false, mode = "ic", speaker = {} } = {}) {
  const writes = [];
  const warnings = [];
  const context = {
    _fetEnabled: enabled,
    _FET_MODULE: "female_edition",
    ChatMessage: { getSpeaker: () => speaker },
    game: {
      settings: {
        get: (namespace, key) => {
          if (namespace === "core" && key === "messageMode") return mode;
          if (namespace === "female_edition" && key === "stageEnabled") return configured;
          assert.fail(`Unexpected setting ${namespace}.${key}`);
        },
        set: async (namespace, key, value) => { writes.push([namespace, key, value]); },
      },
    },
    console: { warn: (...args) => warnings.push(args) },
  };
  const setMode = source.match(/^async function _fetSetChatMode\(mode\) \{[\s\S]*?^\}/m)?.[0];
  const restore = vm.runInNewContext(`let _fetWritingChatMode = false;\n${setMode}\n${helper}\n_fetRestoreVanillaChatMode`, context);
  return restore().then(() => ({ writes, warnings }));
}

test("disabled stage restores public mode when core IC has no speaker", async () => {
  assert.deepEqual((await run()).writes, [["core", "messageMode", "public"]]);
});

test("disabled stage preserves IC for a selected token or assigned character", async () => {
  for (const speaker of [{ actor: "actor-id" }, { token: "token-id" }]) {
    assert.deepEqual((await run({ speaker })).writes, []);
  }
});

test("enabled stage and other core chat modes are untouched", async () => {
  assert.deepEqual((await run({ enabled: true })).writes, []);
  assert.deepEqual((await run({ configured: true })).writes, []);
  assert.deepEqual((await run({ mode: "public" })).writes, []);
  assert.deepEqual((await run({ mode: "gm" })).writes, []);
});

test("mode repair runs on stage disable and on ready for already-disabled stage", () => {
  assert.match(source, /if \(game\.ready\) void _fetRestoreVanillaChatMode\(\)/);
  assert.match(source, /Hooks\.on\("ready",[\s\S]*?void _fetRestoreVanillaChatMode\(\)/);
});

const modeHelpers = [
  source.match(/^async function _fetSetChatMode\(mode\) \{[\s\S]*?^\}/m)?.[0],
  source.match(/^function _fetSyncChatModeForToken\(\) \{[\s\S]*?^\}/m)?.[0],
].join("\n");
assert.ok(modeHelpers.includes("function _fetSyncChatModeForToken()"));

function tokenModeHarness({ generation = 14, stage = false, ready = true, mode = "public" } = {}) {
  const writes = [];
  const state = { generation, stage, ready, mode, selected: [], character: null };
  const context = vm.createContext({
    Promise,
    console: { warn: err => assert.fail(String(err)) },
    _FET_MODULE: "female_edition",
    game: {
      release: { generation },
      ready,
      settings: {
        get: (namespace, key) => {
          if (namespace === "core" && key === "messageMode") return state.mode;
          if (namespace === "female_edition" && key === "stageEnabled") return state.stage;
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
    ChatMessage: {
      getSpeaker: () => state.selected.length ? { actor: state.selected[0].actor, token: "token-id" }
        : state.character ? { actor: state.character } : {},
    },
    Hooks: {
      handlers: {},
      on(name, fn) { this.handlers[name] = fn; },
    },
  });
  vm.runInContext(`let _fetAutoIcMode = false;
let _fetWritingChatMode = false;
let _fetChatModeUpdate = Promise.resolve();
${modeHelpers}
${source.match(/^Hooks.on\("controlToken"[\s\S]*?^\}\);/m)?.[0]}`, context);
  return {
    state, writes,
    sync: async () => {
      context.Hooks.handlers.controlToken();
      await vm.runInContext("_fetChatModeUpdate", context);
    },
    setManually: value => {
      state.mode = value;
      context.Hooks.handlers.clientSettingChanged("core.messageMode");
    },
  };
}

test("selected NPC restores IC after stage disabled, then deselection restores public", async () => {
  const h = tokenModeHarness();
  h.state.selected.push({ actor: "npc-id" });
  await h.sync();
  assert.equal(h.state.mode, "ic");
  h.state.selected.pop();
  await h.sync();
  assert.equal(h.state.mode, "public");
  assert.deepEqual(h.writes, ["ic", "public"]);
});

test("assigned character keeps IC when the token is released", async () => {
  const h = tokenModeHarness();
  h.state.selected.push({ actor: "npc-id" });
  await h.sync();
  h.state.selected.pop();
  h.state.character = "character-id";
  await h.sync();
  assert.equal(h.state.mode, "ic");
});

test("explicit manual mode and non-public modes remain under user control", async () => {
  const h = tokenModeHarness();
  h.state.selected.push({ actor: "npc-id" });
  await h.sync();
  h.setManually("gm");
  h.state.selected.pop();
  await h.sync();
  assert.equal(h.state.mode, "gm");
  assert.deepEqual(h.writes, ["ic"]);
});

test("stage enabled, non-v14 clients, and incomplete boot never switch modes", async () => {
  for (const options of [{ stage: true }, { generation: 13 }, { ready: false }]) {
    const h = tokenModeHarness(options);
    h.state.selected.push({ actor: "npc-id" });
    await h.sync();
    assert.equal(h.state.mode, "public");
    assert.deepEqual(h.writes, []);
  }
});
