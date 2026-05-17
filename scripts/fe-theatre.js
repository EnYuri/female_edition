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
let _fetPortraitHeight = 350;

// DOM anchors (set in _fetInjectUI / renderChatLog)
let _fetDockEl  = null;   // #fe-stage-dock
let _fetNavEl   = null;   // #fe-stage-nav
let _fetRootEl  = null;   // chat log root element (used for scoped querySelector)

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
    range: { min: 150, max: 700, step: 25 },
    default: 350,
    onChange: (v) => {
      _fetPortraitHeight = v;
      _fetDockEl?.style.setProperty("--fet-portrait-height", `${v}px`);
    },
  });
}

function _fetLoadSettings() {
  _fetHideMessages   = game.settings.get(_FET_MODULE, "stageHideMessages");
  _fetAutoDecay      = game.settings.get(_FET_MODULE, "stageAutoDecay");
  _fetDecayTime      = game.settings.get(_FET_MODULE, "stageDecayTime");
  _fetPortraitHeight = game.settings.get(_FET_MODULE, "stagePortraitHeight");
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
    dock.style.setProperty("--fet-portrait-height", `${_fetPortraitHeight}px`);
    document.body.appendChild(dock);
    _fetDockEl = dock;
  } else {
    _fetDockEl = document.getElementById("fe-stage-dock");
  }

  // Nav bar — inside chat controls, rebuild on every call
  document.getElementById("fe-stage-nav")?.remove();
  const nav = document.createElement("div");
  nav.id = "fe-stage-nav";
  nav.className = "fe-stage-nav";

  const oocBtn = document.createElement("button");
  oocBtn.type = "button";
  oocBtn.className = "fe-stage-nav-ooc";
  oocBtn.title = "자신으로 말하기 (OOC)";
  oocBtn.innerHTML = '<i class="fas fa-user"></i>';
  oocBtn.addEventListener("click", (e) => { e.stopPropagation(); _fetSetSpeakingAs(null); });
  nav.appendChild(oocBtn);

  _fetNavEl = nav;

  // Re-add nav items for inserts that survived a scene change
  for (const insert of _fet.inserts.values()) {
    const navItem = _fetCreateNavItem(insert.theatreId, insert.name, insert.src);
    oocBtn.before(navItem);
    insert.navItem = navItem;
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
  el.appendChild(wrapEl);

  return { el, textboxEl, contentEl, nameEl, imgEl, labelEl };
}

function _fetCreateNavItem(theatreId, name, src) {
  const item = document.createElement("div");
  item.className = "fe-stage-nav-item";
  item.dataset.theatreId = theatreId;
  item.title = name;

  const img = document.createElement("img");
  img.src = src;
  img.alt = name;

  const nameSpan = document.createElement("span");
  nameSpan.textContent = name;

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "fe-stage-nav-remove";
  removeBtn.title = "무대에서 제거";
  removeBtn.innerHTML = '<i class="fas fa-times"></i>';
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    _fetRemoveInsert(theatreId);
  });

  item.append(img, nameSpan, removeBtn);
  item.addEventListener("click", () => _fetSetSpeakingAs(theatreId));
  return item;
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

// Global exposure for macros: fetAddToStage(actorOrId)
globalThis.fetAddToStage = fetAddToStage;

function _fetInjectInsert(theatreId, actorId, name, src, emotes, remote) {
  if (!_fetDockEl || _fet.inserts.has(theatreId)) return;

  const { el, textboxEl, contentEl, nameEl, imgEl, labelEl } =
    _fetCreateInsertEl(theatreId, name, src);
  _fetDockEl.appendChild(el);

  const navItem = _fetCreateNavItem(theatreId, name, src);
  _fetNavEl?.querySelector(".fe-stage-nav-ooc")?.before(navItem);

  const insert = {
    theatreId, actorId, name,
    src, baseSrc: src, emote: null, emotes: emotes ?? {},
    el, textboxEl, contentEl, nameEl, imgEl, labelEl, navItem,
    decayTimeout: null,
  };
  _fet.inserts.set(theatreId, insert);

  // Two rAFs ensure the element is in the DOM before the transition starts
  requestAnimationFrame(() => requestAnimationFrame(() =>
    el.classList.add("fe-stage-insert--visible")
  ));

  if (!remote) {
    _fetSendEvent("enter", { theatreId, actorId, name, src, emotes });
    _fetSetSpeakingAs(theatreId);
  }
}

