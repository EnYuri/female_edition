/**
 * Shims for dnd5e schema paths that moved between 5.x and 6.0.
 *
 * This fork targets BOTH Foundry v13 with dnd5e < 6.0 and Foundry v14 with dnd5e >= 6.0,
 * so nothing here may simply be renamed to the new path — each accessor has to answer
 * correctly on either system.
 *
 * The accessors deliberately probe the paths rather than branching on
 * `game.system.version`. A path probe is true by construction: on 6.0 the new field is
 * always present in the schema (a `FormulaField` defaulting to `''`), and on 5.x it is
 * absent, so the first defined value is the right one. Version comparisons, by contrast,
 * have to be kept in step with every point release and say nothing about what a given
 * world's data actually holds after a partial migration.
 */

/** Returns the value at the first path that is defined on `root`. */
export function readFirstDefined(root: any, ...paths: string[]): unknown {
  for (const path of paths) {
    const value = foundry.utils.getProperty(root ?? {}, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * An actor's global bonus to attack rolls of one action type.
 *
 * dnd5e 6.0 moved every attack/damage bonus out of `system.bonuses` into `system.rolls`
 * (`ActorDataModel.#BONUS_FIELD_PATHS`):
 *
 *   bonuses.<mwak|rwak|msak|rsak>.attack  ->  rolls.attack.<type>.bonus
 *   bonuses.<mwak|rwak|msak|rsak>.damage  ->  rolls.damage.<type>.bonus
 *   bonuses.abilities.<check|save|skill>  ->  rolls.ability.<check|save|skill>.bonus
 *
 * Reading the old path on 6.0 throws rather than returning nothing — `system.bonuses`
 * still exists (it kept `spell.dc`, which did NOT move), so `bonuses.rsak` is `undefined`
 * and `.attack` on it is a TypeError. That is what took out the NPC sheet's whole
 * `_prepareContext`.
 *
 * @param actionType One of `mwak`, `rwak`, `msak`, `rsak`.
 */
export function getActorAttackBonus(actor: any, actionType: string): string {
  const bonus = readFirstDefined(
    actor?.system,
    `rolls.attack.${actionType}.bonus`, // dnd5e >= 6.0
    `bonuses.${actionType}.attack` // dnd5e <= 5.x
  );
  return typeof bonus === 'string' ? bonus : '';
}

/** As {@link getActorAttackBonus}, for the damage side of the same pair. */
export function getActorDamageBonus(actor: any, actionType: string): string {
  const bonus = readFirstDefined(
    actor?.system,
    `rolls.damage.${actionType}.bonus`, // dnd5e >= 6.0
    `bonuses.${actionType}.damage` // dnd5e <= 5.x
  );
  return typeof bonus === 'string' ? bonus : '';
}

/**
 * The update payload that sets a physical item's rarity.
 *
 * dnd5e 6.0 replaced the single `system.rarity` string with `system.rarities`, a
 * `SetField` — an item may now carry several. Reading is unaffected: 6.0 keeps a
 * `get rarity()` returning `rarities.first()`. Writing is NOT. `system.rarity` is a
 * getter with no setter and is absent from the schema, and dnd5e's own `_migrateData`
 * bails out the moment `rarities` is present (which it always is on a live document), so
 * the stray key is simply dropped — the select changes and nothing happens, with no error.
 *
 * The shape is probed on the document's own schema rather than the system version,
 * because that is the thing that actually decides which key is accepted.
 */
export function buildItemRarityUpdate(
  item: any,
  rarity: unknown
): Record<string, unknown> {
  if (item?.system?.schema?.fields?.rarities) {
    // dnd5e >= 6.0. Classic offers a single-select, so the set holds at most one entry;
    // an item that already had several loses the rest, which is what picking one means.
    return { 'system.rarities': rarity ? [rarity] : [] };
  }
  return { 'system.rarity': rarity ?? '' };
}

/**
 * The rarity currently on an item, as the single key the Classic select expects.
 *
 * On 5.x this is just `system.rarity`. On 6.0 that name survives only as a getter over the
 * `rarities` set (`get rarity() { return this.rarities.first(); }`) — a PROTOTYPE getter,
 * which means it does not survive any structured copy of `system`. Reading from the live
 * document instead of the prepared context is what makes the select show the saved value
 * back rather than falling to its blank option, which is why this takes the item.
 */
export function getItemRarity(item: any): string {
  const system = item?.system;
  if (!system) return '';
  const rarity = system.rarity ?? system.rarities?.first?.();
  return typeof rarity === 'string' ? rarity : '';
}

/**
 * One movement speed, in the unit stored on the movement object.
 *
 * dnd5e 6.0 moved the six speeds (`CONFIG.DND5E.movementTypes`) into a `speeds` sub-object:
 * `attributes.movement.walk` -> `attributes.movement.speeds.walk`. Reading the old name
 * still works on 6.0 — `MovementField._shim` installs a silent getter for each — but that
 * shim is scheduled for removal in **dnd5e 7.0**, after which the old read returns
 * `undefined` and every speed simply disappears from the sheet with no error.
 *
 * The shim is also an OWN accessor installed on the prepared object, so it does not survive
 * a structured copy; reading `speeds` first is correct for a cloned context too.
 *
 * `hover`, `units` and `special` did NOT move and are read directly at the call sites.
 */
export function getMovementSpeed(movement: any, key: string): number | undefined {
  return movement?.speeds ? movement.speeds[key] : movement?.[key];
}

/**
 * One sense range, in the unit stored on the senses object.
 *
 * The same story as {@link getMovementSpeed}, one version earlier and with a much nearer
 * deadline: dnd5e 5.3 moved the four senses (`CONFIG.DND5E.senses`) into `ranges`
 * (`attributes.senses.darkvision` -> `attributes.senses.ranges.darkvision`) and
 * `SensesField._shim` is slated for removal in **dnd5e 6.1**.
 *
 * `units` and `special` did NOT move.
 */
export function getSenseRange(senses: any, key: string): number | undefined {
  return senses?.ranges ? senses.ranges[key] : senses?.[key];
}

/**
 * The display label for one entry of `CONFIG.DND5E.senses`.
 *
 * dnd5e 6.0 also changed the SHAPE of that config: on 5.x each value is the i18n key
 * itself (`{ darkvision: "DND5E.SenseDarkvision" }`), on 6.0 it is a descriptor object
 * (`{ darkvision: { label: "Darkvision", detectionMode: "…" } }`). Upstream destructured
 * the value straight into `game.i18n.localize(label)`, which on 6.0 hands core an object
 * and throws `key.split is not a function` — taking the whole sheet's `_prepareContext`
 * down with it.
 *
 * It only fires once a sense is actually set, because the loop skips zero-valued senses,
 * which is why it can sit unnoticed on an actor with no darkvision.
 *
 * `localize` passes a string through unchanged when it is not a known key, so the already
 * localized 6.0 label survives it.
 */
export function getSenseLabel(config: unknown): string {
  const label =
    typeof config === 'string' ? config : ((config as any)?.label ?? '');
  return typeof label === 'string' ? game.i18n.localize(label) : '';
}
