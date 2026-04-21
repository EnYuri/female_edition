import { MODULE_ID, S, FE_DEFAULTS, FE_GM_PRIORITY_OVERRIDES_KEY, FE_GM_PRIORITY_EXCLUDED_KEYS } from "./fe-constants.js";
import { feHasOwn, feValuesEqual } from "./fe-util.js";

let feSyncingLocalGmPrioritySettings = false;

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
  feFireChatUiUpdated,
  feSetting,
};
