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
    const enabled = !!feSetting(S.CHATCARD_USE_CUSTOM_FONT);
    doc?.body?.classList?.toggle("fe-chatcard-custom-font", enabled);
  } catch {}
}

function feSetChatFontChoiceClass(doc = document) {
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    const body = doc?.body;
    if (!body) return;
    body.classList.toggle("fe-chat-font-cookie", choice === "cookie");
    body.classList.toggle("fe-chat-font-geurimilgi", choice === "geurimilgi");
  } catch {}
}

function feSetUiFontClass(doc = document) {
  try {
    const enabled = !!feSetting(S.UI_USE_GEURIMILGI);
    doc?.body?.classList?.toggle("fe-ui-font-geurimilgi", enabled);
  } catch (_e) {
    /* noop */
  }
}

function feSetNeodgmModeClass(doc = document) {
  try {
    const choice = String(feSetting(S.CHAT_FONT_CHOICE) ?? "cookie");
    doc?.body?.classList?.toggle("fe-neodgm-mode", choice === "neodgm");
  } catch {}
}

function feSetRetroThemeClass(doc = document) {
  try {
    const enabled = !!feSetting(S.UI_RETRO_THEME);
    doc?.body?.classList?.toggle("fe-retro-theme", enabled);
  } catch {}
}

function feSetUserColorBgClass(doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    doc?.body?.classList?.toggle("fe-msg-bg-usercolor", enabled);
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

function feSetUserColorBgBaseClass(doc = document) {
  try {
    const mode = String(feSetting(S.USER_COLOR_BG_BASE) ?? "white");
    const body = doc?.body;
    if (!body?.classList) return;
    body.classList.toggle("fe-userbg-base-white", mode === "white");
    body.classList.toggle("fe-userbg-base-black", mode === "black");
    if (mode === "none") {
      body.classList.remove("fe-userbg-base-white", "fe-userbg-base-black");
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

    root.style.setProperty("--fe-dx3rd-card-border-alpha", String(num(feSetting(S.DX3RD_CARD_BORDER_ALPHA), 0.5)));

    const accent = String(feSetting(S.DX3RD_PIXEL_ACCENT) ?? "#ffffff").trim() || "#ffffff";
    root.style.setProperty("--fe-dx3rd-accent", accent);

    // H/S만 분해 — §20 CSS가 고정 명도와 조합해 사용 (명도 오염 방지)
    const { h, s } = feAccentToHs(accent);
    root.style.setProperty("--fe-dx3rd-accent-h", `${Math.round(h)}deg`);
    root.style.setProperty("--fe-dx3rd-accent-s", `${Math.round(s * 100)}%`);

  } catch (err) {
    console.warn("female_edition | failed to apply style vars", err);
  }
}

export {
  feSetBodyMergeClasses,
  feSetChatCardFontClass,
  feSetChatFontChoiceClass,
  feSetUiFontClass,
  feSetNeodgmModeClass,
  feSetRetroThemeClass,
  feSetUserColorBgClass,
  feSetUserColorBgBaseClass,
  feSetChatGroupOutlineClass,
  feSetAccentTextOverrideClass,
  feApplyStyleVarsFromSettings,
};
