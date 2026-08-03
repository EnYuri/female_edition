// female_edition: Token Visual Preview — enhances the Prototype Token Config's
// appearance tab with a live grid preview (token on a grid with anchor crosshair)
// and pixel readout for anchor coordinates.
//
// Pure DOM injection via renderPrototypeTokenConfig hook — no core override.
// Self-contained entry-point script (registered in module.json).

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

const _FE_TP_PREVIEW_DEFAULT = 300;
const _FE_TP_PREVIEW_MIN = 150;
const _FE_TP_ZOOM_MIN = 0.25;
const _FE_TP_ZOOM_MAX = 4;
const _FE_TP_SHEET_BASE_WIDTH = 544;
const _FE_TP_SHEET_MIN_HEIGHT = 720;
const _FE_TP_STORAGE_KEY = "fe-tp-preview-size";
const _FE_TP_IMG_CACHE = new Map();
const _FE_TP_IMG_CACHE_MAX = 512;

// Core's texture fit modes (CONST.TEXTURE_DATA_FIT_MODES) mapped to `background-size`.
// CSS `object-fit` was used before and silently broke on `width`/`height`: neither is a
// valid object-fit keyword, so the whole declaration was dropped and the browser fell
// back to `fill` — two of the five modes previewed as the wrong thing. `background-size`
// expresses all five exactly, and the same value doubles as the tint layer's `mask-size`.
const _FE_TP_FIT_TO_BACKGROUND_SIZE = Object.freeze({
  fill: "100% 100%",
  contain: "contain",
  cover: "cover",
  width: "100% auto",
  height: "auto 100%",
});

// TokenRing.#defaultRingThickness + #defaultSubjectThickness (client/canvas/placeables/
// tokens/ring.mjs) — the fallback when the ring spritesheet data is not loaded yet.
const _FE_TP_DEFAULT_SUBJECT_SCALE_ADJUSTMENT = 1 / (0.1269848 + 0.6666666);
// Ring band thickness in normalized ring-diameter units, drawn into a 100×100 viewBox.
const _FE_TP_RING_THICKNESS = 0.1269848;

// Range of the injected anchor sliders. `texture.anchorX/Y` is an unbounded NumberField in
// core (`common/data/data.mjs`), so this is purely our own UI range — wide enough to park the
// anchor outside the art, tight enough that the slider stays precise where it matters.
const _FE_TP_ANCHOR_MIN = -1.5;
const _FE_TP_ANCHOR_MAX = 2.5;

// Widened replacements for core's appearance-tab range pickers. Core hard-codes
// `scale` as min 0.2 / max 3 (templates/scene/token/appearance.hbs) and passes
// `max=3` for `ring.subject.scale`; both underlying document fields are looser than
// the UI — `texture.scaleX/Y` is an unbounded NumberField (common/data/data.mjs) and
// `ring.subject.scale` only carries a schema `min: 0.5` (common/documents/token.mjs).
// That schema minimum is a real validation floor, so the ring subject scale widens at
// the top end only; going below 0.5 there would throw on submit.
const _FE_TP_RANGE_OVERRIDES = [
  { name: "scale", min: 0.1, max: 6, step: 0.05 },
  { name: "ring.subject.scale", min: 0.5, max: 6, step: 0.02 },
];

// Appearance-tab fields whose change alters what the canvas paints.
const _FE_TP_WATCHED_FIELDS = new Set([
  "texture.src", "texture.anchorX", "texture.anchorY", "texture.fit", "texture.tint",
  "scale", "width", "height", "mirrorX", "mirrorY", "alpha",
  "ring.enabled", "ring.subject.texture", "ring.subject.scale",
  "ring.colors.ring", "ring.colors.background",
]);

function feTpGetCachedImageSize(src) {
  if (!_FE_TP_IMG_CACHE.has(src)) return null;
  const value = _FE_TP_IMG_CACHE.get(src);
  _FE_TP_IMG_CACHE.delete(src);
  _FE_TP_IMG_CACHE.set(src, value);
  return value;
}

function feTpSetCachedImageSize(src, value) {
  _FE_TP_IMG_CACHE.delete(src);
  _FE_TP_IMG_CACHE.set(src, value);
  while (_FE_TP_IMG_CACHE.size > _FE_TP_IMG_CACHE_MAX) {
    _FE_TP_IMG_CACHE.delete(_FE_TP_IMG_CACHE.keys().next().value);
  }
}

function feTokenConfigTwoColumnEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.TOKEN_CONFIG_TWO_COLUMN); }
  catch { return !!FE_DEFAULTS[S.TOKEN_CONFIG_TWO_COLUMN]; }
}
function feTokenPreviewEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.CORE_UI_TOKEN_PREVIEW); }
  catch { return !!FE_DEFAULTS[S.CORE_UI_TOKEN_PREVIEW]; }
}

function _feTPGetPreviewSize() {
  const stored = localStorage.getItem(_FE_TP_STORAGE_KEY);
  if (stored) { const n = parseInt(stored, 10); if (n >= _FE_TP_PREVIEW_MIN) return n; }
  return _FE_TP_PREVIEW_DEFAULT;
}

