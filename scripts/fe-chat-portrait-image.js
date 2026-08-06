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
 *   - cpShouldUseHQResample(img, shape)                   — per-document/shape policy
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

// Vector sources. They are excluded from every canvas pass (rasterization quality
// differs and can be inconsistent), but the EXPORT path has to tell them apart from a
// genuinely unusable source: a vector file is the one thing that survives print DPI
// untouched, so it must be pinned to its original rather than handed to the avatar
// downscaler — which would rasterize it at ~96px. Foundry's default speaker art
// (`icons/svg/mystery-man.svg`) lands here, i.e. exactly the actors with no portrait
// of their own.
function cpIsVectorSource(src) {
  try {
    return /\.svgz?(\?.*)?$/i.test(String(src ?? ""));
  } catch {
    return false;
  }
}

function cpIsSafeCanvasSource(src) {
  try {
    if (!src) return false;
    const s = String(src);
    // Already processed or ephemeral.
    if (s.startsWith("data:") || s.startsWith("blob:")) return false;
    if (cpIsVectorSource(s)) return false;

    const url = new URL(s, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    // If URL parsing fails, assume it's a relative/local path.
    return true;
  }
}

// Hard ceiling on the load/decode wait. MUST stay: a `loading="lazy"` <img> that
// Chromium has DEFERRED reports `complete === false` with a valid `naturalWidth`
// (the dimensions come from the partial fetch), never fires `load`, and makes
// `decode()` hang FOREVER — measured live on v14.365, every off-viewport chat
// portrait. Without a timeout the resample promise never settles, so its key stays
// in `_cpResampleInflight` and every later call for that portrait early-returns —
// a permanent per-key deadlock that silently disabled HQ resampling in live chat.
const CP_IMAGE_WAIT_TIMEOUT_MS = 10000;

// Shorter ceiling for the EXPORT probe. The 10 s above is sized for the lazy-deferral
// quirk on in-document portraits; an export probe is a detached, eager <img> that has
// none of it, so the only thing a long wait buys there is a dead path stalling an
// export the user is sitting in front of.
const CP_EXPORT_IMAGE_WAIT_TIMEOUT_MS = 5000;

async function cpWaitForImage(img, timeoutMs = CP_IMAGE_WAIT_TIMEOUT_MS) {
  try {
    if (!img) return false;
    if (img.complete && img.naturalWidth > 0) return true;

    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, Number(timeoutMs) || CP_IMAGE_WAIT_TIMEOUT_MS));
    });

    const wait = (async () => {
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
    })().catch(() => false);

    try {
      return await Promise.race([wait, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
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

// Drop a canvas' backing store immediately instead of waiting for GC. A single
// full-resolution portrait step can hold tens of MB; without this the whole
// halving chain stays resident until the next collection, which is what makes a
// burst of resamples feel like a stall rather than a blip.
function cpReleaseCanvas(canvas) {
  try {
    if (!canvas) return;
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    /* ignore */
  }
}

// Resample jobs are synchronous main-thread work, so a burst — a chat-log render,
// or a scroll revealing a batch of lazy-deferred portraits — used to run as one
// uninterrupted block with no frame in between.
//
// MEASURED (Chrome 150, dpr 1, 64px target, 832x1216 sources, synthetic rig):
//   halving ladder      ~0.4 ms   <- negligible
//   toDataURL("png")    ~3.8 ms   <- DOMINATES; ~3.8/4.2 of the per-portrait cost
//   burst of 12         ~73 ms in one block (~250 ms for 20 cold-decoded sources)
//
// So the fix is NOT to make each job cheaper (there is little left to win: toBlob +
// webp measured 2.4 ms, and buying ~1.4 ms is not worth blob-URL lifetime/eviction
// and cross-window risk against the archive). The fix is to stop the burst from
// landing in one block.
//
// Time-SLICED, not one-yield-per-job: at ~4 ms each, yielding before every job would
// add an idle round-trip per portrait for no benefit. Jobs run back-to-back until the
// slice budget is spent (about half a 60 Hz frame — one in-flight job can overrun it
// by its own duration, which still lands under 16.7 ms), then the queue yields.
// `requestIdleCallback`'s timeout bounds the wait so the queue cannot starve.
const CP_QUEUE_SLICE_MS = 8;
const CP_QUEUE_YIELD_TIMEOUT_MS = 100;

const _cpQueue = [];
let _cpQueueDraining = false;

function cpYieldToBrowser() {
  return new Promise((resolve) => {
    try {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: CP_QUEUE_YIELD_TIMEOUT_MS });
        return;
      }
    } catch {
      /* fall through */
    }
    setTimeout(resolve, 0);
  });
}

