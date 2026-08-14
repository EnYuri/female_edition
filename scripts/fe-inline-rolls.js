import { feNormalizeChatMessageId, feExtractHTMLElement, feCreateElementFromHTML } from "./fe-util.js";

const feInlineRollSnapshots = new Map(); // messageId → { anchors: string[] }
const FE_INLINE_ROLL_SNAPSHOT_MAX = 400; // 세션 내 최대 보관 메시지 수

// Messages currently being frozen by feFreezeInlineRollsIntoContent.
// While a message is in this set, updateChatMessage must NOT clear its snapshot —
// the snapshot must survive the freeze-triggered re-render so it can restore the original value.
const feFreezingInProgress = new Set();

function feIsMessageFreezeInProgress(messageId) {
  try {
    const id = feNormalizeChatMessageId(messageId);
    return id ? feFreezingInProgress.has(id) : false;
  } catch {
    return false;
  }
}

function feStoreInlineRollSnapshot(message, anchors) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (!id || !Array.isArray(anchors) || !anchors.length) return null;
    const stored = { anchors: anchors.map((h) => String(h ?? "").trim()).filter(Boolean) };
    if (!stored.anchors.length) return null;
    // Evict the oldest entry; Map preserves insertion order, so it is the first key.
    if (feInlineRollSnapshots.size >= FE_INLINE_ROLL_SNAPSHOT_MAX && !feInlineRollSnapshots.has(id)) {
      feInlineRollSnapshots.delete(feInlineRollSnapshots.keys().next().value);
    }
    feInlineRollSnapshots.set(id, stored);
    return stored;
  } catch {
    return null;
  }
}

function feGetInlineRollSnapshot(message) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (!id) return null;
    return feInlineRollSnapshots.get(id) ?? null;
  } catch {
    return null;
  }
}

function feClearInlineRollSnapshot(messageId) {
  try {
    const id = feNormalizeChatMessageId(messageId);
    if (!id) return;
    feInlineRollSnapshots.delete(id);
  } catch {
    /* no-op */
  }
}

function feContentHasFreezeTarget(message) {
  try {
    return /\[\[/.test(String(message?.content ?? ""));
  } catch {
    return false;
  }
}

function feAnchorHasUnresolvedVariable(anchorHtml) {
  // Checked at the string level, without DOMParser:
  //   data-roll="<base64>" -> decode, then look for an @variable pattern
  //   aria-label / title    -> extract the text, then look for the same
  try {
    const s = String(anchorHtml ?? "");

    // Extract the data-roll attribute (base64)
    const dataRollMatch = s.match(/\bdata-roll="([^"]*)"/);
    if (dataRollMatch?.[1]) {
      try {
        const decoded = atob(dataRollMatch[1]);
        // Try to parse it as JSON
        try {
          const json = JSON.parse(decoded);
          const formula = json?.formula ?? json?._formula ?? "";
          if (/@\w/.test(formula)) return true;
        } catch {
          if (/@\w/.test(decoded)) return true;
        }
      } catch {
        /* base64 decode failed - ignore */
      }
    }

    // Extract the aria-label / title attributes
    const labelMatch = s.match(/\baria-label="([^"]*)"/) ?? s.match(/\btitle="([^"]*)"/);
    if (labelMatch?.[1] && /@\w/.test(labelMatch[1])) return true;
  } catch {
    /* no-op */
  }
  return false;
}

async function feFreezeInlineRollsIntoContent(message, anchors) {
  try {
    if (!message || !Array.isArray(anchors) || !anchors.length) return;
    if (!feContentHasFreezeTarget(message)) return;
    if (!message.canUserModify?.(game.user, "update")) return;

    if (anchors.some(feAnchorHasUnresolvedVariable)) return;

    let anchorIdx = 0;
    const frozen = String(message.content ?? "").replace(/\[\[[\s\S]*?\]\]/g, () => {
      const anchor = anchors[anchorIdx++];
      return anchor ?? "";
    });

    if (anchorIdx !== anchors.length) return;
    if (frozen === message.content) return;

    // Mark this message as freeze-in-progress so the updateChatMessage hook
    // does not clear the snapshot when this update lands.  The snapshot must
    // survive into the re-render triggered by the update so it can restore
    // the original roll value if enrichHTML re-evaluates the frozen anchor.
    const msgId = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (msgId) feFreezingInProgress.add(msgId);
    try {
      await message.update({ content: frozen });
    } finally {
      if (msgId) feFreezingInProgress.delete(msgId);
    }
  } catch {
    /* no-op: fire-and-forget */
  }
}

function feSnapshotOrRestoreInlineRolls(message, rootEl) {
  try {
    const root = feExtractHTMLElement(rootEl);
    if (!root || !message) return;

    const current = Array.from(root.querySelectorAll?.("a.inline-roll.inline-result, a.inline-roll[data-roll]") ?? []);
    if (!current.length) return;

    const snapshot = feGetInlineRollSnapshot(message);

    if (!snapshot) {
      const anchors = current.map((a) => a.outerHTML);
      feStoreInlineRollSnapshot(message, anchors);

      if (feContentHasFreezeTarget(message)) {
        void feFreezeInlineRollsIntoContent(message, anchors);
      }
      return;
    }

    if (snapshot.anchors.length !== current.length) {
      // Inline-roll count differs from the snapshot: replace the stale snapshot.
      const anchors = current.map((a) => a.outerHTML);
      feStoreInlineRollSnapshot(message, anchors);
      return;
    }

    const allMatch = current.every((a, i) => a.outerHTML === snapshot.anchors[i]);
    if (allMatch) return;

    const doc = root.ownerDocument ?? document;
    for (let i = 0; i < current.length; i += 1) {
      const replacement = feCreateElementFromHTML(doc, snapshot.anchors[i]);
      if (!replacement) continue;
      current[i].replaceWith(replacement);
    }
  } catch {
    /* no-op */
  }
}

export {
  feStoreInlineRollSnapshot,
  feGetInlineRollSnapshot,
  feClearInlineRollSnapshot,
  feContentHasFreezeTarget,
  feAnchorHasUnresolvedVariable,
  feFreezeInlineRollsIntoContent,
  feSnapshotOrRestoreInlineRolls,
  feIsMessageFreezeInProgress,
};
