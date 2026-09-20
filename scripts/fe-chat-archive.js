// Chat archive + HTML/PDF export — ENTRY MODULE.
//
// This is the only archive file in module.json; every `fe-archive-*.js` reaches
// Foundry through an ES import from here. What stays in this file is what has no
// smaller scope to live at:
//
//   - the launch lock (mutable module state, so it cannot be an imported binding)
//   - the export buttons and their hooks
//   - the three export entry points (popup / in-document print / desktop HTML)
//   - feRenderChatArchiveWindow: the ORCHESTRATION, i.e. the order the passes run in
//
// Anything that is about one message, one document, the print run, the saved file or
// which messages to include belongs in a sub-module — see docs/chat.md's
// "Where to look" table, which is organized by SCOPE rather than by topic.

import { feLocalize, feFormat, feLocalizeHTML } from "./fe-i18n.js";
import {
  MODULE_ID,
  S,
  feSetting,
  feApplyStyleClassesToDocument,
  feStripChatTexturesInWindow,
  feApplyChatMerge,
} from "./fe-chat-enhance.js";
import { feSnapshotAndRestoreStickyScroll } from "./fe-util.js";
import {
  feChatPortraitApplyVars,
} from "./fe-chat-portrait.js";
import {
  feWaitForFonts,
  feNormalizeArchiveShellLayout,
  feNormalizeArchiveMessageLayout,
  feWaitForImages,
  feBuildArchiveTitleText,
  feRunArchiveDocumentOperation,
  feEnableArchiveScreenContainment,
} from "./fe-archive-output.js";
import {
  feDownloadArchiveHTML,
  feDownloadExportHTMLFromCurrentDocument,
} from "./fe-archive-snapshot.js";
import {
  FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT,
  FE_EXPORT_WAIT_FONTS_TIMEOUT,
  FE_EXPORT_WAIT_IMAGES_MAX,
  FE_EXPORT_WAIT_IMAGES_TIMEOUT,
  feArchiveWindowClosed,
  feIsElectron,
  feMaybeYieldForUI,
  feRunArchiveChunkedPass,
} from "./fe-archive-runtime.js";
import {
  feApplyMessageRange,
  feBuildLiveChatMessageElementMap,
  feCollectVisibleChatMessages,
  feGetArchiveRenderProfile,
  feShowArchiveRangeDialog,
} from "./fe-archive-collect.js";
import {
  feApplyChatMergeInWindow,
  feBuildArchiveDocument,
  feApplyModuleStylesheetSettingsToDocument,
  feArchiveMergeOptions,
  feEnsureArchiveEmbeddedFonts,
  feSyncArchiveDocumentChrome,
  feSyncArchiveMergeBodyClasses,
} from "./fe-archive-document.js";
import {
  feFireArchiveRenderUpdated,
  feInlineDnd5eIcons,
  feRefreshPortraitsForLog,
  feRenderMessagesIntoLog,
} from "./fe-archive-message.js";
import {
  feArchivePrint,
  feEnsurePrintCSSOverrides,
  fePrepareImagesForPageBreaks,
} from "./fe-archive-print.js";

// ===========================================================================
// Constants
// ===========================================================================

let feArchiveLaunchInProgress = false;
// Bumped per launch so an ABANDONED run's `finally` cannot clear a lock that a later
// run now owns. Without it, a stale-lock takeover would be undone the moment the old
// run finally unwound, letting a third click start a concurrent render.
let feArchiveLaunchToken = 0;
let feArchiveLaunchStartedAt = 0;
// The popup the current launch is rendering into, so the busy-guard can tell an
// abandoned run (its window is gone) from a genuinely slow one.
let feArchiveLaunchWindow = null;
// Last-resort valve for a hang we have not foreseen. Generous on purpose: a huge log
// legitimately takes minutes, and releasing early would start a second concurrent render.
const FE_ARCHIVE_LAUNCH_STALE_MS = 10 * 60 * 1000;


// ===========================================================================
// Export Entry Points  (button injection, PDF popup, inline print)
// ===========================================================================

function _feCreateExportAnchor() {
  const a = document.createElement("a");
  a.className = "control-icon fe-export-pdf";
  a.dataset.tooltip = feLocalize("FE.ChatArchive.tooltip");
  a.ariaLabel = feLocalize("FE.ChatArchive.tooltip");
  a.innerHTML = '<i class="fa-solid fa-file-pdf"></i>';
  a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    await feExportChatLogToPDF();
  });
  return a;
}

