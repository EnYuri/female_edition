// Image processing for fe-chat-archive.js
// Canvas downscale, background color freeze, blob → data-URL conversion.
// No imports — fully self-contained.

// ===========================================================================
// Internal utilities
// ===========================================================================

// 0 ms yield so heavy canvas loops don't freeze the UI thread.
function feNextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ===========================================================================
// Blob → data-URL
// ===========================================================================

export function feBlobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err);
    }
  });
}

// ===========================================================================
// Color parsing  (computed CSS → {r,g,b,a} objects)
// ===========================================================================

function feParseRGBAFromCSS(cssColor) {
  const s = String(cssColor ?? "").trim().toLowerCase();
  if (!s || s === "transparent") return null;

  // Most browsers expose computed colors as rgb()/rgba() with commas.
  // Also accept the modern space + slash syntax just in case.
  const m = s.match(
    /^rgba?\(\s*([\d.]+)\s*(?:,|\s)\s*([\d.]+)\s*(?:,|\s)\s*([\d.]+)(?:\s*(?:,|\/|\s)\s*([\d.]+))?\s*\)$/i
  );
  if (!m) return null;

  const r = Math.max(0, Math.min(255, Number(m[1])));
  const g = Math.max(0, Math.min(255, Number(m[2])));
  const b = Math.max(0, Math.min(255, Number(m[3])));
  const a = m[4] == null ? 1 : Math.max(0, Math.min(1, Number(m[4])));

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b) || !Number.isFinite(a)) return null;
  return { r, g, b, a };
}

function feParseRGBTriplet(raw) {
  try {
    const parts = String(raw ?? "")
      .trim()
      .split(/[^\d.]+/)
      .filter(Boolean)
      .map((v) => Number(v));
    if (parts.length < 3) return null;
    const [r, g, b] = parts;
    if (![r, g, b].every((v) => Number.isFinite(v))) return null;
    return {
      r: Math.max(0, Math.min(255, r)),
      g: Math.max(0, Math.min(255, g)),
      b: Math.max(0, Math.min(255, b)),
    };
  } catch {
    return null;
  }
}

function feScreenBlendChannel(base, overlay) {
  // base/overlay in [0..255]
  return 255 - ((255 - base) * (255 - overlay)) / 255;
}

// ===========================================================================
// Background freeze  (read/write-batched to avoid layout thrashing)
// ===========================================================================

