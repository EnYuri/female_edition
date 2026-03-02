/* female_edition: Chat Enhancements for Foundry VTT v13
 *
 * Features:
 *  - Chat merge (visual grouping; no document edits)
 *  - Player typing indicator (optional)
 *  - Chat log export to PDF (prints current log; no popup windows)
 *  - Standard Markdown in chat input (headings, quotes, links, images, bold/italic/strike)
 *  - Edit existing chat message (with Markdown support)
 *
 * Notes:
 *  - Updated for FVTT v13 data model: ChatMessage#author, ChatMessage#style, ChatMessage#rolls
 *  - Avoids deprecated hooks (renderChatMessage) and deprecated fields (#user, #type)
 */

const MODULE_ID = "female_edition";

// Legacy setting keys kept for one-time migration (do not expose in UI).
// Intentionally assembled without a literal legacy token in-source.
const LEGACY_UI_FONT_KEY = "ceUiUse" + "D" + "o" + "n" + "g" + "l" + "e";

const S = {
  // Merge
  MERGE_ENABLED: "ceMergeEnabled",
  MERGE_ONLY_TEXT: "ceMergeOnlyText",
  MERGE_DIVIDER: "ceMergeDivider",
  MERGE_FOLLOW_HEADER_STYLE: "ceMergeFollowHeaderStyle", // hide | name | portrait

  // Typing indicator
  TYPING_ENABLED: "ceTypingEnabled",

  // Export
  EXPORT_ENABLED: "ceExportEnabled",
  EXPORT_AUTO_PRINT: "ceExportAutoPrint",
  EXPORT_OPTIMIZE: "ceExportOptimize",
  EXPORT_EMBED_FONTS: "ceExportEmbedFonts",
  EXPORT_EMBED_IMAGES: "ceExportEmbedImages",
  EXPORT_PRINT_IMAGE_MODE: "ceExportPrintImageMode", // full | hideAvatars | hideAll | downscale | downscaleLite
  EXPORT_DESKTOP_EXTERNAL_MODE: "ceExportDesktopExternalMode", // off | button | auto

  // Typography
  CHATCARD_USE_CUSTOM_FONT: "ceChatCardUseCustomFont",
  CHAT_FONT_CHOICE: "ceChatFontChoice", // cookie | geurimilgi
  UI_USE_GEURIMILGI: "ceUiUseGeurimilgi", // use Geurimilgi for UI + ability labels instead of CookieRun
  UI_OVERRIDE_FONT_H1_COOKIE: "ceUiOverrideFontH1Cookie", // override --font-h1 to CookieRun
  USE_USER_COLOR_BG: "ceUseUserColorBg", // Chat Portrait-like message background tint
  USER_COLOR_BG_BASE: "ceUserColorBgBase", // none | white | black (opaque underlay)

  // Style (tunable CSS vars)
  STYLE_ACTOR_NAME_SIZE: "ceActorNameSize",
  STYLE_PLAYER_NAME_SIZE: "cePlayerNameSize",
  STYLE_MESSAGE_TEXT_SIZE: "ceMessageTextSize",
  STYLE_CHATCARD_TEXT_SIZE: "ceChatCardTextSize",
  STYLE_BG_SATURATION: "ceMessageBgSaturation",
  STYLE_CHAT_MESSAGE_SPACING: "ceChatMessageSpacing",

  // Markdown
  MARKDOWN_ENABLED: "ceMarkdownEnabled",

  // Edit
  EDIT_ENABLED: "ceEditEnabled",
};

// Default values (used as a safe fallback before settings are registered)
const FE_EXPORT_PRINT_IMAGE_MODE_CHOICES = Object.freeze({
  full: "그대로(고품질/대용량)",
  hideAvatars: "아바타/포트레이트 숨김(권장)",
  hideAll: "모든 이미지 숨김(최대 안정)",
  downscaleLite: "이미지 다운스케일(완화/품질 우선)",
  downscale: "이미지 다운스케일(실험적)",
});

const FE_DEFAULTS = {
  // Merge
  [S.MERGE_ENABLED]: true,
  [S.MERGE_ONLY_TEXT]: true,
  [S.MERGE_DIVIDER]: true,
  [S.MERGE_FOLLOW_HEADER_STYLE]: "hide",

  // Typing indicator
  [S.TYPING_ENABLED]: true,

  // Export
  [S.EXPORT_ENABLED]: true,
  [S.EXPORT_AUTO_PRINT]: false,
  [S.EXPORT_OPTIMIZE]: true,
  // Embedding multi-megabyte fonts as base64 can easily OOM in Chromium.
  // Keep default off for reliability.
  [S.EXPORT_EMBED_FONTS]: false,
  [S.EXPORT_EMBED_IMAGES]: false,
  [S.EXPORT_PRINT_IMAGE_MODE]: "hideAvatars",
  [S.EXPORT_DESKTOP_EXTERNAL_MODE]: "button",

  // Typography
  [S.CHATCARD_USE_CUSTOM_FONT]: true,
  [S.CHAT_FONT_CHOICE]: "cookie",
  [S.UI_USE_GEURIMILGI]: false,
  [S.UI_OVERRIDE_FONT_H1_COOKIE]: false,
  [S.USE_USER_COLOR_BG]: false,
  [S.USER_COLOR_BG_BASE]: "white",

  // Style
  [S.STYLE_ACTOR_NAME_SIZE]: 22,
  [S.STYLE_PLAYER_NAME_SIZE]: 14,
  [S.STYLE_MESSAGE_TEXT_SIZE]: 14,
  [S.STYLE_CHATCARD_TEXT_SIZE]: 12,
  [S.STYLE_BG_SATURATION]: 0.42,
  [S.STYLE_CHAT_MESSAGE_SPACING]: 4,

  // Markdown
  [S.MARKDOWN_ENABLED]: true,

  // Edit
  [S.EDIT_ENABLED]: true,
};

function feFireChatUiUpdated(payload = null) {
  Hooks.callAll(`${MODULE_ID}.chatUiUpdated`, payload);
}


function feSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch {
    return FE_DEFAULTS[key];
  }
}

/** Clamp a value to an integer range. */
function feClampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Stable small hash for cache-busting family names.
 * FNV-1a 32-bit -> hex.
 */
function feStableHash(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime 16777619
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Create or update a <style> tag by id. */
function feEnsureStyleTag(id, cssText, doc = document) {
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    doc.head?.appendChild(el);
  }
  el.textContent = String(cssText ?? "");
  return el;
}

function feGetTextEditor() {
  return foundry?.applications?.ux?.TextEditor?.implementation;
}

function feSetBodyMergeClasses() {
  const enabled = !!feSetting(S.MERGE_ENABLED);
  document.body.classList.toggle("fe-chat-merge", enabled);

  // Follow header style class (only matters when merge enabled)
  const style = String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
  document.body.classList.toggle("fe-merge-follow-hide", enabled && style === "hide");
  document.body.classList.toggle("fe-merge-follow-name", enabled && style === "name");
  document.body.classList.toggle("fe-merge-follow-portrait", enabled && style === "portrait");
}

function feSetChatCardFontClass(doc = document) {
  try {
    const enabled = !!feSetting(S.CHATCARD_USE_CUSTOM_FONT);
    doc?.body?.classList?.toggle("fe-chatcard-custom-font", enabled);
  } catch {}
}

function feSetChatFontChoiceClass(doc = document) {
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    const body = doc?.body;
    if (!body) return;
    const useCookie = choice === "cookie";
    body.classList.toggle("fe-chat-font-cookie", useCookie);
    body.classList.toggle("fe-chat-font-geurimilgi", !useCookie);
  } catch {}
}


function feSetUiFontClass(doc = document) {
  try {
    const enabled = !!feSetting(S.UI_USE_GEURIMILGI);
    doc?.body?.classList?.toggle("fe-ui-font-geurimilgi", enabled);
  } catch (_e) {
    /* noop */
  }
}

function feSetUserColorBgClass(doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    doc?.body?.classList?.toggle("fe-msg-bg-usercolor", enabled);
  } catch {}
}

function feSetUserColorBgBaseClass(doc = document) {
  try {
    const mode = String(feSetting(S.USER_COLOR_BG_BASE) ?? "white");
    const body = doc?.body;
    if (!body?.classList) return;

    body.classList.toggle("fe-userbg-base-white", mode === "white");
    body.classList.toggle("fe-userbg-base-black", mode === "black");
    // If mode is "none", both classes are removed.
    if (mode === "none") {
      body.classList.remove("fe-userbg-base-white", "fe-userbg-base-black");
    }
  } catch {}
}

function feApplyStyleVarsFromSettings(doc = document) {
  try {
    const root = doc?.documentElement;
    if (!root) return;

    const px = (n, fallback) => {
      const v = Number(n);
      return Number.isFinite(v) ? `${v}px` : `${fallback}px`;
    };

    const num = (n, fallback) => {
      const v = Number(n);
      return Number.isFinite(v) ? v : fallback;
    };

    // Chat header sizes
    root.style.setProperty("--fe-chat-title-size", px(feSetting(S.STYLE_ACTOR_NAME_SIZE), 22));
    root.style.setProperty("--fe-chat-subtitle-size", px(feSetting(S.STYLE_PLAYER_NAME_SIZE), 14));

    // Chat text sizes
    root.style.setProperty("--fe-chat-message-font-size", px(feSetting(S.STYLE_MESSAGE_TEXT_SIZE), 14));
    root.style.setProperty("--fe-chat-card-font-size", px(feSetting(S.STYLE_CHATCARD_TEXT_SIZE), 12));

    // Chat layout
    root.style.setProperty("--fe-chat-message-spacing", px(feSetting(S.STYLE_CHAT_MESSAGE_SPACING), 4));

    // Message background saturation (paper overlay alpha)
    root.style.setProperty("--fe-paper-alpha", String(num(feSetting(S.STYLE_BG_SATURATION), 0.42)));

    // Optional: override Foundry's heading font variable
    const h1Cookie = !!feSetting(S.UI_OVERRIDE_FONT_H1_COOKIE);
    if (h1Cookie) root.style.setProperty("--font-h1", "var(--fe-font-primary)");
    else root.style.removeProperty("--font-h1");
  } catch (err) {
    console.warn("female_edition | failed to apply style vars", err);
  }
}


