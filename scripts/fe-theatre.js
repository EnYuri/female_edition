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
 *  - Per-user persisted stage membership
 *  - Optional: hide theatre messages from chat log
 */

import { FE_CONFLICT_FEATURE, feIsConflictFeatureSuppressed } from "./fe-conflict-state.js";

const _FET_MODULE      = "female_edition";
const _FET_ID_PREFIX   = "fes-";          // theatreId prefix: "fes-<actorId>"
const _FET_FLAG_KEY    = "stage";         // actor flag namespace under female_edition
const _FET_USER_STATE_FLAG = "stageUserState";
const _FET_NONE        = "__none__";      // sentinel: theatre nav visible but no overrides applied
const _FET_RECALL_NON_ACTOR_ID = "__fe-stage-recall-non-actor__";

// ── Runtime state ──────────────────────────────────────────────────────────

const _fet = {
  /** Map<theatreId, insertObj> — actors the local user personally added to stage */
  inserts: new Map(),
  /** Map<theatreId, insertObj> — receive-only render targets for other users' stage chat */
  displayInserts: new Map(),
  /** local client: theatreId being spoken as, null for "자신으로 말하기", _FET_NONE for "없음" */
  speakingAs: _FET_NONE,
  /** ChatMessage id currently selected by cross-speaker history recall, or null for live mode. */
  recallMessageId: null,
};

// Settings cache — updated on init and on settings close
let _fetEnabled       = false;
let _fetExcludeSystemMessages = true;
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
let _fetSaveTimer = null;
let _fetSuppressLocalSave = 0;
const _fetPreloadedImages = new Map();
const _FET_PRELOAD_MAX = 256;

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
      _fetEnabled = !!v && !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.STAGE);
      if (!_fetEnabled) {
        _fetClearAll(true);
        document.getElementById("fe-stage-nav")?.remove();
        _fetNavEl = null;
        _fetSelectEl = null;
        document.getElementById("fe-stage-dock")?.remove();
        _fetDockEl = null;
        _fetRefreshSheetHeaders();
      } else {
        _fetInjectUI();
        void _fetRestoreUserState();
        _fetRefreshSheetHeaders();
      }
    },
  });

  game.settings.register(_FET_MODULE, "stageExcludeSystemMessages", {
    name: "무대 채팅: 시스템 메시지 제외",
    hint: "아이템/공격 카드, 이니셔티브, 타 모듈이 생성한 시스템 메시지는 무대 발화로 내보내지 않고 원래 화자 그대로 둡니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: (v) => { _fetExcludeSystemMessages = v; },
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
  _fetEnabled        = game.settings.get(_FET_MODULE, "stageEnabled")
    && !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.STAGE);
  _fetExcludeSystemMessages = game.settings.get(_FET_MODULE, "stageExcludeSystemMessages");
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

// ── Per-user persistence ──────────────────────────────────────────────────

function _fetWorldId() {
  return game.world?.id ?? game.world?.data?.id ?? "world";
}

function _fetLocalStorageKey() {
  return `${_FET_MODULE}.stageUserState.${_fetWorldId()}.${game.user?.id ?? "anonymous"}`;
}

function _fetIsUserStageInsert(insert) {
  return !!insert?.actorId && !insert.recallOnly;
}

function _fetStageActorInserts() {
  return [..._fet.inserts.values()].filter(_fetIsUserStageInsert);
}

function _fetGetDisplayInsert(theatreId) {
  return _fet.inserts.get(theatreId) ?? _fet.displayInserts.get(theatreId) ?? null;
}

function _fetDisplayInsertEntries() {
  const entries = [..._fet.inserts.entries()];
  for (const row of _fet.displayInserts.entries()) {
    if (!_fet.inserts.has(row[0])) entries.push(row);
  }
  return entries;
}

function _fetBuildUserState() {
  const inserts = _fetStageActorInserts()
    .filter((ins) => game.actors?.has?.(ins.actorId))
    .map((ins) => ({
      actorId: ins.actorId,
      emote: ins.emote ?? null,
    }));

  return {
    version: 1,
    worldId: _fetWorldId(),
    userId: game.user?.id ?? null,
    updatedAt: Date.now(),
    // Stage composition is restored, but the active speaker never carries into a new session.
    speakingAs: _FET_NONE,
    inserts,
  };
}

function _fetValidateUserState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  if (state.worldId && state.worldId !== _fetWorldId()) return null;
  if (state.userId && state.userId !== game.user?.id) return null;
  if (!Array.isArray(state.inserts)) return null;
  return state;
}

function _fetReadUserState() {
  let flagState = null;
  try {
    flagState = game.user?.getFlag?.(_FET_MODULE, _FET_USER_STATE_FLAG) ?? null;
  } catch {
    flagState = null;
  }
  flagState = _fetValidateUserState(flagState);

  let localState = null;
  try {
    localState = JSON.parse(localStorage.getItem(_fetLocalStorageKey()) || "null");
  } catch {
    localState = null;
  }
  localState = _fetValidateUserState(localState);

  if (!flagState) return localState;
  if (!localState) return flagState;
  const flagTime = Number(flagState.updatedAt) || 0;
  const localTime = Number(localState.updatedAt) || 0;
  return localTime > flagTime ? localState : flagState;
}

