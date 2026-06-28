// Female-cupwhi: Token selection glow.
//
// When a token is controlled (selected) or hovered, add a soft additive glow (a halo
// behind the still-visible token art) to the token's own mesh instead of drawing a
// separate copied token sprite. This keeps the effect tied to core's token mesh
// lifecycle, avoiding stale oversized overlays when a token texture or mesh transform
// is mid-refresh.
//
// The selection glow uses this client's player color and hides Foundry's native
// square/circle border while active.
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
const FE_TG_DISTANCE = 22;
const FE_TG_QUALITY = 0.12;

// Additive marker glow: keep the original graphic and add a halo behind it. Applied to
// the token's own mesh (selection/hover glow) and to the native target-arrow reticule.
function feTgFragmentShader() {
  const dist = FE_TG_DISTANCE.toFixed(0);
  // ANGLE_STEP_SIZE / MAX_TOTAL_ALPHA mirror core GlowOverlayFilter's derivation.
  const angleStep = Math.min(1 / (FE_TG_QUALITY * FE_TG_DISTANCE), Math.PI * 2).toFixed(7);
  const tail = `
    // Additive marker glow: a halo behind the original graphic. uSampler is
    // premultiplied, so composite the original "source-over" the glow ring.
    // Hue is a radial gradient: strong (near the silhouette) -> glowColor (inner),
    // fading outward -> glowColorOuter. When both colors are equal it's a flat hue.
    // glowColor.a is an overall alpha multiplier (lets the hover overlay sit at <1).
    float ring = clamp(alphaRatio * outerStrength, 0.0, 1.0);
    vec3  gcol = mix(glowColorOuter.rgb, glowColor.rgb, ring);
    float glowA = ring * (1.0 - curColor.a) * glowColor.a;
    vec3  glowPM = gcol * glowA;
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

// Additive glow halo (kept crisp, halo added) — used on both the token mesh selection
// glow and the native target-arrow reticule.
class FeMarkerGlowFilter extends PIXI.Filter {
  constructor() {
    super(undefined, feTgFragmentShader(), {
      outerStrength: 2.4,
      glowColor: [1.0, 0.27, 0.27, 1.0],
      glowColorOuter: [1.0, 0.27, 0.27, 1.0],
    });
    // Generous padding so the (possibly stacked controlled+hover) halo isn't clipped.
    this.padding = FE_TG_DISTANCE + 12;
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
/*  Outline filter (Alt highlight)              */
/* -------------------------------------------- */

// A LIGHTWEIGHT silhouette outline — a crisp edge line tracing the token image's own
// shape (NOT the soft, multi-sample gradient glow). Used for the Alt "오브젝트 강조"
// highlight, which lights up EVERY visible token at once: the glow shader (16 angles ×
// 22 distance = ~350 samples/px) would be far too heavy across a whole scene, so this
// samples only a few px out (THICK) over 16 angles -> a thin, hard-edged ring at a
// fraction of the cost. Following the image silhouette inherently needs to read texture
// alpha, so this is still a (tiny) shader — there is no non-shader way to outline an
// arbitrary image's shape. Output is the token art unchanged + a flat outline ring
// hugging its edge (premultiplied source-over, mirrors the glow's additive composite).
const FE_TG_OUTLINE_THICK = 3;
function feTgOutlineFragmentShader() {
  const thick = FE_TG_OUTLINE_THICK.toFixed(1);
  return `
  precision highp float;
  varying vec2 vTextureCoord;
  uniform sampler2D uSampler;
  uniform vec4 inputSize;
  uniform vec4 inputClamp;
  uniform vec4 outlineColor;

  const float PI = 3.14159265358979323846264;
  const float THICK = ${thick};
  const float ANGLE_STEP = PI / 8.0; // 16 directions

  float getClip(in vec2 uv) {
    return step(3.5,
      step(inputClamp.x, uv.x) +
      step(inputClamp.y, uv.y) +
      step(uv.x, inputClamp.z) +
      step(uv.y, inputClamp.w));
  }

  void main(void) {
    vec2 px = inputSize.zw;
    vec4 cur = texture2D(uSampler, vTextureCoord);
    float maxA = 0.0;
    for (float angle = 0.0; angle < PI * 2.0; angle += ANGLE_STEP) {
      vec2 dir = vec2(cos(angle), sin(angle)) * px;
      for (float d = 1.0; d <= THICK; d += 1.0) {
        vec2 disp = vTextureCoord + dir * d;
        maxA = max(maxA, texture2D(uSampler, disp).a * getClip(disp));
      }
    }
    // Ring lives OUTSIDE the body (where cur.a is low but a neighbor within THICK is
    // opaque). Inside the body cur.a≈1 -> contribution ≈0, so the art shows untouched.
    float ring  = clamp(maxA, 0.0, 1.0);
    float edgeA = ring * (1.0 - cur.a);
    vec3  edgePM = outlineColor.rgb * edgeA;
    float outA  = cur.a + edgeA * (1.0 - cur.a);
    vec3  outRGB = cur.rgb + edgePM * (1.0 - cur.a);
    gl_FragColor = vec4(outRGB, outA);
  }`;
}

class FeOutlineFilter extends PIXI.Filter {
  constructor() {
    super(undefined, feTgOutlineFragmentShader(), {
      outlineColor: [1.0, 1.0, 1.0, 1.0],
    });
    this.padding = FE_TG_OUTLINE_THICK + 2;
  }
}

/* -------------------------------------------- */
/*  Overlay management                          */
/* -------------------------------------------- */

// token.id (current scene) of every token currently carrying the selection/hover glow.
const FE_TG_GLOWING = new Set();

// Shared lightweight outline filter for ALL Alt-highlighted tokens (see FeOutlineFilter).
let feTgOutlineFilter = null;
function feTgGetOutlineFilter() {
  if (!feTgOutlineFilter || feTgOutlineFilter.destroyed) {
    feTgOutlineFilter = new FeOutlineFilter();
    feTgOutlineFilter._feTgMeshGlow = true;
  }
  feTgOutlineFilter.uniforms.outlineColor = [...feTgUserColorRGB(game.user), 1.0];
  return feTgOutlineFilter;
}

// TWO shared additive glow filters distinguish the three selection states:
//   - controlled (click)        -> the CONTROLLED filter alone: a flat player-color halo
//   - hovered (no control)      -> the HOVER filter alone: a brighter inner->player-color
//                                  gradient at reduced alpha, spread a touch wider
//   - controlled AND hovered    -> BOTH filters stacked (controlled base + hover overlay),
//                                  so the combined look reads distinctly from either alone
// Every glowing token shares the same player color + strength, so one PIXI.Filter per
// state can be attached to every matching mesh — PIXI supports sharing a filter across
// display objects (apply() runs per-object each frame; the pulse keys off the global
// ticker, so all glows stay in sync). The target-arrow reticule keeps its OWN per-token
// instance (its hue is the target's border color, which differs per token).
function feTgGlowStrength() {
  return Number(feTgSetting(S.TOKEN_GLOW_STRENGTH)) || 4;
}

let feTgControlledFilter = null;
function feTgGetControlledFilter() {
  if (!feTgControlledFilter || feTgControlledFilter.destroyed) {
    feTgControlledFilter = new FeMarkerGlowFilter();
    feTgControlledFilter._feTgMeshGlow = true;
  }
  const c = feTgUserColorRGB(game.user);
  feTgControlledFilter._baseStrength = feTgGlowStrength();
  feTgControlledFilter.uniforms.glowColor = [...c, 1.0];      // flat, full alpha
  feTgControlledFilter.uniforms.glowColorOuter = [...c, 1.0]; // inner == outer -> no gradient
  return feTgControlledFilter;
}

let feTgHoverFilter = null;
function feTgGetHoverFilter() {
  if (!feTgHoverFilter || feTgHoverFilter.destroyed) {
    feTgHoverFilter = new FeMarkerGlowFilter();
    feTgHoverFilter._feTgMeshGlow = true;
  }
  const c = feTgUserColorRGB(game.user);
  // Inner brightened toward white (fades out to the player color) -> a gradient highlight
  // that visibly overlays the flat controlled base. A bit stronger so it spreads wider.
  const inner = [
    Math.min(1, c[0] * 0.35 + 0.65),
    Math.min(1, c[1] * 0.35 + 0.65),
    Math.min(1, c[2] * 0.35 + 0.65),
  ];
  feTgHoverFilter._baseStrength = feTgGlowStrength() + 2;
  feTgHoverFilter.uniforms.glowColor = [...inner, 0.85];     // inner color + alpha multiplier
  feTgHoverFilter.uniforms.glowColorOuter = [...c, 0.85];    // outer = player color
  return feTgHoverFilter;
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

// Glow on real selection (controlled) and on the token under the cursor when the hover
// setting is on. The native "오브젝트 강조" / Alt key (`layer.highlightObjects`) lights up
// EVERY visible token: we replace core's square/circle selector with a lightweight
// silhouette OUTLINE (feTgGetOutlineFilter) — crisp, cheap, tracks the token image shape.
function feTgShouldGlow(token) {
  if (!token || token.destroyed || !token.mesh || token.mesh.destroyed) return false;
  if (token.document?.isSecret) return false;
  if (!token.visible || !token.renderable) return false;
  if (token.controlled) return true;
  if (feTgSetting(S.TOKEN_GLOW_HOVER) && token.hover) return true;
  if (token.layer?.highlightObjects) return true;
  return false;
}

function feTgSyncOverlay(token) {
  const mesh = token?.mesh;
  if (!mesh || mesh.destroyed) {
    feTgRemoveOverlay(token.id);
    return;
  }
  // Build this token's glow set from its current state, then re-attach it cleanly
  // (strip any prior glow filters first — handles state changes and mesh swaps).
  // Order matters: the controlled base goes first, the hover overlay stacks on top.
  // Alt highlight (`highlightObjects`) shows only the lightweight outline, and only on
  // tokens not already carrying a glow (controlled/hovered keep their richer glow).
  const wantControlled = token.controlled;
  const wantHover = feTgSetting(S.TOKEN_GLOW_HOVER) && token.hover;
  const wantOutline = !!token.layer?.highlightObjects && !wantControlled && !wantHover;
  const glow = [];
  if (wantControlled) glow.push(feTgGetControlledFilter());
  if (wantHover) glow.push(feTgGetHoverFilter());
  if (wantOutline) glow.push(feTgGetOutlineFilter());
  const filters = (mesh.filters ?? []).filter((f) => !f?._feTgMeshGlow);
  mesh.filters = glow.length ? [...filters, ...glow] : (filters.length ? filters : null);
  if (glow.length) FE_TG_GLOWING.add(token.id);
  else FE_TG_GLOWING.delete(token.id);
  if (token.border) token.border.visible = false;
}

function feTgRestoreNativeBorder(tokenId) {
  const token = canvas?.tokens?.get?.(tokenId);
  const border = token?.border;
  if (!token || !border || border.destroyed) return;
  const isSecret = token.document?.isSecret;
  const isHover = token.hover || token.layer?.highlightObjects;
  border.visible = !isSecret && (token.controlled || isHover);
}

function feTgRemoveOverlay(tokenId) {
  FE_TG_GLOWING.delete(tokenId);
  // Strip the shared glow filter off this token's current mesh — but never destroy the
  // shared instance (other glowing tokens still reference it). A swapped-out old mesh is
  // destroyed/GC'd anyway, so resolving the live token's mesh is sufficient.
  const mesh = canvas?.tokens?.get?.(tokenId)?.mesh;
  try {
    if (mesh && !mesh.destroyed && mesh.filters?.length) {
      const filters = mesh.filters.filter((f) => !f?._feTgMeshGlow);
      mesh.filters = filters.length ? filters : null;
    }
  } catch { /* no-op */ }
  finally { feTgRestoreNativeBorder(tokenId); }
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
  for (const id of [...FE_TG_GLOWING]) {
    const token = canvas?.tokens?.get(id);
    if (!token || token.destroyed) { feTgRemoveOverlay(id); continue; }
    feTgRefresh(token);
  }
}

function feTgRebuildAll() {
  for (const id of [...FE_TG_GLOWING]) feTgRemoveOverlay(id);
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
  const arrowRGB = feTgBorderColorRGB(token);
  filter.uniforms.glowColor = [...arrowRGB, 1.0];
  filter.uniforms.glowColorOuter = [...arrowRGB, 1.0]; // flat hue (no gradient on arrows)
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
// full transform; ERASE subtracts source
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
  // Same unloaded-texture guard as feTgSyncOverlay — a 1px placeholder would give a
  // giant ERASE silhouette punching a hole far bigger than the token.
  const tex = mesh.texture;
  if (!tex.valid || !tex.baseTexture?.valid || (tex.orig?.width ?? tex.width ?? 0) <= 1) return;
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
    range: { min: 1, max: 10, step: 1 },
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
  FE_TG_GLOWING.clear();
  // Drop the shared filters so the next glow rebuilds them fresh against the redrawn scene.
  try { feTgControlledFilter?.destroy?.(); } catch { /* no-op */ }
  try { feTgHoverFilter?.destroy?.(); } catch { /* no-op */ }
  try { feTgOutlineFilter?.destroy?.(); } catch { /* no-op */ }
  feTgControlledFilter = null;
  feTgHoverFilter = null;
  feTgOutlineFilter = null;
  if (canvas?.tokens) {
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