function feInjectExportButton(root = document) {
  if (!feSetting(S.EXPORT_ENABLED)) return;

  // Primary: inject directly into the hamburger panel when it exists.
  // This avoids the inject-into-controls → move-to-panel race condition.
  const panel = document.getElementById("fe-ctrl-menu-panel");
  if (panel) {
    // Remove any orphan .fe-export-pdf buttons outside the panel (e.g. stale
    // buttons injected into form.chat-form by the last-resort fallback below).
    document.querySelectorAll(".fe-export-pdf").forEach(el => {
      if (!panel.contains(el)) el.remove();
    });
    if (!panel.querySelector(".fe-export-pdf")) {
      panel.appendChild(_feCreateExportAnchor());
    }
    return;
  }

  // Fallback (panel not yet built): inject into #chat-controls so that
  // feRebuildCtrlMenu can collect and move it when the panel is created.
  // Note: form.chat-form is intentionally excluded — injecting directly into the
  // form caused orphan buttons that appeared outside the hamburger panel.
  const controls =
    root.querySelector("#chat-controls") ||
    root.querySelector("#sidebar #chat #chat-controls") ||
    root.querySelector("#sidebar #chat .chat-controls") ||
    root.querySelector("#sidebar #chat .chat-control-icons") ||
    root.querySelector("#sidebar #chat .control-buttons");

  if (!controls) return;
  if (controls.querySelector(".fe-export-pdf")) return;

  controls.appendChild(_feCreateExportAnchor());
}

// Enumerate every open app across v13 (ui.windows) and v14 (foundry.applications.instances).
function feIterAllApps() {
  const out = [];
  try {
    for (const w of Object.values(ui?.windows ?? {})) if (w) out.push(w);
  } catch { /* no-op */ }
  try {
    const av2 = globalThis.foundry?.applications?.instances;
    if (av2 && typeof av2.values === "function") {
      for (const app of av2.values()) if (app) out.push(app);
    } else if (av2 && typeof av2[Symbol.iterator] === "function") {
      for (const app of av2) if (app) out.push(app);
    }
  } catch { /* no-op */ }
  return out;
}

function feAppRoot(app) {
  const el = app?.element;
  if (!el) return null;
  if (el.jquery && el[0]?.nodeType === 1) return el[0];
  if (el.nodeType === 1) return el;
  if (el[0]?.nodeType === 1) return el[0];
  return null;
}

function feInjectExportButtonsAll() {
  feInjectExportButton(document);
  // also for popped-out chat logs if present
  for (const w of feIterAllApps()) {
    const root = feAppRoot(w);
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
        <a class="fe-chat-export-action fe-chat-export-download" aria-label="${feLocalizeHTML("FE.Common.DownloadHtml")}" data-tooltip="${feLocalizeHTML("FE.ChatArchive.innerHTML.Text1")}">HTML</a>
        <a class="fe-chat-export-action fe-chat-export-print" aria-label="${feLocalizeHTML("FE.Common.Print")}" data-tooltip="${feLocalizeHTML("FE.ChatArchive.innerHTML.Text2")}">🖨</a>
        <a class="fe-chat-export-action fe-chat-export-close" aria-label="${feLocalizeHTML("FE.Common.Close")}" data-tooltip="${feLocalizeHTML("FE.Common.Close")}">✕</a>
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
    dlBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feDownloadExportHTMLFromCurrentDocument();
    });
  }

  return container;
}


/**
 * Primary export entry point.
 *
 * Strategy:
 *  1) Try to open a dedicated "chat archive" popup window and render the log there.
 *     - Avoids Chromium/Electron print clipping caused by Foundry's fixed viewport.
 *     - Lets the user save/print like a normal web page (Ctrl+S / Print to PDF).
 *  2) If popups are blocked, fall back to the in-document export container.
 *  3) In the Foundry desktop (Electron) app, save a self-contained HTML archive
 *     instead. Modules cannot access Electron's native printToPDF API, while
 *     window.print() uses the slow/unreliable OS printer route.
 */
