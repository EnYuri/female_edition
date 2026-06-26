// Female-cupwhi: Token selection silhouette glow.
//
// When a token is controlled (selected) or hovered, draw a glow that follows the
// token image's NON-TRANSPARENT silhouette (the effective visible art), instead of
// — or in addition to — Foundry's grid-square selection border. Only the HUE of the
// native selection outline is preserved (control = green, disposition colors, …):
// `token._getBorderColor()` feeds the glow color. The same smooth glow is used in
// every theme, including the retro / pixel theme.
//
// Implementation: a per-token overlay PIXI.Sprite mirrors the token's own
// PrimarySpriteMesh transform and carries a custom knockout outer-glow filter. The
// sprite lives in a dedicated container under `canvas.tokens` (same world transform
// as the token meshes), so it pans/zooms with the scene. Knockout means the token's
// own body pixels are erased from the overlay — only the surrounding glow ring shows,
// and the real token mesh below stays fully crisp.
//
// The selection glow is a radial GRADIENT: inner (near the silhouette) = this client's
// player color, fading outward to the native selection hue.
//
// Target sightlines (controlled token -> the user's targets) are BROADCAST over the
// shared module socket, so every user sees every other user's lines. Each line's solid
// CORE stroke uses the owning user's player color (telling whose line is whose); the
// soft underlying GLOW keeps the target's native selection hue. A small distance
// readout (scene grid units) is drawn near each line's target end, hidden when the
// scene declares no grid distance. Endpoints resolve per-client by token id, so a
// token a given user can't see drops out of that user's view automatically.
//
// Self-contained except for fe-constants.js. Canvas-only (no CSS, no HTML).

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function feTgSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return FE_DEFAULTS[key]; }
}

function feTgEnabled() {
  return !!feTgSetting(S.TOKEN_GLOW_ENABLED);
}

/* -------------------------------------------- */
/*  Custom glow filter                          */
/* -------------------------------------------- */

// Outline distance (texture-space px the glow reaches out to) and sampling quality.
// Compiled into the shader as constants, so a change requires a fresh filter (we
// rebuild everything on the relevant setting onChange anyway).
const FE_TG_DISTANCE = 12;
const FE_TG_QUALITY = 0.12;

// knockout = true  -> silhouette filter: erase the body, show only the outer ring
//                     (used over the token mesh; the crisp mesh shows through).
// knockout = false -> additive marker glow: keep the original graphic and add a halo
//                     behind it (used on the native target-arrow reticule).
function feTgFragmentShader(knockout = true) {
  const dist = FE_TG_DISTANCE.toFixed(0);
  // ANGLE_STEP_SIZE / MAX_TOTAL_ALPHA mirror core GlowOverlayFilter's derivation.
  const angleStep = Math.min(1 / (FE_TG_QUALITY * FE_TG_DISTANCE), Math.PI * 2).toFixed(7);
  const tail = knockout ? `
    // Outer glow only, knocked out where the token's own art is opaque so the body
    // stays transparent (the real mesh below shows through unaltered). The hue is a
    // radial gradient: strong (near the silhouette) -> glowColorInner (player color),
    // fading outward -> glowColorOuter (the native selection hue).
    float bodyMask = 1.0 - smoothstep(0.35, 1.0, curColor.a);
    float t = clamp(alphaRatio * outerStrength, 0.0, 1.0);
    // Color mix biased 1.5x toward the inner (player) hue so it occupies more of the
    // ring; the alpha falloff below stays on the unbiased t.
    float tc = clamp(t * 1.5, 0.0, 1.0);
    vec3 gcol = mix(glowColorOuter.rgb, glowColorInner.rgb, tc);
    // Lift the outer (low-t) region so the selection hue there isn't washed out to ~0
    // alpha, while still fading to 0 at the very edge (sqrt keeps t=0 -> a=0).
    float a = clamp(sqrt(t) * bodyMask, 0.0, 1.0);
    gl_FragColor = vec4(gcol * a, a);
  ` : `
    // Additive marker glow: a halo behind the original graphic. uSampler is
    // premultiplied, so composite the original "source-over" the glow ring.
    float ring = clamp(alphaRatio * outerStrength, 0.0, 1.0);
    float glowA = ring * (1.0 - curColor.a);
    vec3  glowPM = glowColor.rgb * glowA;
    float outA = curColor.a + glowA * (1.0 - curColor.a);
    vec3  outRGB = curColor.rgb + glowPM * (1.0 - curColor.a);
    gl_FragColor = vec4(outRGB, outA);
  `;
  return `
  precision highp float;
  varying vec2 vTextureCoord;
  uniform sampler2D uSampler;
  uniform vec4 inputSize;
  uniform vec4 inputClamp;

  uniform float outerStrength;
  uniform vec4 glowColor;
  uniform vec4 glowColorInner;
  uniform vec4 glowColorOuter;

  const float PI = 3.14159265358979323846264;

  const float DIST = ${dist}.0;
  const float ANGLE_STEP_SIZE = ${angleStep};
  const float ANGLE_STEP_NUM = ceil(PI * 2.0 / ANGLE_STEP_SIZE);
  const float MAX_TOTAL_ALPHA = ANGLE_STEP_NUM * DIST * (DIST + 1.0) / 2.0;

  float getClip(in vec2 uv) {
    return step(3.5,
      step(inputClamp.x, uv.x) +
      step(inputClamp.y, uv.y) +
      step(uv.x, inputClamp.z) +
      step(uv.y, inputClamp.w));
  }

  void main(void) {
    vec2 px = inputSize.zw;
    float totalAlpha = 0.0;
    vec2 direction;
    vec2 displaced;
    vec4 curColor;

    for (float angle = 0.0; angle < PI * 2.0; angle += ANGLE_STEP_SIZE) {
      direction = vec2(cos(angle), sin(angle)) * px;
      for (float curDistance = 0.0; curDistance < DIST; curDistance++) {
        displaced = vTextureCoord + direction * (curDistance + 1.0);
        curColor = texture2D(uSampler, displaced) * getClip(displaced);
        totalAlpha += (DIST - curDistance) * smoothstep(0.5, 1.0, curColor.a);
      }
    }

    curColor = texture2D(uSampler, vTextureCoord);
    float alphaRatio = totalAlpha / MAX_TOTAL_ALPHA;
${tail}
  }`;
}

