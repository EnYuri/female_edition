// Archive HTML-snapshot production for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Owns the "self-contained HTML file" concern:
// stylesheet inlining (@import + <link> phases), data-URL font embedding, image
// embedding + dedup, blob assembly, and the download/external-browser paths.
// Split out so the archive entry module keeps the render/print orchestration.
//
// The three shared low-level utils it needs (feEscapeAttr, feGetFoundryBaseHref,
// feRunArchiveDocumentOperation) live in fe-archive-output.js so both this module
// and the entry module import them from there — avoiding a circular import.
import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";
import {
  feBlobToDataURL,
  feFreezeMessageBackgroundsForPrint,
  feDownscaleImagesForPrint,
  feCompressImageBlobForEmbed,
} from "./fe-archive-image.js";
import {
  feRestoreOriginalPortraitSources,
  feRestorePrintBlobSources,
  fePatchInlineFontFamiliesForExport,
  feInjectExportFontReadyBootstrap,
  feNormalizeArchiveShellLayout,
  feNormalizeArchiveMessageLayout,
  feIsElement,
  feNextTick,
  feEscapeAttr,
  feGetFoundryBaseHref,
  feRunArchiveDocumentOperation,
  feBuildArchiveTitleText,
} from "./fe-archive-output.js";
import {
  cpBuildExportPortraitDataURL,
  cpClearExportPortraitCache,
} from "./fe-chat-portrait-image.js";
import {
  feRewriteSnapshotCSSURLs,
  feParseCssImports,
  feAssembleInlinedStyleBlock,
} from "./fe-archive-css.js";

// ===========================================================================
// Constants (export-snapshot only)
// ===========================================================================

// Matches a browser's own per-host connection limit — more in-flight fetches would just
// queue in the network stack while holding decoded blobs alive in JS.
const FE_EXPORT_EMBED_CONCURRENCY = 6;
const FE_EXPORT_RESOURCE_FETCH_TIMEOUT = 12000;
const FE_EXPORT_STYLESHEET_FETCH_TIMEOUT = 8000;
const FE_EXPORT_STYLESHEET_MAX_BYTES = 2_000_000;
const FE_EXPORT_STYLESHEET_TOTAL_BYTES = 10_000_000;

// Memoized embedded-font CSS (built once per session).
let feEmbeddedFontCssPromise = null;
let feEmbeddedFontCssValue = null;

// ===========================================================================
// Resource fetch + filename helpers
// ===========================================================================