async function feExportChatLogToPDF() {
  if (feArchiveLaunchInProgress && !feArchiveLaunchIsAbandoned()) {
    ui.notifications?.warn(feLocalize("FE.ChatArchive.feExportChatLogToPDF"), { console: false });
    return;
  }

  const token = ++feArchiveLaunchToken;
  feArchiveLaunchInProgress = true;
  feArchiveLaunchStartedAt = Date.now();
  feArchiveLaunchWindow = null;
  const buttons = Array.from(document.querySelectorAll(".fe-export-pdf"));
  for (const button of buttons) button.setAttribute?.("aria-disabled", "true");
  try {
    return await feExportChatLogToPDFUnlocked();
  } finally {
    // Only the CURRENT owner may release. An abandoned run reaching here later must
    // not unlock a launch that superseded it.
    if (feArchiveLaunchToken === token) {
      feArchiveLaunchInProgress = false;
      feArchiveLaunchWindow = null;
      for (const button of buttons) button.removeAttribute?.("aria-disabled");
    }
  }
}

/**
 * Whether the in-progress launch should be considered dead so a new one may take over.
 *
 * Primary signal is precise, not a guess: the popup it was rendering into is gone. The
 * render aborts at its next batch boundary in that case, so the old run is finishing
 * anyway. The elapsed-time valve is a backstop for a hang we have not foreseen — the
 * failure it guards against is a lock stuck for the WHOLE SESSION, which is what
 * closing the window mid-render used to cause.
 */
function feArchiveLaunchIsAbandoned() {
  try {
    if (feArchiveLaunchWindow && feArchiveWindowClosed(feArchiveLaunchWindow)) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchiveLaunchIsAbandoned"));
      return true;
    }
    if (feArchiveLaunchStartedAt && Date.now() - feArchiveLaunchStartedAt > FE_ARCHIVE_LAUNCH_STALE_MS) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feArchiveLaunchIsAbandoned2"));
      return true;
    }
  } catch {
    /* no-op */
  }
  return false;
}

