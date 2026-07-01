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

function feCreateChatMessageOrderContext() {
  const byId = new Map();
  const byDoc = new WeakMap();
  try {
    const messages = game.messages?.contents;
    if (!Array.isArray(messages)) return { byId, byDoc };
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== "object") continue;
      byDoc.set(msg, i);
      if (msg.id) byId.set(String(msg.id), i);
      if (msg._id) byId.set(String(msg._id), i);
    }
  } catch {
    /* no-op */
  }
  return { byId, byDoc };
}

function feGetChatMessageElementOrder(el, fallback, orderContext = null) {
  try {
    const styleOrder = Number.parseFloat(el?.style?.order);
    if (Number.isFinite(styleOrder)) return styleOrder;

    const id = feGetMessageIdFromElement(el);
    const msg = id ? game.messages?.get?.(id) : null;
    if (msg && orderContext?.byDoc) {
      const idx = orderContext.byDoc.get(msg);
      if (Number.isFinite(idx)) return idx;
    }
    if (id && orderContext?.byId) {
      const idx = orderContext.byId.get(id);
      if (Number.isFinite(idx)) return idx;
    }
    if (!orderContext) {
      const messages = game.messages?.contents;
      if (msg && Array.isArray(messages)) {
        const idx = messages.indexOf(msg);
        if (idx >= 0) return idx;
      }
      if (id && Array.isArray(messages)) {
        const idx = messages.findIndex((m) => m?.id === id || m?._id === id);
        if (idx >= 0) return idx;
      }
    }
    const dataOrder = Number.parseFloat(el?.dataset?.order);
    if (Number.isFinite(dataOrder)) return dataOrder;

    const ts = Number(msg?.timestamp);
    if (Number.isFinite(ts)) return ts;
  } catch {
    /* no-op */
  }
  return fallback;
}

