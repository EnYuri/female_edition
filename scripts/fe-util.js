import { MODULE_ID, FE_MERGE_CLASS_LIST } from "./fe-constants.js";

function feIsElementNode(node) {
  return !!node && node.nodeType === 1;
}

function feExtractHTMLElement(html) {
  if (!html) return null;
  if (feIsElementNode(html)) return html;
  if (html.jquery && feIsElementNode(html[0])) return html[0];
  if (Array.isArray(html) && feIsElementNode(html[0])) return html[0];
  if (feIsElementNode(html[0])) return html[0];
  return null;
}

function feCreateElementFromHTML(doc, html) {
  try {
    const owner = doc ?? document;
    const tpl = owner.createElement("template");
    tpl.innerHTML = String(html ?? "").trim();
    return tpl.content?.firstElementChild ?? null;
  } catch {
    return null;
  }
}

function feEnsureStyleTag(id, cssText, doc = document) {
  let el = doc.getElementById(id);
  if (!el) {
    el = doc.createElement("style");
    el.id = id;
    doc.head?.appendChild(el);
  }
  el.textContent = String(cssText ?? "");
  return el;
}

function feNormalizeChatMessageId(id) {
  if (!id) return null;
  const s = String(id);
  return s.startsWith("ChatMessage.") ? s.slice("ChatMessage.".length) : s;
}

function feGetMessageIdFromElement(el) {
  const li = el?.closest?.("li.chat-message, #chat-notifications .message") ?? el;
  const id =
    li?.dataset?.messageId ||
    li?.dataset?.documentId ||
    li?.getAttribute?.("data-message-id") ||
    li?.getAttribute?.("data-document-id") ||
    null;
  return feNormalizeChatMessageId(id);
}

function feGetChatMessageElementOrder(el, fallback) {
  const raw = el.dataset.order ?? el.style.order;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function feGetChatLogs() {
  const logs = new Set();
  const scannedDocs = new Set();

  const collect = (root) => {
    try {
      const queryRoot = root?.querySelectorAll ? root : root?.document ?? null;
      if (!queryRoot || scannedDocs.has(queryRoot)) return;
      scannedDocs.add(queryRoot);
      queryRoot.querySelectorAll("ol.chat-log, #chat-log").forEach((el) => {
        if (feIsElementNode(el)) logs.add(el);
      });
    } catch {
      /* no-op */
    }
  };

  collect(document);

  try {
    for (const app of Object.values(ui?.windows ?? {})) {
      const root = app?.element?.[0] ?? app?.element ?? null;
      if (root) collect(root);
      const doc = root?.ownerDocument ?? app?.window?.document ?? null;
      if (doc && doc !== document) collect(doc);
    }
  } catch {
    /* no-op */
  }

  return Array.from(logs);
}

function feGetChatLogsInDocument(doc = document) {
  try {
    const rootDoc = doc?.querySelectorAll ? doc : document;
    const logs = new Set();
    rootDoc.querySelectorAll?.("ol.chat-log, #chat-log")?.forEach?.((el) => {
      if (feIsElementNode(el)) logs.add(el);
    });
    return Array.from(logs);
  } catch {
    return feGetChatLogs();
  }
}

function feDedupeChatMessagesInLog(logEl) {
  try {
    if (!logEl?.querySelectorAll) return;
    const seen = new Map();
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    for (const el of items) {
      const rawId = feGetMessageIdFromElement(el);
      const id = rawId ? feNormalizeChatMessageId(rawId) : null;
      if (!id) continue;
      const prev = seen.get(id);
      if (prev && prev !== el) {
        try { prev.remove(); } catch {}
      }
      seen.set(id, el);
    }
  } catch {
    /* no-op */
  }
}

function feBindMessageToElement(message, messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl);
    const li = el?.closest?.("li.chat-message, #chat-notifications .message") ?? (el?.matches?.("li.chat-message, #chat-notifications .message") ? el : null);
    if (!li || !message) return;
    li.__feMessage = message;
  } catch {
    /* no-op */
  }
}

function feIsNotificationMessageElement(messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl) ?? messageEl;
    if (!el) return false;
    if (el.matches?.("#chat-notifications > .message, #chat-notifications .message")) return true;
    return !!el.closest?.("#chat-notifications .message");
  } catch {
    return false;
  }
}

