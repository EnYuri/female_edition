// fe-portrait-hq.js
// High-quality portrait downscaling.
//
// Foundry's WebGL board puts the whole page in GPU compositing mode, where a 10-15x
// <img> reduction is a single bilinear sample (2x2 texels, no mipmaps) and high-frequency
// detail sparkles. CSS image-rendering has no "high quality downscale" keyword, so the
// only reliable fix is to never hand the browser an oversized bitmap: pre-reduce via
// stepped canvas halving with imageSmoothingQuality "high" down to ~2x the display size
// (HiDPI/zoom headroom), leaving the browser a <=2x reduction it handles well.
//
// Same-origin only — a cross-origin fetch just logs a CORS error, so those keep the
// original src untouched.

const _hqCache = new Map();   // key `${url}|${tw}x${th}` → Promise<dataURL|null>
const _hqValue = new Map();   // key → resolved dataURL|null (sync fast path)
const _HQ_CACHE_MAX = 160;

function _canDownscaleUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (url.startsWith("data:")) return false;
  try {
    const parsed = new URL(url, document.baseURI);
    if (parsed.protocol === "blob:") return true;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return true;
    return parsed.origin === window.location.origin;
  } catch {
    return !/^[a-z][a-z0-9+.-]*:/i.test(url);
  }
}

// Concurrency cap — keeps a directory full of huge images (3328² and up) from spiking
// memory by decoding all at once. Sheets only ever have one or two, so they are unaffected.
const _MAX_JOBS = 3;
let _running = 0;
const _jobQ = [];
function _pump() {
  while (_running < _MAX_JOBS && _jobQ.length) {
    const task = _jobQ.shift();
    _running++;
    task().finally(() => { _running--; _pump(); });
  }
}
function _enqueue(task) {
  return new Promise(resolve => {
    _jobQ.push(() => Promise.resolve().then(task).then(resolve, () => resolve(null)));
    _pump();
  });
}

// Fast path: fetch → blob → createImageBitmap({resizeQuality: "high"}). Reduction happens
// during decode, so no full-size canvas is ever allocated. The probe only reads the source
// dimensions and is closed immediately.
async function _viaImageBitmap(url, tw, th) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("http " + resp.status);
  const blob = await resp.blob();
  const probe = await createImageBitmap(blob);
  const w = probe.width, h = probe.height;
  probe.close?.();
  if (!w || !h) return null;
  const scale = Math.max(tw / w, th / h);
  if (scale >= 1) return null;                          // no downscale needed
  const fw = Math.max(1, Math.round(w * scale));
  const fh = Math.max(1, Math.round(h * scale));
  let bmp;
  try { bmp = await createImageBitmap(blob, { resizeWidth: fw, resizeHeight: fh, resizeQuality: "high" }); }
  catch { bmp = await createImageBitmap(blob); }        // no resize support → drawImage
  const c = document.createElement("canvas");
  c.width = fw; c.height = fh;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  x.drawImage(bmp, 0, 0, fw, fh);
  bmp.close?.();
  try { return c.toDataURL("image/webp", 0.92); }
  catch { try { return c.toDataURL("image/png"); } catch { return null; } }
}

// Fallback for environments without createImageBitmap: <img> + stepped halving canvas.
// decode() has been seen to hang on a heavy WebGL page, so this waits on onload + a timeout.
async function _viaImg(url, tw, th) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;                                        // no crossOrigin: cross-origin images must still display
  try {
    await new Promise((res, rej) => {
      if (img.complete && img.naturalWidth) return res();
      img.onload = () => res();
      img.onerror = () => rej(new Error("load failed"));
      setTimeout(() => rej(new Error("load timeout")), 15000);
    });
  } catch { return null; }
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) return null;
  const scale = Math.max(tw / w, th / h);
  if (scale >= 1) return null;
  const finalW = Math.max(1, Math.round(w * scale));
  const finalH = Math.max(1, Math.round(h * scale));
  let canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  let ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0);
  let cw = w, ch = h;
  while (cw > finalW * 2) {                             // bilinear is fine at <=2:1 per step
    const nw = Math.max(finalW, Math.round(cw / 2));
    const nh = Math.max(finalH, Math.round(ch * nw / cw));
    const c2 = document.createElement("canvas");
    c2.width = nw; c2.height = nh;
    const x2 = c2.getContext("2d");
    x2.imageSmoothingEnabled = true; x2.imageSmoothingQuality = "high";
    x2.drawImage(canvas, 0, 0, nw, nh);
    canvas = c2; ctx = x2; cw = nw; ch = nh;
  }
  const fc = document.createElement("canvas");
  fc.width = finalW; fc.height = finalH;
  const fx = fc.getContext("2d");
  fx.imageSmoothingEnabled = true; fx.imageSmoothingQuality = "high";
  fx.drawImage(canvas, 0, 0, cw, ch, 0, 0, finalW, finalH);
  try { return fc.toDataURL("image/webp", 0.92); }
  catch { try { return fc.toDataURL("image/png"); } catch { return null; } }
}

