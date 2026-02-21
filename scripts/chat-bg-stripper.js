// female_edition: FVTT v13 + dnd5e 5.2.5
// Chat message/card texture stripper that PRESERVES Chat Portrait's color overlay.
//
// v11 additions:
//   - Module settings to control:
//       1) CookieRun font CSS enable/disable
//       2) Chat portrait hiding enable/disable
//       3) Chat texture stripping enable/disable (this script)
//   - Live apply (no reload) for all three.
//
// Texture logic is based on "v13-fix5" (previous stable version).
//
// What we remove:
//   - url(.../ui/parchment.jpg)
//   - url(.../ui/texture*.webp|png|jpg|jpeg)  (e.g. texture-gray1.webp)
//
// What we keep:
//   - background-color (player color from Chat Portrait setting)
//   - background-blend-mode (screen)
//   - any non-texture layers (gradients, module-added overlays, etc)
//
// What we add (only if needed):
//   - a flat "paper" overlay layer (no texture) so screen blending still reduces saturation.

const MODULE_ID = "female_edition";
const FE = { LOG: "[female_edition] chat-bg-stripper", VERSION: "v13-fix5+settings-v11" };

const SETTINGS = {
  ENABLE_FONTS: "enableFonts",
  HIDE_PORTRAITS: "hideChatPortraits",
  STRIP_TEXTURES: "stripChatTextures"
};

// Runtime state (avoid repeated settings reads in hot paths)
const STATE = {
  stripTextures: true
};

// Detect Foundry/DnD5e parchment & texture files (names + common paths)
const TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;

const OVERLAY_LAYER = "var(--fe-parchment-overlay)";

/* --------------------------------
 * Settings helpers
 * -------------------------------- */

function safeGetSetting(key, fallback) {
  try { return game?.settings?.get(MODULE_ID, key); }
  catch (_e) { return fallback; }
}

function toggleModuleStylesheet(relPath, enabled) {
  // relPath like "styles/ui-font.css"
  const needle = `/modules/${MODULE_ID}/${relPath}`;
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const matched = links.filter(l => {
    const href = l.getAttribute("href") || "";
    const abs = l.href || "";
    return href.includes(needle) || abs.includes(needle);
  });
  for (const l of matched) l.disabled = !enabled;
  return matched.length;
}

function applyFontSetting(enabled) {
  // Disable/enable the loaded ui-font.css link
  const count = toggleModuleStylesheet("styles/ui-font.css", !!enabled);

  // In some setups the stylesheet link appears slightly later; retry briefly.
  if (!count) {
    let tries = 0;
    const id = setInterval(() => {
      tries++;
      const c = toggleModuleStylesheet("styles/ui-font.css", !!enabled);
      if (c || tries >= 20) clearInterval(id);
    }, 100);
  }
}

function applyPortraitSetting(hide) {
  document.body.classList.toggle("fe-hide-portraits", !!hide);
}

function sanitizeAllExisting() {
  document.querySelectorAll(":is(#chat-log, .chat-log, ol.chat-log) .chat-message").forEach(processMessageRoot);
}

function restoreAllExisting() {
  // Restore any elements we modified.
  // We mark modified elements with .fe-bg-sanitized and/or .fe-pseudo-sanitized
  const root = document;
  root.querySelectorAll(":is(#chat-log, .chat-log, ol.chat-log) .fe-bg-sanitized").forEach(restoreElement);
  root.querySelectorAll(":is(#chat-log, .chat-log, ol.chat-log) .fe-pseudo-sanitized").forEach(restoreElement);
}

function applyTextureSetting(enabled) {
  STATE.stripTextures = !!enabled;
  if (STATE.stripTextures) sanitizeAllExisting();
  else restoreAllExisting();
}

/* --------------------------------
 * Core: texture stripping
 * -------------------------------- */

