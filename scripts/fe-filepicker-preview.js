// fe-filepicker-preview.js
// Adds a preview sidebar to the right of core's FilePicker.
//
// Previews either the file selected in the list (.picked) or a local image pasted/dropped
// onto the FilePicker. External images are uploaded into the module-managed FilePicker
// directory, then the picker changes to that directory and marks the upload as selected.
//
// Non-invasive by design: the renderFilePicker hook makes .window-content a grid and
// appends ONE <aside>. Core's application parts (tabs/subheader/body/subfooter/footer) keep
// their DOM position, so a partial re-render (querySelector([data-application-part]) →
// replaceWith) leaves everything intact, and the aside is not a part so it is never
// re-rendered.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
import {
  ciCanUploadDirect,
  ciNormalizeUploadDirectory,
  ciResolveImageExtension,
  ciUploadImageDirect,
} from "./fe-chat-image-upload.js";

const PREVIEW_WIDTH = 288; // sidebar width in px — must match CSS grid-template-columns
const EXTERNAL_UPLOAD_SETTING = S.CORE_UI_FILEPICKER_UPLOAD_LOCATION;
const EXTERNAL_UPLOAD_DEFAULT = "uploaded-filepicker-images";
let _activePasteContext = null;
let _globalPasteBound = false;
function _enabled() { try { return !!game.settings.get(MODULE_ID, S.CORE_UI_FILEPICKER_ENHANCEMENTS); } catch { return !!FE_DEFAULTS[S.CORE_UI_FILEPICKER_ENHANCEMENTS]; } }
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.CORE_UI_FILEPICKER_ENHANCEMENTS, {
    name: "코어 UI: 파일 픽커 미리보기 및 개선", hint: "파일 픽커 미리보기·정렬과 외부 이미지 붙여넣기/드롭 업로드를 사용합니다.",
    scope: "client", config: false, type: Boolean, default: FE_DEFAULTS[S.CORE_UI_FILEPICKER_ENHANCEMENTS],
  });
  game.settings.register(MODULE_ID, S.CORE_UI_FILEPICKER_UPLOAD_LOCATION, {
    name: "파일 픽커 외부 이미지 업로드 경로",
    hint: "파일 픽커에 붙여넣거나 드롭한 이미지만 저장하는 data 폴더 경로입니다.",
    scope: "world", config: false, restricted: true, type: String,
    default: FE_DEFAULTS[S.CORE_UI_FILEPICKER_UPLOAD_LOCATION],
    onChange: async value => {
      const cleaned = ciNormalizeUploadDirectory(value) || EXTERNAL_UPLOAD_DEFAULT;
      // World-setting callbacks run on every connected client. Only the active GM may
      // canonicalize the shared value; otherwise players would attempt a forbidden
      // SETTINGS_MODIFY write whenever the entered path needs cleanup.
      if (cleaned !== value && game.user === game.users.activeGM)
        await game.settings.set(MODULE_ID, S.CORE_UI_FILEPICKER_UPLOAD_LOCATION, cleaned);
    },
  });
});

// ─── Extension classification ──────────────────────────────────────────────
function _extSet(constKey, fallback) {
  const c = CONST?.[constKey];
  if (c && typeof c === "object") return new Set(Object.keys(c).map(e => e.toLowerCase()));
  return new Set(fallback);
}
const _IMG = _extSet("IMAGE_FILE_EXTENSIONS", ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "tiff"]);
const _VID = _extSet("VIDEO_FILE_EXTENSIONS", ["mp4", "webm", "m4v", "ogv"]);
const _AUD = _extSet("AUDIO_FILE_EXTENSIONS", ["mp3", "ogg", "wav", "flac", "m4a", "aac", "opus", "webm"]);
const _FNT = _extSet("FONT_FILE_EXTENSIONS", ["ttf", "otf", "woff", "woff2"]);

function _classify(name) {
  const ext = String(name).split(".").pop()?.toLowerCase() || "";
  if (_IMG.has(ext)) return "image";
  if (_VID.has(ext)) return "video";
  if (_AUD.has(ext)) return "audio";
  if (_FNT.has(ext)) return "font";
  return "other";
}

function _catIcon(cat) {
  return {
    image: "fa-solid fa-image", video: "fa-solid fa-film", audio: "fa-solid fa-music",
    font: "fa-solid fa-font", other: "fa-solid fa-file"
  }[cat] || "fa-solid fa-file";
}

function _fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

