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
  EXPORT_EXCLUDE_WHISPERS: "ceExportExcludeWhispers",
  EXPORT_PRINT_IMAGE_MODE: "ceExportPrintImageMode",
  EXPORT_DESKTOP_EXTERNAL_MODE: "ceExportDesktopExternalMode",
  CHAT_FONT_CHOICE: "ceChatFontChoice",
  UI_USE_GEURIMILGI: "ceUiUseGeurimilgi",
  // User font: when on, a locally-installed or font/-folder font replaces the
  // module's built-in CookieRun/Geurimilgi stack entirely (like NeoDGM mode).
  UI_USE_USER_FONT: "ceUiUseUserFont",
  USER_FONT_FAMILY: "ceUserFontFamily",
  // Canvas (PIXI) text — token nameplates, cursors, measurement labels. These are
  // WebGL text, not DOM, so CSS cannot reach them; see feApplyCanvasTextFont.
  CANVAS_TEXT_FONT: "ceCanvasTextFont",
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
  SYSTEM_MSG_BG_ENABLED: "ceSystemMsgBgEnabled",
  SYSTEM_MSG_BG_COLOR: "ceSystemMsgBgColor",
  FORCE_NORMAL_MSG_COLOR: "ceForceNormalMsgColor",
  CHAT_GROUP_OUTLINE: "ceChatGroupOutline",
  ACCENT_TEXT_OVERRIDE: "ceAccentTextOverride",
  STYLE_ACTOR_NAME_SIZE: "ceActorNameSize",
  STYLE_PLAYER_NAME_SIZE: "cePlayerNameSize",
  STYLE_MESSAGE_TEXT_SIZE: "ceMessageTextSize",
  STYLE_CHATCARD_TEXT_SIZE: "ceChatCardTextSize",
  STYLE_BG_SATURATION: "ceMessageBgSaturation",
  STYLE_PAPER_OVERLAY_ENABLED: "cePaperOverlayEnabled",
  STYLE_CHAT_MESSAGE_SPACING: "ceChatMessageSpacing",
  STYLE_HEADER_CONTENT_GAP: "ceHeaderContentGap",
  MERGE_INNER_GAP: "ceMergeInnerGap",
  MARKDOWN_ENABLED: "ceMarkdownEnabled",
  EDIT_ENABLED: "ceEditEnabled",
  GM_PRIORITY_ENABLED: "ceGmPriorityEnabled",
  GM_SPEAK_AS_SELF: "ceGmSpeakAsSelf",
  DX3RD_RUI_ENABLED: "ceDx3rdRuiEnabled",
  DX3RD_RUI_VISIBLE: "ceDx3rdRuiVisible",
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
  CORE_UI_TOKEN_PREVIEW: "ceCoreUiTokenPreview",
  CORE_UI_FILEPICKER_ENHANCEMENTS: "ceCoreUiFilepickerEnhancements",
  CORE_UI_SCENE_CONFIG_TABS: "ceCoreUiSceneConfigTabs",
  SCREEN_PANEL_ENABLED: "ceScreenPanelEnabled",
  SCREEN_PANEL_GRID_SNAP: "ceScreenPanelGridSnap",
  ATTR_PATH_HELPER: "ceAttrPathHelper",
  ATTR_PATH_HELPER_SOURCE: "ceAttrPathHelperSource",
  COMBAT_TRACKER_ENABLED: "ceCombatTrackerEnabled",
  COMBAT_TRACKER_PORTRAIT_SIZE: "ceCombatTrackerPortraitSize",
  COMBAT_TRACKER_SHOW_HP: "ceCombatTrackerShowHp",
  COMBAT_TRACKER_ASPECT: "ceCombatTrackerAspect",
  COMBAT_TRACKER_ROUNDNESS: "ceCombatTrackerRoundness",
  COMBAT_TRACKER_ALIGNMENT: "ceCombatTrackerAlignment",
  COMBAT_TRACKER_PORTRAIT_IMAGE: "ceCombatTrackerPortraitImage",
  COMBAT_TRACKER_SHOW_INITIATIVE: "ceCombatTrackerShowInitiative",
  COMBAT_TRACKER_SHOW_DISPOSITION: "ceCombatTrackerShowDisposition",
  COMBAT_TRACKER_HIDE_DEFEATED: "ceCombatTrackerHideDefeated",
  TOKEN_GLOW_ENABLED: "ceTokenGlowEnabled",
  TOKEN_GLOW_HOVER: "ceTokenGlowHover",
  TOKEN_GLOW_STRENGTH: "ceTokenGlowStrength",
  TOKEN_GLOW_TARGET: "ceTokenGlowTarget",
  TOKEN_GLOW_SIGHTLINE: "ceTokenGlowSightline",
  TOKEN_CONFIG_TWO_COLUMN: "ceTokenConfigTwoColumn",
  TOKEN_SYNC_NAME: "ceTokenSyncName",
  TOKEN_SYNC_PLACED_NAME: "ceTokenSyncPlacedName",
  // Music: players upload audio (GM-proxied) into their own personal playlist.
  MUSIC_ENABLED: "ceMusicEnabled",
  MUSIC_PLAYLIST_NAME: "ceMusicPlaylistName",
  MUSIC_UPLOAD_ROOT: "ceMusicUploadRoot",
  MUSIC_MAX_MB: "ceMusicMaxUploadMB",
};

