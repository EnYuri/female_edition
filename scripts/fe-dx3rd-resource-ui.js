import { feLocalize, feFormat } from "./fe-i18n.js";
import { feRegisterSetting } from "./fe-settings-data.js";
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
import { feHpMasked, feToggleHpMask } from "./fe-hp-mask.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";
// feCtDisplaysHp only — the tracker family's shared floor, which reads settings and
// nothing else. Importing the tracker ENTRY here would be a cycle (it fires the hook
// this module listens on) and would drag the whole strip renderer in with it.
import { feCtDisplaysHp } from "./fe-combat-tracker-core.js";
import { feRegisterTemplates, feRenderTemplate } from "./fe-template.js";

// Markup lives in templates/; preloaded at `init` (fe-template.js).
const [RUI_TPL_CARD, RUI_TPL_MENU, RUI_TPL_ACCENT] = feRegisterTemplates(
  "fe-dx3rd-resource-card.hbs",
  "fe-dx3rd-resource-menu.hbs",
  "fe-dx3rd-accent-dialog.hbs"
);

const CONTAINER_ID     = "fe-dx3rd-rui-container";
const CONTAINER_OWN_ID = "fe-dx3rd-rui-container-own";

// Wrap limits, so cards never run off screen.
const PC_CARDS_PER_ROW    = 5; // horizontal container: new row every 5
const ENEMY_CARDS_PER_COL = 8; // vertical container: new column every 8
const ACCENT_BTN_ID    = "fe-dx3rd-accent-btn";
const SHOW_FLAG        = "showInResourceUi"; // flag set → shown in the RUI (token-independent)
const POS_KEY          = `${MODULE_ID}.ruiPos`;
const POS_OWN_KEY      = `${MODULE_ID}.ruiOwnPos`;

// ─── guards ────────────────────────────────────────────────────────────────

function _isDx3rd()      { return feIsDx3rdSystemId(game.system?.id); }
function _isDnd5e()      { return game.system?.id === "dnd5e"; }
// Systems where this status panel is available. DX3rd shows HP + encroachment;
// dnd5e has no encroachment, so cards render the HP bar only (enc group hidden per-card
// in _updateCard). Both expose system.attributes.hp.{value,max}, which _hp() reads.
function _isSupported()  { return _isDx3rd() || _isDnd5e(); }
function _ruiEnabled()   {
  try {
    if (feSetting(S.DX3RD_RUI_ENABLED) !== true) return false;
    return !_yieldsToTracker();
  } catch { return false; }
}
// The battle tracker answers the same question these cards do — "how much HP is left"
// — and during an encounter it answers it for every combatant at once, so the pinned
// cards are redundant furniture for exactly as long as the encounter lasts. Default on.
// feCtDisplaysHp includes the "a combat is on screen" term, so this is a TEMPORARY
// stand-down: the cards come back by themselves when the combat ends.
function _yieldsToTracker() {
  try {
    if (feSetting(S.DX3RD_RUI_YIELD_TO_TRACKER) === false) return false;
    return feCtDisplaysHp();
  } catch { return false; }
}

// The last answer _yieldsToTracker gave, so the combat hooks below can ignore the ones
// that change nothing. They fire on every turn and every round — rebuilding all the
// cards each time would be a full re-sync per turn for a state that flips twice per
// encounter. null = never asked.
let _ruiYieldState = null;

function _syncTrackerYield() {
  if (!_isSupported()) return;
  const yielding = _yieldsToTracker();
  if (yielding === _ruiYieldState) return;
  _ruiYieldState = yielding;
  feRebuildDx3rdResourceUI();
  // Already-open sheets do not re-render, so the pin button would linger on a feature
  // that just stood down — the same cleanup the enable toggle does.
  if (!_ruiEnabled()) document.querySelectorAll(".fedr-sheet-btn").forEach(b => b.remove());
}
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

// The flag is shared with the battle tracker's dynamic portrait — one "hide the
// numbers" switch per actor, not one per UI. Absent means masked; see fe-hp-mask.js.
function _isMasked(actor) {
  return feHpMasked(actor);
}

