// fe-dx3rd-resource-ui.js
// Pixel-theme character status panels. An actor gets a card only while it carries
// SHOW_FLAG (toggled from the sheet header or context menu). Visibility is a separate
// on/off that only changes container `display` — card DOM is never torn down.
//
// World actors are shown regardless of whether a token exists; unlinked tokens' synthetic
// actors are not in game.actors, so the current scene's TokenDocuments are scanned too.
//
// Layout: non-PC actors go into #fe-dx3rd-rui-container (left:8px, vertical), PCs into
// #fe-dx3rd-rui-container-own (top right, horizontal). Both are draggable and persist
// their position in localStorage. The NPC container's default top sits just below the PC
// container (_npcDefaultTop), falling back to below the nav when there are no PC cards.

import { MODULE_ID, S, feIsDx3rdSystemId } from "./fe-constants.js";
import { feSetting, feCaptureWorldSettings, feMirrorGmPrioritySetting } from "./fe-gm-priority.js";
import { feApplyHQPortrait } from "./fe-portrait-hq.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";

// hex → { h: 0-360, s: 0-1 }. Achromatic input (s≈0) yields h=0.
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

// Wrap limits, so cards never run off screen.
const PC_CARDS_PER_ROW    = 5; // horizontal container: new row every 5
const ENEMY_CARDS_PER_COL = 8; // vertical container: new column every 8
const ACCENT_BTN_ID    = "fe-dx3rd-accent-btn";
const SHOW_FLAG        = "showInResourceUi"; // 이 플래그가 있으면 → RUI에 표시 (토큰 무관)
const MASK_FLAG        = "maskResourceValues"; // 수치 값을 ??로 숨김
const POS_KEY          = `${MODULE_ID}.ruiPos`;
const POS_OWN_KEY      = `${MODULE_ID}.ruiOwnPos`;

// Accent H/S variables feed a large portion of the retro stylesheet. Native color
// pickers can emit input events faster than the browser can recalculate that CSS,
// so keep the preview responsive without recalculating the entire UI per event.
let _accentPreviewTimer = null;
let _pendingAccentPreview = null;

// ─── guards ────────────────────────────────────────────────────────────────

function _isDx3rd()      { return feIsDx3rdSystemId(game.system?.id); }
function _isDnd5e()      { return game.system?.id === "dnd5e"; }
// Systems where this status panel is available. DX3rd shows HP + encroachment;
// dnd5e has no encroachment, so cards render the HP bar only (enc group hidden per-card
// in _updateCard). Both expose system.attributes.hp.{value,max}, which _hp() reads.
function _isSupported()  { return _isDx3rd() || _isDnd5e(); }
function _ruiEnabled()   { try { return feSetting(S.DX3RD_RUI_ENABLED) === true; } catch { return false; } }
function _isThemeOn()    { return document.body.classList.contains("fe-retro-theme"); }
// Panel visibility, moved from a chat toggle button to a module setting. Defaults to on.
function _isGlobalOn()   { try { return feSetting(S.DX3RD_RUI_VISIBLE) !== false; } catch { return true; } }

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
// PlayerCharacter → top-right horizontal container; everything else → left vertical one.

function _isPC(actor) {
  // DX3rd: system.actorType === "PlayerCharacter". Other systems (dnd5e): the
  // document type "character" is the player-character analogue → top-right row;
  // everything else (npc/vehicle/group…) → left vertical "enemy" container.
  if (actor?.system?.actorType) return actor.system.actorType === "PlayerCharacter";
  return actor?.type === "character";
}

// ─── pinned actors ─────────────────────────────────────────────────────────
// World actors count regardless of whether a token exists. Unlinked tokens' synthetic
// actors are absent from game.actors, so the current scene's TokenDocument.actor is
// collected too.

function _actorKey(actor) {
  return actor?.uuid ?? actor?.id ?? "";
}

function _activeSceneTokenActors() {
  const tokens = canvas?.scene?.tokens ?? game.scenes?.active?.tokens;
  if (!tokens) return [];
  return Array.from(tokens, token => token?.actor).filter(actor => actor?.documentName === "Actor");
}

