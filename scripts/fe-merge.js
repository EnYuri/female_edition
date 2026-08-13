import { S, FE_MERGE_CLASS_LIST, FE_MERGE_CLASS_SORTED } from "./fe-constants.js";
import {
  feIsElementNode, feExtractHTMLElement, feIsNotificationMessageElement,
  feGetChatLogs, feGetMessageIdFromElement, feGetMessageFromElementOrCollection,
  feBindMessageToElement, feCreateChatMessageOrderContext, feGetChatMessageElementOrder, feDedupeChatMessagesInLog,
  feSnapshotAndRestoreStickyScroll,
} from "./fe-util.js";
import { feSetting } from "./fe-gm-priority.js";
import {
  feMessageMergeInfo, feMergeKey, feCanMergePair,
  feApplyUserColorBgToLog,
  feUserColorBgFeatureActive,
} from "./fe-render-state.js";

// -------------------------------------
// Merge class management
// -------------------------------------

const feMergeClassSignatureCache = new WeakMap();

function feBuildMergeClassSignature(desiredSet) {
  if (!desiredSet || !desiredSet.size) return "";
  let sig = "";
  for (const cls of FE_MERGE_CLASS_SORTED) {
    if (desiredSet.has(cls)) sig += (sig ? "|" : "") + cls;
  }
  return sig;
}

function feApplyMergeClassSetToElement(el, desired = null) {
  try {
    if (!el?.classList) return;
    const signature = feBuildMergeClassSignature(desired);
    const cached = feMergeClassSignatureCache.get(el) ?? null;
    if (cached === signature) return;
    for (const cls of FE_MERGE_CLASS_LIST) {
      const shouldHave = desired ? desired.has(cls) : false;
      if (shouldHave) el.classList.add(cls);
      else el.classList.remove(cls);
    }
    feMergeClassSignatureCache.set(el, signature);
    try {
      if (signature) el.dataset.feMergeSig = signature;
      else delete el.dataset.feMergeSig;
    } catch {
      /* no-op */
    }
  } catch {
    /* no-op */
  }
}

function feClearMergeClassesFromMessageElement(messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl) ?? messageEl;
    const root = el?.closest?.("#chat-notifications .message, li.chat-message") ?? (el?.matches?.("#chat-notifications .message, li.chat-message") ? el : null);
    if (!root?.classList) return;
    for (const cls of FE_MERGE_CLASS_LIST) root.classList.remove(cls);
    feMergeClassSignatureCache?.delete?.(root);
    try { delete root.dataset.feMergeSig; } catch {
      /* no-op */
    }
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// Pruned-window edge lookahead
//
// Merge classification can only see `li.chat-message` elements that are IN THE
// DOM, and fe-chat-prune.js keeps the live log to a window (cePruneMaxMessages).
// So the newest element in that window can never be a group START and the oldest
// can never be a MID/END, even when the neighbour that would make it one is
// sitting right there in `game.messages`.
//
// Measured live 2026-08-13 (v14.365, 2,936-message world, window 2861-2897 after
// scrolling up): messages 2897/2898/2899 are one 3-message group, and while 2898
// was pruned out the live sidebar rendered 2897 as unmerged while the archive —
// which holds the full range — rendered it `fe-merge-start`. 36/37 overlapping
// messages agreed; that ONE was the whole disagreement. Scrolling back down
// restored it, i.e. the miss is purely "the neighbour is not in the DOM".
//
// This resolves the edge by asking the collection for the neighbour and, if it
// would merge, marking the edge element as a CONTINUATION.
//
// OFF BY DEFAULT, and it must stay that way. `feApplyChatMerge` is shared with
// the ARCHIVE, whose log is a deliberately truncated range the user picked. A
// continuation class there would hide the first message's header and fuse its
// border to something the file does not contain. `feIsExportLogElement` is a
// second, independent guard for the same reason — do not remove either.
// -------------------------------------

// The neighbour scan skips messages this user cannot see (they were never in the
// DOM to begin with). The cap only bounds a pathological run of hidden messages;
// a real gap is one or two.
const FE_EDGE_LOOKAHEAD_SCAN_LIMIT = 50;

