import test from 'node:test';
import assert from 'node:assert/strict';
import { hideActivityShortcut } from '../tidy-classic/src/integration/activity-shortcuts.js';
import { classicActorDropBehavior, quickInsertSection, registerClassicQuickInsert } from '../tidy-classic/src/integration/quick-insert.js';

test('midi-only shortcuts can be restored and unusable facility orders stay visible', () => {
  const midi = { active: true };
  globalThis.game = { modules: new Map([['midi-qol', midi]]) };
  const activity = { midiProperties: { automationOnly: true } };
  assert.equal(hideActivityShortcut(activity), true);
  activity.midiProperties.automationOnly = false;
  assert.equal(hideActivityShortcut(activity), false);
  assert.equal(hideActivityShortcut({ canUse: false, inProgress: true }), false);
  midi.active = false;
  activity.midiProperties.automationOnly = true;
  assert.equal(hideActivityShortcut(activity), false);
});

test('Quick Insert fallback leaves native registration to either Tidy provider', () => {
  const modules = new Map([['quick-insert', { active: true }]]);
  globalThis.game = { modules };
  const commands = [];
  const api = { config: { actorItem: { registerSectionCommands(entries) { commands.push(...entries); } } } };
  for (const active of [true, false]) {
    modules.set('tidy5e-sheet', { active });
    registerClassicQuickInsert(api);
  }
  modules.delete('tidy5e-sheet');
  modules.set('tidy5e-sheet-kgar', { api: {} });
  registerClassicQuickInsert(api);
  modules.delete('tidy5e-sheet-kgar');
  modules.get('quick-insert').active = false;
  registerClassicQuickInsert(api);
  assert.equal(commands.length, 0);
  modules.get('quick-insert').active = true;
  registerClassicQuickInsert(api);
  assert.equal(commands.length, 1);
});

test('Quick Insert uses the clicked sheet, its item filter and the configured permissions', () => {
  let filtersEnabled = true;
  globalThis.game = {
    modules: new Map([['quick-insert', { active: true }]]),
    settings: { get: (id, key) => id === 'quick-insert' && key === 'filtersSheetsEnabled' && filtersEnabled },
  };
  const actor = { type: 'character', isOwner: true };
  const sheet = { document: actor, isEditable: true };
  globalThis.foundry = { applications: { instances: new Map([['sheet-id', sheet]]) } };
  const anchor = { closest: () => ({ id: 'sheet-id' }) };
  const opened = [];
  globalThis.QuickInsert = { open: ctx => opened.push(ctx) };
  let command;
  registerClassicQuickInsert({ config: { actorItem: { registerSectionCommands: entries => { [command] = entries; } } } });
  assert.equal(command.enabled({ actor }), false);
  globalThis.QuickInsert.systemIntegration = { Dnd5eSheetContext: class {
    constructor(...args) { this.args = args; }
  } };
  for (actor.type of ['character', 'npc', 'vehicle']) assert.equal(command.enabled({ actor }), true);
  assert.equal(command.enabled({ actor: { type: 'group', isOwner: true } }), false);
  assert.equal(command.enabled({ actor: { type: 'character', isOwner: false } }), false);
  filtersEnabled = false;
  assert.equal(command.enabled({ actor }), false);
  filtersEnabled = true;
  const params = { actor, event: { currentTarget: anchor }, section: { dataset: { type: 'spell', system: { level: 3 } } } };
  command.execute(params);
  const [target, position, types, system] = opened[0].args;
  assert.equal(target, sheet);
  assert.equal(position.get()[0], anchor);
  assert.deepEqual(types, ['spell']);
  assert.deepEqual(system, { level: 3 });
  command.execute({ ...params, section: {} });
  assert.equal(opened[1].args[2], undefined);
  for (const types of [['weapon', 'equipment'], ['feat'], []]) {
    command.execute({ ...params, section: { dataset: {}, custom: { creationItemTypes: types } } });
    assert.deepEqual(opened.at(-1).args[2], types.length ? types : undefined);
  }
  sheet.isEditable = false;
  command.execute(params);
  assert.equal(opened.length, 5);
});

test('synthetic item insertion copies even with a stale drag state, while native drops keep their behavior', () => {
  const module = { active: true };
  globalThis.game = { modules: new Map([['quick-insert', module]]) };
  const allowed = new Set(['copy']);
  const sheet = { _dropBehavior: () => 'move', _allowedDropBehaviors: () => allowed };
  const event = { dataTransfer: { dropEffect: 'none' }, target: { matches: () => true } };
  const item = { type: 'Item', uuid: 'Item.sword' };
  assert.equal(classicActorDropBehavior(sheet, event, item), 'copy');
  assert.equal(classicActorDropBehavior(sheet, { ...event, type: 'drop' }, item), 'move');
  assert.equal(classicActorDropBehavior(sheet, event, { type: 'Actor', uuid: 'Actor.a' }), 'move');
  assert.equal(classicActorDropBehavior(sheet, { ...event, target: {} }, item), 'move');
  allowed.clear();
  assert.equal(classicActorDropBehavior(sheet, event, item), 'none');
  module.active = false;
  assert.equal(classicActorDropBehavior(sheet, event, item), 'move');
});

test('Classic spellbook sections provide Quick Insert search filters without changing creation data', () => {
  const actor = { system: { spells: { pact: { level: 4 } } } };
  for (const level of [0, 3]) {
    const dataset = Object.freeze({ type: 'spell', 'system.level': level });
    assert.deepEqual(quickInsertSection({ dataset, slot: 'spell' + level }, actor).dataset.system, { level });
  }
  const spell = { dataset: { type: 'spell', 'system.level': 1 } };
  assert.deepEqual(quickInsertSection({ ...spell, slot: 'pact' }, actor).dataset.system, { level: { min: 1, max: 4 } });
  assert.equal(quickInsertSection({ ...spell, slot: 'innate' }, actor).dataset.system, undefined);
  const custom = { custom: { creationItemTypes: ['spell'] }, dataset: {} };
  assert.equal(quickInsertSection(custom, actor).dataset.type, 'spell');
  const weapon = { dataset: { type: 'weapon' } };
  assert.equal(quickInsertSection(weapon, actor), weapon);
});