async function _fetSaveUserStateNow() {
  if (_fetSuppressLocalSave > 0) return;
  const state = _fetBuildUserState();
  try {
    localStorage.setItem(_fetLocalStorageKey(), JSON.stringify(state));
  } catch {
    /* localStorage is a fallback only */
  }
  try {
    await game.user?.setFlag?.(_FET_MODULE, _FET_USER_STATE_FLAG, state);
  } catch (err) {
    console.warn("[female_edition] fe-theatre: failed to persist user stage state", err);
  }
}

function _fetScheduleSaveUserState(delay = 80) {
  if (_fetSuppressLocalSave > 0) return;
  try {
    localStorage.setItem(_fetLocalStorageKey(), JSON.stringify(_fetBuildUserState()));
  } catch {
    /* best-effort immediate refresh protection */
  }
  if (_fetSaveTimer) clearTimeout(_fetSaveTimer);
  _fetSaveTimer = setTimeout(() => {
    _fetSaveTimer = null;
    void _fetSaveUserStateNow();
  }, Math.max(0, Number(delay) || 0));
}

async function _fetRestoreUserState() {
  if (!_fetEnabled) return;
  const state = _fetReadUserState();
  if (!state) return;

  _fetSuppressLocalSave++;
  try {
    const seen = new Set();
    for (const row of state.inserts) {
      const actorId = String(row?.actorId ?? "");
      if (!actorId || seen.has(actorId)) continue;
      seen.add(actorId);

      const actor = game.actors?.get?.(actorId);
      if (!actor || !_fetCanSpeakAs(actorId)) continue;

      const theatreId = _FET_ID_PREFIX + actor.id;
      const { name, src, emotes } = _fetGetActorStageData(actor);
      if (_fet.inserts.has(theatreId)) {
        _fetApplyInsertStageData(_fet.inserts.get(theatreId), actor.id, name, src, emotes);
      } else {
        const promoted = _fetPromoteDisplayInsert(theatreId, actor.id, name, src, emotes);
        if (!promoted) _fetInjectInsert(theatreId, actor.id, name, src, emotes, true);
      }
      if (row.emote) _fetSetEmote(theatreId, row.emote, true);
    }

    // The speaker choice is per chat session. Keep the restored stage composition, but do
    // not let the previous session's actor become this login's default speaker.
    _fetSetSpeakingAs(_FET_NONE);
  } finally {
    _fetSuppressLocalSave--;
  }

  _fetUpdateActiveStates();
  _fetRefreshSheetHeaders();
  _fetScheduleSaveUserState(0);
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
    e.preventDefault();
    e.stopPropagation();
    _fetOpenRemoveMenu(removeBtn);
  });

  nav.append(select, emoteBtn, removeBtn);
  _fetNavEl    = nav;
  _fetSelectEl = select;

  // Re-add options + update insert.opt refs for the local user's staged actors
  // that survived a scene change. Receive-only display inserts never enter this
  // dropdown.
  for (const insert of _fetStageActorInserts()) {
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

  // Top-right tool bar: [recall previous <] [close x]
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
    const ins = _fetGetDisplayInsert(theatreId);
    if (ins) _fetDismissInsert(ins);
  });

  toolsEl.append(prevBtn, closeBtn);
  textboxEl.append(nameEl, toolsEl, contentEl);
  el.appendChild(textboxEl);

  // Right-click dismisses the bubble immediately (local only)
  const onDismiss = (e) => {
    e.preventDefault();
    const ins = _fetGetDisplayInsert(theatreId);
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
    if (_fet.inserts.has(theatreId)) _fetOpenEmoteMenu(theatreId, emoteBtn);
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

function _fetResolveStageImage(baseSrc, emotes, emoteName) {
  return (emoteName && emotes?.[emoteName]?.src) ? emotes[emoteName].src : baseSrc;
}

function _fetCollectStageAssetUrls(src, emotes) {
  const urls = new Set();
  const add = (value) => {
    const url = String(value ?? "").trim();
    if (!url || url.startsWith("data:")) return;
    urls.add(url);
  };

  add(src);
  for (const emote of Object.values(emotes ?? {})) {
    if (!emote || typeof emote !== "object") continue;
    add(emote.src);
    add(emote.img);
  }
  return urls;
}

function _fetPreloadImage(url) {
  if (!url || String(url).startsWith("data:")) return;
  if (_fetPreloadedImages.has(url)) return;
  while (_fetPreloadedImages.size >= _FET_PRELOAD_MAX) {
    const oldest = _fetPreloadedImages.keys().next().value;
    _fetPreloadedImages.delete(oldest);
  }

  const img = new Image();
  img.decoding = "async";
  img.src = url;
  _fetPreloadedImages.set(url, img);
}

function _fetPreloadStageAssets(src, emotes) {
  for (const url of _fetCollectStageAssetUrls(src, emotes)) _fetPreloadImage(url);
}

function _fetApplyInsertStageData(insert, actorId, name, src, emotes) {
  _fetPreloadStageAssets(src, emotes);
  insert.actorId = actorId;
  insert.name = name;
  insert.emotes = emotes ?? {};
  insert.baseSrc = src;
  if (insert.emote && !insert.emotes[insert.emote]) insert.emote = null;
  insert.src = _fetResolveStageImage(insert.baseSrc, insert.emotes, insert.emote);
  insert.labelEl.textContent = name;
  insert.nameEl.textContent = name;
  insert.imgEl.alt = name;
  insert.imgEl.src = insert.src;
  if (insert.opt) insert.opt.textContent = name;
}

function _fetAttachStageOption(insert) {
  if (insert.opt || !_fetCanSpeakAs(insert.actorId)) return;
  insert.opt = _fetCreateSelectOption(insert.theatreId, insert.name);
  _fetSelectEl?.appendChild(insert.opt);
}

function _fetPromoteDisplayInsert(theatreId, actorId, name, src, emotes) {
  const insert = _fet.displayInserts.get(theatreId);
  if (!insert) return null;

  _fet.displayInserts.delete(theatreId);
  _fet.inserts.set(theatreId, insert);
  insert.el.classList.remove("fe-stage-insert--display");
  _fetApplyInsertStageData(insert, actorId, name, src, emotes);
  _fetAttachStageOption(insert);
  return insert;
}

/** Public: add actor to stage (called from context menu, macro, or sheet header). */
export function fetAddToStage(actorOrId) {
  const actor = typeof actorOrId === "string" ? game.actors.get(actorOrId) : actorOrId;
  if (!actor) return;
  if (!_fetCanSpeakAs(actor.id)) {
    ui.notifications?.warn?.("이 액터를 무대에 추가할 권한이 없습니다.");
    return;
  }
  const theatreId = _FET_ID_PREFIX + actor.id;
  const { name, src, emotes } = _fetGetActorStageData(actor);
  const existing = _fet.inserts.get(theatreId);
  if (existing) {
    _fetApplyInsertStageData(existing, actor.id, name, src, emotes);
    _fetAttachStageOption(existing);
    _fetScheduleSaveUserState();
    _fetRefreshSheetHeaders();
    return;
  }

  const promoted = _fetPromoteDisplayInsert(theatreId, actor.id, name, src, emotes);
  if (promoted) {
    _fetScheduleSaveUserState();
    _fetRefreshSheetHeaders();
    return;
  }
  _fetInjectInsert(theatreId, actor.id, name, src, emotes, false);
}

// Global exposure for macros/RUI interaction
globalThis.fetAddToStage      = fetAddToStage;
globalThis.fetIsOnStage       = (actorId) => _fetIsUserStageInsert(_fet.inserts.get(_FET_ID_PREFIX + actorId));
globalThis.fetRemoveFromStage = (actorId) => {
  const theatreId = _FET_ID_PREFIX + actorId;
  if (_fetIsUserStageInsert(_fet.inserts.get(theatreId))) _fetRemoveInsert(theatreId);
};
globalThis.fetSetSpeakingAs   = (actorId) => _fetSetSpeakingAs(_FET_ID_PREFIX + actorId);

function _fetInjectInsert(theatreId, actorId, name, src, emotes, remote) {
  if (!_fetDockEl || _fet.inserts.has(theatreId)) return;
  _fetPreloadStageAssets(src, emotes);

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
    _fetScheduleSaveUserState();
  }

  _fetRefreshSheetHeaders();
}

