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
const _FET_RECALL_NON_ACTOR_ID = "__fe-stage-recall-non-actor__";

// ── Runtime state ──────────────────────────────────────────────────────────

const _fet = {
  /** Map<theatreId, insertObj> — all actors currently on stage */
  inserts: new Map(),
  /** local client: theatreId the current user is speaking as, or null (자신으로 말하기), or _FET_NONE (없음) */
  speakingAs: _FET_NONE,
  /** ChatMessage id currently selected by cross-speaker history recall, or null for live mode. */
  recallMessageId: null,
};

// Settings cache — updated on init and on settings close
let _fetEnabled       = false;
let _fetHideMessages  = false;
let _fetRecallIncludeNonActor = false;
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
  game.settings.register(_FET_MODULE, "stageEnabled", {
    name: "무대(Stage) 기능 활성화",
    hint: "활성화 시 채팅 컨트롤에 무대 UI가 표시되고 배우 컨텍스트 메뉴에 무대 항목이 추가됩니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: (v) => {
      _fetEnabled = v;
      if (!v) {
        _fetClearAll(true);
        document.getElementById("fe-stage-nav")?.remove();
        _fetNavEl = null;
        _fetSelectEl = null;
        document.getElementById("fe-stage-dock")?.remove();
        _fetDockEl = null;
        _fetRefreshSheetHeaders();
      } else {
        _fetInjectUI();
        _fetRefreshSheetHeaders();
      }
    },
  });

  game.settings.register(_FET_MODULE, "stageHideMessages", {
    name: "무대 채팅: 채팅 로그에서 숨기기",
    hint: "무대(Stage)에서 발신된 메시지를 채팅 로그에 표시하지 않습니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: (v) => { _fetHideMessages = v; },
  });

  game.settings.register(_FET_MODULE, "stageRecallIncludeNonActor", {
    name: "무대 채팅: 이전 발화에 비액터 메시지 포함",
    hint: "이전 발화 버튼이 액터가 없는 일반/OOC 메시지도 함께 훑습니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: (v) => {
      _fetRecallIncludeNonActor = v;
      if (!v) {
        const insert = _fet.inserts.get(_FET_RECALL_NON_ACTOR_ID);
        if (insert) _fetDismissInsert(insert);
      }
    },
  });

  game.settings.register(_FET_MODULE, "stageAutoDecay", {
    name: "무대 채팅: 대화 상자 자동 소멸",
    hint: "일정 시간 후 대화 상자 텍스트가 자동으로 사라집니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: false,
    onChange: (v) => { _fetAutoDecay = v; },
  });

  game.settings.register(_FET_MODULE, "stageDecayTime", {
    name: "무대 채팅: 대화 상자 소멸 시간 (ms)",
    scope: "world",
    config: false,
    restricted: true,
    type: Number,
    range: { min: 5000, max: 120000, step: 5000 },
    default: 30000,
    onChange: (v) => { _fetDecayTime = v; },
  });

  game.settings.register(_FET_MODULE, "stagePortraitHeight", {
    name: "무대 채팅: 포트레이트 높이 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 50, max: 700, step: 1 },
    default: 318,
    onChange: (v) => {
      _fetPortraitHeight = v;
      _fetApplyBoxVars();
    },
  });

  game.settings.register(_FET_MODULE, "stageBoxWidth", {
    name: "무대 채팅: 대사창 가로 크기 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 200, max: 1600, step: 4 },
    default: 764,
    onChange: (v) => { _fetBoxWidth = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxHeight", {
    name: "무대 채팅: 대사창 세로 크기 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 100, max: 600, step: 4 },
    default: 176,
    onChange: (v) => { _fetBoxHeight = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxBottom", {
    name: "무대 채팅: 화면 하단 여백 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 0, max: 300, step: 2 },
    default: 30,
    onChange: (v) => { _fetBoxBottom = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageBoxLeft", {
    name: "무대 채팅: 화면 좌측 여백 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 0, max: 1200, step: 4 },
    default: 392,
    onChange: (v) => { _fetBoxLeft = v; _fetApplyBoxVars(); },
  });

  game.settings.register(_FET_MODULE, "stageTextSize", {
    name: "무대 채팅: 대사 폰트 크기 (px)",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 10, max: 32, step: 1 },
    default: 14,
    onChange: (v) => { _fetTextSize = v; _fetApplyBoxVars(); },
  });
}

function _fetLoadSettings() {
  _fetEnabled        = game.settings.get(_FET_MODULE, "stageEnabled");
  _fetHideMessages   = game.settings.get(_FET_MODULE, "stageHideMessages");
  _fetRecallIncludeNonActor = game.settings.get(_FET_MODULE, "stageRecallIncludeNonActor");
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
  if (!_fetEnabled) return;
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

  // 우상단 버튼 툴바: [이전 발화 불러오기 <] [닫기 ✕]
  const toolsEl = document.createElement("div");
  toolsEl.className = "fe-stage-textbox-tools";

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "fe-stage-textbox-btn fe-stage-textbox-prev";
  prevBtn.title = "이전 발화 불러오기";
  prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
  prevBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    _fetRecallPrev(theatreId);
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "fe-stage-textbox-btn fe-stage-textbox-close";
  closeBtn.title = "대사창 닫기";
  closeBtn.innerHTML = '<i class="fas fa-times"></i>';
  closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ins = _fet.inserts.get(theatreId);
    if (ins) _fetDismissInsert(ins);
  });

  toolsEl.append(prevBtn, closeBtn);
  textboxEl.append(nameEl, toolsEl, contentEl);
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

