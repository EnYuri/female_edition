/**
 * fe-image-hover.js — Token image hover overlay
 * Ported from image-hover v3.1 (MIT) into female_edition namespace.
 * Compatible with Foundry VTT v13 and v14 (ApplicationV2 + HandlebarsApplicationMixin).
 */

import { feApplyHQPortrait } from "./fe-portrait-hq.js";
import { FE_CONFLICT_FEATURE, feIsConflictFeatureSuppressed } from "./fe-conflict-state.js";

const _IH_MODULE = "female_edition";
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
/** setTimeout handle for hover-delay — cleared before re-creating to prevent pile-up */
let _ihDelayTimer;

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
let _ihEnabled = true; // per-client toggle
let _ihPosition = "Bottom left";
let _ihSize = 3;
let _ihSizeWide = 1.225; // size divisor for wide (landscape) images — applied to screen HEIGHT
let _ihArtType = "character";
let _ihDelay = 0;
let _ihMaxUpscale = _IH_MAX_UPSCALE; // resolution-based upscale cap factor; 0 = no cap (unlimited)

/** Effective enabled state for this client. */
function _ihActive() {
  return _ihEnabled && !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.IMAGE_HOVER);
}

function _ihStandaloneActive() {
  try { return !!game.modules?.get?.("image-hover")?.active; }
  catch { return false; }
}

// The standalone module owns canvas.hud.imageHover whenever it is loaded—even
// while its userEnableModule setting is false. Keep our HUD in a private slot in
// that case so its still-registered hooks cannot call into our implementation.
function _ihHud() {
  return canvas?.hud?.feImageHover
    ?? (_ihStandaloneActive() ? null : canvas?.hud?.imageHover)
    ?? null;
}

// ── Settings ───────────────────────────────────────────────────────────────

