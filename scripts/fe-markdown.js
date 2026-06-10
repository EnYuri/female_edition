import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";

function feEscapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Allow only safe link schemes for markdown `[label](url)` anchors. A bare
// `javascript:`/`data:`/`vbscript:` href turns a chat link into a script-execution
// vector the moment another user clicks it. Relative/anchor/protocol-relative URLs
// (no scheme) and http(s)/mailto are allowed; anything else returns null → rendered
// as plain text instead of an anchor.
function feSafeMarkdownUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) return null;
  const scheme = u.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (scheme && !/^(?:https?|mailto)$/i.test(scheme[1])) return null;
  return u;
}

function feInlineFormat(text) {
  const codeSpans = [];
  text = text.replace(/`([^`]+)`/g, (_m, code) => {
    const idx = codeSpans.push(code) - 1;
    return `FECODE${idx}`;
  });

  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, url) => {
    alt = feEscapeHTML(alt ?? "");
    url = feEscapeHTML(url ?? "");
    return `<img src="${url}" alt="${alt}">`;
  });

  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) => {
    const safeLabel = feEscapeHTML(label ?? "");
    const safeUrl = feSafeMarkdownUrl(url);
    // Unsafe scheme (javascript:/data:/…) → drop the anchor, render label as text.
    if (!safeUrl) return safeLabel;
    return `<a href="${feEscapeHTML(safeUrl)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
  });

  text = text.replace(/~~(.+?)~~/gs, "<s>$1</s>");
  text = text.replace(/\*\*\*(.+?)\*\*\*/gs, "<strong><em>$1</em></strong>");
  text = text.replace(/___(.+?)___/gs, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>");
  text = text.replace(/__(.+?)__/gs, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/gm, "$1<em>$2</em>");
  text = text.replace(/(^|[^_])_([^_\n]+?)_(?!_)/gm, "$1<em>$2</em>");

  for (let i = 0; i < codeSpans.length; i++) {
    const safe = feEscapeHTML(codeSpans[i]);
    text = text.replaceAll(`FECODE${i}`, `<code>${safe}</code>`);
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

    if (!line.trim()) { i++; continue; }

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length && lines[i].trim().startsWith("```")) i++;
      const code = feEscapeHTML(codeLines.join("\n"));
      const safeLang = lang ? lang.trim().replace(/[^a-zA-Z0-9_-]/g, "") : "";
      const langClass = safeLang ? ` class="language-${safeLang}"` : "";
      blocks.push(`<pre><code${langClass}>${code}</code></pre>`);
      continue;
    }

    const mHeading = line.match(/^(#{1,6})\s+(.*)$/);
    if (mHeading) {
      const level = Math.min(6, mHeading[1].length);
      const text = feInlineFormat(feEscapeHTML(mHeading[2] ?? ""));
      blocks.push(`<h${level}>${text}</h${level}>`);
      i++; continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push("<hr>"); i++; continue;
    }

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

    const mUList = line.match(/^\s*([-*])\s+(.*)$/);
    if (mUList) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*([-*])\s+(.*)$/);
        if (!m) break;
        items.push(m[2]); i++;
      }
      const lis = items.map((it) => `<li>${feInlineFormat(feEscapeHTML(it ?? ""))}</li>`).join("");
      blocks.push(`<ul>${lis}</ul>`);
      continue;
    }

    const mOList = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (mOList) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\s*(\d+)\.\s+(.*)$/);
        if (!m) break;
        items.push(m[2]); i++;
      }
      const lis = items.map((it) => `<li>${feInlineFormat(feEscapeHTML(it ?? ""))}</li>`).join("");
      blocks.push(`<ol>${lis}</ol>`);
      continue;
    }

    const para = [];
    while (i < lines.length && lines[i].trim()) {
      if (lines[i].trim().startsWith("```")) break;
      if (/^(#{1,6})\s+/.test(lines[i])) break;
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) break;
      if (lines[i].trim().startsWith(">")) break;
      if (/^\s*[-*]\s+/.test(lines[i])) break;
      if (/^\s*\d+\.\s+/.test(lines[i])) break;
      para.push(lines[i]); i++;
    }
    pushParagraph(para);
  }

  return blocks.join("");
}

function feLooksLikeHTML(text) {
  return /<\s*[a-zA-Z][\s\S]*?>/.test(text);
}

// v14: ProseMirror chat input wraps all text in <p>…</p> before firing
// preCreateChatMessage. If the content is ONLY <p>/<br> (no real HTML elements),
// extract the plain text so markdown can still be applied.
// Returns the unwrapped plain text, or null if the HTML contains real elements.
function feUnwrapProseMirrorHTML(html) {
  const trimmed = html.trim();
  if (!trimmed.startsWith("<p>")) return null;
  // Reject if any tag other than <p>, </p>, <br>, <br/> exists
  if (/<(?!\/?p>|br\s*\/?>)[a-zA-Z]/.test(trimmed)) return null;

  let text = trimmed
    .replace(/<\/p>\s*<p>/g, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?p>/g, "");

  // Decode HTML entities the ProseMirror serializer may have encoded
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#039;/g, "'");

  return text.trim() || null;
}

// Theatre Inserts (module id "theatre") aborts its stage textbox animation in
// `createChatMessage` when message content starts with "<" or contains a <div>
// block. If we convert plain text to <p>...</p> during preCreateChatMessage
// while the user is speaking-as a stage character, Theatre treats the message
// as pre-formatted HTML and the stage animation never plays. Detect that case
// and let Theatre handle the message untouched.
function feIsTheatreStageMessageForCurrentUser() {
  try {
    if (!game.modules?.get?.("theatre")?.active) return false;
    const T = globalThis.Theatre?.instance;
    if (!T) return false;
    const uid = game.user?.id;
    if (!uid) return false;
    return !!(T.speakingAs && T.usersTyping?.[uid]?.theatreId);
  } catch {
    return false;
  }
}

function feApplyMarkdownOnPreCreate(message, data = {}, userId = null) {
  try {
    if (!feSetting(S.MARKDOWN_ENABLED)) return false;
    if (userId !== game.user.id) return false;
    if (feIsTheatreStageMessageForCurrentUser()) return false;

    let content = String(data?.content ?? message?.content ?? "");
    let trimmed = content.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("/")) return false;

    // v14: ProseMirror wraps all chat input in <p>…</p>.
    // Unwrap pure paragraph output so markdown still fires.
    // Real HTML (macros, system cards, etc.) is left untouched.
    if (feLooksLikeHTML(trimmed)) {
      const plain = feUnwrapProseMirrorHTML(trimmed);
      if (plain === null) return false;
      content = plain;
      trimmed = content.trim();
      if (!trimmed || trimmed.startsWith("/")) return false;
    }

    try {
      const hasRolls =
        (Array.isArray(data?.rolls) && data.rolls.length > 0) ||
        (Array.isArray(message?.rolls) && message.rolls.length > 0);
      if (hasRolls) return false;
    } catch (_e) {
      /* noop */
    }

    const html = feMarkdownToHTML(content);

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

export {
  feEscapeHTML,
  feInlineFormat,
  feMarkdownToHTML,
  feLooksLikeHTML,
  feUnwrapProseMirrorHTML,
  feIsTheatreStageMessageForCurrentUser,
  feApplyMarkdownOnPreCreate,
};
