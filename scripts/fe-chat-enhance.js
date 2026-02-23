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
  EXPORT_PRINT_IMAGE_MODE: "ceExportPrintImageMode", // full | hideAvatars | hideAll | downscale
  EXPORT_DESKTOP_EXTERNAL_MODE: "ceExportDesktopExternalMode", // off | button | auto

  // Typography
  CHATCARD_USE_CUSTOM_FONT: "ceChatCardUseCustomFont",

  // Style (tunable CSS vars)
  STYLE_ACTOR_NAME_SIZE: "ceActorNameSize",
  STYLE_PLAYER_NAME_SIZE: "cePlayerNameSize",
  STYLE_MESSAGE_TEXT_SIZE: "ceMessageTextSize",
  STYLE_CHATCARD_TEXT_SIZE: "ceChatCardTextSize",
  STYLE_BG_SATURATION: "ceMessageBgSaturation",

  // Markdown
  MARKDOWN_ENABLED: "ceMarkdownEnabled",

  // Edit
  EDIT_ENABLED: "ceEditEnabled",
};

function feSetting(key) {
  return game.settings.get(MODULE_ID, key);
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

    // Message background saturation (paper overlay alpha)
    root.style.setProperty("--fe-paper-alpha", String(num(feSetting(S.STYLE_BG_SATURATION), 0.42)));
  } catch (err) {
    console.warn("female_edition | failed to apply style vars", err);
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
    onChange: () => feInjectExportButtonsAll(),
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
    choices: {
      full: "그대로(고품질/대용량)",
      hideAvatars: "아바타/포트레이트 숨김(권장)",
      hideAll: "모든 이미지 숨김(최대 안정)",
      downscale: "이미지 다운스케일(실험적)",
    },
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

  game.settings.register(MODULE_ID, S.CHATCARD_USE_CUSTOM_FONT, {
    name: "채팅 카드(설명) 커스텀 폰트 적용",
    hint: "주문/아이템/피처 설명 박스(Details/Description)에도 UI 커스텀 폰트(CookieRun)를 적용합니다. 아이콘/특수문자 표시가 깨지면 끄세요.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feSetChatCardFontClass(),
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
});

Hooks.once("ready", () => {
  feApplyStyleVarsFromSettings(document);
  feSetBodyMergeClasses();
  feSetChatCardFontClass(document);
  feObserveChatLogs();
  feApplyChatMergeToAllLogs();
  feInjectExportButtonsAll();
  feSetupTypingIndicator();
  feInstallMarkdownPreCreateHook();
  feInstallEditHandlers();
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
// The live chat log uses chat-bg-stripper.js (MutationObserver) to remove only
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

function feStripChatTexturesInWindow(win, rootEl) {
  try {
    if (!win || !rootEl) return;
    const root = rootEl instanceof win.Element ? rootEl : win.document;
    const messages = Array.from(root.querySelectorAll?.(".chat-message") ?? []);
    for (const msg of messages) {
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

// -------------------------------------
// Edit existing messages (v13-safe)
// Inspired by mrkb-fvtt-modules/fvtt-chat-enhancements (chatEditor.mjs)
// -------------------------------------

let FE_EDITING_MESSAGE_ID = null;

function feCanEditMessage(msg) {
  try {
    return !!msg?.canUserModify?.(game.user, "update");
  } catch {
    return false;
  }
}

function feIsMsgEditable(msg) {
  return feCanEditMessage(msg);
}

function feGetEditableRaw(msg) {
  return (
    msg?.getFlag?.(MODULE_ID, "raw") ??
    msg?.getFlag?.(MODULE_ID, "plain") ??
    (msg?.content ?? "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n")
      .replace(/<\/?p[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim()
  );
}

function feEnsureInlineEditorUI() {
  const chatForm =
    document.querySelector("#chat-form") ||
    document.querySelector("form.chat-form") ||
    document.querySelector("#chat-controls")?.closest("form");

  if (!chatForm) return null;

  let wrap = chatForm.querySelector("#fe-chat-inline-editor");
  if (wrap) return wrap;

  wrap = document.createElement("div");
  wrap.id = "fe-chat-inline-editor";
  wrap.className = "fe-chat-inline-editor";
  wrap.innerHTML = `
    <div class="fe-chat-inline-editor-row">
      <textarea class="fe-chat-inline-editor-text" rows="3" spellcheck="false"></textarea>
    </div>
    <div class="fe-chat-inline-editor-actions">
      <button type="button" class="fe-chat-inline-editor-save">
        <i class="fa-solid fa-check"></i>
        <span>저장</span>
      </button>
      <button type="button" class="fe-chat-inline-editor-cancel">
        <i class="fa-solid fa-xmark"></i>
        <span>취소</span>
      </button>
    </div>
  `;

  chatForm.prepend(wrap);

  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  const btnSave = wrap.querySelector(".fe-chat-inline-editor-save");
  const btnCancel = wrap.querySelector(".fe-chat-inline-editor-cancel");

  btnSave.addEventListener("click", () => feCommitInlineEdit());
  btnCancel.addEventListener("click", () => feCancelInlineEdit());

  textarea.addEventListener("keydown", (ev) => {
    // Ctrl+Enter => save
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      feCommitInlineEdit();
    }
    // Escape => cancel
    if (ev.key === "Escape") {
      ev.preventDefault();
      feCancelInlineEdit();
    }
  });

  wrap.style.display = "none";
  return wrap;
}

function feSetChatInputDisabled(disabled) {
  const input =
    document.querySelector("#chat-message") ||
    document.querySelector("#chat-form textarea[name='message']") ||
    document.querySelector("textarea[name='message']");

  if (!input) return;
  input.disabled = disabled;
  input.classList.toggle("fe-chat-input-disabled", disabled);
}

function feStartInlineEdit(msg) {
  if (!feCanEditMessage(msg)) {
    ui?.notifications?.warn("이 메시지를 수정할 권한이 없습니다.");
    return;
  }
  const wrap = feEnsureInlineEditorUI();
  if (!wrap) return;

  FE_EDITING_MESSAGE_ID = msg.id;

  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  textarea.value = feGetEditableRaw(msg);

  wrap.style.display = "";
  feSetChatInputDisabled(true);

  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
}

async function feCommitInlineEdit() {
  const wrap = document.getElementById("fe-chat-inline-editor");
  if (!wrap) return;
  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  const raw = (textarea?.value ?? "").trim();

  const msgId = FE_EDITING_MESSAGE_ID;
  if (!msgId) return;

  const msg = game?.messages?.get?.(msgId);
  if (!msg) {
    feCancelInlineEdit();
    return;
  }

  try {
    await feUpdateMessageFromRaw(msg, raw);
  } catch (err) {
    console.error("[female_edition] edit update failed", err);
    ui?.notifications?.error("메시지 수정에 실패했습니다. 콘솔을 확인하세요.");
  }

  feCancelInlineEdit();
}

function feCancelInlineEdit() {
  const wrap = document.getElementById("fe-chat-inline-editor");
  if (wrap) {
    wrap.style.display = "none";
    const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
    if (textarea) textarea.value = "";
  }
  FE_EDITING_MESSAGE_ID = null;
  feSetChatInputDisabled(false);
}

async function feUpdateMessageFromRaw(msg, rawText) {
  const raw = (rawText ?? "").toString();

  // Keep original raw text so re-editing preserves markdown.
  const html = await feMarkdownToHTML(raw);

  await msg.update({
    content: html,
    [`flags.${MODULE_ID}.raw`]: raw,
    [`flags.${MODULE_ID}.plain`]: raw,
  });
}

function fePatchChatContextOptions(inject) {
  const method = "_getEntryContextOptions";

  const patchOne = (host, flagKey) => {
    try {
      if (!host) return;
      if (host[flagKey]) return;
      if (typeof host[method] !== "function") return;

      const original = host[method];
      host[method] = function (...args) {
        const options = original.apply(this, args) ?? [];
        try {
          inject(options);
        } catch (e) {
          console.warn("[female_edition] edit context inject failed", e);
        }
        return options;
      };

      host[flagKey] = true;
    } catch (e) {
      console.warn("[female_edition] context patch failed", e);
    }
  };

  const patch = () => {
    const chat = ui?.chat;
    patchOne(chat?.constructor?.prototype, "__feEditContextPatchedProto");
    patchOne(chat, "__feEditContextPatchedInstance");
  };

  patch();
  Hooks.on("renderChatLog", patch);
}

function feInstallEditHandlers() {
  if (!feSetting(S.EDIT_ENABLED)) return;

  const inject = (options) => {
    if (!Array.isArray(options)) return;

    // Avoid duplicates if multiple hooks fire.
    if (options.some((o) => o?.feId === "fe-edit-message")) return;

    options.unshift({
      feId: "fe-edit-message",
      name: "메시지 수정",
      icon: '<i class="fa-solid fa-pen-to-square"></i>',
      condition: (target) => {
        const msg = feMessageFromContextLI(target);
        return feIsMsgEditable(msg);
      },
      callback: (target) => {
        const msg = feMessageFromContextLI(target);
        if (!msg) return;
        feStartInlineEdit(msg);
      },
    });
  };

  // FVTT v13 (ApplicationV2) - Document context options
  // ChatMessage => getChatMessageContextOptions
  Hooks.on("getChatMessageContextOptions", (_app, options) => inject(options));

  // Back-compat: some modules still use legacy chat context hook
  Hooks.on("getChatLogEntryContext", (_html, options) => inject(options));

  // Fallback: some chat replacements bypass hooks; patch the active chat app prototype
  fePatchChatContextOptions(inject);

  // Delegated click handler for the pencil icon (covers existing + newly-rendered messages)
  if (!feInstallEditHandlers._delegateBound) {
    feInstallEditHandlers._delegateBound = true;
    document.addEventListener(
      "click",
      (ev) => {
        if (!feSetting(S.EDIT_ENABLED)) return;

        const btn = ev.target?.closest?.("a.message-edit, button.message-edit");
        if (!btn) return;

        const li = btn.closest("li.chat-message");
        const msgId = li?.dataset?.messageId;
        if (!msgId) return;

        const msg = game.messages?.get?.(msgId);
        if (!feIsMsgEditable(msg)) return;

        ev.preventDefault();
        ev.stopPropagation();
        feStartInlineEdit(msg);
      },
      true
    );
  }

  // v13+: supported hook (HTMLElement). Ensure an edit control exists even when
  // other modules/themes remove or hide the default edit icon.
  if (!feInstallEditHandlers._renderHookBound) {
    feInstallEditHandlers._renderHookBound = true;
    Hooks.on("renderChatMessageHTML", (message, html) => {
      if (!feSetting(S.EDIT_ENABLED)) return;
      try {
        // v13 hook provides an HTMLElement already.
        feEnsureMessageEditControl(message, html);
      } catch (e) {
        console.warn(`${MODULE_ID} | failed to ensure edit control`, e);
      }
    });
  }
}

function feMessageFromContextLI(target) {
  // Foundry may pass either the <li> itself or an inner element. It can also pass a jQuery wrapper.
  try {
    const el0 = target?.[0] ?? target;
    const el = el0?.closest ? el0.closest("[data-message-id]") ?? el0 : el0;

    const id =
      el?.dataset?.messageId ??
      (typeof target?.data === "function" ? target.data("messageId") : undefined) ??
      (typeof target?.attr === "function" ? target.attr("data-message-id") : undefined) ??
      (typeof el?.getAttribute === "function" ? el.getAttribute("data-message-id") : undefined);

    return id ? game.messages?.get?.(id) ?? null : null;
  } catch (_e) {
    return null;
  }
}

function feEnsureMessageEditControl(message, messageEl) {
  if (!(messageEl instanceof HTMLElement)) return;
  if (!message || !feCanEditMessage(message)) return;

  const metadata = messageEl.querySelector(".message-metadata");
  if (!metadata) return;

  // Bind existing edit control (if present)
  const existing = metadata.querySelector("a.message-edit");
  if (existing) {
    if (existing.dataset.feEditBound === "1") return;
    existing.dataset.feEditBound = "1";
    existing.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        feStartInlineEdit(message);
      },
      true
    );
    return;
  }

  // Otherwise, insert our own control.
  const a = document.createElement("a");
  a.classList.add("message-edit", "fe-message-edit");
  a.setAttribute("role", "button");
  a.setAttribute("aria-label", "메시지 수정");
  a.dataset.action = "feEditMessage";
  a.innerHTML = '<i class="fa-solid fa-pen-to-square" aria-hidden="true"></i>';
  a.addEventListener(
    "click",
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      feStartInlineEdit(message);
    },
    true
  );

  metadata.prepend(a);
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

// -------------------------------------
// Export to PDF (Print)
// -------------------------------------

function feInjectExportButton(root = document) {
  if (!feSetting(S.EXPORT_ENABLED)) return;

  const controls =
    root.querySelector("#chat-controls") ||
    root.querySelector("#sidebar #chat #chat-controls") ||
    root.querySelector("#sidebar #chat .chat-controls") ||
    root.querySelector("#sidebar #chat .chat-control-icons") ||
    root.querySelector("#sidebar #chat .control-buttons") ||
    root.querySelector("#sidebar #chat form.chat-form");

  if (!controls) return;
  if (controls.querySelector(".fe-export-pdf")) return;

  const a = document.createElement("a");
  a.className = "control-icon fe-export-pdf";
  a.dataset.tooltip = "채팅 로그 내보내기(PDF/HTML)";
  a.ariaLabel = "채팅 로그 내보내기(PDF/HTML)";
  a.innerHTML = '<i class="fa-solid fa-file-pdf"></i>';

  a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await feExportChatLogToPDF();
  });

  controls.appendChild(a);
}

function feInjectExportButtonsAll() {
  feInjectExportButton(document);
  // also for popped-out chat logs if present
  for (const w of Object.values(ui.windows ?? {})) {
    const root = w?.element?.[0] ?? w?.element ?? null;
    if (root instanceof HTMLElement) feInjectExportButton(root);
  }
}

function feEnsureExportContainer() {
  let container = document.getElementById("fe-chat-export-container");
  if (container) return container;

  container = document.createElement("div");
  container.id = "fe-chat-export-container";
  container.innerHTML = `
    <div class="fe-chat-export-toolbar">
      <div id="fe-chat-export-title">Chat Log</div>
      <div id="fe-chat-export-meta"></div>
      <div class="fe-chat-export-actions">
        <a class="fe-chat-export-action fe-chat-export-download" aria-label="Download HTML" data-tooltip="HTML 저장">HTML</a>
        <a class="fe-chat-export-action fe-chat-export-print" aria-label="Print" data-tooltip="인쇄 / PDF">🖨</a>
        <a class="fe-chat-export-action fe-chat-export-close" aria-label="Close" data-tooltip="닫기">✕</a>
      </div>
    </div>
    <ol id="fe-chat-export-log" class="chat-log"></ol>
  `;

  document.body.appendChild(container);

  const close = container.querySelector(".fe-chat-export-close");
  const printBtn = container.querySelector(".fe-chat-export-print");
  const dlBtn = container.querySelector(".fe-chat-export-download");

  const closeHandler = (ev) => {
    ev?.preventDefault?.();
    try {
      container.remove();
    } catch {}
    document.body.classList.remove("fe-print-chatlog");
  };

  if (close) close.addEventListener("click", closeHandler);
  if (printBtn) {
    printBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.print();
    });
  }
  if (dlBtn) {
    dlBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      feDownloadExportHTMLFromCurrentDocument();
    });
  }

  return container;
}

