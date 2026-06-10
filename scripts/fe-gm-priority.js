import { MODULE_ID, S, FE_DEFAULTS, FE_GM_PRIORITY_OVERRIDES_KEY, FE_WORLD_SETTINGS_KEY, FE_GM_PRIORITY_EXCLUDED_KEYS } from "./fe-constants.js";
import { feHasOwn, feValuesEqual } from "./fe-util.js";

let feSyncingLocalGmPrioritySettings = false;
let feHydratingWorldSettings = false;

function feGetRegisteredSettingConfig(key) {
  try {
    return game?.settings?.settings?.get?.(`${MODULE_ID}.${String(key ?? "")}`) ?? null;
  } catch {
    return null;
  }
}

function feIsGmPriorityEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, S.GM_PRIORITY_ENABLED);
  } catch {
    return true;
  }
}

function feIsGmPrioritySettingKey(key) {
  try {
    if (!key || key === FE_GM_PRIORITY_OVERRIDES_KEY) return false;
    if (key === FE_WORLD_SETTINGS_KEY) return false;
    if (FE_GM_PRIORITY_EXCLUDED_KEYS.has(key)) return false;
    const cfg = feGetRegisteredSettingConfig(key);
    if (!cfg) return false;
    return String(cfg.scope ?? "") === "client";
  } catch {
    return false;
  }
}

function feGetGmPriorityOverrides() {
  try {
    const data = game.settings.get(MODULE_ID, FE_GM_PRIORITY_OVERRIDES_KEY);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

function feGetGmPriorityOverrideValue(key) {
  try {
    if (!feIsGmPrioritySettingKey(key)) return undefined;
    const overrides = feGetGmPriorityOverrides();
    if (!feHasOwn(overrides, key)) return undefined;
    return overrides[key];
  } catch {
    return undefined;
  }
}

function feHasGmPriorityOverride(key) {
  try {
    return feGetGmPriorityOverrideValue(key) !== undefined;
  } catch {
    return false;
  }
}

async function feSetGmPriorityOverrides(partial = {}) {
  try {
    if (!game.user?.isGM) return false;
    const current = foundry.utils.deepClone(feGetGmPriorityOverrides());
    let changed = false;
    for (const [key, value] of Object.entries(partial ?? {})) {
      if (!feIsGmPrioritySettingKey(key)) continue;
      if (feHasOwn(current, key) && feValuesEqual(current[key], value)) continue;
      current[key] = value;
      changed = true;
    }
    if (!changed) return false;
    await game.settings.set(MODULE_ID, FE_GM_PRIORITY_OVERRIDES_KEY, current);
    return true;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to update GM-priority overrides`, err);
    return false;
  }
}

async function feMirrorGmPrioritySetting(key, value) {
  try {
    if (!game.user?.isGM) return false;
    if (!feIsGmPrioritySettingKey(key)) return false;
    return await feSetGmPriorityOverrides({ [key]: value });
  } catch {
    return false;
  }
}

async function feSeedGmPriorityOverridesFromLocal() {
  try {
    if (!game.user?.isGM) return false;
    const existing = feGetGmPriorityOverrides();
    const partial = {};
    for (const [fullKey, cfg] of game.settings.settings ?? []) {
      if (!String(fullKey).startsWith(`${MODULE_ID}.`)) continue;
      const key = String(fullKey).slice(MODULE_ID.length + 1);
      if (!feIsGmPrioritySettingKey(key)) continue;
      if (feHasOwn(existing, key)) continue;
      partial[key] = game.settings.get(MODULE_ID, key);
    }
    if (!Object.keys(partial).length) return false;
    return await feSetGmPriorityOverrides(partial);
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to seed GM-priority overrides`, err);
    return false;
  }
}

async function feSyncLocalGmPrioritySettings({ keys = null } = {}) {
  try {
    const overrides = feGetGmPriorityOverrides();
    const wanted = Array.isArray(keys)
      ? keys.filter((key) => feIsGmPrioritySettingKey(key) && feHasOwn(overrides, key))
      : Object.keys(overrides).filter((key) => feIsGmPrioritySettingKey(key));
    if (!wanted.length) return false;

    feSyncingLocalGmPrioritySettings = true;
    let changed = false;
    for (const key of wanted) {
      const target = overrides[key];
      let current;
      try {
        current = game.settings.get(MODULE_ID, key);
      } catch {
        continue;
      }
      if (feValuesEqual(current, target)) continue;
      await game.settings.set(MODULE_ID, key, target);
      changed = true;
    }
    return changed;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to sync local GM-priority settings`, err);
    return false;
  } finally {
    feSyncingLocalGmPrioritySettings = false;
  }
}

// =====================================================================
// Per-world settings
//
// Client settings live in localStorage per browser origin (no world id), so
// they are shared across every world on the server. We re-namespace them by
// world id in a single client-scope Object (FE_WORLD_SETTINGS_KEY):
//   { [worldId]: { [settingKey]: value } }
//
// On world load we hydrate game.settings from this world's slice (or seed the
// slice from the current values on first visit, so a world inherits whatever
// the user already had). On settings-menu save we capture the current values
// back into this world's slice. The map itself and GM-priority overrides are
// never stored per-world.
// =====================================================================

function feGetWorldId() {
  try {
    return String(game?.world?.id ?? "");
  } catch {
    return "";
  }
}

// A setting participates in per-world storage when it is a client-scope
// female_edition setting that is not one of the infrastructure stores.
function feIsPerWorldSettingKey(key) {
  try {
    if (!key) return false;
    if (key === FE_WORLD_SETTINGS_KEY || key === FE_GM_PRIORITY_OVERRIDES_KEY) return false;
    const cfg = feGetRegisteredSettingConfig(key);
    if (!cfg) return false;
    return String(cfg.scope ?? "") === "client";
  } catch {
    return false;
  }
}

function feGetAllWorldSettings() {
  try {
    const data = game.settings.get(MODULE_ID, FE_WORLD_SETTINGS_KEY);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

// Snapshot the current local values of every per-world key.
function feSnapshotPerWorldSettings() {
  const snap = {};
  try {
    for (const [fullKey] of game.settings.settings ?? []) {
      if (!String(fullKey).startsWith(`${MODULE_ID}.`)) continue;
      const key = String(fullKey).slice(MODULE_ID.length + 1);
      if (!feIsPerWorldSettingKey(key)) continue;
      try {
        snap[key] = game.settings.get(MODULE_ID, key);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no-op */
  }
  return snap;
}

// Persist the current values into this world's slice of the store.
async function feCaptureWorldSettings() {
  try {
    if (feHydratingWorldSettings) return false;
    const worldId = feGetWorldId();
    if (!worldId) return false;
    const all = foundry.utils.deepClone(feGetAllWorldSettings());
    all[worldId] = feSnapshotPerWorldSettings();
    await game.settings.set(MODULE_ID, FE_WORLD_SETTINGS_KEY, all);
    return true;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to capture per-world settings`, err);
    return false;
  }
}

