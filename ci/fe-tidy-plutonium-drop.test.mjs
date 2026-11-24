import { createLootTurns } from '../tidy-classic/src/integration/plutonium-loot-turns.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePlutoniumSheetDrop, isPlutoniumSheetDrop } from '../tidy-classic/src/integration/plutonium-drop.js';

function setup(api = {}) {
  const modules = new Map([
    ['tidy5e-sheet', { active: true }],
    ['plutonium', { active: true, api }],
  ]);
  const user = { id: 'owner' };
  globalThis.game = { modules, user, users: { activeGM: user } };
  return { isEditable: true, actor: { isOwner: true, system: { currency: { gp: 2 } } } };
}

const hover = { type: 'Item', subType: 'srd5e.Hover', page: 'spells.html', source: 'PHB', hash: 'spell_phb' };

test('only recognizes Plutonium item, loot and flagged journal drops in coexistence mode', () => {
  setup();
  assert.ok(isPlutoniumSheetDrop(hover));
  assert.ok(isPlutoniumSheetDrop({ ...hover, subType: 'srd5e.Import' }));
  assert.equal(isPlutoniumSheetDrop({ type: 'Item', uuid: 'Item.abc' }), false);
  assert.equal(isPlutoniumSheetDrop({ type: 'JournalEntryPage' }), false);
  assert.ok(isPlutoniumSheetDrop({ type: 'JournalEntryPage' }, { flags: { plutonium: { type: 'loot' } } }));
  globalThis.game.modules.get('tidy5e-sheet').active = false;
  assert.equal(isPlutoniumSheetDrop(hover), false);
});

test('hands one temporary item to Classic and respects sheet permissions', async () => {
  const sheet = setup();
  const item = { documentName: 'Item', getFlag: () => false };
  let conversions = 0;
  globalThis.Item = { implementation: { fromDropData: async () => { conversions++; return item; } } };
  const calls = [];
  sheet._onDropItemCreate = (...args) => calls.push(args);
  const event = {};
  await handlePlutoniumSheetDrop(sheet, event, hover);
  sheet.actor.isOwner = false;
  await handlePlutoniumSheetDrop(sheet, event, hover);
  assert.equal(conversions, 1);
  assert.deepEqual(calls, [[item, event, 'copy']]);
});

function lootFixture() {
  const notes = [];
  const writes = [];
  const imports = [];
  let failure;
  function item(parent, data) {
    return { id: data._id, parent, data, toObject: () => structuredClone(data) };
  }
  function makeActor() {
    const actor = { uuid: 'Actor.loot', getFlag: () => actor.revision, isOwner: true, system: { currency: { gp: 2 } }, items: new Map(), effects: new Map() };
    actor.items.set('existing', item(actor, { _id: 'existing', quantity: 1 }));
    actor.toObject = () => ({ items: [...actor.items.values()].map(doc => doc.toObject()), effects: [] });
    return actor;
  }
  class Importer {
    static FOLDER_TYPE = 'Item';
    async pImportEntry(entity, opts, { quantity }) {
      assert.notEqual(opts.actor, live);
      imports.push([entity.name, opts.isSpellScroll, quantity]);
      const existing = opts.actor.items.get(entity.name);
      if (existing) existing.data.quantity += quantity;
      else opts.actor.items.set(entity.name, item(opts.actor, { _id: entity.name, quantity }));
      if (entity.name === 'scroll' && failure) {
        if (failure === 'throw') throw Error('import failed after writing');
        return { status: Symbol('taskExitCancelled') };
      }
    }
    async pImportCurrency(coins, { actor }) {
      assert.notEqual(actor, live);
      actor.items.set('coins', item(actor, { _id: 'coins', gp: coins.gp }));
    }
  }
  class ImportOpts { constructor(opts) { Object.assign(this, opts); } }
  const sheet = setup({ importer: { ImportOpts, pGetImporter: async () => new Importer() },
    config: { getValue: () => true } });
  const live = sheet.actor = makeActor();
  live.clone = () => {
    const clone = makeActor();
    for (const doc of live.items.values()) clone.items.set(doc.id, item(clone, doc.toObject()));
    return clone;
  };
  live.update = async data => {
    writes.push(data);
    live.revision = data['flags.female_edition.classicLootRevision'];
    for (const d of data.items ?? []) {
      live.items.set(d._id, item(live, { ...live.items.get(d._id)?.data, ...d }));
    }
    if ('system.currency.gp' in data) live.system.currency.gp = data['system.currency.gp'];
    return live;
  };
  globalThis.CONFIG = { DND5E: { currencies: { gp: {} } } };
  globalThis.ui = { notifications: { error: msg => notes.push(msg) } };
  globalThis.foundry = { utils: {
    randomID: () => crypto.randomUUID(),
    equals: (a,b) => JSON.stringify(a) === JSON.stringify(b),
    diffObject: (a,b) => Object.fromEntries(Object.entries(b).filter(([k,v]) => a[k] !== v)),
  } };
  const loot = { currency: { gp: 3 }, entityInfos: [
    { page: 'items.html', entity: { name: 'existing' }, options: { quantity: 4 } },
    { page: 'spells.html', entity: { name: 'scroll' }, options: { quantity: 2, isSpellScroll: true } },
  ] };
  return { live, writes, notes, imports, fail: mode => { failure = mode; },
    journal: () => handlePlutoniumSheetDrop(sheet, {}, { type: 'JournalEntryPage' }, { flags: { plutonium: { type: 'loot', loot } } }),
    drop: (data = loot) => handlePlutoniumSheetDrop(sheet, {}, { type: 've-Loot', data }),
  };
}