function _toggleActorMask(actor) {
  feToggleHpMask(actor);
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
        document.body.classList.add("fedr-dragging");
      }
      mv.preventDefault();
      mv.stopPropagation();
      container.style.left = `${Math.max(0, Math.min(window.innerWidth  - 20, mv.clientX - ox))}px`;
      container.style.top  = `${Math.max(0, Math.min(window.innerHeight - 20, mv.clientY - oy))}px`;
    };

    const onUp = up => {
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup",   onUp,   true);
      document.body.classList.remove("fedr-dragging");
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
      label:  feLocalize("FE.Common.SwitchSpeaker"),
      icon:   "fa-comment-dots",
      action: () => globalThis.fetSetSpeakingAs?.(actor.id),
    }] : []),
    ...(hasStage ? [{
      label:  onStage ? feLocalize("FE.Common.RemoveFromStage") : feLocalize("FE.Common.AddToStage"),
      icon:   "fa-theater-masks",
      action: () => onStage
        ? globalThis.fetRemoveFromStage?.(actor.id)
        : globalThis.fetAddToStage?.(actor),
    }] : []),
    {
      label:  pinned ? feLocalize("FE.Dx3rdResourceUi.label") : feLocalize("FE.Dx3rdResourceUi.label2"),
      icon:   "fa-eye",
      action: () => _toggleActorPin(actor),
    },
    {
      label:  masked ? feLocalize("FE.Dx3rdResourceUi.label3") : feLocalize("FE.Dx3rdResourceUi.label4"),
      icon:   masked ? "fa-eye" : "fa-question-circle",
      action: () => _toggleActorMask(actor),
    },
  ];

  const menu = document.createElement("div");
  menu.className = "fedr-ctx-menu";
  menu.innerHTML = feRenderTemplate(RUI_TPL_MENU, { items });
  // One delegated listener instead of one per row; the template stamps the index.
  menu.addEventListener("click", (ev) => {
    const row = ev.target.closest("[data-fedr-ctx]");
    if (!row) return;
    menu.remove();
    items[Number(row.dataset.fedrCtx)]?.action?.();
  });

  // Clamp to the viewport: insert first, then measure the real size.
  document.body.appendChild(menu);
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = `${Math.min(e.clientX, window.innerWidth  - mw - 4)}px`;
  menu.style.top  = `${Math.min(e.clientY, window.innerHeight - mh - 4)}px`;

  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }), 0);
}

// ─── DOM ───────────────────────────────────────────────────────────────────

// The three size custom properties are written from four different places; keep them
// in one helper so a card built here and a card refreshed on rebuild cannot drift.
function _applyCardMetrics(card, pw, panelW, ch) {
  card.style.setProperty("--fedr-pw", `${pw}px`);
  card.style.setProperty("--fedr-panel-w", `${panelW}px`);
  card.style.setProperty("--fedr-ph", `${ch}px`);
}

function _buildCard(actor, pw, panelW, ch) {
  const card = document.createElement("div");
  card.className = "fedr-actor-card";
  card.dataset.actorId = actor.id;
  card.dataset.actorUuid = _actorKey(actor);
  _applyCardMetrics(card, pw, panelW, ch);
  card.innerHTML = feRenderTemplate(RUI_TPL_CARD);
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

  // Bar fills arrive as percentages on custom properties; `width` itself is declared
  // once in fe-dx3rd-compat.css.
  const hp = _hp(actor);
  if (hp) {
    const pct = Math.max(0, Math.min(1, (hp.max - hp.value) / hp.max));
    card.style.setProperty("--fedr-hp-pct", `${pct * 100}%`);
    card.querySelector(".fedr-hp-lbl").textContent = masked ? "??" : `${hp.value}/${hp.max}`;
  }

  // Encroachment bar: present only on systems that have it (DX3rd). On dnd5e and any
  // system without an encroachment attribute the card carries .fedr-no-enc and CSS hides
  // the whole bar-group, so the card shows the HP bar only.
  const enc = _enc(actor);
  if (enc) {
    const pct = Math.max(0, Math.min(1, enc.value / enc.cap));
    card.style.setProperty("--fedr-enc-pct", `${pct * 100}%`);
    card.querySelector(".fedr-enc-lbl").textContent = masked ? "??" : `${enc.value}/${enc.cap}`;
  }
  card.classList.toggle("fedr-no-enc", !enc);
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

  // Flex direction / wrap / alignment are static per container and already declared in
  // fe-dx3rd-compat.css — the JS used to re-write them with the exact same values on
  // every render. The only thing it can know that CSS cannot is the wrap limit, which
  // depends on the measured card footprint (card body + 2x10px margin); that goes out as
  // a custom property. +4px so rounding does not wrap the Nth card one slot early.
  if (id === CONTAINER_OWN_ID) {
    el.style.setProperty("--fedr-wrap-w", `${PC_CARDS_PER_ROW * (_portraitW() + _panelW() + 20) + 4}px`);
  } else {
    el.style.setProperty("--fedr-wrap-h", `${ENEMY_CARDS_PER_COL * (_cardH() + 20) + 4}px`);
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
  cnt.classList.toggle("fedr-hidden", !(hasCards && _isGlobalOn()));
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
      _applyCardMetrics(card, pw, panelW, ch);
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
    _applyCardMetrics(card, pw, panelW, ch);
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
    console.warn(feFormat("FE.Diagnostics.Dx3rdResourceUi._setAccent", { MODULE_ID: MODULE_ID }), err);
  }
}

