// Female-cupwhi: Unified settings menu (collapsible sections)
// This dialog is the primary UI because individual settings are hidden from core Module Settings.

import { MODULE_ID, S, FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES, feSetting, feCaptureWorldSettings } from "./fe-chat-enhance.js";
import { feRegisterModuleFolderFonts, feQueryLocalFonts, feLocalFontsSupported } from "./fe-user-font.js";

// ── Portrait settings (registered by fe-chat-portrait.js under MODULE_ID) ──

const CP = Object.freeze({
  ENABLED:        "chatPortraitEnabled",
  HIDE_WRAP:      "chatPortraitHideWrap",
  USE_TOKEN:      "chatPortraitUseTokenImage",
  SIZE:           "chatPortraitSize",
  CARD_ICON_SIZE: "chatPortraitCardIconSize",
  SHAPE:          "chatPortraitShape",
  BORDER_MODE:    "chatPortraitBorderMode",
  BORDER_WIDTH:   "chatPortraitBorderWidth",
  BORDER_COLOR:   "chatPortraitBorderColor",
  NAME_ALIGN:     "chatPortraitNameAlign",
  SHOW_IC:        "chatPortraitShowIC",
  SHOW_OOC:       "chatPortraitShowOOC",
  SHOW_EMOTE:     "chatPortraitShowEmote",
  SHOW_WHISPER:   "chatPortraitShowWhisper",
  SHOW_ROLL:      "chatPortraitShowRoll",
  SHOW_OTHER:     "chatPortraitShowOther",
});

const CP_DEFAULTS = Object.freeze({
  [CP.ENABLED]:        true,
  [CP.HIDE_WRAP]:      false,
  [CP.USE_TOKEN]:      false,
  [CP.SIZE]:           64,
  [CP.CARD_ICON_SIZE]: 36,
  [CP.SHAPE]:          "none",
  [CP.BORDER_MODE]:    "none",
  [CP.BORDER_WIDTH]:   0,
  [CP.BORDER_COLOR]:   "#000000",
  [CP.NAME_ALIGN]:     "left",
  [CP.SHOW_IC]:        true,
  [CP.SHOW_OOC]:       true,
  [CP.SHOW_EMOTE]:     true,
  [CP.SHOW_WHISPER]:   true,
  [CP.SHOW_ROLL]:      true,
  [CP.SHOW_OTHER]:     true,
});

// Keys whose effect only lands after a page reload. Core's own `requiresReload: true` is
// INERT for this module — SettingsConfig reads it only in its own submit handler
// (client/applications/settings/config.mjs:257) and every one of our settings is
// `config: false`, saved through this custom menu, so core never sees them. THIS LIST is
// what actually produces the prompt (#applyValues). A key carrying `requiresReload` but
// missing from here gets no prompt at all — which is exactly how the combat tracker and
// the music feature ended up silently doing nothing until the user happened to reload.
//
// Membership means: the feature's install work happens once, at `init`/`ready`, behind a
// gate that already returned. Per key:
//   - CORE_UI_SCENE_CONFIG_TABS — SceneConfig.DEFAULT_OPTIONS.position.width is raised at
//     `init`, and a Document caches its sheet instance while AppV2 freezes options at
//     construction, so an already-opened scene keeps the old width forever.
//   - SCREEN_PANEL_ENABLED — the panel feature draws PIXI overlays into canvas.primary,
//     rewrites placeable sizes through updateSource, and subtracts from core's computed
//     visibility with no restore branch (deliberate — see docs/screen-panel.md); unwinding
//     that live would mean a canvas.draw() on every connected client, i.e. the same
//     disruption as a reload with less predictability.
//   - COMBAT_TRACKER_ENABLED — the `ready` block that builds the root, binds the socket and
//     registers ~10 combat hooks bails early when off, so ON needs a reload. (OFF alone does
//     not: feCtTeardown clears the DOM live, and every hook funnels back through feCtRender's
//     own gate. Prompting both ways is the honest simplification — declining leaves a clean
//     screen either way.)
//   - MUSIC_ENABLED — same shape: `init` skips registerSidebarButton/registerPlaylistSeekControls
//     and `ready` skips registerSocket/registerDeleteGuards/registerLiveRefresh, so turning it
//     on without a reload leaves the feature entirely absent.
//   - PRUNE_ENABLED — feInstallChatLogPrune (called from fe-chat-enhance's `init`) reads the key
//     exactly ONCE, at fe-chat-prune.js:24, and returns before subclassing CONFIG.ui.chat. So ON
//     never installs the subclass and OFF leaves the installed one pruning forever — BOTH
//     directions are reload-only. (Its sibling PRUNE_MAX_MESSAGES is read per-call and IS live;
//     the asymmetry is why this one was easy to miss.) Client-scope → world:false → the prompt
//     reloads only the person who changed it, which is right for a local preference.
//   - injectCustomConditions / injectCustomDamageTypes — both write straight into CONFIG.DND5E
//     during `init` behind a gate that already returned (inject-conditions.js:87,
//     inject-damage-type.js:65), and neither has a removal branch, so OFF also only lands on
//     reload. World-scope → world:true → the reload broadcasts, which is correct for a CONFIG
//     change everyone shares. Registered even on non-dnd5e worlds (inject-conditions registers
//     before its CONFIG.DND5E check), but #applyValues only saves them under
//     `feIsDnd5eSystem() && isGM`, so elsewhere the value cannot move and no prompt fires.
const FE_RELOAD_REQUIRED_KEYS = Object.freeze([
  S.CORE_UI_SCENE_CONFIG_TABS,
  S.SCREEN_PANEL_ENABLED,
  S.COMBAT_TRACKER_ENABLED,
  S.MUSIC_ENABLED,
  S.PRUNE_ENABLED,
  "injectCustomConditions",
  "injectCustomDamageTypes",
]);