function _feTPParseOr(val, fallback) {
  const n = parseFloat(val);
  return Number.isFinite(n) ? n : fallback;
}

/** Localize with an inline fallback, so a missing key never renders as the key itself. */
function _feTPL(key, fallback) {
  const s = game.i18n?.localize?.(key);
  return s && s !== key ? s : fallback;
}

/**
 * The live value of a form control, which for a `range-picker` is NOT its own `value`.
 * `#onDragSlider` (client/applications/elements/range-picker.mjs) only mirrors the slider
 * into the inner number input; `this.value` is assigned in `#onChangeInput`, i.e. on
 * pointer release. Reading the element would therefore return the pre-drag value for the
 * entire duration of a drag. The inner number input is the only live source.
 */
function _feTPLiveValue(el) {
  if (!el) return undefined;
  if (el.tagName === "RANGE-PICKER") {
    const n = el.querySelector('input[type="number"]');
    if (n && n.value !== "") return n.value;
  }
  return el.value;
}

function feLoadImage(src) {
  if (!src) return Promise.resolve(null);
  const cached = feTpGetCachedImageSize(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const value = { w: img.naturalWidth, h: img.naturalHeight };
      feTpSetCachedImageSize(src, value);
      resolve(value);
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function feReadAppearanceValues(form) {
  if (!form) return null;
  return {
    src: form.elements["texture.src"]?.value ?? "",
    anchorX: _feTPParseOr(form.elements["texture.anchorX"]?.value, 0.5),
    anchorY: _feTPParseOr(form.elements["texture.anchorY"]?.value, 0.5),
    scale: parseFloat(_feTPLiveValue(form.elements["scale"])) || 1,
    mirrorX: !!form.elements["mirrorX"]?.checked,
    mirrorY: !!form.elements["mirrorY"]?.checked,
    tint: form.elements["texture.tint"]?.value || "",
    fit: form.elements["texture.fit"]?.value || "contain",
    width: parseFloat(form.elements["width"]?.value) || 1,
    height: parseFloat(form.elements["height"]?.value) || 1,
    alpha: _feTPParseOr(form.elements["alpha"]?.value, 1),
    // Dynamic token ring. `ring.colors.*` and `ring.subject.scale` are form-associated
    // custom elements (color-picker / range-picker); `_applyInputAttributes` does NOT
    // copy `name` onto their inner inputs, so `form.elements[name]` resolves to the
    // custom element itself and `.value` is safe (no RadioNodeList).
    ringEnabled: !!form.elements["ring.enabled"]?.checked,
    ringSubjectSrc: form.elements["ring.subject.texture"]?.value ?? "",
    ringSubjectScale: _feTPParseOr(_feTPLiveValue(form.elements["ring.subject.scale"]), 1),
    ringColor: form.elements["ring.colors.ring"]?.value || "",
    ringBgColor: form.elements["ring.colors.background"]?.value || "",
  };
}

/** A CSS `url()` token for an image path, safe to place inside an HTML attribute. */
function _feTPCssUrl(src) {
  if (!src) return "none";
  // MUST resolve to an absolute URL. This `url()` is written into a custom property on an
  // inline style, but it is *consumed* by `background-image`/`mask-image` in
  // `styles/fe-token-preview.css` — and a relative url() in a custom property is resolved
  // against the stylesheet that consumes the variable, not against the document. A Foundry
  // data path such as `NPCimg/YC/hahami.png` therefore resolved to
  // `modules/female_edition/styles/NPCimg/YC/hahami.png` and the preview painted nothing at
  // all. Live-verified on v14.365. `document.baseURI` also keeps any route prefix intact.
  let href = String(src);
  try { href = new URL(href, document.baseURI).href; } catch { /* leave as-is */ }
  // CSS-escape first, HTML-escape later at the attribute boundary: a `"` must reach the
  // CSS parser as `\"`, and esc() would otherwise turn a bare quote into one that closes
  // the url() string once the HTML parser decodes the entity.
  return `url("${href.replace(/["\\]/g, "\\$&")}")`;
}

/** True when the world renders dynamic rings in grid-fit mode. */
function _feTPIsGridFitMode() {
  try { return game.settings.get("core", "dynamicTokenRingFitMode") === "grid"; }
  catch { return false; }
}

/**
 * The subject scale adjustment core multiplies into the mesh scale for ringed tokens in
 * grid-fit mode (`Token#_refreshMeshSizeAndScale`). Read live from the ring spritesheet
 * data when it is loaded — it varies per ring size bucket — else the default constant.
 */
function _feTPSubjectScaleAdjustment(size) {
  try {
    const v = CONFIG?.Token?.ring?.ringClass?.getRingDataBySize?.(size)?.subjectScaleAdjustment;
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* ring textures not initialized (no canvas yet) */ }
  return _FE_TP_DEFAULT_SUBJECT_SCALE_ADJUSTMENT;
}

/**
 * What the canvas actually paints for this token, which is not always `texture.src`:
 * with a dynamic ring carrying an explicit subject texture the base image is overridden
 * (core itself warns via `TOKEN.ImagePathOverridden`), and in grid-fit mode the mesh
 * scale picks up an extra multiplier. Mirrors the sheet's own `usingSubject` test
 * (`sheets/token/mixin.mjs:291`) — the *inferred* subject path in
 * `TokenDocument#hasDistinctSubjectTexture` needs a file-existence check and is not
 * something the form can answer, so it is deliberately out of scope here.
 * @returns {{src: string, scale: number, usingSubject: boolean}}
 */
function _feTPResolveArt(vals) {
  const usingSubject = !!(vals.ringEnabled && vals.ringSubjectSrc);
  let scale = vals.scale;
  if (vals.ringEnabled && _feTPIsGridFitMode()) {
    scale *= _feTPSubjectScaleAdjustment(Math.min(vals.width, vals.height));
  }
  return { src: usingSubject ? vals.ringSubjectSrc : vals.src, scale, usingSubject };
}

/**
 * The size the art is actually painted at, in viewport pixels — core's
 * `PrimarySpriteMesh#resize` (`fit` → scale factor, then `× scale`) expressed against the
 * grid rect, which is exactly what `background-size` + the CSS `transform: scale()` produce.
 * Falls back to the grid rect while the natural size is still unknown (the image load
 * re-renders the preview, so the approximation is momentary).
 */
function _feTPPaintedArtSize(vals, art, natSize, pw, ph) {
  const nw = natSize?.w;
  const nh = natSize?.h;
  let fw = pw;
  let fh = ph;
  if (nw > 0 && nh > 0) {
    let s = null;
    switch (vals.fit) {
      case "fill": break;
      case "cover": s = Math.max(pw / nw, ph / nh); break;
      case "width": s = pw / nw; break;
      case "height": s = ph / nh; break;
      default: s = Math.min(pw / nw, ph / nh); break; // contain
    }
    if (s !== null) {
      fw = nw * s;
      fh = nh * s;
    }
  }
  const k = Math.abs(art.scale);
  return { w: fw * k, h: fh * k };
}

/**
 * How far the art is displaced from the grid square's center by the texture anchor.
 *
 * On canvas the mesh's *anchor point* is pinned to the token's center
 * (`Token#_refreshPosition`: `mesh.position = this.center`; `Token#_refreshMesh`:
 * `mesh.anchor.set(anchorX, anchorY)`), so the anchor moves the ART, never the square.
 * `anchor 0.5/0.5` centers it; `anchor 0` puts the art's left/top edge on the center.
 * A mirrored axis has a negative mesh scale, which flips the art around that same pinned
 * point — hence the sign flip.
 */
function _feTPAnchorOffset(vals, artSize) {
  return {
    x: (0.5 - vals.anchorX) * artSize.w * (vals.mirrorX ? -1 : 1),
    y: (0.5 - vals.anchorY) * artSize.h * (vals.mirrorY ? -1 : 1),
  };
}

/** True when pan or zoom has been moved off its default — i.e. a reset would do something. */
function _feTPViewIsMoved(panel) {
  const pan = panel._feTPPan ?? { x: 0, y: 0 };
  const zoom = panel._feTPZoom ?? 1;
  return Math.abs(pan.x) > 0.5 || Math.abs(pan.y) > 0.5 || Math.abs(zoom - 1) > 0.001;
}

/**
 * Show the reset control only while the view is actually off-default. It is the one moment
 * it is useful, and it doubles as the indicator that what you are looking at is panned or
 * zoomed — which the preview otherwise only hints at through the zoom percentage.
 */
function _feTPSyncViewResetButton(panel) {
  panel.querySelector(".fe-tp-viewport")?.classList.toggle("fe-tp-view-moved", _feTPViewIsMoved(panel));
}

function feRenderGridPreview(container, vals, natSize) {
  if (!vals) return;
  const vpSize = _feTPGetPreviewSize();
  const zoom = Math.min(_FE_TP_ZOOM_MAX, Math.max(_FE_TP_ZOOM_MIN, container._feTPZoom ?? 1));
  container._feTPZoom = zoom;
  container._feTPValues = vals;
  container._feTPNaturalSize = natSize;
  // Grid/image size starts from the fixed reference and only changes via the
  // explicit wheel zoom. Resizing the viewport merely reveals more area.
  const maxDim = Math.max(vals.width, vals.height, 1);
  const cellSize = Math.round(_FE_TP_PREVIEW_DEFAULT / maxDim) * zoom;
  const pw = cellSize * vals.width;
  const ph = cellSize * vals.height;

  const art = _feTPResolveArt(vals);
  const scaleX = art.scale * (vals.mirrorX ? -1 : 1);
  const scaleY = art.scale * (vals.mirrorY ? -1 : 1);
  const artUrl = _feTPCssUrl(art.src);
  const bgSize = _FE_TP_FIT_TO_BACKGROUND_SIZE[vals.fit] ?? _FE_TP_FIT_TO_BACKGROUND_SIZE.contain;

  const anchorPxX = natSize ? Math.round(vals.anchorX * natSize.w) : "?";
  const anchorPxY = natSize ? Math.round(vals.anchorY * natSize.h) : "?";
  const sizeLabel = natSize ? `${natSize.w}×${natSize.h}` : "";

  // The grid square is what stays put — it is the token's footprint, and the canvas pins the
  // texture's anchor point to its center. The anchor therefore moves the ART inside the
  // square (see `_feTPAnchorOffset`), not the square itself.
  const artSize = _feTPPaintedArtSize(vals, art, natSize, pw, ph);
  const anchorOffset = _feTPAnchorOffset(vals, artSize);
  const vpW = vpSize;
  const vpH = vpSize;
  const baseGridLeft = Math.round(vpW / 2 - pw / 2);
  const baseGridTop = Math.round(vpH / 2 - ph / 2);
  const pan = container._feTPPan ?? { x: 0, y: 0 };
  const gridLeft = baseGridLeft + pan.x;
  const gridTop = baseGridTop + pan.y;

  const esc = foundry.utils.escapeHTML ?? ((s) => s);

  // Ring layers. The real ring is a spritesheet sampled in GLSL, so this is a schematic:
  // it reproduces the two things the form actually controls — the colors and how much of
  // the grid space the band eats — not the ring artwork. `ring.subject.scale` scales the
  // ring's UVs outward (TokenRing#configureSize → getTextureUVs), i.e. a larger subject
  // scale makes the *band* smaller around unchanged art, hence the inverse factor. A
  // scale below 1 genuinely does push the band past the grid square on canvas too (core
  // pads the mesh for exactly that case), so it is not clamped.
  const ringSpan = Math.min(pw, ph);
  const ringScale = 1 / Math.max(0.01, vals.ringSubjectScale || 1);
  // The ring is sampled over the mesh's own quad (`TokenRing#configureSize` → `getTextureUVs`),
  // so it rides along with the anchor displacement exactly like the art does.
  const ringBox = `left:50%;top:50%;width:${ringSpan}px;height:${ringSpan}px;transform:translate(-50%,-50%) `
    + `translate(${anchorOffset.x}px,${anchorOffset.y}px) scale(${ringScale});`;
  const ringR = 50 - (_FE_TP_RING_THICKNESS * 100) / 2;
  const ringLayers = vals.ringEnabled
    ? {
      under: `<svg class="fe-tp-ring fe-tp-ring-under" viewBox="0 0 100 100" style="${ringBox}"
          xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="${ringR}"
          fill="${esc(vals.ringBgColor || "#111111")}"/></svg>`,
      over: `<svg class="fe-tp-ring fe-tp-ring-over" viewBox="0 0 100 100" style="${ringBox}"
          xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="${ringR}" fill="none"
          stroke="${esc(vals.ringColor || "#ffffff")}" stroke-width="${_FE_TP_RING_THICKNESS * 100}"/></svg>`,
    }
    : { under: "", over: "" };

  // Only numeric declarations go into the markup. The image URL and the colors are
  // handed to the CSSOM via setProperty() below instead of being interpolated into an
  // HTML attribute: a data: URL inside `url("…")` inside a quoted attribute has to
  // survive CSS escaping AND HTML escaping, and getting either layer wrong silently
  // drops the whole style attribute (art gone, fit and opacity with it).
  const artLayer = art.src
    ? `<div class="fe-tp-art" style="transform:translate(${anchorOffset.x}px,${anchorOffset.y}px) scale(${scaleX},${scaleY});opacity:${vals.alpha};">${
      vals.tint ? `<div class="fe-tp-tint"></div>` : ""
    }</div>`
    : "";

  // Preserve resize handle if it already exists
  const existingHandle = container.querySelector(".fe-tp-resize-handle");

  container.innerHTML = `
    <div class="fe-tp-viewport" style="width:${vpW}px;height:${vpH}px;"
      title="${esc(_feTPL("FETP.Viewport.Hint", "드래그: 이동 · 휠: 확대/축소"))}">
      <button type="button" class="fe-tp-view-reset"
        title="${esc(_feTPL("FETP.ResetView", "시점 초기화"))}"><i class="fa-solid fa-arrows-to-dot"></i></button>
      <div class="fe-tp-grid-field" data-base-left="${baseGridLeft}" data-base-top="${baseGridTop}" style="background-size:${cellSize}px ${cellSize}px;background-position:${gridLeft}px ${gridTop}px;"></div>
      <div class="fe-tp-grid" data-base-left="${baseGridLeft}" data-base-top="${baseGridTop}" style="width:${pw}px;height:${ph}px;left:${gridLeft}px;top:${gridTop}px;">
        ${ringLayers.under}
        ${artLayer}
        ${ringLayers.over}
        <div class="fe-tp-grid-border"></div>
        <svg class="fe-tp-inscribed-circle" viewBox="0 0 ${pw} ${ph}" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="${pw / 2}" cy="${ph / 2}" rx="${pw / 2 - 1}" ry="${ph / 2 - 1}"/>
        </svg>
        <!-- The crosshair marks the square's center, i.e. the fixed point the texture anchor is
             pinned to. It does not move: the art moves under it. -->
        <div class="fe-tp-crosshair-h" style="top:50%;"></div>
        <div class="fe-tp-crosshair-v" style="left:50%;"></div>
        <div class="fe-tp-crosshair-dot" style="left:50%;top:50%;"></div>
      </div>
    </div>
    <div class="fe-tp-info">
      <span class="fe-tp-info-label">Anchor</span>
      <span class="fe-tp-info-value">${anchorPxX}px, ${anchorPxY}px</span>
      ${sizeLabel ? `<span class="fe-tp-info-dim">(${sizeLabel})</span>` : ""}
    </div>
    <div class="fe-tp-info">
      <span class="fe-tp-info-label">Grid</span>
      <span class="fe-tp-info-value">${vals.width}×${vals.height}</span>
      <span class="fe-tp-info-dim">scale ${vals.scale.toFixed(2)}${
        Math.abs(art.scale - vals.scale) > 0.001 ? ` → ${art.scale.toFixed(2)}` : ""
      }</span>
      ${vals.alpha < 1 ? `<span class="fe-tp-info-dim">alpha ${vals.alpha.toFixed(2)}</span>` : ""}
      ${vals.tint ? `<span class="fe-tp-info-swatch" style="background:${esc(vals.tint)};"
        title="${esc(_feTPL("FETP.Tint", "색조"))} ${esc(vals.tint)}"></span>` : ""}
      <span class="fe-tp-info-dim">zoom ${Math.round(zoom * 100)}%</span>
    </div>
    ${vals.ringEnabled ? `<div class="fe-tp-info">
      <span class="fe-tp-info-label">Ring</span>
      <span class="fe-tp-info-value">×${(vals.ringSubjectScale || 1).toFixed(2)}</span>
      ${art.usingSubject
        ? `<span class="fe-tp-info-dim" title="${esc(art.src)}">${
          esc(_feTPL("FETP.Subject", "서브젝트"))}: ${esc(art.src.split("/").pop())}</span>`
        : ""}
    </div>` : ""}`;

  const artEl = container.querySelector(".fe-tp-art");
  if (artEl) {
    artEl.style.setProperty("--fe-tp-art", artUrl);
    artEl.style.setProperty("--fe-tp-fit", bgSize);
    // Inherited by .fe-tp-tint, which reuses both as its mask-image / mask-size.
    if (vals.tint) artEl.style.setProperty("--fe-tp-tint", vals.tint);
  }

  if (!existingHandle) {
    const handle = document.createElement("div");
    handle.className = "fe-tp-resize-handle";
    container.appendChild(handle);
    _feTPWireResize(container, handle);
  } else {
    container.appendChild(existingHandle);
  }
  _feTPWirePan(container);
  _feTPWireZoom(container);
  _feTPWireViewReset(container);
  _feTPSyncViewResetButton(container);
}

function _feTPWireViewReset(panel) {
  const btn = panel.querySelector(".fe-tp-view-reset");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    // Pan/zoom are view state only — the anchor is document data and is deliberately left
    // alone, so this can never undo an edit.
    e.preventDefault();
    e.stopPropagation();
    panel._feTPPan = { x: 0, y: 0 };
    panel._feTPZoom = 1;
    feRenderGridPreview(panel, panel._feTPValues, panel._feTPNaturalSize);
  });
}

