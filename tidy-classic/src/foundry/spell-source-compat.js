// Spell source-class shims (dnd5e 5.x `sourceClass` vs 5.3+/6.0 `sourceItem`).
// Plain JS on purpose: ci/ runs on Node 20, which cannot import a .ts file, and the
// behavioural tests import this module directly. dnd5e-compat.ts re-exports it.

/**
 * Whether a spell stores its source as dnd5e 5.3+'s `system.sourceItem`.
 *
 * dnd5e 5.3 replaced the spell's `sourceClass` (a bare class identifier) with
 * `sourceItem` (`"<type>:<identifier>"`, e.g. `class:wizard` or `subclass:evoker`) and
 * migrated the stored value (`SpellData.#migrateSourceItem`). Unlike rarity there is NO
 * getter left behind: `system.sourceClass` reads `undefined`, and an update naming it is
 * dropped by `cleanData` — core's `updateSource` never runs `migrateData`, so the key is
 * not translated either. Every Classic multiclass feature (class spellbook filter, the
 * source-class filter group, class icons, the actions tab label, auto-assignment on
 * create, the assignments dialog) went silently dead on 6.0 because of that.
 *
 * Probed on the schema, like rarity, so a partially migrated world answers correctly.
 */
export function spellUsesSourceItem(spell) {
  return !!spell?.system?.schema?.fields?.sourceItem;
}

/**
 * The identifier of the spellcasting CLASS a spell belongs to, or `''`.
 *
 * On 6.0 this is the system's own `classIdentifier` getter, which resolves a subclass-
 * or feature-granted spell up to its class — the same key `actor.classes` and
 * `actor.spellcastingClasses` use, which is what every Classic consumer compares against.
 * Where that getter is missing (a 5.3+ build without it, or a spell whose actor cannot
 * resolve the item) a plain `class:<id>` reference is parsed directly.
 */
export function getSpellSourceClass(spell) {
  const system = spell?.system;
  if (!system) return '';
  if (!spellUsesSourceItem(spell)) {
    return typeof system.sourceClass === 'string' ? system.sourceClass.trim() : '';
  }
  const resolved = system.classIdentifier;
  if (typeof resolved === 'string' && resolved !== '') return resolved;
  const sourceItem = typeof system.sourceItem === 'string' ? system.sourceItem.trim() : '';
  if (sourceItem.startsWith('class:')) return sourceItem.slice('class:'.length);
  // dnd5e accepts an untyped value too (`IdentifiedItemsMap#get` then matches any type);
  // the assignments dialog's free-text field produces exactly that, and its hint asks for
  // a class identifier.
  return sourceItem.includes(':') ? '' : sourceItem;
}

/**
 * Whether a spell's source must be left alone by Classic's class-filter auto-assignment.
 *
 * True for anything the SYSTEM granted: an advancement grant (`advancementOrigin`), or on
 * 6.0 a non-class source (`subclass:…`, `feat:…`) — dnd5e's own sheet locks those
 * (`sourceItemLocked`), and rewriting one to `class:<id>` detaches the spell from the
 * feature that granted it. A plain `class:` value is NOT protected: dnd5e's `_preCreate`
 * guesses one from the actor's classes and the spell lists before `createItem` fires, and
 * the class the user picked in the spellbook filter is a better answer than that guess.
 */
export function spellSourceIsSystemGrant(spell) {
  if (foundry.utils.getProperty(spell ?? {}, 'flags.dnd5e.advancementOrigin')) {
    return true;
  }
  if (!spellUsesSourceItem(spell)) return false;
  const sourceItem =
    typeof spell.system.sourceItem === 'string' ? spell.system.sourceItem.trim() : '';
  return sourceItem.includes(':') && !sourceItem.startsWith('class:');
}

/** The raw stored source reference, as the free-text identifier field edits it. */
export function getSpellSourceField(spell) {
  const field = spellUsesSourceItem(spell)
    ? 'system.sourceItem'
    : 'system.sourceClass';
  const value = foundry.utils.getProperty(spell ?? {}, field);
  return { field, value: typeof value === 'string' ? value : '' };
}

/** The update payload that assigns a spell to a class (`''` clears it). */
export function buildSpellSourceClassUpdate(spell, classIdentifier) {
  const id = classIdentifier?.trim() ?? '';
  if (spellUsesSourceItem(spell)) {
    return { 'system.sourceItem': id ? `class:${id}` : '' };
  }
  return { 'system.sourceClass': id };
}