class FeTokenGlowFilter extends PIXI.Filter {
  constructor() {
    super(undefined, feTgFragmentShader(), {
      outerStrength: 3.0,
      glowColor: [0.2, 0.74, 0.3, 1.0],
      glowColorInner: [0.2, 0.74, 0.3, 1.0],
      glowColorOuter: [0.2, 0.74, 0.3, 1.0],
    });
    this.padding = FE_TG_DISTANCE + 4;
    this._baseStrength = 3.0;
  }

  /** @override Scale intensity with zoom + gentle pulse, like core glow/outline filters. */
  apply(filterManager, input, output, clear) {
    let strength = this._baseStrength * (canvas.stage?.worldTransform?.d ?? 1);
    if (!canvas.photosensitiveMode) {
      const time = canvas.app?.ticker?.lastTime ?? 0;
      strength *= Math.oscillation(0.85, 1.18, time, 1600);
    }
    this.uniforms.outerStrength = strength;
    filterManager.applyFilter(this, input, output, clear);
  }
}

// Additive glow applied to the native target-arrow reticule (kept crisp, halo added).
class FeMarkerGlowFilter extends PIXI.Filter {
  constructor() {
    super(undefined, feTgFragmentShader(false), {
      outerStrength: 2.4,
      glowColor: [1.0, 0.27, 0.27, 1.0],
      glowColorInner: [1.0, 0.27, 0.27, 1.0],
      glowColorOuter: [1.0, 0.27, 0.27, 1.0],
    });
    this.padding = FE_TG_DISTANCE + 4;
    this._baseStrength = 2.4;
  }

  /** @override Match the silhouette glow's zoom-scaling + pulse. */
  apply(filterManager, input, output, clear) {
    let strength = this._baseStrength * (canvas.stage?.worldTransform?.d ?? 1);
    if (!canvas.photosensitiveMode) {
      const time = canvas.app?.ticker?.lastTime ?? 0;
      strength *= Math.oscillation(0.85, 1.18, time, 1600);
    }
    this.uniforms.outerStrength = strength;
    filterManager.applyFilter(this, input, output, clear);
  }
}

/* -------------------------------------------- */
/*  Overlay management                          */
/* -------------------------------------------- */

// token.id (current scene) -> { sprite, filter }
const FE_TG_OVERLAYS = new Map();

function feTgGetLayer() {
  const tokens = canvas?.tokens;
  if (!tokens) return null;
  let layer = tokens.feGlowLayer;
  if (!layer || layer.destroyed) {
    layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    layer.sortableChildren = false;
    // Above the placeable token sprites/borders within the tokens layer.
    layer.zIndex = -1; // tokens layer sorts children; keep glow just under borders.
    tokens.addChild(layer);
    tokens.feGlowLayer = layer;
  }
  return layer;
}

