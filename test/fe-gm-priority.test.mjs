/**
 * Node unit tests for the PURE read helpers of fe-gm-priority.js.
 *
 * Run from the module root:
 *   node --test test/fe-gm-priority.test.mjs
 *
 * These helpers read `game.settings` lazily at call time (never at import), so
 * we drive them by swapping a minimal `globalThis.game` stub per test. Only the
 * pure classification/read path is covered here — the async write/sync/restore
 * paths (feSetGmPriorityOverrides, feSyncLocalGmPrioritySettings, …) mutate
 * game.settings and belong in an integration harness, not this unit file.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { S, FE_DEFAULTS } from "../scripts/fe-constants.js";
import {
  feIsGmPrioritySettingKey,
  feIsPerWorldSettingKey,
  feGetGmPriorityOverrideValue,
  feHasGmPriorityOverride,
  feIsGmPriorityEnabled,
  feSetting,
} from "../scripts/fe-gm-priority.js";

// ── game stub ─────────────────────────────────────────────────────────────────

const MODULE_ID = "female_edition";

/**
 * Build a fake `game`.
 *  - registered: { <settingKey>: { scope } } → what game.settings.settings holds
 *  - values:     { <settingKey>: value }     → what game.settings.get returns
 *    A key absent from `values` makes game.settings.get THROW, exactly like an
 *    unregistered/unreadable core setting (exercises the catch/fallback paths).
 */
function makeGame({ isGM = false, registered = {}, values = {} } = {}) {
  const settingsMap = new Map();
  for (const [key, cfg] of Object.entries(registered)) {
    settingsMap.set(`${MODULE_ID}.${key}`, cfg);
  }
  return {
    user: { isGM },
    world: { id: "test-world" },
    settings: {
      settings: settingsMap,
      get(mod, key) {
        if (mod === MODULE_ID && Object.prototype.hasOwnProperty.call(values, key)) {
          return values[key];
        }
        throw new Error(`unreadable setting ${mod}.${key}`);
      },
    },
  };
}

function withGame(cfg, fn) {
  const prev = globalThis.game;
  globalThis.game = makeGame(cfg);
  try {
    return fn();
  } finally {
    globalThis.game = prev;
  }
}

// ── feIsGmPrioritySettingKey ──────────────────────────────────────────────────

test("feIsGmPrioritySettingKey: a registered client-scope, non-excluded key is forced", () => {
  withGame({ registered: { [S.MERGE_ENABLED]: { scope: "client" } } }, () => {
    assert.equal(feIsGmPrioritySettingKey(S.MERGE_ENABLED), true);
  });
});

test("feIsGmPrioritySettingKey: a world-scope key is never forced", () => {
  withGame({ registered: { [S.MERGE_ENABLED]: { scope: "world" } } }, () => {
    assert.equal(feIsGmPrioritySettingKey(S.MERGE_ENABLED), false);
  });
});

test("feIsGmPrioritySettingKey: an excluded key stays personal even when client-scope", () => {
  // EXPORT_* and the font/toolbar keys are in FE_GM_PRIORITY_EXCLUDED_KEYS.
  withGame({ registered: { [S.EXPORT_ENABLED]: { scope: "client" } } }, () => {
    assert.equal(feIsGmPrioritySettingKey(S.EXPORT_ENABLED), false);
  });
  withGame({ registered: { [S.UI_ENABLE_FONTS]: { scope: "client" } } }, () => {
    assert.equal(feIsGmPrioritySettingKey(S.UI_ENABLE_FONTS), false);
  });
});

test("feIsGmPrioritySettingKey: an unregistered key is not forced", () => {
  withGame({ registered: {} }, () => {
    assert.equal(feIsGmPrioritySettingKey(S.MERGE_ENABLED), false);
  });
});

test("feIsGmPrioritySettingKey: infrastructure store keys and empty keys are rejected", () => {
  withGame({}, () => {
    assert.equal(feIsGmPrioritySettingKey("feGmPriorityOverrides"), false);
    assert.equal(feIsGmPrioritySettingKey("feGmPriorityBackup"), false);
    assert.equal(feIsGmPrioritySettingKey("feWorldSettings"), false);
    assert.equal(feIsGmPrioritySettingKey(""), false);
    assert.equal(feIsGmPrioritySettingKey(null), false);
  });
});

// ── feIsPerWorldSettingKey ────────────────────────────────────────────────────

test("feIsPerWorldSettingKey: client-scope keys participate, world-scope do not", () => {
  withGame({ registered: { [S.MERGE_ENABLED]: { scope: "client" } } }, () => {
    assert.equal(feIsPerWorldSettingKey(S.MERGE_ENABLED), true);
  });
  withGame({ registered: { [S.MERGE_ENABLED]: { scope: "world" } } }, () => {
    assert.equal(feIsPerWorldSettingKey(S.MERGE_ENABLED), false);
  });
});

