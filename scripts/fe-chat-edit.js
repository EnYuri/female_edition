// Message editing feature (split)
// Provides inline edit and chat context menu option.

import {
  MODULE_ID,
  S,
  feSetting,
  feMarkdownToHTML,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feGetChatLogs,
  feNormalizeChatMessageId,
  feGetMessageIdFromElement,
} from "./fe-chat-enhance.js";

function feEnsureMessageEditControl(message, messageEl) {
  if (!(messageEl instanceof HTMLElement)) return;
  if (!message || !feCanEditMessage(message)) return;

  // Always remove the header delete icon to prevent overlap with the ellipsis.
  feRemoveMessageDeleteControl(messageEl);

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
  const doc = messageEl?.ownerDocument ?? document;
  const a = doc.createElement("a");
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
// Edit existing messages (v13-safe)
// Inspired by mrkb-fvtt-modules/fvtt-chat-enhancements (chatEditor.mjs)
// -------------------------------------

let FE_EDITING_MESSAGE_ID = null;
// "markdown" | "html"
let FE_EDIT_MODE = "markdown";

function feCanEditMessage(msg) {
  try {
    return !!msg?.canUserModify?.(game.user, "update");
  } catch {
    return false;
  }
}

function feGetEditableRaw(msg) {
  const stored = msg?.getFlag?.(MODULE_ID, "raw") ?? msg?.getFlag?.(MODULE_ID, "plain") ?? null;
  if (stored != null) return String(stored);

  // Fallback: strip HTML from rendered content using DOMParser so attribute values
  // containing ">" (e.g. data-x="1>2") are handled correctly by the browser parser,
  // unlike a naive <[^>]+> regex which would truncate at the first >.
  try {
    const html = String(msg?.content ?? "");
    if (!html) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Preserve paragraph / line-break structure as newlines.
    for (const br of doc.querySelectorAll("br")) br.replaceWith("\n");
    const parts = [];
    for (const p of doc.querySelectorAll("p")) {
      parts.push(p.textContent ?? "");
    }
    if (parts.length) return parts.join("\n").trim();
    return (doc.body?.textContent ?? "").trim();
  } catch {
    // Last-resort plain regex strip (cross-origin sandbox or test environment).
    return String(msg?.content ?? "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p>\s*<p>/gi, "\n")
      .replace(/<\/?p[^>]*>/gi, "")
      .replace(/<[^>]+>/g, "")
      .trim();
  }
}

// Session-persistent floating position (null until the user drags the panel).
let FE_EDITOR_POS = null;

function feEnsureInlineEditorUI() {
  let wrap = document.getElementById("fe-chat-inline-editor");
  if (wrap) return wrap;

  wrap = document.createElement("div");
  wrap.id = "fe-chat-inline-editor";
  wrap.className = "fe-chat-inline-editor";
  // A floating, draggable panel (appended to <body>, position: fixed) — no longer
  // glued above the chat form. The .fe-chat-inline-editor-frame inner wrapper carries
  // the retro-theme pixel-border decoration (::before/::after) so the outline can sit
  // OUTSIDE the panel content without clipping.
  wrap.innerHTML = `
    <div class="fe-chat-inline-editor-frame">
      <div class="fe-chat-inline-editor-header" data-fe-drag-handle>
        <span class="fe-edit-title"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i> 메시지 수정</span>
        <div class="fe-edit-mode-toggle">
          <button type="button" class="fe-edit-mode-btn active" data-mode="markdown">마크다운</button>
          <button type="button" class="fe-edit-mode-btn" data-mode="html">HTML</button>
        </div>
        <button type="button" class="fe-edit-close" aria-label="닫기"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
      </div>
      <div class="fe-chat-inline-editor-row">
        <textarea class="fe-chat-inline-editor-text" spellcheck="false" placeholder="메시지를 입력하세요…"></textarea>
      </div>
      <div class="fe-chat-inline-editor-actions">
        <span class="fe-edit-hint">Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소</span>
        <div class="fe-edit-action-btns">
          <button type="button" class="fe-chat-inline-editor-save">
            <i class="fa-solid fa-check"></i>
            <span>저장</span>
          </button>
          <button type="button" class="fe-chat-inline-editor-cancel">
            <i class="fa-solid fa-xmark"></i>
            <span>취소</span>
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  const btnSave = wrap.querySelector(".fe-chat-inline-editor-save");
  const btnCancel = wrap.querySelector(".fe-chat-inline-editor-cancel");
  const btnClose = wrap.querySelector(".fe-edit-close");

  btnSave.addEventListener("click", () => feCommitInlineEdit());
  btnCancel.addEventListener("click", () => feCancelInlineEdit());
  btnClose.addEventListener("click", () => feCancelInlineEdit());

  wrap.querySelectorAll(".fe-edit-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => feSetEditMode(wrap, btn.dataset.mode));
  });

  // Auto-grow the textarea like the sidebar chat input (within CSS min/max bounds).
  textarea.addEventListener("input", () => feAutoGrowEditorTextarea(textarea));

  textarea.addEventListener("keydown", (ev) => {
    // Enter => save (mirrors the sidebar chat input); Shift+Enter inserts a newline.
    // Ctrl/Cmd+Enter also saves (kept for muscle memory).
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      feCommitInlineEdit();
      return;
    }
    // Escape => cancel (stopPropagation: ESC가 Foundry 게임 메뉴로 버블링되지 않도록)
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      feCancelInlineEdit();
    }
  });

  feMakeEditorDraggable(wrap, wrap.querySelector("[data-fe-drag-handle]"));

  wrap.style.display = "none";
  return wrap;
}

// Grow the textarea to fit its content, clamped by CSS min/max-height.
function feAutoGrowEditorTextarea(textarea) {
  if (!textarea) return;
  try {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  } catch {}
}

// Drag the floating editor by its header. Position is stored in FE_EDITOR_POS so it
// survives mode toggles / re-opens within the session (resets on reload).
function feMakeEditorDraggable(wrap, handle) {
  if (!wrap || !handle) return;
  let dragging = false;
  let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;

  const onMove = (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const w = wrap.offsetWidth;
    const h = wrap.offsetHeight;
    // Keep the panel within the viewport (leave a small margin).
    const left = Math.min(Math.max(8, baseLeft + dx), window.innerWidth - w - 8);
    const top = Math.min(Math.max(8, baseTop + dy), window.innerHeight - h - 8);
    FE_EDITOR_POS = { left, top };
    wrap.style.left = `${left}px`;
    wrap.style.top = `${top}px`;
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
  };

  const onUp = () => {
    dragging = false;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    handle.classList.remove("fe-dragging");
  };

  handle.addEventListener("pointerdown", (ev) => {
    // Ignore drags that start on the toggle buttons / close button.
    if (ev.target.closest("button")) return;
    if (ev.button !== 0) return;
    dragging = true;
    const rect = wrap.getBoundingClientRect();
    startX = ev.clientX;
    startY = ev.clientY;
    baseLeft = rect.left;
    baseTop = rect.top;
    handle.classList.add("fe-dragging");
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    ev.preventDefault();
  });
}

// Place the panel: restore the dragged position, else anchor just above the chat form.
function fePositionInlineEditor(wrap) {
  if (!wrap) return;
  if (FE_EDITOR_POS) {
    wrap.style.left = `${FE_EDITOR_POS.left}px`;
    wrap.style.top = `${FE_EDITOR_POS.top}px`;
    wrap.style.right = "auto";
    wrap.style.bottom = "auto";
    return;
  }
  // Default: anchored to the bottom-right above the chat sidebar input.
  const chatForm =
    document.querySelector("#chat-form") ||
    document.querySelector("form.chat-form") ||
    document.querySelector("#chat-controls")?.closest("form") ||
    document.querySelector("#chat-message");
  try {
    const rect = chatForm?.getBoundingClientRect?.();
    if (rect && rect.width) {
      const w = wrap.offsetWidth || 420;
      const h = wrap.offsetHeight || 220;
      let left = rect.right - w;
      let top = rect.top - h - 10;
      left = Math.min(Math.max(8, left), window.innerWidth - w - 8);
      top = Math.min(Math.max(8, top), window.innerHeight - h - 8);
      wrap.style.left = `${left}px`;
      wrap.style.top = `${top}px`;
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
      return;
    }
  } catch {}
  // Last resort: bottom-right corner.
  wrap.style.left = "auto";
  wrap.style.top = "auto";
  wrap.style.right = "16px";
  wrap.style.bottom = "120px";
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

function feSetEditMode(wrap, newMode) {
  if (!wrap || newMode === FE_EDIT_MODE) return;

  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  const msg = FE_EDITING_MESSAGE_ID ? game?.messages?.get?.(FE_EDITING_MESSAGE_ID) : null;

  if (newMode === "html") {
    // Show the stored HTML content directly
    if (textarea && msg) textarea.value = String(msg.content ?? "");
  } else {
    // Show raw markdown (or stripped text if no raw flag)
    if (textarea && msg) textarea.value = feGetEditableRaw(msg);
  }

  FE_EDIT_MODE = newMode;

  wrap.querySelectorAll(".fe-edit-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === newMode);
  });

  feAutoGrowEditorTextarea(textarea);
  textarea?.focus();
}

function feStartInlineEdit(msg) {
  if (!feCanEditMessage(msg)) {
    ui?.notifications?.warn("이 메시지를 수정할 권한이 없습니다.");
    return;
  }
  const wrap = feEnsureInlineEditorUI();
  if (!wrap) return;

  FE_EDITING_MESSAGE_ID = msg.id;

  // Default to markdown mode if raw flag exists, otherwise HTML mode
  const hasRaw = !!(msg?.getFlag?.(MODULE_ID, "raw") ?? msg?.getFlag?.(MODULE_ID, "plain"));
  const initialMode = hasRaw ? "markdown" : "html";
  FE_EDIT_MODE = initialMode;

  const textarea = wrap.querySelector(".fe-chat-inline-editor-text");
  textarea.value = initialMode === "html" ? String(msg.content ?? "") : feGetEditableRaw(msg);

  // Sync toggle button active state
  wrap.querySelectorAll(".fe-edit-mode-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === initialMode);
  });

  wrap.style.display = "";
  feSetChatInputDisabled(true);

  // Measure-then-place: make it visible (display set above) so offsetWidth/Height
  // are real before anchoring, then size the textarea to its content.
  fePositionInlineEditor(wrap);
  feAutoGrowEditorTextarea(textarea);

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
    if (FE_EDIT_MODE === "html") {
      await feUpdateMessageFromHTML(msg, raw);
    } else {
      await feUpdateMessageFromRaw(msg, raw);
    }
  } catch (err) {
    console.error("[female_edition] edit update failed", err);
    ui?.notifications?.error("메시지 수정에 실패했습니다. 콘솔을 확인하세요.");
    return;
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

function feBuildEditUpdate(rawText) {
  const raw = (rawText ?? "").toString();
  const html = feMarkdownToHTML(raw);
  return {
    content: html,
    [`flags.${MODULE_ID}.raw`]: raw,
    [`flags.${MODULE_ID}.plain`]: raw,
    [`flags.${MODULE_ID}.markdown`]: true,
  };
}

function feApplyRawEditPreUpdate(message, changed, userId = null) {
  try {
    if (!changed || typeof changed !== "object") return;
    const modFlags = changed.flags?.[MODULE_ID] ?? null;
    const hasRaw = !!(modFlags && Object.prototype.hasOwnProperty.call(modFlags, "raw"));
    const hasPlain = !!(modFlags && Object.prototype.hasOwnProperty.call(modFlags, "plain"));
    if (!hasRaw && !hasPlain) return;

    const nextRaw = String((hasRaw ? modFlags.raw : modFlags.plain) ?? "");
    const currentRaw = String(
      message?.getFlag?.(MODULE_ID, "raw") ??
      message?.getFlag?.(MODULE_ID, "plain") ??
      message?.flags?.[MODULE_ID]?.raw ??
      message?.flags?.[MODULE_ID]?.plain ??
      ""
    );

    const rawChanged = nextRaw !== currentRaw;
    // If the raw text hasn't changed, the caller's payload already has the correct
    // flags. No need to rewrite them — just leave the changed object untouched.
    if (!rawChanged) return;

    const html = feMarkdownToHTML(nextRaw);
    changed.content = html;

    if (!changed.flags || typeof changed.flags !== "object") changed.flags = {};
    if (!changed.flags[MODULE_ID] || typeof changed.flags[MODULE_ID] !== "object") changed.flags[MODULE_ID] = {};
    changed.flags[MODULE_ID].raw = nextRaw;
    changed.flags[MODULE_ID].plain = nextRaw;
    changed.flags[MODULE_ID].markdown = true;

    feCaptureMessageRenderFlagsOnPreUpdate(message, changed, userId ?? game?.user?.id ?? null);
    // NOTE: fePrepareInlineRollSnapshotOnPreUpdate was intentionally removed.
    // Freezing [[formula]] → anchor HTML in message.content before storage causes the same
    // hash-mismatch issue as in preCreate. Leave [[formula]] as-is; Foundry's enrichHTML
    // evaluates it on next render, and feSnapshotOrRestoreInlineRolls captures that result.
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to prepare raw edit update`, err);
  }
}

