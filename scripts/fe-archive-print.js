// Print / PDF output for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Everything that only matters once the page is
// going through Chromium's paged-media engine: the print-only CSS overrides, the
// paper-size-adaptive page-break preparation, and the print run itself — image
// mode selection, the temporary-blanking memory guard, background freezing,
// portrait upgrade, and the restore stack that undoes all of it afterwards.
//
// Nothing here is used by the screen/HTML paths; the archive popup renders fine
// with this module never called.


import { feLocalize, feFormat } from "./fe-i18n.js";
import { FE_DEFAULTS } from "./fe-settings-data.js";
import { S, feSetting } from "./fe-chat-enhance.js";
import {
  feFreezeMessageBackgroundsForPrint,
  feDownscaleImagesForPrint,
} from "./fe-archive-image.js";
import {
  feWaitForFonts,
  feWaitForImages,
  fePrepareArchiveImagesForOutput,
} from "./fe-archive-output.js";
import { feUpgradePortraitsForExport } from "./fe-archive-assets.js";
import {
  FE_EXPORT_PAINT_FRAME_TIMEOUT,
  FE_EXPORT_WAIT_FONTS_TIMEOUT,
  FE_EXPORT_WAIT_IMAGES_MAX,
  FE_EXPORT_WAIT_IMAGES_TIMEOUT,
  feIsElectron,
} from "./fe-archive-runtime.js";
import { feGetArchiveRenderProfile } from "./fe-archive-collect.js";
import { feEnsureArchiveEmbeddedFonts } from "./fe-archive-document.js";
import {
  feNormalizeArchivePortraitImages,
  feRepairMissingArchivePortraitsForPrint,
} from "./fe-archive-message.js";