test("feIsPerWorldSettingKey: an EXCLUDED-but-client key still participates per-world", () => {
  // Per-world storage is broader than GM-priority: export prefs are personal to
  // GM-priority yet still stored per world.
  withGame({ registered: { [S.EXPORT_ENABLED]: { scope: "client" } } }, () => {
    assert.equal(feIsPerWorldSettingKey(S.EXPORT_ENABLED), true);
  });
});

test("feIsPerWorldSettingKey: infrastructure store keys are rejected", () => {
  withGame({}, () => {
    assert.equal(feIsPerWorldSettingKey("feWorldSettings"), false);
    assert.equal(feIsPerWorldSettingKey("feGmPriorityOverrides"), false);
    assert.equal(feIsPerWorldSettingKey("feGmPriorityBackup"), false);
  });
});

// ── feGetGmPriorityOverrideValue / feHasGmPriorityOverride ────────────────────

test("feGetGmPriorityOverrideValue returns the stored override for a forced key", () => {
  withGame({
    registered: { [S.MERGE_ENABLED]: { scope: "client" } },
    values: { feGmPriorityOverrides: { [S.MERGE_ENABLED]: false } },
  }, () => {
    assert.equal(feGetGmPriorityOverrideValue(S.MERGE_ENABLED), false);
    assert.equal(feHasGmPriorityOverride(S.MERGE_ENABLED), true);
  });
});

test("feGetGmPriorityOverrideValue is undefined when no override is stored", () => {
  withGame({
    registered: { [S.MERGE_ENABLED]: { scope: "client" } },
    values: { feGmPriorityOverrides: {} },
  }, () => {
    assert.equal(feGetGmPriorityOverrideValue(S.MERGE_ENABLED), undefined);
    assert.equal(feHasGmPriorityOverride(S.MERGE_ENABLED), false);
  });
});

test("feGetGmPriorityOverrideValue ignores an override for a non-forceable key", () => {
  // Even if the store somehow carries an excluded key, it must not be honored.
  withGame({
    registered: { [S.EXPORT_ENABLED]: { scope: "client" } },
    values: { feGmPriorityOverrides: { [S.EXPORT_ENABLED]: true } },
  }, () => {
    assert.equal(feGetGmPriorityOverrideValue(S.EXPORT_ENABLED), undefined);
  });
});

// ── feIsGmPriorityEnabled ─────────────────────────────────────────────────────

test("feIsGmPriorityEnabled reflects the stored toggle, defaulting to true on error", () => {
  withGame({ values: { [S.GM_PRIORITY_ENABLED]: false } }, () => {
    assert.equal(feIsGmPriorityEnabled(), false);
  });
  withGame({ values: { [S.GM_PRIORITY_ENABLED]: true } }, () => {
    assert.equal(feIsGmPriorityEnabled(), true);
  });
  // Unreadable → fail safe to enabled.
  withGame({ values: {} }, () => {
    assert.equal(feIsGmPriorityEnabled(), true);
  });
});

// ── feSetting: the resolution priority contract ───────────────────────────────

test("feSetting: a PLAYER reads the GM override when enforcement is enabled", () => {
  withGame({
    isGM: false,
    registered: { [S.MERGE_ENABLED]: { scope: "client" } },
    values: {
      [S.GM_PRIORITY_ENABLED]: true,
      [S.MERGE_ENABLED]: true, // local value…
      feGmPriorityOverrides: { [S.MERGE_ENABLED]: false }, // …overridden by GM
    },
  }, () => {
    assert.equal(feSetting(S.MERGE_ENABLED), false);
  });
});

test("feSetting: a player with enforcement OFF reads their own local value", () => {
  withGame({
    isGM: false,
    registered: { [S.MERGE_ENABLED]: { scope: "client" } },
    values: {
      [S.GM_PRIORITY_ENABLED]: false,
      [S.MERGE_ENABLED]: true,
      feGmPriorityOverrides: { [S.MERGE_ENABLED]: false },
    },
  }, () => {
    assert.equal(feSetting(S.MERGE_ENABLED), true);
  });
});

test("feSetting: the GM ALWAYS reads game.settings directly, never its own override", () => {
  // The GM reading its own override would make every onChange apply the
  // pre-update value (the "first save does nothing" bug).
  withGame({
    isGM: true,
    registered: { [S.MERGE_ENABLED]: { scope: "client" } },
    values: {
      [S.GM_PRIORITY_ENABLED]: true,
      [S.MERGE_ENABLED]: true,
      feGmPriorityOverrides: { [S.MERGE_ENABLED]: false }, // stale — must be ignored
    },
  }, () => {
    assert.equal(feSetting(S.MERGE_ENABLED), true);
  });
});

test("feSetting: falls back to FE_DEFAULTS when the setting is unreadable", () => {
  withGame({ isGM: false, values: { [S.GM_PRIORITY_ENABLED]: false } }, () => {
    assert.equal(feSetting(S.MERGE_ENABLED), FE_DEFAULTS[S.MERGE_ENABLED]);
    assert.equal(feSetting(S.PRUNE_MAX_MESSAGES), FE_DEFAULTS[S.PRUNE_MAX_MESSAGES]);
  });
});
