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
    scale: parseFloat(form.elements["scale"]?.value) || 1,
    mirrorX: !!form.elements["mirrorX"]?.checked,
    mirrorY: !!form.elements["mirrorY"]?.checked,
    tint: form.elements["texture.tint"]?.value || "",
    fit: form.elements["texture.fit"]?.value || "contain",
    width: parseFloat(form.elements["width"]?.value) || 1,
    height: parseFloat(form.elements["height"]?.value) || 1,
  };
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

  const scaleX = vals.scale * (vals.mirrorX ? -1 : 1);
  const scaleY = vals.scale * (vals.mirrorY ? -1 : 1);

  const anchorPxX = natSize ? Math.round(vals.anchorX * natSize.w) : "?";
  const anchorPxY = natSize ? Math.round(vals.anchorY * natSize.h) : "?";
  const sizeLabel = natSize ? `${natSize.w}×${natSize.h}` : "";

  // Offset the grid so the anchor point sits at the viewport center.
  const vpW = vpSize;
  const vpH = vpSize;
  const baseGridLeft = Math.round(vpW / 2 - vals.anchorX * pw);
  const baseGridTop = Math.round(vpH / 2 - vals.anchorY * ph);
  const pan = container._feTPPan ?? { x: 0, y: 0 };
  const gridLeft = baseGridLeft + pan.x;
  const gridTop = baseGridTop + pan.y;

  const esc = foundry.utils.escapeHTML ?? ((s) => s);

  // Preserve resize handle if it already exists
  const existingHandle = container.querySelector(".fe-tp-resize-handle");

  container.innerHTML = `
    <div class="fe-tp-viewport" style="width:${vpW}px;height:${vpH}px;"
      title="마우스 휠: 확대/축소 · 우클릭 드래그: 이동">
      <div class="fe-tp-grid-field" data-base-left="${baseGridLeft}" data-base-top="${baseGridTop}" style="background-size:${cellSize}px ${cellSize}px;background-position:${gridLeft}px ${gridTop}px;"></div>
      <div class="fe-tp-grid" data-base-left="${baseGridLeft}" data-base-top="${baseGridTop}" style="width:${pw}px;height:${ph}px;left:${gridLeft}px;top:${gridTop}px;">
        ${vals.src ? `<img class="fe-tp-img" src="${esc(vals.src)}" alt=""
          style="object-fit:${vals.fit};transform:scale(${scaleX},${scaleY});">` : ""}
        <div class="fe-tp-grid-border"></div>
        <svg class="fe-tp-inscribed-circle" viewBox="0 0 ${pw} ${ph}" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="${pw / 2}" cy="${ph / 2}" rx="${pw / 2 - 1}" ry="${ph / 2 - 1}"/>
        </svg>
        <div class="fe-tp-crosshair-h" style="top:${vals.anchorY * 100}%;"></div>
        <div class="fe-tp-crosshair-v" style="left:${vals.anchorX * 100}%;"></div>
        <div class="fe-tp-crosshair-dot" style="left:${vals.anchorX * 100}%;top:${vals.anchorY * 100}%;"></div>
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
      <span class="fe-tp-info-dim">scale ${vals.scale.toFixed(2)}</span>
      <span class="fe-tp-info-dim">zoom ${Math.round(zoom * 100)}%</span>
    </div>`;

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
    if (e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startPan = panel._feTPPan ?? { x: 0, y: 0 };
    viewport.classList.add("fe-tp-panning");
    viewport.setPointerCapture?.(e.pointerId);

    const onMove = (ev) => {
      ev.preventDefault();
      _feTPApplyPan(panel, {
        x: startPan.x + ev.clientX - startX,
        y: startPan.y + ev.clientY - startY,
      });
    };
    const onUp = (ev) => {
      viewport.releasePointerCapture?.(ev.pointerId);
      viewport.classList.remove("fe-tp-panning");
      viewport.removeEventListener("pointermove", onMove);
      viewport.removeEventListener("pointerup", onUp);
      viewport.removeEventListener("pointercancel", onUp);
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

    // Keep the grid point beneath the cursor stationary while zooming. The
    // grid anchor normally sits at viewport center plus the current pan.
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
  feLoadImage(vals.src).then((natSize) => feRenderGridPreview(panel, vals, natSize));

  // Inject range sliders next to anchor X/Y number inputs
  feInjectAnchorSliders(tab, form);
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
    range.min = "-0.5";
    range.max = "1.5";
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

  const updatePreview = () => {
    const tab = root.querySelector('.tab[data-tab="appearance"]');
    if (!tab) return;
    const panel = tab.querySelector(".fe-tp-panel");
    if (!panel) return;
    const form = app.form ?? root.querySelector("form");
    const vals = feReadAppearanceValues(form);
    if (!vals) return;
    feLoadImage(vals.src).then((natSize) => feRenderGridPreview(panel, vals, natSize));
  };

  // Attach updatePreview to the panel so the resize handle can trigger it
  const panel = root.querySelector(".fe-tp-panel");
  if (panel) panel._feTPUpdatePreview = updatePreview;

  const form = app.form ?? root.querySelector("form");
  if (form) {
    form.addEventListener("input", (e) => {
      const name = e.target.name ?? "";
      if (["texture.anchorX", "texture.anchorY", "scale", "width", "height",
           "texture.fit", "texture.tint", "texture.src"].includes(name)
          || name === "mirrorX" || name === "mirrorY") {
        updatePreview();
      }
    });
    form.addEventListener("change", (e) => {
      const name = e.target.name ?? "";
      if (name === "mirrorX" || name === "mirrorY" || name === "texture.fit"
          || name === "texture.src") {
        updatePreview();
      }
    });

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