// Combined fallback table: fe-chat-enhance defaults + portrait defaults + DND5e injection defaults.
const ALL_DEFAULTS = Object.freeze({
  ...FE_DEFAULTS,
  ...CP_DEFAULTS,
  injectCustomConditions:  false,
  injectCustomDamageTypes: true,
  // dnd5e custom damage-type name slots (registered by inject-damage-type.js)
  dmgCustom1: "1", dmgCustom2: "2", dmgCustom3: "3", dmgCustom4: "4",
  dmgCustom5: "5", dmgCustom6: "6", dmgCustom7: "7", dmgCustom8: "8",
  // Standalone-module settings migrated into the unified menu.
  chatImagesEnabled: true,
  chatImagesShowButton: true,
  chatImagesUploadLocation: "uploaded-chat-images",
  // image-hover (world/GM: permission/art; client: enable/pos/size/delay/upscale)
  ihPermission: 0, ihArtType: "character",
  ihEnabled: true, ihPosition: "Bottom left", ihSize: 3, ihSizeWide: 1.225, ihDelay: 0, ihMaxUpscale: 0,
  // narrator (all world/GM)
  narratorEnabled: true, narratorDurationMult: 1,
  narratorAllowCopy: true, narratorPermNarrate: 4, narratorPermDescribe: 4, narratorPermAs: 4,
  // theatre (5 world/GM + 6 client)
  stageEnabled: true, stageExcludeSystemMessages: true,
  stageRecallIncludeNonActor: false,
  stageAutoDecay: false, stageDecayTime: 30000,
  stagePortraitHeight: 318, stageBoxWidth: 764, stageBoxHeight: 176,
  stageBoxBottom: 30, stageBoxLeft: 392, stageTextSize: 14,
});

// ── Template choice lists (static — defined once, not rebuilt per getData call) ──

const CHOICES = {
  mergeMode: {
    standard: "표준(경계/간격까지 묶기)",
    simple:   "간소화(후속 헤더만 숨김)",
  },
  mergeFollowHeaderStyle: {
    hide:     "헤더 완전 숨김",
    name:     "이름만 남김",
    portrait: "포트레이트만 남김",
  },
  mergeSpeakerBasis: {
    token:  "토큰(기본) — 토큰+액터+씬 모두 일치",
    actor:  "액터 — 같은 액터면 병합",
    author: "플레이어(작성자) — 같은 유저면 병합",
  },
  exportPrintImageMode: FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  chatFontChoice: {
    cookie:     "쿠키런 + 그림일기",
    cookieAll:  "쿠키런",
    geurimilgi: "그림일기",
    neodgm:     "NeoDGM",
    mona:       "Mona10(웹폰트)",
    galmuri:    "갈무리11(웹폰트)",
  },
  userColorBgBase: {
    white:  "흰색(권장)",
    black:  "검정",
    none:   "사용 안 함(기존 방식)",
    custom: "사용자 지정 색상",
  },
  portraitShape: {
    circle: "원형",
    square: "사각형",
    none:   "미적용(자르지 않음)",
  },
  portraitBorderMode: {
    theme:  "테마/기본값",
    none:   "없음",
    user:   "플레이어 색상",
    custom: "사용자 지정",
  },
  portraitNameAlign: {
    center: "가운데",
    left:   "좌측",
  },
  // image-hover
  ihPermission: { 0: "없음", 1: "제한됨", 2: "관찰자", 3: "소유자" },
  ihArtType: {
    character: "캐릭터 아트",
    token:     "토큰 아트",
    wildcard:  "와일드카드일 때 토큰 아트",
    linked:    "연결 해제된 토큰일 때 토큰 아트",
  },
  ihPosition: {
    "Bottom left":  "왼쪽 아래",
    "Bottom right": "오른쪽 아래",
    "Top left":     "왼쪽 위",
    "Top right":    "오른쪽 위",
    Centre:         "중앙",
  },
  // narrator command permission (USER_ROLES)
  narratorRole: { 0: "없음", 1: "플레이어", 2: "신뢰 플레이어", 3: "어시스턴트 GM", 4: "게임마스터" },
  // combat tracker
  combatTrackerAspect:    { "1": "정사각형", "1.5": "세로형", "2": "긴 세로형" },
  combatTrackerRoundness: { "0": "각짐", "8": "약간 둥글게", "16": "둥글게" },
  combatTrackerAlignment: { left: "왼쪽", center: "가운데", right: "오른쪽" },
  combatTrackerImage:     { actor: "액터 이미지", token: "토큰 이미지" },
};

// ── Helpers ──

function feRead(key) {
  try { return feSetting(key) ?? ALL_DEFAULTS[key]; } catch { return ALL_DEFAULTS[key]; }
}

function feIsChatPortraitModuleActive() {
  try { return !!game?.modules?.get?.("chat-portrait")?.active; } catch { return false; }
}

function feIsDx3rdSystem() {
  try { return ["dx3rd-emanim", "double-cross-3rd"].includes(game?.system?.id); } catch { return false; }
}

function feIsDnd5eSystem() {
  try { return game?.system?.id === "dnd5e"; } catch { return false; }
}

const FE_SM_TAB_STORE = `${MODULE_ID}:settings-menu:active-tab`;