async function feExportChatLogToPDFUnlocked() {
  // Step 1: Collect messages BEFORE opening the popup window,
  // so the range dialog appears on its own without the archive window behind it.
  let preCollectedMessages = null;
  let preRangeSpec = null;
  try {
    const liveMessageMap = feBuildLiveChatMessageElementMap();
    ui.notifications?.info(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked"), { permanent: false, console: false });
    preCollectedMessages = await feCollectVisibleChatMessages(game.user, { liveMessageMap });

    if (!preCollectedMessages.length) {
      ui.notifications?.warn(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked2"));
      return;
    }

    // Step 2: Show range dialog before opening the popup.
    preRangeSpec = await feShowArchiveRangeDialog(preCollectedMessages.length);
    if (preRangeSpec == null) return; // cancelled
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feExportChatLogToPDFUnlocked"), err);
    preCollectedMessages = null;
    preRangeSpec = null;
  }

  // The Electron renderer cannot call the native printToPDF API. Its
  // window.print() route opens the OS printer dialog (often Microsoft Print to
  // PDF), which is slow and can produce invalid files on image-heavy archives.
  // Keep desktop export reliable and portable: download HTML, then let the user
  // open it in any normal browser and use that browser's PDF-save feature.
  if (feIsElectron()) {
    const done = await feExportChatLogToDesktopHTML({ preCollectedMessages, preRangeSpec });
    if (!done) ui.notifications?.error(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked3"), { console: false });
    return;
  }

  // Step 3: Now open the archive popup window.
  const win = feOpenChatArchiveWindow();
  // Recorded so the busy-guard can detect an abandoned launch (see feArchiveLaunchIsAbandoned).
  feArchiveLaunchWindow = win || null;
  if (win) {
    try {
      const optimize = !!feSetting(S.EXPORT_OPTIMIZE);

      // The window title is NOT set here — feRenderChatArchiveWindow calls
      // feBuildArchiveTitleText() itself and writes it to #fe-chat-export-title.
      await feRenderChatArchiveWindow(win, {
        autoPrint: !!feSetting(S.EXPORT_AUTO_PRINT),
        optimize,
        preCollectedMessages,
        preRangeSpec,
      });

      return;
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feExportChatLogToPDFUnlocked2"), err);
      try {
        win.close();
      } catch {}
    }
  }

  // Defensive second check for Electron builds whose user agent is populated
  // late. Never allow the desktop client to fall through to window.print().
  if (feIsElectron()) {
    const done = await feExportChatLogToDesktopHTML({ preCollectedMessages, preRangeSpec });
    if (!done) ui.notifications?.error(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked3"), { console: false });
    return;
  }

  // Browser fallback: in-document export + print. Reuse the already-collected messages
  // and range selection: popup blockers are common in the desktop client, and
  // collecting again here used to discard the user's selected range.
  ui.notifications?.info(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked4"), { console: false });
  await feExportChatLogToPDFInline({ preCollectedMessages, preRangeSpec });
}

// ---------------------------------------------------------------------------
// Export — Inline fallback (print from current document)
// ---------------------------------------------------------------------------

async function feExportChatLogToPDFInline({ preCollectedMessages = null, preRangeSpec = null } = {}) {
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

  // Idempotent restore of the LIVE document (this fallback path mutates the live
  // DOM directly, unlike the popup path). Defined here — before the try — so the
  // catch handler can also reach it. Callable from afterprint, the post-print
  // tick, the close button, and the catch; whichever fires first wins.
  let restorePageBreaks = () => {};
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { restorePageBreaks(); } catch {}
    try { container.remove(); } catch {}
    document.body.classList.remove("fe-print-chatlog");
    document.body.classList.remove("fe-export-optimized");
    htmlEl.style.overflow = prevHtmlOverflow;
    htmlEl.style.height = prevHtmlHeight;
    document.body.style.overflow = prevBodyOverflow;
    document.body.style.height = prevBodyHeight;
  };
  // The container's built-in ✕ does only a partial teardown (container + one
  // class); ensure the full idempotent cleanup also runs so overflow/height are
  // always restored.
  try {
    container.querySelector(".fe-chat-export-close")?.addEventListener("click", cleanup);
  } catch {}

  try {
    const liveMessageMap = feBuildLiveChatMessageElementMap();
    let allMessages;
    if (Array.isArray(preCollectedMessages) && preCollectedMessages.length > 0) {
      allMessages = preCollectedMessages;
    } else {
      allMessages = await feCollectVisibleChatMessages(game.user, {
        liveMessageMap,
        progress: (text) => {
          try { if (metaEl) metaEl.textContent = text; } catch {}
        },
      });
    }

    let rangeSpec = preRangeSpec;
    if (rangeSpec == null) {
      rangeSpec = await feShowArchiveRangeDialog(allMessages.length);
      if (rangeSpec == null) {
        cleanup();
        return;
      }
    }
    const messages = feApplyMessageRange(allMessages, rangeSpec);
    if (!messages.length) {
      ui.notifications?.warn(feLocalize("FE.ChatArchive.feExportChatLogToPDFInline"));
      cleanup();
      return;
    }
    const renderProfile = feGetArchiveRenderProfile(messages.length);

    // Header/meta
    const sceneName = canvas?.scene?.name ?? "";
    titleEl.textContent = feBuildArchiveTitleText();
    metaEl.textContent = feFormat("FE.ChatArchive.MessageCount", { count: messages.length }) + (sceneName ? ` • ${sceneName}` : "");

    // Prefer cloning from the already-rendered live chat log DOM when possible.

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

    // This fallback lives in the real Foundry document. Restrict normalization
    // to the export subtree so the live sidebar/chat DOM is never left with
    // archive-only inline width/overflow styles after cleanup.
    try { feNormalizeArchiveShellLayout(document, { root: container }); } catch {}

    // Apply merge styling to export log (our mutation observer is scoped to #sidebar)
    if (feSetting(S.MERGE_ENABLED)) {
      feSyncArchiveMergeBodyClasses(document);
      feApplyChatMerge(logEl, feArchiveMergeOptions());
      feRefreshPortraitsForLog(logEl, renderProfile);
    } else if (renderProfile.deferPortraits) {
      feRefreshPortraitsForLog(logEl, renderProfile);
    }

    try {
      feFireArchiveRenderUpdated(document, logEl);
    } catch {}

    // Wait for images (portraits, item icons) to load so they actually print
    metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? feLocalize("FE.ChatArchive.Status.LoadingVisibleImages") : feLocalize("FE.ChatArchive.Status.LoadingImages");
    const inlineImgTimeout = await feWaitForImages(logEl, FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
    if (inlineImgTimeout > 0) console.warn(feFormat("FE.Diagnostics.ChatArchive.feExportChatLogToPDFInline", { inlineImgTimeout: inlineImgTimeout }));

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
      void container.offsetHeight;
      void logEl.offsetHeight;
    } catch {}

    // Fonts must be SETTLED before window.print(). The popup path has always done this
    // (feEnsureArchiveEmbeddedFonts + feWaitForFonts before win.print()); this inline
    // fallback went straight from the image wait to print, so Chromium could capture the
    // page while a webface was still loading and rasterize the fallback font into the
    // PDF — the "PDF에 폰트가 임베드되지 않는다" symptom, even though the same document
    // looked correct on screen a moment later.
    //
    // No font CSS is injected here, unlike the popup: this IS the live Foundry document,
    // so ui-font.css and its @font-face rules are already loaded. Injecting the archive's
    // embedded-font block would drop an UNLAYERED `html, body { font-family: … !important }`
    // (plus :root --font-* overrides) onto the live UI — see feBuildEmbeddedCookieRunFontCSS.
    metaEl.textContent = feLocalize("FE.ChatArchive.Status.LoadingFonts");
    await feWaitForFonts(document, FE_EXPORT_WAIT_FONTS_TIMEOUT);

    metaEl.textContent = feLocalize("FE.ChatArchive.Status.OpeningPrintDialog");

    try {
      restorePageBreaks = fePrepareImagesForPageBreaks(document, logEl);
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feExportChatLogToPDFInline2"), err);
    }

    window.addEventListener("afterprint", cleanup, { once: true });
    window.print();
    // window.print() blocks in browsers until the dialog closes; some Electron
    // builds return immediately and don't fire afterprint reliably. cleanup is
    // idempotent, so a post-print tick guarantees the live document is restored
    // even when afterprint never arrives.
    setTimeout(cleanup, 0);
  } catch (err) {
    console.error(err);
    ui.notifications?.error(feLocalize("FE.ChatArchive.Status.ExportFailed"));
    // Restore the live document even if we failed mid-export.
    try { cleanup(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Export — Popup archive window
// ---------------------------------------------------------------------------

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
    if (!win || win.closed) {
      // The caller has a same-window render/print fallback. This is especially
      // expected in Foundry's Electron client, where window.open is commonly
      // disabled, so do not instruct users to change popup-blocker settings.
      console.info(feLocalize("FE.Diagnostics.ChatArchive.feOpenChatArchiveWindow"));
      return null;
    }

    try {
      win.focus();
    } catch {}
    return win;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Export — Desktop (Electron) path
//
// The Foundry desktop app blocks window.open popups and its window.print()
// route invokes an OS printer dialog, not Chromium's reliable PDF-save UI.
// A distributed module cannot access Electron's native printToPDF API, so the
// supported desktop output is an HTML archive saved from a hidden same-origin
// iframe. Users can open that file in Chrome/Edge and print it to PDF there.
// ---------------------------------------------------------------------------

function feCreateHiddenArchiveFrame() {
  const iframe = document.createElement("iframe");
  iframe.id = "fe-chat-archive-frame";
  // Kept RENDERED (not display:none) so images/fonts load and layout measures
  // correctly, but pushed fully off-screen and made inert.
  iframe.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1100px;height:800px;border:0;opacity:0;pointer-events:none;z-index:-1;";
  document.body.appendChild(iframe);
  return iframe;
}

async function feExportChatLogToDesktopHTML({ preCollectedMessages = null, preRangeSpec = null } = {}) {
  const optimize = !!feSetting(S.EXPORT_OPTIMIZE);
  // Same helper feRenderChatArchiveWindow uses below, so the saved file's header
  // and its filename can never disagree.
  const titleText = feBuildArchiveTitleText();

  const iframe = feCreateHiddenArchiveFrame();
  const win = iframe.contentWindow;
  if (!win) {
    try { iframe.remove(); } catch {}
    return false;
  }

  try {
    ui.notifications?.info(feLocalize("FE.ChatArchive.feExportChatLogToDesktopHTML"), { console: false });

    await feRenderChatArchiveWindow(win, {
      autoPrint: false,
      optimize,
      // The HTML snapshot fetches/embeds its own assets below. Waiting for a
      // hidden iframe to decode its full image tree first is redundant and can
      // add a 20-second timeout (or a decode spike) in the Electron client.
      waitForAssets: false,
      preCollectedMessages,
      preRangeSpec,
    });

    const saved = await feDownloadArchiveHTML(win, titleText);
    if (saved) ui.notifications?.info(feLocalize("FE.ChatArchive.feExportChatLogToDesktopHTML2"), { console: false });
    return saved;
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feExportChatLogToDesktopHTML"), err);
    return false;
  } finally {
    // Let the browser receive the download click before tearing down its frame.
    setTimeout(() => { try { iframe.remove(); } catch {} }, 2000);
  }
}


// ===========================================================================
// Archive Window — Main Render Loop
// Collects history, renders all messages into the popup document, wires
// export/print controls, and optionally triggers autoPrint.
// ===========================================================================

async function feRenderChatArchiveWindow(win, {
  autoPrint = false,
  optimize = false,
  waitForAssets = true,
  preCollectedMessages = null,
  preRangeSpec = null,
} = {}) {
  if (!win || win.closed) throw new Error("Archive window is not available.");

  // Treat the chat-bg-stripper's "채팅 카드 텍스쳐 제거" setting as an implicit
  // export optimization request. Users expect the archive/saved HTML to match the
  // live chat appearance.
  const stripTexturesSetting = (() => {
    try {
      return !!game.settings.get(MODULE_ID, S.UI_STRIP_TEXTURES);
    } catch {
      return false;
    }
  })();
  const effectiveOptimize = !!optimize || stripTexturesSetting;

  const sceneName = canvas?.scene?.name ?? "";
  const titleText = feBuildArchiveTitleText();

  // Build the archive document immediately so the popup is never left as a blank about:blank
  // while we collect older message history. Shell markup + its inline stylesheet live in
  // templates/fe-archive-shell.hbs.
  feBuildArchiveDocument(win, { titleText, optimized: effectiveOptimize });

  // Mirror root-level theme / dark-mode classes and data-* attributes so CSS variables
  // resolve the same way as they do in the live Foundry document.
  try {
    feSyncArchiveDocumentChrome(win.document);
  } catch {}

  // The archive window is a new Document; mirror any module settings that are applied
  // via JS on <link rel="stylesheet"> elements (e.g. enableFonts -> ui-font.css).
  // Without this, the archive can ignore the user's live CSS toggles.
  try {
    feApplyModuleStylesheetSettingsToDocument(win.document);
  } catch {}

  // Apply every document-scoped style toggle (style vars, font modes, retro theme,
  // user-color background, message-colour options) to the archive document, so the
  // popup and the downloaded HTML match the live chat.
  //
  // This is a CALL, not a copy, on purpose. It used to be a hand-maintained
  // duplicate of the same list, and it had drifted: two toggles were missing here
  // while their CSS rules explicitly named `#fe-chat-export-log`, so those rules
  // were dead in every archive. Do not inline the list again.
  //
  // The live-only parts of feApplyVisualSettingsToDocument are deliberately NOT
  // included — feSetBodyMergeClasses writes the LIVE body (the archive uses
  // feSyncArchiveMergeBodyClasses below) and feApplyCanvasTextFont mutates global
  // PIXI canvas state.
  feApplyStyleClassesToDocument(win.document);
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
  const btnClose = win.document.getElementById("fe-archive-close");
  const statusEl = win.document.getElementById("fe-chat-export-status");

  const setStatus = (text, { hide = false } = {}) => {
    try {
      if (statusEl) {
        statusEl.textContent = String(text ?? "");
        statusEl.hidden = !!hide;
      }
    } catch {
      /* no-op */
    }
    try {
      if (metaEl) metaEl.textContent = String(text ?? "");
    } catch {
      /* no-op */
    }
  };

  // Prevent exporting/printing until rendering is complete.
  try {
    btnPrint?.setAttribute?.("aria-disabled", "true");
    btnDownload?.setAttribute?.("aria-disabled", "true");
  } catch {}

  if (btnPrint)
    btnPrint.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (btnPrint.getAttribute("aria-disabled") === "true") return;
      try { win.focus(); } catch {}
      btnPrint.setAttribute("aria-disabled", "true");
      // Single unified print path. feArchivePrint handles the print image-mode
      // classes (hideAll/hideAvatars), background-color freeze, profile-aware
      // resolution/memory caps, font + image waits, downscale (blob URLs), and
      // afterprint restore. (Previously this handler ran a separate, simpler
      // downscale that ignored modes/freeze/quality settings.)
      try {
        await feRunArchiveDocumentOperation(win.document, () => feArchivePrint(win));
      } catch (err) {
        console.warn(feLocalize("FE.Diagnostics.ChatArchive.feRenderChatArchiveWindow"), err);
      } finally {
        try { btnPrint.removeAttribute("aria-disabled"); } catch {}
      }
    });

  if (btnDownload)
    btnDownload.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (btnDownload.getAttribute("aria-disabled") === "true") return;
      btnDownload.setAttribute("aria-disabled", "true");
      try {
        await feDownloadArchiveHTML(win, titleText);
      } finally {
        btnDownload.removeAttribute("aria-disabled");
      }
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

  // Let the popup paint its shell before heavy collection/harvesting starts.
  await feMaybeYieldForUI(win);

  // Collect ALL messages first (including DB query) so the range dialog can show the true total.
  // Skip if messages were pre-collected outside (before the popup opened) to preserve dialog order.
  const liveMessageMap = feBuildLiveChatMessageElementMap();
  let allMessages;
  if (Array.isArray(preCollectedMessages) && preCollectedMessages.length > 0) {
    allMessages = preCollectedMessages;
    setStatus(feFormat("FE.ChatArchive.feCollectVisibleChatMessages5", { length: allMessages.length }));
  } else {
    allMessages = await feCollectVisibleChatMessages(game.user, {
      liveMessageMap,
      progress: (text) => {
        setStatus(text);
      },
    });
  }

  // Show the range selection dialog now that we know the real message count.
  // Skip if a range was already selected before the popup opened.
  if (!allMessages.length) {
    setStatus(feLocalize("FE.ChatArchive.feRenderChatArchiveWindow"));
    ui.notifications?.warn(feLocalize("FE.ChatArchive.feExportChatLogToPDFUnlocked2"));
    return;
  }

  let rangeSpec;
  if (preRangeSpec != null) {
    rangeSpec = preRangeSpec;
  } else {
    rangeSpec = await feShowArchiveRangeDialog(allMessages.length);
    // rejectClose:false -> ESC/X returns undefined; cancelling OK can return null
    if (rangeSpec == null) {
      // User cancelled — close the archive window and abort.
      try { win.close(); } catch {}
      return;
    }
  }

  const messages = feApplyMessageRange(allMessages, rangeSpec);
  const renderProfile = feGetArchiveRenderProfile(messages.length);

  try {
    win.document.body.classList.remove("fe-archive-huge", "fe-archive-lean");
    for (const cls of String(renderProfile.bodyClass || "").split(/\s+/).filter(Boolean)) win.document.body.classList.add(cls);
  } catch {
    /* no-op */
  }

  // Deliberately NOT including the render profile's lean/huge label. That meta line
  // is the archive's own header and is serialized into the saved file, where an
  // internal performance mode is noise — the reader wants what this log IS, not how
  // it was produced.
  const metaParts = [feFormat("FE.ChatArchive.MessageCount", { count: messages.length })];
  if (sceneName) metaParts.push(sceneName);
  const metaText = metaParts.join(" • ");
  setStatus(metaText);

  // Render messages.
  logEl.innerHTML = "";

  // Prefer cloning from the already-rendered live chat log DOM when possible.
  // This avoids re-running render hooks from other modules (e.g. chat-portrait) which
  // can throw during automation-heavy sessions (midi-qol, tokenbar, etc.).

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

  // Everything below writes into win.document and waits on its assets. If the user
  // closed the popup during the render there is nothing left to produce, and pressing
  // on would only stall on asset timeouts before failing anyway. Return normally (not
  // by throwing) so the caller's `finally` clears feArchiveLaunchInProgress and the
  // next archive request is accepted immediately.
  if (feArchiveWindowClosed(win)) {
    console.debug(feLocalize("FE.Diagnostics.ChatArchive.feRenderChatArchiveWindow2"));
    return;
  }

  // If texture stripping / export optimization is enabled, apply the same
  // sanitization logic used in the live chat log (chat-bg-stripper.js).
  // This is required for the archive window + downloaded HTML to match the
  // on-screen chat saturation/overlay behavior.
  // Every sweep from here to the merge is chunked through feRunArchiveChunkedPass
  // so the popup stays clickable while it runs — see that function for why.
  const postPassNodes = (() => {
    try {
      return Array.from(logEl.querySelectorAll?.("li.chat-message") ?? []);
    } catch {
      return [];
    }
  })();

  if (effectiveOptimize) {
    if (metaEl) metaEl.textContent = feLocalize("FE.ChatArchive.Status.StrippingTextures");
    await feRunArchiveChunkedPass(win, postPassNodes, (batch) => feStripChatTexturesInWindow(win, logEl, { nodes: batch }));
  }

  // Apply merge styling in the archive window if enabled.
  if (feSetting(S.MERGE_ENABLED)) {
    try {
      feApplyChatMergeInWindow(win, renderProfile, { skipPortraits: true });
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feRenderChatArchiveWindow3"), err);
    }
  }
  if (renderProfile.deferPortraits) {
    if (metaEl) metaEl.textContent = feLocalize("FE.ChatArchive.Status.ApplyingPortraits");
    await feRunArchiveChunkedPass(win, postPassNodes, (batch) => feRefreshPortraitsForLog(logEl, renderProfile, { nodes: batch }));
  }

  try {
    feNormalizeArchiveShellLayout(win.document);
    feNormalizeArchiveMessageLayout(logEl);
  } catch {}

  // Must run BEFORE the snapshot/print steps: it turns empty <dnd5e-icon> custom
  // elements into real inline <svg>. Awaited (a handful of same-origin fetches,
  // cached by src) so the icons exist for both the popup paint and the serializer.
  if (metaEl) metaEl.textContent = feLocalize("FE.ChatArchive.Status.InliningIcons");
  await feInlineDnd5eIcons(logEl, win.document);

  try {
    feFireArchiveRenderUpdated(win.document, logEl);
  } catch {}

  // Popup/print output needs decoded assets before it becomes interactive.
  // The Electron HTML path instead builds a serialized snapshot immediately;
  // that path independently fetches and embeds assets where configured, so
  // waiting here only wastes time and raises its peak decoded-image memory.
  if (waitForAssets) {
    if (metaEl) metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? feLocalize("FE.ChatArchive.Status.LoadingVisibleImages") : feLocalize("FE.ChatArchive.Status.LoadingImages");
    const imgTimeout = await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
    if (imgTimeout > 0) console.warn(feFormat("FE.Diagnostics.ChatArchive.feRenderChatArchiveWindow4", { imgTimeout: imgTimeout }));

    if (metaEl) metaEl.textContent = feLocalize("FE.ChatArchive.Status.LoadingFonts");
    // Inject the self-contained data: URL faces into the popup BEFORE waiting, so the
    // print/PDF path never depends on the popup resolving Foundry's @import-based
    // module stylesheets. The popup is an about:blank document whose <style>@import
    // "modules/…/ui-font.css"> resolves through <base href> unreliably; when it loses
    // the race, feWaitForFonts finds no registered @font-face and print captures with
    // NO custom font ("PDF 폰트 미적용" bug). The embedded CSS carries the same faces as
    // data: URLs (no network, no @import) and correctly routes BOTH the CookieRun and
    // Geurimilgi vars, so the mixed preset renders in full. Done at render time (not at
    // print) so fonts settle well before win.print() — avoids a mid-reflow capture.
    await feEnsureArchiveEmbeddedFonts(win);
    await feWaitForFonts(win.document, FE_EXPORT_WAIT_FONTS_TIMEOUT);
  }

  if (metaEl) metaEl.textContent = metaText;
  try {
    if (statusEl) statusEl.hidden = true;
  } catch {
    /* no-op */
  }

  // Screen-only optimization starts after all full-document render passes finish.
  // The desktop snapshot path skips it, since it immediately serializes output.
  if (waitForAssets) {
    const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
    try { feEnableArchiveScreenContainment(win.document); }
    finally { restoreStickyScroll(); }
  }

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
      void win.document.body.offsetHeight;
    } catch {}
    await feRunArchiveDocumentOperation(win.document, () => feArchivePrint(win));
  }
}


// ===========================================================================
// Button Injection & Hooks
// ===========================================================================

let feInjectExportButtonsTimer = null;
function feScheduleInjectExportButtons(delay = 0) {
  try {
    if (feInjectExportButtonsTimer) clearTimeout(feInjectExportButtonsTimer);
    feInjectExportButtonsTimer = setTimeout(() => {
      feInjectExportButtonsTimer = null;
      try { feInjectExportButtonsAll(); } catch (err) { console.warn(feLocalize("FE.Diagnostics.ChatArchive.feScheduleInjectExportButtons"), err); }
    }, Math.max(0, Number(delay) || 0));
  } catch {}
}

Hooks.once("ready", () => {
  try {
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.warn"), err);
  }
});

// FVTT v13 reparents the shared chat input/controls outside the normal ChatLog render flow.
// Re-inject the export control whenever that input block is adopted so the archive button
// survives sidebar toggles, notifications, and popout transitions.
Hooks.on("renderChatInput", () => {
  try {
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.warn2"), err);
  }
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
  try {
    const reason = payload?.reason ?? null;
    if (reason !== "ready" && reason !== "renderChatLog" && reason !== "export-settings") return;
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.warn3"), err);
  }
});
