// Archive output helpers: visibility filtering, reversible DOM normalization,
// source restoration, font preparation, and image/font readiness waits.
// Self-contained; no Foundry module imports.

// `keepSelfContainedSrc`: the HTML-snapshot path passes true. A portrait whose
// src is ALREADY a data: URL (the HQ resample result — see fe-chat-portrait-image.js)
// needs no file to embed from: it is self-contained, and it is exactly the size the
// portrait box renders at. Restoring the original path there is actively harmful —
// it puts the <img> back into loading state (so feDownscaleImagesForPrint skips it),
// then hands feEmbedImagesInNode a full-resolution file that is dropped whenever it
// exceeds MAX_PER_IMAGE, leaving an absolute Foundry-origin URL in the saved HTML —
// which only the exporting user's browser can resolve. Any srcset is still stripped
// so nothing paints from a non-embedded candidate.
export function feRestoreOriginalPortraitSources(root, { keepSelfContainedSrc = false } = {}) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    const imgs = root.querySelectorAll('img.fe-chat-portrait, img.chat-portrait-message-portrait, img[data-fe-portrait-orig-src]');
    for (const img of imgs) {
      const orig = img.dataset?.fePortraitOrigSrc || img.getAttribute?.('data-fe-portrait-orig-src') || '';
      if (!orig) continue;
      // NEVER touch a portrait that feUpgradePortraitsForExport already replaced.
      // MEASURED 2026-08-05, live, 2936-message log — this guard's absence was a
      // print-preview killer. The print path runs the upgrade (fe-chat-archive.js
      // ~2689) and then fePrepareArchiveImagesForOutput (~2711), which calls this
      // function; without the guard it put the ORIGINAL FILE PATH back into src and
      // set loading="eager". Meanwhile feDownscaleImagesForPrint skips anything
      // carrying data-fe-export-portrait — so the upgrade's marker switched OFF the
      // only pass that was shrinking portraits, and this line threw away the
      // replacement that was supposed to make that safe. Net state at win.print():
      // 2774 <img> pointing at full-resolution originals (akari.png 3328x3677 in a
      // 64px box, x481; largest 3745x5539), 33 distinct sources totalling 69.7
      // MEGAPIXELS, all eager. Chromium's preview never became ready.
      if (img.dataset?.feExportPortrait) continue;
      const prevSrc = img.getAttribute('src');
      const prevSrcset = img.getAttribute('srcset');
      const prevLoading = img.getAttribute('loading');
      if (keepSelfContainedSrc && prevSrc && /^data:/i.test(prevSrc)) {
        if (!prevSrcset) continue;
        changed.push({ img, prevSrc, prevSrcset, prevLoading });
        img.removeAttribute('srcset');
        continue;
      }
      if (prevSrc === orig && !prevSrcset) continue;
      changed.push({ img, prevSrc, prevSrcset, prevLoading });
      img.setAttribute('src', orig);
      img.removeAttribute('srcset');
      img.setAttribute('loading', 'eager');
    }
  } catch {}
  return () => {
    for (const it of changed) {
      try {
        if (it.prevSrc == null) it.img.removeAttribute('src');
        else it.img.setAttribute('src', it.prevSrc);
        if (it.prevSrcset == null) it.img.removeAttribute('srcset');
        else it.img.setAttribute('srcset', it.prevSrcset);
        if (it.prevLoading == null) it.img.removeAttribute('loading');
        else it.img.setAttribute('loading', it.prevLoading);
      } catch {}
    }
  };
}

