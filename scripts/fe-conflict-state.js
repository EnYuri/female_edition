// Shared runtime state for feature-level conflict handling.
//
// Suppression is deliberately runtime-only: a compatible standalone module may
// take precedence for this launch without overwriting the user's saved
// female_edition preference. Module activation changes already require reload.

const feConflictSuppressions = new Map();

const FE_CONFLICT_FEATURE = Object.freeze({
  NARRATOR: "narrator",
  STAGE: "stage",
  IMAGE_HOVER: "image-hover",
  CHAT_PRUNE: "chat-prune",
  TYPING: "typing",
  COMBAT_TRACKER: "combat-tracker",
  CHAT_PORTRAIT: "chat-portrait",
  CHAT_IMAGES: "chat-images",
  MUSIC: "music",
});

function feSuppressConflictFeature(feature, reason = "") {
  const id = String(feature ?? "").trim();
  if (!id) return false;
  feConflictSuppressions.set(id, String(reason ?? ""));
  return true;
}

function feIsConflictFeatureSuppressed(feature) {
  return feConflictSuppressions.has(String(feature ?? ""));
}

function feConflictFeatureSuppressionReason(feature) {
  return feConflictSuppressions.get(String(feature ?? "")) ?? "";
}

function feClearConflictFeatureSuppressions() {
  feConflictSuppressions.clear();
}

/**
 * Read a registered Boolean-like module setting without guessing when the
 * setting is absent. `known:false` lets callers choose a conservative policy.
 */
function feReadRegisteredModuleSetting(moduleId, key) {
  const namespace = String(moduleId ?? "");
  const settingKey = String(key ?? "");
  if (!namespace || !settingKey) return { known: false, value: undefined };

  const fullKey = `${namespace}.${settingKey}`;
  try {
    const registry = game?.settings?.settings;
    if (registry?.has && !registry.has(fullKey)) return { known: false, value: undefined };
    return { known: true, value: game.settings.get(namespace, settingKey) };
  } catch {
    return { known: false, value: undefined };
  }
}

function feIsActiveModuleFeatureEnabled(moduleId, settingKey = null, { unknown = true } = {}) {
  let mod;
  try { mod = game?.modules?.get?.(moduleId); } catch { return false; }
  if (!mod?.active) return false;
  if (!settingKey) return true;
  const result = feReadRegisteredModuleSetting(moduleId, settingKey);
  return result.known ? !!result.value : !!unknown;
}

export {
  FE_CONFLICT_FEATURE,
  feSuppressConflictFeature,
  feIsConflictFeatureSuppressed,
  feConflictFeatureSuppressionReason,
  feClearConflictFeatureSuppressions,
  feReadRegisteredModuleSetting,
  feIsActiveModuleFeatureEnabled,
};
