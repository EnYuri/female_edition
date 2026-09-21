/**
 * fe-hp-mask.js
 *
 * The ONE per-actor "hide the numbers" flag. Two features read it: the pixel status
 * panel (fe-dx3rd-resource-ui.js), which prints "??" in place of the values, and the
 * battle tracker's dynamic battle portrait (fe-combat-tracker-dbp.js), which parks
 * its dial on "?" drums. They used to own a flag each (`maskResourceValues` and
 * `dbpRevealHp`) with opposite polarity, so the same actor could be secret in one UI
 * and public in the other — one toggle, one flag.
 *
 * ABSENT MEANS MASKED, and that is the load-bearing part. Both features exist to keep
 * an enemy's numbers secret, so the safe state has to be the default one: a flag that
 * was never written must not disclose anything. Revealing is therefore the EXPLICIT
 * state, written as a literal `false` — do not go back to unsetting the flag to
 * reveal, or every actor would silently re-open on the next read.
 *
 * Imports fe-constants.js only, so both consumers can depend on it without either
 * depending on the other.
 */
import { MODULE_ID } from "./fe-constants.js";

export const FE_HP_MASK_FLAG = "maskResourceValues";

export function feHpMasked(actor) {
  try { return actor?.getFlag?.(MODULE_ID, FE_HP_MASK_FLAG) !== false; }
  catch { return true; }
}

// Returns the new masked state, or null when nothing was written (not the owner, or
// the update failed) so a caller can skip its own follow-up work.
export async function feToggleHpMask(actor) {
  if (!actor?.isOwner) return null;
  const next = !feHpMasked(actor);
  try { await actor.setFlag(MODULE_ID, FE_HP_MASK_FLAG, next); }
  catch (err) { console.error(`${MODULE_ID} | hp mask toggle failed`, err); return null; }
  return next;
}
