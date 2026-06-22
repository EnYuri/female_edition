// Chat portrait features (split)
// Implements a small, FVTT v13-safe subset inspired by:
// https://github.com/p4535992/foundryvtt-chat-portrait

import {
  MODULE_ID,
  S,
  feSetting,
  feGetChatLogs,
  feGetSpeakerActorFromMessage,
  feGetMessageUserColor,
  feFireChatUiUpdated,
} from "./fe-chat-enhance.js";

const CP = Object.freeze({
  ENABLED: "chatPortraitEnabled",
  HIDE_WRAP: "chatPortraitHideWrap",
  USE_TOKEN: "chatPortraitUseTokenImage",
  SIZE: "chatPortraitSize",
  CARD_ICON_SIZE: "chatPortraitCardIconSize",
  SHAPE: "chatPortraitShape",
  BORDER_MODE: "chatPortraitBorderMode",
  BORDER_WIDTH: "chatPortraitBorderWidth",
  BORDER_COLOR: "chatPortraitBorderColor",
  APPLY_COMBAT: "chatPortraitApplyCombatTracker",
  NAME_ALIGN: "chatPortraitNameAlign",

  SHOW_IC: "chatPortraitShowIC",
  SHOW_OOC: "chatPortraitShowOOC",
  SHOW_EMOTE: "chatPortraitShowEmote",
  SHOW_WHISPER: "chatPortraitShowWhisper",
  SHOW_ROLL: "chatPortraitShowRoll",
  SHOW_OTHER: "chatPortraitShowOther",
});

// ChatMessage flag key (stable portrait src, similar to chat-portrait module's flags.chat-portrait.src)
const FE_FLAG_PORTRAIT_SRC = "portraitSrc";

// Maximum number of entries kept in the HQ-resample cache.
// Each entry holds a data: URL (~5–30 KB for a 64px portrait), so 200 entries
// caps memory at roughly 1–6 MB — safe even in long sessions with many actors.
const CP_RESAMPLE_CACHE_MAX = 200;

// Cache for high-quality downscaled portraits (per src+size+fit) — LRU-capped.
// Implemented as an insertion-order Map; on overflow the oldest entry is evicted.
const _cpResampleCache = new Map();

function cpResampleCacheSet(key, value) {
  if (_cpResampleCache.has(key)) _cpResampleCache.delete(key); // refresh position
  _cpResampleCache.set(key, value);
  if (_cpResampleCache.size > CP_RESAMPLE_CACHE_MAX) {
    // Evict the oldest (first) entry.
    _cpResampleCache.delete(_cpResampleCache.keys().next().value);
  }
}

function cpResampleCacheGet(key) {
  const value = _cpResampleCache.get(key);
  if (value === undefined) return undefined;
  // Move to end (most-recently-used).
  _cpResampleCache.delete(key);
  _cpResampleCache.set(key, value);
  return value;
}

// Track in-flight resample promises to avoid duplicating work
const _cpResampleInflight = new Map();

const _cpRefreshRootTimers = new WeakMap();
let _cpRefreshAllTimer = null;

// Cross-window safe DOM checks (avoid instanceof across Window realms).
function cpIsElement(node) {
  return !!node && node.nodeType === 1;
}

function cpIsImageElement(node) {
  return cpIsElement(node) && String(node.tagName || "").toUpperCase() === "IMG";
}


function cpGet(key) {
  return feSetting(key);
}

function cpGetNameAlign() {
  try {
    const value = String(cpGet(CP.NAME_ALIGN) || "center").trim().toLowerCase();
    return value === "left" ? "left" : "center";
  } catch {
    return "center";
  }
}

function cpApplyNameAlignClasses(doc = document) {
  try {
    const body = doc?.body;
    if (!body?.classList) return;
    const align = cpGetNameAlign();
    body.classList.toggle("fe-chat-portrait-name-align-left", align === "left");
    body.classList.toggle("fe-chat-portrait-name-align-center", align !== "left");
  } catch {}
}

function cpGetMergeFollowMode() {
  try {
    return String(feSetting(S.MERGE_FOLLOW_HEADER_STYLE) ?? "hide");
  } catch {
    return "hide";
  }
}

function cpIsMergeEnabled() {
  try {
    return !!feSetting(S.MERGE_ENABLED);
  } catch {
    return false;
  }
}

function cpIsNotificationMessageElement(messageEl) {
  try {
    if (!messageEl) return false;
    if (messageEl.matches?.("#chat-notifications > .message, #chat-notifications .message")) return true;
    return !!messageEl.closest?.("#chat-notifications .message");
  } catch {
    return false;
  }
}

function cpShouldRenderPortraitForMessageElement(messageEl) {
  try {
    if (!messageEl) return true;
    if (cpIsNotificationMessageElement(messageEl)) return true;

    // If FE merge is enabled and this is a follow-up message (mid/end), mimic chat-portrait behavior:
    // - only show portraits on follow-ups when the merge follow mode is "portrait".
    if (cpIsMergeEnabled()) {
      const cl = messageEl.classList;
      const isFollow =
        cl?.contains?.("fe-merge-mid") ||
        cl?.contains?.("fe-merge-end") ||
        cl?.contains?.("fe-merge-follow");
      if (isFollow) {
        const mode = cpGetMergeFollowMode();
        return mode === "portrait";
      }
    }
  } catch {
    // fall through
  }
  return true;
}

function cpExtractHTMLElement(html) {
  if (!html) return null;
  if (cpIsElement(html)) return html;
  // jQuery-like wrappers
  if (html.jquery && cpIsElement(html[0])) return html[0];
  if (Array.isArray(html) && cpIsElement(html[0])) return html[0];
  if (cpIsElement(html[0])) return html[0];
  return null;
}

function cpExtractChatMessageElement(html) {
  const el = cpExtractHTMLElement(html);
  if (!el) return null;

  // Foundry v13 hook passes an HTMLElement for the *message*.
  // Be defensive: some wrappers/modules may pass a child node.
  try {
    if (el.matches?.("li.chat-message, #chat-notifications .message")) return el;
    const closest = el.closest?.("li.chat-message, #chat-notifications .message");
    if (closest) return closest;
    const found = el.querySelector?.("li.chat-message, #chat-notifications .message");
    if (found) return found;
  } catch {
    /* fall through */
  }
  return el;
}

let _cpWarnedChatPortraitActive = false;

function cpWarnIfChatPortraitModuleActive() {
  if (_cpWarnedChatPortraitActive) return;
  if (!cpIsChatPortraitModuleActive()) return;
  _cpWarnedChatPortraitActive = true;
  console.warn(
    `[${MODULE_ID}] "chat-portrait" 모듈이 활성화되어 있어 포트레이트가 중복 표시될 수 있습니다. 필요하면 둘 중 하나를 비활성화하세요.`
  );
}

