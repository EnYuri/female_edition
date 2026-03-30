// female_edition: FVTT v13 + dnd5e 5.2.5
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

import { MODULE_ID, feSetting } from "./fe-chat-enhance.js";

const SETTINGS = {
  ENABLE_FONTS:    "enableFonts",
  HIDE_PORTRAITS:  "hideChatPortraits",
  STRIP_TEXTURES:  "stripChatTextures",
};

// --------------------------------
// Settings helpers
// --------------------------------

function safeGetSetting(key, fallback) {
  try { return feSetting(key) ?? fallback; }
  catch { return fallback; }
}

function toggleModuleStylesheet(relPath, enabled) {
  const needle = `/modules/${MODULE_ID}/${relPath}`;
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const matched = links.filter(l => {
    const href = l.getAttribute("href") || "";
    const abs  = l.href || "";
    return href.includes(needle) || abs.includes(needle);
  });
  for (const l of matched) l.disabled = !enabled;
  return matched.length;
}

let _fontRetryTimer = null;

function applyFontSetting(enabled) {
  // Cancel any in-progress retry before starting a new one.
  if (_fontRetryTimer !== null) { clearInterval(_fontRetryTimer); _fontRetryTimer = null; }

  const count = toggleModuleStylesheet("styles/ui-font.css", !!enabled);

  // The stylesheet link may appear slightly later on some setups; retry briefly.
  if (!count) {
    let tries = 0;
    _fontRetryTimer = setInterval(() => {
      tries++;
      const c = toggleModuleStylesheet("styles/ui-font.css", !!enabled);
      if (c || tries >= 20) { clearInterval(_fontRetryTimer); _fontRetryTimer = null; }
    }, 100);
  }
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
// Foundry hooks
// --------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTINGS.ENABLE_FONTS, {
    name: "커스텀 폰트 적용 (쿠키런/그림일기)",
    hint: "이 모듈의 ui-font.css를 활성화합니다. CookieRun + 그림일기 폰트 및 관련 옵션(채팅 글꼴 선택 등)이 동작합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyFontSetting(value),
  });

  game.settings.register(MODULE_ID, SETTINGS.HIDE_PORTRAITS, {
    name: "채팅 기본 포트레이트 숨김(내부/기본)",
    hint: "채팅 카드 헤더의 기본 아바타/포트레이트(및 chat-portrait 모듈이 추가하는 일부 아이콘)를 숨깁니다. 이 모듈이 삽입하는 포트레이트(.fe-chat-portrait-wrap)는 별도 옵션에서 제어합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyPortraitSetting(value),
  });

  game.settings.register(MODULE_ID, SETTINGS.STRIP_TEXTURES, {
    name: "채팅 카드 텍스쳐 제거",
    hint: "dnd5e 기본 parchment/texture 배경만 제거하고, 색상 오버레이(채도 약화)는 유지합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyTextureSetting(value),
  });
});

Hooks.once("ready", () => {
  const fontsEnabled   = safeGetSetting(SETTINGS.ENABLE_FONTS,   true);
  const hidePortraits  = safeGetSetting(SETTINGS.HIDE_PORTRAITS,  true);
  const stripTextures  = safeGetSetting(SETTINGS.STRIP_TEXTURES,  true);

  applyFontSetting(fontsEnabled);
  applyPortraitSetting(hidePortraits);
  // Apply the body class that drives CSS-first texture stripping.
  try { document.body?.classList?.toggle("fe-strip-chat-textures", !!stripTextures); } catch {}
  // Remove any inline overrides left by pre-v0.3.91 builds.
  restoreAllExisting();
});