function feTgBorderColorRGB(token) {
  let raw;
  try { raw = token._getBorderColor?.(); } catch { /* no-op */ }
  if (raw == null) raw = CONFIG.Canvas?.dispositionColors?.CONTROLLED ?? 0x33bc4e;
  try {
    const c = foundry.utils.Color.from(raw);
    return [c.r, c.g, c.b];
  } catch {
    return [0.2, 0.74, 0.3];
  }
}

// Hex int form of the token's selection-border hue, for tinting PIXI line strokes.
function feTgBorderColorInt(token) {
  let raw;
  try { raw = token._getBorderColor?.(); } catch { /* no-op */ }
  if (raw == null) raw = CONFIG.Canvas?.dispositionColors?.HOSTILE ?? 0xe72124;
  try { return Number(foundry.utils.Color.from(raw)); } catch { return 0xe72124; }
}

// A user's player color as a [r,g,b] (0–1) array, for the selection-glow inner hue
// and the sightline core stroke.
function feTgUserColorRGB(user) {
  try {
    const c = foundry.utils.Color.from(user?.color ?? 0xffffff);
    return [c.r, c.g, c.b];
  } catch {
    return [1, 1, 1];
  }
}

// A user's player color as a "#rrggbb" string (socket-friendly).
function feTgUserColorHex(user) {
  try { return foundry.utils.Color.from(user?.color ?? 0xffffff).toString(); }
  catch { return "#ffffff"; }
}

// "#rrggbb" / any color form -> hex int for PIXI line tints.
function feTgColorToInt(color) {
  try { return Number(foundry.utils.Color.from(color)); } catch { return 0xffffff; }
}

function feTgUiScale() {
  return canvas?.dimensions?.uiScale ?? 1;
}

// Mirror native selection-border visibility: controlled, or hovered when enabled.
function feTgShouldGlow(token) {
  if (!token || token.destroyed || !token.mesh || token.mesh.destroyed) return false;
  if (token.document?.isSecret) return false;
  if (!token.visible || !token.renderable) return false;
  if (token.controlled) return true;
  if (feTgSetting(S.TOKEN_GLOW_HOVER) && (token.hover || token.layer?.highlightObjects)) return true;
  return false;
}

function feTgSyncOverlay(token) {
  const layer = feTgGetLayer();
  if (!layer) return;
  const mesh = token.mesh;
  let entry = FE_TG_OVERLAYS.get(token.id);
  if (!entry) {
    const sprite = new PIXI.Sprite(mesh.texture);
    sprite.eventMode = "none";
    const filter = new FeTokenGlowFilter();
    sprite.filters = [filter];
    layer.addChild(sprite);
    entry = { sprite, filter };
    FE_TG_OVERLAYS.set(token.id, entry);
  } else if (entry.sprite.parent !== layer) {
    // Layer was rebuilt (canvas redraw) — re-home the sprite.
    layer.addChild(entry.sprite);
  }

  const { sprite, filter } = entry;

  // Mirror the mesh transform so the overlay overlaps it exactly.
  // Position uses token.center (document-derived, always current) instead of
  // mesh.position, which can be stale during Foundry v14's deferred render-flag
  // flush — the refreshToken hook fires before the mesh's own _refresh pass
  // writes the new position into the PIXI property.
  sprite.texture = mesh.texture;
  sprite.anchor.set(0.5, 0.5);
  sprite.position.set(token.center.x, token.center.y);
  sprite.rotation = mesh.rotation;
  sprite.scale.set(mesh.scale.x, mesh.scale.y);
  sprite.pivot.set(0, 0);
  sprite.skew.set(0, 0);
  sprite.alpha = 1;
  sprite.visible = true;

  const strength = Number(feTgSetting(S.TOKEN_GLOW_STRENGTH)) || 3;
  filter._baseStrength = strength;
  // Radial gradient: inner (near body) = this client's player color,
  // fading outward to the native selection hue (token border color).
  filter.uniforms.glowColorInner = [...feTgUserColorRGB(game.user), 1.0];
  filter.uniforms.glowColorOuter = [...feTgBorderColorRGB(token), 1.0];

  // Replace the native grid-square outline with the silhouette glow (its hue is
  // already carried by glowColor). Foundry re-computes border.visible in
  // _refreshState on every refresh, so this self-heals when the token stops
  // glowing — no explicit restore needed.
  if (token.border) token.border.visible = false;
}

