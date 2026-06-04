// fe-dx3rd-resource-ui.js
// 픽셀 테마 캐릭터 스테이터스 — 시트 헤더/컨텍스트 메뉴로 직접 핀한 액터를 패널로 표시.
// 토큰 존재 여부와 완전히 무관.
//
// 카드 존재: 액터에 SHOW_FLAG가 있는 경우만 (시트 헤더·컨텍스트 메뉴로 토글).
// 채팅 토글: 전체 가시성 on/off — 카드 DOM은 유지하고 display만 변경.
//
// 레이아웃:
//   · PC 외 액터(enemy 등) → #fe-dx3rd-rui-container     : 좌측 기본(left:8px), 세로 정렬
//        - 기본 top은 PC 스테이터스(우상단) 바로 아래 높이 (_npcDefaultTop), PC 없으면 nav 아래
//   · PC 액터(character)   → #fe-dx3rd-rui-container-own : 우상단 기본, 가로 정렬
//   · 두 컨테이너 모두 드래그로 이동 가능 (위치 localStorage 저장)

import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";

// hex → { h: 0-360, s: 0-1 }. 무채색(s≈0)이면 h=0.
function _hexToHs(hex) {
  hex = String(hex).replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { h: 0, s: 0 };
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return { h: h * 360, s };
}

const CONTAINER_ID     = "fe-dx3rd-rui-container";
const CONTAINER_OWN_ID = "fe-dx3rd-rui-container-own";
const BTN_ID           = "fe-dx3rd-rui-toggle-btn";
const ACCENT_BTN_ID    = "fe-dx3rd-accent-btn";
const SHOW_FLAG        = "showInResourceUi"; // 이 플래그가 있으면 → RUI에 표시 (토큰 무관)
const MASK_FLAG        = "maskResourceValues"; // 수치 값을 ??로 숨김
const VISIBLE_KEY      = `${MODULE_ID}.ruiVisible2`;
const POS_KEY          = `${MODULE_ID}.ruiPos`;
const POS_OWN_KEY      = `${MODULE_ID}.ruiOwnPos`;

// ─── guards ────────────────────────────────────────────────────────────────

function _isDx3rd()      { return game.system?.id === "double-cross-3rd"; }
function _isThemeOn()    { return document.body.classList.contains("fe-dx3rd-pixel-theme"); }
function _isGlobalOn()   { const v = localStorage.getItem(VISIBLE_KEY); return v === null ? false : v === "true"; }
function _setGlobalOn(v) { localStorage.setItem(VISIBLE_KEY, String(v)); }

function _portraitW() {
  try { return Math.max(32, Number(feSetting(S.DX3RD_RUI_PORTRAIT_WIDTH)) || 98); }
  catch { return 98; }
}

function _panelW() {
  try { return Math.max(60, Number(feSetting(S.DX3RD_RUI_PANEL_WIDTH)) || 110); }
  catch { return 110; }
}