function _fetEnsureRecallNonActorInsert() {
  let insert = _fet.inserts.get(_FET_RECALL_NON_ACTOR_ID);
  if (insert) return insert;
  if (!_fetDockEl) return null;

  const { el, textboxEl, contentEl, nameEl, imgEl, labelEl } =
    _fetCreateInsertEl(_FET_RECALL_NON_ACTOR_ID, "메시지", "icons/svg/mystery-man.svg");
  _fetDockEl.appendChild(el);
  insert = {
    theatreId: _FET_RECALL_NON_ACTOR_ID,
    actorId: null,
    name: "메시지",
    src: "icons/svg/mystery-man.svg",
    baseSrc: "icons/svg/mystery-man.svg",
    emote: null,
    emotes: {},
    el, textboxEl, contentEl, nameEl, imgEl, labelEl,
    opt: null,
    recallOnly: true,
    decayTimeout: null,
    hideTimeout: null,
    cancelTypewriter: null,
    currentMessageId: null,
  };
  _fet.inserts.set(_FET_RECALL_NON_ACTOR_ID, insert);
  el.hidden = true;
  return insert;
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
    currentMessageId: null,
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
  if (insert.currentMessageId && insert.currentMessageId === _fet.recallMessageId) {
    _fet.recallMessageId = null;
  }
  insert.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
  setTimeout(() => insert.el.remove(), 400);
  insert.opt?.remove();
  _fet.inserts.delete(theatreId);
  _fetRefreshSheetHeaders();

  if (_fet.speakingAs === theatreId) _fetSetSpeakingAs(null);
  if (!remote) _fetSendEvent("exit", { theatreId });
}

function _fetClearAll(remote = false) {
  for (const id of [..._fet.inserts.keys()]) _fetRemoveInsert(id, remote);
}

// ── Speaking-as ────────────────────────────────────────────────────────────

// speakingAs is purely LOCAL client state — remote clients never need it (the
// stageId travels with each chat message), so this intentionally does not emit.
function _fetSetSpeakingAs(theatreId) {
  if (theatreId && theatreId !== _FET_NONE) {
    const insert = _fet.inserts.get(theatreId);
    if (insert && !_fetCanSpeakAs(insert.actorId)) return; // no owner permission
  }
  _fet.speakingAs = theatreId ?? null;
  _fetUpdateActiveStates();
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
  if (insert.currentMessageId && insert.currentMessageId === _fet.recallMessageId) {
    _fet.recallMessageId = null;
  }
  insert.textboxEl.classList.remove("fe-stage-textbox--visible");
  insert.el.classList.remove("fe-stage-insert--visible", "fe-stage-insert--last-speaking");
  insert.hideTimeout = setTimeout(() => { insert.el.hidden = true; }, 400);
}

// ── Text / typewriter ──────────────────────────────────────────────────────

// 말풍선용 평문 추출. content 를 DOMParser(브라우징 컨텍스트 없음 → 리소스 미로드,
// onerror 미실행)로 textContent 화한다. innerHTML 직접 주입을 피하는 보안 경로.
function _fetPlainTextFromContent(content) {
  return (new DOMParser()
    .parseFromString(String(content ?? ""), "text/html")
    .body.textContent ?? "").trim();
}

