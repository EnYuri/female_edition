import { feFormat } from "./fe-i18n.js";
import { feRegisterSetting } from "./fe-settings-data.js";
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
  feRegisterSetting(S.TOKEN_SYNC_NAME);

  feRegisterSetting(S.TOKEN_SYNC_PLACED_NAME);
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
      console.error(feFormat("FE.Diagnostics.TokenNameSync.error", { MODULE_ID: MODULE_ID }), result.reason);
    }
  }
});