// Reverts blob: URLs (set by feDownscaleImagesForPrint when useBlobURL=true) back to
// the original src stashed on data-fe-print-orig-src. Used by HTML snapshot paths
// so saved HTML never contains blob: URLs that would die with the popup window.
export function feRestorePrintBlobSources(root) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    const imgs = root.querySelectorAll('img[data-fe-print-orig-src]');
    for (const img of imgs) {
      const orig = img.dataset?.fePrintOrigSrc || img.getAttribute?.('data-fe-print-orig-src') || '';
      if (!orig) continue;
      const prevSrc = img.getAttribute('src');
      const prevSrcset = img.getAttribute('srcset');
      if (prevSrc === orig && !prevSrcset) continue;
      changed.push({ img, prevSrc, prevSrcset });
      img.setAttribute('src', orig);
      img.removeAttribute('srcset');
    }
  } catch {}
  return () => {
    for (const it of changed) {
      try {
        if (it.prevSrc == null) it.img.removeAttribute('src');
        else it.img.setAttribute('src', it.prevSrc);
        if (it.prevSrcset == null) it.img.removeAttribute('srcset');
        else it.img.setAttribute('srcset', it.prevSrcset);
      } catch {}
    }
  };
}

export function fePatchInlineFontFamiliesForExport(root) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    for (const el of root.querySelectorAll('[style]')) {
      let ff = '';
      try {
        ff = el.style.getPropertyValue('font-family') || '';
      } catch {}
      if (!ff) continue;

      let next = ff;
      if (/FE\s+Geurimilgi/i.test(next)) {
        next = next.replace(/"?FE\s+Geurimilgi(?:\s+Embedded)?"?/gi, '"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", system-ui, sans-serif');
      }
      if (/FE\s+CookieRun/i.test(next) && !/FE\s+CookieRun\s+Embedded/i.test(next)) {
        next = next.replace(/FE\s+CookieRun/gi, '"FE CookieRun Embedded", "FE CookieRun"');
      }
      if (!/FE\s+CookieRun\s+Embedded/i.test(next) && !/FE\s+Geurimilgi\s+Embedded/i.test(next) && /\bSignika\b/i.test(next)) {
        next = '"FE CookieRun Embedded", "FE CookieRun", ' + next;
      }
      if (next === ff) continue;

      const prev = ff;
      const prevPriority = el.style.getPropertyPriority('font-family');
      changed.push({ el, prev, prevPriority });
      el.style.setProperty('font-family', next, 'important');
    }
  } catch {}
  return () => {
    for (const it of changed) {
      try {
        if (it.prev) it.el.style.setProperty('font-family', it.prev, it.prevPriority || '');
        else it.el.style.removeProperty('font-family');
      } catch {}
    }
  };
}

export function feInjectExportFontReadyBootstrap(headClone, doc) {
  try {
    const styleEl = doc.createElement('style');
    styleEl.id = 'fe-export-font-ready-gate';
    styleEl.textContent = 'html.fe-fonts-loading #fe-chat-export-container{visibility:hidden !important;}';
    headClone.appendChild(styleEl);

    const scriptEl = doc.createElement('script');
    scriptEl.id = 'fe-export-font-ready-script';
    scriptEl.textContent = `(function(){try{document.documentElement.classList.add("fe-fonts-loading");var done=function(){try{document.documentElement.classList.remove("fe-fonts-loading");}catch(_e){}};if(document.fonts&&document.fonts.ready){Promise.race([document.fonts.ready,new Promise(function(resolve){setTimeout(resolve,5000);})]).then(done,done);}else{done();}}catch(_err){}})();`;
    headClone.appendChild(scriptEl);
  } catch {}
}

