// female_edition: Screen Panel — entry / orchestrator (registered in module.json).
//
// Hybrid feature: a module-defined Actor sub-type (data + native ownership +
// directory) whose "faces" can be placed on the scene canvas as Tiles. See
// CLAUDE.md / the plan for the full rationale.
//
// Responsibilities:
//   - init    : register the data model, the sheet, and the enable setting.
//   - ready   : wire up the GM socket relay, the menu action callbacks, the
//               dismissers, and expose the placement API for the sheet button.
//   - canvas  : a capture-phase board listener performs hit-testing so panel
//               tiles are clickable during normal play, opening the dropdown
//               menu / showing the hover tooltip. A press that travels past a
//               small threshold becomes an owner drag-to-reposition (live mesh
//               preview, final x/y committed via the relay on release); a press
//               that does not travel is treated as a click.
//   - relay   : players cannot write scene-embedded Tiles, so all mutating ops
//               (place/remove/show-hide/flip/disable/move) are emitted on the shared
//               "module.female_edition" socket and applied by the active GM,
//               which re-checks the requester's actor ownership.
//   - hidden  : per-user "disabled" hiding is pure client-side render gating.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";
import {
  FE_PANEL_TYPE,
  FE_PANEL_SUBTYPE,
  FE_PANEL_TILE_FLAG,
  FE_PANEL_SOCKET,
  FE_PANEL_DEFAULT_SIZE,
  ScreenPanelData,
  feEnsureScreenPanelDnd5eActorCompat,
  feCleanFaceTokenData,
  feFaceTokenPinsSize,
  fePanelFace,
} from "./fe-screen-panel-data.js";
import { ScreenPanelSheet } from "./fe-screen-panel-sheet.js";
import {
  feSetPanelMenuActions,
  feOpenPanelMenu,
  closePanelMenu,
  isPanelMenuOpen,
  feShowPanelTooltip,
  feHidePanelTooltip,
  feInitPanelMenuDismissers,
} from "./fe-screen-panel-menu.js";

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const PANEL_SOCKET_TYPES = new Set(Object.values(FE_PANEL_SOCKET));

function isPanelFeatureEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.SCREEN_PANEL_ENABLED); }
  catch { return !!FE_DEFAULTS[S.SCREEN_PANEL_ENABLED]; }
}

/**
 * Wrap a hook handler so the feature switch actually switches it off.
 *
 * The Actor SUB-TYPE can never be unregistered — pulling `CONFIG.Actor.dataModels` out
 * from under existing panel actors turns them into invalid documents — so "off" cannot
 * mean the feature stops existing. What it CAN mean, and now does, is that this module
 * stops touching the canvas: no overlays, no size enforcement, no visibility gate, no
 * position lock, no placement entry points. The sheet and the actor keep working.
 *
 * Before this existed, `S.SCREEN_PANEL_ENABLED` gated only the three board listeners and
 * the HUD veto, which left the worst possible half-state: the lock was still enforced in
 * `preUpdateTile`/`preUpdateToken` while the right-click menu that releases it was
 * silenced — a placement nobody could move and nobody could unlock. That is the same trap
 * the ghost-placement work removed, arrived at from the other direction.
 *
 * Wrapping at the REGISTRATION site rather than inside each function keeps the functions
 * callable from our own already-gated code paths (the drag preview repositions overlays,
 * the updateActor loop rebuilds them) without every one of them re-reading the setting.
 * Teardown handlers are deliberately NOT wrapped — cleanup must run whatever the setting
 * says, or a client that declines the reload prompt keeps its overlays forever.
 */
const fePanelGated = (fn) => (...args) => (isPanelFeatureEnabled() ? fn(...args) : undefined);

// Per-client storage for "snap to grid while dragging". It is not in
// FE_GM_PRIORITY_EXCLUDED_KEYS, so GM priority may force the local value.
function isGridSnapEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.SCREEN_PANEL_GRID_SNAP); }
  catch { return !!FE_DEFAULTS[S.SCREEN_PANEL_GRID_SNAP]; }
}

// Double-click face cycling is a PER-PANEL setting on the actor (system.dblclickCycle),
// not a client setting: it is world data, so a GM turning it off applies to every user
// rather than only themselves, and each panel can differ.
function isDblclickCycleEnabled(actor) {
  return actor?.system?.dblclickCycle !== false;
}

async function toggleDblclickCycle(actor) {
  if (!actor?.testUserPermission(game.user, "OWNER")) return isDblclickCycleEnabled(actor);
  const next = !isDblclickCycleEnabled(actor);
  try { await actor.update({ "system.dblclickCycle": next }); return next; }
  catch { return isDblclickCycleEnabled(actor); }
}

async function toggleGridSnap() {
  try {
    const next = !isGridSnapEnabled();
    await game.settings.set(MODULE_ID, S.SCREEN_PANEL_GRID_SNAP, next);
    return next;
  } catch { return isGridSnapEnabled(); }
}

// Snap a tile top-left (world coords) to the scene grid. On square/hex scenes we
// defer to core's grid-aware snapping (TOP_LEFT_VERTEX); on GRIDLESS scenes core
// returns the point unchanged, so we snap to the base grid-size lattice instead so
// the toggle still aligns panels predictably.
function feSnapPanelPoint(x, y) {
  const grid = canvas?.grid;
  if (!grid) return { x, y };
  const size = grid.size || 100;
  const GRIDLESS = CONST?.GRID_TYPES?.GRIDLESS ?? 0;
  if (grid.type !== GRIDLESS) {
    try {
      const mode = CONST?.GRID_SNAPPING_MODES?.TOP_LEFT_VERTEX ?? CONST?.GRID_SNAPPING_MODES?.VERTEX;
      const p = grid.getSnappedPoint?.({ x, y }, { mode, resolution: 1 });
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: Math.round(p.x), y: Math.round(p.y) };
    } catch { /* fall through to manual snap */ }
  }
  return { x: Math.round(x / size) * size, y: Math.round(y / size) * size };
}

// --------------------------------
// Coordinate + hit-testing helpers
// --------------------------------

function clientToWorld(cx, cy) {
  // canvas.canvasCoordinatesFromClient is the same client→world conversion core
  // uses for pointer events (see canvas/board.mjs _onClick handlers).
  try { return canvas?.canvasCoordinatesFromClient?.({ x: cx, y: cy }) ?? null; }
  catch { return null; }
}

// --------------------------------
// Image aspect helpers (tile is sized to the image so its bounds == the art)
// --------------------------------

const _panelImgSizeCache = new Map();   // src -> {w,h} | null
const _panelImgSizePending = new Map(); // src -> Promise
const FE_PANEL_IMG_SIZE_CACHE_MAX = 512;

function feGetCachedImageSize(src) {
  if (!_panelImgSizeCache.has(src)) return { hit: false, value: null };
  const value = _panelImgSizeCache.get(src);
  _panelImgSizeCache.delete(src);
  _panelImgSizeCache.set(src, value);
  return { hit: true, value };
}

function feSetCachedImageSize(src, value) {
  _panelImgSizeCache.delete(src);
  _panelImgSizeCache.set(src, value);
  while (_panelImgSizeCache.size > FE_PANEL_IMG_SIZE_CACHE_MAX) {
    _panelImgSizeCache.delete(_panelImgSizeCache.keys().next().value);
  }
}

/** Natural pixel size of an image src (cached; null on failure / empty). */
function feLoadImageSize(src) {
  if (!src) return Promise.resolve(null);
  const cached = feGetCachedImageSize(src);
  if (cached.hit) return Promise.resolve(cached.value);
  if (_panelImgSizePending.has(src)) return _panelImgSizePending.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { const r = { w: img.naturalWidth, h: img.naturalHeight }; feSetCachedImageSize(src, r); resolve(r); };
    img.onerror = () => { feSetCachedImageSize(src, null); resolve(null); };
    img.src = src;
  }).finally(() => _panelImgSizePending.delete(src));
  _panelImgSizePending.set(src, p);
  return p;
}

/** Fit a (boxW×boxH) bounding box to the image's aspect ratio (shrinks the long side). */
function feAspectFit(boxW, boxH, natW, natH) {
  if (!(natW > 0) || !(natH > 0) || !(boxW > 0) || !(boxH > 0)) return { w: boxW, h: boxH };
  const ratio = natW / natH;
  if (boxW / boxH > ratio) return { w: Math.max(1, Math.round(boxH * ratio)), h: boxH };
  return { w: boxW, h: Math.max(1, Math.round(boxW / ratio)) };
}

/**
 * World-space rect of the ACTUALLY DRAWN image (the mesh), not the tile's box.
 * This is what makes the clickable area match the visible art regardless of the
 * texture `fit` mode, anchor, or whether the aspect resize has applied yet (with
 * `contain` a mismatched box would otherwise leave the image small in the
 * top-left and the box overflowing to the bottom-right). Falls back to the doc
 * rectangle if the mesh isn't ready.
 */
function panelTileRect(tile) {
  const doc = tile.document;
  const m = tile.mesh;
  const tex = m?.texture;
  if (m && tex?.width > 0 && tex?.height > 0) {
    // Displayed size = |scale| × texture size — exactly how PrimarySpriteMesh#resize
    // derives the rendered dimensions, so this matches the visible art for any fit.
    const mw = Math.abs((m.scale?.x ?? 1) * tex.width);
    const mh = Math.abs((m.scale?.y ?? 1) * tex.height);
    if (mw > 0 && mh > 0) {
      const ax = m.anchor?.x ?? 0, ay = m.anchor?.y ?? 0;
      const left = m.position.x - (ax * mw);
      const top = m.position.y - (ay * mh);
      return { left, top, right: left + mw, bottom: top + mh };
    }
  }
  return { left: doc.x, top: doc.y, right: doc.x + doc.width, bottom: doc.y + doc.height };
}

/**
 * Topmost panel placeable (by elevation, sort) at a world point that this user may see.
 *
 * A panel is a Tile OR a Token (see ScreenPanelData.tokenize), and the two are treated
 * very differently by the caller, hence the opt-in: **core** owns a tokenized panel's
 * interaction (drag, select, grid snap), so the left-click/drag path scans tiles only
 * and lets token panels fall through, while the right-click menu scans both.
 */
function pickPanelTileAt(world, { tiles = true, tokens = false } = {}) {
  const placeables = [
    ...(tiles ? canvas?.tiles?.placeables ?? [] : []),
    ...(tokens ? canvas?.tokens?.placeables ?? [] : []),
  ];
  let best = null;
  let bestKey = -Infinity;
  for (const tile of placeables) {
    const doc = tile.document;
    const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) continue;
    if (doc.hidden && !game.user.isGM) continue; // hidden tiles are a GM secret
    const actor = game.actors.get(flag.actorId);
    if (!actor || !actor.testUserPermission(game.user, "OBSERVER")) continue;
    const r = panelTileRect(tile);
    if (world.x < r.left || world.y < r.top || world.x > r.right || world.y > r.bottom) continue;
    const key = (doc.elevation ?? 0) * 1e6 + (doc.sort ?? 0);
    if (key >= bestKey) { bestKey = key; best = { tile, doc, actor, flag }; }
  }
  return best;
}

/**
 * A value bar at a world point on this tile, but ONLY if the current user has
 * OWNER permission on the bar's own linked actor — permission is baked into the
 * hit test itself so a non-owner's click silently falls through to the normal
 * panel click/drag handling below (the bar simply isn't "there" for them).
 */
function pickPanelBarAt(tile, world) {
  const list = tile?._fePanelOverlays;
  if (!list?.length) return null;
  for (const bar of list) {
    if (!bar._feIsBar) continue;
    const left = bar.position.x, top = bar.position.y;
    const w = bar._feBarW ?? 0, h = bar._feBarH ?? 0;
    if (world.x < left || world.x > left + w || world.y < top || world.y > top + h) continue;
    const linkedActor = bar._feLinkedActor;
    if (!linkedActor?.testUserPermission?.(game.user, "OWNER")) continue;
    return { linkedActor, attr: bar._feAttr, value: bar._feValue };
  }
  return null;
}

/** Whether a visible token at/above the panel's elevation covers the point. */
function tokenOccludesAt(world, panelDoc) {
  const tokens = canvas?.tokens?.placeables ?? [];
  const panelElev = panelDoc.elevation ?? 0;
  for (const tk of tokens) {
    if (!tk.visible) continue;
    if ((tk.document.elevation ?? 0) < panelElev) continue;
    const x = tk.x, y = tk.y, w = tk.w ?? 0, h = tk.h ?? 0;
    if (world.x >= x && world.y >= y && world.x <= x + w && world.y <= y + h) return true;
  }
  return false;
}

// --------------------------------
// Board listeners (capture phase)
// --------------------------------

let _boardEl = null;
let _lastMove = 0;
let _cancelPanelPointer = null;

function attachBoardListeners() {
  const view = canvas?.app?.view;
  if (!view || view === _boardEl) return; // canvas element is stable across scenes
  if (_boardEl) {
    _boardEl.removeEventListener("pointerdown", onBoardPointerDown, true);
    _boardEl.removeEventListener("contextmenu", onBoardContextMenu, true);
    _boardEl.removeEventListener("mousemove", onBoardMouseMove, false);
    _boardEl.removeEventListener("mouseleave", onBoardMouseLeave, false);
  }
  _boardEl = view;
  view.addEventListener("pointerdown", onBoardPointerDown, true);
  view.addEventListener("contextmenu", onBoardContextMenu, true);
  view.addEventListener("mousemove", onBoardMouseMove, false);
  view.addEventListener("mouseleave", onBoardMouseLeave, false);
}

const FE_PANEL_DRAG_THRESHOLD = 6; // px of pointer travel before a click becomes a drag

