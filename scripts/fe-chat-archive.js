// Chat archive + HTML/PDF export (split)
// Kept in its own module so export-only logic can be isolated.

import {
  MODULE_ID,
  S,
  feSetting,
  feGetChatLogs,
  feApplyStyleVarsFromSettings,
  feStripChatTexturesInWindow,
  feApplyUserColorBgToMessageElement,
  feSetChatCardFontClass,
  feSetChatFontChoiceClass,
  feSetUiFontClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,
  feApplyChatMerge,
  feMessageMergeInfo,
  feMergeKey,
  feGetMessageIdFromElement,
} from "./fe-chat-enhance.js";

// Chat portrait: ensure exported/archive-rendered messages receive the same portrait injection.
import {
  feChatPortraitUpsert,
  feChatPortraitApplyVars,
} from "./fe-chat-portrait.js";

const FE_EXPORT_RENDER_BATCH = 64;
const FE_EXPORT_RENDER_CONCURRENCY = 6;
const FE_EXPORT_STATUS_EVERY = 25;
const FE_EXPORT_WAIT_IMAGES_MAX = 800;
const FE_EXPORT_WAIT_IMAGES_TIMEOUT = 20000;
const FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT = 15000;
const FE_EXPORT_WAIT_FONTS_TIMEOUT = 12000;
const FE_EXPORT_PORTRAIT_MARKER_SELECTOR = 'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container';
const FE_ARCHIVE_LARGE_LOG_THRESHOLD = 1600;
const FE_ARCHIVE_HUGE_LOG_THRESHOLD = 3200;
const FE_EXPORT_RENDER_BATCH_LARGE = 48;
const FE_EXPORT_RENDER_BATCH_HUGE = 32;
const FE_EXPORT_RENDER_CONCURRENCY_LARGE = 6;
const FE_EXPORT_RENDER_CONCURRENCY_HUGE = 4;
const FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE = 64;
const FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE = 32;
let feEmbeddedFontCssPromise = null;
let feEmbeddedFontCssValue = null;

function feGetArchiveRenderProfile(messageCount = 0) {
  const count = Math.max(0, Number(messageCount) || 0);
  const large = count >= FE_ARCHIVE_LARGE_LOG_THRESHOLD;
  const huge = count >= FE_ARCHIVE_HUGE_LOG_THRESHOLD;

  return {
    count,
    large,
    huge,
    lean: large,
    renderBatch: huge ? FE_EXPORT_RENDER_BATCH_HUGE : large ? FE_EXPORT_RENDER_BATCH_LARGE : FE_EXPORT_RENDER_BATCH,
    renderConcurrency: huge ? FE_EXPORT_RENDER_CONCURRENCY_HUGE : large ? FE_EXPORT_RENDER_CONCURRENCY_LARGE : FE_EXPORT_RENDER_CONCURRENCY,
    initialImageWaitMax: huge ? FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE : large ? FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE : FE_EXPORT_WAIT_IMAGES_MAX,
    mirrorTree: !large,
    mirrorCardTree: !huge,
    normalizeImageLoading: large ? "lazy" : "eager",
    normalizeImageDecoding: large ? "async" : "sync",
    deferPortraits: true,
    restoreOriginalPortraitSources: true,
    bodyClass: huge ? " fe-archive-huge fe-archive-lean" : large ? " fe-archive-lean" : "",
    statusLabel: large ? "메모리 절약 모드" : "",
  };
}

// -------------------------------------
// Export to PDF (Print)
// -------------------------------------

function feInjectExportButton(root = document) {
  if (!feSetting(S.EXPORT_ENABLED)) return;

  const controls =
    root.querySelector("#chat-controls") ||
    root.querySelector("#sidebar #chat #chat-controls") ||
    root.querySelector("#sidebar #chat .chat-controls") ||
    root.querySelector("#sidebar #chat .chat-control-icons") ||
    root.querySelector("#sidebar #chat .control-buttons") ||
    root.querySelector("#sidebar #chat form.chat-form");

  if (!controls) return;
  if (controls.querySelector(".fe-export-pdf")) return;

  const a = document.createElement("a");
  a.className = "control-icon fe-export-pdf";
  a.dataset.tooltip = "채팅 로그 내보내기(PDF/HTML)";
  a.ariaLabel = "채팅 로그 내보내기(PDF/HTML)";
  a.innerHTML = '<i class="fa-solid fa-file-pdf"></i>';

  a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await feExportChatLogToPDF();
  });

  controls.appendChild(a);
}

function feInjectExportButtonsAll() {
  feInjectExportButton(document);
  // also for popped-out chat logs if present
  for (const w of Object.values(ui.windows ?? {})) {
    const root = w?.element?.[0] ?? w?.element ?? null;
    if (root && typeof root.querySelector === "function") feInjectExportButton(root);
  }
}

function feEnsureExportContainer() {
  let container = document.getElementById("fe-chat-export-container");
  if (container) return container;

  container = document.createElement("div");
  container.id = "fe-chat-export-container";
  container.innerHTML = `
    <div class="fe-chat-export-toolbar">
      <div id="fe-chat-export-title">Chat Log</div>
      <div id="fe-chat-export-meta"></div>
      <div class="fe-chat-export-actions">
        <a class="fe-chat-export-action fe-chat-export-download" aria-label="Download HTML" data-tooltip="HTML 저장">HTML</a>
        <a class="fe-chat-export-action fe-chat-export-print" aria-label="Print" data-tooltip="인쇄 / PDF">🖨</a>
        <a class="fe-chat-export-action fe-chat-export-close" aria-label="Close" data-tooltip="닫기">✕</a>
      </div>
    </div>
    <ol id="fe-chat-export-log" class="chat-log"></ol>
  `;

  document.body.appendChild(container);

  const close = container.querySelector(".fe-chat-export-close");
  const printBtn = container.querySelector(".fe-chat-export-print");
  const dlBtn = container.querySelector(".fe-chat-export-download");

  const closeHandler = (ev) => {
    ev?.preventDefault?.();
    try {
      container.remove();
    } catch {}
    document.body.classList.remove("fe-print-chatlog");
  };

  if (close) close.addEventListener("click", closeHandler);
  if (printBtn) {
    printBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      window.print();
    });
  }
  if (dlBtn) {
    dlBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      feDownloadExportHTMLFromCurrentDocument();
    });
  }

  return container;
}

function feEnsurePrintCSSOverrides() {
  const styleId = "fe-chat-export-printfix";
  if (document.getElementById(styleId)) return;

  const style = document.createElement("style");
  style.id = styleId;
  style.textContent = `
@media print {
  html {
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
  }

  body.game.fe-print-chatlog {
    position: static !important;
    display: block !important;
    width: auto !important;
    height: auto !important;
    overflow: visible !important;
    background: #fff !important;
  }

  body.game.fe-print-chatlog > :not(#fe-chat-export-container) {
    display: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-container {
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

  body.game.fe-print-chatlog #fe-chat-export-container .fe-chat-export-toolbar {
    display: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-log {
    display: block !important;
    flex: none !important;
    height: auto !important;
    overflow: visible !important;
    max-height: none !important;
  }

  body.game.fe-print-chatlog #fe-chat-export-log .chat-message {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  @page {
    margin: 10mm;
  }
}
`;
  document.head.appendChild(style);
}

/**
 * Primary export entry point.
 *
 * Strategy:
 *  1) Try to open a dedicated "chat archive" popup window and render the log there.
 *     - Avoids Chromium/Electron print clipping caused by Foundry's fixed viewport.
 *     - Lets the user save/print like a normal web page (Ctrl+S / Print to PDF).
 *  2) If popups are blocked, fall back to the in-document export container.
 */
async function feExportChatLogToPDF() {
  // Prefer a separate archive window for reliable multi-page printing.
  const win = feOpenChatArchiveWindow();
  if (win) {
    try {
      const desktopExternalMode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
      const wantsExternalAuto = feIsElectron() && desktopExternalMode === "auto";
      const optimize = !!feSetting(S.EXPORT_OPTIMIZE);

      const worldName = game.world?.title || game.world?.name || "";
      const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

      await feRenderChatArchiveWindow(win, {
        autoPrint: wantsExternalAuto ? false : !!feSetting(S.EXPORT_AUTO_PRINT),
        optimize,
      });

      if (wantsExternalAuto) {
        await feOpenArchiveInExternalBrowser(win, titleText, { closeAfter: true });
      }
      return;
    } catch (err) {
      console.warn("female_edition | archive window export failed, falling back to inline export", err);
      try {
        win.close();
      } catch {}
    }
  }

  // Fallback: in-document export + print.
  await feExportChatLogToPDFInline();
}

// ---------------------------
// Export (Inline fallback)
// ---------------------------

