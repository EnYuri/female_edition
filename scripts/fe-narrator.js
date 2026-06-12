/**
 * fe-narrator.js — Narrator overlay + styled narrator chat
 *
 * Adapted from "Narrator Tools" (elizeuangelo, MIT) for FVTT v13/v14, vanilla
 * (no jQuery) + Web Animations API. Folded into female_edition so it is a
 * first-class chat channel.
 *
 * FOUR DISTINCT CHAT CHANNELS — all typed into the one sidebar chatbox, all
 * routed independently:
 *   1. 일반 사이드바 채팅   — Foundry default
 *   2. 무대 채팅 (fe-theatre) — speakingAs a staged actor (flags.female_edition.stageId)
 *   3. 내레이터 채팅 (this)  — /narrate /describe /note  (flags.female_edition.isNarrator)
 *   4. 원본/플레인          — anything else
 *
 * Narrator messages carry `flags.female_edition.isNarrator = true`. This is the
 * SAME flag fe-render-state.js already reads (fe-render-state.js:201), so merge
 * exclusion + archive styling are automatic. fe-theatre.js has guards that bail
 * the moment a message carries this flag, so stage routing never hijacks a
 * narrator message.
 *
 * Features:
 *  - /narrate|/narration  → full-screen cinematic scrolling overlay + chat line
 *  - /describe|/desc|/description → centered italic "description" chat line
 *  - /note|/notify|/notification  → GM-whispered "notification" chat line
 *  - /as <name>           → speak as a plain alias (no portrait); empty /as clears
 *  - Overlay state synced via a WORLD setting (persists; no socket races). GM owns
 *    the auto-close timer. Pause/Close/Copy buttons.
 */

import { feMarkdownToHTML } from "./fe-markdown.js";

const _FN_MODULE   = "female_edition";
const _FN_MD_ENABLED_KEY = "ceMarkdownEnabled";  // shared markdown toggle (fe-chat-enhance)
const _FN_STATE    = "narratorState";   // world-scope shared overlay state
const _FN_NARRATOR_FLAG = "isNarrator"; // flags.female_edition.isNarrator
const _FN_TYPE_FLAG     = "narratorType";

// ── Settings cache ───────────────────────────────────────────────────────────
let _fnEnabled       = true;
let _fnDurationMult  = 1;
let _fnStartPaused   = false;
let _fnAllowCopy     = true;
let _fnPermNarrate   = 4; // CONST.USER_ROLES.GAMEMASTER
let _fnPermDescribe  = 4;
let _fnPermAs        = 4;

// ── Runtime ────────────────────────────────────────────────────────────────
const _fn = {
  /** custom plain alias set via /as (local client) */
  character: "",
  /** id of the last narration we rendered locally */
  lastId: 0,
  /** DOM refs */
  el: null, bg: null, frameBG: null, box: null, content: null,
  buttons: null, btnPause: null, btnClose: null, btnCopy: null,
  /** active scroll animation (WAAPI) */
  scrollAnim: null,
  /** pausable close timer */
  closeTimer: null,
  /** queued narrate strings (for chatMessage.narrate([..])) */
  queue: [],
  isNarrator: false,
  /** true while the overlay is shown (drives fade-in vs instant-swap) */
  visible: false,
};

// Fade via the Web Animations API rather than a CSS transition — the retro
// theme's `* { transition: all 1ms !important }` collapses CSS transitions, but
// WAAPI animations are unaffected (same reason the scroll uses WAAPI).
function _fnAnimate(el, keyframes, duration, easing = "ease-in-out") {
  if (!el) return;
  try { el.animate(keyframes, { duration, easing, fill: "forwards" }); } catch { /* no-op */ }
}

