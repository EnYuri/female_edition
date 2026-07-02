// female_edition: FVTT v13+
// Chat message/card texture stripper — settings + CSS-class driver only.
//
// v0.3.91+: Texture stripping is CSS-first.
// This script is now responsible only for:
//   1) Registering the three settings (fonts, portrait-hide, texture-strip)
//   2) Applying the corresponding body/stylesheet toggles on load and onChange
//   3) Cleaning up any legacy *inline* background-image overrides left by
//      pre-v0.3.91 builds (via restoreAllExisting / restoreElement).
//
// All actual texture removal is handled by CSS rules in:
//   styles/chat-bg-stripper.css  — body.fe-strip-chat-textures .message::before { ... }
//
// What we remove (CSS):
//   - url(.../ui/parchment.jpg)
//   - url(.../ui/texture*.webp|png|jpg|jpeg)  e.g. texture-gray1.webp
//
// What we keep (CSS):
//   - background-color (player color from Chat Portrait setting)
//   - background-blend-mode (screen)
//   - --fe-parchment-overlay (flat desaturation overlay)

import { MODULE_ID, S, FE_DEFAULTS, feSetting } from "./fe-chat-enhance.js";

const SETTINGS = {
  ENABLE_FONTS:    S.UI_ENABLE_FONTS,
  HIDE_PORTRAITS:  S.UI_HIDE_PORTRAITS,
  STRIP_TEXTURES:  S.UI_STRIP_TEXTURES,
};

// --------------------------------
// Settings helpers
// --------------------------------

function safeGetSetting(key, fallback) {
  try { return feSetting(key) ?? fallback; }
  catch { return fallback; }
}

function applyFontSetting(enabled) {
  // Toggle body class instead of disabling the stylesheet link.
  // This is more reliable: link.disabled can be reset when Foundry re-injects
  // stylesheets, but a body class persists until explicitly removed.
  try {
    document.body.classList.toggle("fe-fonts-enabled", !!enabled);
  } catch { /* no-op */ }
}

function applyPortraitSetting(hide) {
  document.body.classList.toggle("fe-hide-portraits", !!hide);
}

function applyTextureSetting(enabled) {
  try { document.body?.classList?.toggle("fe-strip-chat-textures", !!enabled); } catch {}
  // Clean up any legacy inline background-image overrides left by pre-v0.3.91 builds.
  restoreAllExisting();
}

// --------------------------------
// Legacy inline-override cleanup
// --------------------------------
// Pre-v0.3.91 builds mutated element.style directly and marked elements with
// .fe-bg-sanitized / .fe-pseudo-sanitized.  Remove those overrides so the
// CSS-first rules can take over cleanly.

function restoreElement(el) {
  if (!(el instanceof Element)) return;
  if (el.classList.contains("fe-bg-sanitized")) {
    el.style.removeProperty("background-image");
    el.classList.remove("fe-bg-sanitized");
  }
  if (el.classList.contains("fe-pseudo-sanitized")) {
    el.style.removeProperty("--fe-before-bgimg");
    el.style.removeProperty("--fe-after-bgimg");
    el.classList.remove("fe-pseudo-sanitized");
  }
}

function restoreAllExisting() {
  const root = document;
  root.querySelectorAll(
    ":is(#chat-log, .chat-log, ol.chat-log) .fe-bg-sanitized, #chat-notifications > .fe-bg-sanitized"
  ).forEach(restoreElement);
  root.querySelectorAll(
    ":is(#chat-log, .chat-log, ol.chat-log) .fe-pseudo-sanitized, #chat-notifications > .fe-pseudo-sanitized"
  ).forEach(restoreElement);
}

// --------------------------------
// Chat context-menu surface sync
// --------------------------------

const FE_CHAT_CONTEXT_SURFACE_CLASSES = [
  "fe-has-user-color",
  "fe-system-msg",
  "fe-narrator-chat",
  "narrator-chat",
  "fe-round-marker-chat",
  "round-marker",
];

const FE_CHAT_CONTEXT_CSS_VARS = [
  "--fe-user-color-rgb",
  "--fe-user-bg-base-rgb",
  "--fe-group-outline-color",
  "--chat-message-border-color",
];

function feGetChatContextMessage(target) {
  try {
    const message = target?.closest?.(".chat-message, .message");
    if (!message?.matches?.("[data-message-id], [data-document-id]")) return null;
    if (!message.closest?.(".chat-popout, #chat-log, .chat-log, ol.chat-log, #chat-notifications, #fe-chat-export-log")) return null;
    return message;
  } catch {
    return null;
  }
}