function cpNow() {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

async function cpDrainResampleQueue() {
  try {
    while (_cpQueue.length) {
      const sliceStart = cpNow();
      while (_cpQueue.length && cpNow() - sliceStart < CP_QUEUE_SLICE_MS) {
        const entry = _cpQueue.shift();
        try {
          entry.resolve(await entry.job());
        } catch (err) {
          entry.reject(err);
        }
      }
      if (_cpQueue.length) await cpYieldToBrowser();
    }
  } finally {
    _cpQueueDraining = false;
  }
}

function cpEnqueueResample(job) {
  return new Promise((resolve, reject) => {
    _cpQueue.push({ job, resolve, reject });
    if (_cpQueueDraining) return;
    _cpQueueDraining = true;
    // Start on a microtask so a synchronous caller finishes claiming its in-flight
    // slot before the first job can run.
    Promise.resolve()
      .then(cpDrainResampleQueue)
      .catch(() => {
        _cpQueueDraining = false;
      });
  });
}

// Resample to DEVICE pixels, not CSS px. The <img> displays at `size` CSS px, so a
// bitmap at size×dpr maps 1:1 to device pixels → crisp on HiDPI (dpr>1) instead of
// being upscaled (soft). At dpr=1 this is identical to `size`.
function cpTargetPixels(size) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  return Math.max(1, Math.round(Number(size) * dpr));
}

/**
 * True when running the pipeline could not possibly improve on what the browser
 * already paints, so the whole job (canvas ladder + ~3.8 ms toDataURL) is waste.
 *
 * The pipeline exists for exactly ONE reason: Chromium drops to a low-quality filter
 * when `object-fit: cover` draws the bitmap LARGER than the element box and clips it
 * (see the HQ-resample policy in CLAUDE.md). Two cases provably never reach that path:
 *
 *  - Nothing to downscale (source already at/below the device-pixel target).
 *  - `cover` with a SQUARE source. Our box is square (cpApplyImgStyling sets width ===
 *    height), so cover's scale is `max(s/w, s/h)` with `w === h` → the drawn bitmap is
 *    an EXACT fit, nothing overflows, and Chromium keeps the properly box-filtered
 *    path. This is the `sq cover` ✅ / `sq cover+clip` ✅ row of the recorded probe
 *    matrix, and it matters in practice because Foundry token art is typically square.
 *
 * Deliberately NOT applied in the archive window: its branch in cpShouldUseHQResample
 * is unconditional for a separate reason, and that path was only just repaired — it is
 * not being re-tuned in the same breath on reasoning alone.
 */
function cpResampleIsPointless(img, size, fit) {
  try {
    const body = img?.ownerDocument?.body;
    if (body?.classList?.contains("fe-chat-archive")) return false;

    const nw = Number(img.naturalWidth || 0);
    const nh = Number(img.naturalHeight || 0);
    if (!nw || !nh) return false;

    const target = cpTargetPixels(size);
    if (nw <= target && nh <= target) return true;
    if (String(fit) === "cover" && nw === nh) return true;
    return false;
  } catch {
    return false;
  }
}

