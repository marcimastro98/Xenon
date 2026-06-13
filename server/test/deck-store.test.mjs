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

// ── Per-instance revision merge (anti-clobber persistence) ──────────────────────

test('sanitizeInstanceRevs: keeps only instance keys mapped to positive integers', () => {
  const out = ds.sanitizeInstanceRevs({ 'deck': 3, 'deck~x': 1.9, '__lib': 5, 'deck~y': 0, 'deck~z': -2, 'deck~w': 'no' });
  assert.deepEqual(out, { 'deck': 3, 'deck~x': 1 });   // floors, drops 0/neg/non-int/__keys
});

test('sanitizeInstanceRevs: non-object input → empty map', () => {
  assert.deepEqual(ds.sanitizeInstanceRevs(null), {});
  assert.deepEqual(ds.sanitizeInstanceRevs([1, 2]), {});
});

// ── Legacy whole-blob push: additive recovery only (anti-clobber) ───────────────

test('applyLegacyBlob: a stale legacy push can NEVER overwrite an instance the server has', () => {
  // The reported loss: the user edits 'deck' (server now holds EDITED via ops), then a
  // stale tab running old deck.js fires its pagehide beacon with OLD content + a high
  // local rev counter. It must not win — the server is authoritative.
  const current = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['EDITED']) }, instanceRevs: { 'deck': 2 } };
  const incoming = { configs: { 'deck': withKeys(4, 2, ['OLD']) }, instanceRevs: { 'deck': 999 } };
  const { store: out, changed } = ds.applyLegacyBlob(current, incoming);
  assert.equal(changed, false);   // nothing the server didn't already have
  assert.equal(ds.instanceConfig(dm, out.configs, 'deck').profiles[0].root.pages[0].keys[0].title, 'EDITED');
});

test('applyLegacyBlob: restores an instance the server is missing entirely (genuine recovery)', () => {
  const current = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['A']) } };
  const incoming = { configs: { 'deck': withKeys(4, 2, ['A']), 'deck~lost': withKeys(4, 2, ['L']) }, instanceRevs: { 'deck~lost': 4 } };
  const { store: out, changed } = ds.applyLegacyBlob(current, incoming);
  assert.equal(changed, true);
  assert.equal(ds.instanceConfig(dm, out.configs, 'deck').profiles[0].root.pages[0].keys[0].title, 'A');   // existing untouched
  assert.ok('deck~lost' in out.configs);                                                                   // missing one restored
  assert.equal(out.instanceRevs['deck~lost'], 4);
});

test('applyLegacyBlob: never deletes a server instance the blob lacks, and ignores __keys', () => {
  const current = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['A']), 'deck~b': withKeys(4, 2, ['B']) } };
  const incoming = { configs: { 'deck': withKeys(4, 2, ['OLD']), '__evil': withKeys(4, 2, ['X']) } };
  const { store: out, changed } = ds.applyLegacyBlob(current, incoming);
  assert.equal(changed, false);
  assert.ok('deck~b' in out.configs);        // not in the blob → kept (no deletion via legacy push)
  assert.ok(!('__evil' in out.configs));     // internal key rejected
});

test('applyLegacyBlob: presets are additive recovery — a non-empty stored list is never shrunk', () => {
  const current = { ...emptyStore(), presets: [{ id: 'keep' }], keyPresets: [] };
  // A blank/legacy push must not erase stored presets, but CAN restore empty ones.
  const a = ds.applyLegacyBlob(current, { configs: {}, presets: [], keyPresets: [{ id: 'kp' }] });
  assert.deepEqual(a.store.presets.map(p => p.id), ['keep']);   // stored list protected
  assert.deepEqual(a.store.keyPresets.map(p => p.id), ['kp']);  // empty one recovered
  assert.equal(a.changed, true);
});

// ── Op-based persistence (server-authoritative, linear) ─────────────────────────

const emptyStore = () => ({ configs: {}, rev: 0, savedAt: 0, instanceRevs: {}, presets: [], keyPresets: [] });