function _feTPApplyPan(panel, pan) {
  panel._feTPPan = pan;
  const grid = panel.querySelector(".fe-tp-grid");
  const field = panel.querySelector(".fe-tp-grid-field");
  const baseLeft = parseFloat(grid?.dataset?.baseLeft ?? field?.dataset?.baseLeft ?? "0");
  const baseTop = parseFloat(grid?.dataset?.baseTop ?? field?.dataset?.baseTop ?? "0");
  const left = Math.round(baseLeft + pan.x);
  const top = Math.round(baseTop + pan.y);
  if (grid) {
    grid.style.left = `${left}px`;
    grid.style.top = `${top}px`;
  }
  if (field) field.style.backgroundPosition = `${left}px ${top}px`;
}

function _feTPWirePan(panel) {
  const viewport = panel.querySelector(".fe-tp-viewport");
  if (!viewport || viewport._feTPPanWired) return;
  viewport._feTPPanWired = true;

  viewport.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  viewport.addEventListener("pointerdown", (e) => {
    // Left drag pans — which is what `cursor: grab` had been promising all along while the
    // handler ignored button 0 entirely. Right drag stays a pan so the gesture that already
    // existed keeps working. The viewport is a viewer, not an editor: the anchor is set on
    // the sliders, where the number is visible while it changes.
    if (e.button !== 0 && e.button !== 2) return;
    if (e.target.closest?.(".fe-tp-view-reset, .fe-tp-resize-handle")) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startPan = panel._feTPPan ?? { x: 0, y: 0 };
    viewport.classList.add("fe-tp-panning");
    viewport.setPointerCapture?.(e.pointerId);

    const onMove = (ev) => {
      ev.preventDefault();
      _feTPApplyPan(panel, { x: startPan.x + (ev.clientX - startX), y: startPan.y + (ev.clientY - startY) });
    };
    const onUp = (ev) => {
      viewport.releasePointerCapture?.(ev.pointerId);
      viewport.classList.remove("fe-tp-panning");
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", onUp);
      viewport.removeEventListener("pointercancel", onUp);
      // `_feTPApplyPan` moves the DOM without re-rendering, so the reset control has to be
      // re-evaluated here rather than riding along on a render.
      _feTPSyncViewResetButton(panel);
    };

    viewport.addEventListener("pointermove", onMove);
    viewport.addEventListener("pointerup", onUp);
    viewport.addEventListener("pointercancel", onUp);
  });
}