// ─── HEAD metadata (size / mtime) for the picked file, with dedup + cache ──
const _metaCache = new Map();
const _META_CACHE_MAX = 512;

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

async function _headMeta(url) {
  const cached = _getCachedMeta(url);
  if (cached) return cached;
  const p = fetch(url, { method: "HEAD" }).then(r => ({
    size: Number(r.headers.get("content-length")) || 0,
    mtime: Date.parse(r.headers.get("last-modified") || "") || 0
  })).catch(() => ({ size: 0, mtime: 0 }));
  _setCachedMeta(url, p);
  return p;
}

// ─── Layout injection ──────────────────────────────────────────────────────
function _ensureSidebar(el, app) {
  const content = el.querySelector(".window-content");
  if (!content) return null;
  let aside = content.querySelector(":scope > .fe-fp-preview");
  if (aside) return aside;

  el.classList.add("fe-fp-has-preview");
  aside = document.createElement("aside");
  aside.className = "fe-fp-preview fe-fp-empty";
  aside.innerHTML =
    `<div class="fe-fp-preview-body" data-fe-preview-body></div>` +
    `<div class="fe-fp-preview-drop" data-fe-drop-hint>` +
      `<i class="fa-solid fa-arrow-down-to-bracket" inert></i>` +
      `<span>이미지를 창에 드롭하거나 붙여넣기<br>업로드 후 자동 선택</span>` +
    `</div>`;
  content.appendChild(aside);

  _bindExternalImages(aside, el, app);

  // Widen once. A partial re-render only re-measures height:auto, so the width sticks.
  if (!app._feFpWidened) {
    app._feFpWidened = true;
    const w = (app.position?.width || 560) + PREVIEW_WIDTH;
    try { app.setPosition({ width: w }); } catch (_) {}
  }
  return aside;
}

// ─── Paste / external drop: upload to the module folder and select ─────────
function _uploadDirectory() {
  try {
    return ciNormalizeUploadDirectory(game.settings.get(MODULE_ID, EXTERNAL_UPLOAD_SETTING))
      || EXTERNAL_UPLOAD_DEFAULT;
  } catch {
    return EXTERNAL_UPLOAD_DEFAULT;
  }
}

function _pickerAcceptsImage(app, file) {
  const ext = ciResolveImageExtension(file?.name, file?.type);
  if (!ext) return false;
  const allowed = Array.isArray(app?.extensions)
    ? new Set(app.extensions.map(value => String(value).toLowerCase()))
    : null;
  return !allowed?.size || allowed.has(ext.toLowerCase());
}

function _transferImageFiles(transfer, app) {
  const files = [];
  const seen = new Set();
  const add = file => {
    if (!file || seen.has(file) || !_pickerAcceptsImage(app, file)) return;
    seen.add(file);
    files.push(file);
  };
  for (const item of Array.from(transfer?.items || [])) {
    if (item?.kind !== "file") continue;
    add(item.getAsFile?.());
  }
  // Clipboard/DataTransfer commonly exposes the same file through both
  // collections, sometimes as different File wrapper objects. Prefer items.
  if (files.length) return files;
  for (const file of Array.from(transfer?.files || [])) add(file);
  return files;
}

function _hasImageTransfer(transfer, app) {
  if (_transferImageFiles(transfer, app).length) return true;
  return Array.from(transfer?.items || []).some(item =>
    item?.kind === "file"
      && String(item.type || "").toLowerCase().startsWith("image/")
      && _pickerAcceptsImage(app, { name: "", type: item.type })
  );
}

function _transferImageUrls(transfer) {
  const urls = [];
  try {
    const html = transfer?.getData?.("text/html");
    if (html) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      for (const img of parsed.querySelectorAll("img[src]")) {
        const src = String(img.getAttribute("src") || "").trim();
        if (src) urls.push(src);
      }
    }
  } catch (_) {}

  try {
    const uriList = String(transfer?.getData?.("text/uri-list") || "");
    for (const line of uriList.split(/\r?\n/)) {
      const src = line.trim();
      if (!src || src.startsWith("#")) continue;
      if (/^data:image\//i.test(src) || /\.(gif|png|jpe?g|webp|svg|bmp|tiff?|avif)(?:[?#]|$)/i.test(src)) urls.push(src);
    }
  } catch (_) {}
  return [...new Set(urls)].slice(0, 8);
}

