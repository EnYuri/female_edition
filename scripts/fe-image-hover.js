/**
 * fe-image-hover.js — Token image hover overlay
 * Ported from image-hover v3.1 (MIT) into female_edition namespace.
 * Compatible with Foundry VTT v13 and v14 (ApplicationV2 + HandlebarsApplicationMixin).
 */

const _IH_MODULE = "female_edition";
const _IH_SOCKET_TYPE = "fe-image-hover";
const _IH_DEFAULT_TOKEN = "icons/svg/mystery-man.svg";

const _IH_VIDEO_EXTS = new Set(["mp4", "ogg", "webm", "m4v"]);

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
  });

  game.settings.register(_IH_MODULE, "ihEnabled", {
    name: "Image Hover: 활성화/비활성화",
    hint: "비활성화 시 이 클라이언트에서 Image Hover를 끕니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => canvas.hud.imageHover?.close(),
  });

  game.keybindings.register(_IH_MODULE, "ihKeybind", {
    name: "Image Hover: 아트 표시 토글 키",
    hint: "토큰 호버 중 이 키를 누르면 마우스가 토큰을 벗어날 때까지 아트가 표시됩니다. 다시 누르면 취소. 기본값: X",
    editable: [{ key: "KeyX" }],
    onDown: () => {
      const token = canvas.tokens?.hover;
      if (!token) return;
      if (_ihKeyToggled) {
        // 이미 표시 중 → 취소
        _ihKeyToggled = false;
        if (!_ihShowAll) canvas.hud.imageHover?.close();
      } else {
        _ihKeyToggled = true;
        canvas.hud.imageHover?.showArtworkRequirements(token, true, _ihDelay);
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
  });

  game.settings.register(_IH_MODULE, "ihSize", {
    name: "Image Hover: 이미지 크기 (화면 너비의 1/N)",
    hint: "값이 작을수록 이미지가 커집니다 (개인 설정).",
    scope: "client",
    config: true,
    range: { min: 3, max: 20, step: 0.5 },
    default: 7,
    type: Number,
  });

  game.settings.register(_IH_MODULE, "ihDelay", {
    name: "Image Hover: 표시 지연 시간 (ms)",
    hint: "아트 표시 키를 누른 후 이미지가 나타나기까지 대기 시간(밀리초) — 개인 설정.",
    scope: "client",
    config: true,
    range: { min: 0, max: 5000, step: 100 },
    default: 0,
    type: Number,
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
 * Convert scene-space image dimensions to CSS position/size values.
 * The HeadsUpDisplayContainer uses the scene coordinate space, so returned
 * values are applied directly as CSS px to position elements within it.
 *
 * @param {number} imageWidth  Original image/video width in pixels
 * @param {number} imageHeight Original image/video height in pixels
 * @returns {[number, number, number]} [left, top, width] in scene-space px
 */
function _ihComputePosition(imageWidth, imageHeight) {
  const view = canvas.scene._viewPosition;
  const scale = view.scale;

  let w = window.innerWidth / (_ihSize * scale);
  let h = w * (imageHeight / imageWidth);
  const winW = window.innerWidth / scale;
  const winH = window.innerHeight / scale;

  // Clamp height to viewport
  if (h > winH) {
    w = (winH / h) * w;
    h = winH;
  }

  let y = _ihPosition.includes("Bottom")
    ? view.y + winH / 2 - h
    : view.y - winH / 2;

  const sidebar = document.getElementById("sidebar");
  const collapsed = sidebar?.classList.contains("collapsed") ?? true;

  if (_ihPosition === "Centre") {
    const offset = collapsed ? 0 : (sidebar?.offsetWidth ?? 0) / scale / 3;
    return [view.x - w / 2 - offset, view.y - h / 2, w];
  }

  let x;
  if (_ihPosition.includes("right")) {
    if (_ihPosition.includes("Bottom") && collapsed) {
      x = view.x + winW / 2 - w;
    } else {
      const marginRight =
        parseFloat(sidebar ? window.getComputedStyle(sidebar).marginRight : "0") || 0;
      const sidebarW = ((sidebar?.offsetWidth ?? 0) + marginRight) / scale;
      x = view.x + winW / 2 - w - sidebarW;
    }
  } else {
    x = view.x - winW / 2;
  }

  return [x, y, w];
}

function _ihClearArt() {
  _ihKeyToggled = false;
  if (!_ihShowAll) canvas.hud.imageHover?.close();
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

    if (hovered && canvas.activeLayer instanceof foundry.canvas.layers.TokenLayer) {
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

  _ihCacheToken(_IH_DEFAULT_TOKEN, false);
  for (const token of canvas.tokens.placeables) {
    if (!token?.actor) continue;
    const img = token.actor.img;
    if (img === _IH_DEFAULT_TOKEN) {
      _ihCacheToken(token.document.texture.src, false);
    } else if (!(img in _ihCache)) {
      _ihCacheToken(img, false);
    }
  }
});

/** Cache art for newly placed tokens. */
Hooks.on("createToken", (tokenDoc) => {
  const actor = game.actors.get(tokenDoc.actorId);
  if (!actor) return;
  const img = actor.img === _IH_DEFAULT_TOKEN ? tokenDoc.texture.src : actor.img;
  if (img && !(img in _ihCache)) _ihCacheToken(img, false);
});

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
    new foundry.applications.apps.FilePicker.implementation({
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

/** Reposition art on camera pan or zoom. */
Hooks.on("canvasPan", () => {
  if (!canvas.hud.imageHover?.object) return;
  canvas.hud.imageHover._updatePosition();
});

/** Discard dimension cache on scene change — prevents unbounded memory growth. */
Hooks.on("canvasReady", () => { _ihCache = {}; });

/** Reset toggle state when window loses focus — prevents stuck "always show" state. */
window.addEventListener("blur", () => {
  if (_ihKeyToggled) {
    _ihKeyToggled = false;
    if (!_ihShowAll) canvas.hud?.imageHover?.close();
  }
});

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