async function feFetchWithTimeout(url, options = {}, timeoutMs = FE_EXPORT_RESOURCE_FETCH_TIMEOUT, consume = null) {
  const controller = new AbortController();
  const upstream = options?.signal;
  const abortFromUpstream = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener?.("abort", abortFromUpstream, { once: true });

  const timer = setTimeout(() => controller.abort(new DOMException("Export resource request timed out", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return typeof consume === "function" ? await consume(response, controller) : response;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener?.("abort", abortFromUpstream);
  }
}

function feSanitizeExportFilename(name, fallback = "chat-log") {
  return (
    String(name || "")
      .replaceAll(/[^a-zA-Z0-9ㄱ-힝\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || fallback
  );
}

// ===========================================================================
// HTML Snapshot Export  (blob build, download, external browser)
// ===========================================================================

// Fetch one same-origin stylesheet's text under the per-file size cap.
// Returns { cssText, bytes } or null. Shared by both inlining phases below.
async function feFetchSnapshotStylesheet(absolute) {
  try {
    const fetched = await feFetchWithTimeout(
      absolute,
      { credentials: "include" },
      FE_EXPORT_STYLESHEET_FETCH_TIMEOUT,
      async (response) => {
        if (!response.ok) return null;
        const declaredBytes = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(declaredBytes) && declaredBytes > FE_EXPORT_STYLESHEET_MAX_BYTES) return null;
        return { cssText: await response.text() };
      }
    );
    if (!fetched) return null;
    const bytes = new TextEncoder().encode(fetched.cssText).byteLength;
    if (bytes > FE_EXPORT_STYLESHEET_MAX_BYTES) return null;
    return { cssText: fetched.cssText, bytes };
  } catch {
    return null;
  }
}

async function feInlineSnapshotStylesheets(headClone, doc, setMeta = () => {}) {
  const baseURL = doc?.baseURI || window.location.href;
  // Shared byte budget across BOTH phases so a huge core <link> can't crowd out
  // the module styles (Phase A runs first, so module CSS is admitted first).
  const budget = { admitted: 0 };
  const sameOrigin = (abs) => {
    try { return new URL(abs).origin === window.location.origin; } catch { return false; }
  };

  setMeta("Embedding styles…");

  // -----------------------------------------------------------------------
  // Phase A: module/system stylesheets that Foundry injects as
  // `@import "..." layer(...)` inside a <style> block (NOT as <link>s — see
  // fe-archive-css.js). Without this, the saved standalone HTML keeps raw
  // relative @imports that cannot resolve offline: every fe-* sheet (and the
  // fonts they apply) vanishes, breaking the layout and the PDF font embed.
  // -----------------------------------------------------------------------
  let styleBlocks = [];
  try {
    styleBlocks = Array.from(headClone?.querySelectorAll?.("style") ?? [])
      .filter((el) => /@import/i.test(el.textContent || ""));
  } catch {
    styleBlocks = [];
  }

  if (styleBlocks.length) {
    const resolveAbs = (raw) => {
      try { return new URL(raw, baseURL).href; } catch { return String(raw ?? ""); }
    };

    // Unique same-origin, non-media @import URLs across all blocks, first-seen order.
    const importOrder = [];
    const seen = new Set();
    for (const el of styleBlocks) {
      for (const imp of feParseCssImports(el.textContent || "")) {
        if (imp.media) continue;
        const abs = resolveAbs(imp.url);
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (!sameOrigin(abs)) continue;
        importOrder.push(abs);
      }
    }

    const fetchedByUrl = new Map();
    let nextImport = 0;
    const importWorker = async () => {
      while (true) {
        const i = nextImport++;
        if (i >= importOrder.length) return;
        const abs = importOrder[i];
        const got = await feFetchSnapshotStylesheet(abs);
        if (got) fetchedByUrl.set(abs, got);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, importOrder.length) }, () => importWorker()));

    // Admit in first-seen order so the byte cap cannot race the cascade order.
    const inlinedByUrl = new Map();
    for (const abs of importOrder) {
      const got = fetchedByUrl.get(abs);
      if (!got || budget.admitted + got.bytes > FE_EXPORT_STYLESHEET_TOTAL_BYTES) continue;
      inlinedByUrl.set(abs, feRewriteSnapshotCSSURLs(got.cssText, abs));
      budget.admitted += got.bytes;
    }

    for (const el of styleBlocks) {
      try {
        const { text, rebuilt } = feAssembleInlinedStyleBlock(el.textContent || "", {
          resolveAbs,
          getInlinedCss: (abs) => (inlinedByUrl.has(abs) ? inlinedByUrl.get(abs) : null),
        });
        // A non-rebuilt block (one that also holds real rules) is left intact but
        // still gets its relative @import/url() refs absolutized so it loads online.
        el.textContent = rebuilt ? text : feRewriteSnapshotCSSURLs(el.textContent || "", baseURL);
      } catch {
        // Leave the block untouched if assembly throws.
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase B: real <link rel="stylesheet"> elements (mostly core CSS).
  // -----------------------------------------------------------------------
  let links = [];
  try {
    links = Array.from(headClone?.querySelectorAll?.('link[rel="stylesheet"]') ?? []);
  } catch {
    links = [];
  }
  if (!links.length) return;

  let nextIndex = 0;
  const results = new Array(links.length).fill(null);

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= links.length) return;
      const link = links[index];
      try {
        if (link.getAttribute("data-fe-disabled-link") === "1" || link.getAttribute("media") === "not all") continue;
        const href = link.getAttribute("href");
        if (!href) continue;
        const absolute = new URL(href, baseURL).href;
        if (!sameOrigin(absolute)) continue;
        const got = await feFetchSnapshotStylesheet(absolute);
        if (got) results[index] = { absolute, cssText: got.cssText, bytes: got.bytes };
      } catch {
        // Keep the original <link> when a stylesheet cannot be captured.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, links.length) }, () => worker()));

  // Admission and replacement stay in document order so the byte cap cannot
  // race and the original cascade order is preserved exactly.
  for (let index = 0; index < links.length; index += 1) {
    const result = results[index];
    if (!result || budget.admitted + result.bytes > FE_EXPORT_STYLESHEET_TOTAL_BYTES) continue;
    try {
      const link = links[index];
      const style = doc.createElement("style");
      style.setAttribute("data-fe-inline-stylesheet", result.absolute);
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = feRewriteSnapshotCSSURLs(result.cssText, result.absolute);
      link.replaceWith(style);
      budget.admitted += result.bytes;
    } catch {
      // A failed replacement leaves the original link intact.
    }
  }
}

async function feBuildArchiveHTMLSnapshotBlob(win, titleText = "Chat Log", { meta, bodyRoot = null } = {}) {
  if (!win || win.closed) throw new Error("Archive window is closed");
  const setMeta = typeof meta === "function" ? meta : () => {};

  const doc = win.document;
  const snapshotRoot = feIsElement(bodyRoot) ? bodyRoot : doc.body;
  const scopedBody = snapshotRoot !== doc.body;
  const bodyAttrs = (() => {
    try {
      const attrs = Array.from(doc.body?.attributes ?? []).map((a) => {
        const n = String(a?.name ?? "");
        const v = feEscapeAttr(String(a?.value ?? ""));
        return n ? `${n}="${v}"` : "";
      }).filter(Boolean);
      return attrs.length ? " " + attrs.join(" ") : "";
    } catch {
      return "";
    }
  })();
  const serializeSnapshotRoot = () => {
    const parts = feSerializeBodyToParts(snapshotRoot);
    return scopedBody ? [`<body${bodyAttrs}>`, ...parts, "</body>"] : parts;
  };

  // IMPORTANT (memory):
  // Do NOT deep-clone the full <html> tree for large logs.
  // Cloning thousands of chat messages can easily OOM Chromium/Electron.
  // Instead, clone only <head> (small) and serialize <body> directly.

  // ---
  // Head snapshot
  // ---
  const headClone = (doc.head ? doc.head.cloneNode(true) : doc.createElement("head"));

  // A scoped inline snapshot originates from Foundry's real application
  // document, whose <head> contains boot/module scripts. The archive needs its
  // styles and metadata, never executable application code. Popup/iframe heads
  // are already purpose-built, but applying this only to scoped snapshots keeps
  // the distinction explicit and prevents a saved chat file from booting Foundry.
  if (scopedBody) {
    try {
      headClone.querySelectorAll?.('script, noscript, link[rel="modulepreload"], link[rel="preload"][as="script"]')
        .forEach((el) => el.remove());
    } catch {}
  }

  // Ensure a stable <base> so relative URLs resolve when opening as file://
  try {
    const baseHref = (() => {
      try {
        const b = doc.querySelector?.("base")?.getAttribute?.("href") || doc.querySelector?.("base")?.href;
        if (b) return String(b);
      } catch {}
      return feGetFoundryBaseHref();
    })();

    let baseEl = headClone.querySelector?.("base");
    if (!baseEl) {
      baseEl = doc.createElement("base");
      headClone.prepend(baseEl);
    }
    baseEl.setAttribute?.("href", baseHref);
  } catch {}

  // Ensure title is correct
  try {
    let t = headClone.querySelector?.("title");
    if (!t) {
      t = doc.createElement("title");
      headClone.appendChild(t);
    }
    t.textContent = titleText;
  } catch {}

  // Make stylesheet hrefs absolute (helps when opening as file://)
  try {
    const baseForLinks = doc.baseURI ?? window.location.href;
    headClone.querySelectorAll?.('link[rel="stylesheet"]').forEach((l) => {
      try {
        const href = l.getAttribute("href");
        if (!href) return;
        l.setAttribute("href", new URL(href, baseForLinks).href);
      } catch {}
    });
  } catch {}

  // Preserve runtime stylesheet toggles in the saved HTML snapshot.
  // (HTMLLinkElement.disabled does not serialize.)
  try {
    const enableFonts = (() => {
      try {
        return !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
      } catch {
        return true;
      }
    })();

    if (!enableFonts) {
      const needleAbs = `/modules/${MODULE_ID}/styles/ui-font.css`;
      const needleRel = `modules/${MODULE_ID}/styles/ui-font.css`;
      headClone.querySelectorAll?.('link[rel="stylesheet"]').forEach((l) => {
        try {
          const href = l.getAttribute("href") || "";
          if (href.includes(needleAbs) || href.includes(needleRel)) l.remove();
        } catch {}
      });
    }
  } catch {}

  await feInlineSnapshotStylesheets(headClone, doc, setMeta);

  // Embed custom fonts (optional).
  if (feSetting(S.EXPORT_EMBED_FONTS)) {
    try {
      setMeta("Embedding fonts…");
      const fontCss = await feBuildEmbeddedCookieRunFontCSS();
      if (fontCss) {
        const styleEl = doc.createElement("style");
        styleEl.id = "fe-export-embedded-fonts";
        styleEl.textContent = fontCss;
        headClone.appendChild(styleEl);
        feInjectExportFontReadyBootstrap(headClone, doc);
      }
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed fonts", err);
    }
  }

  // ---
  // Body snapshot
  // ---
  let bodyParts = [""];
  const embedFonts = !!feSetting(S.EXPORT_EMBED_FONTS);
  const liveLogEl = snapshotRoot.matches?.("#fe-chat-export-log, #chat-log, ol.chat-log")
    ? snapshotRoot
    : snapshotRoot.querySelector?.("#fe-chat-export-log, #chat-log, ol.chat-log");
  const restoreBg = feFreezeMessageBackgroundsForPrint(win, liveLogEl);
  const restoreShell = feNormalizeArchiveShellLayout(doc, { restore: true, root: scopedBody ? snapshotRoot : null });
  const restoreLayout = feNormalizeArchiveMessageLayout(snapshotRoot, { restore: true });
  try {
    if (feSetting(S.EXPORT_EMBED_IMAGES)) {
      // Image embedding mutates img src/srcset to data: URLs. Apply in-place + revert
      // afterwards instead of cloning the entire body (cloning a large log doubles
      // the DOM tree in V8 heap right when we're about to allocate a giant outerHTML
      // string and a Blob).
      //
      // Declared OUT here, not inside the try: the fallback below runs on the LIVE
      // archive document, so an exception thrown anywhere between the upgrade and the
      // inner finally would otherwise leave every portrait permanently swapped to its
      // export bitmap (and marked data-fe-export-portrait) in the window the user is
      // still looking at, with no reference left to undo it.
      let portraitRestore = () => {};
      try {
        // Portraits first: re-resample each one from its ORIGINAL file at export
        // resolution. The data: URL currently on the element is sized for THIS screen
        // (size × dpr — 64px on a dpr-1 machine) and turns blocky the moment the saved
        // file is printed or zoomed. See feUpgradePortraitsForExport.
        portraitRestore = await feUpgradePortraitsForExport(snapshotRoot, { meta: setMeta }) || (() => {});
        setMeta("Embedding images…");
        // keepSelfContainedSrc: a portrait already showing a data: URL (the upgrade
        // above, or the live HQ result when the upgrade could not improve on it) stays
        // as-is. Restoring the original file path would push a full-resolution
        // image into the embed budget (and past its per-image cap), which is how
        // portraits ended up as absolute Foundry URLs — broken for every reader
        // but the exporter.
        const prepRestore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts, keepSelfContainedSrc: true });
        // P4: downscale images to small data: URLs BEFORE embedding. feEmbedImagesInNode
        // skips anything already `data:`, so this both shrinks the embedded payload
        // (far more images fit under the byte budget → better offline fidelity) and
        // cuts the saved-file size. maxTotalBytes guards against ballooning the HTML;
        // groups beyond the budget keep their original src and fall through to the
        // remote/embed path below. useBlobURL:false → real data: URLs that serialize.
        // Shared image-byte budget for the saved HTML. Pre-embed downscaling
        // spends part of it (dsStats.bytesUsed); feEmbedImagesInNode gets only
        // what's left so downscaled + leftover-embedded images never exceed it.
        // Shared ceiling for downscaled + embedded bytes. Raised 12MB → 24MB with the
        // per-image cap: overflowing it is not "a smaller file", it is images that only
        // load on this machine.
        const HTML_EMBED_TOTAL_BYTES = 24_000_000;
        const dsStats = {};
        let downscaleRestore = () => {};
        try {
          const embedLogEl = snapshotRoot.matches?.("#fe-chat-export-log, #chat-log, ol.chat-log")
            ? snapshotRoot
            : snapshotRoot.querySelector?.("#fe-chat-export-log, #chat-log, ol.chat-log");
          if (embedLogEl) {
            downscaleRestore = await feDownscaleImagesForPrint(win, embedLogEl, {
              meta: setMeta,
              useBlobURL: false,
              maxTotalBytes: HTML_EMBED_TOTAL_BYTES,
              stats: dsStats,
              dprCap: 1.5,
              minDpr: 1.0,
              webpQuality: 0.85,
              jpegQuality: 0.88,
              avatarDprCap: 1.5,
              avatarWebpQuality: 0.82,
              avatarJpegQuality: 0.84,
              maxSide: 1600,
              concurrency: 4,
              // Portraits restored to their original file path are mid-load here;
              // the grouping loop skips `!complete` images, so they would escape
              // downscaling entirely and reach the embed pass at full resolution.
              waitForPendingMs: 8000,
            });
          }
        } catch (e) {
          console.warn("female_edition | HTML export: pre-embed downscale failed", e);
        }
        const embedRestore = await feEmbedImagesInNode(snapshotRoot, {
          meta: setMeta,
          maxTotalBytes: Math.max(0, HTML_EMBED_TOTAL_BYTES - (dsStats.bytesUsed || 0)),
        });
        // Duplicated portrait bitmaps are NOT a problem left to solve here: the embed
        // pass ends in feDeduplicateInlineDataUrlsInNode, which keeps one copy of each
        // distinct data: URL and strips `src` from the rest, restoring them on open via
        // a tiny data-fe-img-ref bootstrap. VERIFIED 2026-08-05 on a 137-message export:
        // 134 portraits, 7 distinct bitmaps, "Deduplicated 127 inline image(s) (~3.0MB
        // saved)", and the saved file renders 134/134. A second sharing mechanism was
        // written here (one CSS background rule per bitmap) and removed — running after
        // the dedup pass it saw seven groups of one and never emitted a single rule.
        try {
          bodyParts = serializeSnapshotRoot();
        } finally {
          try { embedRestore?.(); } catch {}
          try { downscaleRestore?.(); } catch {}
          try { prepRestore?.(); } catch {}
          try { portraitRestore?.(); } catch {}
          // Consumed. A throw from serializeSnapshotRoot() runs this finally AND
          // then the fallback branch below, which owns the same closure — without
          // this the undo ran twice. It is idempotent today (the second pass
          // re-writes already-restored srcs over an emptied blob-URL set), so this
          // is not a live bug; it is removing the reliance on that.
          portraitRestore = () => {};
        }
      } catch (err) {
        console.warn("female_edition | HTML export: failed to embed images", err);
        // Fallback: still produce a valid snapshot. Self-contained portrait srcs
        // are kept for the same reason as the main path above.
        const restore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts, keepSelfContainedSrc: true });
        try {
          bodyParts = serializeSnapshotRoot();
        } finally {
          try { restore(); } catch {}
          try { portraitRestore?.(); } catch {}
        }
      }
    } else {
      const restore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts });
      try {
        bodyParts = serializeSnapshotRoot();
      } finally {
        try { restore(); } catch {}
      }
    }
  } finally {
    try { restoreLayout(); } catch {}
    try { restoreShell(); } catch {}
    try { restoreBg(); } catch {}
  }

  // ---
  // HTML wrapper (preserve attributes like lang/class)
  // ---
  const htmlEl = doc.documentElement;
  const htmlAttrs = (() => {
    try {
      const attrs = Array.from(htmlEl?.attributes ?? []).map((a) => {
        const n = String(a?.name ?? "");
        const v = feEscapeAttr(String(a?.value ?? ""));
        return n ? `${n}="${v}"` : "";
      }).filter(Boolean);
      return attrs.length ? " " + attrs.join(" ") : "";
    } catch {
      return "";
    }
  })();

  return new Blob(
    ["<!doctype html>\n", `<html${htmlAttrs}>`, "\n", headClone.outerHTML, "\n", ...bodyParts, "\n</html>"],
    { type: "text/html;charset=utf-8" }
  );
}

