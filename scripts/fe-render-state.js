import {
  MODULE_ID, S,
  FE_RENDER_STATE_FLAG, FE_RENDER_SPECIAL_KIND_FLAG, FE_RENDER_MERGE_HINT_FLAG, FE_RENDER_STATE_VERSION,
} from "./fe-constants.js";
import {
  feExtractHTMLElement, feNormalizeChatMessageId,
  feGetMessageIdFromElement,
  feGetRoundMarkerFlagValue, feLooksLikeRoundMarkerFlavor,
  feIsSystemCombatNoticeContent, FE_SYSTEM_COMBAT_NOTICE_SELECTOR,
} from "./fe-util.js";
import { feSetting } from "./fe-gm-priority.js";

// -------------------------------------
// User color helpers
// -------------------------------------

function feParseHexColorToRgb(hex) {
  try {
    const s = String(hex || "").trim();
    if (!s) return null;
    const m = s.startsWith("#") ? s.slice(1) : s;
    if (m.length === 3) {
      const r = parseInt(m[0] + m[0], 16);
      const g = parseInt(m[1] + m[1], 16);
      const b = parseInt(m[2] + m[2], 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
      return null;
    }
    if (m.length === 6 || m.length === 8) {
      const r = parseInt(m.slice(0, 2), 16);
      const g = parseInt(m.slice(2, 4), 16);
      const b = parseInt(m.slice(4, 6), 16);
      if ([r, g, b].every((n) => Number.isFinite(n))) return { r, g, b };
      return null;
    }
    return null;
  } catch {
    return null;
  }
}

function feGetSpeakerActorFromMessage(message) {
  try {
    const speaker = message?.speaker ?? message?.data?.speaker ?? null;
    if (!speaker) return null;
    if (typeof ChatMessage?.getSpeakerActor === "function") return ChatMessage.getSpeakerActor(speaker);
    const actorId = speaker?.actor;
    return actorId ? game.actors?.get?.(actorId) ?? null : null;
  } catch {
    return null;
  }
}

function feGetSpeakerActorFromLike(message, data = {}) {
  try {
    const speaker = data?.speaker ?? message?.speaker ?? message?.data?.speaker ?? null;
    if (!speaker) return null;
    if (typeof ChatMessage?.getSpeakerActor === "function") return ChatMessage.getSpeakerActor(speaker);
    const actorId = speaker?.actor;
    return actorId ? game.actors?.get?.(actorId) ?? null : null;
  } catch {
    return null;
  }
}

function fePickActorOwnerUser(actor, preferredUser = null) {
  try {
    if (!actor || !game?.users) return null;
    const users = Array.isArray(game.users) ? game.users : game.users.contents ?? [];
    const ownerLvl = CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;

    // Color ownership must be explicit. actor.testUserPermission() also honors
    // default ownership, which can make every player resolve a GM/NPC card to
    // their own color on their own client.
    const explicitOwnerIds = Object.entries(actor.ownership ?? {})
      .filter(([uid, level]) => uid !== "default" && Number(level) >= ownerLvl)
      .map(([uid]) => uid);
    const explicitOwners = explicitOwnerIds
      .map((uid) => game.users?.get?.(uid) ?? users.find((u) => u?.id === uid) ?? null)
      .filter(Boolean);
    if (explicitOwners.length) {
      if (preferredUser?.id && explicitOwners.some((u) => u.id === preferredUser.id)) return preferredUser;
      return (
        explicitOwners.find((u) => !u.isGM && u.active) ||
        explicitOwners.find((u) => !u.isGM) ||
        explicitOwners.find((u) => u.active) ||
        explicitOwners[0] ||
        null
      );
    }

    const canOwn = (u) => {
      try {
        if (typeof actor.testUserPermission === "function") return actor.testUserPermission(u, "OWNER");
        const lvl = actor.ownership?.[u.id] ?? 0;
        return lvl >= ownerLvl;
      } catch {
        return false;
      }
    };

    const owners = preferredUser?.id && canOwn(preferredUser) ? [preferredUser] : [];
    if (!owners.length) return null;

    return owners[0] || null;
  } catch {
    return null;
  }
}

function feGetMessageUserColor(message) {
  try {
    const author = message?.author ?? (message?.user ? game.users?.get?.(message.user) : null);
    const actor = feGetSpeakerActorFromMessage(message);

    if (author?.color) {
      if (author.isGM) {
        // GM speaking as a player-owned character → that player's color.
        if (actor) {
          const owner = fePickActorOwnerUser(actor, null);
          if (owner?.color && !owner.isGM) return String(owner.color);
        }
        // GM NPC / narration / own chatter → no tint (don't flood the log with
        // the GM's personal color).
        return null;
      }
      return String(author.color);
    }

    const owner = actor ? fePickActorOwnerUser(actor, author && !author.isGM ? author : null) : null;
    if (owner?.color) return String(owner.color);
    return null;
  } catch {
    return null;
  }
}

function feGetActiveGmColor() {
  try {
    const gm = Array.from(game?.users ?? []).find((user) => user?.isGM && user?.active && user?.color);
    return gm?.color ? String(gm.color) : null;
  } catch {
    return null;
  }
}

function feGetMessageUserColorForData(message, data = {}, userId = null) {
  try {
    const actor = feGetSpeakerActorFromLike(message, data);
    const authorId = data?.user ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? userId ?? game?.user?.id ?? null;
    const author = authorId ? game?.users?.get?.(authorId) ?? null : null;

    if (author?.color) {
      if (author.isGM) {
        if (actor) {
          const owner = fePickActorOwnerUser(actor, null);
          if (owner?.color && !owner.isGM) return String(owner.color);
        }
        return null; // GM NPC / narration → no tint
      }
      return String(author.color);
    }

    const owner = actor ? fePickActorOwnerUser(actor, author && !author.isGM ? author : null) : null;
    if (owner?.color) return String(owner.color);
    return null;
  } catch {
    return null;
  }
}

// -------------------------------------
// Content classification helpers
// -------------------------------------

function feMessageHasChatCardContent(content, el = null) {
  try {
    const src = String(content ?? "");
    if (/class=["'][^"']*(?:\bchat-card\b|\bmidi-chat-card\b|\bdx3rd-item-chat\b|\bdx3rd-item-info\b)[^"']*["']/i.test(src)) return true;
    if (el?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info')) return true;
    return false;
  } catch {
    return false;
  }
}

function feMessageHasDiceCardContent(content, message = null, el = null) {
  try {
    const src = String(content ?? "");
    if (/class=["'][^"']*(?:\bdice-roll\b|\bdice-result\b|\bdice-formula\b|\bdice-tooltip\b)[^"']*["']/i.test(src)) return true;
    if (Array.isArray(message?.rolls) && message.rolls.length > 0) return true;
    if (el?.querySelector?.('.dice-roll, .dice-result, .dice-formula, .dice-tooltip')) return true;
    return false;
  } catch {
    return false;
  }
}

function feShouldMergeRollMessages() {
  try {
    return !!feSetting(S.MERGE_INCLUDE_ROLL_MESSAGES);
  } catch {
    return false;
  }
}

function feComputeMergeRuntimeBehavior({
  isNarrator = false,
  isRoundMarker = false,
  hasChatCard = false,
  hasDice = false,
  hasRolls = false,
} = {}) {
  const includeRollMessages = feShouldMergeRollMessages();
  const hasRollMessage = !!(hasDice || hasRolls);
  const mergeableText = !hasChatCard && (includeRollMessages || !hasRollMessage);
  const noMerge = !!isNarrator || !!isRoundMarker || !!hasChatCard || (!includeRollMessages && hasRollMessage);
  return { includeRollMessages, hasRollMessage, mergeableText, noMerge };
}

// -------------------------------------
// Render state storage
// -------------------------------------

const feMessageRenderStateOverrides = new Map();

function feComputeMessageRenderState(message, data = {}, userId = null) {
  try {
    const flags = data?.flags ?? message?.flags ?? {};
    const narrator = !!(
      flags?.["narrator-tools"] ||
      flags?.[MODULE_ID]?.isNarrator ||
      message?.getFlag?.("narrator-tools", "type")
    );
    const roundFlag = feGetRoundMarkerFlagValue(flags) ?? feGetRoundMarkerFlagValue(message);
    const content = String(data?.content ?? message?.content ?? "");
    const isRoundMarker = !!(
      flags?.[MODULE_ID]?.isRoundMarker ||
      roundFlag === true ||
      String(roundFlag) === "true" ||
      /\bround-marker\b/i.test(content) ||
      feIsSystemCombatNoticeContent(content)
    );

    const speaker = data?.speaker ?? message?.speaker ?? {};
    const authorId = String(data?.user ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? userId ?? game?.user?.id ?? "");
    const whisper = Array.isArray(data?.whisper) ? data.whisper : (Array.isArray(message?.whisper) ? message.whisper : []);
    const blind = !!(data?.blind ?? message?.blind);
    const rollMode = String(data?.rollMode ?? message?.rollMode ?? "");
    const style = String(data?.style ?? data?.type ?? message?.style ?? message?.type ?? "");
    const rolls = Array.isArray(data?.rolls) ? data.rolls : (Array.isArray(message?.rolls) ? message.rolls : []);
    const hasRolls = rolls.length > 0;
    const hasChatCard = feMessageHasChatCardContent(content, null);
    const hasDice = feMessageHasDiceCardContent(content, null, null);
    const mergeRuntime = feComputeMergeRuntimeBehavior({ isNarrator: narrator, isRoundMarker, hasChatCard, hasDice, hasRolls });
    const speakerKey = [
      speaker?.scene ?? "",
      speaker?.token ?? "",
      speaker?.actor ?? "",
      speaker?.alias ?? "",
    ].join("|") + (narrator ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : "");

    const userColorHex = feGetMessageUserColorForData(message, data, userId);
    const userColorRgbObj = feParseHexColorToRgb(userColorHex);

    return {
      v: FE_RENDER_STATE_VERSION,
      userColorHex,
      userColorRgb: userColorRgbObj ? `${userColorRgbObj.r} ${userColorRgbObj.g} ${userColorRgbObj.b}` : null,
      isNarrator: narrator,
      isRoundMarker,
      merge: {
        authorId,
        speakerKey,
        whisperKey: whisper.length ? whisper.slice().sort().join(",") : "",
        blind,
        rollMode,
        style,
        mergeableText: mergeRuntime.mergeableText,
        hasDynamicRoll: mergeRuntime.hasRollMessage || hasChatCard,
        hasChatCard,
        hasDice,
        hasRolls,
        isNarrator: narrator,
        isRoundMarker,
        noMerge: mergeRuntime.noMerge,
      },
    };
  } catch {
    return null;
  }
}

function feGetStoredRenderState(message) {
  try {
    const id = feNormalizeChatMessageId(message?.id ?? message?._id);
    if (id && feMessageRenderStateOverrides.has(id)) return feMessageRenderStateOverrides.get(id) ?? null;
    const state = message?.flags?.[MODULE_ID]?.[FE_RENDER_STATE_FLAG] ?? null;
    if (state?.v === FE_RENDER_STATE_VERSION) return state;
    return null;
  } catch {
    return null;
  }
}

function feStoreRenderStateOverride(messageId, state) {
  try {
    const id = feNormalizeChatMessageId(messageId);
    if (!id) return;
    if (state) feMessageRenderStateOverrides.set(id, state);
    else feMessageRenderStateOverrides.delete(id);
  } catch {}
}

function feHydrateRenderStateOverride(message, data = null, userId = null) {
  try {
    const state = feComputeMessageRenderState(message, data ?? {}, userId);
    feStoreRenderStateOverride(message?.id ?? message?._id, state);
    return state;
  } catch {
    return null;
  }
}

function feChangeTouchesRenderState(change) {
  try {
    if (!change || typeof change !== "object") return false;
    return ["content", "rolls", "speaker", "whisper", "blind", "rollMode", "style", "type", "user", "flavor", "flags"]
      .some((k) => Object.prototype.hasOwnProperty.call(change, k));
  } catch {
    return false;
  }
}

function feGetPendingMessageSource(message, data = {}) {
  try {
    const pending = message?.toObject?.() ?? {};
    return foundry.utils.mergeObject(foundry.utils.deepClone(data ?? {}), pending, {
      inplace: false, recursive: true, overwrite: true,
    });
  } catch {
    return data ?? {};
  }
}

// -------------------------------------
// Special message detection
// -------------------------------------

function feIsNarratorToolsMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("narrator-chat") || messageEl?.classList?.contains?.("fe-narrator-chat")) return true;
    const state = feGetStoredRenderState(message);
    if (typeof state?.isNarrator === "boolean") return state.isNarrator;
    if (message?.getFlag?.("narrator-tools", "type")) return true;
    if (message?.flags?.["narrator-tools"]) return true;
    return false;
  } catch {
    return false;
  }
}

function feIsRoundMarkerMessage(message, messageEl) {
  try {
    if (messageEl?.classList?.contains?.("round-marker") || messageEl?.classList?.contains?.("fe-round-marker-chat")) return true;
    if (messageEl?.querySelector?.(`.round-marker, ${FE_SYSTEM_COMBAT_NOTICE_SELECTOR}`)) return true;
  } catch {}

  try {
    const state = feGetStoredRenderState(message);
    if (typeof state?.isRoundMarker === "boolean") return state.isRoundMarker;
  } catch {}

  try {
    const flag = feGetRoundMarkerFlagValue(message);
    if (flag === true || String(flag) === "true") return true;
  } catch {}

  try {
    const content = String(message?.content ?? "");
    if (/\bround-marker\b/i.test(content)) return true;
    if (feIsSystemCombatNoticeContent(content)) return true;
    if (feLooksLikeRoundMarkerFlavor(message?.flavor ?? "", content)) return true;
  } catch {}

  return false;
}

function feIsUntouchedSpecialMessage(message, messageEl) {
  return feIsNarratorToolsMessage(message, messageEl) || feIsRoundMarkerMessage(message, messageEl);
}

// -------------------------------------
// Render state capture (preCreate/preUpdate)
// -------------------------------------

function feCaptureMessageRenderFlagsOnPreCreate(message, data = {}, userId = null) {
  try {
    const renderState = feComputeMessageRenderState(message, data, userId);
    if (!renderState) return;
    const flags = foundry.utils.deepClone(data?.flags ?? message?.flags ?? {});
    const specialKind = renderState.isNarrator ? "narrator" : renderState.isRoundMarker ? "round-marker" : "normal";
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      userColorHex: renderState.userColorHex ?? null,
      userColorRgb: renderState.userColorRgb ?? null,
      isNarrator: !!renderState.isNarrator,
      isRoundMarker: !!renderState.isRoundMarker,
      [FE_RENDER_SPECIAL_KIND_FLAG]: specialKind,
      [FE_RENDER_MERGE_HINT_FLAG]: renderState.merge ?? null,
      [FE_RENDER_STATE_FLAG]: renderState,
    });
    message.updateSource({ flags });
  } catch {
    /* no-op */
  }
}

function feCaptureMessageRenderFlagsOnPreUpdate(message, changed = {}, userId = null) {
  try {
    const merged = foundry.utils.mergeObject(foundry.utils.deepClone(message?.toObject?.() ?? {}), changed ?? {}, { inplace: true, recursive: true });
    const renderState = feComputeMessageRenderState(message, merged, userId ?? game?.user?.id ?? null);
    if (!renderState) return;
    const flags = foundry.utils.deepClone(merged?.flags ?? message?.flags ?? {});
    const specialKind = renderState.isNarrator ? "narrator" : renderState.isRoundMarker ? "round-marker" : "normal";
    flags[MODULE_ID] = foundry.utils.mergeObject(flags[MODULE_ID] ?? {}, {
      userColorHex: renderState.userColorHex ?? null,
      userColorRgb: renderState.userColorRgb ?? null,
      isNarrator: !!renderState.isNarrator,
      isRoundMarker: !!renderState.isRoundMarker,
      [FE_RENDER_SPECIAL_KIND_FLAG]: specialKind,
      [FE_RENDER_MERGE_HINT_FLAG]: renderState.merge ?? null,
      [FE_RENDER_STATE_FLAG]: renderState,
    });
    changed.flags = flags;
    feStoreRenderStateOverride(message?.id ?? message?._id, renderState);
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// User color bg application
// -------------------------------------

// The per-message user-color marker (.fe-has-user-color + --fe-user-color-rgb)
// drives TWO independent features that both key off which messages carry a
// resolvable user color:
//   1) user color tint  (USE_USER_COLOR_BG)     - per-user color overlay
//   2) card base layer  (USER_COLOR_BG_BASE)    - solid opaque card background
// Historically both were gated on the tint toggle, so turning the tint off also
// killed the solid background. They are now decoupled: the marker class is added
// whenever EITHER feature is active, and the tint-only CSS var is set only when
// the tint itself is enabled.
function feUserColorBgBaseActive() {
  try {
    const base = String(feSetting(S.USER_COLOR_BG_BASE) ?? "none");
    return base === "white" || base === "black" || base === "custom";
  } catch {
    return false;
  }
}

function feUserColorBgFeatureActive() {
  try {
    return !!feSetting(S.USE_USER_COLOR_BG) || feUserColorBgBaseActive();
  } catch {
    return false;
  }
}

function feApplyUserColorBgToMessageElement(message, messageEl) {
  try {
    const tintEnabled = !!feSetting(S.USE_USER_COLOR_BG);
    const systemGmTintEnabled = !!feSetting(S.SYSTEM_MSG_COLOR);
    const enabled = feUserColorBgFeatureActive();
    const el0 = messageEl?.[0] ?? messageEl;
    if (!el0?.classList || !el0?.style) return;

    feStampRenderedStateAttributes(message, el0);

    const state = feGetStoredRenderState(message);
    const isNarratorTools = typeof state?.isNarrator === "boolean"
      ? state.isNarrator
      : feIsNarratorToolsMessage(message, el0);
    const isRoundMarker = typeof state?.isRoundMarker === "boolean"
      ? state.isRoundMarker
      : feIsRoundMarkerMessage(message, el0);
    el0.classList.toggle("fe-narrator-chat", isNarratorTools);
    el0.classList.toggle("fe-round-marker-chat", isRoundMarker);
    if (isNarratorTools || isRoundMarker) {
      el0.classList.remove("fe-system-msg", "fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    // Resolve the character (author/owner) color once. null identifies a system
    // message (GM NPC/narration, author-less, Foundry system).
    const charColor = feGetMessageUserColor(message);
    const isSystemMessage = charColor == null;
    el0.classList.toggle("fe-system-msg", isSystemMessage);
    el0.classList.remove("fe-system-gm-tint");

    // System messages can optionally reuse the active GM's user-color tint.
    // They intentionally remain independent of the ordinary player tint/base
    // settings, so enabling this does not recolor normal chat messages.
    if (isSystemMessage && systemGmTintEnabled) {
      const parsed = feParseHexColorToRgb(feGetActiveGmColor());
      if (parsed) {
        el0.classList.remove("fe-has-user-color");
        el0.classList.add("fe-system-gm-tint");
        el0.style.setProperty("--fe-user-color-rgb", `${parsed.r} ${parsed.g} ${parsed.b}`);
        return;
      }
    }

    if (!enabled) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    // GM NPC / narration: suppress the tint even when an OLDER stored flag carries
    // the GM's personal color (otherwise the historical log stays flooded with it).
    // (GM speaking as a player-owned character resolves to that player's color in
    // charColor, so it is NOT suppressed.)
    if (message?.author?.isGM && charColor == null) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    const rgbString = state?.userColorRgb || message?.flags?.[MODULE_ID]?.userColorRgb || null;
    let rgb = null;
    if (rgbString) {
      rgb = { text: String(rgbString) };
    } else {
      const color = state?.userColorHex || message?.flags?.[MODULE_ID]?.userColorHex || charColor;
      const parsed = feParseHexColorToRgb(color);
      if (parsed) rgb = { text: `${parsed.r} ${parsed.g} ${parsed.b}` };
    }
    if (!rgb?.text) {
      el0.classList.remove("fe-has-user-color");
      el0.style.removeProperty("--fe-user-color-rgb");
      return;
    }

    el0.classList.add("fe-has-user-color");
    // The rgb var is only consumed by the tint overlay; when the tint is off but
    // the solid base is on, leave it unset so the box-shadow tint drops out
    // (invalid var → declaration ignored) while the solid base still paints.
    if (tintEnabled) el0.style.setProperty("--fe-user-color-rgb", rgb.text);
    else el0.style.removeProperty("--fe-user-color-rgb");
  } catch {
    /* noop */
  }
}

function feApplyUserColorBgToAllLogs(doc = document) {
  try {
    const enabled = feUserColorBgFeatureActive();
    const queryRoot = doc?.querySelectorAll ? doc : document;
    const roots = Array.from(queryRoot.querySelectorAll?.("#chat-log, ol.chat-log, #fe-chat-export-log, #chat-notifications") ?? []);
    if (queryRoot?.matches?.("#chat-log, ol.chat-log, #fe-chat-export-log, #chat-notifications")) roots.unshift(queryRoot);

    for (const root of roots) {
      const nodes = root.querySelectorAll(":scope > li.chat-message, :scope > .message");
      for (const li of nodes) {
        if (!enabled) {
          li.classList.remove("fe-has-user-color");
          li.style?.removeProperty?.("--fe-user-color-rgb");
          continue;
        }
        const msgId = feGetMessageIdFromElement(li);
        if (!msgId) continue;
        const msg = game?.messages?.get?.(msgId);
        if (!msg) continue;
        feApplyUserColorBgToMessageElement(msg, li);
      }
    }
  } catch {
    /* noop */
  }
}

function feApplyUserColorBgToLog(logEl, doc = document) {
  try {
    const enabled = feUserColorBgFeatureActive();
    if (!enabled) return;
    if (!logEl?.querySelectorAll) return;

    const nodes = logEl.querySelectorAll(":scope > li.chat-message, :scope > .message");
    for (const li of nodes) {
      const msgId = feGetMessageIdFromElement(li);
      if (!msgId) continue;
      const msg = game?.messages?.get?.(msgId);
      if (!msg) continue;
      feApplyUserColorBgToMessageElement(msg, li);
    }
  } catch {
    /* noop */
  }
}

// -------------------------------------
// DOM attribute stamping + merge info
// -------------------------------------

function feReadStampedMergeInfoFromElement(el) {
  try {
    const node = feExtractHTMLElement(el);
    const ds = node?.dataset;
    if (!ds) return null;
    const hasAny =
      Object.prototype.hasOwnProperty.call(ds, "feMergeKey") ||
      Object.prototype.hasOwnProperty.call(ds, "feNoMerge") ||
      Object.prototype.hasOwnProperty.call(ds, "feIsNarrator") ||
      Object.prototype.hasOwnProperty.call(ds, "feIsRoundMarker") ||
      Object.prototype.hasOwnProperty.call(ds, "feHasChatCard") ||
      Object.prototype.hasOwnProperty.call(ds, "feHasDice") ||
      Object.prototype.hasOwnProperty.call(ds, "feHasRolls");
    if (!hasAny) return null;

    const key = String(ds.feMergeKey ?? "").trim();
    return {
      key: key || null,
      mergeableText: ds.feMergeableText === "1",
      isNarrator: ds.feIsNarrator === "1",
      isRoundMarker: ds.feIsRoundMarker === "1",
      noMerge: ds.feNoMerge === "1",
      hasChatCard: ds.feHasChatCard === "1",
      hasDice: ds.feHasDice === "1",
      hasRolls: ds.feHasRolls === "1",
    };
  } catch {
    return null;
  }
}

function feStampRenderedStateAttributes(message, messageEl) {
  try {
    const el = feExtractHTMLElement(messageEl);
    const ds = el?.dataset;
    if (!el?.classList || !ds || !message) return;

    const state = feGetStoredRenderState(message);
    const storedHint = state?.merge ?? null;
    const isNarratorTools = typeof state?.isNarrator === "boolean"
      ? state.isNarrator
      : feIsNarratorToolsMessage(message, el);
    const isRoundMarker = typeof state?.isRoundMarker === "boolean"
      ? state.isRoundMarker
      : feIsRoundMarkerMessage(message, el);

    const speaker = message?.speaker ?? {};
    const whisper = Array.isArray(message?.whisper) ? message.whisper : [];
    const content = String(message?.content ?? "");
    const hasChatCard = typeof storedHint?.hasChatCard === "boolean"
      ? storedHint.hasChatCard
      : feMessageHasChatCardContent(content, el);
    const hasRolls = typeof storedHint?.hasRolls === "boolean"
      ? storedHint.hasRolls
      : (Array.isArray(message?.rolls) && message.rolls.length > 0);
    const hasDice = typeof storedHint?.hasDice === "boolean"
      ? storedHint.hasDice
      : feMessageHasDiceCardContent(content, message, el);
    const mergeRuntime = feComputeMergeRuntimeBehavior({ isNarrator: isNarratorTools, isRoundMarker, hasChatCard, hasDice, hasRolls });
    const mergeInfo = {
      authorId: storedHint?.authorId ?? message?.author?.id ?? message?.user?.id ?? message?.user ?? "",
      speakerKey: storedHint?.speakerKey ?? ([
        speaker.scene ?? "",
        speaker.token ?? "",
        speaker.actor ?? "",
        speaker.alias ?? "",
      ].join("|") + (isNarratorTools ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : "")),
      whisperKey: storedHint?.whisperKey ?? (whisper.length ? whisper.slice().sort().join(",") : ""),
      blind: typeof storedHint?.blind === "boolean" ? storedHint.blind : !!message?.blind,
      rollMode: storedHint?.rollMode ?? message?.rollMode ?? "",
      style: storedHint?.style ?? message?.style ?? message?.type ?? null,
      mergeableText: mergeRuntime.mergeableText,
      isNarrator: isNarratorTools,
      isRoundMarker,
      noMerge: mergeRuntime.noMerge,
    };

    const mergeKey = feMergeKey(mergeInfo);
    const stamp = [
      mergeKey ?? "",
      mergeInfo.mergeableText ? "1" : "0",
      mergeInfo.noMerge       ? "1" : "0",
      isNarratorTools         ? "1" : "0",
      isRoundMarker           ? "1" : "0",
      hasChatCard             ? "1" : "0",
      hasDice                 ? "1" : "0",
      hasRolls                ? "1" : "0",
    ].join(",");
    if (ds.feStamp === stamp) return;
    ds.feStamp = stamp;

    if (mergeKey) ds.feMergeKey = mergeKey;
    else delete ds.feMergeKey;

    ds.feMergeableText = mergeInfo.mergeableText ? "1" : "0";
    ds.feNoMerge = mergeInfo.noMerge ? "1" : "0";
    ds.feIsNarrator = isNarratorTools ? "1" : "0";
    ds.feIsRoundMarker = isRoundMarker ? "1" : "0";
    ds.feHasChatCard = hasChatCard ? "1" : "0";
    ds.feHasDice = hasDice ? "1" : "0";
    ds.feHasRolls = hasRolls ? "1" : "0";
  } catch {
    /* no-op */
  }
}

function feMessageMergeInfo(msg, el) {
  const stamped = feReadStampedMergeInfoFromElement(el);
  const storedState = feGetStoredRenderState(msg);
  const storedHint = storedState?.merge ?? null;

  const authorId = storedHint?.authorId ?? msg?.author?.id ?? msg?.user?.id ?? msg?.user ?? "";

  const isNarratorTools = typeof stamped?.isNarrator === "boolean"
    ? stamped.isNarrator
    : (typeof storedState?.isNarrator === "boolean" ? storedState.isNarrator : feIsNarratorToolsMessage(msg, el));
  const isRoundMarker = typeof stamped?.isRoundMarker === "boolean"
    ? stamped.isRoundMarker
    : (typeof storedState?.isRoundMarker === "boolean" ? storedState.isRoundMarker : feIsRoundMarkerMessage(msg, el));

  const speaker = msg?.speaker ?? {};
  const speakerKey = storedHint?.speakerKey ?? ([
    speaker.scene ?? "",
    speaker.token ?? "",
    speaker.actor ?? "",
    speaker.alias ?? ""
  ].join("|") + (isNarratorTools ? "|__fe_narrator__" : "") + (isRoundMarker ? "|__fe_roundmarker__" : ""));

  const whisper = Array.isArray(msg?.whisper) ? msg.whisper : [];
  const whisperKey = storedHint?.whisperKey ?? (whisper.length ? whisper.slice().sort().join(",") : "");
  const blind = typeof storedHint?.blind === "boolean" ? storedHint.blind : !!msg?.blind;
  const rollMode = storedHint?.rollMode ?? msg?.rollMode ?? "";
  const style = storedHint?.style ?? msg?.style ?? msg?.type ?? null;
  const content = String(msg?.content ?? "");
  const hasChatCard = typeof storedHint?.hasChatCard === "boolean"
    ? storedHint.hasChatCard
    : (typeof stamped?.hasChatCard === "boolean" ? stamped.hasChatCard : feMessageHasChatCardContent(content, el));
  const hasRolls = typeof storedHint?.hasRolls === "boolean"
    ? storedHint.hasRolls
    : (typeof stamped?.hasRolls === "boolean" ? stamped.hasRolls : (Array.isArray(msg?.rolls) && msg.rolls.length > 0));
  const hasDice = typeof storedHint?.hasDice === "boolean"
    ? storedHint.hasDice
    : (typeof stamped?.hasDice === "boolean" ? stamped.hasDice : feMessageHasDiceCardContent(content, msg, el));
  const mergeRuntime = feComputeMergeRuntimeBehavior({ isNarrator: isNarratorTools, isRoundMarker, hasChatCard, hasDice, hasRolls });

  return {
    authorId,
    speakerKey,
    whisperKey,
    blind,
    rollMode,
    style,
    mergeableText: mergeRuntime.mergeableText,
    key: stamped?.key ?? null,
    isNarrator: isNarratorTools,
    isRoundMarker,
    noMerge: mergeRuntime.noMerge,
  };
}

// -------------------------------------
// Merge key + pair eligibility
// (lives here to avoid circular: merge.js imports these, render-state.js does not import from merge.js)
// -------------------------------------

function feMergeKey(info, basisOverride) {
  if (info?.precomputedKey) return String(info.precomputedKey);
  const author = info?.authorId ?? "";
  const whisper = info?.whisperKey ?? "";
  const blind = info?.blind ? "1" : "0";
  const rollMode = info?.rollMode ?? "";
  const style = info?.style ?? "";

  const basis = basisOverride != null
    ? String(basisOverride)
    : String(feSetting(S.MERGE_SPEAKER_BASIS) ?? "token");

  let speakerComponent;
  if (basis === "author") {
    speakerComponent = "";
  } else if (basis === "actor") {
    const raw = info?.speakerKey ?? "";
    const parts = raw.split("|");
    const actorId = parts[2] ?? "";
    const alias   = parts[3] ?? "";
    const special = parts.slice(4).join("|");
    speakerComponent = [actorId, alias, special].join("|");
  } else {
    speakerComponent = info?.speakerKey ?? "";
  }

  return [author, speakerComponent, whisper, blind, rollMode, style].join("||");
}

function feCanMergePair(a, b, { onlyText = false, allowNarratorMerge = false } = {}) {
  if (!a || !b) return false;
  if ((a.noMerge || b.noMerge) && !(allowNarratorMerge && a.isNarrator && b.isNarrator)) return false;
  if (a.key !== b.key) return false;
  if (onlyText && (!a.mergeableText || !b.mergeableText)) return false;
  return true;
}

export {
  feParseHexColorToRgb,
  feGetSpeakerActorFromMessage,
  feGetSpeakerActorFromLike,
  fePickActorOwnerUser,
  feGetMessageUserColor,
  feGetMessageUserColorForData,
  feMessageHasChatCardContent,
  feMessageHasDiceCardContent,
  feShouldMergeRollMessages,
  feComputeMergeRuntimeBehavior,
  feComputeMessageRenderState,
  feMessageRenderStateOverrides,
  feGetStoredRenderState,
  feStoreRenderStateOverride,
  feHydrateRenderStateOverride,
  feChangeTouchesRenderState,
  feGetPendingMessageSource,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
  feCaptureMessageRenderFlagsOnPreCreate,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feApplyUserColorBgToMessageElement,
  feApplyUserColorBgToAllLogs,
  feApplyUserColorBgToLog,
  feUserColorBgFeatureActive,
  feUserColorBgBaseActive,
  feReadStampedMergeInfoFromElement,
  feStampRenderedStateAttributes,
  feMessageMergeInfo,
  feMergeKey,
  feCanMergePair,
};
