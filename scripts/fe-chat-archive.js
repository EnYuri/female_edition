// Chat archive + HTML/PDF export (split)
// Kept in its own module so export-only logic can be isolated.

import {
  MODULE_ID,
  S,
  feSetting,
  feFireChatUiUpdated,
  feGetChatLogs,
  feApplyStyleVarsFromSettings,
  feStripChatTexturesInWindow,
  feApplyRenderedStateToMessageElement,
  feApplyRenderedStateToLog,
  feSetChatCardFontClass,
  feSetChatFontChoiceClass,
  feSetUiFontClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,
  feSetChatGroupOutlineClass,
  feSetRetroThemeClass,
  feSetNeodgmModeClass,
  feSetSystemMsgColorClass,
  feSetAccentTextOverrideClass,
  feApplyChatMerge,
  feGetMessageIdFromElement,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feEscapeHTML,
} from "./fe-chat-enhance.js";

// Chat portrait: ensure exported/archive-rendered messages receive the same portrait injection.
import {
  feChatPortraitUpsert,
  feChatPortraitApplyVars,
} from "./fe-chat-portrait.js";

// Image processing: canvas downscale, background freeze, blob → data-URL.
import {
  feBlobToDataURL,
  feFreezeMessageBackgroundsForPrint,
  feDownscaleImagesForPrint,
} from "./fe-archive-image.js";

// ===========================================================================
// Constants
// ===========================================================================

const FE_EXPORT_RENDER_BATCH = 64;
const FE_EXPORT_RENDER_CONCURRENCY = 6;
const FE_EXPORT_STATUS_EVERY = 25;
const FE_EXPORT_WAIT_IMAGES_MAX = 800;
const FE_EXPORT_WAIT_IMAGES_TIMEOUT = 20000;
const FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT = 15000;
const FE_EXPORT_WAIT_FONTS_TIMEOUT = 12000;
const FE_EXPORT_PORTRAIT_MARKER_SELECTOR = 'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container';
const FE_ARCHIVE_LARGE_LOG_THRESHOLD = 1200;
const FE_ARCHIVE_HUGE_LOG_THRESHOLD = 2600;
const FE_EXPORT_RENDER_BATCH_LARGE = 40;
const FE_EXPORT_RENDER_BATCH_HUGE = 24;
const FE_EXPORT_RENDER_CONCURRENCY_LARGE = 4;
const FE_EXPORT_RENDER_CONCURRENCY_HUGE = 2;
const FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE = 40;
const FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE = 16;
const FE_ARCHIVE_DUPLICATE_IMAGE_KEEP = 1;
const FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT = 4500;
const FE_ARCHIVE_HARVEST_TIMEOUT_LARGE = 2500;
const FE_ARCHIVE_HARVEST_TIMEOUT_HUGE = 1200;
let feEmbeddedFontCssPromise = null;
let feEmbeddedFontCssValue = null;

function feSanitizeExportFilename(name, fallback = "chat-log") {
  return (
    String(name || "")
      .replaceAll(/[^a-zA-Z0-9ㄱ-힝\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || fallback
  );
}

// ===========================================================================
// Range Selection Dialog
// ===========================================================================

// Asks the user which message index range to archive.
// Returns { mode: "all"|"range", from, to } or null if cancelled.
// from/to are 1-based indices (inclusive).
async function feShowArchiveRangeDialog(totalCount = 0) {
  try {
    const content = `
<div style="display:flex;flex-direction:column;gap:12px;padding:4px 0;">
  <p style="margin:0;font-size:0.95em;">
    총 메시지 수: <strong>${totalCount.toLocaleString()}개</strong>
  </p>
  <div style="display:flex;flex-direction:column;gap:8px;">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="radio" name="fe-range-mode" value="all" checked style="margin:0;">
      전체 저장
    </label>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="radio" name="fe-range-mode" value="range" style="margin:0;">
      범위 지정:
      <input type="number" id="fe-range-from" value="1" min="1" max="${totalCount || 99999}"
        style="width:80px;margin:0 4px;text-align:right;"> 번째
      ~
      <input type="number" id="fe-range-to" value="${totalCount || 99999}" min="1" max="${totalCount || 99999}"
        style="width:80px;margin:0 4px;text-align:right;"> 번째
    </label>
  </div>
  <p style="margin:0;font-size:0.82em;color:var(--color-text-secondary,#888);">
    메시지는 오래된 순서로 번호가 매겨집니다. (1 = 가장 오래된 메시지)
  </p>
</div>`;

    return await foundry.applications.api.DialogV2.prompt({
      window: { title: "채팅 아카이브 — 범위 선택" },
      content,
      ok: {
        label: "저장 시작",
        callback: (event, button, dialog) => {
          const form = button.form ?? dialog.element.querySelector("form") ?? dialog.element;
          const mode = form.querySelector?.("input[name='fe-range-mode']:checked")?.value ?? "all";
          const from = Math.max(1, parseInt(form.querySelector?.("#fe-range-from")?.value ?? "1", 10) || 1);
          const to = Math.max(from, parseInt(form.querySelector?.("#fe-range-to")?.value ?? String(totalCount), 10) || totalCount);
          return { mode, from, to };
        },
      },
      rejectClose: false,
      render: (event, dialog) => {
        try {
          const el = dialog.element;
          // Clicking either number input switches to range mode
          ["#fe-range-from", "#fe-range-to"].forEach((sel) => {
            const inp = el.querySelector(sel);
            if (inp) inp.addEventListener("focus", () => {
              const r = el.querySelector("input[value='range']");
              if (r) r.checked = true;
            });
          });
        } catch {
          /* no-op */
        }
      },
    });
  } catch {
    return null;
  }
}

// Apply a range spec returned by feShowArchiveRangeDialog to a sorted items array.
// items: array of { msg, id, liveEl, key } sorted oldest-first.
// from/to are 1-based inclusive indices.
function feApplyMessageRange(items, rangeSpec) {
  try {
    if (!rangeSpec || rangeSpec.mode === "all" || !Array.isArray(items)) return items;

    if (rangeSpec.mode === "range") {
      const from = Math.max(1, Number(rangeSpec.from) || 1);
      const to = Math.min(items.length, Math.max(from, Number(rangeSpec.to) || items.length));
      return items.slice(from - 1, to); // convert to 0-based
    }
  } catch {
    /* no-op */
  }
  return items;
}

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
    mirrorCardTree: !large,
    normalizeImageLoading: large ? "lazy" : "eager",
    normalizeImageDecoding: large ? "async" : "sync",
    deferPortraits: true,
    restoreOriginalPortraitSources: true,
    collapseDuplicateImages: true,
    collapseDuplicateImagesAggressive: large,
    bodyClass: huge ? " fe-archive-huge fe-archive-lean" : large ? " fe-archive-lean" : "",
    statusLabel: large ? "메모리 절약 모드" : "",
  };
}

// ===========================================================================
// Export Entry Points  (button injection, PDF popup, inline print)
// ===========================================================================