const FE_EXPORT_PRINT_IMAGE_MODE_CHOICES = Object.freeze({
  full: "그대로(고품질/대용량)",
  hideAvatars: "아바타/포트레이트 숨김(권장)",
  hideAll: "모든 이미지 숨김(최대 안정)",
  downscaleLite: "이미지 다운스케일(완화/품질 우선)",
  downscale: "이미지 다운스케일(실험적)",
});

// Defaults baked from the dosukebe dnd5e world's live female_edition settings
// (2026-06-23). These are the module's shipped defaults — a fresh world / new
// install starts with this exact configuration.
const FE_DEFAULTS = {
  [S.MERGE_ENABLED]: true,
  [S.MERGE_ONLY_TEXT]: false,
  [S.MERGE_INCLUDE_ROLL_MESSAGES]: true,
  [S.MERGE_DIVIDER]: false,
  [S.MERGE_GROUP_SPACING]: 0,
  [S.MERGE_MODE]: "standard",
  [S.MERGE_FOLLOW_HEADER_STYLE]: "hide",
  [S.MERGE_SPEAKER_BASIS]: "actor",
  [S.EXPORT_ENABLED]: true,
  [S.EXPORT_AUTO_PRINT]: false,
  [S.EXPORT_OPTIMIZE]: true,
  [S.EXPORT_EMBED_FONTS]: true,
  [S.EXPORT_EMBED_IMAGES]: true,
  [S.EXPORT_EXCLUDE_WHISPERS]: false,
  [S.EXPORT_PRINT_IMAGE_MODE]: "downscaleLite",
  [S.EXPORT_DESKTOP_EXTERNAL_MODE]: "button",
  [S.CHAT_FONT_CHOICE]: "cookie",
  [S.UI_USE_GEURIMILGI]: true,
  [S.UI_USE_USER_FONT]: false,
  [S.USER_FONT_FAMILY]: "",
  [S.CANVAS_TEXT_FONT]: true,
  [S.UI_ENABLE_FONTS]: true,
  [S.UI_RETRO_THEME]: false,
  [S.UI_HIDE_PORTRAITS]: true,
  [S.UI_STRIP_TEXTURES]: true,
  [S.USE_USER_COLOR_BG]: true,
  [S.USER_COLOR_BG_BASE]: "custom",
  [S.USER_COLOR_BG_CUSTOM]: "#ffffff",
  [S.USER_COLOR_ALPHA]: 0.22,
  [S.SYSTEM_MSG_COLOR]: false,
  [S.SYSTEM_MSG_BG_ENABLED]: false,
  [S.SYSTEM_MSG_BG_COLOR]: "#ffffff",
  [S.FORCE_NORMAL_MSG_COLOR]: false,
  [S.CHAT_GROUP_OUTLINE]: false,
  [S.ACCENT_TEXT_OVERRIDE]: false,
  [S.STYLE_ACTOR_NAME_SIZE]: 18,
  [S.STYLE_PLAYER_NAME_SIZE]: 12,
  [S.STYLE_MESSAGE_TEXT_SIZE]: 14,
  [S.STYLE_CHATCARD_TEXT_SIZE]: 12,
  [S.STYLE_BG_SATURATION]: 0.5,
  [S.STYLE_PAPER_OVERLAY_ENABLED]: false,
  [S.STYLE_CHAT_MESSAGE_SPACING]: 3,
  [S.STYLE_HEADER_CONTENT_GAP]: 4,
  [S.MERGE_INNER_GAP]: 4,
  [S.MARKDOWN_ENABLED]: true,
  [S.EDIT_ENABLED]: true,
  [S.GM_PRIORITY_ENABLED]: true,
  [S.GM_SPEAK_AS_SELF]: false,
  [S.DX3RD_RUI_ENABLED]: true,
  [S.DX3RD_RUI_VISIBLE]: true,
  [S.DX3RD_RUI_PORTRAIT_WIDTH]: 100,
  [S.DX3RD_RUI_PANEL_WIDTH]: 128,
  [S.DX3RD_RUI_CARD_HEIGHT]: 80,
  [S.DX3RD_CARD_BORDER_ALPHA]: 0.7,
  [S.DX3RD_PIXEL_ACCENT]: "#ffffff",
  [S.PRUNE_ENABLED]: true,
  [S.PRUNE_MAX_MESSAGES]: 60,
  [S.TYPING_ENABLED]: true,
  [S.TYPING_SHOW_TO_PLAYERS]: true,
  [S.SC_COLLAPSE_ENABLED]: false,
  [S.SCREEN_PANEL_ENABLED]: true,
  [S.SCREEN_PANEL_GRID_SNAP]: false,
  [S.ATTR_PATH_HELPER]: true,
  [S.ATTR_PATH_HELPER_SOURCE]: true,
  [S.COMBAT_TRACKER_ENABLED]: true,
  [S.COMBAT_TRACKER_PORTRAIT_SIZE]: 88,
  [S.COMBAT_TRACKER_SHOW_HP]: false,
  [S.COMBAT_TRACKER_ASPECT]: "1",
  [S.COMBAT_TRACKER_ROUNDNESS]: "8",
  [S.COMBAT_TRACKER_ALIGNMENT]: "center",
  [S.COMBAT_TRACKER_PORTRAIT_IMAGE]: "actor",
  [S.COMBAT_TRACKER_SHOW_INITIATIVE]: true,
  [S.COMBAT_TRACKER_SHOW_DISPOSITION]: true,
  [S.COMBAT_TRACKER_HIDE_DEFEATED]: false,
  [S.TOKEN_GLOW_ENABLED]: true,
  [S.TOKEN_GLOW_HOVER]: true,
  [S.TOKEN_GLOW_STRENGTH]: 5,
  [S.TOKEN_GLOW_TARGET]: true,
  [S.TOKEN_GLOW_SIGHTLINE]: true,
  [S.TOKEN_CONFIG_TWO_COLUMN]: true,
  [S.CORE_UI_TOKEN_PREVIEW]: true,
  [S.CORE_UI_FILEPICKER_ENHANCEMENTS]: true,
  [S.CORE_UI_SCENE_CONFIG_TABS]: true,
  [S.TOKEN_SYNC_NAME]: true,
  [S.TOKEN_SYNC_PLACED_NAME]: false,
  [S.MUSIC_ENABLED]: true,
  [S.MUSIC_PLAYLIST_NAME]: "player-uploads",
  [S.MUSIC_UPLOAD_ROOT]: "assets/uploadedmusic",
  [S.MUSIC_MAX_MB]: 20,
};