function cpSetRootVars(doc = document) {
  try {
    const targetDoc = doc?.documentElement ? doc : (doc?.ownerDocument ?? document);
    if (!targetDoc?.documentElement) return;

    const size = Math.max(16, Number(cpGet(CP.SIZE) ?? 64) || 64);
    targetDoc.documentElement.style.setProperty("--fe-chat-portrait-size", `${size}px`);

    const hideWrap = !!cpGet(CP.HIDE_WRAP);
    targetDoc.body?.classList?.toggle("fe-hide-chat-portrait-wrap", hideWrap);

    cpApplyNameAlignClasses(targetDoc);
  } catch {}
}

function cpIsChatPortraitModuleActive() {
  return !!game?.modules?.get?.("chat-portrait")?.active;
}

function cpGetMessageKind(messageEl, message) {
  const cl = messageEl?.classList;

  // Prefer DOM classes (stable across core/system rendering)
  if (cl?.contains?.("whisper")) return "whisper";
  if (cl?.contains?.("emote")) return "emote";
  if (cl?.contains?.("ic")) return "ic";
  if (cl?.contains?.("ooc")) return "ooc";

  // Rolls are not always a class on the root element; try message flags/fields.
  if (message?.isRoll || (Array.isArray(message?.rolls) && message.rolls.length)) return "roll";
  if (messageEl?.querySelector?.(".dice-roll")) return "roll";

  return "other";
}

function cpIsKindAllowed(kind) {
  switch (kind) {
    case "ic":
      return !!cpGet(CP.SHOW_IC);
    case "ooc":
      return !!cpGet(CP.SHOW_OOC);
    case "emote":
      return !!cpGet(CP.SHOW_EMOTE);
    case "whisper":
      return !!cpGet(CP.SHOW_WHISPER);
    case "roll":
      return !!cpGet(CP.SHOW_ROLL);
    default:
      return !!cpGet(CP.SHOW_OTHER);
  }
}

function cpGetTokenDocFromSpeaker(speaker) {
  const tokenId = speaker?.token;
  if (!tokenId) return null;

  // Prefer explicit scene on speaker
  const sceneId = speaker?.scene;
  const scene = sceneId ? game.scenes?.get(sceneId) : canvas?.scene;
  const tokenDoc = scene?.tokens?.get(tokenId);
  if (tokenDoc) return tokenDoc;

  // Fallback: active canvas tokens (if available)
  const tokenObj = canvas?.tokens?.get?.(tokenId);
  return tokenObj?.document ?? null;
}

function cpGetStoredPortraitSrc(message) {
  try {
    const feSrc = message?.flags?.[MODULE_ID]?.[FE_FLAG_PORTRAIT_SRC];
    if (feSrc) return String(feSrc);
  } catch {
    // ignore
  }

  // Compatibility: if chat-portrait module stored src on the message, reuse it.
  try {
    const cpSrc = message?.flags?.["chat-portrait"]?.src;
    if (cpSrc) return String(cpSrc);
  } catch {
    // ignore
  }

  return null;
}

function cpSetStoredPortraitSrcOnPreCreate(message, src) {
  try {
    if (!message || !src) return;
    // preCreate hooks can mutate source data using updateSource.
    message.updateSource({
      flags: {
        [MODULE_ID]: {
          ...(message.flags?.[MODULE_ID] ?? {}),
          [FE_FLAG_PORTRAIT_SRC]: String(src),
        },
      },
    });
  } catch {
    /* no-op */
  }
}

function cpGetPortraitSrc(message) {
  // Prefer a stored, stable portrait source (mirrors chat-portrait's approach)
  const stored = cpGetStoredPortraitSrc(message);
  if (stored) return stored;

  const useToken = !!cpGet(CP.USE_TOKEN);
  const actor = feGetSpeakerActorFromMessage(message);
  const speaker = message?.speaker;

  if (useToken) {
    const tokenDoc = cpGetTokenDocFromSpeaker(speaker);
    const tokenSrc = tokenDoc?.texture?.src || tokenDoc?.img;
    if (tokenSrc) return tokenSrc;

    // Prototype token fallback
    const proto = actor?.prototypeToken;
    const protoSrc = proto?.texture?.src || proto?.img;
    if (protoSrc) return protoSrc;
  }

  const actorSrc = actor?.img;
  if (actorSrc) return actorSrc;

  // As a last resort, show the message author's avatar
  const user = message?.author ?? game?.users?.get?.(message?.user?.id);
  return user?.avatar || "icons/svg/mystery-man.svg";
}

function cpGetPortraitAlt(message) {
  const actor = feGetSpeakerActorFromMessage(message);
  if (actor?.name) return actor.name;
  return message?.speaker?.alias ?? "portrait";
}

function cpRemovePortrait(messageEl) {
  messageEl?.classList?.remove?.("fe-has-chat-portrait");
  // Clean both the legacy wrapper-based injection (<=0.3.49) and the current direct <img> injection.
  try {
    messageEl?.querySelectorAll?.("img.fe-chat-portrait")?.forEach?.((n) => n?.remove?.());
  } catch {
    /* no-op */
  }
  messageEl?.querySelector?.(".fe-chat-portrait-wrap")?.remove?.();
}

function cpIsDfChatEnhancementsMerged(messageEl) {
  try {
    const cl = messageEl?.classList;
    return cl?.contains?.("dfce-cm-middle") || cl?.contains?.("dfce-cm-bottom");
  } catch {
    return false;
  }
}

function cpLooksLikeRoundMarkerFlavor(flavor = "", content = "") {
  try {
    const f = String(flavor ?? "").replace(/\s+/g, " ").trim();
    if (f && /^(?:round\s*(?:start|end|\d+)|start of round|end of round|combat\s*round\s*\d+|라운드\s*(?:시작|종료|끝|\d+)|전투\s*라운드\s*\d+)/i.test(f)) return true;
  } catch {
    /* no-op */
  }

  try {
    const c = String(content ?? "");
    if (/<[^>]*\bround-marker\b/i.test(c)) return true;
  } catch {
    /* no-op */
  }

  return false;
}

function cpGetRoundMarkerFlagValue(source) {
  try {
    const flags = source?.flags ?? source ?? {};
    for (const ns of ["monks-combat-details", "monks-little-details", MODULE_ID]) {
      const data = flags?.[ns];
      if (!data || typeof data !== "object") continue;
      for (const [key, value] of Object.entries(data)) {
        if (!/round[-_ ]?(?:marker|message)|combat[-_ ]?round/i.test(String(key))) continue;
        if (value === true || String(value) === "true") return true;
        if (value && typeof value !== "object") return value;
      }
    }
  } catch {
    /* no-op */
  }
  return null;
}

function cpIsRoundMarkerMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("round-marker") || messageEl?.classList?.contains?.("fe-round-marker-chat")) return true;
  } catch {
    /* ignore */
  }

  try {
    const flag = cpGetRoundMarkerFlagValue(message);
    if (flag === true || String(flag) === "true") return true;
  } catch {
    /* ignore */
  }

  try {
    // Several modules render a .round-marker element inside the message content.
    if (messageEl?.querySelector?.(".message-content .round-marker, .round-marker")) return true;
  } catch {
    /* ignore */
  }

  try {
    const content = String(message?.content ?? "");
    if (/\bround-marker\b/i.test(content)) return true;
    if (cpLooksLikeRoundMarkerFlavor(message?.flavor ?? "", content)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function cpIsNarratorToolsMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("narrator-chat")) return true;
    if (messageEl?.classList?.contains?.("fe-narrator-chat")) return true;
  } catch {}

  // female_edition native narrator (fe-narrator.js) — canonical flag, more robust
  // than the alias fallback below.
  try {
    if (message?.getFlag?.("female_edition", "isNarrator")) return true;
  } catch {}

  try {
    if (message?.getFlag?.("narrator-tools", "type")) return true;
  } catch {}

  try {
    if (message?.flags?.["narrator-tools"]) return true;
  } catch {}

  // Fallback: if the speaker alias is literally "Narrator" / "내레이터".
  // (Avoid hard-coding beyond these two common labels.)
  try {
    const alias = String(message?.speaker?.alias ?? "").trim();
    if (!alias) return false;
    return alias === "Narrator" || alias === "내레이터";
  } catch {
    return false;
  }
}

function cpHideHeaderForSpecial(messageEl) {
  try {
    if (!messageEl) return;
    // Prefer the real message header (direct child) so we don't hide nested chat-card headers.
    const header = messageEl.querySelector?.(":scope > .message-header") || messageEl.querySelector?.(".message-header");
    if (!header) return;
    header.style.setProperty("display", "none", "important");
    header.setAttribute?.("aria-hidden", "true");
  } catch {
    /* no-op */
  }
}


function cpRestoreHeaderForSpecial(messageEl) {
  try {
    if (!messageEl) return;
    const header = messageEl.querySelector?.(":scope > .message-header") || messageEl.querySelector?.(".message-header");
    if (!header) return;
    header.style.removeProperty?.("display");
    header.style.removeProperty?.("visibility");
    header.removeAttribute?.("aria-hidden");
    if (String(header.getAttribute?.("style") || "").trim() === "") header.removeAttribute?.("style");
  } catch {
    /* no-op */
  }
}

function cpFindMessageHeader(messageEl) {
  if (!messageEl) return null;

  // Prefer direct children for correctness (avoid selecting nested headers inside chat cards).
  try {
    for (const child of Array.from(messageEl.children ?? [])) {
      if (child?.classList?.contains?.("message-header")) return child;
    }
  } catch {
    /* ignore */
  }

  // Fallback: any descendant
  try {
    const any = messageEl.querySelector?.(".message-header");
    if (any) return any;
  } catch {
    /* ignore */
  }

  // Last resort: some system cards can omit the base message header.
  try {
    const cardHeader = messageEl.querySelector?.(".card-header");
    if (cardHeader) return cardHeader;
  } catch {
    /* ignore */
  }
  return null;
}

function cpApplyChatCardIconSizing(messageEl) {
  try {
    if (!messageEl?.querySelectorAll) return;
    const size = Math.max(0, Number(cpGet(CP.CARD_ICON_SIZE) ?? 36) || 0);
    if (!size) return;

    // If this is an explicit image-post style message, don't touch its images.
    if (messageEl.querySelector?.(".message-content .chat-images-container img, .message-content .ci-message-image img")) return;

    const cards = messageEl.querySelectorAll(
      ".message-content .chat-card, .message-content .midi-chat-card, .message-content .dnd5e2.chat-card, .message-content .dnd5e.chat-card"
    );

    for (const card of cards ?? []) {
      if (!cpIsElement(card)) continue;

      const directChildImg = (() => {
        try {
          for (const ch of Array.from(card.children ?? [])) {
            if (cpIsImageElement(ch)) return ch;
          }
        } catch {
          /* ignore */
        }
        return null;
      })();

      // Prefer the standard dnd5e icon location.
      const icon =
        card.querySelector("header.card-header img") ||
        card.querySelector(".card-header img") ||
        directChildImg ||
        null;

      if (!cpIsImageElement(icon)) continue;

      // Avoid resizing our own injected chat header portrait.
      if (icon.classList.contains("fe-chat-portrait")) continue;

      icon.width = size;
      icon.height = size;
      icon.style.setProperty("width", `${size}px`, "important");
      icon.style.setProperty("height", `${size}px`, "important");
      icon.style.setProperty("flex", `0 0 ${size}px`, "important");
      icon.style.setProperty("object-fit", "cover", "important");
      // Some themes apply a background to inline <img> icons; keep it transparent.
      icon.style.setProperty("background-color", "transparent", "important");
      icon.style.setProperty("image-rendering", "auto", "important");
      // Prefer "smooth" if supported.
      icon.style.setProperty("image-rendering", "smooth", "important");
      icon.classList.add("fe-chat-card-icon");
    }

    // Some automation modules (monks-tokenbar, midi-qol, etc.) embed large portrait-like
    // images directly inside message content without using the standard chat-card classes.
    // Clamp abnormally large inline images so chat layout remains consistent.
    cpClampLargeInlinePortraits(messageEl, size);
  } catch {
    /* no-op */
  }
}

function cpClampLargeInlinePortraits(messageEl, size) {
  try {
    if (!messageEl?.querySelectorAll) return;
    if (!size) return;

    // If this is an explicit image-post style message, don't touch its images.
    if (messageEl.querySelector?.(".message-content .chat-images-container img, .message-content .ci-message-image img")) return;

    const forceClamp = !!messageEl.querySelector?.(
      ".message-content .monks-tokenbar, .message-content [class*=\"midi-qol\"], .message-content .midi-qol"
    );
    const threshold = Math.max(size * 2, size + 32);

    for (const img of messageEl.querySelectorAll(".message-content img")) {
      if (!cpIsImageElement(img)) continue;

      // Skip our own portraits and already-sized chat-card icons.
      if (img.classList.contains("fe-chat-portrait") || img.classList.contains("fe-chat-card-icon")) continue;

      // Skip dice UI images/tooltips.
      if (img.closest?.(".dice-roll, .dice-tooltip, .dice-result")) continue;

      const wAttr = Number(img.getAttribute?.("width") || 0);
      const hAttr = Number(img.getAttribute?.("height") || 0);
      const sw = Number.parseFloat(String(img.style?.width || "")) || 0;
      const sh = Number.parseFloat(String(img.style?.height || "")) || 0;
      const looksLarge =
        (wAttr && wAttr >= threshold) ||
        (hAttr && hAttr >= threshold) ||
        (sw && sw >= threshold) ||
        (sh && sh >= threshold);

      if (!forceClamp && !looksLarge) continue;

      // Clamp to the configured chat-card icon size.
      img.style.setProperty("width", `${size}px`, "important");
      img.style.setProperty("height", `${size}px`, "important");
      img.style.setProperty("max-width", `${size}px`, "important");
      img.style.setProperty("max-height", `${size}px`, "important");
      img.style.setProperty("flex", `0 0 ${size}px`, "important");
      img.style.setProperty("object-fit", "cover", "important");
      img.style.setProperty("image-rendering", "auto", "important");
      img.style.setProperty("image-rendering", "smooth", "important");
    }
  } catch {
    /* no-op */
  }
}