// Normalizes any user-typed hex into "#rrggbb". Returns null when unusable, so a
// half-typed value in the text field never reaches <input type="color"> (which
// silently clamps invalid input to #000000).
function _normalizeHex(raw) {
  let hex = String(raw ?? "").trim().replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toLowerCase()}`;
}

// Accent picking is EXPLICITLY confirm-gated — no live preview. The accent H/S
// variables recolour a large part of the retro stylesheet, so dragging a native
// colour picker used to repaint the whole UI dozens of times per second and made
// the value hard to judge (and hard to cancel). The dialog previews only its own
// swatch; the document is touched once, on 확인 (confirm).
async function _openAccentDialog(label) {
  const DialogV2 = foundry?.applications?.api?.DialogV2;
  if (!DialogV2) return;
  const cur = _normalizeHex(_getAccent()) ?? "#ffffff";

  const content = feRenderTemplate(RUI_TPL_ACCENT, { current: cur });

  let picked;
  try {
    picked = await DialogV2.prompt({
      window: { title: feLocalize("FE.Dx3rdResourceUi.window.title") },
      content,
      // The two inputs mirror each other; only the colour input is authoritative,
      // because the text field can hold a half-typed value at any moment.
      render: (_ev, dialog) => {
        const root  = dialog.element;
        const color = root.querySelector('input[name="accent"]');
        const text  = root.querySelector('input[name="accentHex"]');
        const swab  = root.querySelector(".fe-accent-dialog-preview");
        const paint = (hex) => swab?.style.setProperty("--fe-accent-swatch", hex);
        color?.addEventListener("input", () => {
          if (text) text.value = color.value;
          paint(color.value);
        });
        text?.addEventListener("input", () => {
          const hex = _normalizeHex(text.value);
          if (!hex || !color) return;
          color.value = hex;
          paint(hex);
        });
      },
      ok: {
        label: feLocalize("FE.Common.Confirm"),
        callback: (_ev, btn) => btn.form.elements.accent.value,
      },
    });
  } catch {
    return; // cancelled / closed — nothing was applied
  }

  const hex = _normalizeHex(picked);
  if (!hex || hex === _normalizeHex(cur)) return;
  label?.style.setProperty("--fe-accent-swatch", hex);
  await _setAccent(hex);
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

  // No nested <input type="color"> any more: the native picker commits while the
  // user is still dragging. The swatch is just a button that opens the dialog.
  const label = document.createElement("label");
  label.id        = ACCENT_BTN_ID;
  label.className = "fe-dx3rd-accent-btn";
  label.title     = feLocalize("FE.Dx3rdResourceUi.window.title");
  label.setAttribute("role", "button");
  label.style.setProperty("--fe-accent-swatch", color);
  label.addEventListener("click", (ev) => {
    ev.preventDefault();
    void _openAccentDialog(label);
  });

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
  if (options.some(o => o.name === feLocalize("FE.Dx3rdResourceUi._ruiContextEntry"))) return;
  // v14 replaced ContextMenuEntry#name/#condition with label/visible (removal slated for
  // v16). Minimum support is v13, so emit both key pairs.
  const visible = li => {
    const el = li instanceof jQuery ? li[0] : li;
    const id = el?.dataset?.documentId ?? el?.dataset?.entryId ?? el?.dataset?.actorId;
    // Owned actors only — isOwner is everything for a GM, own actors for a player.
    return !!game.actors.get(id)?.isOwner;
  };
  const item = {
    label: feLocalize("FE.Dx3rdResourceUi._ruiContextEntry"),
    name: feLocalize("FE.Dx3rdResourceUi._ruiContextEntry"),
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
    if (typeof options[i]?.name === "string" && options[i].name.startsWith(feLocalize("FE.Common.Stage"))) at = i;
  }
  if (at < 0) {
    const editLabel = game.i18n?.localize?.("SIDEBAR.Edit") ?? feLocalize("FE.Common.Edit");
    at = options.findIndex(o =>
      o?.label === "SIDEBAR.Edit" || o?.name === "SIDEBAR.Edit" ||
      o?.label === editLabel       || o?.name === editLabel);
  }
  options.splice(at + 1, 0, item);
}

Hooks.on("getActorContextOptions",     _ruiContextEntry);
Hooks.on("getActorContextMenuOptions", _ruiContextEntry);

// New actors used to be seeded with the mask flag here (DX3rd only), which is what
// made "absent" mean "revealed" for everything else. fe-hp-mask.js makes absent mean
// masked, so there is nothing to write on creation any more — and every system, not
// just DX3rd, now starts private.

// Canvas token right-click: inject buttons into the Token HUD. There is no core
// getTokenEntries hook, so renderTokenHUD is the entry point.
// The one place an <i> is built for this feature. `inert` keeps the glyph out of the hit
// test so the click always lands on the button itself.
function _iconEl(faClasses) {
  const i = document.createElement("i");
  i.className = faClasses;
  i.toggleAttribute("inert", true);
  return i;
}

function _hudIconBtn(label, faIcon, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "control-icon fedr-hud-btn";
  btn.dataset.tooltip = "";
  btn.setAttribute("aria-label", label);
  btn.append(_iconEl(`fa-solid ${faIcon}`));
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

// Actor-sheet header button. Both entries (pin, mask) were byte-identical apart from
// title/icon/handler.
function _sheetHeaderBtn(title, faIcon, onClick) {
  const btn = document.createElement("a");
  btn.className = "header-button fedr-sheet-btn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.append(_iconEl(`fas ${faIcon}`));
  btn.addEventListener("click", (e) => { e.preventDefault(); onClick(); });
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
      colLeft.appendChild(_hudIconBtn(feLocalize("FE.Common.SwitchSpeaker"), "fa-comment-dots",
        () => globalThis.fetSetSpeakingAs?.(actor.id)));
      colLeft.appendChild(_hudIconBtn(feLocalize("FE.Common.RemoveFromStage"), "fa-theater-masks",
        () => globalThis.fetRemoveFromStage?.(actor.id)));
    } else {
      colLeft.appendChild(_hudIconBtn(feLocalize("FE.Common.AddToStage"), "fa-theater-masks",
        () => globalThis.fetAddToStage?.(actor)));
    }
  }

  // Status toggle — supported systems with the feature enabled only.
  if (_isSupported() && _ruiEnabled()) {
    const pinned = _isActorPinned(actor);
    colRight.appendChild(_hudIconBtn(
      pinned ? feLocalize("FE.Dx3rdResourceUi._injectTokenHudButtons") : feLocalize("FE.Dx3rdResourceUi._injectTokenHudButtons2"),
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
    label: _isMasked(actor) ? feLocalize("FE.Dx3rdResourceUi.label3") : feLocalize("FE.Dx3rdResourceUi.label4"),
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

  const btn = _sheetHeaderBtn(
    pinned ? feLocalize("FECT.Ctx.Hide") : feLocalize("FE.Dx3rdResourceUi.title"),
    pinned ? "fa-eye" : "fa-eye-slash",
    () => _toggleActorPin(actor)
  );
  const maskBtn = _sheetHeaderBtn(
    masked ? feLocalize("FE.Dx3rdResourceUi.label3") : feLocalize("FE.Dx3rdResourceUi.label4"),
    "fa-question-circle",
    () => _toggleActorMask(actor)
  );

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
  feRegisterSetting(S.DX3RD_RUI_ENABLED, () => {
      feRebuildDx3rdResourceUI();
      // Clean up header buttons on already-open sheets when toggling off (no re-render).
      if (!_ruiEnabled()) document.querySelectorAll(".fedr-sheet-btn").forEach(b => b.remove());
    });
  feRegisterSetting(S.DX3RD_RUI_VISIBLE, _refreshVisibility);
  feRegisterSetting(S.DX3RD_RUI_YIELD_TO_TRACKER, _syncTrackerYield);
  feRegisterSetting(S.DX3RD_RUI_PORTRAIT_WIDTH, feRebuildDx3rdResourceUI);
  feRegisterSetting(S.DX3RD_RUI_PANEL_WIDTH, feRebuildDx3rdResourceUI);
  feRegisterSetting(S.DX3RD_RUI_CARD_HEIGHT, feRebuildDx3rdResourceUI);
});

// The tracker fires this whenever one of the settings feCtDisplaysHp reads changes.
// It cannot be a feRegisterSetting onChange on our side: those keys already have one
// (the tracker's), and a setting gets exactly one.
Hooks.on(`${MODULE_ID}.combatTrackerHpDisplay`, _syncTrackerYield);

// The other half of feCtDisplaysHp is "a combat is on screen", so the stand-down has to
// follow the encounter's whole life. These are the same hooks the tracker itself
// rerenders on, minus the ones that cannot change whether turns exist; _syncTrackerYield
// throws away the ones that change nothing, which is nearly all of them.
for (const hook of ["createCombat", "deleteCombat", "updateCombat",
  "createCombatant", "deleteCombatant"]) {
  Hooks.on(hook, _syncTrackerYield);
}

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