function _fetInjectDisplayInsert(theatreId, actorId, name, src, emotes) {
  const stageInsert = _fet.inserts.get(theatreId);
  if (stageInsert) return stageInsert;

  let insert = _fet.displayInserts.get(theatreId);
  if (insert) {
    _fetApplyInsertStageData(insert, actorId, name, src, emotes);
    return insert;
  }

  if (!_fetDockEl) return null;
  _fetPreloadStageAssets(src, emotes);

  const { el, textboxEl, contentEl, nameEl, imgEl, labelEl } =
    _fetCreateInsertEl(theatreId, name, src);
  el.classList.add("fe-stage-insert--display");
  _fetDockEl.appendChild(el);

  insert = {
    theatreId, actorId, name,
    src, baseSrc: src, emote: null, emotes: emotes ?? {},
    el, textboxEl, contentEl, nameEl, imgEl, labelEl,
    opt: null,
    decayTimeout: null,
    hideTimeout: null,
    currentMessageId: null,
  };
  _fet.displayInserts.set(theatreId, insert);
  el.hidden = true;
  return insert;
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
  insert.el.classList.remove("fe-stage-insert--visible");
  setTimeout(() => insert.el.remove(), 400);
  insert.opt?.remove();
  _fet.inserts.delete(theatreId);
  _fetRefreshSheetHeaders();

  if (_fet.speakingAs === theatreId) _fetSetSpeakingAs(_FET_NONE);
  if (!remote) _fetScheduleSaveUserState();
}

function _fetRemoveDisplayInsert(theatreId) {
  const insert = _fet.displayInserts.get(theatreId);
  if (!insert) return;

  clearTimeout(insert.decayTimeout);
  clearTimeout(insert.hideTimeout);
  insert.cancelTypewriter?.();
  if (insert.currentMessageId && insert.currentMessageId === _fet.recallMessageId) {
    _fet.recallMessageId = null;
  }
  insert.el.classList.remove("fe-stage-insert--visible");
  setTimeout(() => insert.el.remove(), 400);
  _fet.displayInserts.delete(theatreId);
}