function cpPickActorOwnerColor(actor) {
  try {
    if (!actor || !game?.users) return null;
    const users = Array.isArray(game.users) ? game.users : game.users.contents ?? [];

    const canOwn = (u) => {
      try {
        if (typeof actor.testUserPermission === "function") return actor.testUserPermission(u, "OWNER");
        const lvl = actor.ownership?.[u.id] ?? 0;
        const ownerLvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
        return lvl >= ownerLvl;
      } catch {
        return false;
      }
    };

    const owners = users.filter((u) => canOwn(u));
    if (!owners.length) return null;

    const pick =
      owners.find((u) => !u.isGM && u.active) ||
      owners.find((u) => !u.isGM) ||
      owners.find((u) => u.active) ||
      owners[0] ||
      null;

    return pick?.color ? String(pick.color) : null;
  } catch {
    return null;
  }
}

function cpIsSafeCanvasSource(src) {
  try {
    if (!src) return false;
    const s = String(src);
    // Already processed or ephemeral.
    if (s.startsWith("data:") || s.startsWith("blob:")) return false;
    // SVG portraits are better left untouched (rasterization quality differs and can be inconsistent).
    if (/\.svg(\?.*)?$/i.test(s)) return false;

    const url = new URL(s, window.location.href);
    return url.origin === window.location.origin;
  } catch {
    // If URL parsing fails, assume it's a relative/local path.
    return true;
  }
}

async function cpWaitForImage(img) {
  try {
    if (!img) return false;
    if (img.complete && img.naturalWidth > 0) return true;

    if (typeof img.decode === "function") {
      try {
        await img.decode();
        if (img.complete && img.naturalWidth > 0) return true;
      } catch {
        // fall back to onload
      }
    }

    await new Promise((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        resolve(true);
      };
      const onErr = () => {
        cleanup();
        reject(new Error("image load failed"));
      };
      const cleanup = () => {
        img.removeEventListener?.("load", onLoad);
        img.removeEventListener?.("error", onErr);
      };
      img.addEventListener?.("load", onLoad, { once: true });
      img.addEventListener?.("error", onErr, { once: true });
    });
    return img.complete && img.naturalWidth > 0;
  } catch {
    return false;
  }
}

function cpComputeDrawRect({
  srcW,
  srcH,
  dstSize,
  fit = "cover", // "cover" | "contain"
}) {
  const w = Math.max(1, Number(srcW) || 1);
  const h = Math.max(1, Number(srcH) || 1);
  const s = Math.max(1, Number(dstSize) || 1);

  const scale = fit === "contain" ? Math.min(s / w, s / h) : Math.max(s / w, s / h);
  const dw = w * scale;
  const dh = h * scale;
  // For "contain" mode, keep the artwork left-aligned so any empty space remains
  // on the right only (user-requested behavior). Vertical centering is preserved.
  const dx = fit === "contain" ? 0 : (s - dw) / 2;
  const dy = (s - dh) / 2;
  return { dx, dy, dw, dh };
}

function cpComputeSourceCrop({ srcW, srcH, fit = "cover" }) {
  // Compute a source rectangle (sx,sy,sw,sh) for drawing into a square destination.
  // - cover: crop to a centered square
  // - contain: use full image
  const w = Math.max(1, Number(srcW) || 1);
  const h = Math.max(1, Number(srcH) || 1);

  if (fit === "contain") return { sx: 0, sy: 0, sw: w, sh: h };

  // cover: crop to square by taking the min dimension
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  return { sx, sy, sw: side, sh: side };
}

function cpDownscaleCanvasStep(srcCanvas, dstW, dstH) {
  const next = document.createElement("canvas");
  next.width = dstW;
  next.height = dstH;
  const ctx = next.getContext("2d");
  if (!ctx) return next;
  ctx.imageSmoothingEnabled = true;
  try {
    ctx.imageSmoothingQuality = "high";
  } catch {
    /* ignore */
  }
  ctx.drawImage(srcCanvas, 0, 0, srcCanvas.width, srcCanvas.height, 0, 0, dstW, dstH);
  return next;
}

async function cpResampleToDataURL(img, size, fit) {
  const ok = await cpWaitForImage(img);
  if (!ok) return null;

  const nw = Number(img.naturalWidth || 0);
  const nh = Number(img.naturalHeight || 0);
  if (!nw || !nh) return null;

  // Resample to DEVICE pixels, not CSS px. The <img> displays at `size` CSS px,
  // so a bitmap at size×dpr maps 1:1 to device pixels → crisp on HiDPI (dpr>1)
  // instead of being upscaled (soft). At dpr=1 this is identical to `size`.
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const target = Math.max(1, Math.round(size * dpr));

  // Only resample when we are actually downscaling.
  if (nw <= target && nh <= target) return null;

  try {
    // Multi-step downscale for better quality (especially from very large portraits).
    // Step 1: crop (cover) or keep full (contain) into a working canvas.
    const { sx, sy, sw, sh } = cpComputeSourceCrop({ srcW: nw, srcH: nh, fit });

    let work = document.createElement("canvas");
    work.width = Math.max(1, Math.floor(sw));
    work.height = Math.max(1, Math.floor(sh));
    let wctx = work.getContext("2d");
    if (!wctx) return null;
    wctx.imageSmoothingEnabled = true;
    try {
      wctx.imageSmoothingQuality = "high";
    } catch {
      /* ignore */
    }
    wctx.drawImage(img, sx, sy, sw, sh, 0, 0, work.width, work.height);

    // Step 2: repeatedly half until close to target.
    while (work.width / 2 > target) {
      const nextW = Math.max(target, Math.floor(work.width / 2));
      const nextH = Math.max(target, Math.floor(work.height / 2));
      work = cpDownscaleCanvasStep(work, nextW, nextH);
    }

    // Step 3: final draw into a square destination canvas (device-pixel sized).
    const out = document.createElement("canvas");
    out.width = target;
    out.height = target;
    const octx = out.getContext("2d");
    if (!octx) return null;
    octx.imageSmoothingEnabled = true;
    try {
      octx.imageSmoothingQuality = "high";
    } catch {
      /* ignore */
    }

    const { dx, dy, dw, dh } = cpComputeDrawRect({ srcW: sw, srcH: sh, dstSize: target, fit });
    octx.clearRect(0, 0, target, target);
    octx.drawImage(work, 0, 0, work.width, work.height, dx, dy, dw, dh);

    return out.toDataURL("image/png");
  } catch {
    // Tainted canvas or unsupported draw.
    return null;
  }
}

