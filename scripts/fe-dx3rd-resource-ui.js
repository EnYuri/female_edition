// fe-dx3rd-resource-ui.js
// 픽셀 테마 자원 UI — 씬 내 가시 토큰(액터) 전체를 고정 패널로 표시.
// 조건: game.system.id === "double-cross-3rd" AND body.fe-dx3rd-pixel-theme
//
// 레이아웃:
//   · 비소유 액터  → #fe-dx3rd-rui-container     : 좌상단 기본, 세로 정렬
//   · 본인 소유 액터 → #fe-dx3rd-rui-container-own : 좌하단 기본, 가로 정렬
//   · 두 컨테이너 모두 드래그로 이동 가능 (위치 localStorage 저장)

import { MODULE_ID, S } from "./fe-constants.js";

const CONTAINER_ID     = "fe-dx3rd-rui-container";
const CONTAINER_OWN_ID = "fe-dx3rd-rui-container-own";
const BTN_ID           = "fe-dx3rd-rui-toggle-btn";
const HIDE_FLAG        = "hideResourceUi";
const VISIBLE_KEY      = `${MODULE_ID}.ruiVisible`;
const POS_KEY          = `${MODULE_ID}.ruiPos`;
const POS_OWN_KEY      = `${MODULE_ID}.ruiOwnPos`;

// ─── guards ────────────────────────────────────────────────────────────────

function _isDx3rd()      { return game.system?.id === "double-cross-3rd"; }
function _isThemeOn()    { return document.body.classList.contains("fe-dx3rd-pixel-theme"); }
function _isGlobalOn()   { return localStorage.getItem(VISIBLE_KEY) !== "false"; }
function _setGlobalOn(v) { localStorage.setItem(VISIBLE_KEY, String(v)); }

function _portraitW() {
  try { return Math.max(32, Number(game.settings.get(MODULE_ID, S.DX3RD_RUI_PORTRAIT_WIDTH)) || 144); }
  catch { return 144; }
}

// ─── actor data ────────────────────────────────────────────────────────────

function _hp(actor) {
  const h = actor?.system?.attributes?.hp;
  if (!h) return null;
  const max = Math.max(Number(h.max) || 0, 1);
  return { value: Math.max(Number(h.value) || 0, 0), max };
}

function _enc(actor) {
  const e = actor?.system?.attributes?.encroachment;
  if (e == null) return null;
  return { value: Math.max(Number(e.value ?? e) || 0, 0), cap: 100 };
}

// ─── ownership ─────────────────────────────────────────────────────────────
// 현재 유저가 해당 액터에 직접 OWNER 권한을 가지는지 확인.
// game.user.isGM는 role 기반 권한이므로 여기서는 명시적 퍼미션만 체크.
// → GM은 false → 비소유(상단 세로 컨테이너)
// → 플레이어 소유 PC는 true → 소유(하단 가로 컨테이너)

function _isOwnedByMe(actor) {
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return (actor.ownership?.[game.user?.id] ?? 0) >= OWNER;
}

// ─── visible actors ────────────────────────────────────────────────────────

function _visibleActors() {
  if (!canvas?.tokens?.placeables) return { owned: [], others: [] };
  const seen = new Set();
  const owned = [], others = [];
  for (const tok of canvas.tokens.placeables) {
    if (tok.document.hidden) continue;
    const actor = tok.actor;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    if (actor.getFlag(MODULE_ID, HIDE_FLAG)) continue;
    (_isOwnedByMe(actor) ? owned : others).push(actor);
  }
  return { owned, others };
}

// ─── position persistence ──────────────────────────────────────────────────

