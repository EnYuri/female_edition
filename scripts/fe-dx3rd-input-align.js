// fe-dx3rd-input-align.js
// Force pixel-exact centering of input/select value text in DX3rd sheets and dialogs.
//
// dx3rd and core pin a right padding (8-20px) on inputs and selects at a priority no
// author stylesheet can beat, layered or not - measured, only inline !important wins. So
// fe-dx3rd-compat.css's alignment rules are the first-paint baseline, and the pixel-exact
// finish happens here, inline.
//
// A MutationObserver watches inputs and selects added or re-rendered inside a dx3rd
// window (.dx3rd-emanim / .double-cross-3rd / original .dx3rd), covering sheets,
// items and every custom dialog, and aligns them inline:
//   input  - only centered value fields get symmetric 4px padding; left-aligned fields
//            (name, codename) are skipped.
//   select - line-height normal for vertical centering plus symmetric padding. Selects
//            with an arrow reserve room on the right, and the padding shrinks
//            automatically when the field is too narrow, so text never clips.

import { feIsDx3rdSystemId } from "./fe-constants.js";

const DX3RD_ROOT_SELECTOR = ".dx3rd-emanim, .double-cross-3rd, .dx3rd";
const _measCtx = document.createElement("canvas").getContext("2d");

function _textWidth(text, cs) {
  _measCtx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return _measCtx.measureText(text || "").width;
}

function _alignInput(el) {
  const t = (el.getAttribute("type") || "text").toLowerCase();
  if (t !== "text" && t !== "number") return;               // 텍스트형 값칸만
  if (getComputedStyle(el).textAlign !== "center") return;  // 좌측정렬(이름 등) 보존
  el.style.setProperty("padding-left",  "4px", "important");
  el.style.setProperty("padding-right", "4px", "important");
}

function _alignSelect(el) {
  el.style.setProperty("line-height", "normal", "important");
  el.style.setProperty("text-align",  "center", "important");
  const cs = getComputedStyle(el);
  if (cs.textAlign !== "center") return;
  const hasArrow = !!cs.backgroundImage && cs.backgroundImage !== "none";
  const txt   = el.options?.[el.selectedIndex]?.text ?? "";
  const tw    = _textWidth(txt, cs);
  const inner = el.clientWidth;                              // content + padding
  let pad = hasArrow ? 16 : 4;                               // 화살표 있으면 우측 공간 확보
  const maxPad = Math.max(2, Math.floor((inner - tw) / 2) - 2); // 클리핑 방지 상한
  pad = Math.min(pad, maxPad);
  el.style.setProperty("padding-left",  `${pad}px`, "important");
  el.style.setProperty("padding-right", `${pad}px`, "important");
}

function _alignEl(el) {
  if (!el.isConnected) return;
  try {
    if (el.tagName === "INPUT") _alignInput(el);
    else if (el.tagName === "SELECT") _alignSelect(el);
  } catch { /* 정렬 실패는 무시 — 기능에 영향 없음 */ }
}

function _alignRoot(root) {
  if (root.matches?.("input, select")) _alignEl(root);
  root.querySelectorAll?.("input, select").forEach(_alignEl);
}

let _started = false;
function _start() {
  if (_started || !feIsDx3rdSystemId(game.system?.id)) return;
  _started = true;

  // Handle dx3rd windows that are already open
  document.querySelectorAll(DX3RD_ROOT_SELECTOR).forEach(_alignRoot);

  // Watch for inputs/selects added or re-rendered in a dx3rd window (batched via rAF)
  const pending = new Set();
  let scheduled = false;
  const flush = () => { scheduled = false; const els = [...pending]; pending.clear(); els.forEach(_alignEl); };
  const obs = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (!n.closest?.(DX3RD_ROOT_SELECTOR)) continue;       // dx3rd 윈도우 밖 → 빠른 탈출
      if (n.matches?.("input, select")) pending.add(n);
      n.querySelectorAll?.("input, select").forEach(e => pending.add(e));
    }
    if (pending.size && !scheduled) { scheduled = true; requestAnimationFrame(flush); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

Hooks.once("ready", _start);