function feEnsurePrintCSSOverrides() {
  const styleId = "fe-chat-export-printfix";
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
@media print {
  html {
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
  }

  body.game.fe-print-chatlog {
    position: static !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }

  body.game.fe-print-chatlog > :not(#fe-chat-export-container) {
    display: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-container {
    display: block !important;
    position: static !important;
    inset: auto !important;
    overflow: visible !important;
    width: auto !important;
    height: auto !important;
    max-height: none !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border: 0 !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-container .fe-chat-export-toolbar {
    display: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-log {
    display: block !important;
    flex: none !important;
    height: auto !important;
    overflow: visible !important;
    max-height: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-log .chat-message {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  @page {
    margin: 10mm;
  }
}
`;
  document.head.appendChild(style);
}

/**
 * Primary export entry point.
 *
 * Strategy:
 *  1) Try to open a dedicated "chat archive" popup window and render the log there.
 *     - Avoids Chromium/Electron print clipping caused by Foundry's fixed viewport.
 *     - Lets the user save/print like a normal web page (Ctrl+S / Print to PDF).
 *  2) If popups are blocked, fall back to the in-document export container.
 */
async function feExportChatLogToPDF() {
  // Prefer a separate archive window for reliable multi-page printing.
  const win = feOpenChatArchiveWindow();
  if (win) {
    try {
      const desktopExternalMode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
      const wantsExternalAuto = feIsElectron() && desktopExternalMode === "auto";
      const optimize = !!feSetting(S.EXPORT_OPTIMIZE);

      const worldName = game.world?.title || game.world?.name || "";
      const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

      await feRenderChatArchiveWindow(win, {
        autoPrint: wantsExternalAuto ? false : !!feSetting(S.EXPORT_AUTO_PRINT),
        optimize,
      });

      if (wantsExternalAuto) {
        await feOpenArchiveInExternalBrowser(win, titleText, { closeAfter: true });
      }
      return;
    } catch (err) {
      console.warn("female_edition | archive window export failed, falling back to inline export", err);
      try {
        win.close();
      } catch {}
    }
  }

  // Fallback: in-document export + print.
  await feExportChatLogToPDFInline();
}

// ---------------------------
// Export (Inline fallback)
// ---------------------------

async function feExportChatLogToPDFInline() {
  if (document.body.classList.contains("fe-print-chatlog")) return;

  // Foundry runs the app in a fixed viewport with overflow hidden.
  // Chromium printing will otherwise only capture the first visible page.
  const htmlEl = document.documentElement;
  const prevHtmlOverflow = htmlEl.style.overflow;
  const prevHtmlHeight = htmlEl.style.height;
  const prevBodyOverflow = document.body.style.overflow;
  const prevBodyHeight = document.body.style.height;

  document.body.classList.add("fe-print-chatlog");
  if (feSetting(S.EXPORT_OPTIMIZE)) document.body.classList.add("fe-export-optimized");

    // Ensure print CSS beats Foundry's body.game print rules (multi-page PDF fix)
    feEnsurePrintCSSOverrides();

  // Ensure the document can extend beyond the viewport.
  htmlEl.style.overflow = "visible";
  htmlEl.style.height = "auto";
  document.body.style.overflow = "visible";
  document.body.style.height = "auto";
  const container = feEnsureExportContainer();
  const titleEl = container.querySelector("#fe-chat-export-title");
  const metaEl = container.querySelector("#fe-chat-export-meta");
  const logEl = container.querySelector("#fe-chat-export-log");

  // Match the current chat-log class list as closely as possible (theme, sizing, etc.)
  const sampleLog = document.querySelector("ol.chat-log, #chat-log");
  if (sampleLog?.className) logEl.className = sampleLog.className;

  // Keep our id stable
  logEl.id = "fe-chat-export-log";
  logEl.innerHTML = "";

  try {
    const user = game.user;

    // Collect messages the current user can see
    const all = Array.from(game.messages?.contents ?? []);
    all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const messages = all.filter((m) => feCanUserSeeChatMessage(m, user));

    // Header/meta
    const worldName = game.world?.title ?? game.world?.name ?? "";
    const sceneName = canvas?.scene?.name ?? "";
    titleEl.textContent = worldName ? `Chat Log – ${worldName}` : "Chat Log";
    metaEl.textContent = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

    // Render each message using Foundry's own renderer so we keep portraits/chat cards, etc.
    let i = 0;
    for (const msg of messages) {
      i++;
      if (i === 1 || i % 25 === 0 || i === messages.length) {
        metaEl.textContent = `Rendering… ${i}/${messages.length}`;
      }

      let li = null;
      try {
        // Some modules (e.g. portrait mods) look at this
        msg.exporting = true;
      } catch {}

      try {
        if (typeof msg.renderHTML === "function") li = await msg.renderHTML();
        else if (typeof msg.getHTML === "function") li = await msg.getHTML();
      } catch (err) {
        console.warn("female_edition | PDF export: failed to render message", msg, err);
      } finally {
        try {
          msg.exporting = false;
        } catch {}
      }

      // Normalize jQuery -> HTMLElement
      if (li && !(li instanceof HTMLElement) && li?.[0] instanceof HTMLElement) li = li[0];
      if (!(li instanceof HTMLElement)) continue;

      feNormalizeExportNode(li);
      logEl.appendChild(li);

      // Yield occasionally to keep UI responsive.
      // IMPORTANT: background tabs clamp timers heavily; avoid yields when hidden so export continues.
      if (i % 25 === 0) await feMaybeYieldForUI();
    }

    // Apply merge styling to export log (our mutation observer is scoped to #sidebar)
    if (feSetting(S.MERGE_ENABLED)) {
      feApplyChatMerge(logEl);
    }

    // Wait for images (portraits, item icons) to load so they actually print
    metaEl.textContent = "Loading images…";
    await feWaitForImages(logEl, 15000);

    // IMPORTANT: Force a paginatable layout.
    // If any part of the export UI remains a fixed/scroll container, Chromium printing will
    // often clip to a single page.
    try {
      container.style.position = "static";
      container.style.inset = "auto";
      container.style.width = "auto";
      container.style.height = "auto";
      container.style.overflow = "visible";
      logEl.style.display = "block";
      logEl.style.height = "auto";
      logEl.style.maxHeight = "none";
      logEl.style.overflow = "visible";
    } catch {}

    // Force a synchronous reflow before printing.
    // Avoid relying on timers here (background tabs clamp setTimeout).
    try {
      // eslint-disable-next-line no-unused-expressions
      container.offsetHeight;
      // eslint-disable-next-line no-unused-expressions
      logEl.offsetHeight;
    } catch {}

    metaEl.textContent = "Opening print dialog…";

    // Cleanup after printing; keep a close button as a fallback.
    const cleanup = () => {
      try {
        container.remove();
      } catch {}
      document.body.classList.remove("fe-print-chatlog");
      document.body.classList.remove("fe-export-optimized");

      // Restore document sizing
      htmlEl.style.overflow = prevHtmlOverflow;
      htmlEl.style.height = prevHtmlHeight;
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.height = prevBodyHeight;
    };

    const afterPrint = () => cleanup();
    window.addEventListener("afterprint", afterPrint, { once: true });

    window.print();

    // Some environments (Electron) don't always fire afterprint reliably.
    // The close button remains available; also attempt a delayed cleanup if print returns immediately.
    setTimeout(() => {
      if (document.body.classList.contains("fe-print-chatlog") && !document.getElementById("fe-chat-export-container")) {
        document.body.classList.remove("fe-print-chatlog");
        document.body.classList.remove("fe-export-optimized");
      }
    }, 0);
  } catch (err) {
    console.error(err);
    ui.notifications?.error("Chat log PDF export failed. Check the console for details.");
  }
}

// ---------------------------
// Export (Archive window)
// ---------------------------

function feOpenChatArchiveWindow() {
  try {
    // Reuse the same window if the user exports repeatedly.
    const features = [
      "popup=yes",
      "width=1100",
      "height=800",
      "left=100",
      "top=80",
    ].join(",");

    const win = window.open("", "fe-chat-archive", features);
    if (!win || win.closed) return null;

    try {
      win.focus();
    } catch {}
    return win;
  } catch {
    return null;
  }
}

function feCollectHeadStylesHTML() {
  try {
    // Copy all stylesheet links and injected <style> tags.
    // This makes the archive render match the Foundry UI as closely as possible.
    const nodes = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'));
    return nodes.map((n) => n.outerHTML).join("\n");
  } catch {
    return "";
  }
}

function feEscapeAttr(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function feSanitizeFilename(name) {
  const s = String(name ?? "")
    .trim()
    // Windows reserved characters
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 120);
}

function feIsElectron() {
  try {
    if (window?.process?.versions?.electron) return true;
  } catch {}
  try {
    const ua = String(navigator?.userAgent ?? "");
    if (ua.includes("Electron")) return true;
  } catch {}
  return false;
}

function feTryRequire(moduleName) {
  try {
    const req = window.require || globalThis.require;
    if (!req) return null;
    return req(moduleName);
  } catch {
    return null;
  }
}

async function feRenderChatArchiveWindow(win, { autoPrint = false, optimize = false } = {}) {
  if (!win || win.closed) throw new Error("Archive window is not available.");

  // Treat the chat-bg-stripper's "채팅 카드 텍스쳐 제거" setting as an implicit
  // export optimization request. Users expect the archive/saved HTML to match the
  // live chat appearance.
  const stripTexturesSetting = (() => {
    try {
      return !!game.settings.get(MODULE_ID, "stripChatTextures");
    } catch {
      return false;
    }
  })();
  const effectiveOptimize = !!optimize || stripTexturesSetting;

  // Collect messages first (so the archive UI can show correct counts immediately).
  const user = game.user;
  const all = Array.from(game.messages?.contents ?? []);
  all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const messages = all.filter((m) => feCanUserSeeChatMessage(m, user));

  const worldName = game.world?.title ?? game.world?.name ?? "";
  const sceneName = canvas?.scene?.name ?? "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";
  const metaText = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

  // Build the archive document.
  const headStyles = feCollectHeadStylesHTML();
  const baseHref = feEscapeAttr(document.baseURI ?? window.location.href);

  // Desktop (Electron) can optionally open the archive in the system browser.
  const desktopExternalMode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  const showExternalBtn = feIsElectron() && desktopExternalMode !== "off";
  const externalBtnHTML = showExternalBtn
    ? `<a class="fe-chat-export-action fe-chat-export-external" id="fe-archive-external" data-tooltip="외부 브라우저로 열기">브라우저</a>`
    : "";

  // Print/PDF image handling (Chrome/Electron can freeze on image-heavy pages)
  const printImgMode = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "hideAvatars");
  const printImgClass =
    printImgMode === "hideAll"
      ? " fe-print-hide-all"
      : printImgMode === "downscale"
        ? " fe-print-downscale"
        : printImgMode === "hideAvatars"
          ? " fe-print-hide-avatars"
          : "";

  // Keep Foundry/system/theme classes for variable definitions, then force a printable layout.
  const bodyClass = `${document.body.className ?? ""} fe-print-chatlog fe-chat-archive${effectiveOptimize ? " fe-export-optimized" : ""}${printImgClass}`;

  win.document.open();
  win.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <base href="${baseHref}">
    <title>${feEscapeHTML(titleText)}</title>
    ${headStyles}
    <style>
      /* Archive window hard overrides: make the document paginatable (no fixed viewport). */
      html, body {
        /* Keep on-screen and PDF colors as close as possible */
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        position: static !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        width: auto !important;
        background: #fff !important;
      }

      /* Keep the export container in normal flow. */
      #fe-chat-export-container {
        display: block !important;
        position: static !important;
        inset: auto !important;
        overflow: visible !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        padding: 12mm !important;
        margin: 0 !important;
      }

      /* Archive layout width
       * - Old behavior: hard-locked to Foundry sidebar width (~360px)
       * - New behavior: use a natural page width (better readability in HTML/PDF)
       */
      #fe-chat-export-container .fe-chat-export-toolbar,
      #fe-chat-export-container #sidebar {
        width: min(100%, var(--fe-export-max-width, 1200px)) !important;
        max-width: var(--fe-export-max-width, 1200px) !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      /* Minimal Foundry sidebar/chat structure so existing system/module CSS applies. */
      #fe-chat-export-container #sidebar {
        position: static !important;
        width: min(100%, var(--fe-export-max-width, 1200px)) !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        flex: 0 0 auto !important;
        background: #fff !important;
        border: 0 !important;
      }
      #fe-chat-export-container #chat {
        position: static !important;
        background: #fff !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        display: block !important;
      }
      #fe-chat-export-container #chat-log {
        position: static !important;
        background: #fff !important;
        padding: 0 !important;
        margin: 0 !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
      }

      /* Screen-only text rendering helpers.
       * Some Windows/Chrome setups look jagged when custom fonts are loaded from file://.
       * A tiny text-shadow is a common workaround (kept out of print).
       */
      @media screen {
        #fe-chat-export-container {
          -webkit-font-smoothing: auto;
          -moz-osx-font-smoothing: auto;
          text-rendering: optimizeLegibility;
        }

        #fe-chat-export-container :is(.chat-message, .chat-message *) {
          text-shadow: rgba(0,0,0,0.01) 0 0 1px !important;
        }
      }

      /* Toolbar: compact, web-page-like controls. */
      #fe-chat-export-container .fe-chat-export-toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0 0 10px 0;
      }

      #fe-chat-export-title { font-size: 18px; font-weight: 700; }
      #fe-chat-export-meta { font-size: 12px; opacity: 0.85; }

      .fe-chat-export-actions {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }

      .fe-chat-export-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid rgba(0,0,0,0.25);
        border-radius: 6px;
        font-size: 12px;
        line-height: 1;
        color: #000;
        text-decoration: none;
        cursor: pointer;
        user-select: none;
      }

      .fe-chat-export-action:hover {
        background: rgba(0,0,0,0.06);
      }

      .fe-chat-export-action[aria-disabled="true"] {
        opacity: 0.55;
        pointer-events: none;
      }

      @media print {
        html, body {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Hide the toolbar when printing (save as PDF). */
        #fe-chat-export-container .fe-chat-export-toolbar { display: none !important; }

        /* Avoid splitting a single message across pages where possible. */
        #chat-log .chat-message {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        /* PDF 안정성: 이미지 숨김 옵션 */
        body.fe-print-hide-avatars #chat-log :is(
          .message-header img,
          .message-sender .avatar,
          .message-sender > img,
          img.chat-portrait-image-size-name-dnd5e,
          img[class*="chat-portrait-image-size"]
        ) {
          display: none !important;
        }
        body.fe-print-hide-all #chat-log img { display: none !important; }

        @page { margin: 10mm; }
      }
    </style>
  </head>
  <body class="${feEscapeAttr(bodyClass)}">
    <div id="fe-chat-export-container">
      <div class="fe-chat-export-toolbar">
        <div>
          <div id="fe-chat-export-title">${feEscapeHTML(titleText)}</div>
          <div id="fe-chat-export-meta">${feEscapeHTML(metaText)}</div>
        </div>
        <div class="fe-chat-export-actions">
          <a class="fe-chat-export-action fe-chat-export-download" id="fe-archive-download" data-tooltip="HTML 저장">HTML</a>
          ${externalBtnHTML}
          <a class="fe-chat-export-action fe-chat-export-print" id="fe-archive-print" data-tooltip="인쇄 / PDF">인쇄</a>
          <a class="fe-chat-export-action fe-chat-export-close" id="fe-archive-close" data-tooltip="닫기">닫기</a>
        </div>
      </div>
      <div id="sidebar" class="sidebar">
        <section id="chat" class="sidebar-tab tab active" data-tab="chat">
          <ol id="chat-log" class="chat-log"></ol>
        </section>
      </div>
    </div>
  </body>
</html>`);
  win.document.close();

  // Apply user style variables (font sizes, background saturation) to the archive document.
  // This also ensures downloaded HTML keeps the chosen values.
  feApplyStyleVarsFromSettings(win.document);
  // Apply chat-card font toggle class in the archive window too.
  feSetChatCardFontClass(win.document);

  // Hook up controls.
  const logEl = win.document.getElementById("chat-log");
  const metaEl = win.document.getElementById("fe-chat-export-meta");

  const btnPrint = win.document.getElementById("fe-archive-print");
  const btnDownload = win.document.getElementById("fe-archive-download");
  const btnExternal = win.document.getElementById("fe-archive-external");
  const btnClose = win.document.getElementById("fe-archive-close");

  // Prevent exporting/printing until rendering is complete.
  try {
    btnPrint?.setAttribute?.("aria-disabled", "true");
    btnDownload?.setAttribute?.("aria-disabled", "true");
  } catch {}

  if (btnPrint)
    btnPrint.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feArchivePrint(win);
    });

  if (btnDownload)
    btnDownload.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feDownloadArchiveHTML(win, titleText);
    });

  if (btnExternal)
    btnExternal.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feOpenArchiveInExternalBrowser(win, titleText);
    });

  if (btnClose)
    btnClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      try {
        win.close();
      } catch {}
    });

  // Mirror the live chat-log's class list so themes apply (directory-list, etc.).
  try {
    const sampleLog = document.querySelector("ol.chat-log, #chat-log");
    if (sampleLog?.className) logEl.className = sampleLog.className;
  } catch {}

  // Render messages.
  logEl.innerHTML = "";
  let i = 0;
  for (const msg of messages) {
    i++;
    if (metaEl && (i === 1 || i % 25 === 0 || i === messages.length)) {
      metaEl.textContent = `Rendering… ${i}/${messages.length}`;
    }

    let li = null;
    try {
      msg.exporting = true;
    } catch {}

    try {
      if (typeof msg.renderHTML === "function") li = await msg.renderHTML();
      else if (typeof msg.getHTML === "function") li = await msg.getHTML();
    } catch (err) {
      console.warn("female_edition | archive export: failed to render message", msg, err);
    } finally {
      try {
        msg.exporting = false;
      } catch {}
    }

    if (li && !(li instanceof HTMLElement) && li?.[0] instanceof HTMLElement) li = li[0];
    if (!(li instanceof HTMLElement)) continue;

    try {
      li.classList.add("fe-export-message");
    } catch {}

    feNormalizeExportNode(li);

    // Import into the archive window.
    try {
      logEl.insertAdjacentHTML("beforeend", li.outerHTML);
    } catch {
      try {
        const imported = win.document.importNode(li, true);
        logEl.appendChild(imported);
      } catch {}
    }

    // Keep UI responsive only when visible. Background tabs clamp timers heavily.
    if (i % 25 === 0) await feMaybeYieldForUI();
  }

  // If texture stripping / export optimization is enabled, apply the same
  // sanitization logic used in the live chat log (chat-bg-stripper.js).
  // This is required for the archive window + downloaded HTML to match the
  // on-screen chat saturation/overlay behavior.
  if (effectiveOptimize) {
    try {
      if (metaEl) metaEl.textContent = "Applying texture stripping…";
      feStripChatTexturesInWindow(win, logEl);
    } catch {}
  }

  // Apply merge styling in the archive window if enabled.
  if (feSetting(S.MERGE_ENABLED)) {
    try {
      feApplyChatMergeInWindow(win);
    } catch (err) {
      console.warn("female_edition | archive merge failed", err);
    }
  }

  // Wait for images so avatars/icons actually show up.
  if (metaEl) metaEl.textContent = "Loading images…";
  await feWaitForImages(logEl, 20000);

  if (metaEl) metaEl.textContent = metaText;

  // Re-enable actions.
  try {
    btnPrint?.removeAttribute?.("aria-disabled");
    btnDownload?.removeAttribute?.("aria-disabled");
  } catch {}

  // Auto-open print dialog if requested.
  if (autoPrint) {
    try {
      win.focus();
    } catch {}
    try {
      // eslint-disable-next-line no-unused-expressions
      win.document.body.offsetHeight;
    } catch {}
    await feArchivePrint(win);
  }
}

