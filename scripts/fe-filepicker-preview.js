// fe-filepicker-preview.js
// FilePicker(코어 ApplicationV2) 오른쪽에 "미리보기 사이드바"를 추가한다.
//   · 미리보기 대상 = (1) 파일 리스트에서 선택(.picked)한 파일, (2) 사이드바에 드롭한(업로드할) 파일 한정.
//   · 드롭 업로드는 코어와 "똑같이" 현재 보고 있는 폴더로 올린다(공개 FilePicker.upload + browse).
//     별도 dragupload 분류 폴더는 두지 않는다(렌더러에서 드롭 파일의 디스크 경로를 신뢰성 있게 얻을 수 없어
//     내부/외부 위치 판별이 불가능 → 코어의 "현재 폴더 업로드"를 그대로 활용).
//
// 비침습 구현: renderFilePicker 훅에서 .window-content 를 grid 로 만들고 오른쪽 컬럼에 <aside> 하나만 append.
//   기존 파트(tabs/subheader/body/subfooter/footer)는 DOM 위치/구조를 건드리지 않으므로 코어의 부분 재렌더
//   (querySelector([data-application-part]) → replaceWith 제자리 교체)에 그대로 살아남는다. aside 는 파트가
//   아니라 재렌더 대상이 아니다.

const PREVIEW_WIDTH = 288; // 사이드바 폭(px). CSS grid-template-columns 와 일치시킬 것.

// ─── 확장자 분류 ──────────────────────────────────────────────────────────────
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

// ─── HEAD 메타데이터(크기/수정일) — 선택 파일용. 동시성/캐시 ──────────────────
const _metaCache = new Map();
async function _headMeta(url) {
  if (_metaCache.has(url)) return _metaCache.get(url);
  const p = fetch(url, { method: "HEAD" }).then(r => ({
    size: Number(r.headers.get("content-length")) || 0,
    mtime: Date.parse(r.headers.get("last-modified") || "") || 0
  })).catch(() => ({ size: 0, mtime: 0 }));
  _metaCache.set(url, p);
  return p;
}

// ─── 레이아웃 주입 ────────────────────────────────────────────────────────────
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

  // 폭은 한 번만 넓힌다(부분 재렌더에서 코어가 height:auto 만 다시 잡으므로 폭은 유지됨).
  if (!app._feFpWidened) {
    app._feFpWidened = true;
    const w = (app.position?.width || 560) + PREVIEW_WIDTH;
    try { app.setPosition({ width: w }); } catch (_) {}
  }
  return aside;
}

// ─── 드롭 → 코어와 동일하게 현재 폴더로 업로드 ───────────────────────────────
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

    // 업로드 전, 첫 파일을 즉시 로컬 미리보기(업로드할 파일 미리보기).
    _previewLocal(aside, files[0]);

    if (!_canUpload(el, app)) {
      ui.notifications?.warn("이 위치에는 업로드할 수 없습니다. 미리보기만 표시합니다.");
      return;
    }

    // 코어 #onDrop/#onUpload 와 동일: 현재 활성 소스의 현재 target 폴더로 업로드 후 재탐색.
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

// ─── 미리보기 렌더 ────────────────────────────────────────────────────────────
function _revoke(aside) {
  if (aside._feObjUrl) { try { URL.revokeObjectURL(aside._feObjUrl); } catch (_) {} aside._feObjUrl = null; }
}

function _renderMedia(cat, url, name) {
  switch (cat) {
    case "image":
      return `<img class="fe-fp-media" src="${url}" alt="${foundry.utils.escapeHTML?.(name) ?? name}" data-fe-media>`;
    case "video":
      return `<video class="fe-fp-media" src="${url}" controls preload="metadata" data-fe-media></video>`;
    case "audio":
      return `<div class="fe-fp-audio-wrap"><i class="fa-solid fa-music" inert></i><audio src="${url}" controls preload="metadata" data-fe-media></audio></div>`;
    case "font":
      return `<div class="fe-fp-font" data-fe-font>가나다라 AaBbCc 0123<br><span class="fe-fp-font-sm">다람쥐 헌 쳇바퀴 The quick brown fox</span></div>`;
    default:
      return `<div class="fe-fp-fileicon"><i class="${_catIcon(cat)}" inert></i></div>`;
  }
}

function _clearPreview(aside) {
  if (!aside || aside.classList.contains("fe-fp-empty")) {
    // 이미 비어있어도 objectURL 누수 방지만 처리.
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

  const safeName = foundry.utils.escapeHTML?.(name) ?? name;
  body.innerHTML =
    `<div class="fe-fp-stage" data-fe-stage>${_renderMedia(cat, url, name)}</div>` +
    `<div class="fe-fp-meta">` +
      `<div class="fe-fp-name" title="${safeName}">${safeName}</div>` +
      `<div class="fe-fp-sub" data-fe-sub>${[isLocal ? "업로드할 파일" : "", sizeText, dateText].filter(Boolean).join(" · ")}</div>` +
      `<div class="fe-fp-dim" data-fe-dim></div>` +
    `</div>`;

  // 추가 메타(이미지 해상도 / 미디어 길이 / 폰트 로드) 비동기 보강
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

// 현재 선택(.picked)된 파일을 미리보기 — 초기 렌더 및 선택 변경 시.
// 선택된 파일이 없으면(폴더 이동 등) 미리보기를 비운다.
function _previewCurrentPick(el, aside) {
  const li = el.querySelector("li.file.picked[data-file]") || el.querySelector("li.file[data-file].picked");
  if (li?.dataset?.path) _previewPicked(aside, li.dataset.path, li.dataset.name || li.dataset.path.split("/").pop());
  else _clearPreview(aside);
}

// ─── 훅 ───────────────────────────────────────────────────────────────────────
function _hookRoot(element, app) {
  let el = element;
  if (el && el.jquery) el = el[0];
  if (!(el instanceof HTMLElement)) el = app?.element;
  return el;
}

Hooks.on("renderFilePicker", (app, element) => {
  const el = _hookRoot(element, app);
  if (!el?.querySelector) return;

  // 폴더 선택기(이미지/오디오 등 파일을 고르는 게 아닌)에는 미리보기 불필요.
  if (app?.type === "folder") return;

  const aside = _ensureSidebar(el, app);
  if (!aside) return;

  // 선택(클릭) → 미리보기. 캡처가 아닌 버블 단계에서 코어가 .picked 를 갱신한 뒤 읽는다.
  if (!el._feFpPreviewBound) {
    el._feFpPreviewBound = true;
    el.addEventListener("click", e => {
      const li = e.target.closest?.("li.file[data-file]");
      if (!li || !el.contains(li)) return;
      const cur = el.querySelector(":scope .fe-fp-preview");
      if (cur && li.dataset?.path) _previewPicked(cur, li.dataset.path, li.dataset.name || li.dataset.path.split("/").pop());
    });
  }

  // 초기/재렌더 시: 이미 선택된 파일이 있으면 미리보기.
  _previewCurrentPick(el, aside);
});