function feTgRemoveOverlay(tokenId) {
  const entry = FE_TG_OVERLAYS.get(tokenId);
  if (!entry) return;
  FE_TG_OVERLAYS.delete(tokenId);
  try { entry.sprite.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* no-op */ }
}

function feTgRefresh(token) {
  if (!token) return;
  if (!feTgEnabled() || !feTgShouldGlow(token)) {
    feTgRemoveOverlay(token.id);
    return;
  }
  feTgSyncOverlay(token);
}

// Reconcile every live overlay against current token state. Movement is already
// tracked by the per-token `refreshToken` hook; the ONE gap it misses is a vision/fog
// change (`sightRefresh`) that turns a glowing token invisible without firing a
// per-token refresh — leaving the glow sprite stranded at the token's last-seen spot
// (the "glow left behind" bug another client sees). So this is called only from the
// `sightRefresh` hook, never per animation frame. The map holds only currently-glowing
// tokens (usually 1–2), so the loop is effectively free; feTgRefresh() both removes
// (when !shouldGlow / token gone) and re-syncs.
function feTgReconcileOverlays() {
  for (const id of [...FE_TG_OVERLAYS.keys()]) {
    const token = canvas?.tokens?.get(id);
    if (!token || token.destroyed) { feTgRemoveOverlay(id); continue; }
    feTgRefresh(token);
  }
}

function feTgRebuildAll() {
  for (const id of [...FE_TG_OVERLAYS.keys()]) feTgRemoveOverlay(id);
  if (!feTgEnabled()) {
    for (const token of canvas?.tokens?.placeables ?? []) feTgClearTargetGlow(token);
    feTgUpdateLocalSightlines();
    return;
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    feTgRefresh(token);
    feTgRefreshTargetGlow(token);
  }
  feTgUpdateLocalSightlines();
}

/* -------------------------------------------- */
/*  Target reticule glow                        */
/* -------------------------------------------- */

function feTgClearTargetGlow(token) {
  const arrows = token?.targetArrows;
  if (arrows && arrows.filters) arrows.filters = null;
}

// Apply the additive marker glow to the native target-arrow reticule (the corner
// arrows Foundry draws on a token THIS user is targeting), in the arrows' own hue.
// Also thin the native black outline from 2*uiScale down to a slim 1px.
function feTgRefreshTargetGlow(token) {
  if (!token || token.destroyed) return;
  const arrows = token.targetArrows;
  if (!arrows) return; // created lazily by core on first target refresh
  const want = feTgEnabled()
    && feTgSetting(S.TOKEN_GLOW_TARGET)
    && !token.document?.isSecret
    && token.targeted?.has?.(game.user);
  if (!want) { feTgClearTargetGlow(token); return; }

  // Redraw the arrows ourselves with a slim 1px black outline (core draws
  // 2*uiScale). Core's _refreshTarget runs before this hook, so ours is final.
  try { token._drawTargetArrows({ border: { width: 1 } }); } catch { /* no-op */ }

  let filter = token._feTgArrowFilter;
  if (!filter || filter.destroyed) {
    filter = new FeMarkerGlowFilter();
    token._feTgArrowFilter = filter;
  }
  filter.uniforms.glowColor = [...feTgBorderColorRGB(token), 1.0];
  if (arrows.filters?.length !== 1 || arrows.filters[0] !== filter) {
    arrows.filters = [filter];
  }
}

/* -------------------------------------------- */
/*  Sightlines (controlled token -> targets)    */
/* -------------------------------------------- */

// Shared module socket — sightlines are broadcast so EVERY user sees every other
// user's controlled->target lines, each drawn in the owning user's player color.
const FE_TG_SOCKET_CHANNEL = `module.${MODULE_ID}`;
const FE_TG_SOCKET_STATE = "fe-token-sightline";
const FE_TG_SOCKET_REQUEST = "fe-token-sightline-request";

// userId -> { sceneId, color (hex string), pairs:[{ o:originTokenId, t:targetTokenId, self:bool }] }
// Includes our OWN id (kept in sync locally so the draw loop is uniform).
const FE_TG_REMOTE_SIGHTLINES = new Map();

