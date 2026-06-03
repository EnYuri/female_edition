// Female-cupwhi: Unified settings menu (collapsible sections)
// This dialog is the primary UI because individual settings are hidden from core Module Settings.

import { MODULE_ID, S, FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES, feSetting } from "./fe-chat-enhance.js";

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
    cookie:     "쿠키런",
    geurimilgi: "그림일기",
    neodgm:     "NeoDGM 픽셀",
  },
  userColorBgBase: {
    white: "흰색(권장)",
    black: "검정",
    none:  "사용 안 함(기존 방식)",
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

// ── Settings dialog ──

class FemaleEditionSettingsMenu extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "fe-settings-menu",
      title: "Female-cupwhi 설정",
      template: `modules/${MODULE_ID}/templates/fe-settings-menu.hbs`,
      width: 740,
      height: "auto",
      closeOnSubmit: true,
      submitOnChange: false,
      resizable: true,
      classes: ["fe-settings-menu"],
    });
  }

  getData(options = {}) {
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

      // Markdown / Edit
      [S.MARKDOWN_ENABLED]: feRead(S.MARKDOWN_ENABLED),
      [S.EDIT_ENABLED]:     feRead(S.EDIT_ENABLED),

      // GM priority
      [S.GM_PRIORITY_ENABLED]: feRead(S.GM_PRIORITY_ENABLED),
      [S.GM_SPEAK_AS_SELF]:    feRead(S.GM_SPEAK_AS_SELF),

      // DND5e injection
      injectCustomConditions:  feRead("injectCustomConditions"),
      injectCustomDamageTypes: feRead("injectCustomDamageTypes"),

      // DX3rd
      [S.UI_DX3RD_PIXEL_THEME]:     feRead(S.UI_DX3RD_PIXEL_THEME),
      [S.DX3RD_CARD_BORDER_ALPHA]:  feRead(S.DX3RD_CARD_BORDER_ALPHA),
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
      ...super.getData(options),
      values,
      choices:  CHOICES,
      warnings: { chatPortraitDup: feIsChatPortraitModuleActive() },
      isGM:     !!game.user?.isGM,
      isDx3rd:  feIsDx3rdSystem(),
      isDnd5e:  feIsDnd5eSystem(),
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find("[data-action='expandAll']").on("click",  (ev) => { ev.preventDefault(); html.find("details").prop("open", true); });
    html.find("[data-action='collapseAll']").on("click", (ev) => { ev.preventDefault(); html.find("details").prop("open", false); });
  }

  async _updateObject(_event, formData) {
    const d = foundry.utils.expandObject(formData);

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

        // DND5e injection (world-scoped — only GM can set; fields hidden for non-GMs)
        ...(feIsDnd5eSystem() && game.user?.isGM ? [
          bool("injectCustomConditions"), bool("injectCustomDamageTypes"),
        ] : []),

        // DX3rd (only when in DX3rd system — fields hidden otherwise,
        // so d[key] would be undefined and would overwrite existing DX3rd preferences)
        ...(feIsDx3rdSystem() ? [
          bool(S.UI_DX3RD_PIXEL_THEME), num(S.DX3RD_CARD_BORDER_ALPHA),
          num(S.DX3RD_RUI_PORTRAIT_WIDTH), num(S.DX3RD_RUI_PANEL_WIDTH),
          num(S.DX3RD_RUI_CARD_HEIGHT),
        ] : []),

        // Chat portrait
        bool(CP.ENABLED), bool(CP.HIDE_WRAP), bool(CP.USE_TOKEN),
        num(CP.SIZE), num(CP.CARD_ICON_SIZE),
        str(CP.SHAPE), str(CP.BORDER_MODE), num(CP.BORDER_WIDTH),
        str(CP.BORDER_COLOR), str(CP.NAME_ALIGN), bool(CP.APPLY_COMBAT),
        bool(CP.SHOW_IC), bool(CP.SHOW_OOC), bool(CP.SHOW_EMOTE),
        bool(CP.SHOW_WHISPER), bool(CP.SHOW_ROLL), bool(CP.SHOW_OTHER),
      ]);
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