function feIsExportLogElement(logEl) {
  try {
    if (logEl?.id === "fe-chat-export-log") return true;
    if (logEl?.closest?.("#fe-chat-export-container")) return true;
    const body = logEl?.ownerDocument?.body;
    return !!(
      body?.classList?.contains?.("fe-chat-archive") ||
      body?.classList?.contains?.("fe-print-chatlog")
    );
  } catch {
    return false;
  }
}

// Built from the document alone (`el` is null) — the neighbour has no element by
// definition. Every classifier feMessageMergeInfo uses is optional-chained on the
// element, so the raw `content` drives hasChatCard/hasDice. That can differ from
// what the RENDERED element would have reported for content whose card markup is
// only produced by enrichment; the cost of being wrong is one edge element that
// looks merged until the neighbour actually loads, which is strictly better than
// today's guaranteed miss.
function feBuildEdgeNeighborInfo(msg, speakerBasis) {
  try {
    if (!msg) return null;
    const info = feMessageMergeInfo(msg, null);
    if (!info) return null;
    info.key = info.key || feMergeKey(info, speakerBasis);
    return info;
  } catch {
    return null;
  }
}

function feFindEdgeNeighborInfo(edgeInfo, direction, { presentIds, speakerBasis, orderContext } = {}) {
  try {
    const contents = game.messages?.contents;
    if (!Array.isArray(contents) || !contents.length) return null;
    const rawId = edgeInfo?.msgId != null ? String(edgeInfo.msgId) : "";
    const idx = rawId ? orderContext?.byId?.get?.(rawId) : undefined;
    if (!Number.isFinite(idx)) return null;

    for (let step = 1; step <= FE_EDGE_LOOKAHEAD_SCAN_LIMIT; step += 1) {
      const probe = idx + (direction * step);
      if (probe < 0 || probe >= contents.length) return null;
      const msg = contents[probe];
      if (!msg) continue;
      // Not visible to this user → core never renders it, so it is not a gap.
      if (msg.visible === false) continue;
      // Already in this log → the log is NOT truncated at this edge, and the
      // grouping we just computed is already authoritative. Take no action.
      if (presentIds?.has?.(String(msg.id))) return null;
      return feBuildEdgeNeighborInfo(msg, speakerBasis);
    }
    return null;
  } catch {
    return null;
  }
}

function feResolveEdgeNeighbors(logEl, infos, { edgeLookahead, speakerBasis, orderContext }) {
  const none = { headNeighbor: null, tailNeighbor: null };
  try {
    if (!edgeLookahead) return none;
    if (!Array.isArray(infos) || !infos.length) return none;
    if (feIsExportLogElement(logEl)) return none;

    const presentIds = new Set();
    for (const info of infos) {
      if (info?.msgId != null) presentIds.add(String(info.msgId));
    }
    const ctx = { presentIds, speakerBasis, orderContext };
    return {
      headNeighbor: feFindEdgeNeighborInfo(infos[0], -1, ctx),
      tailNeighbor: feFindEdgeNeighborInfo(infos[infos.length - 1], 1, ctx),
    };
  } catch {
    return none;
  }
}

// -------------------------------------
// Merge application
// -------------------------------------