// ── Settings ─────────────────────────────────────────────────────────────────
function _fnRegisterSettings() {
  game.settings.register(_FN_MODULE, "narratorEnabled", {
    name: "내레이터 기능 활성화",
    hint: "사이드바 채팅에서 /narrate, /describe, /note, /as 명령과 시네마틱 내레이션 오버레이를 사용합니다. (무대 채팅과 별개의 채널)",
    scope: "world", config: true, restricted: true, type: Boolean, default: true,
    onChange: (v) => { _fnEnabled = v; if (!v) _fnForceClose(); },
  });
  game.settings.register(_FN_MODULE, "narratorDurationMult", {
    name: "내레이터: 표시 시간 배수",
    hint: "/narrate 오버레이가 화면에 머무는 시간을 이 값으로 곱합니다.",
    scope: "world", config: true, restricted: true, type: Number,
    range: { min: 0.25, max: 4, step: 0.25 }, default: 1,
    onChange: (v) => { _fnDurationMult = v; },
  });
  game.settings.register(_FN_MODULE, "narratorStartPaused", {
    name: "내레이터: 항상 일시정지 상태로 시작",
    scope: "world", config: true, restricted: true, type: Boolean, default: false,
    onChange: (v) => { _fnStartPaused = v; },
  });
  game.settings.register(_FN_MODULE, "narratorAllowCopy", {
    name: "내레이터: 복사 버튼 표시",
    scope: "world", config: true, restricted: true, type: Boolean, default: true,
    onChange: (v) => { _fnAllowCopy = v; },
  });
  game.settings.register(_FN_MODULE, "narratorPermNarrate", {
    name: "내레이터: /narrate 최소 권한",
    scope: "world", config: true, restricted: true, type: Number,
    choices: _fnRoleChoices(), default: 4,
    onChange: (v) => { _fnPermNarrate = Number(v); },
  });
  game.settings.register(_FN_MODULE, "narratorPermDescribe", {
    name: "내레이터: /describe·/note 최소 권한",
    scope: "world", config: true, restricted: true, type: Number,
    choices: _fnRoleChoices(), default: 4,
    onChange: (v) => { _fnPermDescribe = Number(v); },
  });
  game.settings.register(_FN_MODULE, "narratorPermAs", {
    name: "내레이터: /as 최소 권한",
    scope: "world", config: true, restricted: true, type: Number,
    choices: _fnRoleChoices(), default: 4,
    onChange: (v) => { _fnPermAs = Number(v); },
  });

  // World-scope shared overlay state — drives ALL clients via onChange.
  // (A world setting, not a socket: state persists so a late-joining client
  //  still sees an open narration, and there is no socket/setting race.)
  game.settings.register(_FN_MODULE, _FN_STATE, {
    name: "Narrator Shared State",
    scope: "world", config: false,
    default: { narration: { id: 0, display: false, message: "", paused: false } },
    onChange: (state) => _fnController(state),
  });
}

function _fnRoleChoices() {
  const R = CONST.USER_ROLES ?? { NONE: 0, PLAYER: 1, TRUSTED: 2, ASSISTANT: 3, GAMEMASTER: 4 };
  return {
    [R.NONE]: "없음",
    [R.PLAYER]: "플레이어",
    [R.TRUSTED]: "신뢰 플레이어",
    [R.ASSISTANT]: "어시스턴트 GM",
    [R.GAMEMASTER]: "게임마스터",
  };
}

function _fnLoadSettings() {
  _fnEnabled      = game.settings.get(_FN_MODULE, "narratorEnabled");
  _fnDurationMult = game.settings.get(_FN_MODULE, "narratorDurationMult");
  _fnStartPaused  = game.settings.get(_FN_MODULE, "narratorStartPaused");
  _fnAllowCopy    = game.settings.get(_FN_MODULE, "narratorAllowCopy");
  _fnPermNarrate  = Number(game.settings.get(_FN_MODULE, "narratorPermNarrate"));
  _fnPermDescribe = Number(game.settings.get(_FN_MODULE, "narratorPermDescribe"));
  _fnPermAs       = Number(game.settings.get(_FN_MODULE, "narratorPermAs"));
}

// ── Shared state accessors ─────────────────────────────────────────────────
function _fnGetState() {
  return game.settings.get(_FN_MODULE, _FN_STATE) ?? { narration: { id: 0, display: false, message: "", paused: false } };
}
function _fnSetNarration(narration) {
  const s = { ...(_fnGetState()), narration };
  // Persist + broadcast to all clients (players react via the setting onChange).
  const p = game.settings.set(_FN_MODULE, _FN_STATE, s);
  // Optimistic local apply for the narrator (GM): the GM already knows the state
  // it just wrote, so there is no reason to wait for the server round-trip before
  // displaying. This removes the GM-side appearance lag. The subsequent onChange
  // re-invokes _fnController with the SAME id → the new-id branch is skipped and
  // the pause/resume branch is idempotent, so the echo is a harmless no-op.
  if (_fn.isNarrator) _fnController(s);
  return p;
}

