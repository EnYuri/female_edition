// Fixes ported from tidy5e-sheet 14.1.2 into the Classic fork (12.5.5 baseline).
// See docs/compat.md, "Upstream ports from tidy5e-sheet 14".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';

const SRC = new URL('../tidy-classic/src/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SRC), 'utf8');

globalThis.foundry ??= {
  utils: {
    getProperty: (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj),
  },
};

const compat = await import('../tidy-classic/src/foundry/spell-source-compat.js');

function spell5x(sourceClass) {
  return { system: { schema: { fields: { sourceClass: {} } }, sourceClass } };
}
function spell6(sourceItem, classIdentifier) {
  const system = { schema: { fields: { sourceItem: {} } }, sourceItem };
  if (classIdentifier !== undefined) {
    Object.defineProperty(system, 'classIdentifier', { get: () => classIdentifier });
  }
  return { system };
}

test('spell source class reads the right field on dnd5e 5.x and 6.0', () => {
  assert.equal(compat.getSpellSourceClass(spell5x(' wizard ')), 'wizard');
  assert.equal(compat.getSpellSourceClass(spell5x(undefined)), '');
  // 6.0: the system getter resolves subclass/feature grants up to the class.
  assert.equal(compat.getSpellSourceClass(spell6('subclass:evoker', 'wizard')), 'wizard');
  // No resolvable getter: a plain class reference is parsed, anything else is unknown.
  assert.equal(compat.getSpellSourceClass(spell6('class:cleric', '')), 'cleric');
  assert.equal(compat.getSpellSourceClass(spell6('class:cleric')), 'cleric');
  assert.equal(compat.getSpellSourceClass(spell6('subclass:evoker')), '');
  // An untyped value (dnd5e accepts it; the assignments dialog's text field writes it).
  assert.equal(compat.getSpellSourceClass(spell6('druid')), 'druid');
  assert.equal(compat.getSpellSourceClass(spell6('')), '');
  assert.equal(compat.getSpellSourceClass(null), '');
});

test('spell source class writes the key the schema accepts', () => {
  assert.deepEqual(compat.buildSpellSourceClassUpdate(spell5x(''), 'wizard'), {
    'system.sourceClass': 'wizard',
  });
  assert.deepEqual(compat.buildSpellSourceClassUpdate(spell6(''), 'wizard'), {
    'system.sourceItem': 'class:wizard',
  });
  assert.deepEqual(compat.buildSpellSourceClassUpdate(spell6('class:wizard'), ''), {
    'system.sourceItem': '',
  });
  assert.deepEqual(compat.getSpellSourceField(spell6('subclass:evoker')), {
    field: 'system.sourceItem',
    value: 'subclass:evoker',
  });
  assert.deepEqual(compat.getSpellSourceField(spell5x('bard')), {
    field: 'system.sourceClass',
    value: 'bard',
  });
});

test('class-filter auto-assignment never rewrites a system-granted source', () => {
  const granted = (spell) => compat.spellSourceIsSystemGrant(spell);
  // dnd5e 6.0's _preCreate guess (a plain class) may be replaced by the user's filter.
  assert.equal(granted(spell6('class:bard')), false);
  assert.equal(granted(spell6('')), false);
  // Subclass / feat grants are locked by dnd5e's own sheet.
  assert.equal(granted(spell6('subclass:evoker')), true);
  assert.equal(granted(spell6('feat:magic-initiate')), true);
  // Advancement grants, on either system version.
  const viaAdvancement = { ...spell6('class:wizard'), flags: { dnd5e: { advancementOrigin: 'x.y' } } };
  assert.equal(granted(viaAdvancement), true);
  assert.equal(granted({ ...spell5x('wizard'), flags: { dnd5e: { advancementOrigin: 'x.y' } } }), true);
  assert.equal(granted(spell5x('wizard')), false);
});

test('the create hook acts only for the creating user and respects grants', () => {
  const src = read('features/ready-hooks.ts');
  assert.match(src, /Hooks\.on\('createItem', \(item: any, _options: unknown, userId: string\)/);
  assert.match(src, /if \(userId !== game\.user\?\.id\) \{\s*return;/);
  assert.match(src, /!spellSourceIsSystemGrant\(item\) &&\s*getSpellSourceClass\(item\) !== filter/);
  assert.match(src, /item\.update\(buildSpellSourceClassUpdate\(item, filter\)\)/);
});

test('class icons are keyed by class identifier as well as by name', () => {
  const src = read('sheets/classic/Tidy5eCharacterSheet.svelte.ts');
  const fn = src.slice(src.indexOf('function getActorClassesToImages'));
  assert.match(fn, /const identifier = item\.identifier \?\? item\.system\?\.identifier;/);
  assert.match(fn, /if \(identifier\) actorClassesToImages\[identifier\] = classImg;/);
});

function walk(dirUrl, out = []) {
  for (const name of readdirSync(dirUrl)) {
    const url = new URL(name, dirUrl);
    if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dirUrl), out);
    else if (/\.(ts|svelte)$/.test(name)) out.push(url);
  }
  return out;
}

test('no Classic code reads or writes sourceClass outside the shim', () => {
  // The item sheet's spell tab branches on the schema itself (its own `usesSourceItem`),
  // so its 5.x-only branch is the one legitimate direct use.
  const allowed = new Set(['sheets/classic/item/tabs/ItemSpellDetailsTab.svelte']);
  const offenders = [];
  for (const url of walk(SRC)) {
    const rel = url.pathname.slice(SRC.pathname.length);
    if (/quadrone/i.test(rel) || allowed.has(rel)) continue;
    const text = readFileSync(url, 'utf8');
    if (/system\.sourceClass\b/.test(text)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('activity lists filter on dnd5e 6.0 display visibility, not usability', () => {
  const src = read('features/activities/activities.ts');
  assert.match(src, /'isHidden' in activity \? !activity\.isHidden : activity\.canUse/);
  const visible = src.slice(src.indexOf('static getVisibleActivities'));
  assert.match(visible, /Activities\.isActivityVisible\(a\)/);
  assert.doesNotMatch(visible.slice(0, visible.indexOf('return visibleActivities')), /a\.canUse/);
});