// Build this client's own controlled->target pairs (token ids only; centers are
// resolved per-client at draw time). No vision/LOS guard is needed: a token you can't
// see can't be targeted (T) in the first place, so a line only ever exists for a
// legitimately designated target. Per-VIEWER gating (both endpoints must be visible to
// the viewer, incl. hidden/out-of-sight) and lighting/fog dimming are handled at render
// time (feTgRedrawSightlines + the beam living in canvas.primary, under lighting + fog).
function feTgComputeLocalPairs() {
  const origins = canvas?.tokens?.controlled ?? [];
  const targets = [...(game.user?.targets ?? [])];
  if (!origins.length || !targets.length) return [];
  const pairs = [];
  for (const o of origins) {
    if (!o?.id) continue;
    for (const t of targets) {
      if (!t?.id || t.destroyed) continue;
      pairs.push({ o: o.id, t: t.id, self: t === o });
    }
  }
  return pairs;
}

// Recompute our own sightline state, store it locally, and broadcast it. Safe to call
// on control/target changes, token movement, and vision (sightRefresh) updates: the
// emit is deduped against the last-sent signature, so movement/vision recomputes that
// don't change the visible pair set don't spam the socket. `force` always re-emits
// (used when replying to a peer's state request).
let feTgLastSightSig = "";
function feTgUpdateLocalSightlines({ force = false } = {}) {
  const enabled = feTgEnabled() && feTgSetting(S.TOKEN_GLOW_SIGHTLINE);
  const sceneId = canvas?.scene?.id ?? null;
  const pairs = enabled ? feTgComputeLocalPairs() : [];
  const color = feTgUserColorHex(game.user);
  if (pairs.length) FE_TG_REMOTE_SIGHTLINES.set(game.user.id, { sceneId, color, pairs });
  else FE_TG_REMOTE_SIGHTLINES.delete(game.user.id);
  const sig = `${sceneId}|${color}|${pairs.map((p) => `${p.o}>${p.t}${p.self ? "s" : ""}`).join(",")}`;
  if (force || sig !== feTgLastSightSig) {
    feTgLastSightSig = sig;
    try {
      game.socket?.emit(FE_TG_SOCKET_CHANNEL, {
        type: FE_TG_SOCKET_STATE, userId: game.user.id, sceneId, color, pairs,
      });
    } catch { /* no-op */ }
  }
  feTgScheduleSightlines();
}

function feTgOnSightlineSocket(data) {
  if (!data || typeof data !== "object") return;
  if (data.type === FE_TG_SOCKET_REQUEST) {
    if (data.userId === game.user.id) return;
    feTgUpdateLocalSightlines({ force: true }); // reply with our current state
    return;
  }
  if (data.type !== FE_TG_SOCKET_STATE) return;
  if (data.userId === game.user.id) return; // ignore our own echo
  if (Array.isArray(data.pairs) && data.pairs.length) {
    FE_TG_REMOTE_SIGHTLINES.set(data.userId, {
      sceneId: data.sceneId ?? null, color: data.color, pairs: data.pairs,
    });
  } else {
    FE_TG_REMOTE_SIGHTLINES.delete(data.userId);
  }
  feTgScheduleSightlines();
}

// Resolve the module's active custom UI font to a concrete font-family stack for the
// canvas label. CSS vars can't be read by PIXI directly, so a hidden probe element
// lets the browser fully substitute `--fe-ui-font-family` (which the user-font-mode
// remap already redirects to the user/custom font). Cached; invalidated on font sync.
let FE_TG_FONT_CACHE = null;
function feTgResolveFontFamily() {
  if (FE_TG_FONT_CACHE) return FE_TG_FONT_CACHE;
  let ff = "";
  try {
    const probe = document.createElement("span");
    probe.style.fontFamily = "var(--fe-ui-font-family, var(--fe-font-primary))";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);
    ff = getComputedStyle(probe).fontFamily || "";
    probe.remove();
  } catch { ff = ""; }
  FE_TG_FONT_CACHE = ff.trim() || CONFIG.canvasTextStyle?.fontFamily || "Signika";
  return FE_TG_FONT_CACHE;
}

// Distance readout for a beam, in the scene's grid units. Returns null when the
// scene declares no grid distance (gridless / distance unset) -> no text shown.
function feTgMeasureDistanceText(ox, oy, tx, ty) {
  const grid = canvas?.scene?.grid;
  if (!grid?.distance) return null;
  let dist = null;
  try {
    const r = canvas.grid.measurePath([{ x: ox, y: oy }, { x: tx, y: ty }]);
    dist = typeof r?.distance === "number" ? r.distance : (typeof r === "number" ? r : null);
  } catch { dist = null; }
  if (dist == null || !isFinite(dist)) return null;
  const val = Math.round(dist * 100) / 100;
  const units = grid.units || "";
  return units ? `${val} ${units}` : String(val);
}