async function feExportChatLogToPDFInline() {
  if (document.body.classList.contains("fe-print-chatlog")) return;

  // Foundry runs the app in a fixed viewport with overflow hidden.
  // Chromium printing will otherwise only capture the first visible page.
  const htmlEl = document.documentElement;
  const prevHtmlOverflow = htmlEl.style.overflow;
  const prevHtmlHeight = htmlEl.style.height;
  const prevBodyOverflow = document.body.style.overflow;
  const prevBodyHeight = document.body.style.height;

  document.body.classList.add("fe-print-chatlog");
  if (feSetting(S.EXPORT_OPTIMIZE)) document.body.classList.add("fe-export-optimized");

    // Ensure print CSS beats Foundry's body.game print rules (multi-page PDF fix)
    feEnsurePrintCSSOverrides();

  // Ensure the document can extend beyond the viewport.
  htmlEl.style.overflow = "visible";
  htmlEl.style.height = "auto";
  document.body.style.overflow = "visible";
  document.body.style.height = "auto";
  const container = feEnsureExportContainer();
  const titleEl = container.querySelector("#fe-chat-export-title");
  const metaEl = container.querySelector("#fe-chat-export-meta");
  const logEl = container.querySelector("#fe-chat-export-log");

  // Match the current chat-log class list as closely as possible (theme, sizing, etc.)
  const sampleLog = document.querySelector("ol.chat-log, #chat-log");
  if (sampleLog?.className) logEl.className = sampleLog.className;

  // Keep our id stable
  logEl.id = "fe-chat-export-log";
  logEl.innerHTML = "";

  try {
    const messages = feCollectVisibleChatMessages(game.user);
    const renderProfile = feGetArchiveRenderProfile(messages.length);

    // Header/meta
    const worldName = game.world?.title ?? game.world?.name ?? "";
    const sceneName = canvas?.scene?.name ?? "";
    titleEl.textContent = worldName ? `Chat Log – ${worldName}` : "Chat Log";
    metaEl.textContent = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

    // Prefer cloning from the already-rendered live chat log DOM when possible.
    const liveMessageMap = feBuildLiveChatMessageElementMap();

    await feRenderMessagesIntoLog({
      targetDoc: document,
      logEl,
      messages,
      metaEl,
      yieldWindow: window,
      liveMessageMap,
      annotateExportMessage: false,
      renderProfile,
    });

    try { feNormalizeArchiveShellLayout(document); } catch {}

    // Apply merge styling to export log (our mutation observer is scoped to #sidebar)
    if (feSetting(S.MERGE_ENABLED)) {
      feSyncArchiveMergeBodyClasses(document);
      feApplyChatMerge(logEl, feArchiveMergeOptions());
      feRefreshPortraitsForLog(logEl);
    } else if (renderProfile.deferPortraits) {
      feRefreshPortraitsForLog(logEl);
    }

    // Wait for images (portraits, item icons) to load so they actually print
    metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
    await feWaitForImages(logEl, FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });

    // IMPORTANT: Force a paginatable layout.
    // If any part of the export UI remains a fixed/scroll container, Chromium printing will
    // often clip to a single page.
    try {
      container.style.position = "static";
      container.style.inset = "auto";
      container.style.width = "auto";
      container.style.height = "auto";
      container.style.overflow = "visible";
      logEl.style.display = "block";
      logEl.style.height = "auto";
      logEl.style.maxHeight = "none";
      logEl.style.overflow = "visible";
    } catch {}

    // Force a synchronous reflow before printing.
    // Avoid relying on timers here (background tabs clamp setTimeout).
    try {
      // eslint-disable-next-line no-unused-expressions
      container.offsetHeight;
      // eslint-disable-next-line no-unused-expressions
      logEl.offsetHeight;
    } catch {}

    metaEl.textContent = "Opening print dialog…";

    // Cleanup after printing; keep a close button as a fallback.
    const cleanup = () => {
      try {
        container.remove();
      } catch {}
      document.body.classList.remove("fe-print-chatlog");
      document.body.classList.remove("fe-export-optimized");

      // Restore document sizing
      htmlEl.style.overflow = prevHtmlOverflow;
      htmlEl.style.height = prevHtmlHeight;
      document.body.style.overflow = prevBodyOverflow;
      document.body.style.height = prevBodyHeight;
    };

    const afterPrint = () => cleanup();
    window.addEventListener("afterprint", afterPrint, { once: true });

    window.print();

    // Some environments (Electron) don't always fire afterprint reliably.
    // The close button remains available; also attempt a delayed cleanup if print returns immediately.
    setTimeout(() => {
      if (document.body.classList.contains("fe-print-chatlog") && !document.getElementById("fe-chat-export-container")) {
        document.body.classList.remove("fe-print-chatlog");
        document.body.classList.remove("fe-export-optimized");
      }
    }, 0);
  } catch (err) {
    console.error(err);
    ui.notifications?.error("Chat log PDF export failed. Check the console for details.");
  }
}

// ---------------------------
// Export (Archive window)
// ---------------------------

function feOpenChatArchiveWindow() {
  try {
    // Reuse the same window if the user exports repeatedly.
    const features = [
      "popup=yes",
      "width=1100",
      "height=800",
      "left=100",
      "top=80",
    ].join(",");

    const win = window.open("", "fe-chat-archive", features);
    if (!win || win.closed) return null;

    try {
      win.focus();
    } catch {}
    return win;
  } catch {
    return null;
  }
}

function feCollectHeadStylesHTML() {
  try {
    const baseHref = feGetFoundryBaseHref();

    // Copy all stylesheet links and injected <style> tags.
    // This makes the archive render match the Foundry UI as closely as possible.
    const nodes = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'));
    return nodes
      .map((n) => {
        // IMPORTANT:
        // Some settings (including this module's "enableFonts") toggle stylesheets by setting
        // HTMLLinkElement.disabled. That state is not reliably preserved by outerHTML.
        // Preserve it explicitly for the archive window.
        try {
          if (n?.tagName === "LINK") {
            const c = n.cloneNode(true);

            // Ensure the disabled state is copied.
            c.disabled = !!n.disabled;

            // IMPORTANT: Archive windows use about:blank as their URL.
            // If we keep relative hrefs (e.g. modules/..), they can resolve incorrectly
            // when Foundry is hosted under a route prefix or when the game URL ends with /game/.
            // Rewrite hrefs to absolute URLs rooted at the Foundry route prefix.
            try {
              const href = c.getAttribute("href");
              if (href) c.setAttribute("href", new URL(href, baseHref).href);
            } catch {}

            return c.outerHTML;
          }
        } catch {
          /* fall through */
        }
        return n.outerHTML;
      })
      .join("\n");
  } catch {
    return "";
  }
}

/**
 * Best-effort base href rooted at Foundry's route prefix.
 *
 * Why:
 * - The game client URL is commonly /<prefix>/game
 * - But static assets live under /<prefix>/modules, /<prefix>/systems, /<prefix>/icons, ...
 * - Using document.baseURI (often /<prefix>/game/) makes relative assets resolve to /game/modules/... (wrong)
 */
function feGetFoundryBaseHref() {
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

/**
 * Apply module settings which toggle stylesheets via JS (e.g. enableFonts -> ui-font.css).
 * The archive window is a new Document, so we must re-apply these toggles explicitly.
 */
function feApplyModuleStylesheetSettingsToDocument(doc) {
  try {
    if (!doc?.querySelectorAll) return;

    // chat-bg-stripper.js controls the ui-font.css <link> using HTMLLinkElement.disabled.
    let enableFonts = true;
    try {
      enableFonts = !!game.settings.get(MODULE_ID, "enableFonts");
    } catch {
      enableFonts = true;
    }

    const needleAbs = `/modules/${MODULE_ID}/styles/ui-font.css`;
    const needleRel = `modules/${MODULE_ID}/styles/ui-font.css`;

    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const l of links) {
      try {
        const hrefAttr = l.getAttribute("href") || "";
        const hrefAbs = l.href || "";
        const match =
          hrefAttr.includes(needleAbs) ||
          hrefAbs.includes(needleAbs) ||
          hrefAttr.includes(needleRel) ||
          hrefAbs.includes(needleRel);
        if (!match) continue;
        l.disabled = !enableFonts;
      } catch {
        /* no-op */
      }
    }

    // Mirror the "hideChatPortraits" body class toggle too (defensive).
    try {
      const hidePortraits = !!game.settings.get(MODULE_ID, "hideChatPortraits");
      doc.body?.classList?.toggle?.("fe-hide-portraits", hidePortraits);
    } catch {
      /* no-op */
    }
  } catch (err) {
    console.warn("female_edition | failed to apply module stylesheet settings to archive document", err);
  }
}

function feSyncArchiveMergeBodyClasses(doc) {
  try {
    const enabled = !!feSetting(S.MERGE_ENABLED);
    const style = String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
    doc?.body?.classList?.toggle?.("fe-chat-merge", enabled);
    doc?.body?.classList?.toggle?.("fe-merge-follow-hide", enabled && style === "hide");
    doc?.body?.classList?.toggle?.("fe-merge-follow-name", enabled && style === "name");
    doc?.body?.classList?.toggle?.("fe-merge-follow-portrait", enabled && style === "portrait");
  } catch {
    /* no-op */
  }
}

function feRefreshPortraitsForLog(logEl) {
  try {
    if (!logEl?.querySelectorAll) return;
    for (const el of logEl.querySelectorAll("li.chat-message")) {
      const id = feGetMessageIdFromElement(el);
      const msg = id ? game.messages?.get(id) : null;
      if (!msg) continue;
      feChatPortraitUpsert(msg, el);
    }
  } catch {
    /* no-op */
  }
}

function feArchiveMergeOptions() {
  return {
    // Archive/print does not rely on narrator headers, so allowing narrator-only groups to merge
    // keeps PDF/HTML closer to the live visual grouping while still avoiding cross-type merges.
    allowNarratorMerge: true,
  };
}

