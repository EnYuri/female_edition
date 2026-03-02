// Message editing feature (split)
// Provides inline edit and chat context menu option.

import {
  MODULE_ID,
  S,
  feSetting,
  feMarkdownToHTML,
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

function feBuildEditUpdate(rawText) {
  const raw = (rawText ?? "").toString();
  return {
    content: feMarkdownToHTML(raw),
    [`flags.${MODULE_ID}.raw`]: raw,
    [`flags.${MODULE_ID}.plain`]: raw,
    [`flags.${MODULE_ID}.markdown`]: true,
  };
}

function feApplyRawEditPreUpdate(changed) {
  try {
    if (!changed || typeof changed !== "object") return;
    const modFlags = changed.flags?.[MODULE_ID] ?? null;
    const hasRaw = !!(modFlags && Object.prototype.hasOwnProperty.call(modFlags, "raw"));
    const hasPlain = !!(modFlags && Object.prototype.hasOwnProperty.call(modFlags, "plain"));
    if (!hasRaw && !hasPlain) return;

    const raw = String((hasRaw ? modFlags.raw : modFlags.plain) ?? "");
    const html = feMarkdownToHTML(raw);
    changed.content = html;

    if (!changed.flags || typeof changed.flags !== "object") changed.flags = {};
    if (!changed.flags[MODULE_ID] || typeof changed.flags[MODULE_ID] !== "object") changed.flags[MODULE_ID] = {};
    changed.flags[MODULE_ID].raw = raw;
    changed.flags[MODULE_ID].plain = raw;
    changed.flags[MODULE_ID].markdown = true;
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to prepare raw edit update`, err);
  }
}

async function feUpdateMessageFromRaw(msg, rawText) {
  const payload = feBuildEditUpdate(rawText);
  await msg.update(payload);
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
  feEnsureEditControlsForExistingMessages();

  // Re-apply after chat log re-renders (popout, refresh, etc.)
  if (!feInstallEditHandlers._backfillHookBound) {
    feInstallEditHandlers._backfillHookBound = true;
    Hooks.on("renderChatLog", (_app, html) => {
      try {
        const root = html?.[0] ?? html?.element?.[0] ?? html ?? document;
        feEnsureEditControlsForExistingMessages(root);
      } catch {
        feEnsureEditControlsForExistingMessages();
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

function feGetChatMessagesInRoot(rootLike = document) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root?.querySelectorAll) return document.querySelectorAll("#chat-log li.chat-message, ol.chat-log li.chat-message");
    if (root.matches?.("li.chat-message")) return [root];
    if (root.matches?.("#chat-log, ol.chat-log, .chat-log")) return root.querySelectorAll("li.chat-message");
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


Hooks.once("init", () => {
  feInstallEditContextMenuEarly();
});

Hooks.once("ready", () => {
  feInstallEditHandlers();
});

Hooks.on("preUpdateChatMessage", (_message, changed) => {
  feApplyRawEditPreUpdate(changed);
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
  try {
    const reason = payload?.reason ?? null;
    const root = payload?.root ?? payload?.document ?? document;
    if (reason === "renderChatLog") {
      feEnsureEditControlsForExistingMessages(root);
      return;
    }
    // Settings changes may fire a generic UI update without a concrete chat-log root.
    // Keep that path, but avoid whole-document rescans for normal per-message updates.
    if (!reason) feEnsureEditControlsForExistingMessages(document);
  } catch (err) {
    console.warn("[female_edition] fe-chat-edit: refresh failed", err);
  }
});
