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

const FE_EXPORT_RENDER_BATCH = 25;
const FE_EXPORT_STATUS_EVERY = 25;
const FE_EXPORT_WAIT_IMAGES_MAX = 800;
const FE_EXPORT_WAIT_IMAGES_TIMEOUT = 20000;
const FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT = 15000;

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
    const user = game.user;

    // Collect messages the current user can see
    const all = Array.from(game.messages?.contents ?? []);
    all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const messages = all.filter((m) => feCanUserSeeChatMessage(m, user));

    // Header/meta
    const worldName = game.world?.title ?? game.world?.name ?? "";
    const sceneName = canvas?.scene?.name ?? "";
    titleEl.textContent = worldName ? `Chat Log – ${worldName}` : "Chat Log";
    metaEl.textContent = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

    // Prefer cloning from the already-rendered live chat log DOM when possible.
    const liveMessageMap = feBuildLiveChatMessageElementMap();

    // Render each message using Foundry's own renderer so we keep portraits/chat cards, etc.
    let i = 0;
    for (const msg of messages) {
      i++;
      if (i === 1 || i % 25 === 0 || i === messages.length) {
        metaEl.textContent = `Rendering… ${i}/${messages.length}`;
      }

      const msgId = String(msg?.id ?? msg?._id ?? "");

      // 1) Try to clone from live DOM
      let li = null;
      const liveEl = msgId ? liveMessageMap.get(msgId) : null;
      if (liveEl) {
        try {
          li = liveEl.cloneNode(true);
        } catch {
          li = null;
        }
      }

      // 2) Fallback: minimal render if not present in DOM
      if (!feIsElement(li)) {
        try {
          li = feFallbackRenderChatMessage(document, msg);
        } catch {
          li = null;
        }
      }

      if (!feIsElement(li)) continue;

      // Normalize URLs so print/export loads images reliably.
      feNormalizeExportNode(li);

      // Optional: apply per-message user color tint variables before serializing.
      feApplyUserColorBgToMessageElement(msg, li);

      // Ensure our chat portraits exist in inline export too, but don't duplicate other modules.
      try {
        const hasOtherPortrait = !!li.querySelector?.(
          'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container'
        );
        if (!hasOtherPortrait) feChatPortraitUpsert(msg, li);
      } catch {}

      logEl.appendChild(li);

      // Yield occasionally to keep UI responsive.
      // IMPORTANT: background tabs clamp timers heavily; avoid yields when hidden so export continues.
      if (i % FE_EXPORT_RENDER_BATCH === 0) await feMaybeYieldForUI();
    }

    // Apply merge styling to export log (our mutation observer is scoped to #sidebar)
    if (feSetting(S.MERGE_ENABLED)) {
      feApplyChatMerge(logEl);
    }

    // Wait for images (portraits, item icons) to load so they actually print
    metaEl.textContent = "Loading images…";
    await feWaitForImages(logEl, FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT, { maxImages: FE_EXPORT_WAIT_IMAGES_MAX });

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
  const user = game.user;
  const all = Array.from(game.messages?.contents ?? []);
  all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  const messages = all.filter((m) => feCanUserSeeChatMessage(m, user));

  const worldName = game.world?.title ?? game.world?.name ?? "";
  const sceneName = canvas?.scene?.name ?? "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";
  const metaText = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

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
        : printImgMode === "hideAvatars"
          ? " fe-print-hide-avatars"
          : "";

  // Keep Foundry/system/theme classes for variable definitions, then force a printable layout.
  const bodyClass = `${document.body.className ?? ""} fe-print-chatlog fe-chat-archive${effectiveOptimize ? " fe-export-optimized" : ""}${printImgClass}`;

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
      #fe-chat-export-container #sidebar {
        width: min(100%, var(--fe-export-max-width, 1200px)) !important;
        max-width: var(--fe-export-max-width, 1200px) !important;
        margin-left: auto !important;
        margin-right: auto !important;
      }

      /* Minimal Foundry sidebar/chat structure so existing system/module CSS applies. */
      #fe-chat-export-container #sidebar {
        position: static !important;
        width: min(100%, var(--fe-export-max-width, 1200px)) !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        flex: 0 0 auto !important;
        background: #fff !important;
        border: 0 !important;
      }
      #fe-chat-export-container #chat {
        position: static !important;
        background: #fff !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
        display: block !important;
      }
      #fe-chat-export-container #chat-log {
        position: static !important;
        background: #fff !important;
        padding: 0 !important;
        margin: 0 !important;
        width: auto !important;
        height: auto !important;
        max-height: none !important;
        overflow: visible !important;
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
        #chat-log .chat-message {
          break-inside: avoid;
          page-break-inside: avoid;
        }

        /* PDF 안정성: 이미지 숨김 옵션 */
        body.fe-print-hide-avatars #chat-log :is(
          .message-header img,
          .message-sender .avatar,
          .message-sender > img,
          img.chat-portrait-image-size-name-dnd5e,
          img[class*="chat-portrait-image-size"]
        ) {
          display: none !important;
        }
        body.fe-print-hide-all #chat-log img { display: none !important; }

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
      <div id="sidebar" class="sidebar">
        <section id="chat" class="sidebar-tab tab active" data-tab="chat">
          <ol id="chat-log" class="chat-log"></ol>
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
  // Apply chat portrait vars/classes so archive matches live chat (size, hide-wrap).
  try {
    feChatPortraitApplyVars(win.document);
  } catch {}

  // Hook up controls.
  const logEl = win.document.getElementById("chat-log");
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

  // Render messages in batches to keep UI responsive and reduce reflow/parsing cost.
  let i = 0;
  let frag = win.document.createDocumentFragment();
  let fragCount = 0;

  const flush = async () => {
    if (fragCount) {
      logEl.appendChild(frag);
      frag = win.document.createDocumentFragment();
      fragCount = 0;
    }
    await feMaybeYieldForUI(win);
  };

  for (const msg of messages) {
    i++;
    if (metaEl && (i === 1 || i % FE_EXPORT_STATUS_EVERY === 0 || i === messages.length)) {
      metaEl.textContent = `Rendering… ${i}/${messages.length}`;
    }

    const msgId = String(msg?.id ?? msg?._id ?? "");

    // 1) Try to clone from live DOM
    let node = null;
    const liveEl = msgId ? liveMessageMap.get(msgId) : null;
    if (liveEl) {
      try {
        node = win.document.importNode(liveEl, true);
      } catch (_e) {
        node = null;
      }
    }

    // 2) Fallback: render a minimal message if not present in DOM
    if (!feIsElement(node)) {
      try {
        node = feFallbackRenderChatMessage(win.document, msg);
      } catch (e) {
        console.warn(`${MODULE_ID}: fallback render failed for message`, msgId || msg, e);
        node = null;
      }
    }

    if (!feIsElement(node)) continue;

    node.classList.add("fe-export-message");

    // Normalize URLs so print/export loads images reliably.
    feNormalizeExportNode(node);

    // Apply per-message user color tint variables.
    feApplyUserColorBgToMessageElement(msg, node);

    // Ensure our chat portraits exist in the archive DOM, but avoid duplicating
    // other portrait modules if they already injected portraits.
    try {
      const hasOtherPortrait = !!node.querySelector?.(
        'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container'
      );
      if (!hasOtherPortrait) feChatPortraitUpsert(msg, node);
    } catch {}

    frag.appendChild(node);
    fragCount++;

    // Yield to keep the archive window responsive during large exports.
    if (i % FE_EXPORT_RENDER_BATCH === 0) await flush();
  }

  // Flush any remaining nodes.
  if (fragCount) logEl.appendChild(frag);


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
  }

  // Wait for images so avatars/icons actually show up.
  if (metaEl) metaEl.textContent = "Loading images…";
  await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: FE_EXPORT_WAIT_IMAGES_MAX });

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
    doc.getElementById("chat-log") ||
    doc.getElementById("fe-chat-export-log") ||
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
  const shouldDownscale = !!logEl && (mode === "downscale" || (isElectron && mode !== "hideAll"));
  if (shouldDownscale && logEl) {
    try {
      setMeta("Loading images…");
      await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: FE_EXPORT_WAIT_IMAGES_MAX });
      await feDownscaleImagesForPrint(win, logEl, {
        meta: setMeta,
        excludeAvatars: mode === "hideAvatars",
        dprCap: isElectron ? 1 : 1.5,
        webpQuality: isElectron ? 0.72 : 0.82,
        jpegQuality: isElectron ? 0.78 : 0.85,
        avatarDprCap: isElectron ? 1.75 : 2,
        avatarWebpQuality: isElectron ? 0.86 : 0.92,
        avatarJpegQuality: isElectron ? 0.88 : 0.94,
      });
    } catch (err) {
      console.warn("female_edition | print downscale failed", err);
    }
  }

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

  for (const el of msgs) {
    try {
      const cs = win.getComputedStyle(el);
      const bg = feParseRGBAFromCSS(cs.backgroundColor);
      if (!bg || bg.a <= 0) continue;

      // Blend the paper overlay using the *screen* blend formula.
      // We then bake the result into an opaque RGB to avoid print/PDF blend inconsistencies.
      const sr = feScreenBlendChannel(bg.r, paper.r);
      const sg = feScreenBlendChannel(bg.g, paper.g);
      const sb = feScreenBlendChannel(bg.b, paper.b);

      const outR = Math.round(bg.r * (1 - paperAlpha) + sr * paperAlpha);
      const outG = Math.round(bg.g * (1 - paperAlpha) + sg * paperAlpha);
      const outB = Math.round(bg.b * (1 - paperAlpha) + sb * paperAlpha);

      const prevStyle = el.getAttribute("style");
      changed.push({ el, prevStyle });

      el.style.setProperty("background-color", `rgb(${outR}, ${outG}, ${outB})`, "important");
      el.style.setProperty("background-image", "none", "important");
      el.style.setProperty("background-blend-mode", "normal", "important");
      el.style.setProperty("mix-blend-mode", "normal", "important");
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
  } = {}
) {
  const setMeta = typeof meta === "function" ? meta : () => {};
  let imgs = Array.from(rootEl.querySelectorAll("img"));
  if (!imgs.length) return;

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

  if (excludeAvatars) imgs = imgs.filter((img) => !isAvatarImage(img));

  // Cap DPR for stability (large DPR values can explode PDF size / memory use)
  const dpr = Math.max(1, Math.min(dprCap, win.devicePixelRatio || 1));
  const avatarDpr = Math.max(1, Math.min(avatarDprCap, win.devicePixelRatio || 1));

  // 1) Group images by their resolved source.
  //    This allows de-duplicating identical images (portraits, repeated icons, etc.)
  //    by generating ONE downscaled data URL and reusing it.
  const groups = new Map();

  const getKey = (img) => {
    try {
      // Prefer the actually-used resource when srcset is present.
      return img.currentSrc || img.src || img.getAttribute("src") || "";
    } catch {
      return "";
    }
  };

  // Hard cap to avoid huge canvases (prevents OOM on Electron/Chromium)
  const MAX_SIDE = 1600;

  for (const img of imgs) {
    try {
      if (!img.complete || img.naturalWidth <= 0) continue;

      const key = getKey(img);
      if (!key) continue;

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

      const needsResample = !(img.naturalWidth <= targetW * 1.05 && img.naturalHeight <= targetH * 1.05);

      const g = groups.get(key) || {
        key,
        imgs: [],
        maxW: 0,
        maxH: 0,
        needsResample: false,
        isAvatar: false,
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
  if (!groupList.length) return;

  // 2) Generate a single downscaled image per group.
  const cache = new Map();
  let gi = 0;
  for (const g of groupList) {
    gi++;
    if (gi === 1 || gi % 10 === 0 || gi === groupList.length) {
      setMeta(`Downscaling images… ${gi}/${groupList.length}`);
    }

    try {
      // Only do work when it helps:
      // - if resampling is needed OR
      // - if the same image appears multiple times (dedup benefits PDF size)
      const shouldProcess = g.needsResample || g.imgs.length > 1;
      if (!shouldProcess) continue;

      const rep = g.imgs.find((img) => img?.complete && img.naturalWidth > 0);
      if (!rep) continue;

      // Avoid upscaling.
      let outW = Math.min(g.maxW, rep.naturalWidth);
      let outH = Math.min(g.maxH, rep.naturalHeight);
      outW = Math.max(1, Math.round(outW));
      outH = Math.max(1, Math.round(outH));
      if (outW <= 1 || outH <= 1) continue;

      const canvas = win.document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d", { alpha: true });
      if (!ctx) continue;

      // Improve downscale quality (avoid jaggy / no-AA portraits)
      try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
      } catch {}

      ctx.drawImage(rep, 0, 0, outW, outH);

      const dataUrl = await feCanvasToDataURL(canvas, {
        webpQuality: g.isAvatar ? avatarWebpQuality : webpQuality,
        jpegQuality: g.isAvatar ? avatarJpegQuality : jpegQuality,
      });
      if (!dataUrl) continue;

      cache.set(g.key, dataUrl);

      // Release memory
      canvas.width = 0;
      canvas.height = 0;
    } catch {
      // Ignore per-group failures (CORS-taint, decoding error, etc.)
    }

    if (gi % 10 === 0) await feNextTick();
  }

  // 3) Apply results to every image in the group (dedup).
  for (const g of groupList) {
    const dataUrl = cache.get(g.key);
    if (!dataUrl) continue;
    for (const img of g.imgs) {
      try {
        img.removeAttribute("srcset");
        img.src = dataUrl;
      } catch {}
    }
  }
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
      }
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed fonts", err);
    }
  }

  // ---
  // Body snapshot
  // ---
  let bodyHTML = "";
  if (feSetting(S.EXPORT_EMBED_IMAGES)) {
    // Image embedding requires mutating src/srcset to data: URLs.
    // Do it on a cloned <body> so the archive window stays visually unchanged.
    try {
      setMeta("Embedding images…");
      const bodyClone = doc.body.cloneNode(true);
      await feEmbedImagesInNode(bodyClone, { meta: setMeta });
      bodyHTML = bodyClone.outerHTML;
    } catch (err) {
      console.warn("female_edition | HTML export: failed to embed images", err);
      // Fallback: still produce a valid snapshot.
      bodyHTML = doc.body.outerHTML;
    }
  } else {
    bodyHTML = doc.body.outerHTML;
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
      `@font-face{font-family:"FE CookieRun Embedded";src:url(${dataUrl}) format("${fmt}");font-weight:${w.weight};font-style:normal;unicode-range:${unicodeRange};font-display:swap;}`
    );
  }

  // Optional: embed Hakgyoansim Geurimilgi.
  // If present, we embed it so saved file:// HTML keeps the same look.
  try {
    const geurUrl = `/modules/${MODULE_ID}/font/HakgyoansimGeurimilgi-R.ttf`;
    const geurimilgiData = await fetchFont(geurUrl, { perFileCap: MAX_PER_FILE_BYTES_GEUR });
    if (geurimilgiData) {
      faces.push(
        `@font-face{font-family:"FE Geurimilgi Embedded";src:url(${geurimilgiData}) format("truetype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:swap;}`
      );
    }
  } catch {}

  if (!faces.length) return "";

  return `
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
#fe-chat-export-container :is(
  .chat-message,
  .message-header,
  .message-content,
  .flavor-text,
  .chat-card,
  .midi-chat-card,
  .dnd5e2.chat-card
) {
  font-family: var(--fe-chat-font-family) !important;
}
`;
}

