import {
  S,
  LEGACY_UI_FONT_KEY,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_DEFAULTS,
  FE_GM_PRIORITY_OVERRIDES_KEY,
  FE_GM_PRIORITY_BACKUP_KEY,
  FE_WORLD_SETTINGS_KEY,
  FE_CORE_PRIORITY_OVERRIDES_KEY,
  FE_CORE_PRIORITY_BACKUP_KEY,
  FE_CORE_PRIORITY_EXCLUDED_KEYS,
  FE_GM_PRIORITY_EXCLUDED_KEYS,
} from "./fe-settings-data.js";

const MODULE_ID = "female_edition";

// The maintained companion, its direct upstream fork, and the original system all
// share the DX3rd actor resource schema and most sheet/chat markup. Keep package-ID
// gates centralized so a feature cannot silently support only part of the family.
const FE_DX3RD_SYSTEM_IDS = Object.freeze([
  "dx3rd-emanim",
  "double-cross-3rd",
  "dx3rd",
]);

function feIsDx3rdSystemId(systemId) {
  return FE_DX3RD_SYSTEM_IDS.includes(String(systemId ?? ""));
}

// Dungeon World family. `Emmanim-Dungeonworld` is the maintained fork installed
// alongside this module; `dungeonworld` is Asacolips' upstream. Both share the
// actor schema (`system.attributes.hp`), the `.dungeonworld` sheet root, and the
// `.dw-chat-card` / `.chat-card.move-card` chat markup, so one gate covers both.
// Foundry package IDs are case-sensitive, but the fork's ID is mixed-case and is
// easy to mistype in a world manifest — compare case-insensitively so a stray
// `emmanim-dungeonworld` still gets the compat surfaces.
const FE_DW_SYSTEM_IDS = Object.freeze([
  "Emmanim-Dungeonworld",
  "dungeonworld",
]);

const FE_DW_SYSTEM_IDS_LOWER = Object.freeze(FE_DW_SYSTEM_IDS.map((id) => id.toLowerCase()));

function feIsDungeonWorldSystemId(systemId) {
  return FE_DW_SYSTEM_IDS_LOWER.includes(String(systemId ?? "").toLowerCase());
}

const FE_RENDER_STATE_FLAG = "renderState";
const FE_RENDER_SPECIAL_KIND_FLAG = "specialKind";
const FE_RENDER_MERGE_HINT_FLAG = "mergeHint";
const FE_RENDER_STATE_VERSION = 4;

const FE_TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;

const FE_MERGE_CLASS_LIST = ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"];
const FE_MERGE_CLASS_SORTED = ["fe-divider-before", "fe-merge-end", "fe-merge-follow", "fe-merge-mid", "fe-merge-start"];

export {
  MODULE_ID,
  FE_DX3RD_SYSTEM_IDS,
  feIsDx3rdSystemId,
  FE_DW_SYSTEM_IDS,
  feIsDungeonWorldSystemId,
  LEGACY_UI_FONT_KEY,
  S,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_DEFAULTS,
  FE_GM_PRIORITY_OVERRIDES_KEY,
  FE_GM_PRIORITY_BACKUP_KEY,
  FE_WORLD_SETTINGS_KEY,
  FE_GM_PRIORITY_EXCLUDED_KEYS,
  FE_CORE_PRIORITY_OVERRIDES_KEY,
  FE_CORE_PRIORITY_BACKUP_KEY,
  FE_CORE_PRIORITY_EXCLUDED_KEYS,
  FE_RENDER_STATE_FLAG,
  FE_RENDER_SPECIAL_KIND_FLAG,
  FE_RENDER_MERGE_HINT_FLAG,
  FE_RENDER_STATE_VERSION,
  FE_TEX_RE,
  FE_MERGE_CLASS_LIST,
  FE_MERGE_CLASS_SORTED,
};