function _feTPWireZoom(panel) {
  const viewport = panel.querySelector(".fe-tp-viewport");
  if (!viewport || viewport._feTPZoomWired) return;
  viewport._feTPZoomWired = true;

  viewport.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation();

    const oldZoom = panel._feTPZoom ?? 1;
    const deltaPixels = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1);
    const boundedDelta = Math.min(100, Math.max(-100, deltaPixels));
    const requestedZoom = oldZoom * Math.exp(-boundedDelta * 0.0015);
    const newZoom = Math.min(_FE_TP_ZOOM_MAX, Math.max(_FE_TP_ZOOM_MIN, requestedZoom));
    if (Math.abs(newZoom - oldZoom) < 0.0001) return;

    // Keep the grid point beneath the cursor stationary while zooming. The grid scales about
    // its own center, which sits at the viewport center plus the current pan.
    const rect = viewport.getBoundingClientRect();
    const pan = panel._feTPPan ?? { x: 0, y: 0 };
    const cursorFromAnchorX = e.clientX - rect.left - rect.width / 2 - pan.x;
    const cursorFromAnchorY = e.clientY - rect.top - rect.height / 2 - pan.y;
    const ratio = newZoom / oldZoom;
    panel._feTPPan = {
      x: pan.x + cursorFromAnchorX * (1 - ratio),
      y: pan.y + cursorFromAnchorY * (1 - ratio),
    };
    panel._feTPZoom = newZoom;
    feRenderGridPreview(panel, panel._feTPValues, panel._feTPNaturalSize);
  }, { passive: false });
}