export async function feWaitForFonts(doc, timeoutMs = 12000) {
  try {
    const fonts = doc?.fonts;
    if (!fonts?.ready) return;

    const loads = [fonts.ready.catch(() => {})];
    const families = [
      '400 16px "FE CookieRun Embedded"',
      '700 16px "FE CookieRun Embedded"',
      '900 16px "FE CookieRun Embedded"',
      '400 16px "FE Geurimilgi Embedded"',
      '400 16px "FE CookieRun"',
      '700 16px "FE CookieRun"',
      '400 16px "FE Geurimilgi"',
    ];
    for (const spec of families) {
      try {
        loads.push(fonts.load(spec, '가나다ABC123').catch(() => {}));
      } catch {}
    }

    await Promise.race([
      Promise.all(loads),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {}
}

export function feArchiveIsWhisperMessage(msg, liveEl = null) {
  try {
    const whisper = msg?.whisper;
    if (Array.isArray(whisper) && whisper.length) return true;
    if (!msg && feIsElement(liveEl)) return !!liveEl.classList?.contains?.("whisper");
  } catch {
    /* no-op */
  }
  return false;
}

// A ChatMessage *document* exposes `author` as a User document, so `.id` reads the user id.
// A raw DB *row* stores the same field as a plain user-id string (pre-v13 rows use `user`).
// Since the archive now filters raw rows before materializing them, both shapes reach the
// predicate below — reading `.id` off a string would silently yield undefined and drop the
// author's own whispers from their export.
function feMessageAuthorId(msg) {
  const author = msg?.author ?? msg?.user;
  if (!author) return null;
  return typeof author === "string" ? author : (author.id ?? null);
}

export function feCanUserSeeChatMessage(msg, user) {
  try {
    if (!msg) return false;

    // Whispers: visible to GM and recipients (and the author).
    const whisper = msg.whisper ?? [];
    if (Array.isArray(whisper) && whisper.length) {
      if (user?.isGM) return true;
      if (whisper.includes(user?.id)) return true;
      const authorId = feMessageAuthorId(msg);
      if (authorId && authorId === user?.id) return true;
      return false;
    }

    // Hidden messages are still visible to GMs.
    if (msg.hidden && !user?.isGM) return false;

    return true;
  } catch {
    return true;
  }
}

export function feNormalizeExportNode(rootEl, { loading = "eager", decoding = "sync" } = {}) {
  try {
    const baseHref = rootEl?.ownerDocument?.baseURI || window.location.href;

    // Normalize image URLs to absolute so print reliably loads them
    for (const img of rootEl.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src) continue;
      try {
        img.src = new URL(src, baseHref).href;
      } catch {}
      // Keep archive rendering memory-friendly for large logs.
      if (!img.getAttribute("loading")) img.setAttribute("loading", loading || "eager");
      if (!img.getAttribute("decoding")) img.setAttribute("decoding", decoding || "sync");
    }

    // Normalize anchor URLs too
    for (const a of rootEl.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (!href) continue;
      try {
        a.href = new URL(href, baseHref).href;
      } catch {}
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    }
  } catch {}
}

export function feNormalizeArchiveShellLayout(doc, { restore = false, root = null } = {}) {
  const changed = [];
  try {
    if (!doc?.querySelectorAll) return () => {};
    const scope = feIsElement(root) ? root : null;
    const inScope = (selector) => {
      if (!scope) return null;
      if (scope.matches?.(selector)) return scope;
      return scope.querySelector?.(selector) ?? null;
    };
    const targets = (scope
      ? [
          scope,
          inScope("#fe-chat-export-sidebar"),
          inScope("#fe-chat-export-chat"),
          inScope("#fe-chat-export-log"),
          inScope("#chat-log"),
        ]
      : [
          doc.getElementById?.("fe-chat-export-container"),
          doc.getElementById?.("fe-chat-export-sidebar"),
          doc.getElementById?.("fe-chat-export-chat"),
          doc.getElementById?.("fe-chat-export-log"),
          doc.getElementById?.("sidebar"),
          doc.getElementById?.("chat"),
          doc.getElementById?.("chat-log"),
        ]).filter(Boolean);
    for (const el of targets) {
      try {
        const prevStyle = restore ? el.getAttribute("style") : null;
        if (restore) changed.push({ el, prevStyle });
        el.style.setProperty("display", "block", "important");
        el.style.setProperty("width", "100%", "important");
        el.style.setProperty("inline-size", "100%", "important");
        el.style.setProperty("min-width", "0", "important");
        el.style.setProperty("min-inline-size", "0", "important");
        // Every target here is a shell container (never a media element), so the
        // container branch always applies: let it size to content and drop any
        // inherited max-width so the standalone archive viewport is not clamped.
        el.style.setProperty("max-width", "none", "important");
        el.style.setProperty("max-inline-size", "none", "important");
        el.style.setProperty("flex", "none", "important");
        el.style.setProperty("flex-basis", "auto", "important");
        el.style.setProperty("overflow", "visible", "important");
        el.style.setProperty("height", "auto", "important");
        el.style.setProperty("max-height", "none", "important");
      } catch {
        /* no-op */
      }
    }
  } catch {
    /* no-op */
  }
  return () => {
    for (let i = changed.length - 1; i >= 0; i -= 1) {
      const it = changed[i];
      try {
        if (it.prevStyle == null) it.el.removeAttribute("style");
        else it.el.setAttribute("style", it.prevStyle);
      } catch {
        /* no-op */
      }
    }
  };
}

// Returns an undo for the portrait-source restoration it performs.
//
// Only that part is reversible on purpose. The loading/decoding sweep below is
// deliberately NOT recorded: tempDisableImages and the straggler pass already
// record and restore `loading` for every image they touch, and a second undo for
// the same attribute would race theirs (each one replays a value snapshotted at a
// different point in the pass). An archive window left with eager/sync images
// after printing costs nothing; a portrait left on its full-resolution original
// src does — which is what this undo exists for.
export function fePrepareArchiveImagesForOutput(rootEl, { restorePortraits = true, decoding = "sync" } = {}) {
  let restorePortraitSources = () => {};
  try {
    if (!rootEl?.querySelectorAll) return () => {};
    if (restorePortraits) {
      try {
        restorePortraitSources = feRestoreOriginalPortraitSources(rootEl) || (() => {});
      } catch {}
    }
    // decoding:
    //  · "sync"  — originals will be printed as-is; force decode before win.print().
    //  · "async" — originals are about to be replaced by downscaled blobs, so a
    //              main-thread sync-decode storm is pure waste (and jank on large
    //              logs). Let Chromium decode off-thread; canvas drawImage still
    //              forces the decode it actually needs, one group at a time.
    const wantSync = decoding !== "async";
    for (const img of rootEl.querySelectorAll("img")) {
      try {
        img.setAttribute("loading", "eager");
        const cur = img.getAttribute("decoding");
        if (wantSync) {
          if (!cur || cur === "async") img.setAttribute("decoding", "sync");
        } else if (cur === "sync") {
          img.setAttribute("decoding", "async");
        }
      } catch {
        /* no-op */
      }
    }
  } catch {
    /* no-op */
  }
  return () => {
    try { restorePortraitSources(); } catch {}
  };
}

export function feNormalizeArchiveMessageLayout(root, { restore = false } = {}) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    // A Set, NOT an array + `includes` (MUST keep — measured, do not "simplify").
    // This runs once over the WHOLE archive log, so `targets` holds roughly ten
    // elements per message: ~25,000 entries for a 2,938-message campaign log.
    // `Array#includes` made every push a linear scan of everything collected so
    // far — O(n^2), ~3x10^8 comparisons — and showed up live (v14.365) as a
    // single ~4,000 ms `longtask` immediately after render, during which the
    // archive window and Foundry itself (same event loop) ignored clicks.
    // A Set dedupes in O(1) and preserves insertion order, so the write order
    // below is byte-for-byte the same.
    const targets = new Set();
    const push = (el) => {
      if (el) targets.add(el);
    };
    const messages = root.matches?.("li.chat-message") ? [root] : Array.from(root.querySelectorAll("li.chat-message"));
    // Per-message idempotence stamp (MUST keep — measured, do not remove as
    // "premature optimization"). Every message is normalized ONCE while it is
    // rendered (`feRenderExportMessageNode`) and then AGAIN by the whole-log
    // call in `feRenderChatArchiveWindow` — the second pass re-derived the same
    // ~10 targets per message and rewrote the same ~75 `!important` inline
    // properties. Measured live on v14.365 with a 2,938-message dx3rd log, the
    // whole-log pass alone was 223,237 setProperty + 84,708 querySelector calls
    // inside the single ~4,000 ms `longtask` that follows render — the window
    // (and Foundry, same event loop) ignored clicks for those seconds.
    //
    // The stamp is deliberately a flat marker and NOT a class signature. Every
    // class this function actually branches on is structural and set once when
    // the node is built (chat-message / message-header / message-content /
    // fe-archive-standard-content / chat-card / card-* / dice-* / message-sender
    // / name-stacked / title / subtitle / message-flavor / message-metadata).
    // The classes that DO change afterwards — `fe-merge-*`, user-colour classes,
    // `fe-archive-headerless` — are not consulted here at all, so keying the
    // stamp on the class attribute invalidated ~all 2,938 messages while
    // changing none of the output. Measured: with a class-attribute stamp the
    // whole-log pass still accounted for 1,506 of 2,513 samples inside the
    // block; a flat marker skips it outright.
    // Restore mode drops the stamp instead of setting it, so the re-normalize
    // after a print teardown always runs.
    const stamps = [];
    for (const msg of messages) {
      if (restore) {
        try { delete msg.dataset.feArchLayout; } catch { /* no-op */ }
      } else {
        if (msg.dataset?.feArchLayout === "1") continue;
        stamps.push(msg);
      }
      push(msg);
      push(msg.querySelector?.(":scope > .message-header"));
      push(msg.querySelector?.(":scope > .message-content"));
      push(msg.querySelector?.(":scope > .message-header .message-sender"));
      push(msg.querySelector?.(":scope > .message-header .message-flavor"));
      push(msg.querySelector?.(":scope > .message-header .flavor-text"));
      push(msg.querySelector?.(":scope > .message-header .message-metadata"));
      // NOTE: .dice-roll INTERNALS (.dice-result/.dice-formula/.dice-tooltip) are
      // intentionally NOT listed here. Core renders the dice card as a self-contained
      // flex-column + grid widget (the tooltip collapses via grid-template-rows:0fr).
      // Forcing width:100%/height:auto/flex:none onto those internals breaks the
      // collapse and makes the hidden die-breakdown overflow and overlap the
      // formula/total. The outer .dice-roll is still matched via ".message-content > *"
      // / ".card-content > *", so its width handling is preserved while the internal
      // layout is left to core CSS.
      for (const el of msg.querySelectorAll?.(":scope > .message-content > *, .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .card-header, .card-content, .details.card-content, .details.collapsible-content.card-content, .card-content > *, .details.card-content > *, .details.collapsible-content.card-content > *, .dice-roll") || []) push(el);
    }

    for (const el of targets) {
      try {
        const prevStyle = restore ? el.getAttribute("style") : null;
        if (restore) changed.push({ el, prevStyle });
        const isMessage = el.classList?.contains?.("chat-message");
        const isHeader = el.classList?.contains?.("message-header");
        const isContent = el.classList?.contains?.("message-content");
        const isPlainContent = el.classList?.contains?.("fe-archive-standard-content");
        const isCard = el.classList?.contains?.("chat-card") || el.classList?.contains?.("midi-chat-card") || el.classList?.contains?.("card-header") || el.classList?.contains?.("card-content") || el.classList?.contains?.("dice-roll") || el.classList?.contains?.("dice-result") || el.classList?.contains?.("dice-formula") || el.classList?.contains?.("dice-tooltip");
        const tag = String(el.tagName || '').toUpperCase();
        const isStructural = ["DIV", "SECTION", "ARTICLE", "ASIDE", "NAV", "FORM", "TABLE", "FIELDSET"].includes(tag);
        const isMedia = ["IMG", "VIDEO", "CANVAS", "SVG"].includes(tag);
        const isWideContainer = isMessage || isHeader || isContent || isCard || isStructural;
        if (isMedia) {
          el.style.setProperty("max-width", "100%", "important");
          el.style.setProperty("max-inline-size", "100%", "important");
          el.style.setProperty("height", "auto", "important");
        } else {
          el.style.setProperty("max-width", "none", "important");
          el.style.setProperty("max-inline-size", "none", "important");
        }
        if (isWideContainer) {
          if (isMessage) {
            el.style.setProperty("display", "block", "important");
            el.style.setProperty("width", "100%", "important");
            el.style.setProperty("inline-size", "100%", "important");
            el.style.setProperty("min-width", "0", "important");
            el.style.setProperty("min-inline-size", "0", "important");
            el.style.setProperty("height", "auto", "important");
            el.style.setProperty("min-height", "0", "important");
            el.style.setProperty("max-height", "none", "important");
            el.style.setProperty("flex", "none", "important");
            el.style.setProperty("flex-basis", "auto", "important");
            el.style.setProperty("align-self", "stretch", "important");
            el.style.setProperty("justify-self", "stretch", "important");
          } else {
            // Keep header/card display modes from CSS (grid/flex/none). Overwriting display here breaks
            // merge follow-hides, portrait header grids, and round-marker headers.
            if (!isMedia) {
              el.style.setProperty("width", "100%", "important");
              el.style.setProperty("inline-size", "100%", "important");
              el.style.setProperty("min-width", "0", "important");
              el.style.setProperty("min-inline-size", "0", "important");
              el.style.setProperty("max-width", "none", "important");
              el.style.setProperty("max-inline-size", "none", "important");
              el.style.setProperty("height", "auto", "important");
              el.style.setProperty("min-height", "0", "important");
              el.style.setProperty("max-height", "none", "important");
            }
            if (isContent || isPlainContent) {
              el.style.setProperty("display", "block", "important");
              el.style.setProperty("justify-content", "flex-start", "important");
              el.style.setProperty("align-content", "stretch", "important");
              el.style.setProperty("gap", "0", "important");
              el.style.setProperty("column-gap", "0", "important");
              el.style.setProperty("row-gap", "0", "important");
            }
            if (isCard || isContent || isStructural) {
              el.style.setProperty("flex", "none", "important");
              el.style.setProperty("flex-basis", "auto", "important");
              el.style.setProperty("box-sizing", "border-box", "important");
            }
          }
        } else {
          if (el.classList?.contains?.("message-sender") || el.classList?.contains?.("name-stacked") || el.classList?.contains?.("title") || el.classList?.contains?.("subtitle")) {
            el.style.setProperty("width", "100%", "important");
            el.style.setProperty("inline-size", "100%", "important");
            el.style.setProperty("min-width", "0", "important");
            el.style.setProperty("min-inline-size", "0", "important");
            el.style.setProperty("max-width", "none", "important");
            el.style.setProperty("max-inline-size", "none", "important");
          } else if (!isMedia) {
            el.style.setProperty("width", "auto", "important");
            if (el.classList?.contains?.("message-flavor") || el.classList?.contains?.("message-metadata")) {
              el.style.setProperty("min-width", "0", "important");
              el.style.setProperty("min-inline-size", "0", "important");
            }
          }
        }
      } catch {
        /* no-op */
      }
    }

    // Stamped only after the writes actually landed, so a throw mid-pass leaves
    // the message unstamped and it is retried on the next call.
    for (const msg of stamps) {
      try { msg.dataset.feArchLayout = "1"; } catch { /* no-op */ }
    }
  } catch {
    /* no-op */
  }
  return () => {
    for (let i = changed.length - 1; i >= 0; i -= 1) {
      const it = changed[i];
      try {
        if (it.prevStyle == null) it.el.removeAttribute("style");
        else it.el.setAttribute("style", it.prevStyle);
      } catch {
        /* no-op */
      }
    }
  };
}

