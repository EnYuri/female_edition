// fe-dx3rd-input-align.js
// DX3rd 시트·다이얼로그의 input/select 값 텍스트를 픽셀단위 중앙으로 강제 정렬.
//
// 배경: dx3rd/코어가 input·select 의 우측 패딩(8~20px)을 매우 높은 우선순위로 박아둬서
//   author 스타일시트(레이어 포함)로는 못 이긴다 — 실측상 인라인 !important 만 이긴다.
//   그래서 fe-dx3rd-compat.css 의 정렬 규칙(가로 좌측 대칭 + select line-height)은
//   "첫 페인트 베이스라인"이고, 픽셀단위 완성은 여기서 인라인으로 처리한다.
//
// 동작: dx3rd 윈도우(.double-cross-3rd) 안에 추가/재렌더되는 input·select 를
//   MutationObserver 로 감지(시트·아이템·모든 커스텀 다이얼로그 공통) → 인라인 정렬.
//   · input  : text-align:center 인 값칸만 좌우 4px 대칭. 좌측정렬(이름/코드네임)은 건너뜀.
//   · select : line-height normal(세로 중앙) + 좌우 대칭 패딩. 화살표 있는 셀렉트는 우측
//     공간을 확보하고, 좁아서 글자가 잘릴 것 같으면 패딩을 자동 축소(클리핑 방지).

const SYS_ID = "double-cross-3rd";
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
  if (_started || game.system?.id !== SYS_ID) return;
  _started = true;

  // 이미 열려 있는 dx3rd 윈도우 처리
  document.querySelectorAll(".double-cross-3rd").forEach(_alignRoot);

  // dx3rd 윈도우 안에 추가/재렌더되는 input·select 감지 (rAF 배치)
  const pending = new Set();
  let scheduled = false;
  const flush = () => { scheduled = false; const els = [...pending]; pending.clear(); els.forEach(_alignEl); };
  const obs = new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (!n.closest?.(".double-cross-3rd")) continue;       // dx3rd 윈도우 밖 → 빠른 탈출
      if (n.matches?.("input, select")) pending.add(n);
      n.querySelectorAll?.("input, select").forEach(e => pending.add(e));
    }
    if (pending.size && !scheduled) { scheduled = true; requestAnimationFrame(flush); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

Hooks.once("ready", _start);
