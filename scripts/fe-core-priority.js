import {
  MODULE_ID,
  S,
  FE_CORE_PRIORITY_OVERRIDES_KEY,
  FE_CORE_PRIORITY_BACKUP_KEY,
  FE_CORE_PRIORITY_EXCLUDED_KEYS,
} from "./fe-constants.js";
import { feHasOwn, feValuesEqual } from "./fe-util.js";

// =====================================================================
// Core client-setting enforcement ("일반 환경 설정 GM 강제")
//
// A sibling of fe-gm-priority.js, for Foundry's OWN client-scope settings
// (game.settings namespace "core") instead of this module's.
//
// WHY THIS EXISTS AT ALL — the bug that motivated it: Foundry stores every
// client-scope setting in `window.localStorage`, which is partitioned by browser
// ORIGIN. A server reached both as `http://localhost:30000` and as
// `https://<public-host>` therefore keeps two completely independent copies of
// every client setting. Measured live on v14.367: the same browser, same world,
// had `core.lightAnimation` true on localhost and "false" on the public host, so
// light animations were frozen for anyone using the public address —
// `EffectsCanvasGroup#activateAnimation` (canvas/groups/effects.mjs:463) reads
// that flag and simply never registers its `#animateSources` ticker listener.
// Nothing in the world or on the server can see or fix that; it is per-player,
// per-origin browser state. Hence: let the GM push their values out.
//
// THE ONE STRUCTURAL DIFFERENCE FROM fe-gm-priority.js (do not "unify" them):
// module settings are read through `feSetting()`, so GM priority can intercept at
// READ time and never has to touch a player's stored value for the effect to
// appear. Core settings are read by CORE code (`game.settings.get("core", …)`)
// which we cannot intercept, so enforcement here is necessarily WRITE-THROUGH: we
// overwrite the player's real localStorage value. That makes the pre-force backup
// (FE_CORE_PRIORITY_BACKUP_KEY) load-bearing rather than a nicety — it is the only
// record of the player's own choice, and the only way turning the feature off can
// put things back.
//
// Scope of what is forced: every "core" setting that is client-scope AND
// `config: true` — i.e. exactly the checkboxes/selects Foundry shows in its own
// 환경 설정 panel — minus FE_CORE_PRIORITY_EXCLUDED_KEYS. Deriving the list from
// the live registry rather than hardcoding it means a Foundry update that adds or
// removes a client setting is picked up without a code change.
// =====================================================================

const CORE_NS = "core";

let feSyncingLocalCoreSettings = false;

function feGetCoreSettingConfig(key) {
  try {
    return game?.settings?.settings?.get?.(`${CORE_NS}.${String(key ?? "")}`) ?? null;
  } catch {
    return null;
  }
}

function feIsCorePriorityEnabled() {
  try {
    return !!game.settings.get(MODULE_ID, S.CORE_PRIORITY_ENABLED);
  } catch {
    // Unlike the module's own GM priority (which defaults ON), this feature
    // overwrites settings that belong to Foundry itself, so an unreadable toggle
    // must fail CLOSED — never force on a guess.
    return false;
  }
}

// A core setting participates when it is client-scope and user-facing. The
// `config` gate is what limits us to the visible 환경 설정 panel: core also
// registers ~27 client-scope settings with `config: false` (window positions,
// favorite paths, tour progress, collapsed UI state…) which are per-client
// bookkeeping and would be actively harmful to force.
function feIsCorePriorityKey(key) {
  try {
    if (!key) return false;
    if (FE_CORE_PRIORITY_EXCLUDED_KEYS.has(key)) return false;
    const cfg = feGetCoreSettingConfig(key);
    if (!cfg) return false;
    if (String(cfg.scope ?? "") !== "client") return false;
    return cfg.config === true;
  } catch {
    return false;
  }
}

// Core declares `requiresReload` on some of these (noCanvas, language,
// photosensitiveMode, pixelRatioResolutionScaling, showToolclips,
// universalKeybindings on v14.367). Core only ACTS on that flag inside its own
// SettingsConfig submit handler (applications/settings/config.mjs:257), so a
// programmatic `game.settings.set` like ours changes the stored value and runs the
// setting's `onChange`, but nothing tells the user the UI is now stale. We raise
// the prompt ourselves — once per sync, not once per key.
function feCoreKeyRequiresReload(key) {
  try {
    return feGetCoreSettingConfig(key)?.requiresReload === true;
  } catch {
    return false;
  }
}