function _fetClearAll(remote = false) {
  _fetSuppressLocalSave++;
  try {
    for (const id of [..._fet.inserts.keys()]) _fetRemoveInsert(id, remote);
    for (const id of [..._fet.displayInserts.keys()]) _fetRemoveDisplayInsert(id);
  } finally {
    _fetSuppressLocalSave--;
  }
  if (!remote) _fetScheduleSaveUserState();
}

function _fetClearUserStage() {
  const ids = _fetStageActorInserts().map((ins) => ins.theatreId);
  if (!ids.length) return;

  _fetSuppressLocalSave++;
  try {
    for (const id of ids) _fetRemoveInsert(id, false);
  } finally {
    _fetSuppressLocalSave--;
  }
  if (_fet.speakingAs && _fet.speakingAs !== _FET_NONE && !_fet.inserts.has(_fet.speakingAs)) {
    _fetSetSpeakingAs(_FET_NONE);
  }
  _fetScheduleSaveUserState(0);
}

// ── Speaking-as ────────────────────────────────────────────────────────────

// speakingAs is purely LOCAL client state — remote clients never need it (the
// stageId travels with each chat message), so this intentionally does not emit.
function _fetSetSpeakingAs(theatreId) {
  if (theatreId && theatreId !== _FET_NONE) {
    const insert = _fet.inserts.get(theatreId);
    if (!_fetIsUserStageInsert(insert)) return;
    if (insert && !_fetCanSpeakAs(insert.actorId)) return; // no owner permission
  }
  _fet.speakingAs = theatreId ?? null;
  _fetUpdateActiveStates();
  _fetScheduleSaveUserState();
}

function _fetUpdateActiveStates() {
  const tid      = _fet.speakingAs;
  const hasActor = !!tid && tid !== _FET_NONE;
  const hasStageActors = _fetStageActorInserts().length > 0;

  if (_fetSelectEl) _fetSelectEl.value = tid ?? "";
  _fetNavEl?.querySelector(".fe-stage-nav-emote")?.classList.toggle("hidden", !hasActor);
  _fetNavEl?.querySelector(".fe-stage-nav-remove-cur")?.classList.toggle("hidden", !hasStageActors);

  _fetDockEl?.querySelectorAll(".fe-stage-insert").forEach((el) =>
    el.classList.toggle("fe-stage-insert--speaking", el.dataset.theatreId === tid)
  );
}

function _fetOpenRemoveMenu(anchor) {
  document.querySelector(".fe-stage-remove-menu")?.remove();

  const selectedId = _fet.speakingAs && _fet.speakingAs !== _FET_NONE ? _fet.speakingAs : null;
  const selected = selectedId ? _fet.inserts.get(selectedId) : null;
  const removableSelected = _fetIsUserStageInsert(selected);
  const count = _fetStageActorInserts().length;
  if (!selected && !count) return;

  const menu = document.createElement("div");
  menu.className = "fe-stage-remove-menu";

  const mkItem = (label, icon, onClick, disabled = false) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "fe-stage-remove-item";
    item.disabled = !!disabled;
    const iconEl = document.createElement("i");
    iconEl.className = `fas ${icon}`;
    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    item.append(iconEl, labelEl);
    item.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (item.disabled) return;
      menu.remove();
      onClick();
    });
    return item;
  };

  menu.appendChild(mkItem(
    removableSelected ? `${selected.name} 제거` : "현재 선택 제거",
    "fa-door-open",
    () => { if (selectedId && removableSelected) _fetRemoveInsert(selectedId); },
    !selectedId || !removableSelected,
  ));
  menu.appendChild(mkItem(
    "내 무대 모두 비우기",
    "fa-trash",
    () => _fetClearUserStage(),
    count <= 0,
  ));

  menu.style.visibility = "hidden";
  document.body.appendChild(menu);

  const rect = anchor.getBoundingClientRect();
  const fallbackRect = _fetNavEl?.getBoundingClientRect?.();
  const anchorRect = rect.width || rect.height ? rect : fallbackRect;
  const menuRect = menu.getBoundingClientRect();
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - menuRect.height - 8);
  const left = anchorRect
    ? clamp(anchorRect.right - menuRect.width, 8, maxLeft)
    : maxLeft;
  const top = anchorRect
    ? clamp(anchorRect.top - menuRect.height - 4, 8, maxTop)
    : maxTop;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";

  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 0);
}

// ── Emotion system ─────────────────────────────────────────────────────────

function _fetSetEmote(theatreId, emoteName, remote = false) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  insert.emote = emoteName ?? null;
  const src = _fetResolveStageImage(insert.baseSrc, insert.emotes, insert.emote);
  _fetPreloadImage(src);
  insert.src = src;
  insert.imgEl.src = src;

  if (!remote) _fetScheduleSaveUserState();
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
  insert.el.classList.remove("fe-stage-insert--visible");
  insert.hideTimeout = setTimeout(() => { insert.el.hidden = true; }, 400);
}

// ── Text / typewriter ──────────────────────────────────────────────────────

