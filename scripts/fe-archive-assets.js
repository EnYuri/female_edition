// Asset embedding for the archive's saved HTML file.
//
// Sub-module of fe-chat-archive.js (snapshot family). Scope: ONE NODE TREE's
// images. Fetches every <img>/background image the export subtree references,
// turns them into data: URLs under a byte budget, deduplicates identical bitmaps,
// upgrades portraits to an export-resolution bitmap, and serializes the prepared
// tree to HTML parts.
//
// Every entry point here is REVERSIBLE: it returns a restore callback, because the
// same live document the user is still looking at is what gets mutated.
//
// It knows nothing about the file being built — that is `fe-archive-snapshot.js`.


// ===========================================================================
// Asset Embedding & HTML Preparation  (image embed, portrait restore,
//                                      font-family patch, font-ready bootstrap)
// ===========================================================================

import { feLocalize, feFormat } from "./fe-i18n.js";
import { feSetting } from "./fe-chat-enhance.js";
import { cpBuildExportPortrait, cpClearExportPortraitCache } from "./fe-chat-portrait-image.js";
import { feBlobToDataURL, feCompressImageBlobForEmbed } from "./fe-archive-image.js";
import {
  feNextTick,
  feIsExportOwnedImage,
  feRestoreOriginalPortraitSources,
  feRestorePrintBlobSources,
  fePatchInlineFontFamiliesForExport,
} from "./fe-archive-output.js";
import {
  FE_EXPORT_EMBED_CONCURRENCY,
  FE_EXPORT_RESOURCE_FETCH_TIMEOUT,
  feFetchWithTimeout,
} from "./fe-archive-fetch.js";

