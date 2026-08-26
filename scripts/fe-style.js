import { MODULE_ID, S, feIsDx3rdSystemId } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";

// accent hex -> { h: 0-360, s: 0-1 }. Achromatic input (s~0) pins h to 0.
function feAccentToHs(hex) {
  hex = String(hex).replace(/^#/, "");
  if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { h: 0, s: 0 };
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
    case g: h = ((b - r) / d + 2) / 6; break;
    case b: h = ((r - g) / d + 4) / 6; break;
  }
  return { h: h * 360, s };
}

function feContrastText(hex) {
  let h = String(hex).replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "#f0f0f0";
  const channel = (index) => {
    const value = parseInt(h.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.45 ? "#141414" : "#f0f0f0";
}

// A stored choice value that is neither of the known options must still land on
// ONE of them. Without this, every mode class is left off and the whole standard
// merge block in fe-chat-enhance.css (~216-251: border fusion, radius collapse,
// negative margins) silently stops applying — while the follow-header rules,
// which key off `fe-chat-merge` + the style class only, keep working. The result
// looks exactly like "merged, header hidden, but each message still a closed
// box": merge is clearly ON, only the fusion is gone.
//
// `?? "standard"` does NOT cover this: it fires on null/undefined, not on ""
// or on any leftover value from an older build. The repair pass that WOULD fix
// the stored value (feNormalizeChoiceSetting, via feMigrateLegacySettings) runs
// at `ready` — but these classes are applied from `setup`, and per CLAUDE.md
// `ready` can legitimately never fire (a .webm tile hangs canvas init forever).
// So the fallback has to live here, not only in the stored value.
function feNormalizeChoice(value, allowed, fallback) {
  const v = String(value ?? "").trim();
  return allowed.includes(v) ? v : fallback;
}

function feSetBodyMergeClasses() {
  const enabled = !!feSetting(S.MERGE_ENABLED);
  document.body.classList.toggle("fe-chat-merge", enabled);

  const mode = feNormalizeChoice(feSetting(S.MERGE_MODE), ["standard", "simple"], "standard");
  document.body.classList.toggle("fe-merge-mode-standard", enabled && mode === "standard");
  document.body.classList.toggle("fe-merge-mode-simple", enabled && mode === "simple");

  const style = feNormalizeChoice(feSetting(S.MERGE_FOLLOW_HEADER_STYLE), ["hide", "name", "portrait"], "hide");
  document.body.classList.toggle("fe-merge-follow-hide", enabled && style === "hide");
  document.body.classList.toggle("fe-merge-follow-name", enabled && style === "name");
  document.body.classList.toggle("fe-merge-follow-portrait", enabled && style === "portrait");
}

function feSetChatCardFontClass(doc = document) {
  try {
    // Chat-card descriptions use the secondary (Geurimilgi) face only for the
    // mixed CookieRun + Geurimilgi preset. This used to have a separate toggle;
    // keep the preset self-contained instead.
    const enabled = !!feSetting(S.UI_ENABLE_FONTS)
      && !feUserFontActive()
      && String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie") === "cookie";
    doc?.body?.classList?.toggle("fe-chatcard-custom-font", enabled);
  } catch {}
}

// True when the user-font override is active — the module's chat-font-choice
// classes (cookie/neodgm/…) are then suppressed so the user font fully replaces
// the module font dropdown (and the NeoDGM `*` smoothing rule can't bleed onto a
// non-pixel user font).
function feUserFontActive() {
  try {
    return !!feSetting(S.UI_USE_USER_FONT) && String(feSetting(S.USER_FONT_FAMILY) ?? "").trim().length > 0;
  } catch { return false; }
}

function feSetChatFontChoiceClass(doc = document) {
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    const body = doc?.body;
    if (!body) return;
    const userFont = feUserFontActive();
    body.classList.toggle("fe-chat-font-cookie", !userFont && choice === "cookie");
    body.classList.toggle("fe-chat-font-cookie-all", !userFont && choice === "cookieAll");
    body.classList.toggle("fe-chat-font-geurimilgi", !userFont && choice === "geurimilgi");
  } catch {}
}

function feSetUiFontClass(doc = document) {
  try {
    // "UI/sheet Geurimilgi" is not an independent font mode. It only has a
    // distinct meaning in the mixed CookieRun + Geurimilgi preset; every other
    // preset remaps the UI font variables to its own single font already.
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    const enabled = !feUserFontActive() && choice === "cookie";
    doc?.body?.classList?.toggle("fe-ui-font-geurimilgi", enabled);
  } catch (_e) {
    /* noop */
  }
}

function feSetNeodgmModeClass(doc = document) {
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    const body = doc?.body;
    if (!body) return;
    const userFont = feUserFontActive();
    body.classList.toggle("fe-neodgm-mode", !userFont && choice === "neodgm");
    body.classList.toggle("fe-mona-mode", !userFont && choice === "mona");
    body.classList.toggle("fe-galmuri-mode", !userFont && choice === "galmuri");
  } catch {}
}