// ── Style helpers (CHAT_MESSAGE_STYLES on v14, _TYPES on v13) ───────────────
function _fnMsgStyle(name) {
  const S = CONST.CHAT_MESSAGE_STYLES ?? CONST.CHAT_MESSAGE_TYPES ?? {};
  const v = S[name];
  return CONST.CHAT_MESSAGE_STYLES ? { style: v } : { type: v };
}

// ── Overlay DOM ──────────────────────────────────────────────────────────────
function _fnBuildOverlay() {
  if (_fn.el) return;
  const el = document.createElement("div");
  el.id = "fe-narrator";
  el.className = "fe-narrator";
  el.innerHTML = `
    <div class="fe-narrator-bg"></div>
    <div class="fe-narrator-frame">
      <div class="fe-narrator-box"><div class="fe-narrator-content"></div></div>
      <div class="fe-narrator-buttons" style="opacity:0;visibility:hidden;">
        <button type="button" class="fe-nt-pause"></button>
        <button type="button" class="fe-nt-close"></button>
        <button type="button" class="fe-nt-copy"></button>
      </div>
    </div>`;
  document.body.appendChild(el);

  _fn.el       = el;
  _fn.bg       = el.querySelector(".fe-narrator-bg");
  _fn.frame    = el.querySelector(".fe-narrator-frame");
  _fn.box      = el.querySelector(".fe-narrator-box");
  _fn.content  = el.querySelector(".fe-narrator-content");
  _fn.buttons  = el.querySelector(".fe-narrator-buttons");
  _fn.btnPause = el.querySelector(".fe-nt-pause");
  _fn.btnClose = el.querySelector(".fe-nt-close");
  _fn.btnCopy  = el.querySelector(".fe-nt-copy");

  _fn.btnClose.innerHTML = `<i class="fas fa-times-circle"></i> ${game.i18n?.localize?.("Close") || "닫기"}`;
  _fn.btnCopy.innerHTML  = `<i class="fas fa-clipboard"></i> 복사`;
  _fnUpdatePauseButton(false);

  _fn.btnPause.addEventListener("click", () => {
    const n = _fnGetState().narration;
    const paused = !n.paused;
    _fnSetNarration({ ...n, paused });
    _fnUpdatePauseButton(paused);
  });
  _fn.btnClose.addEventListener("click", () => _fnNarrationClose());
  _fn.btnCopy.addEventListener("click", () => {
    try { navigator.clipboard.writeText(_fn.content.innerText); ui.notifications?.info("클립보드에 복사했습니다."); } catch {}
  });

  // Only the narrator (GM-level) gets pause/close.
  if (!_fn.isNarrator) {
    _fn.btnPause.style.display = "none";
    _fn.btnClose.style.display = "none";
  }
}

function _fnUpdatePauseButton(paused) {
  if (!_fn.btnPause) return;
  _fn.btnPause.innerHTML = paused
    ? `<i class="fas fa-play-circle"></i> 재생`
    : `<i class="fas fa-pause-circle"></i> 일시정지`;
}

// ── Duration model (ported from narrator-tools) ─────────────────────────────
function _fnMessageDuration(length) {
  const clamp = Math.clamp ?? ((min, v, max) => Math.min(Math.max(v, min), max));
  return (clamp(2000, length * 80, 20000) + 3000) * _fnDurationMult + 500;
}

// ── Pausable close timer (GM owns it) ───────────────────────────────────────
function _fnClearCloseTimer() {
  if (_fn.closeTimer?.handle) clearTimeout(_fn.closeTimer.handle);
  _fn.closeTimer = null;
}
function _fnStartCloseTimer(remaining) {
  _fnClearCloseTimer();
  _fn.closeTimer = { handle: setTimeout(_fnNarrationClose, remaining), startedAt: Date.now(), remaining, paused: false };
}
// Idempotent (pause/resume may be invoked twice: optimistic local apply + the
// setting onChange echo for the same state).
function _fnPauseCloseTimer() {
  const t = _fn.closeTimer;
  if (!t || t.paused) return;
  t.remaining = Math.max(0, t.remaining - (Date.now() - t.startedAt));
  if (t.handle) clearTimeout(t.handle);
  t.handle = null;
  t.paused = true;
}
function _fnResumeCloseTimer() {
  const t = _fn.closeTimer;
  if (!t || !t.paused) return;
  _fnStartCloseTimer(t.remaining);
}