async function feArchivePrint(win) {
  if (!win || win.closed) return;
  const doc = win.document;
  const metaEl = doc.getElementById("fe-chat-export-meta");
  const logEl =
    doc.getElementById("chat-log") ||
    doc.getElementById("fe-chat-export-log") ||
    doc.querySelector("ol.chat-log");

  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  const requested = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "hideAvatars");
  const isElectron = feIsElectron();
  let mode = requested;

  // Desktop app (Electron) is much more prone to OOM when printing images.
  // If user picked a "full" / unknown mode, fall back to a safer one.
  if (isElectron && (mode === "full" || mode === "include" || mode === "images")) mode = "downscale";

  const isAvatarImage = (img) => {
    try {
      if (!img) return false;
      if (img.classList?.contains("avatar")) return true;
      if (img.matches?.('img.chat-portrait-image-size-name-dnd5e, img[class*="chat-portrait-image-size"]')) return true;
      if (img.closest?.(".message-header, .message-sender")) return true;
      if (img.closest?.(".chat-portrait-container")) return true;
    } catch {}
    return false;
  };

  // Temporarily blank out image sources to prevent Chromium from decoding/embedding them in PDF.
  const tempDisableImages = (filterFn) => {
    if (!logEl) return () => {};
    const placeholder =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    const changed = [];
    try {
      const imgs = Array.from(logEl.querySelectorAll("img"));
      for (const img of imgs) {
        if (filterFn && !filterFn(img)) continue;
        const src = img.getAttribute("src");
        const srcset = img.getAttribute("srcset");
        if (src == null && srcset == null) continue;

        changed.push({
          img,
          src,
          srcset,
          loading: img.getAttribute("loading"),
        });

        img.setAttribute("src", placeholder);
        img.removeAttribute("srcset");
        img.setAttribute("loading", "lazy");
      }
    } catch {}
    return () => {
      for (const it of changed) {
        try {
          if (it.src != null) it.img.setAttribute("src", it.src);
          else it.img.removeAttribute("src");

          if (it.srcset != null) it.img.setAttribute("srcset", it.srcset);
          else it.img.removeAttribute("srcset");

          if (it.loading != null) it.img.setAttribute("loading", it.loading);
          else it.img.removeAttribute("loading");
        } catch {}
      }
    };
  };

  // Apply print image mode classes.
  try {
    doc.body.classList.toggle("fe-print-hide-avatars", mode === "hideAvatars");
    doc.body.classList.toggle("fe-print-hide-all", mode === "hideAll");
    doc.body.classList.toggle("fe-print-downscale", mode === "downscale");
  } catch {}

  // ---
  // Print color consistency fixes
  // ---
  // Chromium's "Save as PDF" and some printer drivers can render blend modes / translucent
  // overlays differently, causing message background saturation to vary between messages.
  // We avoid this by freezing each chat-message background to a single, computed, opaque RGB.
  // This also tends to speed up PDF printing (less compositing work).
  let restoreBg = () => {};
  try {
    restoreBg = feFreezeMessageBackgroundsForPrint(win, logEl);
    win.addEventListener("afterprint", restoreBg, { once: true });
  } catch (err) {
    console.warn("female_edition | print background freeze failed", err);
  }

  // Memory guard: if images are supposed to be hidden, also blank their src so Chromium won't decode them.
  let restoreImages = () => {};
  if (mode === "hideAll") restoreImages = tempDisableImages(() => true);
  else if (mode === "hideAvatars") restoreImages = tempDisableImages((img) => isAvatarImage(img));

  const restoreOnce = () => {
    try {
      restoreImages();
    } catch {}
    try {
      restoreBg();
    } catch {}
  };

  try {
    win.addEventListener("afterprint", restoreOnce, { once: true });
  } catch {}

  // Downscale images for stability:
  // - always when mode === "downscale"
  // - in Electron, also when images are not fully hidden
  const shouldDownscale = !!logEl && (mode === "downscale" || (isElectron && mode !== "hideAll"));
  if (shouldDownscale && logEl) {
    try {
      setMeta("Loading images…");
      await feWaitForImages(logEl, 20000);
      await feDownscaleImagesForPrint(win, logEl, {
        meta: setMeta,
        excludeAvatars: mode === "hideAvatars",
        dprCap: isElectron ? 1 : 1.5,
        webpQuality: isElectron ? 0.72 : 0.82,
        jpegQuality: isElectron ? 0.78 : 0.85,
        avatarDprCap: isElectron ? 1.75 : 2,
        avatarWebpQuality: isElectron ? 0.86 : 0.92,
        avatarJpegQuality: isElectron ? 0.88 : 0.94,
      });
    } catch (err) {
      console.warn("female_edition | print downscale failed", err);
    }
  }

  try {
    win.focus();
  } catch {}
  try {
    // eslint-disable-next-line no-unused-expressions
    doc.body.offsetHeight;
  } catch {}

  try {
    win.print();
  } finally {
    setMeta(originalMeta);
    // Fallback restore in case afterprint doesn't fire (some Electron builds)
    setTimeout(restoreOnce, 0);
  }
}