export function feFreezeMessageBackgroundsForPrint(win, logEl) {
  if (!win || win.closed) return () => {};
  if (!logEl) return () => {};

  const doc = win.document;
  const rootCS = win.getComputedStyle(doc.documentElement);

  // Pull the same "paper" overlay params used by chat-bg-stripper
  // (defaults match styles/chat-bg-stripper.css)
  const paperRGBRaw = String(rootCS.getPropertyValue("--fe-paper-rgb") || "245 239 229").trim();
  const paperParts = paperRGBRaw.split(/\s+/).map((x) => Number(x));
  const paper = {
    r: Number.isFinite(paperParts[0]) ? Math.max(0, Math.min(255, paperParts[0])) : 245,
    g: Number.isFinite(paperParts[1]) ? Math.max(0, Math.min(255, paperParts[1])) : 239,
    b: Number.isFinite(paperParts[2]) ? Math.max(0, Math.min(255, paperParts[2])) : 229,
  };
  const paperAlpha = (() => {
    const a = Number(String(rootCS.getPropertyValue("--fe-paper-alpha") || "0.42").trim());
    return Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 0.42;
  })();

  const msgs = Array.from(logEl.querySelectorAll(".chat-message"));
  if (!msgs.length) return () => {};

  const changed = [];

  const body = doc.body;
  const hasUserColor = !!body?.classList?.contains?.("fe-msg-bg-usercolor");
  const hasUserBase = !!(body?.classList?.contains?.("fe-userbg-base-white") || body?.classList?.contains?.("fe-userbg-base-black"));

  // Read phase: collect all computed styles before any writes.
  // Separating reads from writes avoids layout thrashing — each write would otherwise
  // invalidate the layout and force a full recalculation on the next getComputedStyle call.
  const plan = [];
  for (const el of msgs) {
    try {
      const cs = win.getComputedStyle(el);
      const bg = feParseRGBAFromCSS(cs.backgroundColor);
      if (!bg || bg.a <= 0) continue;

      let outR;
      let outG;
      let outB;

      if (hasUserColor && hasUserBase && el.classList?.contains?.("fe-has-user-color")) {
        const tint = feParseRGBTriplet(cs.getPropertyValue("--fe-user-color-rgb"));
        const alphaRaw = Number(String(cs.getPropertyValue("--fe-user-color-alpha") || rootCS.getPropertyValue("--fe-user-color-alpha") || "0.22").trim());
        const tintAlpha = Number.isFinite(alphaRaw) ? Math.max(0, Math.min(1, alphaRaw)) : 0.22;
        if (tint) {
          outR = Math.round(bg.r * (1 - tintAlpha) + tint.r * tintAlpha);
          outG = Math.round(bg.g * (1 - tintAlpha) + tint.g * tintAlpha);
          outB = Math.round(bg.b * (1 - tintAlpha) + tint.b * tintAlpha);
        }
      }

      if (outR == null || outG == null || outB == null) {
        const sr = feScreenBlendChannel(bg.r, paper.r);
        const sg = feScreenBlendChannel(bg.g, paper.g);
        const sb = feScreenBlendChannel(bg.b, paper.b);

        outR = Math.round(bg.r * (1 - paperAlpha) + sr * paperAlpha);
        outG = Math.round(bg.g * (1 - paperAlpha) + sg * paperAlpha);
        outB = Math.round(bg.b * (1 - paperAlpha) + sb * paperAlpha);
      }

      plan.push({ el, outR, outG, outB, prevStyle: el.getAttribute("style") });
    } catch {
      // ignore
    }
  }

  // Write phase: apply all style mutations after all reads are complete.
  for (const { el, outR, outG, outB, prevStyle } of plan) {
    try {
      changed.push({ el, prevStyle });
      el.style.setProperty("background-color", `rgb(${outR}, ${outG}, ${outB})`, "important");
      el.style.setProperty("background-image", "none", "important");
      el.style.setProperty("background-blend-mode", "normal", "important");
      el.style.setProperty("mix-blend-mode", "normal", "important");
      el.style.setProperty("box-shadow", "none", "important");
      el.style.setProperty("filter", "none", "important");
      el.style.setProperty("backdrop-filter", "none", "important");
    } catch {
      // ignore
    }
  }

  return () => {
    for (const it of changed) {
      try {
        if (it.prevStyle == null) it.el.removeAttribute("style");
        else it.el.setAttribute("style", it.prevStyle);
      } catch {}
    }
  };
}

// ===========================================================================
// Canvas helpers
// ===========================================================================

function feCreateArchiveCanvas(doc, width, height) {
  const canvas = doc.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width) || 1);
  canvas.height = Math.max(1, Math.round(height) || 1);
  return canvas;
}

function feEnableHighQualitySmoothing(ctx) {
  if (!ctx) return;
  try {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  } catch {
    // ignore
  }
}

