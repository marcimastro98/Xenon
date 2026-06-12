import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dm = require('../js/deck-model.js');
const ds = require('../js/deck-store.js');

// Count placed keys across every profile/page of a config (test helper).
function keyCount(cfg) {
  let n = 0;
  for (const p of cfg.profiles) for (const pg of p.root.pages) n += pg.keys.filter(Boolean).length;
  return n;
}
// Build a config with `titles` placed left-to-right on page 0 of one profile.
function withKeys(cols, rows, titles, profId = 'prof_0', name = 'Utility') {
  let cfg = dm.normalizeDeckConfig({ cols, rows, profiles: [{ id: profId, name, root: { pages: [{ keys: [] }] } }], activeProfile: profId });
  const nav = { profileId: profId, path: [], pageIndex: 0 };
  titles.forEach((tt, i) => { cfg = dm.setKeyAt(cfg, nav, i, { id: 'k' + i, kind: 'action', title: tt }); });
  return cfg;
}

test('instanceConfig: an unknown/empty instance returns a blank deck (a new Deck starts empty)', () => {
  const cfg = ds.instanceConfig(dm, {}, 'deck~new1');
  assert.equal(keyCount(cfg), 0);
  assert.equal(cfg.profiles.length, 1);
});

test('instanceConfig: a stored instance returns its own normalized config', () => {
  const store = { 'deck': withKeys(4, 2, ['A', 'B', 'C']) };
  const cfg = ds.instanceConfig(dm, store, 'deck');
  assert.deepEqual(cfg.profiles[0].root.pages[0].keys.slice(0, 3).map(k => k && k.title), ['A', 'B', 'C']);
});

test('writeInstanceConfig: writes under the instance key without mutating the input store', () => {
  const store = { 'deck': withKeys(4, 2, ['A']) };
  const next = ds.writeInstanceConfig(dm, store, 'deck~x', withKeys(3, 2, ['Z']));
  assert.notEqual(next, store);                 // new object
  assert.ok(!('deck~x' in store));              // original untouched
  assert.equal(ds.instanceConfig(dm, next, 'deck~x').profiles[0].root.pages[0].keys[0].title, 'Z');
  assert.equal(ds.instanceConfig(dm, next, 'deck').profiles[0].root.pages[0].keys[0].title, 'A'); // sibling intact
});

test('two instances are independent: editing one leaves the other unchanged', () => {
  let store = { 'deck': withKeys(4, 2, ['A', 'B']), 'deck~x': withKeys(4, 2, ['A', 'B']) };
  store = ds.writeInstanceConfig(dm, store, 'deck', withKeys(4, 2, ['CHANGED', 'B']));
  assert.equal(ds.instanceConfig(dm, store, 'deck').profiles[0].root.pages[0].keys[0].title, 'CHANGED');
  assert.equal(ds.instanceConfig(dm, store, 'deck~x').profiles[0].root.pages[0].keys[0].title, 'A'); // untouched
});

test('migrateStore: a store without the legacy library is a no-op', () => {
  const store = { 'deck': withKeys(4, 2, ['A']) };
  const { store: out, changed } = ds.migrateStore(dm, store);
  assert.equal(changed, false);
  assert.equal(out, store);
});

test('migrateStore: gives every instance its own snapshot of the library, then drops the library', () => {
  const library = withKeys(5, 2, ['Spotify', 'WhatsApp', 'Discord', 'Claude', 'OBS', 'Desktop', 'Rec', 'Mute']);
  const store = {
    'deck': { activeProfile: 'prof_0', showMedia: true, autoFit: false },
    'deck~eh7b': { activeProfile: 'prof_0' },
    '__deckLibrary': library,
  };
  const { store: out, changed } = ds.migrateStore(dm, store);
  assert.equal(changed, true);
  assert.ok(!('__deckLibrary' in out));                       // library folded away
  // Both instances keep the 8 keys the library held (nothing disappears on upgrade).
  assert.equal(keyCount(ds.instanceConfig(dm, out, 'deck')), 8);
  assert.equal(keyCount(ds.instanceConfig(dm, out, 'deck~eh7b')), 8);
  // Per-instance view prefs are preserved.
  assert.equal(ds.instanceConfig(dm, out, 'deck').autoFit, false);
  assert.equal(ds.instanceConfig(dm, out, 'deck').showMedia, true);
  // The grid comes from the library.
  assert.equal(ds.instanceConfig(dm, out, 'deck').cols, 5);
});

test('migrateStore: distributed snapshots are reference-independent', () => {
  const store = { 'deck': {}, 'deck~x': {}, '__deckLibrary': withKeys(4, 2, ['A', 'B']) };
  let { store: out } = ds.migrateStore(dm, store);
  // Edit deck's keys; deck~x must not change.
  out = ds.writeInstanceConfig(dm, out, 'deck', withKeys(4, 2, ['EDIT', 'B']));
  assert.equal(ds.instanceConfig(dm, out, 'deck').profiles[0].root.pages[0].keys[0].title, 'EDIT');
  assert.equal(ds.instanceConfig(dm, out, 'deck~x').profiles[0].root.pages[0].keys[0].title, 'A');
});

test('migrateStore: a library with no instances seeds the base deck (keys never dropped)', () => {
  const store = { '__deckLibrary': withKeys(4, 2, ['Only', 'Two']) };
  const { store: out, changed } = ds.migrateStore(dm, store);
  assert.equal(changed, true);
  assert.equal(keyCount(ds.instanceConfig(dm, out, 'deck')), 2);
});

test('migrateStore is idempotent: a second pass is a no-op', () => {
  const store = { 'deck': {}, '__deckLibrary': withKeys(4, 2, ['A']) };
  const first = ds.migrateStore(dm, store);
  assert.equal(first.changed, true);
  const second = ds.migrateStore(dm, first.store);
  assert.equal(second.changed, false);
});

test('migrateStore: non-instance, non-library keys are carried over untouched', () => {
  const store = { 'deck': {}, '__deckLibrary': withKeys(4, 2, ['A']), '__future': { something: 1 } };
  const { store: out } = ds.migrateStore(dm, store);
  assert.deepEqual(out['__future'], { something: 1 });
});