// Interaction model (Cocoforia-style): left-drag = move, right-click = menu,
// double-click = cycle to the next face. A bare left click does nothing (the
// menu is on right-click), so double-click detection is just a timestamp check.
const FE_PANEL_DBLCLICK_MS = 300;
let _lastPanelClick = null; // { tileId, t }

/**
 * Unwind any PIXI drag workflow core already started for this pointerdown.
 *
 * PIXI's EventSystem registered its own capture-phase listener on the same <canvas>
 * BEFORE ours, so it dispatches the federated pointerdown (and core's
 * MouseInteractionManager reacts) before our `stopImmediatePropagation` can land. By
 * the time we decide to handle the press ourselves, the board MIM — and, when the
 * press landed on a token, that token's MIM — has already reached CLICKED/GRABBED and
 * armed its drag handlers. Left alone that produces a canvas marquee, or a token that
 * drags along behind whatever UI we just opened.
 *
 * MUST be `cancel()`, NOT `reset({state: true})`. `reset` drops the state to NONE and
 * stops there: `#handleLeftDown` requires `HOVER ≤ state ≤ DRAG`, so the manager would
 * ignore EVERY later left click and drag, and the only route back to HOVER is
 * `#handlePointerOver` — which never re-fires while the cursor stays over the canvas
 * (PIXI keeps the target in its `overTargets`). The pointerup path cannot repair it
 * either: `#handlePointerUp` → `cancel()` early-returns on `state ≤ HOVER`, so
 * `canvas.currentMouseManager` stays pinned and the drag listeners stay live. Symptom:
 * one click on a tile panel froze all canvas interaction until the pointer left the
 * window and came back. `cancel()` runs core's full unwind (interactionData cleared,
 * state → HOVER, `currentMouseManager` released, drag events deactivated); HOVER is
 * below GRABBED so `#handlePointerMove` still bails and no marquee/drag starts. It is
 * self-skipping (`state ≤ HOVER`) when our suppression won the race and the MIM never
 * engaged, so calling it unconditionally is safe.
 *
 * @param {PlaceableObject} [placeable]  Also unwind this placeable's own manager.
 */
function feCancelCanvasDragWorkflows(placeable) {
  try { canvas.mouseInteractionManager?.cancel?.(); } catch { /* no-op */ }
  try { placeable?.mouseInteractionManager?.cancel?.(); } catch { /* no-op */ }
}

function onBoardPointerDown(event) {
  if (!isPanelFeatureEnabled() || event.button !== 0 || !canvas?.ready) return;
  const world = clientToWorld(event.clientX, event.clientY);
  if (!world) return;

  // Tokenized panel: core owns left-click (select, drag, grid snap) — do NOT intercept,
  // or we would fight its MouseInteractionManager. The one exception is a value bar,
  // which is a tiny explicit target that could not plausibly mean "drag me".
  const tokenHit = pickPanelTileAt(world, { tiles: false, tokens: true });
  if (tokenHit) {
    const bar = pickPanelBarAt(tokenHit.tile, world);
    if (!bar) return; // core drags it
    event.preventDefault();
    event.stopImmediatePropagation();
    // PIXI dispatched this pointerdown to the TOKEN before our DOM listener ran (same
    // race as the marquee below), so core's own `#handleClickLeft` has already taken
    // the token to GRABBED and armed its drag handlers. Without unwinding it the
    // value-editor dialog opens AND the token drags along under the cursor.
    feCancelCanvasDragWorkflows(tokenHit.tile);
    feHidePanelTooltip();
    feOpenBarValueEditor(bar.linkedActor, bar.attr, bar.value);
    return;
  }

  const hit = pickPanelTileAt(world);
  if (!hit || tokenOccludesAt(world, hit.doc)) return; // let core handle non-panel / token clicks
  // Tiles layer active = the GM is deliberately in tile-editing mode, so core owns this
  // tile exactly like it owns a tokenized panel on the Tokens layer. Intercepting here
  // is not merely unhelpful, it CONFLICTS: `PlaceablesLayer#_deactivate` sets
  // `objects.visible = false`, so a tile placeable is hit-tested by PIXI only while its
  // layer is active — and when it is, core selects and drags it from the same
  // pointerdown we are handling (PIXI won the race, see feCancelCanvasDragWorkflows).
  // Both drags then move the mesh and both commit on release. Standing down is also what
  // makes the panel menu's own premise true — that a tile panel is reachable through
  // core's Tiles-layer tools (select, delete, send to back/front).
  if (hit.tile.layer?.active) return;
  event.preventDefault();
  event.stopImmediatePropagation(); // suppress core canvas pan / selection
  // Kill the canvas marquee core has already started (see the helper — the MUST-keep
  // `cancel()` vs `reset()` detail lives there). Our own panel drag runs on independent
  // window listeners, so this only cancels the stray canvas selection, not the move.
  feCancelCanvasDragWorkflows();
  feHidePanelTooltip();

  // A click landing on a value bar (only "there" for users with OWNER on its
  // linked actor — see pickPanelBarAt) opens its quick-edit dialog instead of
  // starting a drag or counting toward the double-click face cycle.
  const barHit = pickPanelBarAt(hit.tile, world);
  if (barHit) { feOpenBarValueEditor(barHit.linkedActor, barHit.attr, barHit.value); return; }

  // Owners may left-drag to reposition (unless the panel is locked — per-actor or
  // per-placement). Below the move threshold it is a click; a double click cycles the
  // face. The menu lives on right-click (onBoardContextMenu). Route the lock question
  // through feIsPanelPlacementLocked rather than re-testing the two sources inline: this
  // is the client-side convenience check and the preUpdate hook is the real gate, so the
  // two drifting apart would mean a drag that appears to work and then snaps back.
  const canDrag = hit.actor.testUserPermission(game.user, "OWNER")
    && !feIsPanelPlacementLocked(hit.doc);
  startPanelPointer(hit, event, canDrag);
}

// Right-click on a panel opens its menu (Cocoforia-style). Capture phase so it
// runs before core's canvas context handling; we suppress the default browser
// menu and core's right-context behaviour over the panel only.
function onBoardContextMenu(event) {
  if (!isPanelFeatureEnabled() || !canvas?.ready) return;
  const world = clientToWorld(event.clientX, event.clientY);
  if (!world) return;
  // Tokenized panels get the panel menu too — it is their ONLY way to switch faces,
  // lock position or open the sheet, since core owns everything else about them.
  const hit = pickPanelTileAt(world, { tokens: true });
  if (!hit) return;
  // A token sitting on top of a TILE panel means the user is aiming at that token, so
  // core should handle it. Never applies when the panel IS the token (it would find
  // itself and always bail).
  if (!feIsPanelToken(hit.tile)) {
    if (tokenOccludesAt(world, hit.doc)) return;
    // Tiles layer active → core owns this tile (see onBoardPointerDown). Its own Tile HUD
    // opens from the same right-click and we do NOT veto `_canHUD` for tiles (only for
    // panel tokens), so showing our menu on top would stack two menus on one click.
    if (hit.tile.layer?.active) return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  feHidePanelTooltip();
  feOpenPanelMenu({ tile: hit.tile, actor: hit.actor, clientX: event.clientX, clientY: event.clientY });
}

/**
 * Track a pointer press on a panel tile: past the move threshold it becomes a
 * live drag (mesh moved locally, final position committed via the GM relay on
 * release); below the threshold it is a click that opens the dropdown menu.
 */
function startPanelPointer(hit, downEvent, canDrag) {
  // A second press or a scene teardown must never leave the previous drag's
  // window listeners alive to commit a stale tile after the canvas has changed.
  _cancelPanelPointer?.();
  const start = { x: downEvent.clientX, y: downEvent.clientY };
  const startWorld = clientToWorld(start.x, start.y);
  const origin = { x: hit.doc.x, y: hit.doc.y };
  const mesh = hit.tile.mesh;
  let dragging = false;
  let finalPos = origin;

  const onMove = (e) => {
    if (!canDrag || !startWorld) return;
    if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) < FE_PANEL_DRAG_THRESHOLD) return;
    dragging = true;
    const w = clientToWorld(e.clientX, e.clientY);
    if (!w) return;
    let nx = Math.round(origin.x + (w.x - startWorld.x));
    let ny = Math.round(origin.y + (w.y - startWorld.y));
    if (isGridSnapEnabled()) { const s = feSnapPanelPoint(nx, ny); nx = s.x; ny = s.y; }
    finalPos = { x: nx, y: ny };
    if (mesh) mesh.position.set(finalPos.x, finalPos.y); // local preview; authoritative update on release
    feRepositionPanelOverlays(hit.tile); // keep labels glued to the image during the drag preview
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    if (_cancelPanelPointer === onCancel) _cancelPanelPointer = null;
  };
  const onUp = (e) => {
    cleanup();
    if (dragging) {
      // Optimistic local sync — but ONLY for non-GM clients. The authoritative
      // persistence is feActionMove → applyPanelOp → doc.update({x,y}). Core's
      // update pipeline (client-backend.mjs) diffs the change against doc._source
      // and SKIPS the DB write entirely when the diff is empty. On the GM's own
      // client feActionMove runs doc.update() locally, so pre-writing _source via
      // updateSource here would make that update a no-op → the move is never
      // persisted → the position is lost on scene switch. Players relay to the GM
      // (whose _source is untouched), so their optimistic write is safe and avoids
      // a transient snap-back while the relay round-trips.
      if (!game.user.isGM) { try { hit.doc.updateSource({ x: finalPos.x, y: finalPos.y }); } catch { /* no-op */ } }
      feActionMove(hit.tile, finalPos.x, finalPos.y);
      return;
    }
    // Click (no travel). A double click (second click on the SAME tile within
    // the window) cycles to the next face (when enabled). A single click does
    // nothing — the menu is on right-click.
    const tileId = hit.tile.document.id;
    const now = performance.now();
    if (isDblclickCycleEnabled(hit.actor) && _lastPanelClick && _lastPanelClick.tileId === tileId && (now - _lastPanelClick.t) < FE_PANEL_DBLCLICK_MS) {
      _lastPanelClick = null;
      feCyclePanelFace(hit.tile, hit.actor);
    } else {
      _lastPanelClick = { tileId, t: now };
    }
  };
  const onCancel = () => {
    cleanup();
    if (mesh) mesh.position.set(origin.x, origin.y); // snap preview back
    feRepositionPanelOverlays(hit.tile);
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  _cancelPanelPointer = onCancel;
}

function onBoardMouseMove(event) {
  if (!isPanelFeatureEnabled() || !canvas?.ready) return;
  const now = performance.now();
  if (now - _lastMove < 30) return;
  _lastMove = now;
  if (isPanelMenuOpen()) { feHidePanelTooltip(); return; }
  const world = clientToWorld(event.clientX, event.clientY);
  if (!world) { feHidePanelTooltip(); return; }
  const hit = pickPanelTileAt(world, { tokens: true });
  if (!hit) { feHidePanelTooltip(); return; }
  if (!feIsPanelToken(hit.tile) && tokenOccludesAt(world, hit.doc)) { feHidePanelTooltip(); return; }
  const face = fePanelFace(hit.actor, hit.flag.currentFace ?? 0);
  feShowPanelTooltip(face.description, event.clientX, event.clientY);
}

function onBoardMouseLeave() {
  feHidePanelTooltip();
}

// --------------------------------
// Per-user "disabled" visibility (client-side render gate)
// --------------------------------

// Render-time enforcement: every client resizes panel tiles to their image's
// aspect ratio locally, so a plain refresh fixes legacy (square) tiles for
// everyone — GM or player, no DB write or permission required. The natural size
// is read straight off the tile's already-loaded PIXI texture (synchronous &
// reliable — no async Image() that can silently fail), and the bounding box is
// the actor's width×height (stable across face flips). updateSource mutates the
// live doc (and _source) in memory only — no persistence needed. A texture.src
// change triggers a full redraw (drawTile fires again with the new texture), so
// this also covers face flips. Idempotent (±1px) → no loop.
function enforcePanelTileSize(tile) {
  try {
    const doc = tile?.document;
    const flag = doc?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) return;
    const tex = tile.texture;
    const natW = tex?.width, natH = tex?.height;
    if (!(natW > 0) || !(natH > 0)) return; // texture not ready / failed to load
    // No actor → stop enforcing. Falling back to FE_PANEL_DEFAULT_SIZE here meant a ghost
    // was re-fitted to a 400px box on EVERY draw, so resizing one with core's tile handles
    // silently snapped back on the next redraw — the size was owned by a panel that no
    // longer exists. Let the user's own dimensions stand.
    const actor = feResolvePanelPlacementActor(doc);
    if (!actor) return;
    const boxW = actor.system?.width || FE_PANEL_DEFAULT_SIZE;
    const boxH = actor.system?.height || FE_PANEL_DEFAULT_SIZE;
    const { w, h } = feAspectFit(boxW, boxH, natW, natH);

    // Tokenized panel: width/height are GRID UNITS, not pixels, and there is no
    // `fit` to enforce (core scales a token's texture to its box). Convert the same
    // aspect-fitted pixel box through the grid so a face flip to a differently-shaped
    // image reshapes the token exactly like it reshapes a tile.
    if (feIsPanelToken(tile)) {
      // A face whose Token settings pin an explicit size owns it — the user set it through
      // core's TokenConfig, so the aspect auto-fit must not fight them every draw.
      if (feFaceTokenPinsSize(fePanelFace(actor, flag.currentFace ?? 0))) return;
      // Do NOT read the local grid-snap preference here. Unlike a Tile (whose pixel box
      // is the same number everywhere), a Token's width/height are grid units that this
      // render gate rewrites locally — so consulting a CLIENT setting would draw the very
      // same panel at whole-cell size for one player and pixel-exact size for another,
      // throwing off the overlays and the hit test with it. The stored size is the shared
      // truth (PLACE recorded the placing user's snap intent); infer the mode back out of
      // it, so a face flip reshapes the token the same way on every client.
      const storedSnapped = Number.isInteger(doc.width) && Number.isInteger(doc.height);
      const size = feCompanionTokenSize(doc.parent, w, h, storedSnapped);
      // Tolerance in grid units: ±1px worth, so rounding cannot loop.
      const tol = 1 / (doc.parent?.grid?.size || canvas?.grid?.size || 100);
      if (Math.abs(doc.width - size.width) <= tol && Math.abs(doc.height - size.height) <= tol) return;
      doc.updateSource(size);
      tile.renderFlags?.set?.({ refreshSize: true });
      return;
    }

    const fitOk = doc.texture?.fit === "contain";
    // ±1px tolerance prevents rounding from causing an endless resize loop.
    if (Math.abs(doc.width - w) <= 1 && Math.abs(doc.height - h) <= 1 && fitOk) return;
    doc.updateSource({ width: w, height: h, texture: { fit: "contain" } });
    doc.prepareDerivedData(); // rebuild doc.shape (updateSource does not re-derive)
    tile.renderFlags?.set?.({ refreshTransform: true });
  } catch { /* no-op */ }
}