function feProgressiveResampleCanvas(win, img, spec, outW, outH, { maxIntermediateSide = 2048 } = {}) {
  const doc = win?.document;
  if (!doc || !img) return null;

  const srcW = Math.max(1, Math.round(spec?.sw || img.naturalWidth || outW));
  const srcH = Math.max(1, Math.round(spec?.sh || img.naturalHeight || outH));
  const scaledEnough = srcW <= outW * 1.2 && srcH <= outH * 1.2;

  const out = feCreateArchiveCanvas(doc, outW, outH);
  const octx = out.getContext("2d", { alpha: true });
  if (!octx) return out;
  feEnableHighQualitySmoothing(octx);

  if (scaledEnough) {
    octx.clearRect(0, 0, outW, outH);
    octx.drawImage(img, spec.sx, spec.sy, spec.sw, spec.sh, spec.dx, spec.dy, spec.dw, spec.dh);
    return out;
  }

  const maxSide = Math.max(outW, outH);
  const minSeed = Math.max(maxSide * 4, 512);
  const seedScale = Math.min(1, Math.max(minSeed, Math.min(Number(maxIntermediateSide) || 2048, 4096)) / Math.max(srcW, srcH));
  const seedW = Math.max(outW, Math.round(srcW * seedScale));
  const seedH = Math.max(outH, Math.round(srcH * seedScale));

  let work = feCreateArchiveCanvas(doc, seedW, seedH);
  let wctx = work.getContext("2d", { alpha: true });
  if (!wctx) return out;
  feEnableHighQualitySmoothing(wctx);
  wctx.clearRect(0, 0, seedW, seedH);
  wctx.drawImage(img, spec.sx, spec.sy, spec.sw, spec.sh, 0, 0, seedW, seedH);

  while (work.width / 2 >= outW * 1.1 && work.height / 2 >= outH * 1.1) {
    const nextW = Math.max(outW, Math.round(work.width / 2));
    const nextH = Math.max(outH, Math.round(work.height / 2));
    const next = feCreateArchiveCanvas(doc, nextW, nextH);
    const nctx = next.getContext("2d", { alpha: true });
    if (!nctx) break;
    feEnableHighQualitySmoothing(nctx);
    nctx.clearRect(0, 0, nextW, nextH);
    nctx.drawImage(work, 0, 0, work.width, work.height, 0, 0, nextW, nextH);
    work.width = 0;
    work.height = 0;
    work = next;
  }

  octx.clearRect(0, 0, outW, outH);
  octx.drawImage(work, 0, 0, work.width, work.height, spec.dx, spec.dy, spec.dw, spec.dh);
  work.width = 0;
  work.height = 0;
  return out;
}

// ===========================================================================
// Image downscale  (main export — called by feArchivePrint)
// ===========================================================================

