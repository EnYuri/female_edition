import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../tidy-classic/', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const bundle = read('dist/tidy-classic.js');

test('a GM can open Bastions on a new Classic group while player level and world settings still apply', () => {
  const groupTab = bundle.slice(bundle.indexOf('component: GroupBastionsTab,'));
  const enabled = groupTab.match(/enabled: (\(context\) => \{[\s\S]*?\n {4}\}),/);
  assert.ok(enabled);
  const config = { enabled: true };
  let gm = true;
  const visible = Function('systemSettings', 'FoundryAdapter', 'getUnlockThresholdLevel',
    `return (${enabled[1]})`)({ value: { bastionConfiguration: config } }, { userIsGm: () => gm }, () => 5);
  const context = { bastionsContext: { members: [] } };
  assert.equal(visible(context), true);
  gm = false;
  assert.equal(visible(context), false);
  context.bastionsContext.members.push({ level: 4 });
  assert.equal(visible(context), false);
  context.bastionsContext.members[0].level = 5;
  assert.equal(visible(context), true);
  config.enabled = false;
  assert.equal(visible(context), false);
  gm = true;
  assert.equal(visible(context), false);
});

// Run the functions actually served to Foundry, supplying only their world dependencies.
function loadAction(name, dependencies = {}) {
  const start = bundle.indexOf(`\nasync function ${name}(`);
  assert.notEqual(start, -1, name);
  const end = bundle.indexOf('\n}', start) + 2;
  return Function(...Object.keys(dependencies), `return (${bundle.slice(start, end)})`)(
    ...Object.values(dependencies)
  );
}

test('group turns use system elapsed days unless explicitly overridden', async () => {
  const days = [];
  let calendar = true;
  const bastion = {
    advanceAllFacilities(actor, { duration = calendar ? 0 : 7 }) {
      days.push(duration);
    },
  };
  const advance = loadAction('advanceBastions', { dnd5e: { bastion } });
  const member = { system: { isCharacter: true }, itemTypes: { facility: [{}] } };
  await advance([member]);
  calendar = false;
  await advance([member]);
  await advance([member], { duration: 3 });
  assert.deepEqual(days, [0, 7, 3]);
});

test('trade cancellation releases reservations atomically and preserves unrelated orders', async () => {
  const cancel = loadAction('cancelFacilityOrder');
  const updates = [];
  const facility = {
    system: { progress: { order: 'trade' }, trade: { pending: { creatures: ['Actor.x'] } } },
    update: data => updates.push(data),
  };
  await cancel(facility, 'trade');
  const pending = { creatures: [], operation: null, value: null, stocked: false };
  const progress = { value: 0, max: null, order: '', paid: false };
  assert.deepEqual(updates, [{ 'system.progress': progress, 'system.trade.pending': pending }]);
  facility.system.progress.order = 'build';
  await cancel(facility, 'trade');
  assert.deepEqual(updates[1], { 'system.trade.pending': pending });
  await cancel(facility, 'build');
  assert.deepEqual(updates[2], { 'system.progress': progress });
});

test('immediate completion skips damaged facilities and awards operational orders', async () => {
  const calls = [];
  const messages = [];
  const complete = loadAction('completeOrder', {
    isNil: (value, fallback) => value == null || value === fallback,
    dnd5e: { bastion: { advanceTurn(facility, { duration }) {
      calls.push(duration);
      return { order: 'craft', gold: 2, items: ['Item.x'] };
    } } },
    ChatMessage: { implementation: { getSpeaker: () => ({}), create: msg => messages.push(msg) } },
  });
  const facility = { id: 'a', system: { disabled: true, progress: { order: 'craft', value: 2, max: 7 } } };
  await complete(facility);
  assert.deepEqual(calls, []);
  assert.deepEqual(messages, []);
  facility.system.disabled = false;
  await complete(facility);
  assert.deepEqual(calls, [5]);
  assert.deepEqual(messages[0].system, {
    gold: { value: 2, claimed: false }, items: ['Item.x'], orders: [{ id: 'a', order: 'craft' }],
  });
});

test('Classic slots and roster tolerate missing actor links and preserve unlocked menus', () => {
  for (const component of ['FacilityOccupant', 'FacilityRosterOccupant']) {
    const source = read(`src/sheets/classic/character/parts/${component}.svelte`);
    assert.match(source, /if \(context\.unlocked\) \{\s*EventHelper\.triggerContextMenu\([^;]+;\s*return;\s*\}\s*occupant\?\.sheet\.render\(true\)/);
  }
});

test('pending livestock render separately from editable occupant indices, including full facilities', () => {
  const tab = read('src/sheets/classic/character/tabs/CharacterBastionTab.svelte');
  assert.match(tab, /chosen\.creatures\.length \|\| chosen\.facility\.system\.trade\.pending\?\.creatures\?\.length/);
  assert.match(tab, /#each chosen\.facility\.system\.trade\.pending\?\.creatures \?\? \[\] as uuid/);
  assert.match(tab, /cancelPendingTrade\(chosen\.facility, uuid\)/);
  assert.match(tab, /#each chosen\.creatures as \{ actor, uuid \}, index/);
});