function applyPanelTileVisibility(tile) {
  try {
    const flag = tile?.document?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) return;
    // No actor → not ours any more (feResolvePanelPlacementActor). MUST bail BEFORE the
    // `disabled` branch: the per-user gate below hides the placeable from everyone who
    // is not an OBSERVER of the panel, and "no actor" fails that test for EVERY user
    // including the GM. A ghost that happened to be left in 표시 끔 would have been
    // invisible to the whole world, permanently and with no UI to reveal it — the one
    // state where it really would have been unreachable. This subtracts nothing now, so
    // core's own visibility (recomputed first, see onPanelPlaceableUpdate) stands.
    const panelActor = feResolvePanelPlacementActor(tile.document);
    if (!panelActor) return;
    const overlays = tile._fePanelOverlays;
    if (!flag.disabled) {
      if (overlays) for (const t of overlays) t.visible = true;
      return;
    }
    const canSee = panelActor.testUserPermission(game.user, "OBSERVER");
    if (!canSee) {
      if (tile.mesh) tile.mesh.visible = false;
      tile.visible = false;
      if (overlays) for (const t of overlays) t.visible = false;
    } else if (overlays) {
      for (const t of overlays) t.visible = true;
    }
  } catch { /* no-op */ }
}

// --------------------------------
// Overlay labels — text / live attribute values burned onto a face's image at
// specific coordinates. Rendered as PIXI text objects parented into
// canvas.primary, the SAME group that holds the tile's own mesh (see
// `panelTileRect` above): Tile/PlaceableObject itself stays at local (0,0) and
// never moves — only `tile.mesh` is positioned in world space (registered with
// canvas.primary so it stays visible regardless of which canvas layer is
// active). Parenting the labels there too means they pan/zoom/elevation-sort
// identically with zero manual per-frame syncing, instead of fighting with
// TilesLayer's active/inactive interaction-layer visibility.
// --------------------------------

const FE_OVERLAY_TEXT_CLASS = foundry.canvas?.containers?.PreciseText ?? PIXI.Text;

// Canvas-local reverse indexes used by updateActor.  A normal Actor update (HP,
// resources, effects, etc.) used to scan every Tile on the current scene and
// resolve every overlay UUID just to discover whether that Actor was displayed
// anywhere.  Keep the lookup work at Tile draw/update time instead, when the
// panel's current face is already being refreshed.  These contain Placeable
// objects only, so they are cleared whenever the canvas is redrawn.
const fePanelTilesByActorId = new Map();
const fePanelTilesByLinkedActorId = new Map();
const fePanelTileIndexEntries = new WeakMap();
let fePanelTileIndexReady = false;

function feRemovePanelTileFromIndex(tile) {
  const entry = fePanelTileIndexEntries.get(tile);
  if (!entry) return;
  const remove = (map, id) => {
    const tiles = map.get(id);
    if (!tiles) return;
    tiles.delete(tile);
    if (!tiles.size) map.delete(id);
  };
  remove(fePanelTilesByActorId, entry.panelActorId);
  for (const actorId of entry.linkedActorIds) remove(fePanelTilesByLinkedActorId, actorId);
  fePanelTileIndexEntries.delete(tile);
}

function feIndexPanelTile(tile) {
  feRemovePanelTileFromIndex(tile);
  try {
    const flag = tile?.document?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG);
    const panelActorId = flag?.actorId;
    const panelActor = panelActorId ? game.actors.get(panelActorId) : null;
    if (!panelActor) return;

    const linkedActorIds = new Set();
    const face = fePanelFace(panelActor, flag.currentFace ?? 0);
    for (const overlay of face.overlays ?? []) {
      if (!overlay?.linkedActorUuid) continue;
      try {
        const linked = fromUuidSync(overlay.linkedActorUuid);
        if (linked?.id) linkedActorIds.add(linked.id);
      } catch { /* stale UUID: no live label to refresh */ }
    }

    const add = (map, id) => {
      let tiles = map.get(id);
      if (!tiles) map.set(id, tiles = new Set());
      tiles.add(tile);
    };
    add(fePanelTilesByActorId, panelActorId);
    for (const actorId of linkedActorIds) add(fePanelTilesByLinkedActorId, actorId);
    fePanelTileIndexEntries.set(tile, { panelActorId, linkedActorIds });
  } catch { /* no-op */ }
}

/**
 * Every placeable a panel can be drawn as, on the current canvas: Tiles (plain panels)
 * AND Tokens (tokenized panels). Callers filter by the panel flag themselves.
 */
function fePanelPlaceables() {
  return [...(canvas?.tiles?.placeables ?? []), ...(canvas?.tokens?.placeables ?? [])];
}

function feBuildPanelTileIndex() {
  fePanelTilesByActorId.clear();
  fePanelTilesByLinkedActorId.clear();
  for (const tile of fePanelPlaceables()) feIndexPanelTile(tile);
  fePanelTileIndexReady = true;
}

/**
 * Canvas teardown happens before core destroys the old scene's primary group.
 * Dispose of our independently-added PIXI labels and all DOM/drag state here:
 * otherwise a scene switch can leave an old menu callback or pointer-up listener
 * holding a dead Tile object until the next user interaction.
 */
function feResetPanelCanvasState() {
  _cancelPanelPointer?.();
  _cancelPanelPointer = null;
  _lastPanelClick = null;
  closePanelMenu();
  feHidePanelTooltip();
  for (const tile of fePanelPlaceables()) {
    feClearPanelOverlays(tile);
    feRemovePanelTileFromIndex(tile);
  }
  fePanelTilesByActorId.clear();
  fePanelTilesByLinkedActorId.clear();
  fePanelTileIndexReady = false;
}

function feGetIndexedPanelTiles(actorId, { linked = false } = {}) {
  if (!fePanelTileIndexReady) feBuildPanelTileIndex();
  return Array.from((linked ? fePanelTilesByLinkedActorId : fePanelTilesByActorId).get(actorId) ?? []);
}

function feClearPanelOverlays(tile) {
  const list = tile?._fePanelOverlays;
  if (list?.length) {
    for (const t of list) { try { t.destroy(); } catch { /* no-op */ } }
  }
  if (tile) tile._fePanelOverlays = [];
}

/** Live attribute value (if `attr` resolves against the linked actor) else the static fallback text. */
function feResolveOverlayText(item, linkedActor) {
  if (item?.attr && linkedActor) {
    try {
      const v = foundry.utils.getProperty(linkedActor, item.attr);
      // Objects are NOT a value: a path stopping one segment short of its leaf
      // (`system.customAttributes.0` rather than `…0.value`) would otherwise paint
      // the literal "[object Object]" onto the canvas instead of falling back to
      // the static text. Mirrored by ScreenPanelSheet.#resolveAttrValue.
      if (v !== undefined && v !== null && v !== "" && typeof v !== "object") return String(v);
    } catch { /* fall through to static text */ }
  }
  return item?.text ?? "";
}

/** Numeric `attr` value against the linked actor, or null when absent/non-numeric — the bar needs a real number, not the display string. */
function feResolveOverlayNumericValue(item, linkedActor) {
  if (!item?.attr || !linkedActor) return null;
  try {
    const v = foundry.utils.getProperty(linkedActor, item.attr);
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  } catch { /* no-op */ }
  return null;
}

/**
 * (Re)draw a bar's track + fill rects in its own local space (0,0 origin), then its
 * outline. The outline is drawn LAST so neither the track nor the fill paints over
 * it, and with `alignment: 0` (inside the path) so it never grows the bar past the
 * length the user set — `pickPanelBarAt` hit-tests exactly `w`×`h`.
 */
function feDrawBarGraphics(bar, w, h, pct, color, borderWidth, borderColor) {
  bar.clear();
  bar.beginFill(0x000000, 0.5).drawRect(0, 0, w, h).endFill();
  const fillW = Math.max(0, Math.min(w, w * pct));
  if (fillW > 0) bar.beginFill(color || "#33cc33").drawRect(0, 0, fillW, h).endFill();
  if (borderWidth > 0) {
    bar.lineStyle({ width: borderWidth, color: borderColor || "#000000", alignment: 0 });
    bar.drawRect(0, 0, w, h);
    bar.lineStyle(0);
  }
}

/**
 * Turn PIXI word wrap on/off for one overlay's text style — the single place the
 * text-box width is translated, shared by the full rebuild and the cheap reposition
 * path so the two can never drift.
 *
 * `boxWidth` is authored in the face image's own pixels, so it goes through `scale`
 * exactly once, like `fontSize` and `barWidth`. 0 = auto = the original single
 * unwrapped line.
 *
 * `breakWords: true` is load-bearing for Korean. PIXI's `TextMetrics.wordWrap`
 * tokenizes on whitespace, so a Korean sentence written without spaces is ONE token
 * and would overflow the box no matter how narrow it is. The character-breaking
 * branch is only entered for a token that is itself wider than the box, so English
 * still breaks between words — turning this on does not make Latin text break
 * mid-word unless a single word genuinely cannot fit.
 *
 * `align: "center"` because the text is anchored at (0.5, 0.5): with the default
 * left alignment a wrapped second line would sit flush-left inside a box whose
 * CENTRE is the overlay's placement point, i.e. visibly off-anchor.
 */
function feApplyOverlayWordWrap(style, boxWidth, scale) {
  const w = Math.max(0, boxWidth ?? 0);
  if (w > 0) {
    style.wordWrap = true;
    style.wordWrapWidth = Math.max(1, Math.round(w * scale));
    style.breakWords = true;
    style.align = "center";
  } else {
    style.wordWrap = false;
  }
}

/**
 * The bar's box in RENDERED pixels for one text+bar pair — the single source of
 * that geometry, shared by the full rebuild and the cheap reposition path so the
 * two can never drift apart.
 *
 * `scale` is the panel's natural-pixel → screen ratio, the same factor `fontSize`
 * goes through, so every authored dimension is multiplied by it exactly once.
 * The bar's own settings are read off the Graphics (`_feBar*`), which is all the
 * reposition path has; the font size comes from the paired text (`_feFontSize`).
 *
 * - `_feBarWidth > 0` is an explicit length; 0 means auto = the text's own
 *   rendered width (plus side padding in "inside" mode, where the text is *in*
 *   the bar and a tight fit would read as a bug).
 * - "inside" is the boss-HP layout: bar centered ON the text instead of below it,
 *   with a thickness floor of the text's rendered height + padding — that floor
 *   is what makes the FONT SIZE the bar's default thickness.
 */
function feBarBox(text, bar, scale) {
  const inside = bar._feBarMode === "inside";
  const fontPx = Math.max(1, (text._feFontSize || 28) * scale);
  const padX = inside ? Math.round(fontPx * 0.4) : 0;
  const padY = inside ? Math.round(fontPx * 0.22) : 0;
  const w = bar._feBarWidth > 0
    ? Math.max(1, Math.round(bar._feBarWidth * scale))
    : Math.max(1, Math.round(text.width) + padX * 2);
  const floorH = inside ? Math.round(text.height) + padY * 2 : 1;
  const h = Math.max(1, floorH, Math.round((bar._feBarHeight || 6) * scale));
  const gap = Math.max(1, Math.round(2 * scale));
  // A 1px outline authored in image pixels would round to 0 on a scaled-down panel and
  // silently disappear, so keep a 1px floor once the user has asked for one at all.
  const bw = bar._feBarBorderWidth > 0 ? Math.max(1, Math.round(bar._feBarBorderWidth * scale)) : 0;
  return {
    w, h, bw,
    x: text.position.x - w / 2,
    y: inside ? text.position.y - h / 2 : text.position.y + text.height / 2 + gap,
  };
}

/**
 * Full (re)build of a panel tile's overlay labels for its CURRENT face. Called
 * whenever content can change: initial draw, face flips, and whenever the panel
 * actor's faces/overlays or the linked actor's data is edited.
 *
 * A flip reaches this through TWO different paths and both are needed: when the
 * new face has a different image, `texture.src` sets core's redraw flag and
 * drawTile/drawToken fires; when the faces share an image (or are both imageless)
 * nothing redraws, and onPanelPlaceableUpdate calls this directly off the
 * currentFace flag change. See the note there.
 */
/** Is this panel placeable a Token (tokenized panel) rather than a Tile? */
function feIsPanelToken(placeable) {
  return placeable?.document?.documentName === "Token";
}

/** The primary-group sort layer of the placeable a panel is drawn as. */
function fePanelSortLayer(doc) {
  const L = canvas.primary?.constructor?.SORT_LAYERS;
  if (!L) return 0;
  return doc?.documentName === "Token" ? (L.TOKENS ?? 0) : (L.TILES ?? 0);
}