// v13 stored every open Application in ui.windows (numeric ids → app).
// v14 ApplicationV2 instances live in foundry.applications.instances (Map of id → app).
// Iterate BOTH so popped-out chat logs are found on either core version.
function feIterAllApps() {
  const out = [];
  try {
    for (const app of Object.values(ui?.windows ?? {})) if (app) out.push(app);
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

function feAppRootElement(app) {
  try {
    const el = app?.element;
    if (!el) return null;
    // jQuery wrapper (v1 Application)
    if (el.jquery && feIsElementNode(el[0])) return el[0];
    // Raw HTMLElement (ApplicationV2)
    if (feIsElementNode(el)) return el;
    if (feIsElementNode(el[0])) return el[0];
  } catch { /* no-op */ }
  return null;
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
    for (const app of feIterAllApps()) {
      const root = feAppRootElement(app);
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
  // Backslash-escape each non-identifier char. NOTE: the replacement must be
  // "\\$&" (backslash + matched char); "\$&" collapses to "$&" which returns the
  // char unescaped (a no-op). This fallback only runs when CSS.escape is absent.
  return String(value ?? "").replace(/[^a-zA-Z0-9_\-]/g, "\\$&");
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

// Follow-lock state. Foundry's app.isAtBottom is unreliable during rapid message
// bursts: content grows faster than the scroll catches up, so a scroll event mid-burst
// computes pct < 0.99 and flips #isAtBottom false even though the user never moved.
// Every re-pin is then blocked by the isAtBottom guard and the newest message gets
// stranded below the fold. We therefore track our OWN "following" intent: set when we
// observe/reach the bottom (kept alive across the burst), cleared only by a genuine
// user scroll-up (a scrollTop DECREASE that is not part of our own pin / prune churn).
const _feStickyFollowUntil = new WeakMap(); // scrollEl → timestamp through which we follow
const _feStickyLastTop     = new WeakMap(); // scrollEl → last observed scrollTop
const _feStickyPinTs       = new WeakMap(); // scrollEl → timestamp of our last programmatic pin
const _feStickyWatched     = new WeakSet(); // scrollEls that already have the user-scroll watcher
const FE_STICKY_FOLLOW_MS      = 1500;      // how long "following" persists after the last bottom contact
const FE_STICKY_PIN_IGNORE_MS  = 160;       // ignore scrollTop drops this soon after our own pin (prune clamp)

function _feStickyNow() { try { return performance.now(); } catch { return Date.now(); } }

// A scroll container inside a display:none subtree (the inactive sidebar tab —
// core CSS `.app.tab:not(.active,.sidebar-popout){display:none}`) reports
// scrollHeight/scrollTop/clientHeight all 0, so its pixel gap is a meaningless 0
// that masquerades as "at bottom". When hidden we must fall back to the persistent
// intent (app.isAtBottom) instead of trusting the gap, otherwise a reader who
// deliberately scrolled up before hiding the tab gets a fabricated follow window
// and is yanked to the bottom on return.
function _feElementVisible(el) {
  try { return !!el && el.offsetParent !== null && el.clientHeight > 0; }
  catch { return true; }
}

// Install a one-time scroll watcher that drops the follow-lock when the USER scrolls up.
// A scrollTop decrease that is NOT within the post-pin grace window is treated as a
// deliberate upward gesture (wheel, scrollbar drag, keys, touch — all covered).
function _feStickyEnsureWatcher(scrollEl) {
  try {
    if (!scrollEl || _feStickyWatched.has(scrollEl)) return;
    _feStickyWatched.add(scrollEl);
    _feStickyLastTop.set(scrollEl, scrollEl.scrollTop);
    scrollEl.addEventListener("scroll", () => {
      try {
        const cur = scrollEl.scrollTop;
        const last = _feStickyLastTop.get(scrollEl) ?? cur;
        _feStickyLastTop.set(scrollEl, cur);
        // Only treat a scrollTop DECREASE as a user scroll-up when it actually
        // moves us away from the bottom. A content shrink above the viewport (a
        // message deleted by another user, a merge re-collapse, a typing indicator
        // removed, an embed/image reflowing smaller) clamps scrollTop DOWN while
        // keeping us at the bottom (gap stays ~0) — that is NOT a user gesture and
        // must not drop the follow lock. A genuine upward gesture grows the gap
        // past the bottom band.
        const curGap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (cur < last - 4 && curGap > FE_STICKY_PIXEL_TOLERANCE_SAFETY
            && (_feStickyNow() - (_feStickyPinTs.get(scrollEl) ?? 0)) > FE_STICKY_PIN_IGNORE_MS) {
          _feStickyFollowUntil.set(scrollEl, 0); // user scrolled up → stop following
        }
      } catch { /* no-op */ }
    }, { passive: true });
  } catch { /* no-op */ }
}

// Resolve every live chat log <ol> → its owning ChatLog app (main, directory,
// and v13/v14 popouts). Shared by the snapshot/restore path and the
// incoming-message follow path.
function _feBuildChatLogAppMap() {
  const logToApp = new Map();
  const registerApp = (app) => {
    if (!app) return;
    try {
      const root = feAppRootElement(app);
      const appLog = root?.querySelector?.("ol.chat-log, #chat-log")
        ?? app.element?.querySelector?.("ol.chat-log, #chat-log");
      if (appLog && !logToApp.has(appLog)) logToApp.set(appLog, app);
    } catch { /* no-op */ }
  };
  registerApp(ui?.chat);
  registerApp(game?.messages?.directory);
  try {
    // ChatLog popouts on v13 (ui.windows) and v14 (foundry.applications.instances)
    // both expose scrollBottom() — that is our duck-type signal.
    for (const app of feIterAllApps()) {
      if (typeof app?.scrollBottom === "function") registerApp(app);
    }
  } catch { /* no-op */ }
  return logToApp;
}

// Pin a scroll container to the bottom and refresh all follow-lock bookkeeping
// so our own scroll watcher does not read this programmatic move as a user gesture.
function _feStickyPin(scrollEl, app) {
  // Set scrollTop on the actual scroll container (.chat-scroll in v13), not the
  // inner <ol> which is non-scrollable. scrollBottom() also nudges Foundry's
  // private #isAtBottom back to true after our DOM mutations.
  try { scrollEl.scrollTop = scrollEl.scrollHeight; } catch { /* no-op */ }
  try { app?.scrollBottom?.(); } catch { /* no-op */ }
  const t = _feStickyNow();
  _feStickyPinTs.set(scrollEl, t);
  _feStickyLastTop.set(scrollEl, scrollEl.scrollTop); // so the watcher doesn't read our pin as a user move
  _feStickyFollowUntil.set(scrollEl, t + FE_STICKY_FOLLOW_MS); // keep following while actively pinned
}

function feSnapshotAndRestoreStickyScroll() {
  const logToApp = _feBuildChatLogAppMap();

  const now = _feStickyNow();
  const states = feGetChatLogs().map((log) => {
    if (!feIsElementNode(log)) return null;
    const app = logToApp.get(log) ?? null;
    const scrollEl = feFindScrollContainer(log);
    _feStickyEnsureWatcher(scrollEl);
    // When the DOM-pruning ChatLog has forward-pruned its tail, the user is
    // deliberately browsing history — the DOM's bottom is NOT the newest message.
    // Never follow here; pinning would snap the reader back to the latest message.
    if (app?.isBrowsingHistory === true) {
      _feStickyFollowUntil.set(scrollEl, 0);
      return { log, scrollEl, follow: false, app };
    }
    // app.isAtBottom is Foundry's signal but it transiently (and during bursts,
    // stickily) reads false even when the user is following — see the follow-lock
    // note above. We OR it with a pixel-gap safety net for the at-bottom check, then
    // fall back to our own follow window so a burst doesn't strand the newest message.
    const pixelGap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    // While hidden (display:none) the gap is a meaningless 0 — trust only the
    // persistent intent so a scrolled-up reader is not later yanked to bottom.
    const atBottom = !_feElementVisible(scrollEl)
      ? (app?.isAtBottom === true)
      : ((app && typeof app.isAtBottom === "boolean")
          ? (app.isAtBottom || pixelGap <= FE_STICKY_PIXEL_TOLERANCE_SAFETY)
          : (pixelGap <= FE_STICKY_PIXEL_TOLERANCE));
    if (atBottom) _feStickyFollowUntil.set(scrollEl, now + FE_STICKY_FOLLOW_MS);
    const follow = atBottom || now < (_feStickyFollowUntil.get(scrollEl) ?? 0);
    return { log, scrollEl, follow, app };
  }).filter(Boolean);

  return function feRestoreStickyScroll() {
    for (const { scrollEl, follow, app } of states) {
      if (!follow) continue;
      const pin = () => _feStickyPin(scrollEl, app);
      pin();

      // Re-pin on the next frame to catch layout that settles AFTER our mutation
      // (merge-class reflow, follow-up render passes, pruning). Gate on the follow
      // window — the scroll watcher clears it the instant the user scrolls up, so a
      // genuine upward gesture aborts the re-pin (no "yanked back to bottom").
      const win = scrollEl.ownerDocument?.defaultView ?? window;
      const raf = win?.requestAnimationFrame ?? globalThis.requestAnimationFrame;
      if (typeof raf !== "function") continue;
      raf.call(win ?? globalThis, () => {
        try {
          if (app?.isBrowsingHistory === true) return;
          if (_feStickyNow() >= (_feStickyFollowUntil.get(scrollEl) ?? 0)) return; // user scrolled up
          const gap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
          if (gap > 0) pin();
        } catch { /* no-op */ }
      });
    }
  };
}

// Called from the `createChatMessage` hook — which fires BEFORE ChatLog#postOne
// renders and appends the new <li>. At this instant the scroll position still
// reflects the user's genuine intent (untouched by the incoming message), so a
// near-zero gap is the most reliable "user is following the bottom" signal we get.
//
// Why this exists in addition to the snapshot/restore path: core only auto-scrolls
// an incoming message from ANOTHER player when its cached `isAtBottom` is true
// (chat.mjs #postOne). While the user is interacting with another window (e.g. a
// character sheet) and not touching the chat, a prior async reflow (portrait image
// load, merge-class change) can have flipped core's #isAtBottom to false even though
// the user never moved — so core skips the scroll and the new message is stranded
// below the fold. We capture the pre-append bottom state ourselves and guarantee a
// re-pin after portrait injection / merge / late image reflow settle, each gated on
// the follow-lock so a genuine user scroll-up in the meantime cancels it.
function feFollowIncomingChatMessage() {
  try {
    const logToApp = _feBuildChatLogAppMap();
    const now = _feStickyNow();
    const followed = [];
    for (const log of feGetChatLogs()) {
      if (!feIsElementNode(log)) continue;
      const app = logToApp.get(log) ?? null;
      // fe-chat-prune.js defines isBrowsingHistory: true when the newest tail is
      // pruned AND the DOM bottom is NOT the true newest message. Following here
      // would yank a history-browsing reader down to the (incomplete) DOM bottom.
      if (app?.isBrowsingHistory === true) continue;
      const scrollEl = feFindScrollContainer(log);
      _feStickyEnsureWatcher(scrollEl);
      // While hidden the gap is a meaningless 0 → it would fabricate a follow
      // window even for a scrolled-up reader (who would then be yanked down on
      // tab return). When hidden, follow only if the persistent intent says so.
      const gap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
      const following = _feElementVisible(scrollEl)
        ? (gap <= FE_STICKY_PIXEL_TOLERANCE_SAFETY)
        : (app?.isAtBottom === true);
      if (following) {
        _feStickyFollowUntil.set(scrollEl, now + FE_STICKY_FOLLOW_MS);
        followed.push({ scrollEl, app });
      }
    }
    if (!followed.length) return;
    const pinAll = () => {
      for (const { scrollEl, app } of followed) {
        try {
          if (app?.isBrowsingHistory === true) continue; // history-browsing (pruned tail) → never hijack
          if (_feStickyNow() >= (_feStickyFollowUntil.get(scrollEl) ?? 0)) continue; // user scrolled up
          const gap = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
          if (gap > 0) _feStickyPin(scrollEl, app);
        } catch { /* no-op */ }
      }
    };
    // Staggered pins covering the full settle window: immediate, after the merge
    // RAF + full-merge debounce (~120ms), and after async portrait/image reflow.
    pinAll();
    setTimeout(pinAll, 130);
    setTimeout(pinAll, 280);
  } catch { /* no-op */ }
}

// Re-assert the bottom pin when the chat becomes VISIBLE again after being hidden,
// for readers who were following the bottom. While the chat sidebar tab is inactive
// it is `display:none` (core CSS: `.app.tab:not(.active,.sidebar-popout){display:none}`),
// so scroll measurements read 0 and core's scrollBottom() (scrollTop=0x7fffffbf) clamps
// to nothing — a message arriving meanwhile leaves the log scrolled-up on return, and
// core's `_onActivate` does NOT re-scroll. The user's at-bottom INTENT survives in core's
// persistent `app.isAtBottom` (only a real scroll event flips it, never a tab/visibility
// change), so we gate strictly on it (OR our own still-live follow window) — a reader who
// deliberately scrolled up has isAtBottom=false and is never yanked down. Deferred to the
// next frame because the `.active` class (hence layout) is applied AFTER the
// changeSidebarTab hook fires, so a synchronous read would still see the hidden element.
function feRepinFollowingChatLogs() {
  try {
    const logToApp = _feBuildChatLogAppMap();
    for (const log of feGetChatLogs()) {
      if (!feIsElementNode(log)) continue;
      const app = logToApp.get(log) ?? null;
      if (app?.isBrowsingHistory === true) continue;
      const scrollEl = feFindScrollContainer(log);
      _feStickyEnsureWatcher(scrollEl);
      const following = (app && app.isAtBottom === true)
        || (_feStickyNow() < (_feStickyFollowUntil.get(scrollEl) ?? 0));
      if (!following) continue;
      const win = scrollEl.ownerDocument?.defaultView ?? window;
      const raf = win?.requestAnimationFrame ?? globalThis.requestAnimationFrame;
      const doPin = () => {
        try {
          if (app?.isBrowsingHistory === true) return;
          // Re-check intent at fire time (the user might have scrolled up since).
          if (app && app.isAtBottom === false
              && _feStickyNow() >= (_feStickyFollowUntil.get(scrollEl) ?? 0)) return;
          _feStickyPin(scrollEl, app);
        } catch { /* no-op */ }
      };
      if (typeof raf === "function") raf.call(win ?? globalThis, doPin);
      else setTimeout(doPin, 0);
      setTimeout(doPin, 60); // safety net after the tab's layout/transition settles
    }
  } catch { /* no-op */ }
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
  feCreateChatMessageOrderContext,
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
  feFollowIncomingChatMessage,
  feRepinFollowingChatLogs,
  feGetRoundMarkerFlagValue,
  feLooksLikeRoundMarkerFlavor,
};