async function feFetchAsDataURL(url) {
  try {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await feBlobToDataURL(blob);
  } catch {
    return null;
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
  // Apply merge classes (start/mid/end/divider) in the archive window.
  // This version keeps allocations low for large exports.
  try {
    const logEl =
      win.document.getElementById("chat-log") ||
      win.document.getElementById("fe-chat-export-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    // Mirror merge-related body classes.
    try {
      win.document.body.classList.toggle("fe-chat-merge", !!feSetting(S.MERGE_ENABLED));
      const style = String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
      win.document.body.classList.toggle("fe-merge-follow-hide", style === "hide");
      win.document.body.classList.toggle("fe-merge-follow-name", style === "name");
      win.document.body.classList.toggle("fe-merge-follow-portrait", style === "portrait");
    } catch {}

    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const showDivider = !!feSetting(S.MERGE_DIVIDER);

    const canMerge = (a, b) => {
      if (!a || !b) return false;
      if (a.key !== b.key) return false;
      if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
      return true;
    };

    let prevInfo = null;
    let groupCount = 0;
    let firstInGroup = null;
    let lastInGroup = null;
    let seenAny = false;

    for (const el of logEl.querySelectorAll("li.chat-message")) {
      el.classList.remove("fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-divider-before");

      const id = feGetMessageIdFromElement(el);
      const msg = id ? game.messages?.get(id) : null;
      const info = feMessageMergeInfo(msg, el);
      const current = { el, ...info, key: feMergeKey(info) };

      if (!seenAny) {
        seenAny = true;
      } else if (showDivider && !canMerge(prevInfo, current)) {
        el.classList.add("fe-divider-before");
      }

      if (canMerge(prevInfo, current)) {
        groupCount += 1;
        if (groupCount === 2 && firstInGroup) firstInGroup.el.classList.add("fe-merge-start");
        if (groupCount > 2 && lastInGroup) {
          lastInGroup.el.classList.remove("fe-merge-end");
          lastInGroup.el.classList.add("fe-merge-mid");
        }
        el.classList.add("fe-merge-end");
      } else {
        groupCount = 1;
        firstInGroup = current;
      }

      lastInGroup = current;
      prevInfo = current;
    }
  } catch (err) {
    console.warn("female_edition | feApplyChatMergeInWindow failed", err);
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

function feNormalizeExportNode(rootEl) {
  try {
    const baseHref = rootEl?.ownerDocument?.baseURI || window.location.href;

    // Normalize image URLs to absolute so print reliably loads them
    for (const img of rootEl.querySelectorAll("img")) {
      const src = img.getAttribute("src");
      if (!src) continue;
      try {
        img.src = new URL(src, baseHref).href;
      } catch {}
      // Ensure intrinsic size isn't lost in print layout
      if (!img.getAttribute("loading")) img.setAttribute("loading", "eager");
      if (!img.getAttribute("decoding")) img.setAttribute("decoding", "sync");
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

function feFallbackRenderChatMessage(doc, msg) {
  if (!doc) throw new Error("No document provided");
  const li = doc.createElement("li");
  li.className = "chat-message message";

  try {
    const id = msg?.id ?? msg?._id;
    if (id) li.dataset.messageId = String(id);
  } catch {}

  // Speaker / author name
  const speakerName = (() => {
    try {
      const s = msg?.speaker;
      if (s?.alias) return String(s.alias);
    } catch {}
    try {
      const a = msg?.author ?? msg?.user;
      if (a?.name) return String(a.name);
    } catch {}
    return "Unknown";
  })();

  const timestampText = (() => {
    try {
      const ts = Number(msg?.timestamp);
      if (!Number.isFinite(ts) || ts <= 0) return "";
      // Keep it simple and locale-friendly.
      return new Date(ts).toLocaleString();
    } catch {
      return "";
    }
  })();

  const header = doc.createElement("header");
  header.className = "message-header flexrow";

  const sender = doc.createElement("h4");
  sender.className = "message-sender";
  sender.textContent = speakerName;

  const meta = doc.createElement("span");
  meta.className = "message-metadata";
  if (timestampText) {
    const time = doc.createElement("time");
    time.className = "message-timestamp";
    time.textContent = timestampText;
    meta.appendChild(time);
  }

  header.appendChild(sender);
  header.appendChild(meta);

  const content = doc.createElement("div");
  content.className = "message-content";
  try {
    // ChatMessage.content is already HTML.
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
