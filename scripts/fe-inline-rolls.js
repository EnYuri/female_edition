import { feNormalizeChatMessageId, feExtractHTMLElement, feCreateElementFromHTML } from "./fe-util.js";

const feInlineRollSnapshots = new Map(); // messageId → { anchors: string[] }
const FE_INLINE_ROLL_SNAPSHOT_MAX = 400; // 세션 내 최대 보관 메시지 수

function feStoreInlineRollSnapshot(message, anchors) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (!id || !Array.isArray(anchors) || !anchors.length) return null;
    const stored = { anchors: anchors.map((h) => String(h ?? "").trim()).filter(Boolean) };
    if (!stored.anchors.length) return null;
    // 오래된 항목 정리: Map은 삽입 순서를 유지하므로 첫 번째 항목이 가장 오래됨
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
  // DOMParser 없이 문자열 수준에서 검사:
  // data-roll="<base64>" → base64 디코딩 후 @variable 패턴 확인
  // aria-label / title 속성 → 텍스트 추출 후 확인
  try {
    const s = String(anchorHtml ?? "");

    // data-roll attribute 추출 (base64)
    const dataRollMatch = s.match(/\bdata-roll="([^"]*)"/);
    if (dataRollMatch?.[1]) {
      try {
        const decoded = atob(dataRollMatch[1]);
        // JSON 파싱 시도
        try {
          const json = JSON.parse(decoded);
          const formula = json?.formula ?? json?._formula ?? "";
          if (/@\w/.test(formula)) return true;
        } catch {
          if (/@\w/.test(decoded)) return true;
        }
      } catch {
        /* base64 decode 실패 — 무시 */
      }
    }

    // aria-label / title 속성 추출
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

    await message.update({ content: frozen });
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
      // 스냅샷과 현재 inline roll 개수 불일치 — stale 스냅샷을 현재 상태로 교체
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
  feInlineRollSnapshots,
  feStoreInlineRollSnapshot,
  feGetInlineRollSnapshot,
  feClearInlineRollSnapshot,
  feContentHasFreezeTarget,
  feAnchorHasUnresolvedVariable,
  feFreezeInlineRollsIntoContent,
  feSnapshotOrRestoreInlineRolls,
};
