/**
 * fe-theatre.js — Portrait stage & speech bubble system
 *
 * Replicates core Theatre Inserts functionality using pure CSS/HTML DOM —
 * no PIXI, no GSAP, no external libs required.
 *
 * Features:
 *  - Add actors to a "stage" via Actor Directory right-click
 *  - Portrait images fixed to the bottom of the screen
 *  - Typewriter speech bubble when speaking as a staged actor
 *  - Per-actor emotion/expression image set (configured via actor flags)
 *  - Multi-user sync over module.female_edition socket
 *  - Optional: hide theatre messages from chat log
 */

const _FET_MODULE      = "female_edition";
const _FET_SOCKET_TYPE = "fe-stage";
const _FET_ID_PREFIX   = "fes-";          // theatreId prefix: "fes-<actorId>"
const _FET_FLAG_KEY    = "stage";         // actor flag namespace under female_edition
const _FET_NONE        = "__none__";      // sentinel: theatre nav visible but no overrides applied

// ── Runtime state ──────────────────────────────────────────────────────────

const _fet = {
  /** Map<theatreId, insertObj> — all actors currently on stage */
  inserts: new Map(),
  /** local client: theatreId the current user is speaking as, or null */
  speakingAs: null,
  /** Map<userId, theatreId> — remote users' speaking selections */
  userSpeaking: new Map(),
};

// Settings cache — updated on init and on settings close
let _fetHideMessages  = false;
let _fetAutoDecay     = true;
let _fetDecayTime     = 30000;
let _fetPortraitHeight = 130;
let _fetBoxWidth      = 488;
let _fetBoxHeight     = 276;
let _fetBoxBottom     = 30;
let _fetBoxLeft       = 266;
let _fetTextSize      = 17;

// DOM anchors (set in _fetInjectUI / renderChatLog)
let _fetDockEl   = null;   // #fe-stage-dock
let _fetNavEl    = null;   // #fe-stage-nav
let _fetSelectEl = null;   // <select> inside #fe-stage-nav
let _fetRootEl   = null;   // chat log root element (used for scoped querySelector)

// ── Settings ───────────────────────────────────────────────────────────────