function feParseRGBAFromCSS(cssColor) {
  const s = String(cssColor ?? "").trim().toLowerCase();
  if (!s || s === "transparent") return null;

  // Most browsers expose computed colors as rgb()/rgba() with commas.
  // Also accept the modern space + slash syntax just in case.
  const m = s.match(
    /^rgba?\(\s*([\d.]+)\s*(?:,|\s)\s*([\d.]+)\s*(?:,|\s)\s*([\d.]+)(?:\s*(?:,|\/|\s)\s*([\d.]+))?\s*\)$/i
  );
  if (!m) return null;

  const r = Math.max(0, Math.min(255, Number(m[1])));
  const g = Math.max(0, Math.min(255, Number(m[2])));
  const b = Math.max(0, Math.min(255, Number(m[3])));
  const a = m[4] == null ? 1 : Math.max(0, Math.min(1, Number(m[4])));

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) return null;
  return { r, g, b, a };
}

function feScreenBlendChannel(base, overlay) {
  // base/overlay in [0..255]
  return 255 - ((255 - base) * (255 - overlay)) / 255;
}

function feFreezeMessageBackgroundsForPrint(win, logEl) {
  if (!win || win.closed) return () => {};
  if (!logEl) return () => {};

  const doc = win.document;
  const rootCS = win.getComputedStyle(doc.documentElement);

  // Pull the same "paper" overlay params used by chat-bg-stripper
  // (defaults match styles/chat-bg-stripper.css)
  const paperRGBRaw = String(rootCS.getPropertyValue("--fe-paper-rgb") || "245 239 229").trim();
  const paperParts = paperRGBRaw.split(/\s+/).map((x) => Number(x));
  const paper = {
    r: Number.isFinite(paperParts[0]) ? Math.max(0, Math.min(255, paperParts[0])) : 245,
    g: Number.isFinite(paperParts[1]) ? Math.max(0, Math.min(255, paperParts[1])) : 239,
    b: Number.isFinite(paperParts[2]) ? Math.max(0, Math.min(255, paperParts[2])) : 229,
  };
  const paperAlpha = (() => {
    const a = Number(String(rootCS.getPropertyValue("--fe-paper-alpha") || "0.42").trim());
    return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 0.42;
  })();

  const msgs = Array.from(logEl.querySelectorAll(".chat-message"));
  if (!msgs.length) return () => {};

  const changed = [];

  for (const el of msgs) {
    try {
      const cs = win.getComputedStyle(el);
      const bg = feParseRGBAFromCSS(cs.backgroundColor);
      if (!bg || bg.a <= 0) continue;

      // Blend the paper overlay using the *screen* blend formula.
      // We then bake the result into an opaque RGB to avoid print/PDF blend inconsistencies.
      const sr = feScreenBlendChannel(bg.r, paper.r);
      const sg = feScreenBlendChannel(bg.g, paper.g);
      const sb = feScreenBlendChannel(bg.b, paper.b);

      const outR = Math.round(bg.r * (1 - paperAlpha) + sr * paperAlpha);
      const outG = Math.round(bg.g * (1 - paperAlpha) + sg * paperAlpha);
      const outB = Math.round(bg.b * (1 - paperAlpha) + sb * paperAlpha);

      const prevStyle = el.getAttribute("style");
      changed.push({ el, prevStyle });

      el.style.setProperty("background-color", `rgb(${outR}, ${outG}, ${outB})`, "important");
      el.style.setProperty("background-image", "none", "important");
      el.style.setProperty("background-blend-mode", "normal", "important");
      el.style.setProperty("mix-blend-mode", "normal", "important");
      el.style.setProperty("filter", "none", "important");
      el.style.setProperty("backdrop-filter", "none", "important");
    } catch {
      // ignore
    }
  }

  return () => {
    for (const it of changed) {
      try {
        if (it.prevStyle == null) it.el.removeAttribute("style");
        else it.el.setAttribute("style", it.prevStyle);
      } catch {}
    }
  };
}