function _ihRegisterSettings() {
  game.settings.register(_IH_MODULE, "ihPermission", {
    name: "Image Hover: 아트 표시 최소 권한",
    hint: "캐릭터 아트를 보기 위해 필요한 최소 Actor 권한.",
    scope: "world",
    config: false,
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
    config: false,
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

  game.settings.register(_IH_MODULE, "ihEnabled", {
    name: "Image Hover: 활성화/비활성화",
    hint: "비활성화 시 이 클라이언트에서 Image Hover를 끕니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => { _ihLoadSettings(); _ihHud()?.close(); },
  });

  game.keybindings.register(_IH_MODULE, "ihKeybind", {
    name: "Image Hover: 아트 표시 토글 키",
    hint: "토큰 호버 중 이 키를 누르면 마우스가 토큰을 벗어날 때까지 아트가 표시됩니다. 다시 누르면 취소. 기본값: X",
    editable: [{ key: "KeyX" }],
    onDown: () => {
      if (!_ihActive()) return false;
      const token = canvas.tokens?.hover;
      if (token) {
        if (_ihKeyToggled) {
          // already shown → cancel
          _ihKeyToggled = false;
          _ihHud()?.close();
        } else {
          _ihKeyToggled = true;
          _ihHud()?.showArtworkRequirements(token, true, _ihDelay);
        }
        return;
      }

      // Over a DOM portrait (status UI / character sheet) rather than a canvas token
      if (_ihHoverArtUrl) {
        if (_ihDomToggled) {
          _ihHideDomArt();
        } else {
          _ihDomToggled = true;
          const url = _ihHoverArtUrl;
          clearTimeout(_ihDomDelayTimer);
          _ihDomDelayTimer = setTimeout(() => {
            // Re-check after the delay: only show if still hovering the same portrait
            if (_ihDomToggled && _ihHoverArtUrl === url) _ihShowDomArt(url);
          }, _ihDelay);
        }
      }
    },
    onUp: () => {
      if (!_ihActive()) return false;
      // The image survives key-up; the hoverToken hook clears it when the token is left
    },
  });

  game.settings.register(_IH_MODULE, "ihPosition", {
    name: "Image Hover: 이미지 위치",
    hint: "화면 내 이미지 표시 위치입니다. GM 설정 강제가 켜져 있으면 GM 값으로 통일됩니다.",
    scope: "client",
    config: false,
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
    hint: "값이 작을수록 이미지가 커집니다. GM 설정 강제가 켜져 있으면 GM 값으로 통일됩니다.",
    scope: "client",
    config: false,
    range: { min: 3, max: 20, step: 0.5 },
    default: 3,
    type: Number,
    // Refresh runtime cache immediately. Without this, _ihSize only reloaded on
    // closeSettingsConfig, so a programmatic/per-world-hydrated change (which
    // fires onChange, not the dialog-close hook) left the cache stale until the
    // settings dialog was next closed → first hover used the old size.
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihSizeWide", {
    name: "Image Hover: 가로 이미지 크기 (화면 높이의 1/N)",
    hint: "가로로 긴 이미지(가로:세로 ≥ 1.2)는 세로축 기준으로 크기를 잡습니다. 값이 작을수록 커집니다. 1.0이면 화면 높이를 꽉 채웁니다. GM 설정 강제가 켜져 있으면 GM 값으로 통일됩니다.",
    scope: "client",
    config: false,
    range: { min: 1, max: 20, step: 0.025 },
    default: 1.225,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihMaxUpscale", {
    name: "Image Hover: 최대 업스케일 배율",
    hint: "원본 해상도 대비 최대 확대 한도입니다. 작은 원본을 이 배율 이상으로 키우지 않아 흐려짐을 막습니다. 0이면 제한 없음(항상 설정 크기로 표시). GM 설정 강제가 켜져 있으면 GM 값으로 통일됩니다.",
    scope: "client",
    config: false,
    range: { min: 0, max: 5, step: 0.05 },
    default: 0,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });

  game.settings.register(_IH_MODULE, "ihDelay", {
    name: "Image Hover: 표시 지연 시간 (ms)",
    hint: "아트 표시 키를 누른 후 이미지가 나타나기까지 대기 시간(밀리초)입니다. GM 설정 강제가 켜져 있으면 GM 값으로 통일됩니다.",
    scope: "client",
    config: false,
    range: { min: 0, max: 5000, step: 100 },
    default: 0,
    type: Number,
    onChange: () => _ihLoadSettings(),
  });
}

function _ihLoadSettings() {
  _ihPermission     = game.settings.get(_IH_MODULE, "ihPermission");
  _ihEnabled        = game.settings.get(_IH_MODULE, "ihEnabled")
    && !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.IMAGE_HOVER);
  _ihPosition       = game.settings.get(_IH_MODULE, "ihPosition");
  _ihSize           = game.settings.get(_IH_MODULE, "ihSize");
  _ihSizeWide       = game.settings.get(_IH_MODULE, "ihSizeWide");
  _ihArtType        = game.settings.get(_IH_MODULE, "ihArtType");
  _ihDelay          = game.settings.get(_IH_MODULE, "ihDelay");
  _ihMaxUpscale     = game.settings.get(_IH_MODULE, "ihMaxUpscale");
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
    if (applyToScreen) _ihHud()?._applyToCanvas(url);
  }).catch(() => {});
}

function _ihFlagValues(value) {
  return Array.isArray(value) ? value : [value];
}

function _ihFlagBool(value) {
  return _ihFlagValues(value).some((v) => v === true || v === "true" || v === 1 || v === "1" || v === "on");
}

