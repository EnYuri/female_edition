/**
 * fe-image-hover.js — Token image hover overlay
 * Ported from image-hover v3.1 (MIT) into female_edition namespace.
 * Compatible with Foundry VTT v13 and v14 (ApplicationV2 + HandlebarsApplicationMixin).
 */

import { feApplyHQPortrait } from "./fe-portrait-hq.js";

const _IH_MODULE = "female_edition";
const _IH_SOCKET_TYPE = "fe-image-hover";
const _IH_DEFAULT_TOKEN = "icons/svg/mystery-man.svg";

const _IH_VIDEO_EXTS = new Set(["mp4", "ogg", "webm", "m4v"]);

// Max upscale factor for the hover image. Small source art (e.g. dx3rd ~300px
// portraits) shown at the size setting (e.g. 384px) gets upscaled and softens —
// there is no detail to invent. We allow a mild upscale (sources stay reasonably
// large) but cap it so heavy upscaling (e.g. 2×+) never produces a blurry image.
// Beyond the cap the image is pinned to native×factor (sharper, slightly smaller).
// e.g. a 300px source is shown at most ~375px (1.25×) instead of a blurry 640px.
const _IH_MAX_UPSCALE = 1.25;

const { HandlebarsApplicationMixin } = foundry.applications.api;

/** url → {width, height} dimension cache */
let _ihCache = {};
/** setTimeout handle for showToAll auto-close */
let _ihTimer;
/** setTimeout handle for hover-delay — cleared before re-creating to prevent pile-up */
let _ihDelayTimer;
/** True while showToAll is active — suppresses new hover events */
let _ihShowAll = false;

/** True after X is pressed while hovering — cleared when mouse leaves the token */
let _ihKeyToggled = false;

// ── DOM portrait hover (status UI cards / character & item sheets) ────────────
/** Standalone fixed overlay element for DOM-hovered portraits (non-token) */
let _ihDomOverlay = null;
/** True after X is pressed while hovering a DOM portrait — cleared on leave */
let _ihDomToggled = false;
/** Full-resolution art URL of the portrait currently under the cursor, or null */
let _ihHoverArtUrl = null;
/** setTimeout handle for DOM-portrait hover delay */
let _ihDomDelayTimer;

// Runtime settings cache (populated in init, refreshed on settings close)
let _ihPermission = 0;
let _ihEnabled = true;
let _ihPosition = "Bottom left";
let _ihSize = 7;
let _ihArtType = "character";
let _ihDelay = 0;
let _ihShowAllTimer = 6000;

// ── Settings ───────────────────────────────────────────────────────────────

