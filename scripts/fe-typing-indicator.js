// fe-typing-indicator.js
// "다른 사람이 입력하고 있습니다" typing indicator for Foundry VTT v13 + v14.
//
// Design ported/adapted from CautiousGamemastersPack (CGMP) typing-notifier.js
// (MIT, Alan Davies / Shoyu Vanilla), reimplemented to fit female_edition.
//
// Compatibility / conflict avoidance:
//  - If CautiousGamemastersPack is active, this feature stays OFF and defers to
//    CGMP entirely (no double indicator, no competing socket traffic).
//  - Shares the `module.female_edition` socket channel with fe-theatre.js, so all
//    messages are namespaced by a `type` discriminator. Multiple socket.on()
//    listeners coexist; each guards on its own type.
//  - The indicator element lives in the chat input area (next to #chat-message),
//    NEVER inside .chat-log, so it does not interfere with fe-chat-prune.js DOM
//    pruning. Visibility changes reassert scrollBottom() (the prune subclass's
//    override) when at-bottom, preserving auto-scroll.

import { MODULE_ID, S } from "./fe-constants.js";

const SOCKET_CHANNEL = "module.female_edition";
const SOCKET_TYPE = "fe-typing-indicator";
const INDICATOR_ID = "fe-typing-notify";

// How long a remote user's indicator persists after their last "typing" packet.
const REMOTE_TYPING_TIMEOUT = 5000;
// Throttle for re-emitting "typing" while actively typing (well under the remote timeout).
const TYPING_EMIT_INTERVAL = 1500;
// Local inactivity window after which we emit "typing-end".
const LOCAL_IDLE_TIMEOUT = 3000;

// ── State ────────────────────────────────────────────────────────────────────

// userId -> debounced "remove this user" function (calling it resets the 5s timer)
const typingUsers = new Map();
let lastEmit = 0;
let localTypingActive = false;
let localIdleTimer = null;
let indicatorEl = null;
let textSpan = null;

// ── Settings access
// TYPING_ENABLED is client-scoped but not GM-priority-excluded, so enforcement
// syncs the local game.settings value before this direct read matters.
// TYPING_SHOW_TO_PLAYERS is world-scoped and GM-only.

function feCgmpActive() {
  try { return !!game.modules.get("CautiousGamemastersPack")?.active; }
  catch { return false; }
}

function feTypingFeatureEnabled() {
  if (feCgmpActive()) return false;
  try { return !!game.settings.get(MODULE_ID, S.TYPING_ENABLED); }
  catch { return true; }
}

function feShowToPlayers() {
  try { return !!game.settings.get(MODULE_ID, S.TYPING_SHOW_TO_PLAYERS); }
  catch { return true; }
}

// ── Emit (local user typing → broadcast) ─────────────────────────────────────

function feEmitTyping() {
  const now = Date.now();
  if (now - lastEmit < TYPING_EMIT_INTERVAL) return;
  lastEmit = now;
  try {
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPE, event: "typing", user: game.user.id });
  } catch { /* no-op */ }
}

function feEmitTypingEnd() {
  if (localIdleTimer) { clearTimeout(localIdleTimer); localIdleTimer = null; }
  if (!localTypingActive) return;
  localTypingActive = false;
  lastEmit = 0;
  try {
    game.socket.emit(SOCKET_CHANNEL, { type: SOCKET_TYPE, event: "typing-end", user: game.user.id });
  } catch { /* no-op */ }
}

function feOnLocalInputActivity() {
  if (!feTypingFeatureEnabled()) return;
  localTypingActive = true;
  feEmitTyping();
  if (localIdleTimer) clearTimeout(localIdleTimer);
  localIdleTimer = setTimeout(feEmitTypingEnd, LOCAL_IDLE_TIMEOUT);
}

// Best-effort "is the input empty" check across v13 prose-mirror and v14/textarea.
function feInputIsEmpty(input) {
  try {
    if (typeof input?.value === "string") return input.value.trim() === "";
    const pm = input?.querySelector?.(".ProseMirror");
    if (pm) return (pm.textContent ?? "").trim() === "";
    return (input?.textContent ?? "").trim() === "";
  } catch {
    return false;
  }
}

// ── Receive (remote typing packets) ──────────────────────────────────────────

function feHandleSocket(payload) {
  // Coexist with other female_edition socket users (fe-theatre): ignore foreign types.
  if (payload?.type !== SOCKET_TYPE) return;
  if (!feTypingFeatureEnabled()) return;
  // GM-gated visibility: when disabled, only GMs see who is typing.
  if (!feShowToPlayers() && !game.user.isGM) return;

  const id = payload.user;
  if (!id || id === game.user.id) return;

  if (payload.event === "typing") {
    let resetTimer = typingUsers.get(id);
    if (!resetTimer) {
      resetTimer = foundry.utils.debounce(() => {
        typingUsers.delete(id);
        feUpdateIndicator();
      }, REMOTE_TYPING_TIMEOUT);
      typingUsers.set(id, resetTimer);
      feUpdateIndicator();
    }
    resetTimer(); // (re)start the 5s removal countdown
  } else if (payload.event === "typing-end") {
    if (typingUsers.has(id)) {
      typingUsers.delete(id);
      feUpdateIndicator();
    }
  }
}