function cpMaybeApplyHQResample(img, size, shape) {
  try {
    if (!cpIsImageElement(img)) return;
    if (!size || size <= 0) return;
    if (size > 256) return; // sanity cap
    if (!cpShouldUseHQResample(img)) return;

    const origSrc = img.dataset?.fePortraitOrigSrc;
    const key = img.dataset?.fePortraitResampleKey;
    if (!origSrc || !key) return;
    if (!cpIsSafeCanvasSource(origSrc)) return;

    const cached = cpResampleCacheGet(key);
    if (cached) {
      if (img.src !== cached) img.src = cached;
      return;
    }

    if (_cpResampleInflight.has(key)) return;

    const fit = String(shape) === "none" ? "contain" : "cover";

    const p = (async () => {
      const dataUrl = await cpResampleToDataURL(img, size, fit);
      return dataUrl;
    })();

    _cpResampleInflight.set(key, p);

    p.then((dataUrl) => {
      _cpResampleInflight.delete(key);
      if (!dataUrl) return;
      cpResampleCacheSet(key, dataUrl);
      // Only apply if this image still refers to the same request.
      if (img.dataset?.fePortraitResampleKey === key) {
        img.src = dataUrl;
      }
    }).catch(() => {
      _cpResampleInflight.delete(key);
    });
  } catch {
    /* no-op */
  }
}

function cpShouldUseHQResample(img) {
  try {
    const body = img?.ownerDocument?.body;
    if (!body?.classList) return true;

    // Keep print/PDF documents on the original sources to avoid a large number of
    // extra data: URLs during final export.
    if (body.classList.contains("fe-print-chatlog")) return false;

    // Archive windows benefit from one-time high-quality resampling, especially for
    // low-resolution PC portraits. Repeated portraits still share a cached result.
    if (body.classList.contains("fe-chat-archive")) return true;
  } catch {
    /* fall through */
  }
  return true;
}


/**
 * Apply size/shape/border/quality styles to a portrait <img>.
 * Shared by chat-message portraits and combat-tracker portraits.
 * @param {HTMLImageElement} img
 * @param {{ size, shape, borderMode, borderWidth, borderColor, color }} opts
 *   color — pre-resolved border color (user/actor color, or fallback)
 */
function cpApplyImgStyling(img, { size, shape, borderMode, borderWidth, borderColor, color = null }) {
  try {
    img.width = size;
    img.height = size;
    img.style.setProperty("width",  `${size}px`, "important");
    img.style.setProperty("height", `${size}px`, "important");
    img.style.setProperty("flex",   `0 0 ${size}px`, "important");
  } catch {}

  if (shape === "none") {
    img.style.setProperty("border-radius",   "0",            "important");
    img.style.setProperty("object-fit",      "contain",      "important");
    img.style.setProperty("object-position", "left center",  "important");
    img.style.setProperty("border",          "none",         "important");
    img.style.setProperty("clip-path",       "none",         "important");
  } else {
    img.style.setProperty("border-radius",   shape === "square" ? "0" : "50%", "important");
    img.style.setProperty("object-fit",      "cover",         "important");
    img.style.setProperty("object-position", "center center", "important");
    img.style.setProperty("clip-path",
      shape === "circle" ? "circle(50% at 50% 50%)" : "none", "important");
  }

  img.style.setProperty("display",          "block",  "important");
  img.style.setProperty("image-rendering",  "auto",   "important");
  img.style.setProperty("image-rendering",  "smooth", "important");

  // Border (only when shape is not "none")
  if (shape === "none") return;
  if (borderMode === "theme") { img.style.removeProperty("border"); return; }
  if (borderMode === "none")  { img.style.setProperty("border", "none", "important"); return; }

  const resolvedColor = color || borderColor || "#000000";
  img.style.setProperty("border", `${borderWidth}px solid ${resolvedColor}`, "important");
}


function cpApplyPortraitStyling(message, img, { size: sizeHint, shape: shapeHint } = {}) {
  try {
    if (!cpIsImageElement(img)) return;

    // Accept pre-read values from cpUpsertPortrait to avoid a second settings read per message.
    const size       = sizeHint  != null ? sizeHint  : Math.max(16, Number(cpGet(CP.SIZE)) || 64);
    const shape      = shapeHint != null ? shapeHint : String(cpGet(CP.SHAPE) ?? "circle");
    const borderMode = String(cpGet(CP.BORDER_MODE) ?? "theme");
    const borderWidth = Math.max(0, Number(cpGet(CP.BORDER_WIDTH) ?? 2) || 0);
    const borderColor = String(cpGet(CP.BORDER_COLOR) ?? "#000000");

    let color = borderColor;
    if (borderMode === "user") {
      const msgColor = feGetMessageUserColor?.(message);
      color = msgColor || borderColor;
    }

    cpApplyImgStyling(img, { size, shape, borderMode, borderWidth, borderColor, color });

    // Attempt high-quality resample (safe no-op for cross-origin images).
    cpMaybeApplyHQResample(img, size, shape);
  } catch {
    /* no-op */
  }
}


function cpApplyCombatPortraitStyling(combatant, img) {
  try {
    if (!cpIsImageElement(img)) return;

    const size       = Math.max(16, Number(cpGet(CP.SIZE)) || 64);
    const shape      = String(cpGet(CP.SHAPE) ?? "circle");
    const borderMode = String(cpGet(CP.BORDER_MODE) ?? "theme");
    const borderWidth = Math.max(0, Number(cpGet(CP.BORDER_WIDTH) ?? 2) || 0);
    const borderColor = String(cpGet(CP.BORDER_COLOR) ?? "#000000");

    let color = borderColor;
    if (borderMode === "user") {
      const actorColor = cpPickActorOwnerColor(combatant?.actor);
      color = actorColor || borderColor;
    }

    cpApplyImgStyling(img, { size, shape, borderMode, borderWidth, borderColor, color });

    // Seed HQ-resample cache key (combat tracker images don't go through cpUpsertPortrait).
    try {
      const candidate = img.dataset?.fePortraitOrigSrc || img.currentSrc || img.getAttribute?.("src") || img.src || "";
      const isData = String(candidate).startsWith("data:") || String(candidate).startsWith("blob:");
      if (candidate && !isData) {
        if (!img.dataset.fePortraitOrigSrc) img.dataset.fePortraitOrigSrc = String(candidate);
        const fit = shape === "none" ? "contain" : "cover";
        const key = `${img.dataset.fePortraitOrigSrc}@@${size}@@${fit}`;
        img.dataset.fePortraitResampleKey = key;
        const cached = cpResampleCacheGet(key);
        if (cached && img.src !== cached) img.src = cached;
      }
    } catch {}

    cpMaybeApplyHQResample(img, size, shape);
  } catch {
    /* no-op */
  }
}


function cpLocalize(key, fallback = "") {
  try {
    const s = game?.i18n?.localize?.(key);
    if (s && s !== key) return String(s);
  } catch {
    /* ignore */
  }
  return String(fallback ?? "");
}