async function feDownscaleImagesForPrint(
  win,
  rootEl,
  {
    meta,
    excludeAvatars = false,
    dprCap = 1.5,
    webpQuality = 0.82,
    jpegQuality = 0.85,
    // Avatars/portraits: preserve quality (they are small but visually important)
    avatarDprCap = 2,
    avatarWebpQuality = 0.92,
    avatarJpegQuality = 0.94,
  } = {}
) {
  const setMeta = typeof meta === "function" ? meta : () => {};
  let imgs = Array.from(rootEl.querySelectorAll("img"));
  if (!imgs.length) return;

  const isAvatarImage = (img) => {
    try {
      if (!img) return false;
      if (img.classList?.contains("avatar")) return true;
      if (img.matches?.('img.chat-portrait-image-size-name-dnd5e, img[class*="chat-portrait-image-size"]')) return true;
      if (img.closest?.(".message-header, .message-sender")) return true;
      if (img.closest?.(".chat-portrait-container")) return true;
    } catch {}
    return false;
  };

  if (excludeAvatars) imgs = imgs.filter((img) => !isAvatarImage(img));

  // Cap DPR for stability (large DPR values can explode PDF size / memory use)
  const dpr = Math.max(1, Math.min(dprCap, win.devicePixelRatio || 1));
  const avatarDpr = Math.max(1, Math.min(avatarDprCap, win.devicePixelRatio || 1));

  // 1) Group images by their resolved source.
  //    This allows de-duplicating identical images (portraits, repeated icons, etc.)
  //    by generating ONE downscaled data URL and reusing it.
  const groups = new Map();

  const getKey = (img) => {
    try {
      // Prefer the actually-used resource when srcset is present.
      return img.currentSrc || img.src || img.getAttribute("src") || "";
    } catch {
      return "";
    }
  };

  // Hard cap to avoid huge canvases (prevents OOM on Electron/Chromium)
  const MAX_SIDE = 1600;

  for (const img of imgs) {
    try {
      if (!img.complete || img.naturalWidth <= 0) continue;

      const key = getKey(img);
      if (!key) continue;

      const rect = img.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));
      if (cssW <= 1 || cssH <= 1) continue;

      const isAvatar = isAvatarImage(img);
      const dprUse = isAvatar ? avatarDpr : dpr;

      let targetW = Math.max(1, Math.round(cssW * dprUse));
      let targetH = Math.max(1, Math.round(cssH * dprUse));

      const maxSide = Math.max(targetW, targetH);
      if (maxSide > MAX_SIDE) {
        const scale = MAX_SIDE / maxSide;
        targetW = Math.max(1, Math.round(targetW * scale));
        targetH = Math.max(1, Math.round(targetH * scale));
      }

      const needsResample = !(img.naturalWidth <= targetW * 1.05 && img.naturalHeight <= targetH * 1.05);

      const g = groups.get(key) || {
        key,
        imgs: [],
        maxW: 0,
        maxH: 0,
        needsResample: false,
        isAvatar: false,
      };

      g.imgs.push(img);
      g.maxW = Math.max(g.maxW, targetW);
      g.maxH = Math.max(g.maxH, targetH);
      g.needsResample = g.needsResample || needsResample;
      g.isAvatar = g.isAvatar || isAvatar;
      groups.set(key, g);
    } catch {
      // ignore
    }
  }

  const groupList = Array.from(groups.values());
  if (!groupList.length) return;

  // 2) Generate a single downscaled image per group.
  const cache = new Map();
  let gi = 0;
  for (const g of groupList) {
    gi++;
    if (gi === 1 || gi % 10 === 0 || gi === groupList.length) {
      setMeta(`Downscaling images… ${gi}/${groupList.length}`);
    }

    try {
      // Only do work when it helps:
      // - if resampling is needed OR
      // - if the same image appears multiple times (dedup benefits PDF size)
      const shouldProcess = g.needsResample || g.imgs.length > 1;
      if (!shouldProcess) continue;

      const rep = g.imgs.find((img) => img?.complete && img.naturalWidth > 0);
      if (!rep) continue;

      // Avoid upscaling.
      let outW = Math.min(g.maxW, rep.naturalWidth);
      let outH = Math.min(g.maxH, rep.naturalHeight);
      outW = Math.max(1, Math.round(outW));
      outH = Math.max(1, Math.round(outH));
      if (outW <= 1 || outH <= 1) continue;

      const canvas = win.document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d", { alpha: true });
      if (!ctx) continue;

      // Improve downscale quality (avoid jaggy / no-AA portraits)
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      } catch {}

      ctx.drawImage(rep, 0, 0, outW, outH);

      const dataUrl = await feCanvasToDataURL(canvas, {
        webpQuality: g.isAvatar ? avatarWebpQuality : webpQuality,
        jpegQuality: g.isAvatar ? avatarJpegQuality : jpegQuality,
      });
      if (!dataUrl) continue;

      cache.set(g.key, dataUrl);

      // Release memory
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // Ignore per-group failures (CORS-taint, decoding error, etc.)
    }

    if (gi % 10 === 0) await feNextTick();
  }

  // 3) Apply results to every image in the group (dedup).
  for (const g of groupList) {
    const dataUrl = cache.get(g.key);
    if (!dataUrl) continue;
    for (const img of g.imgs) {
      try {
        img.removeAttribute("srcset");
        img.src = dataUrl;
      } catch {}
    }
  }
}

