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
    feHidePanelTooltip();
    feOpenBarValueEditor(bar.linkedActor, bar.attr, bar.value);
    return;
  }

  const hit = pickPanelTileAt(world);
  if (!hit || tokenOccludesAt(world, hit.doc)) return; // let core handle non-panel / token clicks
  event.preventDefault();
  event.stopImmediatePropagation(); // suppress core canvas pan / selection
  // The canvas marquee select is driven by the board's PIXI MouseInteractionManager
  // off FEDERATED events. PIXI's EventSystem dispatches those synchronously from its
  // own (earlier-registered, capture-phase) DOM listener on the same <canvas>, so our
  // stopImmediatePropagation can land AFTER the board MIM has already advanced to
  // GRABBED — leaving the select-rectangle to draw on the next pointermove. Reset the
  // board MIM back to NONE so its drag-move handler bails (state must be ≥ GRABBED to
  // start a marquee). Our own panel drag uses independent window listeners, so this
  // only cancels the stray canvas selection, not the panel move. Idempotent no-op when
  // our suppression won the race and the MIM never engaged.
  try { canvas.mouseInteractionManager?.reset?.({ state: true }); } catch { /* no-op */ }
  feHidePanelTooltip();

  // A click landing on a value bar (only "there" for users with OWNER on its
  // linked actor — see pickPanelBarAt) opens its quick-edit dialog instead of
  // starting a drag or counting toward the double-click face cycle.
  const barHit = pickPanelBarAt(hit.tile, world);
  if (barHit) { feOpenBarValueEditor(barHit.linkedActor, barHit.attr, barHit.value); return; }

  // Owners may left-drag to reposition (unless the panel is locked — per-actor
  // or per-placement). Below the move threshold it is a click; a double click
  // cycles the face. The menu lives on right-click (onBoardContextMenu).
  const canDrag = hit.actor.testUserPermission(game.user, "OWNER")
    && !hit.actor.system.locked && !hit.flag?.locked;
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
  if (!feIsPanelToken(hit.tile) && tokenOccludesAt(world, hit.doc)) return;
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
    const actor = game.actors.get(flag.actorId);
    const boxW = actor?.system?.width || FE_PANEL_DEFAULT_SIZE;
    const boxH = actor?.system?.height || FE_PANEL_DEFAULT_SIZE;
    const { w, h } = feAspectFit(boxW, boxH, natW, natH);

    // Tokenized panel: width/height are GRID UNITS, not pixels, and there is no
    // `fit` to enforce (core scales a token's texture to its box). Convert the same
    // aspect-fitted pixel box through the grid so a face flip to a differently-shaped
    // image reshapes the token exactly like it reshapes a tile.
    if (feIsPanelToken(tile)) {
      // A face whose Token settings pin an explicit size owns it — the user set it through
      // core's TokenConfig, so the aspect auto-fit must not fight them every draw.
      if (feFaceTokenPinsSize(fePanelFace(actor, flag.currentFace ?? 0))) return;
      const size = feCompanionTokenSize(doc.parent, w, h, isGridSnapEnabled());
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
    const overlays = tile._fePanelOverlays;
    if (!flag.disabled) {
      if (overlays) for (const t of overlays) t.visible = true;
      return;
    }
    const actor = game.actors.get(flag.actorId);
    const canSee = !!actor && actor.testUserPermission(game.user, "OBSERVER");
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
      if (v !== undefined && v !== null && v !== "") return String(v);
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

/** (Re)draw a bar's track + fill rects in its own local space (0,0 origin). */
function feDrawBarGraphics(bar, w, h, pct, color) {
  bar.clear();
  bar.beginFill(0x000000, 0.5).drawRect(0, 0, w, h).endFill();
  const fillW = Math.max(0, Math.min(w, w * pct));
  if (fillW > 0) bar.beginFill(color || "#33cc33").drawRect(0, 0, fillW, h).endFill();
}

/**
 * Full (re)build of a panel tile's overlay labels for its CURRENT face. Called
 * whenever content can change: initial draw, face flips (drawTile fires for
 * both — texture.src changes set the redraw flag), and whenever the panel
 * actor's faces/overlays or the linked actor's data is edited.
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
          const barW = Math.max(1, text.width);
          const barH = Math.max(1, Math.round((item.barHeight || 6) * scale));
          const gap = Math.max(1, Math.round(2 * scale));
          const bar = new PIXI.Graphics();
          feDrawBarGraphics(bar, barW, barH, pct, item.barColor);
          bar.position.set(text.position.x - barW / 2, text.position.y + text.height / 2 + gap);
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
          bar.zIndex = text.zIndex;
          bar._feIsBar = true;
          bar._feBarHeight = item.barHeight || 6;
          bar._feBarColor = item.barColor;
          bar._feBarPct = pct;
          bar._feBarW = barW;
          bar._feBarH = barH;
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
      const bar = obj._feBar;
      if (bar) {
        obj.updateText?.(true); // force sync re-measure so .width reflects the new fontSize
        const barW = Math.max(1, obj.width);
        const barH = Math.max(1, Math.round(bar._feBarHeight * scale));
        const gap = Math.max(1, Math.round(2 * scale));
        bar.position.set(obj.position.x - barW / 2, obj.position.y + obj.height / 2 + gap);
        bar._feBarW = barW; // kept fresh for pickPanelBarAt's hit test
        bar._feBarH = barH;
        feDrawBarGraphics(bar, barW, barH, bar._feBarPct, bar._feBarColor);
      }
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

Hooks.on("canvasReady", () => {
  fePanelTileIndexReady = false;
  attachBoardListeners();
  feBuildPanelTileIndex();
});
// drawTile fires on initial draw, full redraw, AND face flips (texture.src sets
// the redraw flag), each time with the new texture loaded — so it is the only
// hook the aspect resize needs.
Hooks.on("drawTile", enforcePanelTileSize);
// Must run AFTER enforcePanelTileSize — it reads the tile's just-resized mesh
// (via panelTileRect) to position labels against the actually-drawn art.
Hooks.on("drawTile", feRebuildPanelOverlays);
Hooks.on("drawTile", feIndexPanelTile);
Hooks.on("drawTile", applyPanelTileVisibility);
Hooks.on("refreshTile", feRepositionPanelOverlays);
Hooks.on("refreshTile", applyPanelTileVisibility);

// A tokenized panel is a Token, so the same overlay/index/visibility work must run off
// the Token draw cycle too — otherwise a tokenized panel shows no overlay labels and is
// missing from the linked-actor index. The handlers are placeable-shape-agnostic
// (panelTileRect reads the mesh; the panel flag lives on either document), and they
// no-op immediately on any placeable without a panel flag — i.e. on every ordinary
// token in the scene.
Hooks.on("drawToken", enforcePanelTileSize);
Hooks.on("drawToken", feRebuildPanelOverlays);
Hooks.on("drawToken", feIndexPanelTile);
Hooks.on("drawToken", applyPanelTileVisibility);
Hooks.on("refreshToken", feRepositionPanelOverlays);
Hooks.on("refreshToken", applyPanelTileVisibility);
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
// Face flips and panel-flag changes are document updates. Reindex immediately
// so a linked Actor update in the same render cycle still finds the right tile;
// drawTile repeats this harmlessly once the new texture is ready.
Hooks.on("updateTile", (doc) => { if (doc?.object) feIndexPanelTile(doc.object); });

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
    // instance between a Tile and a Token (not just at placement time).
    if (changes.system?.tokenize !== undefined) feSyncPanelTokenization(actor);
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
    if (isPanelFeatureEnabled() && this.document?.getFlag?.(MODULE_ID, FE_PANEL_TILE_FLAG)?.actorId) return false;
    return original.apply(this, args);
  };
}

// Position lock for TOKENIZED panels. A Tile has a real `locked` field that core's own
// tile tools honour, but a Token has none — and core owns a tokenized panel's dragging,
// so the only place to enforce the panel's lock is the update itself. Cancelling the
// pre-hook makes core snap the token back to where it was. Mirrors the tile lock:
// per-placement (`flag.locked`, the right-click menu) OR per-panel
// (`actor.system.locked`, the sheet's 위치 고정). GMs are not exempt — the lock is a
// deliberate "don't nudge this board" guard; unlock it to move it.
Hooks.on("preUpdateToken", (doc, changes) => {
  if ((changes.x === undefined) && (changes.y === undefined)) return;
  const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
  if (!flag?.actorId) return;
  const actor = game.actors.get(flag.actorId);
  if (!flag.locked && !actor?.system?.locked) return;
  ui.notifications?.warn(game.i18n.localize("FESP.Menu.LockedWarn"));
  return false;
});

// Dragging a panel actor onto the canvas must go through feScreenPanelPlaceOnScene.
// Without this guard core's default Actor drop (board.mjs `#onDrop` → tokens._onDropActor)
// creates an ordinary Token from the panel actor: it carries no panel flag, so it is not
// a panel at all — no face cycle, no panel menu, no overlays, and core's "double-click an
// owned token" opens the sheet instead. Our placement produces the right placeable for
// the panel's own tokenize setting (a Token or a Tile, never both) with the flag attached.
// Returning false aborts core's own handling (board.mjs: `if (allowed === false) return`).
// data.x/data.y are already canvas coordinates, so the panel lands under the cursor.
Hooks.on("dropCanvasData", (_canvas, data) => {
  if (data?.type !== "Actor") return;
  let actor = null;
  try { actor = data.uuid ? fromUuidSync(data.uuid) : game.actors.get(data.id); } catch { /* no-op */ }
  if (actor?.type !== FE_PANEL_TYPE) return; // not a panel → core handles it normally
  feScreenPanelPlaceOnScene(actor, { x: data.x, y: data.y });
  return false;
});

// Add panel entries to the Actor directory context menu.
Hooks.on("getActorContextOptions", (directory, options) => {
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
});

export { feScreenPanelPlaceOnScene };