function feCollectMergeNeighborhood(logEl, anchorEl, { allowNarratorMerge = false, edgeLookahead = false } = {}) {
  try {
    if (!feIsElementNode(logEl) || !feIsElementNode(anchorEl)) return { slice: [], firstIndex: 0, total: 0, headNeighbor: null, tailNeighbor: null, hasMissingDocs: false };
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    if (!items.length) return { slice: [], firstIndex: 0, total: 0, headNeighbor: null, tailNeighbor: null, hasMissingDocs: false };

    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const speakerBasis = String(feSetting(S.MERGE_SPEAKER_BASIS) ?? "token");
    const orderContext = feCreateChatMessageOrderContext();
    const makeInfo = (el, fallbackIndex = 0) => {
      const msgId = feGetMessageIdFromElement(el);
      const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game.messages?.get?.(msgId) : null);
      if (msg) feBindMessageToElement(msg, el);
      const info = feMessageMergeInfo(msg, el) ?? {};
      const hasStampedKey = !!info?.key;
      info.msgId = msgId;
      info.missing = !msg && !hasStampedKey;
      info.el = el;
      info.domIndex = fallbackIndex;
      info.order = feGetChatMessageElementOrder(el, fallbackIndex, orderContext);
      info.key = info.key || (msg ? feMergeKey(info, speakerBasis) : `__fe_missing__||${msgId ?? fallbackIndex}`);
      if (!msg && !hasStampedKey) info.mergeableText = false;
      return info;
    };
    const canMerge = (a, b) => feCanMergePair(a, b, { onlyText, allowNarratorMerge });

    const infos = items
      .map((el, i) => makeInfo(el, i))
      .sort((a, b) => {
        const ao = Number.isFinite(a?.order) ? a.order : a?.domIndex ?? 0;
        const bo = Number.isFinite(b?.order) ? b.order : b?.domIndex ?? 0;
        if (ao !== bo) return ao - bo;
        return (a?.domIndex ?? 0) - (b?.domIndex ?? 0);
      });

    const idx = infos.findIndex((info) => info?.el === anchorEl);
    if (idx === -1) return { slice: [], firstIndex: 0, hasMissingDocs: false };

    let start = idx;
    let end = idx;
    while (start > 0 && canMerge(infos[start - 1], infos[start])) start -= 1;
    while (end < infos.length - 1 && canMerge(infos[end], infos[end + 1])) end += 1;

    if (start > 0) {
      start -= 1;
      while (start > 0 && canMerge(infos[start - 1], infos[start])) start -= 1;
    }
    if (end < infos.length - 1) {
      end += 1;
      while (end < infos.length - 1 && canMerge(infos[end], infos[end + 1])) end += 1;
    }

    const slice = infos.slice(start, end + 1);
    const { headNeighbor, tailNeighbor } = feResolveEdgeNeighbors(logEl, infos, {
      edgeLookahead, speakerBasis, orderContext,
    });
    return {
      slice,
      firstIndex: start,
      total: infos.length,
      headNeighbor,
      tailNeighbor,
      hasMissingDocs: slice.some((info) => !!info?.missing),
    };
  } catch {
    return { slice: [], firstIndex: 0, total: 0, headNeighbor: null, tailNeighbor: null, hasMissingDocs: false };
  }
}

function feApplyChatMergeSlice(infos, startOffset = 0, {
  allowNarratorMerge = false, headNeighbor = null, tailNeighbor = null, total = 0,
} = {}) {
  try {
    if (!Array.isArray(infos) || !infos.length) return;
    const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
    const showDivider = !!feSetting(S.MERGE_DIVIDER);
    const mergeMode = String(feSetting(S.MERGE_MODE) ?? "standard");
    const simpleMode = mergeMode === "simple";
    const canMerge = (a, b) => feCanMergePair(a, b, { onlyText, allowNarratorMerge });

    const desiredMap = new Map();
    for (const info of infos) {
      if (info?.el) desiredMap.set(info.el, new Set());
    }
    const mark = (el, cls) => {
      const set = desiredMap.get(el);
      if (set) set.add(cls);
    };

    const totalCount = Number(total) || 0;
    const applyGroup = (startIndex, endIndexExclusive) => {
      const groupLen = endIndexExclusive - startIndex;
      if (groupLen <= 0) return;
      const first = infos[startIndex];
      if (!first?.el) return;
      const last = infos[endIndexExclusive - 1];
      // Only the group that touches the LOG's own edge can be a continuation —
      // startOffset maps this slice back onto the full log.
      const continuesBefore = (startOffset + startIndex) === 0
        && !!headNeighbor && canMerge(headNeighbor, first);
      const continuesAfter = totalCount > 0
        && (startOffset + endIndexExclusive) === totalCount
        && !!tailNeighbor && canMerge(last, tailNeighbor);
      if (showDivider && (startOffset + startIndex) > 0) mark(first.el, "fe-divider-before");
      if (groupLen === 1 && !continuesBefore && !continuesAfter) return;
      if (simpleMode) {
        // A continuation makes the in-window first element a FOLLOW, not a head.
        for (let i = continuesBefore ? startIndex : startIndex + 1; i < endIndexExclusive; i += 1) {
          mark(infos[i]?.el, "fe-merge-follow");
        }
        return;
      }
      if (groupLen === 1) {
        if (continuesBefore && continuesAfter) mark(first.el, "fe-merge-mid");
        else if (continuesBefore) mark(first.el, "fe-merge-end");
        else mark(first.el, "fe-merge-start");
        return;
      }
      mark(first.el, continuesBefore ? "fe-merge-mid" : "fe-merge-start");
      for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
      mark(last?.el, continuesAfter ? "fe-merge-mid" : "fe-merge-end");
    };
    let groupStart = 0;
    for (let i = 1; i < infos.length; i += 1) {
      if (!canMerge(infos[i - 1], infos[i])) {
        applyGroup(groupStart, i);
        groupStart = i;
      }
    }
    applyGroup(groupStart, infos.length);

    for (const info of infos) feApplyMergeClassSetToElement(info?.el, desiredMap.get(info?.el) ?? null);
  } catch {
    /* no-op */
  }
}