function cpEnsureSenderText(message, messageEl, headerEl) {
  try {
    // Narrator Tools messages must NOT show header/name/portrait.
    if (cpIsNarratorToolsMessage(message, messageEl)) return;

    if (!messageEl || !headerEl) return;
    const doc = messageEl.ownerDocument ?? document;

    const sender = headerEl.querySelector?.(".message-sender");
    if (!sender) return;

    const actor = feGetSpeakerActorFromMessage?.(message);
    const actorName = actor?.name ? String(actor.name).trim() : "";
    const speakerAlias = message?.speaker?.alias ? String(message.speaker.alias).trim() : "";
    const authorName = message?.author?.name ? String(message.author.name).trim() : "";

    const unknownLabel = cpLocalize("CHAT.Unknown", "Unknown");

    const title = actorName || speakerAlias || authorName || unknownLabel;
    const subtitle = authorName && authorName !== title ? authorName : "";

    const existingWrap = sender.querySelector?.(":scope .name-stacked");
    const existingTitle = sender.querySelector?.(":scope .title")?.textContent?.trim?.() ?? "";
    const existingSubtitle = sender.querySelector?.(":scope .subtitle")?.textContent?.trim?.() ?? "";
    const existingText = sender.textContent?.trim?.() ?? "";

    // If structured title/subtitle already exists, keep it.
    if (existingWrap && (existingTitle || existingSubtitle)) return;

    // Normalize plain-text senders into the same stacked markup used elsewhere so
    // archive/live rendering stays consistent (actor title + optional player subtitle).
    // Only rewrite when the sender is empty or effectively plain text.
    const hasComplexChildren = Array.from(sender.children ?? []).some((el) => {
      const cl = el?.classList;
      return !(cl?.contains?.("name-stacked") || cl?.contains?.("title") || cl?.contains?.("subtitle"));
    });
    if (hasComplexChildren) return;

    const resolvedTitle = title || existingText || unknownLabel;
    const resolvedSubtitle = subtitle && subtitle !== resolvedTitle ? subtitle : "";

    sender.textContent = "";
    const wrap = doc.createElement("span");
    wrap.className = "name-stacked";

    const titleEl = doc.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = resolvedTitle;
    wrap.appendChild(titleEl);

    if (resolvedSubtitle) {
      const subEl = doc.createElement("span");
      subEl.className = "subtitle";
      subEl.textContent = resolvedSubtitle;
      wrap.appendChild(subEl);
    }

    sender.appendChild(wrap);
  } catch {
    /* no-op */
  }
}


function cpUpsertPortrait(message, messageEl) {
  if (!messageEl) return;

  // Restrict to the actual chat message element.
  if (!messageEl.matches?.("li.chat-message, #chat-notifications .message")) {
    const closest = messageEl.closest?.("li.chat-message, #chat-notifications .message");
    if (closest) messageEl = closest;
  }

  // Narrator/round-marker style system messages must have NO portrait modifications.
  // Narrator messages hide the base header entirely; round-marker messages keep their original
  // header because, for several modules, the header *is* the marker UI.
  const isNarratorSpecial = cpIsNarratorToolsMessage(message, messageEl);
  const isRoundMarkerSpecial = cpIsRoundMarkerMessage(message, messageEl);
  if (isNarratorSpecial || isRoundMarkerSpecial) {
    cpRemovePortrait(messageEl);
    messageEl.classList.toggle("fe-narrator-chat", isNarratorSpecial);
    messageEl.classList.toggle("fe-round-marker-chat", isRoundMarkerSpecial);
    if (isNarratorSpecial) cpHideHeaderForSpecial(messageEl);
    else cpRestoreHeaderForSpecial(messageEl);
    return;
  }

  cpRestoreHeaderForSpecial(messageEl);

  // Coexistence policy: allow duplicates, warn once (no hard-block).
  cpWarnIfChatPortraitModuleActive();

  if (!cpGet(CP.ENABLED)) {
    cpRemovePortrait(messageEl);
    return;
  }

  const kind = cpGetMessageKind(messageEl, message);
  if (!cpIsKindAllowed(kind)) {
    cpRemovePortrait(messageEl);
    return;
  }

  // Respect FE's chat-merge follow-up behavior (match chat-portrait expectations)
  if (!cpShouldRenderPortraitForMessageElement(messageEl)) {
    cpRemovePortrait(messageEl);
    return;
  }

  // Compatibility: skip known merged-message variants from other modules.
  // cpIsRoundMarkerMessage was already evaluated above (isRoundMarkerSpecial); do not call again.
  if (cpIsDfChatEnhancementsMerged(messageEl)) {
    cpRemovePortrait(messageEl);
    return;
  }

  const header = cpFindMessageHeader(messageEl);
  if (!header) return;

  // Narrator Tools and some automation modules can render an empty sender block.
  // Ensure the name(s) are present so the header doesn't look blank.
  cpEnsureSenderText(message, messageEl, header);

  // If another portrait module (e.g. chat-portrait) already injected a portrait into the
  // message header and we don't already have ours, avoid duplicating portraits.
  try {
    const hasOur = !!header.querySelector?.("img.fe-chat-portrait");
    const hasOther = !!header.querySelector?.(
      'img[class*="chat-portrait-message-portrait"], img.chat-portrait-message-portrait, .chat-portrait-container'
    );
    if (!hasOur && hasOther) return;
  } catch {}

  // Add predictable classes so CSS can align header layout similarly to chat-portrait.
  let portraitSystemId = "generic";
  try {
    portraitSystemId = String(game?.system?.id || "generic");
    header.classList.add("fe-chat-portrait-message-header", "chat-portrait-message-header");
    if (portraitSystemId) {
      header.classList.add(`fe-chat-portrait-message-header-${portraitSystemId}`);
      header.classList.add(`chat-portrait-message-header-${portraitSystemId}`);
    }

    const sender = header.querySelector?.(".message-sender");
    if (sender?.classList) {
      sender.classList.add(`chat-portrait-text-size-name-${portraitSystemId}`);
      sender.classList.add(`chat-portrait-text-header-name-${portraitSystemId}`);
      sender.style?.setProperty?.("align-self", "center", "important");
    }

    const metadata = header.querySelector?.(".message-metadata");
    metadata?.style?.setProperty?.("position", "static", "important");
  } catch {}

  const src = cpGetPortraitSrc(message);
  if (!src) return;

  // IMPORTANT: Support insertion into non-main documents (e.g. chat archive export window).
  // Always create elements using the message element's ownerDocument.
  const doc = messageEl.ownerDocument ?? document;

  // Remove legacy wrapper injection if present.
  try {
    header.querySelector?.(".fe-chat-portrait-wrap")?.remove?.();
  } catch {}

  let img = header.querySelector?.("img.fe-chat-portrait");
  if (!img) {
    img = doc.createElement("img");
    img.className = "fe-chat-portrait";
    img.loading = "lazy";
    img.decoding = "async";
    header.prepend(img);
  }

  try {
    img.classList.add("chat-portrait-message-portrait");
    if (portraitSystemId) img.classList.add(`chat-portrait-message-portrait-${portraitSystemId}`);
  } catch {}

  // Keep a stable reference to the original resource.
  // If we already have a HQ-resampled data URL for this exact request, keep using it.
  const size = Math.max(16, Number(cpGet(CP.SIZE) ?? 64) || 64);
  const shape = String(cpGet(CP.SHAPE) ?? "circle");
  const fit = shape === "none" ? "contain" : "cover";
  const key = `${src}@@${size}@@${fit}`;

  const allowHQResample = cpShouldUseHQResample(img);
  const cached = allowHQResample ? cpResampleCacheGet(key) : null;
  const prevKey = img.dataset?.fePortraitResampleKey;
  const prevOrig = img.dataset?.fePortraitOrigSrc;

  if (prevKey !== key || prevOrig !== src) {
    img.dataset.fePortraitOrigSrc = src;
    img.dataset.fePortraitResampleKey = key;
    img.src = cached || src;
  } else {
    // Same request; only swap to cache if it arrived since the last render.
    if (cached && img.src !== cached) img.src = cached;
    else if (!allowHQResample && img.src !== src) img.src = src;
  }

  img.alt = cpGetPortraitAlt(message);
  img.title = img.alt;

  cpApplyPortraitStyling(message, img, { size, shape });

  // Resize common dnd5e/midi chat-card icons to avoid huge portraits inside message content.
  cpApplyChatCardIconSizing(messageEl);

  messageEl.classList.add("fe-has-chat-portrait");
}