function _fetRegisterSettings() {
  game.settings.register(_FET_MODULE, "stageHideMessages", {
    name: "무대 채팅: 채팅 로그에서 숨기기",
    hint: "무대(Stage)에서 발신된 메시지를 채팅 로그에 표시하지 않습니다.",
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: (v) => { _fetHideMessages = v; },
  });

  game.settings.register(_FET_MODULE, "stageAutoDecay", {
    name: "무대 채팅: 대화 상자 자동 소멸",
    hint: "일정 시간 후 대화 상자 텍스트가 자동으로 사라집니다.",
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: (v) => { _fetAutoDecay = v; },
  });

  game.settings.register(_FET_MODULE, "stageDecayTime", {
    name: "무대 채팅: 대화 상자 소멸 시간 (ms)",
    scope: "world",
    config: true,
    restricted: true,
    type: Number,
    range: { min: 5000, max: 120000, step: 5000 },
    default: 30000,
    onChange: (v) => { _fetDecayTime = v; },
  });

  game.settings.register(_FET_MODULE, "stagePortraitHeight", {
    name: "무대 채팅: 포트레이트 높이 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 50, max: 700, step: 1 },
    default: 130,
    onChange: (v) => {
      _fetPortraitHeight = v;
      _fetApplyBoxVars();
    },
  });

  game.settings.register(_FET_MODULE, "stageBoxWidth", {
    name: "무대 채팅: 대사창 가로 크기 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 200, max: 1600, step: 4 },
    default: 488,
    onChange: (v) => { _fetBoxWidth = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxHeight", {
    name: "무대 채팅: 대사창 세로 크기 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 100, max: 600, step: 4 },
    default: 276,
    onChange: (v) => { _fetBoxHeight = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxBottom", {
    name: "무대 채팅: 화면 하단 여백 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 300, step: 2 },
    default: 30,
    onChange: (v) => { _fetBoxBottom = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxLeft", {
    name: "무대 채팅: 화면 좌측 여백 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 1200, step: 4 },
    default: 266,
    onChange: (v) => { _fetBoxLeft = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageTextSize", {
    name: "무대 채팅: 대사 폰트 크기 (px)",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 10, max: 32, step: 1 },
    default: 17,
    onChange: (v) => { _fetTextSize = v; _fetApplyBoxVars(); },
  });
}

function _fetLoadSettings() {
  _fetHideMessages   = game.settings.get(_FET_MODULE, "stageHideMessages");
  _fetAutoDecay      = game.settings.get(_FET_MODULE, "stageAutoDecay");
  _fetDecayTime      = game.settings.get(_FET_MODULE, "stageDecayTime");
  _fetPortraitHeight = game.settings.get(_FET_MODULE, "stagePortraitHeight");
  _fetBoxWidth       = game.settings.get(_FET_MODULE, "stageBoxWidth");
  _fetBoxHeight      = game.settings.get(_FET_MODULE, "stageBoxHeight");
  _fetBoxBottom      = game.settings.get(_FET_MODULE, "stageBoxBottom");
  _fetBoxLeft        = game.settings.get(_FET_MODULE, "stageBoxLeft");
  _fetTextSize       = game.settings.get(_FET_MODULE, "stageTextSize");
}

function _fetApplyBoxVars() {
  if (!_fetDockEl) return;
  _fetDockEl.style.setProperty("--fet-portrait-height", `${_fetPortraitHeight}px`);
  _fetDockEl.style.setProperty("--fet-box-width",  `${_fetBoxWidth}px`);
  _fetDockEl.style.setProperty("--fet-box-height", `${_fetBoxHeight}px`);
  _fetDockEl.style.setProperty("--fet-box-bottom", `${_fetBoxBottom}px`);
  _fetDockEl.style.setProperty("--fet-box-left",   `${_fetBoxLeft}px`);
  _fetDockEl.style.setProperty("--fet-text-size",  `${_fetTextSize}px`);
}

/** Returns true if the current user may speak as the given actorId (GM or owner). */
function _fetCanSpeakAs(actorId) {
  if (game.user.isGM) return true;
  const actor = game.actors.get(actorId);
  if (!actor) return false;
  return actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

// ── UI Injection ───────────────────────────────────────────────────────────

/**
 * Idempotent: creates the dock once; rebuilds the nav bar on every renderChatLog
 * (chat HTML is replaced on scene change, dock is appended to body so it persists).
 */
function _fetInjectUI() {
  // Portrait dock — body-level, persists across scene changes
  if (!document.getElementById("fe-stage-dock")) {
    const dock = document.createElement("div");
    dock.id = "fe-stage-dock";
    dock.className = "fe-stage-dock";
    document.body.appendChild(dock);
    _fetDockEl = dock;
    _fetApplyBoxVars();
  } else {
    _fetDockEl = document.getElementById("fe-stage-dock");
    _fetApplyBoxVars();
  }

  // Nav bar — inside chat controls, rebuild on every call
  document.getElementById("fe-stage-nav")?.remove();
  const nav = document.createElement("div");
  nav.id = "fe-stage-nav";
  nav.className = "fe-stage-nav";

  // Speak-as dropdown
  const select = document.createElement("select");
  select.className = "fe-stage-select";
  select.title = "대화 캐릭터 선택";
  const noneOpt = document.createElement("option");
  noneOpt.value = _FET_NONE;
  noneOpt.textContent = "없음";
  select.appendChild(noneOpt);
  const oocOpt = document.createElement("option");
  oocOpt.value = "";
  oocOpt.textContent = "자신으로 말하기";
  select.appendChild(oocOpt);
  select.addEventListener("change", () => {
    const val = select.value;
    _fetSetSpeakingAs(val === _FET_NONE ? _FET_NONE : (val || null));
  });

  // Emote button (visible only when an actor is selected)
  const emoteBtn = document.createElement("button");
  emoteBtn.type = "button";
  emoteBtn.className = "fe-stage-nav-emote hidden";
  emoteBtn.title = "감정 선택";
  emoteBtn.innerHTML = '<i class="fas fa-theater-masks"></i>';
  emoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_fet.speakingAs) _fetOpenEmoteMenu(_fet.speakingAs, emoteBtn);
  });

  // Remove-from-stage button (visible only when an actor is selected)
  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "fe-stage-nav-remove-cur hidden";
  removeBtn.title = "무대에서 제거";
  removeBtn.innerHTML = '<i class="fas fa-door-open"></i>';
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (_fet.speakingAs) _fetRemoveInsert(_fet.speakingAs);
  });

  nav.append(select, emoteBtn, removeBtn);
  _fetNavEl    = nav;
  _fetSelectEl = select;

  // Re-add options + update insert.opt refs for inserts that survived a scene change
  // Only add option if current user has owner permission for that actor
  for (const insert of _fet.inserts.values()) {
    if (!_fetCanSpeakAs(insert.actorId)) { insert.opt = null; continue; }
    const opt = _fetCreateSelectOption(insert.theatreId, insert.name);
    select.appendChild(opt);
    insert.opt = opt;
  }

  // Restore active states
  _fetUpdateActiveStates();

  // V13: #chat-controls / .chat-controls   V14: <chat-controls> custom element
  const chatControls =
    _fetRootEl?.querySelector("chat-controls, #chat-controls, .chat-controls") ??
    document.querySelector("chat-controls, #chat-controls, .chat-controls");
  chatControls?.prepend(nav);
}

// ── Insert DOM builders ────────────────────────────────────────────────────