function feApplyChatMergeAroundElement(messageEl, { allowNarratorMerge = false, skipDedup = false, edgeLookahead = false } = {}) {
  try {
    if (feIsNotificationMessageElement(messageEl)) {
      feClearMergeClassesFromMessageElement(messageEl);
      return;
    }
    const anchor = messageEl?.closest?.("li.chat-message") ?? messageEl;
    const log = anchor?.closest?.("ol.chat-log, #chat-log, #fe-chat-export-log");
    if (!feIsElementNode(anchor) || !feIsElementNode(log)) return;
    if (!skipDedup) { try { feDedupeChatMessagesInLog(log); } catch {} }
    const neighborhood = feCollectMergeNeighborhood(log, anchor, { allowNarratorMerge, edgeLookahead });
    const slice = neighborhood?.slice ?? [];
    if (!slice.length) return;
    feApplyChatMergeSlice(slice, Math.max(0, Number(neighborhood?.firstIndex) || 0), {
      allowNarratorMerge,
      headNeighbor: neighborhood?.headNeighbor ?? null,
      tailNeighbor: neighborhood?.tailNeighbor ?? null,
      total: neighborhood?.total ?? 0,
    });
    if (neighborhood?.hasMissingDocs) feScheduleRenderedLogRefreshForMerge(log, { delay: 48, allowNarratorMerge, edgeLookahead });
  } catch {
    /* no-op */
  }
}