export async function feDownscaleImagesForPrint(
  win,
  rootEl,
  {
    meta,
    excludeAvatars = false,
    dprCap = 1.5,
    minDpr = 1,
    webpQuality = 0.82,
    jpegQuality = 0.85,
    // Avatars/portraits: preserve quality (they are small but visually important)
    avatarDprCap = 2.25,
    avatarMinDpr = 1.5,
    avatarWebpQuality = 0.95,
    avatarJpegQuality = 0.96,
    maxSide = 1600,
    forceLossless = false,
    minOutSide = 1,
  } = {}
) {
  const setMeta = typeof meta === "function" ? meta : () => {};
  let imgs = Array.from(rootEl.querySelectorAll("img"));
  if (!imgs.length) return () => {};

  const changed = [];

  const isAvatarImage = (img) => {
    try {
      if (!img) return false;
      if (img.classList?.contains("avatar")) return true;
      if (img.matches?.('img.chat-portrait-image-size-name-dnd5e, img[class*="chat-portrait-image-size"]')) return true;
      if (img.matches?.('img.fe-chat-portrait, img.chat-portrait-message-portrait')) return true;
      if (img.closest?.(".message-header, .message-sender")) return true;
      if (img.closest?.(".chat-portrait-container")) return true;
    } catch {}
    return false;
  };

  if (excludeAvatars) imgs = imgs.filter((img) => !isAvatarImage(img));

  const screenDpr = Math.max(1, Number(win.devicePixelRatio) || 1);
  const dpr = Math.max(1, Math.min(dprCap, Math.max(screenDpr, Number(minDpr) || 1)));
  const avatarDpr = Math.max(1, Math.min(avatarDprCap, Math.max(screenDpr, Number(avatarMinDpr) || 1.5)));
  const groups = new Map();
  const MAX_SIDE = Math.max(256, Number(maxSide) || 1600);

  const resolvePosition = (value, axis = "x") => {
    const raw = String(value || "").trim().toLowerCase();
    const parts = raw.split(/\s+/).filter(Boolean);
    const token = axis === "x"
      ? (parts[0] || "center")
      : (parts[1] || parts[0] || "center");
    if (token.endsWith("%")) {
      const n = Number(token.replace("%", ""));
      if (Number.isFinite(n)) return Math.max(0, Math.min(1, n / 100));
    }
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return 1;
    return 0.5;
  };

  const computeDrawSpec = (img, outW, outH) => {
    let fit = "fill";
    let position = "center center";
    try {
      const cs = win.getComputedStyle?.(img);
      fit = String(cs?.objectFit || img.style?.objectFit || "fill").trim() || "fill";
      position = String(cs?.objectPosition || img.style?.objectPosition || "center center").trim() || "center center";
    } catch {}

    const naturalW = Math.max(1, Number(img.naturalWidth) || 1);
    const naturalH = Math.max(1, Number(img.naturalHeight) || 1);
    const px = resolvePosition(position, "x");
    const py = resolvePosition(position, "y");

    if (fit === "contain") {
      const scale = Math.min(outW / naturalW, outH / naturalH);
      const drawW = Math.max(1, Math.round(naturalW * scale));
      const drawH = Math.max(1, Math.round(naturalH * scale));
      const dx = Math.round((outW - drawW) * px);
      const dy = Math.round((outH - drawH) * py);
      return { fit, position, sx: 0, sy: 0, sw: naturalW, sh: naturalH, dx, dy, dw: drawW, dh: drawH };
    }

    if (fit === "cover") {
      const scale = Math.max(outW / naturalW, outH / naturalH);
      const cropW = Math.max(1, Math.round(outW / scale));
      const cropH = Math.max(1, Math.round(outH / scale));
      const sx = Math.round((naturalW - cropW) * px);
      const sy = Math.round((naturalH - cropH) * py);
      return {
        fit,
        position,
        sx: Math.max(0, Math.min(naturalW - cropW, sx)),
        sy: Math.max(0, Math.min(naturalH - cropH, sy)),
        sw: cropW,
        sh: cropH,
        dx: 0,
        dy: 0,
        dw: outW,
        dh: outH,
      };
    }

    return { fit, position, sx: 0, sy: 0, sw: naturalW, sh: naturalH, dx: 0, dy: 0, dw: outW, dh: outH };
  };

  const getKey = (img, targetW, targetH) => {
    try {
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src) return "";
      const spec = computeDrawSpec(img, targetW, targetH);
      return [src, targetW, targetH, spec.fit, spec.position, isAvatarImage(img) ? "avatar" : "img"].join("@@");
    } catch {
      return "";
    }
  };

  for (const img of imgs) {
    try {
      if (!img.complete || img.naturalWidth <= 0) continue;
      const rect = img.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));
      if (cssW <= 1 || cssH <= 1) continue;

      const isAvatar = isAvatarImage(img);
      const dprUse = isAvatar ? avatarDpr : dpr;
      let targetW = Math.max(1, Math.round(cssW * dprUse));
      let targetH = Math.max(1, Math.round(cssH * dprUse));
      if (minOutSide > 1) {
        const minSide = Math.min(targetW, targetH);
        if (minSide < minOutSide) {
          const s = minOutSide / minSide;
          targetW = Math.round(targetW * s);
          targetH = Math.round(targetH * s);
        }
        // Never exceed the natural image dimensions — floor applies to downscaling only.
        targetW = Math.max(1, Math.min(targetW, img.naturalWidth));
        targetH = Math.max(1, Math.min(targetH, img.naturalHeight));
      }
      const maxSide = Math.max(targetW, targetH);
      if (maxSide > MAX_SIDE) {
        const scale = MAX_SIDE / maxSide;
        targetW = Math.max(1, Math.round(targetW * scale));
        targetH = Math.max(1, Math.round(targetH * scale));
      }

      const key = getKey(img, targetW, targetH);
      if (!key) continue;
      const spec = computeDrawSpec(img, targetW, targetH);
      const needsResample = !(img.naturalWidth <= targetW * 1.05 && img.naturalHeight <= targetH * 1.05);
      const g = groups.get(key) || {
        key,
        imgs: [],
        maxW: 0,
        maxH: 0,
        needsResample: false,
        isAvatar: false,
        spec,
      };
      g.imgs.push(img);
      g.maxW = Math.max(g.maxW, targetW);
      g.maxH = Math.max(g.maxH, targetH);
      g.needsResample = g.needsResample || needsResample;
      g.isAvatar = g.isAvatar || isAvatar;
      groups.set(key, g);
    } catch {
      // ignore
    }
  }

  const groupList = Array.from(groups.values());
  if (!groupList.length) return () => {};
  const cache = new Map();
  let gi = 0;

  for (const g of groupList) {
    gi += 1;
    if (gi === 1 || gi % 10 === 0 || gi === groupList.length) {
      setMeta(`Downscaling images… ${gi}/${groupList.length}`);
    }
    try {
      const shouldProcess = g.needsResample;
      if (!shouldProcess) continue;
      const rep = g.imgs.find((img) => img?.complete && img.naturalWidth > 0);
      if (!rep) continue;
      const outW = Math.max(1, Math.min(g.maxW, Math.round(g.maxW)));
      const outH = Math.max(1, Math.min(g.maxH, Math.round(g.maxH)));
      const spec = computeDrawSpec(rep, outW, outH);
      const canvas = feProgressiveResampleCanvas(win, rep, spec, outW, outH, {
        maxIntermediateSide: g.isAvatar ? Math.max(2048, Math.min(MAX_SIDE, 3072)) : Math.max(1536, Math.min(MAX_SIDE, 2560)),
      });
      if (!canvas) continue;

      const dataUrl = await feCanvasToDataURL(canvas, {
        webpQuality: g.isAvatar ? avatarWebpQuality : webpQuality,
        jpegQuality: g.isAvatar ? avatarJpegQuality : jpegQuality,
        preferLossless: forceLossless || g.isAvatar || Math.max(outW, outH) <= 224 || (outW * outH) <= 90_000,
        forcePng: forceLossless,
      });
      if (!dataUrl) continue;
      cache.set(g.key, dataUrl);
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // Ignore per-group failures.
    }
    if (gi % 10 === 0) await feNextTick();
  }

  for (const g of groupList) {
    const dataUrl = cache.get(g.key);
    if (!dataUrl) continue;
    for (const img of g.imgs) {
      try {
        changed.push({
          img,
          src: img.getAttribute("src"),
          srcset: img.getAttribute("srcset"),
          loading: img.getAttribute("loading"),
        });
        img.removeAttribute("srcset");
        img.setAttribute("src", dataUrl);
      } catch {}
    }
  }

  return () => {
    for (let i = changed.length - 1; i >= 0; i -= 1) {
      const it = changed[i];
      try {
        if (it.src == null) it.img.removeAttribute("src");
        else it.img.setAttribute("src", it.src);
        if (it.srcset == null) it.img.removeAttribute("srcset");
        else it.img.setAttribute("srcset", it.srcset);
        if (it.loading == null) it.img.removeAttribute("loading");
        else it.img.setAttribute("loading", it.loading);
      } catch {}
    }
  };
}