function feEscapeAttr(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function feEscapeHTML(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}


function feCoerceElement(node) {
  try {
    if (feIsElement(node)) return node;
    if (node?.jquery && feIsElement(node[0])) return node[0];
    if (Array.isArray(node) && feIsElement(node[0])) return node[0];
    if (feIsElement(node?.[0])) return node[0];
  } catch {}
  return null;
}

function feCoerceChatMessageElement(node) {
  const el = feCoerceElement(node);
  if (!el) return null;
  try {
    if (el.matches?.("li.chat-message")) return el;
    return el.querySelector?.("li.chat-message") || el.closest?.("li.chat-message") || el;
  } catch {
    return el;
  }
}

function feStampArchiveMessageIdentity(node, msg) {
  try {
    if (!node || !msg) return;
    const id = String(msg?.id ?? msg?._id ?? "").trim();
    if (!id) return;
    node.dataset.messageId = id;
    node.dataset.documentId = id;
    node.setAttribute?.("data-message-id", id);
    node.setAttribute?.("data-document-id", id);
  } catch {
    /* no-op */
  }
}

async function feTryFoundryRenderMessage(_msg) {
  // Intentionally disabled in export/archive.
  // Calling ChatLog.renderMessage / ChatMessage.renderHTML for every archived message
  // triggers Foundry's backwards-compatibility path for deprecated renderChatMessage hooks
  // in third-party modules. For export we prefer: live DOM clone -> custom fallback.
  return null;
}

function feCollectVisibleChatMessages(user = game.user) {
  const all = Array.from(game.messages?.contents ?? []);
  all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  return all.filter((m) => feCanUserSeeChatMessage(m, user));
}

function feHasPortraitMarkup(rootEl) {
  try {
    return !!rootEl?.querySelector?.(FE_EXPORT_PORTRAIT_MARKER_SELECTOR);
  } catch {
    return false;
  }
}

async function feRenderMessagesIntoLog({
  targetDoc,
  logEl,
  messages,
  metaEl = null,
  yieldWindow = window,
  liveMessageMap = null,
  annotateExportMessage = false,
  renderProfile = null,
} = {}) {
  if (!targetDoc || !logEl || !Array.isArray(messages) || !messages.length) return 0;

  const flushEvery = Math.max(1, Number(renderProfile?.renderBatch) || FE_EXPORT_RENDER_BATCH);
  const concurrency = Math.max(1, Number(renderProfile?.renderConcurrency) || FE_EXPORT_RENDER_CONCURRENCY);
  const deferPortraits = !!renderProfile?.deferPortraits;
  let renderedCount = 0;
  let frag = targetDoc.createDocumentFragment();
  let fragCount = 0;

  const flush = async () => {
    if (fragCount) {
      logEl.appendChild(frag);
      frag = targetDoc.createDocumentFragment();
      fragCount = 0;
    }
    await feMaybeYieldForUI(yieldWindow);
  };

  const renderOne = async (msg) => {
    const msgId = String(msg?.id ?? msg?._id ?? "");
    const liveEl = msgId && typeof liveMessageMap?.get === "function" ? liveMessageMap.get(msgId) : null;
    const node = await feRenderExportMessageNode(targetDoc, msg, { liveEl, renderProfile });
    if (!feIsElement(node)) return null;

    if (annotateExportMessage) node.classList.add("fe-export-message");

    feNormalizeExportNode(node, {
      loading: renderProfile?.normalizeImageLoading,
      decoding: renderProfile?.normalizeImageDecoding,
    });
    feApplyUserColorBgToMessageElement(msg, node);

    if (!deferPortraits) {
      try {
        if (!feHasPortraitMarkup(node)) feChatPortraitUpsert(msg, node);
      } catch {}
    }

    return node;
  };

  for (let start = 0; start < messages.length; start += concurrency) {
    const slice = messages.slice(start, start + concurrency);
    const nodes = await Promise.all(slice.map((msg) => renderOne(msg)));

    for (let i = 0; i < nodes.length; i += 1) {
      renderedCount += 1;
      if (metaEl && (renderedCount === 1 || renderedCount % FE_EXPORT_STATUS_EVERY === 0 || renderedCount === messages.length)) {
        try {
          metaEl.textContent = `Rendering… ${renderedCount}/${messages.length}`;
        } catch {}
      }

      const node = nodes[i];
      if (!feIsElement(node)) continue;
      frag.appendChild(node);
      fragCount += 1;
    }

    if (fragCount >= flushEvery) await flush();
  }

  if (fragCount) await flush();
  return renderedCount;
}

async function feRenderExportMessageNode(targetDoc, msg, { liveEl = null, renderProfile = null } = {}) {
  let node = null;
  const preferStandardFallback = feArchiveShouldUseStandardFallback(msg, liveEl);

  if (!preferStandardFallback && feIsElement(liveEl)) {
    try {
      node = targetDoc?.importNode ? targetDoc.importNode(liveEl, true) : liveEl.cloneNode(true);
      feMirrorLiveMessageStyles(liveEl, node, { renderProfile });
    } catch {
      node = null;
    }
  }

  if (!feIsElement(node)) {
    try {
      node = feFallbackRenderChatMessage(targetDoc || document, msg);
    } catch {
      node = null;
    }
  }

  if (feIsElement(node)) {
    try {
      feStampArchiveMessageIdentity(node, msg);
      feMarkPlainArchiveMessage(node, msg, liveEl);
    } catch {}
  }

  if (feIsElement(node) && renderProfile?.restoreOriginalPortraitSources) {
    try {
      feRestoreOriginalPortraitSources(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feNormalizeArchiveMessageLayout(node);
    } catch {}
  }

  return feIsElement(node) ? node : null;
}

function feSanitizeFilename(name) {
  const s = String(name ?? "")
    .trim()
    // Windows reserved characters
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return s.slice(0, 120);
}

function feIsElectron() {
  try {
    if (window?.process?.versions?.electron) return true;
  } catch {}
  try {
    const ua = String(navigator?.userAgent ?? "");
    if (ua.includes("Electron")) return true;
  } catch {}
  return false;
}

function feTryRequire(moduleName) {
  try {
    const req = window.require || globalThis.require;
    if (!req) return null;
    return req(moduleName);
  } catch {
    return null;
  }
}

async function feRenderChatArchiveWindow(win, { autoPrint = false, optimize = false } = {}) {
  if (!win || win.closed) throw new Error("Archive window is not available.");

  // Treat the chat-bg-stripper's "채팅 카드 텍스쳐 제거" setting as an implicit
  // export optimization request. Users expect the archive/saved HTML to match the
  // live chat appearance.
  const stripTexturesSetting = (() => {
    try {
      return !!game.settings.get(MODULE_ID, "stripChatTextures");
    } catch {
      return false;
    }
  })();
  const effectiveOptimize = !!optimize || stripTexturesSetting;

  // Collect messages first (so the archive UI can show correct counts immediately).
  const messages = feCollectVisibleChatMessages(game.user);
  const renderProfile = feGetArchiveRenderProfile(messages.length);

  const worldName = game.world?.title ?? game.world?.name ?? "";
  const sceneName = canvas?.scene?.name ?? "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";
  const metaParts = [`${messages.length} messages`];
  if (sceneName) metaParts.push(sceneName);
  if (renderProfile.statusLabel) metaParts.push(renderProfile.statusLabel);
  const metaText = metaParts.join(" • ");

  // Build the archive document.
  const headStyles = feCollectHeadStylesHTML();
  const baseHref = feEscapeAttr(feGetFoundryBaseHref());

  // Desktop (Electron) can optionally open the archive in the system browser.
  const desktopExternalMode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  const showExternalBtn = feIsElectron() && desktopExternalMode !== "off";
  const externalBtnHTML = showExternalBtn
    ? `<a class="fe-chat-export-action fe-chat-export-external" id="fe-archive-external" data-tooltip="외부 브라우저로 열기">브라우저</a>`
    : "";

  // Print/PDF image handling (Chrome/Electron can freeze on image-heavy pages)
  const printImgMode = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "hideAvatars");
  const printImgClass =
    printImgMode === "hideAll"
      ? " fe-print-hide-all"
      : printImgMode === "downscale"
        ? " fe-print-downscale"
        : printImgMode === "downscaleLite"
          ? " fe-print-downscale-lite"
          : printImgMode === "hideAvatars"
            ? " fe-print-hide-avatars"
            : "";

  // Keep Foundry/system/theme classes for variable definitions, then force a printable layout.
  const bodyClass = `${document.body.className ?? ""} fe-print-chatlog fe-chat-archive${renderProfile.bodyClass}${effectiveOptimize ? " fe-export-optimized" : ""}${printImgClass}`;

  win.document.open();
  win.document.write(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <base href="${baseHref}">
    <title>${feEscapeHTML(titleText)}</title>
    ${headStyles}
    <style>
      /* Archive window hard overrides: make the document paginatable (no fixed viewport). */
      html, body {
        /* Keep on-screen and PDF colors as close as possible */
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        position: static !important;
        height: auto !important;
        min-height: 0 !important;
        overflow: visible !important;
        width: auto !important;
        background: #fff !important;
      }

      /* Keep the export container in normal flow. */
      #fe-chat-export-container {
        display: block !important;
        position: static !important;
        inset: auto !important;
        overflow: visible !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        padding: 12mm !important;
        margin: 0 !important;
      }

      /* Archive layout width
       * - Old behavior: hard-locked to Foundry sidebar width (~360px)
       * - New behavior: use a natural page width (better readability in HTML/PDF)
       */
      #fe-chat-export-container .fe-chat-export-toolbar,
      #fe-chat-export-container #fe-chat-export-sidebar {
        width: 100% !important;
        max-width: none !important;
        min-width: 0 !important;
        margin-left: 0 !important;
        margin-right: 0 !important;
      }

      /* Minimal Foundry sidebar/chat structure so existing system/module CSS applies. */
      #fe-chat-export-container #fe-chat-export-sidebar {
        position: static !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        flex: 0 0 auto !important;
        background: #fff !important;
        border: 0 !important;
      }
      #fe-chat-export-container #fe-chat-export-chat {
        position: static !important;
        background: #fff !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        display: block !important;
      }
      #fe-chat-export-container #fe-chat-export-log {
        position: static !important;
        background: #fff !important;
        padding: 0 !important;
        margin: 0 !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        display: block !important;
      }

      /* Screen-only text rendering helpers.
       * Some Windows/Chrome setups look jagged when custom fonts are loaded from file://.
       * A tiny text-shadow is a common workaround (kept out of print).
       */
      @media screen {
        #fe-chat-export-container {
          -webkit-font-smoothing: auto;
          -moz-osx-font-smoothing: auto;
          text-rendering: optimizeLegibility;
        }

        #fe-chat-export-container :is(.chat-message, .chat-message *) {
          text-shadow: rgba(0,0,0,0.01) 0 0 1px !important;
        }
      }

      /* Toolbar: compact, web-page-like controls. */
      #fe-chat-export-container .fe-chat-export-toolbar {
        display: flex;
        align-items: center;
        gap: 12px;
        margin: 0 0 10px 0;
      }

      #fe-chat-export-title { font-size: 18px; font-weight: 700; }
      #fe-chat-export-meta { font-size: 12px; opacity: 0.85; }

      .fe-chat-export-actions {
        margin-left: auto;
        display: inline-flex;
        gap: 8px;
        align-items: center;
      }

      .fe-chat-export-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        height: 28px;
        padding: 0 8px;
        border: 1px solid rgba(0,0,0,0.25);
        border-radius: 6px;
        font-size: 12px;
        line-height: 1;
        color: #000;
        text-decoration: none;
        cursor: pointer;
        user-select: none;
      }

      .fe-chat-export-action:hover {
        background: rgba(0,0,0,0.06);
      }

      .fe-chat-export-action[aria-disabled="true"] {
        opacity: 0.55;
        pointer-events: none;
      }

      @media print {
        html, body {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Hide the toolbar when printing (save as PDF). */
        #fe-chat-export-container .fe-chat-export-toolbar { display: none !important; }

        /* Avoid splitting a single message across pages where possible. */
        #fe-chat-export-log .chat-message {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        #fe-chat-export-log .chat-message:last-child {
          break-after: auto !important;
          page-break-after: auto !important;
          margin-bottom: 0 !important;
        }

        /* PDF 안정성: 이미지 숨김 옵션 */
        body.fe-print-hide-avatars #fe-chat-export-log :is(
          .message-header img,
          .message-sender .avatar,
          .message-sender > img,
          img.chat-portrait-image-size-name-dnd5e,
          img[class*="chat-portrait-image-size"]
        ) {
          display: none !important;
        }
        body.fe-print-hide-all #fe-chat-export-log img { display: none !important; }

        @page { margin: 10mm; }
      }
    </style>
  </head>
  <body class="${feEscapeAttr(bodyClass)}">
    <div id="fe-chat-export-container">
      <div class="fe-chat-export-toolbar">
        <div>
          <div id="fe-chat-export-title">${feEscapeHTML(titleText)}</div>
          <div id="fe-chat-export-meta">${feEscapeHTML(metaText)}</div>
        </div>
        <div class="fe-chat-export-actions">
          <a class="fe-chat-export-action fe-chat-export-download" id="fe-archive-download" data-tooltip="HTML 저장">HTML</a>
          ${externalBtnHTML}
          <a class="fe-chat-export-action fe-chat-export-print" id="fe-archive-print" data-tooltip="인쇄 / PDF">인쇄</a>
          <a class="fe-chat-export-action fe-chat-export-close" id="fe-archive-close" data-tooltip="닫기">닫기</a>
        </div>
      </div>
      <div id="fe-chat-export-sidebar" class="sidebar">
        <section id="fe-chat-export-chat" class="sidebar-tab tab active" data-tab="chat">
          <ol id="fe-chat-export-log" class="chat-log"></ol>
        </section>
      </div>
    </div>
  </body>
