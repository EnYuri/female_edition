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
// Merge application
// -------------------------------------

function feCollectMergeNeighborhood(logEl, anchorEl, { allowNarratorMerge = false } = {}) {
  try {
    if (!feIsElementNode(logEl) || !feIsElementNode(anchorEl)) return { slice: [], firstIndex: 0, hasMissingDocs: false };
    const items = Array.from(logEl.querySelectorAll("li.chat-message"));
    if (!items.length) return { slice: [], firstIndex: 0, hasMissingDocs: false };

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
    return {
      slice,
      firstIndex: start,
      hasMissingDocs: slice.some((info) => !!info?.missing),
    };
  } catch {
    return { slice: [], firstIndex: 0, hasMissingDocs: false };
  }
}

function feApplyChatMergeSlice(infos, startOffset = 0, { allowNarratorMerge = false } = {}) {
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

    const applyGroup = (startIndex, endIndexExclusive) => {
      const groupLen = endIndexExclusive - startIndex;
      if (groupLen <= 0) return;
      const first = infos[startIndex];
      if (!first?.el) return;
      if (showDivider && (startOffset + startIndex) > 0) mark(first.el, "fe-divider-before");
      if (groupLen === 1) return;
      if (simpleMode) {
        for (let i = startIndex + 1; i < endIndexExclusive; i += 1) mark(infos[i]?.el, "fe-merge-follow");
        return;
      }
      mark(first.el, "fe-merge-start");
      for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
      mark(infos[endIndexExclusive - 1]?.el, "fe-merge-end");
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

function feApplyChatMergeAroundElement(messageEl, { allowNarratorMerge = false, skipDedup = false } = {}) {
  try {
    if (feIsNotificationMessageElement(messageEl)) {
      feClearMergeClassesFromMessageElement(messageEl);
      return;
    }
    const anchor = messageEl?.closest?.("li.chat-message") ?? messageEl;
    const log = anchor?.closest?.("ol.chat-log, #chat-log, #fe-chat-export-log");
    if (!feIsElementNode(anchor) || !feIsElementNode(log)) return;
    if (!skipDedup) { try { feDedupeChatMessagesInLog(log); } catch {} }
    const neighborhood = feCollectMergeNeighborhood(log, anchor, { allowNarratorMerge });
    const slice = neighborhood?.slice ?? [];
    if (!slice.length) return;
    feApplyChatMergeSlice(slice, Math.max(0, Number(neighborhood?.firstIndex) || 0), { allowNarratorMerge });
    if (neighborhood?.hasMissingDocs) feScheduleRenderedLogRefreshForMerge(log, { delay: 48, allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feApplyChatMerge(logEl, { allowNarratorMerge = false, preNodes = null } = {}) {
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
  if (hasMissingDocs) feScheduleMergeRetry(logEl);

  const canMerge = (a, b) => feCanMergePair(a, b, { onlyText, allowNarratorMerge });

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
    if (showDivider && startIndex > 0) mark(first.el, "fe-divider-before");
    if (groupLen === 1) return;
    if (simpleMode) {
      for (let i = startIndex + 1; i < endIndexExclusive; i += 1) mark(infos[i]?.el, "fe-merge-follow");
      return;
    }
    mark(first.el, "fe-merge-start");
    for (let i = startIndex + 1; i < endIndexExclusive - 1; i += 1) mark(infos[i]?.el, "fe-merge-mid");
    mark(infos[endIndexExclusive - 1]?.el, "fe-merge-end");
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
      feApplyChatMerge(log);
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

function feScheduleMergeRetry(logEl, delay = 80) {
  try {
    if (!feIsElementNode(logEl)) return;
    if (feMergeRetryTimers.has(logEl)) return;

    const t = setTimeout(() => {
      feMergeRetryTimers.delete(logEl);
      const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
      try {
        feDedupeChatMessagesInLog(logEl);
        feApplyChatMerge(logEl);
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
