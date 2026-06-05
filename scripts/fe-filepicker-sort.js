// fe-filepicker-sort.js
// FVTT FilePicker(코어 ApplicationV2)에 "정렬 기준" 컨트롤 추가.
//   · 이름순  — 로케일 인식 정렬(가-나-다 · A-B-C, 숫자 자연정렬). 코어 기본과 동일하되 오름/내림 토글.
//   · 수정 날짜순 / 크기순 — FilePicker.browse 결과는 경로 문자열만 주고 size·mtime 이 없으므로,
//     파일별 HEAD 요청으로 Last-Modified / Content-Length 를 읽어 정렬한다.
//     (해당 모드 선택 시에만 지연 fetch, 동시성 제한, URL 캐시.)
//
// 비침습 구현: renderFilePicker 훅에서 서브헤더에 셀렉트 1개 + 방향 토글 버튼을 주입하고
//   body 파트의 <li class="file"> 들을 재정렬한다. 부분 재렌더(표시 모드 변경 등)에도
//   매 렌더마다 다시 적용된다. 코어 클래스/템플릿은 건드리지 않는다.

// ─── 영구 설정 (localStorage, 클라이언트 개인 설정) ──────────────────────────
const LS_KEY = "fe-fp-sort-key";
const LS_DIR = k => `fe-fp-sort-dir-${k}`;
const DEFAULT_DIR = { name: "asc", date: "desc", size: "desc" }; // 날짜·크기는 최신/큰 것 먼저가 직관적

function getKey() {
  const v = localStorage.getItem(LS_KEY);
  return (v === "name" || v === "date" || v === "size") ? v : "name";
}
function setKey(v) { localStorage.setItem(LS_KEY, v); }
function getDir(key) {
  const v = localStorage.getItem(LS_DIR(key));
  return (v === "asc" || v === "desc") ? v : (DEFAULT_DIR[key] ?? "asc");
}
function setDir(key, v) { localStorage.setItem(LS_DIR(key), v); }

// ─── 파일 메타데이터 (HEAD 요청, 동시성 제한, 캐시) ──────────────────────────
const _metaCache = new Map();   // url → {size, mtime} | Promise<{size,mtime}>
const _MAX_CONCURRENT = 8;
let _active = 0;
const _queue = [];

function _pump() {
  while (_active < _MAX_CONCURRENT && _queue.length) {
    const job = _queue.shift();
    _active++;
    job().finally(() => { _active--; _pump(); });
  }
}

function _fetchMeta(url) {
  const cached = _metaCache.get(url);
  if (cached) return Promise.resolve(cached); // 값이든 Promise든 그대로 await 가능
  const p = new Promise(resolve => {
    _queue.push(() => fetch(url, { method: "HEAD" }).then(r => {
      const size = Number(r.headers.get("content-length")) || 0;
      const lm = r.headers.get("last-modified");
      const mtime = lm ? (Date.parse(lm) || 0) : 0;
      const m = { size, mtime };
      _metaCache.set(url, m);
      resolve(m);
    }).catch(() => {
      const m = { size: 0, mtime: 0 }; // 실패(CORS/네트워크) → 0 처리, 정렬에서 뒤로 밀림
      _metaCache.set(url, m);
      resolve(m);
    }));
    _pump();
  });
  _metaCache.set(url, p);
  return p;
}

// ─── 정렬 적용 ──────────────────────────────────────────────────────────────
function _cmpName(a, b) {
  return String(a.dataset.name).localeCompare(String(b.dataset.name),
    game.i18n?.lang || undefined, { numeric: true, sensitivity: "base" });
}

function _reorder(ul, lis, cmp, dir) {
  lis.sort(cmp);
  if (dir === "desc") lis.reverse();
  for (const li of lis) ul.appendChild(li); // 같은 부모로 append = 순서 이동
}