function _ihRegisterSettings() {
  game.settings.register(_IH_MODULE, "ihPermission", {
    name: "Image Hover: 아트 표시 최소 권한",
    hint: "캐릭터 아트를 보기 위해 필요한 최소 Actor 권한.",
    scope: "world",
    config: true,
    restricted: true,
    choices: { 0: "없음", 1: "제한됨", 2: "관찰자", 3: "소유자" },
    default: 0,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihArtType", {
    name: "Image Hover: 표시할 아트 유형",
    hint: "호버 시 표시할 아트 종류.",
    scope: "world",
    config: true,
    restricted: true,
    choices: {
      character: "캐릭터 아트",
      token: "토큰 아트",
      wildcard: "와일드카드일 때 토큰 아트",
      linked: "연결 해제된 토큰일 때 토큰 아트",
    },
    default: "character",
    type: String,
    onChange: () => _ihLoadSettings(),
  });

  game.keybindings.register(_IH_MODULE, "ihShowAllKey", {
    name: "Image Hover: 모두에게 아트 표시 (GM 전용)",
    restricted: true,
    editable: [],
    onDown: () => {
      const token = canvas.tokens.hover;
      if (!token) return;
      canvas.hud.imageHover?.showToAll(token);
      game.socket.emit("module.female_edition", { type: _IH_SOCKET_TYPE, tokenID: token.id });
    },
  });

  game.settings.register(_IH_MODULE, "ihShowAllTimer", {
    name: "Image Hover: 전체 표시 지속 시간 (ms)",
    hint: "GM의 전체 표시 키바인드 사용 시 아트가 유지되는 시간(밀리초).",
    restricted: true,
    scope: "world",
    config: true,
    range: { min: 1000, max: 15000, step: 200 },
    default: 6000,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihEnabled", {
    name: "Image Hover: 활성화/비활성화",
    hint: "비활성화 시 이 클라이언트에서 Image Hover를 끕니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => { _ihLoadSettings(); canvas.hud.imageHover?.close(); },
  });

  game.keybindings.register(_IH_MODULE, "ihKeybind", {
    name: "Image Hover: 아트 표시 토글 키",
    hint: "토큰 호버 중 이 키를 누르면 마우스가 토큰을 벗어날 때까지 아트가 표시됩니다. 다시 누르면 취소. 기본값: X",
    editable: [{ key: "KeyX" }],
    onDown: () => {
      const token = canvas.tokens?.hover;
      if (token) {
        if (_ihKeyToggled) {
          // 이미 표시 중 → 취소
          _ihKeyToggled = false;
          if (!_ihShowAll) canvas.hud.imageHover?.close();
        } else {
          _ihKeyToggled = true;
          canvas.hud.imageHover?.showArtworkRequirements(token, true, _ihDelay);
        }
        return;
      }

      // 캔버스 토큰이 아니라 DOM 포트레이트(상태 UI / 캐릭터시트) 위일 때
      if (_ihHoverArtUrl) {
        if (_ihDomToggled) {
          _ihHideDomArt();
        } else {
          _ihDomToggled = true;
          const url = _ihHoverArtUrl;
          clearTimeout(_ihDomDelayTimer);
          _ihDomDelayTimer = setTimeout(() => {
            // 지연 후 재검증: 같은 포트레이트를 계속 호버 중이어야 표시
            if (_ihDomToggled && _ihHoverArtUrl === url) _ihShowDomArt(url);
          }, _ihDelay);
        }
      }
    },
    onUp: () => {
      // 키를 떼도 이미지 유지 — 토큰 이탈 시 hoverToken hook이 해제
    },
  });

  game.settings.register(_IH_MODULE, "ihPosition", {
    name: "Image Hover: 이미지 위치",
    hint: "화면 내 이미지 표시 위치 (개인 설정).",
    scope: "client",
    config: true,
    choices: {
      "Bottom left":  "왼쪽 아래",
      "Bottom right": "오른쪽 아래",
      "Top left":     "왼쪽 위",
      "Top right":    "오른쪽 위",
      Centre:         "중앙",
    },
    default: "Bottom left",
    type: String,
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihSize", {
    name: "Image Hover: 이미지 크기 (화면 너비의 1/N)",
    hint: "값이 작을수록 이미지가 커집니다 (개인 설정).",
    scope: "client",
    config: true,
    range: { min: 3, max: 20, step: 0.5 },
    default: 7,
    type: Number,
    // Refresh runtime cache immediately. Without this, _ihSize only reloaded on
    // closeSettingsConfig, so a programmatic/per-world-hydrated change (which
    // fires onChange, not the dialog-close hook) left the cache stale until the
    // settings dialog was next closed → first hover used the old size.
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihDelay", {
    name: "Image Hover: 표시 지연 시간 (ms)",
    hint: "아트 표시 키를 누른 후 이미지가 나타나기까지 대기 시간(밀리초) — 개인 설정.",
    scope: "client",
    config: true,
    range: { min: 0, max: 5000, step: 100 },
    default: 0,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });
}