async function feDownloadArchiveHTML(win, titleText = "Chat Log", { bodyRoot = null } = {}) {
  if (!win || win.closed) return false;
  return feRunArchiveDocumentOperation(win.document, () => feDownloadArchiveHTMLUnlocked(win, titleText, { bodyRoot }));
}

async function feDownloadArchiveHTMLUnlocked(win, titleText = "Chat Log", { bodyRoot = null } = {}) {
  const metaEl = win.document.getElementById("fe-chat-export-meta");
  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const safeName = feSanitizeExportFilename(titleText);

  const filename = `${safeName}.html`;

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  try {
    const doc = win.document;

    setMeta("Preparing HTML…");
    const blob = await feBuildArchiveHTMLSnapshotBlob(win, titleText, { meta: setMeta, bodyRoot });

    setMeta("Downloading…");
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.warn("female_edition | failed to download archive HTML", err);
    return false;
  } finally {
    setMeta(originalMeta);
  }
}

// ===========================================================================
// Font Embedding  (data-URL encode fonts for self-contained HTML export)
// ===========================================================================

async function feBuildEmbeddedCookieRunFontCSS() {
  if (typeof feEmbeddedFontCssValue === "string") return feEmbeddedFontCssValue;
  if (feEmbeddedFontCssPromise) return feEmbeddedFontCssPromise;

  feEmbeddedFontCssPromise = (async () => {
  // Tries to fetch the CookieRun font files from the module and embed them as data: URLs.
  // On any uncaught error, record an empty string so subsequent calls skip retrying.
  try {
  // If files are not present, returns an empty string.
  //
  // IMPORTANT: Base64 embedding multi-megabyte fonts can easily crash Chromium/Electron
  // (OOM / STATUS_BREAKPOINT) due to base64 expansion + JS string memory overhead.
  // To keep exports reliable, we only embed when the server reports a small Content-Length.
  // CookieRun OTF files shipped with this module are ~0.9–1.0MB each.
  // Hakgyoansim Geurimilgi (TTF) is larger (~6MB).
  // We keep separate per-file caps to avoid accidentally embedding oversized TTF variants
  // of CookieRun while still allowing Geurimilgi to be included when the user explicitly
  // enables "embed custom fonts".
  const MAX_TOTAL_BYTES = 11_000_000; // binary before base64 expansion
  const MAX_PER_FILE_BYTES_COOKIE = 1_200_000;
  const MAX_PER_FILE_BYTES_GEUR = 7_000_000;
  let totalBytes = 0;

  const headSize = async (url) => {
    try {
      const res = await feFetchWithTimeout(url, { method: "HEAD", credentials: "include" });
      if (!res.ok) return null;
      const len = res.headers.get("content-length");
      const n = Number(len);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };

  const fetchFont = async (url, { perFileCap }) => {
    // Try to get a size estimate first.
    const size = await headSize(url);

    // Enforce caps using either the reported size, or a conservative streaming cap.
    const remaining = Math.max(0, MAX_TOTAL_BYTES - totalBytes);
    const cap = Math.max(0, Math.min(perFileCap, remaining));
    if (!cap) return null;

    if (size && (size > perFileCap || size > remaining)) return null;

    // Prefer the capped streaming fetch so exports still work on servers that:
    // - do not support HEAD
    // - omit Content-Length
    const got = await feFetchAsDataURLCapped(url, cap);
    if (!got?.dataUrl) return null;

    const bytes = size || got.bytes || 0;
    if (bytes && totalBytes + bytes > MAX_TOTAL_BYTES) return null;
    totalBytes += bytes;
    return got.dataUrl;
  };

  // Match ui-font.css unicode coverage (KR + basic Latin + Latin-1)
  const unicodeRange = "U+0020-007E, U+00A0-00FF, U+AC00-D7A3, U+1100-11FF, U+3130-318F";
  const weights = [
    // Prefer OTF first (smaller than TTF in this module)
    { weight: 400, name: "Regular", files: ["CookieRun%20Regular.otf", "CookieRun%20Regular.ttf"] },
    { weight: 700, name: "Bold", files: ["CookieRun%20Bold.otf", "CookieRun%20Bold.ttf"] },
    { weight: 900, name: "Black", files: ["CookieRun%20Black.otf", "CookieRun%20Black.ttf"] },
  ];

  const faces = [];
  for (const w of weights) {
    let dataUrl = null;
    let fmt = null;

    for (const f of w.files) {
      const url = `/modules/${MODULE_ID}/font/${f}`;
      const attempt = await fetchFont(url, { perFileCap: MAX_PER_FILE_BYTES_COOKIE });
      if (!attempt) continue;
      dataUrl = attempt;
      fmt = f.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
      break;
    }

    if (!dataUrl) continue;

    faces.push(
      `@font-face{font-family:"FE CookieRun Embedded";src:url(${dataUrl}) format("${fmt}");font-weight:${w.weight};font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
    );
  }

  // Optional: embed Hakgyoansim Geurimilgi.
  // If present, we embed it so saved file:// HTML keeps the same look.
  let geurimilgiEmbedded = false;
  try {
    const geurUrl = `/modules/${MODULE_ID}/font/HakgyoansimGeurimilgi-R.ttf`;
    const geurimilgiData = await fetchFont(geurUrl, { perFileCap: MAX_PER_FILE_BYTES_GEUR });
    if (geurimilgiData) {
      faces.push(
        `@font-face{font-family:"FE Geurimilgi Embedded";src:url(${geurimilgiData}) format("truetype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
      );
      geurimilgiEmbedded = true;
    }
  } catch {}

  // The normal UI imports the official NeoDGM Pro webfont. Re-assert the same
  // import in standalone file:// archive HTML, whose copied module stylesheet
  // cannot resolve its original relative location. The CDN font response permits
  // cross-origin use, so the saved HTML remains lightweight while online.
  const neodgmRule = `
@import url("https://cdn.jsdelivr.net/gh/neodgm/neodgm-pro-webfont@1.020/neodgm_pro/style.css");
/* NeoDGM Pro webfont: route every font var to the imported face. */
body.fe-fonts-enabled.fe-neodgm-mode,
body.fe-neodgm-mode {
  --fe-font-primary: "NeoDunggeunmo Pro", monospace;
  --fe-font-geurimilgi: "NeoDunggeunmo Pro", monospace;
  --fe-font-secondary: "NeoDunggeunmo Pro", monospace;
  --fe-chat-font-family: "NeoDunggeunmo Pro", monospace;
  font-kerning: normal;
  font-variant-ligatures: common-ligatures;
  font-feature-settings: "kern" 1, "liga" 1, "clig" 1;
}
body.fe-fonts-enabled.fe-neodgm-mode * {
  font-kerning: normal !important;
  font-variant-ligatures: common-ligatures !important;
  font-feature-settings: "kern" 1, "liga" 1, "clig" 1 !important;
}`;

  // Even if optional local faces fail to load, preserve the NeoDGM Pro webfont
  // rule so the selected pixel-font mode does not silently fall back.
  if (!faces.length) {
    // Do not cache the fallback-only result: local font requests may have failed
    // transiently, and a later export should get another chance to embed them.
    return neodgmRule;
  }

  // Geurimilgi routing for the mixed "쿠키런 + 그림일기" preset (small text / cards /
  // tooltips = Geurimilgi). If the face was embedded, the export MUST route the
  // geurimilgi var to it — otherwise that half of the mixed preset silently falls back
  // to a system font and only CookieRun shows ("하나만 적용" bug). If it could NOT be
  // embedded (over cap / fetch failed), keep the readable system stack.
  const geurimilgiSystemStack =
    `"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", system-ui, -apple-system, sans-serif, var(--fe-symbol-fallback)`;
  const geurimilgiStack = geurimilgiEmbedded
    ? `"FE Geurimilgi Embedded", "FE Geurimilgi", ${geurimilgiSystemStack}`
    : geurimilgiSystemStack;

  const css = `
/* female_edition: embedded CookieRun fonts (offline HTML export) */
${neodgmRule}
${faces.join("\n")}

/* Prefer the embedded faces when opening the saved HTML as file://
 * (remote font files are often blocked by CORS because the origin becomes "null").
 */
:root {
  --fe-symbol-fallback:
    "Segoe UI Symbol",
    "Segoe UI Emoji",
    "Apple Color Emoji",
    "Noto Color Emoji";

  --fe-font-primary:
    "FE CookieRun Embedded",
    "FE CookieRun",
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  /* Geurimilgi: prefer the embedded face when it was embedded (the mixed
   * CookieRun+Geurimilgi preset needs BOTH faces); else fall back to a readable
   * system UI stack. Built in JS above as geurimilgiStack. */
  --fe-font-geurimilgi: ${geurimilgiStack};

  /* Secondary stack (small text / chat-card descriptions). Mirrors ui-font.css's
   * :root default — follows the geurimilgi stack (embedded face when available). */
  --fe-font-secondary: var(--fe-font-geurimilgi);

  --fe-chat-card-system-font-family:
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  --font-primary: var(--fe-font-primary);
  --font-sans: var(--fe-font-primary);
  --font-serif: var(--fe-font-primary);
  --font-h1: var(--fe-font-primary);
  --font-h2: var(--fe-font-primary);
  --font-body: var(--fe-font-primary);

  /* dnd5e v5.2.x font vars (best-effort) */
  --dnd5e-font-roboto: var(--fe-font-primary);
  --dnd5e-font-roboto-slab: var(--fe-font-primary);
  --dnd5e-font-roboto-condensed: var(--fe-font-primary);
  --dnd5e-font-signika: var(--fe-font-primary);
  --dnd5e-font-modesto: var(--fe-font-primary);

  /* Chat font choice (default: CookieRun). Controlled via body class. */
  --fe-chat-font-family: var(--fe-font-primary);
}

body.fe-chat-font-cookie { --fe-chat-font-family: var(--fe-font-primary); }
body.fe-chat-font-cookie-all {
  --fe-font-geurimilgi: var(--fe-font-primary);
  --fe-font-secondary: var(--fe-font-primary);
  --fe-chat-font-family: var(--fe-font-primary);
}
body.fe-chat-font-geurimilgi {
  --fe-font-primary: var(--fe-font-geurimilgi);
  --fe-font-secondary: var(--fe-font-geurimilgi);
  --fe-chat-font-family: var(--fe-font-geurimilgi);
}
body.fe-ui-font-geurimilgi {
  --fe-ui-font-family: var(--fe-font-geurimilgi);
  --fe-dnd5e-label-font-family: var(--fe-font-geurimilgi);
}

/* Ensure the archive itself uses the embedded stack even when external CSS is partially blocked. */
html, body {
  font-family: var(--fe-ui-font-family, var(--fe-font-primary)) !important;
}

#fe-chat-export-container,


#fe-chat-export-container #fe-chat-export-sidebar,
#fe-chat-export-container #fe-chat-export-chat,
#fe-chat-export-container #fe-chat-export-log,
#fe-chat-export-container :is(#chat-log, #fe-chat-export-log) > li.chat-message {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
}
#fe-chat-export-container .chat-message,
#fe-chat-export-container .chat-message * {
  font-family: var(--fe-chat-font-family) !important;
}
/* 카드/박스 내부 — 라이브 ui-font.css와 동일하게 토글을 따른다. */
body.fe-fonts-enabled:not(.fe-chatcard-custom-font) #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat),
body.fe-fonts-enabled:not(.fe-chatcard-custom-font) #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat) * {
  font-family: var(--fe-chat-card-system-font-family) !important;
}
body.fe-fonts-enabled.fe-chatcard-custom-font #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat),
body.fe-fonts-enabled.fe-chatcard-custom-font #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat) * {
  font-family: var(--fe-font-secondary) !important;
}

#fe-chat-export-container :is(.fa-solid, .fa-regular, .fa-light, .fa-thin, .fa-duotone, .fa-brands, [class^="fa-"], [class*=" fa-"]) {
  font-family: "Font Awesome 6 Free", "Font Awesome 6 Pro", "Font Awesome 5 Free" !important;
}
`;

    feEmbeddedFontCssValue = css;
    return css;
  } catch {
    // A transient timeout/network failure must not poison every later export in
    // this Foundry session. Successful CSS is cached; failures remain retryable.
    return "";
  }
  })();

  try {
    return await feEmbeddedFontCssPromise;
  } finally {
    feEmbeddedFontCssPromise = null;
  }
}

async function feFetchAsDataURLCapped(url, maxBytes) {
  // Stream the response and abort if it exceeds maxBytes.
  // This avoids OOM when servers omit Content-Length.
  const cap = Math.max(0, Number(maxBytes) || 0);
  if (!cap) return null;

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), FE_EXPORT_RESOURCE_FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!res.ok) return null;

    // Respect content-length if present.
    try {
      const len = Number(res.headers.get("content-length") || 0);
      if (Number.isFinite(len) && len > 0 && len > cap) {
        try {
          controller.abort();
        } catch {}
        return null;
      }
    } catch {}

    // If streams aren't available, fall back to blob() (still capped).
    if (!res.body || typeof res.body.getReader !== "function") {
      const blob = await res.blob();
      if (blob.size > cap) return null;
      return { dataUrl: await feBlobToDataURL(blob), bytes: blob.size };
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength || value.length || 0;
      if (received > cap) {
        try {
          controller.abort();
        } catch {}
        return null;
      }
      chunks.push(value);
    }

    const blob = new Blob(chunks);
    if (blob.size > cap) return null;
    return { dataUrl: await feBlobToDataURL(blob), bytes: blob.size };
  } catch {
    try {
      controller.abort();
    } catch {}
    return null;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

// ===========================================================================
// Asset Embedding & HTML Preparation  (image embed, portrait restore,
//                                      font-family patch, font-ready bootstrap)
// ===========================================================================

async function feEmbedImagesInNode(root, { meta, maxTotalBytes } = {}) {
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
  const MAX_IMAGES = 600;
  // ~24MB (binary) before base64/string expansion. Caller may pass a smaller cap
  // (shared budget) — e.g. after pre-embed downscaling already spent part of it.
  const MAX_TOTAL_BYTES = Number.isFinite(maxTotalBytes) ? Math.max(0, maxTotalBytes) : 24_000_000;
  // ~4MB per image. The old 0.8MB dropped full-size NPC portrait art outright
  // whenever it escaped downscaling. Over this, the image is compressed (never dropped).
  const MAX_PER_IMAGE = 4_000_000;
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
            console.warn("female_edition | HTML export: image over per-image cap and not compressible", abs, blob.size);
            return null;
          }
          return { dataUrl: shrunk.dataUrl, size: shrunk.size, compressed: true };
        }
        // `blob` is kept so the commit loop can compress this image if it no longer
        // fits the remaining total budget. Cleared right after that decision so the
        // memoized entry doesn't pin bytes for the rest of the run.
        return { dataUrl: await feBlobToDataURL(blob), size: blob.size, blob };
      } catch (err) {
        console.warn("female_edition | HTML export: failed to embed image", abs, err);
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
          `Embedding images… stopped (limit reached: ${embeddedCount} images, ${(
            embeddedBytes /
            1024 /
            1024
          ).toFixed(1)}MB)`
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

      setMeta(`Embedding images… ${embeddedCount}/${MAX_IMAGES} (scanning ${i + 1}/${imgs.length})`);

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
          `female_edition | HTML export: ${leftovers.length} image(s) could NOT be embedded and still ` +
          `reference this server — they will appear broken for other viewers.`,
          leftovers.slice(0, 10)
        );
        setMeta(`Warning: ${leftovers.length} image(s) left un-embedded`);
      }
    } catch {}

    // Final pass: deduplicate identical inline data: URLs across the serialized HTML.
    // Each repeated <img src="data:..."> is reduced to a marker; a small bootstrap
    // script restores src at view time. Avoids N× base64 bloat for repeated avatars/portraits.
    dedupRestore = feDeduplicateInlineDataUrlsInNode(root, setMeta);
  } catch (err) {
    // The caller still gets `restore` with whatever's been recorded so far,
    // so the live archive window can recover from partial mutation.
    console.warn("female_edition | HTML export: embed pass aborted", err);
  }

  return restore;
}