function _ihSpecificArtFlag(value) {
  const values = _ihFlagValues(value);
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const v = values[i];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (s && s !== "path/image.png") return s;
  }
  return "path/image.png";
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
  const dpr = Math.min(3, window.devicePixelRatio || 1);

  // Wide (landscape) images are sized by the VERTICAL axis instead of width.
  // The size setting (W/size) was previously applied to width regardless of shape,
  // so a horizontally-long image ended up short and cramped. When the image is
  // clearly landscape (width/height ≥ 1.2), the size setting is applied to height
  // (H/size) and width is derived from it. Wide images use their OWN size divisor
  // (ihSizeWide, applied to height) so they can be scaled up independently of the
  // portrait width divisor (ihSize). The 1.2 threshold (rather than a strict 3:2)
  // keeps near-square art as portrait while catching common landscape ratios like
  // 4:3 (1.33) and 3:2 (1.50) that real art frequently sits at.
  const aspect = imageWidth / imageHeight;
  const isWide = aspect >= 1.2;

  let w, h;
  if (isWide) {
    // Size by height. Large art beyond this is HQ-downscaled by feApplyHQPortrait;
    // small art is upscale-capped against native HEIGHT (see below).
    h = H / _ihSizeWide;
    if (_ihMaxUpscale > 0) {
      const maxUpscaledH = (imageHeight * _ihMaxUpscale) / dpr; // CSS px cap from native
      if (h > maxUpscaledH) h = maxUpscaledH;
    }
    w = h * aspect;
    // Clamp width to viewport (downscale only — keeps aspect ratio)
    if (w > W) {
      h = (W / w) * h;
      w = W;
    }
  } else {
    // Target width from the size setting (W / size). Large art beyond this is
    // HQ-downscaled by feApplyHQPortrait (sparkle/aliasing fix). Small art below it
    // would be upscaled — capped so the upscale never exceeds the user-set ihMaxUpscale
    // factor of the native resolution (in DEVICE px, so HiDPI is accounted for). e.g. at
    // 1.25× a 300px source shows at most ~300-450px instead of a blurry 640px.
    // ihMaxUpscale = 0 disables the cap entirely (always shown at the W/size setting).
    w = W / _ihSize;
    // Upscale cap (user-adjustable via ihMaxUpscale; 0 = no cap → always show at the size setting).
    if (_ihMaxUpscale > 0) {
      const maxUpscaledW = (imageWidth * _ihMaxUpscale) / dpr; // CSS px cap from native
      if (w > maxUpscaledW) w = maxUpscaledW;
    }
    h = w * (imageHeight / imageWidth);

    // Clamp height to viewport (downscale only — keeps aspect ratio)
    if (h > H) {
      w = (H / h) * w;
      h = H;
    }
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
  _ihHud()?.close();
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
    const actorUuid = card?.dataset.actorUuid;
    const actor = (actorUuid
      ? Array.from(canvas?.scene?.tokens ?? [], token => token?.actor)
          .find(candidate => candidate?.uuid === actorUuid)
      : null) ?? (card?.dataset.actorId ? game.actors?.get(card.dataset.actorId) : null);
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

  // Chat portraits live in .message-header, which the .message-content branch below does
  // not reach. Their src may hold an HQ-resampled ~64px data: URL, so prefer the original
  // path cpUpsertPortrait stashed in fePortraitOrigSrc. Without a known original, showing
  // the data: URL would just magnify a 64px bitmap — so show nothing instead.
  const portrait = target.closest("img.fe-chat-portrait");
  if (portrait) {
    const orig = portrait.dataset?.fePortraitOrigSrc || portrait.dataset?.feHqSrc;
    if (orig) return orig;
    const src = portrait.getAttribute("src");
    if (src && !src.startsWith("data:")) return src;
    return null;
  }

  // Chat message body images (uploads, embeds, markdown, card art) — hover + X to show.
  // Embedded base64 (data:) is a genuine image source here, so it is allowed.
  const chatImg = target.closest("img");
  if (chatImg && chatImg.closest(".message-content")) {
    const orig = chatImg.dataset?.feHqSrc;
    if (orig) return orig;
    const src = chatImg.getAttribute("src") || chatImg.currentSrc || "";
    if (src) return src;
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
  if (!url || !_ihActive()) return;
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

    const specific = _ihSpecificArtFlag(token.document.getFlag(_IH_MODULE, "ihSpecificArt"));
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
    const specific = _ihSpecificArtFlag(this.object.document.getFlag(_IH_MODULE, "ihSpecificArt"));

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
  showArtworkRequirements(token, hovered, delay, pointerEvent = null) {
    if (!token?.actor || !_ihActive()) return;

    // Permission check — ownership["default"] === -1 means "None (INHERIT)" which
    // should not block display based on the individual actor permission.
    if (
      token.actor.permission < _ihPermission &&
      token.actor.ownership.default !== -1
    ) return;

    if (_ihFlagBool(token.document.getFlag(_IH_MODULE, "ihHideArt"))) return;

    // Imprecise-vision tokens (e.g. PF2e detection filter) — non-GM should not see art.
    if (token.detectionFilter && !game.user.isGM) return;

    // Mouse button held — user is dragging.
    if (pointerEvent?.buttons > 0) return;

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
          _ihHud()?.bind(token);
        } else {
          _ihHud()?.close();
        }
      }, delay);
    } else {
      this.close();
    }
  }

}

// ── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Create the HUD instance and pre-cache all token images on the current scene.
 * The html argument is a raw HTMLElement (HeadsUpDisplayContainer is already AppV2).
 */