function feRebuildPanelOverlays(tile) {
  feClearPanelOverlays(tile);
  try {
    const doc = tile?.document;
    const flag = doc?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) return;
    const actor = game.actors.get(flag.actorId);
    const face = fePanelFace(actor, flag.currentFace ?? 0);
    if (!face.overlays?.length) return;
    const natW = tile.texture?.width, natH = tile.texture?.height;
    if (!(natW > 0) || !(natH > 0)) return;
    const rect = panelTileRect(tile);
    const mw = rect.right - rect.left, mh = rect.bottom - rect.top;
    if (!(mw > 0) || !(mh > 0)) return;
    const scale = mw / natW;

    for (const item of face.overlays) {
      // Per-overlay link (not per-face/per-panel) — different labels on the
      // same face may each read from a different actor.
      const linkedActor = item.linkedActorUuid ? fromUuidSync(item.linkedActorUuid) : null;
      const str = feResolveOverlayText(item, linkedActor);
      if (!str) continue;
      const style = CONFIG.canvasTextStyle.clone();
      style.fontSize = Math.max(1, Math.round((item.fontSize || 28) * scale));
      style.fill = item.color || "#ffffff";
      feApplyOverlayWordWrap(style, item.boxWidth, scale);
      const text = new FE_OVERLAY_TEXT_CLASS(str, style);
      text.eventMode = "none";
      text.anchor.set(0.5, 0.5);
      text.position.set(rect.left + item.x * mw, rect.top + item.y * mh);
      text.elevation = doc.elevation ?? 0;
      // PrimaryCanvasGroup._compareObjects ties on elevation, THEN sortLayer,
      // THEN sort/zIndex. A placeable's mesh carries sortLayer = SORT_LAYERS.TILES
      // (500) or SORT_LAYERS.TOKENS (700), assigned by core's own _refreshState;
      // leaving the label's sortLayer at the default 0 means it always loses that
      // comparison and renders BEHIND the panel's image regardless of sort/zIndex.
      // Match the layer of whichever placeable this panel is (a tokenized panel is a
      // Token, so TILES would put its labels under every token on the scene). Use the
      // SORT_LAYERS constants directly rather than reading mesh.sortLayer — at the
      // draw hook (when this runs) _refreshState may not have fired yet, so the
      // mesh's own sortLayer can still read its just-constructed 0.
      text.sortLayer = fePanelSortLayer(doc);
      text.sort = (doc.sort ?? 0) + 1; // win ties against the tile's own mesh (same sort by default)
      text.zIndex = (tile.mesh?.zIndex ?? 0) + 1;
      // Stashed for the cheap reposition path below (authoritative source, since
      // skipped/empty items mean `tile._fePanelOverlays` indices don't line up
      // 1:1 with `face.overlays`).
      text._feX = item.x;
      text._feY = item.y;
      text._feFontSize = item.fontSize || 28;
      text._feBoxWidth = Math.max(0, item.boxWidth ?? 0);
      canvas.primary.addChild(text);
      tile._fePanelOverlays.push(text);

      // Optional HP-bar-style value bar just below the text. Only meaningful
      // when `attr` resolves to an actual number — a static/non-numeric
      // fallback has no sensible percentage to show.
      if (item.bar) {
        const numeric = feResolveOverlayNumericValue(item, linkedActor);
        const span = (item.barMax ?? 100) - (item.barMin ?? 0);
        if (numeric !== null && span !== 0) {
          const pct = Math.max(0, Math.min(1, (numeric - (item.barMin ?? 0)) / span));
          const bar = new PIXI.Graphics();
          bar._feBarMode = item.barMode === "inside" ? "inside" : "under";
          bar._feBarWidth = Math.max(0, item.barWidth ?? 0);
          bar._feBarHeight = item.barHeight || 6;
          bar._feBarBorderWidth = Math.max(0, item.barBorderWidth ?? 0);
          bar._feBarBorderColor = item.barBorderColor || "#000000";
          const box = feBarBox(text, bar, scale);
          feDrawBarGraphics(bar, box.w, box.h, pct, item.barColor, box.bw, bar._feBarBorderColor);
          bar.position.set(box.x, box.y);
          // Click-to-edit (see pickPanelBarAt / onBoardPointerDown): handled via
          // this module's own DOM-level board hit-testing, NOT PIXI's federated
          // events — onBoardPointerDown's capture-phase listener already swallows
          // any pointerdown landing inside a panel tile's rect before PIXI's own
          // event system would ever see it, so eventMode/listeners here would
          // silently never fire. bar.eventMode stays "none"; the stashed fields
          // below are what the board-level hit test reads instead.
          bar.eventMode = "none";
          bar.elevation = text.elevation;
          bar.sortLayer = text.sortLayer;
          bar.sort = text.sort;
          // One BELOW its text (which sits at mesh.zIndex + 1) — in "inside" mode the
          // bar covers the text's box, and PrimaryCanvasGroup._compareObjects would
          // otherwise fall through to _lastSortedIndex and paint the fill over the
          // number. `sort` still beats the panel's own mesh, so the bar stays above
          // the artwork either way.
          bar.zIndex = text.zIndex - 1;
          bar._feIsBar = true;
          bar._feBarColor = item.barColor;
          bar._feBarPct = pct;
          bar._feBarW = box.w;
          bar._feBarH = box.h;
          bar._feLinkedActor = linkedActor;
          bar._feAttr = item.attr;
          bar._feValue = numeric;
          text._feBar = bar;
          canvas.primary.addChild(bar);
          tile._fePanelOverlays.push(bar);
        }
      }
    }
    if (tile._fePanelOverlays.length) canvas.primary.sortDirty = true;
  } catch (err) { console.warn(`${MODULE_ID} | screen panel overlay rebuild failed`, err); }
}

/**
 * Cheap reposition/rescale of ALREADY-BUILT overlay labels (no restyle/recreate)
 * — used during live drag preview and on refreshTile (move/resize), where a
 * full rebuild would needlessly recreate PIXI text objects every tick.
 */
function feRepositionPanelOverlays(tile) {
  const list = tile?._fePanelOverlays;
  if (!list?.length) return;
  try {
    const natW = tile.texture?.width;
    const rect = panelTileRect(tile);
    const mw = rect.right - rect.left, mh = rect.bottom - rect.top;
    const scale = natW > 0 ? mw / natW : 1;
    for (const obj of list) {
      if (obj._feIsBar) continue; // repositioned below, via its paired text
      obj.position.set(rect.left + obj._feX * mw, rect.top + obj._feY * mh);
      const size = Math.max(1, Math.round(obj._feFontSize * scale));
      if (obj.style.fontSize !== size) obj.style.fontSize = size;
      // The wrap width is in image pixels too, so a resize/zoom has to re-derive it or
      // the text keeps wrapping at the width the panel had when it was built.
      if (obj._feBoxWidth > 0) {
        const wrap = Math.max(1, Math.round(obj._feBoxWidth * scale));
        if (obj.style.wordWrapWidth !== wrap) feApplyOverlayWordWrap(obj.style, obj._feBoxWidth, scale);
      }
      const bar = obj._feBar;
      if (bar) {
        obj.updateText?.(true); // force sync re-measure so .width reflects the new fontSize
        const box = feBarBox(obj, bar, scale);
        bar.position.set(box.x, box.y);
        bar._feBarW = box.w; // kept fresh for pickPanelBarAt's hit test
        bar._feBarH = box.h;
        feDrawBarGraphics(bar, box.w, box.h, bar._feBarPct, bar._feBarColor, box.bw, bar._feBarBorderColor);
      }
    }
  } catch { /* no-op */ }
}

/** Compare a PIXI fontFamily (string OR array stack) by value, not by reference. */
function feSameFontFamily(a, b) {
  const norm = (v) => (Array.isArray(v) ? v.join(",") : String(v ?? ""));
  return norm(a) === norm(b);
}

/**
 * Re-assign the current canvas font family onto ALREADY-BUILT overlay labels.
 *
 * Overlay text clones CONFIG.canvasTextStyle at build time, so the clone keeps
 * whatever family the CONFIG held right then — the same staleness core's own
 * nameplates have (see feRefreshCanvasTextStyles in fe-style.js). Two orderings
 * make it bite here:
 *   - the FIRST scene is fully drawn before the module font is ever pushed into
 *     CONFIG. Core's Game#setupGame does `await this.canvas.initializing` and only
 *     THEN `Hooks.callAll("ready")`, and feApplyCanvasTextFont runs off ready /
 *     canvasReady — so drawTile/drawToken has already cloned core's Signika. The
 *     scene a client logs into would keep it forever (later scene switches look
 *     fine, which is what made this read as "sometimes it works").
 *   - a face drawn before the @font-face files land paints with the fallback and
 *     PIXI never repaints on its own; fe-style.js's document.fonts.load() → refresh
 *     is the only thing that fixes it.
 * Only fontFamily is copied — fontSize/fill are per-overlay.
 */
function feRefreshPanelOverlayFonts() {
  try {
    const family = globalThis.CONFIG?.canvasTextStyle?.fontFamily;
    for (const placeable of fePanelPlaceables()) {
      const list = placeable?._fePanelOverlays;
      if (!list?.length) continue;
      for (const obj of list) {
        if (obj._feIsBar || !obj.style) continue;
        // PIXI's fontFamily setter compares by reference, so re-assigning an equal
        // array would bump styleID pointlessly. Compare the resolved stack instead.
        if (family !== undefined && !feSameFontFamily(obj.style.fontFamily, family)) {
          obj.style.fontFamily = Array.isArray(family) ? [...family] : family;
        }
        // Re-measure UNCONDITIONALLY, even when the family did not move: it can be
        // right and still render wrong. PIXI caches ascent/descent per font string
        // and never invalidates it, so a label first measured while the @font-face
        // was still loading keeps the fallback's vertical metrics and gets clipped.
        // fe-style.js drops that cache immediately before firing this hook — this
        // redraw is what actually picks the corrected metrics up.
        obj.dirty = true;
        obj.updateText?.(false);
      }
      // A value bar's width IS its paired text's rendered width, which the re-measure
      // above may have changed.
      feRepositionPanelOverlays(placeable);
    }
  } catch { /* no-op */ }
}

// --------------------------------
// GM relay — initiators (run on the clicking client)
// --------------------------------

function tileRef(tile) {
  return { sceneId: tile.document.parent?.id, tileId: tile.document.id };
}

async function feRelayPanelOp(type, payload) {
  if (game.user.isGM) return applyPanelOp(type, payload, game.user);
  if (!game.users.activeGM) {
    ui.notifications?.warn(game.i18n.localize("FESP.Menu.NoGM"));
    return;
  }
  game.socket.emit(SOCKET_CHANNEL, { type, ...payload, requesterId: game.user.id });
}

async function feActionFlip(tile, faceIndex) { return feRelayPanelOp(FE_PANEL_SOCKET.FLIP, { ...tileRef(tile), faceIndex }); }

/**
 * Advance a placed panel to the NEXT face in order (wraps around). Triggered by
 * a double-click on the tile. Flipping is an OBSERVER-level op (same as the
 * dropdown's flip), so any viewer can cycle. Returns false when there is nothing
 * to cycle (fewer than 2 faces), so the caller can fall back to the menu.
 */
function feCyclePanelFace(tile, actor) {
  const faceCount = actor?.system?.faces?.length ?? 0;
  if (faceCount < 2) return false;
  const flag = tile.document.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
  const cur = Number.isInteger(flag?.currentFace) ? flag.currentFace : 0;
  const next = (cur + 1) % faceCount;
  feActionFlip(tile, next);
  return true;
}
async function feActionMove(tile, x, y) { return feRelayPanelOp(FE_PANEL_SOCKET.MOVE, { ...tileRef(tile), x, y }); }
/** dir > 0 = bring forward (in front of every sibling), dir < 0 = send backward. */
async function feActionSort(tile, dir) { return feRelayPanelOp(FE_PANEL_SOCKET.SORT, { ...tileRef(tile), dir }); }
async function feActionShowHide(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.SHOW_HIDE, tileRef(tile)); }
async function feActionDisable(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.DISABLE, tileRef(tile)); }
async function feActionLock(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.LOCK, tileRef(tile)); }
async function feActionRemove(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.REMOVE, tileRef(tile)); }

/**
 * GM-only: delegate operate rights for a panel ACTOR to specific players via
 * Foundry actor ownership (OWNER lets them drag/flip/lock/etc., enforced by the
 * existing permission checks + GM relay). Opens a player picker dialog. Changing
 * ownership is a GM capability, so this is gated to the GM.
 */
async function feScreenPanelGrantRights(actor) {
  if (!game.user.isGM) { ui.notifications?.warn(game.i18n.localize("FESP.Grant.GMOnly")); return; }
  if (!actor) return;
  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const players = game.users.filter((u) => !u.isGM);
  if (!players.length) { ui.notifications?.info(game.i18n.localize("FESP.Grant.NoPlayers")); return; }
  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const rows = players.map((u) => {
    const checked = (actor.ownership?.[u.id] ?? 0) >= OWNER ? "checked" : "";
    return `<label class="fe-sp-grant-row" style="display:flex;align-items:center;gap:.5em;padding:.25em 0;">
      <input type="checkbox" name="${u.id}" ${checked}/>
      <span style="display:inline-block;width:.8em;height:.8em;border-radius:50%;background:${u.color ?? "#888"};"></span>
      <span>${esc(u.name)}</span>
    </label>`;
  }).join("");
  await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.format("FESP.Grant.Title", { name: actor.name }) },
    content: `<p>${game.i18n.localize("FESP.Grant.Hint")}</p><div class="fe-sp-grant-list">${rows}</div>`,
    ok: {
      icon: "fa-solid fa-user-shield",
      label: game.i18n.localize("FESP.Grant.Apply"),
      callback: async (_event, button) => {
        const form = button.form ?? button.closest?.("form");
        if (!form) return;
        const ownership = foundry.utils.deepClone(actor.ownership ?? {});
        for (const u of players) {
          const cb = form.elements?.[u.id];
          ownership[u.id] = cb?.checked ? OWNER : CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE;
        }
        await actor.update({ ownership });
        ui.notifications?.info(game.i18n.localize("FESP.Grant.Done"));
      },
    },
  });
}