// User (local / font-folder) font override. When enabled with a non-empty family,
// feeds the family into --fe-user-font-family and flips fe-user-font-mode, which
// remaps every font variable to it (see ui-font.css). Mirrors NeoDGM mode.
function feSetUserFontMode(doc = document) {
  try {
    const root = doc?.documentElement;
    const body = doc?.body;
    if (!root || !body) return;
    const enabled = !!feSetting(S.UI_USE_USER_FONT);
    const fam = String(feSetting(S.USER_FONT_FAMILY) ?? "").trim();
    const active = enabled && fam.length > 0;
    if (active) {
      // Quote a bare family name (handles spaces/Hangul); leave an already-quoted
      // or comma-listed value untouched so power users can supply their own stack.
      const value = /["',]/.test(fam) ? fam : `"${fam}"`;
      root.style.setProperty(
        "--fe-user-font-family",
        `${value}, "FE CookieRun", "Signika", system-ui, "Noto Sans KR", sans-serif, var(--fe-symbol-fallback)`,
      );
    } else {
      root.style.removeProperty("--fe-user-font-family");
    }
    body.classList.toggle("fe-user-font-mode", active);
  } catch {}
}

function feSetRetroThemeClass(doc = document) {
  try {
    const enabled = !!feSetting(S.UI_RETRO_THEME);
    const body = doc?.body;
    if (!body?.classList) return;

    body.classList.toggle("fe-retro-theme", enabled);

    // The master switch remains deliberately singular. These are implementation
    // scope markers, not user-facing settings: system CSS can opt in only where
    // its markup actually exists instead of treating every retro world as DX3rd.
    // Scope DX3rd-native styling to every supported package in the system family.
    const systemId = String(globalThis.game?.system?.id ?? "");
    body.classList.toggle("fe-retro-system-dnd5e", enabled && systemId === "dnd5e");
    body.classList.toggle(
      "fe-retro-system-dx3rd",
      enabled && feIsDx3rdSystemId(systemId),
    );

    // double-cross-3rd's legacy token-adjacent combat buttons are PIXI.Graphics,
    // not DOM nodes, so the CSS theme cannot reach them. Repaint any live button
    // container when the toggle changes; the installer below handles containers
    // created later by middle-click / combat process changes.
    feApplyDoubleCrossLegacyPixiTheme(doc);
  } catch {}
}

// ---------------------------------------------------------------------------
// double-cross-3rd legacy combat buttons (PIXI)
// ---------------------------------------------------------------------------
// The upstream system draws these directly into canvas.interface with hard-coded
// navy/red/yellow colors. Its implementation is closure-private, so we preserve
// every system listener and add a non-interactive child Graphics behind the text.
// That child covers only the original Graphics paint, leaving hit testing and all
// actions owned by the system. This adapter is intentionally package-specific:
// dx3rd-emanim replaced this UI, and original dx3rd never shipped it.
const FE_DOUBLE_CROSS_SYSTEM_ID = "double-cross-3rd";
const FE_DOUBLE_CROSS_COMBAT_CONTAINER = "dx3rd-combat-buttons";
const FE_DOUBLE_CROSS_RETRO_OVERLAY = "fe-double-cross-retro-overlay";
const _feDoubleCrossBoundStages = new WeakSet();
let _feDoubleCrossPixiThemeInstalled = false;
let _feDoubleCrossPixiThemeFrame = null;

function _feDoubleCrossAccentNumber() {
  // Match feApplyStyleVarsFromSettings: the saved swatch is dormant while the
  // accent override toggle is off, and every accent-driven surface is white.
  if (!feSetting(S.ACCENT_TEXT_OVERRIDE)) return 0xffffff;
  let hex = String(feSetting(S.DX3RD_PIXEL_ACCENT) ?? "#ffffff").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((c) => c + c).join("");
  return /^[0-9a-f]{6}$/i.test(hex) ? Number.parseInt(hex, 16) : 0xffffff;
}

function _feDoubleCrossRetroEnabled(doc = document) {
  const classes = doc?.body?.classList;
  return String(globalThis.game?.system?.id ?? "") === FE_DOUBLE_CROSS_SYSTEM_ID
    && classes?.contains?.("fe-retro-theme")
    && classes?.contains?.("fe-retro-system-dx3rd");
}

function _feDoubleCrossCombatContainer() {
  try {
    const group = globalThis.canvas?.interface;
    return group?.getChildByName?.(FE_DOUBLE_CROSS_COMBAT_CONTAINER)
      ?? group?.children?.find?.((child) => child?.name === FE_DOUBLE_CROSS_COMBAT_CONTAINER)
      ?? null;
  } catch {
    return null;
  }
}

function _feDoubleCrossButtonText(button) {
  return button?.children?.find?.((child) => (
    child?.name !== FE_DOUBLE_CROSS_RETRO_OVERLAY
    && child?.style
    && (typeof child.text === "string" || child.text != null)
  )) ?? null;
}

function _feDoubleCrossButtonRect(button) {
  const stored = button?.userData?.feDoubleCrossRetroRect;
  if (stored && [stored.x, stored.y, stored.width, stored.height].every(Number.isFinite)) return stored;
  try {
    const bounds = button?.getLocalBounds?.();
    if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return null;
    const rect = {
      x: Number(bounds.x) || 0,
      y: Number(bounds.y) || 0,
      width: Number(bounds.width),
      height: Number(bounds.height),
    };
    if (rect.width <= 0 || rect.height <= 0) return null;
    button.userData ??= {};
    button.userData.feDoubleCrossRetroRect = rect;
    return rect;
  } catch {
    return null;
  }
}

function _feStyleDoubleCrossPixiButton(button, doc = document) {
  if (!button) return;
  button.userData ??= {};
  const text = _feDoubleCrossButtonText(button);
  let overlay = button.getChildByName?.(FE_DOUBLE_CROSS_RETRO_OVERLAY)
    ?? button.children?.find?.((child) => child?.name === FE_DOUBLE_CROSS_RETRO_OVERLAY)
    ?? null;

  if (!_feDoubleCrossRetroEnabled(doc)) {
    if (overlay) {
      try { button.removeChild?.(overlay); } catch { /* no-op */ }
      try { overlay.destroy?.(); } catch { /* no-op */ }
    }
    if (text?.style) text.style.fill = button.userData.feDoubleCrossRetroHover ? 0xffbb00 : 0xffffff;
    return;
  }

  const rect = _feDoubleCrossButtonRect(button);
  const Graphics = globalThis.PIXI?.Graphics;
  if (!rect || typeof Graphics !== "function") return;
  if (!overlay) {
    overlay = new Graphics();
    overlay.name = FE_DOUBLE_CROSS_RETRO_OVERLAY;
    overlay.eventMode = "none";
    overlay.interactive = false;
    button.addChildAt?.(overlay, 0);
  } else if (button.getChildIndex?.(overlay) !== 0) {
    try { button.setChildIndex?.(overlay, 0); } catch { /* no-op */ }
  }

  const accent = _feDoubleCrossAccentNumber();
  const hovered = button.userData.feDoubleCrossRetroHover === true;
  overlay.clear?.();
  overlay.lineStyle?.(hovered ? 2 : 1, accent, 1);
  overlay.beginFill?.(hovered ? accent : 0x000000, 1);
  overlay.drawRect?.(rect.x, rect.y, rect.width, rect.height);
  overlay.endFill?.();
  if (text?.style) text.style.fill = hovered ? 0x000000 : accent;

  if (!button.userData.feDoubleCrossRetroListeners) {
    button.userData.feDoubleCrossRetroListeners = true;
    button.on?.("pointerover", () => {
      button.userData.feDoubleCrossRetroHover = true;
      _feStyleDoubleCrossPixiButton(button, doc);
    });
    button.on?.("pointerout", () => {
      button.userData.feDoubleCrossRetroHover = false;
      _feStyleDoubleCrossPixiButton(button, doc);
    });
  }
}

function feApplyDoubleCrossLegacyPixiTheme(doc = document) {
  if (String(globalThis.game?.system?.id ?? "") !== FE_DOUBLE_CROSS_SYSTEM_ID) return;
  const container = _feDoubleCrossCombatContainer();
  for (const button of container?.children ?? []) {
    try { _feStyleDoubleCrossPixiButton(button, doc); } catch { /* per-button, non-fatal */ }
  }
}

function _feScheduleDoubleCrossLegacyPixiTheme() {
  if (String(globalThis.game?.system?.id ?? "") !== FE_DOUBLE_CROSS_SYSTEM_ID) return;
  if (_feDoubleCrossPixiThemeFrame != null) return;
  const run = () => {
    _feDoubleCrossPixiThemeFrame = null;
    feApplyDoubleCrossLegacyPixiTheme(document);
  };
  const raf = globalThis.requestAnimationFrame;
  _feDoubleCrossPixiThemeFrame = typeof raf === "function" ? raf(run) : setTimeout(run, 0);
}

function _feBindDoubleCrossLegacyStage() {
  const stage = globalThis.canvas?.stage;
  if (!stage?.on || _feDoubleCrossBoundStages.has(stage)) return;
  _feDoubleCrossBoundStages.add(stage);
  // The system creates/toggles the container in its own earlier mousedown
  // listener. Defer one frame so its synchronous draw has completed.
  stage.on("mousedown", (event) => {
    if ((event?.data?.button ?? event?.button) === 1) _feScheduleDoubleCrossLegacyPixiTheme();
  });
}

function feInstallDoubleCrossLegacyPixiTheme() {
  if (String(globalThis.game?.system?.id ?? "") !== FE_DOUBLE_CROSS_SYSTEM_ID) return;
  _feBindDoubleCrossLegacyStage();
  feApplyDoubleCrossLegacyPixiTheme(document);
  if (_feDoubleCrossPixiThemeInstalled) return;
  _feDoubleCrossPixiThemeInstalled = true;
  Hooks.on("canvasReady", () => {
    _feBindDoubleCrossLegacyStage();
    _feScheduleDoubleCrossLegacyPixiTheme();
  });
  Hooks.on("refreshToken", () => _feScheduleDoubleCrossLegacyPixiTheme());
  Hooks.on("updateCombat", () => _feScheduleDoubleCrossLegacyPixiTheme());
}

function feSetUserColorBgClass(doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    doc?.body?.classList?.toggle("fe-msg-bg-usercolor", enabled);
  } catch {}
}

