// Female-cupwhi: Unified settings menu (collapsible sections)
// This dialog is the primary UI because individual settings are hidden from core Module Settings.

import { MODULE_ID, S, FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES } from "./fe-chat-enhance.js";

// Settings keys owned by other split modules
const BG = Object.freeze({
  ENABLE_FONTS: "enableFonts",
  HIDE_BASE_PORTRAITS: "hideChatPortraits",
  STRIP_TEXTURES: "stripChatTextures",
});

const CP = Object.freeze({
  ENABLED: "chatPortraitEnabled",
  HIDE_WRAP: "chatPortraitHideWrap",
  USE_TOKEN: "chatPortraitUseTokenImage",
  SIZE: "chatPortraitSize",
  APPLY_COMBAT: "chatPortraitApplyCombatTracker",

  SHOW_IC: "chatPortraitShowIC",
  SHOW_OOC: "chatPortraitShowOOC",
  SHOW_EMOTE: "chatPortraitShowEmote",
  SHOW_WHISPER: "chatPortraitShowWhisper",
  SHOW_ROLL: "chatPortraitShowRoll",
  SHOW_OTHER: "chatPortraitShowOther",
});

const MENU_KEY = "settingsMenu";

function feGetSettingSafe(key, fallback) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return fallback;
  }
}