// Plain text for the bubble. DOMParser has no browsing context, so nothing is fetched and
// no onerror runs — this is the path that avoids injecting raw content as innerHTML.
function _fetPlainTextFromContent(content) {
  return (new DOMParser()
    .parseFromString(String(content ?? ""), "text/html")
    .body.textContent ?? "").trim();
}

// Clone the message body Foundry already rendered (and sanitized) into the chat log.
// Injecting the raw content string as innerHTML could execute `<img onerror=…>`, so we
// cloneNode the safe DOM instead. null when it is not in the log → plain-text fallback.
function _fetGetRenderedContentClone(messageId) {
  if (!messageId) return null;
  let sel;
  try { sel = `[data-message-id="${CSS.escape(messageId)}"] .message-content`; }
  catch { sel = `[data-message-id="${messageId}"] .message-content`; }
  const node = document.querySelector(sel);
  return node ? node.cloneNode(true) : null;
}

// Whether the bubble needs rich rendering — true only when embedded media is present.
function _fetContentHasMedia(node) {
  return !!node?.querySelector?.("img, video, picture, table");
}

// For a message with media, render the cloned node straight into the bubble (immediate,
// scrollable) instead of running the typewriter.
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
  if (stageId && stageId !== _FET_RECALL_NON_ACTOR_ID) {
    const insert = _fetGetDisplayInsert(stageId);
    const actorId = message?.speaker?.actor ??
      (String(stageId).startsWith(_FET_ID_PREFIX) ? String(stageId).slice(_FET_ID_PREFIX.length) : null);
    const actor = actorId ? game.actors?.get?.(actorId) : null;
    const stageData = actor ? _fetGetActorStageData(actor) : null;
    return {
      theatreId: stageId,
      displayName: insert?.name || message?.speaker?.alias || stageData?.name || actor?.name || "무대",
    };
  }

  const actorId = message?.speaker?.actor;
  if (actorId) {
    const theatreId = _FET_ID_PREFIX + actorId;
    // A normal message sent while the stage selector is "없음" has no stageId,
    // but it is still an actor's utterance. Include it in the history and let
    // _fetEnsureMessageDisplayInsert create a receive-only display insert when
    // it is recalled. This never adds the actor to the user's dropdown or
    // persisted stage membership.
    const insert = _fetGetDisplayInsert(theatreId);
    const actor = game.actors?.get?.(actorId);
    const stageData = actor ? _fetGetActorStageData(actor) : null;
    return {
      theatreId,
      displayName: insert?.name || message?.speaker?.alias || stageData?.name || actor?.name || "무대",
    };
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

// One timeline spanning stage lines and ordinary actor lines. Ordinary lines only get a
// receive-only display stage when recalled. Depending on the setting, actor-less plain/OOC
// messages share the same cursor. Roll-only and empty messages are excluded.
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

// The "<" button: load the line one step older than the one currently shown.
function _fetRecallPrev(theatreId) {
  const insert = _fetGetDisplayInsert(theatreId);
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
  if (row.target.theatreId !== _FET_RECALL_NON_ACTOR_ID) {
    _fetEnsureMessageDisplayInsert(msg, row.target.theatreId);
  }
  _fet.recallMessageId = msg.id ?? null;
  const text = _fetPlainTextFromContent(msg.content);
  const u = game.users.get(msg.author?.id);
  const color = u?.color?.css ?? (typeof u?.color === "string" ? u.color : "");
  _fetShowText(row.target.theatreId, text, color, {
    messageId: msg.id,
    recall: true,
    displayName: row.target.displayName,
    portraitSrc: msg.flags?.[_FET_MODULE]?.portraitSrc,
  });
}

function _fetShowText(theatreId, text, userColor, opts = {}) {
  const insert = _fetGetDisplayInsert(theatreId);
  if (!insert) return;

  const recall = !!opts.recall;
  // A new live line resets the recall cursor, so "<" starts from the newest again.
  if (!recall) _fet.recallMessageId = null;
  // Record which message the bubble currently shows, so the deferred rAF media upgrade
  // cannot overwrite a different message that arrived in the meantime.
  insert.currentMessageId = opts.messageId ?? null;

  clearTimeout(insert.decayTimeout);
  clearTimeout(insert.hideTimeout);

  // Fade out and collapse all other inserts after their transition completes
  for (const [tid, other] of _fetDisplayInsertEntries()) {
    if (tid === theatreId) continue;
    clearTimeout(other.hideTimeout);
    other.el.classList.remove("fe-stage-insert--visible");
    other.hideTimeout = setTimeout(() => { other.el.hidden = true; }, 400);
  }

  // Un-collapse this insert before triggering the CSS transition
  if (insert.el.hidden) {
    insert.el.hidden = false;
    insert.el.offsetWidth; // force reflow so transition fires from the initial state
  }
  insert.el.classList.add("fe-stage-insert--visible");

  // "Pop" pulse on the portrait — skipped while recalling, which would be too jittery.
  if (!recall) {
    insert.el.classList.remove("fe-stage-insert--pop");
    void insert.el.offsetWidth; // force reflow to restart animation
    insert.el.classList.add("fe-stage-insert--pop");
  }

  // Show textbox with speaker accent color
  insert.nameEl.textContent = opts.displayName || insert.name;
  insert.imgEl.src = opts.portraitSrc || insert.src;
  insert.textboxEl.classList.add("fe-stage-textbox--visible");
  if (userColor) {
    insert.textboxEl.style.setProperty("--fet-speaker-color", userColor);
  }

  // Body: rich (cloned) render when media is embedded, otherwise typewriter — or instant
  // while recalling.
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
      // At createChatMessage time a live message may not be in the chat log DOM yet, so
      // retry the media render once on the next frame.
      if (opts.messageId) {
        requestAnimationFrame(() => {
          if (_fetGetDisplayInsert(theatreId) === insert &&
              insert.currentMessageId === opts.messageId &&
              insert.textboxEl.classList.contains("fe-stage-textbox--visible")) {
            _fetTryRenderRichContent(insert, opts.messageId);
          }
        });
      }
    }
  }

  // Auto-decay: hide textbox AND portrait together, then collapse layout space
  // Never auto-decays while recalling, so history can be browsed at leisure.
  if (_fetAutoDecay && !recall) {
    const readTime = _fetDecayTime + text.length * 38;
    insert.decayTimeout = setTimeout(() => {
      insert.textboxEl.classList.remove("fe-stage-textbox--visible");
      insert.el.classList.remove("fe-stage-insert--visible");
      insert.hideTimeout = setTimeout(() => { insert.el.hidden = true; }, 400);
    }, readTime);
  }
}