test('applyDeckOps: a set op writes ONE instance and leaves siblings untouched', () => {
  const store = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['A']), 'deck~x': withKeys(4, 2, ['B']) } };
  const { store: out, changed } = ds.applyDeckOps(store, [{ t: 'set', id: 'deck', config: withKeys(4, 2, ['EDITED']) }]);
  assert.equal(changed, true);
  assert.equal(ds.instanceConfig(dm, out.configs, 'deck').profiles[0].root.pages[0].keys[0].title, 'EDITED');
  assert.equal(ds.instanceConfig(dm, out.configs, 'deck~x').profiles[0].root.pages[0].keys[0].title, 'B'); // untouched
  assert.equal(out.instanceRevs['deck'], 1);   // server-assigned per-instance rev
  assert.notEqual(out, store);                 // input not mutated
  assert.ok(!('EDITED~marker' in store.configs));
});

test('applyDeckOps: a del op removes only the named instance; deleting a missing one is a no-op', () => {
  const store = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['A']), 'deck~x': withKeys(4, 2, ['B']) }, instanceRevs: { 'deck~x': 3 } };
  const del = ds.applyDeckOps(store, [{ t: 'del', id: 'deck~x' }]);
  assert.equal(del.changed, true);
  assert.ok(!('deck~x' in del.store.configs));
  assert.ok('deck' in del.store.configs);
  const noop = ds.applyDeckOps(store, [{ t: 'del', id: 'deck~missing' }]);
  assert.equal(noop.changed, false);
});

test('applyDeckOps: a presets op replaces the lists, bounded', () => {
  const store = { ...emptyStore(), presets: [{ id: 'old' }] };
  const { store: out, changed } = ds.applyDeckOps(store, [{ t: 'presets', presets: [{ id: 'p1' }], keyPresets: [{ id: 'k1' }] }]);
  assert.equal(changed, true);
  assert.deepEqual(out.presets.map(p => p.id), ['p1']);
  assert.deepEqual(out.keyPresets.map(p => p.id), ['k1']);
});

test('applyDeckOps: malformed ops are skipped (untrusted wire)', () => {
  const store = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['A']) } };
  const { changed } = ds.applyDeckOps(store, [
    null, 42, { t: 'set' }, { t: 'set', id: 'deck', config: [1] }, { t: 'set', id: '__evil', config: {} },
    { t: 'del', id: '__deckLibrary' }, { t: 'nope', id: 'deck' },
  ]);
  assert.equal(changed, false);
});

test('buildDeckOps: derives set/del/presets from the local state (the outbox shape)', () => {
  const configs = { 'deck': withKeys(4, 2, ['A']) };
  const ops = ds.buildDeckOps(['deck', 'deck~gone', ds.PRESETS_ID], configs, [{ id: 'p1' }], []);
  assert.deepEqual(ops.map(o => o.t), ['set', 'del', 'presets']);
  assert.equal(ops[0].id, 'deck');
  assert.equal(ops[1].id, 'deck~gone');           // dirty but absent locally → explicit delete
  assert.deepEqual(ops[2].presets.map(p => p.id), ['p1']);
});

test('ops round-trip: a stale client with an empty outbox cannot revert or delete anything', () => {
  // Client A edits its key and adds a second deck — two precise ops.
  let store = { ...emptyStore(), configs: { 'deck': withKeys(4, 2, ['OLD']) } };
  store = ds.applyDeckOps(store, ds.buildDeckOps(['deck'], { 'deck': withKeys(4, 2, ['EDITED']) }, [], [])).store;
  store = ds.applyDeckOps(store, ds.buildDeckOps(['deck~new'], { 'deck~new': withKeys(3, 3, ['N']) }, [], [])).store;
  // A stale client (old content, no unsent changes) flushes its empty outbox: no ops, no writes.
  const staleOps = ds.buildDeckOps([], { 'deck': withKeys(4, 2, ['OLD']) }, [], []);
  assert.equal(staleOps.length, 0);
  const after = ds.applyDeckOps(store, staleOps);
  assert.equal(after.changed, false);
  assert.equal(ds.instanceConfig(dm, after.store.configs, 'deck').profiles[0].root.pages[0].keys[0].title, 'EDITED');
  assert.ok('deck~new' in after.store.configs);   // the second deck survives
});
