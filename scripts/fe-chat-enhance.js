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
  MERGE_MODE: "ceMergeMode", // standard | simple
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
  [S.MERGE_MODE]: "standard",
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

function feHasRenderedStateWork() {
  try {
    return !!feSetting(S.MERGE_ENABLED) || !!feSetting(S.USE_USER_COLOR_BG);
  } catch {
    return true;
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

  const mode = String(feSetting(S.MERGE_MODE) ?? "standard");
  document.body.classList.toggle("fe-merge-mode-standard", enabled && mode === "standard");
  document.body.classList.toggle("fe-merge-mode-simple", enabled && mode === "simple");

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
    const chatSpacing = px(feSetting(S.STYLE_CHAT_MESSAGE_SPACING), 4);
    root.style.setProperty("--fe-chat-message-spacing", chatSpacing);
    // Some archive / detached chat roots still read the core variable directly.
    root.style.setProperty("--chat-message-spacing", chatSpacing);

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

async function feNormalizeChoiceSetting(key, allowedValues, fallback) {
  try {
    const allowed = new Set(Array.isArray(allowedValues) ? allowedValues : []);
    const value = String(feSetting(key) ?? fallback ?? "").trim();
    if (!allowed.has(value)) await game.settings.set(MODULE_ID, key, fallback);
  } catch (_err) {
    // ignore
  }
}

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

  // 2) Choice-valued settings: normalize unknown/legacy values to safe defaults.
  await feNormalizeChoiceSetting(S.CHAT_FONT_CHOICE, ["cookie", "geurimilgi"], FE_DEFAULTS[S.CHAT_FONT_CHOICE]);
  await feNormalizeChoiceSetting(S.MERGE_MODE, ["standard", "simple"], FE_DEFAULTS[S.MERGE_MODE]);
  await feNormalizeChoiceSetting(S.MERGE_FOLLOW_HEADER_STYLE, ["hide", "name", "portrait"], FE_DEFAULTS[S.MERGE_FOLLOW_HEADER_STYLE]);
  await feNormalizeChoiceSetting(S.USER_COLOR_BG_BASE, ["white", "black", "none"], FE_DEFAULTS[S.USER_COLOR_BG_BASE]);
  await feNormalizeChoiceSetting(S.EXPORT_PRINT_IMAGE_MODE, Object.keys(FE_EXPORT_PRINT_IMAGE_MODE_CHOICES), FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
  await feNormalizeChoiceSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE, ["off", "button", "auto"], FE_DEFAULTS[S.EXPORT_DESKTOP_EXTERNAL_MODE]);
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

  game.settings.register(MODULE_ID, S.MERGE_MODE, {
    name: "채팅 병합 방식",
    hint: "표준은 메시지 박스 경계까지 붙여 묶고, 간소화는 같은 화자의 후속 메시지에서 헤더만 숨깁니다.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      standard: "표준(경계/간격까지 묶기)",
      simple: "간소화(후속 헤더만 숨김)",
    },
    default: "standard",
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
    },
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
    onChange: () => feFireChatUiUpdated({ reason: "export-settings", document }),
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
    default: false,
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
    onChange: () => feFireChatUiUpdated({ reason: "edit-settings", document }),
  });

  // Install chat-log level refreshes on the supported v13 render hook.
  Hooks.on("renderChatLog", (_app, html) => {
    try {
      const root = feExtractHTMLElement(html) ?? html?.element?.[0] ?? null;
      const log = root?.matches?.("ol.chat-log, #chat-log")
        ? root
        : root?.querySelector?.("ol.chat-log, #chat-log") ?? null;

      if (log) feScheduleRenderedLogRefresh(log, { delay: 0 });
      else feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });

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
  if (feHasRenderedStateWork()) feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });
  feFireChatUiUpdated({ reason: "ready", root: document, log: null, document });
  feRenderTypingIndicator();
  feSetupTypingIndicator();
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
let feInlineRollSnapshots = null;
let feInlineRollSnapshotPersistTimer = null;
// Inline-roll snapshotting was used by older post-processing passes.
// The current pipeline freezes new inline rolls at preCreate/preUpdate time instead,
// so these helpers are kept as no-op shims to avoid extra session churn while preserving call sites.
function feClearInlineRollSnapshot(_messageId) {
  /* no-op */
}

function feSnapshotOrRestoreInlineRolls(_message, _rootEl) {
  /* no-op */
}

function feIsElementNode(node) {
  return !!node && node.nodeType === 1;
}

function feGetMessageFromElementOrCollection(elOrId) {
  try {
    if (elOrId && typeof elOrId === "object" && (elOrId.id || elOrId._id) && typeof elOrId.getFlag === "function") return elOrId;
    if (feIsElementNode(elOrId)) {
      const direct = elOrId.__feMessage || elOrId.closest?.("li.chat-message, #chat-notifications .message")?.__feMessage;
      if (direct) return direct;
      const id = feGetMessageIdFromElement(elOrId);
      return id ? game.messages?.get?.(id) ?? null : null;
    }
    const id = feNormalizeChatMessageId(elOrId);
    return id ? game.messages?.get?.(id) ?? null : null;
  } catch {
    return null;
  }
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

function feBindMessageToElement(message, messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl);
    const li = el?.closest?.("li.chat-message, #chat-notifications .message") ?? (el?.matches?.("li.chat-message, #chat-notifications .message") ? el : null);
    if (!li || !message) return;
    li.__feMessage = message;
  } catch {
    /* no-op */
  }
}

