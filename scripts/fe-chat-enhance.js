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
    const enriched = await TextEditor.enrichHTML(html, {
      async: true,
      secrets: false,
      documents: true,
      links: true,
      rolls: true,
    });

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
// Edit existing messages
// -------------------------------------

function feCanEditMessage(msg) {
  try {
    return msg?.canUserModify?.(game.user, "update") ?? false;
  } catch (_e) {
    // Fallback
    return game.user.isGM || msg?.author?.id === game.user.id;
  }
}

function feGetEditableRaw(msg) {
  const flagged = msg?.getFlag?.(MODULE_ID, "raw");
  if (typeof flagged === "string") return flagged;

  // Fallback: try to convert HTML -> text
  const div = document.createElement("div");
  div.innerHTML = msg?.content ?? "";
  // preserve line breaks
  div.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  return (div.textContent ?? "").trim();
}

async function feUpdateMessageFromRaw(msg, rawText) {
  const trimmed = String(rawText ?? "").trim();

  // Empty => keep but clear content
  if (!trimmed) {
    await msg.update({ content: "" });
    await msg.setFlag(MODULE_ID, "raw", "");
    await msg.setFlag(MODULE_ID, "markdown", true);
    return;
  }

  let html = feSetting(S.MARKDOWN_ENABLED) ? feMarkdownToHTML(rawText) : feEscapeHTML(rawText).replaceAll("\n", "<br>");
  html = await TextEditor.enrichHTML(html, {
    async: true,
    secrets: false,
    documents: true,
    links: true,
    rolls: true,
  });

  await msg.update({ content: html });
  await msg.setFlag(MODULE_ID, "raw", rawText);
  await msg.setFlag(MODULE_ID, "markdown", !!feSetting(S.MARKDOWN_ENABLED));
}