function _fetEnsureMessageDisplayInsert(chatMessage, theatreId) {
  const actorId = chatMessage?.speaker?.actor ??
    (String(theatreId).startsWith(_FET_ID_PREFIX) ? String(theatreId).slice(_FET_ID_PREFIX.length) : null);
  const actor = actorId ? game.actors?.get?.(actorId) : null;
  const stageData = actor ? _fetGetActorStageData(actor) : null;
  const flags = chatMessage?.flags?.[_FET_MODULE] ?? {};
  const name = chatMessage?.speaker?.alias || stageData?.name || actor?.name || "무대";
  const src = flags.portraitSrc || stageData?.src || actor?.img || "icons/svg/mystery-man.svg";
  const emotes = stageData?.emotes ?? {};

  const stageInsert = _fet.inserts.get(theatreId);
  if (stageInsert) return stageInsert;

  let displayInsert = _fet.displayInserts.get(theatreId);
  if (displayInsert) {
    _fetApplyInsertStageData(displayInsert, actorId, name, src, emotes);
    return displayInsert;
  }

  if (!_fetDockEl) _fetInjectUI();
  if (!_fetDockEl) return null;

  return _fetInjectDisplayInsert(theatreId, actorId, name, src, emotes);
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

// A message the user did NOT type as plain chat — an item/attack card, initiative,
// or any system/other-module generated message. Such messages carry either their
// own system/module flags (anything outside core/female_edition) or chat-card HTML
// in their content. When "시스템 메시지 제외" is on we leave these at their original
// speaker instead of overriding them into the active stage actor's speech.
function _fetIsSystemMessage(chatMessage, data) {
  const flags = data?.flags ?? chatMessage.flags ?? {};
  for (const scope of Object.keys(flags)) {
    if (scope === "core" || scope === _FET_MODULE) continue;
    // Any non-empty foreign-scope flag block ⇒ system/module-authored message.
    const block = flags[scope];
    if (block && typeof block === "object" && Object.keys(block).length) return true;
  }
  const content = data?.content ?? chatMessage.content ?? "";
  if (typeof content === "string" && content &&
      /class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b|\bdx3rd-item-chat\b|\bdnd5e2\b)[^"']*["']/i.test(content)) {
    return true;
  }
  return false;
}

Hooks.on("preCreateChatMessage", (chatMessage, data, _options, userId) => {
  if (!_fetEnabled) return;
  // Narrator channel + /as plain-alias own their own speaker — never let stage
  // routing hijack them (flags.female_edition.isNarrator / .plainAlias). fe-narrator.js.
  const _fnFlags = data?.flags?.[_FET_MODULE] ?? chatMessage.flags?.[_FET_MODULE];
  if (_fnFlags?.isNarrator || _fnFlags?.plainAlias) return;
  // Skip roll messages — cross-system compat rule mirrors fe-chat-enhance.js
  if (chatMessage.rolls?.length) return;
  // Skip system/module-authored messages (item cards, initiative, etc.) when enabled,
  // so they aren't rerouted into the active stage actor's speech.
  if (_fetExcludeSystemMessages && _fetIsSystemMessage(chatMessage, data)) return;
  // Only process messages created by the local user
  if (userId && userId !== game.user.id) return;

  const theatreId = _fet.speakingAs;

  // "없음" mode: no theatre overrides — let Foundry resolve speaker naturally
  if (theatreId === _FET_NONE) return;

  const insert = theatreId ? _fet.inserts.get(theatreId) : null;

  if (!insert) {
    if (_fetNavEl) {
      // "자신으로 말하기" is deliberately a user speaker, never the selected
      // canvas token. In IC mode the chatMessage hook may temporarily seed an
      // actor solely for Foundry's pre-create validation; that validation has
      // already completed by this hook. Finish as an explicit OOC message so
      // its presentation is as unambiguously user-spoken as its speaker data.
      const oocStyle = CONST.CHAT_MESSAGE_STYLES
        ? { style: CONST.CHAT_MESSAGE_STYLES.OOC }
        : { type: CONST.CHAT_MESSAGE_TYPES.OOC };
      chatMessage.updateSource({
        speaker: { scene: null, actor: null, token: null, alias: game.user.name },
        ...oocStyle,
      });
    }
    return;
  }

  // Safety net: reset speak-as if user somehow lost owner permission
  if (!_fetCanSpeakAs(insert.actorId)) {
    _fetSetSpeakingAs(_FET_NONE);
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
  if (!theatreId) return;

  // Skip roll messages and slash commands; markdown-wrapped HTML is handled by text extraction below
  if (chatMessage.rolls?.length || chatMessage.content?.startsWith("/")) return;

  // Strip HTML → plain text for the speech bubble (DOMParser = inert, no resource
  // load / no onerror execution).
  const text = _fetPlainTextFromContent(chatMessage.content);
  // Media-only lines (an image or table with no text) still deserve a bubble; the rich
  // render fills it in on the next frame.
  const hasMedia = /<(?:img|video|picture|table)\b/i.test(String(chatMessage.content ?? ""));
  if (!text && !hasMedia) return;
  if (!_fetEnsureMessageDisplayInsert(chatMessage, theatreId)) return;

  const _u = game.users.get(chatMessage.author?.id);
  const color = _u?.color?.css ?? (typeof _u?.color === "string" ? _u.color : "");
  _fetShowText(theatreId, text, color, {
    messageId: chatMessage.id,
    displayName: chatMessage.speaker?.alias,
    portraitSrc: chatMessage.flags?.[_FET_MODULE]?.portraitSrc,
  });
});

Hooks.on("updateActor", (actor, change) => {
  if (!_fetEnabled) return;
  if (!change?.flags?.[_FET_MODULE]?.[_FET_FLAG_KEY]) return;
  const { name, src, emotes } = _fetGetActorStageData(actor);
  for (const insert of [
    _fet.inserts.get(_FET_ID_PREFIX + actor.id),
    _fet.displayInserts.get(_FET_ID_PREFIX + actor.id),
  ]) {
    if (insert) _fetApplyInsertStageData(insert, actor.id, name, src, emotes);
  }
});

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

  // Live-update personal stage and receive-only display inserts if present.
  for (const insert of [
    _fet.inserts.get(_FET_ID_PREFIX + actorId),
    _fet.displayInserts.get(_FET_ID_PREFIX + actorId),
  ]) {
    if (insert) _fetApplyInsertStageData(insert, actorId, name, baseSrc, emotes);
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
  // Do NOT early-return on _fetEnabled here. The directory context menu is built ONCE, at
  // the sidebar's first render (before ready), while _fetEnabled is only assigned in
  // _fetLoadSettings() at ready — so returning early would keep the entries out forever
  // (the menu is never rebuilt). Each entry's own condition, re-evaluated per right-click,
  // is where enablement is checked.
  // Guard against both hooks firing simultaneously (V13 + V14 compat shim)
  if (options.some((o) => o.name === "무대에 추가")) return;

  // Screen panels are display boards, not characters, so they are excluded from the stage
  // entirely — same reason _fetInjectSheetButtons omits their sheet header buttons.
  const _fetActorForMenu = (li) => {
    const id = _fetGetActorIdFromLi(li);
    const actor = id ? game.actors.get(id) : null;
    if (!actor || actor.type === "female_edition.screenPanel") return null;
    return actor;
  };

  // v14 replaced ContextMenuEntry#name/#condition with label/visible (removal slated for
  // v16); v13 reads only name/condition, so fill both. `name` must stay regardless —
  // fe-dx3rd-resource-ui locates this group by matching it.
  const entry = ({ label, icon, visible, callback }) =>
    ({ label, name: label, icon, visible, condition: visible, callback });

  // Stage add/remove, inserted directly below the core "SIDEBAR.Edit" entry.
  const stageItems = [
    entry({
      label: "무대에 추가",
      icon: '<i class="fas fa-theater-masks"></i>',
      visible: (li) => {
        if (!_fetEnabled) return false;
        // Owned actors only — isOwner is everything for a GM, own actors for a player.
        const actor = _fetActorForMenu(li);
        if (!actor?.isOwner) return false;
        return !_fetIsUserStageInsert(_fet.inserts.get(_FET_ID_PREFIX + actor.id));
      },
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) fetAddToStage(id);
      },
    }),
    entry({
      label: "무대에서 제거",
      icon: '<i class="fas fa-door-open"></i>',
      visible: (li) => {
        if (!_fetEnabled) return false;
        // Owned actors only — isOwner is everything for a GM, own actors for a player.
        const actor = _fetActorForMenu(li);
        if (!actor?.isOwner) return false;
        return _fetIsUserStageInsert(_fet.inserts.get(_FET_ID_PREFIX + actor.id));
      },
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetRemoveInsert(_FET_ID_PREFIX + id);
      },
    }),
    // Stage settings joins the same group under Edit, behind the same ownership gate.
    entry({
      label: "무대 설정",
      icon: '<i class="fas fa-cog"></i>',
      visible: (li) => _fetEnabled && !!_fetActorForMenu(li)?.isOwner,
      callback: (li) => {
        const id = _fetGetActorIdFromLi(li);
        if (id) _fetOpenActorConfig(id);
      },
    }),
  ];

  // Find the core Edit entry. v14 uses an unlocalized `label: "SIDEBAR.Edit"`, while v13
  // and some modules use `name` and may already be localized by hook time — so match both
  // the key and the localized string. Falls back to the top when absent.
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
});