export function feEnsurePrintCSSOverrides() {
  const styleId = "fe-chat-export-printfix";
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  // NOTE ON THE SELECTORS BELOW — these no longer depend on `body.game`.
  //
  // `body.game` DOES still exist on v14, but it does NOT come from anything a search of
  // client/ or the view templates will show you: `dist/server/views/game.mjs` passes no
  // bodyClass at all, and `client/game.mjs#configureUI` only adds `performance-*`,
  // `noblur` and `theme-*`. It is an EXPRESS MIDDLEWARE DEFAULT —
  // `dist/server/express.mjs` sets `res.locals.bodyClass = ["vtt", <first URL segment>,
  // "system-<id>"]`, so `/game` happens to yield `vtt game system-dnd5e`. Verified in a
  // real saved archive whose body class list starts exactly that way.
  //
  // Depending on a class whose only source is the request path is still a bad bet, so
  // the gate is now `.fe-print-chatlog` — the class WE set, which is the actual
  // precondition. `.fe-print-chatlog` is repeated to keep the ORIGINAL (0,2,1)
  // specificity that `.game.fe-print-chatlog` had. Do not "simplify" it to one class.
  //
  // `#pause` is hidden by name as well as by the direct-child rule. It IS a direct
  // child of <body> today (game.hbs declares `<template id="pause">` at top level and
  // AppV2's _insertElement replaces it in place), but it is `position: fixed`,
  // full-width, with a cool-blue gradient and a running `pulse` animation, so if that
  // ever changes it would paint over every printed page.
  style.textContent = `
@media print {
  html {
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
  }

  body.fe-print-chatlog.fe-print-chatlog {
    position: static !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }

  body.fe-print-chatlog.fe-print-chatlog > :not(#fe-chat-export-container) {
    display: none !important;
  }

  /* The paused banner, named explicitly rather than relying on the direct-child rule
   * above. It is \`position: fixed\` with a full-width cool-blue gradient and a running
   * \`pulse\` animation, so if it ever stops being a direct child of <body> it would
   * paint over the whole printed page again — the exact symptom this block fixes. */
  body.fe-print-chatlog.fe-print-chatlog #pause {
    display: none !important;
    animation: none !important;
  }

  /* Body PSEUDO-ELEMENT overlays. Neither the direct-child rule nor the #pause rule
   * above can reach one — it is not a child and has no id. Observed live: monks-little-
   * details paints its paused vignette as
   *   body.mld-paused:after { box-shadow: rgba(77,208,225,.5) 0 0 100px 50px inset }
   * and the archive copies the live <body> class list verbatim, so the cyan glow reached
   * every exported PDF. Kept in sync with fe-chat-archive.css; this UNLAYERED copy is the
   * one that actually wins (see the layer note there). We declare no body pseudo-element
   * of our own, so blanking them is safe. */
  body.fe-print-chatlog.fe-print-chatlog::before,
  body.fe-print-chatlog.fe-print-chatlog::after {
    content: none !important;
    display: none !important;
    background: none !important;
    box-shadow: none !important;
    animation: none !important;
  }

  body.fe-print-chatlog.fe-print-chatlog #fe-chat-export-container {
    display: block !important;
    position: static !important;
    inset: auto !important;
    overflow: visible !important;
    width: auto !important;
    height: auto !important;
    max-height: none !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border: 0 !important;
  }

  body.fe-print-chatlog.fe-print-chatlog #fe-chat-export-container .fe-chat-export-toolbar {
    display: none !important;
  }

  body.fe-print-chatlog.fe-print-chatlog #fe-chat-export-log {
    display: block !important;
    flex: none !important;
    height: auto !important;
    overflow: visible !important;
    max-height: none !important;
  }

  body.fe-print-chatlog.fe-print-chatlog #fe-chat-export-log .chat-message :is(.message-header, .message-sender) {
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: avoid;
    page-break-after: avoid;
  }

  /* Roll breakdowns / collapsibles print OPEN. Kept in sync with the
   * "ALWAYS EXPANDED" block in styles/fe-chat-archive.css; this UNLAYERED copy is
   * the one that actually wins the cascade (see the layer note in that file). */
  body.fe-print-chatlog.fe-print-chatlog .chat-message :is(
    .dice-roll .dice-tooltip,
    .dice-result .dice-tooltip-collapser,
    .collapsible .collapsible-content,
    .collapsible.collapsed .collapsible-content
  ) {
    display: grid !important;
    grid-template-rows: 1fr !important;
    transition: none !important;
    height: auto !important;
    max-height: none !important;
  }

  body.fe-print-chatlog.fe-print-chatlog .chat-message :is(
    .dice-roll .dice-tooltip > .wrapper,
    .dice-result .dice-tooltip-collapser > .wrapper,
    .collapsible-content > .wrapper,
    .dice-result .dice-tooltip
  ) {
    overflow: visible !important;
    height: auto !important;
    max-height: none !important;
  }

  body.fe-print-chatlog.fe-print-chatlog .chat-message :is(
    .collapsible.collapsed .fa-caret-down,
    .dice-roll .dice-total::after
  ) {
    transform: none !important;
  }

  @page {
    margin: 10mm;
  }
}
`;
  document.head.appendChild(style);
}

// ===========================================================================
// Print page-break image handling  (paper-size-adaptive, single-image fidelity)
// ===========================================================================

/**
 * Prepare content images for print pagination.
 * Keep each source image as one replaced element and let Chromium's paged-media
 * engine place it on the current or next page. A viewport-relative maximum height
 * adapts to A4/Letter/custom paper and print scaling; no guessed pixel page height,
 * document-position modulo, or clipped duplicate is involved.
 *
 * Must be called after all other pre-print mutations (downscale, background freeze,
 * font load) and after a reflow.
 * @param {Document} doc
 * @param {HTMLElement} logEl
 * @returns {() => void} Restore function (idempotent).
 */
