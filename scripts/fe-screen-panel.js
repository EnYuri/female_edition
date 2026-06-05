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
    _boardEl.removeEventListener("mousemove", onBoardMouseMove, false);
    _boardEl.removeEventListener("mouseleave", onBoardMouseLeave, false);
  }
  _boardEl = view;
  view.addEventListener("pointerdown", onBoardPointerDown, true);
  view.addEventListener("mousemove", onBoardMouseMove, false);
  view.addEventListener("mouseleave", onBoardMouseLeave, false);
}

const FE_PANEL_DRAG_THRESHOLD = 6; // px of pointer travel before a click becomes a drag

function onBoardPointerDown(event) {
  if (!isPanelFeatureEnabled() || event.button !== 0 || !canvas?.ready) return;
  const world = clientToWorld(event.clientX, event.clientY);
  if (!world) return;
  const hit = pickPanelTileAt(world);
  if (!hit || tokenOccludesAt(world, hit.doc)) return; // let core handle non-panel / token clicks
  event.preventDefault();
  event.stopImmediatePropagation(); // suppress core canvas pan / selection
  feHidePanelTooltip();

  // Owners may drag to reposition; everyone else just gets the dropdown. The
  // distinction between a drag and a click is made on release (threshold below).
  const canDrag = hit.actor.testUserPermission(game.user, "OWNER") && !hit.actor.system.locked;
  startPanelPointer(hit, event, canDrag);
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
    finalPos = { x: Math.round(origin.x + (w.x - startWorld.x)), y: Math.round(origin.y + (w.y - startWorld.y)) };
    if (mesh) mesh.position.set(finalPos.x, finalPos.y); // local preview; authoritative update on release
  };
  const cleanup = () => {
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
  };
  const onUp = (e) => {
    cleanup();
    if (dragging) {
      try { hit.doc.updateSource({ x: finalPos.x, y: finalPos.y }); } catch { /* local-only optimistic sync */ }
      feActionMove(hit.tile, finalPos.x, finalPos.y);
    } else {
      feOpenPanelMenu({ tile: hit.tile, actor: hit.actor, clientX: e.clientX, clientY: e.clientY });
    }
  };
  const onCancel = () => {
    cleanup();
    if (mesh) mesh.position.set(origin.x, origin.y); // snap preview back
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
    if (!flag?.actorId || !flag.disabled) return;
    const actor = game.actors.get(flag.actorId);
    const canSee = !!actor && actor.testUserPermission(game.user, "OBSERVER");
    if (!canSee) {
      if (tile.mesh) tile.mesh.visible = false;
      tile.visible = false;
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
async function feActionMove(tile, x, y) { return feRelayPanelOp(FE_PANEL_SOCKET.MOVE, { ...tileRef(tile), x, y }); }
async function feActionShowHide(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.SHOW_HIDE, tileRef(tile)); }
async function feActionDisable(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.DISABLE, tileRef(tile)); }
async function feActionRemove(tile) { return feRelayPanelOp(FE_PANEL_SOCKET.REMOVE, tileRef(tile)); }

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
  });
}

// --------------------------------
// GM relay — apply (runs only on the active GM)
// --------------------------------

async function applyPanelOp(type, data) {
  const requester = game.users.get(data.requesterId) ?? game.user;

  if (type === FE_PANEL_SOCKET.PLACE) {
    const actor = game.actors.get(data.actorId);
    if (!actor || !actor.testUserPermission(requester, "OWNER")) return;
    const scene = game.scenes.get(data.sceneId);
    if (!scene) return;
    await scene.createEmbeddedDocuments("Tile", [{
      texture: { src: data.img || "", fit: "contain" },
      x: data.x, y: data.y, width: data.width, height: data.height,
      flags: { [MODULE_ID]: { [FE_PANEL_TILE_FLAG]: { actorId: data.actorId, currentFace: data.currentFace ?? 0, disabled: false } } },
    }]);
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

  if (type === FE_PANEL_SOCKET.FLIP) {
    const face = fePanelFace(actor, data.faceIndex);
    await doc.update({
      "texture.src": face.img || "",
      [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.currentFace`]: face.index,
    });
  } else if (type === FE_PANEL_SOCKET.MOVE) {
    await doc.update({ x: Math.round(data.x), y: Math.round(data.y) });
  } else if (type === FE_PANEL_SOCKET.SHOW_HIDE) {
    await doc.update({ hidden: !doc.hidden });
  } else if (type === FE_PANEL_SOCKET.DISABLE) {
    await doc.update({ [`flags.${MODULE_ID}.${FE_PANEL_TILE_FLAG}.disabled`]: !flag?.disabled });
  } else if (type === FE_PANEL_SOCKET.REMOVE) {
    await scene.deleteEmbeddedDocuments("Tile", [doc.id]);
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
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.SCREEN_PANEL_ENABLED],
    requiresReload: true,
  });
});

Hooks.once("ready", () => {
  feInitPanelMenuDismissers();
  feSetPanelMenuActions({
    flip: feActionFlip,
    toggleShowHide: feActionShowHide,
    toggleDisable: feActionDisable,
    remove: feActionRemove,
    openSheet: (actor) => actor?.sheet?.render(true),
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
Hooks.on("drawTile", applyPanelTileVisibility);
Hooks.on("refreshTile", applyPanelTileVisibility);

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

// Re-evaluate placed tiles when a panel actor's ownership changes.
Hooks.on("updateActor", (actor, changes) => {
  if (actor.type !== FE_PANEL_TYPE) return;
  if (!("ownership" in (changes ?? {}))) return;
  for (const tile of canvas?.tiles?.placeables ?? []) {
    const flag = tile.document.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG);
    if (flag?.actorId === actor.id) tile.renderFlags?.set?.({ refreshState: true });
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