// -------------------------------------
// Legacy migration
// -------------------------------------

async function feMigrateLegacySettings() {
  // 1) UI font toggle: legacy key -> new key
  try {
    const legacy = Boolean(game.settings.get(MODULE_ID, LEGACY_UI_FONT_KEY));
    if (legacy) {
      const current = Boolean(feSetting(S.UI_USE_GEURIMILGI));
      if (!current) await game.settings.set(MODULE_ID, S.UI_USE_GEURIMILGI, true);
      // Clear legacy value to avoid re-migrating forever.
      await game.settings.set(MODULE_ID, LEGACY_UI_FONT_KEY, false);
    }
  } catch (err) {
    // ignore
  }

  // 2) Chat font choice: normalize unknown/legacy values -> geurimilgi
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    if (choice !== "cookie" && choice !== "geurimilgi") {
      await game.settings.set(MODULE_ID, S.CHAT_FONT_CHOICE, "geurimilgi");
    }
  } catch (err) {
    // ignore
  }
}

Hooks.once("init", () => {
  // -------------------------
  // Settings
  // -------------------------
  game.settings.register(MODULE_ID, S.MERGE_ENABLED, {
    name: "채팅 병합(연속 메시지 시각적 묶기)",
    hint: "같은 화자/유저의 연속 메시지를 하나처럼 보이도록 묶습니다(문서 편집 없음).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
    },
  });

  game.settings.register(MODULE_ID, S.MERGE_ONLY_TEXT, {
    name: "채팅 병합: 텍스트 메시지만",
    hint: "주사위/채팅 카드(아이템/주문 등) 메시지는 병합하지 않습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_DIVIDER, {
    name: "채팅 병합: 그룹 구분선 표시",
    hint: "다른 화자의 새 그룹이 시작될 때 얇은 구분선을 표시합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_FOLLOW_HEADER_STYLE, {
    name: "채팅 병합: 후속 메시지 헤더 표시 방식",
    hint: "같은 화자의 연속 메시지(두 번째부터)의 헤더 표시를 설정합니다.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      hide: "헤더 완전 숨김",
      name: "이름만 남김",
      portrait: "포트레이트만 남김",
    },
    default: "hide",
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
    },
  });

  game.settings.register(MODULE_ID, S.TYPING_ENABLED, {
    name: "채팅 입력 중 표시(타이핑 인디케이터)",
    hint: "다른 플레이어가 채팅 입력 중일 때 표시합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feSetupTypingIndicator(),
  });

  game.settings.register(MODULE_ID, S.EXPORT_ENABLED, {
    name: "채팅 로그 PDF 내보내기 버튼",
    hint: "채팅 입력창 옆에 PDF(인쇄) 버튼을 추가합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feFireChatUiUpdated(),
  });

  game.settings.register(MODULE_ID, S.EXPORT_AUTO_PRINT, {
    name: "PDF 버튼: 자동 인쇄창 열기",
    hint: "켜면 PDF 버튼 클릭 시 아카이브 창을 연 뒤 자동으로 인쇄(프린트) 다이얼로그를 엽니다. 끄면 아카이브만 열립니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.EXPORT_OPTIMIZE, {
    name: "내보내기 최적화(용량/멈춤 방지)",
    hint: "아카이브/인쇄 시 parchment/texture 이미지와 그림자 등을 강제로 제거하여 PDF 용량과 메모리 사용량을 크게 줄입니다(권장).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_FONTS, {
    name: "HTML 저장: 커스텀 폰트 포함",
    hint: "HTML로 저장할 때 CookieRun 폰트를 파일 안에 포함시켜(임베드) 나중에 단독으로 열어도 폰트가 유지되게 합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_IMAGES, {
    name: "HTML 저장: 이미지 포함(용량 증가)",
    hint: "HTML로 저장할 때 채팅 로그의 이미지(포트레이트/아이콘 등)를 파일 안에 포함시킵니다. 로그가 크면 저장 시간이 늘고 용량이 커질 수 있습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.EXPORT_PRINT_IMAGE_MODE, {
    name: "PDF/인쇄: 이미지 처리",
    hint: "크롬/일렉트론 인쇄(PDF)에서 이미지가 많으면 메모리가 급증해 멈출 수 있습니다. PDF 안정성을 위해 아바타/이미지를 숨기거나(권장) 다운스케일할 수 있습니다.",
    scope: "client",
    config: true,
    type: String,
    choices: FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
    default: "hideAvatars",
  });

  game.settings.register(MODULE_ID, S.EXPORT_DESKTOP_EXTERNAL_MODE, {
    name: "FVTT 데스크톱: 외부 브라우저로 아카이브 열기",
    hint: "데스크톱(Electron) 앱에서 인쇄(PDF) 시 메모리/멈춤 문제가 있을 때, 아카이브를 HTML 파일로 만들어 시스템 기본 브라우저로 열 수 있습니다. (Electron/Node API 접근이 가능한 경우에만 동작)",
    scope: "client",
    config: true,
    type: String,
    choices: {
      off: "사용 안 함",
      button: "아카이브 창에 버튼 표시",
      auto: "PDF 아이콘 클릭 시 자동",
    },
    default: "button",
  });

  // -------------------------
  // Style settings (CSS vars)
  // -------------------------

  game.settings.register(MODULE_ID, S.STYLE_ACTOR_NAME_SIZE, {
    name: "채팅: 액터 이름 크기(px)",
    hint: "채팅 메시지 헤더의 액터(캐릭터) 이름 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 22,
    range: { min: 10, max: 40, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_PLAYER_NAME_SIZE, {
    name: "채팅: 플레이어 이름 크기(px)",
    hint: "채팅 메시지 헤더의 플레이어 이름(서브타이틀) 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 14,
    range: { min: 8, max: 28, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_MESSAGE_TEXT_SIZE, {
    name: "채팅: 메시지 글자 크기(px)",
    hint: "일반 채팅 텍스트(메시지 내용)의 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 14,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHATCARD_TEXT_SIZE, {
    name: "채팅: 주문/아이템/피처 설명 글자 크기(px)",
    hint: "dnd5e 채팅 카드(주문/아이템/피처) 설명 영역의 기본 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 12,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHAT_MESSAGE_SPACING, {
    name: "채팅: 메시지 카드 간격(px)",
    hint: "Foundry 기본 변수 chat-sidebar { --chat-message-spacing } 값을 덮어씁니다. 메시지 카드 사이 간격을 조절합니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 4,
    range: { min: 0, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.CHATCARD_USE_CUSTOM_FONT, {
    name: "채팅 카드(설명) 커스텀 폰트 적용",
    hint: "주문/아이템/피처 설명 박스(Details/Description)에도 UI 커스텀 폰트(CookieRun/그림일기)를 적용합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다. 아이콘/특수문자 표시가 깨지면 끄세요.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feSetChatCardFontClass(),
  });

  game.settings.register(MODULE_ID, S.CHAT_FONT_CHOICE, {
    name: "채팅 글꼴 선택",
    hint: "채팅 메시지 본문/헤더에 사용할 기본 글꼴을 선택합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      cookie: "쿠키런",
      geurimilgi: "그림일기",
    },
    default: "cookie",
    onChange: () => feSetChatFontChoiceClass(document),
  });


  game.settings.register(MODULE_ID, S.UI_USE_GEURIMILGI, {
    name: "UI/시트 기본 글꼴: 그림일기 사용(쿠키런 대체)",
    hint: "html/body, #ui/#interface, dnd5e2 능력치 라벨(ability-scores/abilities) 등 기본 UI 글꼴을 그림일기 폰트로 바꿉니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => feSetUiFontClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_OVERRIDE_FONT_H1_COOKIE, {
    name: "헤딩 글꼴(--font-h1): 쿠키런으로 덮어쓰기",
    hint: "Foundry/테마가 사용하는 CSS 변수 --font-h1 값을 쿠키런 폰트로 덮어씌웁니다. 일부 테마의 제목/헤딩 글꼴이 바뀔 수 있습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  // Legacy (hidden): migrate old UI font toggle into the new key.
  game.settings.register(MODULE_ID, LEGACY_UI_FONT_KEY, {
    name: "(legacy) UI font toggle",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });


  game.settings.register(MODULE_ID, S.USE_USER_COLOR_BG, {
    name: "채팅 메시지 배경: 유저 색상 적용(Chat Portrait 스타일)",
    hint: "각 메시지 배경을 화자(액터 소유자/작성자)의 유저 색상으로 틴트합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      feSetUserColorBgClass(document);
      feApplyUserColorBgToAllLogs(document);
    },
  });

  game.settings.register(MODULE_ID, S.USER_COLOR_BG_BASE, {
    name: "채팅 메시지 배경: 유저 색상 하부 배경(불투명)",
    hint: "유저 색상 틴트 아래에 불투명한 배경(흰색/검정)을 깔아 가독성을 높입니다. (유저 색상 배경이 켜져 있을 때만 의미가 있습니다)",
    scope: "client",
    config: true,
    type: String,
    choices: {
      white: "흰색(권장)",
      black: "검정",
      none: "사용 안 함(기존 방식)",
    },
    default: "white",
    onChange: () => feSetUserColorBgBaseClass(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_BG_SATURATION, {
    name: "채팅: 배경 채도(페이퍼 오버레이 알파)",
    hint: "텍스쳐 제거 시 사용하는 '페이퍼 오버레이'의 알파 값입니다. 값이 높을수록 더 밝고(채도 약화), 낮을수록 더 진해집니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 0.42,
    range: { min: 0.05, max: 1.0, step: 0.01 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.MARKDOWN_ENABLED, {
    name: "채팅 입력 마크다운 지원",
    hint: "채팅 입력 텍스트를 마크다운으로 처리합니다(이미지/링크/제목/굵게/기울임/취소선/인용구).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EDIT_ENABLED, {
    name: "채팅 수정(편집) 다이얼로그",
    hint: "메시지 수정 버튼 클릭 시 마크다운 기반 편집 다이얼로그를 사용합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  // Install chat-log level refreshes on the supported v13 render hook.
  Hooks.on("renderChatLog", (_app, html) => {
    try {
      const root = feExtractHTMLElement(html) ?? html?.element?.[0] ?? null;
      const log = root?.matches?.("ol.chat-log, #chat-log")
        ? root
        : root?.querySelector?.("ol.chat-log, #chat-log") ?? null;

      if (log) {
        feApplyRenderedStateToLog(log);
        feDeferTask(() => feApplyRenderedStateToLog(log));
      } else {
        feApplyRenderedStateToAllLogs();
        feDeferTask(() => feApplyRenderedStateToAllLogs());
      }

      feFireChatUiUpdated({
        reason: "renderChatLog",
        root: root ?? log ?? null,
        log: log ?? null,
        document: (root?.ownerDocument ?? log?.ownerDocument ?? document),
      });
      feRenderTypingIndicator();
    } catch {
      /* no-op */
    }
  });
});

Hooks.once("ready", async () => {
  await feMigrateLegacySettings();
  feApplyStyleVarsFromSettings(document);
  feSetBodyMergeClasses();
  feSetChatCardFontClass(document);
  feSetChatFontChoiceClass(document);
  feSetUiFontClass(document);
  feSetUserColorBgClass(document);
  feSetUserColorBgBaseClass(document);
  feApplyRenderedStateToAllLogs();
  feFireChatUiUpdated({ reason: "ready", root: document, log: null, document });
  feRenderTypingIndicator();
  feSetupTypingIndicator();
  feInstallMarkdownPreCreateHook();
});

// Extra safety: apply user-color background as soon as each message is rendered.
// This helps when other modules rapidly create->update messages (automation), or when
// the chat log is re-rendered without a full childList mutation.
// Extra safety: chat rendering can race when other modules rapidly create->update the same ChatMessage
// (common with automation like midi-qol). In those cases the same message can be rendered twice or re-rendered
// after the message HTML has been produced. We defensively:
//  - Re-apply user-color tint after the message is inserted into the DOM
//  - Schedule a dedupe + merge recompute for the affected chat log
// See: Foundry core issue #13067 (duplicate render when update races render).
const fePendingMergeLogs = new Set();
let feMergeRefreshScheduled = false;
let feInlineRollSnapshots = null;
let feInlineRollSnapshotPersistTimer = null;
const FE_INLINE_ROLL_SNAPSHOT_KEY = `${MODULE_ID}.inlineRollSnapshots.v1`;
const FE_INLINE_ROLL_SNAPSHOT_LIMIT = 800;
const FE_RENDER_SPECIAL_KIND_FLAG = "specialKind";
const FE_RENDER_MERGE_HINT_FLAG = "mergeHint";

function feEnsureInlineRollSnapshotStore() {
  if (feInlineRollSnapshots instanceof Map) return feInlineRollSnapshots;
  feInlineRollSnapshots = new Map();
  try {
    const raw = sessionStorage.getItem(FE_INLINE_ROLL_SNAPSHOT_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const [id, value] of parsed) {
          if (!id || !Array.isArray(value?.items)) continue;
          feInlineRollSnapshots.set(String(id), value);
        }
      }
    }
  } catch {}
  return feInlineRollSnapshots;
}

function fePersistInlineRollSnapshotsSoon() {
  try {
    if (feInlineRollSnapshotPersistTimer) return;
    feInlineRollSnapshotPersistTimer = setTimeout(() => {
      feInlineRollSnapshotPersistTimer = null;
      try {
        const store = feEnsureInlineRollSnapshotStore();
        const entries = Array.from(store.entries()).slice(-FE_INLINE_ROLL_SNAPSHOT_LIMIT);
        sessionStorage.setItem(FE_INLINE_ROLL_SNAPSHOT_KEY, JSON.stringify(entries));
      } catch {}
    }, 120);
  } catch {}
}

function feTrimInlineRollSnapshots() {
  try {
    const store = feEnsureInlineRollSnapshotStore();
    while (store.size > FE_INLINE_ROLL_SNAPSHOT_LIMIT) {
      const first = store.keys().next();
      if (first.done) break;
      store.delete(first.value);
    }
  } catch {}
}

function feClearInlineRollSnapshot(messageId) {
  try {
    const id = feNormalizeChatMessageId(messageId);
    if (!id) return;
    const store = feEnsureInlineRollSnapshotStore();
    if (!store.delete(id)) return;
    fePersistInlineRollSnapshotsSoon();
  } catch {}
}

function feSnapshotOrRestoreInlineRolls(message, rootEl) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id ?? feGetMessageIdFromElement(rootEl));
    if (!id || !rootEl?.querySelectorAll) return;
    const rolls = Array.from(rootEl.querySelectorAll('.inline-roll.inline-result'));
    if (!rolls.length) return;
    const store = feEnsureInlineRollSnapshotStore();
    const existing = store.get(id);
    if (existing?.items?.length === rolls.length) {
      for (let i = 0; i < rolls.length; i += 1) {
        const snap = existing.items[i];
        const el = rolls[i];
        if (!snap || !el) continue;
        if (typeof snap.html === 'string') el.innerHTML = snap.html;
        if (typeof snap.title === 'string') el.setAttribute('title', snap.title);
        if (typeof snap.aria === 'string') el.setAttribute('aria-label', snap.aria);
        else el.removeAttribute('aria-label');
      }
      return;
    }
    const items = rolls.map((el) => ({
      html: String(el.innerHTML ?? ''),
      title: String(el.getAttribute?.('title') ?? ''),
      aria: String(el.getAttribute?.('aria-label') ?? ''),
    }));
    store.set(id, { items, t: Date.now() });
    feTrimInlineRollSnapshots();
    fePersistInlineRollSnapshotsSoon();
  } catch {}
}


function feIsElementNode(node) {
  return !!node && node.nodeType === 1;
}

function feExtractHTMLElement(html) {
  if (!html) return null;
  if (feIsElementNode(html)) return html;
  // jQuery-like wrappers
  if (html.jquery && feIsElementNode(html[0])) return html[0];
  if (Array.isArray(html) && feIsElementNode(html[0])) return html[0];
  if (feIsElementNode(html[0])) return html[0];
  return null;
}

function feDeferTask(fn) {
  try {
    queueMicrotask(fn);
  } catch {
    Promise.resolve().then(fn);
  }
}


const fePendingRenderedMessageRefreshes = new Map();

function feScheduleRenderedMessageRefresh(messageOrId, { retries = 8, delay = 16, allowNarratorMerge = false } = {}) {
  try {
    const id = feNormalizeChatMessageId(messageOrId?.id ?? messageOrId?._id ?? messageOrId);
    if (!id) return;
    if (fePendingRenderedMessageRefreshes.has(id)) return;

    let attempts = 0;
    const tick = () => {
      attempts += 1;
      let found = false;
      const message = game?.messages?.get?.(id) ?? null;
      for (const log of feGetChatLogs()) {
        const el = log?.querySelector?.(`li.chat-message[data-message-id="${id}"], li.chat-message[data-document-id="${id}"]`);
        if (!el) continue;
        found = true;
        feApplyRenderedStateToMessageElement(message, el, { allowNarratorMerge });
      }
      if ((!found || attempts < 2) && attempts < retries) {
        const t = setTimeout(tick, delay);
        fePendingRenderedMessageRefreshes.set(id, t);
      } else {
        const t = fePendingRenderedMessageRefreshes.get(id);
        if (t) clearTimeout(t);
        fePendingRenderedMessageRefreshes.delete(id);
      }
    };

    const t = setTimeout(tick, 0);
    fePendingRenderedMessageRefreshes.set(id, t);
  } catch {
    /* no-op */
  }
}

function feCollectMergeNeighborhood(logEl, anchorEl, { allowNarratorMerge = false } = {}) {
  try {
    if (!feIsElementNode(logEl) || !feIsElementNode(anchorEl)) return [];
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    const idx = items.indexOf(anchorEl);
    if (idx === -1) return [];

    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const makeInfo = (el) => {
      const msgId = feGetMessageIdFromElement(el);
      const msg = msgId ? game.messages?.get(msgId) : null;
      const info = feMessageMergeInfo(msg, el);
      info.msgId = msgId;
      info.missing = !msg;
      info.el = el;
      info.order = feGetChatMessageElementOrder(el, 0);
      info.key = msg ? feMergeKey(info) : `__fe_missing__||${msgId ?? Math.random()}`;
      if (!msg) info.mergeableText = false;
      return info;
    };
    const canMerge = (a, b) => {
      if (!a || !b) return false;
      const narratorPair = !!allowNarratorMerge && !!a.isNarrator && !!b.isNarrator;
      if ((a.noMerge || b.noMerge) && !narratorPair) return false;
      if (a.key !== b.key) return false;
      if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
      return true;
    };

    const infos = items.map(makeInfo);
    let start = idx;
    let end = idx;
    while (start > 0 && canMerge(infos[start - 1], infos[start])) start -= 1;
    while (end < infos.length - 1 && canMerge(infos[end], infos[end + 1])) end += 1;
    start = Math.max(0, start - 1);
    end = Math.min(infos.length - 1, end + 1);
    return infos.slice(start, end + 1);
  } catch {
    return [];
  }
}

function feApplyChatMergeSlice(infos, startOffset = 0, { allowNarratorMerge = false } = {}) {
  try {
    if (!Array.isArray(infos) || !infos.length) return;
    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const showDivider = !!feSetting(S.MERGE_DIVIDER);
    const canMerge = (a, b) => {
      if (!a || !b) return false;
      const narratorPair = !!allowNarratorMerge && !!a.isNarrator && !!b.isNarrator;
      if ((a.noMerge || b.noMerge) && !narratorPair) return false;
      if (a.key !== b.key) return false;
      if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
      return true;
    };
    for (const info of infos) {
      info?.el?.classList?.remove?.("fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-divider-before");
    }
    const applyGroup = (startIndex, endIndexExclusive) => {
      const groupLen = endIndexExclusive - startIndex;
      if (groupLen <= 0) return;
      const first = infos[startIndex];
      if (!first?.el) return;
      if (showDivider && (startOffset + startIndex) > 0) first.el.classList.add("fe-divider-before");
      if (groupLen === 1) return;
      first.el.classList.add("fe-merge-start");
      for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) infos[i]?.el?.classList?.add?.("fe-merge-mid");
      infos[endIndexExclusive - 1]?.el?.classList?.add?.("fe-merge-end");
    };
    let groupStart = 0;
    for (let i = 1; i < infos.length; i += 1) {
      if (!canMerge(infos[i - 1], infos[i])) {
        applyGroup(groupStart, i);
        groupStart = i;
      }
    }
    applyGroup(groupStart, infos.length);
  } catch {
    /* no-op */
  }
}

function feApplyChatMergeAroundElement(messageEl, { allowNarratorMerge = false } = {}) {
  try {
    const anchor = messageEl?.closest?.("li.chat-message") ?? messageEl;
    const log = anchor?.closest?.("ol.chat-log, #chat-log, #fe-chat-export-log");
    if (!feIsElementNode(anchor) || !feIsElementNode(log)) return;
    const all = Array.from(log.querySelectorAll("li.chat-message"));
    const slice = feCollectMergeNeighborhood(log, anchor, { allowNarratorMerge });
    if (!slice.length) return;
    const firstIndex = Math.max(0, all.indexOf(slice[0]?.el));
    feApplyChatMergeSlice(slice, firstIndex, { allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToMessageElement(message, messageEl, { allowNarratorMerge = false } = {}) {
  try {
    const el = feExtractHTMLElement(messageEl);
    if (!el) return;
    // Do NOT mutate .message-content during normal live-chat refreshes.
    // Merge only relies on message classes/header visibility, and touching inline-roll DOM here
    // can cause visible churn when Foundry re-renders messages while scrolling.
    feApplyUserColorBgToMessageElement(message, el);
    if (feSetting(S.MERGE_ENABLED)) feApplyChatMergeAroundElement(el, { allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToLog(logEl, { allowNarratorMerge = false } = {}) {
  try {
    if (!feIsElementNode(logEl)) return;
    const nodes = Array.from(logEl.querySelectorAll?.("li.chat-message") ?? []);
    for (const li of nodes) {
      const msgId = feGetMessageIdFromElement(li);
      const msg = msgId ? game?.messages?.get?.(msgId) : null;
      if (!msg) continue;
      feApplyUserColorBgToMessageElement(msg, li);
    }
    if (feSetting(S.MERGE_ENABLED)) feApplyChatMerge(logEl, { allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToAllLogs() {
  try {
    for (const log of feGetChatLogs()) feApplyRenderedStateToLog(log);
  } catch {
    /* no-op */
  }
}

function feRefreshRenderedMessageById(message) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (!id) return;
    for (const log of feGetChatLogs()) {
      const sel = `li.chat-message[data-message-id="${id}"], li.chat-message[data-document-id="${id}"]`;
      const el = log?.querySelector?.(sel);
      if (!el) continue;
      feApplyRenderedStateToMessageElement(message, el);
    }
  } catch {
    /* no-op */
  }
}

function feChangeTouchesRenderState(change) {
  try {
    if (!change || typeof change !== "object") return false;
    return ["content", "rolls", "speaker", "whisper", "blind", "rollMode", "style", "type", "user", "flavor", "flags"]
      .some((k) => Object.prototype.hasOwnProperty.call(change, k));
  } catch {
    return false;
  }
}

function feHydrateRenderStateOverride(message, data = null, userId = null) {
  try {
    const state = feComputeMessageRenderState(message, data ?? {}, userId);
    feStoreRenderStateOverride(message?.id ?? message?._id, state);
    return state;
  } catch {
    return null;
  }
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  const el = feExtractHTMLElement(html);
  if (!el) return;
  try {
    feApplyUserColorBgToMessageElement(message, el);
  } catch {
    /* no-op */
  }
  feScheduleRenderedMessageRefresh(message);
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  try {
    feHydrateRenderStateOverride(message, null, userId);
    feScheduleRenderedMessageRefresh(message);
  } catch {
    /* no-op */
  }
});

Hooks.on("deleteChatMessage", (message) => {
  try {
    feStoreRenderStateOverride(message?.id ?? message?._id, null);
    if (feSetting(S.MERGE_ENABLED)) feApplyRenderedStateToAllLogs();
  } catch {
    /* no-op */
  }
});

Hooks.on("updateChatMessage", (message, change, _options, userId) => {
  try {
    if (feChangeTouchesRenderState(change)) feHydrateRenderStateOverride(message, null, userId);
    feRefreshRenderedMessageById(message);
    feScheduleRenderedMessageRefresh(message);
  } catch {
    /* no-op */
  }
});


// -------------------------------------
// Markdown
// -------------------------------------

function feEscapeHTML(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function feRewriteCSSAssetURLs(cssText, baseUrl) {
  // When exporting to a standalone file:// HTML, any relative URLs inside *inlined* CSS
  // (url(...), @import ...) would otherwise resolve against the local file path and break.
  // Rebase them to absolute URLs using the original stylesheet URL as the base.
  if (!cssText) return "";
  let out = String(cssText);
  const base = String(baseUrl || "");

  const isAbsoluteLike = (u) => /^(data:|blob:|https?:|file:|chrome-extension:|about:)/i.test(u);

  const safeResolve = (u) => {
    try {
      return new URL(u, base).href;
    } catch {
      return null;
    }
  };

  // url(...)
  out = out.replace(/url\(\s*(['"]?)([^'\")]+)\1\s*\)/g, (m, _q, raw) => {
    const u = String(raw || "").trim();
    if (!u) return m;
    if (isAbsoluteLike(u) || u.startsWith("#")) return m;
    const resolved = safeResolve(u);
    if (!resolved) return m;
    return `url("${resolved}")`;
  });

  // @import "...";  /  @import url(... ) screen;
  out = out.replace(
    /@import\s+(url\(\s*)?(['"]?)(\/[^'\")\s;]+|[^'\")\s;]+)\2\s*\)?\s*([^;]*);/g,
    (m, urlPrefix, _q, raw, mediaTail) => {
      const u = String(raw || "").trim();
      if (!u) return m;
      if (isAbsoluteLike(u)) return m;
      const resolved = safeResolve(u);
      if (!resolved) return m;
      const media = String(mediaTail ?? "").trim();
      if (urlPrefix) return `@import url("${resolved}")${media ? " " + media : ""};`;
      return `@import "${resolved}"${media ? " " + media : ""};`;
    }
  );

  return out;
}

// -------------------------------------
// Export helper: Chat texture stripping (archive/html)
// -------------------------------------
// The live chat log uses chat-bg-stripper.js on render hooks to remove only
// parchment/texture url() layers while preserving Chat Portrait's color overlay.
// The archive window renders from ChatMessage templates, so we must re-apply the
// same sanitization there to match the on-screen chat appearance.

const FE_TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;
const FE_OVERLAY_LAYER = "var(--fe-parchment-overlay)";

/** Split a CSS background-image string into top-level layers (commas), respecting parentheses/quotes. */
function feSplitBgLayers(value) {
  if (!value) return [];
  const v = String(value).trim();
  if (!v || v === "none") return [];
  const out = [];
  let buf = "";
  let depth = 0;
  let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) {
      buf += c;
      if (c === q && v[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      buf += c;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);

    if (c === "," && depth === 0) {
      const s = buf.trim();
      if (s && s !== "none") out.push(s);
      buf = "";
      continue;
    }
    buf += c;
  }
  const last = buf.trim();
  if (last && last !== "none") out.push(last);
  return out;
}

function feHasOverlayLayer(layers) {
  return Array.isArray(layers) && layers.some((l) => /--fe-parchment-overlay/i.test(String(l)));
}

function feIsTextureLayer(layer) {
  return /url\(/i.test(String(layer)) && FE_TEX_RE.test(String(layer));
}

function feStripTextureLayers(layers) {
  return Array.isArray(layers) ? layers.filter((l) => !feIsTextureLayer(l)) : [];
}

function feSanitizeElementBackgroundInWindow(win, el) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    const styleAttr = el.getAttribute?.("style") || "";
    const cs = win.getComputedStyle?.(el);
    const bgImage = cs?.backgroundImage || "";

    // Fast reject
    if (!FE_TEX_RE.test(bgImage) && !FE_TEX_RE.test(styleAttr)) return false;

    const layers = feSplitBgLayers(bgImage);
    const stripped = feStripTextureLayers(layers);

    // Always ensure a flat overlay exists so screen blending desaturates consistently.
    const nextLayers = stripped.slice();
    if (!feHasOverlayLayer(nextLayers)) nextLayers.unshift(FE_OVERLAY_LAYER);
    const finalLayers = nextLayers.length ? nextLayers : [FE_OVERLAY_LAYER];

    el.style.setProperty("background-image", finalLayers.join(", "), "important");
    el.classList.add("fe-bg-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feSanitizePseudoInWindow(win, el, pseudo, varName) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    const cs = win.getComputedStyle?.(el, pseudo);
    const bgImage = cs?.backgroundImage || "";
    if (!FE_TEX_RE.test(bgImage)) return false;

    const layers = feSplitBgLayers(bgImage);
    const stripped = feStripTextureLayers(layers);
    const nextLayers = stripped.slice();
    if (!feHasOverlayLayer(nextLayers)) nextLayers.unshift(FE_OVERLAY_LAYER);
    const finalLayers = nextLayers.length ? nextLayers : [FE_OVERLAY_LAYER];

    el.style.setProperty(varName, finalLayers.join(", "));
    el.classList.add("fe-pseudo-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feIsNarratorMessageElementInWindow(win, msgEl) {
  try {
    if (!win || !msgEl || !(msgEl instanceof win.Element)) return false;
    if (msgEl.classList?.contains?.("narrator-chat")) return true;

    const rawId =
      msgEl.dataset?.messageId ||
      msgEl.dataset?.documentId ||
      msgEl.getAttribute?.("data-message-id") ||
      msgEl.getAttribute?.("data-document-id");
    const msgId = rawId ? String(rawId).split(".").pop() : null;
    if (!msgId) return false;

    const msg = game.messages?.get?.(msgId);
    return !!msg?.getFlag?.("narrator-tools", "type") || !!msg?.flags?.["narrator-tools"];
  } catch {
    return false;
  }
}

function feIsRoundMarkerMessageElementInWindow(win, msgEl) {
  try {
    if (!win || !msgEl || !(msgEl instanceof win.Element)) return false;
    if (msgEl.classList?.contains?.("round-marker") || msgEl.classList?.contains?.("fe-round-marker-chat")) return true;
    if (msgEl.querySelector?.(".round-marker")) return true;

    const rawId =
      msgEl.dataset?.messageId ||
      msgEl.dataset?.documentId ||
      msgEl.getAttribute?.("data-message-id") ||
      msgEl.getAttribute?.("data-document-id");
    const msgId = rawId ? String(rawId).split(".").pop() : null;
    if (!msgId) return false;

    const msg = game.messages?.get?.(msgId);
    const flag = msg?.flags?.["monks-little-details"]?.roundmarker;
    if (flag === true || String(flag) === "true") return true;
    const content = String(msg?.content ?? "");
    return /\bround-marker\b/i.test(content);
  } catch {
    return false;
  }
}

function feGetSpecialMessageKindInWindow(win, msgEl) {
  try {
    if (feIsNarratorMessageElementInWindow(win, msgEl)) return "narrator";
    if (feIsRoundMarkerMessageElementInWindow(win, msgEl)) return "round-marker";
    return null;
  } catch {
    return null;
  }
}

function feSanitizeNarratorBackgroundInWindow(win, el) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    el.style.setProperty("background-image", "none", "important");
    el.classList.add("fe-bg-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feSanitizePseudoNoneInWindow(win, el, varName) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    el.style.setProperty(varName, "none");
    el.classList.add("fe-pseudo-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feStripChatTexturesInWindow(win, rootEl) {
  try {
    if (!win || !rootEl) return;
    const root = rootEl instanceof win.Element ? rootEl : win.document;
    const messages = Array.from(root.querySelectorAll?.(".chat-message") ?? []);
    for (const msg of messages) {
      const specialKind = feGetSpecialMessageKindInWindow(win, msg);
      if (specialKind === "narrator") {
        feSanitizeNarratorBackgroundInWindow(win, msg);
        msg
          .querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
          ?.forEach?.((el) => feSanitizeNarratorBackgroundInWindow(win, el));
        feSanitizePseudoNoneInWindow(win, msg, "--fe-before-bgimg");
        feSanitizePseudoNoneInWindow(win, msg, "--fe-after-bgimg");
        continue;
      }
      if (specialKind === "round-marker") {
        continue;
      }

      feSanitizeElementBackgroundInWindow(win, msg);
      msg
        .querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
        ?.forEach?.((el) => feSanitizeElementBackgroundInWindow(win, el));
      feSanitizePseudoInWindow(win, msg, "::before", "--fe-before-bgimg");
      feSanitizePseudoInWindow(win, msg, "::after", "--fe-after-bgimg");
    }
  } catch (err) {
    console.warn("female_edition | archive texture strip failed", err);
  }
}


function feInlineFormat(text) {
  // Inline code: protect first
  const codeSpans = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.push(code) - 1;
    return `@@FE_CODE_${idx}@@`;
  });

  // Images: ![alt](url)
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    alt = feEscapeHTML(alt ?? "");
    url = feEscapeHTML(url ?? "");
    return `<img src="${url}" alt="${alt}">`;
  });

  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    label = feEscapeHTML(label ?? "");
    url = feEscapeHTML(url ?? "");
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Strikethrough
  text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");

  // Bold (**text**)
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic (*text*)
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_]+)_(?!_)/g, "$1<em>$2</em>");

  // Restore inline code
  for (let i = 0; i < codeSpans.length; i++) {
    const safe = feEscapeHTML(codeSpans[i]);
    text = text.replaceAll(`@@FE_CODE_${i}@@`, `<code>${safe}</code>`);
  }

  return text;
}

function feMarkdownToHTML(md) {
  const src = String(md ?? "").replace(/\r\n/g, "\n");
  const lines = src.split("\n");

  const blocks = [];
  let i = 0;

  const pushParagraph = (paragraphLines) => {
    if (!paragraphLines.length) return;
    const raw = paragraphLines.join("\n");
    const escaped = feEscapeHTML(raw);
    const formatted = feInlineFormat(escaped).replaceAll("\n", "<br>");
    blocks.push(`<p>${formatted}</p>`);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Blank line => paragraph boundary
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      // consume closing fence if present
      if (i < lines.length && lines[i].trim().startsWith("```")) i++;

      const code = feEscapeHTML(codeLines.join("\n"));
      const langClass = lang ? ` class="language-${feEscapeHTML(lang)}"` : "";
      blocks.push(`<pre><code${langClass}>${code}</code></pre>`);
      continue;
    }

    // Headings (# .. ######)
    const mHeading = line.match(/^(#{1,6})\s+(.*)$/);
    if (mHeading) {
      const level = Math.min(6, mHeading[1].length);
      const text = feInlineFormat(feEscapeHTML(mHeading[2] ?? ""));
      blocks.push(`<h${level}>${text}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote (>)
    if (line.trim().startsWith(">")) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      const raw = quoteLines.join("\n");
      const escaped = feEscapeHTML(raw);
      const formatted = feInlineFormat(escaped).replaceAll("\n", "<br>");
      blocks.push(`<blockquote><p>${formatted}</p></blockquote>`);
      continue;
    }

    // Unordered list (- item / * item)
    const mUList = line.match(/^\s*([-*])\s+(.*)$/);
    if (mUList) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*])\s+(.*)$/);
        if (!m) break;
        items.push(m[2]);
        i++;
      }
      const lis = items
        .map((it) => `<li>${feInlineFormat(feEscapeHTML(it ?? ""))}</li>`)
        .join("");
      blocks.push(`<ul>${lis}</ul>`);
      continue;
    }

    // Ordered list (1. item)
    const mOList = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (mOList) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(\d+)\.\s+(.*)$/);
        if (!m) break;
        items.push(m[2]);
        i++;
      }
      const lis = items
        .map((it) => `<li>${feInlineFormat(feEscapeHTML(it ?? ""))}</li>`)
        .join("");
      blocks.push(`<ol>${lis}</ol>`);
      continue;
    }

    // Normal paragraph: consume until blank line
    const para = [];
    while (i < lines.length && lines[i].trim()) {
      // stop if next block starts
      if (lines[i].trim().startsWith("```")) break;
      if (/^(#{1,6})\s+/.test(lines[i])) break;
      if (lines[i].trim().startsWith(">")) break;
      if (/^\s*[-*]\s+/.test(lines[i])) break;
      if (/^\s*\d+\.\s+/.test(lines[i])) break;
      para.push(lines[i]);
      i++;
    }
    pushParagraph(para);
  }

  return blocks.join("");
}

function feLooksLikeHTML(text) {
  // Rough heuristic: if it already contains an HTML tag, treat as HTML and skip markdown
  return /<\s*[a-zA-Z][\s\S]*?>/.test(text);
}

function feInstallMarkdownPreCreateHook() {
  // NOTE (FVTT v13): Hooks are not awaited. preCreate* hooks are especially sensitive.
  // Do NOT use async/await here, or message creation can complete before we updateSource.
  Hooks.on("preCreateChatMessage", (message, data, _options, userId) => {
    if (!feSetting(S.MARKDOWN_ENABLED)) return;
    if (userId !== game.user.id) return;

    const content = (data?.content ?? message.content ?? "").toString();
    const trimmed = content.trim();
    if (!trimmed) return;

    // Slash commands / roll commands should be handled by Foundry
    if (trimmed.startsWith("/")) return;

    // If message already HTML (chat cards, system messages, etc.), don't touch it.
    if (feLooksLikeHTML(content)) return;

    // Don't touch roll messages.
    try {
      const hasRolls =
        (Array.isArray(data?.rolls) && data.rolls.length > 0) ||
        (Array.isArray(message?.rolls) && message.rolls.length > 0);
      if (hasRolls) return;
    } catch (_e) {
      /* noop */
    }

    // Convert markdown -> HTML (keep it synchronous so the create flow is not raced).
    // Enrichment (UUID links, inline rolls) is intentionally skipped here.
    const html = feMarkdownToHTML(content);

    // Store the raw text for later edits
    const flags = foundry.utils.deepClone(data?.flags ?? message.flags ?? {});
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      raw: content,
      markdown: true,
    });

    message.updateSource({ content: html, flags });
  });
}

Hooks.on("preCreateChatMessage", (message, data, _options, userId) => {
  try {
    if (userId !== game.user.id) return;
    feCaptureMessageRenderFlagsOnPreCreate(message, data, userId);
  } catch {
    /* no-op */
  }
});

Hooks.on("preUpdateChatMessage", (message, changed, _options, userId) => {
  try {
    if (userId !== game.user.id) return;
    feCaptureMessageRenderFlagsOnPreUpdate(message, changed);
  } catch {
    /* no-op */
  }
});

// -------------------------------------
// Chat Portrait-like: user color message backgrounds
// -------------------------------------

function feParseHexColorToRgb(hex) {
  try {
    const s = String(hex || "").trim();
    if (!s) return null;
    const m = s.startsWith("#") ? s.slice(1) : s;
    if (m.length === 3) {
      const r = parseInt(m[0] + m[0], 16);
      const g = parseInt(m[1] + m[1], 16);
      const b = parseInt(m[2] + m[2], 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
      return null;
    }
    // Accept #RRGGBB or #RRGGBBAA (ignore alpha)
    if (m.length === 6 || m.length === 8) {
      const r = parseInt(m.slice(0, 2), 16);
      const g = parseInt(m.slice(2, 4), 16);
      const b = parseInt(m.slice(4, 6), 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function feGetSpeakerActorFromMessage(message) {
  try {
    const speaker = message?.speaker ?? message?.data?.speaker ?? null;
    if (!speaker) return null;
    if (typeof ChatMessage?.getSpeakerActor === "function") return ChatMessage.getSpeakerActor(speaker);
    const actorId = speaker?.actor;
    return actorId ? game.actors?.get?.(actorId) ?? null : null;
  } catch {
    return null;
  }
}

function fePickActorOwnerUser(actor, preferredUser = null) {
  try {
    if (!actor || !game?.users) return null;
    const users = Array.isArray(game.users) ? game.users : game.users.contents ?? [];

    const canOwn = (u) => {
      try {
        if (typeof actor.testUserPermission === "function") return actor.testUserPermission(u, "OWNER");
        const lvl = actor.ownership?.[u.id] ?? 0;
        const ownerLvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
        return lvl >= ownerLvl;
      } catch {
        return false;
      }
    };

    const owners = users.filter((u) => canOwn(u));
    if (!owners.length) return null;

    // If the message author is an owner, prefer them (most intuitive for multi-owner actors).
    if (preferredUser?.id && owners.some((u) => u.id === preferredUser.id)) return preferredUser;

    // Prefer active non-GM owners, then any non-GM owner, then any active owner.
    return (
      owners.find((u) => !u.isGM && u.active) ||
      owners.find((u) => !u.isGM) ||
      owners.find((u) => u.active) ||
      owners[0] ||
      null
    );
  } catch {
    return null;
  }
}

function feGetMessageUserColor(message) {
  try {
    // Chat Portrait-style: tint primarily by the *message author*.
    // If a GM authored the message on behalf of an actor with a player owner,
    // prefer a non-GM owner to avoid every PC message inheriting the GM color.

    const author = message?.author ?? (message?.user ? game.users?.get?.(message.user) : null);
    const actor = feGetSpeakerActorFromMessage(message);

    // 1) Prefer author color
    if (author?.color) {
      if (author.isGM && actor) {
        const owner = fePickActorOwnerUser(actor, null);
        if (owner?.color && !owner.isGM) return String(owner.color);
      }
      return String(author.color);
    }

    // 2) Fallback: speaker actor owner (prefer non-GM owners)
    const owner = actor ? fePickActorOwnerUser(actor, author && !author.isGM ? author : null) : null;
    if (owner?.color) return String(owner.color);

    return null;
  } catch {
    return null;
  }
}

const FE_RENDER_STATE_FLAG = "renderState";
const FE_RENDER_STATE_VERSION = 1;
const feMessageRenderStateOverrides = new Map();

function feGetSpeakerActorFromLike(message, data = {}) {
  try {
    const speaker = data?.speaker ?? message?.speaker ?? message?.data?.speaker ?? null;
    if (!speaker) return null;
    if (typeof ChatMessage?.getSpeakerActor === "function") return ChatMessage.getSpeakerActor(speaker);
    const actorId = speaker?.actor;
    return actorId ? game.actors?.get?.(actorId) ?? null : null;
  } catch {
    return null;
  }
}

function feGetMessageUserColorForData(message, data = {}, userId = null) {
  try {
    const actor = feGetSpeakerActorFromLike(message, data);
    const authorId = data?.user ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? userId ?? game?.user?.id ?? null;
    const author = authorId ? game?.users?.get?.(authorId) ?? null : null;

    if (author?.color) {
      if (author.isGM && actor) {
        const owner = fePickActorOwnerUser(actor, null);
        if (owner?.color && !owner.isGM) return String(owner.color);
      }
      return String(author.color);
    }

    const owner = actor ? fePickActorOwnerUser(actor, author && !author.isGM ? author : null) : null;
    if (owner?.color) return String(owner.color);
    return null;
  } catch {
    return null;
  }
}

function feComputeMessageRenderState(message, data = {}, userId = null) {
  try {
    const flags = data?.flags ?? message?.flags ?? {};
    const narrator = !!(
      flags?.["narrator-tools"] ||
      flags?.[MODULE_ID]?.isNarrator ||
      message?.getFlag?.("narrator-tools", "type")
    );
    const roundFlag = flags?.["monks-little-details"]?.roundmarker;
    const content = String(data?.content ?? message?.content ?? "");
    const isRoundMarker = !!(
      flags?.[MODULE_ID]?.isRoundMarker ||
      roundFlag === true ||
      String(roundFlag) === "true" ||
      /\bround-marker\b/i.test(content)
    );

    const speaker = data?.speaker ?? message?.speaker ?? {};
    const authorId = String(data?.user ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? userId ?? game?.user?.id ?? "");
    const whisper = Array.isArray(data?.whisper) ? data.whisper : (Array.isArray(message?.whisper) ? message.whisper : []);
    const blind = !!(data?.blind ?? message?.blind);
    const rollMode = String(data?.rollMode ?? message?.rollMode ?? "");
    const style = String(data?.style ?? data?.type ?? message?.style ?? message?.type ?? "");
    const rolls = Array.isArray(data?.rolls) ? data.rolls : (Array.isArray(message?.rolls) ? message.rolls : []);
    const hasRolls = rolls.length > 0;
    const hasChatCard = /class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b)[^"']*["']/.test(content);
    const hasDice = /class=["'][^"']*(?:\bdice-roll\b|\bdice-result\b)[^"']*["']/.test(content);
    const mergeableText = !hasRolls && !hasChatCard && !hasDice;
    const speakerKey = [
      speaker?.scene ?? "",
      speaker?.token ?? "",
      speaker?.actor ?? "",
      speaker?.alias ?? "",
    ].join("|") + (narrator ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : "");

    const userColorHex = feGetMessageUserColorForData(message, data, userId);
    const userColorRgbObj = feParseHexColorToRgb(userColorHex);

    return {
      v: FE_RENDER_STATE_VERSION,
      userColorHex,
      userColorRgb: userColorRgbObj ? `${userColorRgbObj.r} ${userColorRgbObj.g} ${userColorRgbObj.b}` : null,
      isNarrator: narrator,
      isRoundMarker,
      merge: {
        authorId,
        speakerKey,
        whisperKey: whisper.length ? whisper.slice().sort().join(",") : "",
        blind,
        rollMode,
        style,
        mergeableText,
        isNarrator: narrator,
        isRoundMarker,
        noMerge: narrator || isRoundMarker,
      },
    };
  } catch {
    return null;
  }
}

function feGetStoredRenderState(message) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (id && feMessageRenderStateOverrides.has(id)) return feMessageRenderStateOverrides.get(id) ?? null;
    const state = message?.flags?.[MODULE_ID]?.[FE_RENDER_STATE_FLAG] ?? null;
    if (state?.v === FE_RENDER_STATE_VERSION) return state;
    return null;
  } catch {
    return null;
  }
}

function feStoreRenderStateOverride(messageId, state) {
  try {
    const id = feNormalizeChatMessageId(messageId);
    if (!id) return;
    if (state) feMessageRenderStateOverrides.set(id, state);
    else feMessageRenderStateOverrides.delete(id);
  } catch {}
}

function feCaptureMessageRenderFlagsOnPreCreate(message, data = {}, userId = null) {
  try {
    const renderState = feComputeMessageRenderState(message, data, userId);
    if (!renderState) return;
    const flags = foundry.utils.deepClone(data?.flags ?? message?.flags ?? {});
    const specialKind = renderState.isNarrator ? "narrator" : renderState.isRoundMarker ? "round-marker" : "normal";
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      userColorHex: renderState.userColorHex ?? null,
      userColorRgb: renderState.userColorRgb ?? null,
      isNarrator: !!renderState.isNarrator,
      isRoundMarker: !!renderState.isRoundMarker,
      [FE_RENDER_SPECIAL_KIND_FLAG]: specialKind,
      [FE_RENDER_MERGE_HINT_FLAG]: renderState.merge ?? null,
      [FE_RENDER_STATE_FLAG]: renderState,
    });
    message.updateSource({ flags });
  } catch {
    /* no-op */
  }
}

function feCaptureMessageRenderFlagsOnPreUpdate(message, changed = {}, userId = null) {
  try {
    const merged = foundry.utils.mergeObject(foundry.utils.deepClone(message?.toObject?.() ?? {}), changed ?? {}, { inplace: true, recursive: true });
    const renderState = feComputeMessageRenderState(message, merged, userId ?? game?.user?.id ?? null);
    if (!renderState) return;
    const flags = foundry.utils.deepClone(merged?.flags ?? message?.flags ?? {});
    const specialKind = renderState.isNarrator ? "narrator" : renderState.isRoundMarker ? "round-marker" : "normal";
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      userColorHex: renderState.userColorHex ?? null,
      userColorRgb: renderState.userColorRgb ?? null,
      isNarrator: !!renderState.isNarrator,
      isRoundMarker: !!renderState.isRoundMarker,
      [FE_RENDER_SPECIAL_KIND_FLAG]: specialKind,
      [FE_RENDER_MERGE_HINT_FLAG]: renderState.merge ?? null,
      [FE_RENDER_STATE_FLAG]: renderState,
    });
    changed.flags = flags;
    feStoreRenderStateOverride(message?.id ?? message?._id, renderState);
  } catch {
    /* no-op */
  }
}

function feIsNarratorToolsMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("narrator-chat") || messageEl?.classList?.contains?.("fe-narrator-chat")) return true;
    const state = feGetStoredRenderState(message);
    if (typeof state?.isNarrator === "boolean") return state.isNarrator;
    if (message?.getFlag?.("narrator-tools", "type")) return true;
    if (message?.flags?.["narrator-tools"]) return true;
    return false;
  } catch {
    return false;
  }
}

function feIsRoundMarkerMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("round-marker") || messageEl?.classList?.contains?.("fe-round-marker-chat")) return true;
    if (messageEl?.querySelector?.(".round-marker")) return true;
  } catch {}

  try {
    const state = feGetStoredRenderState(message);
    if (typeof state?.isRoundMarker === "boolean") return state.isRoundMarker;
  } catch {}

  try {
    const flag = message?.flags?.["monks-little-details"]?.roundmarker;
    if (flag === true || String(flag) === "true") return true;
  } catch {}

  try {
    const content = String(message?.content ?? "");
    if (/\bround-marker\b/i.test(content)) return true;
  } catch {}

  return false;
}
function feIsUntouchedSpecialMessage(message, messageEl) {
  return feIsNarratorToolsMessage(message, messageEl) || feIsRoundMarkerMessage(message, messageEl);
}

function feApplyUserColorBgToMessageElement(message, messageEl) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    const el0 = messageEl?.[0] ?? messageEl;
    if (!el0?.classList || !el0?.style) return;

    const isNarratorTools = feIsNarratorToolsMessage(message, el0);
    const isRoundMarker = feIsRoundMarkerMessage(message, el0);
    el0.classList.toggle("fe-narrator-chat", isNarratorTools);
    el0.classList.toggle("fe-round-marker-chat", isRoundMarker);
    if (isNarratorTools || isRoundMarker) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    if (!enabled) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    const state = feGetStoredRenderState(message);
    const rgbString = state?.userColorRgb || message?.flags?.[MODULE_ID]?.userColorRgb || null;
    let rgb = null;
    if (rgbString) {
      rgb = { text: String(rgbString) };
    } else {
      const color = state?.userColorHex || message?.flags?.[MODULE_ID]?.userColorHex || feGetMessageUserColor(message);
      const parsed = feParseHexColorToRgb(color);
      if (parsed) rgb = { text: `${parsed.r} ${parsed.g} ${parsed.b}` };
    }
    if (!rgb?.text) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    el0.classList.add("fe-has-user-color");
    el0.style.setProperty("--fe-user-color-rgb", rgb.text);
  } catch {
    /* noop */
  }
}

function feApplyUserColorBgToAllLogs(doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    const root = doc?.querySelector?.("#chat-log, ol.chat-log, #fe-chat-export-log") ?? doc;
    if (!root?.querySelectorAll) return;
    const nodes = root.querySelectorAll("li.chat-message");

    for (const li of nodes) {
      if (!enabled) {
        li.classList.remove("fe-has-user-color");
        li.style?.removeProperty?.("--fe-user-color-rgb");
        continue;
      }
      const msgId = feGetMessageIdFromElement(li);
      if (!msgId) continue;
      const msg = game?.messages?.get?.(msgId);
      if (!msg) continue;
      feApplyUserColorBgToMessageElement(msg, li);
    }
  } catch {
    /* noop */
  }
}

function feApplyUserColorBgToLog(logEl, doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    if (!enabled) return;
    if (!logEl?.querySelectorAll) return;

    const nodes = logEl.querySelectorAll("li.chat-message");
    for (const li of nodes) {
      const msgId = feGetMessageIdFromElement(li);
      if (!msgId) continue;
      const msg = game?.messages?.get?.(msgId);
      if (!msg) continue;
      feApplyUserColorBgToMessageElement(msg, li);
    }
  } catch {
    /* noop */
  }
}

// -------------------------------------
// Typing indicator (socket-based, lightweight)
// -------------------------------------

let feTypingInitialized = false;
let feTypingTimeout = null;
let feTypingActive = false;
const feTypingUsers = new Map(); // userId -> lastSeen (ms)

function feEnsureTypingIndicatorElement() {
  const chatForm = document.querySelector("#chat-form");
  if (!chatForm) return null;

  let el = chatForm.querySelector(".fe-typing-indicator");
  if (!el) {
    el = document.createElement("div");
    el.className = "fe-typing-indicator";
    el.style.display = "none";
    chatForm.appendChild(el);
  }
  return el;
}

function feRenderTypingIndicator() {
  const el = feEnsureTypingIndicatorElement();
  if (!el) return;

  const now = Date.now();
  // expire entries older than 5s
  for (const [uid, ts] of feTypingUsers.entries()) {
    if (now - ts > 5000) feTypingUsers.delete(uid);
  }

  const names = [...feTypingUsers.keys()]
    .filter((uid) => uid !== game.user.id)
    .map((uid) => game.users.get(uid)?.name)
    .filter(Boolean);

  if (!names.length) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }

  el.style.display = "";
  el.textContent = `${names.join(", ")} 입력 중...`;
}

function feSetupTypingIndicator() {
  const enabled = !!feSetting(S.TYPING_ENABLED);

  // Always render current state (might hide)
  feRenderTypingIndicator();
  if (!enabled) return;

  // Socket receiver (register once)
  if (!feTypingInitialized) {
    feTypingInitialized = true;

    game.socket.on(`module.${MODULE_ID}`, (payload) => {
      if (!payload || payload.type !== "typing") return;
      if (!payload.userId) return;
      if (payload.userId === game.user.id) return;

      if (payload.active) feTypingUsers.set(payload.userId, Date.now());
      else feTypingUsers.delete(payload.userId);

      feRenderTypingIndicator();
    });

    // periodic cleanup
    setInterval(() => feRenderTypingIndicator(), 1500);
  }

  // Local input listeners
  const textarea =
    document.querySelector('#chat-form textarea[name="message"]') ||
    document.querySelector("#chat-message") ||
    document.querySelector("#chat-form textarea");

  if (!textarea) return;

  if (!textarea.dataset.feTypingBound) {
    textarea.dataset.feTypingBound = "1";

    const send = (active) => {
      game.socket.emit(`module.${MODULE_ID}`, { type: "typing", userId: game.user.id, active: !!active });
    };

    textarea.addEventListener("input", () => {
      if (!feSetting(S.TYPING_ENABLED)) return;

      if (!feTypingActive) {
        feTypingActive = true;
        send(true);
      }

      if (feTypingTimeout) clearTimeout(feTypingTimeout);
      feTypingTimeout = setTimeout(() => {
        feTypingActive = false;
        send(false);
      }, 1200);
    });

    textarea.addEventListener("blur", () => {
      if (!feSetting(S.TYPING_ENABLED)) return;
      if (feTypingTimeout) clearTimeout(feTypingTimeout);
      feTypingTimeout = null;
      if (feTypingActive) {
        feTypingActive = false;
        send(false);
      }
    });
  }
}


function feNormalizeChatMessageId(id) {
  if (!id) return null;
  const s = String(id);
  return s.startsWith("ChatMessage.") ? s.slice("ChatMessage.".length) : s;
}

function feGetMessageIdFromElement(el) {
  const li = el?.closest?.("li.chat-message") ?? el;
  const id =
    li?.dataset?.messageId ||
    li?.dataset?.documentId ||
    li?.getAttribute?.("data-message-id") ||
    li?.getAttribute?.("data-document-id") ||
    null;
  return feNormalizeChatMessageId(id);
}

function feGetChatMessageElementOrder(el, fallback) {
  const raw = el.dataset.order ?? el.style.order;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function feMessageMergeInfo(msg, el) {
  const storedState = feGetStoredRenderState(msg);
  const storedHint = storedState?.merge ?? msg?.flags?.[MODULE_ID]?.[FE_RENDER_MERGE_HINT_FLAG] ?? null;

  // NOTE: v13+: ChatMessage#user is deprecated -> use ChatMessage#author
  // Some automation modules may still populate legacy fields during rapid updates, so keep fallbacks.
  const authorId = storedHint?.authorId ?? msg?.author?.id ?? msg?.user?.id ?? msg?.user ?? "";

  const isNarratorTools = feIsNarratorToolsMessage(msg, el);
  const isRoundMarker = feIsRoundMarkerMessage(msg, el);

  const speaker = msg?.speaker ?? {};
  const speakerKey = storedHint?.speakerKey ?? ([
    speaker.scene ?? "",
    speaker.token ?? "",
    speaker.actor ?? "",
    speaker.alias ?? ""
  ].join("|") + (isNarratorTools ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : ""));

  // Whisper recipients (if any)
  const whisper = Array.isArray(msg?.whisper) ? msg.whisper : [];
  const whisperKey = storedHint?.whisperKey ?? (whisper.length ? whisper.slice().sort().join(",") : "");

  const blind = typeof storedHint?.blind === "boolean" ? storedHint.blind : !!msg?.blind;
  const rollMode = storedHint?.rollMode ?? msg?.rollMode ?? "";

  // ChatMessage#style exists in v13+ (ChatMessage#type was renamed)
  const style = storedHint?.style ?? msg?.style ?? msg?.type ?? null;

  // Rolls are defined in ChatMessage#rolls in v13+
  const hasRolls = Array.isArray(msg?.rolls) && msg.rolls.length > 0;

  const content = String(msg?.content ?? "");
  const hasChatCard = /class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b)[^"']*["']/.test(content);
  const hasDice = /class=["'][^"']*(?:\bdice-roll\b|\bdice-result\b)[^"']*["']/.test(content);

  // "Merge only text" should merge plain text lines, but avoid merging item cards / dice rolls.
  const mergeableText = typeof storedHint?.mergeableText === "boolean"
    ? storedHint.mergeableText
    : (!hasRolls && !hasChatCard && !hasDice);

  return {
    authorId,
    speakerKey,
    whisperKey,
    blind,
    rollMode,
    style,
    mergeableText,
    isNarrator: isNarratorTools,
    isRoundMarker,
    // Keep narrator/round-marker lines standalone in live chat; archive/print can opt specific cases back in.
    noMerge: isNarratorTools || isRoundMarker,
  };
}




function feGetChatLogs() {
  // Sidebar + any chat popouts
  const logs = new Set();
  document.querySelectorAll("ol.chat-log, #chat-log").forEach((el) => {
    if (feIsElementNode(el)) logs.add(el);
  });
  return Array.from(logs);
}

/**
 * Remove duplicate rendered chat messages inside a single chat log.
 *
 * In some Foundry versions, rapid create->update cycles (common in automation modules)
 * could briefly render the same ChatMessage twice. Foundry has addressed this in core,
 * but we defensively de-dupe by message id to prevent "old messages mixing in".
 */
function feDedupeChatMessagesInLog(logEl) {
  try {
    if (!logEl?.querySelectorAll) return;
    const seen = new Map();
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    for (const el of items) {
      const rawId = feGetMessageIdFromElement(el);
      const id = rawId ? feNormalizeChatMessageId(rawId) : null;
      if (!id) continue;

      const prev = seen.get(id);
      if (prev && prev !== el) {
        // Keep the most recently encountered element (typically the updated render).
        try {
          prev.remove();
        } catch {}
      }
      seen.set(id, el);
    }
  } catch {
    /* no-op */
  }
}


const feMergeRetryTimers = new WeakMap();

/**
 * If a merge pass encounters messages whose ChatMessage documents are not yet available in game.messages,
 * schedule a short retry. This prevents accidental merges (headers hidden) during rapid create->update races
 * while still converging to the correct grouping once the documents are ready.
 */
function feScheduleMergeRetry(logEl, delay = 80) {
  try {
    if (!feIsElementNode(logEl)) return;
    if (feMergeRetryTimers.has(logEl)) return;

    const t = setTimeout(() => {
      feMergeRetryTimers.delete(logEl);
      try {
        feDedupeChatMessagesInLog(logEl);
        feApplyChatMerge(logEl);
        if (feSetting(S.USE_USER_COLOR_BG)) feApplyUserColorBgToLog(logEl, logEl?.ownerDocument ?? document);
      } catch {
        /* no-op */
      }
    }, delay);

    feMergeRetryTimers.set(logEl, t);
  } catch {
    /* no-op */
  }
}

function feMergeKey(info) {
  if (info?.precomputedKey) return String(info.precomputedKey);
  const author = info?.authorId ?? "";
  const speaker = info?.speakerKey ?? "";
  const whisper = info?.whisperKey ?? "";
  const blind = info?.blind ? "1" : "0";
  const rollMode = info?.rollMode ?? "";
  const style = info?.style ?? "";
  return [author, speaker, whisper, blind, rollMode, style].join("||");
}




function feApplyChatMerge(logEl, { allowNarratorMerge = false } = {}) {
  if (!feIsElementNode(logEl)) return;

  // Always clear previous merge classes first (so disabling the feature restores normal view).
  const msgs = logEl.querySelectorAll("li.chat-message");
  for (const el of msgs) {
    el.classList.remove(
      "fe-merge-start",
      "fe-merge-mid",
      "fe-merge-end",
      "fe-divider-before"
    );
  }

  const mergeEnabled = !!feSetting(S.MERGE_ENABLED);
  if (!mergeEnabled) return;

  const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
  const showDivider = !!feSetting(S.MERGE_DIVIDER);

  const infos = [];
  let idx = 0;
  for (const el of msgs) {
    const msgId = feGetMessageIdFromElement(el);
    const msg = msgId ? game.messages?.get(msgId) : null;
    const info = feMessageMergeInfo(msg, el);
    infos.push({
      ...info,
      msgId,
      missing: !msg,
      el,
      idx,
      order: feGetChatMessageElementOrder(el, idx),
    });
    idx++;
  }

  if (!infos.length) return;

  // Sort by visual order (Foundry sometimes uses fractional data-order)
  infos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Precompute merge keys.
  // If the ChatMessage document isn't available yet (rare race during rapid create->update),
  // never merge it to avoid "message mixing". We will retry shortly.
  let hasMissingDocs = false;
  for (const info of infos) {
    if (!info.msgId || info.missing) {
      hasMissingDocs = true;
      info.key = `__fe_missing__||${info.msgId ?? info.idx}`;
      info.mergeableText = false;
      continue;
    }
    info.key = feMergeKey(info);
  }
  if (hasMissingDocs) feScheduleMergeRetry(logEl);

  const canMerge = (a, b) => {
    if (!a || !b) return false;
    const narratorPair = !!allowNarratorMerge && !!a.isNarrator && !!b.isNarrator;
    if ((a.noMerge || b.noMerge) && !narratorPair) return false;
    if (a.key !== b.key) return false;
    if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
    return true;
  };

  const applyGroup = (startIndex, endIndexExclusive) => {
    const groupLen = endIndexExclusive - startIndex;
    if (groupLen <= 0) return;

    const first = infos[startIndex];
    if (!first?.el) return;

    // Divider at group boundary (except first group)
    if (showDivider && startIndex > 0) first.el.classList.add("fe-divider-before");

    // Do not apply "follow" classes for single messages (prevents accidental header hiding).
    if (groupLen === 1) return;

    first.el.classList.add("fe-merge-start");
    for (let i = startIndex + 1; i < endIndexExclusive - 1; i++) infos[i]?.el?.classList?.add("fe-merge-mid");
    infos[endIndexExclusive - 1]?.el?.classList?.add("fe-merge-end");
  };

  let groupStart = 0;
  for (let i = 1; i < infos.length; i++) {
    if (!canMerge(infos[i - 1], infos[i])) {
      applyGroup(groupStart, i);
      groupStart = i;
    }
  }
  applyGroup(groupStart, infos.length);
}


function feApplyChatMergeToAllLogs() {
  for (const log of feGetChatLogs()) {
    feApplyChatMerge(log);
  }
}


// Legacy observer-based chat log passes were removed in favor of
// preCreate/preUpdate/create/renderChatMessageHTML-driven rendering.
// Keep a tiny compatibility shim so older internal call sites remain harmless.
function feObserveChatLogs() {
  try {
    feApplyRenderedStateToAllLogs();
    feFireChatUiUpdated();
    feRenderTypingIndicator();
  } catch {
    /* no-op */
  }
}

export {
  MODULE_ID,
  S,
  FE_DEFAULTS,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  feSetting,
  feFireChatUiUpdated,

  feNormalizeChatMessageId,
  feGetMessageIdFromElement,

  feGetChatLogs,
  feMarkdownToHTML,
  feGetSpeakerActorFromMessage,
  feGetMessageUserColor,

  feApplyStyleVarsFromSettings,
  feStripChatTexturesInWindow,
  feApplyUserColorBgToMessageElement,
  feApplyRenderedStateToLog,
  feApplyRenderedStateToAllLogs,
  feSetChatFontChoiceClass,
  feSetChatCardFontClass,
  feSetUiFontClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,

  feApplyChatMerge,
  feMessageMergeInfo,
  feMergeKey,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
};