export function feIsElement(node) {
  // Cross-window safe element check (avoid instanceof HTMLElement which fails across Window realms).
  return !!node && node.nodeType === 1;
}

export function feNextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Returns a Promise that resolves to the number of images that failed to load
// within the timeout (0 = all loaded successfully, >0 = some timed out or errored).
export function feWaitForImages(rootEl, timeoutMs = 10000, { maxImages = 800 } = {}) {
  try {
    if (!rootEl?.querySelectorAll) return Promise.resolve(0);

    // Avoid materializing a giant array for huge chat logs.
    const nodeList = rootEl.querySelectorAll("img[src]");
    if (!nodeList?.length) return Promise.resolve(0);

    // Hard cap: waiting on thousands of images can allocate too many listeners and stall.
    const imgs = [];
    let count = 0;
    for (const img of nodeList) {
      imgs.push(img);
      count++;
      if (count >= maxImages) break;
    }

    if (!imgs.length) return Promise.resolve(0);

    return new Promise((resolve) => {
      let done = false;
      let remaining = imgs.length;
      let failed = 0;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(remaining + failed); // unresolved plus permanently failed images
      }, timeoutMs);

      const onOne = (loaded = true) => {
        if (!loaded) failed++;
        remaining--;
        if (remaining > 0) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(failed);
      };

      for (const img of imgs) {
        try {
          // `complete` is true for both successfully loaded and permanently failed images.
          // Missing/404 images must NOT stall export until timeout.
          if (img.complete) {
            onOne((img.naturalWidth || 0) > 0);
            continue;
          }
          img.addEventListener?.("load", () => onOne((img.naturalWidth || 0) > 0), { once: true });
          img.addEventListener?.("error", () => onOne(false), { once: true });
        } catch {
          onOne(false);
        }
      }
    });
  } catch {
    return Promise.resolve(0);
  }
}

