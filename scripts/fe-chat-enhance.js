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
  feSetBodyMergeClasses();
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
  Hooks.on("preCreateChatMessage", async (message, data, _options, userId) => {
    if (!feSetting(S.MARKDOWN_ENABLED)) return;
    if (userId !== game.user.id) return;

    const content = (data?.content ?? message.content ?? "").toString();
    const trimmed = content.trim();
    if (!trimmed) return;

    // Slash commands / roll commands should be handled by Foundry
    if (trimmed.startsWith("/")) return;

    // If message already HTML (chat cards, system messages, etc.), don't touch it.
    if (feLooksLikeHTML(content)) return;

    // Convert markdown -> HTML -> enrich (rolls, UUID links, etc.)
    const html = feMarkdownToHTML(content);
    const te = feGetTextEditor();
    const enriched = te?.enrichHTML ? await te.enrichHTML(html, {
      async: true,
      secrets: false,
      documents: true,
      links: true,
      rolls: true,
    }) : html;

    // Store the raw text for later edits
    const flags = foundry.utils.deepClone(data?.flags ?? message.flags ?? {});
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      raw: content,
      markdown: true,
    });

    message.updateSource({ content: enriched, flags });
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
        const el = feToElement(html);
        feEnsureMessageEditControl(message, el);
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
  a.dataset.tooltip = "채팅 로그 PDF(인쇄)";
  a.ariaLabel = "채팅 로그 PDF(인쇄)";
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
      <a class="fe-chat-export-close" aria-label="Close">✕</a>
    </div>
    <ol id="fe-chat-export-log" class="chat-log"></ol>
  `;

  document.body.appendChild(container);

  const close = container.querySelector(".fe-chat-export-close");
  if (close) {
    close.addEventListener("click", (ev) => {
      ev.preventDefault();
      try {
        container.remove();
      } catch {}
      document.body.classList.remove("fe-print-chatlog");
    });
  }

  return container;
}

async function feExportChatLogToPDF() {
  if (document.body.classList.contains("fe-print-chatlog")) return;

  // Foundry runs the app in a fixed viewport with overflow hidden.
  // Chromium printing will otherwise only capture the first visible page.
  const htmlEl = document.documentElement;
  const prevHtmlOverflow = htmlEl.style.overflow;
  const prevHtmlHeight = htmlEl.style.height;
  const prevBodyOverflow = document.body.style.overflow;
  const prevBodyHeight = document.body.style.height;

  document.body.classList.add("fe-print-chatlog");

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

      // Yield occasionally to keep UI responsive
      if (i % 25 === 0) await feNextTick();
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

    // Give the browser time to reflow before printing.
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));

    metaEl.textContent = "Opening print dialog…";

    // Cleanup after printing; keep a close button as a fallback.
    const cleanup = () => {
      try {
        container.remove();
      } catch {}
      document.body.classList.remove("fe-print-chatlog");

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
      }
    }, 0);
  } catch (err) {
    console.error(err);
    ui.notifications?.error("Chat log PDF export failed. Check the console for details.");
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