async function feUpdateMessageFromRaw(msg, rawText) {
  const payload = feBuildEditUpdate(rawText);
  await msg.update(payload);
}

// HTML mode: save content as-is, no markdown flags touched.
// feApplyRawEditPreUpdate skips payloads without raw/plain flags, so no conflict.
async function feUpdateMessageFromHTML(msg, htmlText) {
  await msg.update({ content: (htmlText ?? "").toString() });
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
    // Patch the ChatLog class prototype early (v13). This must happen before
    // the ChatLog builds its ContextMenu, otherwise the handler can capture the
    // unpatched method.
    const ChatLogClass = foundry?.applications?.sidebar?.tabs?.ChatLog;
    patchOne(ChatLogClass?.prototype, "__feEditContextPatchedClassProto");

    const chat = ui?.chat;
    patchOne(chat?.constructor?.prototype, "__feEditContextPatchedProto");
    patchOne(chat, "__feEditContextPatchedInstance");
  };

  patch();
  Hooks.on("renderChatLog", patch);
}

/**
 * Install the "메시지 수정" entry into the chat message context menu.
 *
 * Important: this must run during init (before ChatLog creates its ContextMenu)
 * or Foundry may bind a handler to the original _getEntryContextOptions.
 */
function feInstallEditContextMenuEarly() {
  if (feInstallEditContextMenuEarly._done) return;
  feInstallEditContextMenuEarly._done = true;

  const inject = (options) => {
    // Respect the setting at runtime (so users can toggle without reload).
    if (feSetting(S.EDIT_ENABLED) === false) return;
    if (!Array.isArray(options)) return;

    // Avoid duplicates if multiple hooks/patches fire.
    if (
      options.some(
        (o) => o?.feId === "fe-edit-message" || String(o?.name ?? "") === "메시지 수정"
      )
    ) {
      return;
    }

    options.unshift({
      feId: "fe-edit-message",
      name: "메시지 수정",
      icon: '<i class="fa-solid fa-pen-to-square"></i>',
      condition: (target) => {
        const msg = feMessageFromContextLI(target);
        return feCanEditMessage(msg);
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

  // Patch the ChatLog method as a fallback (works even if hooks aren't fired).
  fePatchChatContextOptions(inject);
}

function feInstallEditHandlers() {
  if (feSetting(S.EDIT_ENABLED) === false) return;

  // Context menu injection is installed during init.

  // Delegated click handler for the pencil icon (covers existing + newly-rendered messages)
  if (!feInstallEditHandlers._delegateBound) {
    feInstallEditHandlers._delegateBound = true;
    document.addEventListener(
      "click",
      (ev) => {
        if (feSetting(S.EDIT_ENABLED) === false) return;

        const btn = ev.target?.closest?.("a.message-edit, button.message-edit");
        if (!btn) return;

        const li = btn.closest("li.chat-message");
        const msgId = feGetMessageIdFromElement(li);
        if (!msgId) return;

        const msg = game.messages?.get?.(msgId);
        if (!feCanEditMessage(msg)) return;

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
      try {
        // v13 hook provides an HTMLElement already.
        feRemoveMessageDeleteControl(html);

        if (feSetting(S.EDIT_ENABLED) === false) return;
        feEnsureMessageEditControl(message, html);
      } catch (e) {
        console.warn(`${MODULE_ID} | failed to ensure edit control`, e);
      }
    });
  }

  // Backfill: existing chat log entries were rendered before our hooks ran.
  // Ensure the edit icon exists for already-posted messages.
  feScheduleEditControlsRefresh(document, 0);

  // Re-apply after chat log re-renders (popout, refresh, etc.)
  if (!feInstallEditHandlers._backfillHookBound) {
    feInstallEditHandlers._backfillHookBound = true;
    Hooks.on("renderChatLog", (_app, html) => {
      try {
        const root = html?.[0] ?? html?.element?.[0] ?? html ?? document;
        feScheduleEditControlsRefresh(root, 0);
      } catch {
        feScheduleEditControlsRefresh(document, 0);
      }
    });
  }
}

function feMessageFromContextLI(target) {
  // Foundry may pass either the <li> itself or an inner element. It can also pass a jQuery wrapper.
  try {
    const el0 = target?.[0] ?? target;
    // FVTT v13+: chat message list items can use either data-message-id or data-document-id.
    const el = el0?.closest
      ? el0.closest("[data-message-id],[data-document-id]") ?? el0
      : el0;

    const id =
      el?.dataset?.messageId ??
      el?.dataset?.documentId ??
      (typeof target?.data === "function" ? target.data("messageId") : undefined) ??
      (typeof target?.data === "function" ? target.data("documentId") : undefined) ??
      (typeof target?.attr === "function" ? target.attr("data-message-id") : undefined) ??
      (typeof target?.attr === "function" ? target.attr("data-document-id") : undefined) ??
      (typeof el?.getAttribute === "function" ? el.getAttribute("data-message-id") : undefined) ??
      (typeof el?.getAttribute === "function" ? el.getAttribute("data-document-id") : undefined);

    const norm = feNormalizeChatMessageId(id);
    if (!norm) return null;

    // Prefer the normalized ID (v13 can use UUID-like values such as ChatMessage.<id>).
    return game.messages?.get?.(norm) ?? game.messages?.get?.(id) ?? null;
  } catch (_e) {
    return null;
  }
}


function feRemoveMessageDeleteControl(messageEl) {
  try {
    const el0 = messageEl?.[0] ?? messageEl;
    if (!el0?.querySelector) return;
    // Remove the header trash icon (it can overlap the ellipsis / edit icon)
    el0.querySelectorAll(".message-metadata .message-delete")?.forEach((el) => el.remove());
  } catch (_e) {
    /* noop */
  }
}

const feEditRefreshTimers = new WeakMap();

function feScheduleEditControlsRefresh(rootLike = document, delay = 0) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root) return;
    const existing = feEditRefreshTimers.get(root);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      try { feEnsureEditControlsForExistingMessages(root); } catch {}
      finally {
        const cur = feEditRefreshTimers.get(root);
        if (cur === t) feEditRefreshTimers.delete(root);
      }
    }, Math.max(0, Number(delay) || 0));
    feEditRefreshTimers.set(root, t);
  } catch {}
}

