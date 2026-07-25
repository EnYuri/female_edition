import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";

// accent hex → { h: 0-360, s: 0-1 }. 무채색(s≈0)이면 h=0으로 고정.
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

function feSetBodyMergeClasses() {
  const enabled = !!feSetting(S.MERGE_ENABLED);
  document.body.classList.toggle("fe-chat-merge", enabled);

  const mode = String(feSetting(S.MERGE_MODE) ?? "standard");
  document.body.classList.toggle("fe-merge-mode-standard", enabled && mode === "standard");
  document.body.classList.toggle("fe-merge-mode-simple", enabled && mode === "simple");

  const style = String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
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
    // Keep both known DX3rd package IDs: older worlds still use double-cross-3rd.
    const systemId = String(globalThis.game?.system?.id ?? "");
    body.classList.toggle("fe-retro-system-dnd5e", enabled && systemId === "dnd5e");
    body.classList.toggle(
      "fe-retro-system-dx3rd",
      enabled && (systemId === "dx3rd-emanim" || systemId === "double-cross-3rd"),
    );
  } catch {}
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

    // 텍스트 색조 오버라이드가 꺼지면 강조색이 적용되는 모든 것(텍스트·테두리·체커보드
    // 무늬)을 기본 백색(#ffffff, H=0·S=0%)으로 되돌려 "진짜 off" 상태로 만든다.
    // 채팅 컨트롤의 강조색 스와치 버튼은 fe-chat-controls-menu.css 가 같은 조건으로 숨긴다.
    const accentOverrideOn = !!feSetting(S.ACCENT_TEXT_OVERRIDE);
    const accent = accentOverrideOn
      ? (String(feSetting(S.DX3RD_PIXEL_ACCENT) ?? "#ffffff").trim() || "#ffffff")
      : "#ffffff";
    root.style.setProperty("--fe-dx3rd-accent", accent);

    // H/S만 분해 — §20 CSS가 고정 명도와 조합해 사용 (명도 오염 방지)
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

// Nameplates/tooltips of already-drawn tokens hold a clone of the old style.
// Re-running _getTextStyle() picks up the new CONFIG value without a full redraw.
function feRefreshCanvasTextStyles() {
  try {
    const c = globalThis.canvas;
    if (!c?.ready) return;
    for (const token of c.tokens?.placeables ?? []) {
      try {
        const style = token?._getTextStyle?.();
        if (!style) continue;
        if (token.nameplate) token.nameplate.style = style;
        if (token.tooltip) token.tooltip.style = style.clone?.() ?? style;
      } catch { /* per-token, non-fatal */ }
    }
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

// UI_ENABLE_FONTS is GM-priority EXCLUDED, so read it directly (same reasoning as
// feApplyStyleVarsFromSettings): going through feSetting would let a GM override
// force fonts onto a client that opted out.
function feApplyCanvasTextFont(doc = document) {
  try {
    const style = globalThis.CONFIG?.canvasTextStyle;
    if (!style) return;
    if (_feCanvasFontOriginal === null) _feCanvasFontOriginal = style.fontFamily;

    let fontsOn = true;
    try { fontsOn = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS); } catch { /* pre-init */ }
    const active = fontsOn && !!feSetting(S.CANVAS_TEXT_FONT);
    const families = active ? feResolveCanvasFontFamilies(doc) : [];

    style.fontFamily = families.length ? families : _feCanvasFontOriginal;
    if (families.length) feEnsureCanvasFontsLoaded(families);
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
  feSetUserColorBgClass,
  feSetPaperOverlayClass,
  feSetUserColorBgBaseClass,
  feSetChatGroupOutlineClass,
  feSetAccentTextOverrideClass,
  feSetSystemMsgColorClass,
  feSetForceNormalMsgColorClass,
  feApplyStyleVarsFromSettings,
  feApplyCanvasTextFont,
};
