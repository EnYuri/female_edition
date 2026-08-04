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
  feSetPaperOverlayClass,
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
import { feSnapshotAndRestoreStickyScroll } from "./fe-util.js";

// Chat portrait: ensure exported/archive-rendered messages receive the same portrait injection.
import {
  feChatPortraitUpsert,
  feChatPortraitApplyVars,
} from "./fe-chat-portrait.js";
import { cpMaybeApplyHQResample } from "./fe-chat-portrait-image.js";

// Image processing: canvas downscale, background freeze.
import {
  feFreezeMessageBackgroundsForPrint,
  feDownscaleImagesForPrint,
} from "./fe-archive-image.js";
import {
  feOptimizeArchiveNodeImages,
  feMirrorLiveMessageStyles,
} from "./fe-archive-clone.js";
import {
  feRestoreOriginalPortraitSources,
  feWaitForFonts,
  feArchiveIsWhisperMessage,
  feCanUserSeeChatMessage,
  feNormalizeExportNode,
  feNormalizeArchiveShellLayout,
  fePrepareArchiveImagesForOutput,
  feNormalizeArchiveMessageLayout,
  feIsElement,
  feNextTick,
  feWaitForImages,
  feEscapeAttr,
  feGetFoundryBaseHref,
  feRunArchiveDocumentOperation,
} from "./fe-archive-output.js";
// HTML-snapshot production (stylesheet inlining, font/image embedding, download).
import {
  feDownloadArchiveHTML,
  feBuildEmbeddedCookieRunFontCSS,
  feDownloadExportHTMLFromCurrentDocument,
  feUpgradePortraitsForExport,
} from "./fe-archive-snapshot.js";

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
// Ceiling on the two-paint-frame settle before win.print(). Generous next to the
// ~33 ms two frames actually take when the popup is in front, and the only thing
// standing between the user and a minute-plus hang when it is not — a hidden window
// gets no rAF at all. See the comment at the await for the measurement.
const FE_EXPORT_PAINT_FRAME_TIMEOUT = 400;
const FE_EXPORT_PORTRAIT_MARKER_SELECTOR = 'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container';
const FE_ARCHIVE_LARGE_LOG_THRESHOLD = 1200;
const FE_ARCHIVE_HUGE_LOG_THRESHOLD = 2600;
const FE_EXPORT_RENDER_BATCH_LARGE = 40;
const FE_EXPORT_RENDER_BATCH_HUGE = 24;
const FE_EXPORT_RENDER_CONCURRENCY_LARGE = 4;
const FE_EXPORT_RENDER_CONCURRENCY_HUGE = 2;
const FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE = 40;
const FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE = 16;
const FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT = 4500;
const FE_ARCHIVE_HARVEST_TIMEOUT_LARGE = 2500;
const FE_ARCHIVE_HARVEST_TIMEOUT_HUGE = 1200;
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
// Range Selection Dialog
// ===========================================================================