function _fetRemoveInsert(theatreId, remote = false) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  clearTimeout(insert.decayTimeout);
  insert.cancelTypewriter?.();
  insert.el.classList.remove("fe-stage-insert--visible");
  setTimeout(() => insert.el.remove(), 400);
  insert.navItem.remove();
  _fet.inserts.delete(theatreId);

  if (_fet.speakingAs === theatreId) _fetSetSpeakingAs(null, true);
  if (!remote) _fetSendEvent("exit", { theatreId });
}

function _fetClearAll(remote = false) {
  for (const id of [..._fet.inserts.keys()]) _fetRemoveInsert(id, remote);
}

// ── Speaking-as ────────────────────────────────────────────────────────────

function _fetSetSpeakingAs(theatreId, localOnly = false) {
  _fet.speakingAs = theatreId ?? null;
  _fetUpdateActiveStates();
  if (!localOnly) _fetSendEvent("speakas", { theatreId, userId: game.user.id });
}

function _fetUpdateActiveStates() {
  const tid = _fet.speakingAs;
  _fetNavEl?.querySelectorAll(".fe-stage-nav-item").forEach((el) =>
    el.classList.toggle("active", el.dataset.theatreId === tid)
  );
  _fetNavEl?.querySelector(".fe-stage-nav-ooc")?.classList.toggle("active", !tid);
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
  insert.navItem.querySelector("img").src = src;

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

// ── Text / typewriter ──────────────────────────────────────────────────────

function _fetShowText(theatreId, text, userColor) {
  const insert = _fet.inserts.get(theatreId);
  if (!insert) return;

  clearTimeout(insert.decayTimeout);

  // Mark as last speaker (visual highlight)
  _fetDockEl.querySelectorAll(".fe-stage-insert").forEach((el) =>
    el.classList.remove("fe-stage-insert--last-speaking")
  );
  insert.el.classList.add("fe-stage-insert--last-speaking");

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

  // Auto-decay
  if (_fetAutoDecay) {
    const readTime = _fetDecayTime + text.length * 38;
    insert.decayTimeout = setTimeout(() => {
      insert.textboxEl.classList.remove("fe-stage-textbox--visible");
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

Hooks.on("preCreateChatMessage", (chatMessage, data) => {
  // Skip roll messages — cross-system compat rule mirrors fe-chat-enhance.js
  if (chatMessage.rolls?.length) return;

  const theatreId = _fet.speakingAs;
  const insert    = theatreId ? _fet.inserts.get(theatreId) : null;
  if (!insert) return;

  // V13: CONST.CHAT_MESSAGE_TYPES.IC  |  V14: CONST.CHAT_MESSAGE_STYLES.IC
  const icStyle = CONST.CHAT_MESSAGE_STYLES
    ? { style: CONST.CHAT_MESSAGE_STYLES.IC }
    : { type: CONST.CHAT_MESSAGE_TYPES.IC };

  chatMessage.updateSource({
    speaker: { scene: null, actor: null, token: null, alias: insert.name },
    ...icStyle,
    flags: {
      ...data.flags,
      [_FET_MODULE]: { ...data.flags?.[_FET_MODULE], stageId: theatreId },
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
  insert.labelEl.textContent  = name;
  insert.nameEl.textContent   = name;
  insert.navItem.querySelector("span").textContent = name;
  if (!insert.emote) {
    insert.src = baseSrc;
    insert.imgEl.src                    = baseSrc;
    insert.navItem.querySelector("img").src = baseSrc;
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

Hooks.on("closeSettingsConfig", _fetLoadSettings);

// ── Actor sheet header button ───────────────────────────────────────────────

Hooks.on("renderActorSheet", (app, html) => {
  // v13: html is jQuery; v14: raw HTMLElement; AppV2: html may be inner element
  const el = html instanceof jQuery ? html[0] : (html?.element?.[0] ?? html ?? null);
  if (!(el instanceof HTMLElement)) return;

  const actor = app.actor ?? app.document;
  if (!actor) return;

  // Resolve header buttons area — v13: .header-buttons, v14 AppV2: .window-header-buttons
  const headerButtons =
    el.querySelector(".window-header .header-buttons, .window-header .window-header-buttons") ??
    el.closest(".window-app, .application")
      ?.querySelector(".window-header .header-buttons, .window-header .window-header-buttons");
  if (!headerButtons || headerButtons.querySelector(".fet-stage-btn")) return;

  const btn = document.createElement("a");
  btn.className = "header-button fet-stage-btn";
  btn.title = "무대에 추가 / 발화 전환";
  btn.innerHTML = '<i class="fas fa-theater-masks"></i>';
  btn.addEventListener("click", (e) => { e.preventDefault(); fetAddToStage(actor); });
  headerButtons.prepend(btn);
});