async function feCanvasToDataURL(canvas, { webpQuality = 0.82, jpegQuality = 0.85 } = {}) {
  // Prefer webp (smaller); fall back to jpeg/png.
  const tryTypes = [
    { type: "image/webp", quality: webpQuality },
    { type: "image/jpeg", quality: jpegQuality },
    { type: "image/png", quality: 1.0 },
  ];

  for (const t of tryTypes) {
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, t.type, t.quality));
      if (!blob) continue;
      return await feBlobToDataURL(blob);
    } catch {}
  }
  return null;
}

async function feBuildArchiveHTMLSnapshot(win, titleText = "Chat Log", { meta } = {}) {
  if (!win || win.closed) throw new Error("Archive window is closed");
  const setMeta = typeof meta === "function" ? meta : () => {};

  const doc = win.document;
  const clone = doc.documentElement.cloneNode(true);

  // Remove CSP meta if present - it can block inline styles or resource loading in file:// context.
  try {
    clone
      .querySelectorAll('meta[http-equiv="Content-Security-Policy"], meta[http-equiv="content-security-policy"]')
      .forEach((m) => m.remove());
  } catch {}

  // Remove scripts - exported HTML should be a static snapshot.
  try {
    clone.querySelectorAll("script").forEach((s) => s.remove());
  } catch {}

  // Keep a stable <base> so relative links/resources resolve correctly when opening the saved HTML as file://.
  // (Important for CSS @import and url(...) when core/system CSS contains relative paths.)
  try {
    const headEl = clone.querySelector("head");
    const baseHref = (() => {
      try {
        return new URL(doc.baseURI ?? window.location.href).origin + "/";
      } catch {
        return "/";
      }
    })();
    if (headEl) {
      let baseEl = headEl.querySelector("base");
      if (!baseEl) {
        baseEl = doc.createElement("base");
        headEl.prepend(baseEl);
      }
      baseEl.setAttribute("href", baseHref);
    }
  } catch {}

  // IMPORTANT:
  // - Do NOT attempt to inline *all* Foundry/system/module CSS.
  //   In practice, CSSOM access can be partially blocked, and inlining a partial set
  //   while removing <link> tags results in a badly broken export (giant portraits, no merges, etc.).
  // - Keep original <link rel="stylesheet"> tags and only add small export-specific helpers.

  const head = clone.querySelector("head");
  if (head) {
    // Ensure title is correct
    try {
      let t = head.querySelector("title");
      if (!t) {
        t = doc.createElement("title");
        head.appendChild(t);
      }
      t.textContent = titleText;
    } catch {}

    // Make stylesheet hrefs absolute (helps when opening as file://)
    try {
      const baseForLinks = doc.baseURI ?? window.location.href;
      head.querySelectorAll('link[rel="stylesheet"]').forEach((l) => {
        try {
          const href = l.getAttribute("href");
          if (!href) return;
          l.setAttribute("href", new URL(href, baseForLinks).href);
        } catch {}
      });
    } catch {}

    // Embed CookieRun fonts (optional). This avoids CORS/font-loading issues when opening the
    // saved HTML from file:// (fonts are often blocked because the origin becomes "null").
    if (feSetting(S.EXPORT_EMBED_FONTS)) {
      try {
        setMeta("Embedding fonts…");
        const fontCss = await feBuildEmbeddedCookieRunFontCSS();
        if (fontCss) {
          const styleEl = doc.createElement("style");
          styleEl.id = "fe-export-embedded-fonts";
          styleEl.textContent = fontCss;
          head.appendChild(styleEl);
        }
      } catch (err) {
        console.warn("female_edition | HTML export: failed to embed fonts", err);
      }
    }
  }

  // Optional: embed images into the HTML (can increase size)
  if (feSetting(S.EXPORT_EMBED_IMAGES)) {
    try {
      await feEmbedImagesInNode(clone, { meta: setMeta });
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed images", err);
    }
  }

  return "<!doctype html>\n" + clone.outerHTML;
}

async function feDownloadArchiveHTML(win, titleText = "Chat Log") {
  if (!win || win.closed) return;
  const metaEl = win.document.getElementById("fe-chat-export-meta");
  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const safeName =
    String(titleText || "chat-log")
      .replaceAll(/[^a-zA-Z0-9\u3131-\uD79D\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || "chat-log";

  const filename = `${safeName}.html`;

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  try {
    const doc = win.document;

    setMeta("Preparing HTML…");
    const html = await feBuildArchiveHTMLSnapshot(win, titleText, { meta: setMeta });

    setMeta("Downloading…");
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("female_edition | failed to download archive HTML", err);
  } finally {
    setMeta(originalMeta);
  }
}

async function feOpenArchiveInExternalBrowser(win, titleText = "Chat Log", { closeAfter = false } = {}) {
  const mode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  if (mode === "off") return;
  if (!feIsElectron()) {
    ui?.notifications?.warn?.("외부 브라우저 열기는 데스크톱(Electron) 앱에서만 지원됩니다.");
    return;
  }

  const electron = feTryRequire("electron");
  const shell = electron?.shell;
  const fs = feTryRequire("fs");
  const path = feTryRequire("path");
  const os = feTryRequire("os");

  if (!shell || !fs || !path || !os) {
    ui?.notifications?.warn?.("Electron shell/fs 접근이 불가하여 자동으로 외부 브라우저를 열 수 없습니다. 아카이브 창에서 HTML 저장 후 외부 브라우저로 열어주세요.");
    return;
  }

  const metaEl = win?.document?.getElementById?.("fe-chat-export-meta");
  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();
  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  try {
    setMeta("Building HTML…");
    const html = await feBuildArchiveHTMLSnapshot(win, titleText, { meta: setMeta });

    const safeName = feSanitizeFilename(titleText) || "chat-log";
    const filePath = path.join(os.tmpdir(), `${safeName}-${Date.now()}.html`);
    fs.writeFileSync(filePath, html, "utf8");

    setMeta("Opening system browser…");

    // shell.openPath is preferred for opening local files.
    // It resolves with an error message string, or empty string on success.
    let errMsg = "";
    try {
      if (typeof shell.openPath === "function") {
        errMsg = (await shell.openPath(filePath)) || "";
      } else if (typeof shell.openExternal === "function") {
        await shell.openExternal(`file://${filePath}`);
      } else {
        throw new Error("Electron shell has no openPath/openExternal");
      }
    } catch (err) {
      errMsg = String(err?.message ?? err);
    }

    if (errMsg) {
      console.warn("female_edition | open external browser failed", errMsg);
      ui?.notifications?.warn?.(`외부 브라우저 열기 실패: ${errMsg}`);
    } else {
      ui?.notifications?.info?.("외부 브라우저에서 채팅 아카이브를 열었습니다.");
    }

    if (closeAfter) {
      try {
        win.close();
      } catch {}
    }
  } catch (err) {
    console.warn("female_edition | external open failed", err);
    ui?.notifications?.warn?.("외부 브라우저 열기 실패. HTML 저장 후 수동으로 열어주세요.");
  } finally {
    setMeta(originalMeta);
  }
}

async function feBuildEmbeddedCookieRunFontCSS() {
  // Tries to fetch the CookieRun font files from the module and embed them as data: URLs.
  // If files are not present, returns an empty string.
  // Match ui-font.css unicode coverage (KR + basic Latin + Latin-1)
  const unicodeRange = "U+0020-007E, U+00A0-00FF, U+AC00-D7A3, U+1100-11FF, U+3130-318F";
  const weights = [
    { weight: 400, name: "Regular", files: ["CookieRun%20Regular.ttf", "CookieRun%20Regular.otf"] },
    { weight: 700, name: "Bold", files: ["CookieRun%20Bold.ttf", "CookieRun%20Bold.otf"] },
    { weight: 900, name: "Black", files: ["CookieRun%20Black.ttf", "CookieRun%20Black.otf"] },
  ];

  const faces = [];
  for (const w of weights) {
    let dataUrl = null;
    let fmt = null;

    for (const f of w.files) {
      const url = `/modules/${MODULE_ID}/font/${f}`;
      const attempt = await feFetchAsDataURL(url);
      if (attempt) {
        dataUrl = attempt;
        fmt = f.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
        break;
      }
    }

    if (!dataUrl) continue;

    faces.push(
      `@font-face{font-family:"FE CookieRun Embedded";src:url(${dataUrl}) format("${fmt}");font-weight:${w.weight};font-style:normal;unicode-range:${unicodeRange};font-display:swap;}`
    );
  }

  // Optional: embed Dongle-Regular.ttf as a “light-feel” helper face.
  // This file is user-provided in many setups:
  //   /modules/female_edition/font/Dongle-Regular.ttf
  // If present, we embed it so saved file:// HTML keeps the same thinner look.
  try {
    const dongleUrl = `/modules/${MODULE_ID}/font/Dongle-Regular.ttf`;
    const dongleData = await feFetchAsDataURL(dongleUrl);
    if (dongleData) {
      faces.push(
        `@font-face{font-family:"FE Dongle Embedded";src:url(${dongleData}) format("truetype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:swap;}`
      );
    }
  } catch {}

  if (!faces.length) return "";

  return `
/* female_edition: embedded CookieRun fonts (offline HTML export) */
${faces.join("\n")}

/* Prefer the embedded faces when opening the saved HTML as file://
 * (remote font files are often blocked by CORS because the origin becomes "null").
 */
:root {
  --fe-symbol-fallback:
    "Segoe UI Symbol",
    "Segoe UI Emoji",
    "Apple Color Emoji",
    "Noto Color Emoji";

  --fe-font-primary:
    "FE CookieRun Embedded",
    "FE CookieRun",
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  /* Light stack for small text / chat-card descriptions */
  --fe-font-light:
    "FE Dongle Embedded",
    "FE Dongle",
    "FE CookieRun Embedded",
    "FE CookieRun",
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  --font-primary: var(--fe-font-primary);
  --font-sans: var(--fe-font-primary);
  --font-serif: var(--fe-font-primary);

  /* dnd5e v5.2.x font vars (best-effort) */
  --dnd5e-font-roboto: var(--fe-font-primary);
  --dnd5e-font-roboto-slab: var(--fe-font-primary);
  --dnd5e-font-signika: var(--fe-font-primary);
  --dnd5e-font-modesto: var(--fe-font-primary);
}

/* Ensure the archive itself uses the embedded stack even when external CSS is partially blocked. */
#fe-chat-export-container,
#fe-chat-export-container :is(
  .chat-message,
  .message-header,
  .message-content,
  .flavor-text,
  .chat-card,
  .midi-chat-card,
  .dnd5e2.chat-card
) {
  font-family: var(--fe-font-primary) !important;
}
`;
}

async function feFetchAsDataURL(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await feBlobToDataURL(blob);
  } catch {
    return null;
  }
}

function feBlobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err);
    }
  });
}

