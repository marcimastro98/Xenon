// The combinations a new install starts with (capabilities/function-key.js): the
// main functions get a key once, and a person's own choice is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULT_KEYS, seedKeys } = require('../capabilities/function-key.js');
const S = require('../js/deck-shortcuts.js');

const READY = { shortcuts: true, capture: true, captureRegion: true, captureVideo: true };

function fakeDeck(configs = {}, taken = []) {
  const state = { configs, writes: 0 };
  return {
    state,
    deck: {
      takenByOthers: () => taken,
      update: async (edit) => {
        const copy = JSON.parse(JSON.stringify(state.configs));
        const out = edit(copy) || {};
        for (const id of out.changed || []) { state.configs[id] = copy[id]; state.writes += 1; }
        return out.result;
      },
    },
  };
}
const combos = (configs) => Object.fromEntries(S.collectShortcuts(configs).list.map((s) => [s.keyId, s.combo]));

test('the defaults are free: no system, driver or known app holds them', () => {
  for (const combo of Object.values(DEFAULT_KEYS)) {
    assert.equal(S.normalizeShortcut(combo), combo);
    assert.equal(S.reservedBy(combo), '', combo);
  }
});

test('a new install gets screenshot, area and record on keys', async () => {
  const { state, deck } = fakeDeck();
  await seedKeys({ deck, probes: () => READY });
  assert.deepEqual(combos(state.configs), { fn_shot: 'ctrl+shift+f12', fn_record: 'ctrl+shift+f11', fn_area: 'ctrl+shift+f8' });
});

test('they are given once: a key taken away stays away', async () => {
  const { state, deck } = fakeDeck();
  await seedKeys({ deck, probes: () => READY });
  state.configs.keys.profiles[0].root.pages[0].keys = [];
  const writes = state.writes;
  await seedKeys({ deck, probes: () => READY });
  assert.equal(state.writes, writes);
  assert.deepEqual(combos(state.configs), {});
});

test('a function with a key of its own, or a combination in use, is left alone', async () => {
  const mine = { id: 'k1', kind: 'action', title: 'Snap', triggers: { tap: { type: 'screenshot', target: 'screen', mode: 'take' } }, shortcut: 'ctrl+alt+s' };
  const other = { id: 'k2', kind: 'action', title: 'Lights', triggers: { tap: { type: 'openUrl', url: 'https://x.test' } }, shortcut: 'ctrl+shift+f11' };
  const { state, deck } = fakeDeck({ 'deck-a': { profiles: [{ name: 'Main', root: { pages: [{ keys: [mine, other] }] } }] } }, ['ctrl+shift+f8']);
  await seedKeys({ deck, probes: () => READY });
  assert.deepEqual(combos(state.configs), { k1: 'ctrl+alt+s', k2: 'ctrl+shift+f11' });
});

test('nothing happens where it could not work, and the next start tries again', async () => {
  const { state, deck } = fakeDeck();
  await seedKeys({ deck, probes: () => ({ ...READY, shortcuts: false }) });
  await seedKeys({ deck, probes: () => ({ ...READY, capture: false }) });
  assert.equal(state.writes, 0);
  await seedKeys({ deck, probes: () => ({ ...READY, captureVideo: false }) });
  assert.deepEqual(Object.keys(combos(state.configs)).sort(), ['fn_area', 'fn_shot'], 'no record key without recording');
});