function _cardH() {
  try { return Math.max(32, Number(feSetting(S.DX3RD_RUI_CARD_HEIGHT)) || 80); }
  catch { return 80; }
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

// ─── actor type ────────────────────────────────────────────────────────────
// DX3rd actor.system.actorType: "PlayerCharacter" | "Enemy" | "NPC" | "Ally" | "Troop"
// PlayerCharacter → 우상단 가로 컨테이너 / 그 외 → 좌상단 세로 컨테이너.

function _isPC(actor) {
  return actor.system?.actorType === "PlayerCharacter";
}

// ─── pinned actors ─────────────────────────────────────────────────────────
// 토큰 존재 여부 무관 — SHOW_FLAG가 설정된 액터만 포함.

function _pinnedActors() {
  if (!game.actors) return { pcs: [], enemies: [] };
  const pcs = [], enemies = [];
  for (const actor of game.actors) {
    if (!actor.getFlag(MODULE_ID, SHOW_FLAG)) continue;
    (_isPC(actor) ? pcs : enemies).push(actor);
  }
  return { pcs, enemies };
}

function _isActorPinned(actor) {
  return !!actor.getFlag(MODULE_ID, SHOW_FLAG);
}

function _isMasked(actor) {
  return !!actor.getFlag(MODULE_ID, MASK_FLAG);
}

function _toggleActorMask(actor) {
  if (!actor.isOwner) return;
  if (_isMasked(actor)) actor.unsetFlag(MODULE_ID, MASK_FLAG);
  else actor.setFlag(MODULE_ID, MASK_FLAG, true);
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
// 컨테이너 자체를 드래그 가능하게 만든다.
// 카드에서 mousedown이 버블업되면 5px 임계값 이후 드래그로 전환.
// 임계값 미만은 일반 클릭으로 처리 (카드 상호작용 보존).

function _makeDraggable(container, posKey) {
  let dragging = false;
  let wasDragging = false;

  container.addEventListener("mousedown", e => {
    if (e.button !== 0) return;

    const rect = container.getBoundingClientRect();
    const ox = e.clientX - rect.left;
    const oy = e.clientY - rect.top;
    const startX = e.clientX;
    const startY = e.clientY;
    dragging = false;

    const onMove = mv => {
      if (!dragging) {
        if (Math.hypot(mv.clientX - startX, mv.clientY - startY) < 5) return;
        dragging = true;
        container.style.left   = `${rect.left}px`;
        container.style.top    = `${rect.top}px`;
        container.style.bottom = "";
        container.style.right  = "";
        document.body.style.cursor = "grabbing";
      }
      mv.preventDefault();
      mv.stopPropagation();
      container.style.left = `${Math.max(0, Math.min(window.innerWidth  - 20, mv.clientX - ox))}px`;
      container.style.top  = `${Math.max(0, Math.min(window.innerHeight - 20, mv.clientY - oy))}px`;
    };

    const onUp = up => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup",   onUp,   true);
      document.body.style.cursor = "";
      if (dragging) {
        up.stopPropagation();
        const r = container.getBoundingClientRect();
        _savePos(posKey, Math.round(r.left), Math.round(r.top));
        wasDragging = true;
      }
      dragging = false;
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("mouseup",   onUp,   true);
  });

  // 드래그 직후 발생하는 click 억제 (카드 클릭 오작동 방지)
  container.addEventListener("click", e => {
    if (wasDragging) { e.stopPropagation(); e.preventDefault(); wasDragging = false; }
  }, true);
}

// ─── card context menu ────────────────────────────────────────────────────

function _showCardContextMenu(actor, e) {
  e.preventDefault();
  e.stopPropagation();

  document.querySelector(".fedr-ctx-menu")?.remove();

  const onStage = !!globalThis.fetIsOnStage?.(actor.id);
  const pinned  = _isActorPinned(actor);
  const masked  = _isMasked(actor);

  const items = [
    ...(onStage ? [{
      label:  "발화 전환",
      icon:   "fa-comment-dots",
      action: () => globalThis.fetSetSpeakingAs?.(actor.id),
    }] : []),
    {
      label:  onStage ? "무대에서 제거" : "무대에 추가",
      icon:   "fa-theater-masks",
      action: () => onStage
        ? globalThis.fetRemoveFromStage?.(actor.id)
        : globalThis.fetAddToStage?.(actor),
    },
    {
      label:  pinned ? "스테이터스에서 제거" : "스테이터스에 추가",
      icon:   "fa-eye",
      action: () => _toggleActorPin(actor),
    },
    {
      label:  masked ? "수치 표시" : "수치 숨기기 (??)",
      icon:   masked ? "fa-eye" : "fa-question-circle",
      action: () => _toggleActorMask(actor),
    },
  ];

  const menu = document.createElement("div");
  menu.className = "fedr-ctx-menu";

  for (const { label, icon, action } of items) {
    const item = document.createElement("div");
    item.className = "fedr-ctx-item";
    item.innerHTML = `<i class="fas ${icon}"></i>${label}`;
    item.addEventListener("click", () => { menu.remove(); action(); });
    menu.appendChild(item);
  }

  // 뷰포트 경계 클램프: 먼저 DOM에 삽입한 뒤 실제 크기 측정
  menu.style.left = "0";
  menu.style.top  = "0";
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth  - mw - 4)}px`;
  menu.style.top  = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`;

  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

// ─── DOM ───────────────────────────────────────────────────────────────────

function _buildCard(actor, pw, panelW, ch) {
  const card = document.createElement("div");
  card.className = "fedr-actor-card";
  card.dataset.actorId = actor.id;
  card.style.setProperty("--fedr-pw", `${pw}px`);
  card.style.setProperty("--fedr-panel-w", `${panelW}px`);
  card.style.setProperty("--fedr-ph", `${ch}px`);

  card.innerHTML =
    `<div class="fedr-name-row"><span class="fedr-name"></span></div>` +
    `<div class="fedr-card-body">` +
      `<div class="fedr-portrait-wrap">` +
        `<img class="fedr-portrait" draggable="false">` +
      `</div>` +
      `<div class="fedr-panel">` +
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
      `</div>` +
    `</div>`;
  card.querySelector(".fedr-portrait").setAttribute("src", actor.img ?? "");

  card.addEventListener("contextmenu", e => {
    const a = game.actors?.get(card.dataset.actorId);
    if (!a?.isOwner) return;
    _showCardContextMenu(a, e);
  });

  card.addEventListener("dblclick", e => {
    const a = game.actors?.get(card.dataset.actorId);
    if (!a?.isOwner) return;
    e.stopPropagation();
    a.sheet?.render(true);
  });

  return card;
}

function _updateCard(card, actor) {
  card.querySelector(".fedr-name").textContent = actor.name ?? "";
  const masked = _isMasked(actor);

  const hp = _hp(actor);
  if (hp) {
    const pct = Math.max(0, Math.min(1, (hp.max - hp.value) / hp.max));
    card.querySelector(".fedr-hp .fedr-fill").style.width = `${pct * 100}%`;
    card.querySelector(".fedr-hp-lbl").textContent = masked ? "??" : `${hp.value}/${hp.max}`;
  }

  const enc = _enc(actor);
  if (enc) {
    const pct = Math.max(0, Math.min(1, enc.value / enc.cap));
    card.querySelector(".fedr-enc .fedr-fill").style.width = `${pct * 100}%`;
    card.querySelector(".fedr-enc-lbl").textContent = masked ? "??" : `${enc.value}/${enc.cap}`;
  }
}

// ─── container management ──────────────────────────────────────────────────

function _sidebarW() {
  return document.querySelector("#sidebar")?.offsetWidth ?? 300;
}

function _navBottom() {
  const nav = document.getElementById("navigation");
  return nav ? Math.round(nav.getBoundingClientRect().bottom) + 8 : 8;
}

// NPC(적/기타) 컨테이너 기본 top.
// 씬 컨트롤 접힘으로 좌상단이 비어, NPC 스테이터스를 PC 스테이터스(우상단 가로
// 컨테이너) 바로 아래 높이까지 끌어올린다. 좌우(left)는 그대로 8px 유지.
// PC 카드가 있을 때만 PC 하단에 맞추고, 없으면 기존 nav 아래로 폴백.
function _npcDefaultTop() {
  const pc = document.getElementById(CONTAINER_OWN_ID);
  const hasPcCards = pc && pc.querySelector(".fedr-actor-card");
  if (hasPcCards) {
    const r = pc.getBoundingClientRect();
    // 보이는 상태면 실제 하단을, 숨김(display:none)이면 기본 top(8) + 카드 높이로 추정.
    if (r.height > 0) return Math.round(r.bottom) + 8;
    return 8 + _cardH() + 44;
  }
  return _navBottom();
}

function _getOrCreateContainer(id, posKey) {
  let el = document.getElementById(id);
  const isNew = !el;
  if (isNew) {
    el = document.createElement("div");
    el.id = id;
    document.body.appendChild(el);
  }

  el.style.flexDirection = id === CONTAINER_OWN_ID ? "row" : "column";
  el.style.alignItems    = id === CONTAINER_OWN_ID ? "flex-start" : "";

  if (isNew) {
    const pos = _loadPos(posKey);
    if (pos) {
      el.style.left = `${pos.left}px`;
      el.style.top  = `${pos.top}px`;
    } else if (id === CONTAINER_OWN_ID) {
      el.style.left  = "auto";
      el.style.right = `${_sidebarW() + 8}px`;
      el.style.top   = "8px";
    } else {
      el.style.left = "8px";
      el.style.top  = `${_npcDefaultTop()}px`;
    }
    _makeDraggable(el, posKey);
  }
  return el;
}

// 카드 수 + 전역 가시성으로 컨테이너 display 결정.
// 채팅 토글과 카드 추가/제거 양쪽에서 호출.
function _applyContainerDisplay(cnt) {
  const hasCards = cnt.querySelectorAll(".fedr-actor-card").length > 0;
  cnt.style.display = (hasCards && _isGlobalOn()) ? "" : "none";
}

function _syncContainerCards(cnt, actors, pw, panelW, ch) {
  const live = new Set(actors.map(a => a.id));
  for (const card of [...cnt.querySelectorAll(".fedr-actor-card")]) {
    if (!live.has(card.dataset.actorId)) card.remove();
  }
  for (const actor of actors) {
    let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actor.id}"]`);
    if (!card) {
      card = _buildCard(actor, pw, panelW, ch);
      cnt.appendChild(card);
    } else {
      card.style.setProperty("--fedr-pw", `${pw}px`);
      card.style.setProperty("--fedr-panel-w", `${panelW}px`);
      card.style.setProperty("--fedr-ph", `${ch}px`);
      card.querySelector(".fedr-portrait").src = actor.img ?? "";
    }
    _updateCard(card, actor);
  }
  _applyContainerDisplay(cnt);
}