export function fePrepareImagesForPageBreaks(doc, logEl) {
  if (!logEl) return () => {};

  let restored = false;
  const changes = [];

  const isContentImage = (img) => {
    try {
      if (!img?.parentNode) return false;
      if (img.classList?.contains("avatar")) return false;
      if (img.matches?.('img.chat-portrait-image-size-name-dnd5e, img[class*="chat-portrait-image-size"]')) return false;
      if (img.closest?.(".message-header, .message-sender, .chat-portrait-container")) return false;
      const r = img.getBoundingClientRect();
      return r.height >= 40 && r.width >= 40;
    } catch { return false; }
  };

  try {
    void logEl.offsetHeight;
    const imgs = Array.from(logEl.querySelectorAll("img")).filter(isContentImage);

    for (const img of imgs) {
      const rect = img.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) continue;

      const prevStyle = img.getAttribute("style");
      changes.push({ img, prevStyle });

      // Preserve the archive's already-rendered width, but allow narrower paper
      // to shrink it. height:auto retains the source aspect ratio. In print media,
      // 100vh tracks the selected page viewport; subtracting the module's 10mm
      // top/bottom @page margins keeps a very tall image inside one page box.
      img.style.setProperty("width", `min(100%, ${Math.ceil(rect.width)}px)`, "important");
      img.style.setProperty("height", "auto", "important");
      img.style.setProperty("max-width", "100%", "important");
      img.style.setProperty("max-height", "calc(100vh - 20mm)", "important");
      img.style.setProperty("object-fit", "contain", "important");
      img.style.setProperty("break-inside", "avoid", "important");
      img.style.setProperty("page-break-inside", "avoid", "important");
    }
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.fePrepareImagesForPageBreaks"), err);
  }

  return () => {
    if (restored) return;
    restored = true;
    for (const ch of changes.reverse()) {
      try {
        if (ch.prevStyle == null) ch.img.removeAttribute("style");
        else ch.img.setAttribute("style", ch.prevStyle);
      } catch {}
    }
  };
}

// Print Orchestration  (background freeze, image downscale, window.print())
// ===========================================================================