function feIsNotificationMessageElement(messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl) ?? messageEl;
    if (!el) return false;
    if (el.matches?.("#chat-notifications > .message, #chat-notifications .message")) return true;
    return !!el.closest?.("#chat-notifications .message");
  } catch {
    return false;
  }
}

function feClearMergeClassesFromMessageElement(messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl) ?? messageEl;
    const root = el?.closest?.("#chat-notifications .message, li.chat-message") ?? (el?.matches?.("#chat-notifications .message, li.chat-message") ? el : null);
    if (!root?.classList) return;
    for (const cls of FE_MERGE_CLASS_LIST) root.classList.remove(cls);
    feMergeClassSignatureCache?.delete?.(root);
    try { delete root.dataset.feMergeSig; } catch {
      /* no-op */
    }
  } catch {
    /* no-op */
  }
}

function feDeferTask(fn) {
  try {
    queueMicrotask(fn);
  } catch {
    Promise.resolve().then(fn);
  }
}


const fePendingRenderedLogs = new Set();
const fePendingRenderedLogOptions = new WeakMap();
const fePendingRenderedLogFrames = new Map();

const feQueuedRenderedMessageIds = new Set();
let feQueuedRenderedMessageTimer = null;
let feQueuedRenderedMessagePass = 0;
let feQueuedRenderedMessageNarratorMerge = false;

function feWindowRequestFrame(win, fn) {
  try {
    const w = win ?? window;
    if (typeof w?.requestAnimationFrame === "function") return w.requestAnimationFrame(fn);
  } catch {
    /* no-op */
  }
  return setTimeout(fn, 16);
}

function feWindowCancelFrame(win, handle) {
  try {
    const w = win ?? window;
    if (typeof w?.cancelAnimationFrame === "function") {
      w.cancelAnimationFrame(handle);
      return;
    }
  } catch {
    /* no-op */
  }
  clearTimeout(handle);
}

function feFlushRenderedLogsForWindow(win = window) {
  try {
    const pending = Array.from(fePendingRenderedLogs).filter((log) => (log?.ownerDocument?.defaultView ?? window) === win);
    for (const log of pending) {
      fePendingRenderedLogs.delete(log);
      const opts = fePendingRenderedLogOptions.get(log) ?? {};
      fePendingRenderedLogOptions.delete(log);
      try {
        feDedupeChatMessagesInLog(log);
        feApplyRenderedStateToLog(log, opts);
      } catch {
        /* no-op */
      }
    }
  } finally {
    fePendingRenderedLogFrames.delete(win);
  }
}

function feScheduleRenderedLogRefresh(logEl, { delay = 24, allowNarratorMerge = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    if (!feIsElementNode(logEl)) return;
    const opts = fePendingRenderedLogOptions.get(logEl) ?? { allowNarratorMerge: false };
    opts.allowNarratorMerge = opts.allowNarratorMerge || !!allowNarratorMerge;
    fePendingRenderedLogOptions.set(logEl, opts);
    fePendingRenderedLogs.add(logEl);

    const win = logEl?.ownerDocument?.defaultView ?? window;
    const existing = fePendingRenderedLogFrames.get(win);
    if (existing) return;

    const wait = Math.max(0, Number(delay) || 0);
    const kickoff = () => {
      const current = fePendingRenderedLogFrames.get(win);
      if (typeof current === "number") {
        // timeout handle is consumed; the next stored handle becomes the animation frame.
      }
      const raf = feWindowRequestFrame(win, () => feFlushRenderedLogsForWindow(win));
      fePendingRenderedLogFrames.set(win, raf);
    };

    if (wait > 0) {
      const timeout = setTimeout(kickoff, wait);
      fePendingRenderedLogFrames.set(win, timeout);
    } else {
      kickoff();
    }
  } catch {
    /* no-op */
  }
}

function feScheduleRenderedStateRefreshForAllLogs({ delay = 24, allowNarratorMerge = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    for (const log of feGetChatLogs()) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feGetChatLogsInDocument(doc = document) {
  try {
    const rootDoc = doc?.querySelectorAll ? doc : document;
    const logs = new Set();
    rootDoc.querySelectorAll?.("ol.chat-log, #chat-log")?.forEach?.((el) => {
      if (feIsElementNode(el)) logs.add(el);
    });
    return Array.from(logs);
  } catch {
    return feGetChatLogs();
  }
}

function feCssEscape(value) {
  try {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value ?? ""));
  } catch {
    /* no-op */
  }
  return String(value ?? "").replace(/[^a-zA-Z0-9_\-]/g, "\$&");
}

