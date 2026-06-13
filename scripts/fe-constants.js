const MODULE_ID = "female_edition";

const LEGACY_UI_FONT_KEY = "ceUiUse" + "D" + "o" + "n" + "g" + "l" + "e";

const S = {
  MERGE_ENABLED: "ceMergeEnabled",
  MERGE_ONLY_TEXT: "ceMergeOnlyText",
  MERGE_INCLUDE_ROLL_MESSAGES: "ceMergeIncludeRollMessages",
  MERGE_DIVIDER: "ceMergeDivider",
  MERGE_GROUP_SPACING: "ceMergeGroupSpacing",
  MERGE_MODE: "ceMergeMode",
  MERGE_FOLLOW_HEADER_STYLE: "ceMergeFollowHeaderStyle",
  MERGE_SPEAKER_BASIS: "ceMergeSpeakerBasis",
  EXPORT_ENABLED: "ceExportEnabled",
  EXPORT_AUTO_PRINT: "ceExportAutoPrint",
  EXPORT_OPTIMIZE: "ceExportOptimize",
  EXPORT_EMBED_FONTS: "ceExportEmbedFonts",
  EXPORT_EMBED_IMAGES: "ceExportEmbedImages",
  EXPORT_PRINT_IMAGE_MODE: "ceExportPrintImageMode",
  EXPORT_DESKTOP_EXTERNAL_MODE: "ceExportDesktopExternalMode",
  CHATCARD_USE_CUSTOM_FONT: "ceChatCardUseCustomFont",
  CHAT_FONT_CHOICE: "ceChatFontChoice",
  UI_USE_GEURIMILGI: "ceUiUseGeurimilgi",
  // Master toggles registered by chat-bg-stripper.js. Keys are not "ce*"-prefixed
  // for backwards compatibility with already-saved user settings.
  UI_ENABLE_FONTS: "enableFonts",
  // Retro (pixel high-contrast) theme. Storage key keeps its legacy
  // "ceUiDx3rdPixelTheme" value so already-saved user toggles are preserved
  // after the rename from the old DX3rd-specific name to a general theme.
  UI_RETRO_THEME: "ceUiDx3rdPixelTheme",
  UI_HIDE_PORTRAITS: "hideChatPortraits",
  UI_STRIP_TEXTURES: "stripChatTextures",
  USE_USER_COLOR_BG: "ceUseUserColorBg",
  USER_COLOR_BG_BASE: "ceUserColorBgBase",
  USER_COLOR_BG_CUSTOM: "ceUserColorBgCustom",
  USER_COLOR_ALPHA: "ceUserColorAlpha",
  SYSTEM_MSG_COLOR: "ceSystemMsgColor",
  CHAT_GROUP_OUTLINE: "ceChatGroupOutline",
  ACCENT_TEXT_OVERRIDE: "ceAccentTextOverride",
  STYLE_ACTOR_NAME_SIZE: "ceActorNameSize",
  STYLE_PLAYER_NAME_SIZE: "cePlayerNameSize",
  STYLE_MESSAGE_TEXT_SIZE: "ceMessageTextSize",
  STYLE_CHATCARD_TEXT_SIZE: "ceChatCardTextSize",
  STYLE_BG_SATURATION: "ceMessageBgSaturation",
  STYLE_CHAT_MESSAGE_SPACING: "ceChatMessageSpacing",
  STYLE_HEADER_CONTENT_GAP: "ceHeaderContentGap",
  MERGE_INNER_GAP: "ceMergeInnerGap",
  MARKDOWN_ENABLED: "ceMarkdownEnabled",
  EDIT_ENABLED: "ceEditEnabled",
  GM_PRIORITY_ENABLED: "ceGmPriorityEnabled",
  GM_SPEAK_AS_SELF: "ceGmSpeakAsSelf",
  DX3RD_RUI_ENABLED: "ceDx3rdRuiEnabled",
  DX3RD_RUI_PORTRAIT_WIDTH: "ceDx3rdRuiPortraitWidth",
  DX3RD_RUI_PANEL_WIDTH: "ceDx3rdRuiPanelWidth",
  DX3RD_RUI_CARD_HEIGHT: "ceDx3rdRuiCardHeight",
  DX3RD_CARD_BORDER_ALPHA: "ceDx3rdCardBorderAlpha",
  DX3RD_PIXEL_ACCENT: "ceDx3rdPixelAccent",
  PRUNE_ENABLED: "cePruneEnabled",
  PRUNE_MAX_MESSAGES: "cePruneMaxMessages",
  TYPING_ENABLED: "ceTypingEnabled",
  TYPING_SHOW_TO_PLAYERS: "ceTypingShowToPlayers",
  SC_COLLAPSE_ENABLED: "ceSceneControlsCollapse",
  SCREEN_PANEL_ENABLED: "ceScreenPanelEnabled",
};

