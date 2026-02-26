// Chat portrait features (split)
// Implements a small, FVTT v13-safe subset inspired by:
// https://github.com/p4535992/foundryvtt-chat-portrait

import {
  MODULE_ID,
  feGetChatLogs,
  feGetSpeakerActorFromMessage,
} from "./fe-chat-enhance.js";

const CP = Object.freeze({
  ENABLED: "chatPortraitEnabled",
  HIDE_WRAP: "chatPortraitHideWrap",
  USE_TOKEN: "chatPortraitUseTokenImage",
  SIZE: "chatPortraitSize",
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
  const size = Math.max(16, Number(cpGet(CP.SIZE) ?? 48) || 48);
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

  let wrap = header.querySelector?.(".fe-chat-portrait-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "fe-chat-portrait-wrap";
    header.prepend(wrap);
  }

  let img = wrap.querySelector("img.fe-chat-portrait");
  if (!img) {
    img = document.createElement("img");
    img.className = "fe-chat-portrait";
    img.loading = "lazy";
    img.decoding = "async";
    wrap.appendChild(img);
  }

  img.src = src;
  img.alt = cpGetPortraitAlt(message);
  img.title = img.alt;

  messageEl.classList.add("fe-has-chat-portrait");
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
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.HIDE_WRAP, {
    name: "채팅 포트레이트(삽입) 숨김",
    hint: "이 모듈이 채팅 카드 헤더에 삽입하는 포트레이트(.fe-chat-portrait-wrap)를 숨깁니다. 기존 '채팅 포트레이트 숨김'(내부/기본 포트레이트) 옵션과 별개입니다.",
    scope: "client",
    config: false,
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
    config: false,
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
    config: false,
    type: Number,
    range: { min: 16, max: 128, step: 1 },
    default: 48,
    onChange: () => {
      cpSetRootVars();
      cpRefreshAllChatMessages();
      Hooks.callAll(`${MODULE_ID}.chatUiUpdated`);
    },
  });

  game.settings.register(MODULE_ID, CP.APPLY_COMBAT, {
    name: "컴뱃 트래커에 포트레이트 적용",
    hint: "컴뱃 트래커의 토큰 이미지에 동일한 규칙(토큰/포트레이트)을 적용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => Hooks.callAll(`${MODULE_ID}.chatUiUpdated`),
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