function _fetCreateInsertEl(theatreId, name, src) {
  const el = document.createElement("div");
  el.className = "fe-stage-insert";
  el.dataset.theatreId = theatreId;

  // Speech bubble (above portrait)
  const textboxEl = document.createElement("div");
  textboxEl.className = "fe-stage-textbox";

  const nameEl = document.createElement("div");
  nameEl.className = "fe-stage-textbox-name";
  nameEl.textContent = name;

  const contentEl = document.createElement("div");
  contentEl.className = "fe-stage-textbox-content";

  textboxEl.append(nameEl, contentEl);
  el.appendChild(textboxEl);

  // 우클릭으로 대사창 즉시 닫기 (로컬 전용)
  const onDismiss = (e) => {
    e.preventDefault();
    const ins = _fet.inserts.get(theatreId);
    if (ins) _fetDismissInsert(ins);
  };
  textboxEl.addEventListener("contextmenu", onDismiss);

  // Portrait area
  const wrapEl = document.createElement("div");
  wrapEl.className = "fe-stage-portrait-wrap";

  const imgEl = document.createElement("img");
  imgEl.className = "fe-stage-portrait";
  imgEl.src = src;
  imgEl.alt = name;
  imgEl.draggable = false;

  const emoteBtn = document.createElement("button");
  emoteBtn.type = "button";
  emoteBtn.className = "fe-stage-emote-btn";
  emoteBtn.title = "감정 선택";
  emoteBtn.innerHTML = '<i class="fas fa-theater-masks"></i>';
  emoteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _fetOpenEmoteMenu(theatreId, emoteBtn);
  });

  const labelEl = document.createElement("div");
  labelEl.className = "fe-stage-label";
  labelEl.textContent = name;

  wrapEl.append(imgEl, emoteBtn, labelEl);
  wrapEl.addEventListener("click", () => _fetSetSpeakingAs(theatreId));
  wrapEl.addEventListener("contextmenu", onDismiss);
  el.appendChild(wrapEl);

  return { el, textboxEl, contentEl, nameEl, imgEl, labelEl };
}

function _fetCreateSelectOption(theatreId, name) {
  const opt = document.createElement("option");
  opt.value = theatreId;
  opt.textContent = name;
  return opt;
}

// ── Stage management ───────────────────────────────────────────────────────

function _fetGetActorStageData(actor) {
  const flags = actor.getFlag?.(_FET_MODULE, _FET_FLAG_KEY) ?? {};
  return {
    name:   flags.name   || actor.name,
    src:    flags.baseSrc || actor.img || "icons/svg/mystery-man.svg",
    emotes: flags.emotes || {},
  };
}

/** Public: add actor to stage (called from context menu, macro, or sheet header). */
export function fetAddToStage(actorOrId) {
  const actor = typeof actorOrId === "string" ? game.actors.get(actorOrId) : actorOrId;
  if (!actor) return;
  const theatreId = _FET_ID_PREFIX + actor.id;
  if (_fet.inserts.has(theatreId)) { _fetSetSpeakingAs(theatreId); return; }
  const { name, src, emotes } = _fetGetActorStageData(actor);
  _fetInjectInsert(theatreId, actor.id, name, src, emotes, false);
}

// Global exposure for macros/RUI interaction
globalThis.fetAddToStage      = fetAddToStage;
globalThis.fetIsOnStage       = (actorId) => _fet.inserts.has(_FET_ID_PREFIX + actorId);
globalThis.fetRemoveFromStage = (actorId) => _fetRemoveInsert(_FET_ID_PREFIX + actorId);
globalThis.fetSetSpeakingAs   = (actorId) => _fetSetSpeakingAs(_FET_ID_PREFIX + actorId);

function _fetInjectInsert(theatreId, actorId, name, src, emotes, remote) {
  if (!_fetDockEl || _fet.inserts.has(theatreId)) return;

  const { el, textboxEl, contentEl, nameEl, imgEl, labelEl } =
    _fetCreateInsertEl(theatreId, name, src);
  _fetDockEl.appendChild(el);

  // Only expose in speak-as dropdown if the local user has owner permission
  const opt = _fetCanSpeakAs(actorId) ? _fetCreateSelectOption(theatreId, name) : null;
  if (opt) _fetSelectEl?.appendChild(opt);

  const insert = {
    theatreId, actorId, name,
    src, baseSrc: src, emote: null, emotes: emotes ?? {},
    el, textboxEl, contentEl, nameEl, imgEl, labelEl, opt,
    decayTimeout: null,
    hideTimeout: null,
  };
  _fet.inserts.set(theatreId, insert);

  // Starts collapsed (no layout space) — expands only when this actor speaks
  el.hidden = true;

  if (!remote) {
    _fetSendEvent("enter", { theatreId, actorId, name, src, emotes });
    _fetSetSpeakingAs(theatreId);
  }

  _fetRefreshSheetHeaders();
}

function _fetRemoveInsert(theatreId, remote = false) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  clearTimeout(insert.decayTimeout);
  clearTimeout(insert.hideTimeout);
  insert.cancelTypewriter?.();
  insert.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
  setTimeout(() => insert.el.remove(), 400);
  insert.opt?.remove();
  _fet.inserts.delete(theatreId);
  _fetRefreshSheetHeaders();

  if (_fet.speakingAs === theatreId) _fetSetSpeakingAs(null, true);
  if (!remote) _fetSendEvent("exit", { theatreId });
}

function _fetClearAll(remote = false) {
  for (const id of [..._fet.inserts.keys()]) _fetRemoveInsert(id, remote);
}

// ── Speaking-as ────────────────────────────────────────────────────────────