// 전체 재빌드 — 핀된 액터 목록 기준으로 양쪽 컨테이너 동기화.
function feRebuildDx3rdResourceUI() {
  if (!_isDx3rd()) {
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(CONTAINER_OWN_ID)?.remove();
    _syncToggleBtn(false);
    return;
  }

  const { pcs, enemies } = _pinnedActors();
  const pw = _portraitW();
  const panelW = _panelW();
  const ch = _cardH();

  // PC(우상단) 컨테이너를 먼저 빌드/배치해야 NPC 컨테이너 기본 top을
  // PC 스테이터스 바로 아래로 계산할 수 있다 (_npcDefaultTop이 PC rect를 측정).
  const cntPcs = _getOrCreateContainer(CONTAINER_OWN_ID, POS_OWN_KEY);
  _syncContainerCards(cntPcs, pcs, pw, panelW, ch);

  const cntEnemies = _getOrCreateContainer(CONTAINER_ID, POS_KEY);
  _syncContainerCards(cntEnemies, enemies, pw, panelW, ch);

  _syncToggleBtn(_isGlobalOn());
}

// 단일 액터 데이터 갱신 — 핀된 액터의 HP·침식률 업데이트.
function feUpdateDx3rdResourceUI(actorId) {
  if (!_isDx3rd()) return;

  const actor = game.actors?.get(actorId);
  if (!actor || !_isActorPinned(actor)) return;

  const cntId = _isPC(actor) ? CONTAINER_OWN_ID : CONTAINER_ID;
  const cnt   = document.getElementById(cntId);
  if (!cnt) { feRebuildDx3rdResourceUI(); return; }

  let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actorId}"]`);
  if (!card) {
    // actorType 변경 등으로 컨테이너가 달라진 경우
    card = _buildCard(actor, _portraitW(), _panelW(), _cardH());
    cnt.appendChild(card);
    _applyContainerDisplay(cnt);
  }
  _updateCard(card, actor);
}