Hooks.on("renderHeadsUpDisplayContainer", (_app, html) => {
  if (!_ihActive()) return;
  // The standalone Image Hover constructs canvas.hud.imageHover even when its
  // own userEnableModule toggle is false. Install after the complete hook pass so
  // that inert instance cannot overwrite ours. When the original feature is on,
  // conflict policy makes _ihActive() false and this callback never reaches here.
  queueMicrotask(() => {
    if (!_ihActive()) return;
    html.style.zIndex = 70;
    let anchor = html.querySelector?.("#fe-image-hover-hud");
    if (!anchor) {
      anchor = document.createElement("template");
      anchor.id = "fe-image-hover-hud";
      html.appendChild(anchor);
    }
    const hud = new FeImageHoverHUD();
    canvas.hud.feImageHover = hud;
    if (!_ihStandaloneActive()) canvas.hud.imageHover = hud;

    // Cache only the tiny default-token SVG dimensions up front (it's the fallback).
    // Per-token portrait dimensions are cached lazily on first hover.
    _ihCacheToken(_IH_DEFAULT_TOKEN, false);
  });
});

/** (Token portrait dimensions are cached lazily on first hover — see above.) */

/** Main hover entry point. */
Hooks.on("hoverToken", (token, hovered) => {
  const hud = _ihHud();
  if (!hud) return;
  if (!hovered) {
    // Mouse left the token → release the latch and close the image
    _ihKeyToggled = false;
    hud.close();
    return;
  }
  // On hover enter: nothing is shown until X is pressed
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

  const hideArt = _ihFlagBool(await token.getFlag(_IH_MODULE, "ihHideArt"));
  const specificArt = _ihSpecificArtFlag(await token.getFlag(_IH_MODULE, "ihSpecificArt"));

  const _renderTpl = foundry.applications?.handlebars?.renderTemplate ?? globalThis.renderTemplate;
  const contents = await _renderTpl(
    "modules/female_edition/templates/fe-image-hover-token-config.html",
    { hideHoverStatus: hideArt ? "checked" : "", specificArtStatus: specificArt }
  );

  const wrapper = document.createElement("div");
  wrapper.innerHTML = contents;
  const insertionTarget = tab.querySelector(".fe-tp-controls") ?? tab;
  while (wrapper.firstChild) insertionTarget.appendChild(wrapper.firstChild);

  const lockedHeight = app.options?.position?.height;
  const lockedWidth = app.options?.position?.width;
  if (Number.isFinite(lockedHeight)) app.setPosition?.({ width: lockedWidth, height: lockedHeight });
  else app.setPosition?.({ height: "auto" });

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

// v14: TokenApplication | v13: TokenConfig — the class name differs between versions
Hooks.on("renderTokenApplication", _ihInjectTokenConfigFields);
Hooks.on("renderTokenConfig",      _ihInjectTokenConfigFields);

// Clear art when dragging tokens or when a token update animation starts.
Hooks.on("preUpdateToken", _ihClearArt);
Hooks.on("deleteToken",    _ihClearArt);

// Clear art when various application windows close (avoids stale HUD state).
//
// The close hook name is built from the CLASS NAME of every entry in the app's
// inheritance chain, and the two frameworks have different base classes:
//   · AppV2 — `ApplicationV2#_doEvent` → `#callHooks` (applications/api/application.mjs)
//     bottoms out at `ApplicationV2` / `ActorSheetV2` → closeApplicationV2, closeActorSheetV2
//   · AppV1 — `Application#_callHooks` (appv1/api/application-v1.mjs:53, class name is a
//     bare `Application`) → closeApplication, closeActorSheet
// So the V1 names alone MISS every AppV2 sheet (dnd5e v4+ and core's own). Both sets
// are needed; `closeSettingsConfig` is spelled the same in either framework.
Hooks.on("closeActorSheet",     _ihClearArt);
Hooks.on("closeActorSheetV2",   _ihClearArt);
Hooks.on("closeSettingsConfig", _ihClearArt);
Hooks.on("closeApplication",    _ihClearArt);
Hooks.on("closeApplicationV2",  _ihClearArt);

/** Discard dimension cache on scene change — prevents unbounded memory growth. */
Hooks.on("canvasReady", () => { _ihCache = {}; });

/** Reset toggle state when window loses focus — prevents stuck "always show" state. */
window.addEventListener("blur", () => {
  if (_ihKeyToggled) {
    _ihKeyToggled = false;
    _ihHud()?.close();
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
});

// Reload runtime settings cache after the user closes the settings dialog.
Hooks.on("closeSettingsConfig", _ihLoadSettings);
