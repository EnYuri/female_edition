// Archive output helpers: visibility filtering, reversible DOM normalization,
// source restoration, font preparation, and image/font readiness waits.
// Self-contained; no Foundry module imports.

export function feRestoreOriginalPortraitSources(root) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    const imgs = root.querySelectorAll('img.fe-chat-portrait, img.chat-portrait-message-portrait, img[data-fe-portrait-orig-src]');
    for (const img of imgs) {
      const orig = img.dataset?.fePortraitOrigSrc || img.getAttribute?.('data-fe-portrait-orig-src') || '';
      if (!orig) continue;
      const prevSrc = img.getAttribute('src');
      const prevSrcset = img.getAttribute('srcset');
      const prevLoading = img.getAttribute('loading');
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

export function feNormalizeArchiveShellLayout(doc, { restore = false } = {}) {
  const changed = [];
  try {
    if (!doc?.querySelectorAll) return () => {};
    const targets = [
      doc.getElementById?.("fe-chat-export-container"),
      doc.getElementById?.("fe-chat-export-sidebar"),
      doc.getElementById?.("fe-chat-export-chat"),
      doc.getElementById?.("fe-chat-export-log"),
      doc.getElementById?.("sidebar"),
      doc.getElementById?.("chat"),
      doc.getElementById?.("chat-log"),
    ].filter(Boolean);
    for (const el of targets) {
      try {
        const prevStyle = restore ? el.getAttribute("style") : null;
        if (restore) changed.push({ el, prevStyle });
        el.style.setProperty("display", "block", "important");
        el.style.setProperty("width", "100%", "important");
        el.style.setProperty("inline-size", "100%", "important");
        el.style.setProperty("min-width", "0", "important");
        el.style.setProperty("min-inline-size", "0", "important");
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

export function fePrepareArchiveImagesForOutput(rootEl, { restorePortraits = true, decoding = "sync" } = {}) {
  try {
    if (!rootEl?.querySelectorAll) return;
    if (restorePortraits) {
      try {
        feRestoreOriginalPortraitSources(rootEl);
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
}

export function feNormalizeArchiveMessageLayout(root, { restore = false } = {}) {
  const changed = [];
  try {
    if (!root?.querySelectorAll) return () => {};
    const targets = [];
    const push = (el) => {
      if (el && !targets.includes(el)) targets.push(el);
    };
    const messages = root.matches?.("li.chat-message") ? [root] : Array.from(root.querySelectorAll("li.chat-message"));
    for (const msg of messages) {
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
        el.style.setProperty("max-width", "none", "important");
        el.style.setProperty("max-inline-size", "none", "important");
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

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve(remaining); // return count of images still waiting
      }, timeoutMs);

      const onOne = () => {
        remaining--;
        if (remaining > 0) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(0);
      };

      for (const img of imgs) {
        try {
          // `complete` is true for both successfully loaded and permanently failed images.
          // Missing/404 images must NOT stall export until timeout.
          if (img.complete) {
            onOne();
            continue;
          }
          img.addEventListener?.("load", onOne, { once: true });
          img.addEventListener?.("error", onOne, { once: true });
        } catch {
          onOne();
        }
      }
    });
  } catch {
    return Promise.resolve(0);
  }
}