function feTgMakeDistanceLabel(ox, oy, token, gs) {
  const tx = token.center.x, ty = token.center.y;
  const text = feTgMeasureDistanceText(ox, oy, tx, ty);
  if (!text) return null;
  const PT = foundry.canvas?.containers?.PreciseText ?? globalThis.PreciseText ?? PIXI.Text;
  const style = new PIXI.TextStyle({
    fontFamily: feTgResolveFontFamily(),
    fontSize: Math.round(Math.max(14, gs * 0.20)),
    fill: "#ffffff",
    stroke: "#000000",
    strokeThickness: 3,
    align: "left",
  });
  const lbl = new PT(text, style);
  // Sit just beside the target token's top-right corner.
  lbl.anchor.set(0, 0.5);
  const tw = token.w || gs;
  const th = token.h || gs;
  const margin = Math.max(4, gs * 0.06);
  lbl.position.set(tx + tw / 2 + margin, ty - th / 2);
  lbl.eventMode = "none";
  return lbl;
}

function feTgClearLabels(container) {
  if (!container) return;
  for (const c of [...container.children]) {
    try { c.destroy({ children: true, texture: true, baseTexture: true }); } catch { /* no-op */ }
  }
  container.removeChildren();
}

function feTgGetSightLayer() {
  const tokens = canvas?.tokens;
  const primary = canvas?.primary;
  if (!tokens || !primary) return null;
  // The beam lives in canvas.primary (NOT the interface group), so the scene's
  // lighting/ambience and the fog-of-war overlay dim it exactly like a tile/token
  // mesh — bright in current sight, faded under fog, dark in shadow/unexplored.
  let layer = primary.feSightLayer;
  if (!layer || layer.destroyed) {
    layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    layer.sortableChildren = false;
    // canvas.primary sorts children by elevation -> sortLayer -> sort/zIndex. Place
    // the beam between drawings (600) and tokens (700) so all token meshes draw over
    // it (the aiming line reads as lying on the ground beneath the figures).
    layer.elevation = 0;
    layer.sort = 0;
    layer.zIndex = 0;
    layer.sortLayer = (primary.constructor?.SORT_LAYERS?.DRAWINGS ?? 600) + 50; // 650, below TOKENS
    // Isolate the beam into its own framebuffer so the ERASE-blended target
    // silhouettes (drawn last) cut holes ONLY in this beam.
    const iso = new PIXI.AlphaFilter(1);
    iso.padding = 16;
    layer.filters = [iso];
    const glow = new PIXI.Graphics();   // wide, blurred -> soft beam glow
    glow.filters = [new PIXI.BlurFilter(6, 4)];
    const core = new PIXI.Graphics();   // thin, crisp beam on top
    // Sprites of the TARGET token images, ERASE-blended over the beam, so the
    // line/point tuck behind the target art (targets only). Drawn last.
    const occlude = new PIXI.Container();
    occlude.eventMode = "none";
    layer.addChild(glow, core, occlude);
    layer._glow = glow;
    layer._core = core;
    layer._occlude = occlude;
    primary.addChild(layer);
    primary.feSightLayer = layer;
  }
  // Distance labels live in the INTERFACE group (canvas.tokens), above the fog, so the
  // readout stays legible; and NOT inside the AlphaFilter-isolated beam layer (the
  // ERASE occluders would otherwise punch holes in the text).
  let labels = tokens.feSightLabels;
  if (!labels || labels.destroyed) {
    labels = new PIXI.Container();
    labels.eventMode = "none";
    labels.interactiveChildren = false;
    labels.sortableChildren = false;
    labels.zIndex = 100; // above token sprites so the readout is always legible
    tokens.addChild(labels);
    tokens.feSightLabels = labels;
  }
  layer._labels = labels;
  return layer;
}

let feTgSightScheduled = false;
function feTgScheduleSightlines() {
  if (feTgSightScheduled) return;
  feTgSightScheduled = true;
  requestAnimationFrame(() => {
    feTgSightScheduled = false;
    try { feTgRedrawSightlines(); } catch { /* no-op */ }
  });
}

// Erase a target token's image silhouette out of the beam framebuffer, so the
// line/point appear to pass BEHIND that target's art. Mirrors the token mesh's
// full transform (same approach as feTgSyncOverlay); ERASE subtracts source
// alpha, so anti-aliased art edges give a clean, shape-accurate cut (no square).
function feTgClearOcclude(occlude) {
  for (const c of [...occlude.children]) {
    try { c.destroy({ children: true, texture: false, baseTexture: false }); } catch { /* no-op */ }
  }
  occlude.removeChildren();
}