// On world load: apply this world's saved slice into local game.settings.
// First visit (no slice yet) seeds the slice from the current values, so the
// world adopts whatever the user already had configured.
async function feHydrateWorldSettings() {
  const worldId = feGetWorldId();
  if (!worldId) return false;
  feHydratingWorldSettings = true;
  try {
    const all = feGetAllWorldSettings();
    const slice = all[worldId];

    if (!slice || typeof slice !== "object") {
      // First visit — seed from current values without touching game.settings.
      const seeded = foundry.utils.deepClone(all);
      seeded[worldId] = feSnapshotPerWorldSettings();
      await game.settings.set(MODULE_ID, FE_WORLD_SETTINGS_KEY, seeded);
      return false;
    }

    // Apply only the keys whose stored value differs (avoids redundant
    // onChange churn), mirroring feSyncLocalGmPrioritySettings.
    let changed = false;
    for (const [key, target] of Object.entries(slice)) {
      if (!feIsPerWorldSettingKey(key)) continue;
      let current;
      try {
        current = game.settings.get(MODULE_ID, key);
      } catch {
        continue;
      }
      if (feValuesEqual(current, target)) continue;
      await game.settings.set(MODULE_ID, key, target);
      changed = true;
    }
    return changed;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to hydrate per-world settings`, err);
    return false;
  } finally {
    feHydratingWorldSettings = false;
  }
}

function feFireChatUiUpdated(payload = null) {
  Hooks.callAll(`${MODULE_ID}.chatUiUpdated`, payload);
}

function feSetting(key) {
  try {
    if (feIsGmPriorityEnabled()) {
      const override = feGetGmPriorityOverrideValue(key);
      if (override !== undefined) return override;
    }
  } catch {
    /* no-op */
  }
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return FE_DEFAULTS[key];
  }
}

export {
  feSyncingLocalGmPrioritySettings,
  feGetRegisteredSettingConfig,
  feIsGmPriorityEnabled,
  feIsGmPrioritySettingKey,
  feGetGmPriorityOverrides,
  feGetGmPriorityOverrideValue,
  feHasGmPriorityOverride,
  feSetGmPriorityOverrides,
  feMirrorGmPrioritySetting,
  feSeedGmPriorityOverridesFromLocal,
  feSyncLocalGmPrioritySettings,
  feIsPerWorldSettingKey,
  feGetAllWorldSettings,
  feCaptureWorldSettings,
  feHydrateWorldSettings,
  feFireChatUiUpdated,
  feSetting,
};