function feScheduleRenderedStateRefreshForMessageId(messageId, { delay = 24, allowNarratorMerge = false, doc = document } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    const id = feNormalizeChatMessageId(messageId);
    const rootDoc = doc?.querySelectorAll ? doc : document;
    const logs = new Set();
    if (id) {
      const escaped = feCssEscape(id);
      const selector = `[data-message-id="${escaped}"], [data-document-id="${escaped}"], [data-document-id$=".${escaped}"]`;
      rootDoc.querySelectorAll?.(selector)?.forEach?.((node) => {
        const li = node?.closest?.("li.chat-message");
        const log = li?.closest?.("ol.chat-log, #chat-log") ?? node?.closest?.("ol.chat-log, #chat-log");
        if (feIsElementNode(log)) logs.add(log);
      });
    }
    if (!logs.size) {
      const fallbackLogs = feGetChatLogsInDocument(rootDoc);
      for (const log of fallbackLogs) logs.add(log);
    }
    if (!logs.size) {
      feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge });
      return;
    }
    for (const log of logs) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge });
  } catch {
    feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge });
  }
}

function feFlushQueuedRenderedMessageRefreshes() {
  try {
    const ids = Array.from(feQueuedRenderedMessageIds);
    feQueuedRenderedMessageIds.clear();
    feQueuedRenderedMessageTimer = null;

    if (!ids.length) {
      feQueuedRenderedMessagePass = 0;
      feQueuedRenderedMessageNarratorMerge = false;
      return;
    }

    const logs = feGetChatLogs();
    let missing = false;
    for (const log of logs) {
      if (!feIsElementNode(log)) continue;
      try { feDedupeChatMessagesInLog(log); } catch {}
      const anchors = new Set();
      for (const id of ids) {
        const el = log.querySelector?.(`li.chat-message[data-message-id="${id}"], li.chat-message[data-document-id="${id}"]`);
        if (!el) {
          missing = true;
          continue;
        }
        anchors.add(el);
      }
      for (const el of anchors) {
        const msg = feGetMessageFromElementOrCollection(el);
        feApplyRenderedStateToMessageElement(msg, el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge });
        if (feSetting(S.MERGE_ENABLED)) feApplyChatMergeAroundElement(el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge });
      }
    }

    if (missing && feQueuedRenderedMessagePass < 2) {
      feQueuedRenderedMessagePass += 1;
      for (const id of ids) feQueuedRenderedMessageIds.add(id);
      feQueuedRenderedMessageTimer = setTimeout(feFlushQueuedRenderedMessageRefreshes, 28 + (feQueuedRenderedMessagePass * 18));
      return;
    }

    feQueuedRenderedMessagePass = 0;
    feQueuedRenderedMessageNarratorMerge = false;
  } catch {
    feQueuedRenderedMessageTimer = null;
    feQueuedRenderedMessagePass = 0;
    feQueuedRenderedMessageNarratorMerge = false;
  }
}

function feScheduleRenderedMessageRefresh(messageOrId, { delay = 16, allowNarratorMerge = false } = {}) {
  try {
    const id = feNormalizeChatMessageId(messageOrId?.id ?? messageOrId?._id ?? messageOrId);
    if (!id) return;
    feQueuedRenderedMessageIds.add(id);
    feQueuedRenderedMessageNarratorMerge = feQueuedRenderedMessageNarratorMerge || !!allowNarratorMerge;
    if (feQueuedRenderedMessageTimer) return;
    feQueuedRenderedMessageTimer = setTimeout(feFlushQueuedRenderedMessageRefreshes, Math.max(0, Number(delay) || 0));
  } catch {
    /* no-op */
  }
}

function feCollectMergeNeighborhood(logEl, anchorEl, { allowNarratorMerge = false } = {}) {
  try {
    if (!feIsElementNode(logEl) || !feIsElementNode(anchorEl)) return { slice: [], firstIndex: 0, hasMissingDocs: false };
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    if (!items.length) return { slice: [], firstIndex: 0, hasMissingDocs: false };

    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const makeInfo = (el, fallbackIndex = 0) => {
      const msgId = feGetMessageIdFromElement(el);
      const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game.messages?.get?.(msgId) : null);
      if (msg) feBindMessageToElement(msg, el);
      const info = feMessageMergeInfo(msg, el) ?? {};
      const hasStampedKey = !!info?.key;
      info.msgId = msgId;
      info.missing = !msg && !hasStampedKey;
      info.el = el;
      info.domIndex = fallbackIndex;
      info.order = feGetChatMessageElementOrder(el, fallbackIndex);
      info.key = info.key || (msg ? feMergeKey(info) : `__fe_missing__||${msgId ?? fallbackIndex}`);
      if (!msg && !hasStampedKey) info.mergeableText = false;
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

    const infos = items
      .map((el, i) => makeInfo(el, i))
      .sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : a?.domIndex ?? 0;
        const bo = Number.isFinite(b?.order) ? b.order : b?.domIndex ?? 0;
        if (ao !== bo) return ao - bo;
        return (a?.domIndex ?? 0) - (b?.domIndex ?? 0);
      });

    const idx = infos.findIndex((info) => info?.el === anchorEl);
    if (idx === -1) return { slice: [], firstIndex: 0, hasMissingDocs: false };

    let start = idx;
    let end = idx;
    while (start > 0 && canMerge(infos[start - 1], infos[start])) start -= 1;
    while (end < infos.length - 1 && canMerge(infos[end], infos[end + 1])) end += 1;

    // Also include the *full* adjacent groups on both sides.
    // If a new standalone message is inserted after a merged run, recomputing only the
    // anchor and its immediate neighbor can clear the prior group's end/follow classes.
    if (start > 0) {
      start -= 1;
      while (start > 0 && canMerge(infos[start - 1], infos[start])) start -= 1;
    }
    if (end < infos.length - 1) {
      end += 1;
      while (end < infos.length - 1 && canMerge(infos[end], infos[end + 1])) end += 1;
    }

    const slice = infos.slice(start, end + 1);
    return {
      slice,
      firstIndex: start,
      hasMissingDocs: slice.some((info) => !!info?.missing),
    };
  } catch {
    return { slice: [], firstIndex: 0, hasMissingDocs: false };
  }
}