function feSetPaperOverlayClass(doc = document) {
  try {
    const enabled = !!feSetting(S.STYLE_PAPER_OVERLAY_ENABLED);
    doc?.body?.classList?.toggle("fe-paper-overlay", enabled);
  } catch {}
}

function feSetChatGroupOutlineClass(doc = document) {
  try {
    const enabled = !!feSetting(S.CHAT_GROUP_OUTLINE);
    doc?.body?.classList?.toggle("fe-chat-group-outline", enabled);
  } catch {}
}

function feSetAccentTextOverrideClass(doc = document) {
  try {
    const enabled = !!feSetting(S.ACCENT_TEXT_OVERRIDE);
    doc?.body?.classList?.toggle("fe-accent-text-override", enabled);
  } catch {}
}

function feSetSystemMsgColorClass(doc = document) {
  try {
    const body = doc?.body;
    body?.classList?.toggle("fe-system-msg-color", !!feSetting(S.SYSTEM_MSG_COLOR));
    body?.classList?.toggle("fe-system-msg-bg", !!feSetting(S.SYSTEM_MSG_BG_ENABLED));
  } catch {}
}

function feSetForceNormalMsgColorClass(doc = document) {
  try {
    const enabled = !!feSetting(S.FORCE_NORMAL_MSG_COLOR);
    doc?.body?.classList?.toggle("fe-force-normal-msg-color", enabled);
  } catch {}
}

