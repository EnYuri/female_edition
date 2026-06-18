// fe-portrait-hq.js
// 포트레이트 고품질 다운스케일 — 거대한 원본 이미지(예: 1024×1536, 2323×4096)를
// 표시 크기(예: 99×80, 150×200)로 줄일 때 브라우저의 GPU 합성 경로가 저품질 bilinear
// (밉맵 없음) 축소를 적용해 안티엘리어싱이 깨지는(픽셀처럼 깨져 보이는) 현상을 해결한다.
//
// 원인: Foundry는 WebGL 보드(#board) 때문에 페이지 전체가 GPU 합성 모드로 동작한다.
//   이 모드에서 <img> 의 10~15배 축소는 단일 bilinear 샘플(2×2 텍셀)로 처리되어
//   고주파 디테일(머리카락 가닥 등)이 sparkle/계단 현상을 일으킨다. CSS image-rendering
//   에는 "고품질 축소"를 강제하는 키워드가 없으므로(auto/pixelated/crisp-edges 뿐),
//   유일한 신뢰 가능한 해법은 브라우저에게 과도한 축소를 시키지 않는 것이다.
//
// 해법: 캔버스로 단계적 절반 축소(stepped halving) + imageSmoothingQuality="high" 로
//   표시 크기의 ~2배(HiDPI/줌 여유)까지 미리 줄인 비트맵을 만들어 <img>.src 로 교체한다.
//   결과 비트맵은 표시 크기에 근접하므로 브라우저의 추가 축소는 ≤2배(고품질 영역)에 머문다.
//
// CORS: 동일 출처(Foundry 유저 데이터) 이미지는 toDataURL 가능. 외부 교차 출처 이미지는
//   캔버스가 오염되어 toDataURL 이 throw → null 반환 → 원본 src 유지(이미지는 정상 표시).

const _hqCache = new Map();   // key `${url}|${tw}x${th}` → Promise<dataURL|null>
const _hqValue = new Map();   // key → 해결된 dataURL|null (동기 fast-path용)
const _HQ_CACHE_MAX = 160;

// 동시 처리 제한 — 디렉토리에 큰 이미지(예: 3328²)가 여러 장일 때 동시 디코드로 인한
// 메모리 급증을 막는다. (status/sheet 는 1~2장이라 영향 없음)
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

// 효율 경로: fetch→blob→createImageBitmap(resizeQuality:"high"). 디코드 단계에서 바로
//   고품질 축소 → 풀사이즈 캔버스 불필요(메모리 최소). probe 로 원본 비율만 읽고 닫는다.
async function _viaImageBitmap(url, tw, th) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error("http " + resp.status);
  const blob = await resp.blob();
  const probe = await createImageBitmap(blob);
  const w = probe.width, h = probe.height;
  probe.close?.();
  if (!w || !h) return null;
  const scale = Math.max(tw / w, th / h);
  if (scale >= 1) return null;                          // 확대 불필요 → 원본 유지
  const fw = Math.max(1, Math.round(w * scale));
  const fh = Math.max(1, Math.round(h * scale));
  let bmp;
  try { bmp = await createImageBitmap(blob, { resizeWidth: fw, resizeHeight: fh, resizeQuality: "high" }); }
  catch { bmp = await createImageBitmap(blob); }        // resize 옵션 미지원 → drawImage 축소
  const c = document.createElement("canvas");
  c.width = fw; c.height = fh;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
  x.drawImage(bmp, 0, 0, fw, fh);
  bmp.close?.();
  try { return c.toDataURL("image/webp", 0.92); }
  catch { try { return c.toDataURL("image/png"); } catch { return null; } }
}

// 폴백: <img> + 단계적 절반 축소 캔버스. createImageBitmap 미지원/실패 환경용.
//   decode() 는 무거운 WebGL 페이지에서 hang 사례 → onload/타임아웃 사용.
async function _viaImg(url, tw, th) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;                                        // crossOrigin 미설정 — 외부 이미지도 표시는 되게
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
  while (cw > finalW * 2) {                             // 한 번에 1/2 이하면 bilinear 도 양호
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
    catch { /* 교차출처 fetch 실패/네트워크 → <img> 폴백 시도 */ }
  }
  return _viaImg(url, tw, th);
}