export async function feEmbedImagesInNode(root, { meta, maxTotalBytes } = {}) {
  const setMeta = typeof meta === "function" ? meta : () => {};

  // Track per-img mutations so the caller can restore the live DOM after serialization.
  // Allocated up-front and captured by the restore closure so a partial-failure path
  // (any throw mid-loop) still hands the caller a valid restore.
  const changed = [];
  const recordBeforeMutate = (img) => {
    try {
      changed.push({
        img,
        src: img.getAttribute("src"),
        srcset: img.getAttribute("srcset"),
        loading: img.getAttribute("loading"),
      });
    } catch {}
  };
  let dedupRestore = null;

  const restore = () => {
    try { dedupRestore?.(); } catch {}
    for (let k = changed.length - 1; k >= 0; k -= 1) {
      const it = changed[k];
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

  let imgs;
  try {
    imgs = Array.from(root?.querySelectorAll?.("img") ?? []);
  } catch {
    return restore;
  }
  if (!imgs.length) return restore;

  // Hard safety limits:
  // Single-file HTML + embedded images can easily crash Chromium/Electron (STATUS_BREAKPOINT / OOM)
  // due to base64 expansion + JS string memory overhead.
  //
  // These are LAST-RESORT ceilings, not a tuning knob for file size — the pre-embed
  // downscale pass is what actually keeps the payload small. Hitting one of them is a
  // silent failure that leaves an absolute Foundry-origin src in the saved HTML, i.e.
  // an image only the exporting user can load. So they are set well above what a
  // downscaled log needs; the console warning at the end of the pass reports any image
  // that still fell through.
  // COUNT cap, and the one that actually bit. Measured on the 2026-08-12 export
  // (1900 messages): 2096 <img> elements, of which ~1980 kept a Foundry-origin src.
  // With the old 600 the pass stopped after the first 600 elements no matter how
  // much byte budget was left — a log this size could never finish embedding.
  // 8000 covers ~4x this log; it is a runaway guard, not a tuning knob.
  const MAX_IMAGES = 8000;
  // Binary bytes before base64/string expansion. Caller may pass a smaller cap
  // (shared budget) — e.g. after pre-embed downscaling already spent part of it.
  // Explicit user decision (2026-08-12): file size does not matter, offline
  // completeness does. Measured demand for the 1900-message log above is ~50MB
  // post-downscale (24.5MB actually embedded before the budget ran dry, plus 42
  // distinct source files totalling 71.7MB on disk that downscale to ~25MB), so
  // 250MB carries 4-5x that log. The saved HTML is assembled as an ARRAY of
  // per-message strings passed to new Blob() (feSerializeBodyToParts), never one
  // giant string, so V8's ~512MB max string length is not a ceiling here.
  const MAX_TOTAL_BYTES = Number.isFinite(maxTotalBytes) ? Math.max(0, maxTotalBytes) : 250_000_000;
  // Over this, the image is compressed (never dropped). Raised 4MB → 16MB so that
  // full-resolution art escaping the downscale pass is embedded as-is instead of
  // being re-encoded; at 4MB the largest character portraits in the world above
  // (up to ~9MB) were all taking the compressor path.
  const MAX_PER_IMAGE = 16_000_000;
  // Absolute stop for the compress-past-the-budget path below.
  const HARD_TOTAL_CEILING = Math.round(MAX_TOTAL_BYTES * 1.5);

  const cache = new Map();

  // Resolve each img to the URL it would be embedded from — LAZILY, at most once per img.
  // A big log can hold thousands of <img> while the commit loop stops at MAX_IMAGES, so
  // resolving them all up front would spend unbounded synchronous time parsing URLs that are
  // never used, before the first yield. Resolution stays just ahead of the prefetch window.
  //
  // Reading an img's src before its own turn is safe: an img is mutated only when the commit
  // loop reaches it, which is always at or after the point we resolve it.
  //
  // planCache[i]: `undefined` = unresolved, `null` = not embeddable (already a data: URL,
  // unparseable, or cross-origin), else { img, abs }.
  const planCache = new Array(imgs.length);
  const entryAt = (i) => {
    let entry = planCache[i];
    if (entry !== undefined) return entry;

    entry = null;
    try {
      const img = imgs[i];
      const src = img.getAttribute("src") || img.src;
      if (src && !src.startsWith("data:")) {
        const abs = new URL(src, window.location.href).href;
        // Only embed same-origin resources (avoid CORS failures).
        if (new URL(abs).origin === window.location.origin) entry = { img, abs };
      }
    } catch {
      entry = null;
    }

    planCache[i] = entry;
    return entry;
  };

  // Fetches run ahead of the commit loop (network overlap), but the DECISIONS below stay
  // strictly in document order. That ordering is load-bearing, not incidental:
  //   - the byte budget is spent in a deterministic prefix, so the same log exports the
  //     same way every time — with completion-order accounting, which images make the cut
  //     would vary run to run;
  //   - `cache` (first occurrence embeds, later ones reuse) stays well-defined.
  const fetches = new Map(); // abs -> Promise<{ dataUrl, size } | null>
  let inflight = 0;
  let prefetchIdx = 0;

  const startFetch = (abs) => {
    const existing = fetches.get(abs);
    if (existing) return existing;

    inflight += 1;
    const p = (async () => {
      try {
        const fetched = await feFetchWithTimeout(
          abs,
          { credentials: "include" },
          FE_EXPORT_RESOURCE_FETCH_TIMEOUT,
          async (res) => res.ok ? res.blob() : null
        );
        const blob = fetched;
        if (!blob) return null;
        // Per-image limit. Order-independent, so it belongs here rather than at commit.
        // Over the cap is NOT a drop: dropping leaves an absolute Foundry-origin src that
        // only this machine can load. Compress it down instead and embed the result
        // unconditionally — `compressed: true` tells the commit loop not to re-apply any
        // cap to what came back.
        if (blob.size > MAX_PER_IMAGE) {
          const shrunk = await feCompressImageBlobForEmbed(window, blob, {
            targetBytes: MAX_PER_IMAGE,
            maxSide: 1400,
          });
          if (!shrunk) {
            console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feEmbedImagesInNode"), abs, blob.size);
            return null;
          }
          return { dataUrl: shrunk.dataUrl, size: shrunk.size, compressed: true };
        }
        // `blob` is kept so the commit loop can compress this image if it no longer
        // fits the remaining total budget. Cleared right after that decision so the
        // memoized entry doesn't pin bytes for the rest of the run.
        return { dataUrl: await feBlobToDataURL(blob), size: blob.size, blob };
      } catch (err) {
        console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feEmbedImagesInNode2"), abs, err);
        return null;
      } finally {
        inflight -= 1;
      }
    })();

    fetches.set(abs, p);
    return p;
  };

  // Keep the window topped up with distinct URLs the commit loop is about to need.
  const pumpPrefetch = () => {
    while (prefetchIdx < imgs.length && inflight < FE_EXPORT_EMBED_CONCURRENCY) {
      const entry = entryAt(prefetchIdx);
      prefetchIdx += 1;
      if (entry && !fetches.has(entry.abs)) startFetch(entry.abs);
    }
  };

  try {
    let embeddedCount = 0;
    let embeddedBytes = 0;

    for (let i = 0; i < imgs.length; i += 1) {
      pumpPrefetch();

      const entry = entryAt(i);
      if (!entry) continue;

      // Stop when reaching limits.
      //
      // NOT at MAX_TOTAL_BYTES: past the budget, images go through the compressor
      // below instead of being abandoned on a server-only URL. HARD_TOTAL_CEILING is
      // where that stops too — otherwise 600 compressed images could still add up
      // far past any sane file size.
      if (embeddedCount >= MAX_IMAGES || embeddedBytes >= HARD_TOTAL_CEILING) {
        setMeta(
          feFormat("FE.ChatArchive.Status.ImageLimitReached", { embeddedCount: embeddedCount, value2: (
            embeddedBytes /
            1024 /
            1024
          ).toFixed(1) })
        );
        break;
      }

      const { img, abs } = entry;

      if (cache.has(abs)) {
        // Every duplicate — including one collapsed by feOptimizeArchiveNodeImages
        // (`data-fe-archive-shared-image`) — gets the cached data: URL. Leaving a
        // shared duplicate on its absolute Foundry-origin src used to be the
        // size optimization, but it makes that image load ONLY for a viewer who can
        // reach this server. `feDeduplicateInlineDataUrlsInNode` below already
        // removes the repeat cost: identical data: srcs collapse to one copy plus a
        // marker attribute, restored at view time by the bootstrap script.
        try {
          recordBeforeMutate(img);
          img.setAttribute("src", cache.get(abs));
          img.removeAttribute("srcset");
          img.removeAttribute("loading");
        } catch {}
        continue;
      }

      setMeta(feFormat("FE.ChatArchive.Status.EmbeddingImageProgress", { embeddedCount: embeddedCount, MAX_IMAGES: MAX_IMAGES, value3: i + 1, value4: imgs.length }));

      let result = await startFetch(abs);
      if (!result) continue;

      // Total limit. A too-large image is compressed into what's left rather than skipped —
      // same reasoning as the per-image cap: a skipped image keeps a server-only URL. Once
      // it has been through the compressor it is embedded regardless of the remaining
      // budget (bounded overshoot: a compressed image is ≲1MB).
      if (!result.compressed && embeddedBytes + result.size > MAX_TOTAL_BYTES) {
        const remaining = Math.max(0, MAX_TOTAL_BYTES - embeddedBytes);
        const shrunk = result.blob
          ? await feCompressImageBlobForEmbed(window, result.blob, {
              targetBytes: Math.max(150_000, remaining),
              maxSide: 1200,
            })
          : null;
        if (shrunk && shrunk.size < result.size) {
          result = { dataUrl: shrunk.dataUrl, size: shrunk.size, compressed: true };
        } else {
          // Compression failed, or re-encoding an already-optimized file made it bigger.
          // Embed the original rather than abandon it: it is under MAX_PER_IMAGE, and the
          // run still stops at HARD_TOTAL_CEILING.
          result = { dataUrl: result.dataUrl, size: result.size, compressed: true };
        }
        // Re-memoize so later duplicates reuse this decision (and drop the blob).
        fetches.set(abs, Promise.resolve(result));
      }

      // Budget decision is made — drop the retained blob so it can be collected.
      try { if (result.blob) result.blob = null; } catch {}

      cache.set(abs, result.dataUrl);

      try {
        recordBeforeMutate(img);
        img.setAttribute("src", result.dataUrl);
        img.removeAttribute("srcset");
        img.removeAttribute("loading");
      } catch {}

      embeddedCount++;
      embeddedBytes += result.size;

      // Yield periodically so Chromium doesn't freeze.
      if (i % 10 === 0) await feNextTick();
    }

    // Diagnostic: anything still pointing at a network URL will render only for a
    // reader whose browser can reach this Foundry server — i.e. a broken image for
    // everyone the file is shared with. Report it instead of failing silently.
    try {
      const leftovers = [];
      for (const img of root.querySelectorAll?.("img[src]") ?? []) {
        const s = img.getAttribute("src") || "";
        if (!s || s.startsWith("data:")) continue;
        leftovers.push(s);
      }
      if (leftovers.length) {
        console.warn(
          feFormat("FE.Diagnostics.ArchiveSnapshot.feEmbedImagesInNode3", { value1: leftovers.length }) +
          feLocalize("FE.Diagnostics.ArchiveSnapshot.feEmbedImagesInNode4"),
          leftovers.slice(0, 10)
        );
        setMeta(feFormat("FE.ChatArchive.Status.ImagesNotEmbedded", { value1: leftovers.length }));
      }
    } catch {}

    // Final pass: deduplicate identical inline data: URLs across the serialized HTML.
    // Each repeated <img src="data:..."> is reduced to a marker; a small bootstrap
    // script restores src at view time. Avoids N× base64 bloat for repeated avatars/portraits.
    dedupRestore = feDeduplicateInlineDataUrlsInNode(root, setMeta);
  } catch (err) {
    // The caller still gets `restore` with whatever's been recorded so far,
    // so the live archive window can recover from partial mutation.
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feEmbedImagesInNode5"), err);
  }

  return restore;
}

export function feDeduplicateInlineDataUrlsInNode(root, setMeta = () => {}) {
  const refsAdded = [];
  const srcRemoved = [];
  let scriptEl = null;
  try {
    if (!root?.querySelectorAll) return () => {};
    const doc = root.ownerDocument || document;
    const groups = new Map();
    let n = 0;
    let dedupCount = 0;
    let savedBytes = 0;
    for (const img of root.querySelectorAll('img[src^="data:"]')) {
      const url = img.getAttribute("src");
      // Skip tiny inline images — bootstrap overhead outweighs the saving.
      if (!url || url.length < 256) continue;
      let entry = groups.get(url);
      if (!entry) {
        entry = { id: `fei${++n}` };
        groups.set(url, entry);
        img.setAttribute("data-fe-img-ref", entry.id);
        refsAdded.push(img);
        continue;
      }
      img.setAttribute("data-fe-img-ref", entry.id);
      refsAdded.push(img);
      const removedSrc = img.getAttribute("src");
      img.removeAttribute("src");
      srcRemoved.push({ img, src: removedSrc });
      dedupCount += 1;
      savedBytes += url.length;
    }
    if (dedupCount > 0) {
      scriptEl = doc.createElement("script");
      scriptEl.id = "fe-archive-img-dedup";
      // The script auto-executes the moment it gets inserted into a connected
      // document. In the in-place embed flow this would re-fill `src` on the
      // duplicates we just stripped, undoing the dedup. The skip flag turns
      // that one execution into a no-op; we strip the flag right after so the
      // copy that ends up in saved HTML still runs when the file is later opened.
      scriptEl.setAttribute("data-fe-skip-bootstrap", "1");
      scriptEl.textContent = '(function(){var cs=document.currentScript;if(cs&&cs.hasAttribute("data-fe-skip-bootstrap"))return;try{var m={};document.querySelectorAll(\'img[data-fe-img-ref][src^="data:"]\').forEach(function(el){var k=el.getAttribute("data-fe-img-ref");if(k&&!m[k])m[k]=el.getAttribute("src");});document.querySelectorAll("img[data-fe-img-ref]:not([src])").forEach(function(el){var s=m[el.getAttribute("data-fe-img-ref")];if(s)el.setAttribute("src",s);});}catch(_e){}})();';
      root.appendChild(scriptEl);
      scriptEl.removeAttribute("data-fe-skip-bootstrap");
      try { setMeta(feFormat("FE.ChatArchive.Status.DeduplicatedImages", { dedupCount: dedupCount, value2: (savedBytes / 1024 / 1024).toFixed(1) })); } catch {}
    }
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feDeduplicateInlineDataUrlsInNode"), err);
  }
  return () => {
    try { scriptEl?.remove(); } catch {}
    for (const it of srcRemoved) {
      try {
        if (it.src != null) it.img.setAttribute("src", it.src);
      } catch {}
    }
    for (const img of refsAdded) {
      try { img.removeAttribute("data-fe-img-ref"); } catch {}
    }
  };
}

// Splits the body's outerHTML into [shell-before-log-open, ...messages, shell-after-log-open]
// so the caller can pass an array of small strings to `new Blob()` instead of allocating
// one giant outerHTML and then re-copying it into the Blob. Avoids the V8 peak-memory hit
// for large logs (~50MB single string → many small strings).
export function feSerializeBodyToParts(body) {
  try {
    const log = body?.querySelector?.("#fe-chat-export-log, ol.chat-log");
    if (!log?.children?.length) return [body?.outerHTML || ""];

    // Detach messages, snapshot the now-empty shell, re-attach. This narrows the
    // body.outerHTML allocation to "everything except the messages", which is small.
    const messages = Array.from(log.children);
    for (const m of messages) m.remove();
    let shellHTML;
    let emptyLogHTML;
    try {
      emptyLogHTML = log.outerHTML;
      shellHTML = body.outerHTML;
    } finally {
      // Always re-insert in original order, even if a serialization step throws.
      log.append(...messages);
    }

    const logIdx = shellHTML.indexOf(emptyLogHTML);
    if (logIdx < 0) return [body.outerHTML];
    // The empty log serializes as `<ol ...></ol>`. Split right after the open tag so
    // messages get spliced in between open and close.
    const closeTag = "</ol>";
    const splitAt = logIdx + emptyLogHTML.length - closeTag.length;

    const parts = [];
    parts.push(shellHTML.slice(0, splitAt));
    for (const m of messages) {
      try { parts.push(m.outerHTML); } catch {}
    }
    parts.push(shellHTML.slice(splitAt));
    return parts;
  } catch {
    try { return [body?.outerHTML || ""]; } catch { return [""]; }
  }
}

// Multiplier over the CSS portrait box, and the absolute pixel ceiling, for the
// export-resolution portrait bitmaps. 4x of the default 64px box = 256px.
//
// The number is a print-DPI budget, not a taste setting: Chrome rasterizes
// `window.print()` well above CSS pixels, and a reader may zoom or open the file on a
// HiDPI screen. Anything at 1x (which is what the live `src` data URL is on a dpr-1
// machine) is visibly blocky in all three cases — that is exactly the "터무니없이 낮은
// 해상도" (absurdly low resolution) report. A 256px pre-cropped PNG costs ~60-100 KB and
// dedups across every
// message from the same actor, so the whole log usually adds well under 1 MB.
// The 4x multiplier IS the print budget: 300 DPI over CSS's 96 DPI reference is
// 3.125 device px per CSS px, so 4x covers 300 DPI with headroom at every portrait
// size. The ceiling only exists to bound the file, and MUST NOT be set below what the
// multiplier needs at the largest usable portrait size — at 512 it silently clipped
// every box above 128px (a 160px portrait needs ~500px at 300 DPI and got 512, a 200px
// one needs ~625 and still got 512), i.e. the exact ceiling this whole pass removes,
// reappearing for anyone who enlarged their portraits. 768 covers up to a 192px box.
export const FE_EXPORT_PORTRAIT_SCALE = 4;
export const FE_EXPORT_PORTRAIT_MAX_PX = 768;
// Total wall-clock the portrait pass may spend on NEW work. Sized against the 5 s
// per-source probe ceiling at concurrency 4: a batch of dead paths costs one round of
// timeouts, not one per source. Keep it well under the point where a user assumes the
// export has hung — everything past it degrades to "keep the original src", not to a
// failure.
export const FE_EXPORT_PORTRAIT_BUDGET_MS = 10000;
// Absolute ceiling for the same pass, so "extend on progress" can never turn into an
// unbounded wait when slow-but-alive and dead sources interleave. Generous on purpose:
// everything past it degrades to a lower-resolution portrait, which is exactly the
// defect this pass exists to fix — it is a hang guard, not a speed target.
export const FE_EXPORT_PORTRAIT_HARD_BUDGET_MS = 90000;

/**
 * Re-resample every portrait from its ORIGINAL file at export resolution and swap the
 * result in, returning an undo.
 *
 * Runs BEFORE fePrepareBodyForHTMLSnapshot so its `keepSelfContainedSrc` branch sees
 * an already-self-contained data: URL and leaves it alone; anything this could not
 * upgrade still falls through to the normal restore + embed path.
 */
export async function feUpgradePortraitsForExport(
  root,
  { meta = () => {}, useBlobURL = false, win = null } = {}
) {
  const changed = [];
  const winURL = (win && win.URL) || URL;
  const createdBlobURLs = new Set();
  // dataUrl -> Promise<blobUrl>. Every message from the same speaker must end up
  // sharing ONE blob: URL, which is the entire point of this on the print path.
  const blobURLByData = new Map();
  const toBlobURL = (dataUrl) => {
    let p = blobURLByData.get(dataUrl);
    if (p) return p;
    p = (async () => {
      const blob = await (await fetch(dataUrl)).blob();
      const url = winURL.createObjectURL(blob);
      createdBlobURLs.add(url);
      return url;
    })().catch(() => null);
    blobURLByData.set(dataUrl, p);
    return p;
  };
  try {
    if (!root?.querySelectorAll) return () => {};
    const imgs = Array.from(root.querySelectorAll("img[data-fe-portrait-orig-src]"));
    if (!imgs.length) return () => {};

    const size = Math.max(16, Number(feSetting("chatPortraitSize") ?? 64) || 64);
    const shape = String(feSetting("chatPortraitShape") ?? "circle");
    const fit = shape === "none" ? "contain" : "cover";
    const targetPx = Math.min(FE_EXPORT_PORTRAIT_MAX_PX, Math.round(size * FE_EXPORT_PORTRAIT_SCALE));

    // Budget for NEW work, measured as time WITHOUT PROGRESS rather than total elapsed.
    // MUST stay: cpWaitForImage puts a ceiling on each source, and a source that 404s or
    // hangs burns all of it. Past the deadline the pass keeps running but only serves
    // sources already resolved in the memo (free), so repeated speakers still upgrade;
    // everything else keeps its original src and falls through to the normal embed path.
    //
    // The deadline is pushed forward on every source that answers (`runOne`), because a
    // FIXED total is the wrong shape here: a log with many distinct speakers on a remote
    // Foundry host spends its whole budget on healthy-but-slow fetches and then silently
    // degrades the entire tail — and the tail is where the one-off NPCs live, which is
    // the second half of the "NPC만 저해상도" (only NPC portraits low-res) report. What the
    // budget must actually bound
    // is a batch of DEAD paths, and those make no progress by definition. The hard
    // ceiling below still bounds the pathological case where the two interleave.
    let deadline = performance.now() + FE_EXPORT_PORTRAIT_BUDGET_MS;
    const hardDeadline = performance.now() + FE_EXPORT_PORTRAIT_HARD_BUDGET_MS;

    // CONCURRENT, bounded. This loop used to be serial, with a comment claiming
    // parallelism could not help because the work is main-thread canvas work. That
    // reasoning was WRONG and it made printing take far too long: per the measurements
    // in CLAUDE.md the ladder is ~0.4 ms and the encode ~2.4 ms, but this pass first has
    // to FETCH AND FULLY DECODE the original file — several MB and 10+ megapixels for a
    // typical portrait — and that part is off-main-thread and overlaps almost perfectly.
    // Serially it is the entire cost of the pass, multiplied by the number of distinct
    // speakers, and on a remote Foundry host it is network latency multiplied by the
    // same. The cap keeps peak memory to a few decoded sources at once.
    const CONCURRENCY = 4;
    let cursor = 0;
    let done = 0;
    const runOne = async (img) => {
      const orig = img.dataset?.fePortraitOrigSrc || img.getAttribute?.("data-fe-portrait-orig-src") || "";
      if (!orig) return;
      let info = null;
      try {
        info = await cpBuildExportPortrait(orig, {
          targetPx,
          fit,
          anchorTop: true,
          cachedOnly: performance.now() > Math.min(deadline, hardDeadline),
        });
      } catch {}
      if (!info) return;
      // Any answer at all means this source is alive — see the deadline comment.
      deadline = performance.now() + FE_EXPORT_PORTRAIT_BUDGET_MS;

      const dataUrl = info.dataUrl;
      if (!dataUrl) {
        // The ORIGINAL file is already the best available answer (a source at/below the
        // export target, or a vector). Pin it and mark it: doing nothing here is not
        // neutral — it hands the portrait to the two passes that each impose their own
        // ceiling BELOW the source's own resolution (the avatar downscaler's
        // `cssBox × avatarDpr` ≈ 96px on the print path, and `keepSelfContainedSrc`
        // keeping the 64px live screen bitmap on the saved-HTML path). That asymmetry —
        // large portrait art upgraded to 256px, small/default art capped at 64-96px —
        // is the reported "PC는 선명한데 NPC 포트레이트만 저해상도" (PCs sharp, only NPC
        // portraits low-res).
        if (!info.keepOriginal) return;
        const prevSrc = img.getAttribute("src");
        const prevSrcset = img.getAttribute("srcset");
        const prevLoading = img.getAttribute("loading");
        changed.push({ img, prevSrc, prevSrcset, prevLoading });
        img.setAttribute("src", orig);
        img.removeAttribute("srcset");
        // The print path waits on image LOAD before rasterizing; a portrait we just
        // pointed at a file must be able to finish on its own (feDownscaleImagesForPrint
        // and feWaitForImages both skip `loading="lazy"` elements).
        img.setAttribute("loading", "eager");
        img.dataset.feExportPortrait = "1";
        // Same value the snapshot revert would write anyway — set so the print path's
        // blob revert treats this element like every other upgraded portrait.
        if (useBlobURL) {
          try { img.dataset.fePrintOrigSrc = orig; } catch {}
        }
        return;
      }

      // PRINT uses blob: URLs, the saved-HTML path uses the data: URL directly.
      //
      // The bitmap is identical either way — what differs is what sits in the DOM. A
      // base64 data: URL is ~20 KB of attribute text, and a busy log repeats the same
      // speaker across hundreds of messages, so the print document ends up carrying
      // megabytes of duplicated string that Chromium has to copy when it builds the
      // preview. One blob: URL per distinct speaker is a short, shared handle instead.
      // `feDownscaleImagesForPrint` already made exactly this choice for the same
      // reason ("~33% memory plus V8 string overhead"); portraits skip that pass now,
      // so they have to make it themselves. The saved HTML cannot use blob: at all —
      // the handle dies with the session — hence the flag rather than a blanket switch.
      let finalUrl = dataUrl;
      if (useBlobURL) {
        const blobUrl = await toBlobURL(dataUrl);
        if (blobUrl) finalUrl = blobUrl;
      }

      const prevSrc = img.getAttribute("src");
      const prevSrcset = img.getAttribute("srcset");
      if (prevSrc === finalUrl && !prevSrcset) {
        // Already carrying exactly this bitmap — but it still has to be MARKED, or the
        // downscale pass re-targets it at `cssBox × avatarDpr` and the HQ resampler is
        // free to put the 64px screen bitmap back. Recorded in `changed` so undo clears
        // the marker; rewriting the identical src on undo is a no-op.
        if (!feIsExportOwnedImage(img)) {
          changed.push({ img, prevSrc, prevSrcset });
          img.dataset.feExportPortrait = "1";
        }
        return;
      }
      changed.push({ img, prevSrc, prevSrcset });
      // Same contract as the downscale pass: an HTML snapshot taken while these blob:
      // URLs are live reverts through data-fe-print-orig-src, since a blob: handle in
      // saved HTML would be dead on arrival.
      //
      // Stash the ORIGINAL FILE PATH, never `prevSrc`. MEASURED 2026-08-05: prevSrc
      // here is the live HQ resample, i.e. a ~10.8 KB base64 data: URL, and copying it
      // per element put 29.34 MB of dead string into the print document — the single
      // largest attribute in it, ahead of style (6.51 MB) and src (0.37 MB). Nothing
      // ever paints it. The path is what a snapshot actually wants (it is the same
      // value feRestoreOriginalPortraitSources would write) and costs ~20 bytes.
      if (useBlobURL && orig) {
        try { img.dataset.fePrintOrigSrc = orig; } catch {}
      }
      img.setAttribute("src", finalUrl);
      img.removeAttribute("srcset");
      // Tells feDownscaleImagesForPrint to leave this one alone. Without it the
      // downscale pass re-targets every avatar at `cssBox × avatarDpr` (64 × 1.5 =
      // 96px) and throws the extra resolution straight back away — which is the
      // ceiling that made both the PDF and the saved HTML look low-resolution.
      img.dataset.feExportPortrait = "1";
    };

    // Progress has to be reported from inside the pass: the memoized sources return
    // instantly and the cold ones do not, so a single message posted up front sits
    // there looking hung for exactly as long as the work actually takes.
    const workers = Array.from({ length: Math.min(CONCURRENCY, imgs.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= imgs.length) return;
        try {
          await runOne(imgs[i]);
        } catch {}
        done += 1;
        if (done === imgs.length || done % CONCURRENCY === 0) {
          meta(feFormat("FE.ChatArchive.Status.PreparingPortraits", { done: done, value2: imgs.length }));
        }
      }
    });
    await Promise.all(workers);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feUpgradePortraitsForExport"), err);
  }
  return () => {
    for (const it of changed) {
      try {
        if (it.prevSrc == null) it.img.removeAttribute("src");
        else it.img.setAttribute("src", it.prevSrc);
        if (it.prevSrcset == null) it.img.removeAttribute("srcset");
        else it.img.setAttribute("srcset", it.prevSrcset);
        // Only the keep-the-original branch records `loading`; the upgrade branch leaves
        // it untouched, so `undefined` here means "was never changed".
        if (it.prevLoading !== undefined) {
          if (it.prevLoading == null) it.img.removeAttribute("loading");
          else it.img.setAttribute("loading", it.prevLoading);
        }
        delete it.img.dataset.feExportPortrait;
        delete it.img.dataset.fePrintOrigSrc;
      } catch {}
    }
    // Blob handles outlive the elements that referenced them until revoked — the
    // bitmaps would stay pinned in memory for the rest of the session otherwise.
    for (const url of createdBlobURLs) {
      try { winURL.revokeObjectURL(url); } catch {}
    }
    createdBlobURLs.clear();
    blobURLByData.clear();
    try { cpClearExportPortraitCache(); } catch {}
  };
}

export function fePrepareBodyForHTMLSnapshot(root, { embedFonts = false, keepSelfContainedSrc = false } = {}) {
  const restores = [];
  try {
    restores.push(feRestoreOriginalPortraitSources(root, { keepSelfContainedSrc }));
  } catch {}
  try {
    // Revert any blob: URLs left over from in-flight print downscale so they
    // don't end up in the saved HTML (where they'd be invalid once the popup
    // closes or `afterprint` revokes them).
    restores.push(feRestorePrintBlobSources(root));
  } catch {}
  if (embedFonts) {
    try {
      restores.push(fePatchInlineFontFamiliesForExport(root));
    } catch {}
  }
  return () => {
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]?.();
      } catch {}
    }
  };
}
