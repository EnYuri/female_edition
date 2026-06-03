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

const clampByte = (v) => Math.max(0, Math.min(255, v));
const clampAlpha = (v) => Math.max(0, Math.min(1, v));

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

  const r = clampByte(Number(m[1]));
  const g = clampByte(Number(m[2]));
  const b = clampByte(Number(m[3]));
  const a = m[4] == null ? 1 : clampAlpha(Number(m[4]));

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
      r: clampByte(r),
      g: clampByte(g),
      b: clampByte(b),
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
    r: Number.isFinite(paperParts[0]) ? clampByte(paperParts[0]) : 245,
    g: Number.isFinite(paperParts[1]) ? clampByte(paperParts[1]) : 239,
    b: Number.isFinite(paperParts[2]) ? clampByte(paperParts[2]) : 229,
  };
  const paperAlpha = (() => {
    const a = Number(String(rootCS.getPropertyValue("--fe-paper-alpha") || "0.42").trim());
    return Number.isFinite(a) ? clampAlpha(a) : 0.42;
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
        const tintAlpha = Number.isFinite(alphaRaw) ? clampAlpha(alphaRaw) : 0.22;
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

// P5: high-quality, off-thread resample via createImageBitmap.
//   createImageBitmap(img, sx,sy,sw,sh, { resizeWidth, resizeHeight, resizeQuality })
// crops the source rect then resamples to the destination size on a worker
// thread, returning an ImageBitmap we draw once (1:1) at the destination offset
// and close() immediately — deterministic memory release, no progressive canvas
// chain, less main-thread jank. Honors the same {fit,position} draw spec:
//   · contain → bitmap is dw×dh, drawn at (dx,dy) with transparent letterbox
//   · cover   → source pre-cropped to (sx,sy,sw,sh), bitmap fills outW×outH
//   · fill    → bitmap is outW×outH at (0,0)
// Returns null when unsupported or on any failure (e.g. tainted cross-origin
// sources, older engines) so the caller can fall back to the canvas path.
async function feResampleViaImageBitmap(win, img, spec, outW, outH) {
  const doc = win?.document;
  if (!doc || !img || !spec) return null;
  if (typeof win.createImageBitmap !== "function") return null;

  const sx = Math.max(0, Math.round(spec.sx) || 0);
  const sy = Math.max(0, Math.round(spec.sy) || 0);
  const sw = Math.max(1, Math.round(spec.sw) || 1);
  const sh = Math.max(1, Math.round(spec.sh) || 1);
  const dw = Math.max(1, Math.round(spec.dw) || 1);
  const dh = Math.max(1, Math.round(spec.dh) || 1);

  let bitmap = null;
  try {
    bitmap = await win.createImageBitmap(img, sx, sy, sw, sh, {
      resizeWidth: dw,
      resizeHeight: dh,
      resizeQuality: "high",
    });
    const out = feCreateArchiveCanvas(doc, outW, outH);
    const octx = out.getContext("2d", { alpha: true });
    if (!octx) return null;
    feEnableHighQualitySmoothing(octx);
    octx.clearRect(0, 0, outW, outH);
    // Draw at the bitmap's natural size (dw×dh) at the destination offset — the
    // resize already happened off-thread, so no further scaling here.
    octx.drawImage(bitmap, Math.round(spec.dx) || 0, Math.round(spec.dy) || 0);
    return out;
  } catch {
    return null;
  } finally {
    try { bitmap?.close?.(); } catch {}
  }
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
    // Avatars/portraits: small images don't need extreme quality. Higher caps
    // and qualities here multiplied data size with little visible benefit.
    avatarDprCap = 1.5,
    avatarMinDpr = 1.0,
    avatarWebpQuality = 0.80,
    avatarJpegQuality = 0.82,
    maxSide = 1600,
    forceLossless = false,
    minOutSide = 1,
    // When true, encoded image bytes are exposed as blob: URLs instead of
    // data: URLs. Saves ~33% memory plus V8 string overhead — img.src holds
    // a short blob: reference and the bytes live in the URL registry once.
    // Caller must call the returned restore() to revoke the URLs.
    useBlobURL = false,
    // Parallel encode batch size. Each in-flight group holds a decoded source
    // bitmap + output canvas (+ progressive intermediates), so lowering this
    // for huge logs directly cuts peak downscale memory at a small time cost.
    concurrency = 6,
    // Upper bound for the progressive-resample seed canvas. 0 = use per-group
    // defaults. Lowering it trims intermediate-canvas memory on huge logs.
    intermediateCap = 0,
    // Cap on total encoded output bytes. 0 = unlimited (print path). Used by the
    // HTML-embed path so downscaled data: URLs can't balloon the saved file:
    // once the budget is spent, remaining groups keep their original src.
    maxTotalBytes = 0,
    // Optional out-param object: on completion, `stats.bytesUsed` is set to the
    // total encoded output bytes produced. Lets the HTML-embed caller charge the
    // remaining embed budget against what downscaling already spent (shared cap).
    stats = null,
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

  // Snap a pixel size up to the next power of 2 (capped to MAX_SIDE). Used to
  // bucket display sizes so minor render-size differences (47/49) collapse into
  // the same group, while dramatically different sizes (48 vs 200) stay separate.
  const bucketSize = (n) => {
    const v = Math.max(1, Math.round(Number(n) || 1));
    if (v <= 1) return 1;
    const p = Math.ceil(Math.log2(v));
    return Math.min(MAX_SIDE, 1 << p);
  };

  // Conservative ceiling-bucketing for non-avatar images. Catches near-duplicate
  // render sizes (e.g., 47/48 from layout rounding) while keeping aspect drift
  // bounded under ~4.6%. Step grows logarithmically with size; tiny icons (≤32px)
  // stay exact since the dedup payoff is negligible vs distortion risk.
  // Always rounds UP so canvas size ≥ rendered display size (no upscale blur).
  const bucketSizeFine = (n) => {
    const v = Math.max(1, Math.round(Number(n) || 1));
    if (v <= 32) return v;
    let step;
    if (v <= 64) step = 2;          // 33-64: ≤3.0% drift
    else if (v <= 256) step = 4;    // 65-256: ≤4.6% drift
    else if (v <= 1024) step = 8;   // 257-1024: ≤2.7% drift
    else step = 16;                  // >1024: ≤1.5% drift
    return Math.min(MAX_SIDE, Math.ceil(v / step) * step);
  };

  const getKey = (img, targetW, targetH) => {
    try {
      const src = img.currentSrc || img.src || img.getAttribute("src") || "";
      if (!src) return "";
      const spec = computeDrawSpec(img, targetW, targetH);
      if (isAvatarImage(img)) {
        // Cross-message dedup with size bucketing: avatars sharing src + fit +
        // position + size-bucket reuse one canvas. Keeps small instances small
        // while a single large instance doesn't bloat all sibling instances.
        return ["avatar", src, bucketSize(targetW), bucketSize(targetH), spec.fit, spec.position].join("@@");
      }
      // Non-avatar: fine-grained bucketing collapses near-identical sizes into
      // shared encodings. g.maxW / g.maxH still uses raw targets so the canvas
      // is sized to the largest actual member, never to the inflated bucket value.
      return [src, bucketSizeFine(targetW), bucketSizeFine(targetH), spec.fit, spec.position, "img"].join("@@");
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
  const createdBlobURLs = useBlobURL ? new Set() : null;
  const winURL = (win && win.URL) || URL;
  let totalEncodedBytes = 0;

  // Swap a group's <img> elements to the downscaled URL immediately after that
  // group is encoded — not in a final pass. Releasing each original src as soon
  // as its replacement is ready lets Chromium free the full-resolution decoded
  // bitmap progressively, so peak memory declines through the run instead of
  // staying pinned at "all originals decoded" until the very end.
  const swapGroup = (g, imageUrl) => {
    for (const img of g.imgs) {
      try {
        const origSrc = img.getAttribute("src");
        changed.push({
          img,
          src: origSrc,
          srcset: img.getAttribute("srcset"),
          loading: img.getAttribute("loading"),
        });
        // Stash the original src so the HTML-snapshot path (which can run while
        // blob: URLs are still live) can revert before serialization — the
        // closure's `changed` array is not visible to that path; the dataset is.
        if (useBlobURL && origSrc != null) {
          try { img.dataset.fePrintOrigSrc = origSrc; } catch {}
        }
        img.removeAttribute("srcset");
        img.setAttribute("src", imageUrl);
      } catch {}
    }
  };

  // Process groups in parallel batches so multiple canvas.toBlob() calls are
  // in-flight simultaneously. Chromium encodes blobs on a worker thread, so
  // N parallel encodes take roughly max(individual times) instead of sum.
  // Caller may lower this for huge logs to cap peak memory.
  const ENCODE_CONCURRENCY = Math.max(1, Number(concurrency) || 6);

  const processGroup = async (g) => {
    try {
      if (!g.needsResample) return;
      const rep = g.imgs.find((img) => img?.complete && img.naturalWidth > 0);
      if (!rep) return;
      // Budget spent (HTML-embed path) → skip before the (expensive) resample,
      // leaving this group at its original src.
      if (maxTotalBytes > 0 && totalEncodedBytes >= maxTotalBytes) return;
      const outW = Math.max(1, Math.min(g.maxW, Math.round(g.maxW)));
      const outH = Math.max(1, Math.min(g.maxH, Math.round(g.maxH)));
      const spec = computeDrawSpec(rep, outW, outH);
      // P5: prefer createImageBitmap's off-thread high-quality resize; fall back
      // to the progressive canvas halving when unavailable or on failure.
      let canvas = await feResampleViaImageBitmap(win, rep, spec, outW, outH);
      if (!canvas) {
        const baseIntermediate = g.isAvatar ? Math.max(2048, Math.min(MAX_SIDE, 3072)) : Math.max(1536, Math.min(MAX_SIDE, 2560));
        canvas = feProgressiveResampleCanvas(win, rep, spec, outW, outH, {
          maxIntermediateSide: intermediateCap > 0 ? Math.min(baseIntermediate, intermediateCap) : baseIntermediate,
        });
      }
      if (!canvas) return;
      const encodeOpts = {
        webpQuality: g.isAvatar ? avatarWebpQuality : webpQuality,
        jpegQuality: g.isAvatar ? avatarJpegQuality : jpegQuality,
        preferLossless: forceLossless || (Math.max(outW, outH) <= 96 && (outW * outH) <= 9216),
        forcePng: forceLossless,
      };
      let imageUrl = null;
      let approxBytes = 0;
      if (useBlobURL) {
        const blob = await feEncodeCanvasToBlob(canvas, encodeOpts);
        if (blob) {
          imageUrl = winURL.createObjectURL(blob);
          createdBlobURLs.add(imageUrl);
          approxBytes = blob.size || 0;
        }
      } else {
        imageUrl = await feCanvasToDataURL(canvas, encodeOpts);
        // base64 data: URL ≈ 4/3 of the binary it encodes.
        approxBytes = imageUrl ? Math.ceil(imageUrl.length * 0.75) : 0;
      }
      canvas.width = 0;
      canvas.height = 0;
      if (!imageUrl) return;
      totalEncodedBytes += approxBytes;
      // Swap + release this group's originals right away (see swapGroup).
      swapGroup(g, imageUrl);
    } catch {
      // Ignore per-group failures.
    }
  };

  for (let start = 0; start < groupList.length; start += ENCODE_CONCURRENCY) {
    const batch = groupList.slice(start, start + ENCODE_CONCURRENCY);
    await Promise.all(batch.map(processGroup));
    const gi = Math.min(start + ENCODE_CONCURRENCY, groupList.length);
    setMeta(`Downscaling images… ${gi}/${groupList.length}`);
    await feNextTick();
  }

  if (stats) stats.bytesUsed = totalEncodedBytes;

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
        try { delete it.img.dataset.fePrintOrigSrc; } catch {}
      } catch {}
    }
    // Revoke after src has been reverted so no img is referencing a stale URL.
    if (createdBlobURLs) {
      for (const url of createdBlobURLs) {
        try { winURL.revokeObjectURL(url); } catch {}
      }
      createdBlobURLs.clear();
    }
  };
}

// ===========================================================================
// Canvas → data-URL encoding
// ===========================================================================

async function feEncodeCanvasToBlob(canvas, { webpQuality = 0.82, jpegQuality = 0.85, preferLossless = false, forcePng = false } = {}) {
  const toBlob = async (type, quality) => {
    try {
      return await new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    } catch {
      return null;
    }
  };

  // forcePng: lossless only — never fall back to lossy formats.
  if (forcePng) {
    const pngBlob = await toBlob("image/png", 1.0);
    if (pngBlob) return pngBlob;
    const webpBlob = await toBlob("image/webp", 1.0);
    if (webpBlob) return webpBlob;
    return null;
  }

  if (preferLossless) {
    const pngBlob = await toBlob("image/png", 1.0);
    if (pngBlob && pngBlob.size <= 650_000) return pngBlob;
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
    const blob = await toBlob(t.type, t.quality);
    if (blob) return blob;
  }
  return null;
}

async function feCanvasToDataURL(canvas, options) {
  try {
    const blob = await feEncodeCanvasToBlob(canvas, options);
    if (!blob) return null;
    return await feBlobToDataURL(blob);
  } catch {
    return null;
  }
}
