/**
 * Integrations written against official Tidy 14 assume Quadrone exists whenever
 * `tidy5e-sheet.ready` fires. Plutonium (2.19/2.20) is the known case: its listener
 * hands libWrapper string paths such as
 *   CONFIG.Actor.sheetClasses.character["dnd5e.Tidy5eCharacterSheetQuadrone"].cls.__proto__.prototype._onDrop
 *   CONFIG.Actor.sheetClasses.character["dnd5e.Tidy5eCharacterSheetQuadrone"].cls.prototype.findItem
 * When this fork is the sole provider those keys do not exist, libWrapper throws
 * "target does not exist", and Plutonium's top-level handler turns that into a
 * `window.alert("Failed to initialize Plutonium!")` plus `isFail = true`, which also
 * stops the rest of its Tidy integration.
 *
 * So for the duration of that one synchronous hook dispatch, each key resolves to an
 * alias of the matching Classic sheet:
 * - `alias.__proto__` IS the Classic class, so the drag-drop patch lands on the
 *   Classic sheet's real `_onDrop` (libWrapper wraps an inherited method in place),
 *   which is the behaviour Plutonium wanted for Tidy sheets in the first place.
 * - `alias.prototype.findItem` is an inert stub. Classic has no findItem (it is a
 *   Quadrone-only API), nothing calls the stub, and wrapping it merely keeps the
 *   registration from throwing.
 *
 * The aliases are non-enumerable (the sheet picker never lists them) and are removed
 * as soon as the dispatch returns: an actor whose stored `core.sheetClass` still names
 * a Quadrone sheet would otherwise resolve to this alias instead of falling back.
 * Existing keys (official Tidy active) are never touched.
 */
export const QUADRONE_READY_ALIAS_KEYS = Object.freeze({
  character: 'dnd5e.Tidy5eCharacterSheetQuadrone',
  npc: 'dnd5e.Tidy5eNpcSheetQuadrone',
  group: 'dnd5e.Tidy5eGroupSheetQuadrone',
  encounter: 'dnd5e.Tidy5eEncounterSheetQuadrone',
});

function createAlias(key, ClassicSheet) {
  const cls = Object.create(ClassicSheet);
  Object.defineProperty(cls, 'prototype', {
    value: { async findItem() {} },
  });
  return { id: key, cls };
}

/**
 * @param {Record<string, object>|undefined} sheetClasses  CONFIG.Actor.sheetClasses
 * @param {Record<string, Function>} classicByType         actor type -> Classic sheet class
 * @param {Function} dispatch                               runs the ready hook
 */
export function withQuadroneReadyAliases(sheetClasses, classicByType, dispatch) {
  const installed = [];
  for (const [type, key] of Object.entries(QUADRONE_READY_ALIAS_KEYS)) {
    const bucket = sheetClasses?.[type];
    const ClassicSheet = classicByType?.[type];
    if (!bucket || typeof ClassicSheet !== 'function' || Object.hasOwn(bucket, key)) continue;
    try {
      Object.defineProperty(bucket, key, {
        value: createAlias(key, ClassicSheet),
        configurable: true,
        enumerable: false,
      });
      installed.push([bucket, key]);
    } catch (error) {
      console.warn(`female_edition | cannot alias ${key} for tidy5e-sheet.ready`, error);
    }
  }
  try {
    return dispatch();
  } finally {
    for (const [bucket, key] of installed) delete bucket[key];
  }
}
