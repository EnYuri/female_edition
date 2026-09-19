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