function feGetCoreOverrides() {
  try {
    const data = game.settings.get(MODULE_ID, FE_CORE_PRIORITY_OVERRIDES_KEY);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

function feGetCoreBackup() {
  try {
    const data = game.settings.get(MODULE_ID, FE_CORE_PRIORITY_BACKUP_KEY);
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    return data;
  } catch {
    return {};
  }
}

function feGetCoreOverrideValue(key) {
  try {
    if (!feIsCorePriorityKey(key)) return undefined;
    const overrides = feGetCoreOverrides();
    if (!feHasOwn(overrides, key)) return undefined;
    return overrides[key];
  } catch {
    return undefined;
  }
}

function feHasCoreOverride(key) {
  return feGetCoreOverrideValue(key) !== undefined;
}

// Same serialization rationale as fe-gm-priority.js's `feWithStoreLock`: a single
// settings save can fire N concurrent `clientSettingChanged` mirrors, each doing
// an unsynchronized read→merge→write of the SAME override object, and
// last-writer-wins would silently drop every other key's new value. This lock is
// separate from that one on purpose — the two stores are independent documents,
// so serializing them together would only add contention.
let _feCoreStoreWriteChain = Promise.resolve();
function feWithCoreStoreLock(fn) {
  const run = _feCoreStoreWriteChain.then(fn, fn);
  _feCoreStoreWriteChain = run.then(() => {}, () => {});
  return run;
}

async function feSetCoreOverrides(partial = {}) {
  try {
    if (!game.user?.isGM) return false;
    return await feWithCoreStoreLock(async () => {
      const current = foundry.utils.deepClone(feGetCoreOverrides());
      let changed = false;
      for (const [key, value] of Object.entries(partial ?? {})) {
        if (!feIsCorePriorityKey(key)) continue;
        if (feHasOwn(current, key) && feValuesEqual(current[key], value)) continue;
        current[key] = value;
        changed = true;
      }
      if (!changed) return false;
      await game.settings.set(MODULE_ID, FE_CORE_PRIORITY_OVERRIDES_KEY, current);
      return true;
    });
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to update core-setting overrides`, err);
    return false;
  }
}

async function feClearCoreBackupKey(key) {
  try {
    return await feWithCoreStoreLock(async () => {
      const backup = feGetCoreBackup();
      if (!feHasOwn(backup, key)) return false;
      const next = foundry.utils.deepClone(backup);
      delete next[key];
      await game.settings.set(MODULE_ID, FE_CORE_PRIORITY_BACKUP_KEY, next);
      return true;
    });
  } catch {
    return false;
  }
}

// The GM changed a core setting in Foundry's own settings panel — propagate it.
// Clearing the backup first mirrors feMirrorGmPrioritySetting: a deliberate GM
// change makes any pre-force record of the GM's own value obsolete, and a stale
// one would make restore-on-disable revert to a value the GM abandoned.
async function feMirrorCoreSetting(key, value) {
  try {
    if (!game.user?.isGM) return false;
    if (!feIsCorePriorityEnabled()) return false;
    if (!feIsCorePriorityKey(key)) return false;
    await feClearCoreBackupKey(key);
    return await feSetCoreOverrides({ [key]: value });
  } catch {
    return false;
  }
}

// Seed the override store from the GM's own core settings. `force: true` on the
// enable transition so re-enabling reflects whatever the GM changed while it was
// off; the steady-state seed only fills keys that are still missing.
async function feSeedCoreOverridesFromLocal({ force = false } = {}) {
  try {
    if (!game.user?.isGM) return false;
    if (!feIsCorePriorityEnabled()) return false;
    const existing = feGetCoreOverrides();
    const partial = {};
    for (const [fullKey] of game.settings.settings ?? []) {
      const path = String(fullKey);
      if (!path.startsWith(`${CORE_NS}.`)) continue;
      const key = path.slice(CORE_NS.length + 1);
      if (!feIsCorePriorityKey(key)) continue;
      if (!force && feHasOwn(existing, key)) continue;
      try {
        partial[key] = game.settings.get(CORE_NS, key);
      } catch {
        /* skip unreadable key */
      }
    }
    if (!Object.keys(partial).length) return false;
    return await feSetCoreOverrides(partial);
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to seed core-setting overrides`, err);
    return false;
  }
}

// Ask once for a reload after a batch of forced changes touched reload-only core
// keys. `world: false` — these are client-scope values that changed for THIS
// browser only; `reloadConfirm({world: true})` would emit a "reload" socket and
// bounce the entire table for one player's local sync (config.mjs:195).
function feRequestCoreReload(keys) {
  if (!keys.length) return;
  try {
    const names = keys
      .map((key) => {
        const name = feGetCoreSettingConfig(key)?.name;
        return name ? game.i18n.localize(name) : key;
      })
      .join(", ");
    ui.notifications?.info(`GM이 강제한 환경 설정이 적용되었습니다(새로고침 필요): ${names}`);
    foundry.applications.settings.SettingsConfig.reloadConfirm({ world: false })
      .catch((err) => console.warn(`[${MODULE_ID}] core-priority reload prompt failed`, err));
  } catch (err) {
    console.warn(`[${MODULE_ID}] core-priority reload prompt failed`, err);
  }
}

// Apply the GM's override values into THIS client's core settings, recording each
// key's pre-force value the first time it is overwritten.
async function feSyncLocalCoreSettings({ keys = null } = {}) {
  try {
    if (!feIsCorePriorityEnabled()) return false;
    const overrides = feGetCoreOverrides();
    const wanted = Array.isArray(keys)
      ? keys.filter((key) => feIsCorePriorityKey(key) && feHasOwn(overrides, key))
      : Object.keys(overrides).filter((key) => feIsCorePriorityKey(key));
    if (!wanted.length) return false;

    const backup = feGetCoreBackup();
    const newBackupEntries = {};
    const reloadKeys = [];

    feSyncingLocalCoreSettings = true;
    let changed = false;
    try {
      for (const key of wanted) {
        const target = overrides[key];
        let current;
        try {
          current = game.settings.get(CORE_NS, key);
        } catch {
          continue;
        }
        if (feValuesEqual(current, target)) continue;
        if (!feHasOwn(backup, key)) newBackupEntries[key] = current;
        try {
          // A value the GM's Foundry accepted may still be invalid here (a
          // language whose module is missing, a choice a different core build
          // dropped): core's #cleanJSON throws rather than storing junk, and one
          // bad key must not abort the rest of the batch.
          await game.settings.set(CORE_NS, key, target);
        } catch (err) {
          console.warn(`[${MODULE_ID}] could not force core setting "${key}"`, err);
          delete newBackupEntries[key];
          continue;
        }
        if (feCoreKeyRequiresReload(key)) reloadKeys.push(key);
        changed = true;
      }
    } finally {
      feSyncingLocalCoreSettings = false;
    }

    if (Object.keys(newBackupEntries).length) {
      try {
        // Locked read-modify-MERGE, never a whole-object write: re-read inside the
        // lock and add only keys not already present, so a concurrent
        // feClearCoreBackupKey is not clobbered by stale data.
        await feWithCoreStoreLock(async () => {
          const cur = foundry.utils.deepClone(feGetCoreBackup());
          let merged = false;
          for (const [k, v] of Object.entries(newBackupEntries)) {
            if (!feHasOwn(cur, k)) { cur[k] = v; merged = true; }
          }
          if (merged) await game.settings.set(MODULE_ID, FE_CORE_PRIORITY_BACKUP_KEY, cur);
        });
      } catch {
        /* backup is best-effort; a failure only weakens restore, not safety */
      }
    }

    feRequestCoreReload(reloadKeys);
    return changed;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to sync local core settings`, err);
    return false;
  }
}

// Put every forced core setting back to this client's own pre-force value and
// clear the backup. Runs on every client when the feature is turned OFF, and at
// `ready` when it loads already-off (covers a client that was offline when the GM
// disabled it), so disabling leaves nothing forced behind.
async function feRestoreLocalCoreSettings() {
  try {
    const backup = feGetCoreBackup();
    const keys = Object.keys(backup);
    if (!keys.length) return false;

    const reloadKeys = [];
    feSyncingLocalCoreSettings = true;
    try {
      for (const key of keys) {
        const target = backup[key];
        let current;
        try {
          current = game.settings.get(CORE_NS, key);
        } catch {
          continue;
        }
        if (feValuesEqual(current, target)) continue;
        try {
          await game.settings.set(CORE_NS, key, target);
        } catch {
          continue;
        }
        if (feCoreKeyRequiresReload(key)) reloadKeys.push(key);
      }
    } finally {
      feSyncingLocalCoreSettings = false;
    }

    try {
      await feWithCoreStoreLock(() => game.settings.set(MODULE_ID, FE_CORE_PRIORITY_BACKUP_KEY, {}));
    } catch {
      /* no-op */
    }
    feRequestCoreReload(reloadKeys);
    return true;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to restore local core settings`, err);
    return false;
  }
}

// The user-facing list, for the settings panel's explanatory note. Labels come
// from core's own i18n keys so they always match Foundry's wording.
function feListCorePriorityKeys() {
  const out = [];
  try {
    for (const [fullKey, cfg] of game.settings.settings ?? []) {
      const path = String(fullKey);
      if (!path.startsWith(`${CORE_NS}.`)) continue;
      const key = path.slice(CORE_NS.length + 1);
      if (!feIsCorePriorityKey(key)) continue;
      out.push({
        key,
        label: cfg?.name ? game.i18n.localize(cfg.name) : key,
        requiresReload: cfg?.requiresReload === true,
      });
    }
  } catch {
    /* no-op */
  }
  return out;
}

export {
  feSyncingLocalCoreSettings,
  feIsCorePriorityEnabled,
  feIsCorePriorityKey,
  feGetCoreOverrides,
  feGetCoreBackup,
  feGetCoreOverrideValue,
  feHasCoreOverride,
  feSetCoreOverrides,
  feMirrorCoreSetting,
  feSeedCoreOverridesFromLocal,
  feSyncLocalCoreSettings,
  feRestoreLocalCoreSettings,
  feListCorePriorityKeys,
};