/** Split a CSS background-image string into top-level layers, respecting parentheses and quotes. */
function splitLayers(value) {
  if (!value) return [];
  const v = String(value).trim();
  if (!v || v === "none") return [];
  const out = [];
  let buf = "";
  let depth = 0;
  let q = null;

  for (let i = 0; i < v.length; i++) {
    const c = v[i];

    if (q) {
      buf += c;
      if (c === q && v[i - 1] !== "\\") q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; buf += c; continue; }

    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);

    if (c === "," && depth === 0) {
      const s = buf.trim();
      if (s && s !== "none") out.push(s);
      buf = "";
      continue;
    }
    buf += c;
  }

  const last = buf.trim();
  if (last && last !== "none") out.push(last);
  return out;
}

function hasGradientLayer(layers) {
  return layers.some(l => /gradient\(/i.test(l));
}

function isTextureLayer(layer) {
  return /url\(/i.test(layer) && TEX_RE.test(layer);
}

function stripTextureLayers(layers) {
  return layers.filter(l => !isTextureLayer(l));
}

/**
 * Remove only texture url() layers from background-image and ensure a flat overlay exists.
 * Never touches background-color or background-blend-mode.
 */
function sanitizeElementBackground(el) {
  if (!STATE.stripTextures) return false;
  if (!(el instanceof Element)) return false;

  const styleAttr = el.getAttribute("style") || "";
  const cs = getComputedStyle(el);
  const bgImage = cs.backgroundImage || "";

  // Fast reject
  if (!TEX_RE.test(bgImage) && !TEX_RE.test(styleAttr)) return false;

  const layers = splitLayers(bgImage);
  const stripped = stripTextureLayers(layers);

  // Preserve existing gradient overlays if present; otherwise ensure our flat overlay exists.
  const needOverlay = !hasGradientLayer(stripped);

  const nextLayers = needOverlay ? [OVERLAY_LAYER, ...stripped] : stripped;
  const finalLayers = nextLayers.length ? nextLayers : [OVERLAY_LAYER];

  el.style.setProperty("background-image", finalLayers.join(", "), "important");
  el.classList.add("fe-bg-sanitized");
  return true;
}

/** If ::before/::after have textures, override them via CSS variables. */
function sanitizePseudo(el, pseudo, varName) {
  if (!STATE.stripTextures) return false;
  try {
    const cs = getComputedStyle(el, pseudo);
    const bgImage = cs?.backgroundImage || "";
    if (!TEX_RE.test(bgImage)) return false;

    const layers = splitLayers(bgImage);
    const stripped = stripTextureLayers(layers);
    const needOverlay = !hasGradientLayer(stripped);

    const nextLayers = needOverlay ? [OVERLAY_LAYER, ...stripped] : stripped;
    const finalLayers = nextLayers.length ? nextLayers : [OVERLAY_LAYER];

    el.style.setProperty(varName, finalLayers.join(", "));
    el.classList.add("fe-pseudo-sanitized");
    return true;
  } catch (_e) {
    return false;
  }
}

/** Restore any changes made by this module (background-image + pseudo vars). */
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

function processMessageRoot(root) {
  if (!STATE.stripTextures) return;
  if (!(root instanceof Element)) return;

  // Root message (common case)
  sanitizeElementBackground(root);

  // Nested containers where some modules apply textures
  root.querySelectorAll(":scope .chat-card, :scope .midi-chat-card, :scope .message-content, :scope .message-header")
    .forEach(sanitizeElementBackground);

  // Pseudo layers (depends on theme/system)
  sanitizePseudo(root, "::before", "--fe-before-bgimg");
  sanitizePseudo(root, "::after", "--fe-after-bgimg");
}

function extractChatMessage(node) {
  if (!(node instanceof Element)) return null;
  if (node.classList.contains("chat-message")) return node;
  return node.closest?.(".chat-message") || null;
}

function processNode(node) {
  if (!STATE.stripTextures) return;
  const msg = extractChatMessage(node);
  if (msg) processMessageRoot(msg);
  else if (node instanceof Element) node.querySelectorAll?.(".chat-message").forEach(processMessageRoot);
}

const observedLogs = new WeakSet();

function attachToChatLog(log) {
  if (!(log instanceof Element)) return;
  if (observedLogs.has(log)) return;
  observedLogs.add(log);

  // Existing messages (will early-return if stripping disabled)
  log.querySelectorAll(".chat-message").forEach(processMessageRoot);

  // Observe new messages + style reinjection
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (!STATE.stripTextures) continue;

      if (m.type === "childList") {
        m.addedNodes?.forEach(processNode);
      } else if (m.type === "attributes") {
        const t = m.target;
        if (!(t instanceof Element)) continue;
        if (m.attributeName === "style" && TEX_RE.test(t.getAttribute("style") || "")) processNode(t);
      }
    }
  });

  obs.observe(log, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] });
}