async function feEmbedImagesInNode(root, { meta } = {}) {
  const setMeta = typeof meta === "function" ? meta : () => {};

  const imgs = Array.from(root.querySelectorAll("img"));
  if (!imgs.length) return;

  // Hard safety limits:
  // Single-file HTML + embedded images can easily crash Chromium/Electron (STATUS_BREAKPOINT / OOM)
  // due to base64 expansion + JS string memory overhead.
  const MAX_IMAGES = 160;
  const MAX_TOTAL_BYTES = 12_000_000; // ~12MB (binary) before base64/string expansion
  const MAX_PER_IMAGE = 800_000;      // ~0.8MB per image

  const cache = new Map();
  let embeddedCount = 0;
  let embeddedBytes = 0;

  let i = 0;
  for (const img of imgs) {
    i++;
    const src = img.getAttribute("src") || img.src;
    if (!src || src.startsWith("data:")) continue;

    // Stop when reaching limits
    if (embeddedCount >= MAX_IMAGES || embeddedBytes >= MAX_TOTAL_BYTES) {
      setMeta(
        `Embedding images… stopped (limit reached: ${embeddedCount} images, ${(
          embeddedBytes /
          1024 /
          1024
        ).toFixed(1)}MB)`
      );
      break;
    }

    // Resolve URL
    let abs;
    try {
      abs = new URL(src, window.location.href).href;
    } catch {
      continue;
    }

    // Only embed same-origin resources (avoid CORS failures).
    try {
      const u = new URL(abs);
      if (u.origin !== window.location.origin) continue;
    } catch {
      continue;
    }

    if (cache.has(abs)) {
      img.setAttribute("src", cache.get(abs));
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      continue;
    }

    setMeta(`Embedding images… ${embeddedCount}/${MAX_IMAGES} (scanning ${i}/${imgs.length})`);

    try {
      const res = await fetch(abs, { credentials: "include" });
      if (!res.ok) continue;
      const blob = await res.blob();

      // Per-image limit
      if (blob.size > MAX_PER_IMAGE) continue;

      // Total limit
      if (embeddedBytes + blob.size > MAX_TOTAL_BYTES) continue;

      const dataUrl = await feBlobToDataURL(blob);
      cache.set(abs, dataUrl);

      img.setAttribute("src", dataUrl);
      img.removeAttribute("srcset");
      img.removeAttribute("loading");

      embeddedCount++;
      embeddedBytes += blob.size;
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed image", abs, err);
    }

    // Yield periodically so Chromium doesn't freeze.
    if (i % 10 === 0) await feNextTick();
  }
}

function feDownloadExportHTMLFromCurrentDocument() {
  try {
    const container = document.getElementById("fe-chat-export-container");
    if (!container) return;

    const docEl = document.documentElement;
    const html = "<!doctype html>\n" + docEl.outerHTML;

    const worldName = game.world?.title ?? game.world?.name ?? "chat-log";
    const safeName = String(worldName)
      .replaceAll(/[^a-zA-Z0-9\u3131-\uD79D\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || "chat-log";
    const filename = `Chat Log - ${safeName}.html`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("female_edition | failed to download export HTML", err);
  }
}

async function feMaybeYieldForUI() {
  // Background tabs/windows clamp timers; yielding there can look like the export "stopped".
  // Only yield when visible so we keep UI responsive without stalling in background.
  if (document.visibilityState !== "visible") return;
  await feNextTick();
}

function feApplyChatMergeInWindow(win) {
  // Apply merge classes (start/mid/end/divider) in the archive window.
  // This simplified version avoids computed-style syncing.
  try {
    const logEl =
      win.document.getElementById("chat-log") ||
      win.document.getElementById("fe-chat-export-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    // Mirror merge-related body classes.
    try {
      win.document.body.classList.toggle("fe-chat-merge", !!feSetting(S.MERGE_ENABLED));
      const style = String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
      win.document.body.classList.toggle("fe-merge-follow-hide", style === "hide");
      win.document.body.classList.toggle("fe-merge-follow-name", style === "name");
      win.document.body.classList.toggle("fe-merge-follow-portrait", style === "portrait");
    } catch {}

    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const showDivider = !!feSetting(S.MERGE_DIVIDER);

    const els = Array.from(logEl.querySelectorAll("li.chat-message"));
    for (const el of els) {
      el.classList.remove("fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-divider-before");
    }

    const infos = els
      .map((el) => {
        const id = el.dataset?.messageId;
        const msg = id ? game.messages?.get(id) : null;
        const info = feMessageMergeInfo(msg, el);
        return {
          el,
          ...info,
          key: feMergeKey(info),
        };
      })
      .filter((x) => x && x.el);

    const canMerge = (a, b) => {
      if (!a || !b) return false;
      if (a.key !== b.key) return false;
      if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
      return true;
    };

    const applyGroup = (start, endExclusive) => {
      const group = infos.slice(start, endExclusive);
      if (!group.length) return;
      if (showDivider && start > 0) group[0].el.classList.add("fe-divider-before");
      if (group.length === 1) return;
      group[0].el.classList.add("fe-merge-start");
      for (let i = 1; i < group.length - 1; i++) group[i].el.classList.add("fe-merge-mid");
      group[group.length - 1].el.classList.add("fe-merge-end");
    };

    let groupStart = 0;
    for (let i = 1; i < infos.length; i++) {
      if (!canMerge(infos[i - 1], infos[i])) {
        applyGroup(groupStart, i);
        groupStart = i;
      }
    }
    applyGroup(groupStart, infos.length);
  } catch (err) {
    console.warn("female_edition | feApplyChatMergeInWindow failed", err);
  }
}

function feCanUserSeeChatMessage(msg, user) {
  try {
    if (!msg) return false;

    // If Foundry provides a boolean visibility flag, prefer it.
    if (typeof msg.visible === "boolean") return msg.visible;

    // Whispers: visible to GM and recipients (and the author).
    const whisper = msg.whisper ?? [];
    if (Array.isArray(whisper) && whisper.length) {
      if (user?.isGM) return true;
      if (whisper.includes(user?.id)) return true;
      if (msg.author?.id === user?.id) return true;
      return false;
    }

    // Hidden messages are still visible to GMs.
    if (msg.hidden && !user?.isGM) return false;

    return true;
  } catch {
    return true;
  }
}

function feNormalizeExportNode(rootEl) {
  try {
    // Normalize image URLs to absolute so print reliably loads them
    for (const img of rootEl.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src) continue;
      try {
        img.src = new URL(src, window.location.href).href;
      } catch {}
      // Ensure intrinsic size isn't lost in print layout
      if (!img.getAttribute("loading")) img.setAttribute("loading", "eager");
      if (!img.getAttribute("decoding")) img.setAttribute("decoding", "sync");
    }

    // Normalize anchor URLs too
    for (const a of rootEl.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      try {
        a.href = new URL(href, window.location.href).href;
      } catch {}
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    }
  } catch {}
}

function feNextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feWaitForImages(rootEl, timeoutMs = 10000) {
  try {
    const imgs = Array.from(rootEl.querySelectorAll("img")).filter((img) => {
      const src = img.getAttribute("src");
      return !!src;
    });

    if (!imgs.length) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve();
      }, timeoutMs);

      let remaining = imgs.length;
      const onOne = () => {
        remaining--;
        if (remaining > 0) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };

      for (const img of imgs) {
        if (img.complete && img.naturalWidth > 0) {
          onOne();
          continue;
        }
        img.addEventListener("load", onOne, { once: true });
        img.addEventListener("error", onOne, { once: true });
      }
    });
  } catch {
    return Promise.resolve();
  }
}