function _feCreateExportAnchor() {
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

  body.game.fe-print-chatlog #fe-chat-export-log .chat-message :is(.message-header, .message-sender) {
    break-inside: avoid;
    page-break-inside: avoid;
    break-after: avoid;
    page-break-after: avoid;
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
  // Step 1: Collect messages BEFORE opening the popup window,
  // so the range dialog appears on its own without the archive window behind it.
  let preCollectedMessages = null;
  let preRangeSpec = null;
  try {
    const liveMessageMap = feBuildLiveChatMessageElementMap();
    ui.notifications?.info("female_edition | 메시지 수집 중…", { permanent: false, console: false });
    preCollectedMessages = await feCollectVisibleChatMessages(game.user, { liveMessageMap });

    if (!preCollectedMessages.length) {
      ui.notifications?.warn("female_edition | 아카이브할 메시지가 없습니다.");
      return;
    }

    // Step 2: Show range dialog before opening the popup.
    preRangeSpec = await feShowArchiveRangeDialog(preCollectedMessages.length);
    if (preRangeSpec == null) return; // cancelled
  } catch (err) {
    console.warn("female_edition | pre-collection failed, falling through", err);
    preCollectedMessages = null;
    preRangeSpec = null;
  }

  // Step 3a: Desktop (Electron) app — window.open popups are blocked and
  // window.print() invokes the OS print dialog (Microsoft Print to PDF → slow,
  // 0 KB files). Render offscreen and hand off to the system browser for a real
  // "Save as PDF". Skipped only when the user explicitly set the desktop-external
  // mode to "off" (opting back into the legacy in-app print path below).
  if (feIsElectron() && String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off") !== "off") {
    const done = await feExportChatLogViaDesktopBrowser({ preCollectedMessages, preRangeSpec });
    if (done) return;
    // Fell through (frame/render failed) — try the legacy popup/inline path.
  }

  // Step 3: Now open the archive popup window.
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
        preCollectedMessages,
        preRangeSpec,
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

// ---------------------------------------------------------------------------
// Export — Inline fallback (print from current document)
// ---------------------------------------------------------------------------

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
    const messages = await feCollectVisibleChatMessages(game.user, {
      liveMessageMap,
      progress: (text) => {
        try { if (metaEl) metaEl.textContent = text; } catch {}
      },
    });
    const renderProfile = feGetArchiveRenderProfile(messages.length);

    // Header/meta
    const worldName = game.world?.title ?? game.world?.name ?? "";
    const sceneName = canvas?.scene?.name ?? "";
    titleEl.textContent = worldName ? `Chat Log – ${worldName}` : "Chat Log";
    metaEl.textContent = `${messages.length} messages${sceneName ? ` • ${sceneName}` : ""}`;

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

    try { feNormalizeArchiveShellLayout(document); } catch {}

    // Apply merge styling to export log (our mutation observer is scoped to #sidebar)
    if (feSetting(S.MERGE_ENABLED)) {
      feSyncArchiveMergeBodyClasses(document);
      feApplyChatMerge(logEl, feArchiveMergeOptions());
      feRefreshPortraitsForLog(logEl);
    } else if (renderProfile.deferPortraits) {
      feRefreshPortraitsForLog(logEl);
    }

    try {
      feFireArchiveRenderUpdated(document, logEl);
    } catch {}

    // Wait for images (portraits, item icons) to load so they actually print
    metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
    const inlineImgTimeout = await feWaitForImages(logEl, FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
    if (inlineImgTimeout > 0) console.warn(`female_edition | inline export: ${inlineImgTimeout} image(s) did not load within timeout`);

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

    metaEl.textContent = "Opening print dialog…";

    try {
      restorePageBreaks = fePrepareImagesForPageBreaks(document, logEl);
    } catch (err) {
      console.warn("female_edition | inline page-break image preparation failed", err);
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
    ui.notifications?.error("Chat log PDF export failed. Check the console for details.");
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
      ui.notifications?.warn("채팅 아카이브 팝업이 차단됐습니다. 브라우저 팝업 차단을 해제해 주세요.");
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
// The Foundry desktop app blocks window.open popups (feOpenChatArchiveWindow
// returns null), and window.print() there invokes the OS print dialog
// ("Microsoft Print to PDF" → very slow, produces 0 KB files) instead of a
// browser-style "Save as PDF". Instead we render the archive into a hidden,
// same-origin <iframe> — a full document just like a popup, so the entire
// existing render pipeline (feRenderChatArchiveWindow) is reused unchanged —
// then hand the result to the system browser, where the user gets the real
// print → "PDF로 저장" they expect.
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

async function feExportChatLogViaDesktopBrowser({ preCollectedMessages = null, preRangeSpec = null } = {}) {
  const optimize = !!feSetting(S.EXPORT_OPTIMIZE);
  const worldName = game.world?.title || game.world?.name || "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

  const iframe = feCreateHiddenArchiveFrame();
  const win = iframe.contentWindow;
  if (!win) {
    try { iframe.remove(); } catch {}
    return false;
  }

  try {
    ui.notifications?.info("female_edition | 아카이브 생성 중… 완료되면 시스템 브라우저에서 열립니다.", { console: false });

    await feRenderChatArchiveWindow(win, {
      autoPrint: false,
      optimize,
      preCollectedMessages,
      preRangeSpec,
    });

    // Open in the system browser (real "PDF로 저장"). force:true bypasses the
    // desktop-external mode gate — this path only runs when the caller already
    // decided desktop external handoff is wanted.
    const opened = await feOpenArchiveInExternalBrowser(win, titleText, { force: true });
    if (!opened) {
      // Shell access unavailable (or open failed): save the HTML directly so the
      // user can open it in a browser manually and print → PDF from there.
      await feDownloadArchiveHTML(win, titleText);
      ui.notifications?.info("female_edition | 외부 브라우저를 열 수 없어 HTML로 저장했습니다. 브라우저로 열어 PDF로 저장하세요.", { console: false });
    }
    return true;
  } catch (err) {
    console.warn("female_edition | desktop browser export failed", err);
    return false;
  } finally {
    // The temp file is already fully written before shell.openPath resolves, so
    // the frame can go now; a short delay is just belt-and-suspenders.
    setTimeout(() => { try { iframe.remove(); } catch {} }, 2000);
  }
}

// ===========================================================================
// Archive Document Setup  (head styles, base href, body classes, chrome sync)
// ===========================================================================

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

            // Preserve disabled stylesheet state in a *serialized* form.
            // HTMLLinkElement.disabled is not reliably reflected by outerHTML, so use
            // media="not all" + a data marker that the archive window can later inspect.
            const disabled = !!n.disabled;
            if (disabled) {
              c.setAttribute("data-fe-disabled-link", "1");
              c.setAttribute("media", "not all");
            }

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

function feSyncArchiveDocumentChrome(doc) {
  try {
    if (!doc?.documentElement) return;
    const srcHtml = document.documentElement;
    const dstHtml = doc.documentElement;

    if (srcHtml?.className != null) dstHtml.className = srcHtml.className;
    const htmlStyle = srcHtml?.getAttribute?.("style");
    if (htmlStyle) dstHtml.setAttribute("style", htmlStyle);
    else dstHtml.removeAttribute?.("style");

    for (const attr of Array.from(srcHtml?.attributes ?? [])) {
      const name = String(attr?.name ?? "");
      if (!name || name === "class" || name === "style") continue;
      if (name === "lang" || name === "dir" || name.startsWith("data-") || name.startsWith("aria-")) {
        dstHtml.setAttribute(name, String(attr?.value ?? ""));
      }
    }

    const srcBody = document.body;
    const dstBody = doc.body;
    if (srcBody && dstBody) {
      for (const attr of Array.from(srcBody.attributes ?? [])) {
        const name = String(attr?.name ?? "");
        if (!name || name === "class") continue;
        if (name === "style" || name.startsWith("data-") || name.startsWith("aria-")) {
          dstBody.setAttribute(name, String(attr?.value ?? ""));
        }
      }
    }
  } catch {
    /* no-op */
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
      enableFonts = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
    } catch {
      enableFonts = true;
    }

    const needleAbs = `/modules/${MODULE_ID}/styles/ui-font.css`;
    const needleRel = `modules/${MODULE_ID}/styles/ui-font.css`;

    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const l of links) {
      try {
        // Generic disabled-state replay for cloned head links.
        if (l.getAttribute?.("data-fe-disabled-link") === "1") {
          l.disabled = true;
          l.setAttribute("media", "not all");
        }

        const hrefAttr = l.getAttribute("href") || "";
        const hrefAbs = l.href || "";
        const match =
          hrefAttr.includes(needleAbs) ||
          hrefAbs.includes(needleAbs) ||
          hrefAttr.includes(needleRel) ||
          hrefAbs.includes(needleRel);
        if (!match) continue;

        if (enableFonts) {
          l.disabled = false;
          if (l.getAttribute("media") === "not all") l.removeAttribute("media");
          l.removeAttribute?.("data-fe-disabled-link");
        } else {
          l.disabled = true;
          l.setAttribute("media", "not all");
          l.setAttribute("data-fe-disabled-link", "1");
        }
      } catch {
        /* no-op */
      }
    }

    // Mirror body class toggles used by stylesheet-driven chat UI features.
    // fe-fonts-enabled gates all font rules in ui-font.css — must be synced here.
    doc.body?.classList?.toggle?.("fe-fonts-enabled", enableFonts);
    try {
      const hidePortraits = !!game.settings.get(MODULE_ID, S.UI_HIDE_PORTRAITS);
      doc.body?.classList?.toggle?.("fe-hide-portraits", hidePortraits);
    } catch {
      /* no-op */
    }
    try {
      const stripTextures = !!game.settings.get(MODULE_ID, S.UI_STRIP_TEXTURES);
      doc.body?.classList?.toggle?.("fe-strip-chat-textures", stripTextures);
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
    const mode = String(feSetting(S.MERGE_MODE) ?? "standard");
    doc?.body?.classList?.toggle?.("fe-chat-merge", enabled);
    doc?.body?.classList?.toggle?.("fe-merge-mode-standard", enabled && mode === "standard");
    doc?.body?.classList?.toggle?.("fe-merge-mode-simple", enabled && mode === "simple");
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
      const msg = (id ? game.messages?.get(id) : null) || el.__feMessage || null;
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

// ===========================================================================
// String & DOM Utilities  (escape, coerce, stamp, identity)
// ===========================================================================

function feEscapeAttr(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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

async function feTryFoundryRenderMessage(msg) {
  try {
    if (!msg) return null;

    if (typeof msg?.renderHTML === "function") {
      const rendered = await msg.renderHTML();
      if (feIsElement(rendered)) return feCoerceChatMessageElement(rendered);
      if (typeof rendered === "string") {
        const shell = document.createElement("template");
        shell.innerHTML = rendered.trim();
        const el = shell.content.firstElementChild;
        if (feIsElement(el)) return feCoerceChatMessageElement(el);
      }
    }
  } catch {
    /* fall through */
  }

  try {
    const renderFn =
      ui?.chat?.constructor?.renderMessage ||
      foundry?.applications?.sidebar?.tabs?.ChatLog?.renderMessage ||
      globalThis?.ChatLog?.renderMessage;
    if (typeof renderFn !== "function") return null;
    const rendered = await renderFn.call(ui?.chat?.constructor || null, msg, {});
    return feCoerceChatMessageElement(rendered);
  } catch {
    return null;
  }
}



// ===========================================================================
// Message Collection & Filtering
// ===========================================================================

async function feFetchAllChatMessagesFromDatabase() {
  try {
    const docClass = game?.messages?.documentClass || CONFIG?.ChatMessage?.documentClass || foundry?.documents?.ChatMessage || globalThis.ChatMessage?.implementation || globalThis.ChatMessage;
    const backend = docClass?.database;
    if (!docClass || !backend?.get) return [];
    // v13 changed the third argument of ClientBackend.get() from a User document
    // to a plain context object { userId: string }. Passing the User object directly
    // caused context.id to be undefined in v13's permission checks, leading to
    // silent message filtering / empty archive results.
    // Build the context object that works for both v12 (accepts User) and v13 (wants { userId }).
    const userId = game?.user?.id ?? null;
    const backendContext = userId ? { userId } : (game?.user ?? {});
    const rows = await backend.get(docClass, { query: {}, sort: { timestamp: 1 } }, backendContext);
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      if (!row) return null;
      if (typeof row.getFlag === "function" || row.documentName === "ChatMessage") return row;
      try {
        return docClass.fromSource ? docClass.fromSource(row) : new docClass(row, {});
      } catch {
        try { return new docClass(row, {}); } catch { return null; }
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function feCollectVisibleChatMessages(user = game.user, { liveMessageMap = null, progress = null } = {}) {
  const liveMap = liveMessageMap instanceof Map ? liveMessageMap : feBuildLiveChatMessageElementMap();
  const report = (text) => {
    try {
      if (typeof progress === "function") progress(String(text ?? ""));
    } catch {
      /* no-op */
    }
  };

  report("메시지 수집 중…");

  let all = Array.from(game.messages?.contents ?? []);
  // Archive/export should prefer the fullest document source available.
  // Some worlds/clients may only have the most recent chat page hydrated in memory,
  // so always probe the backend and keep whichever source is longer.
  try {
    report("메시지 DB 확인 중…");
    const dbAll = await feFetchAllChatMessagesFromDatabase();
    if (dbAll.length > all.length) {
      all = dbAll;
    } else if (dbAll.length === 0 && all.length > 0) {
      console.warn("female_edition | archive: DB query returned 0 messages — falling back to in-memory messages. Some older messages may be missing.");
    }
  } catch (err) {
    console.warn("female_edition | archive: DB query failed — falling back to in-memory messages. Some older messages may be missing.", err);
  }

  const collectProfile = feGetArchiveRenderProfile(all.length);

  // As a final best-effort fallback, harvest any live DOM-only history that has been
  // paged in by ChatLog.renderBatch so the archive can still preserve older messages.
  // IMPORTANT: this is a fidelity enhancement only. Do not let it block the archive UI
  // forever; large worlds should prefer completion over perfect DOM clones.
  let harvested = null;
  const needsHarvest = all.length > liveMap.size && liveMap.size > 0 && !collectProfile.lean;
  if (needsHarvest) {
    try {
      const timeBudgetMs = collectProfile.huge
        ? FE_ARCHIVE_HARVEST_TIMEOUT_HUGE
        : collectProfile.large
          ? FE_ARCHIVE_HARVEST_TIMEOUT_LARGE
          : FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT;
      const maxIterations = collectProfile.huge ? 4 : collectProfile.large ? 6 : 10;
      report(`이전 채팅 보강 중… ${Math.min(liveMap.size, all.length)}/${all.length}`);
      harvested = await feHarvestFullChatHistory({
        batchSize: collectProfile.large ? 80 : 100,
        maxIterations,
        timeBudgetMs,
        progress: ({ collected = 0, total = all.length, timedOut = false } = {}) => {
          const suffix = timedOut ? " (시간 제한 도달)" : "";
          report(`이전 채팅 보강 중… ${Math.min(collected, total)}/${total}${suffix}`);
        },
      });
      if (harvested?.cloneMap?.size) {
        for (const [id, el] of harvested.cloneMap.entries()) {
          if (!liveMap.has(id)) liveMap.set(id, el);
        }
        // Release the harvest-side references — the clones now live in liveMap only.
        // Without this, both maps pin the same nodes and they can't be GC'd as render
        // progressively drops them from liveMap.
        harvested.cloneMap.clear();
      }
    } catch {
      harvested = null;
    }
  }

  report("메시지 정렬 중…");

  const visibleDocs = all
    .filter((m) => feCanUserSeeChatMessage(m, user))
    .sort((a, b) => {
      const ao = Number(a?.sort ?? a?.timestamp ?? 0);
      const bo = Number(b?.sort ?? b?.timestamp ?? 0);
      if (ao !== bo) return ao - bo;
      return String(a?.id ?? a?._id ?? '').localeCompare(String(b?.id ?? b?._id ?? ''));
    });

  const items = visibleDocs.map((m) => {
    const id = String(m?.id ?? m?._id ?? '');
    return {
      key: id || `__msg__${Math.random()}`,
      id,
      msg: m,
      liveEl: id ? (liveMap.get(id) || null) : null,
    };
  });

  if (!items.length && harvested?.orderedIds?.length) {
    const out = harvested.orderedIds.map((id, idx) => ({
      key: id || `__harvest__${idx}`,
      id,
      msg: null,
      liveEl: id ? (liveMap.get(id) || null) : null,
    })).filter((it) => it.liveEl);
    report(`메시지 ${out.length}개 준비 완료`);
    return out;
  }

  report(`메시지 ${items.length}개 준비 완료`);
  return items;
}

// ===========================================================================
// Message State & Normalization  (portrait, empty-check, special-state, root cleanup)
// ===========================================================================

function feHasPortraitMarkup(rootEl) {
  try {
    return !!rootEl?.querySelector?.(FE_EXPORT_PORTRAIT_MARKER_SELECTOR);
  } catch {
    return false;
  }
}

function feArchiveMessageContentLooksEmpty(node) {
  try {
    const content = node?.querySelector?.(':scope > .message-content');
    if (!content) return true;
    if (content.querySelector?.('.round-marker, img, video, audio, canvas, svg, table, iframe, .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dice-roll, .dice-result, blockquote, pre, hr, ul, ol')) {
      return false;
    }
    const text = String(content.textContent ?? '').replace(/ /g, ' ').trim();
    return !text;
  } catch {
    return false;
  }
}

function feExpandCollapsedArchiveSections(node) {
  try {
    if (!feIsElement(node)) return;
    for (const el of node.querySelectorAll?.(".collapsible.collapsed") ?? []) {
      try { el.classList.remove("collapsed"); } catch {}
    }
  } catch {}
}

function feFinalizeArchiveSpecialMessageState(node, msg, liveEl = null) {
  try {
    if (!feIsElement(node)) return;

    const isNarrator = !!(
      feIsNarratorToolsMessage(msg, node) ||
      liveEl?.classList?.contains?.('narrator-chat') ||
      liveEl?.classList?.contains?.('fe-narrator-chat')
    );

    const isRoundMarker = !!(
      feIsRoundMarkerMessage(msg, node) ||
      liveEl?.classList?.contains?.('round-marker') ||
      liveEl?.classList?.contains?.('fe-round-marker-chat') ||
      liveEl?.dataset?.feIsRoundMarker === '1' ||
      liveEl?.querySelector?.('.round-marker')
    );

    node.classList.toggle('narrator-chat', isNarrator);
    node.classList.toggle('fe-narrator-chat', isNarrator);
    node.classList.toggle('round-marker', isRoundMarker);
    node.classList.toggle('fe-round-marker-chat', isRoundMarker);

    if (isRoundMarker) {
      node.dataset.feIsRoundMarker = '1';
      node.setAttribute?.('data-fe-is-round-marker', '1');
    } else {
      delete node.dataset.feIsRoundMarker;
      node.removeAttribute?.('data-fe-is-round-marker');
    }

    if (isNarrator || isRoundMarker) {
      node.classList.remove('fe-has-user-color');
      node.style?.removeProperty?.('--fe-user-color-rgb');
    }

    if (!isRoundMarker) {
      node.classList.remove('fe-round-marker-empty-content');
      return;
    }

    const header = node.querySelector?.(':scope > .message-header');
    const sender = header?.querySelector?.('.message-sender');
    const metadata = header?.querySelector?.('.message-metadata');
    const portrait = header?.querySelector?.('img.fe-chat-portrait, .fe-chat-portrait-wrap');
    try { sender?.style?.setProperty?.('display', 'none', 'important'); } catch {}
    try { metadata?.style?.setProperty?.('display', 'none', 'important'); } catch {}
    try { portrait?.style?.setProperty?.('display', 'none', 'important'); } catch {}

    node.classList.toggle('fe-round-marker-empty-content', feArchiveMessageContentLooksEmpty(node));
  } catch {
    /* no-op */
  }
}

function feNormalizeArchiveMessageRoot(targetDoc, node) {
  try {
    if (!feIsElement(node)) return null;
    if (node.matches?.("li.chat-message")) return node;

    // Notification tray roots in FVTT v13 can be .message instead of li.chat-message.
    // Normalize them to the archive's expected list-item structure.
    const wrapper = targetDoc?.createElement?.("li") || document.createElement("li");
    const classNames = new Set(["chat-message", "message"]);
    for (const cls of Array.from(node.classList ?? [])) classNames.add(cls);
    wrapper.className = Array.from(classNames).join(" ");

    for (const attr of Array.from(node.attributes ?? [])) {
      const name = String(attr?.name ?? "");
      if (!name || name === "class") continue;
      wrapper.setAttribute(name, String(attr?.value ?? ""));
    }

    // Notification tray messages intentionally opt out of FE's visual merge.
    // If we use them as a fidelity fallback for export, start from a clean state and let
    // the archive log compute its own merge classes later.
    for (const cls of ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"]) {
      wrapper.classList.remove(cls);
    }
    wrapper.removeAttribute?.("data-fe-merge-sig");

    while (node.firstChild) wrapper.appendChild(node.firstChild);
    return wrapper;
  } catch {
    return node;
  }
}

function feFireArchiveRenderUpdated(targetDoc, logEl) {
  try {
    feFireChatUiUpdated({
      reason: "archive-render",
      root: logEl,
      log: logEl,
      document: targetDoc,
    });
  } catch {
    /* no-op */
  }
}

// ===========================================================================
// Image Registry & Deduplication
// ===========================================================================

function feArchiveGetImageSourceKey(img, baseHref = null) {
  try {
    const raw = img?.getAttribute?.("src") || img?.currentSrc || img?.src || "";
    if (!raw) return "";
    if (/^(?:data:|blob:)/i.test(raw)) return raw;
    return new URL(raw, baseHref || img?.ownerDocument?.baseURI || document.baseURI).href;
  } catch {
    return String(img?.getAttribute?.("src") || img?.currentSrc || img?.src || "");
  }
}

function feArchiveIsProtectedImage(img) {
  try {
    if (!img) return true;
    // dnd5e item card header icons only — small UI ornaments inside card frames.
    // Avatars, portraits, and small images are no longer protected: A-1/A-2
    // dedup now handles them across messages and small icons benefit the most
    // from collapsing.
    if (img.closest?.('.chat-card .card-header, .midi-chat-card .card-header, .dnd5e.chat-card .card-header, .dnd5e2.chat-card .card-header')) return true;
  } catch {
    /* no-op */
  }
  return false;
}

function feArchiveShouldCollapseDuplicateImage(img, renderProfile = null) {
  try {
    if (!renderProfile?.collapseDuplicateImages) return false;
    const src = feArchiveGetImageSourceKey(img);
    if (!src || /^(?:data:|blob:)/i.test(src)) return false;
    if (feArchiveIsProtectedImage(img)) return false;
    if (renderProfile?.collapseDuplicateImagesAggressive) return true;
    if (img.classList?.contains("ci-message-image")) return true;
    if (img.closest?.('.chat-images-container, .ci-message-image, .message-content, figure, .editor-content')) return true;
    return false;
  } catch {
    return false;
  }
}


function fePrepareArchiveSharedImage(img, src, occurrence = 2) {
  try {
    if (!img || !src) return;
    img.classList?.add?.("fe-archive-shared-image");
    img.dataset.feArchiveSharedImage = "1";
    img.dataset.feArchiveSharedSrc = src;
    img.dataset.feArchiveSharedOccurrence = String(Math.max(2, Number(occurrence) || 2));
    img.setAttribute("src", src);
    img.removeAttribute("srcset");
    if (!img.getAttribute("loading")) img.setAttribute("loading", "lazy");
    if (!img.getAttribute("decoding")) img.setAttribute("decoding", "async");

    const label = String(img.getAttribute("title") || img.getAttribute("alt") || "").trim();
    const suffix = occurrence > 1 ? ` (shared ×${occurrence})` : "";
    if (label) img.setAttribute("title", `${label}${suffix}`);
    else img.setAttribute("title", `shared image${suffix}`);
  } catch {
    /* no-op */
  }
}

function feOptimizeArchiveNodeImages(rootEl, { targetDoc = document, renderProfile = null, imageRegistry = null } = {}) {
  try {
    if (!imageRegistry || !renderProfile?.collapseDuplicateImages || !rootEl?.querySelectorAll) return 0;
    let collapsed = 0;
    const imgs = Array.from(rootEl.querySelectorAll('img[src]'));
    for (const img of imgs) {
      if (!feArchiveShouldCollapseDuplicateImage(img, renderProfile)) continue;
      const srcKey = feArchiveGetImageSourceKey(img, targetDoc?.baseURI || rootEl?.ownerDocument?.baseURI || document.baseURI);
      if (!srcKey || /^(?:data:|blob:)/i.test(srcKey)) continue;

      const entry = imageRegistry.get(srcKey) ?? { count: 0 };
      entry.count += 1;
      imageRegistry.set(srcKey, entry);
      if (entry.count <= FE_ARCHIVE_DUPLICATE_IMAGE_KEEP) continue;

      try {
        fePrepareArchiveSharedImage(img, srcKey, entry.count);
        collapsed += 1;
      } catch {
        /* no-op */
      }
    }
    return collapsed;
  } catch {
    return 0;
  }
}

// ===========================================================================
// Message Rendering Pipeline  (batch render, live-clone, system render, fallback)
// ===========================================================================

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
  const imageRegistry = renderProfile?.collapseDuplicateImages ? new Map() : null;
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

  const renderOne = async (item) => {
    const msg = item?.msg ?? null;
    const explicitLive = item?.liveEl ?? null;
    const msgId = String(item?.id ?? msg?.id ?? msg?._id ?? "");
    const liveEl = explicitLive || (msgId && typeof liveMessageMap?.get === "function" ? liveMessageMap.get(msgId) : null) || null;
    const node = await feRenderExportMessageNode(targetDoc, msg, { liveEl, renderProfile });
    if (!feIsElement(node)) return null;

    if (annotateExportMessage) node.classList.add("fe-export-message");

    feNormalizeExportNode(node, {
      loading: renderProfile?.normalizeImageLoading,
      decoding: renderProfile?.normalizeImageDecoding,
    });
    if (msg) feApplyRenderedStateToMessageElement(msg, node);

    if (!deferPortraits) {
      try {
        if (msg && !feHasPortraitMarkup(node)) feChatPortraitUpsert(msg, node);
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
      const item = slice[i];
      const itemId = String(item?.id ?? item?.msg?.id ?? item?.msg?._id ?? "");
      if (feIsElement(node)) {
        feOptimizeArchiveNodeImages(node, { targetDoc, renderProfile, imageRegistry });
        frag.appendChild(node);
        fragCount += 1;
      }
      // Release the live element reference now — the imported clone in archive doc
      // no longer needs it. For harvested clones, this lets the original be GC'd
      // progressively instead of pinning the entire history until render completes.
      if (item) item.liveEl = null;
      if (itemId) liveMessageMap?.delete?.(itemId);
    }

    if (fragCount >= flushEvery) await flush();
  }

  if (fragCount) await flush();
  return renderedCount;
}

function feArchiveShouldPreferLiveClone(msg, liveEl = null, renderProfile = null) {
  try {
    if (!feIsElement(liveEl)) return false;
    if (!msg) return true;
    if (!renderProfile?.lean) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return true;

    const cl = liveEl.classList;
    if (
      cl?.contains?.("fe-has-chat-portrait") ||
      cl?.contains?.("fe-has-user-color") ||
      cl?.contains?.("narrator-chat") ||
      cl?.contains?.("fe-narrator-chat") ||
      cl?.contains?.("round-marker") ||
      cl?.contains?.("fe-round-marker-chat") ||
      cl?.contains?.("fe-merge-start") ||
      cl?.contains?.("fe-merge-mid") ||
      cl?.contains?.("fe-merge-end") ||
      cl?.contains?.("fe-merge-follow") ||
      cl?.contains?.("fe-divider-before")
    ) return true;

    if (liveEl.querySelector?.(FE_EXPORT_PORTRAIT_MARKER_SELECTOR)) return true;
    if (liveEl.querySelector?.('.message-content :is(img, video, blockquote, pre, code, table, ul, ol, hr)')) return true;
  } catch {
    /* no-op */
  }
  return false;
}

function feArchiveShouldTrySystemRender(msg, liveEl = null) {
  try {
    if (!msg) return false;
    if (feIsNarratorToolsMessage(msg, liveEl) || feIsRoundMarkerMessage(msg, liveEl)) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return true;
    return false;
  } catch {
    return false;
  }
}

async function feRenderExportMessageNode(targetDoc, msg, { liveEl = null, renderProfile = null } = {}) {
  let node = null;
  const shouldCloneLive = feArchiveShouldPreferLiveClone(msg, liveEl, renderProfile);
  try {
    if (shouldCloneLive && feIsElement(liveEl)) node = targetDoc.importNode(liveEl, true);
  } catch {
    node = null;
  }

  if (!feIsElement(node) && feArchiveShouldTrySystemRender(msg, liveEl)) {
    try {
      const rendered = await feTryFoundryRenderMessage(msg);
      if (feIsElement(rendered)) node = targetDoc.importNode(rendered, true);
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

  if (feIsElement(node) && shouldCloneLive && feIsElement(liveEl)) {
    try {
      feMirrorLiveMessageStyles(liveEl, node, { renderProfile });
    } catch {
      /* no-op */
    }
  }

  if (feIsElement(node)) {
    try {
      node = feNormalizeArchiveMessageRoot(targetDoc || document, node) || node;
      node.__feMessage = msg || node.__feMessage || null;
      feStampArchiveMessageIdentity(node, msg || { id: feGetMessageIdFromElement(liveEl) || undefined });
      feFinalizeArchiveSpecialMessageState(node, msg, liveEl);
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

  if (feIsElement(node)) {
    try {
      feExpandCollapsedArchiveSections(node);
    } catch {}
  }

  return feIsElement(node) ? node : null;
}

// ===========================================================================
// Platform Utilities  (filename sanitize, Electron detection, require shim)
// ===========================================================================

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

// ===========================================================================
// Archive Window — Main Render Loop
// Collects history, renders all messages into the popup document, wires
// export/print controls, and optionally triggers autoPrint.
// ===========================================================================

async function feRenderChatArchiveWindow(win, { autoPrint = false, optimize = false, preCollectedMessages = null, preRangeSpec = null } = {}) {
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

  const worldName = game.world?.title ?? game.world?.name ?? "";
  const sceneName = canvas?.scene?.name ?? "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

  // Build the archive document immediately so the popup is never left as a blank about:blank
  // while we collect older message history.
  const headStyles = feCollectHeadStylesHTML();
  const baseHref = feEscapeAttr(feGetFoundryBaseHref());

  // Desktop (Electron) can optionally open the archive in the system browser.
  const desktopExternalMode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  const showExternalBtn = feIsElectron() && desktopExternalMode !== "off";
  const externalBtnHTML = showExternalBtn
    ? `<a class="fe-chat-export-action fe-chat-export-external" id="fe-archive-external" data-tooltip="외부 브라우저로 열기">브라우저</a>`
    : "";

  // Print/PDF image handling (Chrome/Electron can freeze on image-heavy pages)
  const printImgMode = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "downscaleLite");
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
  const bodyClass = `${document.body.className ?? ""} fe-print-chatlog fe-chat-archive fe-chat-archive-window${effectiveOptimize ? " fe-export-optimized" : ""}${printImgClass}`;

  const feArchivePixelTheme = !!feSetting(S.UI_RETRO_THEME);
  const feArchiveBg = feArchivePixelTheme ? "#000000" : "#ffffff";

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
        background: ${feArchiveBg} !important;
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
        background: ${feArchiveBg} !important;
        border: 0 !important;
      }
      #fe-chat-export-container #fe-chat-export-chat {
        position: static !important;
        background: ${feArchiveBg} !important;
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
        background: ${feArchiveBg} !important;
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

      #fe-chat-export-status {
        margin: 0 0 10px 0;
        padding: 10px 12px;
        border: 1px solid rgba(0,0,0,0.18);
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.4;
        color: rgba(0,0,0,0.82);
        background: rgba(0,0,0,0.03);
      }

      #fe-chat-export-status[hidden] {
        display: none !important;
      }

      /* Expand all collapsed collapsible sections in the archive (dnd5e chat cards). */
      #fe-chat-export-log .collapsible.collapsed .collapsible-content {
        grid-template-rows: 1fr !important;
      }
      #fe-chat-export-log .chat-card .description.collapsed .details {
        grid-template-rows: 1fr !important;
        opacity: 1 !important;
      }
      #fe-chat-export-log .collapsible.collapsed > .fa-chevron-down,
      #fe-chat-export-log .collapsible.collapsed > * > .fa-chevron-down,
      #fe-chat-export-log .collapsible.collapsed .fa-caret-down {
        transform: none !important;
      }

      @media print {
        html, body {
          -webkit-print-color-adjust: exact !important;
          print-color-adjust: exact !important;
        }

        /* Speed: normalize blend modes — Chromium must composite each blend layer
         * when generating PDFs, which is the largest single source of slowness.
         * Normalizing to "normal" eliminates the compositor pass entirely.
         * background-blend-mode must also be reset: user-color tints use screen blend. */
        #fe-chat-export-log *,
        #fe-chat-export-log *::before,
        #fe-chat-export-log *::after {
          mix-blend-mode: normal !important;
          background-blend-mode: normal !important;
          isolation: auto !important;
          filter: none !important;
          -webkit-filter: none !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
        }

        /* Speed: disable transitions/animations so the PDF captures static state. */
        #fe-chat-export-log *,
        #fe-chat-export-log *::before,
        #fe-chat-export-log *::after {
          transition: none !important;
          animation: none !important;
        }

        /* Completeness: content wrappers inside collapsible sections must not clip. */
        #fe-chat-export-log .collapsible-content > .wrapper {
          overflow: visible !important;
        }

        /* Hide the toolbar when printing (save as PDF). */
        #fe-chat-export-container .fe-chat-export-toolbar { display: none !important; }

        /* Keep message headers together and attached to content. */
        #fe-chat-export-log .chat-message :is(.message-header, .message-sender) {
          break-inside: avoid;
          page-break-inside: avoid;
          break-after: avoid;
          page-break-after: avoid;
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
    ${feArchivePixelTheme ? `<style data-fe-pixel-archive="1">
      /* Pixel theme: inline fallback — guaranteed present regardless of <link> load order */
      html, body,
      #fe-chat-export-container,
      #fe-chat-export-sidebar,
      #fe-chat-export-chat,
      #fe-chat-export-log {
        background: #000000 !important;
        background-image: none !important;
        color: rgba(230,230,230,0.82) !important;
      }
      .fe-chat-export-status {
        background: #000000 !important;
        color: rgba(230,230,230,0.82) !important;
      }
      .fe-chat-export-action {
        background: #000000 !important;
        color: rgba(230,230,230,0.82) !important;
      }
      #fe-chat-export-log .chat-message {
        background: #000000 !important;
        background-color: #000000 !important;
        background-image: none !important;
        color: rgba(230,230,230,0.82) !important;
        border-color: rgba(255,255,255,0.7) !important;
      }
      #fe-chat-export-log .chat-message::before,
      #fe-chat-export-log .chat-message::after {
        background: transparent none !important;
        background-image: none !important;
      }
      #fe-chat-export-log .chat-message .message-header,
      #fe-chat-export-log .chat-message .message-content {
        background: transparent !important;
        background-image: none !important;
        color: rgba(230,230,230,0.82) !important;
      }
      #fe-chat-export-log .chat-message .message-header *,
      #fe-chat-export-log .chat-message .message-sender,
      #fe-chat-export-log .chat-message .message-sender *,
      #fe-chat-export-log .chat-message .name-stacked,
      #fe-chat-export-log .chat-message .name-stacked .title,
      #fe-chat-export-log .chat-message .name-stacked .subtitle,
      #fe-chat-export-log .chat-message .message-flavor,
      #fe-chat-export-log .chat-message .flavor-text,
      #fe-chat-export-log .chat-message .message-metadata {
        color: rgba(230,230,230,0.82) !important;
      }
      #fe-chat-export-log .chat-message :is(
        .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat
      ) {
        background: #000000 !important;
        background-color: #000000 !important;
        background-image: none !important;
        color: rgba(230,230,230,0.82) !important;
        border-color: rgba(255,255,255,0.7) !important;
      }
      #fe-chat-export-log .chat-message :is(
        .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat
      ) :is(header, section, footer, .card-header, .card-content, .collapsible-content,
            .details, .wrapper) {
        background: transparent !important;
        background-color: transparent !important;
        background-image: none !important;
        color: rgba(230,230,230,0.82) !important;
      }
    </style>` : ""}
  </head>
  <body class="${feEscapeAttr(bodyClass)}">
    <div id="fe-chat-export-container">
      <div class="fe-chat-export-toolbar">
        <div>
          <div id="fe-chat-export-title">${feEscapeHTML(titleText)}</div>
          <div id="fe-chat-export-meta">메시지 수집 중…</div>
        </div>
        <div class="fe-chat-export-actions">
          <a class="fe-chat-export-action fe-chat-export-download" id="fe-archive-download" data-tooltip="HTML 저장">HTML</a>
          ${externalBtnHTML}
          <a class="fe-chat-export-action fe-chat-export-print" id="fe-archive-print" data-tooltip="인쇄 / PDF">인쇄</a>
          <a class="fe-chat-export-action fe-chat-export-close" id="fe-archive-close" data-tooltip="닫기">닫기</a>
        </div>
      </div>
      <div id="fe-chat-export-sidebar" class="sidebar chat-sidebar">
        <section id="fe-chat-export-chat" class="sidebar-tab tab active" data-tab="chat">
          <div id="fe-chat-export-status" class="fe-chat-export-status">메시지 수집 중…</div>
          <ol id="fe-chat-export-log" class="chat-log"></ol>
        </section>
      </div>
    </div>
  </body>
</html>`);
  win.document.close();

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
  feSetChatGroupOutlineClass(win.document);
  feSetRetroThemeClass(win.document);
  feSetNeodgmModeClass(win.document);
  feSetSystemMsgColorClass(win.document);
  feSetAccentTextOverrideClass(win.document);
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
        await feArchivePrint(win);
      } catch (err) {
        console.warn("female_edition | print failed", err);
      } finally {
        try { btnPrint.removeAttribute("aria-disabled"); } catch {}
      }
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

  // Let the popup paint its shell before heavy collection/harvesting starts.
  await feMaybeYieldForUI(win);

  // Collect ALL messages first (including DB query) so the range dialog can show the true total.
  // Skip if messages were pre-collected outside (before the popup opened) to preserve dialog order.
  const liveMessageMap = feBuildLiveChatMessageElementMap();
  let allMessages;
  if (Array.isArray(preCollectedMessages) && preCollectedMessages.length > 0) {
    allMessages = preCollectedMessages;
    setStatus(`메시지 ${allMessages.length}개 준비 완료`);
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
    setStatus("수집된 메시지가 없습니다.");
    ui.notifications?.warn("female_edition | 아카이브할 메시지가 없습니다.");
    return;
  }

  let rangeSpec;
  if (preRangeSpec != null) {
    rangeSpec = preRangeSpec;
  } else {
    rangeSpec = await feShowArchiveRangeDialog(allMessages.length);
    // rejectClose:false → ESC/X 닫기 시 undefined 반환, OK 취소 시 null 가능
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

  const metaParts = [`${messages.length} messages`];
  if (sceneName) metaParts.push(sceneName);
  if (renderProfile.statusLabel) metaParts.push(renderProfile.statusLabel);
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

  try {
    feFireArchiveRenderUpdated(win.document, logEl);
  } catch {}

  // Wait for images so avatars/icons actually show up.
  if (metaEl) metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
  const imgTimeout = await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
  if (imgTimeout > 0) console.warn(`female_edition | archive: ${imgTimeout} image(s) did not load within timeout`);

  if (metaEl) metaEl.textContent = "Loading fonts…";
  await feWaitForFonts(win.document, FE_EXPORT_WAIT_FONTS_TIMEOUT);

  if (metaEl) metaEl.textContent = metaText;
  try {
    if (statusEl) statusEl.hidden = true;
  } catch {
    /* no-op */
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
    await feArchivePrint(win);
  }
}

// ===========================================================================
// Print page-break image handling  (shrink / split for page boundaries)
// ===========================================================================

/**
 * Prepare content images for print pagination.
 * - Images taller than one page: shrink to fit.
 * - Images crossing a page boundary with < 50% overflow: shrink to fit current page.
 * - Images crossing a page boundary with >= 50% overflow: split into two clipped
 *   fragments so the image spans both pages without blank space.
 *
 * Must be called after all other pre-print mutations (downscale, background freeze,
 * font load) and after a reflow.
 * @param {Document} doc
 * @param {HTMLElement} logEl
 * @returns {() => void} Restore function (idempotent).
 */
function fePrepareImagesForPageBreaks(doc, logEl) {
  if (!logEl) return () => {};

  // A4 = 297mm, @page margin = 10mm each → 277mm content ≈ 1047px at 96 dpi.
  const PAGE_H = 1047;
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
    const scrollY = doc.defaultView?.scrollY ?? 0;

    const imgs = Array.from(logEl.querySelectorAll("img")).filter(isContentImage);

    for (const img of imgs) {
      void logEl.offsetHeight;
      const rect = img.getBoundingClientRect();
      const imgDocTop = rect.top + scrollY;
      const imgH = rect.height;
      const imgW = rect.width;

      if (imgH <= 0 || imgW <= 0) continue;

      if (imgH > PAGE_H) {
        const prevStyle = img.getAttribute("style") || "";
        img.style.maxHeight = `${PAGE_H - 20}px`;
        img.style.width = "auto";
        img.style.objectFit = "contain";
        changes.push({ type: "shrink", img, prevStyle });
        continue;
      }

      const posInPage = ((imgDocTop % PAGE_H) + PAGE_H) % PAGE_H;
      const remaining = PAGE_H - posInPage;

      if (imgH <= remaining) continue;

      const overflow = imgH - remaining;
      const overflowRatio = overflow / imgH;

      if (overflowRatio < 0.5) {
        const prevStyle = img.getAttribute("style") || "";
        const fitH = Math.max(remaining - 4, 40);
        img.style.maxHeight = `${fitH}px`;
        img.style.width = "auto";
        img.style.objectFit = "contain";
        changes.push({ type: "shrink", img, prevStyle });
      } else {
        const prevStyle = img.getAttribute("style") || "";
        const parent = img.parentNode;
        const nextSib = img.nextSibling;

        const wrapper = doc.createElement("div");
        wrapper.className = "fe-print-img-split";
        wrapper.style.cssText = "display:block;";

        const frag1 = doc.createElement("div");
        frag1.style.cssText = `width:${imgW}px; height:${remaining}px; overflow:hidden; display:block; break-inside:avoid; page-break-inside:avoid;`;
        const img1 = img.cloneNode(true);
        img1.removeAttribute("style");
        img1.style.cssText = `width:${imgW}px; height:${imgH}px; display:block; max-width:none;`;
        frag1.appendChild(img1);

        const frag2 = doc.createElement("div");
        frag2.style.cssText = `width:${imgW}px; height:${overflow}px; overflow:hidden; display:block; break-inside:avoid; page-break-inside:avoid;`;
        const img2 = img.cloneNode(true);
        img2.removeAttribute("style");
        img2.style.cssText = `width:${imgW}px; height:${imgH}px; display:block; margin-top:${-remaining}px; max-width:none;`;
        frag2.appendChild(img2);

        wrapper.appendChild(frag1);
        wrapper.appendChild(frag2);

        parent.replaceChild(wrapper, img);
        changes.push({ type: "split", img, wrapper, parent, nextSib, prevStyle });
      }
    }
  } catch (err) {
    console.warn("female_edition | fePrepareImagesForPageBreaks error", err);
  }

  return () => {
    if (restored) return;
    restored = true;
    for (const ch of changes.reverse()) {
      try {
        if (ch.type === "shrink") {
          if (ch.prevStyle) ch.img.setAttribute("style", ch.prevStyle);
          else ch.img.removeAttribute("style");
        } else if (ch.type === "split") {
          if (ch.prevStyle) ch.img.setAttribute("style", ch.prevStyle);
          else ch.img.removeAttribute("style");
          if (ch.nextSib && ch.nextSib.parentNode === ch.parent) {
            ch.parent.insertBefore(ch.img, ch.nextSib);
          } else {
            ch.parent.appendChild(ch.img);
          }
          ch.wrapper.remove();
        }
      } catch {}
    }
  };
}

// Print Orchestration  (background freeze, image downscale, window.print())
// ===========================================================================

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

  const requested = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? "downscaleLite");
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

  // P2: images that never finished loading (slow / 404) are skipped by the
  // downscaler and would otherwise be decoded at full resolution by the print
  // engine — the main residual OOM source on huge logs. Blank those stragglers
  // right before print (restored on afterprint). Set after downscale.
  let restoreStragglers = () => {};
  let restorePageBreaks = () => {};

  const restoreOnce = () => {
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
      // Originals are about to be replaced by downscaled blobs — skip the
      // sync-decode storm (async lets Chromium decode off-thread).
      fePrepareArchiveImagesForOutput(logEl, { decoding: "async" });
      // Wait for ALL images to finish loading (bytes) — not a small initial
      // slice. The downscaler skips images that aren't `complete`, so anything
      // unloaded by now would slip through to print at full resolution. The
      // `load` wait only pulls encoded bytes (decode stays lazy → no decode
      // storm); the per-group canvas pass below decodes them under the
      // concurrency cap. The 20 s timeout bounds genuinely slow/dead images,
      // which the straggler-blank pass then neutralizes.
      const printImgCount = logEl.querySelectorAll?.("img")?.length || 0;
      const printImgTimeout = await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: Math.max(FE_EXPORT_WAIT_IMAGES_MAX, printImgCount) });
      if (printImgTimeout > 0) console.warn(`female_edition | print: ${printImgTimeout} image(s) did not load within timeout`);
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
      console.warn("female_edition | print downscale failed", err);
    }
  }

  if (!shouldDownscale && logEl) {
    try {
      fePrepareArchiveImagesForOutput(logEl);
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
        if (img.complete) return false;
        const s = img.getAttribute("src") || "";
        return !(s.startsWith("blob:") || s.startsWith("data:"));
      });
    } catch {}
  }

  try {
    setMeta("Loading fonts…");
    // feEnsureArchiveEmbeddedFonts is intentionally NOT called here.
    // It is designed for offline HTML export (file:// CORS workaround) and
    // injects !important font overrides + variable resets that break live fonts:
    //   - resets --fe-font-geurimilgi to system fonts (breaks Geurimilgi chat font)
    //   - overrides .chat-message * font-family, clobbering icon fonts (FA → □)
    //   - triggers a full text re-layout just before win.print(), so Chromium
    //     may capture the document mid-reflow (garbled text, broken rendering)
    // The archive popup already has all fonts loaded via <link> stylesheets.
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
  try {
    await new Promise((resolve) => {
      try {
        win.requestAnimationFrame(() => win.requestAnimationFrame(resolve));
      } catch {
        setTimeout(resolve, 50);
      }
    });
  } catch {}

  try {
    restorePageBreaks = fePrepareImagesForPageBreaks(doc, logEl);
  } catch (err) {
    console.warn("female_edition | print page-break image preparation failed", err);
  }

  try {
    win.print();
  } finally {
    setMeta(originalMeta);
    // Fallback restore in case afterprint doesn't fire (some Electron builds)
    setTimeout(restoreOnce, 0);
  }
}

// ===========================================================================
// HTML Snapshot Export  (blob build, download, external browser)
// ===========================================================================

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
  const liveLogEl = doc.getElementById("fe-chat-export-log") || doc.getElementById("chat-log") || doc.querySelector("ol.chat-log");
  const restoreBg = feFreezeMessageBackgroundsForPrint(win, liveLogEl);
  const restoreShell = feNormalizeArchiveShellLayout(doc, { restore: true });
  const restoreLayout = feNormalizeArchiveMessageLayout(doc.body, { restore: true });
  try {
    if (feSetting(S.EXPORT_EMBED_IMAGES)) {
      // Image embedding mutates img src/srcset to data: URLs. Apply in-place + revert
      // afterwards instead of cloning the entire body (cloning a large log doubles
      // the DOM tree in V8 heap right when we're about to allocate a giant outerHTML
      // string and a Blob).
      try {
        setMeta("Embedding images…");
        const prepRestore = fePrepareBodyForHTMLSnapshot(doc.body, { embedFonts });
        // P4: downscale images to small data: URLs BEFORE embedding. feEmbedImagesInNode
        // skips anything already `data:`, so this both shrinks the embedded payload
        // (far more images fit under the byte budget → better offline fidelity) and
        // cuts the saved-file size. maxTotalBytes guards against ballooning the HTML;
        // groups beyond the budget keep their original src and fall through to the
        // remote/embed path below. useBlobURL:false → real data: URLs that serialize.
        // Shared image-byte budget for the saved HTML. Pre-embed downscaling
        // spends part of it (dsStats.bytesUsed); feEmbedImagesInNode gets only
        // what's left so downscaled + leftover-embedded images never exceed it.
        const HTML_EMBED_TOTAL_BYTES = 12_000_000;
        const dsStats = {};
        let downscaleRestore = () => {};
        try {
          const embedLogEl = doc.getElementById("fe-chat-export-log") || doc.getElementById("chat-log") || doc.querySelector("ol.chat-log");
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
            });
          }
        } catch (e) {
          console.warn("female_edition | HTML export: pre-embed downscale failed", e);
        }
        const embedRestore = await feEmbedImagesInNode(doc.body, {
          meta: setMeta,
          maxTotalBytes: Math.max(0, HTML_EMBED_TOTAL_BYTES - (dsStats.bytesUsed || 0)),
        });
        try {
          bodyParts = feSerializeBodyToParts(doc.body);
        } finally {
          try { embedRestore?.(); } catch {}
          try { downscaleRestore?.(); } catch {}
          try { prepRestore?.(); } catch {}
        }
      } catch (err) {
        console.warn("female_edition | HTML export: failed to embed images", err);
        // Fallback: still produce a valid snapshot.
        const restore = fePrepareBodyForHTMLSnapshot(doc.body, { embedFonts });
        try {
          bodyParts = feSerializeBodyToParts(doc.body);
        } finally {
          try { restore(); } catch {}
        }
      }
    } else {
      const restore = fePrepareBodyForHTMLSnapshot(doc.body, { embedFonts });
      try {
        bodyParts = feSerializeBodyToParts(doc.body);
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

async function feOpenArchiveInExternalBrowser(win, titleText = "Chat Log", { closeAfter = false, force = false } = {}) {
  // Returns true when the archive was successfully handed to the system browser,
  // false otherwise (so callers can fall back to a direct HTML download).
  const mode = String(feSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE) ?? "off");
  // `force` bypasses the mode gate — used by the desktop (Electron) export path,
  // where opening in the system browser is the only way to get a real "Save as PDF".
  if (mode === "off" && !force) return false;
  if (!feIsElectron()) {
    ui?.notifications?.warn?.("외부 브라우저 열기는 데스크톱(Electron) 앱에서만 지원됩니다.");
    return false;
  }

  const electron = feTryRequire("electron");
  const shell = electron?.shell;
  const fs = feTryRequire("fs");
  const path = feTryRequire("path");
  const os = feTryRequire("os");

  if (!shell || !fs || !path || !os) {
    ui?.notifications?.warn?.("Electron shell/fs 접근이 불가하여 자동으로 외부 브라우저를 열 수 없습니다. 아카이브 창에서 HTML 저장 후 외부 브라우저로 열어주세요.");
    return false;
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
      ui?.notifications?.info?.("외부 브라우저에서 채팅 아카이브를 열었습니다. 브라우저의 인쇄 → PDF로 저장을 사용하세요.");
    }

    if (closeAfter) {
      try {
        win.close();
      } catch {}
    }
    return !errMsg;
  } catch (err) {
    console.warn("female_edition | external open failed", err);
    ui?.notifications?.warn?.("외부 브라우저 열기 실패. HTML 저장 후 수동으로 열어주세요.");
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
  let hasNeodgm = false;
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

  // Optional: embed NeoDGM (NeoDunggeunmo) pixel font (~0.65MB).
  // Unlike Geurimilgi (which intentionally falls back to system fonts offline),
  // the "neodgm" chat-font choice has NO acceptable system substitute — it is a
  // pixel font. Embed it so the retro look survives offline file:// export.
  try {
    const neodgmUrl = `/modules/${MODULE_ID}/font/NeoDunggeunmoPro-Regular.ttf`;
    const neodgmData = await fetchFont(neodgmUrl, { perFileCap: MAX_PER_FILE_BYTES_GEUR });
    if (neodgmData) {
      faces.push(
        `@font-face{font-family:"FE NeoDGM Embedded";src:url(${neodgmData}) format("truetype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
      );
      hasNeodgm = true;
    }
  } catch {}

  if (!faces.length) {
    feEmbeddedFontCssValue = "";
    return "";
  }

  // When the embedded NeoDGM is available AND the "neodgm" chat font is active,
  // ui-font.css's `body.fe-fonts-enabled.fe-neodgm-mode` rule remaps every font
  // var to "FE NeoDGM" — whose font file is CORS-blocked offline. Re-assert the
  // same selector (matching specificity, later source order → wins the tie) so
  // the var chain resolves to the embedded face instead of falling back to
  // generic monospace.
  const neodgmRule = hasNeodgm
    ? `
/* Offline neodgm: route every font var to the embedded pixel face. */
body.fe-fonts-enabled.fe-neodgm-mode,
body.fe-neodgm-mode {
  --fe-font-primary: "FE NeoDGM Embedded", "FE NeoDGM", monospace;
  --fe-font-geurimilgi: "FE NeoDGM Embedded", "FE NeoDGM", monospace;
  --fe-font-secondary: "FE NeoDGM Embedded", "FE NeoDGM", monospace;
  --fe-chat-font-family: "FE NeoDGM Embedded", "FE NeoDGM", monospace;
}`
    : "";

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

  /* Archive/export fallback for the large Geurimilgi face: use readable
   * system UI fonts instead of forcing another decorative font in offline HTML.
   */
  --fe-font-geurimilgi:
    "Noto Sans KR",
    "Malgun Gothic",
    "Apple SD Gothic Neo",
    "Segoe UI",
    system-ui,
    -apple-system,
    sans-serif,
    var(--fe-symbol-fallback);

  /* Secondary stack (small text / chat-card descriptions). Mirrors ui-font.css's
   * :root default — resolves to the readable system stack above, not a decorative
   * face, since Geurimilgi intentionally isn't embedded for offline export. */
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
${neodgmRule}
`;

    feEmbeddedFontCssValue = css;
    return css;
  } catch {
    feEmbeddedFontCssValue = "";
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
  const MAX_IMAGES = 160;
  // ~12MB (binary) before base64/string expansion. Caller may pass a smaller cap
  // (shared budget) — e.g. after pre-embed downscaling already spent part of it.
  const MAX_TOTAL_BYTES = Number.isFinite(maxTotalBytes) ? Math.max(0, maxTotalBytes) : 12_000_000;
  const MAX_PER_IMAGE = 800_000;      // ~0.8MB per image

  const cache = new Map();

  try {
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
        // For duplicate archive images, keep the original absolute src instead of repeating
        // the same large data: URL over and over in saved HTML.
        try {
          recordBeforeMutate(img);
          if (img.dataset?.feArchiveSharedImage === "1") {
            img.setAttribute("src", abs);
            img.removeAttribute("srcset");
            if (!img.getAttribute("loading")) img.setAttribute("loading", "lazy");
          } else {
            img.setAttribute("src", cache.get(abs));
            img.removeAttribute("srcset");
            img.removeAttribute("loading");
          }
        } catch {}
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

        recordBeforeMutate(img);
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

function fePrepareBodyForHTMLSnapshot(root, { embedFonts = false } = {}) {
  const restores = [];
  try {
    restores.push(feRestoreOriginalPortraitSources(root));
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

// Reverts blob: URLs (set by feDownscaleImagesForPrint when useBlobURL=true) back to
// the original src stashed on data-fe-print-orig-src. Used by HTML snapshot paths
// so saved HTML never contains blob: URLs that would die with the popup window.
function feRestorePrintBlobSources(root) {
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

// ---------------------------------------------------------------------------
// Inline Export — download from current (non-popup) document
// ---------------------------------------------------------------------------

function feDownloadExportHTMLFromCurrentDocument() {
  try {
    const container = document.getElementById("fe-chat-export-container");
    if (!container) return;

    const docEl = document.documentElement;
    const html = "<!doctype html>\n" + docEl.outerHTML;

    const worldName = game.world?.title ?? game.world?.name ?? "chat-log";
    const safeName = feSanitizeExportFilename(worldName);
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

// ===========================================================================
// Archive Merge & Style Mirroring  (merge classes, computed style copy,
//                                   live-tree mirror, message style mirror)
// ===========================================================================

function feApplyChatMergeInWindow(win) {
  try {
    const logEl =
      win.document.getElementById("fe-chat-export-log") ||
      win.document.getElementById("chat-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    feSyncArchiveMergeBodyClasses(win.document);
    feApplyRenderedStateToLog(logEl, feArchiveMergeOptions());
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
    const view = srcEl?.ownerDocument?.defaultView ?? window;
    const cs = view.getComputedStyle?.(srcEl);
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
    const liveDoc = liveEl.ownerDocument ?? document;
    const cloneDoc = cloneEl.ownerDocument ?? document;
    const liveWalker = liveDoc.createTreeWalker(liveEl, NodeFilter.SHOW_ELEMENT);
    const cloneWalker = cloneDoc.createTreeWalker(cloneEl, NodeFilter.SHOW_ELEMENT);

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

    const isNarratorLike = !!(liveEl.classList?.contains?.("narrator-chat") || liveEl.classList?.contains?.("fe-narrator-chat"));
    const isRoundMarkerLike = !!(
      liveEl.classList?.contains?.("round-marker") ||
      liveEl.classList?.contains?.("fe-round-marker-chat") ||
      liveEl.dataset?.feIsRoundMarker === "1" ||
      liveEl.querySelector?.(".round-marker")
    );
    if (isNarratorLike || isRoundMarkerLike) {
      sync(":scope, :scope > .message-header, :scope > .message-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS);
      sync(":scope .message-content, :scope .round-marker", FE_ARCHIVE_TEXT_STYLE_PROPS);
    }
  } catch {
    /* no-op */
  }
}

// ===========================================================================
// Layout Normalization  (visibility, export node prep, shell/message layout,
//                        image output, font injection, image/font wait helpers)
// ===========================================================================

function feCanUserSeeChatMessage(msg, user) {
  try {
    if (!msg) return false;

    // Whispers: visible to GM and recipients (and the author).
    const whisper = msg.whisper ?? [];
    if (Array.isArray(whisper) && whisper.length) {
      if (user?.isGM) return true;
      if (whisper.includes(user?.id)) return true;
      if ((msg.author ?? msg.user)?.id === user?.id) return true;
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

function fePrepareArchiveImagesForOutput(rootEl, { restorePortraits = true, decoding = "sync" } = {}) {
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

async function feEnsureArchiveEmbeddedFonts(win) {
  try {
    if (!win || win.closed) return;
    const doc = win.document;
    if (!doc?.head) return;

    let enableFonts = true;
    try {
      enableFonts = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
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

// Returns a Promise that resolves to the number of images that failed to load
// within the timeout (0 = all loaded successfully, >0 = some timed out or errored).
function feWaitForImages(rootEl, timeoutMs = 10000, { maxImages = 800 } = {}) {
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

    // When the user is not viewing the Chat tab in FVTT v13, recent lines can still exist
    // in the notifications tray. Use them as a fidelity backup, but only for ids not already
    // backed by a real chat-log entry.
    for (const el of Array.from(document.querySelectorAll?.("#chat-notifications > .message") ?? [])) {
      const id = feGetMessageIdFromElement?.(el);
      if (id && !map.has(String(id))) map.set(String(id), el);
    }
  } catch {
    /* no-op */
  }
  return map;
}

function feCloneChatMessageElement(el) {
  try {
    if (!feIsElement(el)) return null;
    return el.cloneNode(true);
  } catch {
    return null;
  }
}

// ===========================================================================
// Chat History Harvesting  (scroll-safe DOM clone, full log rebuild)
// ===========================================================================

async function feHarvestFullChatHistory({ batchSize = 100, maxIterations = 80, timeBudgetMs = 0, progress = null } = {}) {
  const cloneMap = new Map();
  let orderedIds = [];
  // Declared outside try so the finally block can always restore scroll positions,
  // even if an error is thrown before or during the harvest loop.
  let logStates = null;
  try {
    const chat = game?.messages?.directory || ui?.chat;
    const logs = feGetChatLogs?.() ?? [];
    if (!chat?.renderBatch || !logs.length) return { cloneMap, orderedIds };

    logStates = logs.map((log) => ({
      log,
      top: Number(log?.scrollTop ?? 0),
      height: Number(log?.scrollHeight ?? 0),
    }));

    const harvestOnce = () => {
      const visibleIds = [];
      for (const log of logs) {
        if (!log?.querySelectorAll) continue;
        for (const el of log.querySelectorAll('li.chat-message')) {
          const id = feGetMessageIdFromElement?.(el);
          if (!id) continue;
          const sid = String(id);
          visibleIds.push(sid);
          if (!cloneMap.has(sid)) {
            const clone = feCloneChatMessageElement(el);
            if (clone) cloneMap.set(sid, clone);
          }
        }
      }
      if (visibleIds.length) {
        const seen = new Set();
        const merged = [];
        for (const id of visibleIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(id);
        }
        for (const id of orderedIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(id);
        }
        orderedIds = merged;
      }
      return visibleIds;
    };

    let prevFirst = '';
    let prevCount = -1;
    let stablePasses = 0;
    const startedAt = Date.now();
    let timedOut = false;
    for (let i = 0; i < maxIterations; i += 1) {
      if (timeBudgetMs > 0 && (Date.now() - startedAt) >= timeBudgetMs) {
        timedOut = true;
        break;
      }

      const before = harvestOnce();
      const beforeFirst = before[0] || '';
      const beforeCount = before.length;

      try {
        if (typeof progress === "function") progress({ iteration: i + 1, maxIterations, collected: cloneMap.size, total: orderedIds.length || beforeCount, timedOut: false });
      } catch {
        /* no-op */
      }

      for (const st of logStates) {
        try {
          st.log.scrollTop = 0;
          st.log.dispatchEvent?.(new Event('scroll'));
        } catch {}
      }
      await feMaybeYieldForUI(window);

      try {
        const remaining = timeBudgetMs > 0 ? Math.max(250, timeBudgetMs - (Date.now() - startedAt)) : 0;
        if (remaining > 0) {
          let expired = false;
          await Promise.race([
            Promise.resolve(chat.renderBatch(batchSize)),
            new Promise((resolve) => setTimeout(() => { expired = true; resolve(null); }, remaining)),
          ]);
          if (expired) {
            timedOut = true;
            break;
          }
        } else {
          await chat.renderBatch(batchSize);
        }
      } catch {
        break;
      }
      await feMaybeYieldForUI(window);
      await feMaybeYieldForUI(window);

      const after = harvestOnce();
      const afterFirst = after[0] || '';
      const afterCount = after.length;

      if (afterCount === beforeCount && afterFirst === beforeFirst) stablePasses += 1;
      else stablePasses = 0;

      if (afterCount === prevCount && afterFirst === prevFirst) stablePasses += 1;
      prevCount = afterCount;
      prevFirst = afterFirst;

      if (stablePasses >= 2) break;
    }

    harvestOnce();
    try {
      if (typeof progress === "function") progress({ collected: cloneMap.size, total: orderedIds.length || cloneMap.size, timedOut });
    } catch {
      /* no-op */
    }

  } catch {
    // swallow and return best-effort partial history
  } finally {
    // Always restore scroll positions — even if an error interrupted the harvest loop.
    for (const st of logStates ?? []) {
      try { st.log.scrollTop = st.top; } catch {}
    }
  }
  return { cloneMap, orderedIds };
}

// ===========================================================================
// Render Decision & Fallback  (complexity heuristic, plain-message fast path,
//                              HTML fallback renderer)
// ===========================================================================

function feArchiveMessageLooksComplex(msg, liveEl = null) {
  try {
    const el = liveEl;
    if (el?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dice-roll, .dice-result, .round-marker, .chat-images-container, .ci-message-image, img, video, table, blockquote, pre, iframe')) return true;
  } catch {}
  try {
    // Roll messages store the dice total in content, not the .dice-roll card HTML.
    // The card is generated by Foundry's template at render time, so we must use
    // the system render path whenever a message carries actual dice rolls.
    if (Array.isArray(msg?.rolls) && msg.rolls.length > 0) return true;
  } catch {}
  try {
    const content = String(msg?.content ?? '');
    if (!content) return false;
    return /(?:chat-card|midi-chat-card|dice-roll|dice-result|round-marker|chat-images-container|ci-message-image|<img\b|<video\b|<table\b|<blockquote\b|<pre\b|<iframe\b)/i.test(content);
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
  li.className = "chat-message message flexcol fe-pseudo-sanitized";

  try {
    const id = msg?.id ?? msg?._id;
    if (id) {
      li.dataset.messageId = String(id);
      li.dataset.documentId = String(id);
    }
  } catch {}

  try {
    const style = Number(msg?.style ?? msg?.type ?? -1);
    // v14: CONST.CHAT_MESSAGE_STYLES | v13: CONST.CHAT_MESSAGE_TYPES (same numeric values)
    const styles = CONST?.CHAT_MESSAGE_STYLES || CONST?.CHAT_MESSAGE_TYPES || {};
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

  const isNarratorMessage = !!feIsNarratorToolsMessage(msg, null);
  const isRoundMarkerMessage = !!feIsRoundMarkerMessage(msg, null);
  if (isNarratorMessage) li.classList.add("narrator-chat", "fe-narrator-chat");
  if (isRoundMarkerMessage) li.classList.add("round-marker", "fe-round-marker-chat");

  const hideSender = isRoundMarkerMessage;
  if (hideSender) sender.style.setProperty("display", "none", "important");

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
  content.className = "message-content fe-archive-standard-content";
  try {
    content.innerHTML = String(msg?.content ?? "");
  } catch {
    content.textContent = String(msg?.content ?? "");
  }

  li.appendChild(header);
  li.appendChild(content);
  return li;
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
      try { feInjectExportButtonsAll(); } catch (err) { console.warn("[female_edition] fe-chat-archive: inject failed", err); }
    }, Math.max(0, Number(delay) || 0));
  } catch {}
}

Hooks.once("ready", () => {
  try {
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn("[female_edition] fe-chat-archive: initial inject failed", err);
  }
});

// FVTT v13 reparents the shared chat input/controls outside the normal ChatLog render flow.
// Re-inject the export control whenever that input block is adopted so the archive button
// survives sidebar toggles, notifications, and popout transitions.
Hooks.on("renderChatInput", () => {
  try {
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn("[female_edition] fe-chat-archive: chat input reinject failed", err);
  }
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
  try {
    const reason = payload?.reason ?? null;
    if (reason !== "ready" && reason !== "renderChatLog" && reason !== "export-settings") return;
    feScheduleInjectExportButtons(0);
  } catch (err) {
    console.warn("[female_edition] fe-chat-archive: reinject failed", err);
  }
});