// ===========================================================================
// Shared low-level archive utilities
// Moved here (from fe-chat-archive.js) so BOTH the archive entry module and
// fe-archive-snapshot.js can import them without a circular import.
// ===========================================================================

// The one archive title string, used for the on-page header, the saved file's
// <title>, AND the download filename. It MUST be a single source: the desktop
// path used to derive its own copy for the filename while letting
// feRenderChatArchiveWindow title the document, so the two could disagree.
//
// The `?? game.world?.name` fallback below is retained only as v9-era defensive
// residue — it cannot fire on v13/v14. Package schema declares `id`, not `name`
// (common/packages/base-package.mjs:322), and there is no `name` getter, so
// game.world.name is undefined; `title` is {required: true, blank: false}, so it
// is never blank either. That is also why the old ||-vs-?? split between call
// sites was unobservable and safe to collapse.
export function feBuildArchiveTitleText() {
  const worldName = game.world?.title ?? game.world?.name ?? "";
  return worldName ? `Chat Log – ${worldName}` : "Chat Log";
}

// Attribute-context escape. Routes through core foundry.utils.escapeHTML, which
// ALSO escapes ' (the old local impl did not) — strictly safer for any quoting
// style. Self-contained fallback if the core API is absent.
export function feEscapeAttr(str) {
  const s = String(str ?? "");
  return globalThis.foundry?.utils?.escapeHTML?.(s)
    ?? s
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("'", "&#039;");
}

export function feGetFoundryBaseHref() {
  try {
    const route = (() => {
      try {
        const r = foundry?.utils?.getRoute?.("/");
        if (typeof r === "string" && r.length) return r;
      } catch {}
      return "/";
    })();

    const path = route.endsWith("/") ? route : `${route}/`;
    return new URL(path, window.location.origin).href;
  } catch {
    try {
      return new URL("/", window.location.origin).href;
    } catch {
      return "/";
    }
  }
}

const feArchiveDocumentOperations = new WeakSet();
export async function feRunArchiveDocumentOperation(doc, task) {
  if (!doc || typeof task !== "function") return false;
  if (feArchiveDocumentOperations.has(doc)) {
    ui.notifications?.warn("female_edition | 이 아카이브에서 다른 인쇄/저장 작업이 진행 중입니다.", { console: false });
    return false;
  }
  feArchiveDocumentOperations.add(doc);
  try {
    return await task();
  } finally {
    feArchiveDocumentOperations.delete(doc);
  }
}