// 채팅 로그에 이미 렌더(=정제)된 메시지 본문을 복제한다. 원본 content 문자열을
// innerHTML 로 직접 넣으면 `<img onerror=…>` 등이 실행될 수 있어, Foundry 가 이미
// 렌더한 안전한 DOM 노드를 cloneNode 하는 방식을 쓴다(없으면 null → 평문 폴백).
function _fetGetRenderedContentClone(messageId) {
  if (!messageId) return null;
  let sel;
  try { sel = `[data-message-id="${CSS.escape(messageId)}"] .message-content`; }
  catch { sel = `[data-message-id="${messageId}"] .message-content`; }
  const node = document.querySelector(sel);
  return node ? node.cloneNode(true) : null;
}

// 말풍선에 리치 표시(이미지·표 등)가 필요한지 — 임베드 미디어가 있을 때만 true.
function _fetContentHasMedia(node) {
  return !!node?.querySelector?.("img, video, picture, table");
}

// 미디어가 포함된 메시지면 복제 노드를 말풍선에 그대로 렌더(즉시·스크롤 가능).
function _fetTryRenderRichContent(insert, messageId) {
  const clone = _fetGetRenderedContentClone(messageId);
  if (!clone || !_fetContentHasMedia(clone)) return false;
  insert.cancelTypewriter?.();
  insert.contentEl.textContent = "";
  insert.contentEl.classList.add("fe-stage-textbox-content--rich");
  insert.contentEl.appendChild(clone);
  insert.contentEl.scrollTop = 0;
  return true;
}

function _fetMessageHasStageRecallContent(message) {
  const content = String(message?.content ?? "");
  return _fetPlainTextFromContent(content).length > 0 || /<(?:img|video|picture|table)\b/i.test(content);
}

function _fetRecallTargetForMessage(message) {
  const stageId = message?.flags?.[_FET_MODULE]?.stageId;
  if (stageId && stageId !== _FET_RECALL_NON_ACTOR_ID && _fet.inserts.has(stageId)) {
    return {
      theatreId: stageId,
      displayName: _fet.inserts.get(stageId)?.name,
    };
  }

  const actorId = message?.speaker?.actor;
  if (actorId) {
    const theatreId = _FET_ID_PREFIX + actorId;
    if (_fet.inserts.has(theatreId)) {
      return {
        theatreId,
        displayName: _fet.inserts.get(theatreId)?.name,
      };
    }
    return null;
  }

  if (!_fetRecallIncludeNonActor) return null;
  const insert = _fetEnsureRecallNonActorInsert();
  if (!insert) return null;
  const user = game.users.get(message?.author?.id);
  return {
    theatreId: _FET_RECALL_NON_ACTOR_ID,
    displayName: message?.speaker?.alias || user?.name || "메시지",
  };
}

// 현재 무대에 있는 모든 배우의 발화 타임라인. 필요하면 설정에 따라 액터 없는
// 일반/OOC 메시지도 같은 커서에 포함한다. 굴림 전용·빈 메시지는 제외한다.
function _fetRecallMessages() {
  return (game.messages?.contents ?? [])
    .filter((message) =>
      !message.rolls?.length &&
      !String(message.content ?? "").startsWith("/") &&
      _fetMessageHasStageRecallContent(message))
    .map((message) => ({ message, target: _fetRecallTargetForMessage(message) }))
    .filter(({ target }) => target)
    .sort((a, b) => {
      const dt = (a.message.timestamp ?? 0) - (b.message.timestamp ?? 0);
      if (dt) return dt;
      return String(a.message.id ?? "").localeCompare(String(b.message.id ?? ""));
    });
}

// "<" 버튼: 현재 표시 메시지보다 한 칸 이전(과거)의 발화를 말풍선에 불러온다.
function _fetRecallPrev(theatreId) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;
  const rows = _fetRecallMessages();
  if (!rows.length) return;

  const anchorId = _fet.recallMessageId || insert.currentMessageId;
  const anchorIndex = anchorId ? rows.findIndex((row) => row.message.id === anchorId) : -1;
  const nextIndex = anchorIndex >= 0
    ? Math.max(0, anchorIndex - 1)
    : rows.length - 1;
  const row = rows[nextIndex];
  if (!row) return;

  const msg = row.message;
  _fet.recallMessageId = msg.id ?? null;
  const text = _fetPlainTextFromContent(msg.content);
  const u = game.users.get(msg.author?.id);
  const color = u?.color?.css ?? (typeof u?.color === "string" ? u.color : "");
  _fetShowText(row.target.theatreId, text, color, {
    messageId: msg.id,
    recall: true,
    displayName: row.target.displayName,
  });
}