function _ihLoadSettings() {
  _ihPermission   = game.settings.get(_IH_MODULE, "ihPermission");
  _ihEnabled      = game.settings.get(_IH_MODULE, "ihEnabled");
  _ihPosition     = game.settings.get(_IH_MODULE, "ihPosition");
  _ihSize         = game.settings.get(_IH_MODULE, "ihSize");
  _ihArtType      = game.settings.get(_IH_MODULE, "ihArtType");
  _ihDelay        = game.settings.get(_IH_MODULE, "ihDelay");
  _ihShowAllTimer = game.settings.get(_IH_MODULE, "ihShowAllTimer");
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _ihFileExt(file) {
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.substring(dot + 1).toLowerCase() : "png";
}

function _ihLoadDimensions(url) {
  return new Promise((resolve, reject) => {
    if (_IH_VIDEO_EXTS.has(_ihFileExt(url))) {
      const video = document.createElement("video");
      video.addEventListener("loadedmetadata", function () {
        resolve({ width: this.videoWidth, height: this.videoHeight });
      });
      video.addEventListener("error", reject);
      video.src = url;
    } else {
      const img = new Image();
      img.addEventListener("load", function () {
        resolve({ width: this.width, height: this.height });
      });
      img.addEventListener("error", reject);
      img.src = url;
    }
  });
}

function _ihCacheToken(url, applyToScreen) {
  _ihLoadDimensions(url).then(({ width, height }) => {
    _ihCache[url] = { width, height };
    if (applyToScreen) canvas.hud.imageHover?._applyToCanvas(url);
  }).catch(() => {});
}

/**
 * Compute image position in CSS viewport pixels (position: fixed coordinate space).
 * Using viewport pixels avoids any scene-coordinate / canvas-zoom mismatch
 * that would occur when the browser or OS zoom level changes.
 *
 * @param {number} imageWidth  Original image/video width in pixels
 * @param {number} imageHeight Original image/video height in pixels
 * @returns {[number, number, number]} [left, top, width] in CSS viewport px
 */
function _ihComputePosition(imageWidth, imageHeight) {
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Target width from the size setting (W / size). Large art beyond this is
  // HQ-downscaled by feApplyHQPortrait (sparkle/aliasing fix). Small art below it
  // would be upscaled — capped here so the upscale never exceeds _IH_MAX_UPSCALE
  // of the native resolution (in DEVICE px, so HiDPI is accounted for). A 300px
  // source therefore shows at most ~450px (1.5×) instead of a blurry 640px.
  let w = W / _ihSize;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const maxUpscaledW = (imageWidth * _IH_MAX_UPSCALE) / dpr; // CSS px cap from native
  if (w > maxUpscaledW) w = maxUpscaledW;
  let h = w * (imageHeight / imageWidth);

  // Clamp height to viewport (downscale only — keeps aspect ratio)
  if (h > H) {
    w = (H / h) * w;
    h = H;
  }

  const sidebar = document.getElementById("sidebar");
  const collapsed = sidebar?.classList.contains("collapsed") ?? true;

  if (_ihPosition === "Centre") {
    const sidebarOffset = collapsed ? 0 : (sidebar?.offsetWidth ?? 0) / 2;
    return [W / 2 - w / 2 - sidebarOffset, H / 2 - h / 2, w];
  }

  const y = _ihPosition.includes("Bottom") ? H - h : 0;

  let x;
  if (_ihPosition.includes("right")) {
    const marginRight = sidebar
      ? parseFloat(window.getComputedStyle(sidebar).marginRight) || 0
      : 0;
    const sidebarW = collapsed ? 0 : (sidebar?.offsetWidth ?? 0) + marginRight;
    x = W - w - sidebarW;
  } else {
    x = 0;
  }

  return [x, y, w];
}

function _ihClearArt() {
  _ihKeyToggled = false;
  if (!_ihShowAll) canvas.hud.imageHover?.close();
  _ihHideDomArt();
}

// ── DOM portrait hover helpers ───────────────────────────────────────────────

/**
 * Resolve the full-resolution art URL for a hovered DOM element, or null.
 * Covers the dx3rd resource (status) UI cards and character/item sheet portraits.
 */
function _ihResolveHoverArt(target) {
  if (!target?.closest) return null;

  // Status UI portrait → owning card's actor.img (always the full-res original).
  if (target.closest(".fedr-portrait")) {
    const card = target.closest(".fedr-actor-card");
    const actor = card?.dataset.actorId && game.actors?.get(card.dataset.actorId);
    if (actor?.img) return actor.img;
  }

  // Sheet portrait <img>. feApplyHQPortrait may swap src to a downscaled data:
  // URL, so prefer the preserved original in dataset.feHqSrc.
  const img = target.closest("img.profile-img, img.profile, img[data-edit='img']");
  if (img) {
    const orig = img.dataset?.feHqSrc;
    if (orig) return orig;
    const src = img.getAttribute("src");
    if (src && !src.startsWith("data:")) return src;
  }
  return null;
}

/** Build/update the overlay element and apply the computed position. */
function _ihRenderDomOverlay(url) {
  const dims = _ihCache[url];
  if (!dims) return;
  const [x, y, w] = _ihComputePosition(dims.width, dims.height);

  if (!_ihDomOverlay) {
    _ihDomOverlay = document.createElement("div");
    _ihDomOverlay.className = "fe-image-hover-hud";
    document.body.appendChild(_ihDomOverlay);
  }

  const isVideo = _IH_VIDEO_EXTS.has(_ihFileExt(url));
  const tag = isVideo ? "video" : "img";
  let media = _ihDomOverlay.firstElementChild;
  if (!media || media.tagName.toLowerCase() !== tag) {
    _ihDomOverlay.textContent = "";
    media = document.createElement(tag);
    media.className = "fe-image-hover-media";
    if (isVideo) {
      media.autoplay = true;
      media.loop = true;
      media.muted = true;
      media.playsInline = true;
    }
    _ihDomOverlay.appendChild(media);
  }
  if (media.getAttribute("src") !== url) media.setAttribute("src", url);

  // HQ downscale for images (see _applyToCanvas / fe-portrait-hq.js).
  if (!isVideo) feApplyHQPortrait(media, url, w, w * (dims.height / dims.width));

  _ihDomOverlay.style.width = `${w}px`;
  _ihDomOverlay.style.left = `${x}px`;
  _ihDomOverlay.style.top = `${y}px`;
  _ihDomOverlay.style.display = "block";
}

/** Show DOM portrait art, caching its dimensions first if needed. */
function _ihShowDomArt(url) {
  if (!url || !_ihEnabled) return;
  if (url in _ihCache) {
    _ihRenderDomOverlay(url);
  } else {
    _ihLoadDimensions(url).then(({ width, height }) => {
      _ihCache[url] = { width, height };
      if (_ihDomToggled) _ihRenderDomOverlay(url);
    }).catch(() => {});
  }
}

function _ihHideDomArt() {
  _ihDomToggled = false;
  clearTimeout(_ihDomDelayTimer);
  if (_ihDomOverlay) _ihDomOverlay.style.display = "none";
}

// ── HUD Class ──────────────────────────────────────────────────────────────

class FeImageHoverHUD extends HandlebarsApplicationMixin(
  foundry.applications.hud.BasePlaceableHUD
) {
  static DEFAULT_OPTIONS = {
    ...super.DEFAULT_OPTIONS,
    classes: ["fe-image-hover-hud"],
    window: { resizable: true },
  };

  static PARTS = {
    body: {
      template: "modules/female_edition/templates/fe-image-hover-hud.html",
    },
  };

  async _prepareContext() {
    const data = await super._prepareContext();
    const token = this.object;
    let image = token.actor.img;
    const isWildcard = token.actor.prototypeToken.randomImg;
    const isLinked = token.document.actorLink;

    if (
      image === _IH_DEFAULT_TOKEN ||
      _ihArtType === "token" ||
      (_ihArtType === "wildcard" && isWildcard) ||
      (_ihArtType === "linked" && !isLinked)
    ) {
      image = token.document.texture.src;
    }

    const specific = token.document.getFlag(_IH_MODULE, "ihSpecificArt");
    if (specific && specific !== "path/image.png") image = specific;

    data.url = image;
    if (_IH_VIDEO_EXTS.has(_ihFileExt(image))) data.isVideo = true;
    return data;
  }

  /** Render to document.body so position: fixed coordinates map 1:1 to viewport pixels. */
  _insertElement(element) {
    document.body.appendChild(element);
  }

  /** Override: position is managed entirely by _ihComputePosition. */
  setPosition() {
    if (!this.object) return;
    this._updatePosition();
  }

  /** Recalculate position after pan/zoom or token art change. */
  _updatePosition() {
    let url = this.object.actor.img;
    const isWildcard = this.object.actor.prototypeToken.randomImg;
    const isLinked = this.object.document.actorLink;
    const specific = this.object.document.getFlag(_IH_MODULE, "ihSpecificArt");

    if (specific && specific !== "path/image.png") {
      url = specific;
    } else if (
      url === _IH_DEFAULT_TOKEN ||
      _ihArtType === "token" ||
      (_ihArtType === "wildcard" && isWildcard) ||
      (_ihArtType === "linked" && !isLinked)
    ) {
      if (this.object.document.texture.src === _IH_DEFAULT_TOKEN) {
        this.close();
        return;
      }
      url = this.object.document.texture.src;
    }

    if (url in _ihCache) {
      this._applyToCanvas(url);
    } else {
      // Art changed on canvas mid-hover — re-cache then apply.
      _ihCacheToken(url, true);
    }
  }

  _applyToCanvas(url) {
    const el = this.element;
    if (!el) return;
    const { width, height } = _ihCache[url];
    const [x, y, w] = _ihComputePosition(width, height);
    el.style.width = `${w}px`;
    el.style.left  = `${x}px`;
    el.style.top   = `${y}px`;

    // HQ downscale: on Foundry's GPU-composited page a raw <img> shrunk 5-15×
    // gets a single bilinear sample → sparkle/aliasing. Route images through the
    // module's stepped-halving downscaler (videos are left untouched). See
    // fe-portrait-hq.js for the rationale.
    const img = el.querySelector("img.fe-image-hover-media");
    if (img) feApplyHQPortrait(img, url, w, w * (height / width));
  }

  /**
   * Evaluate all requirements before displaying the hover art.
   * @param {Token}   token   Canvas token being hovered
   * @param {boolean} hovered Whether cursor is over the token
   * @param {number}  delay   Milliseconds to wait before showing (ihDelay)
   */
  showArtworkRequirements(token, hovered, delay) {
    if (!token?.actor || !_ihEnabled) return;

    // Permission check — ownership["default"] === -1 means "None (INHERIT)" which
    // should not block display based on the individual actor permission.
    if (
      token.actor.permission < _ihPermission &&
      token.actor.ownership.default !== -1
    ) return;

    if (token.document.getFlag(_IH_MODULE, "ihHideArt")) return;

    // Imprecise-vision tokens (e.g. PF2e detection filter) — non-GM should not see art.
    if (token.detectionFilter && !game.user.isGM) return;

    // Mouse button held — user is dragging.
    if (event?.buttons > 0) return;

    // showToAll is active — do not disturb the displayed art.
    if (_ihShowAll) return;

    // Token layer active? Compare against canvas.tokens directly — version-agnostic
    // (avoids a hard dependency on the `foundry.canvas.layers.TokenLayer` path,
    // which would throw in `instanceof` if that namespace differs across cores).
    if (hovered && canvas.activeLayer === canvas.tokens) {
      clearTimeout(_ihDelayTimer);
      _ihDelayTimer = setTimeout(() => {
        // Re-validate after delay: token must still be the hovered one.
        if (
          token === canvas.tokens.hover &&
          token.actor?.img === canvas.tokens.hover?.actor?.img
        ) {
          canvas.hud.imageHover.bind(token);
        } else {
          canvas.hud.imageHover.close();
        }
      }, delay);
    } else {
      this.close();
    }
  }

  /**
   * Show art to this client for showAllTimer ms.
   * Called both locally (GM keybind) and via socket (all other users).
   * @param {Token} token
   */
  showToAll(token) {
    if (!token || !_ihEnabled) return;
    _ihShowAll = true;
    canvas.hud.imageHover.bind(token);
    clearTimeout(_ihTimer);
    _ihTimer = setTimeout(() => {
      _ihShowAll = false;
      canvas.hud.imageHover.close();
    }, _ihShowAllTimer);
  }
}

// ── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Create the HUD instance and pre-cache all token images on the current scene.
 * The html argument is a raw HTMLElement (HeadsUpDisplayContainer is already AppV2).
 */
Hooks.on("renderHeadsUpDisplayContainer", (_app, html) => {
  html.style.zIndex = 70;
  const anchor = document.createElement("template");
  anchor.id = "fe-image-hover-hud";
  html.appendChild(anchor);
  canvas.hud.imageHover = new FeImageHoverHUD();

  // Cache only the tiny default-token SVG dimensions up front (it's the fallback).
  // Per-token portrait dimensions are now cached LAZILY on first hover
  // (showArtworkRequirements → bind → _updatePosition → _ihCacheToken(url, true)),
  // instead of eagerly loading EVERY scene token's full-res actor portrait at each
  // scene draw — which front-loaded dozens of image decodes for art that is often
  // never hovered. First hover of a token incurs one small dimension-load, then caches.
  _ihCacheToken(_IH_DEFAULT_TOKEN, false);
});

/** (Token portrait dimensions are cached lazily on first hover — see above.) */

/** Main hover entry point. */
Hooks.on("hoverToken", (token, hovered) => {
  if (_ihShowAll || !canvas.hud.imageHover) return;
  if (!hovered) {
    // 토큰에서 마우스가 떠남 → 래치 해제 + 이미지 닫기
    _ihKeyToggled = false;
    canvas.hud.imageHover.close();
    return;
  }
  // 호버 진입: X 키를 누를 때까지 이미지 자동 표시 없음
});

/** Inject GM-only options into the token config appearance tab. */
async function _ihInjectTokenConfigFields(app, html, _data) {
  if (!game.user.isGM) return;
  // app.token (V1 TokenConfig) or app.document (V2 TokenConfig)
  const token = app.token ?? app.document;
  if (!token) return;

  // v13 passes jQuery, v14 passes raw HTMLElement.
  const rootEl = html instanceof jQuery ? html[0] : html;
  const tab = rootEl.querySelector('div[data-tab="appearance"]');
  if (!tab) return;

  // Dedup: both hooks may fire on the same render in some FVTT versions.
  if (tab.querySelector(".fe-ih-specific-art")) return;

  const hideArt    = await token.getFlag(_IH_MODULE, "ihHideArt");
  const specificArt = (await token.getFlag(_IH_MODULE, "ihSpecificArt")) ?? "path/image.png";

  const contents = await foundry.applications.handlebars.renderTemplate(
    "modules/female_edition/templates/fe-image-hover-token-config.html",
    { hideHoverStatus: hideArt ? "checked" : "", specificArtStatus: specificArt }
  );

  const wrapper = document.createElement("div");
  wrapper.innerHTML = contents;
  while (wrapper.firstChild) tab.appendChild(wrapper.firstChild);

  app.setPosition?.({ height: "auto" });

  rootEl.querySelector("button.fe-ih-picker-button")?.addEventListener("click", () => {
    // Cross-version FilePicker resolution (mirrors fe-theatre.js).
    const FPClass = foundry.applications?.apps?.FilePicker?.implementation
      ?? foundry.applications?.apps?.FilePicker
      ?? globalThis.FilePicker;
    if (!FPClass) return;
    new FPClass({
      type: "imagevideo",
      callback: (path) => {
        const input = rootEl.querySelector("input.fe-ih-specific-art");
        if (input) input.value = path;
      },
    }).render();
  });
}

// v14: TokenApplication  |  v13: TokenConfig (FormApplication → AppV2 이름이 다를 수 있음)
Hooks.on("renderTokenApplication", _ihInjectTokenConfigFields);
Hooks.on("renderTokenConfig",      _ihInjectTokenConfigFields);

// Clear art when dragging tokens or when a token update animation starts.
Hooks.on("preUpdateToken", _ihClearArt);
Hooks.on("deleteToken",    _ihClearArt);

// Clear art when various application windows close (avoids stale HUD state).
// closeApplication fires for all AppV2 instances (v14+); the V1 variants cover v13.
Hooks.on("closeActorSheet",    _ihClearArt);
Hooks.on("closeSettingsConfig", _ihClearArt);
Hooks.on("closeApplication",   _ihClearArt);

/** Discard dimension cache on scene change — prevents unbounded memory growth. */
Hooks.on("canvasReady", () => { _ihCache = {}; });

/** Reset toggle state when window loses focus — prevents stuck "always show" state. */
window.addEventListener("blur", () => {
  if (_ihKeyToggled) {
    _ihKeyToggled = false;
    if (!_ihShowAll) canvas.hud?.imageHover?.close();
  }
  _ihHideDomArt();
});

// Track which DOM portrait (status UI card / sheet) the cursor is over so the
// X keybind can show it even when no canvas token is hovered.
document.addEventListener("pointerover", (ev) => {
  const url = _ihResolveHoverArt(ev.target);
  if (url) _ihHoverArtUrl = url;
}, { passive: true });

document.addEventListener("pointerout", (ev) => {
  const url = _ihResolveHoverArt(ev.target);
  if (!url) return;
  // Moving within the same portrait (e.g. card → child) — keep it.
  if (ev.relatedTarget && _ihResolveHoverArt(ev.relatedTarget) === url) return;
  if (_ihHoverArtUrl === url) _ihHoverArtUrl = null;
  _ihHideDomArt();
}, { passive: true });

Hooks.on("init", () => {
  _ihRegisterSettings();
  _ihLoadSettings();

  // Socket: GM emits a tokenID; all other clients call showToAll locally.
  // Uses a type discriminator so other female_edition socket consumers are unaffected.
  game.socket.on("module.female_edition", (data) => {
    if (data?.type !== _IH_SOCKET_TYPE) return;
    const token = canvas.tokens?.get(data.tokenID);
    if (token) canvas.hud.imageHover?.showToAll(token);
  });
});

// Reload runtime settings cache after the user closes the settings dialog.
Hooks.on("closeSettingsConfig", _ihLoadSettings);
