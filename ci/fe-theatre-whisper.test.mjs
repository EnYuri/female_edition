import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../scripts/fe-theatre.js", import.meta.url), "utf8");
const body = (start, end) => {
  const from = src.indexOf(start);
  assert.ok(from >= 0, `missing: ${start}`);
  return src.slice(from, src.indexOf(end, from));
};

// Every client receives every ChatMessage, whispers included; core hides a whisper from
// non-recipients only in its own chat-log render. The stage must apply the same gate on
// BOTH paths that put message text on screen, or whispers leak as speech bubbles.
test("stage hides whispers from non-recipients on live and recall paths", () => {
  assert.match(src, /function _fetMessageVisibleToUser\(message\)[\s\S]{0,120}isContentVisible/);
  assert.match(body('Hooks.on("createChatMessage"', "_fetShowText("),
    /if \(!_fetMessageVisibleToUser\(chatMessage\)\) return;/);
  assert.match(body("function _fetRecallRow(", "\n}\n"), /_fetMessageVisibleToUser\(message\)/);
});

// "<" used to DOMParser-parse every message in the world per click. The expensive
// eligibility test must run lazily, walking back from the anchor and stopping at a hit.
test("recall walks back lazily instead of filtering the whole log", () => {
  assert.doesNotMatch(src, /function _fetRecallMessages\(/);
  assert.doesNotMatch(body("function _fetRecallTimeline(", "\n}\n"), /_fetRecallRow|_fetPlainTextFromContent/);
  const prev = body("function _fetRecallPrev(", "_fetEnsureMessageDisplayInsert(");
  assert.match(prev, /for \(let i = [^;]+; i >= 0 && !row; i--\) \{\s*row = _fetRecallRow\(timeline\[i\]\);/);
});