export async function feArchivePrint(win) {
  if (!win || win.closed) return;
  const doc = win.document;
  const metaEl = doc.getElementById("fe-chat-export-meta");
  const logEl =
    doc.getElementById("fe-chat-export-log") ||
    doc.getElementById("chat-log") ||
    doc.querySelector("ol.chat-log");

  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  const renderProfile = (() => {
    try {
      const count = logEl?.querySelectorAll?.("li.chat-message")?.length || 0;
      return feGetArchiveRenderProfile(count);
    } catch {
      return feGetArchiveRenderProfile(0);
    }
  })();

  const requested = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
  const isElectron = feIsElectron();
  let mode = requested;

  // Desktop app (Electron) is much more prone to OOM when printing images.
  // If user picked a "full" / unknown mode, fall back to a safer one.
  if (isElectron && (mode === "full" || mode === "include" || mode === "images")) mode = "downscale";

  const isAvatarImage = (img) => {
    try {
      if (!img) return false;
      if (img.classList?.contains("avatar")) return true;
      if (img.matches?.('img.chat-portrait-image-size-name-dnd5e, img[class*="chat-portrait-image-size"]')) return true;
      if (img.closest?.(".message-header, .message-sender")) return true;
      if (img.closest?.(".chat-portrait-container")) return true;
    } catch {}
    return false;
  };

  // Temporarily blank out image sources to prevent Chromium from decoding/embedding them in PDF.
  const tempDisableImages = (filterFn) => {
    if (!logEl) return () => {};
    const placeholder =
      "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
    const changed = [];
    try {
      const imgs = Array.from(logEl.querySelectorAll("img"));
      for (const img of imgs) {
        if (filterFn && !filterFn(img)) continue;
        const src = img.getAttribute("src");
        const srcset = img.getAttribute("srcset");
        if (src == null && srcset == null) continue;

        changed.push({
          img,
          src,
          srcset,
          loading: img.getAttribute("loading"),
        });

        img.setAttribute("src", placeholder);
        img.removeAttribute("srcset");
        img.setAttribute("loading", "lazy");
      }
    } catch {}
    return () => {
      for (const it of changed) {
        try {
          if (it.src != null) it.img.setAttribute("src", it.src);
          else it.img.removeAttribute("src");

          if (it.srcset != null) it.img.setAttribute("srcset", it.srcset);
          else it.img.removeAttribute("srcset");

          if (it.loading != null) it.img.setAttribute("loading", it.loading);
          else it.img.removeAttribute("loading");
        } catch {}
      }
    };
  };

  // Apply print image mode classes.
  try {
    doc.body.classList.toggle("fe-print-hide-avatars", mode === "hideAvatars");
    doc.body.classList.toggle("fe-print-hide-all", mode === "hideAll");
    doc.body.classList.toggle("fe-print-downscale", mode === "downscale");
    doc.body.classList.toggle("fe-print-downscale-lite", mode === "downscaleLite");
    feNormalizeArchivePortraitImages(logEl, renderProfile);
    if (mode !== "hideAll" && mode !== "hideAvatars") {
      feRepairMissingArchivePortraitsForPrint(logEl, renderProfile);
    }
  } catch {}

  // ---
  // Print color consistency fixes
  // ---
  // Chromium's "Save as PDF" and some printer drivers can render blend modes / translucent
  // overlays differently, causing message background saturation to vary between messages.
  // We avoid this by freezing each chat-message background to a single, computed, opaque RGB.
  // This also tends to speed up PDF printing (less compositing work).
  let restoreBg = () => {};
  try {
    restoreBg = feFreezeMessageBackgroundsForPrint(win, logEl);
    win.addEventListener("afterprint", restoreBg, { once: true });
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchivePrint"), err);
  }

  // Memory guard: if images are supposed to be hidden, also blank their src so Chromium won't decode them.
  let restoreImages = () => {};
  if (mode === "hideAll") restoreImages = tempDisableImages(() => true);
  else if (mode === "hideAvatars") restoreImages = tempDisableImages((img) => isAvatarImage(img));

  // P2: images that never finished loading (slow / 404) are skipped by the
  // downscaler and would otherwise be decoded at full resolution by the print
  // engine — the main residual OOM source on huge logs. Blank those stragglers
  // right before print (restored on afterprint). Set after downscale.
  let restoreStragglers = () => {};
  let restorePageBreaks = () => {};
  let restorePortraitUpgrade = () => {};
  let restorePrepImages = () => {};

  // Both hide modes are implemented ENTIRELY by blanking `src` (tempDisableImages
  // above) — there is no `display:none` anywhere in styles/ for them, only a
  // `:not(.fe-print-hide-*)` exclusion. So fePrepareArchiveImagesForOutput must not
  // run its portrait-source restoration here: it writes the ORIGINAL FILE PATH back
  // over the placeholder (and sets loading="eager"), which un-hides the very images
  // the mode exists to suppress. In hideAvatars the straggler pass happens to
  // re-blank them (a freshly-assigned src is never `complete`); hideAll skips that
  // pass entirely, so there it printed full-resolution portraits — the exact
  // eager-full-res state feRestoreOriginalPortraitSources' own comment documents as
  // a print-preview killer.
  const portraitsAreBlanked = mode === "hideAll" || mode === "hideAvatars";

  const restoreOnce = () => {
    try {
      restorePortraitUpgrade();
    } catch {}
    try {
      restorePageBreaks();
    } catch {}
    try {
      restoreDownscaledImages();
    } catch {}
    try {
      restoreStragglers();
    } catch {}
    try {
      restoreImages();
    } catch {}
    // LAST of the src-restoring undos, and that position is load-bearing. This one
    // rewrites the portrait `src` it replaced; every undo above replays a value it
    // snapshotted LATER in the pass (the downscaler's `prev` for a portrait is the
    // original path this pass just installed, the straggler/blank undos likewise),
    // so running it any earlier would let one of them overwrite the restored value
    // with a stale one.
    try {
      restorePrepImages();
    } catch {}
    try {
      restoreBg();
    } catch {}
  };

  try {
    win.addEventListener("afterprint", restoreOnce, { once: true });
  } catch {}

  // Portraits get an EXPORT-resolution bitmap before anything else touches them.
  //
  // What is on the element right now is the live HQ resample — `portraitSize × dpr`,
  // i.e. a 64x64 PNG on a dpr-1 machine. That is correct on screen and far too small on
  // paper: `win.print()` rasterizes well above CSS pixels, so the portrait is the one
  // element in the whole page that gets visibly enlarged. The downscale pass below would
  // not have fixed it either — it caps avatars at `cssBox × avatarDpr` (~96px) — which is
  // why it now skips anything this marks. A portrait it cannot upgrade because the source
  // is ALREADY at/below the export target (small token art, a vector) is marked too, with
  // its original file pinned: that source is the best answer available, and the ~96px cap
  // would otherwise throw away resolution we already had.
  if (logEl && mode !== "hideAll" && mode !== "hideAvatars") {
    try {
      restorePortraitUpgrade = await feUpgradePortraitsForExport(logEl, {
        meta: setMeta,
        // blob: URLs, not data:. Revoked by restoreOnce on afterprint.
        useBlobURL: true,
        win,
      });
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchivePrint2"), err);
    }
  }

  // Downscale images for stability:
  // - always when mode === "downscale"
  // - in Electron, also when images are not fully hidden
  const shouldDownscale = !!logEl && (mode === "downscale" || mode === "downscaleLite" || (isElectron && mode !== "hideAll"));
  let restoreDownscaledImages = () => {};
  if (shouldDownscale && logEl) {
    try {
      const mildDownscale = mode === "downscaleLite";
      setMeta(mildDownscale ? feLocalize("FE.ChatArchive.feArchivePrint") : feLocalize("FE.ChatArchive.Status.LoadingImages"));
      // Originals are about to be replaced by downscaled blobs — skip the
      // sync-decode storm (async lets Chromium decode off-thread).
      restorePrepImages = fePrepareArchiveImagesForOutput(logEl, {
        decoding: "async",
        restorePortraits: !portraitsAreBlanked,
      }) || (() => {});
      // Wait for ALL images to finish loading (bytes) — not a small initial
      // slice. The downscaler skips images that aren't `complete`, so anything
      // unloaded by now would slip through to print at full resolution. The
      // `load` wait only pulls encoded bytes (decode stays lazy → no decode
      // storm); the per-group canvas pass below decodes them under the
      // concurrency cap. The 20 s timeout bounds genuinely slow/dead images,
      // which the straggler-blank pass then neutralizes.
      const printImgCount = logEl.querySelectorAll?.("img")?.length || 0;
      const printImgTimeout = await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: Math.max(FE_EXPORT_WAIT_IMAGES_MAX, printImgCount) });
      if (printImgTimeout > 0) console.warn(feFormat("FE.Diagnostics.ChatArchive.feArchivePrint3", { printImgTimeout: printImgTimeout }));
      // Large/huge logs: shrink resolution caps so the pixels Chromium must
      // rasterize into the PDF (and the decoded bitmaps it holds during
      // win.print()) stay within memory. Print-time OOM scales with total
      // pixel count, so we scale dimensions — never encoder quality.
      const sizeFactor = renderProfile.huge ? 0.55 : renderProfile.large ? 0.78 : 1.0;
      const capSide = (n) => Math.max(640, Math.round(n * sizeFactor));
      const capDpr  = (n) => renderProfile.huge ? Math.min(n, 1.25)
                           : renderProfile.large ? Math.min(n, 1.5)
                           : n;
      restoreDownscaledImages = await feDownscaleImagesForPrint(win, logEl, {
        meta: setMeta,
        excludeAvatars: mode === "hideAvatars",
        // downscaleLite: visually-lossless WebP/JPEG (~q0.95) sized for print.
        // PNG forcing was causing 5–10× PDF bloat with no perceivable benefit
        // for photo-like chat content (portraits, item icons).
        dprCap: capDpr(mildDownscale ? 2.0 : (isElectron ? 1.35 : 1.65)),
        minDpr: mildDownscale ? 1.25 : (isElectron ? 1.1 : 1.25),
        webpQuality: mildDownscale ? 0.95 : (isElectron ? 0.85 : 0.88),
        jpegQuality: mildDownscale ? 0.95 : (isElectron ? 0.88 : 0.90),
        avatarDprCap: capDpr(mildDownscale ? 2.0 : (isElectron ? 1.5 : 1.6)),
        avatarMinDpr: mildDownscale ? 1.25 : 1.0,
        avatarWebpQuality: mildDownscale ? 0.92 : (isElectron ? 0.82 : 0.84),
        avatarJpegQuality: mildDownscale ? 0.92 : (isElectron ? 0.84 : 0.86),
        maxSide: capSide(mildDownscale ? 2560 : (isElectron ? 1792 : 2048)),
        // Fewer simultaneous canvases on big logs → lower peak memory.
        concurrency: renderProfile.huge ? 3 : renderProfile.large ? 4 : 6,
        intermediateCap: renderProfile.huge ? 1536 : renderProfile.large ? 2048 : 0,
        forceLossless: false,
        minOutSide: mildDownscale ? 256 : 1,
        // Print path only — restore() revokes blob URLs on afterprint.
        // Saves ~33% memory plus V8 string overhead vs data: URLs.
        useBlobURL: true,
      });
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchivePrint4"), err);
    }
  }

  if (!shouldDownscale && logEl) {
    try {
      restorePrepImages = fePrepareArchiveImagesForOutput(logEl, {
        restorePortraits: !portraitsAreBlanked,
      }) || (() => {});
    } catch {}
  }

  // P2: blank any image that STILL hasn't loaded so the print engine can't
  // decode it at full resolution mid-rasterization. Downscaled images carry
  // small blob:/data: sources (and may be transiently !complete right after the
  // swap), so they are explicitly excluded — only unresolved remote sources are
  // neutralized. Restored on afterprint via restoreStragglers.
  if (logEl && mode !== "hideAll") {
    try {
      restoreStragglers = tempDisableImages((img) => {
        if (img.complete && (img.naturalWidth || 0) > 0) return false;
        const s = img.getAttribute("src") || "";
        return !(s.startsWith("blob:") || s.startsWith("data:"));
      });
    } catch {}
  }

  try {
    setMeta(feLocalize("FE.ChatArchive.Status.LoadingFonts"));
    // The embedded data: URL faces are injected at RENDER time (feEnsureArchiveEmbeddedFonts,
    // in feRenderChatArchiveWindow) — NOT here. Reasons they must not be injected at print
    // time: the !important font overrides trigger a full text re-layout, so injecting right
    // before win.print() risks Chromium capturing the document mid-reflow. The earlier
    // objections that kept them out entirely are resolved: --fe-font-geurimilgi now routes to
    // the embedded Geurimilgi face (mixed preset works), and Font Awesome is re-asserted in the
    // embedded CSS so icons never fall back to □. So by the time we reach print, the popup
    // already carries self-contained faces; we only wait for them to finish loading.
    await feEnsureArchiveEmbeddedFonts(win);
    await feWaitForFonts(doc, FE_EXPORT_WAIT_FONTS_TIMEOUT);
  } catch {}

  try {
    win.focus();
  } catch {}
  try {
    void doc.body.offsetHeight;
  } catch {}

  // Wait for two paint frames so any pending layout/style changes (background
  // freeze, image src swaps) are fully composited before the print engine
  // captures the document. A single offsetHeight reflow is not enough when
  // style mutations queue micro-task paint work.
  //
  // THE TIMEOUT IS NOT OPTIONAL. MEASURED 2026-08-05, live, 2936-message log: this
  // await was the single largest cost of the whole print path — 3.1 s to reach it,
  // then 73 s sitting here. The archive popup opens BEHIND the Foundry window, so
  // its `document.visibilityState` is "hidden" (verified) and Chromium does not run
  // rAF for a hidden window at all. `win.focus()` two lines up does not help: focus
  // stealing is blocked. The old `catch` never fired either — a rAF that is simply
  // never serviced does not throw. So the user pressed "인쇄" (print) and waited a minute-plus
  // for a frame that only arrived when the compositor happened to wake the window,
  // which is why the delay looked random.
  //
  // Racing it is safe: `void doc.body.offsetHeight` above already forced a
  // synchronous layout, and a hidden window has no composited frame to wait for in
  // the first place. When the popup IS in front, two frames land in ~33 ms and the
  // timeout is never reached — behaviour there is unchanged.
  try {
    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(done, FE_EXPORT_PAINT_FRAME_TIMEOUT);
      try {
        win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
          clearTimeout(timer);
          done();
        }));
      } catch {
        clearTimeout(timer);
        setTimeout(done, 50);
      }
    });
  } catch {}

  try {
    restorePageBreaks = fePrepareImagesForPageBreaks(doc, logEl);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchivePrint5"), err);
  }

  try {
    win.print();
  } finally {
    setMeta(originalMeta);
    // Fallback restore in case afterprint doesn't fire (some Electron builds)
    setTimeout(restoreOnce, 0);
  }
}