/**
 * Quick numeric editor for a value-bar overlay's live attribute, opened by
 * clicking the bar during actual play (see pickPanelBarAt / onBoardPointerDown).
 * Independent of ScreenPanelData.tokenize — works whether or not the panel has
 * a companion Token, since core's own Token resource bar can only ever read/
 * edit a token's OWN actor (client/documents/token.mjs `getBarAttribute`), not
 * an arbitrarily-linked other actor like our per-overlay model needs.
 */
async function feOpenBarValueEditor(linkedActor, attr, currentValue) {
  const esc = foundry.utils.escapeHTML ?? ((s) => s);
  const content = `
    <div class="form-group">
      <label>${esc(linkedActor.name)} — ${esc(attr)}</label>
      <input type="number" name="value" value="${currentValue ?? 0}" step="any" autofocus>
    </div>`;
  await foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("FESP.Bar.EditTitle") },
    content,
    ok: {
      icon: "fa-solid fa-check",
      label: game.i18n.localize("FESP.Bar.EditApply"),
      callback: async (_event, button) => {
        const form = button.form ?? button.closest?.("form");
        const v = Number(form?.elements?.value?.value);
        if (!Number.isFinite(v)) return;
        await linkedActor.update({ [attr]: v });
      },
    },
  });
}

/**
 * Place a panel actor on the current scene as a panel Tile.
 * @param {Actor} actor
 * @param {{x?: number, y?: number}} [center]  Canvas-coordinate center point for the
 *   placement. Defaults to the viewport center (the Actor-directory menu entry has no
 *   drop point); the canvas drop guard passes the cursor position instead.
 */
async function feScreenPanelPlaceOnScene(actor, center = {}) {
  // The last of the three placement entry points to be gated (the directory entry and the
  // canvas drop guard are gated at their hooks). This one is also the sheet footer's
  // "씬에 올리기" button, reached through globalThis — and the sheet keeps opening with
  // the feature off, so the check has to live in the function, not only at its callers.
  if (!isPanelFeatureEnabled()) { ui.notifications?.warn(game.i18n.localize("FESP.Menu.FeatureOff")); return; }
  if (!canvas?.scene) { ui.notifications?.warn(game.i18n.localize("FESP.Menu.NoScene")); return; }
  if (!actor?.testUserPermission(game.user, "OWNER")) { ui.notifications?.warn(game.i18n.localize("FESP.Menu.NoPerm")); return; }
  const faceCount = actor.system.faces?.length ?? 0;
  if (faceCount === 0) { ui.notifications?.warn(game.i18n.localize("FESP.Menu.NoFaces")); return; }
  const face = fePanelFace(actor, actor.system.defaultFace ?? 0);
  // Size the tile to the image's real aspect ratio (the actor width×height act as
  // a bounding box). The whole image shows, nothing is stretched or cropped, and
  // the tile bounds — i.e. the clickable area — exactly match the visible art.
  const boxW = actor.system.width || FE_PANEL_DEFAULT_SIZE;
  const boxH = actor.system.height || FE_PANEL_DEFAULT_SIZE;
  const nat = await feLoadImageSize(face.img);
  const { w, h } = feAspectFit(boxW, boxH, nat?.w, nat?.h);
  const pivot = canvas.stage.pivot;
  const cx = Number.isFinite(center.x) ? center.x : pivot.x;
  const cy = Number.isFinite(center.y) ? center.y : pivot.y;
  await feRelayPanelOp(FE_PANEL_SOCKET.PLACE, {
    sceneId: canvas.scene.id,
    actorId: actor.id,
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    width: w,
    height: h,
    img: face.img,
    currentFace: face.index,
    gridSnap: isGridSnapEnabled(), // initiator's intent → companion token size branch
  });
}

// --------------------------------
// GM relay — apply (runs only on the active GM)
// --------------------------------

/**
 * Panel Token size (in GRID UNITS — token width/height are grid units, NOT
 * pixels; a NumberField that is positive & fractional-allowed, see core token.mjs).
 * Two branches, selected by the grid-snap toggle (the SAME preference that snaps
 * panel dragging):
 *   - snap OFF → pixel-exact: the token covers exactly the panel image's pixel
 *     box (fractional grid units, `px / gridSize`), so the token and the tile art
 *     line up 1:1 regardless of grid.
 *   - snap ON  → grid-converted: round to whole grid units so the token occupies
 *     a clean integer number of cells (Cocoforia-style "roughly snapped" token).
 * gridSize comes from the token's OWN scene (feSyncPanelTokenization walks scenes
 * that may not be the viewed one), falling back to the active canvas grid.
 */
function feCompanionTokenSize(scene, pxWidth, pxHeight, snap) {
  const gridSize = scene?.grid?.size || canvas?.grid?.size || 100;
  let w = (pxWidth || gridSize) / gridSize;
  let h = (pxHeight || gridSize) / gridSize;
  if (snap) { w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h)); }
  else { w = Math.max(0.05, w); h = Math.max(0.05, h); } // schema requires positive
  return { width: w, height: h };
}

/**
 * A Tile's visible TOP-LEFT corner in scene pixels.
 *
 * MUST use this instead of reading `tileDoc.x/y` whenever the value is handed to
 * something that expects a top-left (notably a Token's x/y, which IS the top-left on
 * every version). On **v14** a Tile's x,y is its texture ANCHOR point, not its corner:
 * `client/documents/tile.mjs` builds `TileDocument#shape` as
 * `{x, y, anchorX: texture.anchorX, anchorY: texture.anchorY}` and `Tile#_refreshPosition`
 * renders `mesh.position.set(shape.x, shape.y)` with `mesh.anchor.set(anchorX, anchorY)`.
 * Core's TextureData defaults the anchor to **0.5** (`common/documents/tile.mjs`), i.e.
 * x,y = the tile's CENTER. **v13** has no anchor and x,y is always the top-left.
 *
 * Copying `tileDoc.x/y` straight onto a companion Token therefore put the token's corner
 * at the panel's centre — the panel appeared duplicated, offset by exactly half its size.
 * New panel tiles pin the anchor to 0 (see applyPanelOp PLACE) so both versions agree,
 * but tiles placed before that fix still carry 0.5, so the conversion stays anchor-aware.
 */
function feTileTopLeft(tileDoc) {
  const ax = tileDoc?.texture?.anchorX ?? 0;
  const ay = tileDoc?.texture?.anchorY ?? 0;
  return {
    x: Math.round(tileDoc.x - (ax * tileDoc.width)),
    y: Math.round(tileDoc.y - (ay * tileDoc.height)),
  };
}

/**
 * Texture data shared by every panel Tile we create.
 *
 * anchorX/anchorY 0 = the tile's x,y is its TOP-LEFT. On **v14** a Tile's x,y is its
 * texture ANCHOR point and core's TextureData defaults that to 0.5 (= the CENTER); on
 * v13 there is no anchor and x,y is always the top-left. Pinning it to 0 makes both
 * versions agree with the rest of this module's math — and with a Token's x,y, which is
 * the top-left everywhere, so a panel converts between Tile and Token without moving.
 * v13 has no anchorX/anchorY field, so schema cleaning simply drops these keys there.
 */
function fePanelTileTextureData(img) {
  return { texture: { src: img || "", fit: "contain", anchorX: 0, anchorY: 0 } };
}

/**
 * Token creation data for a panel placed as a TOKEN (ScreenPanelData.tokenize).
 *
 * A tokenized panel IS the token — there is no Tile behind it. It carries the same
 * `flags.female_edition.panel` payload a panel Tile would (actorId / currentFace /
 * disabled / locked), so every panel feature keys off the placeable it is actually
 * looking at. Core owns the interaction (drag, select, grid snap, combat tracker);
 * female_edition only adds the right-click face menu, the overlays and the sheet.
 *
 * `corner` is a TOP-LEFT in scene pixels (a Token's x,y is its top-left on every
 * version — unlike a Tile's, see feTileTopLeft).
 */
async function fePanelTokenData(scene, actor, { corner, pxWidth, pxHeight, flag, hidden = false, snap = isGridSnapEnabled() }) {
  const face = fePanelFace(actor, flag?.currentFace ?? 0);
  const { width, height } = feCompanionTokenSize(scene, pxWidth, pxHeight, snap);
  const tokenDoc = await actor.getTokenDocument({
    x: corner.x, y: corner.y, width, height, hidden,
    texture: { src: face.img || "" },
    // The face's own Token settings win over our defaults — the user configured them
    // explicitly through core's TokenConfig. Position is NOT among them (stripped on save,
    // see feCleanFaceTokenData), so `corner` always stands.
    ...feCleanFaceTokenData(face.token),
    flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: { ...flag, actorId: actor.id } } },
  }, { parent: scene });
  return tokenDoc.toObject();
}

/**
 * The document changes that apply a face to an already-placed panel: its image, the
 * per-placement current-face flag, and — for a tokenized panel — that face's own Token
 * settings. Position keys never appear (see feCleanFaceTokenData).
 */
function fePanelFaceChanges(face, isToken) {
  const changes = {
    "texture.src": face.img || "",
    [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.currentFace`]: face.index,
  };
  if (!isToken) return changes;
  // Expanded, not dot-flattened: a face's stored token data is a partial source object and
  // `update` merges nested objects, so passing it wholesale keeps unset keys untouched.
  return foundry.utils.mergeObject(feCleanFaceTokenData(face.token), changes, { inplace: false });
}

/**
 * Reconcile every placed instance of `panelActor` (across ALL scenes) with its current
 * `system.tokenize` setting by CONVERTING the placement between a Tile and a Token —
 * a panel is one or the other, never both.
 *
 * The old model created a companion Token *in addition to* the Tile, which drew the
 * same art in the same spot (the panel looked duplicated) and left an orphaned Tile
 * behind whenever the token was deleted. Converting keeps the per-placement flag
 * (current face, disabled, locked) and the position/size across the swap.
 *
 * GM-only (embedded writes); runs from the updateActor hook.
 */
async function feSyncPanelTokenization(panelActor) {
  if (game.user !== game.users.activeGM) return;
  const want = !!panelActor.system.tokenize;
  for (const scene of game.scenes ?? []) {
    const placements = fePanelPlacementsIn(scene, panelActor.id);
    for (const { doc, isToken } of placements) {
      if (isToken === want) continue; // already the right kind
      try {
        if (want) await feConvertPanelTileToToken(scene, doc, panelActor);
        else await feConvertPanelTokenToTile(scene, doc, panelActor);
      } catch (err) { console.warn(`${MODULE_ID} | screen panel tokenize conversion failed`, err); }
    }
  }
}

/** Every placement of a panel actor in a scene, as Tiles AND Tokens. */
function fePanelPlacementsIn(scene, actorId) {
  const out = [];
  for (const doc of scene?.tiles ?? []) {
    const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (flag?.actorId === actorId) out.push({ doc, flag, isToken: false });
  }
  for (const doc of scene?.tokens ?? []) {
    const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (flag?.actorId === actorId) out.push({ doc, flag, isToken: true });
  }
  return out;
}

/**
 * Panel placements in a scene whose panel Actor no longer exists — "ghost boards".
 *
 * The art keeps drawing (a Tile/Token is self-contained once its texture is set) but
 * nothing resolves it any more: `pickPanelTileAt` skips it, so the panel menu, the face
 * cycle, the drag and the overlays are all dead. It is a leftover image, nothing worse:
 * every behaviour this module adds to a placeable is gated on
 * `feResolvePanelPlacementActor`, so a ghost falls back to being an ORDINARY Tile/Token
 * — selectable, movable, deletable through core's own UI like any other.
 *
 * That is why this list only ever feeds the MANUAL cleanup
 * (`feCleanupOrphanPanelPlacementsIn`, offered from the Scenes sidebar). Deleting scene
 * content automatically would trade an inert image for an unrecoverable loss: "this ID
 * is not in game.actors right now" is not the same claim as "this placement is
 * permanently useless". A scene imported without its panel actors, or a panel restored
 * from a compendium (`WorldCollection#fromCompendium` defaults to `keepId: false`, so
 * the restored actor gets a NEW id), both land here while being entirely recoverable by
 * the user — but not after we have deleted the boards.
 */
function feOrphanPanelPlacementsIn(scene) {
  const out = [];
  const collect = (docs, isToken) => {
    for (const doc of docs ?? []) {
      const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
      if (!flag?.actorId) continue;
      if (game.actors.get(flag.actorId)) continue; // still has its panel actor
      out.push({ doc, flag, isToken });
    }
  };
  collect(scene?.tiles, false);
  collect(scene?.tokens, true);
  return out;
}

/** Delete a list of {doc, isToken} placements from one scene, batched per collection. */
async function feDeletePanelPlacements(scene, placements) {
  const ids = (isToken) => placements.filter(p => p.isToken === isToken).map(p => p.doc.id);
  const tileIds = ids(false);
  const tokenIds = ids(true);
  if (tileIds.length) await scene.deleteEmbeddedDocuments("Tile", tileIds);
  if (tokenIds.length) await scene.deleteEmbeddedDocuments("Token", tokenIds);
  return tileIds.length + tokenIds.length;
}

/**
 * Remove every placement of one panel actor, across ALL scenes. GM-only (embedded writes).
 * Runs from the `deleteActor` hook: a panel's boards are meaningless without the actor that
 * defines their faces, so they go with it rather than becoming ghosts.
 */
async function feRemoveAllPanelPlacements(actorId) {
  let removed = 0;
  for (const scene of game.scenes ?? []) {
    const placements = fePanelPlacementsIn(scene, actorId);
    if (!placements.length) continue;
    try { removed += await feDeletePanelPlacements(scene, placements); }
    catch (err) { console.warn(`${MODULE_ID} | screen panel placement cleanup failed`, err); }
  }
  return removed;
}

/**
 * Clear one scene's ghost boards, on explicit request (Scenes sidebar → right-click).
 *
 * USER-INITIATED ONLY, and confirmed before it writes. This used to run automatically on
 * every `canvasReady`; it does not any more, because the deletion is unrecoverable while
 * the condition that triggers it is not conclusive — see `feOrphanPanelPlacementsIn` for
 * the two ordinary workflows (scene-only import, compendium restore) that produce ghosts
 * a user still wants. Nothing forces the cleanup either: a ghost is now an ordinary
 * placeable, so ignoring this entry forever costs a stale image and nothing else.
 *
 * Logs what it removed before removing it. There is no undo for an embedded-document
 * delete, so the console record is the only trace of what was there.
 */
async function feCleanupOrphanPanelPlacementsIn(scene) {
  if (!scene || !game.user.isGM) return 0;
  const orphans = feOrphanPanelPlacementsIn(scene);
  if (!orphans.length) {
    // The menu entry is built from a count taken when the menu opened; the scene can
    // change under it. Say so rather than silently doing nothing.
    ui.notifications?.info(game.i18n.format("FESP.Cleanup.None", { scene: scene.name }));
    return 0;
  }
  const ok = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("FESP.Cleanup.ConfirmTitle") },
    content: `<p>${game.i18n.format("FESP.Cleanup.ConfirmBody", { count: orphans.length, scene: foundry.utils.escapeHTML(scene.name) })}</p>`,
  }).catch(() => false);
  if (!ok) return 0;
  try {
    console.warn(`${MODULE_ID} | removing ${orphans.length} orphan panel placement(s) from "${scene.name}"`,
      orphans.map(p => ({
        id: p.doc.id,
        type: p.isToken ? "Token" : "Tile",
        actorId: p.flag?.actorId,
        x: p.doc.x, y: p.doc.y,
        img: p.doc.texture?.src ?? "",
      })));
    const count = await feDeletePanelPlacements(scene, orphans);
    if (count) ui.notifications?.info(game.i18n.format("FESP.Cleanup.Orphans", { count, scene: scene.name }));
    return count;
  } catch (err) {
    console.warn(`${MODULE_ID} | screen panel orphan cleanup failed`, err);
    return 0;
  }
}

