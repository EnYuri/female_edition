import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMovedItems } from '../tidy-classic/src/utils/move-items.js';
import { watchAdvancementMove } from '../tidy-classic/src/utils/advancement-move.js';
import {
  canCopyActivity,
  resolveDroppedActivity,
} from '../tidy-classic/src/foundry/activity-drop-compat.js';
import {
  matchesEffectOrigin,
  prepareDroppedEnchantment,
} from '../tidy-classic/src/foundry/enchantment-drop-compat.js';

test('a declined move keeps its source while completed moves remove only theirs', async () => {
  const calls = [];
  const items = [{ id: 'declined' }, { id: 'created' }];
  const result = await createMovedItems(
    items,
    async (item) => {
      calls.push(`create:${item.id}`);
      return item.id === 'declined'
        ? { documents: [] }
        : { documents: [{ id: 'replacement' }] };
    },
    async (item) => calls.push(`delete:${item.id}`),
  );
  assert.deepEqual(result, [{ id: 'replacement' }]);
  assert.deepEqual(calls, ['create:declined', 'create:created', 'delete:created']);
});

test('a failed creation never deletes its source', async () => {
  let deleted = false;
  await assert.rejects(
    createMovedItems([{}], async () => { throw Error('creation failed'); },
      async () => { deleted = true; }),
    /creation failed/,
  );
  assert.equal(deleted, false);
});

test('a cancelled document creation never deletes its source', async () => {
  let deleted = false;
  const result = await createMovedItems([{}], async () => ({ documents: [] }),
    async () => { deleted = true; });
  assert.deepEqual(result, []);
  assert.equal(deleted, false);
});