async function _applySort(element) {
  const ul = element.querySelector("ul.directory.files-list");
  if (!ul) return;
  const key = getKey();
  const dir = getDir(key);
  _updateControl(element, key, dir);

  const lis = [...ul.querySelectorAll(":scope > li.file")];
  if (lis.length < 2) return;

  if (key === "name") {
    _reorder(ul, lis, _cmpName, dir);
    return;
  }

  // date / size — 메타데이터 필요
  ul.classList.add("fe-fp-sorting");
  await Promise.all(lis.map(li => _fetchMeta(li.dataset.path)));
  if (!ul.isConnected) return; // 그 사이 폴더 이동/재렌더 → 이 ul 은 폐기됨
  ul.classList.remove("fe-fp-sorting");

  // await 동안 사용자가 기준을 바꿨을 수 있으니 현재 값 재확인
  const k2 = getKey(), d2 = getDir(k2);
  const cur = [...ul.querySelectorAll(":scope > li.file")];
  if (k2 === "name") { _reorder(ul, cur, _cmpName, d2); return; }
  const field = k2 === "date" ? "mtime" : "size";
  _reorder(ul, cur, (a, b) =>
    ((_metaCache.get(a.dataset.path)?.[field]) || 0) - ((_metaCache.get(b.dataset.path)?.[field]) || 0), d2);
}

// ─── 컨트롤 주입 / 갱신 ──────────────────────────────────────────────────────
function _updateControl(element, key, dir) {
  const sel = element.querySelector(".fe-fp-sort-key");
  if (sel && sel.value !== key) sel.value = key;
  const btn = element.querySelector(".fe-fp-sort-dir");
  if (btn) {
    btn.classList.remove("fa-arrow-up-short-wide", "fa-arrow-down-wide-short");
    btn.classList.add(dir === "asc" ? "fa-arrow-up-short-wide" : "fa-arrow-down-wide-short");
    btn.setAttribute("aria-label", dir === "asc" ? "오름차순" : "내림차순");
  }
}

function _injectControl(element) {
  const sub = element.querySelector("header.subheader");
  if (!sub || sub.querySelector(".fe-fp-sort")) return;

  const group = document.createElement("div");
  group.className = "form-group slim fe-fp-sort";
  group.innerHTML =
    `<label>정렬 기준</label>` +
    `<div class="form-fields">` +
      `<select class="fe-fp-sort-key" aria-label="정렬 기준">` +
        `<option value="name">이름순</option>` +
        `<option value="date">수정 날짜순</option>` +
        `<option value="size">크기순</option>` +
      `</select>` +
      `<button type="button" class="ui-control icon fa-solid fe-fp-sort-dir" data-tooltip aria-label="정렬 방향"></button>` +
    `</div>`;

  const modeGroup = sub.querySelector('[data-action="changeDisplayMode"]')?.closest(".form-group");
  if (modeGroup) modeGroup.after(group); else sub.appendChild(group);

  const sel = group.querySelector(".fe-fp-sort-key");
  sel.value = getKey();
  sel.addEventListener("change", e => {
    e.stopPropagation();
    setKey(sel.value);
    _applySort(element);
  });
  group.querySelector(".fe-fp-sort-dir").addEventListener("click", e => {
    e.stopPropagation();
    const k = getKey();
    setDir(k, getDir(k) === "asc" ? "desc" : "asc");
    _applySort(element);
  });
}

// ─── 훅 ──────────────────────────────────────────────────────────────────────
// 주의: 훅 element 는 <form> 일 수 있고, HTMLFormElement 에서 element[0] 은
//   "첫 번째 폼 컨트롤"(헤더 버튼 등)을 반환한다. jQuery 래퍼일 때만 [0] 로 언랩.
function _hookRoot(element, app) {
  let el = element;
  if (el && el.jquery) el = el[0];                 // v13 jQuery 래퍼
  if (!(el instanceof HTMLElement)) el = app?.element;
  return el;
}

Hooks.on("renderFilePicker", (app, element) => {
  const el = _hookRoot(element, app);
  if (!el?.querySelector) return;
  _injectControl(el);
  _applySort(el);
});
