// Chat portrait features (split)
// Implements a small, FVTT v13-safe subset inspired by:
// https://github.com/p4535992/foundryvtt-chat-portrait

import {
  MODULE_ID,
  feGetChatLogs,
  feGetSpeakerActorFromMessage,
  feGetMessageUserColor,
} from "./fe-chat-enhance.js";

const CP = Object.freeze({
  ENABLED: "chatPortraitEnabled",
  HIDE_WRAP: "chatPortraitHideWrap",
  USE_TOKEN: "chatPortraitUseTokenImage",
  SIZE: "chatPortraitSize",
  SHAPE: "chatPortraitShape",
  BORDER_MODE: "chatPortraitBorderMode",
  BORDER_WIDTH: "chatPortraitBorderWidth",
  BORDER_COLOR: "chatPortraitBorderColor",
  APPLY_COMBAT: "chatPortraitApplyCombatTracker",

  SHOW_IC: "chatPortraitShowIC",
  SHOW_OOC: "chatPortraitShowOOC",
  SHOW_EMOTE: "chatPortraitShowEmote",
  SHOW_WHISPER: "chatPortraitShowWhisper",
  SHOW_ROLL: "chatPortraitShowRoll",
  SHOW_OTHER: "chatPortraitShowOther",
});

function cpGet(key) {
  return game.settings.get(MODULE_ID, key);
}

