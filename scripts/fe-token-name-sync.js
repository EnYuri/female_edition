// Female-cupwhi: Actor name -> token name synchronization.
// Document behavior only: no Token Config DOM or canvas-rendering concerns.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

function feTokenNameSyncEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.TOKEN_SYNC_NAME); }
  catch { return !!FE_DEFAULTS[S.TOKEN_SYNC_NAME]; }
}

function fePlacedTokenNameSyncEnabled() {
  try { return !!game.settings.get(MODULE_ID, S.TOKEN_SYNC_PLACED_NAME); }
  catch { return !!FE_DEFAULTS[S.TOKEN_SYNC_PLACED_NAME]; }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.TOKEN_SYNC_NAME, {
    name: "액터 이름을 프로토타입 토큰 이름에 동기화",
    hint: "액터 이름을 바꾸면 프로토타입 토큰 이름도 함께 바꿉니다. 이미 씬에 배치된 토큰까지 바꾸려면 아래의 별도 옵션을 켜세요.",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_SYNC_NAME],
  });

  game.settings.register(MODULE_ID, S.TOKEN_SYNC_PLACED_NAME, {
    name: "액터 이름을 배치 토큰 이름에도 동기화",
    hint: "액터 이름을 바꾸면 모든 씬에 배치된 해당 액터 토큰의 이름도 함께 바꿉니다. 켜진 동안 개별 토큰에 따로 붙인 이름도 다음 액터 개명 때 액터 이름으로 바뀝니다.",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.TOKEN_SYNC_PLACED_NAME],
  });
});

// Foundry initializes a prototype token name from the actor name only when the
// former is blank. Keep it current here so tokens created after a rename also
// inherit the renamed actor's label.
Hooks.on("preUpdateActor", (actor, changes) => {
  if (!("name" in (changes ?? {})) || !feTokenNameSyncEnabled()) return;
  const name = String(changes.name ?? "");
  if (!name || name === actor.name) return;

  if (Object.hasOwn(changes, "prototypeToken.name")) {
    changes["prototypeToken.name"] = name;
    return;
  }
  if (!changes.prototypeToken || typeof changes.prototypeToken !== "object") changes.prototypeToken = {};
  changes.prototypeToken.name = name;
});

// Existing token names are separate Scene document fields, including on
// unlinked tokens, so prototype-token updates alone cannot change their hover
// labels. Only the active GM writes them to avoid duplicate scene updates.
Hooks.on("updateActor", async (actor, changes) => {
  if (!("name" in (changes ?? {})) || !feTokenNameSyncEnabled() || !fePlacedTokenNameSyncEnabled()) return;
  if (!game.user?.isGM || game.users?.activeGM?.id !== game.user.id) return;
  if (actor.isToken) return;

  const name = actor.name;
  const updatesByScene = new Map();
  for (const scene of game.scenes ?? []) {
    const updates = [];
    for (const token of scene.tokens ?? []) {
      if (token.actorId !== actor.id || token.name === name) continue;
      updates.push({ _id: token.id, name });
    }
    if (updates.length) updatesByScene.set(scene, updates);
  }

  const results = await Promise.allSettled(Array.from(updatesByScene, async ([scene, updates]) => {
    await scene.updateEmbeddedDocuments("Token", updates, { feActorNameTokenSync: true });
  }));
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(`[${MODULE_ID}] failed to synchronize token names after actor rename`, result.reason);
    }
  }
});