function _fetShowText(theatreId, text, userColor, opts = {}) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  const recall = !!opts.recall;
  // 새 라이브 발화가 오면 전역 회상 위치 초기화(다시 "<" 누르면 최신부터 거슬러 감).
  if (!recall) _fet.recallMessageId = null;
  // 현재 말풍선이 표시 중인 메시지 id — 지연 rAF 미디어 업그레이드가 그새 도착한
  // 다른 메시지를 덮어쓰지 않도록 식별용으로 기록한다(경쟁 조건 방지).
  insert.currentMessageId = opts.messageId ?? null;

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

  // "Pop" pulse animation on the portrait (회상 탐색 시엔 생략 — 과한 흔들림 방지)
  if (!recall) {
    insert.el.classList.remove("fe-stage-insert--pop");
    void insert.el.offsetWidth; // force reflow to restart animation
    insert.el.classList.add("fe-stage-insert--pop");
  }

  // Show textbox with speaker accent color
  insert.nameEl.textContent = opts.displayName || insert.name;
  insert.textboxEl.classList.add("fe-stage-textbox--visible");
  if (userColor) {
    insert.textboxEl.style.setProperty("--fet-speaker-color", userColor);
  }

  // 본문 — 임베드 미디어가 있으면 리치(복제) 렌더, 없으면 타자기(또는 회상=즉시).
  insert.cancelTypewriter?.();
  insert.contentEl.classList.remove("fe-stage-textbox-content--rich");
  insert.contentEl.textContent = "";
  insert.contentEl.scrollTop = 0;

  const renderedRich = opts.messageId ? _fetTryRenderRichContent(insert, opts.messageId) : false;
  if (!renderedRich) {
    if (recall) {
      insert.contentEl.textContent = text;
    } else {
      insert.cancelTypewriter = _fetTypewriter(insert.contentEl, text);
      // 라이브 메시지는 createChatMessage 시점에 채팅 로그 DOM 이 아직 없을 수
      // 있어, 다음 프레임에 한 번 더 미디어 렌더를 시도한다.
      if (opts.messageId) {
        requestAnimationFrame(() => {
          if (_fet.inserts.get(theatreId) === insert &&
              insert.currentMessageId === opts.messageId &&
              insert.textboxEl.classList.contains("fe-stage-textbox--visible")) {
            _fetTryRenderRichContent(insert, opts.messageId);
          }
        });
      }
    }
  }

  // Auto-decay: hide textbox AND portrait together, then collapse layout space
  // (회상 탐색 중엔 자동 소멸하지 않음 — 천천히 훑어볼 수 있게)
  if (_fetAutoDecay && !recall) {
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
  if (!_fetEnabled) return;

  // "없음" mode: theatre does not modify the message, but GM needs IC-mode bypass.
  // v14 PaC validates speaker.actor in #processChatCommand before preCreateChatMessage.
  // GMs without a canvas token selected have no actor → force OOC to bypass validation.
  if (_fet.speakingAs === _FET_NONE) {
    if (game.user.isGM && _fetNavEl) {
      try {
        if (game.settings.get("core", "messageMode") === "ic") {
          if (!chatData.speaker?.actor && !chatData.speaker?.token) {
            if (CONST.CHAT_MESSAGE_STYLES) chatData.style = CONST.CHAT_MESSAGE_STYLES.OOC;
            else chatData.type = CONST.CHAT_MESSAGE_TYPES.OOC;
          }
        }
      } catch { /* messageMode not registered on v13 — no-op */ }
    }
    return;
  }

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
    } else if (game.user.isGM && _fetNavEl) {
      // GM "자신으로 말하기": no character assigned → force OOC to bypass IC validation.
      try {
        if (game.settings.get("core", "messageMode") === "ic") {
          if (!chatData.speaker?.actor && !chatData.speaker?.token) {
            if (CONST.CHAT_MESSAGE_STYLES) chatData.style = CONST.CHAT_MESSAGE_STYLES.OOC;
            else chatData.type = CONST.CHAT_MESSAGE_TYPES.OOC;
          }
        }
      } catch { /* messageMode not registered on v13 — no-op */ }
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
  if (!_fetEnabled) return;
  // Narrator channel + /as plain-alias own their own speaker — never let stage
  // routing hijack them (flags.female_edition.isNarrator / .plainAlias). fe-narrator.js.
  const _fnFlags = data?.flags?.[_FET_MODULE] ?? chatMessage.flags?.[_FET_MODULE];
  if (_fnFlags?.isNarrator || _fnFlags?.plainAlias) return;
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
    _fetSetSpeakingAs(null);
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
  if (!_fetEnabled) return;
  const theatreId = chatMessage.flags?.[_FET_MODULE]?.stageId;
  if (!theatreId || !_fet.inserts.has(theatreId)) return;

  // Skip roll messages and slash commands; markdown-wrapped HTML is handled by text extraction below
  if (chatMessage.rolls?.length || chatMessage.content?.startsWith("/")) return;

  // Strip HTML → plain text for the speech bubble (DOMParser = inert, no resource
  // load / no onerror execution).
  const text = _fetPlainTextFromContent(chatMessage.content);
  // 평문이 비어도 이미지/표 등 임베드 미디어만 있는 발화는 말풍선을 띄운다
  // (리치 렌더가 다음 프레임에 미디어를 채운다).
  const hasMedia = /<(?:img|video|picture|table)\b/i.test(String(chatMessage.content ?? ""));
  if (!text && !hasMedia) return;

  const _u = game.users.get(chatMessage.author?.id);
  const color = _u?.color?.css ?? (typeof _u?.color === "string" ? _u.color : "");
  _fetShowText(theatreId, text, color, { messageId: chatMessage.id });
});