function feSetUserColorBgBaseClass(doc = document) {
  try {
    const mode = String(feSetting(S.USER_COLOR_BG_BASE) ?? "white");
    const body = doc?.body;
    if (!body?.classList) return;
    body.classList.toggle("fe-userbg-base-white", mode === "white");
    body.classList.toggle("fe-userbg-base-black", mode === "black");
    body.classList.toggle("fe-userbg-base-custom", mode === "custom");
    if (mode === "custom") {
      // Feed the custom base color to CSS as "r g b" (inherited down to messages).
      const hex = String(feSetting(S.USER_COLOR_BG_CUSTOM) ?? "#1b1b1b").trim();
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      const rgb = m ? `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}` : "27 27 27";
      body.style.setProperty("--fe-user-bg-base-rgb", rgb);
    } else {
      body.style.removeProperty("--fe-user-bg-base-rgb");
    }
    if (mode === "none") {
      body.classList.remove("fe-userbg-base-white", "fe-userbg-base-black", "fe-userbg-base-custom");
    }
  } catch {}
}

function feApplyStyleVarsFromSettings(doc = document) {
  try {
    const root = doc?.documentElement;
    if (!root) return;

    const px = (n, fallback) => {
      const v = Number(n);
      return Number.isFinite(v) ? `${v}px` : `${fallback}px`;
    };
    const num = (n, fallback) => {
      const v = Number(n);
      return Number.isFinite(v) ? v : fallback;
    };

    // User-color tint strength (clamped to the registered range).
    const ucAlpha = num(feSetting(S.USER_COLOR_ALPHA), 0.22);
    root.style.setProperty("--fe-user-color-alpha", String(Math.min(0.6, Math.max(0.05, ucAlpha))));

    root.style.setProperty("--fe-chat-title-size", px(feSetting(S.STYLE_ACTOR_NAME_SIZE), 22));
    root.style.setProperty("--fe-chat-subtitle-size", px(feSetting(S.STYLE_PLAYER_NAME_SIZE), 14));
    root.style.setProperty("--fe-chat-message-font-size", px(feSetting(S.STYLE_MESSAGE_TEXT_SIZE), 14));
    root.style.setProperty("--fe-chat-card-font-size", px(feSetting(S.STYLE_CHATCARD_TEXT_SIZE), 12));

    const chatSpacing = px(feSetting(S.STYLE_CHAT_MESSAGE_SPACING), 2);
    root.style.setProperty("--fe-chat-message-spacing", chatSpacing);
    // Do NOT set --chat-message-spacing on :root — Foundry v14 uses this variable
    // for layout beyond just message gap (causes sidebar spacing side-effects).
    // chat-bg-stripper.css scopes it correctly inside chat-sidebar.

    root.style.setProperty("--fe-merge-group-spacing", px(feSetting(S.MERGE_GROUP_SPACING), 14));
    root.style.setProperty("--fe-header-content-gap", px(feSetting(S.STYLE_HEADER_CONTENT_GAP), 4));
    root.style.setProperty("--fe-merge-inner-gap", px(feSetting(S.MERGE_INNER_GAP), 8));

    root.style.setProperty("--fe-paper-alpha", String(num(feSetting(S.STYLE_BG_SATURATION), 0.42)));

    const systemBg = String(feSetting(S.SYSTEM_MSG_BG_COLOR) ?? "#ffffff").trim() || "#ffffff";
    root.style.setProperty("--fe-system-msg-bg", systemBg);
    root.style.setProperty("--fe-system-msg-text", feContrastText(systemBg));

    root.style.setProperty("--fe-dx3rd-card-border-alpha", String(num(feSetting(S.DX3RD_CARD_BORDER_ALPHA), 0.5)));

    // With the text-tint override off, every accent-driven surface (text, borders,
    // checkerboard pattern) returns to plain white (#ffffff, H=0 S=0%) so "off" is
    // genuinely off. fe-chat-controls-menu.css hides the accent swatch on the same test.
    const accentOverrideOn = !!feSetting(S.ACCENT_TEXT_OVERRIDE);
    const accent = accentOverrideOn
      ? (String(feSetting(S.DX3RD_PIXEL_ACCENT) ?? "#ffffff").trim() || "#ffffff")
      : "#ffffff";
    root.style.setProperty("--fe-dx3rd-accent", accent);

    // Decompose to H/S only - section 20 CSS pairs them with a fixed lightness.
    const { h, s } = feAccentToHs(accent);
    root.style.setProperty("--fe-dx3rd-accent-h", `${Math.round(h)}deg`);
    root.style.setProperty("--fe-dx3rd-accent-s", `${Math.round(s * 100)}%`);

  } catch (err) {
    console.warn("female_edition | failed to apply style vars", err);
  }
}