async function _produce(url, tw, th) {
  if (typeof createImageBitmap === "function") {
    try { return await _viaImageBitmap(url, tw, th); }
    catch { /* CORS/network failure → try the <img> fallback */ }
  }
  return _viaImg(url, tw, th);
}

// Evict down to the LRU cap. Both maps MUST be keyed off _hqCache — a key present in only
// one of them would never be evicted (undownscalable URLs used to pile up in _hqValue).
function _hqEvict() {
  while (_hqCache.size > _HQ_CACHE_MAX) {
    const oldest = _hqCache.keys().next().value;
    _hqCache.delete(oldest);
    _hqValue.delete(oldest);
  }
}

// Convert url into a high-quality data URL covering tw x th. null on failure. Queued + cached.
export function feHQImageDownscale(url, tw, th) {
  if (!url || typeof url !== "string") return Promise.resolve(null);
  if (url.startsWith("data:")) return Promise.resolve(null); // already a processed bitmap
  const key = `${url}|${tw}x${th}`;
  const cached = _hqCache.get(key);
  if (cached) { _hqCache.delete(key); _hqCache.set(key, cached); return cached; } // LRU bump

  // Cache the "cannot downscale" verdict too — into BOTH maps, since eviction walks
  // _hqCache and a _hqValue-only key would never be reclaimed.
  if (!_canDownscaleUrl(url)) {
    const job = Promise.resolve(null);
    _hqValue.set(key, null);
    _hqCache.set(key, job);
    _hqEvict();
    return job;
  }

  const job = _enqueue(() => _produce(url, tw, th)).then(v => { _hqValue.set(key, v); return v; });
  _hqCache.set(key, job);
  _hqEvict();
  return job;
}

// ─── Editable images (data-edit) — HQ via srcset ─────────────────────────────
// An editable image's src must never be substituted (see the CRITICAL note below), so the
// HQ bitmap rides along in srcset instead:
//     <img src="real/path.webp" srcset="data:image/webp;base64,... 1x">
// A valid srcset candidate wins the paint, while core's only editable-image serialization
// point (form-data-extended.mjs #processEditableHTML) reads getAttribute("src") and never
// touches srcset or currentSrc. V1's eventless _getSubmitData uses the same path.
//
// Because the <img> itself paints, object-fit/border-radius/layout stay native — which is
// what removed the old overlay apparatus (overlay div, parent position mutation,
// ResizeObserver, global scroll listeners, rAF position sync) along with its flicker.
//
// Commas in the data URL are safe: the srcset parser collects non-whitespace characters as
// one URL before reading descriptors, so a whitespace-free base64 URL is a single candidate.

function _clearSrcsetHQ(imgEl) {
  if (!imgEl._feHqSrcset) return;
  imgEl.removeAttribute("srcset");
  imgEl._feHqSrcset = false;
}

// Core's image picker writes `img.src = path` directly on both V1 (_onEditImage) and V2
// (#onEditImage). A stale srcset would keep painting the OLD bitmap over the newly picked
// image, and a V1 sheet without submitOnChange never re-renders, so it would persist until
// the window closes. Watch the src attribute and invalidate the moment it diverges.
function _watchSrcHQ(imgEl) {
  if (imgEl._feHqSrcMO) return;
  const mo = new MutationObserver(() => {
    if (imgEl.getAttribute("src") === imgEl.dataset.feHqSrc) return; // still the path we know
    _clearSrcsetHQ(imgEl);                                            // user picked a new image
  });
  mo.observe(imgEl, { attributes: true, attributeFilter: ["src"] });
  imgEl._feHqSrcMO = mo;
}

