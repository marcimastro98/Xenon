// The deckState action: a named on/off the Deck owns, shared with /state/set,
// so one key can switch another and keys sharing a name act as a radio group.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRegistry } = require('../actions/registry.js');
const { validateAction } = require('../js/deck-actions.js');

function registryWithStates() {
  const states = {};
  const reg = createRegistry({
    setNamedState: (name, value) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) return 'bad_name';
      if (value == null) delete states[name]; else states[name] = value;
      return '';
    },
    getNamedState: (name) => (name in states ? states[name] : null),
  });
  return { reg, states };
}

test('the action validates to a name, a mode and an optional value', () => {
  assert.deepEqual(validateAction({ type: 'deckState', name: 'stream', mode: 'set' }), { type: 'deckState', name: 'stream', mode: 'set' });
  assert.deepEqual(validateAction({ type: 'deckState', name: 'scene', mode: 'bogus', value: 'game' }), { type: 'deckState', name: 'scene', mode: 'toggle', value: 'game' });
});

test('set, toggle and clear drive the shared map', async () => {
  const { reg, states } = registryWithStates();
  assert.deepEqual(await reg.run({ type: 'deckState', name: 'live', mode: 'set' }), { ok: true, state: 'on' });
  assert.equal(states.live, 'on');
  assert.deepEqual(await reg.run({ type: 'deckState', name: 'live', mode: 'toggle' }), { ok: true, state: null });
  assert.equal('live' in states, false);
  await reg.run({ type: 'deckState', name: 'live', mode: 'toggle' });
  assert.equal(states.live, 'on');
  await reg.run({ type: 'deckState', name: 'live', mode: 'clear' });
  assert.equal('live' in states, false);
});

test('toggling one member of a radio group selects it instead of clearing', async () => {
  const { reg, states } = registryWithStates();
  await reg.run({ type: 'deckState', name: 'scene', mode: 'set', value: 'game' });
  await reg.run({ type: 'deckState', name: 'scene', mode: 'toggle', value: 'chat' });
  assert.equal(states.scene, 'chat');
  await reg.run({ type: 'deckState', name: 'scene', mode: 'toggle', value: 'chat' });
  assert.equal('scene' in states, false);
});

test('a bad name is reported, and a host without the map says unavailable', async () => {
  const { reg } = registryWithStates();
  assert.deepEqual(await reg.run({ type: 'deckState', name: '../x', mode: 'set' }), { ok: false, error: 'bad_name' });
  assert.deepEqual(await createRegistry({}).run({ type: 'deckState', name: 'a', mode: 'set' }), { ok: false, error: 'unavailable' });
});