function feTgAddOccluder(occlude, token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed || !mesh.texture) return;
  const spr = new PIXI.Sprite(mesh.texture);
  spr.eventMode = "none";
  spr.blendMode = PIXI.BLEND_MODES.ERASE;
  // Use token.center for position (document-derived, always current) — same
  // staleness guard as feTgSyncOverlay (see comment there).
  spr.anchor.set(0.5, 0.5);
  spr.position.set(token.center.x, token.center.y);
  spr.rotation = mesh.rotation;
  spr.scale.set(mesh.scale.x, mesh.scale.y);
  spr.pivot.set(0, 0);
  spr.skew.set(0, 0);
  occlude.addChild(spr);
}

// Draw an aiming line from each controlled token to each of the user's targets,
// with a faint blurred glow underneath. Coordinates are scene pixels (token.center),
// which align because canvas.tokens shares the stage world transform.
function feTgRedrawSightlines() {
  const layer = feTgGetSightLayer();
  if (!layer) return;
  const glow = layer._glow;
  const core = layer._core;
  const occlude = layer._occlude;
  const labels = layer._labels;
  glow.clear();
  core.clear();
  feTgClearOcclude(occlude);
  feTgClearLabels(labels);

  if (!feTgEnabled() || !feTgSetting(S.TOKEN_GLOW_SIGHTLINE)) {
    layer.visible = false; if (labels) labels.visible = false; return;
  }

  const sceneId = canvas?.scene?.id ?? null;
  const s = feTgUiScale();
  const gs = canvas?.dimensions?.size ?? 100;
  const hit = new Set(); // tokens to occlude (drawn targets + participating origins)
  let drewAny = false;

  // One pass per user (ours + every broadcast peer). The CORE stroke uses the owner's
  // player color (so you can tell whose line is whose); the soft GLOW keeps the
  // target's native selection hue. A line is shown to THIS viewer only when they can
  // currently see BOTH endpoints (token.visible folds in current sight, lighting and
  // the hidden flag — false for a hidden/out-of-sight token to a non-GM, true for the
  // GM). Lighting/fog then dims the visible line where it crosses fog (canvas.primary).
  for (const [, entry] of FE_TG_REMOTE_SIGHTLINES) {
    if (!entry?.pairs?.length || entry.sceneId !== sceneId) continue;
    const coreCol = feTgColorToInt(entry.color);
    for (const pair of entry.pairs) {
      const o = canvas.tokens?.get(pair.o);
      if (!o || o.destroyed || !o.center || !o.visible) continue;
      const t = canvas.tokens?.get(pair.t);
      if (!t || t.destroyed || !t.center || !t.visible) continue;
      const ox = o.center.x;
      const oy = o.center.y;
      const glowCol = feTgBorderColorInt(t);
      if (pair.self) {
        // Self-target: a thin grid-sized ring framing the token, tucked behind it.
        const r = Math.max(o.w || gs, o.h || gs) / 2;
        glow.lineStyle(6 * s, glowCol, 0.62).drawCircle(ox, oy, r);
        core.lineStyle(2 * s, coreCol, 0.95).drawCircle(ox, oy, r);
        hit.add(o);
        drewAny = true;
        continue;
      }
      const tx = t.center.x;
      const ty = t.center.y;
      glow.lineStyle(9 * s, glowCol, 0.68).moveTo(ox, oy).lineTo(tx, ty);
      core.lineStyle(2.5 * s, coreCol, 0.95).moveTo(ox, oy).lineTo(tx, ty);
      core.beginFill(coreCol, 0.95).drawCircle(tx, ty, 4 * s).endFill();
      hit.add(t);
      hit.add(o);
      drewAny = true;
      // Distance readout beside the target token's top-right corner (hidden when the
      // scene declares no grid distance).
      const lbl = feTgMakeDistanceLabel(ox, oy, t, gs);
      if (lbl && labels) labels.addChild(lbl);
    }
  }

  layer.visible = drewAny;
  if (labels) labels.visible = drewAny;
  for (const t of hit) feTgAddOccluder(occlude, t);
}