function feOpenEditDialog(msg) {
  const raw = feGetEditableRaw(msg);
  const safe = feEscapeHTML(raw);

  const content = `
    <form class="fe-chat-edit-form">
      <div class="form-group">
        <label>메시지 내용</label>
        <textarea name="content" rows="10" style="width:100%; resize: vertical;">${safe}</textarea>
        <p class="notes">저장 시 현재 설정에 따라 마크다운을 적용합니다.</p>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    new Dialog({
      title: "채팅 메시지 수정",
      content,
      buttons: {
        save: {
          icon: '<i class="fa-solid fa-check"></i>',
          label: "저장",
          callback: async (html) => {
            const ta = html.querySelector('textarea[name="content"]');
            const value = ta?.value ?? "";
            await feUpdateMessageFromRaw(msg, value);
            resolve(true);
          },
        },
        cancel: {
          icon: '<i class="fa-solid fa-xmark"></i>',
          label: "취소",
          callback: () => resolve(false),
        },
      },
      default: "save",
    }).render(true);
  });
}

function feInstallEditHandlers() {
  Hooks.on("renderChatMessageHTML", (msg, html) => {
    if (!feSetting(S.EDIT_ENABLED)) return;
    if (!feCanEditMessage(msg)) return;

    const el = html instanceof HTMLElement ? html : html?.[0];
    if (!el) return;

    // Existing edit button
    const btn = el.querySelector(".message-edit");
    if (btn && !btn.dataset.feBound) {
      btn.dataset.feBound = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        await feOpenEditDialog(msg);
      });
    }

    // Optional: alt-doubleclick on message content
    if (!el.dataset.feDblBound) {
      el.dataset.feDblBound = "1";
      el.addEventListener("dblclick", async (ev) => {
        if (!ev.altKey) return;
        if (!feCanEditMessage(msg)) return;
        await feOpenEditDialog(msg);
      });
    }
  });
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
    root.querySelector("#sidebar #chat .chat-controls");

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

async function feExportChatLogToPDF() {
  // Build export container
  const containerId = "fe-chat-export-container";
  let container = document.getElementById(containerId);
  if (container) container.remove();

  container = document.createElement("div");
  container.id = containerId;

  const title = document.createElement("h1");
  title.textContent = `${game.world?.title ?? "Chat Log"} — ${new Date().toLocaleString()}`;
  container.appendChild(title);

  const ol = document.createElement("ol");
  ol.className = "chat-log";
  container.appendChild(ol);

  document.body.appendChild(container);
  document.body.classList.add("fe-exporting-chat");

  // Render messages
  const msgs = (game.messages?.contents ?? []).slice().sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const msg of msgs) {
    try {
      const li = await msg.renderHTML();
      // Remove per-message controls from print
      li.querySelectorAll(".message-actions, .message-delete, .message-edit").forEach((n) => n.remove());
      ol.appendChild(li);
    } catch (err) {
      console.warn(`[${MODULE_ID}] failed to render message for export`, err);
    }
  }

  // Apply merge styling to the export log as well
  feApplyChatMerge(ol);

  // Ensure images are loaded before printing (best-effort)
  const imgs = [...container.querySelectorAll("img")];
  await Promise.all(
    imgs.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => (img.onload = img.onerror = () => r()))))
  );

  const cleanup = () => {
    document.body.classList.remove("fe-exporting-chat");
    container.remove();
  };

  window.addEventListener("afterprint", cleanup, { once: true });

  // Some environments don't fire afterprint reliably; fallback
  setTimeout(() => {
    if (document.body.classList.contains("fe-exporting-chat")) cleanup();
  }, 20000);

  window.print();
}

// -------------------------------------
// Chat merge (visual)
// -------------------------------------

function feGetChatLogs() {
  return Array.from(document.querySelectorAll(":is(#chat-log, .chat-log, ol.chat-log)")).filter((el) => el instanceof HTMLElement);
}

function feGetChatMessageElementOrder(el, fallback) {
  const raw = el.dataset.order ?? el.style.order;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function feMessageMergeInfo(msg) {
  const authorId = msg?.author?.id ?? msg?.user?.id ?? "";
  const speaker = msg?.speaker ?? {};
  const speakerKey = JSON.stringify({
    scene: speaker.scene ?? null,
    token: speaker.token ?? null,
    actor: speaker.actor ?? null,
    alias: speaker.alias ?? "",
  });

  const style = msg?.style ?? msg?.type ?? null;

  const whisper = Array.isArray(msg?.whisper) ? msg.whisper.slice() : [];
  whisper.sort();
  const whisperKey = whisper.join(",");

  const blind = !!msg?.blind;
  const rollMode = msg?.rollMode ?? null;

  const content = String(msg?.content ?? "");
  const hasRolls = Array.isArray(msg?.rolls) && msg.rolls.length > 0;
  const hasDiceMarkup = /class="dice-roll\b/.test(content) || /data-action="expandRoll"/.test(content);
  const hasChatCard = /class="chat-card\b/.test(content) || /class="midi-chat-card\b/.test(content);

  const mergeableText = !(hasRolls || hasDiceMarkup || hasChatCard);

  return {
    authorId,
    speakerKey,
    style,
    whisperKey,
    blind,
    rollMode,
    mergeableText,
  };
}

function feMergeKey(info) {
  return `${info.authorId}|${info.speakerKey}|${info.style}|${info.whisperKey}|${info.blind}|${info.rollMode}`;
}

function feApplyChatMerge(logEl) {
  if (!feSetting(S.MERGE_ENABLED)) return;
  if (!(logEl instanceof HTMLElement)) return;

  const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
  const showDivider = !!feSetting(S.MERGE_DIVIDER);

  // Collect + sort by visual order
  const entries = Array.from(logEl.querySelectorAll("li.chat-message"))
    .map((el, idx) => ({ el, order: feGetChatMessageElementOrder(el, idx) }))
    .sort((a, b) => a.order - b.order);

  const infos = entries.map(({ el }) => {
    const id = el.dataset.messageId || el.getAttribute("data-message-id") || "";
    const msg = id ? game.messages.get(id) : null;
    const info = msg ? feMessageMergeInfo(msg) : null;
    return { el, msg, info, id };
  });

  // Clear old classes
  for (const it of infos) {
    it.el.classList.remove(
      "fe-merge-start",
      "fe-merge-mid",
      "fe-merge-end",
      "fe-merge-single",
      "fe-divider-before",
      "fe-msg-plain"
    );
  }

  const canMerge = (a, b) => {
    if (!a?.info || !b?.info) return false;
    if (onlyText && (!a.info.mergeableText || !b.info.mergeableText)) return false;
    return feMergeKey(a.info) === feMergeKey(b.info);
  };

  for (let i = 0; i < infos.length; i++) {
    const cur = infos[i];
    const prev = infos[i - 1];
    const next = infos[i + 1];

    const mergePrev = i > 0 && canMerge(prev, cur);
    const mergeNext = i < infos.length - 1 && canMerge(cur, next);

    if (cur.info?.mergeableText) cur.el.classList.add("fe-msg-plain");

    if (mergePrev || mergeNext) {
      if (!mergePrev && mergeNext) cur.el.classList.add("fe-merge-start");
      else if (mergePrev && mergeNext) cur.el.classList.add("fe-merge-mid");
      else if (mergePrev && !mergeNext) cur.el.classList.add("fe-merge-end");
    } else {
      cur.el.classList.add("fe-merge-single");
    }

    // Divider before new group
    if (showDivider && i > 0 && !mergePrev) {
      cur.el.classList.add("fe-divider-before");
    }
  }
}

function feApplyChatMergeToAllLogs() {
  for (const log of feGetChatLogs()) feApplyChatMerge(log);
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
