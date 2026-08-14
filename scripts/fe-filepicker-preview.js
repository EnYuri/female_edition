// fe-filepicker-preview.js
// Adds a preview sidebar to the right of core's FilePicker.
//
// Previews either the file selected in the list (.picked) or a file dropped onto the
// sidebar. A drop uploads to the folder currently being browsed, exactly like core does
// (public FilePicker.upload + browse) — there is deliberately no separate dragupload
// folder, because the renderer cannot resolve a dropped file's disk path and so cannot
// tell an internal location from an external one.
//
// Non-invasive by design: the renderFilePicker hook makes .window-content a grid and
// appends ONE <aside>. Core's application parts (tabs/subheader/body/subfooter/footer) keep
// their DOM position, so a partial re-render (querySelector([data-application-part]) →
// replaceWith) leaves everything intact, and the aside is not a part so it is never
// re-rendered.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
const PREVIEW_WIDTH = 288; // sidebar width in px — must match CSS grid-template-columns
function _enabled() { try { return !!game.settings.get(MODULE_ID, S.CORE_UI_FILEPICKER_ENHANCEMENTS); } catch { return !!FE_DEFAULTS[S.CORE_UI_FILEPICKER_ENHANCEMENTS]; } }
Hooks.once("init", () => game.settings.register(MODULE_ID, S.CORE_UI_FILEPICKER_ENHANCEMENTS, {
  name: "코어 UI: 파일 픽커 미리보기 및 개선", hint: "파일 픽커 미리보기와 정렬 개선을 표시합니다.",
  scope: "client", config: false, type: Boolean, default: FE_DEFAULTS[S.CORE_UI_FILEPICKER_ENHANCEMENTS],
}));

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
      `<span>여기에 파일을 드롭하면<br>현재 폴더에 업로드</span>` +
    `</div>`;
  content.appendChild(aside);

  _bindDrop(aside, el, app);

  // Widen once. A partial re-render only re-measures height:auto, so the width sticks.
  if (!app._feFpWidened) {
    app._feFpWidened = true;
    const w = (app.position?.width || 560) + PREVIEW_WIDTH;
    try { app.setPosition({ width: w }); } catch (_) {}
  }
  return aside;
}

// ─── Drop: upload to the current folder, exactly as core does ──────────────
function _canUpload(el, app) {
  const input = el.querySelector('input[name="upload"]');
  return !!input && !input.disabled && (app.canUpload !== false);
}

function _bindDrop(aside, el, app) {
  aside.addEventListener("dragover", e => { e.preventDefault(); aside.classList.add("fe-fp-dragover"); });
  aside.addEventListener("dragleave", e => {
    if (e.target === aside || !aside.contains(e.relatedTarget)) aside.classList.remove("fe-fp-dragover");
  });
  aside.addEventListener("drop", async e => {
    e.preventDefault();
    e.stopPropagation();
    aside.classList.remove("fe-fp-dragover");
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;

    // Preview the first file locally before the upload even starts.
    _previewLocal(aside, files[0]);

    if (!_canUpload(el, app)) {
      ui.notifications?.warn("이 위치에는 업로드할 수 없습니다. 미리보기만 표시합니다.");
      return;
    }

    // Same as core #onDrop/#onUpload: upload into the active source's current target
    // folder, then re-browse it.
    const target = el.querySelector('input[name="target"]')?.value ?? app.target;
    const bucket = el.querySelector('[name="bucket"]')?.value || null;
    aside.classList.add("fe-fp-uploading");
    try {
      for (const f of files) {
        const resp = await app.constructor.upload(app.activeSource, target, f, { bucket });
        if (resp?.path) app.request = resp.path;
      }
      await app.browse(target);
    } catch (err) {
      ui.notifications?.error(err, { console: true });
    } finally {
      aside.classList.remove("fe-fp-uploading");
    }
  });
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