function cpExtractHTMLElement(html) {
  if (!html) return null;
  if (html instanceof HTMLElement) return html;
  // jQuery-like wrappers
  if (html.jquery && html[0] instanceof HTMLElement) return html[0];
  if (Array.isArray(html) && html[0] instanceof HTMLElement) return html[0];
  if (html[0] instanceof HTMLElement) return html[0];
  return null;
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

function cpSetRootVars() {
  const size = Math.max(16, Number(cpGet(CP.SIZE) ?? 64) || 64);
  document.documentElement.style.setProperty("--fe-chat-portrait-size", `${size}px`);

  const enabled = !!cpGet(CP.ENABLED);
  document.documentElement.classList.toggle("fe-chat-portrait-enabled", enabled);

  const hideWrap = !!cpGet(CP.HIDE_WRAP);
  document.body.classList.toggle("fe-hide-chat-portrait-wrap", hideWrap);
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

function cpGetPortraitSrc(message) {
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
  messageEl?.querySelector?.(".fe-chat-portrait-wrap")?.remove?.();
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

function cpApplyPortraitStyling(message, img) {
  try {
    if (!(img instanceof HTMLImageElement)) return;

    // Shape (cropping)
    const shape = String(cpGet(CP.SHAPE) ?? "circle");
    img.style.setProperty("border-radius", shape === "square" ? "0" : "50%", "important");

    // Quality: override any global pixelated rules so downscaling looks smooth.
    // (Some themes/modules set image-rendering: pixelated for sidebar images.)
    img.style.setProperty("image-rendering", "auto", "important");
    img.style.setProperty("object-fit", "cover", "important");

    // Border
    const mode = String(cpGet(CP.BORDER_MODE) ?? "theme");
    if (mode === "theme") {
      // Do not override theme/module styling
      img.style.removeProperty("border");
      return;
    }

    if (mode === "none") {
      img.style.setProperty("border", "none", "important");
      return;
    }

    const width = Math.max(0, Number(cpGet(CP.BORDER_WIDTH) ?? 2) || 0);
    const fallbackColor = String(cpGet(CP.BORDER_COLOR) ?? "#000000");

    let color = fallbackColor;
    if (mode === "user") {
      // Prefer the same "message user color" logic used by FE's background tint
      // (GM-authored on behalf of a player-owned actor -> prefer player owner color).
      const msgColor = feGetMessageUserColor?.(message);
      color = msgColor || fallbackColor;
    }

    img.style.setProperty("border", `${width}px solid ${color}`, "important");
  } catch {
    /* no-op */
  }
}

function cpApplyCombatPortraitStyling(combatant, img) {
  try {
    if (!(img instanceof HTMLImageElement)) return;

    const shape = String(cpGet(CP.SHAPE) ?? "circle");
    img.style.setProperty("border-radius", shape === "square" ? "0" : "50%", "important");

    img.style.setProperty("image-rendering", "auto", "important");
    img.style.setProperty("object-fit", "cover", "important");

    const mode = String(cpGet(CP.BORDER_MODE) ?? "theme");
    if (mode === "theme") {
      img.style.removeProperty("border");
      return;
    }

    if (mode === "none") {
      img.style.setProperty("border", "none", "important");
      return;
    }

    const width = Math.max(0, Number(cpGet(CP.BORDER_WIDTH) ?? 2) || 0);
    const fallbackColor = String(cpGet(CP.BORDER_COLOR) ?? "#000000");

    let color = fallbackColor;
    if (mode === "user") {
      const actorColor = cpPickActorOwnerColor(combatant?.actor);
      color = actorColor || fallbackColor;
    }

    img.style.setProperty("border", `${width}px solid ${color}`, "important");
  } catch {
    /* no-op */
  }
}



function cpUpsertPortrait(message, messageEl) {
  if (!messageEl) return;

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

  const header = messageEl.querySelector?.("header.message-header");
  if (!header) return;

  const src = cpGetPortraitSrc(message);
  if (!src) return;

  // IMPORTANT: Support insertion into non-main documents (e.g. chat archive export window).
  // Always create elements using the message element's ownerDocument.
  const doc = messageEl.ownerDocument ?? document;

  let wrap = header.querySelector?.(".fe-chat-portrait-wrap");
  if (!wrap) {
    wrap = doc.createElement("div");
    wrap.className = "fe-chat-portrait-wrap";
    header.prepend(wrap);
  }

  let img = wrap.querySelector("img.fe-chat-portrait");
  if (!img) {
    img = doc.createElement("img");
    img.className = "fe-chat-portrait";
    img.loading = "lazy";
    img.decoding = "async";
    wrap.appendChild(img);
  }

  img.src = src;
  img.alt = cpGetPortraitAlt(message);
  img.title = img.alt;

  cpApplyPortraitStyling(message, img);

  messageEl.classList.add("fe-has-chat-portrait");
}

function cpApplyVarsToDocument(doc) {
  if (!doc?.documentElement) return;
  const size = Math.max(16, Number(cpGet(CP.SIZE) ?? 64) || 64);
  try {
    doc.documentElement.style.setProperty("--fe-chat-portrait-size", `${size}px`);
  } catch {}

  const enabled = !!cpGet(CP.ENABLED);
  try {
    doc.documentElement.classList.toggle("fe-chat-portrait-enabled", enabled);
  } catch {}

  const hideWrap = !!cpGet(CP.HIDE_WRAP);
  try {
    doc.body?.classList?.toggle?.("fe-hide-chat-portrait-wrap", hideWrap);
  } catch {}
}

function cpRefreshAllChatMessages() {
  cpWarnIfChatPortraitModuleActive();

  // feGetChatLogs() returns actual <ol.chat-log> / #chat-log HTMLElements.
  // Do NOT treat them as Application objects.
  for (const logEl of feGetChatLogs()) {
    if (!(logEl instanceof HTMLElement)) continue;
    const messages = logEl.querySelectorAll?.("li.chat-message");
    if (!messages?.length) continue;

    for (const li of messages) {
      const id = li?.dataset?.messageId || li?.getAttribute?.("data-message-id");
      const msg = id ? game.messages?.get(id) : null;
      if (!msg) continue;
      cpUpsertPortrait(msg, li);
    }
  }
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
  if (!cpGet(CP.ENABLED)) return;
  if (!cpGet(CP.APPLY_COMBAT)) return;

  const root = html?.querySelector ? html : document;
  const combat = root.querySelector?.("#combat") ?? root.querySelector?.(".combat-tracker");
  if (!combat) return;

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
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      cpSetRootVars();
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.HIDE_WRAP, {
    name: "채팅 포트레이트(삽입) 숨김",
    hint: "이 모듈이 채팅 카드 헤더에 삽입하는 포트레이트(.fe-chat-portrait-wrap)를 숨깁니다. 기존 '채팅 포트레이트 숨김'(내부/기본 포트레이트) 옵션과 별개입니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      cpSetRootVars();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.USE_TOKEN, {
    name: "채팅 포트레이트에 토큰 이미지 사용",
    hint: "활성화 시 액터 포트레이트 대신 토큰 이미지를 사용합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.SIZE, {
    name: "채팅 포트레이트 크기(px)",
    hint: "포트레이트 이미지의 가로/세로 크기(px)입니다.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 16, max: 128, step: 1 },
    default: 64,
    onChange: () => {
      cpSetRootVars();
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });


  game.settings.register(MODULE_ID, CP.SHAPE, {
    name: "채팅 포트레이트 모양",
    hint: "포트레이트 이미지를 원형/사각형으로 표시합니다.",
    scope: "client",
    config: true,
    type: String,
    default: "circle",
    choices: {
      circle: "원형",
      square: "사각형",
    },
    onChange: () => {
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_MODE, {
    name: "채팅 포트레이트 테두리(보더) 모드",
    hint: "포트레이트 이미지 테두리 스타일을 설정합니다. '테마/기본값'은 다른 테마/모듈의 스타일을 그대로 사용합니다.",
    scope: "client",
    config: true,
    type: String,
    default: "theme",
    choices: {
      theme: "테마/기본값(변경 안 함)",
      none: "없음",
      user: "플레이어 색상",
      custom: "사용자 지정",
    },
    onChange: () => {
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_WIDTH, {
    name: "채팅 포트레이트 테두리 두께(px)",
    hint: "테두리 모드가 '플레이어 색상' 또는 '사용자 지정'일 때 적용됩니다.",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 12, step: 1 },
    default: 2,
    onChange: () => {
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.BORDER_COLOR, {
    name: "채팅 포트레이트 테두리 색상(HEX)",
    hint: "테두리 모드가 '사용자 지정'일 때 사용합니다. 예) #000000",
    scope: "client",
    config: true,
    type: String,
    default: "#000000",
    onChange: () => {
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.APPLY_COMBAT, {
    name: "컴뱃 트래커에 포트레이트 적용",
    hint: "컴뱃 트래커의 토큰 이미지에 동일한 규칙(토큰/포트레이트)을 적용합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => Hooks.callAll(`${MODULE_ID}.chatUiUpdated`),
  });

  // Message type filters
  const typeSetting = (key, name, def = true) =>
    game.settings.register(MODULE_ID, key, {
      name,
      scope: "client",
      config: true,
      type: Boolean,
      default: def,
      onChange: () => {
        cpRefreshAllChatMessages();
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
  cpRefreshAllChatMessages();
});

Hooks.on("renderChatMessageHTML", (message, html) => {
  cpUpsertPortrait(message, cpExtractHTMLElement(html));
});

Hooks.on("renderChatLog", () => {
  // Chat popouts / re-render
  cpRefreshAllChatMessages();
});

Hooks.on("renderCombatTracker", (app, html) => {
  cpApplyCombatTrackerPortraits(html);
});

Hooks.on(`${MODULE_ID}.chatUiUpdated`, () => {
  cpSetRootVars();
  cpRefreshAllChatMessages();
});