function _feTPWireResize(panel, handle) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startSize = _feTPGetPreviewSize();
    const configEl = panel.closest(".prototype-token-config, .token-config");
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const delta = Math.max(dx, dy);
      const newSize = Math.max(_FE_TP_PREVIEW_MIN, Math.round(startSize + delta));
      localStorage.setItem(_FE_TP_STORAGE_KEY, String(newSize));
      const vp = panel.querySelector(".fe-tp-viewport");
      if (vp) { vp.style.width = `${newSize}px`; vp.style.height = `${newSize}px`; }
      if (configEl) {
        const targetW = _FE_TP_SHEET_BASE_WIDTH + newSize;
        configEl.style.width = `${targetW}px`;
        configEl.style.minWidth = `${targetW}px`;
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      panel._feTPUpdatePreview?.();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
  });
}

function feGetTokenConfigElement(root) {
  return root?.closest?.(".prototype-token-config, .token-config") ?? null;
}

function feApplyPreviewSheetSize(app, root) {
  const configEl = feGetTokenConfigElement(root);
  if (!configEl) return;
  configEl.classList.add("fe-tp-active");
  configEl.classList.toggle("fe-tp-two-column", feTokenConfigTwoColumnEnabled());
  const targetW = _FE_TP_SHEET_BASE_WIDTH + _feTPGetPreviewSize();
  const currentH = Math.round(configEl.getBoundingClientRect?.().height || 0);
  const viewportH = configEl.ownerDocument?.documentElement?.clientHeight ?? window.innerHeight ?? 900;
  const maxH = Math.max(520, viewportH - 80);
  const targetH = Math.min(Math.max(currentH, _FE_TP_SHEET_MIN_HEIGHT), maxH);

  if (app?.options?.position) {
    app.options.position.width = targetW;
    app.options.position.height = targetH;
  }
  try { app?.setPosition?.({ width: targetW, height: targetH }); } catch (_) { /* best effort for v13/v14 variants */ }
  configEl.style.width = `${targetW}px`;
  configEl.style.minWidth = `${targetW}px`;
  configEl.style.height = `${targetH}px`;
}