</html>`);
  win.document.close();

  // The archive window is a new Document; mirror any module settings that are applied
  // via JS on <link rel="stylesheet"> elements (e.g. enableFonts -> ui-font.css).
  // Without this, the archive can ignore the user's live CSS toggles.
  try {
    feApplyModuleStylesheetSettingsToDocument(win.document);
  } catch {}

  // Apply user style variables (font sizes, background saturation) to the archive document.
  // This also ensures downloaded HTML keeps the chosen values.
  feApplyStyleVarsFromSettings(win.document);
  // Apply chat-card font toggle class in the archive window too.
  feSetChatCardFontClass(win.document);
  // Apply chat font choice + optional user-color background class.
  feSetChatFontChoiceClass(win.document);
  feSetUiFontClass(win.document);
  feSetUserColorBgClass(win.document);
  feSetUserColorBgBaseClass(win.document);
  feSyncArchiveMergeBodyClasses(win.document);
  // Apply chat portrait vars/classes so archive matches live chat (size, hide-wrap).
  try {
    feChatPortraitApplyVars(win.document);
  } catch {}

  // Hook up controls.
  const logEl = win.document.getElementById("fe-chat-export-log") || win.document.getElementById("chat-log");
  const metaEl = win.document.getElementById("fe-chat-export-meta");

  const btnPrint = win.document.getElementById("fe-archive-print");
  const btnDownload = win.document.getElementById("fe-archive-download");
  const btnExternal = win.document.getElementById("fe-archive-external");
  const btnClose = win.document.getElementById("fe-archive-close");

  // Prevent exporting/printing until rendering is complete.
  try {
    btnPrint?.setAttribute?.("aria-disabled", "true");
    btnDownload?.setAttribute?.("aria-disabled", "true");
  } catch {}

  if (btnPrint)
    btnPrint.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feArchivePrint(win);
    });

  if (btnDownload)
    btnDownload.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feDownloadArchiveHTML(win, titleText);
    });

  if (btnExternal)
    btnExternal.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feOpenArchiveInExternalBrowser(win, titleText);
    });

  if (btnClose)
    btnClose.addEventListener("click", (ev) => {
      ev.preventDefault();
      try {
        win.close();
      } catch {}
    });

  // Mirror the live chat-log's class list so themes apply (directory-list, etc.).
  try {
    const sampleLog = document.querySelector("ol.chat-log, #chat-log");
    if (sampleLog?.className) logEl.className = sampleLog.className;
  } catch {}

  // Render messages.
  logEl.innerHTML = "";

  // Prefer cloning from the already-rendered live chat log DOM when possible.
  // This avoids re-running render hooks from other modules (e.g. chat-portrait) which
  // can throw during automation-heavy sessions (midi-qol, tokenbar, etc.).
  const liveMessageMap = feBuildLiveChatMessageElementMap();

  await feRenderMessagesIntoLog({
    targetDoc: win.document,
    logEl,
    messages,
    metaEl,
    yieldWindow: win,
    liveMessageMap,
    annotateExportMessage: true,
    renderProfile,
  });


  // If texture stripping / export optimization is enabled, apply the same
  // sanitization logic used in the live chat log (chat-bg-stripper.js).
  // This is required for the archive window + downloaded HTML to match the
  // on-screen chat saturation/overlay behavior.
  if (effectiveOptimize) {
    try {
      if (metaEl) metaEl.textContent = "Applying texture stripping…";
      feStripChatTexturesInWindow(win, logEl);
    } catch {}
  }

  // Apply merge styling in the archive window if enabled.
  if (feSetting(S.MERGE_ENABLED)) {
    try {
      feApplyChatMergeInWindow(win);
    } catch (err) {
      console.warn("female_edition | archive merge failed", err);
    }
  } else if (renderProfile.deferPortraits) {
    feRefreshPortraitsForLog(logEl);
  }

  try {
    feNormalizeArchiveShellLayout(win.document);
    feNormalizeArchiveMessageLayout(logEl);
  } catch {}

  // Wait for images so avatars/icons actually show up.
  if (metaEl) metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
  await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });

  if (metaEl) metaEl.textContent = "Loading fonts…";
  await feWaitForFonts(win.document, FE_EXPORT_WAIT_FONTS_TIMEOUT);

  if (metaEl) metaEl.textContent = metaText;

  // Re-enable actions.
  try {
    btnPrint?.removeAttribute?.("aria-disabled");
    btnDownload?.removeAttribute?.("aria-disabled");
  } catch {}

  // Auto-open print dialog if requested.
  if (autoPrint) {
    try {
      win.focus();
    } catch {}
    try {
      // eslint-disable-next-line no-unused-expressions
      win.document.body.offsetHeight;
    } catch {}
    await feArchivePrint(win);
  }
}

async function feArchivePrint(win) {
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

  const requested = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "hideAvatars");
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
    console.warn("female_edition | print background freeze failed", err);
  }

  // Memory guard: if images are supposed to be hidden, also blank their src so Chromium won't decode them.
  let restoreImages = () => {};
  if (mode === "hideAll") restoreImages = tempDisableImages(() => true);
  else if (mode === "hideAvatars") restoreImages = tempDisableImages((img) => isAvatarImage(img));

  const restoreOnce = () => {
    try {
      restoreDownscaledImages();
    } catch {}
    try {
      restoreImages();
    } catch {}
    try {
      restoreBg();
    } catch {}
  };

  try {
    win.addEventListener("afterprint", restoreOnce, { once: true });
  } catch {}

  // Downscale images for stability:
  // - always when mode === "downscale"
  // - in Electron, also when images are not fully hidden
  const shouldDownscale = !!logEl && (mode === "downscale" || mode === "downscaleLite" || (isElectron && mode !== "hideAll"));
  let restoreDownscaledImages = () => {};
  if (shouldDownscale && logEl) {
    try {
      const mildDownscale = mode === "downscaleLite";
      setMeta(mildDownscale ? "Loading images… (품질 우선)" : "Loading images…");
      fePrepareArchiveImagesForOutput(logEl);
      await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: Math.min(FE_EXPORT_WAIT_IMAGES_MAX, Math.max(160, renderProfile.initialImageWaitMax * 4)) });
      restoreDownscaledImages = await feDownscaleImagesForPrint(win, logEl, {
        meta: setMeta,
        excludeAvatars: mode === "hideAvatars",
        dprCap: mildDownscale ? (isElectron ? 1.2 : 1.75) : (isElectron ? 1 : 1.5),
        webpQuality: mildDownscale ? (isElectron ? 0.80 : 0.88) : (isElectron ? 0.72 : 0.82),
        jpegQuality: mildDownscale ? (isElectron ? 0.86 : 0.91) : (isElectron ? 0.78 : 0.85),
        avatarDprCap: mildDownscale ? (isElectron ? 2 : 2.25) : (isElectron ? 1.75 : 2),
        avatarWebpQuality: mildDownscale ? (isElectron ? 0.90 : 0.95) : (isElectron ? 0.86 : 0.92),
        avatarJpegQuality: mildDownscale ? (isElectron ? 0.92 : 0.96) : (isElectron ? 0.88 : 0.94),
        maxSide: mildDownscale ? (isElectron ? 2048 : 2304) : 1600,
      });
    } catch (err) {
      console.warn("female_edition | print downscale failed", err);
    }
  }

  if (!shouldDownscale && logEl) {
    try {
      fePrepareArchiveImagesForOutput(logEl);
    } catch {}
  }

  try {
    setMeta("Loading fonts…");
    await feEnsureArchiveEmbeddedFonts(win);
    await feWaitForFonts(doc, FE_EXPORT_WAIT_FONTS_TIMEOUT);
  } catch {}

  try {
    win.focus();
  } catch {}
  try {
    // eslint-disable-next-line no-unused-expressions
    doc.body.offsetHeight;
  } catch {}

  try {
    win.print();
  } finally {
    setMeta(originalMeta);
    // Fallback restore in case afterprint doesn't fire (some Electron builds)
    setTimeout(restoreOnce, 0);
  }
}

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

function feFreezeMessageBackgroundsForPrint(win, logEl) {
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

  for (const el of msgs) {
    try {
      const cs = win.getComputedStyle(el);
      const bg = feParseRGBAFromCSS(cs.backgroundColor);
      if (!bg || bg.a <= 0) continue;

      let outR;
      let outG;
      let outB;

      // When the user-color tint is implemented via an inset box-shadow (base white/black mode),
      // computed backgroundColor only reports the solid base layer. Bake the tint explicitly so
      // print/PDF preserves the same pastel message color, including merged follow-up messages.
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
        // Blend the paper overlay using the *screen* blend formula.
        // We then bake the result into an opaque RGB to avoid print/PDF blend inconsistencies.
        const sr = feScreenBlendChannel(bg.r, paper.r);
        const sg = feScreenBlendChannel(bg.g, paper.g);
        const sb = feScreenBlendChannel(bg.b, paper.b);

        outR = Math.round(bg.r * (1 - paperAlpha) + sr * paperAlpha);
        outG = Math.round(bg.g * (1 - paperAlpha) + sg * paperAlpha);
        outB = Math.round(bg.b * (1 - paperAlpha) + sb * paperAlpha);
      }

      const prevStyle = el.getAttribute("style");
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

async function feDownscaleImagesForPrint(
  win,
  rootEl,
  {
    meta,
    excludeAvatars = false,
    dprCap = 1.5,
    webpQuality = 0.82,
    jpegQuality = 0.85,
    // Avatars/portraits: preserve quality (they are small but visually important)
    avatarDprCap = 2,
    avatarWebpQuality = 0.92,
    avatarJpegQuality = 0.94,
    maxSide = 1600,
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

  const dpr = Math.max(1, Math.min(dprCap, win.devicePixelRatio || 1));
  const avatarDpr = Math.max(1, Math.min(avatarDprCap, win.devicePixelRatio || 1));
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
      const shouldProcess = g.needsResample || g.imgs.length > 1;
      if (!shouldProcess) continue;
      const rep = g.imgs.find((img) => img?.complete && img.naturalWidth > 0);
      if (!rep) continue;
      const outW = Math.max(1, Math.min(g.maxW, Math.round(g.maxW)));
      const outH = Math.max(1, Math.min(g.maxH, Math.round(g.maxH)));
      const canvas = win.document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d", { alpha: true });
      if (!ctx) continue;
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      } catch {}

      const spec = computeDrawSpec(rep, outW, outH);
      ctx.clearRect(0, 0, outW, outH);
      ctx.drawImage(rep, spec.sx, spec.sy, spec.sw, spec.sh, spec.dx, spec.dy, spec.dw, spec.dh);

      const dataUrl = await feCanvasToDataURL(canvas, {
        webpQuality: g.isAvatar ? avatarWebpQuality : webpQuality,
        jpegQuality: g.isAvatar ? avatarJpegQuality : jpegQuality,
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

async function feCanvasToDataURL(canvas, { webpQuality = 0.82, jpegQuality = 0.85 } = {}) {
  // Prefer webp (smaller); fall back to jpeg/png.
  const tryTypes = [
    { type: "image/webp", quality: webpQuality },
    { type: "image/jpeg", quality: jpegQuality },
    { type: "image/png", quality: 1.0 },
  ];

  for (const t of tryTypes) {
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, t.type, t.quality));
      if (!blob) continue;
      return await feBlobToDataURL(blob);
    } catch {}
  }
  return null;
}

async function feBuildArchiveHTMLSnapshotBlob(win, titleText = "Chat Log", { meta } = {}) {
  if (!win || win.closed) throw new Error("Archive window is closed");
  const setMeta = typeof meta === "function" ? meta : () => {};

  const doc = win.document;

  // IMPORTANT (memory):
  // Do NOT deep-clone the full <html> tree for large logs.
  // Cloning thousands of chat messages can easily OOM Chromium/Electron.
  // Instead, clone only <head> (small) and serialize <body> directly.

  // ---
  // Head snapshot
  // ---
  const headClone = (doc.head ? doc.head.cloneNode(true) : doc.createElement("head"));

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
        return !!game.settings.get(MODULE_ID, "enableFonts");
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
  let bodyHTML = "";
  const embedFonts = !!feSetting(S.EXPORT_EMBED_FONTS);
  const liveLogEl = doc.getElementById("fe-chat-export-log") || doc.getElementById("chat-log") || doc.querySelector("ol.chat-log");
  const restoreBg = feFreezeMessageBackgroundsForPrint(win, liveLogEl);
  const restoreShell = feNormalizeArchiveShellLayout(doc, { restore: true });
  const restoreLayout = feNormalizeArchiveMessageLayout(doc.body, { restore: true });
  try {
    if (feSetting(S.EXPORT_EMBED_IMAGES)) {
      // Image embedding requires mutating src/srcset to data: URLs.
      // Do it on a cloned <body> so the archive window stays visually unchanged.
      try {
        setMeta("Embedding images…");
        const bodyClone = doc.body.cloneNode(true);
        feRestoreOriginalPortraitSources(bodyClone);
        feNormalizeArchiveMessageLayout(bodyClone);
        if (embedFonts) fePatchInlineFontFamiliesForExport(bodyClone);
        await feEmbedImagesInNode(bodyClone, { meta: setMeta });
        bodyHTML = bodyClone.outerHTML;
      } catch (err) {
        console.warn("female_edition | HTML export: failed to embed images", err);
        // Fallback: still produce a valid snapshot.
        const restore = fePrepareBodyForHTMLSnapshot(doc.body, { embedFonts });
        try {
          bodyHTML = doc.body.outerHTML;
        } finally {
          try { restore(); } catch {}
        }
      }
    } else {
      const restore = fePrepareBodyForHTMLSnapshot(doc.body, { embedFonts });
      try {
        bodyHTML = doc.body.outerHTML;
      } finally {
        try { restore(); } catch {}
      }
    }
  } finally {
    try { restoreLayout(); } catch {}
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
    ["<!doctype html>\n", `<html${htmlAttrs}>`, "\n", headClone.outerHTML, "\n", bodyHTML, "\n</html>"],
    { type: "text/html;charset=utf-8" }
  );
}

async function feDownloadArchiveHTML(win, titleText = "Chat Log") {
  if (!win || win.closed) return;
  const metaEl = win.document.getElementById("fe-chat-export-meta");
  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const safeName =
    String(titleText || "chat-log")
      .replaceAll(/[^a-zA-Z0-9\u3131-\uD79D\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || "chat-log";

  const filename = `${safeName}.html`;

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  try {
    const doc = win.document;

    setMeta("Preparing HTML…");
    const blob = await feBuildArchiveHTMLSnapshotBlob(win, titleText, { meta: setMeta });

    setMeta("Downloading…");
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("female_edition | failed to download archive HTML", err);
  } finally {
    setMeta(originalMeta);
  }
}

async function feOpenArchiveInExternalBrowser(win, titleText = "Chat Log", { closeAfter = false } = {}) {
  const mode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  if (mode === "off") return;
  if (!feIsElectron()) {
    ui?.notifications?.warn?.("외부 브라우저 열기는 데스크톱(Electron) 앱에서만 지원됩니다.");
    return;
  }

  const electron = feTryRequire("electron");
  const shell = electron?.shell;
  const fs = feTryRequire("fs");
  const path = feTryRequire("path");
  const os = feTryRequire("os");

  if (!shell || !fs || !path || !os) {
    ui?.notifications?.warn?.("Electron shell/fs 접근이 불가하여 자동으로 외부 브라우저를 열 수 없습니다. 아카이브 창에서 HTML 저장 후 외부 브라우저로 열어주세요.");
    return;
  }

  const metaEl = win?.document?.getElementById?.("fe-chat-export-meta");
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

  try {
    setMeta("Building HTML…");
    const blob = await feBuildArchiveHTMLSnapshotBlob(win, titleText, { meta: setMeta });

    const safeName = feSanitizeFilename(titleText) || "chat-log";
    const filePath = path.join(os.tmpdir(), `${safeName}-${Date.now()}.html`);
    // Write as binary to avoid constructing one massive JS string for huge logs.
    const ab = await blob.arrayBuffer();
    const buf = globalThis.Buffer ? globalThis.Buffer.from(ab) : new Uint8Array(ab);
    fs.writeFileSync(filePath, buf);

    setMeta("Opening system browser…");

    // shell.openPath is preferred for opening local files.
    // It resolves with an error message string, or empty string on success.
    let errMsg = "";
    try {
      if (typeof shell.openPath === "function") {
        errMsg = (await shell.openPath(filePath)) || "";
      } else if (typeof shell.openExternal === "function") {
        await shell.openExternal(`file://${filePath}`);
      } else {
        throw new Error("Electron shell has no openPath/openExternal");
      }
    } catch (err) {
      errMsg = String(err?.message ?? err);
    }

    if (errMsg) {
      console.warn("female_edition | open external browser failed", errMsg);
      ui?.notifications?.warn?.(`외부 브라우저 열기 실패: ${errMsg}`);
    } else {
      ui?.notifications?.info?.("외부 브라우저에서 채팅 아카이브를 열었습니다.");
    }

    if (closeAfter) {
      try {
        win.close();
      } catch {}
    }
  } catch (err) {
    console.warn("female_edition | external open failed", err);
    ui?.notifications?.warn?.("외부 브라우저 열기 실패. HTML 저장 후 수동으로 열어주세요.");
  } finally {
    setMeta(originalMeta);
  }
}

