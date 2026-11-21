import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isAntimagicItem } from '../tidy-classic/src/features/item/antimagic.js';

const bundle = readFileSync(new URL('../tidy-classic/dist/tidy-classic.js', import.meta.url), 'utf8');

test('both Classic drop paths deliver full documents and can veto a move before any writes', async () => {
  const handlers = [...bundle.matchAll(/^ {4}async _onDropItemCreate\([^\n]+\n[\s\S]*?^ {4}\}/gm)]
    .map(match => match[0]).filter(body => body.includes('TidyHooks.dnd5eDropCreateItems'));
  assert.equal(handlers.length, 2);
  for (const handler of handlers) {
    const source = { type: 'class', system: { container: null }, toObject() { return {}; } };
    const event = { _behavior: 'move' };
    let allow = false;
    let calls = 0;
    let writes = 0;
    const hooks = { dnd5eDropCreateItems(sheet, items, options) {
      calls++;
      assert.equal(sheet, app);
      assert.equal(items[0], source);
      assert.equal(options.event, event);
      assert.equal(options.behavior, 'move');
      options.behavior = 'copy';
      return allow;
    } };
    const itemClass = {
      createWithContents(items) { assert.equal(items[0], source); return items; },
      createDocuments(items) { writes++; return items; },
    };
    const Sheet = Function('TidyHooks', 'hasAdvancement', 'dnd5e', `return class {
      #pendingMoveSource;
      #completedMoveWithoutCreation;
      actor = {};
      ${handler}
    }`)(hooks, () => false, { documents: { Item5e: itemClass } });
    const app = new Sheet();
    assert.deepEqual(await app._onDropItemCreate(source, event), []);
    assert.equal(writes, 0);
    allow = true;
    assert.deepEqual(await app._onDropItemCreate([source], event), [source]);
    assert.equal(writes, 1);
    assert.equal(calls, 2);
  }
});

test('Classic antimagic presentation recognizes spells, scrolls, magic items and magic-dependent activities', () => {
  assert.ok(isAntimagicItem({ type: 'spell', system: {} }));
  assert.ok(isAntimagicItem({ type: 'consumable', system: { type: { value: 'scroll' } } }));
  assert.ok(isAntimagicItem({ type: 'weapon', system: { properties: new Set(['mgc']) } }));
  assert.ok(isAntimagicItem({ type: 'feat', system: { activities: [{ visibility: { requireMagic: true } }] } }));
  assert.equal(isAntimagicItem({ type: 'equipment', system: {} }), false);
  assert.equal(isAntimagicItem(null), false);
});

test('rider tooltips use activity metadata when present and the enchant type on older systems', () => {
  const method = bundle.match(/^ {2}static getRiderEffectParentNames\(item\) \{[\s\S]*?^ {2}\}/m)?.[0];
  assert.ok(method);
  const Helper = Function(`return class { ${method} }`)();
  const effects = [{ _id: 'parent', riders: { effect: ['child'] } }];
  const item = {
    effects: new Map([['parent', { name: 'Source' }]]),
    system: { activities: [
      { type: 'custom', metadata: { hasRiders: true }, effects },
      { type: 'enchant', metadata: { hasRiders: false }, effects },
      { type: 'utility', effects },
    ] },
  };
  assert.deepEqual(Helper.getRiderEffectParentNames(item), { child: ['Source'] });
  item.system.activities = [{ type: 'enchant', effects }];
  assert.deepEqual(Helper.getRiderEffectParentNames(item), { child: ['Source'] });
});