// ─── per-actor pin toggle ──────────────────────────────────────────────────

function _addActorCard(actor) {
  if (!_isDx3rd()) return;
  const posKey = _isPC(actor) ? POS_OWN_KEY : POS_KEY;
  const cntId  = _isPC(actor) ? CONTAINER_OWN_ID : CONTAINER_ID;
  const cnt    = _getOrCreateContainer(cntId, posKey);
  const pw     = _portraitW();
  const panelW = _panelW();
  const ch     = _cardH();

  let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actor.id}"]`);
  if (!card) {
    card = _buildCard(actor, pw, panelW, ch);
    cnt.appendChild(card);
  } else {
    card.style.setProperty("--fedr-pw", `${pw}px`);
    card.style.setProperty("--fedr-panel-w", `${panelW}px`);
    card.style.setProperty("--fedr-ph", `${ch}px`);
    card.querySelector(".fedr-portrait").src = actor.img ?? "";
  }
  _updateCard(card, actor);
  _applyContainerDisplay(cnt);
}

function _removeActorCard(actorId) {
  for (const id of [CONTAINER_ID, CONTAINER_OWN_ID]) {
    const cnt = document.getElementById(id);
    if (!cnt) continue;
    cnt.querySelector(`.fedr-actor-card[data-actor-id="${actorId}"]`)?.remove();
    _applyContainerDisplay(cnt);
  }
}