// ── Indicator DOM ────────────────────────────────────────────────────────────

function feFindChatInput() {
  return document.querySelector("#chat-message")
      ?? document.querySelector("#chat-form textarea[name='message']")
      ?? document.querySelector("textarea[name='message']");
}

function feInjectIndicator() {
  const input = feFindChatInput();
  if (!input) return false;

  let el = document.getElementById(INDICATOR_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = INDICATOR_ID;
    el.className = "hidden";
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<span class="fe-typing-dots"><span></span><span></span><span></span></span>' +
      '<span class="fe-typing-text"></span>';
    // Place directly above the chat input box.
    input.parentElement?.insertBefore(el, input);
  }
  indicatorEl = el;
  textSpan = el.querySelector(".fe-typing-text");
  feUpdateIndicator(); // restore current state after a chat re-render
  return true;
}

function feAttachInputListeners() {
  const input = feFindChatInput();
  if (!input || input.__feTypingBound) return;
  input.__feTypingBound = true;

  input.addEventListener("keydown", (ev) => {
    if (!feTypingFeatureEnabled()) return;
    const key = String(ev.key ?? "").toUpperCase();
    // Enter (without Shift) sends the message → typing ends.
    if ((key === "ENTER") && !ev.shiftKey) { feEmitTypingEnd(); return; }
    feOnLocalInputActivity();
  });

  // Catch deletions/clears that leave the box empty.
  input.addEventListener("input", () => {
    if (!feTypingFeatureEnabled()) return;
    if (feInputIsEmpty(input)) feEmitTypingEnd();
  });
}

function feUpdateIndicator() {
  if (!indicatorEl || !textSpan) return;

  const names = [];
  for (const uid of typingUsers.keys()) {
    const u = game.users?.get(uid);
    if (u) names.push(u.name);
  }

  if (!names.length) { feSetIndicatorVisible(false); return; }

  let text;
  if (names.length === 1) text = game.i18n.format("FE.Typing.One", { user: names[0] });
  else if (names.length === 2) text = game.i18n.format("FE.Typing.Two", { user1: names[0], user2: names[1] });
  else text = game.i18n.format("FE.Typing.Many", { user1: names[0], user2: names[1], count: names.length - 2 });

  textSpan.textContent = text;
  feSetIndicatorVisible(true);
}

function feSetIndicatorVisible(visible) {
  if (!indicatorEl) return;
  // Preserve auto-scroll: capture at-bottom BEFORE the layout shift, then
  // reassert it via scrollBottom() (which is fe-chat-prune's override when
  // pruning is active, or core ChatLog.scrollBottom otherwise).
  const app = ui.chat;
  const atBottom = !!app?.isAtBottom;
  indicatorEl.classList.toggle("hidden", !visible);
  if (atBottom) {
    try { app?.scrollBottom?.(); } catch { /* no-op */ }
  }
}

function feClearAllTyping() {
  typingUsers.clear();
  feSetIndicatorVisible(false);
}

// ── Hooks ────────────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.TYPING_ENABLED, {
    name: "타이핑 인디케이터 표시('…님이 입력 중')",
    hint: "다른 사용자가 채팅을 입력 중일 때 입력창 위에 표시합니다. CautiousGamemastersPack(CGMP)이 활성화되어 있으면 자동으로 비활성화되어 CGMP에 양보합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: (value) => {
      if (!value || feCgmpActive()) { feEmitTypingEnd(); feClearAllTyping(); }
    },
  });

  game.settings.register(MODULE_ID, S.TYPING_SHOW_TO_PLAYERS, {
    name: "타이핑 인디케이터: 플레이어에게도 표시",
    hint: "끄면 GM만 다른 사용자의 입력 중 표시를 볼 수 있습니다. (월드 설정 — GM 전용)",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: () => feClearAllTyping(),
  });

  // Coexists with fe-theatre's listener on the same channel (type-discriminated).
  try { game.socket.on(SOCKET_CHANNEL, feHandleSocket); } catch { /* no-op */ }

  if (feCgmpActive()) {
    console.log(`${MODULE_ID} | CautiousGamemastersPack active — deferring typing indicator to CGMP`);
  }
});

Hooks.on("renderChatLog", (app, _html) => {
  if (!feTypingFeatureEnabled()) return;
  // Main chat only — skip popout windows (v13 options.popOut / v14 id fallback).
  if (app?.options?.popOut === true || app?.popOut === true || app?.id === "chat-popout") return;
  // The input/controls render into #chat-notifications (a separate subtree); a
  // microtask defer ensures #chat-message exists before we query for it.
  queueMicrotask(() => {
    feInjectIndicator();
    feAttachInputListeners();
  });
});

Hooks.once("ready", () => {
  if (!feTypingFeatureEnabled()) return;
  feInjectIndicator();
  feAttachInputListeners();
});