function feGetChatMessageElementOrder(el, fallback) {
  const raw = el.dataset.order ?? el.style.order;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function feMessageMergeInfo(msg, el) {
  // NOTE: v13+: ChatMessage#user is deprecated -> use ChatMessage#author
  const authorId = msg?.author?.id ?? "";

  const speaker = msg?.speaker ?? {};
  const speakerKey = [
    speaker.scene ?? "",
    speaker.token ?? "",
    speaker.actor ?? "",
    speaker.alias ?? ""
  ].join("|");

  // Whisper recipients (if any)
  const whisper = Array.isArray(msg?.whisper) ? msg.whisper : [];
  const whisperKey = whisper.length ? whisper.slice().sort().join(",") : "";

  const blind = !!msg?.blind;
  const rollMode = msg?.rollMode ?? "";

  // ChatMessage#style exists in v13+ (ChatMessage#type was renamed)
  const style = msg?.style ?? msg?.type ?? null;

  // Rolls are defined in ChatMessage#rolls in v13+
  const hasRolls = Array.isArray(msg?.rolls) && msg.rolls.length > 0;

  const content = String(msg?.content ?? "");
  const hasChatCard = /class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b)[^"']*["']/.test(content);
  const hasDice = /class=["'][^"']*(?:\bdice-roll\b|\bdice-result\b)[^"']*["']/.test(content);

  // "Merge only text" should merge plain text lines, but avoid merging item cards / dice rolls.
  const mergeableText = !hasRolls && !hasChatCard && !hasDice;

  return {
    authorId,
    speakerKey,
    whisperKey,
    blind,
    rollMode,
    style,
    mergeableText
  };
}




function feGetChatLogs() {
  // Sidebar + any chat popouts
  const logs = new Set();
  document.querySelectorAll("ol.chat-log, #chat-log").forEach((el) => {
    if (el instanceof HTMLElement) logs.add(el);
  });
  return Array.from(logs);
}

function feMergeKey(info) {
  // Key that defines whether two messages may be merged.
  // Include style + rollMode + whisper visibility so we don't merge across contexts.
  const author = info?.authorId ?? "";
  const speaker = info?.speakerKey ?? "";
  const whisper = info?.whisperKey ?? "";
  const blind = info?.blind ? "1" : "0";
  const rollMode = info?.rollMode ?? "";
  const style = info?.style ?? "";
  return [author, speaker, whisper, blind, rollMode, style].join("||");
}



function feSyncMergedGroupBackground(group) {
  try {
    if (!Array.isArray(group) || group.length < 2) return;
    // Prefer the most recent message in the group as the reference.
    // Some web environments apply slightly different background stacks to
    // earlier-rendered messages; syncing to the newest reduces mismatches.
    const refEl = group?.[group.length - 1]?.el ?? group?.[0]?.el;
    if (!refEl) return;

    const cs = window.getComputedStyle(refEl);
    const bg = {
      color: cs.backgroundColor,
      image: cs.backgroundImage,
      blend: cs.backgroundBlendMode,
      repeat: cs.backgroundRepeat,
      size: cs.backgroundSize,
      position: cs.backgroundPosition,
      attachment: cs.backgroundAttachment,
      origin: cs.backgroundOrigin,
      clip: cs.backgroundClip,
    };

    for (let i = 0; i < group.length; i++) {
      const el = group?.[i]?.el;
      if (!el || el === refEl) continue;
      el.style.backgroundColor = bg.color;
      el.style.backgroundImage = bg.image;
      el.style.backgroundBlendMode = bg.blend;
      el.style.backgroundRepeat = bg.repeat;
      el.style.backgroundSize = bg.size;
      el.style.backgroundPosition = bg.position;
      el.style.backgroundAttachment = bg.attachment;
      el.style.backgroundOrigin = bg.origin;
      el.style.backgroundClip = bg.clip;
    }
  } catch (e) {
    console.warn("[female_edition] merge background sync failed", e);
  }
}

function feNormalizeKeyBackgrounds(infos) {
  try {
    if (!Array.isArray(infos) || infos.length < 2) return;

    const hasBgStyling = (el, cs) => {
      const styleAttr = el?.getAttribute?.("style") ?? "";
      if (/background/i.test(styleAttr)) return true;
      if (!cs) return false;
      return cs.backgroundBlendMode !== "normal" || cs.backgroundImage !== "none";
    };

    const extract = (cs) => ({
      color: cs.backgroundColor,
      image: cs.backgroundImage,
      blend: cs.backgroundBlendMode,
      repeat: cs.backgroundRepeat,
      size: cs.backgroundSize,
      position: cs.backgroundPosition,
      attachment: cs.backgroundAttachment,
      origin: cs.backgroundOrigin,
      clip: cs.backgroundClip,
    });

    const apply = (el, bg) => {
      el.style.backgroundColor = bg.color;
      el.style.backgroundImage = bg.image;
      el.style.backgroundBlendMode = bg.blend;
      el.style.backgroundRepeat = bg.repeat;
      el.style.backgroundSize = bg.size;
      el.style.backgroundPosition = bg.position;
      el.style.backgroundAttachment = bg.attachment;
      el.style.backgroundOrigin = bg.origin;
      el.style.backgroundClip = bg.clip;
    };

    // Use the most recent message (DOM-bottom) as the reference for a key.
    const ref = new Map();
    for (let i = infos.length - 1; i >= 0; i--) {
      const info = infos[i];
      const el = info?.el;
      const key = info?.key;
      if (!el || !key) continue;

      const cs = window.getComputedStyle(el);
      if (!hasBgStyling(el, cs)) continue;

      if (!ref.has(key)) {
        ref.set(key, extract(cs));
        continue;
      }

      const bg = ref.get(key);
      if (!bg) continue;

      // Only apply if a visible mismatch is likely.
      if (
        cs.backgroundColor !== bg.color ||
        cs.backgroundImage !== bg.image ||
        cs.backgroundBlendMode !== bg.blend
      ) {
        apply(el, bg);
      }
    }
  } catch (e) {
    console.warn("[female_edition] key background normalization failed", e);
  }
}


function feApplyChatMerge(logEl) {
  if (!(logEl instanceof HTMLElement)) return;

  // Always clear previous merge classes first (so disabling the feature restores normal view).
  const msgs = Array.from(logEl.querySelectorAll("li.chat-message"));
  for (const el of msgs) {
    el.classList.remove(
      "fe-merge-start",
      "fe-merge-mid",
      "fe-merge-end",
      "fe-divider-before"
    );
  }

  if (!feSetting(S.MERGE_ENABLED)) return;

  const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
  const showDivider = !!feSetting(S.MERGE_DIVIDER);

  // Collect message infos
  const infos = msgs
    .map((el, idx) => {
      const id = el.dataset?.messageId;
      const msg = id ? game.messages?.get(id) : null;
      const info = feMessageMergeInfo(msg, el);
      return {
        ...info,
        el,
        idx,
        order: feGetChatMessageElementOrder(el, idx)
      };
    })
    .filter((x) => x && x.el);

  // Sort by visual order (Foundry sometimes uses fractional data-order)
  infos.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Precompute merge keys
  for (const info of infos) info.key = feMergeKey(info);

  const canMerge = (a, b) => {
    if (!a || !b) return false;
    if (a.key !== b.key) return false;
    if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
    return true;
  };

  const applyGroup = (startIndex, endIndexExclusive) => {
    const group = infos.slice(startIndex, endIndexExclusive);
    const groupLen = group.length;

    if (groupLen <= 0) return;

    // Divider at group boundary (except first group)
    if (showDivider && startIndex > 0) {
      group[0].el.classList.add("fe-divider-before");
    }

    // Do not apply "follow" classes for single messages (prevents accidental header hiding).
    if (groupLen === 1) return;

    group[0].el.classList.add("fe-merge-start");
    for (let i = 1; i < groupLen - 1; i++) group[i].el.classList.add("fe-merge-mid");
    group[groupLen - 1].el.classList.add("fe-merge-end");


    // Chrome/Web parity: enforce identical background for merged messages
    feSyncMergedGroupBackground(group);
  };

  let groupStart = 0;
  for (let i = 1; i < infos.length; i++) {
    if (!canMerge(infos[i - 1], infos[i])) {
      applyGroup(groupStart, i);
      groupStart = i;
    }
  }
  applyGroup(groupStart, infos.length);

  // Web(Chrome) parity: some modules end up applying slightly different
  // background stacks to messages rendered at different times. Normalise per
  // merge-key using the most recent message as the reference.
  feNormalizeKeyBackgrounds(infos);
}


function feApplyChatMergeToAllLogs() {
  for (const log of feGetChatLogs()) {
    feApplyChatMerge(log);
  }
}


let feChatLogObserver = null;

function feObserveChatLogs() {
  if (feChatLogObserver) return;

  feChatLogObserver = new MutationObserver((_mutations) => {
    // Throttle merge re-application
    if (feChatLogObserver._scheduled) return;
    feChatLogObserver._scheduled = true;
    requestAnimationFrame(() => {
      feChatLogObserver._scheduled = false;
      feApplyChatMergeToAllLogs();
      feInjectExportButtonsAll();
      feRenderTypingIndicator();
    });
  });

  // Observe #sidebar (chat can rerender) to rebind on changes
  const sidebar = document.getElementById("sidebar");
  if (sidebar) feChatLogObserver.observe(sidebar, { childList: true, subtree: true });

  // Initial
  feApplyChatMergeToAllLogs();
  feInjectExportButtonsAll();
  feSetupTypingIndicator();
}