function feRegisterTokenPreviewSettings() {
  game.settings.register(MODULE_ID, S.CORE_UI_TOKEN_PREVIEW, {
    name: "코어 UI: 토큰 설정 미리보기", hint: "프로토타입 토큰 비주얼 탭에 라이브 미리보기를 표시합니다.",
    scope: "client", config: false, type: Boolean, default: FE_DEFAULTS[S.CORE_UI_TOKEN_PREVIEW],
  });
  game.settings.register(MODULE_ID, S.TOKEN_CONFIG_TWO_COLUMN, {
    name: "프로토타입 토큰 설정: 다른 탭 2열 정렬",
    hint: "비주얼 미리보기 때문에 넓어진 토큰 설정 창에서, 비주얼 탭이 아닌 탭들도 좌우 2열로 정렬합니다. 끄면 Foundry 기본 1열 정렬로 표시합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_CONFIG_TWO_COLUMN],
    onChange: (value) => {
      for (const el of document.querySelectorAll(".prototype-token-config.fe-tp-active, .token-config.fe-tp-active")) {
        el.classList.toggle("fe-tp-two-column", !!value);
      }
    },
  });

}

function feNormalizeAppearanceLayout(tab) {
  const layout = tab?.querySelector?.(":scope > .fe-tp-layout");
  const controls = layout?.querySelector?.(":scope > .fe-tp-controls");
  if (!tab || !layout || !controls) return;

  for (const child of Array.from(tab.children)) {
    if (child === layout) continue;
    controls.appendChild(child);
  }
}