function feSyncChatContextMenuSurface(contextMenu, menuOverride = null, targetOverride = null) {
  try {
    const menu = menuOverride ?? contextMenu?.element;
    const message = feGetChatContextMessage(targetOverride ?? contextMenu?.target);
    if (!menu || !message) return;

    const cs = getComputedStyle(message);
    menu.classList.add("fe-chat-context-menu");
    for (const cls of FE_CHAT_CONTEXT_SURFACE_CLASSES) {
      menu.classList.toggle(cls, message.classList.contains(cls));
    }

    menu.style.backgroundColor = cs.backgroundColor;
    menu.style.backgroundImage = cs.backgroundImage;
    menu.style.backgroundRepeat = cs.backgroundRepeat;
    menu.style.backgroundPosition = cs.backgroundPosition;
    menu.style.backgroundSize = cs.backgroundSize;
    menu.style.backgroundBlendMode = cs.backgroundBlendMode;
    menu.style.color = cs.color;
    menu.style.textShadow = cs.textShadow;
    menu.style.fontFamily = cs.fontFamily;

    for (const name of FE_CHAT_CONTEXT_CSS_VARS) {
      const value = cs.getPropertyValue(name).trim();
      if (value) menu.style.setProperty(name, value);
      else menu.style.removeProperty(name);
    }
  } catch {
    /* no-op */
  }
}

function feInstallChatContextMenuSurfaceSync() {
  try {
    const CM = foundry?.applications?.ux?.ContextMenu ?? globalThis.ContextMenu;
    const proto = CM?.prototype;
    if (!proto || proto.__feChatContextSurfaceSyncInstalled) return;
    const origSetPosition = proto._setPosition;
    if (typeof origSetPosition === "function") {
      proto._setPosition = function (menu, target, options) {
        const result = origSetPosition.call(this, menu, target, options);
        feSyncChatContextMenuSurface(this, menu, target);
        return result;
      };
    } else {
      const origRender = proto.render;
      if (typeof origRender !== "function") return;
      proto.render = async function (...args) {
        const result = await origRender.apply(this, args);
        feSyncChatContextMenuSurface(this);
        return result;
      };
    }
    proto.__feChatContextSurfaceSyncInstalled = true;
  } catch (err) {
    console.warn(`${MODULE_ID} | failed to install chat context-menu surface sync`, err);
  }
}

// --------------------------------
// Foundry hooks
// --------------------------------

Hooks.once("init", () => {
  feInstallChatContextMenuSurfaceSync();

  game.settings.register(MODULE_ID, SETTINGS.ENABLE_FONTS, {
    name: "커스텀 폰트 적용 (쿠키런/그림일기)",
    hint: "이 모듈의 ui-font.css를 활성화합니다. CookieRun + 그림일기 폰트 및 관련 옵션(채팅 글꼴 선택 등)이 동작합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_ENABLE_FONTS],
    onChange: value => applyFontSetting(value),
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_PORTRAITS, {
    name: "채팅 기본 포트레이트 숨김(내부/기본)",
    hint: "채팅 카드 헤더의 기본 아바타/포트레이트(및 chat-portrait 모듈이 추가하는 일부 아이콘)를 숨깁니다. 이 모듈이 삽입하는 포트레이트(.fe-chat-portrait-wrap)는 별도 옵션에서 제어합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_HIDE_PORTRAITS],
    onChange: value => applyPortraitSetting(value),
  });

  game.settings.register(MODULE_ID, SETTINGS.STRIP_TEXTURES, {
    name: "채팅 카드 텍스쳐 제거",
    hint: "채팅 카드의 parchment/texture 배경 이미지를 제거하고, 색상 오버레이(채도 약화)는 유지합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_STRIP_TEXTURES],
    onChange: value => applyTextureSetting(value),
  });

  // Apply fe-fonts-enabled as early as possible (init) to prevent FOUC.
  // The ready hook will re-apply with the final feSetting() value (GM priority aware).
  try {
    const fontsEnabled = safeGetSetting(SETTINGS.ENABLE_FONTS, FE_DEFAULTS[S.UI_ENABLE_FONTS]);
    document.body?.classList?.toggle("fe-fonts-enabled", !!fontsEnabled);
  } catch { /* no-op */ }
});

Hooks.once("ready", () => {
  const fontsEnabled   = safeGetSetting(SETTINGS.ENABLE_FONTS,   FE_DEFAULTS[S.UI_ENABLE_FONTS]);
  const hidePortraits  = safeGetSetting(SETTINGS.HIDE_PORTRAITS, FE_DEFAULTS[S.UI_HIDE_PORTRAITS]);
  const stripTextures  = safeGetSetting(SETTINGS.STRIP_TEXTURES, FE_DEFAULTS[S.UI_STRIP_TEXTURES]);

  applyFontSetting(fontsEnabled);
  applyPortraitSetting(hidePortraits);
  // Apply the body class that drives CSS-first texture stripping.
  try { document.body?.classList?.toggle("fe-strip-chat-textures", !!stripTextures); } catch {}
  // Remove any inline overrides left by pre-v0.3.91 builds.
  restoreAllExisting();
  feInstallChatContextMenuSurfaceSync();

  // Re-assert local font preference after every GM priority sync.
  // enableFonts is excluded from GM priority (players control it personally),
  // but feApplyStyleVarsFromSettings is called during sync and may reset font-related
  // inline styles. Re-applying here ensures the player's choice always wins.
  Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
    try {
      if (payload?.reason !== "gm-priority-overrides") return;
      const localFontsEnabled = safeGetSetting(SETTINGS.ENABLE_FONTS, FE_DEFAULTS[S.UI_ENABLE_FONTS]);
      applyFontSetting(localFontsEnabled);
    } catch { /* no-op */ }
  });
});
