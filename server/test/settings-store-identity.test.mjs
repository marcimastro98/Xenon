import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every surface mirrors the settings blob into its browser's localStorage, and
// the boot hydrate resolves a conflict by comparing `rev`. But `rev` counts up
// from 0 PER STORE, so a store that was just created loses to any surface still
// holding an older mirror of the same origin — and an origin is an address, not
// an install. Reported on Discord: a user reinstalled Windows and Xenon, the PC
// came back on the same LAN address, and the phone paired before the wipe
// republished its months-old layout over the fresh install. That one landed
// well; the same mechanism aimed at a dashboard the user has just rebuilt is a
// silent loss of their work.
//
// The store id makes "higher rev" mean "higher rev in the SAME store". This
// pins both halves: the client rule (evaluated from the shipped source, never
// re-implemented here) and the server's mint + keep-prev.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = fs.readFileSync(path.join(HERE, '..', 'js', 'settings.js'), 'utf8');
const SERVER = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');

// js/settings.js cannot be require()d (a classic script whose top level runs the
// whole settings UI), so the function is extracted and evaluated on its own —
// the same idiom as state-server-origin.test.mjs, and what keeps this honest: a
// copy of the rule would keep passing after the shipped one regressed.
function isForeign(serverStoreId, knownStoreId) {
  const at = CLIENT.indexOf('function settingsMirrorIsForeign');
  assert.notEqual(at, -1, 'js/settings.js must still define settingsMirrorIsForeign');
  const next = CLIENT.indexOf('\nfunction ', at + 10);
  const src = CLIENT.slice(at, next > 0 ? next : CLIENT.length);
  const fn = new Function(src + '\nreturn settingsMirrorIsForeign;')();
  return fn(serverStoreId, knownStoreId);
}

test('a mirror left by a previous install is foreign', () => {
  assert.equal(isForeign('a'.repeat(32), 'b'.repeat(32)), true);
});

test('a mirror of the store being served is not foreign', () => {
  const id = 'c'.repeat(32);
  assert.equal(isForeign(id, id), false);
});

test('an unknown id on either side answers false, never "different"', () => {
  // Absent means "this side cannot say" (a mirror written before this build, a
  // server too old to mint one). Answering true here would throw away the case
  // the rev comparison exists for — a save that never reached the server before
  // a shutdown — for every surface at once, on the one load after the update.
  assert.equal(isForeign('', 'b'.repeat(32)), false);
  assert.equal(isForeign('a'.repeat(32), ''), false);
  assert.equal(isForeign('', ''), false);
  assert.equal(isForeign(null, undefined), false);
  assert.equal(isForeign(undefined, 'b'.repeat(32)), false);
});

test('the local mirror only wins the hydrate within the same store', () => {
  assert.ok(CLIENT.includes('const localNewer = localRev > serverRev && !foreignStore;'),
    'the rev comparison must be scoped to the store the server is serving');
});

test('the store id is remembered under its own key, never inside the blob', () => {
  // Inside the blob it would be rebuilt by normalizeSettings and posted back to
  // the server on the next save, which is the one thing it must never do.
  assert.ok(CLIENT.includes("const SETTINGS_STORE_KEY = 'xeneonedge.store.v1';"));
  const at = CLIENT.indexOf('function normalizeSettings');
  const next = CLIENT.indexOf('\nfunction ', at + 10);
  assert.ok(!CLIENT.slice(at, next > 0 ? next : CLIENT.length).includes('storeId'),
    'the browser normalizer must not carry storeId — it would travel back on every save');
});

test('the server mints the store id once and keeps it across saves', () => {
  assert.ok(SERVER.includes("if (!safe.storeId) safe.storeId = _settingsStoreId || crypto.randomBytes(16).toString('hex');"),
    'writeHubSettings must mint a store id when the persisted blob has none, reusing the '
    + 'one this process has already seen so an unlucky write cannot rotate it');
  assert.ok(SERVER.includes('incoming.storeId = prev.storeId;'),
    'POST /settings must keep the persisted store id (a stale surface would echo the old one)');
  assert.ok(/settings\] store id init failed/.test(SERVER),
    'boot must mint the id before a fresh install can answer GET /settings with no payload at all');
});

test('a restored backup does not adopt the exporting machine\'s store', () => {
  assert.ok(SERVER.includes("incoming.storeId = (prev && prev.storeId) || '';"),
    'the backup import must keep this machine\'s store id');
});
