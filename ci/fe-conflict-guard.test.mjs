/**
 * Node unit tests for the PURE helpers of fe-conflict-guard.js.
 *
 * Run from the module root:
 *   node --test ci/fe-conflict-guard.test.mjs
 *
 * fe-conflict-guard.js is a Foundry side-effect module (it registers a `ready`
 * hook at load), so we stub the few globals it touches at module-eval time
 * BEFORE importing it. The helpers themselves only read globals when called.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── global stubs (must exist before the dynamic import below) ─────────────────

// Minimal, correct-enough semver "is a newer than b" — mirrors foundry.utils.
function isNewerVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false; // equal → not newer
}

const hooksEvents = {};
globalThis.Hooks = {
  events: hooksEvents,
  once() {}, // swallow the module's ready registration
  on() {},
  off(hookName, fnOrId) {
    // Mirror Foundry: accept either a numeric id or the function itself, and
    // operate on whichever registry is live (events or the _hooks fallback).
    const store = globalThis.Hooks.events ?? globalThis.Hooks._hooks;
    const arr = store?.[hookName];
    if (!Array.isArray(arr)) return;
    const i = typeof fnOrId === "number"
      ? arr.findIndex((e) => e.id === fnOrId)
      : arr.findIndex((e) => e.fn === fnOrId || e === fnOrId);
    if (i >= 0) arr.splice(i, 1);
  },
};
globalThis.game = {
  release: { generation: 14 },
  version: "14.363",
  modules: { get: () => null },
  settings: {
    settings: new Map(),
    _values: new Map(),
    get(namespace, key) { return this._values.get(`${namespace}.${key}`); },
  },
  user: { isGM: true },
};
globalThis.ui = { notifications: { warn() {} } };
globalThis.foundry = { utils: { isNewerVersion } };

const G = await import("../scripts/fe-conflict-guard.js");
const C = await import("../scripts/fe-conflict-state.js");

function setSetting(namespace, key, value) {
  const fullKey = `${namespace}.${key}`;
  game.settings.settings.set(fullKey, {});
  game.settings._values.set(fullKey, value);
}

function resetSettings() {
  game.settings.settings.clear();
  game.settings._values.clear();
  C.feClearConflictFeatureSuppressions();
}

// ── feCgGenOf ─────────────────────────────────────────────────────────────

test("feCgGenOf parses the generation integer", () => {
  assert.equal(G.feCgGenOf(null), null);
  assert.equal(G.feCgGenOf(undefined), null);
  assert.equal(G.feCgGenOf(13), 13);
  assert.equal(G.feCgGenOf("13"), 13);
  assert.equal(G.feCgGenOf("14.999"), 14);
  assert.equal(G.feCgGenOf("9"), 9);
});

// ── feCgDeclaresForwardCompat (core is stubbed to gen 14) ───────────────────

test("feCgDeclaresForwardCompat: only true when maximum > core gen", () => {
  assert.equal(G.feCgDeclaresForwardCompat({ compatibility: { maximum: "15" } }), true);
  assert.equal(G.feCgDeclaresForwardCompat({ compatibility: { maximum: "14.999" } }), false); // gen 14 == core
  assert.equal(G.feCgDeclaresForwardCompat({ compatibility: { maximum: "13" } }), false);
  assert.equal(G.feCgDeclaresForwardCompat({ compatibility: {} }), false); // no maximum
  assert.equal(G.feCgDeclaresForwardCompat({}), false);
});

// ── feCgIsNewerThanVerified ─────────────────────────────────────────────────

test("feCgIsNewerThanVerified: installed newer than spec version → true", () => {
  assert.equal(G.feCgIsNewerThanVerified({ version: "3.3.0" }, "3.3.0"), false); // equal
  assert.equal(G.feCgIsNewerThanVerified({ version: "3.4.0" }, "3.3.0"), true);
  assert.equal(G.feCgIsNewerThanVerified({ version: "3.3.1" }, "3.3.0"), true);
  assert.equal(G.feCgIsNewerThanVerified({ version: "3.2.0" }, "3.3.0"), false); // older
  assert.equal(G.feCgIsNewerThanVerified({ version: "v3.3.0" }, "3.3.0"), false); // 'v' stripped
  assert.equal(G.feCgIsNewerThanVerified({ version: "3.4.0" }, null), false);     // no pin → never blocks
});

// ── feCgStripHooks (the safety-critical matcher) ────────────────────────────

function resetHooks() {
  for (const k of Object.keys(hooksEvents)) delete hooksEvents[k];
}

test("feCgStripHooks removes marker-matching handlers but PROTECTS self-guard", () => {
  resetHooks();
  function origHandler() { const x = "Theatre.instance"; return x; }            // matches
  function ourHandler() { const x = "Theatre.instance", y = "female_edition"; return x + y; } // matches but self-guarded
  function unrelated() { return "nothing here"; }
  hooksEvents.preCreateChatMessage = [
    { hook: "preCreateChatMessage", id: 1, fn: origHandler },
    { hook: "preCreateChatMessage", id: 2, fn: ourHandler },
    { hook: "preCreateChatMessage", id: 3, fn: unrelated },
  ];
  const removed = G.feCgStripHooks(["Theatre.instance"]);
  assert.equal(removed.preCreateChatMessage, 1, "only the original handler removed");
  assert.deepEqual(
    hooksEvents.preCreateChatMessage.map((e) => e.id),
    [2, 3],
    "self-guarded + unrelated handlers survive"
  );
});

test("feCgStripHooks matches BOUND handlers by fn.name", () => {
  resetHooks();
  // bound functions report '[native code]' source but fn.name === 'bound <name>'
  function _chatMessage() {}
  const bound = _chatMessage.bind(null);
  hooksEvents.chatMessage = [
    { hook: "chatMessage", id: 10, fn: bound },
    { hook: "chatMessage", id: 11, fn: function unrelated() {} },
  ];
  const removed = G.feCgStripHooks(["bound _chatMessage"]);
  assert.equal(removed.chatMessage, 1);
  assert.deepEqual(hooksEvents.chatMessage.map((e) => e.id), [11]);
});

test("feCgStripHooks: no marker match → nothing removed", () => {
  resetHooks();
  hooksEvents.renderChatLog = [{ hook: "renderChatLog", id: 20, fn: function x() { return "core"; } }];
  const removed = G.feCgStripHooks(["NoSuchMarker"]);
  assert.deepEqual(removed, {});
  assert.equal(hooksEvents.renderChatLog.length, 1);
});

test("feCgStripHooks does not report success when Hooks.off is a no-op", () => {
  resetHooks();
  const savedOff = Hooks.off;
  try {
    hooksEvents.h = [{ hook: "h", id: 21, fn: function original() { return "Theatre.instance"; } }];
    Hooks.off = () => {};
    assert.deepEqual(G.feCgStripHooks(["Theatre.instance"]), {});
    assert.equal(hooksEvents.h.length, 1);
  } finally {
    Hooks.off = savedOff;
  }
});

// ── v13/older-build hardening fallbacks ──────────────────────────────────────

test("feCgStripHooks: entry without id → off-by-function fallback", () => {
  resetHooks();
  function origHandler() { return "Theatre.instance"; }
  hooksEvents.someHook = [{ hook: "someHook", fn: origHandler }]; // no id field
  const removed = G.feCgStripHooks(["Theatre.instance"]);
  assert.equal(removed.someHook, 1);
  assert.equal(hooksEvents.someHook.length, 0);
});

test("feCgStripHooks: bare-function entry (legacy registry shape)", () => {
  resetHooks();
  function origHandler() { return "Theatre.instance"; }
  hooksEvents.legacyHook = [origHandler]; // entry IS the function
  const removed = G.feCgStripHooks(["Theatre.instance"]);
  assert.equal(removed.legacyHook, 1);
  assert.equal(hooksEvents.legacyHook.length, 0);
});

test("feCgStripHooks: falls back to Hooks._hooks when .events is absent", () => {
  const saved = globalThis.Hooks.events;
  try {
    delete globalThis.Hooks.events; // simulate a build that lacks the events getter
    globalThis.Hooks._hooks = {
      h: [{ hook: "h", id: 99, fn: function origX() { return "Theatre.instance"; } }],
    };
    const removed = G.feCgStripHooks(["Theatre.instance"]);
    assert.equal(removed.h, 1);
    assert.equal(globalThis.Hooks._hooks.h.length, 0);
  } finally {
    globalThis.Hooks.events = saved;
    delete globalThis.Hooks._hooks;
  }
});

// ── curated conflict list sanity ─────────────────────────────────────────────

test("FE_CG_CONFLICTS: every neutralize spec is version-pinned", () => {
  for (const c of G.FE_CG_CONFLICTS) {
    if (c.neutralize) {
      assert.ok(c.neutralize.verifiedVersion, `${c.id} neutralize spec must pin verifiedVersion`);
      assert.ok(Array.isArray(c.neutralize.markers) && c.neutralize.markers.length, `${c.id} needs markers`);
    }
  }
});

test("FE_CG_SELF_GUARD contains the female_edition markers", () => {
  assert.ok(G.FE_CG_SELF_GUARD.includes("female_edition"));
  assert.ok(G.FE_CG_SELF_GUARD.includes("_FET_"));
});

// ── feature-level conflict assessment ──────────────────────────────────────

test("conflict assessment ignores an active original when our feature is off", () => {
  resetSettings();
  setSetting("female_edition", "narratorEnabled", false);
  const hit = {
    id: "narrator-tools",
    mod: { active: true, version: "1.0.1", compatibility: {} },
    own: { features: [C.FE_CONFLICT_FEATURE.NARRATOR], settings: ["narratorEnabled"] },
    neutralize: { verifiedVersion: "1.0.1" },
  };
  assert.equal(G.feCgAssessConflict(hit).action, "none");
});

test("conflict assessment reads the original module's feature toggle", () => {
  resetSettings();
  setSetting("female_edition", "ihEnabled", true);
  setSetting("image-hover", "userEnableModule", false);
  const hit = {
    id: "image-hover",
    mod: { active: true, version: "3.1", compatibility: {} },
    own: { features: [C.FE_CONFLICT_FEATURE.IMAGE_HOVER], settings: ["ihEnabled"] },
    externalSetting: "userEnableModule",
    neutralize: { verifiedVersion: "3.1" },
  };
  assert.equal(G.feCgAssessConflict(hit).action, "none");
});

test("maintained full replacement yields our feature instead of stripping it", () => {
  resetSettings();
  setSetting("female_edition", "narratorEnabled", true);
  const hit = {
    id: "narrator-tools",
    mod: { active: true, version: "2.0.5", compatibility: {} },
    own: { features: [C.FE_CONFLICT_FEATURE.NARRATOR], settings: ["narratorEnabled"] },
    neutralize: { verifiedVersion: "1.0.1" },
    yieldWhenMaintained: true,
  };
  assert.equal(G.feCgAssessConflict(hit).action, "yield");
});

test("verified abandoned target is neutralized only when both features are on", () => {
  resetSettings();
  setSetting("female_edition", "narratorEnabled", true);
  const hit = {
    id: "narrator-tools",
    mod: { active: true, version: "1.0.1", compatibility: {} },
    own: { features: [C.FE_CONFLICT_FEATURE.NARRATOR], settings: ["narratorEnabled"] },
    neutralize: { verifiedVersion: "1.0.1" },
  };
  assert.equal(G.feCgAssessConflict(hit).action, "neutralize");
});

test("unknown external feature setting never authorizes neutralization", () => {
  resetSettings();
  setSetting("female_edition", "ihEnabled", true);
  const hit = {
    id: "image-hover",
    mod: { active: true, version: "3.1", compatibility: {} },
    own: { features: [C.FE_CONFLICT_FEATURE.IMAGE_HOVER], settings: ["ihEnabled"] },
    externalSetting: "userEnableModule",
    neutralize: { verifiedVersion: "3.1" },
  };
  assert.equal(G.feCgAssessConflict(hit).action, "unknown");
});

// ── Force Client Settings namespace-scoped neutralization ──────────────────

test("FCS neutralization removes only female_edition runtime entries", async () => {
  const savedGet = game.modules.get;
  const calls = [];
  try {
    game.modules.get = (id) => id === "force-client-settings" ? { active: true } : null;
    const runtime = {
      forced: new Map([
        ["female_edition.ceMergeEnabled", { mode: "hard" }],
        ["other-module.enabled", { mode: "hard" }],
      ]),
      unlocked: new Map([
        ["female_edition.ceMergeEnabled", true],
        ["other-module.enabled", true],
      ]),
      restricted: new Map([
        ["female_edition.internalMenu", { mode: "restricted" }],
        ["other-module.menu", { mode: "restricted" }],
      ]),
      async forceSetting(key, mode) { calls.push(["force", key, mode]); return true; },
      async restrictSetting(key) { calls.push(["restrict", key]); return true; },
    };

    const result = G.feCgNeutralizeForceClientSettings(runtime);
    assert.equal(result.success, true);
    assert.equal(runtime.forced.has("female_edition.ceMergeEnabled"), false);
    assert.equal(runtime.unlocked.has("female_edition.ceMergeEnabled"), false);
    assert.equal(runtime.restricted.has("female_edition.internalMenu"), false);
    assert.equal(runtime.forced.has("other-module.enabled"), true);
    assert.equal(runtime.unlocked.has("other-module.enabled"), true);
    assert.equal(runtime.restricted.has("other-module.menu"), true);

    assert.equal(await runtime.forceSetting("female_edition.ceMergeEnabled", "hard"), false);
    assert.equal(await runtime.restrictSetting("female_edition.internalMenu"), false);
    assert.deepEqual(calls, [], "our namespace never reaches FCS mutators");

    assert.equal(await runtime.forceSetting("other-module.enabled", "hard"), true);
    assert.equal(await runtime.restrictSetting("other-module.menu"), true);
    assert.deepEqual(calls, [
      ["force", "other-module.enabled", "hard"],
      ["restrict", "other-module.menu"],
    ]);
  } finally {
    game.modules.get = savedGet;
  }
});

test("FCS neutralization reports an inaccessible runtime instead of claiming success", () => {
  const savedGet = game.modules.get;
  try {
    game.modules.get = (id) => id === "force-client-settings" ? { active: true } : null;
    const result = G.feCgNeutralizeForceClientSettings(null);
    assert.equal(result.active, true);
    assert.equal(result.success, false);
    assert.match(result.reason, /접근할 수 없음/);
  } finally {
    game.modules.get = savedGet;
  }
});
