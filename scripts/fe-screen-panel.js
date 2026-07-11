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
import {
  FE_PANEL_TYPE,
  FE_PANEL_TILE_FLAG,
  FE_PANEL_SOCKET,
  FE_PANEL_DEFAULT_SIZE,
  ScreenPanelData,
  feEnsureScreenPanelDnd5eActorCompat,
  fePanelFace,
} from "./fe-screen-panel-data.js";
import { ScreenPanelSheet } from "./fe-screen-panel-sheet.js";
import {
  feSetPanelMenuActions,
  feOpenPanelMenu,
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

function isDblclickCycleEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.SCREEN_PANEL_DBLCLICK_CYCLE); }
  catch { return !!FE_DEFAULTS[S.SCREEN_PANEL_DBLCLICK_CYCLE]; }
}

async function toggleDblclickCycle() {
  try {
    const next = !isDblclickCycleEnabled();
    await game.settings.set(MODULE_ID, S.SCREEN_PANEL_DBLCLICK_CYCLE, next);
    return next;
  } catch { return isDblclickCycleEnabled(); }
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

/** Natural pixel size of an image src (cached; null on failure / empty). */
function feLoadImageSize(src) {
  if (!src) return Promise.resolve(null);
  if (_panelImgSizeCache.has(src)) return Promise.resolve(_panelImgSizeCache.get(src));
  if (_panelImgSizePending.has(src)) return _panelImgSizePending.get(src);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { const r = { w: img.naturalWidth, h: img.naturalHeight }; _panelImgSizeCache.set(src, r); resolve(r); };
    img.onerror = () => { _panelImgSizeCache.set(src, null); resolve(null); };
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

/** Topmost panel tile (by elevation, sort) at a world point that this user may see. */
function pickPanelTileAt(world) {
  const placeables = canvas?.tiles?.placeables ?? [];
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
  const hit = pickPanelTileAt(world);
  if (!hit || tokenOccludesAt(world, hit.doc)) return; // let core handle elsewhere
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
    if (isDblclickCycleEnabled() && _lastPanelClick && _lastPanelClick.tileId === tileId && (now - _lastPanelClick.t) < FE_PANEL_DBLCLICK_MS) {
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
}

function onBoardMouseMove(event) {
  if (!isPanelFeatureEnabled() || !canvas?.ready) return;
  const now = performance.now();
  if (now - _lastMove < 30) return;
  _lastMove = now;
  if (isPanelMenuOpen()) { feHidePanelTooltip(); return; }
  const world = clientToWorld(event.clientX, event.clientY);
  if (!world) { feHidePanelTooltip(); return; }
  const hit = pickPanelTileAt(world);
  if (!hit || tokenOccludesAt(world, hit.doc)) { feHidePanelTooltip(); return; }
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
      // THEN sort/zIndex. Tile meshes carry sortLayer = SORT_LAYERS.TILES (500,
      // assigned by core Tile#_refreshState); leaving the label's sortLayer at
      // the default 0 means it always loses that comparison and renders BEHIND
      // the tile's own image regardless of sort/zIndex. Use the SORT_LAYERS
      // constant directly rather than reading tile.mesh.sortLayer — at the
      // drawTile hook (when this runs) _refreshState may not have fired yet, so
      // the mesh's own sortLayer can still read its just-constructed 0.
      text.sortLayer = canvas.primary?.constructor?.SORT_LAYERS?.TILES ?? 0;
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
  if (game.user.isGM) return applyPanelOp(type, { ...payload, requesterId: game.user.id });
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

async function feScreenPanelPlaceOnScene(actor) {
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
  await feRelayPanelOp(FE_PANEL_SOCKET.PLACE, {
    sceneId: canvas.scene.id,
    actorId: actor.id,
    x: Math.round(pivot.x - w / 2),
    y: Math.round(pivot.y - h / 2),
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
 * The companion Token created for a "tokenized" panel (see ScreenPanelData.tokenize)
 * is found via the Tile's own flag (set right after creation) — not by re-scanning
 * tokens by actorId, since the same actor may be placed more than once.
 */
function feFindCompanionToken(scene, flag) {
  const id = flag?.companionTokenId;
  return id ? scene?.tokens?.get(id) ?? null : null;
}

/**
 * Companion Token size (in GRID UNITS — token width/height are grid units, NOT
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
 * Create a companion Token for one already-placed panel Tile, mirroring its
 * current position/face image and its pixel size (converted to grid units per
 * feCompanionTokenSize). Tags the token back to this specific Tile and stores
 * companionTokenId on the Tile's flag so feFindCompanionToken can resolve it.
 * GM-only (embedded writes). `snap` defaults to the local grid-snap preference;
 * PLACE passes the initiator's own flag through so their intent is honored.
 */
async function feCreateCompanionTokenFor(scene, tileDoc, actor, snap = isGridSnapEnabled()) {
  const flag = tileDoc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
  const face = fePanelFace(actor, flag?.currentFace ?? 0);
  const { width, height } = feCompanionTokenSize(scene, tileDoc.width, tileDoc.height, snap);
  const tokenDoc = await actor.getTokenDocument({
    x: tileDoc.x, y: tileDoc.y, width, height,
    hidden: tileDoc.hidden,
    texture: { src: face.img || tileDoc.texture?.src || "" },
    flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: { actorId: actor.id, companion: true, tileId: tileDoc.id } } },
  }, { parent: scene });
  const [created] = await scene.createEmbeddedDocuments("Token", [tokenDoc.toObject()]);
  if (created) await tileDoc.setFlag(MODULE_ID, `${FE_PANEL_TILE_FLAG}.companionTokenId`, created.id);
}

/**
 * Reactively reconcile every placed instance of `panelActor` (across ALL scenes)
 * with its current `system.tokenize` setting: spawn a companion Token where one
 * is now wanted but missing, and remove the companion where tokenize was turned
 * off. This makes the tokenize toggle take effect on already-placed panels
 * instead of only at placement time. GM-only; runs from the updateActor hook.
 */
async function feSyncPanelTokenization(panelActor) {
  if (game.user !== game.users.activeGM) return;
  const want = !!panelActor.system.tokenize;
  for (const scene of game.scenes ?? []) {
    for (const tileDoc of scene.tiles ?? []) {
      const flag = tileDoc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
      if (!flag || flag.actorId !== panelActor.id) continue;
      const companion = feFindCompanionToken(scene, flag);
      try {
        if (want && !companion) {
          await feCreateCompanionTokenFor(scene, tileDoc, panelActor);
        } else if (!want && companion) {
          await scene.deleteEmbeddedDocuments("Token", [companion.id]);
          await tileDoc.unsetFlag(MODULE_ID, `${FE_PANEL_TILE_FLAG}.companionTokenId`);
        }
      } catch (err) { console.warn(`${MODULE_ID} | screen panel tokenize sync failed`, err); }
    }
  }
}

async function applyPanelOp(type, data) {
  const requester = game.users.get(data.requesterId) ?? game.user;

  if (type === FE_PANEL_SOCKET.PLACE) {
    const actor = game.actors.get(data.actorId);
    if (!actor || !actor.testUserPermission(requester, "OWNER")) return;
    const scene = game.scenes.get(data.sceneId);
    if (!scene) return;
    const [tileDoc] = await scene.createEmbeddedDocuments("Tile", [{
      texture: { src: data.img || "", fit: "contain" },
      x: data.x, y: data.y, width: data.width, height: data.height,
      flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: { actorId: data.actorId, currentFace: data.currentFace ?? 0, disabled: false } } },
    }]);
    // Optional companion Token (ScreenPanelData.tokenize) — same position/face
    // image, tagged back to this specific Tile placement (not just the actor,
    // since the same panel actor may be placed more than once). Token size is
    // grid-unit-converted from the tile's pixel box, honoring the INITIATOR's
    // own grid-snap preference (data.gridSnap) rather than the GM's.
    if (actor.system.tokenize && tileDoc) {
      try { await feCreateCompanionTokenFor(scene, tileDoc, actor, !!data.gridSnap); }
      catch (err) { console.warn(`${MODULE_ID} | screen panel companion token creation failed`, err); }
    }
    return;
  }

  const scene = game.scenes.get(data.sceneId);
  const doc = scene?.tiles?.get(data.tileId);
  if (!doc) return;
  const flag = doc.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
  const actor = game.actors.get(flag?.actorId);
  if (!actor) return;

  const level = type === FE_PANEL_SOCKET.FLIP ? "OBSERVER" : "OWNER";
  if (!actor.testUserPermission(requester, level)) return;
  const companion = feFindCompanionToken(scene, flag);

  if (type === FE_PANEL_SOCKET.FLIP) {
    const face = fePanelFace(actor, data.faceIndex);
    await doc.update({
      "texture.src": face.img || "",
      [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.currentFace`]: face.index,
    });
    if (companion) await companion.update({ "texture.src": face.img || "" });
  } else if (type === FE_PANEL_SOCKET.MOVE) {
    await doc.update({ x: Math.round(data.x), y: Math.round(data.y) });
    if (companion) await companion.update({ x: Math.round(data.x), y: Math.round(data.y) });
  } else if (type === FE_PANEL_SOCKET.SHOW_HIDE) {
    await doc.update({ hidden: !doc.hidden });
    if (companion) await companion.update({ hidden: !companion.hidden });
  } else if (type === FE_PANEL_SOCKET.DISABLE) {
    await doc.update({ [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.disabled`]: !flag?.disabled });
  } else if (type === FE_PANEL_SOCKET.LOCK) {
    await doc.update({ [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.locked`]: !flag?.locked });
  } else if (type === FE_PANEL_SOCKET.REMOVE) {
    await scene.deleteEmbeddedDocuments("Tile", [doc.id]);
    if (companion) await scene.deleteEmbeddedDocuments("Token", [companion.id]);
  }
}

function onPanelSocket(data) {
  if (!data?.type || !PANEL_SOCKET_TYPES.has(data.type)) return; // foreign type — ignore
  if (game.user !== game.users.activeGM) return; // only the primary GM applies
  applyPanelOp(data.type, data).catch(err => console.error(`${MODULE_ID} | screen panel op failed`, err));
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

  game.settings.register(MODULE_ID, S.SCREEN_PANEL_DBLCLICK_CYCLE, {
    name: "FESP.Settings.DblclickCycleName",
    hint: "FESP.Settings.DblclickCycleHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SCREEN_PANEL_DBLCLICK_CYCLE],
  });
});

Hooks.once("setup", () => {
  for (const actor of game.actors ?? []) feEnsureScreenPanelDnd5eActorCompat(actor);
});

Hooks.once("ready", () => {
  feInitPanelMenuDismissers();
  feSetPanelMenuActions({
    flip: feActionFlip,
    toggleShowHide: feActionShowHide,
    toggleDisable: feActionDisable,
    toggleLock: feActionLock,
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

Hooks.on("canvasReady", attachBoardListeners);
// drawTile fires on initial draw, full redraw, AND face flips (texture.src sets
// the redraw flag), each time with the new texture loaded — so it is the only
// hook the aspect resize needs.
Hooks.on("drawTile", enforcePanelTileSize);
// Must run AFTER enforcePanelTileSize — it reads the tile's just-resized mesh
// (via panelTileRect) to position labels against the actually-drawn art.
Hooks.on("drawTile", feRebuildPanelOverlays);
Hooks.on("drawTile", applyPanelTileVisibility);
Hooks.on("refreshTile", feRepositionPanelOverlays);
Hooks.on("refreshTile", applyPanelTileVisibility);
// Orphaned overlay PIXI objects aren't covered by core's own Tile teardown
// (canvas.primary.removeTile only destroys the mesh it tracks itself).
Hooks.on("deleteTile", (doc) => { if (doc?.object) feClearPanelOverlays(doc.object); });

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
    // Reactive tokenize: turning the setting on/off adds/removes the companion
    // token for every already-placed instance (not just at placement time).
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
  for (const tile of canvas?.tiles?.placeables ?? []) {
    const flag = tile.document.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (!flag?.actorId) continue;
    const panelActor = game.actors.get(flag.actorId);
    if (!panelActor) continue;
    const isPanelActor = panelActor.id === actor.id;

    if (isPanelActor && "ownership" in (changes ?? {}))
      tile.renderFlags?.set?.({ refreshState: true });

    // Sync tile texture with current face image when faces data changed.
    if (isPanelActor && isGM && facesChanged) {
      const curFace = fePanelFace(panelActor, flag.currentFace ?? 0);
      const tileSrc = tile.document.texture?.src ?? "";
      if (curFace.img && tileSrc !== curFace.img) {
        tile.document.update({ "texture.src": curFace.img });
        const companion = feFindCompanionToken(canvas.scene, flag);
        if (companion) companion.update({ "texture.src": curFace.img });
      }
    }

    // Overlay rebuild: only when system data actually changed (skip pure
    // prototypeToken / img-only updates triggered by our own sync above).
    if (isPanelActor && changes.system !== undefined) feRebuildPanelOverlays(tile);

    if (!isPanelActor) {
      const isLinkedActor = (panelActor.system?.faces ?? []).some((face) =>
        (face.overlays ?? []).some((ov) => {
          if (!ov.linkedActorUuid) return false;
          try { return fromUuidSync(ov.linkedActorUuid)?.id === actor.id; }
          catch { return false; }
        })
      );
      if (isLinkedActor) feRebuildPanelOverlays(tile);
    }
  }
});

// Add "Place on current scene" to the Actor directory context menu for panels.
Hooks.on("getActorContextOptions", (directory, options) => {
  options.push({
    name: game.i18n.localize("FESP.Menu.PlaceOnScene"),
    icon: '<i class="fa-solid fa-image"></i>',
    condition: (li) => {
      const el = li instanceof HTMLElement ? li : li?.[0];
      const id = el?.dataset?.entryId ?? el?.dataset?.documentId;
      const actor = game.actors.get(id);
      return !!actor && actor.type === FE_PANEL_TYPE && actor.testUserPermission(game.user, "OWNER") && !!canvas?.scene;
    },
    callback: (li) => {
      const el = li instanceof HTMLElement ? li : li?.[0];
      const id = el?.dataset?.entryId ?? el?.dataset?.documentId;
      const actor = game.actors.get(id);
      if (actor) feScreenPanelPlaceOnScene(actor);
    },
  });
});

export { feScreenPanelPlaceOnScene };
