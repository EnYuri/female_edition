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

/**
 * The rest types to offer on a sheet, as `{ key: { label, icon } }` entries.
 *
 * dnd5e 5.3 introduced `CONFIG.DND5E.restTypes`, which lets modules register
 * additional rest kinds; the sheet renders one button per entry. Older versions
 * (and any world where the config is absent) fall back to the short/long pair
 * the classic buttons always showed.
 */
export function getRestTypes(): Record<
  string,
  { label?: string; icon?: string; [key: string]: unknown }
> {
  const restTypes = CONFIG.DND5E?.restTypes;
  if (restTypes && typeof restTypes === 'object') {
    return restTypes;
  }
  return {
    short: { label: 'TIDY5E.ShortRest', icon: 'fas fa-hourglass-half' },
    long: { label: 'TIDY5E.LongRest', icon: 'fas fa-hourglass-end' },
  };
}

/**
 * Starts a rest of the given type on the actor.
 *
 * `actor.initiateRest` accepts any registered rest type and carries extra
 * options (`chat`, `advanceTime`, `newDay`, ...) through to the eventual
 * `_rest` call. Versions that predate it only know the `shortRest`/`longRest`
 * pair, so the method is probed rather than assumed.
 */
export function initiateActorRest(
  actor: any,
  type: string,
  options: Record<string, unknown> = {}
) {
  if (typeof actor?.initiateRest === 'function') {
    return actor.initiateRest({ type, ...options });
  }
  const legacy =
    type === 'long'
      ? actor?.longRest
      : type === 'short'
        ? actor?.shortRest
        : undefined;
  return legacy?.call(actor, options);
}

/**
 * Silently applies a long rest to the actor — no dialog, no chat card — for the
 * NPC "refresh" action. Falls back to `longRest` with the same options when
 * `_rest` is not exposed.
 */
export function refreshActor(actor: any) {
  const config = { type: 'long', dialog: false, chat: false, newDay: true };
  if (typeof actor?._rest === 'function') {
    return actor._rest(config);
  }
  return actor?.longRest?.(config);
}

/**
 * Localization keys this fork still references that dnd5e 6.0 renamed.
 *
 * Consulted by `FoundryAdapter.localize` only when `game.i18n.has(key)` fails,
 * so older systems keep resolving the original key (and its translation) and
 * 6.x installs fall through to the modern key. Keys dnd5e removed outright —
 * with no 6.x successor — are deliberately absent here; the fork ships those
 * strings itself in `public/lang` under the same `DND5E.*` key.
 */