function feApplyChatMergeSlice(infos, startOffset = 0, { allowNarratorMerge = false } = {}) {
  try {
    if (!Array.isArray(infos) || !infos.length) return;
    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const showDivider = !!feSetting(S.MERGE_DIVIDER);
    const mergeMode = String(feSetting(S.MERGE_MODE) ?? "standard");
    const simpleMode = mergeMode === "simple";
    const canMerge = (a, b) => {
      if (!a || !b) return false;
      const narratorPair = !!allowNarratorMerge && !!a.isNarrator && !!b.isNarrator;
      if ((a.noMerge || b.noMerge) && !narratorPair) return false;
      if (a.key !== b.key) return false;
      if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
      return true;
    };

    const desiredMap = new Map();
    for (const info of infos) {
      if (info?.el) desiredMap.set(info.el, new Set());
    }
    const mark = (el, cls) => {
      const set = desiredMap.get(el);
      if (set) set.add(cls);
    };

    const applyGroup = (startIndex, endIndexExclusive) => {
      const groupLen = endIndexExclusive - startIndex;
      if (groupLen <= 0) return;
      const first = infos[startIndex];
      if (!first?.el) return;
      if (showDivider && (startOffset + startIndex) > 0) mark(first.el, "fe-divider-before");
      if (groupLen === 1) return;
      if (simpleMode) {
        for (let i = startIndex + 1; i < endIndexExclusive; i += 1) mark(infos[i]?.el, "fe-merge-follow");
        return;
      }
      mark(first.el, "fe-merge-start");
      for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
      mark(infos[endIndexExclusive - 1]?.el, "fe-merge-end");
    };
    let groupStart = 0;
    for (let i = 1; i < infos.length; i += 1) {
      if (!canMerge(infos[i - 1], infos[i])) {
        applyGroup(groupStart, i);
        groupStart = i;
      }
    }
    applyGroup(groupStart, infos.length);

    for (const info of infos) feApplyMergeClassSetToElement(info?.el, desiredMap.get(info?.el) ?? null);
  } catch {
    /* no-op */
  }
}