function _loadPos(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function _savePos(key, left, top) {
  try { localStorage.setItem(key, JSON.stringify({ left, top })); } catch {}
}

// ─── drag ──────────────────────────────────────────────────────────────────

function _makeDraggable(container, posKey) {
  const handle = container.querySelector(":scope > .fedr-drag-handle");
  if (!handle) return;

  handle.addEventListener("mousedown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    // bottom/right → top/left 절대 좌표로 전환 (drag 기준점 확정)
    const rect = container.getBoundingClientRect();
    container.style.left   = `${rect.left}px`;
    container.style.top    = `${rect.top}px`;
    container.style.bottom = "";
    container.style.right  = "";

    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;

    const onMove = mv => {
      const left = Math.max(0, Math.min(window.innerWidth  - 20, mv.clientX - ox));
      const top  = Math.max(0, Math.min(window.innerHeight - 20, mv.clientY - oy));
      container.style.left = `${left}px`;
      container.style.top  = `${top}px`;
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      const r = container.getBoundingClientRect();
      _savePos(posKey, Math.round(r.left), Math.round(r.top));
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  });
}

// ─── DOM ───────────────────────────────────────────────────────────────────

function _portraitH(pw) { return Math.round(pw * 296 / 144); }

function _buildCard(actor, pw) {
  const ph = _portraitH(pw);
  const card = document.createElement("div");
  card.className = "fedr-actor-card";
  card.dataset.actorId = actor.id;
  card.style.setProperty("--fedr-pw", `${pw}px`);
  card.style.setProperty("--fedr-ph", `${ph}px`);

  card.innerHTML =
    `<div class="fedr-portrait-wrap">` +
      `<img class="fedr-portrait" draggable="false">` +
    `</div>` +
    `<div class="fedr-panel">` +
      `<div class="fedr-name-row"><span class="fedr-name"></span></div>` +
      `<div class="fedr-bars">` +
        `<div class="fedr-bar-group">` +
          `<div class="fedr-bar fedr-hp"><div class="fedr-fill"></div></div>` +
          `<div class="fedr-label-row">` +
            `<span class="fedr-label-key">HP</span>` +
            `<span class="fedr-label fedr-hp-lbl"></span>` +
          `</div>` +
        `</div>` +
        `<div class="fedr-bar-group">` +
          `<div class="fedr-bar fedr-enc"><div class="fedr-fill"></div></div>` +
          `<div class="fedr-label-row">` +
            `<span class="fedr-label-key">침식률</span>` +
            `<span class="fedr-label fedr-enc-lbl"></span>` +
          `</div>` +
        `</div>` +
      `</div>` +
    `</div>`;
  card.querySelector(".fedr-portrait").setAttribute("src", actor.img ?? "");
  return card;
}

function _updateCard(card, actor) {
  card.querySelector(".fedr-name").textContent = actor.name ?? "";

  const hp = _hp(actor);
  if (hp) {
    const pct = Math.max(0, Math.min(1, (hp.max - hp.value) / hp.max));
    card.querySelector(".fedr-hp .fedr-fill").style.width = `${pct * 100}%`;
    card.querySelector(".fedr-hp-lbl").textContent = `${hp.value}/${hp.max}`;
  }

  const enc = _enc(actor);
  if (enc) {
    const pct = Math.max(0, Math.min(1, enc.value / enc.cap));
    card.querySelector(".fedr-enc .fedr-fill").style.width = `${pct * 100}%`;
    card.querySelector(".fedr-enc-lbl").textContent = `${enc.value}/${enc.cap}`;
  }
}

// ─── container management ──────────────────────────────────────────────────

function _getOrCreateContainer(id, posKey, defaultLeft, defaultTop) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;

    const handle = document.createElement("div");
    handle.className = "fedr-drag-handle";
    el.appendChild(handle);

    document.body.appendChild(el);

    const pos = _loadPos(posKey);
    el.style.left = `${pos?.left ?? defaultLeft}px`;
    el.style.top  = `${pos?.top  ?? defaultTop}px`;

    _makeDraggable(el, posKey);
  }
  return el;
}

function _syncContainerCards(cnt, actors, pw) {
  const live = new Set(actors.map(a => a.id));
  for (const card of [...cnt.querySelectorAll(".fedr-actor-card")]) {
    if (!live.has(card.dataset.actorId)) card.remove();
  }
  for (const actor of actors) {
    let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actor.id}"]`);
    if (!card) {
      card = _buildCard(actor, pw);
      cnt.appendChild(card);
    } else {
      card.style.setProperty("--fedr-pw", `${pw}px`);
      card.style.setProperty("--fedr-ph", `${_portraitH(pw)}px`);
      card.querySelector(".fedr-portrait").src = actor.img ?? "";
    }
    _updateCard(card, actor);
  }
  cnt.style.display = actors.length ? "" : "none";
}

function feRebuildDx3rdResourceUI() {
  if (!_isDx3rd() || !_isThemeOn() || !_isGlobalOn()) {
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(CONTAINER_OWN_ID)?.remove();
    _syncToggleBtn(false);
    return;
  }

  const { owned, others } = _visibleActors();
  const pw = _portraitW();

  // 비소유 액터: 좌상단 기본, 세로 정렬
  const cntOthers = _getOrCreateContainer(CONTAINER_ID, POS_KEY, 8, 8);
  _syncContainerCards(cntOthers, others, pw);

  // 본인 소유 액터: 좌하단 기본, 가로 정렬
  const defaultOwnTop = Math.max(8, window.innerHeight - _portraitH(pw) - 48);
  const cntOwn = _getOrCreateContainer(CONTAINER_OWN_ID, POS_OWN_KEY, 8, defaultOwnTop);
  _syncContainerCards(cntOwn, owned, pw);

  _syncToggleBtn(true);
}

function feUpdateDx3rdResourceUI(actorId) {
  if (!_isDx3rd() || !_isThemeOn() || !_isGlobalOn()) {
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(CONTAINER_OWN_ID)?.remove();
    return;
  }

  const actor = game.actors?.get(actorId);
  if (!actor) return;

  const isOwned = _isOwnedByMe(actor);
  const cntId   = isOwned ? CONTAINER_OWN_ID : CONTAINER_ID;
  const cnt     = document.getElementById(cntId);
  if (!cnt) { feRebuildDx3rdResourceUI(); return; }

  if (actor.getFlag(MODULE_ID, HIDE_FLAG)) {
    cnt.querySelector(`.fedr-actor-card[data-actor-id="${actorId}"]`)?.remove();
    return;
  }
  const hasToken = canvas?.tokens?.placeables?.some(
    t => !t.document.hidden && t.actor?.id === actorId
  );
  if (!hasToken) {
    cnt.querySelector(`.fedr-actor-card[data-actor-id="${actorId}"]`)?.remove();
    return;
  }

  let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actorId}"]`);
  if (!card) {
    card = _buildCard(actor, _portraitW());
    cnt.appendChild(card);
  }
  _updateCard(card, actor);
  cnt.style.display = "";  // 카드 추가 시 숨겨진 컨테이너 복원
}