function _toggleActorPin(actor) {
  const willPin = !_isActorPinned(actor);
  if (actor.isOwner) {
    // 직접 수정 권한 있음 — updateActor hook이 모든 클라이언트에서 재빌드 처리
    if (willPin) actor.setFlag(MODULE_ID, SHOW_FLAG, true);
    else actor.unsetFlag(MODULE_ID, SHOW_FLAG);
  } else {
    // 직접 수정 불가 — GM에게 소켓으로 요청
    game.socket.emit(`module.${MODULE_ID}`, { type: "ruiPinToggle", actorId: actor.id, pinned: willPin });
    // 낙관적 로컬 업데이트 (updateActor로 최종 확정)
    if (willPin) _addActorCard(actor);
    else _removeActorCard(actor.id);
  }
}

// ─── accent color button ────────────────────────────────────────────────────

function _getAccent() {
  try { return String(game.settings.get(MODULE_ID, S.DX3RD_PIXEL_ACCENT) || "#ffffff"); }
  catch { return "#ffffff"; }
}

function _setAccent(color) {
  document.documentElement.style.setProperty("--fe-dx3rd-accent", color);
  try { game.settings.set(MODULE_ID, S.DX3RD_PIXEL_ACCENT, color); } catch {}
}

function _injectAccentBtn() {
  // 액센트 색 선택기는 픽셀 테마 전용(비-픽셀엔 액센트 오버라이드가 없음).
  // 테마가 꺼졌으면 이미 주입된 버튼을 제거하고 빠진다.
  if (!_isDx3rd() || !_isThemeOn() || !game.user?.isGM) {
    document.getElementById(ACCENT_BTN_ID)?.remove();
    return;
  }
  if (document.getElementById(ACCENT_BTN_ID)) return;

  const controls = document.querySelector("chat-controls, #chat-controls, .chat-controls");
  if (!controls) return;

  const color = _getAccent();

  const label = document.createElement("label");
  label.id        = ACCENT_BTN_ID;
  label.className = "fe-dx3rd-accent-btn";
  label.title     = "픽셀 테마 강조색";
  label.style.background = color;

  const input = document.createElement("input");
  input.type  = "color";
  input.value = color;

  // real-time preview while dragging the picker — §20 palette(H·S)도 즉시 반영
  input.addEventListener("input", (e) => {
    const color = e.target.value;
    label.style.background = color;
    const root = document.documentElement;
    root.style.setProperty("--fe-dx3rd-accent", color);
    const { h, s } = _hexToHs(color);
    root.style.setProperty("--fe-dx3rd-accent-h", `${Math.round(h)}deg`);
    root.style.setProperty("--fe-dx3rd-accent-s", `${Math.round(s * 100)}%`);
  });
  // commit: persist to setting (triggers feApplyStyleVarsFromSettings via onChange)
  input.addEventListener("change", (e) => _setAccent(e.target.value));

  label.appendChild(input);
  controls.prepend(label);
}

// ─── chat toggle button ────────────────────────────────────────────────────
// 채팅 토글은 가시성만 조작 — 카드 DOM은 건드리지 않음.

function _syncToggleBtn(ruiOn) {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return;
  btn.title = ruiOn ? "스테이터스 숨기기" : "스테이터스 표시";
  btn.classList.toggle("fe-dx3rd-rui-active", ruiOn);
}

// 로컬 가시성 적용 — 소켓 수신 및 버튼 클릭 양쪽에서 공유.
function _applyVisibility(visible) {
  _setGlobalOn(visible);
  for (const id of [CONTAINER_ID, CONTAINER_OWN_ID]) {
    const cnt = document.getElementById(id);
    if (cnt) _applyContainerDisplay(cnt);
  }
  _syncToggleBtn(visible);
}

function _injectChatBtn() {
  if (!_isDx3rd()) return;
  if (document.getElementById(BTN_ID)) return;

  const controls = document.querySelector("chat-controls, #chat-controls, .chat-controls");
  if (!controls) return;

  const btn = document.createElement("button");
  btn.id        = BTN_ID;
  btn.type      = "button";
  btn.className = "fe-dx3rd-rui-toggle";
  const on = _isGlobalOn();
  btn.title     = on ? "스테이터스 숨기기" : "스테이터스 표시";
  btn.classList.toggle("fe-dx3rd-rui-active", on);
  btn.textContent = "스테이터스";
  btn.addEventListener("click", () => {
    const nowOn = !_isGlobalOn();
    _applyVisibility(nowOn);
    // 모든 접속 중인 클라이언트에 가시성 상태 브로드캐스트
    game.socket.emit(`module.${MODULE_ID}`, { type: "ruiVisible", visible: nowOn });
  });
  controls.prepend(btn);
}