// ---------------------------------------------------------------------------
// Canvas (PIXI) text font — token nameplates and friends
// ---------------------------------------------------------------------------
// Token nameplates are PreciseText drawn into the WebGL canvas, so no CSS rule
// can ever reach them. The only lever is CONFIG.canvasTextStyle, which every
// canvas label clones (Token#_getTextStyle at client/canvas/placeables/token.mjs,
// plus cursors, templates, lights, sounds). Core's original family is captured
// once so turning the option off restores exactly what core shipped.
//
// Two things this must do beyond assigning the family:
//   1. Wait for the font to actually be in document.fonts. PIXI renders text
//      through canvas 2D, which silently falls back to the next family when the
//      face is not loaded yet — and never repaints when it finishes loading.
//   2. Re-assign the style on already-drawn placeables. CONFIG.canvasTextStyle is
//      *cloned* at draw time, so live nameplates keep their old family until they
//      are redrawn.
let _feCanvasFontOriginal = null;

// Families the font-loading API cannot (and need not) load by name.
const FE_CANVAS_GENERIC_FAMILIES = new Set([
  "serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui",
  "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "inherit", "initial",
]);

// Read the currently active font stack from the rendered CSS rather than
// re-deriving it from the settings: the body mode classes (neodgm/mona/galmuri/
// user-font/…) already resolve which stack wins, and getComputedStyle reports
// the substituted result. Returns a PIXI-friendly array of family names.
function feResolveCanvasFontFamilies(doc = document) {
  try {
    const body = doc?.body;
    if (!body) return [];
    const raw = String(getComputedStyle(body).getPropertyValue("--fe-font-primary") ?? "");
    return raw
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " ").replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

// PIXI caches a font's ascent/descent/fontSize under its FONT STRING — see
// TextMetrics.measureFont in pixi.js 7.4.3 (`if (_TextMetrics._fonts[font]) return …`,
// never invalidated). The font string is `style.toFontString()`, which does NOT change
// when the @font-face finally arrives, so text first measured while the face was still
// missing keeps the FALLBACK's vertical metrics for the rest of the session — and the
// texture built from them clips the real glyphs top and bottom. That is the "token
// nameplate is cut off right after a world load" symptom; re-picking a font only
// appeared to fix it because a different family is a different cache key.
//
// Drop the whole cache before re-styling anything. It is keyed per font string and
// each entry costs two canvas measureText calls to rebuild, so a full clear is cheap
// and avoids having to guess which strings (family × every size in use) went stale.
function feClearPixiFontMetricsCache() {
  try { globalThis.PIXI?.TextMetrics?.clearMetrics?.(); } catch { /* no-op */ }
}

// Nameplates/tooltips of already-drawn placeables hold a clone of the old style.
// Re-running _getTextStyle() picks up the new CONFIG value without a full redraw.
// Drawings and Notes are refreshed too: they read CONFIG.defaultFontFamily (not
// canvasTextStyle) whenever their own fontFamily is blank.
function feRefreshCanvasTextStyles() {
  try {
    const c = globalThis.canvas;
    if (!c?.ready) return;
    // MUST run before the re-styling below: assigning a style only marks the text
    // dirty, and a redraw that re-reads a poisoned metrics cache measures exactly the
    // same wrong ascent/descent again.
    feClearPixiFontMetricsCache();
    for (const token of c.tokens?.placeables ?? []) {
      try {
        const style = token?._getTextStyle?.();
        if (!style) continue;
        if (token.nameplate) token.nameplate.style = style;
        if (token.tooltip) token.tooltip.style = style.clone?.() ?? style;
      } catch { /* per-token, non-fatal */ }
    }
    for (const drawing of c.drawings?.placeables ?? []) {
      try {
        if (drawing?.text) drawing.text.style = drawing._getTextStyle();
      } catch { /* per-drawing, non-fatal */ }
    }
    for (const note of c.notes?.placeables ?? []) {
      try {
        if (note?.tooltip) note.tooltip.style = note._getTextStyle();
      } catch { /* per-note, non-fatal */ }
    }
    // This module draws canvas text of its own (screen panel overlay labels), which
    // clones CONFIG.canvasTextStyle at build time exactly like core's nameplates and
    // goes stale for exactly the same reasons. Announce the refresh instead of
    // importing the feature module: fe-style.js sits low in the chat-enhance
    // dependency order and must not reach up into an entry module.
    Hooks.callAll(`${MODULE_ID}.canvasTextStyleRefreshed`);
  } catch { /* no-op */ }
}

// Ask the browser to load the faces we are about to hand to PIXI, then refresh
// once they are ready. Fire-and-forget — a failed/absent face just falls through
// to the next family in the stack.
function feEnsureCanvasFontsLoaded(families) {
  try {
    if (typeof document?.fonts?.load !== "function") return;
    const size = Number(CONFIG?.canvasTextStyle?.fontSize) || 36;
    const jobs = families
      .filter((f) => !FE_CANVAS_GENERIC_FAMILIES.has(f.toLowerCase()))
      .map((f) => document.fonts.load(`${size}px "${f.replace(/"/g, '\\"')}"`).catch(() => null));
    if (!jobs.length) return;
    Promise.all(jobs).then(() => feRefreshCanvasTextStyles()).catch(() => {});
  } catch { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Drawn text — Drawing / map Note placeables and the rich-text editor
// ---------------------------------------------------------------------------
// This is a DIFFERENT path from CONFIG.canvasTextStyle above. Drawing#_getTextStyle
// (client/canvas/placeables/drawing.mjs) and Note#_getTextStyle read the document's
// own `fontFamily` and only fall back to CONFIG.defaultFontFamily when it is blank
// (the sheet's "기본값" blank option). The family dropdown itself comes from
// FontConfig.getAvailableFontChoices(), which lists exactly the families that were
// declared in CONFIG.fontDefinitions with `editor: true` AND then loaded through
// FontConfig.loadFont — nothing else can appear there.
//
// So offering the module fonts for drawn text takes two independent steps:
//   1. declare + load them, so every module font is selectable per drawing/note
//      (and in the journal editor's font menu, which uses the same list),
//   2. point CONFIG.defaultFontFamily at the active primary family, so a drawing
//      left on "기본값" uses the module font without the user picking anything.
//
// The definitions deliberately use an empty `fonts: []`: ui-font.css already owns
// every @font-face, so core only has to await document.fonts for that family
// instead of building a second, duplicate FontFace for the same file. A family
// that fails to load (CDN font while offline) is simply never added to the list.
const FE_EDITOR_FONT_FAMILIES = [
  "FE CookieRun",
  "FE Geurimilgi",
  "NeoDunggeunmo Pro",
  "Galmuri11",
  "Mona12",
  "Mona12 Text KR",
  "Mona10",
];

// font/-folder families discovered at runtime by fe-user-font.js.
const _feExtraEditorFamilies = new Set();
// Families already handed to FontConfig.loadFont — this applier re-runs on every
// font setting change and on canvasReady, and loading is a one-time job.
const _feEditorFontsLoaded = new Set();
let _feDefaultFontFamilyOriginal = null;

function feResolveFontConfig() {
  return (
    foundry?.applications?.settings?.menus?.FontConfig ||
    globalThis.FontConfig ||
    null
  );
}

// The module's own families plus whatever the user brought in (font/ folder,
// locally-installed pick).
function feCollectEditorFontFamilies() {
  const out = [...FE_EDITOR_FONT_FAMILIES, ..._feExtraEditorFamilies];
  try {
    const chosen = String(game.settings.get(MODULE_ID, S.USER_FONT_FAMILY) ?? "").trim();
    if (chosen) out.push(chosen);
  } catch { /* pre-init */ }
  return out;
}

function feRegisterEditorFonts(active) {
  try {
    if (!active) return;
    const FontConfig = feResolveFontConfig();
    const definitions = globalThis.CONFIG?.fontDefinitions;
    if (!FontConfig?.loadFont || !definitions) return;
    for (const family of feCollectEditorFontFamilies()) {
      if (!family || _feEditorFontsLoaded.has(family)) continue;
      _feEditorFontsLoaded.add(family);
      // Never clobber an existing definition — core ships some, and the world's
      // own Font settings may define others under the same name.
      definitions[family] ??= { editor: true, fonts: [] };
      // loadFont resolves false (rather than throwing) when the face never
      // arrives — e.g. a CDN pixel font while offline. Forget it either way so a
      // later re-apply gets another chance.
      Promise.resolve(FontConfig.loadFont(family, definitions[family]))
        .then((ok) => { if (!ok) _feEditorFontsLoaded.delete(family); })
        .catch(() => { _feEditorFontsLoaded.delete(family); });
    }
  } catch (err) {
    console.warn("female_edition | failed to register editor fonts", err);
  }
}

function feApplyDefaultFontFamily(doc, fontsOn) {
  try {
    const cfg = globalThis.CONFIG;
    if (!cfg) return;
    if (_feDefaultFontFamilyOriginal === null) _feDefaultFontFamilyOriginal = cfg.defaultFontFamily;

    const active = fontsOn && !!feSetting(S.CANVAS_DRAWING_FONT);
    // Only the FIRST family of the stack: CONFIG.defaultFontFamily is handed to
    // PIXI as one family name, and PIXI quotes a plain string whole — a
    // comma-separated stack would become a single, unmatchable family.
    const primary = active ? feResolveCanvasFontFamilies(doc)[0] : null;
    cfg.defaultFontFamily = primary || _feDefaultFontFamilyOriginal;
    if (primary) feEnsureCanvasFontsLoaded([primary]);
  } catch { /* no-op */ }
}

// Called by fe-user-font.js once the font/ folder scan resolves, so folder fonts
// join the drawing/note dropdown alongside the built-ins.
function feAddEditorFontFamilies(families = []) {
  let added = false;
  for (const entry of families) {
    const family = String(entry ?? "").trim();
    if (!family || _feExtraEditorFamilies.has(family)) continue;
    _feExtraEditorFamilies.add(family);
    added = true;
  }
  if (added) feApplyCanvasTextFont(document);
}

// UI_ENABLE_FONTS is GM-priority EXCLUDED, so read it directly (same reasoning as
// feApplyStyleVarsFromSettings): going through feSetting would let a GM override
// force fonts onto a client that opted out.
function feApplyCanvasTextFont(doc = document) {
  try {
    let fontsOn = true;
    try { fontsOn = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS); } catch { /* pre-init */ }

    const style = globalThis.CONFIG?.canvasTextStyle;
    if (style) {
      if (_feCanvasFontOriginal === null) _feCanvasFontOriginal = style.fontFamily;
      const active = fontsOn && !!feSetting(S.CANVAS_TEXT_FONT);
      const families = active ? feResolveCanvasFontFamilies(doc) : [];
      style.fontFamily = families.length ? families : _feCanvasFontOriginal;
      if (families.length) feEnsureCanvasFontsLoaded(families);
    }

    feRegisterEditorFonts(fontsOn);
    feApplyDefaultFontFamily(doc, fontsOn);
    feRefreshCanvasTextStyles();
  } catch (err) {
    console.warn("female_edition | failed to apply canvas text font", err);
  }
}

export {
  feSetBodyMergeClasses,
  feSetChatCardFontClass,
  feSetChatFontChoiceClass,
  feSetUiFontClass,
  feSetNeodgmModeClass,
  feSetUserFontMode,
  feSetRetroThemeClass,
  feApplyDoubleCrossLegacyPixiTheme,
  feInstallDoubleCrossLegacyPixiTheme,
  feSetUserColorBgClass,
  feSetPaperOverlayClass,
  feSetUserColorBgBaseClass,
  feNormalizeChoice,
  feSetChatGroupOutlineClass,
  feSetAccentTextOverrideClass,
  feSetSystemMsgColorClass,
  feSetForceNormalMsgColorClass,
  feAddEditorFontFamilies,
  feApplyStyleVarsFromSettings,
  feApplyCanvasTextFont,
};