// Settings must be loaded BEFORE the sidebar renders. `_fetEnabled` starts false and
// is only ever assigned here, while `_fetInjectUI` bails on `!_fetEnabled` — so if the
// first load happens at `ready`, the renderChatLog hook below has already run and
// injected nothing. Core's order is setup(game.mjs:740) → initializeUI(:764) →
// await canvas.initializing(:776) → ready(:779), so loading at `setup` puts the values
// in place before the chat log renders AND survives a canvas that never finishes
// (measured: a .webm tile in a non-visible tab hangs canvas.draw() forever, so `ready`
// never fires — see feApplyVisualSettingsToDocument in fe-chat-enhance.js).
Hooks.once("setup", () => {
  try { _fetLoadSettings(); } catch { /* no-op */ }
});

Hooks.on("ready", () => {
  _fetLoadSettings();   // re-read: `setup` ran before GM priority was synced
  _fetInjectUI();
  void _fetRestoreUserState();
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

/**
 * Return the Actor directly managed by an Actor sheet, never an owning Actor
 * exposed by some other document sheet. Both core ItemSheet and ItemSheetV2
 * provide `app.actor` for embedded items, so actor-first resolution causes their
 * header controls to be mistaken for Actor-sheet controls.
 */
function _fetGetActorSheetActor(app) {
  const document = app?.document ?? app?.object ?? null;
  return document?.documentName === "Actor" ? document : null;
}

// ApplicationV2 sheets already ship their own header-controls dropdown (the
// "⋯" button, `data-action="toggleControls"` — core
// application.mjs `_getHeaderControls()` / `_headerControlButtons()`). Rather
// than building a bespoke dropdown, "무대 설정" is pushed straight into THAT
// menu via the `getHeaderControls{ClassName}` hook chain, which always
// includes the base class name too ("getHeaderControlsApplicationV2" —
// `Application#_callHooks` walks `inheritanceChain()` and fires one hook per
// class, ApplicationV2 last), so this single registration covers every AppV2
// actor sheet regardless of system. v1 sheets (classic FormApplication, e.g.
// DX3rd) have no such menu at all — those keep "무대 설정" as a plain header
// button (see the windowHeader fallback branch in _fetInjectSheetButtons).
function _fetOnGetHeaderControls(app, controls) {
  if (!_fetEnabled) return;
  const actor = _fetGetActorSheetActor(app);
  // Owners may edit their own actor's stage settings (display name, portrait, emotes).
  // The only write path is actor.setFlag, so core's OWNER permission already suffices.
  if (!actor?.isOwner) return;
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
  const actor = _fetGetActorSheetActor(app);
  if (!actor) return;
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
  const onStage   = _fetIsUserStageInsert(_fet.inserts.get(theatreId));

  const mkBtn = (extraCls, icon, title, onClick) => {
    const btn = document.createElement("a");
    btn.className = `header-button fet-stage-btn ${extraCls}`;
    btn.title = title;
    // Label wrapped in a span so systems that force icon-only round header
    // buttons (dnd5e: .window-header .header-button → 18px grid) can hide the
    // text via CSS instead of letting it wrap and stack the buttons vertically.
    btn.innerHTML = `<i class="fas ${icon}"></i><span class="fet-stage-btn-label"> ${title}</span>`;
    btn.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
    return btn;
  };

  if (headerBtns) {
    // Container mode: append in forward visual order, AFTER whatever core/system
    // buttons are already in the container — our injected controls sort last
    // (lower priority than the existing header menu), not first.
    // Final order (left → right): [core buttons] [add/switch] [remove].
    // "무대 설정" (owners only) lives in the sheet's own native "⋯" controls dropdown
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
    // Final order: [core buttons] [add/switch] [remove] [settings] before [close]
    // AppV2 (dnd5e 5.x) close button is `button[data-action="close"]` (class
    // .header-control), not `.header-button.close`/`.close-window`. Without matching
    // it the buttons were appended AFTER close (to its right). Match all variants.
    // This branch also catches AppV2 sheets that simply lack the dnd5e-style
    // .header-buttons container — those DO have the native "⋯" dropdown (it's
    // part of every ApplicationV2 frame, see application.mjs _renderFrame),
    // so "무대 설정" must NOT be added here too or it would duplicate the
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
    if (actor.isOwner && !hasNativeControls) {
      ins(mkBtn("fet-stage-config", "fa-cog", "무대 설정",
        () => _fetOpenActorConfig(actor.id)));
    }
  }
}

function _fetRefreshSheetHeaders() {
  const process = (app) => {
    if (!_fetGetActorSheetActor(app)) return;
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