// `targetPx` (0 = off) bypasses the CSS-size × dpr calculation entirely, and
// `mimeType`/`quality` override the encoder. Both exist for the export path, which
// needs a bitmap sized for PRINT/zoom rather than for this machine's screen, and which
// pays for that size in file bytes — see cpBuildExportPortrait. The live path
// passes neither and is unchanged: screen-sized, lossless PNG.
async function cpResampleToDataURL(
  img,
  size,
  fit,
  anchorTop = false,
  { targetPx: targetOverride = 0, mimeType = "image/png", quality } = {}
) {
  const ok = await cpWaitForImage(img);
  if (!ok) return null;

  const nw = Number(img.naturalWidth || 0);
  const nh = Number(img.naturalHeight || 0);
  if (!nw || !nh) return null;

  const target = targetOverride > 0 ? Math.max(1, Math.round(targetOverride)) : cpTargetPixels(size);

  // Only resample when we are actually downscaling.
  if (nw <= target && nh <= target) return null;

  let work = null;
  let out = null;
  try {
    const { sx, sy, sw, sh } = cpComputeSourceCrop({ srcW: nw, srcH: nh, fit, anchorTop });

    // Plan the halving chain BEFORE allocating anything.
    //
    // The quality requirement is only that no single reduction exceeds 2:1 (a larger
    // ratio is where Chromium's filter degrades — see CLAUDE.md). The old code met it
    // by copying the source rect 1:1 into a work canvas and halving from there, but
    // that first copy is pure waste: for a 3328px portrait it allocates 3328x3328 px
    // (~44 MB) and does a full-resolution draw, per portrait, on the main thread.
    // Starting the chain at HALF the source is the same <=2:1 first reduction — the
    // browser just performs it straight out of the decoded <img> — while cutting the
    // peak allocation 4x and removing one full-size draw entirely.
    // Bound the ladder on the LARGER dimension, and never clamp the smaller one to
    // `target`. The old loop tested `work.width` alone and clamped both next dims with
    // `Math.max(target, …)`, which for "자르기 없음" (contain, non-square source) was
    // wrong in both directions: a TALL portrait stopped a step early (final canvas→canvas
    // draw up to ~2.4:1 instead of ≤2:1), and a WIDE one had its height floored at
    // `target` mid-ladder — e.g. 4000×1000 became a 250×128 work canvas holding a
    // vertically stretched image, so the final compose came out at the wrong aspect
    // ratio. For "cover" the crop is square (sw === sh), so this is a no-op there.
    const dims = [];
    let w = Math.max(1, Math.floor(sw));
    let h = Math.max(1, Math.floor(sh));
    while (Math.floor(Math.max(w, h) / 2) >= target) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      dims.push([w, h]);
    }

    for (const [stepW, stepH] of dims) {
      const next = document.createElement("canvas");
      next.width = stepW;
      next.height = stepH;
      const ctx = next.getContext("2d");
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      try {
        ctx.imageSmoothingQuality = "high";
      } catch {
        /* ignore */
      }
      if (work) ctx.drawImage(work, 0, 0, work.width, work.height, 0, 0, stepW, stepH);
      else ctx.drawImage(img, sx, sy, sw, sh, 0, 0, stepW, stepH);
      cpReleaseCanvas(work);
      work = next;
    }

    // Final draw into a square destination canvas (device-pixel sized).
    out = document.createElement("canvas");
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
    // `dims` is empty when the source is already within 2x of the target — then the
    // single draw straight from the <img> is both the reduction and the final compose.
    if (work) octx.drawImage(work, 0, 0, work.width, work.height, dx, dy, dw, dh);
    else octx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);

    return out.toDataURL(mimeType, quality);
  } catch {
    // Tainted canvas or unsupported draw.
    return null;
  } finally {
    cpReleaseCanvas(work);
    cpReleaseCanvas(out);
  }
}