function cpApplyVarsToDocument(doc) {
  // Delegates to cpSetRootVars which performs the same work with doc normalization.
  cpSetRootVars(doc);
}

function cpRefreshMessagesInRoot(rootLike = document) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root?.querySelectorAll) return;

    const messages = root.matches?.("li.chat-message")
      ? [root]
      : root.querySelectorAll("li.chat-message");

    for (const li of messages) {
      const id = li?.dataset?.messageId || li?.dataset?.documentId || li?.getAttribute?.("data-message-id") || li?.getAttribute?.("data-document-id");
      const msg = id ? game.messages?.get(id) : null;
      if (!msg) {
        // Older messages rehydrated by Foundry/chat-log-prune may no longer have a live ChatMessage
        // document in game.messages. Round-marker system messages still need their portrait/header
        // cleanup to run, but plain messages should be left untouched.
        const isRoundMarker = li?.classList?.contains?.("round-marker") || li?.classList?.contains?.("fe-round-marker-chat") || !!li?.querySelector?.(".round-marker");
        if (isRoundMarker) {
          cpRemovePortrait(li);
          li.classList.add("fe-round-marker-chat");
          cpRestoreHeaderForSpecial(li);
        }
        continue;
      }
      cpUpsertPortrait(msg, li);
    }
  } catch {}
}

function cpRefreshAllChatMessages() {
  cpWarnIfChatPortraitModuleActive();

  for (const logEl of feGetChatLogs()) {
    if (!cpIsElement(logEl)) continue;
    cpRefreshMessagesInRoot(logEl);
  }
}

function cpScheduleRefreshMessagesInRoot(rootLike = document, { delay = 24 } = {}) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root) return;
    const existing = _cpRefreshRootTimers.get(root);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      try { cpRefreshMessagesInRoot(root); } catch {}
      finally {
        const cur = _cpRefreshRootTimers.get(root);
        if (cur === t) _cpRefreshRootTimers.delete(root);
      }
    }, Math.max(0, Number(delay) || 0));
    _cpRefreshRootTimers.set(root, t);
  } catch {}
}

function cpScheduleRefreshAllChatMessages({ delay = 24 } = {}) {
  try {
    if (_cpRefreshAllTimer) clearTimeout(_cpRefreshAllTimer);
    _cpRefreshAllTimer = setTimeout(() => {
      _cpRefreshAllTimer = null;
      cpRefreshAllChatMessages();
    }, Math.max(0, Number(delay) || 0));
  } catch {}
}

// -------------------------------------
// Exports for other feature modules (e.g. chat archive export)
// -------------------------------------

/**
 * Upsert a chat portrait into a given chat message element.
 * Safe to call on nodes living in other documents (e.g. archive window).
 */
export function feChatPortraitUpsert(message, messageEl) {
  cpUpsertPortrait(message, messageEl);
}

/** Apply chat portrait CSS vars/classes to a specific document. */
export function feChatPortraitApplyVars(doc = document) {
  cpApplyVarsToDocument(doc);
}

function cpApplyCombatTrackerPortraits(html) {
  cpWarnIfChatPortraitModuleActive();
  const root = html?.querySelector ? html : document;
  const combat = root.querySelector?.("#combat") ?? root.querySelector?.(".combat-tracker");
  if (!combat) return;

  const enabled = !!cpGet(CP.ENABLED);
  const applyCombat = enabled && !!cpGet(CP.APPLY_COMBAT);

  // If feature is off, clean up any previously injected portraits/styling.
  if (!applyCombat) {
    try {
      const imgs = Array.from(combat.querySelectorAll?.("img.token-image.fe-combat-portrait") ?? []);
      for (const img of imgs) {
        try {
          img.classList.remove("fe-combat-portrait");
        } catch {}

        // Attempt to restore the default token image.
        try {
          const li = img.closest?.("li.combatant") ?? img.closest?.("li");
          const cid = li?.dataset?.combatantId;
          const combatant = cid ? game.combat?.combatants?.get(cid) : null;
          const tokenDoc = combatant?.token;
          const restore = tokenDoc?.texture?.src || tokenDoc?.img || combatant?.actor?.img;
          if (restore) img.src = restore;
        } catch {}

        try {
          img.style.removeProperty("width");
          img.style.removeProperty("height");
          img.style.removeProperty("flex");
          img.style.removeProperty("border-radius");
          img.style.removeProperty("object-fit");
          img.style.removeProperty("clip-path");
          img.style.removeProperty("display");
          img.style.removeProperty("image-rendering");
          img.style.removeProperty("border");
        } catch {}
      }
    } catch {}
    return;
  }

  const useToken = !!cpGet(CP.USE_TOKEN);

  for (const li of combat.querySelectorAll?.("li.combatant") ?? []) {
    const id = li?.dataset?.combatantId;
    const combatant = id ? game.combat?.combatants?.get(id) : null;
    if (!combatant) continue;

    const img = li.querySelector?.("img.token-image");
    if (!img) continue;

    let src = null;
    if (useToken) {
      // Token image: keep current, but prefer document texture if available.
      const tokenDoc = combatant.token;
      src = tokenDoc?.texture?.src || tokenDoc?.img || img.src;
    } else {
      src = combatant.actor?.img || img.src;
    }

    if (src) img.src = src;
    img.classList.add("fe-combat-portrait");
    cpApplyCombatPortraitStyling(combatant, img);
  }
}