// ─── chat toggle button ────────────────────────────────────────────────────

function _syncToggleBtn(ruiOn) {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return;
  btn.title = ruiOn ? "자원 UI 숨김 (DX3rd)" : "자원 UI 표시 (DX3rd)";
  btn.classList.toggle("fe-dx3rd-rui-active", ruiOn);
  btn.querySelector("i")?.classList.toggle("fa-eye",       ruiOn);
  btn.querySelector("i")?.classList.toggle("fa-eye-slash", !ruiOn);
}

function _injectChatBtn() {
  if (!_isDx3rd() || !_isThemeOn()) return;
  if (document.getElementById(BTN_ID)) return;

  const controls = document.querySelector("chat-controls, #chat-controls, .chat-controls");
  if (!controls) return;

  const btn = document.createElement("button");
  btn.id        = BTN_ID;
  btn.type      = "button";
  btn.className = "fe-dx3rd-rui-toggle";
  const on = _isGlobalOn();
  btn.title     = on ? "자원 UI 숨김 (DX3rd)" : "자원 UI 표시 (DX3rd)";
  btn.classList.toggle("fe-dx3rd-rui-active", on);
  btn.innerHTML = `<i class="fas ${on ? "fa-eye" : "fa-eye-slash"}"></i>`;
  btn.addEventListener("click", () => {
    _setGlobalOn(!_isGlobalOn());
    feRebuildDx3rdResourceUI();
  });
  controls.prepend(btn);
}

// ─── actor sheet toggle ────────────────────────────────────────────────────

Hooks.on("renderActorSheet", (app, html) => {
  if (!_isDx3rd()) return;
  const actor = app.actor ?? app.document;
  if (!actor) return;

  const root   = html instanceof HTMLElement ? html : (html[0] ?? html);
  const header = root?.querySelector(".window-header");
  if (!header || header.querySelector(".fedr-sheet-toggle")) return;

  const isHidden = !!actor.getFlag(MODULE_ID, HIDE_FLAG);
  const wrap = document.createElement("label");
  wrap.className = "fedr-sheet-toggle";
  wrap.title = "자원 UI 숨김 여부";
  wrap.innerHTML =
    `<input type="checkbox" class="fedr-hide-cb"${isHidden ? " checked" : ""}> 자원UI 숨김`;
  wrap.querySelector(".fedr-hide-cb").addEventListener("change", (e) => {
    actor.setFlag(MODULE_ID, HIDE_FLAG, e.target.checked).then(feRebuildDx3rdResourceUI);
  });
  header.appendChild(wrap);
});

// ─── settings ─────────────────────────────────────────────────────────────

Hooks.on("init", () => {
  if (!_isDx3rd()) return;
  game.settings.register(MODULE_ID, S.DX3RD_RUI_PORTRAIT_WIDTH, {
    name: "[DX3rd] 자원 UI 포트레이트 너비(px)",
    hint: "포트레이트 너비. 높이는 너비×296/144 비율로 자동 계산. 기본 144.",
    scope: "client", config: true, type: Number,
    default: 144,
    range: { min: 32, max: 256, step: 8 },
    onChange: feRebuildDx3rdResourceUI,
  });
});

// ─── Foundry hooks ─────────────────────────────────────────────────────────

Hooks.on("ready", () => {
  if (!_isDx3rd()) return;
  _injectChatBtn();
  feRebuildDx3rdResourceUI();
});

Hooks.on("canvasReady", () => {
  if (!_isDx3rd()) return;
  feRebuildDx3rdResourceUI();
});

Hooks.on("createToken", (doc) => {
  if (!_isDx3rd() || doc.hidden) return;
  feRebuildDx3rdResourceUI();
});
Hooks.on("deleteToken", () => {
  if (_isDx3rd()) feRebuildDx3rdResourceUI();
});
Hooks.on("updateToken", (_doc, change) => {
  if (_isDx3rd() && "hidden" in change) feRebuildDx3rdResourceUI();
});

Hooks.on("updateActor", (actor) => {
  if (_isDx3rd()) feUpdateDx3rdResourceUI(actor.id);
});

Hooks.on("renderChatLog", () => _injectChatBtn());
Hooks.on("renderSidebar",  () => _injectChatBtn());

Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  if (!_isDx3rd()) return;
  _injectChatBtn();
  feRebuildDx3rdResourceUI();
});

export { feRebuildDx3rdResourceUI, feUpdateDx3rdResourceUI };