function _fetSetSpeakingAs(theatreId, localOnly = false) {
  if (theatreId && theatreId !== _FET_NONE) {
    const insert = _fet.inserts.get(theatreId);
    if (insert && !_fetCanSpeakAs(insert.actorId)) return; // no owner permission
  }
  _fet.speakingAs = theatreId ?? null;
  _fetUpdateActiveStates();
  if (!localOnly) _fetSendEvent("speakas", { theatreId, userId: game.user.id });
}

function _fetUpdateActiveStates() {
  const tid      = _fet.speakingAs;
  const hasActor = !!tid && tid !== _FET_NONE;

  if (_fetSelectEl) _fetSelectEl.value = tid ?? "";
  _fetNavEl?.querySelector(".fe-stage-nav-emote")?.classList.toggle("hidden", !hasActor);
  _fetNavEl?.querySelector(".fe-stage-nav-remove-cur")?.classList.toggle("hidden", !hasActor);

  _fetDockEl?.querySelectorAll(".fe-stage-insert").forEach((el) =>
    el.classList.toggle("fe-stage-insert--speaking", el.dataset.theatreId === tid)
  );
}

// ── Emotion system ─────────────────────────────────────────────────────────

function _fetSetEmote(theatreId, emoteName, remote = false) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  insert.emote = emoteName ?? null;
  const src = (emoteName && insert.emotes[emoteName]?.src)
    ? insert.emotes[emoteName].src
    : insert.baseSrc;
  insert.src = src;
  insert.imgEl.src = src;

  if (!remote) _fetSendEvent("emote", { theatreId, emoteName });
}