export const DND5E_RENAMED_LOCALIZATION_KEYS: Record<string, string> = {
  'DND5E.Effects': 'DND5E.EFFECT.Tab',
  'DND5E.ConImm': 'DND5E.TRAIT.Condition.Immunity.title',
  'DND5E.DamImm': 'DND5E.TRAIT.Damage.Immunity.title',
  'DND5E.DamRes': 'DND5E.TRAIT.Damage.Resistance.title',
  'DND5E.DamVuln': 'DND5E.TRAIT.Damage.Vulnerability.title',
  'DND5E.TraitWeaponProf': 'DND5E.TRAIT.Weapon.title',
  'DND5E.TraitArmorProf': 'DND5E.TRAIT.Armor.title',
  'DND5E.TraitToolProf': 'DND5E.TRAIT.Tool.title',
  'DND5E.TraitConfig': 'DND5E.TRAIT.Action.Configure',
  'DND5e.TraitConfig': 'DND5E.TRAIT.Action.Configure',
  'DND5E.TraitCIPlural.other': 'DND5E.TRAIT.Condition.Immunity.other',
  'DND5E.TraitDIPlural.other': 'DND5E.TRAIT.Damage.Immunity.other',
  'DND5E.EffectCreate': 'DND5E.EFFECT.Action.CreateEffect',
  'DND5E.EffectDelete': 'DND5E.EFFECT.Action.DeleteEffect',
  'DND5E.EffectDisable': 'DND5E.EFFECT.Action.DisableEffect',
  'DND5E.EffectEdit': 'DND5E.EFFECT.Action.EditEffect',
  'DND5E.EffectEnable': 'DND5E.EFFECT.Action.EnableEffect',
  'DND5E.EffectNew': 'DND5E.EFFECT.New',
  'DND5E.ConcentrationBreak': 'DND5E.CONCENTRATION.Action.Break',
  'DND5E.ArmorConfig': 'DND5E.ARMORCLASS.Action.Configure',
  'DND5E.DamageAll': 'DND5E.DAMAGE.All',
  'DND5E.DamagePhysicalBypassesShort':
    'DND5E.DAMAGE.PhysicalBypass.DescriptionShort',
  'DND5E.VehicleType': 'DND5E.VEHICLE.Type.label',
  'DND5E.VehicleActionThresholdsFull':
    'DND5E.VEHICLE.FIELDS.attributes.actions.thresholds.full.label',
  'DND5E.VehicleActionThresholdsMid':
    'DND5E.VEHICLE.FIELDS.attributes.actions.thresholds.mid.label',
  'DND5E.VehicleActionThresholdsMin':
    'DND5E.VEHICLE.FIELDS.attributes.actions.thresholds.min.label',
  'DND5E.VehicleActionsHint':
    'DND5E.VEHICLE.FIELDS.attributes.actions.max.hint',
  'DND5E.AdvancementLevelAnyHeader': 'DND5E.ADVANCEMENT.Level.Any',
  'DND5E.AdvancementLevelNoneHeader': 'DND5E.ADVANCEMENT.Level.None',
  'DND5E.AdvancementLevelHeader': 'DND5E.ADVANCEMENT.Level.Specific',
  'DND5E.AdvancementConfiguredComplete': 'DND5E.ADVANCEMENT.Config.Status.Complete',
  'DND5E.AdvancementConfiguredIncomplete':
    'DND5E.ADVANCEMENT.Config.Status.Incomplete',
  'DND5E.AdvancementModifyChoices': 'DND5E.ADVANCEMENT.Action.ModifyChoices',
  'DND5E.AdvancementClassRestrictionPrimary':
    'DND5E.ADVANCEMENT.FIELDS.classRestriction.primary',
  'DND5E.AdvancementClassRestrictionSecondary':
    'DND5E.ADVANCEMENT.FIELDS.classRestriction.secondary',
  'DND5E.ENCHANTMENT.FIELDS.enchantment.items.max.label':
    'DND5E.FEATURE.FIELDS.enchant.items.max.label',
  'DND5E.ENCHANTMENT.FIELDS.enchantment.items.max.hint':
    'DND5E.FEATURE.FIELDS.enchant.items.max.hint',
  'DND5E.ENCHANTMENT.FIELDS.enchantment.items.period.label':
    'DND5E.FEATURE.FIELDS.enchant.items.period.label',
  'DND5E.ENCHANTMENT.FIELDS.enchantment.items.period.hint':
    'DND5E.FEATURE.FIELDS.enchant.items.period.hint',
  'DND5E.ActorWarningInvalidItem': 'DND5E.ACTOR.Warning.InvalidItem',
  'DND5E.AdvancementTitle': 'DND5E.ADVANCEMENT.Label',
  'DND5E.DamagePhysicalBypasses': 'DND5E.DAMAGE.PhysicalBypass.Description',
  'DND5E.EffectUnavailableInfo': 'DND5E.EFFECT.Suppressed.Hint',
  'DND5E.SpellPreparation.Mode': 'DND5E.Preparation',
  'DOCUMENT.DND5E.Activity': 'DOCUMENT.Activity',
  Actor: 'DOCUMENT.Actor',
  Journal: 'DOCUMENT.JournalEntry',
};

/**
 * Resolves a localization key against the running system's translations.
 *
 * Order of preference (current-language translations first, English
 * fallbacks last):
 *  1. The requested key itself — older dnd5e where it still exists.
 *  2. The modern renamed key when the *current* language has it.
 *  3. `TIDY5E.Compat.<key>` — the fork's own translation (we ship ko/en).
 *  4. English fallbacks: original key, then modern key, then compat.
 *
 * dnd5e 6.x ships English only, so a non-English world would otherwise see
 * English labels for every renamed key even though the fork has translations.
 */
