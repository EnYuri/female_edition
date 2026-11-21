import test from 'node:test';
import assert from 'node:assert/strict';
import { hideCatActivityOnActor, isCatHiddenActivity, updateCatKitStatus } from '../tidy-classic/src/integration/cat.js';

test('CAT visibility follows the setting without removing stored activities', () => {
  const activity = Object.freeze({ flags: { cat: { hidden: true } } });
  const cat = { active: true };
  let hide = false;
  globalThis.game = { modules: new Map([['cat', cat]]), settings: { get(namespace, key) {
    assert.equal(namespace + '.' + key, 'cat.hideActivitiesOnActorSheet');
    return hide;
  } } };
  assert.equal(isCatHiddenActivity(activity), true);
  for (hide of [false, true, false]) assert.equal(hideCatActivityOnActor(activity), hide);
  hide = true;
  assert.equal(hideCatActivityOnActor({ flags: {} }), false);
  cat.active = false;
  assert.equal(isCatHiddenActivity(activity), false);
  assert.equal(hideCatActivityOnActor(activity), false);
});

test('CatKit uses CAT status codes on the intended Classic headers and clears stale color', () => {
  const catModule = { active: true };
  globalThis.game = { modules: new Map([['cat', catModule]]) };
  let code;
  let source;
  globalThis.cat = {
    utils: { automationUtils: { getAutomationStatus: () => code }, documentUtils: { getSource: () => source } },
    lib: { constants: {
      MEDKIT_STATUSES: { UNKNOWN: 'unknown', AVAILABLE: 'available', OUTDATED: 'outdated', UP_TO_DATE: 'up-to-date', CONFIGURABLE: 'configurable' },
      automationStatus: { UNAVAILABLE: -2, AVAILABLE: -1, OUTDATED: 0, UP_TO_DATE: 1, CONFIGURABLE: 2, GENERIC: 3 },
    } },
  };
  const button = { dataset: {} };
  const element = { classList: new Set(['classic']), querySelector: () => button };
  element.classList.contains = element.classList.has;
  const item = { documentName: 'Item' };
  for (const [value, status] of [[-1, 'available'], [0, 'outdated'], [1, 'up-to-date'], [2, 'configurable'], [3, 'configurable']]) {
    code = value;
    updateCatKitStatus(item, element);
    assert.equal(button.dataset.medkitStatus, status);
  }
  code = -2;
  source = 'module';
  updateCatKitStatus(item, element);
  assert.equal(button.dataset.medkitStatus, 'unknown');
  source = 'none';
  updateCatKitStatus(item, element);
  assert.equal(button.dataset.medkitStatus, undefined);
  updateCatKitStatus({ documentName: 'Actor', type: 'npc' }, element);
  assert.equal(button.dataset.medkitStatus, undefined);
  updateCatKitStatus({ documentName: 'Actor', type: 'character' }, element);
  assert.equal(button.dataset.medkitStatus, 'unknown');
  code = 0;
  catModule.active = false;
  updateCatKitStatus(item, element);
  assert.equal(button.dataset.medkitStatus, 'unknown');
});