Hooks.on("renderChatMessageHTML", (chatMessage, html) => {
  if (!_fetEnabled || !_fetHideMessages || !chatMessage.flags?.[_FET_MODULE]?.stageId) return;
  const el = html instanceof jQuery ? html[0] : html;
  el.style.display = "none";
});

Hooks.on("updateActor", (actor, change) => {
  if (!_fetEnabled) return;
  if (!change?.flags?.[_FET_MODULE]?.[_FET_FLAG_KEY]) return;
  const insert = _fet.inserts.get(_FET_ID_PREFIX + actor.id);
  if (!insert) return;
  const { name, src, emotes } = _fetGetActorStageData(actor);
  insert.name    = name;
  insert.emotes  = emotes;
  insert.baseSrc = src;
  insert.labelEl.textContent = name;
  insert.nameEl.textContent  = name;
  if (insert.opt) insert.opt.textContent = name;
  if (!insert.emote) { insert.src = src; insert.imgEl.src = src; }
});

// ── Socket ─────────────────────────────────────────────────────────────────

function _fetSendEvent(event, data = {}) {
  game.socket.emit("module.female_edition", { type: _FET_SOCKET_TYPE, event, ...data });
}

function _fetHandleSocket(payload) {
  if (!_fetEnabled || payload?.type !== _FET_SOCKET_TYPE) return;
  switch (payload.event) {
    case "enter":
      _fetInjectInsert(payload.theatreId, payload.actorId, payload.name, payload.src, payload.emotes, true);
      break;
    case "exit":
      _fetRemoveInsert(payload.theatreId, true);
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
    <div class="fe-stage-config-form">
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
    </div>`;

  // ApplicationV2 DialogV2 (v1 Dialog is deprecated and slated for removal in a
  // future v14). Buttons are an array; callback is (event, button, dialog) and
  // render is (event, dialog). We read inputs via dialog.element (descendant
  // querySelector), so the DialogV2 form wrapper vs our content layout is irrelevant.
  const { DialogV2 } = foundry.applications.api;
  new DialogV2({
    window: { title: `${actor.name} — 무대 설정` },
    position: { width: 580 },
    content,
    buttons: [
      {
        action: "save",
        icon: "fas fa-save",
        label: "저장",
        default: true,
        callback: async (_event, _button, dialog) => {
          await _fetSaveActorConfig(actorId, dialog.element);
        },
      },
      { action: "cancel", icon: "fas fa-times", label: "취소" },
    ],
    render: (_event, dialog) => {
      const root = dialog.element;
      if (!root) return;

      // File picker buttons
      root.addEventListener("click", (e) => {
        const btn = e.target.closest(".fe-pick");
        if (!btn) return;
        const name = btn.dataset.target;
        const input = btn.closest(".form-fields, .form-group")?.querySelector(`[name="${name}"]`);
        const FPClass = foundry.applications.apps?.FilePicker?.implementation
          ?? foundry.applications.apps?.FilePicker
          ?? window.FilePicker;
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
        if (tmp.firstElementChild) list.appendChild(tmp.firstElementChild);
      });
    },
  }).render({ force: true });
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
  // 주의: 여기서 _fetEnabled 로 early-return 하면 안 된다. 디렉터리 컨텍스트
  // 메뉴는 사이드바 최초 렌더(= ready 이전)에 "한 번만"(fixed) 빌드되는데,
  // _fetEnabled 는 ready 의 _fetLoadSettings() 에서야 설정된다. 빌드 시점엔 아직
  // false 라 early-return 하면 항목이 영영 메뉴에 안 들어간다(메뉴는 재빌드 X).
  // → 활성 여부는 각 항목 condition(우클릭마다 재평가, ready 이후)에서 검사한다.
  // Guard against both hooks firing simultaneously (V13 + V14 compat shim)
  if (options.some((o) => o.name === "무대에 추가")) return;

  // 무대 추가/제거 — "편집"(SIDEBAR.Edit) 항목 바로 아래에 끼워 넣는다.
  const stageItems = [
    {
      name: "무대에 추가",
      icon: '<i class="fas fa-theater-masks"></i>',
      condition: (li) => {
        if (!_fetEnabled) return false;
        const id = _fetGetActorIdFromLi(li);
        // 소유 캐릭터에만 노출 (isOwner: GM 은 전체, 플레이어는 본인 소유만)
        if (!id || !game.actors.get(id)?.isOwner) return false;
        return !_fet.inserts.has(_FET_ID_PREFIX + id);
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
        if (!_fetEnabled) return false;
        const id = _fetGetActorIdFromLi(li);
        // 소유 캐릭터에만 노출 (isOwner: GM 은 전체, 플레이어는 본인 소유만)
        if (!id || !game.actors.get(id)?.isOwner) return false;
        return _fet.inserts.has(_FET_ID_PREFIX + id);
      },
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetRemoveInsert(_FET_ID_PREFIX + id);
      },
    },
    // 무대 설정(GM 전용)도 무대 항목 그룹으로 묶어 "편집" 아래에 함께 배치.
    {
      name: "무대 설정",
      icon: '<i class="fas fa-cog"></i>',
      condition: (li) => _fetEnabled && game.user.isGM && !!_fetGetActorIdFromLi(li),
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetOpenActorConfig(id);
      },
    },
  ];

  // 코어 "편집" 항목의 인덱스를 찾는다. v14 코어는 `label: "SIDEBAR.Edit"`(미지역화
  // 키), v13/일부 모듈은 `name`을 쓰고 훅 시점에 이미 지역화돼 있을 수 있어
  // 키·지역화 문자열 양쪽을 모두 매칭한다. 못 찾으면 맨 위로 폴백.
  const editLabel = game.i18n?.localize?.("SIDEBAR.Edit") ?? "편집";
  const isEdit = (o) =>
    o?.label === "SIDEBAR.Edit" || o?.name === "SIDEBAR.Edit" ||
    o?.label === editLabel       || o?.name === editLabel;
  const editIdx = options.findIndex(isEdit);
  options.splice(editIdx >= 0 ? editIdx + 1 : 0, 0, ...stageItems);
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
  if (_fetEnabled && !game.user.isGM) _fetSendEvent("resync");
});

Hooks.on("renderChatLog", (app, html) => {
  // Skip popout chat windows (v13: options.popOut, v14 AppV2: popOut getter, id fallback)
  if (app.options?.popOut === true || app.popOut === true || app.id === "chat-popout") return;

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

// ApplicationV2 sheets already ship their own header-controls dropdown (the
// "⋯" button, `data-action="toggleControls"` — core
// application.mjs `_getHeaderControls()` / `_headerControlButtons()`). Rather
// than building a bespoke dropdown, 무대 설정 is pushed straight into THAT
// menu via the `getHeaderControls{ClassName}` hook chain, which always
// includes the base class name too ("getHeaderControlsApplicationV2" —
// `Application#_callHooks` walks `inheritanceChain()` and fires one hook per
// class, ApplicationV2 last), so this single registration covers every AppV2
// actor sheet regardless of system. v1 sheets (classic FormApplication, e.g.
// DX3rd) have no such menu at all — those keep 무대 설정 as a plain header
// button (see the windowHeader fallback branch in _fetInjectSheetButtons).
function _fetOnGetHeaderControls(app, controls) {
  if (!_fetEnabled || !game.user?.isGM) return;
  const actor = app.actor ?? app.document;
  if (actor?.documentName !== "Actor") return;
  if (actor.type === "female_edition.screenPanel") return;
  controls.push({
    action: "fetStageConfig",
    icon: "fas fa-cog",
    label: "무대 설정",
    onClick: () => _fetOpenActorConfig(actor.id),
  });
}
Hooks.on("getHeaderControlsApplicationV2", _fetOnGetHeaderControls);

function _fetInjectSheetButtons(app, el) {
  if (!_fetEnabled) return;
  const actor = app.actor ?? app.document;
  if (actor?.documentName !== "Actor") return;
  // A screen panel (female_edition.screenPanel) is a display board, not a
  // character — stage add/switch/config buttons here would just be confusing.
  if (actor.type === "female_edition.screenPanel") return;

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
    // Container mode: append in forward visual order, AFTER whatever core/system
    // buttons are already in the container — our injected controls sort last
    // (lower priority than the existing header menu), not first.
    // Final order (left → right): [Foundry 기본 버튼들] [추가/전환] [제거]
    // 무대 설정(GM) lives in the sheet's own native "⋯" controls dropdown
    // instead — see _fetOnGetHeaderControls above.
    if (onStage) {
      headerBtns.append(mkBtn("fet-stage-switch", "fa-comment-dots", "발화 전환",
        () => _fetSetSpeakingAs(theatreId)));
      headerBtns.append(mkBtn("fet-stage-remove", "fa-door-open", "무대에서 제거",
        () => _fetRemoveInsert(theatreId)));
    } else {
      headerBtns.append(mkBtn("fet-stage-add", "fa-theater-masks", "무대에 추가",
        () => fetAddToStage(actor)));
    }
  } else {
    // Header fallback: insert before the close button (forward order, left → right).
    // Final order: [Foundry 기본 버튼들] [추가/전환] [제거] [설정] before [close]
    // AppV2 (dnd5e 5.x) close button is `button[data-action="close"]` (class
    // .header-control), not `.header-button.close`/`.close-window`. Without matching
    // it the buttons were appended AFTER close (to its right). Match all variants.
    // This branch also catches AppV2 sheets that simply lack the dnd5e-style
    // .header-buttons container — those DO have the native "⋯" dropdown (it's
    // part of every ApplicationV2 frame, see application.mjs _renderFrame),
    // so 무대 설정 must NOT be added here too or it would duplicate the
    // _fetOnGetHeaderControls entry. Only genuine v1 sheets (no
    // [data-action="toggleControls"] at all) get the plain fallback button.
    const closeBtn = windowHeader.querySelector('[data-action="close"], .header-control.close-window, .header-button.close');
    const ins = (btn) => closeBtn ? windowHeader.insertBefore(btn, closeBtn) : windowHeader.appendChild(btn);
    const hasNativeControls = !!windowHeader.querySelector('[data-action="toggleControls"]');

    if (onStage) {
      ins(mkBtn("fet-stage-switch", "fa-comment-dots", "발화 전환",
        () => _fetSetSpeakingAs(theatreId)));
      ins(mkBtn("fet-stage-remove", "fa-door-open", "무대에서 제거",
        () => _fetRemoveInsert(theatreId)));
    } else {
      ins(mkBtn("fet-stage-add", "fa-theater-masks", "무대에 추가",
        () => fetAddToStage(actor)));
    }
    if (game.user?.isGM && !hasNativeControls) {
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

// renderActorSheet: v1 sheets (DX3rd). renderActorSheetV2: ApplicationV2 sheets
// (dnd5e 5.x and other modern systems) — the `renderActorSheet` hook does NOT fire
// for those (no `ActorSheet` class in the AppV2 prototype chain), so without the V2
// hook theatre buttons only appeared after a state-change refresh. _fetInjectSheetButtons
// de-dupes its own buttons, so firing both for a system that emits both is harmless.
function _fetOnRenderActorSheet(app, html) {
  const el = _fetResolveEl(app, html);
  if (el instanceof HTMLElement) _fetInjectSheetButtons(app, el);
}
Hooks.on("renderActorSheet",   _fetOnRenderActorSheet);
Hooks.on("renderActorSheetV2", _fetOnRenderActorSheet);
