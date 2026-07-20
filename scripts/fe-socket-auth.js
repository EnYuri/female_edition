import { MODULE_ID } from "./fe-constants.js";

let feWarnedLegacySocketSender = false;

/**
 * Resolve a custom module-socket sender from the server-authenticated callback
 * argument. Foundry v14 supplies this as the second listener argument. The
 * claimed id is retained only as a v13 compatibility fallback until that path
 * is verified live; v14 never trusts a packet-owned identity.
 */
export function feResolveSocketSender(senderId, claimedId = null, context = "socket") {
  if (typeof senderId === "string" && senderId) {
    return game.users?.get?.(senderId) ?? null;
  }

  const generation = Number(game.release?.generation ?? String(game.version ?? "").split(".")[0]);
  if (generation === 13 && typeof claimedId === "string" && claimedId) {
    if (!feWarnedLegacySocketSender) {
      feWarnedLegacySocketSender = true;
      console.warn(
        `${MODULE_ID} | ${context}: socket sender id unavailable; using the v13 claimed-id compatibility fallback`
      );
    }
    return game.users?.get?.(claimedId) ?? null;
  }

  return null;
}
