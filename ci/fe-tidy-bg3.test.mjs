import test from 'node:test';
import assert from 'node:assert/strict';
import { bg3CommonActionSection } from '../tidy-classic/src/integration/bg3-common-actions.js';

test('only saved first-bar slots belonging to Chris premades supply a Classic section', () => {
  const modules = new Map(['bg3-inspired-hotbar', 'chris-premades'].map(id => [id, { active: true }]));
  globalThis.game = { modules };
  const uuid = 'Actor.a.Item.b';
  const actor = { getFlag: (id, key) => {
    assert.equal(id + '.' + key, 'bg3-inspired-hotbar.containersConfig');
    return { combat: [{ items: { 0: null, 3: { uuid } } }, { items: [{ uuid: 'other' }] }] };
  } };
  const item = Object.freeze({ uuid, actor, getFlag: () => ({ source: 'chris-premades' }) });
  assert.equal(bg3CommonActionSection(item), 'CHRISPREMADES.Generic.Actions');
  assert.equal(bg3CommonActionSection({ ...item, uuid: 'other' }), undefined);
  assert.equal(bg3CommonActionSection({ ...item, getFlag: () => ({ source: 'world' }) }), undefined);
  assert.equal(bg3CommonActionSection({ ...item, actor: null }), undefined);
  modules.set('tidy5e-sheet', { active: true });
  assert.equal(bg3CommonActionSection(item), undefined);
  modules.delete('tidy5e-sheet');
  modules.get('bg3-inspired-hotbar').active = false;
  assert.equal(bg3CommonActionSection(item), undefined);
});
