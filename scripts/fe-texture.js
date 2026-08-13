import { FE_TEX_RE } from "./fe-constants.js";
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

// ---------------------------------------------------------------------------
// Read/write split (MUST keep — measured, do not fold back into one loop)
//
// The per-element helpers above each do getComputedStyle() -> style.setProperty().
// Called in a single loop that is a textbook layout thrash: every write
// invalidates style, so every following read forces a fresh recalculation.
// It is invisible on a live sidebar (a few dozen messages) and catastrophic on
// an archive of a full campaign.
//
// Measured live, v14.365, a real 2938-message dx3rd archive window:
//   3 x 2938 computed-style reads (element + ::before + ::after), no writes ....   96 ms
//   the same reads with ONE style write interleaved per iteration ............. 9037 ms
// i.e. ~94x. It showed up as a single 4363 ms `longtask` right after render —
// the archive window (and Foundry itself, same event loop) simply stopped
// responding to clicks for those seconds. 2789 of the 2938 messages take the
// pseudo write, so nearly every iteration invalidated the next one's reads.
//
// So: PLAN every element in a read-only pass, then APPLY every write. Ordering
// within each phase is preserved, and the planners never read a value that an
// earlier write could have changed — an element's background-image write does
// not affect its own pseudo-elements (background-image is not inherited by
// ::before/::after), and the `--fe-*-bgimg` vars are only ever read back
// through those pseudos, never by the plain-background planner.
// ---------------------------------------------------------------------------

function fePlanElementBackground(win, el, out) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return;
    const styleAttr = el.getAttribute?.("style") || "";
    const cs = win.getComputedStyle?.(el);
    const bgImage = cs?.backgroundImage || "";

    if (!FE_TEX_RE.test(bgImage) && !FE_TEX_RE.test(styleAttr)) return;

    const stripped = feStripTextureLayers(feSplitBgLayers(bgImage));
    const finalLayers = stripped.length ? stripped : ["none"];
    out.push({ el, prop: "background-image", value: finalLayers.join(", "), priority: "important", cls: "fe-bg-sanitized" });
  } catch { /* planning is best-effort, a bad element is simply skipped */ }
}

function fePlanPseudoBackground(win, el, pseudo, varName, out) {
  try {
    if (!win || !el || !(el instanceof win.Element)) return;
    const cs = win.getComputedStyle?.(el, pseudo);
    const bgImage = cs?.backgroundImage || "";
    if (!FE_TEX_RE.test(bgImage)) return;

    const stripped = feStripTextureLayers(feSplitBgLayers(bgImage));
    const finalLayers = stripped.length ? stripped : ["none"];
    out.push({ el, prop: varName, value: finalLayers.join(", "), priority: "", cls: "fe-pseudo-sanitized" });
  } catch { /* planning is best-effort, a bad element is simply skipped */ }
}

function feApplyBackgroundPlan(plan) {
  for (const step of plan) {
    try {
      step.el.style.setProperty(step.prop, step.value, step.priority || "");
      step.el.classList.add(step.cls);
    } catch { /* a detached/dead node must not abort the rest of the plan */ }
  }
}

// `nodes` lets a caller hand in a pre-sliced batch of messages so a huge archive
// log can be stripped in chunks with a yield between them (see
// feRunArchiveChunkedPass in fe-chat-archive.js). Omitted → the whole root.
function feStripChatTexturesInWindow(win, rootEl, { nodes = null } = {}) {
  try {
    if (!win || !rootEl) return;
    const root = rootEl instanceof win.Element ? rootEl : win.document;
    const messages = Array.isArray(nodes) ? nodes : Array.from(root.querySelectorAll?.(".chat-message") ?? []);
    const plan = [];

    for (const msg of messages) {
      const specialKind = feGetSpecialMessageKindInWindow(win, msg);
      if (specialKind === "narrator") {
        // Narrator messages are forced to "none" unconditionally — no read at
        // all — so these steps only ride along to keep the write order intact.
        plan.push({ el: msg, prop: "background-image", value: "none", priority: "important", cls: "fe-bg-sanitized" });
        msg.querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
          ?.forEach?.((el) => plan.push({ el, prop: "background-image", value: "none", priority: "important", cls: "fe-bg-sanitized" }));
        plan.push({ el: msg, prop: "--fe-before-bgimg", value: "none", priority: "", cls: "fe-pseudo-sanitized" });
        plan.push({ el: msg, prop: "--fe-after-bgimg", value: "none", priority: "", cls: "fe-pseudo-sanitized" });
        continue;
      }
      if (specialKind === "round-marker") continue;

      fePlanElementBackground(win, msg, plan);
      msg.querySelectorAll?.(".chat-card, .midi-chat-card, .message-content, .message-header")
        ?.forEach?.((el) => fePlanElementBackground(win, el, plan));
      fePlanPseudoBackground(win, msg, "::before", "--fe-before-bgimg", plan);
      fePlanPseudoBackground(win, msg, "::after", "--fe-after-bgimg", plan);
    }

    feApplyBackgroundPlan(plan);
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