function feGetChatMessagesInRoot(rootLike = document) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root?.querySelectorAll) return document.querySelectorAll("#chat-log li.chat-message, ol.chat-log li.chat-message");
    if (root.matches?.("li.chat-message")) return [root];
    return root.querySelectorAll("li.chat-message");
  } catch {
    return document.querySelectorAll("#chat-log li.chat-message, ol.chat-log li.chat-message");
  }
}

function feEnsureEditControlsForExistingMessages(rootLike = document) {
  try {
    const messages = feGetChatMessagesInRoot(rootLike);

    for (const li of messages) {
      // Always remove the delete icon for layout stability.
      feRemoveMessageDeleteControl(li);

      if (!feSetting(S.EDIT_ENABLED)) continue;

      const msgId = feGetMessageIdFromElement(li);
      if (!msgId) continue;

      const msg = game?.messages?.get?.(msgId);
      if (!msg) continue;

      feEnsureMessageEditControl(msg, li);
    }
  } catch (e) {
    console.warn(`[${MODULE_ID}] failed to backfill edit controls`, e);
  }
}


// ── Defensive: keep one bad module's context-menu condition from breaking ALL menus ──
// Foundry's ContextMenu#render evaluates every entry's `visible`/`condition` inside a
// single reduce WITHOUT try/catch (context-menu.mjs). If ANY module's condition throws
// (e.g. monks-tokenbar's canHeroPointReroll reads `li.dataset` when the target is
// undefined), the whole reduce throws and the menu never opens — including the
// right-click AND "…" chat-message menus (same path). We wrap each entry's check so a
// throw is treated as "hidden" instead of aborting the menu. Idempotent.
// Gated to v13 only (per request) — v14 is left untouched.
function feGuardContextMenuEntry(entry) {
  if (!entry || typeof entry !== "object") return entry;
  for (const key of ["visible", "condition"]) {
    const fn = entry[key];
    if (typeof fn === "function" && !fn.__feGuarded) {
      const guarded = function (...args) {
        try {
          return fn.apply(this, args);
        } catch (e) {
          console.warn(`${MODULE_ID} | a context-menu condition threw; hiding that entry`, e);
          return false;
        }
      };
      guarded.__feGuarded = true;
      entry[key] = guarded;
    }
  }
  return entry;
}