// ── Controller: react to shared-state changes ───────────────────────────────
function _fnController(state) {
  if (!_fn.el) return;
  const n = state?.narration ?? { id: 0, display: false, message: "", paused: false };

  // Narration ended → fade out (WAAPI)
  if (!n.display) {
    _fnStopScroll();
    _fnClearCloseTimer();
    if (_fn.visible) {
      _fnAnimate(_fn.content, [{ opacity: 1 }, { opacity: 0 }], 400);
      _fnAnimate(_fn.bg, [{ height: _fn.bg.style.height || "0px" }, { height: "0px" }], 400);
      _fnAnimate(_fn.buttons, [{ opacity: 1 }, { opacity: 0 }], 280);
    }
    _fn.content.style.opacity = "0";
    _fn.bg.style.height = "0px";
    _fn.buttons.style.opacity = "0";
    _fn.buttons.style.visibility = "hidden";
    _fn.visible = false;
    return;
  }
  if (!n.message) { _fn.content.style.opacity = "0"; return; }

  // New narration id → open immediately (no artificial gap). The text fades in
  // via the CSS opacity transition (content starts at opacity 0 when nothing was
  // showing); when replacing an active narration the content swaps instantly.
  if (n.id !== _fn.lastId) {
    const wasHidden = !_fn.visible;
    _fn.lastId = n.id;
    _fnStopScroll();
    _fn.content.innerHTML = n.message;
    _fn.content.style.top = "0px";
    const h = Math.min(_fn.content.offsetHeight || 0, 310);
    _fn.btnCopy.style.display = _fnAllowCopy ? "" : "none";
    _fn.buttons.style.visibility = "visible";
    _fn.buttons.style.top = `calc(50% + ${60 + h / 2}px)`;
    // Fade in via WAAPI only when coming from a hidden state; a back-to-back
    // replacement swaps content instantly (no flash to 0).
    if (wasHidden) {
      _fnAnimate(_fn.content, [{ opacity: 0 }, { opacity: 1 }], 450);
      _fnAnimate(_fn.bg, [{ height: "0px" }, { height: `${h * 3}px` }], 450);
      _fnAnimate(_fn.buttons, [{ opacity: 0 }, { opacity: 1 }], 450);
    }
    _fn.content.style.opacity = "1";
    _fn.bg.style.height = `${h * 3}px`;
    _fn.buttons.style.opacity = "1";
    _fn.visible = true;
    const paused = n.paused || _fnStartPaused;
    _fnUpdatePauseButton(paused);
    _fnRunNarration(n, paused);
    return;
  }

  // Same narration, pause/resume toggled (anim + timer already set up at open)
  if (n.paused) {
    _fn.scrollAnim?.pause?.();
    _fnPauseCloseTimer();
  } else {
    _fn.scrollAnim?.play?.();
    _fnResumeCloseTimer();
  }
}

function _fnStopScroll() {
  try { _fn.scrollAnim?.cancel?.(); } catch {}
  _fn.scrollAnim = null;
  if (_fn.content) _fn.content.style.top = "0px";
}

// Set up the scroll animation + close timer for an open narration.
function _fnRunNarration(n, paused) {
  const total = _fnMessageDuration(String(n.message ?? "").length);
  const scroll = (_fn.content.offsetHeight || 0) - 290;

  if (scroll > 20) {
    // delay 3000*mult before scrolling, then linear scroll over scrollDuration
    const delay = 3000 * _fnDurationMult;
    const scrollDuration = Math.max(0, total - 500 - 4500 * _fnDurationMult);
    // WAAPI animates `top`; fill:forwards keeps it parked at the end.
    const anim = _fn.content.animate(
      [{ top: "0px" }, { top: `${-scroll}px` }],
      { duration: scrollDuration, delay, easing: "linear", fill: "forwards" }
    );
    _fn.scrollAnim = anim;
    if (paused) anim.pause();
  }

  // Only the narrator owns the authoritative close (flips shared state).
  if (_fn.isNarrator) {
    _fnStartCloseTimer(total);
    if (paused) _fnPauseCloseTimer();
  }
}

function _fnNarrationClose() {
  const n = _fnGetState().narration;
  Hooks.call("fe-narration-closes", { id: n.id, message: n.message });
  _fnClearCloseTimer();
  // chain any queued /narrate strings
  const next = _fn.queue.shift();
  if (next && _fn.isNarrator) {
    _fnCreateMessage("narration", next);
    return;
  }
  setTimeout(() => {
    const cur = _fnGetState().narration;
    if (cur.id === n.id && _fn.isNarrator) {
      _fnSetNarration({ ...cur, display: false, message: "" });
    }
  }, 250);
}

