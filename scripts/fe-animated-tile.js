// Female-cupwhi: Animated tile textures (gif / animated webp / apng / animated avif).
//
// WHY THIS EXISTS
// ---------------
// `CONST.IMAGE_FILE_EXTENSIONS` (common/constants.mjs) lists gif/webp/apng/avif, so Foundry
// happily *stores* them in `TileDocument#texture.src`. But the render path builds ONE static
// `PIXI.BaseTexture` via `loadTexture()` -> `PIXI.Assets.load()` (client/canvas/loader.mjs),
// and the only thing core recognises as animated is a `<video>`:
//
//     get isVideo() { return this.sourceElement?.tagName === "VIDEO"; }   // placeables/tile.mjs
//
// So webm/mp4 play and gif/webp render as a frozen first frame. This module decodes the real
// frames with WebCodecs `ImageDecoder`, paints them into a canvas-backed BaseTexture, and
// advances that texture on the PIXI ticker.
//
// SCOPE: Tiles only. Tokens and scene backgrounds deliberately untouched — a token's mesh goes
// through ring/overlay/detection-filter paths that a texture swap would have to keep in step
// with, and scene backgrounds are large enough that full pre-decoding is a different tradeoff.
//
// v14 NOTE: we never touch geometry. A Tile's x,y is a texture ANCHOR on v14 (center) but the
// top-left on v13 — swapping only `mesh.texture`, at identical pixel dimensions, sidesteps that
// difference entirely. Do not "improve" this by repositioning anything.
//
// OWNERSHIP: `Tile#_destroy` only destroys a base texture when `#unlinkedVideo` is set, which is
// never true for an image source. So core will NOT free our per-tile BaseTexture — `feAtDetach`
// must, and it must also restore the original texture so core's own cached asset survives.
//
// Self-contained except for fe-constants.js. Canvas-only (no CSS, no HTML).

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

/* -------------------------------------------- */
/*  Settings                                    */
/* -------------------------------------------- */

function feAtSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return FE_DEFAULTS[key]; }
}

function feAtEnabled() {
  return !!feAtSetting(S.ANIMATED_TILE_ENABLED);
}

/* -------------------------------------------- */
/*  Constants                                   */
/* -------------------------------------------- */

// Extensions that CAN carry animation, mapped to the mime `ImageDecoder` accepts — which is NOT
// always core's mime. Core lists apng as "image/apng" (constants.mjs:1621) but Chrome's WebCodecs
// decoder only registers "image/png", and it animates APNG through that type. Do not "correct"
// this back to CONST.IMAGE_FILE_EXTENSIONS: isTypeSupported("image/apng") is false and every
// .apng tile would silently fall back to a still frame.
//
// A plain .png can also be an APNG, but it is deliberately absent: including it would mean a
// fetch + decode probe for every png tile on every scene, to catch a file the user could simply
// name .apng.
const FE_AT_MIME_BY_EXT = Object.freeze({
  gif: "image/gif",
  webp: "image/webp",
  apng: "image/png",
  avif: "image/avif",
});

// GIF frame delays of 0 (and the legacy 10ms) are rendered by every browser as 100ms. Match that
// rather than spinning the ticker on a delay no real viewer honours.
const FE_AT_MIN_DELAY_MS = 20;
const FE_AT_ZERO_DELAY_MS = 100;
const FE_AT_DEFAULT_DELAY_MS = 100;

/* -------------------------------------------- */
/*  Decoded-animation cache                     */
/* -------------------------------------------- */

/**
 * src -> Promise<Animation|null>. A resolved `null` is a permanent "this file is not animated
 * (or cannot be decoded)" verdict, so a still webp costs exactly one fetch+probe for the whole
 * session and never re-enters the pipeline.
 *
 * Animation: {frames: ImageBitmap[], delays: number[], width, height, totalMs}
 */
const _feAtCache = new Map();

/** Tile object -> live animation entry. */
const _feAtActive = new Map();

function feAtExtOf(src) {
  if (typeof src !== "string" || !src) return "";
  const clean = src.split("?")[0].split("#")[0];
  const dot = clean.lastIndexOf(".");
  return dot < 0 ? "" : clean.slice(dot + 1).toLowerCase();
}

function feAtMimeOf(src) {
  return FE_AT_MIME_BY_EXT[feAtExtOf(src)] ?? null;
}

/* -------------------------------------------- */
/*  Decoding                                    */
/* -------------------------------------------- */

/**
 * Fully decode every frame of an animated image.
 *
 * Frames are decoded eagerly and kept as ImageBitmaps with NO size or frame-count ceiling — a
 * deliberate choice: playback must be smooth and predictable, and a decode-on-demand scheme
 * drops frames whenever the decoder lags. The cost is bounded only by what the GM actually
 * places on the scene.
 *
 * Each decoded frame is already fully composed (the decoder applies GIF disposal/blending), so
 * playback is a plain clear+draw per frame, not a delta composite.
 *
 * @param {string} src
 * @returns {Promise<object|null>} null when the file is static, undecodable, or unreachable.
 */