function feIsChatPortraitModuleActive() {
  try {
    return !!game?.modules?.get?.("chat-portrait")?.active;
  } catch {
    return false;
  }
}

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
    const data = super.getData(options);

    const values = {
      // Base toggles
      [BG.ENABLE_FONTS]: feGetSettingSafe(BG.ENABLE_FONTS, true),
      [BG.HIDE_BASE_PORTRAITS]: feGetSettingSafe(BG.HIDE_BASE_PORTRAITS, true),
      [BG.STRIP_TEXTURES]: feGetSettingSafe(BG.STRIP_TEXTURES, true),

      // Chat enhancements
      [S.MERGE_ENABLED]: feGetSettingSafe(S.MERGE_ENABLED, FE_DEFAULTS[S.MERGE_ENABLED]),
      [S.MERGE_ONLY_TEXT]: feGetSettingSafe(S.MERGE_ONLY_TEXT, FE_DEFAULTS[S.MERGE_ONLY_TEXT]),
      [S.MERGE_INCLUDE_ROLL_MESSAGES]: feGetSettingSafe(S.MERGE_INCLUDE_ROLL_MESSAGES, FE_DEFAULTS[S.MERGE_INCLUDE_ROLL_MESSAGES]),
      [S.MERGE_DIVIDER]: feGetSettingSafe(S.MERGE_DIVIDER, FE_DEFAULTS[S.MERGE_DIVIDER]),
      [S.MERGE_MODE]: feGetSettingSafe(S.MERGE_MODE, FE_DEFAULTS[S.MERGE_MODE]),
      [S.MERGE_FOLLOW_HEADER_STYLE]: feGetSettingSafe(
        S.MERGE_FOLLOW_HEADER_STYLE,
        FE_DEFAULTS[S.MERGE_FOLLOW_HEADER_STYLE]
      ),
      [S.MERGE_SPEAKER_BASIS]: feGetSettingSafe(S.MERGE_SPEAKER_BASIS, FE_DEFAULTS[S.MERGE_SPEAKER_BASIS]),

      // Export
      [S.EXPORT_ENABLED]: feGetSettingSafe(S.EXPORT_ENABLED, FE_DEFAULTS[S.EXPORT_ENABLED]),
      [S.EXPORT_AUTO_PRINT]: feGetSettingSafe(S.EXPORT_AUTO_PRINT, FE_DEFAULTS[S.EXPORT_AUTO_PRINT]),
      [S.EXPORT_OPTIMIZE]: feGetSettingSafe(S.EXPORT_OPTIMIZE, FE_DEFAULTS[S.EXPORT_OPTIMIZE]),
      [S.EXPORT_EMBED_FONTS]: feGetSettingSafe(S.EXPORT_EMBED_FONTS, FE_DEFAULTS[S.EXPORT_EMBED_FONTS]),
      [S.EXPORT_EMBED_IMAGES]: feGetSettingSafe(S.EXPORT_EMBED_IMAGES, FE_DEFAULTS[S.EXPORT_EMBED_IMAGES]),
      [S.EXPORT_PRINT_IMAGE_MODE]: feGetSettingSafe(
        S.EXPORT_PRINT_IMAGE_MODE,
        FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]
      ),
      [S.EXPORT_DESKTOP_EXTERNAL_MODE]: feGetSettingSafe(
        S.EXPORT_DESKTOP_EXTERNAL_MODE,
        FE_DEFAULTS[S.EXPORT_DESKTOP_EXTERNAL_MODE]
      ),

      // Fonts
      [S.CHAT_FONT_CHOICE]: feGetSettingSafe(S.CHAT_FONT_CHOICE, FE_DEFAULTS[S.CHAT_FONT_CHOICE]),
      [S.CHATCARD_USE_CUSTOM_FONT]: feGetSettingSafe(
        S.CHATCARD_USE_CUSTOM_FONT,
        FE_DEFAULTS[S.CHATCARD_USE_CUSTOM_FONT]
      ),
      [S.UI_USE_GEURIMILGI]: feGetSettingSafe(S.UI_USE_GEURIMILGI, FE_DEFAULTS[S.UI_USE_GEURIMILGI]),

      // Style vars
      [S.STYLE_CHAT_MESSAGE_SPACING]: feGetSettingSafe(
        S.STYLE_CHAT_MESSAGE_SPACING,
        FE_DEFAULTS[S.STYLE_CHAT_MESSAGE_SPACING]
      ),
      [S.STYLE_BG_SATURATION]: feGetSettingSafe(S.STYLE_BG_SATURATION, FE_DEFAULTS[S.STYLE_BG_SATURATION]),
      [S.STYLE_ACTOR_NAME_SIZE]: feGetSettingSafe(S.STYLE_ACTOR_NAME_SIZE, FE_DEFAULTS[S.STYLE_ACTOR_NAME_SIZE]),
      [S.STYLE_PLAYER_NAME_SIZE]: feGetSettingSafe(
        S.STYLE_PLAYER_NAME_SIZE,
        FE_DEFAULTS[S.STYLE_PLAYER_NAME_SIZE]
      ),
      [S.STYLE_MESSAGE_TEXT_SIZE]: feGetSettingSafe(
        S.STYLE_MESSAGE_TEXT_SIZE,
        FE_DEFAULTS[S.STYLE_MESSAGE_TEXT_SIZE]
      ),
      [S.STYLE_CHATCARD_TEXT_SIZE]: feGetSettingSafe(
        S.STYLE_CHATCARD_TEXT_SIZE,
        FE_DEFAULTS[S.STYLE_CHATCARD_TEXT_SIZE]
      ),

      // User-color tint
      [S.USE_USER_COLOR_BG]: feGetSettingSafe(S.USE_USER_COLOR_BG, FE_DEFAULTS[S.USE_USER_COLOR_BG]),
      [S.USER_COLOR_BG_BASE]: feGetSettingSafe(S.USER_COLOR_BG_BASE, FE_DEFAULTS[S.USER_COLOR_BG_BASE]),

      // Markdown/edit
      [S.MARKDOWN_ENABLED]: feGetSettingSafe(S.MARKDOWN_ENABLED, FE_DEFAULTS[S.MARKDOWN_ENABLED]),
      [S.EDIT_ENABLED]: feGetSettingSafe(S.EDIT_ENABLED, FE_DEFAULTS[S.EDIT_ENABLED]),

      // Chat portrait (ported)
      [CP.ENABLED]: feGetSettingSafe(CP.ENABLED, true),
      [CP.HIDE_WRAP]: feGetSettingSafe(CP.HIDE_WRAP, false),
      [CP.USE_TOKEN]: feGetSettingSafe(CP.USE_TOKEN, false),
      [CP.SIZE]: feGetSettingSafe(CP.SIZE, 48),
      [CP.APPLY_COMBAT]: feGetSettingSafe(CP.APPLY_COMBAT, false),
      [CP.SHOW_IC]: feGetSettingSafe(CP.SHOW_IC, true),
      [CP.SHOW_OOC]: feGetSettingSafe(CP.SHOW_OOC, true),
      [CP.SHOW_EMOTE]: feGetSettingSafe(CP.SHOW_EMOTE, true),
      [CP.SHOW_WHISPER]: feGetSettingSafe(CP.SHOW_WHISPER, true),
      [CP.SHOW_ROLL]: feGetSettingSafe(CP.SHOW_ROLL, true),
      [CP.SHOW_OTHER]: feGetSettingSafe(CP.SHOW_OTHER, true),
    };

    const choices = {
      mergeMode: {
        standard: "표준(경계/간격까지 묶기)",
        simple: "간소화(후속 헤더만 숨김)",
      },
      mergeFollowHeaderStyle: {
        hide: "헤더 완전 숨김",
        name: "이름만 남김",
        portrait: "포트레이트만 남김",
      },
      mergeSpeakerBasis: {
        token:  "토큰(기본) — 토큰+액터+씬 모두 일치",
        actor:  "액터 — 같은 액터면 병합",
        author: "플레이어(작성자) — 같은 유저면 병합",
      },
      exportPrintImageMode: FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
      exportDesktopExternalMode: {
        off: "사용 안 함",
        button: "아카이브 창에 버튼 표시",
        auto: "PDF 아이콘 클릭 시 자동",
      },
      chatFontChoice: {
        cookie: "쿠키런",
        geurimilgi: "그림일기",
      },
      userColorBgBase: {
        white: "흰색(권장)",
        black: "검정",
        none: "사용 안 함(기존 방식)",
      },
    };

    const warnings = {
      chatPortraitDup: feIsChatPortraitModuleActive(),
    };

    return {
      ...data,
      values,
      choices,
      warnings,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    // Expand/collapse all
    html.find("[data-action='expandAll']").on("click", (ev) => {
      ev.preventDefault();
      html.find("details").prop("open", true);
    });

    html.find("[data-action='collapseAll']").on("click", (ev) => {
      ev.preventDefault();
      html.find("details").prop("open", false);
    });
  }

  async _updateObject(_event, formData) {
    const data = foundry.utils.expandObject(formData);

    // Helper to set only if present; for checkboxes, Handlebars omits unchecked -> treat as false
    const setBool = async (key) => {
      const v = !!data[key];
      await game.settings.set(MODULE_ID, key, v);
    };

    const setNum = async (key, fallback) => {
      const n = Number(data[key]);
      await game.settings.set(MODULE_ID, key, Number.isFinite(n) ? n : fallback);
    };

    const setStr = async (key, fallback) => {
      const s = data[key];
      await game.settings.set(MODULE_ID, key, s == null ? fallback : String(s));
    };

    try {
      // Base
      await setBool(BG.ENABLE_FONTS);
      await setBool(BG.HIDE_BASE_PORTRAITS);
      await setBool(BG.STRIP_TEXTURES);

      // Merge
      await setBool(S.MERGE_ENABLED);
      await setBool(S.MERGE_ONLY_TEXT);
      await setBool(S.MERGE_INCLUDE_ROLL_MESSAGES);
      await setBool(S.MERGE_DIVIDER);
      await setStr(S.MERGE_MODE, FE_DEFAULTS[S.MERGE_MODE]);
      await setStr(S.MERGE_FOLLOW_HEADER_STYLE, FE_DEFAULTS[S.MERGE_FOLLOW_HEADER_STYLE]);
      await setStr(S.MERGE_SPEAKER_BASIS, FE_DEFAULTS[S.MERGE_SPEAKER_BASIS]);

      // Markdown/Edit
      await setBool(S.MARKDOWN_ENABLED);
      await setBool(S.EDIT_ENABLED);

      // Export
      await setBool(S.EXPORT_ENABLED);
      await setBool(S.EXPORT_AUTO_PRINT);
      await setBool(S.EXPORT_OPTIMIZE);
      await setBool(S.EXPORT_EMBED_FONTS);
      await setBool(S.EXPORT_EMBED_IMAGES);
      await setStr(S.EXPORT_PRINT_IMAGE_MODE, FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
      await setStr(S.EXPORT_DESKTOP_EXTERNAL_MODE, FE_DEFAULTS[S.EXPORT_DESKTOP_EXTERNAL_MODE]);

      // Fonts
      await setStr(S.CHAT_FONT_CHOICE, FE_DEFAULTS[S.CHAT_FONT_CHOICE]);
      await setBool(S.UI_USE_GEURIMILGI);
      await setBool(S.CHATCARD_USE_CUSTOM_FONT);

      // Style
      await setNum(S.STYLE_CHAT_MESSAGE_SPACING, FE_DEFAULTS[S.STYLE_CHAT_MESSAGE_SPACING]);
      await setNum(S.STYLE_BG_SATURATION, FE_DEFAULTS[S.STYLE_BG_SATURATION]);
      await setNum(S.STYLE_ACTOR_NAME_SIZE, FE_DEFAULTS[S.STYLE_ACTOR_NAME_SIZE]);
      await setNum(S.STYLE_PLAYER_NAME_SIZE, FE_DEFAULTS[S.STYLE_PLAYER_NAME_SIZE]);
      await setNum(S.STYLE_MESSAGE_TEXT_SIZE, FE_DEFAULTS[S.STYLE_MESSAGE_TEXT_SIZE]);
      await setNum(S.STYLE_CHATCARD_TEXT_SIZE, FE_DEFAULTS[S.STYLE_CHATCARD_TEXT_SIZE]);

      // User color bg
      await setBool(S.USE_USER_COLOR_BG);
      await setStr(S.USER_COLOR_BG_BASE, FE_DEFAULTS[S.USER_COLOR_BG_BASE]);

      // Portrait
      await setBool(CP.ENABLED);
      await setBool(CP.HIDE_WRAP);
      await setBool(CP.USE_TOKEN);
      await setNum(CP.SIZE, 48);
      await setBool(CP.APPLY_COMBAT);
      await setBool(CP.SHOW_IC);
      await setBool(CP.SHOW_OOC);
      await setBool(CP.SHOW_EMOTE);
      await setBool(CP.SHOW_WHISPER);
      await setBool(CP.SHOW_ROLL);
      await setBool(CP.SHOW_OTHER);
    } catch (err) {
      console.error(`[${MODULE_ID}] settings save failed`, err);
      ui.notifications?.error("설정 저장 중 오류가 발생했습니다. 콘솔을 확인하세요.");
    }
  }
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, MENU_KEY, {
    name: "Female-cupwhi: 통합 설정 패널",
    label: "설정 열기",
    hint: "카테고리/접기·펼치기 방식의 통합 설정 패널을 엽니다.",
    icon: "fas fa-sliders-h",
    type: FemaleEditionSettingsMenu,
    restricted: false,
  });
});
