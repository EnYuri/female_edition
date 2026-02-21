// female_edition: FVTT v13 + dnd5e 5.2.5
// Chat message/card texture stripper that PRESERVES Chat Portrait's color overlay.
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

const FE = { LOG: "[female_edition] chat-bg-stripper", VERSION: "v13-fix5" };

// Detect Foundry/DnD5e parchment & texture files (names + common paths)
const TEX_RE = /(parchment\.jpg|\/ui\/texture[^"' )]*\.(?:webp|png|jpg|jpeg)|texture[^"' )]*\.(?:webp|png|jpg|jpeg))/i;

const OVERLAY_LAYER = "var(--fe-parchment-overlay)";

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
  return true;
}

/** If ::before/::after have textures, override them via CSS variables. */
function sanitizePseudo(el, pseudo, varName) {
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

function processMessageRoot(root) {
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
  const msg = extractChatMessage(node);
  if (msg) processMessageRoot(msg);
  else if (node instanceof Element) node.querySelectorAll?.(".chat-message").forEach(processMessageRoot);
}

const observedLogs = new WeakSet();

function attachToChatLog(log) {
  if (!(log instanceof Element)) return;
  if (observedLogs.has(log)) return;
  observedLogs.add(log);

  // Existing messages
  log.querySelectorAll(".chat-message").forEach(processMessageRoot);

  // Observe new messages + style reinjection
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
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

Hooks.once("ready", () => {
  console.log(`${FE.LOG} ${FE.VERSION} loaded`);

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
    const el = extractHTMLElement(html);
    if (!el) return;
    processMessageRoot(el);
    requestAnimationFrame(() => processMessageRoot(el));
  });
  Hooks.on("renderChatMessageHTML", (_app, html) => {
    const el = extractHTMLElement(html);
    if (!el) return;
    processMessageRoot(el);
    requestAnimationFrame(() => processMessageRoot(el));
  });

  Hooks.on("renderChatLog", () => attachAllChatLogs());
});
