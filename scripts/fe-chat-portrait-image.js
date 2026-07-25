/**
 * fe-chat-portrait-image.js — Portrait image resampling engine
 *
 * Self-contained high-quality canvas downscale subsystem extracted from
 * fe-chat-portrait.js. Takes an <img> + target size/shape and produces a crisp,
 * device-pixel-sized data: URL, cached (LRU) per src+size+fit and de-duplicated
 * while in flight. Pure pipeline — no settings, no hooks, no shared module state
 * beyond its own caches.
 *
 * Parallel in spirit to fe-archive-image.js (the archive's canvas downscale).
 *
 * Public surface (imported by fe-chat-portrait.js):
 *   - cpMaybeApplyHQResample(img, size, shape, anchorTop) — fire-and-forget swap
 *   - cpShouldUseHQResample(img)                          — per-document policy
 *   - cpResampleCacheGet(key)                             — synchronous cache peek
 */

// Cross-window safe DOM checks (avoid instanceof across Window realms). Defined
// privately here too — the same tiny utils live in fe-chat-portrait.js, mirroring
// the archive modules' "feNextTick defined privately in both files" pattern. Do
// not merge them across a module boundary (would introduce a circular import).
function cpIsElement(node) {
  return !!node && node.nodeType === 1;
}

function cpIsImageElement(node) {
  return cpIsElement(node) && String(node.tagName || "").toUpperCase() === "IMG";
}

// Maximum number of entries kept in the HQ-resample cache.
// Each entry holds a data: URL (~5–30 KB for a 64px portrait), so 200 entries
// caps memory at roughly 1–6 MB — safe even in long sessions with many actors.
const CP_RESAMPLE_CACHE_MAX = 200;

// Cache for high-quality downscaled portraits (per src+size+fit) — LRU-capped.
// Implemented as an insertion-order Map; on overflow the oldest entry is evicted.
const _cpResampleCache = new Map();

function cpResampleCacheSet(key, value) {
  if (_cpResampleCache.has(key)) _cpResampleCache.delete(key); // refresh position
  _cpResampleCache.set(key, value);
  if (_cpResampleCache.size > CP_RESAMPLE_CACHE_MAX) {
    // Evict the oldest (first) entry.
    _cpResampleCache.delete(_cpResampleCache.keys().next().value);
  }
}

function cpResampleCacheGet(key) {
  const value = _cpResampleCache.get(key);
  if (value === undefined) return undefined;
  // Move to end (most-recently-used).
  _cpResampleCache.delete(key);
  _cpResampleCache.set(key, value);
  return value;
}

// Track in-flight resample promises to avoid duplicating work
const _cpResampleInflight = new Map();

function cpIsSafeCanvasSource(src) {
  try {
    if (!src) return false;
    const s = String(src);
    // Already processed or ephemeral.
    if (s.startsWith("data:") || s.startsWith("blob:")) return false;
    // SVG portraits are better left untouched (rasterization quality differs and can be inconsistent).
    if (/\.svg(\?.*)?$/i.test(s)) return false;

    const url = new URL(s, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    // If URL parsing fails, assume it's a relative/local path.
    return true;
  }
}

async function cpWaitForImage(img) {
  try {
    if (!img) return false;
    if (img.complete && img.naturalWidth > 0) return true;

    if (typeof img.decode === "function") {
      try {
        await img.decode();
        if (img.complete && img.naturalWidth > 0) return true;
      } catch {
        // fall back to onload
      }
    }

    await new Promise((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        resolve(true);
      };
      const onErr = () => {
        cleanup();
        reject(new Error("image load failed"));
      };
      const cleanup = () => {
        img.removeEventListener?.("load", onLoad);
        img.removeEventListener?.("error", onErr);
      };
      img.addEventListener?.("load", onLoad, { once: true });
      img.addEventListener?.("error", onErr, { once: true });
    });
    return img.complete && img.naturalWidth > 0;
  } catch {
    return false;
  }
}

function cpComputeDrawRect({
  srcW,
  srcH,
  dstSize,
  fit = "cover", // "cover" | "contain"
}) {
  const w = Math.max(1, Number(srcW) || 1);
  const h = Math.max(1, Number(srcH) || 1);
  const s = Math.max(1, Number(dstSize) || 1);

  const scale = fit === "contain" ? Math.min(s / w, s / h) : Math.max(s / w, s / h);
  const dw = w * scale;
  const dh = h * scale;
  // For "contain" mode, keep the artwork left-aligned so any empty space remains
  // on the right only (user-requested behavior). Vertical centering is preserved.
  const dx = fit === "contain" ? 0 : (s - dw) / 2;
  const dy = (s - dh) / 2;
  return { dx, dy, dw, dh };
}

function cpComputeSourceCrop({ srcW, srcH, fit = "cover", anchorTop = false }) {
  // Compute a source rectangle (sx,sy,sw,sh) for drawing into a square destination.
  // - cover: crop to a square (horizontal centered). Vertically: top-anchored when
  //   `anchorTop` (preserve head, crop the bottom — used for CHAT portraits so a tall
  //   full-body image keeps the head), otherwise centered (combat tracker keeps its
  //   original centered crop).
  // - contain: use full image
  const w = Math.max(1, Number(srcW) || 1);
  const h = Math.max(1, Number(srcH) || 1);

  if (fit === "contain") return { sx: 0, sy: 0, sw: w, sh: h };

  // cover: crop to square by taking the min dimension.
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = anchorTop ? 0 : (h - side) / 2;
  return { sx, sy, sw: side, sh: side };
}

