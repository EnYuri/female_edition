import { MODULE_ID, FE_TEX_RE } from "./fe-constants.js";
import {
  feGetMessageFromElementOrCollection, feGetRoundMarkerFlagValue, feLooksLikeRoundMarkerFlavor,
  feIsSystemCombatNoticeContent, FE_SYSTEM_COMBAT_NOTICE_CLASS,
} from "./fe-util.js";

function feSplitBgLayers(value) {
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
      buf = ""; continue;
    }
    buf += c;
  }
  const last = buf.trim();
  if (last && last !== "none") out.push(last);
  return out;
}

function feIsTextureLayer(layer) {
  return /url\(/i.test(String(layer)) && FE_TEX_RE.test(String(layer));
}

function feStripTextureLayers(layers) {
  return Array.isArray(layers) ? layers.filter((l) => !feIsTextureLayer(l)) : [];
}

function feSanitizeElementBackgroundInWindow(win, el) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    const styleAttr = el.getAttribute?.("style") || "";
    const cs = win.getComputedStyle?.(el);
    const bgImage = cs?.backgroundImage || "";

    if (!FE_TEX_RE.test(bgImage) && !FE_TEX_RE.test(styleAttr)) return false;

    const layers = feSplitBgLayers(bgImage);
    const stripped = feStripTextureLayers(layers);
    const finalLayers = stripped.length ? stripped : ["none"];

    el.style.setProperty("background-image", finalLayers.join(", "), "important");
    el.classList.add("fe-bg-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feSanitizePseudoInWindow(win, el, pseudo, varName) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    const cs = win.getComputedStyle?.(el, pseudo);
    const bgImage = cs?.backgroundImage || "";
    if (!FE_TEX_RE.test(bgImage)) return false;

    const layers = feSplitBgLayers(bgImage);
    const stripped = feStripTextureLayers(layers);
    const finalLayers = stripped.length ? stripped : ["none"];

    el.style.setProperty(varName, finalLayers.join(", "));
    el.classList.add("fe-pseudo-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feIsNarratorMessageElementInWindow(win, msgEl) {
  try {
    if (!win || !msgEl || !(msgEl instanceof win.Element)) return false;
    if (msgEl.classList?.contains?.("narrator-chat")) return true;

    const rawId =
      msgEl.dataset?.messageId ||
      msgEl.dataset?.documentId ||
      msgEl.getAttribute?.("data-message-id") ||
      msgEl.getAttribute?.("data-document-id");
    const msgId = rawId ? String(rawId).split(".").pop() : null;
    if (!msgId) return false;

    const msg = feGetMessageFromElementOrCollection(msgEl) || game.messages?.get?.(msgId);
    return !!msg?.getFlag?.("narrator-tools", "type") || !!msg?.flags?.["narrator-tools"];
  } catch {
    return false;
  }
}

function feIsRoundMarkerMessageElementInWindow(win, msgEl) {
  try {
    if (!win || !msgEl || !(msgEl instanceof win.Element)) return false;
    if (msgEl.classList?.contains?.("round-marker") || msgEl.classList?.contains?.("fe-round-marker-chat")) return true;
    if (msgEl.querySelector?.(`.round-marker, .${FE_SYSTEM_COMBAT_NOTICE_CLASS}`)) return true;

    const rawId =
      msgEl.dataset?.messageId ||
      msgEl.dataset?.documentId ||
      msgEl.getAttribute?.("data-message-id") ||
      msgEl.getAttribute?.("data-document-id");
    const msgId = rawId ? String(rawId).split(".").pop() : null;
    if (!msgId) return false;

    const msg = feGetMessageFromElementOrCollection(msgEl) || game.messages?.get?.(msgId);
    const flag = feGetRoundMarkerFlagValue(msg);
    if (flag === true || String(flag) === "true") return true;
    const content = String(msg?.content ?? "");
    if (/\bround-marker\b/i.test(content)) return true;
    if (feIsSystemCombatNoticeContent(content)) return true;
    return feLooksLikeRoundMarkerFlavor(msg?.flavor ?? "", content);
  } catch {
    return false;
  }
}

function feGetSpecialMessageKindInWindow(win, msgEl) {
  try {
    if (feIsNarratorMessageElementInWindow(win, msgEl)) return "narrator";
    if (feIsRoundMarkerMessageElementInWindow(win, msgEl)) return "round-marker";
    return null;
  } catch {
    return null;
  }
}

function feSanitizeNarratorBackgroundInWindow(win, el) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    el.style.setProperty("background-image", "none", "important");
    el.classList.add("fe-bg-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feSanitizePseudoNoneInWindow(win, el, varName) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return false;
    el.style.setProperty(varName, "none");
    el.classList.add("fe-pseudo-sanitized");
    return true;
  } catch {
    return false;
  }
}

function feStripChatTexturesInWindow(win, rootEl) {
  try {
    if (!win || !rootEl) return;
    const root = rootEl instanceof win.Element ? rootEl : win.document;
    const messages = Array.from(root.querySelectorAll?.(".chat-message") ?? []);
    for (const msg of messages) {
      const specialKind = feGetSpecialMessageKindInWindow(win, msg);
      if (specialKind === "narrator") {
        feSanitizeNarratorBackgroundInWindow(win, msg);
        msg.querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
          ?.forEach?.((el) => feSanitizeNarratorBackgroundInWindow(win, el));
        feSanitizePseudoNoneInWindow(win, msg, "--fe-before-bgimg");
        feSanitizePseudoNoneInWindow(win, msg, "--fe-after-bgimg");
        continue;
      }
      if (specialKind === "round-marker") continue;

      feSanitizeElementBackgroundInWindow(win, msg);
      msg.querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
        ?.forEach?.((el) => feSanitizeElementBackgroundInWindow(win, el));
      feSanitizePseudoInWindow(win, msg, "::before", "--fe-before-bgimg");
      feSanitizePseudoInWindow(win, msg, "::after", "--fe-after-bgimg");
    }
  } catch (err) {
    console.warn("female_edition | archive texture strip failed", err);
  }
}

export {
  feSplitBgLayers,
  feIsTextureLayer,
  feStripTextureLayers,
  feSanitizeElementBackgroundInWindow,
  feSanitizePseudoInWindow,
  feIsNarratorMessageElementInWindow,
  feIsRoundMarkerMessageElementInWindow,
  feGetSpecialMessageKindInWindow,
  feSanitizeNarratorBackgroundInWindow,
  feSanitizePseudoNoneInWindow,
  feStripChatTexturesInWindow,
};