async function feAtDecodeAnimation(src) {
  const type = feAtMimeOf(src);
  if (!type) return null;
  if (typeof globalThis.ImageDecoder !== "function") return null;

  let decoder = null;
  const frames = [];
  try {
    if (!(await globalThis.ImageDecoder.isTypeSupported(type))) return null;

    const response = await fetch(src);
    if (!response.ok) return null;
    const data = await response.arrayBuffer();

    decoder = new globalThis.ImageDecoder({ data, type });
    // `completed` guarantees `frameCount` is final rather than a streaming estimate.
    await decoder.completed;

    const track = decoder.tracks?.selectedTrack;
    const frameCount = track?.frameCount ?? 0;
    if (!track?.animated || frameCount < 2) return null;

    const delays = [];
    for (let i = 0; i < frameCount; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      // `duration` is in microseconds and MUST be read before close().
      const micro = image.duration;
      let ms = Number.isFinite(micro) ? micro / 1000 : FE_AT_DEFAULT_DELAY_MS;
      if (ms <= 10) ms = FE_AT_ZERO_DELAY_MS;
      delays.push(Math.max(FE_AT_MIN_DELAY_MS, ms));
      const bitmap = await createImageBitmap(image);
      image.close();
      frames.push(bitmap);
    }

    const width = frames[0].width;
    const height = frames[0].height;
    if (!width || !height) throw new Error("decoded frame has no dimensions");

    return {
      frames,
      delays,
      width,
      height,
      totalMs: delays.reduce((a, b) => a + b, 0),
    };
  } catch (err) {
    console.warn(`[${MODULE_ID}] animated tile decode failed for ${src}`, err);
    for (const bitmap of frames) { try { bitmap.close(); } catch (_) {} }
    return null;
  } finally {
    try { decoder?.close(); } catch (_) {}
  }
}

/** Cached, in-flight-deduped accessor for {@link feAtDecodeAnimation}. */
function feAtGetAnimation(src) {
  if (_feAtCache.has(src)) return _feAtCache.get(src);
  const promise = feAtDecodeAnimation(src);
  _feAtCache.set(src, promise);
  return promise;
}

/* -------------------------------------------- */
/*  Attach / detach                             */
/* -------------------------------------------- */

function feAtAttach(tile, src, anim) {
  if (_feAtActive.has(tile)) return;
  const mesh = tile.mesh;
  const original = tile.texture;
  if (!mesh || !original) return;

  const surface = document.createElement("canvas");
  surface.width = anim.width;
  surface.height = anim.height;
  const ctx = surface.getContext("2d", { alpha: true, willReadFrequently: false });
  if (!ctx) return;

  // No mipmaps: the texture is re-uploaded every frame, and regenerating a mip chain per frame
  // costs far more than the sharpness it buys on a tile that is usually near 1:1.
  // alphaMode is left unset ON PURPOSE — PIXI auto-detects UNPACK (premultiply on upload) for a
  // canvas resource. Forcing PMA claims the canvas is already premultiplied and paints dark
  // fringes around every transparent edge, which is exactly what a cut-out tile is made of.
  const baseTexture = new PIXI.BaseTexture(surface, {
    mipmap: PIXI.MIPMAP_MODES.OFF,
    scaleMode: PIXI.SCALE_MODES.LINEAR,
  });
  const texture = new PIXI.Texture(baseTexture);

  const entry = { tile, src, anim, ctx, surface, texture, baseTexture, original, index: -1, elapsed: 0 };
  _feAtActive.set(tile, entry);

  feAtPaintFrame(entry, 0);
  tile.texture = texture;
  mesh.texture = texture;

  feAtEnsureTicker();
}

function feAtDetach(tile) {
  const entry = _feAtActive.get(tile);
  if (!entry) return;
  _feAtActive.delete(tile);

  // Restore core's own cached texture BEFORE destroying ours, so the tile is never left holding
  // a destroyed texture if it survives (setting change, src change) rather than being torn down.
  if (!tile.destroyed) {
    try {
      if (tile.texture === entry.texture) tile.texture = entry.original;
      if (tile.mesh && !tile.mesh.destroyed && tile.mesh.texture === entry.texture) {
        tile.mesh.texture = entry.original;
      }
    } catch (_) {}
  }

  // Ours to free — core only destroys a tile base texture for unlinked video (tile.mjs:243).
  try { entry.texture.destroy(true); } catch (_) {}
  entry.surface.width = entry.surface.height = 0;
}

function feAtPaintFrame(entry, index) {
  if (entry.index === index) return;
  const bitmap = entry.anim.frames[index];
  if (!bitmap) return;
  entry.index = index;
  entry.ctx.clearRect(0, 0, entry.anim.width, entry.anim.height);
  entry.ctx.drawImage(bitmap, 0, 0);
  entry.baseTexture.update();
}

/* -------------------------------------------- */
/*  Playback ticker                             */
/* -------------------------------------------- */

let _feAtTickerBound = false;
let _feAtLastTime = 0;