function _fetOpenEmoteMenu(theatreId, anchor) {
  document.querySelector(".fe-stage-emote-menu")?.remove();

  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  const menu = document.createElement("div");
  menu.className = "fe-stage-emote-menu";

  const mkItem = (label, iconSrc, onClick, active) => {
    const item = document.createElement("div");
    item.className = "fe-stage-emote-item" + (active ? " active" : "");
    if (iconSrc) {
      const icon = document.createElement("img");
      icon.src = iconSrc;
      item.appendChild(icon);
    }
    const span = document.createElement("span");
    span.textContent = label;
    item.append(span);
    item.addEventListener("click", () => { onClick(); menu.remove(); });
    return item;
  };

  menu.appendChild(mkItem("기본", insert.baseSrc, () => _fetSetEmote(theatreId, null), !insert.emote));
  for (const [key, emote] of Object.entries(insert.emotes)) {
    menu.appendChild(
      mkItem(emote.label || key, emote.img || emote.src || null,
             () => _fetSetEmote(theatreId, key), insert.emote === key)
    );
  }

  const rect = anchor.getBoundingClientRect();
  menu.style.left   = `${rect.left}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;
  document.body.appendChild(menu);

  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

// ── Dismiss (local, right-click) ───────────────────────────────────────────

function _fetDismissInsert(insert) {
  clearTimeout(insert.decayTimeout);
  clearTimeout(insert.hideTimeout);
  insert.cancelTypewriter?.();
  insert.textboxEl.classList.remove("fe-stage-textbox--visible");
  insert.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
  insert.hideTimeout = setTimeout(() => { insert.el.hidden = true; }, 400);
}

// ── Text / typewriter ──────────────────────────────────────────────────────

function _fetShowText(theatreId, text, userColor) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  clearTimeout(insert.decayTimeout);
  clearTimeout(insert.hideTimeout);

  // Fade out and collapse all other inserts after their transition completes
  for (const [tid, other] of _fet.inserts) {
    if (tid === theatreId) continue;
    clearTimeout(other.hideTimeout);
    other.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
    other.hideTimeout = setTimeout(() => { other.el.hidden = true; }, 400);
  }

  // Un-collapse this insert before triggering the CSS transition
  if (insert.el.hidden) {
    insert.el.hidden = false;
    insert.el.offsetWidth; // force reflow so transition fires from the initial state
  }
  insert.el.classList.add("fe-stage-insert--visible", "fe-stage-insert--last-speaking");

  // "Pop" pulse animation on the portrait
  insert.el.classList.remove("fe-stage-insert--pop");
  void insert.el.offsetWidth; // force reflow to restart animation
  insert.el.classList.add("fe-stage-insert--pop");

  // Show textbox with speaker accent color
  insert.textboxEl.classList.add("fe-stage-textbox--visible");
  if (userColor) {
    insert.textboxEl.style.setProperty("--fet-speaker-color", userColor);
  }

  // Typewriter — cancel previous animation before starting a new one
  insert.cancelTypewriter?.();
  insert.contentEl.textContent = "";
  insert.cancelTypewriter = _fetTypewriter(insert.contentEl, text);

  // Auto-decay: hide textbox AND portrait together, then collapse layout space
  if (_fetAutoDecay) {
    const readTime = _fetDecayTime + text.length * 38;
    insert.decayTimeout = setTimeout(() => {
      insert.textboxEl.classList.remove("fe-stage-textbox--visible");
      insert.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
      insert.hideTimeout = setTimeout(() => { insert.el.hidden = true; }, 400);
    }, readTime);
  }
}

function _fetTypewriter(el, text) {
  const chars = [...text]; // unicode-aware split
  let i = 0;
  let handle;
  const step = () => {
    if (i >= chars.length) return;
    el.textContent += chars[i++];
    el.scrollTop = el.scrollHeight;
    handle = setTimeout(step, 38);
  };
  step();
  return () => clearTimeout(handle);
}

// ── Chat hooks ─────────────────────────────────────────────────────────────

// Foundry v14 validates IC-style messages in #processChatCommand *before* preCreateChatMessage
// fires. The check is: if mode === "ic" && !(speaker.actor || speaker.token) → throw.
// getSpeaker() resolves from the canvas token selection, so the theatre actor is unknown.
// Setting chatData.speaker.actor here (in the chatMessage hook, which fires before the
// validation) allows the check to pass. preCreateChatMessage then overwrites speaker and
// style with the full theatre data as usual.
Hooks.on("chatMessage", (_log, _message, chatData) => {
  if (_fet.speakingAs === _FET_NONE) return;

  if (!_fet.speakingAs) {
    // "자신으로 말하기": Foundry v14 PaC (ic mode) validates speaker.actor in
    // #processChatCommand before preCreateChatMessage fires. Pre-seed the character
    // actor here so the ic-mode check passes when the player has an assigned character.
    if (_fetNavEl && !game.user.isGM) {
      const char = game.user.character;
      if (char) {
        try {
          if (game.settings.get("core", "messageMode") === "ic") {
            chatData.speaker ??= {};
            chatData.speaker.actor = char.id;
            chatData.speaker.alias ??= char.name;
          }
        } catch { /* messageMode not registered on v13 — no-op */ }
      }
    }
    return;
  }

  const insert = _fet.inserts.get(_fet.speakingAs);
  if (!insert || !_fetCanSpeakAs(insert.actorId)) return;
  chatData.speaker ??= {};
  chatData.speaker.actor = insert.actorId;
  chatData.speaker.alias ??= insert.name;
});

Hooks.on("preCreateChatMessage", (chatMessage, data, _options, userId) => {
  // Skip roll messages — cross-system compat rule mirrors fe-chat-enhance.js
  if (chatMessage.rolls?.length) return;
  // Only process messages created by the local user
  if (userId && userId !== game.user.id) return;

  const theatreId = _fet.speakingAs;

  // "없음" mode: no theatre overrides — let Foundry resolve speaker naturally
  if (theatreId === _FET_NONE) return;

  const insert = theatreId ? _fet.inserts.get(theatreId) : null;

  if (!insert) {
    if (game.user.isGM && _fetNavEl) {
      // GM: clear actor/token so a canvas token selection doesn't leak through.
      chatMessage.updateSource({
        speaker: { scene: null, actor: null, token: null, alias: game.user.name },
      });
    } else if (!game.user.isGM && _fetNavEl) {
      // Player "자신으로 말하기": when PaC (ic) mode is active, assert character speaker
      // and IC style so the message renders with the character portrait.
      const char = game.user.character;
      if (char) {
        try {
          if (game.settings.get("core", "messageMode") === "ic") {
            const icStyle = CONST.CHAT_MESSAGE_STYLES
              ? { style: CONST.CHAT_MESSAGE_STYLES.IC }
              : { type: CONST.CHAT_MESSAGE_TYPES.IC };
            chatMessage.updateSource({
              speaker: { scene: null, actor: char.id, token: null, alias: char.name },
              ...icStyle,
            });
          }
        } catch { /* messageMode not registered on v13 — no-op */ }
      }
    }
    return;
  }

  // Safety net: reset speak-as if user somehow lost owner permission
  if (!_fetCanSpeakAs(insert.actorId)) {
    _fetSetSpeakingAs(null, true);
    return;
  }

  // V13: CONST.CHAT_MESSAGE_TYPES.IC  |  V14: CONST.CHAT_MESSAGE_STYLES.IC
  const icStyle = CONST.CHAT_MESSAGE_STYLES
    ? { style: CONST.CHAT_MESSAGE_STYLES.IC }
    : { type: CONST.CHAT_MESSAGE_TYPES.IC };

  chatMessage.updateSource({
    // actor ID is set so the sidebar can resolve portrait, chat-portrait, and merge basis
    // portraitSrc stored so fe-chat-portrait uses the stage image (baseSrc/emote) instead of actor.img
    speaker: { scene: null, actor: insert.actorId, token: null, alias: insert.name },
    ...icStyle,
    flags: {
      ...data.flags,
      [_FET_MODULE]: { ...data.flags?.[_FET_MODULE], stageId: theatreId, portraitSrc: insert.src },
    },
  });
});

Hooks.on("createChatMessage", (chatMessage) => {
  const theatreId = chatMessage.flags?.[_FET_MODULE]?.stageId;
  if (!theatreId || !_fet.inserts.has(theatreId)) return;

  // Skip roll messages and slash commands; markdown-wrapped HTML is handled by text extraction below
  if (chatMessage.rolls?.length || chatMessage.content?.startsWith("/")) return;

  // Strip HTML, decode entities
  const tmp = document.createElement("div");
  tmp.innerHTML = chatMessage.content ?? "";
  const text = tmp.textContent?.trim() ?? "";
  if (!text) return;

  const _u = game.users.get(chatMessage.author?.id ?? chatMessage.userId);
  const color = _u?.color?.css ?? (typeof _u?.color === "string" ? _u.color : "") ?? "";
  _fetShowText(theatreId, text, color);
});

Hooks.on("renderChatMessageHTML", (chatMessage, html) => {
  if (!_fetHideMessages || !chatMessage.flags?.[_FET_MODULE]?.stageId) return;
  const el = html instanceof jQuery ? html[0] : html;
  el.style.display = "none";
});

// ── Socket ─────────────────────────────────────────────────────────────────

function _fetSendEvent(event, data = {}) {
  game.socket.emit("module.female_edition", { type: _FET_SOCKET_TYPE, event, ...data });
}

function _fetHandleSocket(payload) {
  if (payload?.type !== _FET_SOCKET_TYPE) return;
  switch (payload.event) {
    case "enter":
      _fetInjectInsert(payload.theatreId, payload.actorId, payload.name, payload.src, payload.emotes, true);
      break;
    case "exit":
      _fetRemoveInsert(payload.theatreId, true);
      break;
    case "speakas":
      _fet.userSpeaking.set(payload.userId, payload.theatreId ?? null);
      break;
    case "emote":
      _fetSetEmote(payload.theatreId, payload.emoteName ?? null, true);
      break;
    case "resync":
      if (game.user.isGM) _fetSendResyncData();
      break;
    case "resyncdata":
      _fetClearAll(true);
      for (const ins of payload.inserts ?? []) {
        _fetInjectInsert(ins.theatreId, ins.actorId, ins.name, ins.src, ins.emotes, true);
        if (ins.emote) _fetSetEmote(ins.theatreId, ins.emote, true);
      }
      _fet.userSpeaking = new Map(Object.entries(payload.speakingBy ?? {}));
      break;
  }
}

function _fetSendResyncData() {
  const inserts = [..._fet.inserts.values()].map((ins) => ({
    theatreId: ins.theatreId, actorId: ins.actorId,
    name: ins.name, src: ins.src, emotes: ins.emotes, emote: ins.emote,
  }));
  game.socket.emit("module.female_edition", {
    type: _FET_SOCKET_TYPE,
    event: "resyncdata",
    inserts,
    speakingBy: Object.fromEntries(_fet.userSpeaking),
  });
}

// ── Actor config dialog ────────────────────────────────────────────────────

async function _fetOpenActorConfig(actorId) {
  const actor = game.actors.get(actorId);
  if (!actor) return;

  // Reload fresh flags each open
  const flags = actor.getFlag(_FET_MODULE, _FET_FLAG_KEY) ?? {};

  const buildEmoteRow = (key = "", emote = {}) => `
    <div class="fe-config-emote-row">
      <input type="text" name="emoteKey"   placeholder="키(영문)" value="${_fetEsc(key)}">
      <input type="text" name="emoteLabel" placeholder="레이블"   value="${_fetEsc(emote.label ?? "")}">
      <div class="form-fields">
        <input type="text" name="emoteImg" placeholder="아이콘 경로" value="${_fetEsc(emote.img ?? "")}">
        <button type="button" class="fe-pick" data-target="emoteImg" title="파일 선택"><i class="fas fa-file-import"></i></button>
      </div>
      <div class="form-fields">
        <input type="text" name="emoteSrc" placeholder="포트레이트 경로" value="${_fetEsc(emote.src ?? "")}">
        <button type="button" class="fe-pick" data-target="emoteSrc" title="파일 선택"><i class="fas fa-file-import"></i></button>
      </div>
      <button type="button" class="fe-remove-emote" title="제거"><i class="fas fa-trash"></i></button>
    </div>`;

  const existingRows = Object.entries(flags.emotes ?? {})
    .map(([k, v]) => buildEmoteRow(k, v)).join("");

  const content = `
    <form class="fe-stage-config-form">
      <div class="form-group">
        <label>표시 이름</label>
        <input type="text" name="stageName" value="${_fetEsc(flags.name ?? actor.name)}">
      </div>
      <div class="form-group">
        <label>기본 포트레이트</label>
        <div class="form-fields">
          <input type="text" name="stageBaseSrc" value="${_fetEsc(flags.baseSrc ?? actor.img ?? "")}">
          <button type="button" class="fe-pick" data-target="stageBaseSrc" title="파일 선택"><i class="fas fa-file-import"></i></button>
        </div>
      </div>
      <div class="form-group-stacked">
        <label>감정 표정 <small>(키: 영문 식별자, 아이콘: 선택사항)</small></label>
        <div class="fe-config-emotes-list">${existingRows}</div>
        <button type="button" class="fe-add-emote"><i class="fas fa-plus"></i> 감정 추가</button>
      </div>
    </form>`;

  new Dialog({
    title: `${actor.name} — 무대 설정`,
    content,
    buttons: {
      save: {
        icon:  '<i class="fas fa-save"></i>',
        label: "저장",
        callback: async (html) => {
          const root = html instanceof jQuery ? html[0] : html;
          await _fetSaveActorConfig(actorId, root);
        },
      },
      cancel: { icon: '<i class="fas fa-times"></i>', label: "취소" },
    },
    default: "save",
    render: (html) => {
      const root = html instanceof jQuery ? html[0] : html;

      // File picker buttons
      root.addEventListener("click", (e) => {
        const btn = e.target.closest(".fe-pick");
        if (!btn) return;
        const name = btn.dataset.target;
        const input = btn.closest(".form-fields, .form-group")?.querySelector(`[name="${name}"]`);
        const FPClass = foundry.applications.apps?.FilePicker ?? window.FilePicker;
        if (FPClass) new FPClass({ type: "imagevideo", callback: (path) => { if (input) input.value = path; } }).render(true);
      });

      // Remove emote row
      root.addEventListener("click", (e) => {
        if (e.target.closest(".fe-remove-emote")) {
          e.target.closest(".fe-config-emote-row")?.remove();
        }
      });

      // Add emote row
      root.querySelector(".fe-add-emote")?.addEventListener("click", () => {
        const list = root.querySelector(".fe-config-emotes-list");
        const tmp = document.createElement("div");
        tmp.innerHTML = buildEmoteRow();
        list.appendChild(tmp.firstElementChild);
      });
    },
  }, { width: 580 }).render(true);
}

async function _fetSaveActorConfig(actorId, root) {
  const actor = game.actors.get(actorId);
  if (!actor) return;

  const name    = root.querySelector('[name="stageName"]')?.value?.trim()    || actor.name;
  const baseSrc = root.querySelector('[name="stageBaseSrc"]')?.value?.trim() || actor.img || "";

  const emotes = {};
  for (const row of root.querySelectorAll(".fe-config-emote-row")) {
    const key = row.querySelector('[name="emoteKey"]')?.value?.trim();
    if (!key) continue;
    emotes[key] = {
      label: row.querySelector('[name="emoteLabel"]')?.value?.trim() || key,
      img:   row.querySelector('[name="emoteImg"]')?.value?.trim()   || "",
      src:   row.querySelector('[name="emoteSrc"]')?.value?.trim()   || "",
    };
  }

  await actor.setFlag(_FET_MODULE, _FET_FLAG_KEY, { name, baseSrc, emotes });

  // Live-update the insert if actor is currently on stage
  const insert = _fet.inserts.get(_FET_ID_PREFIX + actorId);
  if (!insert) return;

  insert.name   = name;
  insert.emotes = emotes;
  insert.baseSrc = baseSrc;
  insert.labelEl.textContent = name;
  insert.nameEl.textContent  = name;
  if (insert.opt) insert.opt.textContent = name;
  if (!insert.emote) {
    insert.src = baseSrc;
    insert.imgEl.src = baseSrc;
  }
}

/** HTML-escape helper for template strings */
function _fetEsc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Actor Directory context menu ───────────────────────────────────────────

/**
 * Extract actor ID from a context-menu target <li>.
 * V13: li may be a jQuery object; actor ID in data-actor-id.
 * V14: li is a raw HTMLElement; actor ID in data-document-id or data-entry-id.
 */
function _fetGetActorIdFromLi(li) {
  const el = li instanceof jQuery ? li[0] : li;
  return (
    el?.dataset?.documentId ??  // V14 AppV2 directory
    el?.dataset?.entryId    ??  // V14 alternate
    el?.dataset?.actorId        // V13
  );
}

function _fetRegisterContextOptions(_html, options) {
  // Guard against both hooks firing simultaneously (V13 + V14 compat shim)
  if (options.some((o) => o.name === "무대에 추가")) return;

  options.push(
    {
      name: "무대에 추가",
      icon: '<i class="fas fa-theater-masks"></i>',
      condition: (li) => {
        const id = _fetGetActorIdFromLi(li);
        return !!id && !_fet.inserts.has(_FET_ID_PREFIX + id);
      },
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) fetAddToStage(id);
      },
    },
    {
      name: "무대에서 제거",
      icon: '<i class="fas fa-door-open"></i>',
      condition: (li) => {
        const id = _fetGetActorIdFromLi(li);
        return !!id && _fet.inserts.has(_FET_ID_PREFIX + id);
      },
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetRemoveInsert(_FET_ID_PREFIX + id);
      },
    },
    {
      name: "무대 설정",
      icon: '<i class="fas fa-cog"></i>',
      condition: (li) => game.user.isGM && !!_fetGetActorIdFromLi(li),
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetOpenActorConfig(id);
      },
    }
  );
}

// V13 hook name
Hooks.on("getActorContextOptions", _fetRegisterContextOptions);
// V14 hook name (AppV2 directory — both may fire; guard above prevents duplicates)
Hooks.on("getActorContextMenuOptions", _fetRegisterContextOptions);

// ── Foundry Hooks ──────────────────────────────────────────────────────────

Hooks.on("init", () => {
  _fetRegisterSettings();
  game.socket.on("module.female_edition", _fetHandleSocket);
});

Hooks.on("ready", () => {
  _fetLoadSettings();   // world-scoped settings are only reliable here
  _fetInjectUI();
  if (!game.user.isGM) _fetSendEvent("resync");
});

Hooks.on("renderChatLog", (app, html) => {
  // Skip popout chat windows
  if (app.options?.popOut === true || app.id === "chat-popout") return;

  // v13: html is jQuery; v14 AppV2: html is raw HTMLElement
  const raw = html instanceof jQuery ? html[0] : (html?.element?.[0] ?? html ?? null);
  _fetRootEl = raw instanceof HTMLElement ? raw : null;

  _fetInjectUI();
});

Hooks.on("closeSettingsConfig", () => { _fetLoadSettings(); _fetApplyBoxVars(); });

// ── Actor sheet header buttons ─────────────────────────────────────────────

function _fetResolveEl(app, html) {
  if (html instanceof HTMLElement) return html;
  if (typeof jQuery !== "undefined" && html instanceof jQuery) return html[0] ?? null;
  return html?.element?.[0] ?? null;
}

function _fetInjectSheetButtons(app, el) {
  const actor = app.actor ?? app.document;
  if (actor?.documentName !== "Actor") return;

  const root = el.closest?.(".window-app, .application") ?? el;

  // Preferred: explicit header-buttons container (dnd5e / some systems)
  const headerBtns =
    el.querySelector(".window-header .header-buttons, .window-header .window-header-buttons") ??
    root.querySelector(".window-header .header-buttons, .window-header .window-header-buttons");

  // Fallback: standard Application v1 layout — buttons are direct children of .window-header
  const windowHeader = !headerBtns
    ? (el.querySelector(".window-header") ?? root.querySelector(".window-header"))
    : null;

  const target = headerBtns ?? windowHeader;
  if (!target) return;

  target.querySelectorAll(".fet-stage-btn").forEach((b) => b.remove());

  const theatreId = _FET_ID_PREFIX + actor.id;
  const onStage   = _fet.inserts.has(theatreId);

  const mkBtn = (extraCls, icon, title, onClick) => {
    const btn = document.createElement("a");
    btn.className = `header-button fet-stage-btn ${extraCls}`;
    btn.title = title;
    btn.innerHTML = `<i class="fas ${icon}"></i> ${title}`;
    btn.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
    return btn;
  };

  if (headerBtns) {
    // Container mode: prepend in reverse visual order.
    // Final order (left → right): [추가/전환] [제거] [설정] [Foundry 기본 버튼들]
    if (game.user?.isGM) {
      headerBtns.prepend(mkBtn("fet-stage-config", "fa-cog", "무대 설정",
        () => _fetOpenActorConfig(actor.id)));
    }
    if (onStage) {
      headerBtns.prepend(mkBtn("fet-stage-remove", "fa-door-open", "무대에서 제거",
        () => _fetRemoveInsert(theatreId)));
      headerBtns.prepend(mkBtn("fet-stage-switch", "fa-comment-dots", "발화 전환",
        () => _fetSetSpeakingAs(theatreId)));
    } else {
      headerBtns.prepend(mkBtn("fet-stage-add", "fa-theater-masks", "무대에 추가",
        () => fetAddToStage(actor)));
    }
  } else {
    // Header fallback: insert before the close button (forward order, left → right).
    // Final order: [추가/전환] [제거] [설정] before [close]
    const closeBtn = windowHeader.querySelector(".header-button.close, .header-control.close-window");
    const ins = (btn) => closeBtn ? windowHeader.insertBefore(btn, closeBtn) : windowHeader.appendChild(btn);

    if (onStage) {
      ins(mkBtn("fet-stage-switch", "fa-comment-dots", "발화 전환",
        () => _fetSetSpeakingAs(theatreId)));
      ins(mkBtn("fet-stage-remove", "fa-door-open", "무대에서 제거",
        () => _fetRemoveInsert(theatreId)));
    } else {
      ins(mkBtn("fet-stage-add", "fa-theater-masks", "무대에 추가",
        () => fetAddToStage(actor)));
    }
    if (game.user?.isGM) {
      ins(mkBtn("fet-stage-config", "fa-cog", "무대 설정",
        () => _fetOpenActorConfig(actor.id)));
    }
  }
}

function _fetRefreshSheetHeaders() {
  const process = (app) => {
    if ((app.actor ?? app.document)?.documentName !== "Actor") return;
    const raw = app.element;
    const el  = raw instanceof HTMLElement ? raw : (raw?.[0] ?? null);
    if (el && document.contains(el)) _fetInjectSheetButtons(app, el);
  };
  for (const app of Object.values(ui.windows ?? {})) process(app);
  try {
    for (const app of (foundry.applications?.instances?.values?.() ?? [])) process(app);
  } catch { /* noop */ }
}

Hooks.on("renderActorSheet", (app, html) => {
  const el = _fetResolveEl(app, html);
  if (el instanceof HTMLElement) _fetInjectSheetButtons(app, el);
});