function feHardenContextMenuConditions() {
  try {
    if (Number(game.release?.generation) !== 13) return; // v13-only
    const CM = foundry?.applications?.ux?.ContextMenu ?? globalThis.ContextMenu;
    const proto = CM?.prototype;
    if (!proto || proto.__feConditionGuardInstalled) return;
    const origRender = proto.render;
    if (typeof origRender !== "function") return;
    proto.render = function (...args) {
      try {
        if (Array.isArray(this.menuItems)) this.menuItems.forEach(feGuardContextMenuEntry);
      } catch {
        /* no-op */
      }
      return origRender.apply(this, args);
    };
    proto.__feConditionGuardInstalled = true;
  } catch (e) {
    console.warn(`${MODULE_ID} | failed to harden ContextMenu conditions`, e);
  }
}

Hooks.once("init", () => {
  feHardenContextMenuConditions();
  feInstallEditContextMenuEarly();
});

Hooks.once("ready", () => {
  feInstallEditHandlers();
});

Hooks.on("preUpdateChatMessage", (message, changed, _options, userId) => {
  feApplyRawEditPreUpdate(message, changed, userId);
});

// If the message currently being edited is deleted by anyone (GM, automation, etc.),
// close the inline editor immediately so it does not remain open as a stale orphan.
Hooks.on("deleteChatMessage", (message) => {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (!id || id !== FE_EDITING_MESSAGE_ID) return;
    feCancelInlineEdit();
  } catch {
    /* no-op */
  }
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
  try {
    const reason = payload?.reason ?? null;
    if (reason !== "edit-settings") return;
    feScheduleEditControlsRefresh(payload?.document ?? document, 0);
  } catch (err) {
    console.warn("[female_edition] fe-chat-edit: refresh failed", err);
  }
});
