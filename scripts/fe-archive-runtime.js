// Archive runtime primitives for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Holds the things every other archive module
// needs and that depend on nothing of ours but `fe-archive-output.js`'s element
// guard: the render/wait tuning constants, the cooperative-yield scheduler, the
// popup liveness check, the chunked post-render sweep, Electron detection, and
// the node-coercion/identity helpers.
//
// Deliberately NOT here: the launch lock (`feArchiveLaunchInProgress` and
// friends). Those are mutable module state that only the entry module assigns,
// and an imported binding cannot be assigned to.

import { feIsElement } from "./fe-archive-output.js";

export const FE_EXPORT_RENDER_BATCH = 64;
export const FE_EXPORT_RENDER_CONCURRENCY = 6;
export const FE_EXPORT_STATUS_EVERY = 25;
export const FE_EXPORT_WAIT_IMAGES_MAX = 800;
export const FE_EXPORT_WAIT_IMAGES_TIMEOUT = 20000;
export const FE_EXPORT_INLINE_WAIT_IMAGES_TIMEOUT = 15000;
export const FE_EXPORT_WAIT_FONTS_TIMEOUT = 12000;
// Ceiling on the two-paint-frame settle before win.print(). Generous next to the
// ~33 ms two frames actually take when the popup is in front, and the only thing
// standing between the user and a minute-plus hang when it is not — a hidden window
// gets no rAF at all. See the comment at the await for the measurement.
export const FE_EXPORT_PAINT_FRAME_TIMEOUT = 400;
export const FE_EXPORT_PORTRAIT_MARKER_SELECTOR = 'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container';
export const FE_ARCHIVE_LARGE_LOG_THRESHOLD = 1200;
export const FE_ARCHIVE_HUGE_LOG_THRESHOLD = 2600;
export const FE_EXPORT_RENDER_BATCH_LARGE = 40;
export const FE_EXPORT_RENDER_BATCH_HUGE = 24;
export const FE_EXPORT_RENDER_CONCURRENCY_LARGE = 4;
export const FE_EXPORT_RENDER_CONCURRENCY_HUGE = 2;
export const FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE = 40;
export const FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE = 16;
export const FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT = 4500;
export const FE_ARCHIVE_HARVEST_TIMEOUT_LARGE = 2500;
export const FE_ARCHIVE_HARVEST_TIMEOUT_HUGE = 1200;

// Chunk size for the post-render sweeps below. Measured on v14.365 with a
// 2,938-message dx3rd log: the portrait sweep costs ~0.77 ms per message (a
// 150-message chunk measured 110-130 ms, i.e. still several dropped frames), so
// the chunk is sized from the measurement rather than from a round number. The
// yield itself is a MessageChannel round-trip, so ~50 extra chunks cost nothing
// worth measuring — do not raise this back for "fewer yields".
const FE_ARCHIVE_POST_PASS_CHUNK = 60;

/**
 * Run a per-message sweep over the whole archive log in yielding chunks.
 *
 * MUST keep the yields (measured, v14.365, 2,938 messages). The post-render
 * sweeps — texture strip, portrait upsert, layout normalize — ran back to back
 * with no await between them, so they coalesced into ONE ~4,000 ms `longtask`.
 * The archive popup and Foundry share an event loop, so for those seconds
 * NEITHER window responded to a click; that is the whole of the reported
 * "아카이브 렌더 직후 클릭이 지연된다". The work itself is irreducible (every
 * message really does need each pass) — what was wrong was doing it in one
 * uninterruptible block.
 * @param {Window} win
 * @param {Element[]} nodes
 * @param {(batch: Element[]) => void} fn
 */