function _resolveResourceActor(actorRef) {
  if (actorRef?.documentName === "Actor") return actorRef;
  const ref = String(actorRef ?? "");
  if (!ref) return null;
  const sceneActor = _activeSceneTokenActors().find(actor => _actorKey(actor) === ref);
  const worldId = ref.startsWith("Actor.") ? ref.slice("Actor.".length) : ref;
  return sceneActor ?? game.actors?.get(worldId) ?? null;
}

function _findActorCard(container, actorRef) {
  const key = typeof actorRef === "string" ? actorRef : _actorKey(actorRef);
  return Array.from(container?.querySelectorAll?.(".fedr-actor-card") ?? [])
    .find(card => card.dataset.actorUuid === key) ?? null;
}

function _pinnedActors() {
  if (!game.actors) return { pcs: [], enemies: [] };
  const pcs = [], enemies = [];
  const seen = new Set();
  for (const actor of [...game.actors, ..._activeSceneTokenActors()]) {
    const key = _actorKey(actor);
    if (!key || seen.has(key)) continue;
    seen.add(key);
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
// Make the container itself draggable. A mousedown bubbling up from a card becomes a drag
// only past a 5px threshold; below it the event stays an ordinary click so card
// interactions keep working.

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

  // Swallow the click that follows a drag, so it does not fire a card action.
  container.addEventListener("click", e => {
    if (wasDragging) { e.stopPropagation(); e.preventDefault(); wasDragging = false; }
  }, true);
}

// ─── card context menu ────────────────────────────────────────────────────

function _showCardContextMenu(actor, e) {
  e.preventDefault();
  e.stopPropagation();

  document.querySelector(".fedr-ctx-menu")?.remove();

  // Stage (fe-theatre) items only when the theatre API is present (DX3rd).
  const hasStage = typeof globalThis.fetAddToStage === "function";
  const onStage = hasStage && !!globalThis.fetIsOnStage?.(actor.id);
  const pinned  = _isActorPinned(actor);
  const masked  = _isMasked(actor);

  const items = [
    ...(onStage ? [{
      label:  "발화 전환",
      icon:   "fa-comment-dots",
      action: () => globalThis.fetSetSpeakingAs?.(actor.id),
    }] : []),
    ...(hasStage ? [{
      label:  onStage ? "무대에서 제거" : "무대에 추가",
      icon:   "fa-theater-masks",
      action: () => onStage
        ? globalThis.fetRemoveFromStage?.(actor.id)
        : globalThis.fetAddToStage?.(actor),
    }] : []),
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

  // Clamp to the viewport: insert first, then measure the real size.
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
  card.dataset.actorUuid = _actorKey(actor);
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
  feApplyHQPortrait(card.querySelector(".fedr-portrait"), actor.img ?? "", pw, ch);

  card.addEventListener("contextmenu", e => {
    const a = _resolveResourceActor(card.dataset.actorUuid);
    if (!a?.isOwner) return;
    _showCardContextMenu(a, e);
  });

  card.addEventListener("dblclick", e => {
    const a = _resolveResourceActor(card.dataset.actorUuid);
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

  // Encroachment bar: present only on systems that have it (DX3rd).
  // On dnd5e and any system without an encroachment attribute, hide the whole
  // bar-group so the card shows the HP bar only.
  const encGroup = card.querySelector(".fedr-enc")?.closest(".fedr-bar-group");
  const enc = _enc(actor);
  if (enc) {
    const pct = Math.max(0, Math.min(1, enc.value / enc.cap));
    card.querySelector(".fedr-enc .fedr-fill").style.width = `${pct * 100}%`;
    card.querySelector(".fedr-enc-lbl").textContent = masked ? "??" : `${enc.value}/${enc.cap}`;
    if (encGroup) encGroup.style.display = "";
  } else if (encGroup) {
    encGroup.style.display = "none";
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

// Default top for the NPC container. With the scene controls collapsed the top-left is
// free, so NPC cards rise to just below the PC container's bottom (left stays 8px).
// Only when PC cards exist — otherwise fall back to below the nav.
function _npcDefaultTop() {
  const pc = document.getElementById(CONTAINER_OWN_ID);
  const hasPcCards = pc && pc.querySelector(".fedr-actor-card");
  if (hasPcCards) {
    const r = pc.getBoundingClientRect();
    // Use the real bottom when visible; estimate from default top + card height when hidden.
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

  // Wrapping: cap the main-axis size at N card footprints so the rest spills to the next
  // row/column. One footprint is the card body (pw + panelW, or ch tall) plus 2x10px margin.
  el.style.flexWrap = "wrap";
  const footW = _portraitW() + _panelW() + 20;
  const footH = _cardH() + 20;
  if (id === CONTAINER_OWN_ID) {
    el.style.maxWidth       = `${PC_CARDS_PER_ROW * footW + 4}px`;  // +4: 반올림으로 5번째가 일찍 줄바뀜 방지
    el.style.maxHeight      = "";
    el.style.justifyContent = "flex-end";    // 부분 행도 우측 정렬
    el.style.alignContent   = "flex-start";
  } else {
    el.style.maxHeight      = `${ENEMY_CARDS_PER_COL * footH + 4}px`;
    el.style.maxWidth       = "";
    el.style.justifyContent = "";
    el.style.alignContent   = "flex-start";  // 열들을 왼쪽부터 채움
  }

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

// Container display is a function of card count and global visibility. Called from both
// the visibility toggle and card add/remove.
function _applyContainerDisplay(cnt) {
  const hasCards = cnt.querySelectorAll(".fedr-actor-card").length > 0;
  cnt.style.display = (hasCards && _isGlobalOn()) ? "" : "none";
}

function _syncContainerCards(cnt, actors, pw, panelW, ch) {
  const live = new Set(actors.map(_actorKey));
  for (const card of [...cnt.querySelectorAll(".fedr-actor-card")]) {
    if (!live.has(card.dataset.actorUuid)) card.remove();
  }
  for (const actor of actors) {
    let card = _findActorCard(cnt, actor);
    if (!card) {
      card = _buildCard(actor, pw, panelW, ch);
      cnt.appendChild(card);
    } else {
      card.style.setProperty("--fedr-pw", `${pw}px`);
      card.style.setProperty("--fedr-panel-w", `${panelW}px`);
      card.style.setProperty("--fedr-ph", `${ch}px`);
      feApplyHQPortrait(card.querySelector(".fedr-portrait"), actor.img ?? "", pw, ch);
    }
    _updateCard(card, actor);
  }
  _applyContainerDisplay(cnt);
}

// Full rebuild: sync both containers against the pinned-actor list.
function feRebuildDx3rdResourceUI() {
  if (!_isSupported() || !_ruiEnabled()) {
    document.getElementById(CONTAINER_ID)?.remove();
    document.getElementById(CONTAINER_OWN_ID)?.remove();
    return;
  }

  const { pcs, enemies } = _pinnedActors();
  const pw = _portraitW();
  const panelW = _panelW();
  const ch = _cardH();

  // Build/place the PC container FIRST — _npcDefaultTop measures its rect to position the
  // NPC container just below it.
  const cntPcs = _getOrCreateContainer(CONTAINER_OWN_ID, POS_OWN_KEY);
  _syncContainerCards(cntPcs, pcs, pw, panelW, ch);

  const cntEnemies = _getOrCreateContainer(CONTAINER_ID, POS_KEY);
  _syncContainerCards(cntEnemies, enemies, pw, panelW, ch);
}

// Update one pinned actor's HP/encroachment in place.
function feUpdateDx3rdResourceUI(actorRef) {
  if (!_isSupported()) return;

  const actor = _resolveResourceActor(actorRef);
  if (!actor || !_isActorPinned(actor)) return;

  const cntId = _isPC(actor) ? CONTAINER_OWN_ID : CONTAINER_ID;
  const cnt   = document.getElementById(cntId);
  if (!cnt) { feRebuildDx3rdResourceUI(); return; }

  let card = _findActorCard(cnt, actor);
  if (!card) {
    // The card moved containers (e.g. actorType changed)
    card = _buildCard(actor, _portraitW(), _panelW(), _cardH());
    cnt.appendChild(card);
    _applyContainerDisplay(cnt);
  }
  _updateCard(card, actor);
}

// ─── per-actor pin toggle ──────────────────────────────────────────────────

function _addActorCard(actor) {
  if (!_isSupported()) return;
  const posKey = _isPC(actor) ? POS_OWN_KEY : POS_KEY;
  const cntId  = _isPC(actor) ? CONTAINER_OWN_ID : CONTAINER_ID;
  const cnt    = _getOrCreateContainer(cntId, posKey);
  const pw     = _portraitW();
  const panelW = _panelW();
  const ch     = _cardH();

  let card = _findActorCard(cnt, actor);
  if (!card) {
    card = _buildCard(actor, pw, panelW, ch);
    cnt.appendChild(card);
  } else {
    card.style.setProperty("--fedr-pw", `${pw}px`);
    card.style.setProperty("--fedr-panel-w", `${panelW}px`);
    card.style.setProperty("--fedr-ph", `${ch}px`);
    feApplyHQPortrait(card.querySelector(".fedr-portrait"), actor.img ?? "", pw, ch);
  }
  _updateCard(card, actor);
  _applyContainerDisplay(cnt);
}

function _removeActorCard(actorRef) {
  const key = typeof actorRef === "string" ? actorRef : _actorKey(actorRef);
  for (const id of [CONTAINER_ID, CONTAINER_OWN_ID]) {
    const cnt = document.getElementById(id);
    if (!cnt) continue;
    _findActorCard(cnt, key)?.remove();
    _applyContainerDisplay(cnt);
  }
}

function _toggleActorPin(actor) {
  const willPin = !_isActorPinned(actor);
  if (actor.isOwner) {
    // We can write directly; the updateActor hook rebuilds on every client.
    if (willPin) actor.setFlag(MODULE_ID, SHOW_FLAG, true);
    else actor.unsetFlag(MODULE_ID, SHOW_FLAG);
  } else {
    // No write permission — ask the GM over the socket.
    game.socket.emit(`module.${MODULE_ID}`, {
      type: "ruiPinToggle",
      actorUuid: _actorKey(actor),
      actorId: actor.id,
      requesterId: game.user.id,
      pinned: willPin,
    });
    // Optimistic local update; updateActor confirms it.
    if (willPin) _addActorCard(actor);
    else _removeActorCard(actor);
  }
}

// ─── accent color button ────────────────────────────────────────────────────

function _getAccent() {
  try { return String(game.settings.get(MODULE_ID, S.DX3RD_PIXEL_ACCENT) || "#ffffff"); }
  catch { return "#ffffff"; }
}

async function _setAccent(color) {
  document.documentElement.style.setProperty("--fe-dx3rd-accent", color);
  try {
    await game.settings.set(MODULE_ID, S.DX3RD_PIXEL_ACCENT, color);
    // GM priority override store is world-scope; the setting's onChange mirrors it
    // but does NOT await the server round-trip, so a quick refresh can leave the
    // override (which feSetting → feApplyStyleVarsFromSettings reads while priority
    // is ON) holding the OLD color → theme stays old while the button shows new.
    // Await it here so the override is persisted before any refresh.
    await feMirrorGmPrioritySetting(S.DX3RD_PIXEL_ACCENT, color);
    // Persist into this world's per-world slice IMMEDIATELY. Otherwise
    // feHydrateWorldSettings on the next load re-applies the stale slice value
    // and reverts the color. (The clientSettingChanged hook also captures this,
    // but await-ing here guarantees it before any quick refresh.)
    await feCaptureWorldSettings();
  } catch (err) {
    console.warn(`[${MODULE_ID}] failed to persist accent color`, err);
  }
}

function _applyAccentPreview(color) {
  const root = document.documentElement;
  root.style.setProperty("--fe-dx3rd-accent", color);
  const { h, s } = _hexToHs(color);
  root.style.setProperty("--fe-dx3rd-accent-h", `${Math.round(h)}deg`);
  root.style.setProperty("--fe-dx3rd-accent-s", `${Math.round(s * 100)}%`);
}

function _queueAccentPreview(color) {
  _pendingAccentPreview = color;
  if (_accentPreviewTimer) return;
  // 30fps is visually continuous for a colour swatch while leaving enough time
  // for the expensive variable-driven style recalculation to finish.
  _accentPreviewTimer = setTimeout(() => {
    _accentPreviewTimer = null;
    const next = _pendingAccentPreview;
    _pendingAccentPreview = null;
    if (next) _applyAccentPreview(next);
  }, 33);
}

function _flushAccentPreview() {
  if (_accentPreviewTimer) clearTimeout(_accentPreviewTimer);
  _accentPreviewTimer = null;
  const next = _pendingAccentPreview;
  _pendingAccentPreview = null;
  if (next) _applyAccentPreview(next);
}

function _injectAccentBtn() {
  // The accent picker is retro-theme-only (nothing else honours the accent override), and
  // the retro theme is system-agnostic — so gate on theme + GM, NOT on the system. It used
  // to be wrapped in _isDx3rd(), which hid the swatch on dnd5e and elsewhere.
  // Remove any already-injected button when the theme is off.
  if (!_isThemeOn() || !game.user?.isGM) {
    document.getElementById(ACCENT_BTN_ID)?.remove();
    return;
  }
  const controls = document.querySelector("chat-controls, #chat-controls, .chat-controls");
  if (!controls) return;

  const color = _getAccent();
  const existing = document.getElementById(ACCENT_BTN_ID);
  if (existing) {
    existing.style.removeProperty("background");
    existing.style.setProperty("--fe-accent-swatch", color);
    controls.appendChild(existing);
    return;
  }

  const label = document.createElement("label");
  label.id        = ACCENT_BTN_ID;
  label.className = "fe-dx3rd-accent-btn";
  label.title     = "픽셀 테마 강조색";
  label.style.setProperty("--fe-accent-swatch", color);

  const input = document.createElement("input");
  input.type  = "color";
  input.value = color;

  // Live preview is rate-limited because these root variables recolour a large
  // part of the DOM. The swatch itself still follows every native input event.
  input.addEventListener("input", (e) => {
    const color = e.target.value;
    label.style.setProperty("--fe-accent-swatch", color);
    _queueAccentPreview(color);
  });
  // Commit the last queued preview first, then persist it once. The setting's
  // onChange performs the authoritative full style-variable refresh.
  input.addEventListener("change", (e) => {
    _pendingAccentPreview = e.target.value;
    _flushAccentPreview();
    void _setAccent(e.target.value);
  });

  label.appendChild(input);
  controls.append(label);
}

// ─── Visibility ──────────────────────────────────────────────────────────────
// Driven by the DX3RD_RUI_VISIBLE setting's onChange. Only container display changes;
// card DOM is left alone.

function _refreshVisibility() {
  for (const id of [CONTAINER_ID, CONTAINER_OWN_ID]) {
    const cnt = document.getElementById(id);
    if (cnt) _applyContainerDisplay(cnt);
  }
}

// ─── Context menus (sidebar actor / canvas token right-click) ────────────────

// Sidebar Actor directory right-click
// v14: getActorContextOptions / v13: getActorContextMenuOptions
function _ruiContextEntry(html, options) {
  if (!_isSupported() || !_ruiEnabled()) return;
  if (options.some(o => o.name === "스테이터스 토글")) return;
  // v14 replaced ContextMenuEntry#name/#condition with label/visible (removal slated for
  // v16). Minimum support is v13, so emit both key pairs.
  const visible = li => {
    const el = li instanceof jQuery ? li[0] : li;
    const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId;
    // Owned actors only — isOwner is everything for a GM, own actors for a player.
    return !!game.actors.get(id)?.isOwner;
  };
  const item = {
    label: "스테이터스 토글",
    name: "스테이터스 토글",
    icon: '<i class="fas fa-eye"></i>',
    visible,
    condition: visible,
    callback: li => {
      const el = li instanceof jQuery ? li[0] : li;
      const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId;
      const actor = id ? game.actors.get(id) : null;
      if (actor) _toggleActorPin(actor);
    },
  };
  // Join the end of the stage-entry group under SIDEBAR.Edit — do NOT push to the bottom.
  // If fe-theatre's entries are already there, append after them; otherwise (theatre's hook
  // has not run yet) sit directly under Edit. Either hook order converges on the same final
  // order: [Edit, stage add/remove, stage settings, status toggle].
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

// New actors start masked. createActor fires on EVERY connected client, so only the
// creator (who owns it) may write — without that gate, other clients spam
// "User X lacks permission to update Actor [...]".
Hooks.on("createActor", (actor, _options, userId) => {
  if (!_isDx3rd()) return;
  if (game.user.id !== userId || !actor.isOwner) return;
  actor.setFlag(MODULE_ID, MASK_FLAG, true)
    .catch(err => console.warn(`[${MODULE_ID}] failed to set default mask flag`, err));
});

// Canvas token right-click: inject buttons into the Token HUD. There is no core
// getTokenEntries hook, so renderTokenHUD is the entry point.
function _hudIconBtn(label, faIcon, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-icon fedr-hud-btn";
  btn.dataset.tooltip = "";
  btn.setAttribute("aria-label", label);
  btn.innerHTML = `<i class="fa-solid ${faIcon}" inert></i>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function _injectTokenHudButtons(app, el) {
  const root = el instanceof HTMLElement ? el
    : (typeof jQuery !== "undefined" && el instanceof jQuery) ? el[0]
    : app?.element ?? null;
  if (!(root instanceof HTMLElement)) return;

  const actor = app?.actor ?? app?.document?.actor ?? app?.object?.actor;
  if (!actor) return;

  // Stage entries go in the left column (the GM control column); the status toggle right.
  const colLeft  = root.querySelector(".col.left")  ?? root;
  const colRight = root.querySelector(".col.right") ?? colLeft;
  root.querySelectorAll(".fedr-hud-btn").forEach(b => b.remove());

  // Stage (fe-theatre) entries — only when the theatre API exists and the actor is owned.
  const hasStage = typeof globalThis.fetAddToStage === "function";
  if (hasStage && actor.isOwner) {
    const onStage = !!globalThis.fetIsOnStage?.(actor.id);
    if (onStage) {
      colLeft.appendChild(_hudIconBtn("발화 전환", "fa-comment-dots",
        () => globalThis.fetSetSpeakingAs?.(actor.id)));
      colLeft.appendChild(_hudIconBtn("무대에서 제거", "fa-theater-masks",
        () => globalThis.fetRemoveFromStage?.(actor.id)));
    } else {
      colLeft.appendChild(_hudIconBtn("무대에 추가", "fa-theater-masks",
        () => globalThis.fetAddToStage?.(actor)));
    }
  }

  // Status toggle — supported systems with the feature enabled only.
  if (_isSupported() && _ruiEnabled()) {
    const pinned = _isActorPinned(actor);
    colRight.appendChild(_hudIconBtn(
      pinned ? "스테이터스 UI에서 제거" : "스테이터스 UI 토글",
      pinned ? "fa-eye-slash" : "fa-eye",
      () => _toggleActorPin(actor)));
  }
}

Hooks.on("renderTokenHUD", _injectTokenHudButtons);

// ─── Actor sheet header buttons ──────────────────────────────────────────────

// ApplicationV2 sheets already ship their own header-controls dropdown (the
// "⋯" button, `data-action="toggleControls"` — core application.mjs
// `_getHeaderControls()` / `_headerControlButtons()`). Rather than building a
// bespoke dropdown, the mask/unmask entry is pushed straight into THAT menu via
// the `getHeaderControls{ClassName}` hook chain, which always includes the
// base class name too ("getHeaderControlsApplicationV2" —
// `Application#_callHooks` walks `inheritanceChain()` and fires one hook per
// class, ApplicationV2 last). DX3rd's own actor sheet is a v1 classic
// FormApplication though (no such menu exists there at all), so this hook is
// mostly future-proofing; the practical path for DX3rd today is the
// windowHeader plain-button fallback in _injectSheetStatusBtn below.
function _ruiOnGetHeaderControls(app, controls) {
  if (!_isSupported() || !_ruiEnabled()) return;
  const actor = app.actor ?? app.document;
  if (actor?.documentName !== "Actor") return;
  controls.push({
    action: "fedrToggleMask",
    icon: "fas fa-question-circle",
    label: _isMasked(actor) ? "수치 표시" : "수치 숨기기 (??)",
    onClick: () => _toggleActorMask(actor),
  });
}
Hooks.on("getHeaderControlsApplicationV2", _ruiOnGetHeaderControls);

function _injectSheetStatusBtn(app, el) {
  if (!_isSupported() || !_ruiEnabled()) {
    el?.querySelectorAll?.(".fedr-sheet-btn")?.forEach(b => b.remove());
    return;
  }
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
  btn.setAttribute("aria-label", btn.title);
  btn.innerHTML = `<i class="fas ${pinned ? "fa-eye" : "fa-eye-slash"}" inert></i>`;
  btn.addEventListener("click", e => { e.preventDefault(); _toggleActorPin(actor); });

  const maskBtn = document.createElement("a");
  maskBtn.className = "header-button fedr-sheet-btn";
  maskBtn.title = masked ? "수치 표시" : "수치 숨기기 (??)";
  maskBtn.setAttribute("aria-label", maskBtn.title);
  maskBtn.innerHTML = `<i class="fas fa-question-circle" inert></i>`;
  maskBtn.addEventListener("click", e => { e.preventDefault(); _toggleActorMask(actor); });

  if (headerBtns) {
    // Append (not prepend) so our button sorts AFTER any core/system buttons
    // already present in the container — lower priority than the existing
    // header menu, not first. The mask/unmask entry lives in the sheet's own
    // native "⋯" controls dropdown instead — see _ruiOnGetHeaderControls above.
    headerBtns.append(btn);
  } else {
    // AppV2 (dnd5e 5.x) close button is `button[data-action="close"]` (class
    // .header-control), not `.header-button.close`/`.close-window`. Without matching
    // it the buttons were appended AFTER close (to its right). Match all variants.
    // This branch also catches AppV2 sheets that simply lack the dnd5e-style
    // .header-buttons container — those DO have the native "⋯" dropdown (it's
    // part of every ApplicationV2 frame, see application.mjs _renderFrame),
    // so the mask toggle must NOT be added here too or it would duplicate the
    // _ruiOnGetHeaderControls entry. Only genuine v1 sheets (no
    // [data-action="toggleControls"] at all — DX3rd today) get the plain
    // fallback button.
    const closeBtn = windowHeader.querySelector('[data-action="close"], .header-control.close-window, .header-button.close');
    const hasNativeControls = !!windowHeader.querySelector('[data-action="toggleControls"]');
    closeBtn ? windowHeader.insertBefore(btn, closeBtn) : windowHeader.appendChild(btn);
    if (!hasNativeControls) {
      closeBtn ? windowHeader.insertBefore(maskBtn, closeBtn) : windowHeader.appendChild(maskBtn);
    }
  }
}

function _onRenderActorSheet(app, html) {
  if (!_isSupported()) return;
  const el = html instanceof HTMLElement ? html
    : (typeof jQuery !== "undefined" && html instanceof jQuery) ? html[0]
    : html?.element?.[0] ?? app?.element ?? null;
  if (el instanceof HTMLElement) _injectSheetStatusBtn(app, el);
}

// renderActorSheet: v1 sheets (DX3rd). renderActorSheetV2: ApplicationV2 sheets
// (dnd5e 5.x and other modern systems). _injectSheetStatusBtn de-dupes its own
// button, so firing both for a system that emits both is harmless.
Hooks.on("renderActorSheet",   _onRenderActorSheet);
Hooks.on("renderActorSheetV2", _onRenderActorSheet);

// ─── settings ─────────────────────────────────────────────────────────────

Hooks.on("init", () => {
  if (!_isSupported()) return;
  game.settings.register(MODULE_ID, S.DX3RD_RUI_ENABLED, {
    name: "스테이터스 UI 표시",
    hint: "핀 고정한 액터의 HP·자원 카드(스테이터스 UI)를 화면에 표시합니다. 끄면 스테이터스 UI 전체와 채팅의 토글 버튼이 비활성화됩니다.",
    // config:false — managed in the unified settings menu (fe-settings-menu) "스테이터스 UI" section.
    scope: "client", config: false, type: Boolean,
    default: true,
    onChange: () => {
      feRebuildDx3rdResourceUI();
      // Clean up header buttons on already-open sheets when toggling off (no re-render).
      if (!_ruiEnabled()) document.querySelectorAll(".fedr-sheet-btn").forEach(b => b.remove());
    },
  });
  game.settings.register(MODULE_ID, S.DX3RD_RUI_VISIBLE, {
    name: "스테이터스 UI 표시(가시성)",
    hint: "스테이터스 UI 카드를 화면에 표시합니다. 끄면 핀 고정은 유지한 채 카드만 숨깁니다. (이전 채팅 토글 버튼을 대체)",
    // config:false — managed in the unified settings menu (fe-settings-menu) "스테이터스 UI" section.
    scope: "client", config: false, type: Boolean,
    default: true,
    onChange: _refreshVisibility,
  });
  game.settings.register(MODULE_ID, S.DX3RD_RUI_PORTRAIT_WIDTH, {
    name: "[DX3rd] 캐릭터 스테이터스 포트레이트 너비(px)",
    hint: "포트레이트 이미지 영역의 너비. 기본 100.",
    scope: "client", config: false, type: Number,
    default: 100,
    range: { min: 32, max: 256, step: 4 },
    onChange: feRebuildDx3rdResourceUI,
  });
  game.settings.register(MODULE_ID, S.DX3RD_RUI_PANEL_WIDTH, {
    name: "[DX3rd] 캐릭터 스테이터스 자원 칸 너비(px)",
    hint: "HP·침식률 바가 표시되는 패널의 너비. 기본 128.",
    scope: "client", config: false, type: Number,
    default: 128,
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
  if (!_isSupported()) return;
  _injectAccentBtn();
  feRebuildDx3rdResourceUI();

  game.socket.on(`module.${MODULE_ID}`, async (data, senderId) => {
    if (data?.type === "ruiPinToggle" && game.user.isGM) {
      // Apply the flag change on behalf of a player who cannot write it themselves.
      const requester = feResolveSocketSender(senderId, data.requesterId, "resource-ui");
      if (!requester) return;
      let actor = null;
      try { actor = data.actorUuid ? await fromUuid(data.actorUuid) : null; }
      catch { /* fall through to the v13/world-actor compatibility path */ }
      actor ??= game.actors?.get(data.actorId);
      if (actor?.documentName !== "Actor" || !actor.testUserPermission?.(requester, "OWNER")) return;
      if (data.pinned) actor.setFlag(MODULE_ID, SHOW_FLAG, true);
      else actor.unsetFlag(MODULE_ID, SHOW_FLAG);
    }
  });
});

Hooks.on("updateActor", (actor, change) => {
  if (!_isSupported() || !_ruiEnabled()) return; // skip entirely when the status UI is off
  if (change.system?.actorType !== undefined || change.flags?.[MODULE_ID] !== undefined) {
    // actorType or SHOW_FLAG changed → full rebuild (syncs on every client)
    feRebuildDx3rdResourceUI();
  } else {
    // plain data change (HP, encroachment) → refresh just that card
    feUpdateDx3rdResourceUI(actor);
  }
});

// Synthetic actors are only enumerable through the current scene's TokenDocuments, so a
// scene change or an unlinked-token delete cannot be reconciled from game.actors alone.
Hooks.on("canvasReady", feRebuildDx3rdResourceUI);
Hooks.on("deleteToken", feRebuildDx3rdResourceUI);

Hooks.on("renderChatLog",   () => { _injectAccentBtn(); });
Hooks.on("renderChatInput", () => { _injectAccentBtn(); });
Hooks.on("renderSidebar",   () => { _injectAccentBtn(); });

Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  if (!_isSupported()) return;
  _injectAccentBtn();
  feRebuildDx3rdResourceUI();
});

export { feRebuildDx3rdResourceUI, feUpdateDx3rdResourceUI };