/** Tile placement → Token placement (same spot, same flag). GM-only. */
async function feConvertPanelTileToToken(scene, tileDoc, actor) {
  const flag = tileDoc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG) ?? {};
  const data = await fePanelTokenData(scene, actor, {
    corner: feTileTopLeft(tileDoc),
    pxWidth: tileDoc.width, pxHeight: tileDoc.height,
    flag, hidden: tileDoc.hidden,
  });
  await scene.createEmbeddedDocuments("Token", [data]);
  await scene.deleteEmbeddedDocuments("Tile", [tileDoc.id]);
}

/** Token placement → Tile placement (same spot, same flag). GM-only. */
async function feConvertPanelTokenToTile(scene, tokenDoc, actor) {
  const flag = tokenDoc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG) ?? {};
  const face = fePanelFace(actor, flag.currentFace ?? 0);
  const gridSize = scene?.grid?.size || canvas?.grid?.size || 100;
  await scene.createEmbeddedDocuments("Tile", [{
    ...fePanelTileTextureData(face.img),
    x: Math.round(tokenDoc.x), y: Math.round(tokenDoc.y),
    width: Math.max(1, Math.round(tokenDoc.width * gridSize)),
    height: Math.max(1, Math.round(tokenDoc.height * gridSize)),
    hidden: tokenDoc.hidden,
    flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: { ...flag, actorId: actor.id } } },
  }]);
  await scene.deleteEmbeddedDocuments("Token", [tokenDoc.id]);
}

async function applyPanelOp(type, data, requester) {
  if (!requester) return;

  if (type === FE_PANEL_SOCKET.PLACE) {
    const actor = game.actors.get(data.actorId);
    if (!actor || !actor.testUserPermission(requester, "OWNER")) return;
    const scene = game.scenes.get(data.sceneId);
    if (!scene) return;
    const flag = { actorId: data.actorId, currentFace: data.currentFace ?? 0, disabled: false };

    // A panel is placed as EXACTLY ONE placeable — a Token when tokenized, a Tile
    // otherwise. (The old model made a Tile plus a "companion" Token, which drew the
    // same art twice in the same spot and orphaned the Tile when the token was
    // deleted.) Token size is grid-unit-converted from the panel's pixel box honoring
    // the INITIATOR's grid-snap preference (data.gridSnap), not the GM's.
    if (actor.system.tokenize) {
      const tokenData = await fePanelTokenData(scene, actor, {
        corner: { x: data.x, y: data.y },
        pxWidth: data.width, pxHeight: data.height,
        flag, snap: !!data.gridSnap,
      });
      await scene.createEmbeddedDocuments("Token", [tokenData]);
      return;
    }
    await scene.createEmbeddedDocuments("Tile", [{
      ...fePanelTileTextureData(data.img),
      x: data.x, y: data.y, width: data.width, height: data.height,
      flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: flag } },
    }]);
    return;
  }

  const scene = game.scenes.get(data.sceneId);
  // A panel placement is a Tile OR a Token (never both — see fePanelTokenData), so
  // resolve against whichever collection holds this id.
  const doc = scene?.tiles?.get(data.tileId) ?? scene?.tokens?.get(data.tileId);
  if (!doc) return;
  const isToken = doc.documentName === "Token";
  const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
  const actor = game.actors.get(flag?.actorId);
  if (!actor) return;

  const level = type === FE_PANEL_SOCKET.FLIP ? "OBSERVER" : "OWNER";
  if (!actor.testUserPermission(requester, level)) return;

  if (type === FE_PANEL_SOCKET.FLIP) {
    const face = fePanelFace(actor, data.faceIndex);
    await doc.update(fePanelFaceChanges(face, isToken));
  } else if (type === FE_PANEL_SOCKET.MOVE) {
    // Never trust the requester's client-side lock check (`canDrag` in
    // onBoardPointerDown): a stale menu or a hand-crafted socket payload would
    // otherwise move a locked panel. Dropped silently — the preUpdate hooks own the
    // user-facing warning, and it belongs on the screen of whoever actually dragged,
    // not on the relaying GM's.
    if (feIsPanelPlacementLocked(doc)) return;
    await doc.update({ x: Math.round(data.x), y: Math.round(data.y) });
  } else if (type === FE_PANEL_SOCKET.SHOW_HIDE) {
    await doc.update({ hidden: !doc.hidden });
  } else if (type === FE_PANEL_SOCKET.DISABLE) {
    await doc.update({ [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.disabled`]: !flag?.disabled });
  } else if (type === FE_PANEL_SOCKET.SORT) {
    // Jump clear of every sibling in the same collection rather than stepping by 1: core's
    // PrimaryCanvasGroup sort is per-layer, so "in front" only has to beat the other tokens
    // (or tiles) — and a single step would be a no-op whenever siblings share a sort value,
    // which they do by default (all 0).
    const siblings = (isToken ? scene.tokens : scene.tiles) ?? [];
    const sorts = [...siblings].filter(d => d.id !== doc.id).map(d => d.sort ?? 0);
    const bound = data.dir > 0 ? Math.max(0, ...sorts) + 1 : Math.min(0, ...sorts) - 1;
    await doc.update({ sort: bound });
  } else if (type === FE_PANEL_SOCKET.LOCK) {
    await doc.update({ [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.locked`]: !flag?.locked });
  } else if (type === FE_PANEL_SOCKET.REMOVE) {
    await scene.deleteEmbeddedDocuments(isToken ? "Token" : "Tile", [doc.id]);
  }
}

function onPanelSocket(data, senderId) {
  if (!data?.type || !PANEL_SOCKET_TYPES.has(data.type)) return; // foreign type — ignore
  // The setting is world-scope, so an incoming request while it is off means a client that
  // has not reloaded yet. The GM is the one who writes, so this is where it has to stop.
  if (!isPanelFeatureEnabled()) return;
  if (game.user !== game.users.activeGM) return; // only the primary GM applies
  const requester = feResolveSocketSender(senderId, data.requesterId, "screen-panel");
  if (!requester) return;
  applyPanelOp(data.type, data, requester).catch(err => console.error(`${MODULE_ID} | screen panel op failed`, err));
}

/**
 * Third-party hardening: dot-path resolution of our DOTTED sub-type id.
 *
 * A module sub-type id is namespaced ("female_edition.screenPanel"), and a lot of
 * third-party code treats a type id as an object PATH rather than a literal key —
 * either directly (`foundry.utils.getProperty(registry, actor.type)`, which splits
 * on ".") or by string-building a target out of it. Every such consumer resolves
 * `CONFIG.Actor.<registry>.female_edition.screenPanel` instead of the real
 * `CONFIG.Actor.<registry>["female_edition.screenPanel"]` and fails on OUR type
 * only, so the breakage looks like a female_edition bug.
 *
 * Observed instance (Item Piles 3.2.x): it builds one libWrapper target per
 * registered actor sheet as `CONFIG.Actor.sheetClasses.${type}.["${sheetId}"]…`,
 * so ours becomes unresolvable and every client start logs a red
 * LibWrapperPackageError blaming Item Piles.
 *
 * Fix: expose the dot-path as a NON-ENUMERABLE alias on each type-keyed
 * CONFIG.Actor registry. This is not a second type or sheet registration —
 * Foundry only ever reads these registries by literal key.
 *
 * Non-enumerability is load-bearing twice over:
 *   - core (`WorldCollection.registeredSheets`, `DocumentSheetConfig`) and any
 *     module walking `Object.values(registry)` must not see a phantom actor type;
 *   - the very enumeration that produced the broken target above would otherwise
 *     walk into the alias and build a SECOND broken target
 *     (`sheetClasses.female_edition.["screenPanel"].cls`).
 *
 * The alias is a live GETTER rather than a copied reference, so it keeps resolving
 * after a registry entry is replaced (another module registering a sheet for our
 * type, a system swapping data models).
 *
 * TIMING — this is what made the first attempt dead code: `registerSheet()` before
 * `game.ready` only queues into DocumentSheetConfig's private #pending list, and
 * core REBUILDS `CONFIG.Actor.sheetClasses` from scratch in
 * `DocumentSheetConfig.initializeSheets()`, which runs AFTER the `setup` hook
 * (`client/game.mjs`: init → setup → initializeSheets → ready). So at `init` our
 * type key does not exist yet and anything installed there is thrown away with the
 * old object. Hence the `ready` call — still comfortably before the earliest point
 * a module can wrap a sheet class (Item Piles does it at `ready` + 100 ms). The
 * `init` call is kept because dataModels/typeLabels ARE ours from init onward.
 */
const FE_TYPE_KEYED_ACTOR_REGISTRIES = [
  "sheetClasses",
  "dataModels",
  "typeLabels",
  "typeIcons",
  "trackableAttributes",
];

function feInstallDottedTypeAliases() {
  const cfg = CONFIG.Actor;
  if (!cfg) return;

  for (const name of FE_TYPE_KEYED_ACTOR_REGISTRIES) {
    const registry = cfg[name];
    if (!registry || typeof registry !== "object") continue;
    if (!(FE_PANEL_TYPE in registry)) continue; // nothing registered for our type here
    try {
      let ns = registry[MODULE_ID];
      if (ns === undefined) {
        ns = Object.create(null);
        Object.defineProperty(registry, MODULE_ID, {
          value: ns,
          enumerable: false,
          configurable: true,
          writable: true,
        });
      }
      // A real entry literally keyed "female_edition" would be someone else's
      // data — never shadow it.
      if (!ns || typeof ns !== "object") continue;
      const existing = Object.getOwnPropertyDescriptor(ns, FE_PANEL_SUBTYPE);
      if (existing && !existing.configurable) continue;
      Object.defineProperty(ns, FE_PANEL_SUBTYPE, {
        get: () => registry[FE_PANEL_TYPE],
        enumerable: false,
        configurable: true,
      });
    } catch (err) {
      // A nonstandard system-owned CONFIG shape must never block panel setup.
      console.warn(`${MODULE_ID} | could not install the dotted-type alias for CONFIG.Actor.${name}`, err);
    }
  }
}

// --------------------------------
// Hooks
// --------------------------------

Hooks.once("init", () => {
  CONFIG.Actor.dataModels ||= {};
  CONFIG.Actor.dataModels[FE_PANEL_TYPE] = ScreenPanelData;

  // Give the sub-type a readable label. The DX3rd system hard-replaces
  // CONFIG.Actor.typeLabels in a top-level IIFE (script-eval time); this init
  // hook runs afterward, so our entry survives. Dropdown ORDER is forced
  // separately by the renderDialogV2 hook below.
  CONFIG.Actor.typeLabels ||= {};
  CONFIG.Actor.typeLabels[FE_PANEL_TYPE] = "FESP.SheetLabel";

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Actor, MODULE_ID, ScreenPanelSheet, {
    types: [FE_PANEL_TYPE],
    makeDefault: true,
    label: "FESP.SheetLabel",
  });
  // Covers dataModels/typeLabels immediately; sheetClasses is re-installed at
  // `ready` because core rebuilds that object after `setup` — see the function.
  feInstallDottedTypeAliases();

  game.settings.register(MODULE_ID, S.SCREEN_PANEL_ENABLED, {
    // Pass localization KEYS — at the `init` hook i18n is not yet loaded; the
    // settings UI localizes name/hint at render time.
    name: "FESP.Settings.EnableName",
    hint: "FESP.Settings.EnableHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SCREEN_PANEL_ENABLED],
    requiresReload: true,
  });

  // Per-client drag preference: snap panels to the scene grid while dragging.
  game.settings.register(MODULE_ID, S.SCREEN_PANEL_GRID_SNAP, {
    name: "FESP.Settings.GridSnapName",
    hint: "FESP.Settings.GridSnapHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SCREEN_PANEL_GRID_SNAP],
  });

});