export function resolveLocalizationKey(key: string): string {
  const i18n = game.i18n;
  const modern = DND5E_RENAMED_LOCALIZATION_KEYS[key];
  const compat = `TIDY5E.Compat.${key}`;

  if (i18n.has(key, false)) return key;
  if (modern !== undefined && i18n.has(modern, false)) return modern;
  if (i18n.has(compat, false)) return compat;
  if (i18n.has(key)) return key;
  if (modern !== undefined && i18n.has(modern)) return modern;
  if (i18n.has(compat)) return compat;
  return key;
}

/**
 * Localizes an item's activation-type label (e.g. "Action") through the same
 * resolution chain as `resolveLocalizationKey`, so our own translations apply.
 * `item.labels.activation` is pre-baked by the system in English on systems
 * without a current-language pack, so we rebuild it from the raw type key.
 */
export function localizedActivationLabel(item: any): string {
  const fallback: string = item?.labels?.activation ?? '';
  const acts = item?.system?.activities;
  const first =
    acts?.contents?.[0] ??
    (typeof acts?.values === 'function' ? [...acts.values()][0] : undefined);
  const type: string | undefined =
    first?.activation?.type ?? item?.system?.activation?.type;
  const value = first?.activation?.value ?? item?.system?.activation?.value;
  const num = typeof value === 'number' && value > 0 ? value : undefined;
  return localizedActivationTypeLabel(type, num) ?? fallback;
}

/**
 * Builds a localized activation label from a raw activation type/value
 * (e.g. 'action', 'legendary'). Returns undefined when no key resolves so
 * callers can fall back to the system-pre-baked `labels.activation`.
 */
export function localizedActivationTypeLabel(
  type: string | undefined,
  num?: number
): string | undefined {
  if (!type) return undefined;
  const cap = type.charAt(0).toUpperCase() + type.slice(1);
  const i18n = game.i18n;
  if (num !== undefined) {
    const counted = resolveLocalizationKey(
      `DND5E.ACTIVATION.Type.${cap}.Counted.other`
    );
    if (i18n.has(counted)) {
      return i18n.format(counted, { number: num });
    }
  }
  const label = resolveLocalizationKey(`DND5E.ACTIVATION.Type.${cap}.Label`);
  if (i18n.has(label)) {
    const text = i18n.localize(label);
    return num !== undefined ? `${num}${text}` : text;
  }
  return undefined;
}

/**
 * Splits a stack of identical items into two stacks, prompting for the amount
 * when the stack is larger than two.
 *
 * dnd5e < 6.0 exported `dnd5e.applications.item.SplitStackDialog`; 6.0 keeps the
 * dialog class internal, so this shim replicates it with `DialogV2.input` —
 * same semantics: the entered amount becomes the new ("right") stack.
 */
export async function promptSplitStack(item: any): Promise<void> {
  const quantity = item.system.quantity ?? 1;
  if (quantity === 2) {
    await item.system.split();
    return;
  }

  const Dialog = dnd5e.applications?.item?.SplitStackDialog;
  if (Dialog) {
    new Dialog({ document: item }).render({ force: true });
    return;
  }

  const max = Math.max(1, quantity - 1);
  const right = quantity - Math.ceil(quantity / 2);
  const fd = await foundry.applications.api.DialogV2.input({
    window: { title: 'DND5E.SplitStack.Title' },
    content: `<input name="right" type="number" min="1" max="${max}" step="1" value="${right}" autofocus>`,
    ok: {
      label: 'DND5E.SplitStack.Action',
      icon: 'fa-solid fa-arrows-split-up-and-left',
    },
  });
  if (!fd) return;

  const amount = Math.clamp(Number(fd.right) || 0, 1, max);
  if (amount) await item.system.split(amount);
}