async function _readClipboardApiImages(app) {
  const read = globalThis.navigator?.clipboard?.read;
  if (typeof read !== "function") return [];
  try {
    const files = [];
    for (const item of await read.call(globalThis.navigator.clipboard)) {
      for (const type of Array.from(item?.types || [])) {
        if (!String(type).toLowerCase().startsWith("image/")) continue;
        const blob = await item.getType(type);
        const ext = ciResolveImageExtension("", blob.type || type);
        if (!ext) continue;
        const file = new File([blob], `clipboard-image${ext}`, { type: blob.type || type });
        if (_pickerAcceptsImage(app, file)) files.push(file);
      }
    }
    return files;
  } catch (_) {
    return [];
  }
}

async function _downloadImageUrls(urls, app) {
  const files = [];
  for (const source of urls) {
    try {
      const url = new URL(source, document.baseURI);
      if (!["http:", "https:", "data:", "blob:"].includes(url.protocol)) continue;
      const response = await fetch(url.href, { credentials: url.origin === location.origin ? "same-origin" : "omit" });
      if (!response.ok) continue;
      const blob = await response.blob();
      const leaf = url.protocol === "data:" ? "" : url.pathname.split("/").pop();
      const ext = ciResolveImageExtension(leaf, blob.type);
      if (!ext) continue;
      let name = "web-image";
      try { name = decodeURIComponent(leaf || "") || name; } catch (_) {}
      if (!/\.[a-z0-9]+$/i.test(name)) name += ext;
      const file = new File([blob], name, { type: blob.type || "" });
      if (_pickerAcceptsImage(app, file)) files.push(file);
    } catch (_) {}
  }
  return files;
}

function _uploadedDirectory(path) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function _syncUploadedPick(app, path) {
  const root = _hookRoot(app?.element, app);
  if (!root?.querySelector) return;
  const input = root.querySelector('input[name="file"]');
  if (input) input.value = path;

  let picked = null;
  for (const row of root.querySelectorAll("li.file[data-file][data-path]")) {
    const matches = row.dataset.path === path;
    row.classList.toggle("picked", matches);
    if (matches) picked = row;
  }
  const aside = root.querySelector(":scope .fe-fp-preview");
  if (aside && picked) _previewPicked(aside, path, picked.dataset.name || path.split("/").pop());
}

async function _selectUploadedImage(app, path) {
  app.request = path;
  if (app.sources?.data) app.activeSource = "data";
  await app.browse(_uploadedDirectory(path));
  _syncUploadedPick(app, path);
  // ApplicationV2 may settle a part render after browse() has resolved. The
  // request value makes core select it too; this pass covers legacy/v13 DOM.
  setTimeout(() => _syncUploadedPick(app, path), 0);
}

async function _uploadExternalImages(files, aside, app, { clipboardFallback = false, urls = [] } = {}) {
  if ((!files.length && !clipboardFallback && !urls.length) || app._feFpExternalUploadBusy) return;
  if (!ciCanUploadDirect()) {
    ui.notifications?.warn("파일 픽커 이미지 업로드에는 Foundry 파일 업로드 권한이 필요합니다.");
    return;
  }

  app._feFpExternalUploadBusy = true;
  aside.classList.add("fe-fp-uploading");
  try {
    let uploadFiles = files;
    if (!uploadFiles.length && clipboardFallback) uploadFiles = await _readClipboardApiImages(app);
    if (!uploadFiles.length && urls.length) uploadFiles = await _downloadImageUrls(urls, app);
    if (!uploadFiles.length) {
      throw new Error("업로드 가능한 이미지 데이터를 읽지 못했습니다. 클립보드 형식이나 원본 사이트의 다운로드 제한일 수 있습니다.");
    }

    _previewLocal(aside, uploadFiles[0]);
    let selectedPath = "";
    const directory = _uploadDirectory();
    for (const file of uploadFiles) selectedPath = await ciUploadImageDirect(file, directory);
    if (!selectedPath) throw new Error("업로드 결과 경로가 없습니다.");
    await _selectUploadedImage(app, selectedPath);
    ui.notifications?.info?.("이미지를 업로드하고 파일 픽커에서 선택했습니다.");
  } catch (err) {
    ui.notifications?.error(err, { console: true });
  } finally {
    app._feFpExternalUploadBusy = false;
    aside.classList.remove("fe-fp-uploading");
  }
}

function _stopExternalTransfer(event) {
  event.preventDefault();
  event.stopImmediatePropagation();
}