// ── Settings dialog (ApplicationV2) ──

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class FemaleEditionSettingsMenu extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "fe-settings-menu",
    classes: ["fe-settings-menu"],
    window: {
      title: "Female-cupwhi 설정",
      icon: "fas fa-sliders-h",
      resizable: true,
    },
    position: { width: 740, height: "auto" },
    actions: {
      feSave: FemaleEditionSettingsMenu.#onSaveAction,
      feResetDefaults: FemaleEditionSettingsMenu.#onResetDefaults,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/fe-settings-menu.hbs` },
  };

  async _prepareContext(options = {}) {
    const context = await super._prepareContext(options);
    const values = {
      // Base toggles
      [S.PRUNE_ENABLED]:       feRead(S.PRUNE_ENABLED),
      [S.PRUNE_MAX_MESSAGES]:  feRead(S.PRUNE_MAX_MESSAGES),
      [S.TYPING_ENABLED]:          feRead(S.TYPING_ENABLED),
      [S.TYPING_SHOW_TO_PLAYERS]:  feRead(S.TYPING_SHOW_TO_PLAYERS),
      [S.UI_ENABLE_FONTS]:   feRead(S.UI_ENABLE_FONTS),
      [S.UI_HIDE_PORTRAITS]: feRead(S.UI_HIDE_PORTRAITS),
      [S.UI_STRIP_TEXTURES]: feRead(S.UI_STRIP_TEXTURES),
      [S.SC_COLLAPSE_ENABLED]: feRead(S.SC_COLLAPSE_ENABLED),
      [S.CORE_UI_TOKEN_PREVIEW]: feRead(S.CORE_UI_TOKEN_PREVIEW),
      [S.CORE_UI_FILEPICKER_ENHANCEMENTS]: feRead(S.CORE_UI_FILEPICKER_ENHANCEMENTS),
      [S.CORE_UI_SCENE_CONFIG_TABS]: feRead(S.CORE_UI_SCENE_CONFIG_TABS),
      [S.TOKEN_CONFIG_TWO_COLUMN]: feRead(S.TOKEN_CONFIG_TWO_COLUMN),
      [S.TOKEN_SYNC_NAME]: feRead(S.TOKEN_SYNC_NAME),
      [S.TOKEN_SYNC_PLACED_NAME]: feRead(S.TOKEN_SYNC_PLACED_NAME),

      // Merge
      [S.MERGE_ENABLED]:               feRead(S.MERGE_ENABLED),
      [S.MERGE_ONLY_TEXT]:             feRead(S.MERGE_ONLY_TEXT),
      [S.MERGE_INCLUDE_ROLL_MESSAGES]: feRead(S.MERGE_INCLUDE_ROLL_MESSAGES),
      [S.MERGE_DIVIDER]:               feRead(S.MERGE_DIVIDER),
      [S.MERGE_GROUP_SPACING]:         feRead(S.MERGE_GROUP_SPACING),
      [S.MERGE_MODE]:                  feRead(S.MERGE_MODE),
      [S.MERGE_FOLLOW_HEADER_STYLE]:   feRead(S.MERGE_FOLLOW_HEADER_STYLE),
      [S.MERGE_SPEAKER_BASIS]:         feRead(S.MERGE_SPEAKER_BASIS),

      // Export
      [S.EXPORT_ENABLED]:               feRead(S.EXPORT_ENABLED),
      [S.EXPORT_AUTO_PRINT]:            feRead(S.EXPORT_AUTO_PRINT),
      [S.EXPORT_OPTIMIZE]:              feRead(S.EXPORT_OPTIMIZE),
      [S.EXPORT_EMBED_FONTS]:           feRead(S.EXPORT_EMBED_FONTS),
      [S.EXPORT_EMBED_IMAGES]:          feRead(S.EXPORT_EMBED_IMAGES),
      [S.EXPORT_EXCLUDE_WHISPERS]:      feRead(S.EXPORT_EXCLUDE_WHISPERS),
      [S.EXPORT_PRINT_IMAGE_MODE]:      feRead(S.EXPORT_PRINT_IMAGE_MODE),

      // Fonts
      [S.CHAT_FONT_CHOICE]:         feRead(S.CHAT_FONT_CHOICE),
      [S.UI_USE_GEURIMILGI]:        feRead(S.UI_USE_GEURIMILGI),
      [S.UI_USE_USER_FONT]:         feRead(S.UI_USE_USER_FONT),
      [S.USER_FONT_FAMILY]:         feRead(S.USER_FONT_FAMILY),
      [S.CANVAS_TEXT_FONT]:         feRead(S.CANVAS_TEXT_FONT),
      [S.CANVAS_DRAWING_FONT]:      feRead(S.CANVAS_DRAWING_FONT),

      // Style vars
      [S.STYLE_CHAT_MESSAGE_SPACING]: feRead(S.STYLE_CHAT_MESSAGE_SPACING),
      [S.STYLE_HEADER_CONTENT_GAP]:   feRead(S.STYLE_HEADER_CONTENT_GAP),
      [S.MERGE_INNER_GAP]:            feRead(S.MERGE_INNER_GAP),
      [S.STYLE_BG_SATURATION]:        feRead(S.STYLE_BG_SATURATION),
      [S.STYLE_PAPER_OVERLAY_ENABLED]: feRead(S.STYLE_PAPER_OVERLAY_ENABLED),
      [S.STYLE_ACTOR_NAME_SIZE]:      feRead(S.STYLE_ACTOR_NAME_SIZE),
      [S.STYLE_PLAYER_NAME_SIZE]:     feRead(S.STYLE_PLAYER_NAME_SIZE),
      [S.STYLE_MESSAGE_TEXT_SIZE]:    feRead(S.STYLE_MESSAGE_TEXT_SIZE),
      [S.STYLE_CHATCARD_TEXT_SIZE]:   feRead(S.STYLE_CHATCARD_TEXT_SIZE),

      // User-color tint
      [S.USE_USER_COLOR_BG]:  feRead(S.USE_USER_COLOR_BG),
      [S.USER_COLOR_BG_BASE]: feRead(S.USER_COLOR_BG_BASE),
      [S.USER_COLOR_BG_CUSTOM]: feRead(S.USER_COLOR_BG_CUSTOM),
      [S.USER_COLOR_ALPHA]:   feRead(S.USER_COLOR_ALPHA),
      [S.SYSTEM_MSG_COLOR]:   feRead(S.SYSTEM_MSG_COLOR),
      [S.SYSTEM_MSG_BG_ENABLED]: feRead(S.SYSTEM_MSG_BG_ENABLED),
      [S.SYSTEM_MSG_BG_COLOR]: feRead(S.SYSTEM_MSG_BG_COLOR),
      [S.FORCE_NORMAL_MSG_COLOR]: feRead(S.FORCE_NORMAL_MSG_COLOR),
      [S.CHAT_GROUP_OUTLINE]: feRead(S.CHAT_GROUP_OUTLINE),
      [S.ACCENT_TEXT_OVERRIDE]: feRead(S.ACCENT_TEXT_OVERRIDE),

      // Markdown / Edit
      [S.MARKDOWN_ENABLED]: feRead(S.MARKDOWN_ENABLED),
      [S.EDIT_ENABLED]:     feRead(S.EDIT_ENABLED),

      // GM priority
      [S.GM_PRIORITY_ENABLED]: feRead(S.GM_PRIORITY_ENABLED),
      [S.GM_SPEAK_AS_SELF]:    feRead(S.GM_SPEAK_AS_SELF),

      // DND5e injection
      injectCustomConditions:  feRead("injectCustomConditions"),
      injectCustomDamageTypes: feRead("injectCustomDamageTypes"),
      dmgCustom1: feRead("dmgCustom1"), dmgCustom2: feRead("dmgCustom2"),
      dmgCustom3: feRead("dmgCustom3"), dmgCustom4: feRead("dmgCustom4"),
      dmgCustom5: feRead("dmgCustom5"), dmgCustom6: feRead("dmgCustom6"),
      dmgCustom7: feRead("dmgCustom7"), dmgCustom8: feRead("dmgCustom8"),

      // Chat images (standalone module — migrated to unified menu)
      chatImagesEnabled:        feRead("chatImagesEnabled"),
      chatImagesShowButton:     feRead("chatImagesShowButton"),
      chatImagesUploadLocation: feRead("chatImagesUploadLocation"),

      // Image Hover (standalone — migrated)
      ihPermission:   feRead("ihPermission"),
      ihArtType:      feRead("ihArtType"),
      ihEnabled:      feRead("ihEnabled"),
      ihPosition:     feRead("ihPosition"),
      ihSize:         feRead("ihSize"),
      ihSizeWide:     feRead("ihSizeWide"),
      ihDelay:        feRead("ihDelay"),
      ihMaxUpscale:   feRead("ihMaxUpscale"),

      // Narrator (standalone — migrated; all world/GM)
      narratorEnabled:      feRead("narratorEnabled"),
      narratorDurationMult: feRead("narratorDurationMult"),
      narratorAllowCopy:    feRead("narratorAllowCopy"),
      narratorPermNarrate:  feRead("narratorPermNarrate"),
      narratorPermDescribe: feRead("narratorPermDescribe"),
      narratorPermAs:       feRead("narratorPermAs"),

      // Theatre / Stage (standalone — migrated)
      stageEnabled:        feRead("stageEnabled"),
      stageExcludeSystemMessages: feRead("stageExcludeSystemMessages"),
      stageRecallIncludeNonActor: feRead("stageRecallIncludeNonActor"),
      stageAutoDecay:      feRead("stageAutoDecay"),
      stageDecayTime:      feRead("stageDecayTime"),
      stagePortraitHeight: feRead("stagePortraitHeight"),
      stageBoxWidth:       feRead("stageBoxWidth"),
      stageBoxHeight:      feRead("stageBoxHeight"),
      stageBoxBottom:      feRead("stageBoxBottom"),
      stageBoxLeft:        feRead("stageBoxLeft"),
      stageTextSize:       feRead("stageTextSize"),

      // Screen Panel (standalone — migrated; world/GM, requiresReload)
      [S.SCREEN_PANEL_ENABLED]: feRead(S.SCREEN_PANEL_ENABLED),
      // Screen Panel grid-snap (client-scoped; GM-priority-forced unless excluded)
      [S.SCREEN_PANEL_GRID_SNAP]: feRead(S.SCREEN_PANEL_GRID_SNAP),
      // Attribute name helper (client-scoped; GM-priority-forced unless excluded)
      [S.ATTR_PATH_HELPER]: feRead(S.ATTR_PATH_HELPER),
      [S.ATTR_PATH_HELPER_SOURCE]: feRead(S.ATTR_PATH_HELPER_SOURCE),

      // Combat Tracker (world/GM: enabled + hide-defeated; client: the rest)
      [S.COMBAT_TRACKER_ENABLED]:         feRead(S.COMBAT_TRACKER_ENABLED),
      [S.COMBAT_TRACKER_HIDE_DEFEATED]:   feRead(S.COMBAT_TRACKER_HIDE_DEFEATED),
      [S.COMBAT_TRACKER_PORTRAIT_SIZE]:   feRead(S.COMBAT_TRACKER_PORTRAIT_SIZE),
      [S.COMBAT_TRACKER_ASPECT]:          feRead(S.COMBAT_TRACKER_ASPECT),
      [S.COMBAT_TRACKER_ROUNDNESS]:       feRead(S.COMBAT_TRACKER_ROUNDNESS),
      [S.COMBAT_TRACKER_ALIGNMENT]:       feRead(S.COMBAT_TRACKER_ALIGNMENT),
      [S.COMBAT_TRACKER_PORTRAIT_IMAGE]:  feRead(S.COMBAT_TRACKER_PORTRAIT_IMAGE),
      [S.COMBAT_TRACKER_SHOW_INITIATIVE]: feRead(S.COMBAT_TRACKER_SHOW_INITIATIVE),
      [S.COMBAT_TRACKER_SHOW_DISPOSITION]:feRead(S.COMBAT_TRACKER_SHOW_DISPOSITION),
      [S.COMBAT_TRACKER_SHOW_HP]:         feRead(S.COMBAT_TRACKER_SHOW_HP),

      // Music (player audio upload — world/GM)
      [S.MUSIC_ENABLED]:         feRead(S.MUSIC_ENABLED),
      [S.MUSIC_PLAYLIST_NAME]:   feRead(S.MUSIC_PLAYLIST_NAME),
      [S.MUSIC_UPLOAD_ROOT]:     feRead(S.MUSIC_UPLOAD_ROOT),
      [S.MUSIC_MAX_MB]:          feRead(S.MUSIC_MAX_MB),

      // Token selection glow
      [S.TOKEN_GLOW_ENABLED]:   feRead(S.TOKEN_GLOW_ENABLED),
      [S.TOKEN_GLOW_HOVER]:     feRead(S.TOKEN_GLOW_HOVER),
      [S.TOKEN_GLOW_STRENGTH]:  feRead(S.TOKEN_GLOW_STRENGTH),
      [S.TOKEN_GLOW_TARGET]:    feRead(S.TOKEN_GLOW_TARGET),
      [S.TOKEN_GLOW_SIGHTLINE]: feRead(S.TOKEN_GLOW_SIGHTLINE),

      // Animated tile textures (gif/webp/apng)
      [S.ANIMATED_TILE_ENABLED]: feRead(S.ANIMATED_TILE_ENABLED),

      // Retro theme (general — all systems)
      [S.UI_RETRO_THEME]:           feRead(S.UI_RETRO_THEME),

      // DX3rd
      [S.DX3RD_CARD_BORDER_ALPHA]:  feRead(S.DX3RD_CARD_BORDER_ALPHA),
      // Status UI (dx3rd + dnd5e)
      [S.DX3RD_RUI_ENABLED]:        feRead(S.DX3RD_RUI_ENABLED),
      [S.DX3RD_RUI_VISIBLE]:        feRead(S.DX3RD_RUI_VISIBLE),
      [S.DX3RD_RUI_PORTRAIT_WIDTH]: feRead(S.DX3RD_RUI_PORTRAIT_WIDTH),
      [S.DX3RD_RUI_PANEL_WIDTH]:    feRead(S.DX3RD_RUI_PANEL_WIDTH),
      [S.DX3RD_RUI_CARD_HEIGHT]:    feRead(S.DX3RD_RUI_CARD_HEIGHT),

      // Chat portrait
      [CP.ENABLED]:        feRead(CP.ENABLED),
      [CP.HIDE_WRAP]:      feRead(CP.HIDE_WRAP),
      [CP.USE_TOKEN]:      feRead(CP.USE_TOKEN),
      [CP.SIZE]:           feRead(CP.SIZE),
      [CP.CARD_ICON_SIZE]: feRead(CP.CARD_ICON_SIZE),
      [CP.SHAPE]:          feRead(CP.SHAPE),
      [CP.BORDER_MODE]:    feRead(CP.BORDER_MODE),
      [CP.BORDER_WIDTH]:   feRead(CP.BORDER_WIDTH),
      [CP.BORDER_COLOR]:   feRead(CP.BORDER_COLOR),
      [CP.NAME_ALIGN]:     feRead(CP.NAME_ALIGN),
      [CP.SHOW_IC]:        feRead(CP.SHOW_IC),
      [CP.SHOW_OOC]:       feRead(CP.SHOW_OOC),
      [CP.SHOW_EMOTE]:     feRead(CP.SHOW_EMOTE),
      [CP.SHOW_WHISPER]:   feRead(CP.SHOW_WHISPER),
      [CP.SHOW_ROLL]:      feRead(CP.SHOW_ROLL),
      [CP.SHOW_OTHER]:     feRead(CP.SHOW_OTHER),
    };

    // Module font/-folder fonts (no permission needed). System fonts are loaded
    // on demand via the "시스템 폰트 불러오기" button in _onRender (user gesture).
    let userFontModuleList = [];
    try { userFontModuleList = await feRegisterModuleFolderFonts(); } catch { /* no-op */ }

    return {
      ...context,
      values,
      choices:  CHOICES,
      userFontModuleList,
      localFontsSupported: feLocalFontsSupported(),
      warnings: { chatPortraitDup: feIsChatPortraitModuleActive() },
      isGM:     !!game.user?.isGM,
      isDx3rd:  feIsDx3rdSystem(),
      isDnd5e:  feIsDnd5eSystem(),
      // Status UI (fe-dx3rd-resource-ui) works on both dx3rd and dnd5e.
      ruiSupported: feIsDx3rdSystem() || feIsDnd5eSystem(),
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);

    // Wire form submit manually — AppV2's built-in form infrastructure requires
    // tag:"form" or contentTag:"form" for this.form to return non-null, and
    // neither works reliably across v13+v14. Wiring here is version-agnostic.
    try {
      const form = this.element?.querySelector?.("form");
      if (form) {
        form.setAttribute("autocomplete", "off");
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          // Prefer the namespaced class (avoids v14's once-per-session deprecation
          // warning on the bare global); fall back to the bare global so any v13.x
          // without the ux namespace still works. Same pattern as FilePicker resolution.
          const FDE = foundry.applications.ux?.FormDataExtended ?? FormDataExtended;
          const formData = new FDE(form);
          await FemaleEditionSettingsMenu.#onSubmit.call(this, e, form, formData);
          await this.close();
        });
      }
    } catch { /* no-op */ }

    try { this.#wireTabs(); } catch { /* no-op */ }

    // Live value readout for range sliders: keep <span class="fe-range-value"
    // data-for="NAME"> in sync with its <input type="range" name="NAME">.
    try {
      for (const range of this.element?.querySelectorAll?.('input[type="range"]') ?? []) {
        const out = this.element.querySelector(`.fe-range-value[data-for="${range.name}"]`);
        if (!out) continue;
        const sync = () => { out.textContent = range.value; };
        sync();
        range.addEventListener("input", sync);
      }
    } catch { /* no-op */ }

    // User-font controls: dropdown replacement toggle, picker -> input, live
    // preview, and on-demand system-font enumeration.
    try { this.#wireUserFontControls(); } catch { /* no-op */ }

    // A disabled dependent control is omitted from FormData. Keep the UI and
    // the targeted save-preservation rules below in sync.
    try { this.#wireDependentControls(); } catch { /* no-op */ }
  }

  // Wires up the "폰트" section's user-font UI (added in fe-settings-menu.hbs):
  //   · the "유저 폰트 사용" checkbox shows the user-font row and hides the module
  //     font dropdown (and vice-versa);
  //   · the picker <select> writes into the ceUserFontFamily text input;
  //   · the preview box live-renders whatever family the text input holds;
  //   · the "시스템 폰트 불러오기" button enumerates installed fonts on click
  //     (a real user gesture, so the permission prompt only appears intentionally).
  #wireUserFontControls() {
    const root = this.element;
    if (!root) return;
    const enableToggle = root.querySelector('input[name="enableFonts"]');
    const useToggle = root.querySelector('input[name="ceUiUseUserFont"]');
    const moduleRow = root.querySelector(".fe-module-font-row");
    const userRow   = root.querySelector(".fe-user-font-row");
    const input     = root.querySelector('input[name="ceUserFontFamily"]');
    const picker    = root.querySelector("select.fe-user-font-picker");
    const sysGroup  = root.querySelector("optgroup.fe-user-font-system-group");
    const loadBtn   = root.querySelector("button.fe-load-system-fonts");
    const preview   = root.querySelector(".fe-user-font-preview");

    const applyVisibility = () => {
      const fontsEnabled = !!enableToggle?.checked;
      const userFontEnabled = !!useToggle?.checked;
      if (moduleRow) moduleRow.hidden = !fontsEnabled || userFontEnabled;
      if (userRow) userRow.hidden = !fontsEnabled || !userFontEnabled;
      if (useToggle) useToggle.disabled = !fontsEnabled;
      for (const field of moduleRow?.querySelectorAll("input, select, button, textarea") ?? []) {
        field.disabled = !fontsEnabled;
      }
      for (const field of userRow?.querySelectorAll("input, select, button, textarea") ?? []) {
        field.disabled = !fontsEnabled;
      }
    };
    const updatePreview = () => {
      if (!preview) return;
      const fam = String(input?.value ?? "").trim();
      preview.style.fontFamily = fam
        ? `${/["',]/.test(fam) ? fam : `"${fam}"`}, "FE CookieRun", sans-serif`
        : "";
    };

    enableToggle?.addEventListener("change", applyVisibility);
    useToggle?.addEventListener("change", applyVisibility);
    input?.addEventListener("input", updatePreview);
    picker?.addEventListener("change", () => {
      if (!picker.value) return;
      if (input) input.value = picker.value;
      updatePreview();
    });

    loadBtn?.addEventListener("click", async () => {
      loadBtn.disabled = true;
      const original = loadBtn.textContent;
      loadBtn.textContent = "불러오는 중…";
      try {
        const fonts = await feQueryLocalFonts();
        if (sysGroup) {
          sysGroup.replaceChildren();
          for (const { family, label } of fonts) {
            const opt = document.createElement("option");
            opt.value = family;
            opt.textContent = label;
            sysGroup.appendChild(opt);
          }
        }
        loadBtn.textContent = fonts.length ? `시스템 폰트 ${fonts.length}개` : "불러오기 실패/거부됨";
      } catch {
        loadBtn.textContent = "불러오기 실패";
      } finally {
        setTimeout(() => { loadBtn.disabled = false; loadBtn.textContent = original; }, 1500);
      }
    });

    applyVisibility();
    updatePreview();
  }

  // Keep a small, explicit list of settings whose subordinate value has no
  // effect until its controlling checkbox is enabled. Do not generalize this
  // into a convention: disabled form fields need matching save handling.
  #wireDependentControls() {
    const root = this.element;
    if (!root) return;
    const wire = (masterName, dependentNames) => {
      const master = root.querySelector(`[name="${masterName}"]`);
      const fields = dependentNames
        .map((name) => root.querySelector(`[name="${name}"]`))
        .filter(Boolean);
      if (!master || !fields.length) return;

      const sync = () => {
        const enabled = !!master.checked;
        for (const field of fields) {
          field.disabled = !enabled;
          field.closest(".form-group")?.classList.toggle("fe-setting-dependent-disabled", !enabled);
        }
      };
      master.addEventListener("change", sync);
      sync();
    };

    wire(S.ATTR_PATH_HELPER, [S.ATTR_PATH_HELPER_SOURCE]);
    wire("stageAutoDecay", ["stageDecayTime"]);
    wire(S.TOKEN_SYNC_NAME, [S.TOKEN_SYNC_PLACED_NAME]);
  }

  #wireTabs() {
    const root = this.element;
    const buttons = Array.from(root?.querySelectorAll?.("[data-fe-settings-tab-button]") ?? []);
    const panels = Array.from(root?.querySelectorAll?.("[data-fe-settings-tab]") ?? []);
    if (!buttons.length || !panels.length) return;

    const visibleButtons = buttons.filter((button) => {
      const tab = button.dataset.feSettingsTabButton;
      const available = panels.some((panel) => panel.dataset.feSettingsTab === tab);
      button.hidden = !available;
      return available;
    });
    if (!visibleButtons.length) return;

    const available = new Set(visibleButtons.map((button) => button.dataset.feSettingsTabButton));
    let active = "general";
    try { active = localStorage.getItem(FE_SM_TAB_STORE) || active; } catch { /* no-op */ }
    if (!available.has(active)) active = visibleButtons[0].dataset.feSettingsTabButton;

    const select = (tab) => {
      for (const button of buttons) {
        const selected = button.dataset.feSettingsTabButton === tab;
        button.classList.toggle("active", selected);
        button.setAttribute("aria-selected", String(selected));
      }
      for (const panel of panels) panel.hidden = panel.dataset.feSettingsTab !== tab;
      try { localStorage.setItem(FE_SM_TAB_STORE, tab); } catch { /* no-op */ }
    };

    for (const button of visibleButtons) {
      button.addEventListener("click", () => select(button.dataset.feSettingsTabButton));
    }
    select(active);
  }

  static async #onSaveAction(event, _target) {
    event.preventDefault();
    const form = this.element?.querySelector?.("form");
    if (!form) return;
    const FDE = foundry.applications.ux?.FormDataExtended ?? FormDataExtended;
    const formData = new FDE(form);
    await FemaleEditionSettingsMenu.#onSubmit.call(this, event, form, formData);
    await this.close();
  }

  // formData is a FormDataExtended; .object is the flat field map (data-dtype coerced).
  static async #onSubmit(_event, _form, formData) {
    const d = foundry.utils.expandObject(formData.object);
    await FemaleEditionSettingsMenu.#applyValues(d);
  }

  // Reset every setting to the module's own defaults (ALL_DEFAULTS), reusing the exact
  // same scope/permission gating as a normal save (non-GMs only reset their client-scope
  // keys; world/GM keys are left untouched). Then re-render so the fields show defaults.
  static async #onResetDefaults(event, _target) {
    event.preventDefault();
    const DialogV2 = foundry.applications.api.DialogV2;
    const ok = await DialogV2.confirm({
      window: { title: "기본값으로 되돌리기" },
      content: "<p>모든 Female-cupwhi 설정을 <b>모듈 기본값</b>으로 되돌릴까요?</p>"
        + "<p class=\"notes\">월드(GM) 설정은 GM만 되돌릴 수 있습니다. 일부 항목은 되돌린 뒤 새로고침이 필요할 수 있습니다.</p>",
      modal: true,
    }).catch(() => false);
    if (!ok) return;
    await FemaleEditionSettingsMenu.#applyValues({ ...ALL_DEFAULTS }, { resetDefaults: true });
    ui.notifications?.info("설정을 모듈 기본값으로 되돌렸습니다.");
    try { await this.render(); } catch { /* no-op */ }
  }

  // Writes a flat key→value map into game.settings with full scope/permission gating.
  // Shared by #onSubmit (form values) and #onResetDefaults (ALL_DEFAULTS).
  static async #applyValues(d, { resetDefaults = false } = {}) {
    // Fault-isolated writes. Each setter NEVER rejects: a single failing key
    // (unregistered on this core/version/system, validation error, permission)
    // must NOT abort the whole batch — otherwise the per-world capture below is
    // skipped and feHydrateWorldSettings silently reverts EVERY change on the next
    // reload (the long-standing "저장이 안 된다" recurrence). Unregistered keys are
    // skipped (some settings are conditionally registered per system/version, but
    // are still listed unconditionally below), failures are collected and surfaced.
    const failed = [];
    const has = (key) => { try { return game.settings.settings.has(`${MODULE_ID}.${key}`); } catch { return false; } };
    const setOne = async (key, value) => {
      if (!has(key)) return;
      try { await game.settings.set(MODULE_ID, key, value); }
      catch (err) { failed.push(key); console.warn(`[${MODULE_ID}] failed to save setting "${key}"`, err); }
    };
    const bool = (key) => setOne(key, !!d[key]);
    // Snapshot before the batch so we can tell whether a reload-only key actually
    // changed — prompting on every save would be noise.
    const reloadKeyBefore = new Map();
    for (const key of FE_RELOAD_REQUIRED_KEYS) {
      if (!has(key)) continue;
      try { reloadKeyBefore.set(key, game.settings.get(MODULE_ID, key)); } catch { /* no-op */ }
    }
    const num  = (key) => { const n = Number(d[key]); return setOne(key, Number.isFinite(n) ? n : ALL_DEFAULTS[key]); };
    const str  = (key) => setOne(key, d[key] == null ? ALL_DEFAULTS[key] : String(d[key]));
    const supplied = (key) => Object.prototype.hasOwnProperty.call(d, key);
    const fontsEnabled = !!d[S.UI_ENABLE_FONTS];
    const saveFontDependents = fontsEnabled || [
      S.CHAT_FONT_CHOICE, S.UI_USE_USER_FONT, S.USER_FONT_FAMILY, S.CANVAS_TEXT_FONT,
      S.CANVAS_DRAWING_FONT,
    ].some(supplied);
    const saveAttrSource = !!d[S.ATTR_PATH_HELPER] || supplied(S.ATTR_PATH_HELPER_SOURCE);
    const saveDecayTime = !!d.stageAutoDecay || supplied("stageDecayTime");
    const savePlacedTokenNameSync = !!d[S.TOKEN_SYNC_NAME] || supplied(S.TOKEN_SYNC_PLACED_NAME);
    const nextChatFontChoice = String(d[S.CHAT_FONT_CHOICE] ?? ALL_DEFAULTS[S.CHAT_FONT_CHOICE] ?? "cookie");

    try {
      // Save in parallel so the dialog closes in one round-trip instead of
      // sequential game.settings.set() calls. ceUiUseGeurimilgi is legacy/internal
      // state now and is derived from the mixed CookieRun + Geurimilgi preset.
      await Promise.all([
        // Base toggles
        bool(S.PRUNE_ENABLED), num(S.PRUNE_MAX_MESSAGES),
        bool(S.TYPING_ENABLED),
        // World-scoped (GM-only) typing visibility — non-GMs lack write permission
        ...(game.user?.isGM ? [bool(S.TYPING_SHOW_TO_PLAYERS)] : []),
        bool(S.UI_ENABLE_FONTS), bool(S.UI_HIDE_PORTRAITS), bool(S.UI_STRIP_TEXTURES),
        bool(S.SC_COLLAPSE_ENABLED),
        bool(S.CORE_UI_TOKEN_PREVIEW), bool(S.CORE_UI_FILEPICKER_ENHANCEMENTS),
        bool(S.CORE_UI_SCENE_CONFIG_TABS),
        bool(S.TOKEN_CONFIG_TWO_COLUMN),
        ...(game.user?.isGM ? [
          bool(S.TOKEN_SYNC_NAME),
          ...(savePlacedTokenNameSync ? [bool(S.TOKEN_SYNC_PLACED_NAME)] : []),
        ] : []),

        // Merge
        bool(S.MERGE_ENABLED), bool(S.MERGE_ONLY_TEXT), bool(S.MERGE_INCLUDE_ROLL_MESSAGES),
        bool(S.MERGE_DIVIDER), num(S.MERGE_GROUP_SPACING),
        str(S.MERGE_MODE), str(S.MERGE_FOLLOW_HEADER_STYLE), str(S.MERGE_SPEAKER_BASIS),

        // Markdown / Edit
        bool(S.MARKDOWN_ENABLED), bool(S.EDIT_ENABLED),

        // GM priority (world-scoped — non-GMs lack write permission)
        ...(game.user?.isGM ? [bool(S.GM_PRIORITY_ENABLED), bool(S.GM_SPEAK_AS_SELF)] : []),

        // Export
        bool(S.EXPORT_ENABLED), bool(S.EXPORT_AUTO_PRINT), bool(S.EXPORT_OPTIMIZE),
        bool(S.EXPORT_EMBED_FONTS), bool(S.EXPORT_EMBED_IMAGES),
        bool(S.EXPORT_EXCLUDE_WHISPERS),
        str(S.EXPORT_PRINT_IMAGE_MODE),
        // Hidden legacy preference: preserve it on ordinary saves, but honour
        // the reset action's promise to restore every registered setting.
        ...(resetDefaults ? [str(S.EXPORT_DESKTOP_EXTERNAL_MODE)] : []),

        // Fonts
        ...(saveFontDependents ? [
          str(S.CHAT_FONT_CHOICE),
          setOne(S.UI_USE_GEURIMILGI, nextChatFontChoice === "cookie"),
          bool(S.UI_USE_USER_FONT), str(S.USER_FONT_FAMILY),
          bool(S.CANVAS_TEXT_FONT), bool(S.CANVAS_DRAWING_FONT),
        ] : []),

        // Style
        num(S.STYLE_CHAT_MESSAGE_SPACING), num(S.STYLE_HEADER_CONTENT_GAP),
        num(S.MERGE_INNER_GAP),            num(S.STYLE_BG_SATURATION),
        bool(S.STYLE_PAPER_OVERLAY_ENABLED),
        num(S.STYLE_ACTOR_NAME_SIZE),      num(S.STYLE_PLAYER_NAME_SIZE),
        num(S.STYLE_MESSAGE_TEXT_SIZE),    num(S.STYLE_CHATCARD_TEXT_SIZE),

        // User-color background
        bool(S.USE_USER_COLOR_BG), str(S.USER_COLOR_BG_BASE),
        str(S.USER_COLOR_BG_CUSTOM), num(S.USER_COLOR_ALPHA), bool(S.SYSTEM_MSG_COLOR),
        bool(S.SYSTEM_MSG_BG_ENABLED), str(S.SYSTEM_MSG_BG_COLOR),
        bool(S.FORCE_NORMAL_MSG_COLOR),
        bool(S.CHAT_GROUP_OUTLINE),

        // Retro theme (general — visible/saved in all systems). The accent is
        // edited from the chat-control swatch, so only the reset path touches it.
        bool(S.UI_RETRO_THEME), bool(S.ACCENT_TEXT_OVERRIDE),
        ...(resetDefaults ? [str(S.DX3RD_PIXEL_ACCENT)] : []),

        // DND5e injection (world-scoped — only GM can set; fields hidden for non-GMs)
        ...(feIsDnd5eSystem() && game.user?.isGM ? [
          bool("injectCustomConditions"), bool("injectCustomDamageTypes"),
          str("dmgCustom1"), str("dmgCustom2"), str("dmgCustom3"), str("dmgCustom4"),
          str("dmgCustom5"), str("dmgCustom6"), str("dmgCustom7"), str("dmgCustom8"),
        ] : []),

        // Status UI (dx3rd + dnd5e) — only when its fields are shown (ruiSupported),
        // else d[key] would be undefined and overwrite existing preferences.
        ...((feIsDx3rdSystem() || feIsDnd5eSystem()) ? [
          bool(S.DX3RD_RUI_ENABLED), bool(S.DX3RD_RUI_VISIBLE),
          num(S.DX3RD_RUI_PORTRAIT_WIDTH), num(S.DX3RD_RUI_PANEL_WIDTH),
          num(S.DX3RD_RUI_CARD_HEIGHT),
        ] : []),

        // DX3rd-only (hidden on other systems).
        ...(feIsDx3rdSystem() ? [
          num(S.DX3RD_CARD_BORDER_ALPHA),
        ] : []),

        // Chat images (upload path is world-scoped/GM-only)
        bool("chatImagesEnabled"), bool("chatImagesShowButton"),
        ...(game.user?.isGM ? [str("chatImagesUploadLocation")] : []),

        // Image Hover — world/GM (permission/art) gated; client prefs always saved
        ...(game.user?.isGM ? [num("ihPermission"), str("ihArtType")] : []),
        bool("ihEnabled"), str("ihPosition"), num("ihSize"), num("ihSizeWide"), num("ihDelay"), num("ihMaxUpscale"),

        // Narrator — all world/GM
        ...(game.user?.isGM ? [
          bool("narratorEnabled"), num("narratorDurationMult"),
          bool("narratorAllowCopy"),
          num("narratorPermNarrate"), num("narratorPermDescribe"), num("narratorPermAs"),
        ] : []),

        // Theatre — world/GM (enable/history/decay) gated; client box dims always saved.
        ...(game.user?.isGM ? [
          bool("stageEnabled"),
          bool("stageExcludeSystemMessages"),
          bool("stageRecallIncludeNonActor"),
          bool("stageAutoDecay"), ...(saveDecayTime ? [num("stageDecayTime")] : []),
        ] : []),
        num("stagePortraitHeight"), num("stageBoxWidth"), num("stageBoxHeight"),
        num("stageBoxBottom"), num("stageBoxLeft"), num("stageTextSize"),

        // Screen Panel — world/GM (in FE_RELOAD_REQUIRED_KEYS → reload prompt on change)
        ...(game.user?.isGM ? [bool(S.SCREEN_PANEL_ENABLED)] : []),
        // Screen Panel grid-snap — client-scoped (always saved for every user)
        bool(S.SCREEN_PANEL_GRID_SNAP),
        // Attribute name helper — client-scoped (always saved for every user)
        bool(S.ATTR_PATH_HELPER), ...(saveAttrSource ? [bool(S.ATTR_PATH_HELPER_SOURCE)] : []),

        // Combat Tracker — world/GM (enabled[FE_RELOAD_REQUIRED_KEYS] + hide-defeated) gated;
        // client display prefs always saved (GM-priority forces them automatically).
        ...(game.user?.isGM ? [
          bool(S.COMBAT_TRACKER_ENABLED), bool(S.COMBAT_TRACKER_HIDE_DEFEATED),
        ] : []),
        num(S.COMBAT_TRACKER_PORTRAIT_SIZE),
        str(S.COMBAT_TRACKER_ASPECT), str(S.COMBAT_TRACKER_ROUNDNESS),
        str(S.COMBAT_TRACKER_ALIGNMENT), str(S.COMBAT_TRACKER_PORTRAIT_IMAGE),
        bool(S.COMBAT_TRACKER_SHOW_INITIATIVE), bool(S.COMBAT_TRACKER_SHOW_DISPOSITION),
        bool(S.COMBAT_TRACKER_SHOW_HP),

        // Music — world/GM (enabled[FE_RELOAD_REQUIRED_KEYS] + name/root/size); non-GMs lack write permission
        ...(game.user?.isGM ? [
          bool(S.MUSIC_ENABLED), str(S.MUSIC_PLAYLIST_NAME),
          str(S.MUSIC_UPLOAD_ROOT), num(S.MUSIC_MAX_MB),
        ] : []),

        // Token selection glow — client-scoped (GM-priority forces them automatically)
        bool(S.TOKEN_GLOW_ENABLED), bool(S.TOKEN_GLOW_HOVER), num(S.TOKEN_GLOW_STRENGTH),
        bool(S.TOKEN_GLOW_TARGET), bool(S.TOKEN_GLOW_SIGHTLINE),

        // Animated tile textures — client-scoped (GM-priority forces it automatically).
        // No reload key: fe-animated-tile.js always installs its hooks and its onChange
        // attaches/detaches in place, per the CLAUDE.md teardown corollary.
        bool(S.ANIMATED_TILE_ENABLED),

        // Chat portrait
        bool(CP.ENABLED), bool(CP.HIDE_WRAP), bool(CP.USE_TOKEN),
        num(CP.SIZE), num(CP.CARD_ICON_SIZE),
        str(CP.SHAPE), str(CP.BORDER_MODE), num(CP.BORDER_WIDTH),
        str(CP.BORDER_COLOR), str(CP.NAME_ALIGN),
        bool(CP.SHOW_IC), bool(CP.SHOW_OOC), bool(CP.SHOW_EMOTE),
        bool(CP.SHOW_WHISPER), bool(CP.SHOW_ROLL), bool(CP.SHOW_OTHER),
      ]);
    } catch (err) {
      // setOne swallows per-key errors, so reaching here is unexpected — but never
      // let it skip the capture below.
      console.error(`[${MODULE_ID}] settings save batch error`, err);
    } finally {
      // ALWAYS persist the just-saved values into this world's per-world slice,
      // even if some individual keys failed. If this is skipped, feHydrateWorldSettings
      // re-applies the stale slice on the next reload and reverts everything that
      // DID save. The failure is logged loudly (not silently swallowed) so a future
      // recurrence names the offending key instead of vanishing.
      try {
        await feCaptureWorldSettings();
      } catch (err) {
        console.error(`[${MODULE_ID}] feCaptureWorldSettings failed — per-world slice not updated; settings may revert on reload`, err);
        ui.notifications?.error("설정 저장(월드별 스냅샷) 중 오류가 발생했습니다. 콘솔을 확인하세요.");
      }
    }

    if (failed.length) {
      console.warn(`[${MODULE_ID}] ${failed.length} setting(s) failed to save:`, failed);
      ui.notifications?.warn(`일부 설정을 저장하지 못했습니다: ${failed.join(", ")}`);
    }

    // Not awaited: the caller closes this menu right after, and awaiting a modal here
    // would hold the settings window open behind it.
    //
    // `world` is derived from the SCOPE of whichever reload-only key actually moved, not
    // hardcoded: `reloadConfirm({world: true})` emits a "reload" socket to every connected
    // client (config.mjs:195). That is required for a world-scope key like the screen-panel
    // toggle — the setting changed for everyone, so everyone's page is now stale — and
    // wrong for a client-scope one like the scene-config tabs, which would reload the whole
    // table for one person's local preference. Core derives the same flag the same way in
    // its own SettingsConfig submit.
    const changedReloadKeys = [...reloadKeyBefore]
      .filter(([key, prev]) => { try { return game.settings.get(MODULE_ID, key) !== prev; } catch { return false; } })
      .map(([key]) => key);
    if (changedReloadKeys.length) {
      const world = changedReloadKeys.some((key) => {
        try { return game.settings.settings.get(`${MODULE_ID}.${key}`)?.scope === "world"; }
        catch { return false; }
      });
      foundry.applications.settings.SettingsConfig.reloadConfirm({ world })
        .catch((err) => console.warn(`[${MODULE_ID}] reload prompt failed`, err));
    }
  }
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "settingsMenu", {
    name: "Female-cupwhi: 통합 설정 패널",
    label: "설정 열기",
    hint: "카테고리/접기·펼치기 방식의 통합 설정 패널을 엽니다.",
    icon: "fas fa-sliders-h",
    type: FemaleEditionSettingsMenu,
    restricted: false,
  });
});
