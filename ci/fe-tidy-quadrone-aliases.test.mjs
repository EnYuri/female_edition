import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  QUADRONE_READY_ALIAS_KEYS,
  withQuadroneReadyAliases,
} from '../tidy-classic/src/integration/quadrone-ready-aliases.js';

// Resolve a Plutonium-style libWrapper target the way libWrapper does: walk the path,
// then find the (possibly inherited) property on the final object.
function resolve(root, path) {
  // Bracketed keys contain dots ("dnd5e.Tidy5e…"), so take them whole.
  const parts = [...path.matchAll(/\["([^"]+)"\]|([^.[\]]+)/g)].map((m) => m[1] ?? m[2]);
  const name = parts.pop();
  let obj = root;
  for (const p of parts) obj = obj?.[p];
  return { obj, name, exists: obj != null && name in Object(obj) };
}

function buildWorld() {
  class Base { async _onDrop() { return 'base'; } }
  class Character extends Base { async _onDrop() { return 'character'; } }
  class Npc extends Base {}
  class Group extends Base {}
  class Encounter extends Base {}
  const CONFIG = { Actor: { sheetClasses: { character: {}, npc: {}, group: {}, encounter: {} } } };
  return { CONFIG, classic: { character: Character, npc: Npc, group: Group, encounter: Encounter } };
}

test('Plutonium Quadrone paths resolve to Classic only during the ready dispatch', () => {
  const { CONFIG, classic } = buildWorld();
  const k = QUADRONE_READY_ALIAS_KEYS;
  const findItem = `CONFIG.Actor.sheetClasses.character["${k.character}"].cls.prototype.findItem`;
  const drops = Object.entries(k).map(([type, key]) =>
    [type, `CONFIG.Actor.sheetClasses.${type}["${key}"].cls.__proto__.prototype._onDrop`]);

  assert.equal(resolve({ CONFIG }, findItem).exists, false); // the throw Plutonium hit

  withQuadroneReadyAliases(CONFIG.Actor.sheetClasses, classic, () => {
    assert.equal(resolve({ CONFIG }, findItem).exists, true);
    for (const [type, path] of drops) {
      const { obj, exists } = resolve({ CONFIG }, path);
      assert.equal(exists, true, type);
      assert.equal(obj, classic[type].prototype, `${type} drop patch lands on the Classic sheet`);
    }
    // Never listed by the sheet picker.
    assert.deepEqual(Object.keys(CONFIG.Actor.sheetClasses.character), []);
  });

  for (const [type, key] of Object.entries(k)) {
    assert.equal(Object.hasOwn(CONFIG.Actor.sheetClasses[type], key), false, `${type} alias removed`);
  }
});

test('aliases are removed even when a listener throws, and real Quadrone keys are untouched', () => {
  const { CONFIG, classic } = buildWorld();
  const real = { id: QUADRONE_READY_ALIAS_KEYS.npc, cls: class Quadrone {} };
  CONFIG.Actor.sheetClasses.npc[real.id] = real;
  assert.throws(() => withQuadroneReadyAliases(CONFIG.Actor.sheetClasses, classic, () => {
    assert.equal(CONFIG.Actor.sheetClasses.npc[real.id], real);
    throw new Error('listener');
  }), /listener/);
  assert.equal(Object.hasOwn(CONFIG.Actor.sheetClasses.character, QUADRONE_READY_ALIAS_KEYS.character), false);
  assert.equal(CONFIG.Actor.sheetClasses.npc[real.id], real);
});

test('the sole-provider ready hook dispatches through the aliases', () => {
  const src = readFileSync(new URL('../tidy-classic/src/main.svelte.ts', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('if (!upstreamTidy?.active)'), src.indexOf("Hooks.callAll('female_edition.tidyClassicReady'"));
  assert.match(block, /withQuadroneReadyAliases\([\s\S]*\(\) => TidyHooks\.tidy5eSheetsReady\(api\)/);
  assert.doesNotMatch(block.replace(/\(\) => TidyHooks\.tidy5eSheetsReady\(api\)/, ''), /TidyHooks\.tidy5eSheetsReady/);
});