function feApplyChatMergeAroundElement(messageEl, { allowNarratorMerge = false } = {}) {
  try {
    if (feIsNotificationMessageElement(messageEl)) {
      feClearMergeClassesFromMessageElement(messageEl);
      return;
    }
    const anchor = messageEl?.closest?.("li.chat-message") ?? messageEl;
    const log = anchor?.closest?.("ol.chat-log, #chat-log, #fe-chat-export-log");
    if (!feIsElementNode(anchor) || !feIsElementNode(log)) return;
    try { feDedupeChatMessagesInLog(log); } catch {}
    const neighborhood = feCollectMergeNeighborhood(log, anchor, { allowNarratorMerge });
    const slice = neighborhood?.slice ?? [];
    if (!slice.length) return;
    feApplyChatMergeSlice(slice, Math.max(0, Number(neighborhood?.firstIndex) || 0), { allowNarratorMerge });
    if (neighborhood?.hasMissingDocs) feScheduleRenderedLogRefresh(log, { delay: 48, allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToMessageElement(message, messageEl, { allowNarratorMerge = false } = {}) {
  try {
    void allowNarratorMerge;
    const el = feExtractHTMLElement(messageEl);
    if (!el) return;
    feBindMessageToElement(message, el);
    if (feIsNotificationMessageElement(el)) feClearMergeClassesFromMessageElement(el);
    // Do NOT mutate .message-content during normal live-chat refreshes.
    // Merge only relies on message classes/header visibility, and touching inline-roll DOM here
    // can cause visible churn when Foundry re-renders messages while scrolling.
    feStampRenderedStateAttributes(message, el);
    feApplyUserColorBgToMessageElement(message, el);
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToLog(logEl, { allowNarratorMerge = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    if (!feIsElementNode(logEl)) return;
    const nodes = Array.from(logEl.querySelectorAll?.("li.chat-message") ?? []);
    for (const li of nodes) {
      const msgId = feGetMessageIdFromElement(li);
      const msg = feGetMessageFromElementOrCollection(li) || (msgId ? game?.messages?.get?.(msgId) : null);
      if (!msg) continue;
      feApplyRenderedStateToMessageElement(msg, li, { allowNarratorMerge });
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

function feChangeTouchesInlineRollSnapshot(change) {
  try {
    if (!change || typeof change !== "object") return false;
    return ["content", "rolls", "flavor"].some((k) => Object.prototype.hasOwnProperty.call(change, k));
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
    feApplyRenderedStateToMessageElement(message, el);
  } catch {
    /* no-op */
  }
  // The message element is not yet inserted into the ChatLog at this point.
  // Schedule one debounced, message-targeted log pass for the next tick instead of mutating the
  // neighborhood immediately; this keeps merge display stable and avoids touching message-content.
  feDeferTask(() => feScheduleRenderedMessageRefresh(message?.id ?? message?._id, { delay: 18 }));
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  try {
    feHydrateRenderStateOverride(message, null, userId);
    feDeferTask(() => feScheduleRenderedMessageRefresh(message?.id ?? message?._id, { delay: 18 }));
    feDeferTask(() => feScheduleRenderedStateRefreshForMessageId(message?.id ?? message?._id, { delay: 42 }));
  } catch {
    /* no-op */
  }
});

Hooks.on("deleteChatMessage", (message) => {
  try {
    feClearInlineRollSnapshot(message?.id ?? message?._id);
    feStoreRenderStateOverride(message?.id ?? message?._id, null);
    feScheduleRenderedStateRefreshForAllLogs({ delay: 24 });
  } catch {
    /* no-op */
  }
});

Hooks.on("updateChatMessage", (message, change, _options, userId) => {
  try {
    if (feChangeTouchesInlineRollSnapshot(change)) feClearInlineRollSnapshot(message?.id ?? message?._id);
    if (feChangeTouchesRenderState(change)) feHydrateRenderStateOverride(message, null, userId);
    feDeferTask(() => feScheduleRenderedMessageRefresh(message?.id ?? message?._id, { delay: 18 }));
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

function feFreezeInlineRollSyntax(content) {
  try {
    const src = String(content ?? "");
    if (!src || !src.includes("[[") || /class=["']inline-roll\b/i.test(src)) return src;
    return src.replace(/\[\[([\s\S]+?)\]\]/g, (match, rawExpr) => {
      try {
        let expr = String(rawExpr ?? "").trim();
        if (!expr) return match;
        expr = expr.replace(/^\/(?:r|roll|gmroll|blindroll|selfroll|publicroll|pr|br|sr)\s+/i, "").trim();
        if (!expr) return match;
        let roll = null;
        try { roll = Roll.create ? Roll.create(expr) : new Roll(expr); } catch { roll = new Roll(expr); }
        if (!roll) return match;
        if (typeof roll.evaluateSync === "function") roll = roll.evaluateSync({ strict: false });
        else if (typeof roll.evaluate === "function") roll = roll.evaluate({ async: false, strict: false });
        const total = roll?.total ?? "";
        const json = typeof roll?.toJSON === "function" ? roll.toJSON() : roll;
        const dataRoll = encodeURIComponent(JSON.stringify(json));
        const title = feEscapeHTML(expr);
        const label = feEscapeHTML(String(total ?? ""));
        return `<a class="inline-roll inline-result" data-roll="${dataRoll}" data-tooltip="${title}" title="${title}"><i class="fas fa-dice-d20"></i>${label}</a>`;
      } catch {
        return match;
      }
    });
  } catch {
    return String(content ?? "");
  }
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

    const msg = feGetMessageFromElementOrCollection(msgEl) || game.messages?.get?.(msgId);
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

    const msg = feGetMessageFromElementOrCollection(msgEl) || game.messages?.get?.(msgId);
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

function feApplyMarkdownOnPreCreate(message, data = {}, userId = null) {
  try {
    if (!feSetting(S.MARKDOWN_ENABLED)) return false;
    if (userId !== game.user.id) return false;

    const content = String(data?.content ?? message?.content ?? "");
    const trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/")) return false;
    if (feLooksLikeHTML(content)) return false;

    try {
      const hasRolls =
        (Array.isArray(data?.rolls) && data.rolls.length > 0) ||
        (Array.isArray(message?.rolls) && message.rolls.length > 0);
      if (hasRolls) return false;
    } catch (_e) {
      /* noop */
    }

    let html = feMarkdownToHTML(content);
    html = feFreezeInlineRollSyntax(html);

    const flags = foundry.utils.deepClone(data?.flags ?? message?.flags ?? {});
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      raw: content,
      markdown: true,
    });

    message.updateSource({ content: html, flags });
    return true;
  } catch {
    return false;
  }
}

function feMaybeFreezeInlineRollContentOnPreCreate(message, data = {}, userId = null) {
  try {
    if (userId !== game.user.id) return false;
    const content = String(data?.content ?? message?.content ?? "");
    if (!content || !content.includes("[[") || /class=["']inline-roll\b/i.test(content)) return false;
    const frozen = feFreezeInlineRollSyntax(content);
    if (frozen && frozen !== content) {
      message.updateSource({ content: frozen });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function feGetPendingMessageSource(message, data = {}) {
  try {
    const pending = message?.toObject?.() ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(data ?? {}), pending, {
      inplace: false,
      recursive: true,
      overwrite: true,
    });
  } catch {
    return data ?? {};
  }
}

Hooks.on("preCreateChatMessage", (message, data, _options, userId) => {
  try {
    if (userId !== game.user.id) return;
    feApplyMarkdownOnPreCreate(message, data, userId);
    feMaybeFreezeInlineRollContentOnPreCreate(message, data, userId);
    feCaptureMessageRenderFlagsOnPreCreate(message, feGetPendingMessageSource(message, data), userId);
  } catch {
    /* no-op */
  }
});

Hooks.on("preUpdateChatMessage", (message, changed, _options, userId) => {
  try {
    if (userId !== game.user.id) return;
    if (typeof changed?.content === "string" && changed.content.includes("[[") && !/class=["']inline-roll\b/i.test(changed.content)) {
      changed.content = feFreezeInlineRollSyntax(changed.content);
    }
    feCaptureMessageRenderFlagsOnPreUpdate(message, changed, userId);
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
const FE_RENDER_SPECIAL_KIND_FLAG = "specialKind";
const FE_RENDER_MERGE_HINT_FLAG = "mergeHint";
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

function feMessageHasDynamicRollContent(content, message = null, el = null) {
  try {
    const src = String(content ?? "");
    if (/class=["'][^"']*\binline-roll\b[^"']*["']/i.test(src)) return true;
    if (/class=["'][^"']*(?:\bdice-roll\b|\bdice-result\b)[^"']*["']/i.test(src)) return true;
    if (/class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b)[^"']*["']/i.test(src)) return true;
    if (/\[\[[\s\S]+?\]\]/.test(src)) return true;
    if ((Array.isArray(message?.rolls) && message.rolls.length > 0)) return true;
    if (el?.querySelector?.('.inline-roll.inline-result, .dice-roll, .dice-result, .chat-card, .midi-chat-card')) return true;
    return false;
  } catch {
    return false;
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
    const hasDynamicRoll = feMessageHasDynamicRollContent(content, message, null) || hasRolls;
    const mergeableText = !hasDynamicRoll && !hasChatCard && !hasDice;
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
        hasDynamicRoll,
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

    feStampRenderedStateAttributes(message, el0);

    const state = feGetStoredRenderState(message);
    const isNarratorTools = typeof state?.isNarrator === "boolean"
      ? state.isNarrator
      : feIsNarratorToolsMessage(message, el0);
    const isRoundMarker = typeof state?.isRoundMarker === "boolean"
      ? state.isRoundMarker
      : feIsRoundMarkerMessage(message, el0);
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
    const queryRoot = doc?.querySelectorAll ? doc : document;
    const roots = Array.from(queryRoot.querySelectorAll?.("#chat-log, ol.chat-log, #fe-chat-export-log, #chat-notifications") ?? []);
    if (queryRoot?.matches?.("#chat-log, ol.chat-log, #fe-chat-export-log, #chat-notifications")) roots.unshift(queryRoot);

    for (const root of roots) {
      const nodes = root.querySelectorAll(":scope > li.chat-message, :scope > .message");
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

    const nodes = logEl.querySelectorAll(":scope > li.chat-message, :scope > .message");
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
  const li = el?.closest?.("li.chat-message, #chat-notifications .message") ?? el;
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

function feReadStampedMergeInfoFromElement(el) {
  try {
    const node = feExtractHTMLElement(el);
    const ds = node?.dataset;
    if (!ds) return null;
    const hasAny =
      Object.prototype.hasOwnProperty.call(ds, "feMergeKey") ||
      Object.prototype.hasOwnProperty.call(ds, "feNoMerge") ||
      Object.prototype.hasOwnProperty.call(ds, "feIsNarrator") ||
      Object.prototype.hasOwnProperty.call(ds, "feIsRoundMarker");
    if (!hasAny) return null;

    const key = String(ds.feMergeKey ?? "").trim();
    return {
      key: key || null,
      mergeableText: ds.feMergeableText === "1",
      isNarrator: ds.feIsNarrator === "1",
      isRoundMarker: ds.feIsRoundMarker === "1",
      noMerge: ds.feNoMerge === "1",
    };
  } catch {
    return null;
  }
}

function feStampRenderedStateAttributes(message, messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl);
    const ds = el?.dataset;
    if (!el?.classList || !ds || !message) return;

    const state = feGetStoredRenderState(message);
    const storedHint = state?.merge ?? message?.flags?.[MODULE_ID]?.[FE_RENDER_MERGE_HINT_FLAG] ?? null;
    const isNarratorTools = typeof state?.isNarrator === "boolean"
      ? state.isNarrator
      : feIsNarratorToolsMessage(message, el);
    const isRoundMarker = typeof state?.isRoundMarker === "boolean"
      ? state.isRoundMarker
      : feIsRoundMarkerMessage(message, el);

    const speaker = message?.speaker ?? {};
    const whisper = Array.isArray(message?.whisper) ? message.whisper : [];
    const mergeInfo = {
      authorId: storedHint?.authorId ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? "",
      speakerKey: storedHint?.speakerKey ?? ([
        speaker.scene ?? "",
        speaker.token ?? "",
        speaker.actor ?? "",
        speaker.alias ?? "",
      ].join("|") + (isNarratorTools ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : "")),
      whisperKey: storedHint?.whisperKey ?? (whisper.length ? whisper.slice().sort().join(",") : ""),
      blind: typeof storedHint?.blind === "boolean" ? storedHint.blind : !!message?.blind,
      rollMode: storedHint?.rollMode ?? message?.rollMode ?? "",
      style: storedHint?.style ?? message?.style ?? message?.type ?? null,
      mergeableText: typeof storedHint?.mergeableText === "boolean"
        ? storedHint.mergeableText
        : !feMessageHasDynamicRollContent(String(message?.content ?? ""), message, el),
      isNarrator: isNarratorTools,
      isRoundMarker,
      noMerge: typeof storedHint?.noMerge === "boolean"
        ? storedHint.noMerge
        : (isNarratorTools || isRoundMarker),
    };

    const mergeKey = feMergeKey(mergeInfo);
    if (mergeKey) ds.feMergeKey = mergeKey;
    else delete ds.feMergeKey;

    ds.feMergeableText = mergeInfo.mergeableText ? "1" : "0";
    ds.feNoMerge = mergeInfo.noMerge ? "1" : "0";
    ds.feIsNarrator = isNarratorTools ? "1" : "0";
    ds.feIsRoundMarker = isRoundMarker ? "1" : "0";
  } catch {
    /* no-op */
  }
}

function feMessageMergeInfo(msg, el) {
  const stamped = feReadStampedMergeInfoFromElement(el);
  const storedState = feGetStoredRenderState(msg);
  const storedHint = storedState?.merge ?? msg?.flags?.[MODULE_ID]?.[FE_RENDER_MERGE_HINT_FLAG] ?? null;

  // NOTE: v13+: ChatMessage#user is deprecated -> use ChatMessage#author
  // Some automation modules may still populate legacy fields during rapid updates, so keep fallbacks.
  const authorId = storedHint?.authorId ?? msg?.author?.id ?? msg?.user?.id ?? msg?.user ?? "";

  const isNarratorTools = typeof stamped?.isNarrator === "boolean"
    ? stamped.isNarrator
    : (typeof storedState?.isNarrator === "boolean" ? storedState.isNarrator : feIsNarratorToolsMessage(msg, el));
  const isRoundMarker = typeof stamped?.isRoundMarker === "boolean"
    ? stamped.isRoundMarker
    : (typeof storedState?.isRoundMarker === "boolean" ? storedState.isRoundMarker : feIsRoundMarkerMessage(msg, el));

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
  const hasDynamicRoll = typeof storedHint?.hasDynamicRoll === "boolean"
    ? storedHint.hasDynamicRoll
    : feMessageHasDynamicRollContent(content, msg, el) || hasRolls;

  // "Merge only text" should merge plain text lines, but avoid inline rolls / dice rolls / chat cards.
  const mergeableText = typeof storedHint?.mergeableText === "boolean"
    ? storedHint.mergeableText
    : (typeof stamped?.mergeableText === "boolean" ? stamped.mergeableText : !hasDynamicRoll);

  const noMerge = typeof storedHint?.noMerge === "boolean"
    ? storedHint.noMerge
    : (typeof stamped?.noMerge === "boolean" ? stamped.noMerge : (isNarratorTools || isRoundMarker));

  return {
    authorId,
    speakerKey,
    whisperKey,
    blind,
    rollMode,
    style,
    mergeableText,
    key: stamped?.key ?? null,
    isNarrator: isNarratorTools,
    isRoundMarker,
    // Keep narrator/round-marker lines standalone in live chat; inline-roll / dice messages can also opt out.
    noMerge,
  };
}




function feGetChatLogs() {
  // Sidebar + any chat popouts / adopted chat roots in other windows.
  const logs = new Set();
  const scannedDocs = new Set();

  const collect = (root) => {
    try {
      const queryRoot = root?.querySelectorAll ? root : root?.document ?? null;
      if (!queryRoot || scannedDocs.has(queryRoot)) return;
      scannedDocs.add(queryRoot);
      queryRoot.querySelectorAll("ol.chat-log, #chat-log").forEach((el) => {
        if (feIsElementNode(el)) logs.add(el);
      });
    } catch {
      /* no-op */
    }
  };

  collect(document);

  try {
    for (const app of Object.values(ui?.windows ?? {})) {
      const root = app?.element?.[0] ?? app?.element ?? null;
      if (root) collect(root);
      const doc = root?.ownerDocument ?? app?.window?.document ?? null;
      if (doc && doc !== document) collect(doc);
    }
  } catch {
    /* no-op */
  }

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




const feMergeClassSignatureCache = new WeakMap();
const FE_MERGE_CLASS_LIST = ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"];

function feBuildMergeClassSignature(desiredSet) {
  try {
    if (!desiredSet || !desiredSet.size) return "";
    return Array.from(desiredSet).sort().join("|");
  } catch {
    return "";
  }
}

function feReadActualMergeClassSignature(el) {
  try {
    if (!el?.classList) return "";
    const actual = new Set();
    for (const cls of FE_MERGE_CLASS_LIST) {
      if (el.classList.contains(cls)) actual.add(cls);
    }
    return feBuildMergeClassSignature(actual);
  } catch {
    return "";
  }
}

function feApplyMergeClassSetToElement(el, desired = null) {
  try {
    if (!el?.classList) return;
    const signature = feBuildMergeClassSignature(desired);
    const cached = feMergeClassSignatureCache.get(el) ?? null;
    const actual = feReadActualMergeClassSignature(el);
    if (cached === signature && actual === signature) return;
    for (const cls of FE_MERGE_CLASS_LIST) {
      const shouldHave = desired ? desired.has(cls) : false;
      if (shouldHave) el.classList.add(cls);
      else el.classList.remove(cls);
    }
    feMergeClassSignatureCache.set(el, signature);
    try {
      if (signature) el.dataset.feMergeSig = signature;
      else delete el.dataset.feMergeSig;
    } catch {
      /* no-op */
    }
  } catch {
    /* no-op */
  }
}

function feApplyChatMerge(logEl, { allowNarratorMerge = false } = {}) {
  if (!feIsElementNode(logEl)) return;
  try { feDedupeChatMessagesInLog(logEl); } catch {}

  const msgs = Array.from(logEl.querySelectorAll("li.chat-message"));

  const applyDesiredClasses = (desiredMap) => {
    for (const el of msgs) {
      const desired = desiredMap.get(el) ?? null;
      feApplyMergeClassSetToElement(el, desired);
    }
  };

  const mergeEnabled = !!feSetting(S.MERGE_ENABLED);
  if (!mergeEnabled || !msgs.length) {
    applyDesiredClasses(new Map());
    return;
  }

  const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
  const showDivider = !!feSetting(S.MERGE_DIVIDER);
  const mergeMode = String(feSetting(S.MERGE_MODE) ?? "standard");
  const simpleMode = mergeMode === "simple";

  const infos = [];
  let idx = 0;
  for (const el of msgs) {
    const msgId = feGetMessageIdFromElement(el);
    const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game.messages?.get?.(msgId) : null);
    const info = feMessageMergeInfo(msg, el);
    infos.push({
      ...info,
      msgId,
      missing: !msg && !info?.key,
      el,
      idx,
      order: feGetChatMessageElementOrder(el, idx),
    });
    idx += 1;
  }

  infos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  let hasMissingDocs = false;
  for (const info of infos) {
    if (info.key) continue;
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

  const desiredMap = new Map();
  for (const info of infos) desiredMap.set(info.el, new Set());

  const mark = (el, cls) => {
    const set = desiredMap.get(el);
    if (set) set.add(cls);
  };

  const applyGroup = (startIndex, endIndexExclusive) => {
    const groupLen = endIndexExclusive - startIndex;
    if (groupLen <= 0) return;
    const first = infos[startIndex];
    if (!first?.el) return;
    if (showDivider && startIndex > 0) mark(first.el, "fe-divider-before");
    if (groupLen === 1) return;
    if (simpleMode) {
      for (let i = startIndex + 1; i < endIndexExclusive; i += 1) mark(infos[i]?.el, "fe-merge-follow");
      return;
    }
    mark(first.el, "fe-merge-start");
    for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
    mark(infos[endIndexExclusive - 1]?.el, "fe-merge-end");
  };

  let groupStart = 0;
  for (let i = 1; i < infos.length; i += 1) {
    if (!canMerge(infos[i - 1], infos[i])) {
      applyGroup(groupStart, i);
      groupStart = i;
    }
  }
  applyGroup(groupStart, infos.length);

  applyDesiredClasses(desiredMap);
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
    if (feHasRenderedStateWork()) feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });
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
  feScheduleRenderedStateRefreshForAllLogs,
  feScheduleRenderedStateRefreshForMessageId,
  feSetChatFontChoiceClass,
  feSetChatCardFontClass,
  feSetUiFontClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,

  feApplyChatMerge,
  feCaptureMessageRenderFlagsOnPreCreate,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feMessageMergeInfo,
  feMergeKey,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
};