function feInjectTokenPreview(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
  if (!root) return;
  const tab = root.querySelector('.tab[data-tab="appearance"]');
  if (!tab) return;

  const form = app.form ?? root.querySelector("form");
  const vals = feReadAppearanceValues(form);
  if (!vals) return;

  // Restructure: wrap tab contents in a two-column layout
  let layout = tab.querySelector(".fe-tp-layout");
  if (!layout) {
    layout = document.createElement("div");
    layout.className = "fe-tp-layout";
    const controls = document.createElement("div");
    controls.className = "fe-tp-controls";
    while (tab.firstChild) controls.appendChild(tab.firstChild);
    const panel = document.createElement("div");
    panel.className = "fe-tp-panel";
    layout.appendChild(controls);
    layout.appendChild(panel);
    tab.appendChild(layout);
  }
  feNormalizeAppearanceLayout(tab);
  feApplyPreviewSheetSize(app, root);

  const panel = layout.querySelector(".fe-tp-panel");
  // The natural-size / anchor-pixel readout must describe the texture that is actually
  // painted, which is the ring subject when one overrides the base image.
  feLoadImage(_feTPResolveArt(vals).src).then((natSize) => feRenderGridPreview(panel, vals, natSize));

  // Inject range sliders next to anchor X/Y number inputs
  feInjectAnchorSliders(tab, form);
  feWidenAppearanceRanges(tab);
}

/**
 * Widen the appearance tab's scale sliders past core's hard-coded bounds.
 *
 * `HTMLRangePickerElement` reads min/max/step into PRIVATE fields in its constructor
 * (client/applications/elements/range-picker.mjs) and `_setValue` clamps against those
 * captured numbers — so rewriting the attributes (or the inner inputs') on a live element
 * does nothing. The element has to be rebuilt through `create()`, which is why this
 * replaces the node instead of patching it.
 */
function feWidenAppearanceRanges(tab) {
  for (const { name, min, max, step } of _FE_TP_RANGE_OVERRIDES) {
    const old = tab.querySelector(`range-picker[name="${name}"]`);
    if (!old || old.dataset.feTpWidened === "1") continue;
    const cls = typeof old.constructor?.create === "function"
      ? old.constructor
      : foundry.applications.elements?.HTMLRangePickerElement;
    if (typeof cls?.create !== "function") continue;

    const current = Number(old.value ?? old.getAttribute("value"));
    const picker = cls.create({
      name, value: Number.isFinite(current) ? current : 1, min, max, step,
    });
    picker.dataset.feTpWidened = "1";
    if (old.id) picker.id = old.id;
    if (old.disabled) picker.disabled = true;
    old.replaceWith(picker);
  }
}