function _activatePasteContext(app) {
  _activePasteContext = app;
  if (_globalPasteBound) return;
  _globalPasteBound = true;
  document.addEventListener("paste", event => {
    const activeApp = _activePasteContext;
    const root = _hookRoot(activeApp?.element, activeApp);
    if (!root?.isConnected || activeApp?.rendered === false) return;
    const aside = root.querySelector(":scope .fe-fp-preview");
    if (!aside) return;

    const files = _transferImageFiles(event.clipboardData, activeApp);
    const urls = files.length ? [] : _transferImageUrls(event.clipboardData);
    if (!files.length && !urls.length && !_hasImageTransfer(event.clipboardData, activeApp)) return;
    _stopExternalTransfer(event);
    void _uploadExternalImages(files, aside, activeApp, { clipboardFallback: true, urls });
  }, true);
}

function _bindExternalImages(aside, el, app) {
  if (el._feFpExternalImagesBound) return;
  el._feFpExternalImagesBound = true;
  el.addEventListener("pointerdown", () => { _activePasteContext = app; }, true);

  el.addEventListener("dragover", event => {
    const types = Array.from(event.dataTransfer?.types || []);
    if (!_hasImageTransfer(event.dataTransfer, app) && !types.includes("text/html") && !types.includes("text/uri-list")) return;
    event.preventDefault();
    aside.classList.add("fe-fp-dragover");
  }, true);
  el.addEventListener("dragleave", event => {
    if (event.relatedTarget && el.contains(event.relatedTarget)) return;
    aside.classList.remove("fe-fp-dragover");
  }, true);
  el.addEventListener("drop", event => {
    const files = _transferImageFiles(event.dataTransfer, app);
    const urls = files.length ? [] : _transferImageUrls(event.dataTransfer);
    if (!files.length && !urls.length) return;
    _stopExternalTransfer(event);
    aside.classList.remove("fe-fp-dragover");
    void _uploadExternalImages(files, aside, app, { urls });
  }, true);
}

// ─── Preview rendering ─────────────────────────────────────────────────────
function _revoke(aside) {
  if (aside._feObjUrl) { try { URL.revokeObjectURL(aside._feObjUrl); } catch (_) {} aside._feObjUrl = null; }
}

function _renderMedia(cat, url, name) {
  // Attribute-escape BOTH the src URL and the alt name. A file whose name contains
  // a double-quote (allowed on Linux/macOS hosts; a player-uploaded file is a
  // cross-user vector once the GM previews it) would otherwise break out of the
  // src="" attribute and inject an onerror handler. foundry.utils.escapeHTML is
  // safe for quoted attributes (handles & < > " ').
  const esc = (s) => globalThis.foundry?.utils?.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
  switch (cat) {
    case "image":
      return `<img class="fe-fp-media" src="${esc(url)}" alt="${esc(name)}" data-fe-media>`;
    case "video":
      return `<video class="fe-fp-media" src="${esc(url)}" controls preload="metadata" data-fe-media></video>`;
    case "audio":
      return `<div class="fe-fp-audio-wrap"><i class="fa-solid fa-music" inert></i><audio src="${esc(url)}" controls preload="metadata" data-fe-media></audio></div>`;
    case "font":
      return `<div class="fe-fp-font" data-fe-font>가나다라 AaBbCc 0123<br><span class="fe-fp-font-sm">다람쥐 헌 쳇바퀴 The quick brown fox</span></div>`;
    default:
      return `<div class="fe-fp-fileicon"><i class="${_catIcon(cat)}" inert></i></div>`;
  }
}

function _clearPreview(aside) {
  if (!aside || aside.classList.contains("fe-fp-empty")) {
    // Already empty — still revoke, so no object URL leaks.
    _revoke(aside);
    if (aside) aside.dataset.fePreviewKey = "";
    return;
  }
  _revoke(aside);
  aside.dataset.fePreviewKey = "";
  aside.classList.add("fe-fp-empty");
  const body = aside.querySelector("[data-fe-preview-body]");
  if (body) body.innerHTML = "";
}

