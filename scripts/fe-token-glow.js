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
    // stays transparent (the real mesh below shows through unaltered).
    float bodyMask = 1.0 - smoothstep(0.35, 1.0, curColor.a);
    float a = clamp(alphaRatio * outerStrength * bodyMask, 0.0, 1.0);
    gl_FragColor = vec4(glowColor.rgb * a, a);
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

  // Copy the mesh's full local transform so the overlay overlaps it exactly.
  // canvas.tokens and canvas.primary share the same stage world transform.
  sprite.texture = mesh.texture;
  sprite.anchor.set(mesh.anchor.x, mesh.anchor.y);
  sprite.position.set(mesh.position.x, mesh.position.y);
  sprite.rotation = mesh.rotation;
  sprite.scale.set(mesh.scale.x, mesh.scale.y);
  sprite.pivot.set(mesh.pivot.x, mesh.pivot.y);
  sprite.skew.set(mesh.skew.x, mesh.skew.y);
  sprite.alpha = 1;
  sprite.visible = true;

  const strength = Number(feTgSetting(S.TOKEN_GLOW_STRENGTH)) || 3;
  filter._baseStrength = strength;
  filter.uniforms.glowColor = [...feTgBorderColorRGB(token), 1.0];

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

function feTgRebuildAll() {
  for (const id of [...FE_TG_OVERLAYS.keys()]) feTgRemoveOverlay(id);
  if (!feTgEnabled()) {
    for (const token of canvas?.tokens?.placeables ?? []) feTgClearTargetGlow(token);
    feTgRedrawSightlines();
    return;
  }
  for (const token of canvas?.tokens?.placeables ?? []) {
    feTgRefresh(token);
    feTgRefreshTargetGlow(token);
  }
  feTgRedrawSightlines();
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

function feTgGetSightLayer() {
  const tokens = canvas?.tokens;
  if (!tokens) return null;
  let layer = tokens.feSightLayer;
  if (!layer || layer.destroyed) {
    layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    layer.sortableChildren = false;
    layer.zIndex = -2; // below the silhouette glow and token sprites
    // Isolate the beam into its own framebuffer so the ERASE-blended target
    // silhouettes (drawn last) cut holes ONLY in this beam — not into the rest
    // of the interface layer below it.
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
    tokens.addChild(layer);
    tokens.feSightLayer = layer;
  }
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
  spr.anchor.set(mesh.anchor.x, mesh.anchor.y);
  spr.position.set(mesh.position.x, mesh.position.y);
  spr.rotation = mesh.rotation;
  spr.scale.set(mesh.scale.x, mesh.scale.y);
  spr.pivot.set(mesh.pivot.x, mesh.pivot.y);
  spr.skew.set(mesh.skew.x, mesh.skew.y);
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
  glow.clear();
  core.clear();
  feTgClearOcclude(occlude);

  if (!feTgEnabled() || !feTgSetting(S.TOKEN_GLOW_SIGHTLINE)) { layer.visible = false; return; }
  const origins = canvas?.tokens?.controlled ?? [];
  const targets = [...(game.user?.targets ?? [])];
  if (!origins.length || !targets.length) { layer.visible = false; return; }
  layer.visible = true;

  const s = feTgUiScale();
  const gs = canvas?.dimensions?.size ?? 100;
  const hit = new Set(); // tokens to occlude (drawn targets + participating origins)
  for (const o of origins) {
    if (!o || o.destroyed || !o.center) continue;
    const ox = o.center.x;
    const oy = o.center.y;
    let drewFromO = false;
    for (const t of targets) {
      if (!t || t.destroyed || !t.center || t.document?.isSecret) continue;
      const col = feTgBorderColorInt(t);
      if (t === o) {
        // Self-target: a thin grid-sized ring framing the token, tucked behind it.
        const r = Math.max(o.w || gs, o.h || gs) / 2;
        glow.lineStyle(6 * s, col, 0.40).drawCircle(ox, oy, r);
        core.lineStyle(2 * s, col, 0.95).drawCircle(ox, oy, r);
        hit.add(o);
        continue;
      }
      const tx = t.center.x;
      const ty = t.center.y;
      glow.lineStyle(9 * s, col, 0.45).moveTo(ox, oy).lineTo(tx, ty);
      core.lineStyle(2.5 * s, col, 0.95).moveTo(ox, oy).lineTo(tx, ty);
      core.beginFill(col, 0.95).drawCircle(tx, ty, 4 * s).endFill();
      hit.add(t);
      drewFromO = true;
    }
    // Tuck the line's start behind the origin token too, so it doesn't ride on
    // top of the token it starts from. Other (non-target, non-origin) tokens
    // stay above the beam — the layer is in the interface group above all images.
    if (drewFromO) hit.add(o);
  }
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
    hint: "선택한 토큰에서 타겟으로 이어지는 조준선(약한 글로우)을 그립니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_GLOW_SIGHTLINE],
    onChange: () => feTgRedrawSightlines(),
  });
});

Hooks.on("canvasReady", () => {
  // The tokens layer (and our glow/sight containers) is torn down on every scene draw.
  for (const id of [...FE_TG_OVERLAYS.keys()]) FE_TG_OVERLAYS.delete(id);
  if (canvas?.tokens) {
    canvas.tokens.feGlowLayer = null;
    canvas.tokens.feSightLayer = null;
  }
  feTgRebuildAll();
});

Hooks.on("refreshToken", (token) => {
  feTgRefresh(token);
  feTgRefreshTargetGlow(token);
  feTgScheduleSightlines();
});
Hooks.on("controlToken", (token) => {
  feTgRefresh(token);
  feTgScheduleSightlines();
});
Hooks.on("hoverToken", (token) => feTgRefresh(token));
Hooks.on("targetToken", (user, token) => {
  feTgRefreshTargetGlow(token);
  feTgScheduleSightlines();
});
Hooks.on("destroyToken", (token) => {
  feTgRemoveOverlay(token?.id);
  feTgScheduleSightlines();
});
Hooks.on("deleteToken", (doc) => {
  feTgRemoveOverlay(doc?.id);
  feTgScheduleSightlines();
});