// ─── 컨텍스트 메뉴 (사이드바 액터 / 캔버스 토큰 우클릭) ──────────────────────

// 사이드바 액터 디렉터리 우클릭
// v14: getActorContextOptions / v13: getActorContextMenuOptions
function _ruiContextEntry(html, options) {
  if (!_isDx3rd()) return;
  if (options.some(o => o.name === "스테이터스 토글")) return;
  const item = {
    name: "스테이터스 토글",
    icon: '<i class="fas fa-eye"></i>',
    condition: li => {
      const el = li instanceof jQuery ? li[0] : li;
      const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId;
      // 소유 캐릭터에만 노출 (isOwner: GM 은 전체, 플레이어는 본인 소유만)
      return !!game.actors.get(id)?.isOwner;
    },
    callback: li => {
      const el = li instanceof jQuery ? li[0] : li;
      const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId;
      const actor = id ? game.actors.get(id) : null;
      if (actor) _toggleActorPin(actor);
    },
  };
  // "편집"(SIDEBAR.Edit) 아래 무대 항목 그룹 끝에 합류시킨다(맨 아래 push 금지).
  // 무대 항목(fe-theatre)이 이미 있으면 그 그룹 끝, 없으면(훅 실행 순서상 theatre
  // 미실행) "편집" 바로 아래. 두 훅 중 무엇이 먼저 실행돼도 최종 순서는
  // [편집, 무대에 추가/제거, 무대 설정, 스테이터스 토글] 으로 수렴한다.
  let at = -1;
  for (let i = 0; i < options.length; i++) {
    if (typeof options[i]?.name === "string" && options[i].name.startsWith("무대")) at = i;
  }
  if (at < 0) {
    const editLabel = game.i18n?.localize?.("SIDEBAR.Edit") ?? "편집";
    at = options.findIndex(o =>
      o?.label === "SIDEBAR.Edit" || o?.name === "SIDEBAR.Edit" ||
      o?.label === editLabel       || o?.name === editLabel);
  }
  options.splice(at + 1, 0, item);
}

Hooks.on("getActorContextOptions",     _ruiContextEntry);
Hooks.on("getActorContextMenuOptions", _ruiContextEntry);

Hooks.on("createActor", (actor) => {
  if (!_isDx3rd()) return;
  actor.setFlag(MODULE_ID, MASK_FLAG, true);
});

// 캔버스 토큰 우클릭 (v14: getTokenEntries)
Hooks.on("getTokenEntries", (token, options) => {
  if (!_isDx3rd()) return;
  const actor = token.actor;
  if (!actor) return;
  options.push({
    name: "스테이터스 토글",
    icon: '<i class="fas fa-eye"></i>',
    callback: () => _toggleActorPin(actor),
  });
});

// ─── 액터 시트 헤더 버튼 ──────────────────────────────────────────────────────

function _injectSheetStatusBtn(app, el) {
  if (!_isDx3rd()) return;
  const actor = app.actor ?? app.document;
  if (actor?.documentName !== "Actor") return;

  const root = el.closest?.(".window-app, .application") ?? el;
  const headerBtns =
    el.querySelector(".window-header .header-buttons, .window-header .window-header-buttons") ??
    root.querySelector(".window-header .header-buttons, .window-header .window-header-buttons");
  const windowHeader = !headerBtns
    ? (el.querySelector(".window-header") ?? root.querySelector(".window-header"))
    : null;
  const target = headerBtns ?? windowHeader;
  if (!target) return;

  target.querySelectorAll(".fedr-sheet-btn").forEach(b => b.remove());

  const pinned = _isActorPinned(actor);
  const masked = _isMasked(actor);

  const btn = document.createElement("a");
  btn.className = "header-button fedr-sheet-btn";
  btn.title = pinned ? "숨기기" : "스테이터스";
  btn.innerHTML = `<i class="fas ${pinned ? "fa-eye" : "fa-eye-slash"}"></i> 스테이터스`;
  btn.addEventListener("click", e => { e.preventDefault(); _toggleActorPin(actor); });

  const maskBtn = document.createElement("a");
  maskBtn.className = "header-button fedr-sheet-btn";
  maskBtn.title = masked ? "수치 표시" : "수치 숨기기 (??)";
  maskBtn.innerHTML = `<i class="fas fa-question-circle"></i> ${masked ? "수치 표시" : "수치 ??"}`;
  maskBtn.addEventListener("click", e => { e.preventDefault(); _toggleActorMask(actor); });

  if (headerBtns) {
    headerBtns.prepend(maskBtn);
    headerBtns.prepend(btn);
  } else {
    const closeBtn = windowHeader.querySelector(".header-button.close, .header-control.close-window");
    closeBtn ? windowHeader.insertBefore(maskBtn, closeBtn) : windowHeader.appendChild(maskBtn);
    closeBtn ? windowHeader.insertBefore(btn, closeBtn) : windowHeader.appendChild(btn);
  }
}