// url 을 (tw×th 커버) 고품질 비트맵 데이터 URL 로 변환. 실패 시 null. 동시성·캐시 적용.
export function feHQImageDownscale(url, tw, th) {
  if (!url || typeof url !== "string") return Promise.resolve(null);
  if (url.startsWith("data:")) return Promise.resolve(null); // 이미 처리된 비트맵
  const key = `${url}|${tw}x${th}`;
  const cached = _hqCache.get(key);
  if (cached) { _hqCache.delete(key); _hqCache.set(key, cached); return cached; } // LRU bump

  const job = _enqueue(() => _produce(url, tw, th)).then(v => { _hqValue.set(key, v); return v; });
  _hqCache.set(key, job);
  if (_hqCache.size > _HQ_CACHE_MAX) {
    const oldest = _hqCache.keys().next().value;
    _hqCache.delete(oldest);
    _hqValue.delete(oldest);
  }
  return job;
}

// <img> 에 원본을 즉시 표시한 뒤, 고품질 축소본이 준비되면 교체.
// cssW/cssH = 표시 크기(CSS px). dpr·2배 오버샘플로 줌/HiDPI 에서도 선명하게.
export function feApplyHQPortrait(imgEl, url, cssW, cssH) {
  if (!imgEl) return;

  // CRITICAL — never substitute the `src` of an editable image.
  // Core's FormDataExtended serializes an editable image's value straight from the DOM:
  //   client/applications/ux/form-data-extended.mjs:144 → `value = element.getAttribute("src")`.
  // Used on BOTH ApplicationV2 (change/submit handlers) AND ApplicationV1 FormApplication
  // (`_getSubmitData`, fired on close/submit with NO DOM event — confirmed live on dx3rd's V1
  // DX3rdActorSheet: close→submit→_updateObject→actor.update({img})). A downscaled data: URL in
  // `src` would therefore be saved as actor.img and uploaded to worlds/<world>/assets/<type>/
  // img-*.webp, permanently replacing the real high-res file with a ~300px copy. So editable
  // portraits get NO HQ downscale — the original path is left untouched. The image-hover overlay
  // and directory thumbnails are display-only (not form fields) and keep HQ below.
  if (imgEl.hasAttribute?.("data-edit")) {
    if (url) imgEl.dataset.feHqSrc = url; // let image-hover resolve the real high-res original
    return;
  }

  if (!url) { imgEl.removeAttribute("src"); imgEl.dataset.feHqSrc = ""; return; }

  // 동일 url 재요청 무시 (재렌더 중복 방지)
  if (imgEl.dataset.feHqSrc === url) return;
  imgEl.dataset.feHqSrc = url;

  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const k = 2; // 오버샘플 배수
  const tw = Math.max(1, Math.ceil((cssW || 98) * dpr * k));
  const th = Math.max(1, Math.ceil((cssH || 80) * dpr * k));
  const key = `${url}|${tw}x${th}`;

  // 이미 계산된 결과가 있으면 즉시 적용 — 재렌더 시 원본(저화질) 플래시 방지.
  // 값이 null(확대/CORS 오염)이면 원본을 그대로 쓴다.
  if (_hqValue.has(key)) {
    const v = _hqValue.get(key);
    imgEl.src = v || url;
    return;
  }

  imgEl.src = url; // 처음 보는 이미지: 원본 먼저 표시 후 준비되면 교체
  feHQImageDownscale(url, tw, th).then(dataURL => {
    if (!dataURL) return;
    if (imgEl.dataset.feHqSrc !== url) return; // 그 사이 다른 이미지로 바뀜
    imgEl.src = dataURL;
  });
}

// ─── 캐릭터 시트 포트레이트 자동 처리 — 전 시스템 ──────────────────────────────