function _fnForceClose() {
  _fnStopScroll();
  _fnClearCloseTimer();
  if (_fn.content) _fn.content.style.opacity = "0";
  if (_fn.buttons) { _fn.buttons.style.opacity = "0"; _fn.buttons.style.visibility = "hidden"; }
  if (_fn.bg) _fn.bg.style.height = "0px";
}

// Render markdown so BOTH the overlay and the chat line show formatted text.
// Honours the shared `ceMarkdownEnabled` toggle. <br> → newline so feMarkdownToHTML
// (line-based) sees real line breaks. Returns raw text when markdown is off.
function _fnRenderMarkdown(text) {
  try {
    if (!game.settings.get(_FN_MODULE, _FN_MD_ENABLED_KEY)) return text;
    const src = String(text ?? "").replace(/<br\s*\/?>/gi, "\n");
    return feMarkdownToHTML(src);
  } catch {
    return text;
  }
}

// ── Chat message creation ────────────────────────────────────────────────────
function _fnCreateMessage(type, message, options = {}) {
  if (type === "narration" && game.user.role < _fnPermNarrate) return;
  if (type !== "narration" && game.user.role < _fnPermDescribe) return;
  message = String(message ?? "").replace(/\\n/g, "<br>");

  // Render once; reuse for overlay + chat so they stay identical. The chat
  // pre-create markdown pass (fe-markdown.js) sees this as real HTML and bails,
  // so there is no double-processing.
  const rendered = _fnRenderMarkdown(message);

  const chatData = {
    content: rendered,
    flags: { [_FN_MODULE]: { [_FN_NARRATOR_FLAG]: true, [_FN_TYPE_FLAG]: type, raw: message, markdown: true } },
    ..._fnMsgStyle("OTHER"),
    speaker: { scene: game.user.viewedScene, actor: null, token: null, alias: "내레이터" },
    whisper: type === "notification" ? game.users.filter((u) => u.isGM).map((u) => u.id) : [],
    ...options,
  };

  if (type === "narration") {
    const prev = _fnGetState().narration;
    _fnSetNarration({ id: (prev.id ?? 0) + 1, display: true, message: rendered, paused: _fnStartPaused });
  }
  return ChatMessage.create(chatData, {});
}

// ── Selection helper (for future context-menu hook) ─────────────────────────
function _fnGetSelectionText() {
  let html = "";
  const sel = window.getSelection?.();
  if (sel?.rangeCount && !sel.isCollapsed) {
    const frag = sel.getRangeAt(0).cloneContents();
    frag.childNodes.forEach((nd) => {
      html += nd.nodeType === Node.TEXT_NODE ? nd.wholeText : (nd.outerHTML ?? "");
    });
  }
  return html;
}

