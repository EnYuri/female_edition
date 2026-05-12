// fe-dx3rd-resource-ui.js
// 픽셀 테마 자원 UI — 씬 내 가시 토큰(액터) 전체를 좌상단에 세로 정렬.
// 조건: game.system.id === "double-cross-3rd" AND body.fe-dx3rd-pixel-theme

import { MODULE_ID, S } from "./fe-constants.js";

const CONTAINER_ID  = "fe-dx3rd-rui-container";
const BTN_ID        = "fe-dx3rd-rui-toggle-btn";
const HIDE_FLAG     = "hideResourceUi";
const VISIBLE_KEY   = `${MODULE_ID}.ruiVisible`;

// ─── guards ────────────────────────────────────────────────────────────────

function _isDx3rd()      { return game.system?.id === "double-cross-3rd"; }
function _isThemeOn()    { return document.body.classList.contains("fe-dx3rd-pixel-theme"); }
function _isGlobalOn()   { return localStorage.getItem(VISIBLE_KEY) !== "false"; }
function _setGlobalOn(v) { localStorage.setItem(VISIBLE_KEY, String(v)); }

function _portraitW() {
  try { return Math.max(32, Number(game.settings.get(MODULE_ID, S.DX3RD_RUI_PORTRAIT_WIDTH)) || 64); }
  catch { return 64; }
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

// ─── visible actors ────────────────────────────────────────────────────────
// 씬 내 비숨김 토큰 → actor 중복 제거 → per-actor 숨김 플래그 확인

function _visibleActors() {
  if (!canvas?.tokens?.placeables) return [];
  const seen = new Set();
  const out  = [];
  for (const tok of canvas.tokens.placeables) {
    if (tok.document.hidden) continue;
    const actor = tok.actor;
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    if (actor.getFlag(MODULE_ID, HIDE_FLAG)) continue;
    out.push(actor);
  }
  return out;
}

// ─── DOM ───────────────────────────────────────────────────────────────────

function _buildCard(actor, pw) {
  const ph = pw * 2;
  const card = document.createElement("div");
  card.className = "fedr-actor-card";
  card.dataset.actorId = actor.id;
  card.style.setProperty("--fedr-pw", `${pw}px`);
  card.style.setProperty("--fedr-ph", `${ph}px`);

  card.innerHTML =
    `<div class="fedr-portrait-wrap">` +
      `<img class="fedr-portrait" src="${actor.img ?? ""}" draggable="false">` +
    `</div>` +
    `<div class="fedr-panel">` +
      `<div class="fedr-name-row"><span class="fedr-name"></span></div>` +
      `<div class="fedr-bars">` +
        `<div class="fedr-bar-group">` +
          `<div class="fedr-bar fedr-hp"><div class="fedr-fill"></div></div>` +
          `<div class="fedr-label fedr-hp-lbl"></div>` +
        `</div>` +
        `<div class="fedr-bar-group">` +
          `<div class="fedr-bar fedr-enc"><div class="fedr-fill"></div></div>` +
          `<div class="fedr-label fedr-enc-lbl"></div>` +
        `</div>` +
      `</div>` +
    `</div>`;
  return card;
}

function _updateCard(card, actor) {
  card.querySelector(".fedr-name").textContent = actor.name ?? "";

  const hp = _hp(actor);
  if (hp) {
    // 역방향: 빈 = 최대 HP, 채워짐 = HP=0
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

function _getOrCreateContainer() {
  let el = document.getElementById(CONTAINER_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CONTAINER_ID;
    document.body.appendChild(el);
  }
  return el;
}

function feRebuildDx3rdResourceUI() {
  if (!_isDx3rd() || !_isThemeOn() || !_isGlobalOn()) {
    document.getElementById(CONTAINER_ID)?.remove();
    _syncToggleBtn(false);
    return;
  }

  const actors = _visibleActors();
  const cnt    = _getOrCreateContainer();
  const pw     = _portraitW();

  // 사라진 카드 제거
  const live = new Set(actors.map(a => a.id));
  for (const card of [...cnt.querySelectorAll(".fedr-actor-card")]) {
    if (!live.has(card.dataset.actorId)) card.remove();
  }

  // 추가/업데이트
  for (const actor of actors) {
    let card = cnt.querySelector(`.fedr-actor-card[data-actor-id="${actor.id}"]`);
    if (!card) {
      card = _buildCard(actor, pw);
      cnt.appendChild(card);
    } else {
      // 포트레이트 크기 동기화
      card.style.setProperty("--fedr-pw", `${pw}px`);
      card.style.setProperty("--fedr-ph", `${pw * 2}px`);
      card.querySelector(".fedr-portrait").src = actor.img ?? "";
    }
    _updateCard(card, actor);
  }

  _syncToggleBtn(true);
}

function feUpdateDx3rdResourceUI(actorId) {
  if (!_isDx3rd() || !_isThemeOn() || !_isGlobalOn()) {
    document.getElementById(CONTAINER_ID)?.remove();
    return;
  }

  const cnt = document.getElementById(CONTAINER_ID);
  if (!cnt) { feRebuildDx3rdResourceUI(); return; }

  const actor = game.actors?.get(actorId);
  if (!actor) return;

  // 플래그 or 비가시면 카드 제거
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
}

// ─── chat toggle button ────────────────────────────────────────────────────

function _syncToggleBtn(ruiOn) {
  const btn = document.getElementById(BTN_ID);
  if (!btn) return;
  btn.title = ruiOn ? "자원 UI 숨김 (DX3rd)" : "자원 UI 표시 (DX3rd)";
  btn.classList.toggle("fe-dx3rd-rui-active", ruiOn);
  btn.querySelector("i")?.classList.toggle("fa-eye", ruiOn);
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
    hint: "포트레이트 너비. 높이는 너비×2. 기본 64.",
    scope: "client", config: true, type: Number,
    default: 64,
    range: { min: 32, max: 128, step: 8 },
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

// 토큰 생성 / 삭제 / 가시성 변경
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

// HP / 침식률 실시간 갱신
Hooks.on("updateActor", (actor) => {
  if (_isDx3rd()) feUpdateDx3rdResourceUI(actor.id);
});

// 채팅 탭 재렌더 시 버튼 재삽입
Hooks.on("renderChatLog", () => _injectChatBtn());
Hooks.on("renderSidebar",  () => _injectChatBtn());

// 픽셀 테마 설정 변경 시 재빌드
Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  if (!_isDx3rd()) return;
  _injectChatBtn();
  feRebuildDx3rdResourceUI();
});

export { feRebuildDx3rdResourceUI, feUpdateDx3rdResourceUI };
