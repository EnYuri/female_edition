// fe-filepicker-sort.js
// Adds a sort-order control to core's FilePicker.
//
// By name: locale-aware with natural number ordering, matching core's default but with an
// ascending/descending toggle. By modified date or size: FilePicker.browse returns only
// path strings, so each file's Last-Modified / Content-Length is read with a HEAD request
// — fetched lazily (only in those modes), concurrency-limited and cached per URL.
//
// Non-invasive: the renderFilePicker hook injects one <select> plus a direction toggle into
// the subheader and reorders the body part's <li class="file"> elements. It re-applies on
// every render, including partial ones, and never touches core classes or templates.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
function feFilePickerEnhancementsEnabled() { try { return !!game.settings.get(MODULE_ID, S.CORE_UI_FILEPICKER_ENHANCEMENTS); } catch { return !!FE_DEFAULTS[S.CORE_UI_FILEPICKER_ENHANCEMENTS]; } }

// ─── Persisted per-client preference (localStorage) ────────────────────────
const LS_KEY = "fe-fp-sort-key";
const LS_DIR = k => `fe-fp-sort-dir-${k}`;
const DEFAULT_DIR = { name: "asc", date: "desc", size: "desc" }; // newest/largest first reads better

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

// ─── File metadata (HEAD request, concurrency-limited, cached) ─────────────
const _metaCache = new Map();   // url → {size, mtime} | Promise<{size,mtime}>
const _META_CACHE_MAX = 512;
const _MAX_CONCURRENT = 8;
let _active = 0;
const _queue = [];

function _getCachedMeta(url) {
  if (!_metaCache.has(url)) return null;
  const value = _metaCache.get(url);
  _metaCache.delete(url);
  _metaCache.set(url, value);
  return value;
}

function _setCachedMeta(url, value) {
  _metaCache.delete(url);
  _metaCache.set(url, value);
  while (_metaCache.size > _META_CACHE_MAX) _metaCache.delete(_metaCache.keys().next().value);
}

function _pump() {
  while (_active < _MAX_CONCURRENT && _queue.length) {
    const job = _queue.shift();
    _active++;
    job().finally(() => { _active--; _pump(); });
  }
}

function _fetchMeta(url) {
  const cached = _getCachedMeta(url);
  if (cached) return Promise.resolve(cached); // a value or a Promise both await fine
  const p = new Promise(resolve => {
    _queue.push(() => fetch(url, { method: "HEAD" }).then(r => {
      const size = Number(r.headers.get("content-length")) || 0;
      const lm = r.headers.get("last-modified");
      const mtime = lm ? (Date.parse(lm) || 0) : 0;
      const m = { size, mtime };
      if (_metaCache.get(url) === p) _setCachedMeta(url, m);
      resolve(m);
    }).catch(() => {
      // On failure (CORS/network) treat it as 0 for this pass but do NOT cache that —
      // dropping the entry lets the next sort retry instead of the failure sticking.
      _metaCache.delete(url);
      resolve({ size: 0, mtime: 0 });
    }));
    _pump();
  });
  _setCachedMeta(url, p);
  return p;
}

// ─── Applying the sort ─────────────────────────────────────────────────────
function _cmpName(a, b) {
  return String(a.dataset.name).localeCompare(String(b.dataset.name),
    game.i18n?.lang || undefined, { numeric: true, sensitivity: "base" });
}

function _reorder(ul, lis, cmp, dir) {
  lis.sort(cmp);
  if (dir === "desc") lis.reverse();
  for (const li of lis) ul.appendChild(li); // append within the same parent = reorder
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

  // date / size need metadata
  ul.classList.add("fe-fp-sorting");
  const fetched = await Promise.all(lis.map(async li => [li.dataset.path, await _fetchMeta(li.dataset.path)]));
  // Keep this sort pass complete even when a very large directory exceeds the
  // bounded cross-directory LRU cache.
  const passMeta = new Map(fetched);
  if (!ul.isConnected) return; // navigated away or re-rendered meanwhile
  ul.classList.remove("fe-fp-sorting");

  // The user may have changed the key during the await, so re-read it
  const k2 = getKey(), d2 = getDir(k2);
  const cur = [...ul.querySelectorAll(":scope > li.file")];
  if (k2 === "name") { _reorder(ul, cur, _cmpName, d2); return; }
  const field = k2 === "date" ? "mtime" : "size";
  _reorder(ul, cur, (a, b) =>
    ((passMeta.get(a.dataset.path)?.[field]) || 0) - ((passMeta.get(b.dataset.path)?.[field]) || 0), d2);
}

// ─── Control injection / refresh ───────────────────────────────────────────
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
  if (!sub || sub.querySelector(".fe-fp-controls-row")) return;

  const modeGroup = sub.querySelector('[data-action="changeDisplayMode"]')?.closest(".form-group");

  // One row holding both the sort key and core's display mode.
  const row = document.createElement("div");
  row.className = "form-group slim fe-fp-controls-row";
  row.innerHTML =
    `<label class="fe-fp-ctl-label">정렬 기준</label>` +
    `<select class="fe-fp-sort-key" aria-label="정렬 기준">` +
      `<option value="name">이름순</option>` +
      `<option value="date">수정 날짜순</option>` +
      `<option value="size">크기순</option>` +
    `</select>`;

  // Move core's display-mode label + split-button into this row and drop the old group.
  if (modeGroup) {
    const modeLabel = modeGroup.querySelector("label");
    const splitBtn = modeGroup.querySelector(".split-button");
    if (modeLabel) { modeLabel.classList.add("fe-fp-ctl-label", "fe-fp-mode-label"); row.appendChild(modeLabel); }
    if (splitBtn) row.appendChild(splitBtn);
  }

  // Direction toggle, far right of the row
  const dirBtn = document.createElement("button");
  dirBtn.type = "button";
  dirBtn.className = "ui-control icon fa-solid fe-fp-sort-dir";
  dirBtn.setAttribute("data-tooltip", "");
  dirBtn.setAttribute("aria-label", "정렬 방향");
  row.appendChild(dirBtn);

  if (modeGroup) modeGroup.replaceWith(row); else sub.appendChild(row);

  const sel = row.querySelector(".fe-fp-sort-key");
  sel.value = getKey();
  sel.addEventListener("change", e => {
    e.stopPropagation();
    setKey(sel.value);
    _applySort(element);
  });
  dirBtn.addEventListener("click", e => {
    e.stopPropagation();
    const k = getKey();
    setDir(k, getDir(k) === "asc" ? "desc" : "asc");
    _applySort(element);
  });
}

// ─── Hooks ─────────────────────────────────────────────────────────────────
// The hook's element can be a <form>, where element[0] returns the first form control
// rather than the form. Only unwrap with [0] when it really is a jQuery wrapper.
function _hookRoot(element, app) {
  let el = element;
  if (el && el.jquery) el = el[0];                 // v13 jQuery wrapper
  if (!(el instanceof HTMLElement)) el = app?.element;
  return el;
}

Hooks.on("renderFilePicker", (app, element) => {
  if (!feFilePickerEnhancementsEnabled()) return;
  const el = _hookRoot(element, app);
  if (!el?.querySelector) return;
  _injectControl(el);
  _applySort(el);
});