Hooks.on("renderActorSheet", (app, html) => {
  if (!_isDx3rd()) return;
  const el = html instanceof HTMLElement ? html
    : (typeof jQuery !== "undefined" && html instanceof jQuery) ? html[0]
    : html?.element?.[0] ?? null;
  if (el instanceof HTMLElement) _injectSheetStatusBtn(app, el);
});

// ─── settings ─────────────────────────────────────────────────────────────

Hooks.on("init", () => {
  if (!_isDx3rd()) return;
  game.settings.register(MODULE_ID, S.DX3RD_RUI_PORTRAIT_WIDTH, {
    name: "[DX3rd] 캐릭터 스테이터스 포트레이트 너비(px)",
    hint: "포트레이트 이미지 영역의 너비. 기본 98.",
    scope: "client", config: false, type: Number,
    default: 98,
    range: { min: 32, max: 256, step: 4 },
    onChange: feRebuildDx3rdResourceUI,
  });
  game.settings.register(MODULE_ID, S.DX3RD_RUI_PANEL_WIDTH, {
    name: "[DX3rd] 캐릭터 스테이터스 자원 칸 너비(px)",
    hint: "HP·침식률 바가 표시되는 패널의 너비. 기본 110.",
    scope: "client", config: false, type: Number,
    default: 110,
    range: { min: 60, max: 300, step: 4 },
    onChange: feRebuildDx3rdResourceUI,
  });
  game.settings.register(MODULE_ID, S.DX3RD_RUI_CARD_HEIGHT, {
    name: "[DX3rd] 캐릭터 스테이터스 카드 높이(px)",
    hint: "카드 전체 높이. 기본 80.",
    scope: "client", config: false, type: Number,
    default: 80,
    range: { min: 32, max: 200, step: 4 },
    onChange: feRebuildDx3rdResourceUI,
  });
});

// ─── Foundry hooks ─────────────────────────────────────────────────────────

Hooks.on("ready", () => {
  if (!_isDx3rd()) return;
  _injectChatBtn();
  _injectAccentBtn();
  feRebuildDx3rdResourceUI();

  // 다른 클라이언트의 소켓 메시지 수신
  game.socket.on(`module.${MODULE_ID}`, data => {
    if (data?.type === "ruiVisible") {
      _applyVisibility(data.visible);
    } else if (data?.type === "ruiPinToggle" && game.user.isGM) {
      // 직접 수정 권한 없는 플레이어 대신 GM이 플래그 변경 처리
      const actor = game.actors?.get(data.actorId);
      if (!actor) return;
      if (data.pinned) actor.setFlag(MODULE_ID, SHOW_FLAG, true);
      else actor.unsetFlag(MODULE_ID, SHOW_FLAG);
    }
  });
});

Hooks.on("updateActor", (actor, change) => {
  if (!_isDx3rd()) return;
  if (change.system?.actorType !== undefined || change.flags?.[MODULE_ID] !== undefined) {
    // actorType 변경 또는 SHOW_FLAG 변경 → 전체 재빌드 (모든 클라이언트에서 동기화)
    feRebuildDx3rdResourceUI();
  } else {
    // HP·침식률 등 데이터 변경 → 해당 카드만 갱신
    feUpdateDx3rdResourceUI(actor.id);
  }
});

Hooks.on("renderChatLog",   () => { _injectChatBtn(); _injectAccentBtn(); });
Hooks.on("renderChatInput", () => { _injectChatBtn(); _injectAccentBtn(); });
Hooks.on("renderSidebar",   () => { _injectChatBtn(); _injectAccentBtn(); });

Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  if (!_isDx3rd()) return;
  _injectChatBtn();
  _injectAccentBtn();
  feRebuildDx3rdResourceUI();
});

export { feRebuildDx3rdResourceUI, feUpdateDx3rdResourceUI };