function cpMaybeApplyHQResample(img, size, shape, anchorTop = false) {
  try {
    if (!cpIsImageElement(img)) return;
    // An element the EXPORT pass already resolved is OFF-LIMITS. `feUpgradePortraitsForExport`
    // puts a targetPx (256) bitmap — or the pinned original file — into `src` and marks it,
    // while this function's answer is the 64px SCREEN bitmap. Re-applying that here is a pure
    // 4x downgrade of a portrait that is about to be printed.
    //
    // Measured live 2026-08-07 on v14: after the export pass, calling this on the archive log
    // took 48/48 portraits from 256x256 back to 64x64. That is the whole of the reported
    // "아카이브 PDF에서 일부 포트레이트만 저해상도" — and it presents as "일부" only because
    // the two passes RACE: `feNormalizeArchivePortraitImages` enqueues the HQ jobs during
    // render and `feUpgradePortraitsForExport` awaits network fetches, so which one lands
    // last varies per source (a big source decodes slower and lands after ⇒ that speaker is
    // the one that comes out blurry). It correlates with an actor's art, never with ownership.
    if (img.dataset?.feExportPortrait === "1") return;
    if (!size || size <= 0) return;
    if (size > 256) return; // sanity cap
    if (!cpShouldUseHQResample(img, shape)) return;

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

    // Decided BEFORE the deferral guard below, on purpose.
    //
    // It needs only `naturalWidth`/`naturalHeight`, and those are already valid while
    // Chromium has a lazy image DEFERRED — the dimensions come from the partial fetch
    // (that is the same quirk the deferral guard exists for). When they really are 0 it
    // returns false and falls through to the guard, so nothing is decided on bad data.
    //
    // Measured live 2026-08-04: every portrait still sitting in the deferred state was a
    // 760x760 SQUARE source — i.e. one this function skips anyway. Running the guard
    // first made each of them register a one-shot `load` listener and carry a
    // `feHqWaiting` marker forever, for a resample that was never going to happen.
    //
    // Cheap arithmetic, and it also ends a repeat cost: the equivalent "nothing to
    // downscale" test inside cpResampleToDataURL returns null, which is never cached, so
    // EVERY later upsert of such a portrait used to re-enqueue a job.
    //
    // No src fix-up on this path: cpUpsertPortrait already put `cached || src` on the
    // element, and we only get here when the cache missed — so `src` is the original
    // path already. (Assigning `img.src = origSrc` would in fact be a real mutation
    // every time, since the property reflects an ABSOLUTE URL while origSrc is the
    // relative one, and the two never compare equal.)
    if (cpResampleIsPointless(img, size, fit)) return;

    // The portrait <img> carries `loading="lazy"`, so an off-viewport one is DEFERRED by
    // Chromium: `complete` stays false, no `load` fires and `decode()` never settles.
    // Starting the resample here would occupy the in-flight slot with a promise that only
    // the timeout can end, and — worse — the image is not decodable yet, so the attempt is
    // wasted. Instead, defer: re-enter once the browser actually loads it (i.e. when the
    // user scrolls it into view). Do NOT "fix" this by forcing `loading="eager"` — that
    // would eagerly fetch every full-resolution source in the whole chat history.
    if (!img.complete || !(img.naturalWidth > 0)) {
      if (!img.dataset.feHqWaiting) {
        img.dataset.feHqWaiting = "1";
        const done = () => {
          delete img.dataset.feHqWaiting;
        };
        const onLoad = () => {
          // Release the flag FIRST, unconditionally. It is the only thing gating a fresh
          // registration, so holding it across a branch that does not resample would wedge
          // this element out of HQ for the rest of the session.
          done();
          // The export pass owns this element right now — the `load` that just fired is
          // almost certainly its own src write. Resampling here would undo the upgrade, but
          // simply consuming the one-shot listener would leave a portrait that never got its
          // screen bitmap parked on the browser-downscaled original after the export undo.
          // Re-arm: the undo restores the previous src, which fires `load` again.
          if (img.dataset?.feExportPortrait === "1") {
            img.addEventListener?.("load", onLoad, { once: true });
            return;
          }
          cpMaybeApplyHQResample(img, size, shape, anchorTop);
        };
        img.addEventListener?.("load", onLoad, { once: true });
        img.addEventListener?.("error", done, { once: true });
      }
      return;
    }

    // Queued, not fired immediately: see cpEnqueueResample. The in-flight slot is
    // still claimed synchronously below, so a queued job is deduped exactly like an
    // already-running one. The `!img.complete` guard above means the job's own
    // cpWaitForImage resolves instantly, so a job can never sit on the queue head
    // waiting for a network fetch.
    const p = cpEnqueueResample(() => cpResampleToDataURL(img, size, fit, anchorTop));

    _cpResampleInflight.set(key, p);

    p.then((dataUrl) => {
      _cpResampleInflight.delete(key);
      if (!dataUrl) return;
      cpResampleCacheSet(key, dataUrl);
      // Repeated, not redundant: this job may have been enqueued BEFORE the export pass
      // marked the element, so the guard at the top of the function saw nothing. Caching
      // the result above is still correct — it is a valid SCREEN bitmap — but applying it
      // to an element the export pass owns would undo the upgrade.
      if (img.dataset?.feExportPortrait === "1") return;
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

function cpShouldUseHQResample(img, shape) {
  try {
    const body = img?.ownerDocument?.body;

    // Archive/export window: portraits are enlarged there, so a one-time high-quality
    // downscale (shared via cache) helps regardless of shape.
    //
    // MUST be checked BEFORE `fe-print-chatlog`: the archive window's body class is built
    // as `… fe-print-chatlog fe-chat-archive fe-chat-archive-window …`
    // (`fe-chat-archive.js`, feBuildArchiveDocument), so it carries BOTH. Testing print
    // first made this branch unreachable and silently disabled HQ resampling in every
    // archive window — the reported "아카이브에서 포트레이트 안티에일리어싱이 안 된다".
    if (body?.classList?.contains("fe-chat-archive")) return true;

    // Genuine print/PDF path only — `feExportChatLogToPDFInline` adds `fe-print-chatlog`
    // to the MAIN document (no `fe-chat-archive`). Keep those on the original sources to
    // avoid a large number of extra data: URLs during the final export.
    if (body?.classList?.contains("fe-print-chatlog")) return false;

    // Live sidebar / combat tracker: needed ONLY for the cropping shapes.
    //
    // Chromium's native <img> downscale is properly box-filtered as long as the drawn
    // bitmap FITS the element box — `object-fit: contain`, and `cover` on a square
    // source, both look correct at 64px. But `cover` on a non-square source draws the
    // bitmap LARGER than the box and clips it, and on that path Chromium drops to a
    // low-quality filter: a large portrait (~1000px) shrunk into a 64px crop comes out
    // visibly aliased/moiré. Measured, not assumed — see CLAUDE.md.
    //
    // `shape` is undefined for callers that have no crop context; treat that as "no".
    return shape != null && String(shape) !== "none";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Export-resolution portraits
// ---------------------------------------------------------------------------

// Keyed by `${origUrl}|${targetPx}|${fit}|${anchorTop}`. Deliberately SEPARATE from
// the LRU above: these bitmaps are several times larger, they are only useful for the
// duration of one export, and mixing them in would evict the live sidebar's cache.
// The export path calls cpClearExportPortraitCache() when it is done.
const _cpExportPortraitCache = new Map();

function cpClearExportPortraitCache() {
  _cpExportPortraitCache.clear();
}

/**
 * How many pixels an export resample may actually ask for, given the source.
 *
 * MUST stay. The "nothing to do" guard inside `cpResampleToDataURL` is
 * `max(nw, nh) <= target`, which is the correct test for **contain** (the whole image
 * is drawn, so the long side is what has to reach the target) but WRONG for **cover**:
 * cover crops to a square on the SHORT side first, so only the short side has to
 * supply the target. A 200x600 source asked for 256 passes that guard — 600 > 256 —
 * and then has its 200px square blown up 1.28x, producing a blurrier AND larger file
 * than the untouched original. Clamping to what the source can actually supply makes
 * the pass a pure downscale in both fits.
 *
 * Returns 0 when the source dimensions are unusable — the caller must bail then, not
 * substitute a default. When the clamp lands on the source's own size,
 * `cpResampleToDataURL` returns null and the caller falls back to embedding the
 * original file, which for a source that small is the cheaper answer anyway.
 */
function cpEffectiveExportTarget(srcW, srcH, fit, targetPx) {
  const nw = Math.floor(Number(srcW) || 0);
  const nh = Math.floor(Number(srcH) || 0);
  if (!(nw > 0) || !(nh > 0)) return 0;
  const target = Math.round(Number(targetPx) || 0);
  if (!(target > 0)) return 0;
  const supplied = fit === "contain" ? Math.max(nw, nh) : Math.min(nw, nh);
  return Math.max(1, Math.min(target, supplied));
}

/**
 * Build a portrait bitmap sized for EXPORT rather than for this screen, and — just as
 * importantly — report WHY when it cannot.
 *
 * Returns:
 *   null                                    — nothing usable (already self-contained,
 *                                             cross-origin, load failure, or the
 *                                             caller's budget is spent).
 *   { dataUrl, srcW, srcH }                 — the upgraded bitmap.
 *   { dataUrl: null, keepOriginal: true }   — the ORIGINAL file is already the best
 *                                             answer; the caller must pin it and keep
 *                                             it out of the avatar downscaler.
 *
 * That third case is not a detail — it is where the "NPC 포트레이트만 저해상도" report
 * came from. Two sources land in it and BOTH used to fall through to a low-resolution
 * ceiling that the large-art portraits never hit:
 *
 *  - A source already at/below the export target (a 256px token art with a 256px
 *    target). `cpResampleToDataURL` correctly refuses to upscale and returns null, so
 *    the portrait stayed unmarked: on the print path `feDownscaleImagesForPrint` then
 *    re-sized it at `cssBox × avatarDpr` (~96px), and on the saved-HTML path
 *    `keepSelfContainedSrc` left the LIVE screen bitmap (64px) in place. Both are
 *    below the source's own resolution, i.e. we threw away pixels we already had.
 *  - A vector source (`icons/svg/mystery-man.svg` and friends). Perfect at any DPI
 *    until something rasterizes it at 96px.
 *
 * Note this can only ever be reached with `max(srcW, srcH) <= targetPx`, so pinning the
 * original is also cheap for the embed budget: for `cover` the bail needs a square
 * source (the crop takes the short side), for `contain` it needs the long side under
 * the target. A tall 200x3000 source still resamples normally.
 *
 * MUST NOT be replaced by reusing the live `src` data URL. That one is `size × dpr`
 * device pixels — a 64x64 PNG on a dpr-1 machine — which is exactly right in the
 * sidebar and visibly blocky the moment it is enlarged: browser zoom, a HiDPI reader,
 * and above all `window.print()`, which rasterizes at print DPI. The saved HTML has to
 * survive all three on machines we know nothing about, so it gets its own, larger
 * resample straight from the ORIGINAL file.
 *
 * Also MUST NOT be replaced by simply embedding the original file and letting CSS
 * scale it: the portrait box is square and applies `object-fit: cover`, so a non-square
 * source is drawn larger than the box and clipped — the Chromium low-quality-filter
 * path this whole module exists to avoid (see CLAUDE.md). Pre-cropping to a square
 * here keeps the good filter AND is far smaller than the untouched source.
 *
 * The `cover` note above is also why "just embed the original" is not the answer for the
 * general case, only for the small-source case: a NON-square original left to CSS is the
 * clipped-downscale path. The pin is safe exactly because a size bail implies a source
 * the crop would not have shrunk anyway.
 */
async function cpBuildExportPortrait(
  origUrl,
  {
    targetPx = 256,
    fit = "cover",
    anchorTop = false,
    mimeType = "image/webp",
    quality = 0.92,
    cachedOnly = false,
  } = {}
) {
  try {
    if (!origUrl) return null;
    // Before the safe-source test, which lumps vectors in with data:/blob:/cross-origin.
    // Not cached: it is a regex, and it never starts any work.
    if (cpIsVectorSource(origUrl)) return { dataUrl: null, srcW: 0, srcH: 0, keepOriginal: true };
    if (!cpIsSafeCanvasSource(origUrl)) return null;
    const target = Math.max(1, Math.round(targetPx));
    const key = `${origUrl}|${target}|${fit}|${anchorTop ? 1 : 0}|${mimeType}|${quality}`;
    if (_cpExportPortraitCache.has(key)) return _cpExportPortraitCache.get(key);
    // The caller has spent its time budget and will not start new work — but a source
    // it already paid for is free, so it keeps asking with this flag set.
    if (cachedOnly) return null;

    const promise = (async () => {
      // A detached <img> — never `loading="lazy"`, so none of the deferral quirks that
      // plague the in-document portraits apply and cpWaitForImage settles normally.
      const probe = new Image();
      // "async", NOT "sync". These probes are fetched several at a time and each one is
      // a full-resolution source (10+ megapixels is normal for portrait art); a sync
      // hint pulls that decode onto the main thread, which is the one place it must not
      // be during an export the user is watching.
      try { probe.decoding = "async"; } catch { /* ignore */ }
      probe.src = new URL(origUrl, window.location.href).href;
      const ok = await cpWaitForImage(probe, CP_EXPORT_IMAGE_WAIT_TIMEOUT_MS);
      if (!ok) return null;

      const srcW = Math.floor(Number(probe.naturalWidth) || 0);
      const srcH = Math.floor(Number(probe.naturalHeight) || 0);
      const effective = cpEffectiveExportTarget(srcW, srcH, fit, target);
      if (!effective) return null;

      // WebP q0.92 rather than the live path's lossless PNG: a 256px photographic
      // portrait is ~120 KB as PNG and ~15 KB here, and the saved HTML carries one per
      // distinct speaker. The difference is not visible at portrait scale.
      const dataUrl = await cpResampleToDataURL(probe, 0, fit, anchorTop, { targetPx: effective, mimeType, quality });
      if (dataUrl) return { dataUrl, srcW, srcH, keepOriginal: false };

      // No bitmap — either the source is already at/below the target (never upscale) or
      // the draw failed. Only the former is a "keep the original" verdict, and it is
      // identified by the size test rather than assumed.
      return { dataUrl: null, srcW, srcH, keepOriginal: Math.max(srcW, srcH) <= target };
    })().catch(() => null);

    _cpExportPortraitCache.set(key, promise);
    return await promise;
  } catch {
    return null;
  }
}

export {
  cpMaybeApplyHQResample,
  cpShouldUseHQResample,
  cpResampleCacheGet,
  cpBuildExportPortrait,
  cpClearExportPortraitCache,
  // Pure geometry — exported for ci/fe-chat-portrait-image.test.mjs. They have no
  // production caller outside this file; the crop/target math is where every
  // resolution and aspect-ratio regression this module has had actually lived.
  cpEffectiveExportTarget,
  cpComputeSourceCrop,
  cpComputeDrawRect,
};