function feDeduplicateInlineDataUrlsInNode(root, setMeta = () => {}) {
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
      try { setMeta(`Deduplicated ${dedupCount} inline image(s) (~${(savedBytes / 1024 / 1024).toFixed(1)}MB saved)`); } catch {}
    }
  } catch (err) {
    console.warn("female_edition | HTML export: image dedup pass failed", err);
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
function feSerializeBodyToParts(body) {
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
// 해상도" report. A 256px pre-cropped PNG costs ~60-100 KB and dedups across every
// message from the same actor, so the whole log usually adds well under 1 MB.
// The 4x multiplier IS the print budget: 300 DPI over CSS's 96 DPI reference is
// 3.125 device px per CSS px, so 4x covers 300 DPI with headroom at every portrait
// size. The ceiling only exists to bound the file, and MUST NOT be set below what the
// multiplier needs at the largest usable portrait size — at 512 it silently clipped
// every box above 128px (a 160px portrait needs ~500px at 300 DPI and got 512, a 200px
// one needs ~625 and still got 512), i.e. the exact ceiling this whole pass removes,
// reappearing for anyone who enlarged their portraits. 768 covers up to a 192px box.
const FE_EXPORT_PORTRAIT_SCALE = 4;
const FE_EXPORT_PORTRAIT_MAX_PX = 768;
// Total wall-clock the portrait pass may spend on NEW work. Sized against the 5 s
// per-source probe ceiling at concurrency 4: a batch of dead paths costs one round of
// timeouts, not one per source. Keep it well under the point where a user assumes the
// export has hung — everything past it degrades to "keep the original src", not to a
// failure.
const FE_EXPORT_PORTRAIT_BUDGET_MS = 10000;

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

    // Wall-clock budget for NEW work. MUST stay: cpWaitForImage puts a ceiling on each
    // source, and a source that 404s or hangs burns all of it. Past the deadline the
    // pass keeps running but only serves sources already resolved in the memo (free),
    // so repeated speakers still upgrade; everything else keeps its original src and
    // falls through to the normal embed path.
    const deadline = performance.now() + FE_EXPORT_PORTRAIT_BUDGET_MS;

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
      let dataUrl = null;
      try {
        dataUrl = await cpBuildExportPortraitDataURL(orig, {
          targetPx,
          fit,
          anchorTop: true,
          cachedOnly: performance.now() > deadline,
        });
      } catch {}
      if (!dataUrl) return;

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
      if (prevSrc === finalUrl && !prevSrcset) return;
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
          meta(`Preparing portraits… ${done}/${imgs.length}`);
        }
      }
    });
    await Promise.all(workers);
  } catch (err) {
    console.warn("female_edition | HTML export: portrait upgrade failed", err);
  }
  return () => {
    for (const it of changed) {
      try {
        if (it.prevSrc == null) it.img.removeAttribute("src");
        else it.img.setAttribute("src", it.prevSrc);
        if (it.prevSrcset == null) it.img.removeAttribute("srcset");
        else it.img.setAttribute("srcset", it.prevSrcset);
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

function fePrepareBodyForHTMLSnapshot(root, { embedFonts = false, keepSelfContainedSrc = false } = {}) {
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


// ---------------------------------------------------------------------------
// Inline Export — download from current (non-popup) document
// ---------------------------------------------------------------------------

async function feDownloadExportHTMLFromCurrentDocument() {
  try {
    const container = document.getElementById("fe-chat-export-container");
    if (!container) return false;

    const titleText = feBuildArchiveTitleText();
    // Reuse the popup/desktop snapshot pipeline, but serialize only the export
    // subtree. Head styles and body theme classes are retained; unrelated live
    // Foundry UI and out-of-range chat DOM never enter the saved file.
    return await feDownloadArchiveHTML(window, titleText, { bodyRoot: container });
  } catch (err) {
    console.warn("female_edition | failed to download export HTML", err);
    return false;
  }
}

export {
  feDownloadArchiveHTML,
  feBuildEmbeddedCookieRunFontCSS,
  feDownloadExportHTMLFromCurrentDocument,
};