function feAtEnsureTicker() {
  if (_feAtTickerBound) return;
  const ticker = canvas?.app?.ticker;
  if (!ticker) return;
  _feAtLastTime = performance.now();
  // NORMAL, not LOW: PIXI.Application registers its own render at UPDATE_PRIORITY.LOW, and a
  // same-priority listener added later runs AFTER it — every frame would paint one frame stale.
  ticker.add(feAtTick, null, PIXI.UPDATE_PRIORITY.NORMAL);
  _feAtTickerBound = true;
}

function feAtReleaseTicker() {
  if (!_feAtTickerBound) return;
  try { canvas?.app?.ticker?.remove(feAtTick, null); } catch (_) {}
  _feAtTickerBound = false;
}

function feAtTick() {
  const now = performance.now();
  // A backgrounded tab resumes with an enormous gap; clamp so we advance one step, not hundreds.
  const dt = Math.min(250, now - _feAtLastTime);
  _feAtLastTime = now;
  if (!_feAtActive.size) { feAtReleaseTicker(); return; }

  for (const [tile, entry] of _feAtActive) {
    if (tile.destroyed) { _feAtActive.delete(tile); continue; }
    // An off-screen or hidden tile still accumulates time (so it stays in sync with visible
    // copies of the same art) but skips the GPU upload until it is drawn again.
    const visible = tile.visible && tile.renderable && (tile.mesh?.visible !== false);

    entry.elapsed += dt;
    const { delays } = entry.anim;
    let index = entry.index < 0 ? 0 : entry.index;
    let guard = delays.length + 1;
    while (entry.elapsed >= delays[index] && guard-- > 0) {
      entry.elapsed -= delays[index];
      index = (index + 1) % delays.length;
    }
    if (guard <= 0) entry.elapsed = 0;  // pathologically long frame: resync instead of spinning
    if (visible) feAtPaintFrame(entry, index);
    else entry.index = index;           // keep the cursor without touching the texture
  }
}

/* -------------------------------------------- */
/*  Tile lifecycle                              */
/* -------------------------------------------- */

async function feAtConsiderTile(tile) {
  if (!feAtEnabled()) return;
  if (!tile || tile.destroyed || _feAtActive.has(tile)) return;
  const src = tile.document?.texture?.src;
  if (!feAtMimeOf(src)) return;
  if (!tile.mesh || !tile.texture) return;

  const anim = await feAtGetAnimation(src);
  if (!anim) return;
  // The tile may have been destroyed, redrawn, or repointed while we decoded.
  if (tile.destroyed || tile.document?.texture?.src !== src) return;
  if (!feAtEnabled()) return;
  feAtAttach(tile, src, anim);
}

/** Re-evaluate every placed tile — used by the setting onChange, in both directions. */
function feAtRefreshAll() {
  const tiles = canvas?.tiles?.placeables ?? [];
  if (!feAtEnabled()) {
    for (const tile of [..._feAtActive.keys()]) feAtDetach(tile);
    feAtReleaseTicker();
    return;
  }
  for (const tile of tiles) feAtConsiderTile(tile);
}

/**
 * Drop decoded frames for animations no longer used by anything on the canvas. Bitmaps are held
 * with no size cap by design, so scene changes are the one place they must be reclaimed —
 * otherwise every scene visited in a session stays resident for the whole session.
 */
function feAtPruneCache() {
  const live = new Set([..._feAtActive.values()].map(e => e.src));
  for (const [src, promise] of [..._feAtCache]) {
    if (live.has(src)) continue;
    _feAtCache.delete(src);
    Promise.resolve(promise).then(anim => {
      if (!anim) return;
      for (const bitmap of anim.frames) { try { bitmap.close(); } catch (_) {} }
    }).catch(() => {});
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.ANIMATED_TILE_ENABLED, {
    name: "타일 애니메이션 이미지 재생",
    hint: "타일에 지정한 움직이는 gif/webp/apng를 실제로 재생합니다. Foundry 기본 동작은 첫 프레임 정지 이미지입니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.ANIMATED_TILE_ENABLED],
    onChange: () => feAtRefreshAll(),
  });
});

// `drawTile` fires from PlaceableObject#draw (placeable-object.mjs:546) after Tile#_draw has
// resolved `tile.texture` and `tile.mesh`, which is exactly what we swap.
Hooks.on("drawTile", tile => { feAtConsiderTile(tile); });

Hooks.on("destroyTile", tile => feAtDetach(tile));

// A texture.src change normally forces a redraw, but a preview/refresh path can repoint the
// document without one. Detaching here lets the next draw re-attach against the new source.
Hooks.on("refreshTile", tile => {
  const entry = _feAtActive.get(tile);
  if (!entry) return;
  if (tile.document?.texture?.src !== entry.src) feAtDetach(tile);
});

Hooks.on("canvasTearDown", () => {
  for (const tile of [..._feAtActive.keys()]) feAtDetach(tile);
  feAtReleaseTicker();
  feAtPruneCache();
});

Hooks.on("canvasReady", () => { feAtRefreshAll(); });
