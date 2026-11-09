import test from 'node:test';
import assert from 'node:assert/strict';
import {
  installTidyApiBridge,
} from '../tidy-classic/src/integration/tidy-api-bridge.js';

test('the official API remains public while its supported registrations reach Classic', () => {
  const calls = [];
  const module = { active: true };
  const classicApi = {
    registerItemHeaderControls(params) { calls.push(['classic-header', params]); },
    config: { actorItem: {
      registerSectionCommands(commands) { calls.push(['classic-command', commands]); },
    } },
  };
  assert.equal(installTidyApiBridge(module, classicApi), true);

  const officialApi = {
    registerItemHeaderControls(params) {
      assert.equal(this, officialApi);
      calls.push(['official-header', params]);
      return 'official-result';
    },
    config: { actorItem: {
      registerSectionCommands(commands) {
        calls.push(['official-command', commands]);
      },
    } },
  };
  module.api = officialApi; // Tidy does this before calling tidy5e-sheet.ready.
  assert.equal(module.api, officialApi);

  const controls = { controls: [{ label: 'DAE' }] };
  assert.equal(module.api.registerItemHeaderControls(controls), 'official-result');
  const commands = [{ id: 'quick-insert' }];
  module.api.config.actorItem.registerSectionCommands(commands);
  assert.deepEqual(calls, [
    ['official-header', controls], ['classic-header', controls],
    ['official-command', commands], ['classic-command', commands],
  ]);

  // Re-publishing the same API does not add another mirror wrapper.
  module.api = officialApi;
  module.api.registerItemHeaderControls(controls);
  assert.equal(calls.filter(([name]) => name === 'classic-header').length, 2);
});

test('an inactive Tidy module is never trapped', () => {
  const module = { active: false };
  assert.equal(installTidyApiBridge(module, {}), false);
  assert.equal(Object.hasOwn(module, 'api'), false);
});

test('a Classic registration failure does not change the official API result', () => {
  const warnings = [];
  const module = { active: true };
  const classicApi = {
    registerItemHeaderControls() { throw Error('Classic failure'); },
  };
  installTidyApiBridge(module, classicApi, (...args) => warnings.push(args));
  module.api = { registerItemHeaderControls() { return 42; } };
  assert.equal(module.api.registerItemHeaderControls({ controls: [] }), 42);
  assert.equal(warnings.length, 1);
});

// midi-qol registers item-summary commands on whichever API is published; with official
// Tidy active, Classic used to miss them. The singular actor-trait helper must reach
// Classic exactly once (upstream routes it through the plural method).
test('layout-agnostic config registrations reach Classic, each exactly once', () => {
  const calls = [];
  const module = { active: true };
  const classicApi = { config: {
    itemSummary: { registerCommands(c) { calls.push(['classic-summary', c]); } },
    actorPortrait: { registerMenuCommands(c) { calls.push(['classic-portrait', c]); } },
    actorTraits: {
      registerActorTraits(t) { calls.push(['classic-traits', t]); },
      registerActorTrait(t) { this.registerActorTraits([t]); },
    },
    item: { registerCustomEquipmentTypeGroup(g) { calls.push(['classic-equip', g]); } },
  } };
  installTidyApiBridge(module, classicApi);
  const officialApi = { config: {
    itemSummary: { registerCommands(c) { calls.push(['official-summary', c]); } },
    actorPortrait: { registerMenuCommands() { calls.push(['official-portrait-noop']); } },
    actorTraits: {
      registerActorTraits(t) { calls.push(['official-traits', t]); },
      registerActorTrait(t) { this.registerActorTraits([t]); },
    },
    item: { registerCustomEquipmentTypeGroup(g) { calls.push(['official-equip', g]); } },
  } };
  module.api = officialApi;

  const midi = [{ label: 'midi-qol.buttons.roll' }];
  module.api.config.itemSummary.registerCommands(midi);
  module.api.config.actorPortrait.registerMenuCommands(['p']);
  module.api.config.actorTraits.registerActorTrait({ title: 't' });
  module.api.config.item.registerCustomEquipmentTypeGroup({ label: 'g' });

  assert.deepEqual(calls, [
    ['official-summary', midi], ['classic-summary', midi],
    ['official-portrait-noop'], ['classic-portrait', ['p']],
    ['official-traits', [{ title: 't' }]], ['classic-traits', [{ title: 't' }]],
    ['official-equip', { label: 'g' }], ['classic-equip', { label: 'g' }],
  ]);
});