function _rootEl(html) {
  // v13: jQuery 래퍼 / v14: HTMLElement
  // 주의: <form> 에서 html[0] 은 첫 폼 컨트롤을 반환하므로 jQuery 일 때만 언랩.
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

// 액터 시트 포트레이트 셀렉터 (시스템별):
//   dx3rd            → img.profile-img
//   dnd5e Tidy5e     → img.actor-image
//   dnd5e 기본(quadrone) → [data-action="showArtwork"] img (클래스 없음)
//   범용 Foundry      → img.profile, [data-edit="img"], [data-action="showPortraitArtwork"] img
// 작은 아이콘이 아닌 "큰 포트레이트/프로필 이미지"만 잡도록 고른 선택자다.
const FE_SHEET_PORTRAIT_SELECTOR = [
  "img.profile-img",
  "img.actor-image",
  "img.profile",
  'img[data-edit="img"]',
  // dnd5e 기본(quadrone) 시트는 data-action 이 <img> 자신에 붙는다(설명서·Tidy 와 다름).
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
    feApplyHQPortrait(img, url, w, h);
  }
}

Hooks.on("renderActorSheet", (app, html) => _processSheetPortraits(html));
Hooks.on("renderActorSheetV2", (app, html) => _processSheetPortraits(html));

// ─── 사이드바 디렉토리 썸네일 (지연 처리) ──────────────────────────────────────
// Actor.thumbnail === actor.img (풀해상도)라 디렉토리의 작은 썸네일(<img class="thumbnail">)도
// 동일하게 깨진다(코어 partial: templates/sidebar/partials/document-partial.hbs).
// 액터 수십 개 + loading="lazy" 이므로 IntersectionObserver 로 "화면에 보이는 것만" 지연 처리해
// 한꺼번에 큰 이미지를 디코드하지 않는다(메모리 보호). 처리 결과는 캐시 → 재렌더 시 즉시 적용.
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
      // naturalWidth>0 = 픽셀 보유(로드 완료). lazy 이미지는 로드됐어도 complete 가
      // false 인 경우가 있어 complete 에 의존하면 안 된다(load 가 다시 안 불림).
      if (img.naturalWidth > 0) run();
      else img.addEventListener("load", run, { once: true });
    }
  }, { rootMargin: "200px" });   // 뷰포트 기준 — 사이드바 내부 스크롤 클리핑도 IO 가 반영
  return _thumbObserver;
}

function _processDirectoryThumbs(html) {
  const root = _rootEl(html);
  if (!root?.querySelectorAll) return;
  const io = _thumbIO();
  for (const img of root.querySelectorAll("img.thumbnail")) {
    if (img.dataset.feThumbObs) continue;          // 이 렌더에서 이미 관찰 중
    img.dataset.feThumbObs = "1";
    if (!img.dataset.feThumbSrc) {                 // 스왑 전 원본 경로 보존
      const s = img.getAttribute("src");
      if (s && !s.startsWith("data:")) img.dataset.feThumbSrc = s;
    }
    io.observe(img);
  }
}

// 풀해상도 원본을 작은 썸네일로 깎아 쓰는 디렉토리만 관찰한다.
//   · Actor 디렉토리: thumbnail === actor.img (풀해상도 포트레이트) → 10~30× 축소 → 다운스케일 필요.
//   · Scene 디렉토리: 배경 기반 썸네일 → 큰 경우 있음.
// Item/Journal/Cards/RollTable 은 작은 아이콘(64px·SVG)이라 다운스케일이 불필요하다
// (실측: dnd5e 아이템 5424개 관찰 시 다운스케일 0건). 그 디렉토리들까지 관찰하면
// 수천 개 IntersectionObserver 등록 + 스크롤마다 무의미한 처리가 쌓여 낭비이므로 제외한다.
for (const hook of ["renderActorDirectory", "renderSceneDirectory"]) {
  Hooks.on(hook, (app, html) => _processDirectoryThumbs(html));
}