// Asks the user which message index range to archive.
// Returns { mode: "all"|"range", from, to } or null if cancelled.
// from/to are 1-based indices (inclusive).
async function feShowArchiveRangeDialog(totalCount = 0) {
  const readRange = (root) => {
    try {
      // DialogV2 hands us an HTMLElement (often the <form> itself, via `button.form`),
      // while v13's legacy Dialog callback hands us a jQuery collection.
      //
      // Unwrap ONLY jQuery. A bare `root?.[0] ?? root` looks like a harmless normalization
      // but silently breaks the DialogV2 path: HTMLFormElement exposes indexed access to
      // its own controls, so `form[0]` returns the FIRST RADIO INPUT rather than undefined.
      // Every querySelector on that input then returns null, `mode` fell back to its "all"
      // default, and the range dialog became a no-op that always exported everything.
      // jQuery objects are identified by their `.jquery` version string.
      const el = (root && typeof root.jquery === "string") ? root[0] : root;

      // `el` may be the dialog root or the <form>; the controls are inside either, so query
      // directly and do not try to re-resolve a <form> ancestor/descendant.
      const q = (sel) => el?.querySelector?.(sel) ?? null;

      const mode = q("input[name='fe-range-mode']:checked")?.value ?? "all";
      const from = Math.max(1, parseInt(q("#fe-range-from")?.value ?? "1", 10) || 1);
      const to = Math.max(from, parseInt(q("#fe-range-to")?.value ?? String(totalCount), 10) || totalCount);
      return { mode, from, to };
    } catch {
      return { mode: "all", from: 1, to: Math.max(1, totalCount) };
    }
  };

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

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (typeof DialogV2?.prompt === "function") {
      return await DialogV2.prompt({
        window: { title: "채팅 아카이브 — 범위 선택" },
        content,
        ok: {
          label: "저장 시작",
          callback: (event, button, dialog) => readRange(button?.form ?? dialog?.element),
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
    }

    // Keep a legacy Dialog fallback for installations where DialogV2 is not
    // exposed (including older v13-compatible environments). Do not treat
    // that API gap as a cancellation: the archive renderer itself can still
    // run perfectly well once a range has been chosen.
    const LegacyDialog = globalThis.Dialog;
    if (typeof LegacyDialog !== "function") return null;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const dialog = new LegacyDialog({
        title: "채팅 아카이브 — 범위 선택",
        content,
        buttons: {
          save: {
            icon: '<i class="fas fa-save"></i>',
            label: "저장 시작",
            callback: (html) => finish(readRange(html)),
          },
        },
        default: "save",
        close: () => finish(null),
      });
      dialog.render(true);
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
    dlBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await feDownloadExportHTMLFromCurrentDocument();
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
 *  3) In the Foundry desktop (Electron) app, save a self-contained HTML archive
 *     instead. Modules cannot access Electron's native printToPDF API, while
 *     window.print() uses the slow/unreliable OS printer route.
 */
async function feExportChatLogToPDF() {
  if (feArchiveLaunchInProgress && !feArchiveLaunchIsAbandoned()) {
    ui.notifications?.warn("female_edition | 채팅 아카이브를 이미 만들고 있습니다.", { console: false });
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
      console.warn("female_edition | archive launch lock released: its window was closed");
      return true;
    }
    if (feArchiveLaunchStartedAt && Date.now() - feArchiveLaunchStartedAt > FE_ARCHIVE_LAUNCH_STALE_MS) {
      console.warn("female_edition | archive launch lock released: stale");
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

  // The Electron renderer cannot call the native printToPDF API. Its
  // window.print() route opens the OS printer dialog (often Microsoft Print to
  // PDF), which is slow and can produce invalid files on image-heavy archives.
  // Keep desktop export reliable and portable: download HTML, then let the user
  // open it in any normal browser and use that browser's PDF-save feature.
  if (feIsElectron()) {
    const done = await feExportChatLogToDesktopHTML({ preCollectedMessages, preRangeSpec });
    if (!done) ui.notifications?.error("female_edition | 데스크톱 앱에서 HTML 아카이브 저장에 실패했습니다. 콘솔을 확인해 주세요.", { console: false });
    return;
  }

  // Step 3: Now open the archive popup window.
  const win = feOpenChatArchiveWindow();
  // Recorded so the busy-guard can detect an abandoned launch (see feArchiveLaunchIsAbandoned).
  feArchiveLaunchWindow = win || null;
  if (win) {
    try {
      const optimize = !!feSetting(S.EXPORT_OPTIMIZE);

      const worldName = game.world?.title || game.world?.name || "";
      const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

      await feRenderChatArchiveWindow(win, {
        autoPrint: !!feSetting(S.EXPORT_AUTO_PRINT),
        optimize,
        preCollectedMessages,
        preRangeSpec,
      });

      return;
    } catch (err) {
      console.warn("female_edition | archive window export failed, falling back to inline export", err);
      try {
        win.close();
      } catch {}
    }
  }

  // Defensive second check for Electron builds whose user agent is populated
  // late. Never allow the desktop client to fall through to window.print().
  if (feIsElectron()) {
    const done = await feExportChatLogToDesktopHTML({ preCollectedMessages, preRangeSpec });
    if (!done) ui.notifications?.error("female_edition | 데스크톱 앱에서 HTML 아카이브 저장에 실패했습니다. 콘솔을 확인해 주세요.", { console: false });
    return;
  }

  // Browser fallback: in-document export + print. Reuse the already-collected messages
  // and range selection: popup blockers are common in the desktop client, and
  // collecting again here used to discard the user's selected range.
  ui.notifications?.info("female_edition | 새 창을 열 수 없어 현재 Foundry 창에서 아카이브와 인쇄를 진행합니다.", { console: false });
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
      ui.notifications?.warn("female_edition | 선택한 범위에 아카이브할 메시지가 없습니다.");
      cleanup();
      return;
    }
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
    metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
    const inlineImgTimeout = await feWaitForImages(logEl, FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
    if (inlineImgTimeout > 0) console.warn(`female_edition | inline export: ${inlineImgTimeout} image(s) failed or timed out`);

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
      // The caller has a same-window render/print fallback. This is especially
      // expected in Foundry's Electron client, where window.open is commonly
      // disabled, so do not instruct users to change popup-blocker settings.
      console.info("female_edition | chat archive popup unavailable; using in-document fallback");
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
  const worldName = game.world?.title || game.world?.name || "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

  const iframe = feCreateHiddenArchiveFrame();
  const win = iframe.contentWindow;
  if (!win) {
    try { iframe.remove(); } catch {}
    return false;
  }

  try {
    ui.notifications?.info("female_edition | HTML 아카이브 생성 중…", { console: false });

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
    if (saved) ui.notifications?.info("female_edition | HTML 아카이브를 저장했습니다. Chrome 또는 Edge로 열어 인쇄 → PDF로 저장하세요.", { console: false });
    return saved;
  } catch (err) {
    console.warn("female_edition | desktop HTML archive export failed", err);
    return false;
  } finally {
    // Let the browser receive the download click before tearing down its frame.
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

function feNormalizeArchivePortraitImages(rootEl, renderProfile = null) {
  try {
    if (!rootEl?.querySelectorAll) return;
    const body = rootEl.ownerDocument?.body;
    const explicitlyHidden = !!(
      body?.classList?.contains?.("fe-hide-chat-portrait-wrap") ||
      body?.classList?.contains?.("fe-print-hide-avatars") ||
      body?.classList?.contains?.("fe-print-hide-all")
    );

    for (const img of rootEl.querySelectorAll("img.fe-chat-portrait")) {
      const src = img.getAttribute("src");
      if (src) {
        try {
          img.src = new URL(src, rootEl.ownerDocument?.baseURI || window.location.href).href;
        } catch {
          try { img.src = new URL(src, window.location.href).href; } catch {}
        }
      }
      img.setAttribute("loading", renderProfile?.normalizeImageLoading || "eager");
      img.setAttribute("decoding", renderProfile?.normalizeImageDecoding || "sync");

      // Re-apply the HQ downscale AFTER the src normalization above.
      //
      // MUST stay: `feRestoreOriginalPortraitSources` deliberately puts the original file
      // path back into `src` (the saved-HTML path needs real files to embed), and it runs
      // per node during render — i.e. AFTER `feChatPortraitUpsert` already resolved the
      // HQ data URL. Nothing else re-invokes the resample once the render pass is over, so
      // without this call the archive window keeps painting full-resolution bitmaps
      // (e.g. 832x1216) inside a 64px `object-fit: cover` box — exactly the Chromium
      // low-quality clipped-downscale path the HQ pipeline exists to avoid.
      //
      // Cheap by design: `cpMaybeApplyHQResample` is a cache hit for any portrait already
      // processed by the live sidebar, and a no-op when the <img> is still lazy-deferred
      // (it re-enters on that image's own `load`). The snapshot builder calls
      // `feRestoreOriginalPortraitSources` again with its own undo, so the saved HTML is
      // unaffected by the data URLs we put back here.
      try {
        cpMaybeApplyHQResample(
          img,
          Math.max(16, Number(feSetting("chatPortraitSize") ?? 64) || 64),
          String(feSetting("chatPortraitShape") ?? "circle"),
          true
        );
      } catch {}
      if (!explicitlyHidden) {
        // Inline !important is intentional: v13 systems/themes can carry their
        // own broad @media print image rules, which otherwise beat module CSS.
        img.style.setProperty("display", "block", "important");
        img.style.setProperty("visibility", "visible", "important");
      } else {
        // A live clone may already carry the archive override. Remove it so the
        // user's explicit hide mode remains authoritative.
        img.style.removeProperty("display");
        img.style.removeProperty("visibility");
      }
    }
  } catch {
    /* no-op */
  }
}

function feRefreshPortraitsForLog(logEl, renderProfile = null) {
  try {
    if (!logEl?.querySelectorAll) return;
    for (const el of logEl.querySelectorAll("li.chat-message")) {
      const id = feGetMessageIdFromElement(el);
      const msg = (id ? game.messages?.get(id) : null) || el.__feMessage || null;
      if (!msg) continue;
      feChatPortraitUpsert(msg, el);
      feNormalizeArchivePortraitImages(el, renderProfile);
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
    if (!docClass || !backend?.get) return { rows: [], docClass: null };
    // The public v13 API defines the third argument as the requesting User
    // document. v14 continues to accept that argument (and its client get
    // path does not require a private context object). Passing `{userId}` here
    // can make v13 permission-aware retrieval fail or omit older messages.
    const rows = await backend.get(docClass, { query: {}, sort: { timestamp: 1 } }, game?.user);
    if (!Array.isArray(rows)) return { rows: [], docClass: null };
    return { rows: rows.filter(Boolean), docClass };
  } catch {
    return { rows: [], docClass: null };
  }
}

// Turn one DB row into a ChatMessage document. `backend.get` sometimes hands back real
// documents already (the check below), in which case this is a pass-through.
//
// This is deliberately NOT done eagerly for every row: a large world returns thousands of
// rows and the user is usually about to pick a range that discards almost all of them.
// feCollectVisibleChatMessages defers each call behind a lazy `msg` getter so only rows
// that survive feApplyMessageRange ever become documents.
function feMaterializeChatMessage(row, docClass = null) {
  if (!row) return null;
  if (typeof row.getFlag === "function" || row.documentName === "ChatMessage") return row;
  const cls = docClass
    || game?.messages?.documentClass
    || CONFIG?.ChatMessage?.documentClass
    || globalThis.ChatMessage?.implementation
    || globalThis.ChatMessage;
  if (!cls) return null;
  try {
    return cls.fromSource ? cls.fromSource(row) : new cls(row, {});
  } catch {
    try { return new cls(row, {}); } catch { return null; }
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
  // Set only when `all` holds raw DB rows; the lazy `msg` getter needs it to materialize.
  let rowDocClass = null;
  // Archive/export should prefer the fullest document source available.
  // Some worlds/clients may only have the most recent chat page hydrated in memory,
  // so always probe the backend and keep whichever source is longer.
  try {
    report("메시지 DB 확인 중…");
    const { rows: dbAll, docClass } = await feFetchAllChatMessagesFromDatabase();
    if (dbAll.length > all.length) {
      all = dbAll;
      rowDocClass = docClass;
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

  // Applied here — inside collection — rather than alongside feApplyMessageRange, so the
  // count handed to the range dialog is the already-filtered count. Filtering later would
  // make "1~100번째" refer to a list the user never saw.
  const excludeWhispers = !!feSetting(S.EXPORT_EXCLUDE_WHISPERS);

  const visibleDocs = all
    .filter((m) => feCanUserSeeChatMessage(m, user))
    .filter((m) => !(excludeWhispers && feArchiveIsWhisperMessage(m)))
    .sort((a, b) => {
      const ao = Number(a?.sort ?? a?.timestamp ?? 0);
      const bo = Number(b?.sort ?? b?.timestamp ?? 0);
      if (ao !== bo) return ao - bo;
      return String(a?.id ?? a?._id ?? '').localeCompare(String(b?.id ?? b?._id ?? ''));
    });

  // `msg` is a lazy getter, not a value. Everything above this point (visibility, whisper
  // filter, sort) reads only plain fields that a raw DB row already carries, and every
  // caller applies feApplyMessageRange to this array before touching `.msg` — so exporting
  // the last 50 of a 5000-message world constructs 50 ChatMessage documents instead of
  // 5000. Items dropped by the range slice are never materialized at all.
  //
  // If you add a step between collection and feApplyMessageRange, keep it off `.msg`, or
  // this degrades back to eager materialization without any visible symptom.
  const items = visibleDocs.map((m) => {
    const id = String(m?.id ?? m?._id ?? '');
    const item = {
      key: id || `__msg__${Math.random()}`,
      id,
      liveEl: id ? (liveMap.get(id) || null) : null,
    };
    let cached;
    Object.defineProperty(item, "msg", {
      configurable: true,
      enumerable: true,
      get() {
        if (cached === undefined) cached = feMaterializeChatMessage(m, rowDocClass);
        return cached;
      },
      // Present so an assignment can't throw in this strict-mode module; nothing writes
      // `.msg` today, but a getter-only property would fail loudly if that ever changed.
      set(value) { cached = value; },
    });
    return item;
  });

  if (!items.length && harvested?.orderedIds?.length) {
    const out = harvested.orderedIds.map((id, idx) => ({
      key: id || `__harvest__${idx}`,
      id,
      msg: null,
      liveEl: id ? (liveMap.get(id) || null) : null,
    })).filter((it) => it.liveEl)
      .filter((it) => !(excludeWhispers && feArchiveIsWhisperMessage(null, it.liveEl)));
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

    // Portrait upsert can create a new <img> after the first normalization
    // pass above. Normalize existing clones and newly inserted portraits alike.
    feNormalizeArchivePortraitImages(node, renderProfile);

    return node;
  };

  for (let start = 0; start < messages.length; start += concurrency) {
    // The user can close the archive popup mid-render. Without this the loop keeps
    // building thousands of nodes into a dead document — and every downstream asset
    // wait (feWaitForImages/feWaitForFonts) then burns its full 10–12 s timeout on
    // images that can never load. Stop at the batch boundary instead.
    if (feArchiveWindowClosed(yieldWindow)) break;

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
// Platform Utilities  (Electron detection)
// ===========================================================================

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

  const worldName = game.world?.title ?? game.world?.name ?? "";
  const sceneName = canvas?.scene?.name ?? "";
  const titleText = worldName ? `Chat Log – ${worldName}` : "Chat Log";

  // Build the archive document immediately so the popup is never left as a blank about:blank
  // while we collect older message history.
  const headStyles = feCollectHeadStylesHTML();
  const baseHref = feEscapeAttr(feGetFoundryBaseHref());

  // Electron exports are saved as HTML by the entry path; do not surface an
  // external-browser control in archive documents.
  const externalBtnHTML = "";

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
  feSetPaperOverlayClass(win.document);
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
        console.warn("female_edition | print failed", err);
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

  // Everything below writes into win.document and waits on its assets. If the user
  // closed the popup during the render there is nothing left to produce, and pressing
  // on would only stall on asset timeouts before failing anyway. Return normally (not
  // by throwing) so the caller's `finally` clears feArchiveLaunchInProgress and the
  // next archive request is accepted immediately.
  if (feArchiveWindowClosed(win)) {
    console.debug("female_edition | archive window closed during render; aborting");
    return;
  }

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
      feApplyChatMergeInWindow(win, renderProfile);
    } catch (err) {
      console.warn("female_edition | archive merge failed", err);
    }
  } else if (renderProfile.deferPortraits) {
    feRefreshPortraitsForLog(logEl, renderProfile);
  }

  try {
    feNormalizeArchiveShellLayout(win.document);
    feNormalizeArchiveMessageLayout(logEl);
  } catch {}

  try {
    feFireArchiveRenderUpdated(win.document, logEl);
  } catch {}

  // Popup/print output needs decoded assets before it becomes interactive.
  // The Electron HTML path instead builds a serialized snapshot immediately;
  // that path independently fetches and embeds assets where configured, so
  // waiting here only wastes time and raises its peak decoded-image memory.
  if (waitForAssets) {
    if (metaEl) metaEl.textContent = renderProfile.initialImageWaitMax < FE_EXPORT_WAIT_IMAGES_MAX ? "Loading visible images…" : "Loading images…";
    const imgTimeout = await feWaitForImages(logEl, FE_EXPORT_WAIT_IMAGES_TIMEOUT, { maxImages: renderProfile.initialImageWaitMax });
    if (imgTimeout > 0) console.warn(`female_edition | archive: ${imgTimeout} image(s) failed or timed out`);

    if (metaEl) metaEl.textContent = "Loading fonts…";
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
function fePrepareImagesForPageBreaks(doc, logEl) {
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
    console.warn("female_edition | fePrepareImagesForPageBreaks error", err);
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
    feNormalizeArchivePortraitImages(logEl, renderProfile);
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
  // why it now skips anything this marks. Portraits it cannot upgrade keep their current
  // src and fall through to the normal path.
  if (logEl && mode !== "hideAll" && mode !== "hideAvatars") {
    try {
      restorePortraitUpgrade = await feUpgradePortraitsForExport(logEl, {
        meta: setMeta,
        // blob: URLs, not data:. Revoked by restoreOnce on afterprint.
        useBlobURL: true,
        win,
      });
    } catch (err) {
      console.warn("female_edition | print portrait upgrade failed", err);
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
      setMeta(mildDownscale ? "Loading images… (품질 우선)" : "Loading images…");
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
      if (printImgTimeout > 0) console.warn(`female_edition | print: ${printImgTimeout} image(s) failed or timed out`);
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
    setMeta("Loading fonts…");
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
  // never serviced does not throw. So the user pressed 인쇄 and waited a minute-plus
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


/**
 * True when `win` is a popup we opened that the user has since closed.
 *
 * Returns false for the main window (the in-document fallback path passes it as the
 * render target, and `window.closed` is false there anyway) and false when the check
 * itself is not possible — "unknown" must never read as "gone".
 */
function feArchiveWindowClosed(win) {
  try {
    if (!win || win === window) return false;
    return win.closed === true;
  } catch {
    return false;
  }
}

// How long to wait for a yield scheduled on the target window before giving up on it
// and continuing on our own timer. Only ever paid when that window died mid-yield.
const FE_YIELD_FALLBACK_MS = 250;

async function feMaybeYieldForUI(targetWindow = window) {
  // A CLOSED window's timers NEVER FIRE. This used to `await` one unconditionally, so
  // closing the archive popup mid-render hung feRenderMessagesIntoLog forever — the
  // export promise never settled, feExportChatLogToPDF's `finally` never ran, and
  // `feArchiveLaunchInProgress` stayed true for the rest of the session. That is the
  // reported "아직 렌더 중" that no longer clears. Bail out before scheduling anything.
  if (feArchiveWindowClosed(targetWindow)) return;

  // Background tabs/windows clamp timers; yielding there can look like the export "stopped".
  // Only yield when the *target* document is visible.
  try {
    const doc = targetWindow?.document ?? document;
    if (doc.visibilityState !== "visible") return;
  } catch {
    // If we can't read visibility state, fall back to yielding.
  }

  // Race the target window's timer against our own. The `closed` check above cannot
  // cover a window that dies between it and the callback, and this yield sits in the
  // hot render loop — it must be structurally incapable of wedging.
  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      // `.call` matters: a cross-window setTimeout invoked unbound throws
      // "Illegal invocation" in Chromium.
      const host = targetWindow ?? window;
      (host.setTimeout ?? setTimeout).call(host, done, 0);
    } catch {
      /* fall through to the local timer below */
    }
    setTimeout(done, FE_YIELD_FALLBACK_MS);
  });
}

// ===========================================================================
// Archive Merge & Style Mirroring  (merge classes, computed style copy,
//                                   live-tree mirror, message style mirror)
// ===========================================================================

function feApplyChatMergeInWindow(win, renderProfile = null) {
  try {
    const logEl =
      win.document.getElementById("fe-chat-export-log") ||
      win.document.getElementById("chat-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    feSyncArchiveMergeBodyClasses(win.document);
    feApplyRenderedStateToLog(logEl, feArchiveMergeOptions());
    feRefreshPortraitsForLog(logEl, renderProfile);
  } catch (err) {
    console.warn("female_edition | feApplyChatMergeInWindow failed", err);
  }
}


// ===========================================================================
// Layout Normalization  (visibility, export node prep, shell/message layout,
//                        image output, font injection, image/font wait helpers)
// ===========================================================================

// Whisper detection for the archive's "exclude whispers" preference.
//
// This is deliberately NOT folded into feCanUserSeeChatMessage: that predicate answers
// "is this user allowed to see it", while this answers "does the user want it in the
// output". A GM passes the visibility check for every whisper in the world, so without
// this filter a GM-saved log carries every private conversation into a file that is
// usually made in order to be shared.
//
// `liveEl` is a fallback for the harvest-only path, where a rendered <li> may be all we
// have (no ChatMessage document). Both core and feFallbackRenderChatMessage put the
// `whisper` class on whispered messages.

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
    const clone = el.cloneNode(true);
    // Harvested nodes are detached immediately after this pass, so capture the
    // live sidebar's essential computed appearance now. Use the lean targeted
    // profile: it preserves the message shell, header/content, portraits,
    // cards, component sizes, custom variables, and live control state without
    // multiplying a full descendant-style tree across the entire history.
    feMirrorLiveMessageStyles(el, clone, {
      renderProfile: { lean: true, mirrorTree: false, mirrorCardTree: false },
    });
    return clone;
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
  // renderBatch prepends messages and changes the real `.chat-scroll` height.
  // Reuse the ordinary live-chat sticky-scroll contract so bottom-follow stays
  // pinned while a reader browsing older history keeps their current viewport.
  const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
  try {
    const chat = game?.messages?.directory || ui?.chat;
    const logs = feGetChatLogs?.() ?? [];
    if (!chat?.renderBatch || !logs.length) return { cloneMap, orderedIds };

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

      try {
        // A started renderBatch cannot be cancelled. Always let this one settle
        // before restoring sticky state; otherwise a timed-out batch can mutate
        // the log after the finally block and invalidate the restoration.
        await chat.renderBatch(batchSize);
      } catch {
        break;
      }
      if (timeBudgetMs > 0 && (Date.now() - startedAt) >= timeBudgetMs) {
        timedOut = true;
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
    // Always restore follow intent — even if an error interrupted the harvest loop.
    restoreStickyScroll();
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

  // Core parity — the message border color.
  //
  // `ChatMessage#renderHTML` (client/documents/chat-message.mjs:428) does exactly
  // one thing with it: `if (style === CHAT_MESSAGE_STYLES.OOC) borderColor =
  // author.color.css`. So ONLY OOC messages get the author's color; IC / emote /
  // roll keep the theme's `--chat-message-border-color` (#6f6c66). It reaches the
  // DOM as an inline `style="border-color:…"`, which means the live-clone and
  // core-render paths inherit it for free — and this fresh-build path was the only
  // one that dropped it, so OOC messages older than the sidebar's live DOM window
  // rendered gray in the archive while the recent ones were colored
  // ("이전 페이지들만 유저색 테두리가 없음"). Verified live: messages carrying the
  // `ic` class had no inline border-color, non-IC ones did.
  //
  // Do NOT widen this to every message — coloring IC borders too would make the
  // archive stop matching the live chat, which is the opposite of the point.
  try {
    const styles = CONST?.CHAT_MESSAGE_STYLES || CONST?.CHAT_MESSAGE_TYPES || {};
    if (Number(msg?.style ?? msg?.type ?? -1) === styles.OOC) {
      const author = msg?.author ?? msg?.user;
      const color = author?.color;
      const css = typeof color === "string" ? color : color?.css;
      if (css) li.style.borderColor = String(css);
    }
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
