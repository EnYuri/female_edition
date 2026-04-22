import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";

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
    const useCookie = choice === "cookie";
    body.classList.toggle("fe-chat-font-cookie", useCookie);
    body.classList.toggle("fe-chat-font-geurimilgi", !useCookie);
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

function feSetUserColorBgClass(doc = document) {
  try {
    const enabled = !!feSetting(S.USE_USER_COLOR_BG);
    doc?.body?.classList?.toggle("fe-msg-bg-usercolor", enabled);
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
    root.style.setProperty("--chat-message-spacing", chatSpacing);

    root.style.setProperty("--fe-paper-alpha", String(num(feSetting(S.STYLE_BG_SATURATION), 0.42)));

    // enableFonts is excluded from GM priority so each player controls it independently.
    const fontsEnabled = (() => {
      try { return !!game.settings.get(MODULE_ID, "enableFonts"); } catch { return true; }
    })();
    const h1Cookie = fontsEnabled && !!feSetting(S.UI_OVERRIDE_FONT_H1_COOKIE);
    if (h1Cookie) root.style.setProperty("--font-h1", "var(--fe-font-primary)");
    else root.style.removeProperty("--font-h1");
  } catch (err) {
    console.warn("female_edition | failed to apply style vars", err);
  }
}

export {
  feSetBodyMergeClasses,
  feSetChatCardFontClass,
  feSetChatFontChoiceClass,
  feSetUiFontClass,
  feSetUserColorBgClass,
  feSetUserColorBgBaseClass,
  feApplyStyleVarsFromSettings,
};