// ── Public API ───────────────────────────────────────────────────────────────
const FENarrator = {
  describe: (msg, opts) => _fnCreateMessage("description", msg, opts),
  notify:   (msg, opts) => _fnCreateMessage("notification", msg, opts),
  narrate(msg, opts) {
    const arr = Array.isArray(msg) ? msg : [msg];
    _fn.queue = arr.slice(1);
    return _fnCreateMessage("narration", arr[0], opts);
  },
  getSelectionText: _fnGetSelectionText,
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

// Slash-command parsing. Returning false swallows the raw message. The narrator
// message is then created programmatically with the isNarrator flag, which makes
// fe-theatre.js bail (no stage hijack) and fe-render-state.js skip merge.
Hooks.on("chatMessage", (_log, message, chatData) => {
  if (!_fnEnabled) return;
  // The v14 chat input is ProseMirror and serializes to HTML before
  // processMessage runs (chat-input-plugin.mjs:151), so a typed "/narrate x"
  // arrives as "<p>/narrate x</p>". Strip the paragraph wrapper (mirrors core
  // ChatLog.parse: `message.replace(/^<p>|<\/p>$/gi, "")`) BEFORE matching —
  // otherwise the regexes never match the leading "/" and the command falls
  // through to core's invalid-command throw. Programmatic processMessage(string)
  // calls pass plain text (no wrapper), which is why they matched in testing.
  // Also NFC-normalize (Korean IME/ProseMirror text can arrive NFD-decomposed).
  let content = String(message ?? "").normalize("NFC")
    .replace(/^<p>/i, "")
    .replace(/<\/p>$/i, "")
    .replace(/<\/p>\s*<p>/gi, "<br>")
    .replace(/\n/g, "<br>");

  // English slash commands. The chatMessage hook runs BEFORE Foundry's own
  // command parser (chat.mjs:867), so matching here + returning false swallows
  // the input before the invalid-command throw. Content is OPTIONAL: a bare
  // command shows a usage hint instead of erroring.
  const cmds = {};
  if (game.user.role >= _fnPermAs)       cmds.as = /^\/as(?:\s+([^]*))?$/i;
  if (game.user.role >= _fnPermDescribe) {
    cmds.description  = /^\/desc(?:ribe|ription|)(?:\s+([^]*))?$/i;
    cmds.notification = /^\/not(?:e|ify|ication)(?:\s+([^]*))?$/i;
  }
  if (game.user.role >= _fnPermNarrate)  cmds.narration = /^\/narrat(?:e|ion)(?:\s+([^]*))?$/i;

  const _usage = { narration: "/narrate <text>", description: "/desc <text>", notification: "/note <text>" };

  for (const [c, rgx] of Object.entries(cmds)) {
    const match = content.match(rgx);
    if (!match) continue;
    if (c === "as") {
      const box = document.getElementById("chat-message");
      if (match[1]) {
        _fn.character = match[1];
        if (box) box.placeholder = `말하기: ${_fn.character}`;
      } else {
        _fn.character = "";
        if (box) box.placeholder = "";
      }
      return false;
    }
    const body = (match[1] ?? "").trim();
    if (!body) {
      // Bare command (no text) — swallow and hint, do not error.
      ui.notifications?.info(`사용법: ${_usage[c]}`);
      return false;
    }
    if (c === "narration" && !game.user.hasPermission?.("SETTINGS_MODIFY")) {
      ui.notifications?.error("이 작업에는 설정 수정 권한이 필요합니다.");
    } else {
      _fnCreateMessage(c, body);
    }
    return false;
  }

  // /as alias for plain messages (only when not a command and a character is set).
  // Skipped if the user is speaking via the theatre stage (that channel owns the speaker).
  if (game.user.role >= _fnPermAs && _fn.character && !/^\//.test(content)) {
    const stageActive = (() => {
      try {
        const v = document.querySelector("#fe-stage-nav select.fe-stage-select")?.value;
        return !!v && v !== "__none__" && v !== "";
      } catch { return false; }
    })();
    if (!stageActive) {
      // /as is a PLAIN message with a custom alias — NOT a styled narrator line.
      // No isNarrator flag, so it merges normally like any other alias's messages.
      ChatMessage.create({
        ..._fnMsgStyle("IC"),
        content,
        speaker: { scene: null, actor: null, token: null, alias: _fn.character },
        // plainAlias: theatre bails (don't overwrite the alias), but render-state
        // doesn't know this key → message merges normally like any alias's lines.
        flags: { [_FN_MODULE]: { plainAlias: true } },
      });
      return false;
    }
  }
});

// Tag rendered narrator messages with style classes.
Hooks.on("renderChatMessageHTML", (message, html) => {
  const el = html?.nodeType ? html : (html?.[0] ?? html);
  if (!el?.classList) return;
  const type = message?.getFlag?.(_FN_MODULE, _FN_TYPE_FLAG);
  if (!type) return;
  el.classList.add("fe-narrator-chat", "narrator-chat");
  if (type === "narration")        el.classList.add("fe-narrator-narrative");
  else if (type === "description") el.classList.add("fe-narrator-description");
  else if (type === "notification") el.classList.add("fe-narrator-notification");
});

Hooks.on("init", () => {
  _fnRegisterSettings();
});

Hooks.on("ready", () => {
  _fnLoadSettings();
  _fn.isNarrator = !!(game.user.hasPermission?.("SETTINGS_MODIFY") && game.user.role >= _fnPermNarrate);
  _fnBuildOverlay();
  _fnController(_fnGetState());
  // expose API
  const mod = game.modules.get(_FN_MODULE);
  if (mod) { mod.api ??= {}; mod.api.narrator = FENarrator; }
  window.FENarrator = FENarrator;
});

export { FENarrator, _fnCreateMessage };
