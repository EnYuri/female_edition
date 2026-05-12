// fe-dx3rd-resource-ui.js
// 픽셀 테마 전용 자원 UI (HP · 침식률). double-cross-3rd 시스템 + fe-dx3rd-pixel-theme 한정.

import { MODULE_ID } from "./fe-constants.js";

const RUI_ID = "fe-dx3rd-resource-ui";

function _active() {
  return game.system?.id === "double-cross-3rd"
    && document.body.classList.contains("fe-dx3rd-pixel-theme");
}

function _actor() {
  return game.user?.character ?? null;
}

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

function _build() {
  const el = document.createElement("div");
  el.id = RUI_ID;
  el.innerHTML =
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
    `</div>`;
  document.body.appendChild(el);
  return el;
}

function feUpdateDx3rdResourceUI() {
  let el = document.getElementById(RUI_ID);

  if (!_active()) {
    el?.remove();
    return;
  }

  if (!el) el = _build();

  const actor = _actor();
  el.hidden = !actor;
  if (!actor) return;

  el.querySelector(".fedr-name").textContent = actor.name ?? "";

  const hp = _hp(actor);
  if (hp) {
    // 빈 상태 = HP 최대, 채워질수록 HP 감소 (역방향)
    const pct = Math.max(0, Math.min(1, (hp.max - hp.value) / hp.max));
    el.querySelector(".fedr-hp .fedr-fill").style.width = `${pct * 100}%`;
    el.querySelector(".fedr-hp-lbl").textContent = `${hp.value}/${hp.max}`;
  }

  const enc = _enc(actor);
  if (enc) {
    // 침식률: 0 = 빈 바, 100 = 만 바 (시각 상한 100 고정)
    const pct = Math.max(0, Math.min(1, enc.value / enc.cap));
    el.querySelector(".fedr-enc .fedr-fill").style.width = `${pct * 100}%`;
    el.querySelector(".fedr-enc-lbl").textContent = `${enc.value}/${enc.cap}`;
  }
}

Hooks.on("ready", feUpdateDx3rdResourceUI);

Hooks.on("updateActor", (actor) => {
  if (actor.id === _actor()?.id) feUpdateDx3rdResourceUI();
});

Hooks.on("updateUser", (user) => {
  if (user.id === game.user?.id) feUpdateDx3rdResourceUI();
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, feUpdateDx3rdResourceUI);

export { feUpdateDx3rdResourceUI };