/* -------------------------------------------- */
/*  Hooks                                        */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.TOKEN_GLOW_ENABLED, {
    name: "토큰 선택 글로우 사용",
    hint: "토큰을 선택/호버하면 격자 사각형 대신 이미지 실루엣을 따라 글로우를 표시합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_GLOW_ENABLED],
    onChange: () => feTgRebuildAll(),
  });
  game.settings.register(MODULE_ID, S.TOKEN_GLOW_HOVER, {
    name: "호버 시에도 글로우",
    hint: "마우스를 올린 토큰에도 글로우를 표시합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_GLOW_HOVER],
    onChange: () => feTgRebuildAll(),
  });
  game.settings.register(MODULE_ID, S.TOKEN_GLOW_STRENGTH, {
    name: "글로우 세기",
    hint: "글로우의 밝기/퍼짐 강도입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.TOKEN_GLOW_STRENGTH],
    range: { min: 1, max: 8, step: 1 },
    onChange: () => feTgRebuildAll(),
  });
  game.settings.register(MODULE_ID, S.TOKEN_GLOW_TARGET, {
    name: "타겟 표시 글로우",
    hint: "타겟(T)으로 지정한 토큰의 모서리 화살표 표시에도 글로우를 적용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_GLOW_TARGET],
    onChange: () => feTgRebuildAll(),
  });
  game.settings.register(MODULE_ID, S.TOKEN_GLOW_SIGHTLINE, {
    name: "타겟 조준선",
    hint: "선택한 토큰에서 타겟으로 이어지는 조준선을 그립니다. 다른 플레이어에게도 표시되며(소유자 색상), 선 끝에 거리가 표시됩니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_GLOW_SIGHTLINE],
    onChange: () => feTgUpdateLocalSightlines(),
  });
});

Hooks.once("ready", () => {
  try { game.socket?.on(FE_TG_SOCKET_CHANNEL, feTgOnSightlineSocket); } catch { /* no-op */ }
});

// Font/style sync (incl. custom/user-font changes) — drop the cached family so the
// next label redraw picks up the new font.
Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  FE_TG_FONT_CACHE = null;
  feTgScheduleSightlines();
});

Hooks.on("canvasReady", () => {
  // The tokens layer (and our glow/sight containers) is torn down on every scene draw.
  for (const id of [...FE_TG_OVERLAYS.keys()]) FE_TG_OVERLAYS.delete(id);
  if (canvas?.tokens) {
    canvas.tokens.feGlowLayer = null;
    canvas.tokens.feSightLabels = null;
  }
  if (canvas?.primary) canvas.primary.feSightLayer = null;
  FE_TG_FONT_CACHE = null; // re-resolve the custom font for the new scene's labels
  feTgLastSightSig = "";   // force a fresh broadcast for the new scene
  // Drop stale peer state from the previous scene, then re-announce ours and ask
  // peers to re-announce theirs (covers late join / scene change).
  FE_TG_REMOTE_SIGHTLINES.clear();
  feTgRebuildAll();
  try {
    game.socket?.emit(FE_TG_SOCKET_CHANNEL, { type: FE_TG_SOCKET_REQUEST, userId: game.user.id });
  } catch { /* no-op */ }
});

Hooks.on("refreshToken", (token) => {
  feTgRefresh(token);
  feTgRefreshTargetGlow(token);
  // Geometry/visibility only — the pair set depends on control/target, not movement;
  // peers redraw from their own canvas and endpoint visibility re-evaluates at draw time.
  feTgScheduleSightlines();
});
// The viewer's own vision recompute (fog reveal, lighting change, their token moving)
// changes which endpoints are visible -> re-evaluate the both-endpoints-visible gate,
// and prune/re-sync any selection glow whose token just went (in)visible — the one
// staleness gap `refreshToken` doesn't cover (cheap: only currently-glowing tokens).
Hooks.on("sightRefresh", () => {
  feTgReconcileOverlays();
  feTgScheduleSightlines();
});
Hooks.on("controlToken", (token) => {
  feTgRefresh(token);
  feTgUpdateLocalSightlines();
});
Hooks.on("hoverToken", (token) => feTgRefresh(token));
Hooks.on("targetToken", (user, token) => {
  feTgRefreshTargetGlow(token);
  if (user?.id === game.user.id) feTgUpdateLocalSightlines();
  else feTgScheduleSightlines();
});
Hooks.on("destroyToken", (token) => {
  feTgRemoveOverlay(token?.id);
  feTgScheduleSightlines();
});
Hooks.on("deleteToken", (doc) => {
  feTgRemoveOverlay(doc?.id);
  feTgUpdateLocalSightlines(); // a deleted token may have been our origin/target
});
Hooks.on("userConnected", (user, connected) => {
  if (connected) return;
  if (FE_TG_REMOTE_SIGHTLINES.delete(user?.id)) feTgScheduleSightlines();
});
