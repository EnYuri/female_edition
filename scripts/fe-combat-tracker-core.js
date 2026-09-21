/**
 * fe-combat-tracker-core.js
 *
 * The battle tracker's shared FLOOR: the handful of things both the tracker
 * itself and the dynamic battle portrait need, and nothing either of them owns.
 * It imports only fe-constants.js, which is what keeps the family's import graph
 * a DAG (ci/fe-module-imports.test.mjs):
 *
 *   fe-combat-tracker-core.js
 *     ← fe-combat-tracker-dbp.js
 *     ← fe-combat-tracker.js   (the entry — the only one in module.json)
 *     ← fe-dx3rd-resource-ui.js (feCtDisplaysHp only — the status panel stands
 *                                down while the tracker is the thing showing HP)
 *
 * feCtScheduleRender lives here for one reason: the dbp module has to ask for a
 * rerender (a spin that ends on a hidden actor, an HP change it just observed),
 * and importing the renderer from the entry would close the cycle. The renderer
 * registers itself instead — the same callback-injection shape fe-merge.js uses
 * for feSetMergeScheduleCallback.
 */
import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

export const TRACKER_DOM_ID = "fe-combat-tracker";
export const CTD_ID = "combat-tracker-dock"; // original Carousel Combat Tracker — we yield to it

export function feCtSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return FE_DEFAULTS[key]; }
}

export function feCtEnabled() {
  return !!feCtSetting(S.COMBAT_TRACKER_ENABLED);
}

// The dynamic battle portrait, and whether it is available at all. Square (1) is
// excluded: the overlay layout would swallow the artwork and the inserted one would
// make a square portrait taller than it is wide — neither reads as a portrait any
// more. It lives in the floor rather than in fe-combat-tracker-dbp.js because two
// other modules need the answer (the entry, and the status panel's yield check)
// and neither of them should have to import the dbp module's rAF ticker for it.
export function feCtDbpEnabled() {
  if (!feCtSetting(S.COMBAT_TRACKER_DYNAMIC_PORTRAIT)) return false;
  return (Number(feCtSetting(S.COMBAT_TRACKER_ASPECT)) || 1) >= 1.5;
}

// "dial" (default) rolls the odometer; "bar" draws a status-panel-style bar with a
// "value/max" caption instead. Anything unrecognised is the dial.
export function feCtDbpHpStyle() {
  return String(feCtSetting(S.COMBAT_TRACKER_DBP_HP_STYLE) || "dial") === "bar" ? "bar" : "dial";
}

// Is the strip on screen at all? Exactly feCtRender's own emptiness gate — it draws
// for whatever encounter feCtGetCombat resolves (including a DEACTIVATED one, which
// stays up so it can be resumed from the tracker) and only while that encounter has
// combatants. Anything asking "is the tracker there right now" must ask it this way,
// or it will disagree with what the user is looking at.
export function feCtCombatOnScreen() {
  return !!feCtGetCombat()?.turns?.length;
}

// Is the tracker publishing HP RIGHT NOW? Three things have to be true, and each one
// is part of the answer rather than a nicety:
//
//   - it is installed — switched on, and not yielded to the original Carousel Combat
//     Tracker (feCtOriginalActive), because a tracker that was never built shows
//     nothing;
//   - one of its two independent HP displays is on — the plain bar under the portrait,
//     or the dynamic battle portrait's own readout;
//   - an encounter is on screen. This is a TEMPORARY condition by design: the status
//     panel (fe-dx3rd-resource-ui.js) stands down for the duration of a combat and
//     comes back when it ends, which is what ceDx3rdRuiYieldToTracker promises.
export function feCtDisplaysHp() {
  if (!feCtEnabled() || feCtOriginalActive()) return false;
  if (!feCtCombatOnScreen()) return false;
  return feCtSetting(S.COMBAT_TRACKER_SHOW_HP) === true || feCtDbpEnabled();
}

// Yield: skip install when the original Carousel Combat Tracker is active.
export function feCtOriginalActive() {
  return !!game.modules?.get?.(CTD_ID)?.active;
}

export function feCtGetCombat() {
  // The `viewed` fallback keeps a deactivated encounter (active:false) on screen so it can
  // be resumed straight from the tracker instead of the tracker vanishing.
  return game.combat ?? game.combats?.active ?? game.combats?.viewed ?? null;
}

// HP for the bar and for the dial. `system.attributes.hp` (dnd5e/dx3rd) with a
// plain `system.hp` fallback; null whenever there is no usable pool, which is what
// every caller tests rather than guessing at zeroes.
export function feCtResolveHp(actor) {
  if (!actor) return null;
  const sys = actor.system ?? {};
  const cand = sys?.attributes?.hp ?? sys?.hp ?? null;
  if (!cand) return null;
  const value = Number(cand.value);
  const max = Number(cand.max ?? cand.maxHP ?? 0);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct > 50 ? "#2ecc71" : pct > 25 ? "#e67e22" : "#e74c3c";
  return { value, max, pct, color };
}

// ── render scheduling ──────────────────────────────────────────────

let _ctRaf = 0;
let _ctRenderer = null;

// Called once by fe-combat-tracker.js at import time. Until it is, scheduling is
// a no-op rather than an error — nothing can usefully render before the entry
// module has finished evaluating anyway.
export function feCtSetRenderer(fn) {
  _ctRenderer = typeof fn === "function" ? fn : null;
}

// Teardown has to drop a frame already in flight: it runs precisely when the
// tracker is being removed, and a queued render would put it straight back.
export function feCtCancelScheduledRender() {
  if (_ctRaf) { cancelAnimationFrame(_ctRaf); _ctRaf = 0; }
}

// Coalesces every caller into one frame: a single combat update can fire a dozen
// hooks, and each one would otherwise rebuild the whole strip.
export function feCtScheduleRender() {
  if (_ctRaf) return;
  _ctRaf = requestAnimationFrame(() => {
    _ctRaf = 0;
    _ctRenderer?.();
  });
}