// ===========================================================================
// Canvas → data-URL encoding
// ===========================================================================

async function feCanvasToDataURL(canvas, { webpQuality = 0.82, jpegQuality = 0.85, preferLossless = false, forcePng = false } = {}) {
  const toBlob = async (type, quality) => {
    try {
      return await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    } catch {
      return null;
    }
  };

  // forcePng: lossless only — never fall back to lossy formats.
  if (forcePng) {
    try {
      const pngBlob = await toBlob("image/png", 1.0);
      if (pngBlob) return await feBlobToDataURL(pngBlob);
    } catch { /* no-op */ }
    try {
      const webpBlob = await toBlob("image/webp", 1.0);
      if (webpBlob) return await feBlobToDataURL(webpBlob);
    } catch { /* no-op */ }
    return null;
  }

  if (preferLossless) {
    try {
      const pngBlob = await toBlob("image/png", 1.0);
      if (pngBlob && pngBlob.size <= 650_000) return await feBlobToDataURL(pngBlob);
    } catch {
      /* no-op */
    }
  }

  // Prefer webp for normal content, but keep quality high in the "품질 우선" path.
  const tryTypes = preferLossless
    ? [
        { type: "image/webp", quality: Math.max(webpQuality, 0.92) },
        { type: "image/jpeg", quality: Math.max(jpegQuality, 0.93) },
        { type: "image/png", quality: 1.0 },
      ]
    : [
        { type: "image/webp", quality: webpQuality },
        { type: "image/jpeg", quality: jpegQuality },
        { type: "image/png", quality: 1.0 },
      ];

  for (const t of tryTypes) {
    try {
      const blob = await toBlob(t.type, t.quality);
      if (!blob) continue;
      return await feBlobToDataURL(blob);
    } catch {}
  }
  return null;
}