Hooks.once("setup", () => {
  for (const actor of game.actors ?? []) feEnsureScreenPanelDnd5eActorCompat(actor);
  feInstallPanelHudVeto(); // must precede the first canvas draw — see the function's comment
});

Hooks.once("ready", () => {
  // MUST run here (not at init): core replaces CONFIG.Actor.sheetClasses wholesale
  // in DocumentSheetConfig.initializeSheets(), which runs after `setup`.
  feInstallDottedTypeAliases();
  feInitPanelMenuDismissers();
  feSetPanelMenuActions({
    flip: feActionFlip,
    toggleShowHide: feActionShowHide,
    toggleDisable: feActionDisable,
    toggleLock: feActionLock,
    sort: feActionSort,
    remove: feActionRemove,
    openSheet: (actor) => actor?.sheet?.render(true),
    grantRights: feScreenPanelGrantRights,
    gridSnapState: isGridSnapEnabled,
    toggleGridSnap: toggleGridSnap,
    dblclickCycleState: isDblclickCycleEnabled,
    toggleDblclickCycle: toggleDblclickCycle,
  });
  game.socket.on(SOCKET_CHANNEL, onPanelSocket);

  // Expose placement for the sheet's "Place on scene" button (avoids importing
  // the entry module from the sheet).
  globalThis.feScreenPanelPlaceOnScene = feScreenPanelPlaceOnScene;

  if (canvas?.ready) attachBoardListeners();
});

Hooks.on("canvasTearDown", () => feResetPanelCanvasState());

// fe-style.js fires this from feRefreshCanvasTextStyles, i.e. every time it
// re-styles core's own canvas text: the font settings changed, or the @font-face
// files finished loading after a scene had already been drawn.
Hooks.on(`${MODULE_ID}.canvasTextStyleRefreshed`, fePanelGated(feRefreshPanelOverlayFonts));

Hooks.on("canvasReady", fePanelGated(() => {
  fePanelTileIndexReady = false;
  attachBoardListeners();
  feBuildPanelTileIndex();
}));

// A panel actor's boards define nothing without it: every face image, overlay and menu
// entry is resolved from the actor at draw/click time, so a surviving placement is a
// ghost (see feOrphanPanelPlacementsIn). Take them with it, across every scene.
//
// This is the one destructive path that stays automatic, and it is the one that has the
// standing to be: the user just deleted the panel, in this session, on purpose — the
// boards are part of what they deleted. Compare `feCleanupOrphanPanelPlacementsIn`,
// which acts on a mere INFERENCE that some placement is unwanted and therefore asks.
// NOT gated on the feature setting either — deleting the actor is an explicit act and
// its boards belong to it whether or not the feature is currently on.
Hooks.on("deleteActor", (actor) => {
  if (actor?.type !== FE_PANEL_TYPE) return;
  if (game.user !== game.users.activeGM) return;
  feRemoveAllPanelPlacements(actor.id).then((count) => {
    if (count) ui.notifications?.info(game.i18n.format("FESP.Cleanup.ActorDeleted", { name: actor.name, count }));
  }).catch(err => console.warn(`${MODULE_ID} | screen panel placement cleanup failed`, err));
});
// drawTile fires on initial draw, full redraw, AND face flips (texture.src sets
// the redraw flag), each time with the new texture loaded — so it is the only
// hook the aspect resize needs.
Hooks.on("drawTile", fePanelGated(enforcePanelTileSize));
// Must run AFTER enforcePanelTileSize — it reads the tile's just-resized mesh
// (via panelTileRect) to position labels against the actually-drawn art.
Hooks.on("drawTile", fePanelGated(feRebuildPanelOverlays));
Hooks.on("drawTile", fePanelGated(feIndexPanelTile));
Hooks.on("drawTile", fePanelGated(applyPanelTileVisibility));
Hooks.on("refreshTile", fePanelGated(feRepositionPanelOverlays));
Hooks.on("refreshTile", fePanelGated(applyPanelTileVisibility));

// A tokenized panel is a Token, so the same overlay/index/visibility work must run off
// the Token draw cycle too — otherwise a tokenized panel shows no overlay labels and is
// missing from the linked-actor index. The handlers are placeable-shape-agnostic
// (panelTileRect reads the mesh; the panel flag lives on either document), and they
// no-op immediately on any placeable without a panel flag — i.e. on every ordinary
// token in the scene.
Hooks.on("drawToken", fePanelGated(enforcePanelTileSize));
Hooks.on("drawToken", fePanelGated(feRebuildPanelOverlays));
Hooks.on("drawToken", fePanelGated(feIndexPanelTile));
Hooks.on("drawToken", fePanelGated(applyPanelTileVisibility));
Hooks.on("refreshToken", fePanelGated(feRepositionPanelOverlays));
Hooks.on("refreshToken", fePanelGated(applyPanelTileVisibility));
// Teardown is NOT gated (see fePanelGated): a client that declined the reload prompt still
// has live overlay PIXI objects, and they must be destroyed with their placeable either way.
Hooks.on("destroyToken", (token) => {
  if (!token) return;
  feClearPanelOverlays(token);
  feRemovePanelTileFromIndex(token);
});
// Orphaned overlay PIXI objects aren't covered by core's own Tile teardown
// (canvas.primary.removeTile only destroys the mesh it tracks itself).
Hooks.on("deleteTile", (doc) => {
  if (!doc?.object) return;
  feClearPanelOverlays(doc.object);
  feRemovePanelTileFromIndex(doc.object);
});
/**
 * A placed panel's document was updated (Tile OR Token).
 *
 * 1. Reindex immediately so a linked Actor update in the same render cycle still finds
 *    the right placeable; the draw hook repeats this harmlessly once the new texture
 *    is ready.
 * 2. **Force a state refresh when our own panel FLAG changed (MUST keep).** Core assigns
 *    render flags strictly from the document's own fields — `tile.mjs` / `token.mjs`
 *    `_onUpdate` list `hidden`/`sort`/`locked`/`x`/`y`/`texture`/… and nothing else — so
 *    a **flags-only** update (표시 전환 `disabled`, 위치 고정 `locked`, or a face flip
 *    between two faces that share an image) sets NO flags at all. `RenderFlags#set` then
 *    adds the object to `pendingRenderFlags` with an empty set, and
 *    `PlaceableObject#applyRenderFlags` early-returns on `!this.renderFlags.size` — so
 *    neither `_refreshVisibility` nor our `refreshTile`/`refreshToken` handler ever runs
 *    and the per-user disabled gate does not appear (or disappear) until the next full
 *    redraw: a scene switch, a texture change, or F5. Asking for `refreshState` fixes
 *    both directions at once: it propagates to `refreshVisibility`, so core recomputes
 *    `visible` from its OWN rules first and `applyPanelTileVisibility` (which runs after,
 *    from the refresh hook) only ever subtracts on top. That is why there is no "restore
 *    visibility" branch in `applyPanelTileVisibility` — reconstructing core's visibility
 *    ourselves would be wrong the moment core's rules change.
 */
function onPanelPlaceableUpdate(doc, changes) {
  const obj = doc?.object;
  if (!obj) return;
  // A placeable that lost its panel flag must drop out of the reverse index, or a later
  // linked-Actor update would still resolve to it.
  if (!doc.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG)?.actorId) { feRemovePanelTileFromIndex(obj); return; }
  feIndexPanelTile(obj);
  // Hooks receive the EXPANDED diff, so a dot-path write lands here as a nested object.
  const flagChange = foundry.utils.getProperty(changes ?? {}, `flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}`);
  if (flagChange === undefined) return;
  obj.renderFlags?.set?.({ refreshState: true });

  // 3. **Rebuild the overlays on a face flip that changes no texture (MUST keep).**
  //    feRebuildPanelOverlays runs from drawTile/drawToken, and a flip only reaches
  //    those because a `texture.src` change sets core's redraw flag. When the two
  //    faces SHARE one image — or are both imageless — the update carries no texture
  //    key at all, so nothing redraws and the PREVIOUS face's labels stay on screen:
  //    for a panel whose faces differ only in their overlay text, the flip looks like
  //    it did absolutely nothing. `refreshState` above is not enough — the refresh
  //    hook only runs feRepositionPanelOverlays, which moves the existing labels and
  //    never re-reads the face.
  //    Skip when the texture IS changing: the redraw rebuilds it anyway, and doing it
  //    here would measure the OLD texture (`tile.texture` still holds the previous
  //    bitmap at update time), scaling every label to the wrong size.
  if (flagChange.currentFace === undefined) return;
  if (foundry.utils.getProperty(changes ?? {}, "texture.src") !== undefined) return;
  feRebuildPanelOverlays(obj);
}

Hooks.on("updateTile", fePanelGated(onPanelPlaceableUpdate));
Hooks.on("updateToken", fePanelGated(onPanelPlaceableUpdate));

// Force the screenPanel option to the BOTTOM of the Actor-create type dropdown.
// Core sorts types alphabetically by label (ClientDocument.createDialog), which
// floats our type to the top under the Korean locale; reorder after render.
Hooks.on("renderDialogV2", (dialog, element) => {
  try {
    const root = element instanceof HTMLElement ? element : (element?.[0] ?? element);
    const select = root?.querySelector?.('select[name="type"]');
    if (!select) return;
    const opt = select.querySelector(`option[value="${FE_PANEL_TYPE}"]`);
    if (opt && opt !== select.lastElementChild) select.appendChild(opt);
  } catch { /* no-op */ }
});

/**
 * linkMode "linked" — auto-sync face images from their linked actors' portraits.
 * Idempotent: skips faces whose image already matches, so a re-entrant
 * updateActor (from our own update below) is a harmless no-op.
 */
function feSyncLinkedFaceImages(panelActor) {
  const faces = panelActor.system.faces ?? [];
  let needsUpdate = false;
  const cloned = foundry.utils.deepClone(faces);
  for (const face of cloned) {
    if (face.linkMode !== "linked" || !face.linkedActorUuid) continue;
    let linked = null;
    try { linked = fromUuidSync(face.linkedActorUuid); } catch { continue; }
    if (!linked) continue;
    const target = linked.img || linked.prototypeToken?.texture?.src || "";
    if (target && face.img !== target) {
      face.img = target;
      needsUpdate = true;
    }
  }
  if (needsUpdate) panelActor.update({ "system.faces": cloned }, { render: false });
}

Hooks.on("updateActor", (actor, changes) => {
  const isGM = game.user === game.users.activeGM;
  const facesChanged = changes.system?.faces !== undefined;

  // ── GM-only actor-level syncs (prototype token, linkMode, portrait) ──
  if (actor.type === FE_PANEL_TYPE && isGM) {
    // Reactive tokenize: turning the setting on/off CONVERTS every already-placed
    // instance between a Tile and a Token (not just at placement time). Gated on the
    // feature — this rewrites scene content, which is exactly what "off" must not do.
    if (changes.system?.tokenize !== undefined && isPanelFeatureEnabled()) feSyncPanelTokenization(actor);
    if (facesChanged || changes.system?.defaultFace !== undefined) {
      const face = fePanelFace(actor, actor.system.defaultFace ?? 0);
      const target = face?.img || "";
      if (target && (actor.prototypeToken?.texture?.src ?? "") !== target)
        actor.update({ "prototypeToken.texture.src": target, img: target }, { render: false });
      else if (target && (actor.img ?? "") !== target)
        actor.update({ img: target }, { render: false });
    }
    if (facesChanged) feSyncLinkedFaceImages(actor);
  }

  // Non-panel actor portrait changed → sync to linked panel faces.
  if (actor.type !== FE_PANEL_TYPE && isGM && changes.img !== undefined) {
    for (const pa of game.actors) {
      if (pa.type !== FE_PANEL_TYPE) continue;
      const hasLinkedFace = (pa.system.faces ?? []).some(f => {
        if (f.linkMode !== "linked" || !f.linkedActorUuid) return false;
        try { return fromUuidSync(f.linkedActorUuid)?.id === actor.id; } catch { return false; }
      });
      if (hasLinkedFace) feSyncLinkedFaceImages(pa);
    }
  }

  // ── Canvas tile updates (all clients) ──
  // Look up only tiles owned by this panel Actor, or tiles whose CURRENT face
  // displays the changed Actor. This replaces the former every-Actor-update ×
  // every-Tile × every-overlay scan. The index is refreshed on drawTile,
  // updateTile, canvasReady, and panel-system changes below.
  //
  // Gated here rather than at the hook, because the actor-level syncs ABOVE (default-face
  // portrait, linkMode image mirroring) must keep running with the feature off: the sheet
  // still opens and still edits faces, so the actor's own data has to stay coherent. Only
  // the canvas half stands down.
  if (!isPanelFeatureEnabled()) return;
  const isUpdatedPanelActor = actor.type === FE_PANEL_TYPE;
  const tiles = isUpdatedPanelActor
    ? feGetIndexedPanelTiles(actor.id)
    : feGetIndexedPanelTiles(actor.id, { linked: true });
  for (const tile of tiles) {
    const flag = tile?.document?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) continue;
    const panelActor = game.actors.get(flag.actorId);
    if (!panelActor) continue;
    if ("ownership" in (changes ?? {}))
      tile.renderFlags?.set?.({ refreshState: true });

    // Sync tile texture with current face image when faces data changed.
    if (isGM && facesChanged) {
      const curFace = fePanelFace(panelActor, flag.currentFace ?? 0);
      const tileSrc = tile.document.texture?.src ?? "";
      if (curFace.img && tileSrc !== curFace.img) tile.document.update({ "texture.src": curFace.img });
    }

    // Overlay rebuild: only when system data actually changed (skip pure
    // prototypeToken / img-only updates triggered by our own sync above).
    if (changes.system !== undefined) {
      // A face/overlay edit may add or remove linked Actors; update the reverse
      // mapping before the next Actor update can arrive.
      feIndexPanelTile(tile);
      feRebuildPanelOverlays(tile);
    }

    // A tile returned by the linked-Actor index is known to display this Actor
    // on its current face, so rebuilding it is the complete equivalent of the
    // old per-overlay UUID scan.
    if (!isUpdatedPanelActor) feRebuildPanelOverlays(tile);
  }
});