function feApplyChatMerge(logEl, { allowNarratorMerge = false, preNodes = null, edgeLookahead = false } = {}) {
  if (!feIsElementNode(logEl)) return;
  try { feDedupeChatMessagesInLog(logEl); } catch {}

  const msgs = Array.isArray(preNodes) && preNodes.length > 0
    ? preNodes
    : Array.from(logEl.querySelectorAll("li.chat-message"));

  const applyDesiredClasses = (desiredMap) => {
    for (const el of msgs) {
      const desired = desiredMap.get(el) ?? null;
      feApplyMergeClassSetToElement(el, desired);
    }
  };

  const mergeEnabled = !!feSetting(S.MERGE_ENABLED);
  if (!mergeEnabled || !msgs.length) {
    applyDesiredClasses(new Map());
    return;
  }

  const onlyText = !!feSetting(S.MERGE_ONLY_TEXT);
  const showDivider = !!feSetting(S.MERGE_DIVIDER);
  const mergeMode = String(feSetting(S.MERGE_MODE) ?? "standard");
  const simpleMode = mergeMode === "simple";
  const speakerBasis = String(feSetting(S.MERGE_SPEAKER_BASIS) ?? "token");
  const orderContext = feCreateChatMessageOrderContext();

  const infos = [];
  let idx = 0;
  for (const el of msgs) {
    const msgId = feGetMessageIdFromElement(el);
    const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game.messages?.get?.(msgId) : null);
    const info = feMessageMergeInfo(msg, el);
    infos.push({
      ...info,
      msgId,
      missing: !msg && !info?.key,
      el,
      idx,
      order: feGetChatMessageElementOrder(el, idx, orderContext),
    });
    idx += 1;
  }

  infos.sort((a, b) => {
    const ao = Number.isFinite(a?.order) ? a.order : a?.idx ?? 0;
    const bo = Number.isFinite(b?.order) ? b.order : b?.idx ?? 0;
    if (ao !== bo) return ao - bo;
    return (a?.idx ?? 0) - (b?.idx ?? 0);
  });

  let hasMissingDocs = false;
  for (const info of infos) {
    if (info.key) continue;
    if (!info.msgId || info.missing) {
      hasMissingDocs = true;
      info.key = `__fe_missing__||${info.msgId ?? info.idx}`;
      info.mergeableText = false;
      continue;
    }
    info.key = feMergeKey(info, speakerBasis);
  }
  if (hasMissingDocs) feScheduleMergeRetry(logEl, 80, { edgeLookahead });

  const canMerge = (a, b) => feCanMergePair(a, b, { onlyText, allowNarratorMerge });

  // Resolved AFTER the keys above — the neighbour is compared against a fully
  // keyed edge info, never a half-built one.
  const { headNeighbor, tailNeighbor } = feResolveEdgeNeighbors(logEl, infos, {
    edgeLookahead, speakerBasis, orderContext,
  });

  const desiredMap = new Map();
  for (const info of infos) desiredMap.set(info.el, new Set());

  const mark = (el, cls) => {
    const set = desiredMap.get(el);
    if (set) set.add(cls);
  };

  const applyGroup = (startIndex, endIndexExclusive) => {
    const groupLen = endIndexExclusive - startIndex;
    if (groupLen <= 0) return;
    const first = infos[startIndex];
    if (!first?.el) return;
    const last = infos[endIndexExclusive - 1];
    // Only the log's own first/last group can continue outside the DOM window.
    const continuesBefore = startIndex === 0 && !!headNeighbor && canMerge(headNeighbor, first);
    const continuesAfter = endIndexExclusive === infos.length && !!tailNeighbor && canMerge(last, tailNeighbor);
    if (showDivider && startIndex > 0) mark(first.el, "fe-divider-before");
    if (groupLen === 1 && !continuesBefore && !continuesAfter) return;
    if (simpleMode) {
      // A continuation makes the in-window first element a FOLLOW, not a head.
      for (let i = continuesBefore ? startIndex : startIndex + 1; i < endIndexExclusive; i += 1) {
        mark(infos[i]?.el, "fe-merge-follow");
      }
      return;
    }
    if (groupLen === 1) {
      if (continuesBefore && continuesAfter) mark(first.el, "fe-merge-mid");
      else if (continuesBefore) mark(first.el, "fe-merge-end");
      else mark(first.el, "fe-merge-start");
      return;
    }
    mark(first.el, continuesBefore ? "fe-merge-mid" : "fe-merge-start");
    for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
    mark(last?.el, continuesAfter ? "fe-merge-mid" : "fe-merge-end");
  };

  let groupStart = 0;
  for (let i = 1; i < infos.length; i += 1) {
    if (!canMerge(infos[i - 1], infos[i])) {
      applyGroup(groupStart, i);
      groupStart = i;
    }
  }
  applyGroup(groupStart, infos.length);

  applyDesiredClasses(desiredMap);
}

function feApplyChatMergeToAllLogs() {
  const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
  try {
    for (const log of feGetChatLogs()) {
      // Live logs only — feGetChatLogs also reaches the INLINE export container
      // (`#fe-chat-export-container` is built inside the main document by
      // feExportChatLogToPDFInline), which feIsExportLogElement then rejects.
      feApplyChatMerge(log, { edgeLookahead: true });
    }
  } finally {
    restoreStickyScroll();
  }
}