async function feBuildEmbeddedCookieRunFontCSS() {
  if (typeof feEmbeddedFontCssValue === "string") return feEmbeddedFontCssValue;
  if (feEmbeddedFontCssPromise) return feEmbeddedFontCssPromise;

  feEmbeddedFontCssPromise = (async () => {
  // Tries to fetch the CookieRun font files from the module and embed them as data: URLs.
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
      const res = await fetch(url, { method: "HEAD", credentials: "include" });
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
  try {
    const geurUrl = `/modules/${MODULE_ID}/font/HakgyoansimGeurimilgi-R.ttf`;
    const geurimilgiData = await fetchFont(geurUrl, { perFileCap: MAX_PER_FILE_BYTES_GEUR });
    if (geurimilgiData) {
      faces.push(
        `@font-face{font-family:"FE Geurimilgi Embedded";src:url(${geurimilgiData}) format("truetype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
      );
    }
  } catch {}

  if (!faces.length) {
    feEmbeddedFontCssValue = "";
    return "";
  }

  const css = `
/* female_edition: embedded CookieRun fonts (offline HTML export) */
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

  /* Secondary stack (Geurimilgi) */
  --fe-font-geurimilgi:
    "FE Geurimilgi Embedded",
    "FE Geurimilgi",
    "FE CookieRun Embedded",
    "FE CookieRun",
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  /* Secondary stack for small text / chat-card descriptions */
  --fe-font-light:
    "FE Geurimilgi Embedded",
    "FE Geurimilgi",
    "FE CookieRun Embedded",
    "FE CookieRun",
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
  --dnd5e-font-signika: var(--fe-font-primary);
  --dnd5e-font-modesto: var(--fe-font-primary);

  /* Chat font choice (default: CookieRun). Controlled via body class. */
  --fe-chat-font-family: var(--fe-font-primary);
}

body.fe-chat-font-cookie { --fe-chat-font-family: var(--fe-font-primary); }
body.fe-chat-font-geurimilgi { --fe-chat-font-family: var(--fe-font-geurimilgi); }
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

#fe-chat-export-container :is(.fa-solid, .fa-regular, .fa-light, .fa-thin, .fa-duotone, .fa-brands, [class^="fa-"], [class*=" fa-"]) {
  font-family: "Font Awesome 6 Free", "Font Awesome 6 Pro", "Font Awesome 5 Free" !important;
}
`;

    feEmbeddedFontCssValue = css;
    return css;
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
  }
}

function feBlobToDataURL(blob) {
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

async function feEmbedImagesInNode(root, { meta } = {}) {
  const setMeta = typeof meta === "function" ? meta : () => {};

  const imgs = Array.from(root.querySelectorAll("img"));
  if (!imgs.length) return;

  // Hard safety limits:
  // Single-file HTML + embedded images can easily crash Chromium/Electron (STATUS_BREAKPOINT / OOM)
  // due to base64 expansion + JS string memory overhead.
  const MAX_IMAGES = 160;
  const MAX_TOTAL_BYTES = 12_000_000; // ~12MB (binary) before base64/string expansion
  const MAX_PER_IMAGE = 800_000;      // ~0.8MB per image

  const cache = new Map();
  let embeddedCount = 0;
  let embeddedBytes = 0;

  let i = 0;
  for (const img of imgs) {
    i++;
    const src = img.getAttribute("src") || img.src;
    if (!src || src.startsWith("data:")) continue;

    // Stop when reaching limits
    if (embeddedCount >= MAX_IMAGES || embeddedBytes >= MAX_TOTAL_BYTES) {
      setMeta(
        `Embedding images… stopped (limit reached: ${embeddedCount} images, ${(
          embeddedBytes /
          1024 /
          1024
        ).toFixed(1)}MB)`
      );
      break;
    }

    // Resolve URL
    let abs;
    try {
      abs = new URL(src, window.location.href).href;
    } catch {
      continue;
    }

    // Only embed same-origin resources (avoid CORS failures).
    try {
      const u = new URL(abs);
      if (u.origin !== window.location.origin) continue;
    } catch {
      continue;
    }

    if (cache.has(abs)) {
      img.setAttribute("src", cache.get(abs));
      img.removeAttribute("srcset");
      img.removeAttribute("loading");
      continue;
    }

    setMeta(`Embedding images… ${embeddedCount}/${MAX_IMAGES} (scanning ${i}/${imgs.length})`);

    try {
      const res = await fetch(abs, { credentials: "include" });
      if (!res.ok) continue;
      const blob = await res.blob();

      // Per-image limit
      if (blob.size > MAX_PER_IMAGE) continue;

      // Total limit
      if (embeddedBytes + blob.size > MAX_TOTAL_BYTES) continue;

      const dataUrl = await feBlobToDataURL(blob);
      cache.set(abs, dataUrl);

      img.setAttribute("src", dataUrl);
      img.removeAttribute("srcset");
      img.removeAttribute("loading");

      embeddedCount++;
      embeddedBytes += blob.size;
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed image", abs, err);
    }

    // Yield periodically so Chromium doesn't freeze.
    if (i % 10 === 0) await feNextTick();
  }
}

function fePrepareBodyForHTMLSnapshot(root, { embedFonts = false } = {}) {
  const restores = [];
  try {
    restores.push(feRestoreOriginalPortraitSources(root));
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

function feRestoreOriginalPortraitSources(root) {
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

function fePatchInlineFontFamiliesForExport(root) {
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
      if (/FE\s+Geurimilgi/i.test(next) && !/FE\s+Geurimilgi\s+Embedded/i.test(next)) {
        next = next.replace(/FE\s+Geurimilgi/gi, '"FE Geurimilgi Embedded", "FE Geurimilgi"');
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

function feInjectExportFontReadyBootstrap(headClone, doc) {
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

async function feWaitForFonts(doc, timeoutMs = FE_EXPORT_WAIT_FONTS_TIMEOUT) {
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

function feDownloadExportHTMLFromCurrentDocument() {
  try {
    const container = document.getElementById("fe-chat-export-container");
    if (!container) return;

    const docEl = document.documentElement;
    const html = "<!doctype html>\n" + docEl.outerHTML;

    const worldName = game.world?.title ?? game.world?.name ?? "chat-log";
    const safeName = String(worldName)
      .replaceAll(/[^a-zA-Z0-9\u3131-\uD79D\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || "chat-log";
    const filename = `Chat Log - ${safeName}.html`;

    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.warn("female_edition | failed to download export HTML", err);
  }
}

async function feMaybeYieldForUI(targetWindow = window) {
  // Background tabs/windows clamp timers; yielding there can look like the export "stopped".
  // Only yield when the *target* document is visible.
  try {
    const doc = targetWindow?.document ?? document;
    if (doc.visibilityState !== "visible") return;
  } catch {
    // If we can't read visibility state, fall back to yielding.
  }

  try {
    const t = targetWindow?.setTimeout ?? setTimeout;
    await new Promise((resolve) => t(resolve, 0));
  } catch {
    await feNextTick();
  }
}

function feApplyChatMergeInWindow(win) {
  try {
    const logEl =
      win.document.getElementById("fe-chat-export-log") ||
      win.document.getElementById("chat-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    feSyncArchiveMergeBodyClasses(win.document);
    feApplyChatMerge(logEl, feArchiveMergeOptions());
    feRefreshPortraitsForLog(logEl);
  } catch (err) {
    console.warn("female_edition | feApplyChatMergeInWindow failed", err);
  }
}

const FE_ARCHIVE_CONTAINER_STYLE_PROPS = [
  "color",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "background-blend-mode",
  "border",
  "border-color",
  "border-style",
  "border-width",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-radius",
  "box-shadow",
  "outline",
  "outline-color",
  "outline-style",
  "outline-width",
  "filter",
  "opacity",
  "display",
  "padding",
  "margin",
  "align-items",
  "justify-content",
  "align-self",
  "justify-self",
  "justify-items",
  "align-content",
  "place-items",
  "place-content",
  "grid-template-columns",
  "grid-template-rows",
  "grid-template-areas",
  "grid-auto-columns",
  "grid-auto-rows",
  "grid-auto-flow",
  "grid-area",
  "grid-column",
  "grid-column-start",
  "grid-column-end",
  "grid-row",
  "grid-row-start",
  "grid-row-end",
  "gap",
  "column-gap",
  "row-gap",
  "white-space",
  "overflow",
  "text-overflow",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "z-index",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "box-sizing",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "transform",
  "transform-origin",
  "translate",
  "scale",
  "rotate",
  "vertical-align",
];

const FE_ARCHIVE_TEXT_STYLE_PROPS = [
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "line-height",
  "letter-spacing",
  "text-shadow",
  "text-transform",
  "text-align",
  "white-space",
];

const FE_ARCHIVE_FIXED_SIZE_PROPS = ["width", "height", "min-width", "min-height", "max-width", "max-height"];
const FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_CONTAINER_STYLE_PROPS.filter((p) => !FE_ARCHIVE_FIXED_SIZE_PROPS.includes(p));
const FE_ARCHIVE_TREE_STYLE_PROPS = Array.from(new Set([
  ...FE_ARCHIVE_CONTAINER_STYLE_PROPS,
  ...FE_ARCHIVE_TEXT_STYLE_PROPS,
]));
const FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE = Array.from(new Set([
  ...FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE,
  ...FE_ARCHIVE_TEXT_STYLE_PROPS,
]));
const FE_ARCHIVE_CARD_TREE_STYLE_PROPS = FE_ARCHIVE_TREE_STYLE_PROPS;
const FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_MIXED_STYLE_PROPS = FE_ARCHIVE_TREE_STYLE_PROPS;
const FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_TREE_MAX_SIMPLE = 72;
const FE_ARCHIVE_TREE_MAX_PORTRAIT = 112;
const FE_ARCHIVE_TREE_MAX_COMPLEX = 260;

function feGetArchiveTreeMirrorBudget(liveEl) {
  try {
    const hasCard = !!liveEl?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .details.card-content, .details.collapsible-content.card-content');
    if (hasCard) return FE_ARCHIVE_TREE_MAX_COMPLEX;
    const hasPortraitHeader = !!liveEl?.classList?.contains?.('fe-has-chat-portrait');
    if (hasPortraitHeader) return FE_ARCHIVE_TREE_MAX_PORTRAIT;
  } catch {
    /* no-op */
  }
  return FE_ARCHIVE_TREE_MAX_SIMPLE;
}

function feCopyComputedStyleSubset(srcEl, dstEl, propNames = []) {
  try {
    if (!srcEl || !dstEl) return;
    const cs = window.getComputedStyle?.(srcEl);
    if (!cs) return;
    for (const prop of propNames) {
      const value = cs.getPropertyValue?.(prop);
      if (!value) continue;
      dstEl.style.setProperty(prop, value.trim());
    }
  } catch {
    /* no-op */
  }
}

function feSelectScoped(root, selector) {
  try {
    if (!root) return [];
    if (selector === ":scope") return [root];
    return Array.from(root.querySelectorAll?.(selector) ?? []);
  } catch {
    return [];
  }
}


function feMirrorLiveTreeStyles(liveEl, cloneEl, { maxNodes = 80, propNames = FE_ARCHIVE_TREE_STYLE_PROPS } = {}) {
  try {
    if (!feIsElement(liveEl) || !feIsElement(cloneEl)) return;
    const liveWalker = document.createTreeWalker(liveEl, NodeFilter.SHOW_ELEMENT);
    const cloneWalker = cloneEl.ownerDocument.createTreeWalker(cloneEl, NodeFilter.SHOW_ELEMENT);

    let liveNode = liveWalker.currentNode;
    let cloneNode = cloneWalker.currentNode;
    let count = 0;

    while (liveNode && cloneNode && count < maxNodes) {
      feCopyComputedStyleSubset(liveNode, cloneNode, propNames);
      liveNode = liveWalker.nextNode();
      cloneNode = cloneWalker.nextNode();
      count += 1;
    }
  } catch {
    /* no-op */
  }
}

function feMirrorLiveMessageStyles(liveEl, cloneEl, { renderProfile = null } = {}) {
  try {
    if (!feIsElement(liveEl) || !feIsElement(cloneEl)) return;

    const hasCard = !!liveEl.querySelector?.(".chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card");
    const lean = !!renderProfile?.lean;
    const mirrorTree = renderProfile?.mirrorTree !== false;
    const mirrorCardTree = renderProfile?.mirrorCardTree !== false;

    // First, mirror a broad-but-safe subset of computed styles across the cloned tree.
    // For complex chat cards (notably midi-qol), preserve more layout properties so saved HTML/PDF
    // stays close to the live sidebar rendering even without the full live stylesheet environment.
    if (mirrorTree && (!hasCard || mirrorCardTree)) {
      feMirrorLiveTreeStyles(liveEl, cloneEl, {
        maxNodes: feGetArchiveTreeMirrorBudget(liveEl),
        propNames: hasCard ? FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE : FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE,
      });
    }

    const sync = (selector, props) => {
      const srcList = feSelectScoped(liveEl, selector);
      const dstList = feSelectScoped(cloneEl, selector);
      const n = Math.min(srcList.length, dstList.length);
      for (let i = 0; i < n; i++) feCopyComputedStyleSubset(srcList[i], dstList[i], props);
    };

    sync(":scope", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender .name-stacked", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender .name-stacked .title, :scope > .message-header .message-sender .title", FE_ARCHIVE_TEXT_STYLE_PROPS);
    sync(":scope > .message-header .message-sender .name-stacked .subtitle, :scope > .message-header .message-sender .subtitle", FE_ARCHIVE_TEXT_STYLE_PROPS);
    sync(":scope > .message-header .message-flavor, :scope > .message-header .flavor-text", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-metadata", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);

    if (hasCard) {
      sync(":scope .chat-card, :scope .midi-chat-card, :scope .dnd5e.chat-card, :scope .dnd5e2.chat-card", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .card-header, :scope .midi-chat-card .card-header, :scope .dnd5e.chat-card .card-header, :scope .dnd5e2.chat-card .card-header", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .card-content, :scope .midi-chat-card .card-content, :scope .dnd5e.chat-card .card-content, :scope .dnd5e2.chat-card .card-content, :scope .details.card-content, :scope .details.collapsible-content.card-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .name-stacked .title, :scope .midi-chat-card .name-stacked .title, :scope .chat-card .name-stacked .subtitle, :scope .midi-chat-card .name-stacked .subtitle", FE_ARCHIVE_TEXT_STYLE_PROPS);
      sync(":scope .chat-card button, :scope .midi-chat-card button, :scope .dnd5e.chat-card button, :scope .dnd5e2.chat-card button, :scope .chat-card .pill, :scope .midi-chat-card .pill", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      const midiSelector = lean
        ? ":scope .midi-chat-card :is(.dice-roll, .dice-result, .dice-formula, .dice-tooltip, .dice-total, .dice-flavor, .dice-target, .dice-targets, .targets, .target)"
        : ":scope .midi-chat-card :is(.dice-roll, .dice-result, .dice-formula, .dice-tooltip, .dice-total, .dice-flavor, .dice-target, .dice-targets, .targets, .target, [class*=\"midi\"], [class*=\"roll\"], [class*=\"damage\"], [class*=\"attack\"] )";
      sync(midiSelector, lean ? FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE : FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE);
    }

    if (liveEl.classList?.contains?.("narrator-chat")) {
      sync(":scope, :scope > .message-header, :scope > .message-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS);
      sync(":scope .message-content", FE_ARCHIVE_TEXT_STYLE_PROPS);
    }
  } catch {
    /* no-op */
  }
}

function feCanUserSeeChatMessage(msg, user) {
  try {
    if (!msg) return false;

    // If Foundry provides a boolean visibility flag, prefer it.
    if (typeof msg.visible === "boolean") return msg.visible;

    // Whispers: visible to GM and recipients (and the author).
    const whisper = msg.whisper ?? [];
    if (Array.isArray(whisper) && whisper.length) {
      if (user?.isGM) return true;
      if (whisper.includes(user?.id)) return true;
      if (msg.author?.id === user?.id) return true;
      return false;
    }

    // Hidden messages are still visible to GMs.
    if (msg.hidden && !user?.isGM) return false;

    return true;
  } catch {
    return true;
  }
}

function feNormalizeExportNode(rootEl, { loading = "eager", decoding = "sync" } = {}) {
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

function feNormalizeArchiveShellLayout(doc, { restore = false } = {}) {
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

function fePrepareArchiveImagesForOutput(rootEl, { restorePortraits = true } = {}) {
  try {
    if (!rootEl?.querySelectorAll) return;
    if (restorePortraits) {
      try {
        feRestoreOriginalPortraitSources(rootEl);
      } catch {}
    }
    for (const img of rootEl.querySelectorAll("img")) {
      try {
        img.setAttribute("loading", "eager");
        if (!img.getAttribute("decoding") || img.getAttribute("decoding") === "async") {
          img.setAttribute("decoding", "sync");
        }
      } catch {
        /* no-op */
      }
    }
  } catch {
    /* no-op */
  }
}

function feNormalizeArchiveMessageLayout(root, { restore = false } = {}) {
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
      for (const el of msg.querySelectorAll?.(":scope > .message-content > *, .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .card-header, .card-content, .details.card-content, .details.collapsible-content.card-content, .dice-roll, .dice-result, .dice-formula, .dice-tooltip") || []) push(el);
    }

    for (const el of targets) {
      try {
        const prevStyle = restore ? el.getAttribute("style") : null;
        if (restore) changed.push({ el, prevStyle });
        const isMessage = el.classList?.contains?.("chat-message");
        const isHeader = el.classList?.contains?.("message-header");
        const isContent = el.classList?.contains?.("message-content");
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

async function feEnsureArchiveEmbeddedFonts(win) {
  try {
    if (!win || win.closed) return;
    const doc = win.document;
    if (!doc?.head) return;

    let enableFonts = true;
    try {
      enableFonts = !!game.settings.get(MODULE_ID, "enableFonts");
    } catch {
      enableFonts = true;
    }
    if (!enableFonts) return;
    if (doc.getElementById("fe-export-embedded-fonts-live")) return;

    const fontCss = await feBuildEmbeddedCookieRunFontCSS();
    if (!fontCss) return;

    const styleEl = doc.createElement("style");
    styleEl.id = "fe-export-embedded-fonts-live";
    styleEl.textContent = fontCss;
    doc.head.appendChild(styleEl);
  } catch (err) {
    console.warn("female_edition | failed to embed fonts in archive window", err);
  }
}

function feIsElement(node) {
  // Cross-window safe element check (avoid instanceof HTMLElement which fails across Window realms).
  return !!node && node.nodeType === 1;
}

function feNextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function feWaitForImages(rootEl, timeoutMs = 10000, { maxImages = 800 } = {}) {
  try {
    if (!rootEl?.querySelectorAll) return Promise.resolve();

    // Avoid materializing a giant array for huge chat logs.
    const nodeList = rootEl.querySelectorAll("img[src]");
    if (!nodeList?.length) return Promise.resolve();

    // Hard cap: waiting on thousands of images can allocate too many listeners and stall.
    const imgs = [];
    let count = 0;
    for (const img of nodeList) {
      imgs.push(img);
      count++;
      if (count >= maxImages) break;
    }

    if (!imgs.length) return Promise.resolve();

    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve();
      }, timeoutMs);

      let remaining = imgs.length;
      const onOne = () => {
        remaining--;
        if (remaining > 0) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
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
    return Promise.resolve();
  }
}

function feBuildLiveChatMessageElementMap() {
  const map = new Map();
  try {
    const logs = feGetChatLogs?.() ?? [];
    for (const log of logs) {
      if (!log?.querySelectorAll) continue;
      for (const el of log.querySelectorAll("li.chat-message")) {
        const id = feGetMessageIdFromElement?.(el);
        if (id) map.set(String(id), el);
      }
    }
  } catch {
    /* no-op */
  }
  return map;
}

function feArchiveMessageLooksComplex(msg, liveEl = null) {
  try {
    const el = liveEl;
    if (el?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dice-roll, .dice-result, .round-marker, .chat-images-container, .ci-message-image, img, video, table, blockquote, pre, iframe')) return true;
  } catch {}
  try {
    const content = String(msg?.content ?? '');
    if (!content) return false;
    return /(?:chat-card|midi-chat-card|dice-roll|dice-result|round-marker|chat-images-container|ci-message-image|<img|<video|<table|<blockquote|<pre|<iframe)/i.test(content);
  } catch {
    return false;
  }
}

function feArchiveShouldUseStandardFallback(msg, liveEl = null) {
  try {
    if (!msg) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return false;
    return true;
  } catch {
    return true;
  }
}

function feMarkPlainArchiveMessage(node, msg, liveEl = null) {
  try {
    if (!feIsElement(node)) return;
    const plain = feArchiveShouldUseStandardFallback(msg, liveEl);
    node.classList.toggle('fe-msg-plain', !!plain);
  } catch {}
}

function feFallbackRenderChatMessage(doc, msg) {
  if (!doc) throw new Error("No document provided");
  const li = doc.createElement("li");
  li.className = "chat-message message flexcol dnd5e2 fe-pseudo-sanitized";

  try {
    const id = msg?.id ?? msg?._id;
    if (id) {
      li.dataset.messageId = String(id);
      li.dataset.documentId = String(id);
    }
  } catch {}

  try {
    const style = Number(msg?.style ?? msg?.type ?? -1);
    const styles = CONST?.CHAT_MESSAGE_STYLES || {};
    if (style === styles.OTHER) li.classList.add("other");
    else if (style === styles.IC) li.classList.add("ic");
    else if (style === styles.OOC) li.classList.add("ooc");
    else if (style === styles.EMOTE) li.classList.add("emote");
    else if (style === styles.WHISPER) li.classList.add("whisper");
    else if (style === styles.ROLL) li.classList.add("roll");
  } catch {}
  try {
    if (Array.isArray(msg?.whisper) && msg.whisper.length) li.classList.add("whisper");
  } catch {}

  const actorName = (() => {
    try { if (msg?.speaker?.alias) return String(msg.speaker.alias); } catch {}
    try {
      const actor = game.actors?.get?.(msg?.speaker?.actor) || game.actors?.tokens?.[msg?.speaker?.token];
      if (actor?.name) return String(actor.name);
    } catch {}
    try { const a = msg?.author ?? msg?.user; if (a?.name) return String(a.name); } catch {}
    return "Unknown";
  })();
  const playerName = (() => {
    try { const a = msg?.author ?? msg?.user; return String(a?.name || "").trim(); } catch { return ""; }
  })();

  const timestampText = (() => {
    try {
      const ts = Number(msg?.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) return "";
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  })();

  const header = doc.createElement("header");
  header.className = "message-header flexrow";

  const sender = doc.createElement("h4");
  sender.className = "message-sender chat-portrait-text-size-name-dnd5e chat-portrait-text-header-name-dnd5e";
  const wrap = doc.createElement("span");
  wrap.className = "name-stacked";
  const title = doc.createElement("span");
  title.className = "title";
  title.textContent = actorName;
  wrap.appendChild(title);
  if (playerName && playerName !== actorName) {
    const sub = doc.createElement("span");
    sub.className = "subtitle";
    sub.textContent = playerName;
    wrap.appendChild(sub);
  }
  sender.appendChild(wrap);

  const meta = doc.createElement("span");
  meta.className = "message-metadata";
  if (timestampText) {
    const time = doc.createElement("time");
    time.className = "message-timestamp";
    time.textContent = timestampText;
    meta.appendChild(time);
  }

  const flavor = String(msg?.flavor ?? "").trim();
  header.appendChild(sender);
  header.appendChild(meta);
  if (flavor) {
    const flavorEl = doc.createElement("span");
    flavorEl.className = "message-flavor";
    flavorEl.textContent = flavor;
    header.appendChild(flavorEl);
  }

  const content = doc.createElement("div");
  content.className = "message-content";
  try {
    content.innerHTML = String(msg?.content ?? "");
  } catch {
    content.textContent = String(msg?.content ?? "");
  }

  li.appendChild(header);
  li.appendChild(content);
  return li;
}


Hooks.once("ready", () => {
  try {
    feInjectExportButtonsAll();
  } catch (err) {
    console.warn("[female_edition] fe-chat-archive: initial inject failed", err);
  }
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  try {
    feInjectExportButtonsAll();
  } catch (err) {
    console.warn("[female_edition] fe-chat-archive: reinject failed", err);
  }
});
