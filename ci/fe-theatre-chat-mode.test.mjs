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
  const restore = vm.runInNewContext(`${helper}\n_fetRestoreVanillaChatMode`, context);
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