test('a move waits for source deletion before returning', async () => {
  let finishDelete;
  let finished = false;
  const pending = createMovedItems([{}], async () => ({ documents: [{}] }), () =>
    new Promise((resolve) => { finishDelete = resolve; }));
  pending.then(() => { finished = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  finishDelete();
  await pending;
  assert.equal(finished, true);
});

test('a confirmed stack or class transfer removes the source without new documents', async () => {
  const deleted = [];
  const items = [{ id: 'stack' }, { id: 'level-up' }, { id: 'dialog' }];
  const result = await createMovedItems(items,
    async (item) => ({ documents: [], transferred: item.id !== 'dialog' }),
    async (item) => deleted.push(item.id));
  assert.deepEqual(result, []);
  assert.deepEqual(deleted, ['stack', 'level-up']);
});

function makeHooks() {
  const listeners = new Map();
  return {
    on(name, fn) { listeners.set(name, fn); },
    off(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
    call(name, ...args) { listeners.get(name)?.(...args); },
    count() { return listeners.size; },
  };
}

test('advancement move deletes only after its own manager completes', async () => {
  const hooks = makeHooks();
  const manager = new EventTarget();
  const source = { uuid: 'Item.source', _stats: { modifiedTime: 10 },
    async delete() { this.deleted = true; } };
  watchAdvancementMove(manager, source, {
    hooks, resolveSource: async () => source,
  });
  hooks.call('dnd5e.advancementManagerComplete', new EventTarget());
  assert.equal(source.deleted, undefined);
  hooks.call('dnd5e.advancementManagerComplete', manager);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.deleted, true);
  assert.equal(hooks.count(), 0);
});

test('closing advancement without completion preserves the source and removes the listener', () => {
  const hooks = makeHooks();
  const manager = new EventTarget();
  const source = { uuid: 'Item.source', async delete() { this.deleted = true; } };
  watchAdvancementMove(manager, source, {
    hooks, resolveSource: async () => source,
  });
  manager.dispatchEvent(new Event('close'));
  hooks.call('dnd5e.advancementManagerComplete', manager);
  assert.equal(source.deleted, undefined);
  assert.equal(hooks.count(), 0);
});

test('legacy advancement close also preserves the source and cleans both hooks', () => {
  const hooks = makeHooks();
  const manager = {};
  const source = { uuid: 'Item.source', async delete() { this.deleted = true; } };
  watchAdvancementMove(manager, source, {
    hooks, resolveSource: async () => source,
  });
  hooks.call('closeAdvancementManager', manager);
  hooks.call('dnd5e.advancementManagerComplete', manager);
  assert.equal(source.deleted, undefined);
  assert.equal(hooks.count(), 0);
});

test('advancement preserves a source edited while the dialog was open', async () => {
  const hooks = makeHooks();
  const manager = new EventTarget();
  let warned = false;
  const current = { uuid: 'Item.source', _stats: { modifiedTime: 11 },
    async delete() { this.deleted = true; } };
  watchAdvancementMove(manager, { uuid: current.uuid, _stats: { modifiedTime: 10 } }, {
    hooks, resolveSource: async () => current,
    onSourceChanged: () => { warned = true; },
  });
  hooks.call('dnd5e.advancementManagerComplete', manager);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warned, true);
  assert.equal(current.deleted, undefined);
});

test('enchantment drops retain the appropriate origin for both dnd5e schemas', () => {
  const source = { id: 'effect', parent: { uuid: 'Item.source' }, origin: null };
  const oldData = { origin: null, system: {} };
  assert.deepEqual(prepareDroppedEnchantment(source, oldData), {
    enchantmentProfile: 'effect', activityId: undefined,
  });
  assert.equal(oldData.origin, 'Item.source');
  assert.equal(matchesEffectOrigin({ ...source, origin: 'Item.target' }, 'Item.target'), true);

  const modern = {
    ...source,
    matchesOrigin: (uuid) => uuid === 'Item.target',
    system: { isOnActivity: true },
    parent: { uuid: 'Item.source', system: { activities: {
      getByType: () => [{ id: 'activity', effects: [{ _id: 'effect' }] }],
    } } },
  };
  const modernData = { origin: null, transfer: false, system: { origin: { item: null } } };
  assert.equal(matchesEffectOrigin(modern, 'Item.target'), true);
  assert.deepEqual(prepareDroppedEnchantment(modern, modernData), {
    enchantmentProfile: 'effect', activityId: 'activity',
  });
  assert.equal(modernData.system.origin.item, 'Item.source');
  assert.equal(modernData.transfer, true);
  assert.equal(modernData.origin, null);
});

test('the Classic call sites use the guarded move, scroll, and enchantment paths', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const base = read('../tidy-classic/src/sheets/classic/Tidy5eActorSheetClassicV2Base.svelte.ts');
  assert.match(base, /return createMovedItems\(/);
  assert.match(base, /if \(await stacked\) this\._markCompletedMoveWithoutCreation\(\)/);
  for (const sheet of ['Tidy5eCharacterSheet', 'Tidy5eNpcSheet', 'Tidy5eKgarVehicleSheet']) {
    assert.match(read(`../tidy-classic/src/sheets/classic/${sheet}.svelte.ts`),
      /return scroll\?\.toObject\?\.\(\) \?\? false/);
  }
  assert.match(read('../tidy-classic/src/sheets/classic/Tidy5eCharacterSheet.svelte.ts'),
    /if \(updated\) this\._markCompletedMoveWithoutCreation\(\)/);
  assert.match(base, /this\._watchAdvancementMove\(manager\)/);
  assert.match(read('../tidy-classic/src/sheets/classic/Tidy5eItemSheetClassic.svelte.ts'),
    /options\.dnd5e = prepareDroppedEnchantment\(/);
});

test('activity drops resolve UUID payloads and check item compatibility', () => {
  const src = readFileSync(new URL(
    '../tidy-classic/src/sheets/classic/Tidy5eItemSheetClassic.svelte.ts',
    import.meta.url), 'utf8');
  assert.match(src, /resolveDroppedActivity\(transfer, Activity, fromUuid\)/);
  assert.match(src, /activity\.parent === source\?\.parent/);
  assert.match(src, /canCopyActivity\(config, this\.item\)/);
});

test('activity resolution accepts UUID and inline drag data', async () => {
  const fromUuid = async (uuid) => ({ uuid });
  const Activity = { fromDropData: async (data) => ({ transfer: data }) };
  assert.deepEqual(await resolveDroppedActivity({ uuid: 'Item.x.Activity.y' }, Activity, fromUuid),
    { transfer: { uuid: 'Item.x.Activity.y' } });
  assert.deepEqual(await resolveDroppedActivity({ data: { type: 'utility' } }, Activity, fromUuid),
    { transfer: { data: { type: 'utility' } } });
  assert.deepEqual(await resolveDroppedActivity({ uuid: 'Item.x.Activity.y' }, null, fromUuid),
    { uuid: 'Item.x.Activity.y' });
  assert.equal(await resolveDroppedActivity({}, null, fromUuid), null);
});

test('activity copies respect configuration and item availability', () => {
  const item = { id: 'target' };
  assert.equal(canCopyActivity(null, item), false);
  assert.equal(canCopyActivity({ configurable: false }, item), false);
  assert.equal(canCopyActivity({ configurable: true,
    documentClass: { availableForItem: () => false } }, item), false);
  assert.equal(canCopyActivity({ configurable: true,
    documentClass: { availableForItem: () => true } }, item), true);
});