function cpRegisterSettings() {
  game.settings.register(MODULE_ID, CP.ENABLED, {
    name: "채팅 포트레이트 사용",
    hint: "채팅 메시지 카드에 액터(또는 토큰) 이미지를 삽입합니다. (chat-portrait 모듈이 활성화되어 있으면 포트레이트가 중복될 수 있으며, 콘솔에 경고만 표시합니다.)",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      cpSetRootVars();
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.HIDE_WRAP, {
    name: "채팅 포트레이트(삽입) 숨김",
    hint: "이 모듈이 채팅 카드 헤더에 삽입하는 포트레이트(이미지)를 숨깁니다. 기존 '채팅 기본 포트레이트 숨김(내부/기본)' 옵션과 별개입니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => {
      cpSetRootVars();
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.USE_TOKEN, {
    name: "채팅 포트레이트에 토큰 이미지 사용",
    hint: "활성화 시 액터 포트레이트 대신 토큰 이미지를 사용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.SIZE, {
    name: "채팅 포트레이트 크기(px)",
    hint: "포트레이트 이미지의 가로/세로 크기(px)입니다.",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 16, max: 128, step: 1 },
    default: 64,
    onChange: () => {
      cpSetRootVars();
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.CARD_ICON_SIZE, {
    name: "채팅 카드 아이콘 크기(px)",
    hint: "midi-qol/dnd5e 채팅 카드 안의 큰 이미지(아이콘/포트레이트)가 과도하게 크게 보이는 경우를 방지하기 위해, 카드 헤더 이미지 크기를 강제로 조정합니다. 0으로 설정하면 비활성화됩니다.",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 0, max: 128, step: 1 },
    default: 36,
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });


  game.settings.register(MODULE_ID, CP.SHAPE, {
    name: "채팅 포트레이트 모양",
    hint: "포트레이트 모양/자르기 방식을 설정합니다. '미적용'은 보더/자르기 없이 크기만 조절합니다.",
    scope: "client",
    config: false,
    type: String,
    default: "none",
    choices: {
      circle: "원형",
      square: "사각형",
      none: "미적용(자르지 않음)",
    },
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_MODE, {
    name: "채팅 포트레이트 테두리(보더) 모드",
    hint: "포트레이트 이미지 테두리 스타일을 설정합니다. '테마/기본값'은 다른 테마/모듈의 스타일을 그대로 사용합니다.",
    scope: "client",
    config: false,
    type: String,
    default: "none",
    choices: {
      theme: "테마/기본값(변경 안 함)",
      none: "없음",
      user: "플레이어 색상",
      custom: "사용자 지정",
    },
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_WIDTH, {
    name: "채팅 포트레이트 테두리 두께(px)",
    hint: "테두리 모드가 '플레이어 색상' 또는 '사용자 지정'일 때 적용됩니다.",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 0, max: 12, step: 1 },
    default: 0,
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_COLOR, {
    name: "채팅 포트레이트 테두리 색상(HEX)",
    hint: "테두리 모드가 '사용자 지정'일 때 사용합니다. 예) #000000",
    scope: "client",
    config: false,
    type: String,
    default: "#000000",
    onChange: () => {
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.NAME_ALIGN, {
    name: "채팅 포트레이트 이름 정렬",
    hint: "헤더의 액터 이름/플레이어 이름을 가운데 정렬 또는 좌측 정렬로 표시합니다.",
    scope: "client",
    config: false,
    type: String,
    default: "left",
    choices: {
      center: "가운데 정렬",
      left: "좌측 정렬",
    },
    onChange: () => {
      cpSetRootVars();
      cpScheduleRefreshAllChatMessages({ delay: 0 });
      feFireChatUiUpdated({ reason: "portrait-settings", document });
    },
  });

  game.settings.register(MODULE_ID, CP.APPLY_COMBAT, {
    name: "컴뱃 트래커에 포트레이트 적용",
    hint: "컴뱃 트래커의 토큰 이미지에 동일한 규칙(토큰/포트레이트)을 적용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => feFireChatUiUpdated({ reason: "portrait-settings", document }),
  });

  // Message type filters
  const typeSetting = (key, name, def = true) =>
    game.settings.register(MODULE_ID, key, {
      name,
      scope: "client",
      config: false,
      type: Boolean,
      default: def,
      onChange: () => {
        cpScheduleRefreshAllChatMessages({ delay: 0 });
      },
    });

  typeSetting(CP.SHOW_IC, "포트레이트 표시: IC", true);
  typeSetting(CP.SHOW_OOC, "포트레이트 표시: OOC", true);
  typeSetting(CP.SHOW_EMOTE, "포트레이트 표시: EMOTE", true);
  typeSetting(CP.SHOW_WHISPER, "포트레이트 표시: WHISPER", true);
  typeSetting(CP.SHOW_ROLL, "포트레이트 표시: ROLL", true);
  typeSetting(CP.SHOW_OTHER, "포트레이트 표시: 기타", true);
}

Hooks.once("init", () => {
  cpRegisterSettings();
});

Hooks.once("ready", () => {
  cpSetRootVars();
  cpScheduleRefreshAllChatMessages({ delay: 0 });
});

// Store a stable portrait src on the message at creation time.
// This mirrors chat-portrait's behavior and improves long-term consistency
// (archives, renamed/deleted actors, etc.).
Hooks.on("preCreateChatMessage", (message, data) => {
  try {
    // Respect module enable, but it's harmless to store even if later hidden.
    if (!cpGet(CP.ENABLED)) return;

    // Avoid overwriting an existing stored portrait.
    const existing = cpGetStoredPortraitSrc(message) || data?.flags?.[MODULE_ID]?.[FE_FLAG_PORTRAIT_SRC];
    if (existing) return;

    const src = cpGetPortraitSrc(message);
    if (!src) return;
    cpSetStoredPortraitSrcOnPreCreate(message, src);
  } catch {
    /* no-op */
  }
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  cpUpsertPortrait(message, cpExtractChatMessageElement(html));
});

Hooks.on("renderChatLog", () => {
  // Portrait insertion is performed per-message via renderChatMessageHTML.
  // Keep this hook lightweight to avoid whole-log post-processing passes.
  cpSetRootVars();
});

Hooks.on("renderCombatTracker", (app, html) => {
  cpApplyCombatTrackerPortraits(html);
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
  try {
    const doc = payload?.document ?? payload?.root?.ownerDocument ?? document;
    cpSetRootVars(doc);

    // renderChatMessageHTML already upserts portraits one message at a time.
    // Avoid whole-root rescans on every chat-log render; reserve broad refreshes
    // for explicit UI/setting changes instead.
    if (payload?.reason === "renderChatLog") return;

    // Portrait settings already perform an immediate local refresh in their onChange handlers.
    // Do not refresh again here, or the same whole-log pass runs twice.
    if (payload?.reason === "portrait-settings") return;

    if (payload?.root && payload?.reason === "archive-render") cpScheduleRefreshMessagesInRoot(payload.root, { delay: 0 });
    else cpScheduleRefreshAllChatMessages({ delay: 0 });
  } catch {
    cpSetRootVars();
    cpScheduleRefreshAllChatMessages({ delay: 0 });
  }
});