function _applyEditableSrcsetHQ(imgEl, url, cssW, cssH) {
  _clearSrcsetHQ(imgEl);
  if (!url || url.startsWith("data:")) return;

  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const k = 2; // oversample factor
  const tw = Math.max(1, Math.ceil((cssW || 98) * dpr * k));
  const th = Math.max(1, Math.ceil((cssH || 80) * dpr * k));
  const key = `${url}|${tw}x${th}`;

  const show = (dataURL) => {
    if (imgEl.dataset.feHqSrc !== url) return; // swapped to another image meanwhile
    if (!dataURL) return;                      // nothing to downscale / CORS → keep original
    // The 1x descriptor keeps the bitmap's natural size as the intrinsic size. _produce
    // preserves the aspect ratio, so layout is identical whether the portrait is sized by
    // CSS or by width:100%;height:auto. An unsized image never reaches here at all
    // (display size == source size → scale >= 1 → _produce returns null).
    imgEl.setAttribute("srcset", `${dataURL} 1x`);
    imgEl._feHqSrcset = true;
    _watchSrcHQ(imgEl);
  };

  if (_hqValue.has(key)) { show(_hqValue.get(key)); return; }
  feHQImageDownscale(url, tw, th).then(show);
}

// Show the original immediately, then swap in the downscaled bitmap once ready.
// cssW/cssH are the display size in CSS px; dpr x2 oversampling covers zoom and HiDPI.
// opts.assumeEditable: treat as an editable [data-edit] field even if the attribute is not
// present RIGHT NOW. Needed for sheets whose lock/unlock toggle (e.g. Tidy5e) adds/removes
// data-edit reactively without re-touching `src` — see the CRITICAL note below and the MUST
// KEEP note above _processSheetPortraits.
export function feApplyHQPortrait(imgEl, url, cssW, cssH, opts) {
  if (!imgEl) return;

  // CRITICAL — never substitute the `src` of an editable image.
  // FormDataExtended serializes it straight from the DOM (`element.getAttribute("src")`) on
  // both AppV2 and AppV1 — V1's `_getSubmitData` fires on close with NO DOM event, so event
  // guards cannot help. A data: URL in `src` would be saved as actor.img and uploaded,
  // permanently replacing the real high-res file with a ~300px copy. Editable portraits get
  // HQ through `srcset` instead (see _applyEditableSrcsetHQ). Non-editable images
  // (image-hover, directory thumbnails) are not form fields and keep the src swap below.
  if (imgEl.hasAttribute?.("data-edit") || opts?.assumeEditable) {
    if (url) imgEl.dataset.feHqSrc = url; // let image-hover resolve the real high-res original
    else imgEl.dataset.feHqSrc = "";
    _applyEditableSrcsetHQ(imgEl, url, cssW, cssH);
    return;
  }

  if (!url) { imgEl.removeAttribute("src"); imgEl.dataset.feHqSrc = ""; return; }

  // Ignore a repeat request for the same url (re-render dedup)
  if (imgEl.dataset.feHqSrc === url) return;
  imgEl.dataset.feHqSrc = url;

  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const k = 2; // oversample factor
  const tw = Math.max(1, Math.ceil((cssW || 98) * dpr * k));
  const th = Math.max(1, Math.ceil((cssH || 80) * dpr * k));
  const key = `${url}|${tw}x${th}`;

  // Apply an already-computed result synchronously so a re-render does not flash the
  // low-quality original. A null value means keep the original.
  if (_hqValue.has(key)) {
    const v = _hqValue.get(key);
    imgEl.src = v || url;
    return;
  }

  imgEl.src = url; // first sight of this image: show the original, swap when ready
  feHQImageDownscale(url, tw, th).then(dataURL => {
    if (!dataURL) return;
    if (imgEl.dataset.feHqSrc !== url) return; // swapped to another image meanwhile
    imgEl.src = dataURL;
  });
}

// ─── Actor sheet portraits (all systems) ─────────────────────────────────────

function _rootEl(html) {
  // v13 passes a jQuery wrapper, v14 an HTMLElement. Only unwrap when it really is jQuery —
  // on a <form>, html[0] returns the first form control, not the form.
  if (html && html.jquery) return html[0] ?? null;
  if (html instanceof HTMLElement) return html;
  return html?.[0] ?? html ?? null;
}

function _displaySize(imgEl) {
  const r = imgEl.getBoundingClientRect();
  let w = r.width, h = r.height;
  if (!w || !h) {
    const cs = getComputedStyle(imgEl);
    w = parseFloat(cs.width) || 0;
    h = parseFloat(cs.height) || 0;
  }
  return { w: Math.round(w) || 150, h: Math.round(h) || 200 };
}