const FE_GM_PRIORITY_OVERRIDES_KEY = "feGmPriorityOverrides";

// Per-client backup of each player's OWN value for a setting, captured the first
// time that key is about to be overwritten by a GM-priority force-sync. Lets us
// fully restore a player's personal values when "GM 설정 전역 강제" is turned OFF,
// so disabling enforcement leaves nothing forced behind. Client-scope; cleared
// after a restore.
const FE_GM_PRIORITY_BACKUP_KEY = "feGmPriorityBackup";

// Per-world settings store. A single client-scope Object holding
// { [worldId]: { [settingKey]: value } }. Client settings in Foundry are stored
// in localStorage per browser origin WITHOUT a world id, so they are shared
// across every world on the same server. This store re-namespaces them by world
// id so each world keeps an independent copy of the user's preferences.
const FE_WORLD_SETTINGS_KEY = "feWorldSettings";

// Keys NEVER forced by "GM 설정 전역 강제" (feSeedGmPriorityOverridesFromLocal
// seeds EVERY other client-scope module setting, so anything NOT listed here IS
// forced onto all players when GM priority is enabled). Policy (per request): when
// GM priority is ON, almost everything is forced — the GM turns the whole feature
// OFF if they want players to keep personal taste. Only THREE categories stay
// personal regardless:
//   1. 커스텀 폰트 유무 (UI_ENABLE_FONTS) + 유저 로컬 폰트(UI_USE_USER_FONT/
//      USER_FONT_FAMILY) — opt-in per player (glyph/icon breakage risk; the user
//      font depends on what is actually installed on each client)
//   2. 채팅 아카이브 / 내보내기 (EXPORT_*) — output preference
//   3. 툴바 접기 (SC_COLLAPSE_ENABLED) — personal toolbar layout
// GM_PRIORITY_ENABLED is a world-scope sentinel; GM_SPEAK_AS_SELF is GM-only and
// client-scoped so each GM can keep their own speaker behavior. Neither is
// client-forced.
const FE_GM_PRIORITY_EXCLUDED_KEYS = new Set([
  // 채팅 아카이브 / 내보내기 — output preference, always personal.
  S.EXPORT_ENABLED,
  S.EXPORT_AUTO_PRINT,
  S.EXPORT_OPTIMIZE,
  S.EXPORT_EMBED_FONTS,
  S.EXPORT_EMBED_IMAGES,
  S.EXPORT_EXCLUDE_WHISPERS,
  S.EXPORT_PRINT_IMAGE_MODE,
  S.EXPORT_DESKTOP_EXTERNAL_MODE,
  // 커스텀 폰트 유무 — players opt in individually.
  S.UI_ENABLE_FONTS,
  // 유저(로컬/모듈 폴더) 폰트 — 각 클라이언트에 실제 설치/존재하는
  // 폰트에 의존하므로
  // GM이 강제하면 폰트가 없는 플레이어는 깨진다. 항상 개인 설정으로 유지.
  S.UI_USE_USER_FONT,
  S.USER_FONT_FAMILY,
  // 툴바 접기 — personal toolbar preference.
  S.SC_COLLAPSE_ENABLED,
  // World-scope sentinels (never client-forced anyway).
  S.GM_PRIORITY_ENABLED,
  S.GM_SPEAK_AS_SELF,
]);

const FE_RENDER_STATE_FLAG = "renderState";
const FE_RENDER_SPECIAL_KIND_FLAG = "specialKind";
const FE_RENDER_MERGE_HINT_FLAG = "mergeHint";
const FE_RENDER_STATE_VERSION = 4;

const FE_TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;

const FE_MERGE_CLASS_LIST = ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"];
const FE_MERGE_CLASS_SORTED = ["fe-divider-before", "fe-merge-end", "fe-merge-follow", "fe-merge-mid", "fe-merge-start"];

export {
  MODULE_ID,
  LEGACY_UI_FONT_KEY,
  S,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_DEFAULTS,
  FE_GM_PRIORITY_OVERRIDES_KEY,
  FE_GM_PRIORITY_BACKUP_KEY,
  FE_WORLD_SETTINGS_KEY,
  FE_GM_PRIORITY_EXCLUDED_KEYS,
  FE_RENDER_STATE_FLAG,
  FE_RENDER_SPECIAL_KIND_FLAG,
  FE_RENDER_MERGE_HINT_FLAG,
  FE_RENDER_STATE_VERSION,
  FE_TEX_RE,
  FE_MERGE_CLASS_LIST,
  FE_MERGE_CLASS_SORTED,
};