function feInjectAnchorSliders(tab, form) {
  const pairs = [
    { name: "texture.anchorX", label: "X" },
    { name: "texture.anchorY", label: "Y" },
  ];
  for (const { name, label } of pairs) {
    const numInput = form?.elements[name];
    if (!numInput || numInput._feTPSliderWired) continue;
    numInput._feTPSliderWired = true;

    const formGroup = numInput.closest(".form-group");
    if (!formGroup) continue;

    const row = document.createElement("div");
    row.className = "fe-tp-anchor-row";

    const lbl = document.createElement("span");
    lbl.className = "fe-tp-anchor-label";
    lbl.textContent = label;

    const range = document.createElement("input");
    range.type = "range";
    range.className = "fe-tp-anchor-range";
    range.min = String(_FE_TP_ANCHOR_MIN);
    range.max = String(_FE_TP_ANCHOR_MAX);
    range.step = "0.01";
    range.value = numInput.value || "0.5";

    row.appendChild(lbl);
    row.appendChild(range);
    row.appendChild(numInput);

    formGroup.appendChild(row);

    range.addEventListener("input", () => {
      numInput.value = range.value;
      numInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    numInput.addEventListener("input", () => { range.value = numInput.value; });
  }
}

// Live update: listen for input changes on the appearance tab fields
function feWirePreviewUpdates(app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
  if (!root) return;
  if (root._feTPWired) return;
  root._feTPWired = true;

  const renderNow = () => {
    const tab = root.querySelector('.tab[data-tab="appearance"]');
    if (!tab) return;
    const panel = tab.querySelector(".fe-tp-panel");
    if (!panel) return;
    const form = app.form ?? root.querySelector("form");
    const vals = feReadAppearanceValues(form);
    if (!vals) return;
    feLoadImage(_feTPResolveArt(vals).src).then((natSize) => feRenderGridPreview(panel, vals, natSize));
  };

  // Coalesce to one render per frame. Slider drags now stream input events (they used to be
  // swallowed, see below), and each render is a full innerHTML rebuild of the panel.
  let rafId = 0;
  const updatePreview = () => {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; renderNow(); });
  };

  // Attach updatePreview to the panel so the resize handle can trigger it
  const panel = root.querySelector(".fe-tp-panel");
  if (panel) panel._feTPUpdatePreview = updatePreview;

  const form = app.form ?? root.querySelector("form");
  if (form) {
    // One list for both events. The previous pair of divergent inline lists was already
    // hard to keep in sync, and the ring fields fire on either depending on whether the
    // control is a plain input, a color-picker or a range-picker.
    const onFieldEvent = (e) => {
      // The event target is not always the named control. Foundry's form-associated custom
      // elements (range-picker, color-picker, file-picker) are light DOM and only the host
      // carries `name` — `_applyInputAttributes` does not copy it onto the inner inputs —
      // so a slider drag arrives with `target` = an anonymous `input[type=range]` and used
      // to be dropped here. That, not the event plumbing, is why the scale slider looked
      // dead until release. Walk up to the nearest named ancestor.
      const t = e.target;
      const name = t?.name || t?.closest?.("[name]")?.getAttribute("name") || "";
      if (_FE_TP_WATCHED_FIELDS.has(name)) updatePreview();
    };
    form.addEventListener("input", onFieldEvent);
    form.addEventListener("change", onFieldEvent);

    // Scroll-wheel adjustment on anchor X/Y inputs
    for (const name of ["texture.anchorX", "texture.anchorY"]) {
      const input = form.elements[name];
      if (!input) continue;
      input.addEventListener("wheel", (e) => {
        e.preventDefault();
        const step = e.shiftKey ? 0.1 : 0.01;
        const cur = parseFloat(input.value) || 0.5;
        const next = Math.round((cur + (e.deltaY < 0 ? step : -step)) * 1000) / 1000;
        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, { passive: false });
    }
  }
}

function feHideVisionTabForPanel(app, html) {
  const actor = app.actor ?? app.document?.parent;
  if (actor?.type !== "female_edition.screenPanel") return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
  if (!root) return;
  const navBtn = root.querySelector('[data-tab="vision"]');
  if (navBtn) {
    const li = navBtn.closest("li, a, button");
    if (li) li.style.display = "none";
  }
  const tabContent = root.querySelector('.tab[data-tab="vision"]');
  if (tabContent) tabContent.remove();
}

function feInjectPanelBarAttributes(app, html) {
  const actor = app.actor ?? app.document?.parent;
  if (actor?.type !== "female_edition.screenPanel") return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
  if (!root) return;
  const customAttrs = actor.system?.customAttributes ?? [];
  if (!customAttrs.length) return;
  const selects = root.querySelectorAll(
    'select[name="bar1.attribute"], select[name="bar2.attribute"]'
  );
  for (const sel of selects) {
    if (sel._fePanelInjected) continue;
    sel._fePanelInjected = true;
    const group = document.createElement("optgroup");
    group.label = game.i18n?.localize?.("FESP.Sheet.CustomAttrs") ?? "커스텀 어트리뷰트";
    for (let i = 0; i < customAttrs.length; i++) {
      const attr = customAttrs[i];
      if (!attr.name) continue;
      const opt = document.createElement("option");
      opt.value = `customAttributes.${i}`;
      opt.textContent = attr.name;
      if (sel.value === opt.value) opt.selected = true;
      group.appendChild(opt);
    }
    if (group.children.length) sel.appendChild(group);
  }
}

Hooks.once("init", feRegisterTokenPreviewSettings);

Hooks.on("renderPrototypeTokenConfig", (app, html) => {
  if (feTokenPreviewEnabled()) { feInjectTokenPreview(app, html); feWirePreviewUpdates(app, html); }
  feHideVisionTabForPanel(app, html);
  feInjectPanelBarAttributes(app, html);
});

Hooks.on("renderTokenConfig", (app, html) => {
  if (feTokenPreviewEnabled()) { feInjectTokenPreview(app, html); feWirePreviewUpdates(app, html); }
});