// Actor sheet portrait selectors, per system: dx3rd uses img.profile-img, Tidy5e
// img.actor-image, stock dnd5e (quadrone) an unclassed [data-action="showArtwork"] img, and
// generic Foundry img.profile / [data-edit="img"]. Chosen to match only large portrait
// images, never small icons.
//
// MUST KEEP — every match here is processed as `assumeEditable` (see _processSheetPortraits),
// never as a plain display image, EVEN THOUGH some of these selectors (showArtwork /
// showPortraitArtwork) exist specifically to catch the LOCKED-sheet state where no
// [data-edit] attribute is present yet. Verified live in Tidy5e's bundled ActorPortrait
// component: `set_attribute(img, "data-edit", context.unlocked ? "img" : null)` — the SAME
// <img> node loses/gains data-edit purely from the lock toggle, a client-side Svelte state
// change that fires NO renderActorSheet(V2) hook. If this function ever substituted `src`
// while locked (data-edit absent), unlocking afterward only flips data-edit back on — Svelte's
// reactive `set_attribute(img, "src", actor.img)` does not re-run (its dependency, actor.img,
// never changed), so the already-corrupted data: URL `src` survives into the now-`[data-edit]`
// element untouched. The next unrelated form submit (any submitOnChange field) then has
// FormDataExtended read that data: URL as the "img" field and Foundry uploads it as a new
// ~300px file, permanently replacing the real portrait — reproduced 2026-09-03, actor.img
// still low-res after closing and reopening the sheet. assumeEditable makes every sheet
// portrait always go through the srcset-safe path regardless of the CURRENT data-edit state.
const FE_SHEET_PORTRAIT_SELECTOR = [
  "img.profile-img",
  "img.actor-image",
  "img.profile",
  'img[data-edit="img"]',
  // On stock dnd5e (quadrone) the data-action sits on the <img> itself, unlike Tidy.
  'img[data-action="showArtwork"]',
  'img[data-action="showPortraitArtwork"]',
  '[data-action="showArtwork"] img',
  '[data-action="showPortraitArtwork"] img',
].join(", ");

function _processSheetPortraits(html) {
  const root = _rootEl(html);
  if (!root?.querySelectorAll) return;
  const seen = new Set();
  for (const img of root.querySelectorAll(FE_SHEET_PORTRAIT_SELECTOR)) {
    if (img.tagName !== "IMG" || seen.has(img)) continue;
    seen.add(img);
    const url = img.getAttribute("src");
    if (!url || url.startsWith("data:")) continue;
    const { w, h } = _displaySize(img);
    feApplyHQPortrait(img, url, w, h, { assumeEditable: true });
  }
}

Hooks.on("renderActorSheet", (app, html) => _processSheetPortraits(html));
Hooks.on("renderActorSheetV2", (app, html) => _processSheetPortraits(html));

// ─── Sidebar directory thumbnails (deferred) ─────────────────────────────────
// Actor.thumbnail === actor.img (full resolution), so directory thumbnails alias the same
// way. With dozens of lazy-loaded actors, an IntersectionObserver processes only what is
// actually on screen rather than decoding every large image at once. Results are cached.
let _thumbObserver = null;
function _thumbIO() {
  if (_thumbObserver) return _thumbObserver;
  _thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const img = e.target;
      _thumbObserver.unobserve(img);
      const run = () => {
        if (!img.isConnected) return;
        const url = img.dataset.feThumbSrc || img.getAttribute("src");
        if (!url || url.startsWith("data:")) return;
        const { w, h } = _displaySize(img);
        feApplyHQPortrait(img, url, w, h);
      };
      // naturalWidth > 0 means pixels are available. Do NOT test `complete`: a loaded lazy
      // image can still report false, and `load` will not fire again.
      if (img.naturalWidth > 0) run();
      else img.addEventListener("load", run, { once: true });
    }
  }, { rootMargin: "200px" });   // viewport-relative; IO accounts for the sidebar's own clipping
  return _thumbObserver;
}

function _processDirectoryThumbs(html) {
  const root = _rootEl(html);
  if (!root?.querySelectorAll) return;
  const io = _thumbIO();
  for (const img of root.querySelectorAll("img.thumbnail")) {
    if (img.dataset.feThumbObs) continue;          // already observed in this render
    img.dataset.feThumbObs = "1";
    if (!img.dataset.feThumbSrc) {                 // preserve the pre-swap original path
      const s = img.getAttribute("src");
      if (s && !s.startsWith("data:")) img.dataset.feThumbSrc = s;
    }
    io.observe(img);
  }
}

// Only observe directories that shrink a full-resolution source into a small thumbnail:
// Actor (thumbnail === actor.img, a 10-30x reduction) and Scene (background-derived).
// Item/Journal/Cards/RollTable are 64px icons and SVGs — measured over 5424 dnd5e items,
// zero needed downscaling — so observing them would register thousands of useless
// IntersectionObservers and burn work on every scroll.
for (const hook of ["renderActorDirectory", "renderSceneDirectory"]) {
  Hooks.on(hook, (app, html) => _processDirectoryThumbs(html));
}
