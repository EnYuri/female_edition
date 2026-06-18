// Female-cupwhi: Unified settings menu (collapsible sections)
// This dialog is the primary UI because individual settings are hidden from core Module Settings.

import { MODULE_ID, S, FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES, feSetting, feCaptureWorldSettings } from "./fe-chat-enhance.js";

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
  APPLY_COMBAT:   "chatPortraitApplyCombatTracker",
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
  [CP.SHAPE]:          "circle",
  [CP.BORDER_MODE]:    "theme",
  [CP.BORDER_WIDTH]:   2,
  [CP.BORDER_COLOR]:   "#000000",
  [CP.NAME_ALIGN]:     "center",
  [CP.APPLY_COMBAT]:   false,
  [CP.SHOW_IC]:        true,
  [CP.SHOW_OOC]:       true,
  [CP.SHOW_EMOTE]:     true,
  [CP.SHOW_WHISPER]:   true,
  [CP.SHOW_ROLL]:      true,
  [CP.SHOW_OTHER]:     true,
});

// Combined fallback table: fe-chat-enhance defaults + portrait defaults + DND5e injection defaults.
const ALL_DEFAULTS = Object.freeze({
  ...FE_DEFAULTS,
  ...CP_DEFAULTS,
  injectCustomConditions:  true,
  injectCustomDamageTypes: true,
  // dnd5e custom damage-type name slots (registered by inject-damage-type.js)
  dmgCustom1: "1", dmgCustom2: "2", dmgCustom3: "3", dmgCustom4: "4",
  dmgCustom5: "5", dmgCustom6: "6", dmgCustom7: "7", dmgCustom8: "8",
  // Standalone-module settings migrated into the unified menu.
  chatImagesEnabled: true,
  chatImagesShowButton: true,
  chatImagesUploadLocation: "uploaded-chat-images",
  // image-hover (3 world/GM + 4 client)
  ihPermission: 0, ihArtType: "character", ihShowAllTimer: 6000,
  ihEnabled: true, ihPosition: "Bottom left", ihSize: 7, ihDelay: 0,
  // narrator (all world/GM)
  narratorEnabled: true, narratorDurationMult: 1, narratorStartPaused: false,
  narratorAllowCopy: true, narratorPermNarrate: 4, narratorPermDescribe: 4, narratorPermAs: 4,
  // theatre (4 world/GM + 6 client)
  stageEnabled: false, stageHideMessages: false, stageAutoDecay: true, stageDecayTime: 30000,
  stagePortraitHeight: 130, stageBoxWidth: 488, stageBoxHeight: 276,
  stageBoxBottom: 30, stageBoxLeft: 266, stageTextSize: 17,
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
  exportDesktopExternalMode: {
    off:    "사용 안 함",
    button: "아카이브 창에 버튼 표시",
    auto:   "PDF 아이콘 클릭 시 자동",
  },
  chatFontChoice: {
    cookie:     "쿠키런 + 그림일기",
    cookieAll:  "쿠키런",
    geurimilgi: "그림일기",
    neodgm:     "NeoDGM 픽셀",
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
};

// ── Helpers ──

function feRead(key) {
  try { return feSetting(key) ?? ALL_DEFAULTS[key]; } catch { return ALL_DEFAULTS[key]; }
}

function feIsChatPortraitModuleActive() {
  try { return !!game?.modules?.get?.("chat-portrait")?.active; } catch { return false; }
}

function feIsDx3rdSystem() {
  try { return game?.system?.id === "double-cross-3rd"; } catch { return false; }
}

function feIsDnd5eSystem() {
  try { return game?.system?.id === "dnd5e"; } catch { return false; }
}

// Persist each collapsible section's open/closed state across menu open/close.
// Pure client UI state → localStorage (no settings registration needed). Keyed
// by the section's summary text (stable, unique per section).
const FE_SM_OPEN_STORE = `${MODULE_ID}:settings-menu:open-sections`;

function feSmLoadOpenState() {
  try { return JSON.parse(localStorage.getItem(FE_SM_OPEN_STORE) || "{}") || {}; }
  catch { return {}; }
}

function feSmSaveOpenState(state) {
  try { localStorage.setItem(FE_SM_OPEN_STORE, JSON.stringify(state)); } catch { /* no-op */ }
}

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
      expandAll: FemaleEditionSettingsMenu.#onExpandAll,
      collapseAll: FemaleEditionSettingsMenu.#onCollapseAll,
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
      [S.EXPORT_PRINT_IMAGE_MODE]:      feRead(S.EXPORT_PRINT_IMAGE_MODE),
      [S.EXPORT_DESKTOP_EXTERNAL_MODE]: feRead(S.EXPORT_DESKTOP_EXTERNAL_MODE),

      // Fonts
      [S.CHAT_FONT_CHOICE]:         feRead(S.CHAT_FONT_CHOICE),
      [S.CHATCARD_USE_CUSTOM_FONT]: feRead(S.CHATCARD_USE_CUSTOM_FONT),
      [S.UI_USE_GEURIMILGI]:        feRead(S.UI_USE_GEURIMILGI),

      // Style vars
      [S.STYLE_CHAT_MESSAGE_SPACING]: feRead(S.STYLE_CHAT_MESSAGE_SPACING),
      [S.STYLE_HEADER_CONTENT_GAP]:   feRead(S.STYLE_HEADER_CONTENT_GAP),
      [S.MERGE_INNER_GAP]:            feRead(S.MERGE_INNER_GAP),
      [S.STYLE_BG_SATURATION]:        feRead(S.STYLE_BG_SATURATION),
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
      ihShowAllTimer: feRead("ihShowAllTimer"),
      ihEnabled:      feRead("ihEnabled"),
      ihPosition:     feRead("ihPosition"),
      ihSize:         feRead("ihSize"),
      ihDelay:        feRead("ihDelay"),

      // Narrator (standalone — migrated; all world/GM)
      narratorEnabled:      feRead("narratorEnabled"),
      narratorDurationMult: feRead("narratorDurationMult"),
      narratorStartPaused:  feRead("narratorStartPaused"),
      narratorAllowCopy:    feRead("narratorAllowCopy"),
      narratorPermNarrate:  feRead("narratorPermNarrate"),
      narratorPermDescribe: feRead("narratorPermDescribe"),
      narratorPermAs:       feRead("narratorPermAs"),

      // Theatre / Stage (standalone — migrated)
      stageEnabled:        feRead("stageEnabled"),
      stageHideMessages:   feRead("stageHideMessages"),
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
      // Screen Panel grid-snap (client/personal)
      [S.SCREEN_PANEL_GRID_SNAP]: feRead(S.SCREEN_PANEL_GRID_SNAP),
      // Attribute name helper (client/personal — hover + hold X → show attribute name)
      [S.ATTR_PATH_HELPER]: feRead(S.ATTR_PATH_HELPER),
      [S.ATTR_PATH_HELPER_SOURCE]: feRead(S.ATTR_PATH_HELPER_SOURCE),

      // Retro theme (general — all systems)
      [S.UI_RETRO_THEME]:           feRead(S.UI_RETRO_THEME),

      // DX3rd
      [S.DX3RD_CARD_BORDER_ALPHA]:  feRead(S.DX3RD_CARD_BORDER_ALPHA),
      // Status UI (dx3rd + dnd5e)
      [S.DX3RD_RUI_ENABLED]:        feRead(S.DX3RD_RUI_ENABLED),
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
      [CP.APPLY_COMBAT]:   feRead(CP.APPLY_COMBAT),
      [CP.SHOW_IC]:        feRead(CP.SHOW_IC),
      [CP.SHOW_OOC]:       feRead(CP.SHOW_OOC),
      [CP.SHOW_EMOTE]:     feRead(CP.SHOW_EMOTE),
      [CP.SHOW_WHISPER]:   feRead(CP.SHOW_WHISPER),
      [CP.SHOW_ROLL]:      feRead(CP.SHOW_ROLL),
      [CP.SHOW_OTHER]:     feRead(CP.SHOW_OTHER),
    };

    return {
      ...context,
      values,
      choices:  CHOICES,
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
          const formData = new FormDataExtended(form);
          await FemaleEditionSettingsMenu.#onSubmit.call(this, e, form, formData);
          await this.close();
        });
      }
    } catch { /* no-op */ }

    // Restore each section's saved open/closed state and persist on toggle. The
    // template's `open` attribute is only the first-time default; once the user
    // has expanded/collapsed a section, that choice is remembered. (AppV2 rebuilds
    // the DOM each render, so per-render listeners do not accumulate.)
    try {
      const state = feSmLoadOpenState();
      for (const d of this.element?.querySelectorAll?.("details") ?? []) {
        const key = d.querySelector("summary")?.textContent?.trim();
        if (!key) continue;
        if (Object.prototype.hasOwnProperty.call(state, key)) d.open = !!state[key];
        d.addEventListener("toggle", () => {
          const s = feSmLoadOpenState();
          s[key] = d.open;
          feSmSaveOpenState(s);
        });
      }
    } catch { /* no-op */ }
  }

  // data-action handlers receive (event, target) bound to the application instance.
  static #onExpandAll(_event, _target) {
    this.element?.querySelectorAll?.("details")?.forEach?.((d) => { d.open = true; });
  }

  static #onCollapseAll(_event, _target) {
    this.element?.querySelectorAll?.("details")?.forEach?.((d) => { d.open = false; });
  }

  // AppV2 form handler: (event, form, formData) bound to the application instance.
  // formData is a FormDataExtended; .object is the flat field map (data-dtype coerced).
  static async #onSubmit(_event, _form, formData) {
    const d = foundry.utils.expandObject(formData.object);

    // Helpers return Promises directly — no async/await needed inside.
    const bool = (key) => game.settings.set(MODULE_ID, key, !!d[key]);
    const num  = (key) => { const n = Number(d[key]); return game.settings.set(MODULE_ID, key, Number.isFinite(n) ? n : ALL_DEFAULTS[key]); };
    const str  = (key) => game.settings.set(MODULE_ID, key, d[key] == null ? ALL_DEFAULTS[key] : String(d[key]));

    try {
      // All settings are independent — save in parallel so the dialog closes
      // in one round-trip instead of sequential game.settings.set() calls.
      await Promise.all([
        // Base toggles
        bool(S.PRUNE_ENABLED), num(S.PRUNE_MAX_MESSAGES),
        bool(S.TYPING_ENABLED),
        // World-scoped (GM-only) typing visibility — non-GMs lack write permission
        ...(game.user?.isGM ? [bool(S.TYPING_SHOW_TO_PLAYERS)] : []),
        bool(S.UI_ENABLE_FONTS), bool(S.UI_HIDE_PORTRAITS), bool(S.UI_STRIP_TEXTURES),
        bool(S.SC_COLLAPSE_ENABLED),

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
        str(S.EXPORT_PRINT_IMAGE_MODE), str(S.EXPORT_DESKTOP_EXTERNAL_MODE),

        // Fonts
        str(S.CHAT_FONT_CHOICE), bool(S.UI_USE_GEURIMILGI), bool(S.CHATCARD_USE_CUSTOM_FONT),

        // Style
        num(S.STYLE_CHAT_MESSAGE_SPACING), num(S.STYLE_HEADER_CONTENT_GAP),
        num(S.MERGE_INNER_GAP),            num(S.STYLE_BG_SATURATION),
        num(S.STYLE_ACTOR_NAME_SIZE),      num(S.STYLE_PLAYER_NAME_SIZE),
        num(S.STYLE_MESSAGE_TEXT_SIZE),    num(S.STYLE_CHATCARD_TEXT_SIZE),

        // User-color background
        bool(S.USE_USER_COLOR_BG), str(S.USER_COLOR_BG_BASE),
        str(S.USER_COLOR_BG_CUSTOM), num(S.USER_COLOR_ALPHA), bool(S.SYSTEM_MSG_COLOR),
        bool(S.CHAT_GROUP_OUTLINE),

        // Retro theme (general — visible/saved in all systems)
        bool(S.UI_RETRO_THEME), bool(S.ACCENT_TEXT_OVERRIDE),

        // DND5e injection (world-scoped — only GM can set; fields hidden for non-GMs)
        ...(feIsDnd5eSystem() && game.user?.isGM ? [
          bool("injectCustomConditions"), bool("injectCustomDamageTypes"),
          str("dmgCustom1"), str("dmgCustom2"), str("dmgCustom3"), str("dmgCustom4"),
          str("dmgCustom5"), str("dmgCustom6"), str("dmgCustom7"), str("dmgCustom8"),
        ] : []),

        // Status UI (dx3rd + dnd5e) — only when its fields are shown (ruiSupported),
        // else d[key] would be undefined and overwrite existing preferences.
        ...((feIsDx3rdSystem() || feIsDnd5eSystem()) ? [
          bool(S.DX3RD_RUI_ENABLED),
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

        // Image Hover — world/GM (perm/art/timer) gated; client prefs always saved
        ...(game.user?.isGM ? [num("ihPermission"), str("ihArtType"), num("ihShowAllTimer")] : []),
        bool("ihEnabled"), str("ihPosition"), num("ihSize"), num("ihDelay"),

        // Narrator — all world/GM
        ...(game.user?.isGM ? [
          bool("narratorEnabled"), num("narratorDurationMult"), bool("narratorStartPaused"),
          bool("narratorAllowCopy"),
          num("narratorPermNarrate"), num("narratorPermDescribe"), num("narratorPermAs"),
        ] : []),

        // Theatre — world/GM (enable/hide/decay) gated; client box dims always saved
        ...(game.user?.isGM ? [
          bool("stageEnabled"), bool("stageHideMessages"), bool("stageAutoDecay"), num("stageDecayTime"),
        ] : []),
        num("stagePortraitHeight"), num("stageBoxWidth"), num("stageBoxHeight"),
        num("stageBoxBottom"), num("stageBoxLeft"), num("stageTextSize"),

        // Screen Panel — world/GM (requiresReload triggers the reload prompt on change)
        ...(game.user?.isGM ? [bool(S.SCREEN_PANEL_ENABLED)] : []),
        // Screen Panel grid-snap — client/personal (always saved for every user)
        bool(S.SCREEN_PANEL_GRID_SNAP),
        // Attribute name helper — client/personal (always saved for every user)
        bool(S.ATTR_PATH_HELPER),
        bool(S.ATTR_PATH_HELPER_SOURCE),

        // Chat portrait
        bool(CP.ENABLED), bool(CP.HIDE_WRAP), bool(CP.USE_TOKEN),
        num(CP.SIZE), num(CP.CARD_ICON_SIZE),
        str(CP.SHAPE), str(CP.BORDER_MODE), num(CP.BORDER_WIDTH),
        str(CP.BORDER_COLOR), str(CP.NAME_ALIGN), bool(CP.APPLY_COMBAT),
        bool(CP.SHOW_IC), bool(CP.SHOW_OOC), bool(CP.SHOW_EMOTE),
        bool(CP.SHOW_WHISPER), bool(CP.SHOW_ROLL), bool(CP.SHOW_OTHER),
      ]);

      // Persist the just-saved values into this world's per-world slice so the
      // configuration stays independent from other worlds on this browser.
      try { await feCaptureWorldSettings(); } catch { /* no-op */ }
    } catch (err) {
      console.error(`[${MODULE_ID}] settings save failed`, err);
      ui.notifications?.error("설정 저장 중 오류가 발생했습니다. 콘솔을 확인하세요.");
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