test('failed or cancelled loot leaves no partial currency or items, then retries in one actor write', async t => {
  t.mock.method(console, 'error', () => {});
  const f = lootFixture();
  for (const mode of ['throw', 'cancel']) {
    f.fail(mode);
    await f.drop();
    assert.equal(f.writes.length, 0);
    assert.equal(f.live.items.get('existing').data.quantity, 1);
    assert.equal(f.live.system.currency.gp, 2);
  }
  assert.equal(f.notes.length, 2);
  f.fail(null);
  await f.journal();
  assert.equal(f.writes.length, 1);
  assert.equal(f.live.items.get('existing').data.quantity, 5);
  assert.equal(f.live.items.get('scroll').data.quantity, 2);
  assert.deepEqual(f.imports.at(-1), ['scroll', true, 2]);
  assert.equal(f.live.system.currency.gp, 5);
});

test('currency-only and empty loot skip actor staging unless coins are embedded items', async t => {
  const f = lootFixture();
  const clone = t.mock.method(f.live, 'clone');
  await f.drop({ currency: { gp: 0, unknown: 2 } });
  assert.equal(f.writes.length, 0);
  await f.drop({ currency: { gp: 3 } });
  assert.equal(f.live.system.currency.gp, 5);
  assert.equal(f.writes.length, 1);
  assert.equal(clone.mock.callCount(), 0);
  f.live.type = 'npc';
  await f.drop({ currency: { gp: 4 } });
  assert.equal(clone.mock.callCount(), 1);
  assert.equal(f.live.system.currency.gp, 5);
  assert.equal(f.live.items.get('coins').data.gp, 4);
  assert.deepEqual(f.notes, []);
});

test('overlapping local drops see the preceding commit; NPC currency stays an item', async () => {
  const f = lootFixture();
  await Promise.all([f.drop(), f.drop()]);
  assert.equal(f.live.system.currency.gp, 8);
  assert.equal(f.live.items.get('existing').data.quantity, 9);
  const npc = lootFixture();
  npc.live.type = 'npc';
  await npc.drop();
  assert.equal(npc.writes.length, 1);
  assert.equal(npc.live.items.get('coins').data.gp, 3);
  assert.equal(npc.live.system.currency.gp, 2);
});

test('forced imports use the Plutonium importer on the receiving actor', async () => {
  let imported;
  class Importer {
    static FOLDER_TYPE = 'Item';
    pImportEntry(entity, opts) {
      if (opts.isTemp) return { getPrimaryDocument: () => ({ clone: () => ({ documentName: 'Item' }), documentName: 'Item' }) };
      imported = [entity, opts.actor];
    }
  }
  class ImportOpts { constructor(opts) { Object.assign(this, opts); } }
  const sheet = setup({ config: { getValue: () => false }, importer: { ImportOpts, pGetImporter: async () => new Importer() } });
  sheet._onDropItemCreate = async (item, event, behavior, finish) => {
    assert.equal(item.documentName, 'Item');
    assert.equal(behavior, 'copy');
    await finish();
  };
  const entity = { name: 'Light', __prop: 'spell' };
  globalThis.DataLoader = { pCacheAndGet: async () => entity };
  await handlePlutoniumSheetDrop(sheet, {}, { ...hover, isDragDropForcePlutoniumImport: true });
  assert.deepEqual(imported, [entity, sheet.actor]);
});

test('a player and GM share one loot queue across delayed actor replicas', async () => {
  globalThis.game = { time: { get serverTime() { return Date.now(); } } };
  globalThis.foundry = { utils: { randomID: () => crypto.randomUUID() } };
  const users = [{ id: 'gm' }, { id: 'player' }];
  const actors = users.map(() => ({
    uuid: 'Actor.shared', documentName: 'Actor', isOwner: true, gp: 2, quantity: 1,
    revision: null, getFlag() { return this.revision; },
    testUserPermission: user => users.some(owner => owner.id === user.id),
  }));
  const queries = [{}, {}];
  const address = (sender, target) => ({
    id: users[target].id,
    query: (name, data) => queries[target][name](structuredClone(data), { user: address(target, sender) }),
  });
  const clients = users.map((user, i) => {
    const turns = createLootTurns(() => user, () => address(i, 0), () => actors[i]);
    turns.register(queries[i]);
    return turns;
  });
  const addLoot = i => clients[i].run(actors[i], async (id, check) => {
    const next = { gp: actors[i].gp + 3, quantity: actors[i].quantity + 4, revision: id };
    await new Promise(resolve => setTimeout(resolve, 5));
    check();
    Object.assign(actors[i], next);
    setTimeout(() => Object.assign(actors[1-i], next), 15);
    return id;
  });
  await Promise.all([addLoot(1), addLoot(0), addLoot(1)]);
  assert.deepEqual(actors.map(actor => [actor.gp, actor.quantity]), [[11, 13], [11, 13]]);
  await assert.rejects(queries[0]['female_edition.classicLootRequest'](
    { uuid: 'Actor.shared', id: 'unknown' }, { user: { id: 'stranger' } }));
});