// A tokenized panel's right-click must show OUR panel menu and ONLY ours — core's Token HUD
// (the orbiting icon ring) is meaningless for a display board and just overlaps the dropdown.
//
// Core opens it from `PlaceableObject#_onClickRight` → `if (this._canHUD(...)) this.layer.hud.bind(this)`,
// driven by PIXI FEDERATED events. Racing it from our capture-phase DOM listener does not work:
// PIXI's EventSystem registered its own listener on the same <canvas> first, so it dispatches (and
// core reacts) before our `stopImmediatePropagation` lands — the same race the marquee reset in
// onBoardPointerDown works around. Veto at core's own gate instead, which is race-free.
//
// A cooperative prototype wrap (calls through to the original) rather than libWrapper: this file
// has no libWrapper dependency, and the override is one boolean.
//
// MUST be installed before the canvas draws (we do it at `setup`, NOT `ready`): each placeable's
// `_createInteractionManager` captures `this._canHUD` as a direct **reference** into its permissions
// map (`placeable-object.mjs`: `permissions = {clickRight: this._canHUD, …}`) when its listeners are
// activated at draw time. Tokens are drawn before the `ready` hook, so a wrap installed there is
// captured by nobody and the HUD still opens.
function feInstallPanelHudVeto() {
  const proto = CONFIG.Token?.objectClass?.prototype;
  if (!proto || proto._feHudVetoInstalled) return;
  proto._feHudVetoInstalled = true;
  const original = proto._canHUD;
  proto._canHUD = function (...args) {
    if (isPanelFeatureEnabled() && feResolvePanelPlacementActor(this.document)) return false;
    return original.apply(this, args);
  };
}

/**
 * The panel Actor a placement actually resolves to, or null.
 *
 * The single gate for EVERY behaviour this module imposes on a placeable — the Token HUD
 * veto and the position lock today, anything added later by rule. It exists because the
 * flag alone is not the right question. Both of those started out asking only "does the
 * flag carry an actorId", which stays true forever once written, so a placement whose
 * actor was gone kept being treated as ours: no panel menu (`pickPanelTileAt` needs the
 * actor and bails), no core Token HUD (vetoed), and — if it happened to be locked — no
 * moving it either, with no UI left anywhere to unlock it. The module manufactured a
 * placeable the user could barely touch, and then deleted scene content automatically to
 * clear up the mess it had made.
 *
 * Resolve the actor instead. No actor → not ours → every override stands down and the
 * placeable behaves exactly like the ordinary Tile/Token it now is. That is what makes
 * `feCleanupOrphanPanelPlacementsIn` a convenience rather than a necessity.
 */
function feResolvePanelPlacementActor(doc) {
  const actorId = doc?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG)?.actorId;
  return actorId ? (game.actors.get(actorId) ?? null) : null;
}

/**
 * WHICH lock pins this placement's position: `"placement"` (`flag.locked`, the canvas
 * right-click menu), `"panel"` (`actor.system.locked`, the sheet's 위치 고정), or null.
 *
 * The source matters, not just the boolean, because only ONE of the two can be released
 * from the canvas menu. Collapsing them into a bare `true` produced two lies at once: a
 * warning telling the user to "우클릭 메뉴에서 고정을 해제하세요" for a lock the menu
 * cannot touch, and a menu row offering a per-placement toggle that visibly did nothing
 * while the panel-level lock stood behind it.
 *
 * Returns null for anything that is not a live panel placement — a lock whose owning
 * panel is gone would be unreleasable, since the menu that sets `flag.locked` cannot open
 * without the actor (see feResolvePanelPlacementActor).
 */
function fePanelLockSource(doc) {
  const actor = feResolvePanelPlacementActor(doc);
  if (!actor) return null;
  if (doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG)?.locked) return "placement";
  return actor.system?.locked ? "panel" : null;
}

/** Is this placed panel position-locked, from either source? */
function feIsPanelPlacementLocked(doc) {
  return fePanelLockSource(doc) !== null;
}

/**
 * Position lock, enforced on the update itself for BOTH placeable kinds.
 *
 * A Token has no `locked` field of its own and core owns a tokenized panel's dragging,
 * so the update is the only gate there. A Tile does have core's `locked` field, but we
 * never set it (the panel lock is our flag), so a GM using the Tiles layer could drag a
 * "locked" panel tile freely — and our own left-drag guard (`canDrag` in
 * onBoardPointerDown) is client-side only, so it does not cover that path either.
 * Cancelling the pre-hook makes core snap the placeable back to where it was.
 *
 * GMs are not exempt — the lock is a deliberate "don't nudge this board" guard; unlock
 * it to move it. Relayed MOVE ops are filtered earlier (applyPanelOp) so this warning
 * only ever fires for a direct drag by the user in front of the screen.
 *
 * **Compare the values; do NOT key off the keys' mere presence (MUST keep).** Core hands
 * `_preUpdate` the RAW submitted changes, not the diff — `client-backend.mjs:238` calls
 * `doc._preUpdate(changes, …)` and only then (`:250`) runs the `dryRun` `updateSource`
 * that computes the diff. And core's own config sheets submit the position
 * unconditionally: `templates/scene/tile/position.hbs:9-11` and
 * `scene/token/identity.hbs:19-22` both put x and y in the form. A presence check
 * therefore refused the ENTIRE submit whenever a GM edited a locked panel's rotation,
 * elevation, sort, alpha or occlusion — warning about a position they had not touched,
 * and silently dropping every other field with it.
 *
 * A real move attempt is still cancelled outright rather than having x/y stripped: the
 * cancel path is the one that is proven to snap the placeable back, and on v14 a Token's
 * position travels through core's waypoint/movement pipeline, which is no place to hand
 * back a half-edited change set.
 */
function onPanelPlacementPreUpdate(doc, changes) {
  const moving = (changes.x !== undefined && changes.x !== doc.x)
    || (changes.y !== undefined && changes.y !== doc.y);
  if (!moving) return;
  const source = fePanelLockSource(doc);
  if (!source) return;
  // Name the lock the user can actually reach: the canvas menu releases only the
  // per-placement flag, so pointing at it for a panel-level lock sends them somewhere
  // that has no such control.
  ui.notifications?.warn(game.i18n.localize(
    source === "panel" ? "FESP.Menu.LockedWarnPanel" : "FESP.Menu.LockedWarn"));
  return false;
}

// Gated: with panels off there is no menu to release a lock, so continuing to enforce one
// would strand the placement (see fePanelGated).
Hooks.on("preUpdateToken", fePanelGated(onPanelPlacementPreUpdate));
Hooks.on("preUpdateTile", fePanelGated(onPanelPlacementPreUpdate));

// Dragging a panel actor onto the canvas must go through feScreenPanelPlaceOnScene.
// Without this guard core's default Actor drop (board.mjs `#onDrop` → tokens._onDropActor)
// creates an ordinary Token from the panel actor: it carries no panel flag, so it is not
// a panel at all — no face cycle, no panel menu, no overlays, and core's "double-click an
// owned token" opens the sheet instead. Our placement produces the right placeable for
// the panel's own tokenize setting (a Token or a Tile, never both) with the flag attached.
// Returning false aborts core's own handling (board.mjs: `if (allowed === false) return`).
// data.x/data.y are already canvas coordinates, so the panel lands under the cursor.
// Gated: with panels off this hands the drop back to core, which makes an ordinary Token
// from the actor. `fePanelGated` returns undefined, and undefined is core's "carry on".
Hooks.on("dropCanvasData", fePanelGated((_canvas, data) => {
  if (data?.type !== "Actor") return;
  let actor = null;
  try { actor = data.uuid ? fromUuidSync(data.uuid) : game.actors.get(data.id); } catch { /* no-op */ }
  if (actor?.type !== FE_PANEL_TYPE) return; // not a panel → core handles it normally
  feScreenPanelPlaceOnScene(actor, { x: data.x, y: data.y });
  return false;
}));

// Add panel entries to the Actor directory context menu. Gated: 토큰화 / 씬에 올리기 are
// placement operations, and nothing may be placed while the feature is off.
Hooks.on("getActorContextOptions", fePanelGated((directory, options) => {
  const actorOf = (li) => {
    const el = li instanceof HTMLElement ? li : li?.[0];
    return game.actors.get(el?.dataset?.entryId ?? el?.dataset?.documentId);
  };
  const isOwnedPanel = (li) => {
    const actor = actorOf(li);
    return !!actor && actor.type === FE_PANEL_TYPE && actor.testUserPermission(game.user, "OWNER");
  };

  // Tokenize toggle, mirrored from the sheet header — reachable without opening the
  // sheet at all. Two mutually exclusive entries rather than one that changes label:
  // a ContextMenu entry's `name` is read once when the menu is built, so a single
  // stateful label would go stale. Each names the ACTION, not the current state.
  // v14부터 ContextMenuEntry#name/#condition은 label/visible로 대체(삭제 예정: v16).
  // 최소 지원이 v13이므로 양쪽 키를 모두 채워 넣는다(v13은 name/condition만 읽는다).
  const entry = ({ label, icon, visible, callback }) =>
    ({ label, name: label, icon, visible, condition: visible, callback });

  const items = [
    entry({
      label: game.i18n.localize("FESP.Menu.TokenizeOn"),
      icon: '<i class="fa-solid fa-chess-pawn"></i>',
      visible: (li) => isOwnedPanel(li) && !actorOf(li).system.tokenize,
      callback: (li) => actorOf(li)?.update({ "system.tokenize": true }),
    }),
    entry({
      label: game.i18n.localize("FESP.Menu.TokenizeOff"),
      icon: '<i class="fa-regular fa-square"></i>',
      visible: (li) => isOwnedPanel(li) && !!actorOf(li).system.tokenize,
      callback: (li) => actorOf(li)?.update({ "system.tokenize": false }),
    }),
    entry({
      label: game.i18n.localize("FESP.Menu.PlaceOnScene"),
      icon: '<i class="fa-solid fa-image"></i>',
      visible: (li) => isOwnedPanel(li) && !!canvas?.scene,
      callback: (li) => { const a = actorOf(li); if (a) feScreenPanelPlaceOnScene(a); },
    }),
  ];

  // Sit directly under core's "편집" (SIDEBAR.Edit) — the slot fe-theatre.js uses for its
  // own stage entries, which are excluded for panels (a panel is a display board, not a
  // character). v14 core labels the entry with the un-localized key, v13 and some modules
  // use `name` already localized, so match both. Fall back to the top when not found.
  const editLabel = game.i18n?.localize?.("SIDEBAR.Edit") ?? "편집";
  const isEdit = (o) => [o?.label, o?.name].some(v => v === "SIDEBAR.Edit" || v === editLabel);
  const editIdx = options.findIndex(isEdit);
  options.splice(editIdx >= 0 ? editIdx + 1 : 0, 0, ...items);
}));

/**
 * Scenes sidebar → right-click → "원본 없는 패널 배치 정리".
 *
 * SELF-REVEALING: the entry is only present when that scene actually has ghosts, so it
 * doubles as the notification that they exist. That is the whole job the automatic sweep
 * used to do badly — it noticed the same condition, but acted on it instead of reporting
 * it. Nothing here writes until the confirm dialog comes back true.
 *
 * Any scene, not just the active one, so a stack of imported scenes can be cleared
 * without visiting each. The count is computed live per menu build; `scene.tiles` and
 * `scene.tokens` are loaded for every world scene, so this needs no canvas.
 */
function feSceneCleanupContextEntry(_directory, options) {
  const sceneOf = (li) => {
    const el = li instanceof HTMLElement ? li : li?.[0];
    return game.scenes.get(el?.dataset?.entryId ?? el?.dataset?.documentId);
  };
  // v14부터 ContextMenuEntry#name/#condition은 label/visible로 대체(삭제 예정: v16).
  // 최소 지원이 v13이므로 양쪽 키를 모두 채워 넣는다(v13은 name/condition만 읽는다).
  const label = game.i18n.localize("FESP.Cleanup.MenuLabel");
  const visible = (li) => {
    if (!game.user.isGM || !isPanelFeatureEnabled()) return false;
    const scene = sceneOf(li);
    return !!scene && feOrphanPanelPlacementsIn(scene).length > 0;
  };
  options.push({
    label, name: label,
    icon: '<i class="fa-solid fa-broom"></i>',
    visible, condition: visible,
    callback: (li) => { const s = sceneOf(li); if (s) feCleanupOrphanPanelPlacementsIn(s); },
  });
}

// v14: getSceneContextOptions / v13: getSceneContextMenuOptions — same shape either way
// (fe-dx3rd-resource-ui.js registers the Actor pair the same way).
Hooks.on("getSceneContextOptions", feSceneCleanupContextEntry);
Hooks.on("getSceneContextMenuOptions", feSceneCleanupContextEntry);

export { feScreenPanelPlaceOnScene };