export async function feRunArchiveChunkedPass(win, nodes, fn) {
  if (!Array.isArray(nodes) || !nodes.length) return;
  for (let i = 0; i < nodes.length; i += FE_ARCHIVE_POST_PASS_CHUNK) {
    // Same reason feRenderMessagesIntoLog bails at its batch boundary: the user
    // can close the popup mid-sweep, and every remaining chunk would then style
    // nodes in a dead document — with a MessageChannel yield between each one.
    if (feArchiveWindowClosed(win)) return;
    try {
      fn(nodes.slice(i, i + FE_ARCHIVE_POST_PASS_CHUNK));
    } catch {
      /* one bad batch must not abort the remaining log */
    }
    await feMaybeYieldForUI(win);
  }
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

export function feStampArchiveMessageIdentity(node, msg) {
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

export async function feTryFoundryRenderMessage(msg) {
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
// Platform Utilities  (Electron detection)
// ===========================================================================

export function feIsElectron() {
  try {
    if (window?.process?.versions?.electron) return true;
  } catch {}
  try {
    const ua = String(navigator?.userAgent ?? "");
    if (ua.includes("Electron")) return true;
  } catch {}
  return false;
}

/**
 * True when `win` is a popup we opened that the user has since closed.
 *
 * Returns false for the main window (the in-document fallback path passes it as the
 * render target, and `window.closed` is false there anyway) and false when the check
 * itself is not possible — "unknown" must never read as "gone".
 */
export function feArchiveWindowClosed(win) {
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
// Backstop only, for a hidden window whose MessageChannel yield somehow never lands.
// Chromium clamps a hidden window's timers to >=1000 ms, so anything below that is
// indistinguishable from 1000 — do not "tighten" it, it would just spin.
const FE_YIELD_HIDDEN_FALLBACK_MS = 1000;

export async function feMaybeYieldForUI(targetWindow = window) {
  // A CLOSED window's timers NEVER FIRE. This used to `await` one unconditionally, so
  // closing the archive popup mid-render hung feRenderMessagesIntoLog forever — the
  // export promise never settled, feExportChatLogToPDF's `finally` never ran, and
  // `feArchiveLaunchInProgress` stayed true for the rest of the session. That is the
  // reported "아직 렌더 중" that no longer clears. Bail out before scheduling anything.
  if (feArchiveWindowClosed(targetWindow)) return;

  // MUST keep yielding even when the target document is HIDDEN.
  //
  // This used to `return` early on `visibilityState !== "visible"`, to stop a
  // background window's clamped timers from making the export look stopped. The
  // cure was worse: with no yield at all, the whole remaining render runs in ONE
  // uninterrupted synchronous burst. The popup shares its event loop with the
  // Foundry window that is driving the render, so alt-tabbing away from a 3000
  // message archive freezes BOTH windows solid until it finishes — the reported
  // "알탭 하면 아예 뻗는다". Under ~1200 messages it was short enough to pass for
  // normal slowness, which is why it surfaced only on a very large log.
  //
  // MessageChannel is the fix for the original problem too: a port message is an
  // ordinary task, NOT a timer, so Chromium's background clamp (>=1000 ms for
  // setTimeout in a hidden tab) does not apply to it. A hidden window therefore
  // keeps draining at full speed AND stays interruptible.
  const hidden = (() => {
    try {
      return (targetWindow?.document ?? document).visibilityState !== "visible";
    } catch {
      return false;
    }
  })();

  // Race every available scheduler. The `closed` check above cannot cover a window
  // that dies between it and the callback, and this yield sits in the hot render
  // loop — it must be structurally incapable of wedging.
  await new Promise((resolve) => {
    let settled = false;
    let port = null;
    const done = () => {
      if (settled) return;
      settled = true;
      try { port?.close?.(); } catch {}
      resolve();
    };

    const host = targetWindow ?? window;
    try {
      const Channel = host.MessageChannel ?? MessageChannel;
      const ch = new Channel();
      port = ch.port1;
      ch.port1.onmessage = done;
      ch.port1.start?.();
      ch.port2.postMessage(0);
    } catch {
      /* fall through to the timers below */
    }

    try {
      // `.call` matters: a cross-window setTimeout invoked unbound throws
      // "Illegal invocation" in Chromium.
      (host.setTimeout ?? setTimeout).call(host, done, 0);
    } catch {
      /* fall through to the local timer below */
    }
    // While hidden, the local timer is clamped too — it is only a backstop here,
    // and the MessageChannel task above is what actually settles this promise.
    setTimeout(done, hidden ? FE_YIELD_HIDDEN_FALLBACK_MS : FE_YIELD_FALLBACK_MS);
  });
}