function attachAllChatLogs() {
  document.querySelectorAll(":is(#chat-log, .chat-log, ol.chat-log)").forEach(attachToChatLog);
}

function extractHTMLElement(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  if (html.jquery && html[0] instanceof HTMLElement) return html[0];
  if (Array.isArray(html) && html[0] instanceof HTMLElement) return html[0];
  if (html[0] instanceof HTMLElement) return html[0];
  return null;
}

/* --------------------------------
 * Foundry hooks
 * -------------------------------- */

Hooks.once("init", () => {
  // 1) Font toggle (ui-font.css)
  game.settings.register(MODULE_ID, SETTINGS.ENABLE_FONTS, {
    name: "쿠키런 폰트 적용",
    hint: "UI와 채팅에 새 폰트를 적용합니다. 끄면 Foundry 기본 폰트로 돌아갑니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyFontSetting(value)
  });

  // 2) Portrait hide toggle (body class)
  game.settings.register(MODULE_ID, SETTINGS.HIDE_PORTRAITS, {
    name: "채팅 포트레이트 숨김",
    hint: "DnD5e 시스템이 출력하는 채팅 포트레이트/아바타/스킬 아이콘을 숨깁니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyPortraitSetting(value)
  });

  // 3) Texture stripping toggle (this script)
  game.settings.register(MODULE_ID, SETTINGS.STRIP_TEXTURES, {
    name: "채팅 카드 텍스쳐 제거",
    hint: "dnd5e 기본 parchment/texture 배경을 제거합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: value => applyTextureSetting(value)
  });
});

Hooks.once("ready", () => {
  console.log(`${FE.LOG} ${FE.VERSION} loaded`);

  // Apply settings (initial)
  const fontsEnabled = safeGetSetting(SETTINGS.ENABLE_FONTS, true);
  const hidePortraits = safeGetSetting(SETTINGS.HIDE_PORTRAITS, true);
  const stripTextures = safeGetSetting(SETTINGS.STRIP_TEXTURES, true);

  applyFontSetting(fontsEnabled);
  applyPortraitSetting(hidePortraits);
  STATE.stripTextures = !!stripTextures;

  // Attach to existing logs
  attachAllChatLogs();

  // Watch for new chat logs / popouts
  const bodyObs = new MutationObserver(muts => {
    for (const m of muts) {
      m.addedNodes?.forEach(n => {
        if (!(n instanceof Element)) return;
        if (n.matches?.(":is(#chat-log, .chat-log, ol.chat-log)")) attachToChatLog(n);
        n.querySelectorAll?.(":is(#chat-log, .chat-log, ol.chat-log)").forEach(attachToChatLog);
      });
    }
  });
  bodyObs.observe(document.body, { childList: true, subtree: true });

  // Hooks (both legacy and v13)
  Hooks.on("renderChatMessage", (_msg, html) => {
    if (!STATE.stripTextures) return;
    const el = extractHTMLElement(html);
    if (!el) return;
    processMessageRoot(el);
    requestAnimationFrame(() => processMessageRoot(el));
  });
  Hooks.on("renderChatMessageHTML", (_app, html) => {
    if (!STATE.stripTextures) return;
    const el = extractHTMLElement(html);
    if (!el) return;
    processMessageRoot(el);
    requestAnimationFrame(() => processMessageRoot(el));
  });

  Hooks.on("renderChatLog", () => attachAllChatLogs());

  // Ensure current state is reflected immediately on load
  if (STATE.stripTextures) sanitizeAllExisting();
  else restoreAllExisting();
});