function _writePreview(aside, { url, name, cat, sizeText = "", dateText = "", isLocal = false }) {
  const body = aside.querySelector("[data-fe-preview-body]");
  if (!body) return;
  aside.classList.remove("fe-fp-empty");
  aside.dataset.fePreviewKey = isLocal ? `local:${name}` : url;

  const safeName = globalThis.foundry?.utils?.escapeHTML?.(name) ?? name;
  body.innerHTML =
    `<div class="fe-fp-stage" data-fe-stage>${_renderMedia(cat, url, name)}</div>` +
    `<div class="fe-fp-meta">` +
      `<div class="fe-fp-name" title="${safeName}">${safeName}</div>` +
      `<div class="fe-fp-sub" data-fe-sub>${[isLocal ? "업로드할 파일" : "", sizeText, dateText].filter(Boolean).join(" · ")}</div>` +
      `<div class="fe-fp-dim" data-fe-dim></div>` +
    `</div>`;

  // Fill in extra metadata asynchronously: image resolution, media duration, font load.
  const dim = body.querySelector("[data-fe-dim]");
  const media = body.querySelector("[data-fe-media]");
  if (cat === "image" && media) {
    media.addEventListener("load", () => {
      if (media.naturalWidth) dim.textContent = `${media.naturalWidth} × ${media.naturalHeight}px`;
    }, { once: true });
  } else if ((cat === "audio" || cat === "video") && media) {
    media.addEventListener("loadedmetadata", () => {
      const d = media.duration;
      if (Number.isFinite(d) && d > 0) {
        const m = Math.floor(d / 60), s = Math.round(d % 60);
        dim.textContent = `${m}:${String(s).padStart(2, "0")}` + (cat === "video" && media.videoWidth ? ` · ${media.videoWidth}×${media.videoHeight}` : "");
      }
    }, { once: true });
  } else if (cat === "font") {
    _applyFontSample(body.querySelector("[data-fe-font]"), url, name).catch(() => {});
  }
}

async function _applyFontSample(elFont, url, name) {
  if (!elFont || !url) return;
  const fam = `FEPV-${name.replace(/[^a-z0-9]/gi, "")}`;
  try {
    const face = new FontFace(fam, `url("${url}")`);
    await face.load();
    document.fonts.add(face);
    elFont.style.fontFamily = `"${fam}", sans-serif`;
  } catch (_) {}
}

function _previewLocal(aside, file) {
  _revoke(aside);
  const url = URL.createObjectURL(file);
  aside._feObjUrl = url;
  _writePreview(aside, {
    url, name: file.name, cat: _classify(file.name),
    sizeText: _fmtSize(file.size), isLocal: true
  });
}

async function _previewPicked(aside, url, name) {
  if (!url) return;
  if (aside.dataset.fePreviewKey === url) return; // 동일 파일 재선택 → 스킵
  _revoke(aside);
  const cat = _classify(name);
  _writePreview(aside, { url, name, cat });
  const meta = await _headMeta(url);
  if (aside.dataset.fePreviewKey !== url) return; // 그 사이 다른 걸 선택
  const sub = aside.querySelector("[data-fe-sub]");
  if (sub) {
    const date = meta.mtime ? new Date(meta.mtime).toLocaleDateString() : "";
    sub.textContent = [_fmtSize(meta.size), date].filter(Boolean).join(" · ");
  }
}

// Preview the currently picked file, on first render and on every selection change.
// With nothing picked (e.g. after navigating to another folder) the preview is cleared.
function _previewCurrentPick(el, aside) {
  const li = el.querySelector("li.file.picked[data-file]") || el.querySelector("li.file[data-file].picked");
  if (li?.dataset?.path) _previewPicked(aside, li.dataset.path, li.dataset.name || li.dataset.path.split("/").pop());
  else _clearPreview(aside);
}

// ─── Hooks ─────────────────────────────────────────────────────────────────
function _hookRoot(element, app) {
  let el = element;
  if (el && el.jquery) el = el[0];
  if (!(el instanceof HTMLElement)) el = app?.element;
  return el;
}

Hooks.on("renderFilePicker", (app, element) => {
  if (!_enabled()) return;
  const el = _hookRoot(element, app);
  if (!el?.querySelector) return;

  // A folder picker selects directories, not files — nothing to preview.
  if (app?.type === "folder") return;

  const aside = _ensureSidebar(el, app);
  if (!aside) return;
  _activatePasteContext(app);

  // Click → preview. Bubble phase, not capture, so core has already updated .picked.
  if (!el._feFpPreviewBound) {
    el._feFpPreviewBound = true;
    el.addEventListener("click", e => {
      const li = e.target.closest?.("li.file[data-file]");
      if (!li || !el.contains(li)) return;
      const cur = el.querySelector(":scope .fe-fp-preview");
      if (cur && li.dataset?.path) _previewPicked(cur, li.dataset.path, li.dataset.name || li.dataset.path.split("/").pop());
    });
  }

  // On first render and re-render: preview whatever is already picked.
  _previewCurrentPick(el, aside);
});