function feGetMessageFromElementOrCollection(elOrId) {
  try {
    if (elOrId && typeof elOrId === "object" && (elOrId.id || elOrId._id) && typeof elOrId.getFlag === "function") return elOrId;
    if (feIsElementNode(elOrId)) {
      const direct = elOrId.__feMessage || elOrId.closest?.("li.chat-message, #chat-notifications .message")?.__feMessage;
      if (direct) return direct;
      const id = feGetMessageIdFromElement(elOrId);
      return id ? game.messages?.get?.(id) ?? null : null;
    }
    const id = feNormalizeChatMessageId(elOrId);
    return id ? game.messages?.get?.(id) ?? null : null;
  } catch {
    return null;
  }
}

function feCssEscape(value) {
  try {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value ?? ""));
  } catch {
    /* no-op */
  }
  return String(value ?? "").replace(/[^a-zA-Z0-9_\-]/g, "\$&");
}

function feClampInt(value, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function feHasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function feValuesEqual(a, b) {
  try {
    if (Object.is(a, b)) return true;
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function feDeferTask(fn) {
  try {
    queueMicrotask(fn);
  } catch {
    Promise.resolve().then(fn);
  }
}

function feWindowRequestFrame(win, fn) {
  try {
    const w = win ?? window;
    if (typeof w?.requestAnimationFrame === "function") return w.requestAnimationFrame(fn);
  } catch {
    /* no-op */
  }
  return setTimeout(fn, 16);
}

function feWindowCancelFrame(win, handle) {
  try {
    const w = win ?? window;
    if (typeof w?.cancelAnimationFrame === "function") {
      w.cancelAnimationFrame(handle);
      return;
    }
  } catch {
    /* no-op */
  }
  clearTimeout(handle);
}

// Tight tolerance for unregistered logs (archive/detached): 2px so a small
// intentional scroll-up is not misclassified as "at bottom".
const FE_STICKY_PIXEL_TOLERANCE = 2;

// Looser tolerance used as a safety net when app.isAtBottom reads false but
// the scroll position is visually at the bottom. Third-party typing-indicator
// modules can shift scrollHeight by ~5-8px, flipping Foundry's #isAtBottom to
// false before the scroll event fires. 16px covers that range with margin.
const FE_STICKY_PIXEL_TOLERANCE_SAFETY = 16;

// In v13 the ChatLog DOM is:
//   <div class="chat-scroll">  ← actual scroll container (overflow-y: auto)
//     <ol class="chat-log">    ← non-scrollable; scrollHeight ≈ clientHeight
//   </div>
// feGetChatLogs() returns the inner <ol>, so any pixel-gap measurement on it
// is meaningless (always ~0). Walk up to find the real scroll container.
function feFindScrollContainer(el) {
  try {
    if (!feIsElementNode(el)) return el;
    const win = el.ownerDocument?.defaultView ?? globalThis;
    const direct = el.closest?.(".chat-scroll");
    if (direct) return direct;
    let cur = el.parentElement;
    const root = el.ownerDocument?.documentElement ?? null;
    while (cur && cur !== root) {
      // Either CSS opts the element into scrolling, or layout tells us it
      // does scroll. Either is sufficient evidence.
      const overflowY = win.getComputedStyle?.(cur)?.overflowY;
      if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return cur;
      if (cur.scrollHeight > cur.clientHeight + 1) return cur;
      cur = cur.parentElement;
    }
  } catch { /* no-op */ }
  return el;
}

function feSnapshotAndRestoreStickyScroll() {
  const logToApp = new Map();
  const registerApp = (app) => {
    if (!app) return;
    try {
      const root = app.element?.[0] ?? app.element ?? null;
      const appLog = root?.querySelector?.("ol.chat-log, #chat-log")
        ?? app.element?.querySelector?.("ol.chat-log, #chat-log");
      if (appLog && !logToApp.has(appLog)) logToApp.set(appLog, app);
    } catch { /* no-op */ }
  };
  registerApp(ui?.chat);
  registerApp(game?.messages?.directory);
  try {
    for (const app of Object.values(ui?.windows ?? {})) {
      if (!app) continue;
      // ChatLog popouts expose scrollBottom() — that is our duck-type signal.
      if (typeof app.scrollBottom === "function") registerApp(app);
    }
  } catch { /* no-op */ }

  const states = feGetChatLogs().map((log) => {
    if (!feIsElementNode(log)) return null;
    const app = logToApp.get(log) ?? null;
    const scrollEl = feFindScrollContainer(log);
    // app.isAtBottom is the primary signal (Foundry updates it synchronously in
    // _onScrollLog). However it can transiently read false between a DOM resize
    // and the next scroll event — so pixel-gap ≤ 2px acts as a safety net for
    // that race window. For unregistered logs (archive/detached) only the
    // pixel-gap path below is used.
    const pixelGap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    if (app && typeof app.isAtBottom === "boolean") {
      return { log, scrollEl, atBottom: app.isAtBottom || pixelGap <= FE_STICKY_PIXEL_TOLERANCE_SAFETY, app };
    }
    return { log, scrollEl, atBottom: pixelGap <= FE_STICKY_PIXEL_TOLERANCE, app };
  }).filter(Boolean);

  return function feRestoreStickyScroll() {
    for (const { scrollEl, atBottom, app } of states) {
      if (!atBottom) continue;
      // Set scrollTop on the actual scroll container (.chat-scroll in v13),
      // not the inner <ol> which is non-scrollable.
      try { scrollEl.scrollTop = scrollEl.scrollHeight; } catch { /* no-op */ }
      // v13 ChatLog tracks sticky state in a real ES private (#isAtBottom).
      // The public scrollBottom() method is the only supported way to nudge
      // Foundry's internal flag back to "at bottom" after our DOM mutations.
      try { app?.scrollBottom?.(); } catch { /* no-op */ }
    }
  };
}

function feGetRoundMarkerFlagValue(source) {
  try {
    const flags = source?.flags ?? source ?? {};
    const namespaces = ["monks-combat-details", "monks-little-details", MODULE_ID];
    const directCandidates = [
      "roundmarker", "roundMarker", "round-message", "roundMessage",
      "roundmessage", "combatRoundMessage", "combatroundmessage", "isRoundMarker",
    ];

    for (const ns of namespaces) {
      const data = flags?.[ns];
      if (!data || typeof data !== "object") continue;
      for (const key of directCandidates) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) continue;
        const value = data[key];
        if (value === true || String(value) === "true") return true;
        if (value && typeof value !== "object") return value;
      }
      for (const [key, value] of Object.entries(data)) {
        if (!/round[-_ ]?(?:marker|message)|combat[-_ ]?round/i.test(String(key))) continue;
        if (value === true || String(value) === "true") return true;
        if (value && typeof value !== "object") return value;
      }
    }
  } catch {
    /* no-op */
  }
  return null;
}

function feLooksLikeRoundMarkerFlavor(flavor = "", content = "") {
  try {
    const f = String(flavor ?? "").replace(/\s+/g, " ").trim();
    if (f && /^(?:round\s*(?:start|end|\d+)|start of round|end of round|combat\s*round\s*\d+|라운드\s*(?:시작|종료|끝|\d+)|전투\s*라운드\s*\d+)/i.test(f)) {
      return true;
    }
  } catch {
    /* no-op */
  }
  try {
    const c = String(content ?? "");
    if (/<[^>]*\bround-marker\b/i.test(c)) return true;
  } catch {
    /* no-op */
  }
  return false;
}

export {
  feIsElementNode,
  feExtractHTMLElement,
  feCreateElementFromHTML,
  feEnsureStyleTag,
  feNormalizeChatMessageId,
  feGetMessageIdFromElement,
  feGetChatMessageElementOrder,
  feGetChatLogs,
  feGetChatLogsInDocument,
  feDedupeChatMessagesInLog,
  feBindMessageToElement,
  feIsNotificationMessageElement,
  feGetMessageFromElementOrCollection,
  feCssEscape,
  feClampInt,
  feHasOwn,
  feValuesEqual,
  feDeferTask,
  feWindowRequestFrame,
  feWindowCancelFrame,
  feSnapshotAndRestoreStickyScroll,
  feGetRoundMarkerFlagValue,
  feLooksLikeRoundMarkerFlavor,
};