function cpDownscaleCanvasStep(srcCanvas, dstW, dstH) {
  const next = document.createElement("canvas");
  next.width = dstW;
  next.height = dstH;
  const ctx = next.getContext("2d");
  if (!ctx) return next;
  ctx.imageSmoothingEnabled = true;
  try {
    ctx.imageSmoothingQuality = "high";
  } catch {
    /* ignore */
  }
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, dstW, dstH);
  return next;
}

async function cpResampleToDataURL(img, size, fit, anchorTop = false) {
  const ok = await cpWaitForImage(img);
  if (!ok) return null;

  const nw = Number(img.naturalWidth || 0);
  const nh = Number(img.naturalHeight || 0);
  if (!nw || !nh) return null;

  // Resample to DEVICE pixels, not CSS px. The <img> displays at `size` CSS px,
  // so a bitmap at size×dpr maps 1:1 to device pixels → crisp on HiDPI (dpr>1)
  // instead of being upscaled (soft). At dpr=1 this is identical to `size`.
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const target = Math.max(1, Math.round(size * dpr));

  // Only resample when we are actually downscaling.
  if (nw <= target && nh <= target) return null;

  try {
    // Multi-step downscale for better quality (especially from very large portraits).
    // Step 1: crop (cover) or keep full (contain) into a working canvas.
    const { sx, sy, sw, sh } = cpComputeSourceCrop({ srcW: nw, srcH: nh, fit, anchorTop });

    let work = document.createElement("canvas");
    work.width = Math.max(1, Math.floor(sw));
    work.height = Math.max(1, Math.floor(sh));
    let wctx = work.getContext("2d");
    if (!wctx) return null;
    wctx.imageSmoothingEnabled = true;
    try {
      wctx.imageSmoothingQuality = "high";
    } catch {
      /* ignore */
    }
    wctx.drawImage(img, sx, sy, sw, sh, 0, 0, work.width, work.height);

    // Step 2: repeatedly half until close to target.
    while (work.width / 2 > target) {
      const nextW = Math.max(target, Math.floor(work.width / 2));
      const nextH = Math.max(target, Math.floor(work.height / 2));
      work = cpDownscaleCanvasStep(work, nextW, nextH);
    }

    // Step 3: final draw into a square destination canvas (device-pixel sized).
    const out = document.createElement("canvas");
    out.width = target;
    out.height = target;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    try {
      octx.imageSmoothingQuality = "high";
    } catch {
      /* ignore */
    }

    const { dx, dy, dw, dh } = cpComputeDrawRect({ srcW: sw, srcH: sh, dstSize: target, fit });
    octx.clearRect(0, 0, target, target);
    octx.drawImage(work, 0, 0, work.width, work.height, dx, dy, dw, dh);

    return out.toDataURL("image/png");
  } catch {
    // Tainted canvas or unsupported draw.
    return null;
  }
}

function cpMaybeApplyHQResample(img, size, shape, anchorTop = false) {
  try {
    if (!cpIsImageElement(img)) return;
    if (!size || size <= 0) return;
    if (size > 256) return; // sanity cap
    if (!cpShouldUseHQResample(img)) return;

    const origSrc = img.dataset?.fePortraitOrigSrc;
    const key = img.dataset?.fePortraitResampleKey;
    if (!origSrc || !key) return;
    if (!cpIsSafeCanvasSource(origSrc)) return;

    const cached = cpResampleCacheGet(key);
    if (cached) {
      if (img.src !== cached) img.src = cached;
      return;
    }

    if (_cpResampleInflight.has(key)) return;

    const fit = String(shape) === "none" ? "contain" : "cover";

    const p = (async () => {
      const dataUrl = await cpResampleToDataURL(img, size, fit, anchorTop);
      return dataUrl;
    })();

    _cpResampleInflight.set(key, p);

    p.then((dataUrl) => {
      _cpResampleInflight.delete(key);
      if (!dataUrl) return;
      cpResampleCacheSet(key, dataUrl);
      // Only apply if this image still refers to the same request.
      if (img.dataset?.fePortraitResampleKey === key) {
        img.src = dataUrl;
      }
    }).catch(() => {
      _cpResampleInflight.delete(key);
    });
  } catch {
    /* no-op */
  }
}

function cpShouldUseHQResample(img) {
  try {
    const body = img?.ownerDocument?.body;

    // Keep print/PDF documents on the original sources to avoid a large number of
    // extra data: URLs during final export. (Checked first: takes precedence even
    // if an archive doc is being printed.)
    if (body?.classList?.contains("fe-print-chatlog")) return false;

    // HQ resample is only worthwhile in the archive/export window, where low-resolution
    // PC portraits are enlarged and a one-time high-quality downscale (shared via cache)
    // visibly helps. The live sidebar and combat tracker display at ~64px where the
    // browser's native downscale is already crisp — resampling there spends async work +
    // cache for no visible gain, so it is intentionally skipped (verified live: dpr=1,
    // 64px sidebar portraits are indistinguishable with/without the swap).
    return !!body?.classList?.contains("fe-chat-archive");
  } catch {
    return false;
  }
}

export { cpMaybeApplyHQResample, cpShouldUseHQResample, cpResampleCacheGet };