const FE_EXPORT_PRINT_IMAGE_MODE_CHOICES = Object.freeze({
  full: "그대로(고품질/대용량)",
  hideAvatars: "아바타/포트레이트 숨김(권장)",
  hideAll: "모든 이미지 숨김(최대 안정)",
  downscaleLite: "이미지 다운스케일(완화/품질 우선)",
  downscale: "이미지 다운스케일(실험적)",
});

// Defaults seeded from yuricross world's final feGmPriorityOverrides (2026-05-12).
const FE_DEFAULTS = {
  [S.MERGE_ENABLED]: true,
  [S.MERGE_ONLY_TEXT]: false,
  [S.MERGE_INCLUDE_ROLL_MESSAGES]: true,
  [S.MERGE_DIVIDER]: false,
  [S.MERGE_GROUP_SPACING]: 14,
  [S.MERGE_MODE]: "simple",
  [S.MERGE_FOLLOW_HEADER_STYLE]: "hide",
  [S.MERGE_SPEAKER_BASIS]: "actor",
  [S.EXPORT_ENABLED]: true,
  [S.EXPORT_AUTO_PRINT]: false,
  [S.EXPORT_OPTIMIZE]: true,
  [S.EXPORT_EMBED_FONTS]: true,
  [S.EXPORT_EMBED_IMAGES]: true,
  [S.EXPORT_PRINT_IMAGE_MODE]: "downscaleLite",
  [S.EXPORT_DESKTOP_EXTERNAL_MODE]: "button",
  [S.CHATCARD_USE_CUSTOM_FONT]: true,
  [S.CHAT_FONT_CHOICE]: "cookie",
  [S.UI_USE_GEURIMILGI]: true,
  [S.UI_ENABLE_FONTS]: true,
  [S.UI_RETRO_THEME]: false,
  [S.UI_HIDE_PORTRAITS]: true,
  [S.UI_STRIP_TEXTURES]: true,
  [S.USE_USER_COLOR_BG]: false,
  [S.USER_COLOR_BG_BASE]: "white",
  [S.USER_COLOR_BG_CUSTOM]: "#1b1b1b",
  [S.USER_COLOR_ALPHA]: 0.22,
  [S.SYSTEM_MSG_COLOR]: false,
  [S.CHAT_GROUP_OUTLINE]: false,
  [S.ACCENT_TEXT_OVERRIDE]: true,
  [S.STYLE_ACTOR_NAME_SIZE]: 22,
  [S.STYLE_PLAYER_NAME_SIZE]: 14,
  [S.STYLE_MESSAGE_TEXT_SIZE]: 14,
  [S.STYLE_CHATCARD_TEXT_SIZE]: 12,
  [S.STYLE_BG_SATURATION]: 1,
  [S.STYLE_CHAT_MESSAGE_SPACING]: 3,
  [S.STYLE_HEADER_CONTENT_GAP]: 4,
  [S.MERGE_INNER_GAP]: 8,
  [S.MARKDOWN_ENABLED]: true,
  [S.EDIT_ENABLED]: true,
  [S.GM_PRIORITY_ENABLED]: true,
  [S.GM_SPEAK_AS_SELF]: false,
  [S.DX3RD_RUI_ENABLED]: false,
  [S.DX3RD_RUI_PORTRAIT_WIDTH]: 98,
  [S.DX3RD_RUI_PANEL_WIDTH]: 110,
  [S.DX3RD_RUI_CARD_HEIGHT]: 80,
  [S.DX3RD_CARD_BORDER_ALPHA]: 0.5,
  [S.DX3RD_PIXEL_ACCENT]: "#ffffff",
  [S.PRUNE_ENABLED]: true,
  [S.PRUNE_MAX_MESSAGES]: 50,
  [S.TYPING_ENABLED]: true,
  [S.TYPING_SHOW_TO_PLAYERS]: true,
  [S.SC_COLLAPSE_ENABLED]: false,
  [S.SCREEN_PANEL_ENABLED]: true,
};