function fePreApplyMergeHint(message, el) {
  try {
    if (!feSetting(S.MERGE_ENABLED)) return;
    if (!feIsElementNode(el)) return;

    const thisInfo = feMessageMergeInfo(message, el);
    if (!thisInfo || thisInfo.noMerge) return;

    const speakerBasis = feSetting(S.MERGE_SPEAKER_BASIS);
    const thisKey = feMergeKey(thisInfo, speakerBasis);
    if (!thisKey) return;

    const orderContext = feCreateChatMessageOrderContext();
    for (const log of feGetChatLogs()) {
      if (!feIsElementNode(log)) continue;
      const items = log.querySelectorAll?.("li.chat-message");
      if (!items?.length) continue;
      let lastEl = null;
      let lastOrder = -Infinity;
      let lastDomIndex = -1;
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const order = feGetChatMessageElementOrder(item, i, orderContext);
        if (order > lastOrder || (order === lastOrder && i > lastDomIndex)) {
          lastEl = item;
          lastOrder = order;
          lastDomIndex = i;
        }
      }
      if (!lastEl) continue;
      const lastId = feGetMessageIdFromElement(lastEl);
      const lastMsg = lastId ? game.messages?.get?.(lastId) : null;
      if (!lastMsg) continue;

      const lastInfo = feMessageMergeInfo(lastMsg, lastEl);
      if (!lastInfo) continue;
      const lastKey = feMergeKey(lastInfo, speakerBasis);
      if (!lastKey) continue;

      if (feCanMergePair(
        { key: lastKey, noMerge: lastInfo.noMerge, isNarrator: lastInfo.isNarrator, mergeableText: lastInfo.mergeableText },
        { key: thisKey, noMerge: thisInfo.noMerge, isNarrator: thisInfo.isNarrator, mergeableText: thisInfo.mergeableText },
        { allowNarratorMerge: false }
      )) {
        el.classList.add("fe-merge-follow");
      }
      break;
    }
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// Retry scheduling (forward-declared ref set by fe-chat-enhance.js)
// -------------------------------------

const feMergeRetryTimers = new WeakMap();

// feScheduleRenderedLogRefreshForMerge is a callback injected from fe-chat-enhance.js
// to break the circular dependency (merge.js → schedule → merge.js).
// Set via feSetMergeScheduleCallback before hooks fire.
let _scheduleLogRefreshFn = null;

function feSetMergeScheduleCallback(fn) {
  _scheduleLogRefreshFn = fn;
}

function feScheduleRenderedLogRefreshForMerge(logEl, opts) {
  if (_scheduleLogRefreshFn) _scheduleLogRefreshFn(logEl, opts);
}

function feScheduleMergeRetry(logEl, delay = 80, { edgeLookahead = false } = {}) {
  try {
    if (!feIsElementNode(logEl)) return;
    if (feMergeRetryTimers.has(logEl)) return;

    const t = setTimeout(() => {
      feMergeRetryTimers.delete(logEl);
      const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
      try {
        feDedupeChatMessagesInLog(logEl);
        feApplyChatMerge(logEl, { edgeLookahead });
        if (feUserColorBgFeatureActive()) feApplyUserColorBgToLog(logEl, logEl?.ownerDocument ?? document);
      } finally {
        restoreStickyScroll();
      }
    }, delay);

    feMergeRetryTimers.set(logEl, t);
  } catch {
    /* no-op */
  }
}

export {
  feMergeClassSignatureCache,
  feBuildMergeClassSignature,
  feApplyMergeClassSetToElement,
  feClearMergeClassesFromMessageElement,
  feCollectMergeNeighborhood,
  feApplyChatMergeSlice,
  feApplyChatMergeAroundElement,
  feApplyChatMerge,
  feApplyChatMergeToAllLogs,
  fePreApplyMergeHint,
  feScheduleMergeRetry,
  feSetMergeScheduleCallback,
};