const FE_GM_PRIORITY_OVERRIDES_KEY = "feGmPriorityOverrides";

// Per-world settings store. A single client-scope Object holding
// { [worldId]: { [settingKey]: value } }. Client settings in Foundry are stored
// in localStorage per browser origin WITHOUT a world id, so they are shared
// across every world on the same server. This store re-namespaces them by world
// id so each world keeps an independent copy of the user's preferences.
const FE_WORLD_SETTINGS_KEY = "feWorldSettings";

const FE_GM_PRIORITY_EXCLUDED_KEYS = new Set([
  S.EXPORT_ENABLED,
  S.EXPORT_AUTO_PRINT,
  S.EXPORT_OPTIMIZE,
  S.EXPORT_EMBED_FONTS,
  S.EXPORT_EMBED_IMAGES,
  S.EXPORT_PRINT_IMAGE_MODE,
  S.EXPORT_DESKTOP_EXTERNAL_MODE,
  S.UI_ENABLE_FONTS,
  S.DX3RD_RUI_ENABLED,
  S.GM_PRIORITY_ENABLED,
  S.GM_SPEAK_AS_SELF,
  S.PRUNE_ENABLED,
  S.PRUNE_MAX_MESSAGES,
  S.TYPING_ENABLED,
  // Personal toolbar preference — each player decides; never GM-forced.
  S.SC_COLLAPSE_ENABLED,
  // Standalone-module client settings migrated into the unified menu — personal,
  // read by their modules via game.settings.get; exclude so the menu's feSetting
  // read reflects the raw value (no GM-priority override staleness).
  "chatImagesEnabled",
  "chatImagesShowButton",
  // image-hover + theatre CLIENT-scope personal settings (also migrated). Each
  // player keeps their own; never GM-forced.
  "ihEnabled",
  "ihPosition",
  "ihSize",
  "ihDelay",
  "stagePortraitHeight",
  "stageBoxWidth",
  "stageBoxHeight",
  "stageBoxBottom",
  "stageBoxLeft",
  "stageTextSize",
  // User-color background appearance tuning — read via feSetting in the apply
  // path; exclude so the raw per-client value is used (no stale GM-priority
  // override) and each player tunes their own base/color/alpha.
  S.USER_COLOR_BG_BASE,
  S.USER_COLOR_BG_CUSTOM,
  S.USER_COLOR_ALPHA,
  S.SYSTEM_MSG_COLOR,
]);

const FE_RENDER_STATE_FLAG = "renderState";
const FE_RENDER_SPECIAL_KIND_FLAG = "specialKind";
const FE_RENDER_MERGE_HINT_FLAG = "mergeHint";
const FE_RENDER_STATE_VERSION = 3;

const FE_TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;
const FE_OVERLAY_LAYER = "var(--fe-parchment-overlay)";

const FE_MERGE_CLASS_LIST = ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"];
const FE_MERGE_CLASS_SORTED = ["fe-divider-before", "fe-merge-end", "fe-merge-follow", "fe-merge-mid", "fe-merge-start"];

export {
  MODULE_ID,
  LEGACY_UI_FONT_KEY,
  S,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_DEFAULTS,
  FE_GM_PRIORITY_OVERRIDES_KEY,
  FE_WORLD_SETTINGS_KEY,
  FE_GM_PRIORITY_EXCLUDED_KEYS,
  FE_RENDER_STATE_FLAG,
  FE_RENDER_SPECIAL_KIND_FLAG,
  FE_RENDER_MERGE_HINT_FLAG,
  FE_RENDER_STATE_VERSION,
  FE_TEX_RE,
  FE_OVERLAY_LAYER,
  FE_MERGE_CLASS_LIST,
  FE_MERGE_CLASS_SORTED,
};
