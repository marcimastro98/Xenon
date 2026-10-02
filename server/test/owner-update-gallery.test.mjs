import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// The Store's side of the owner update: which id the hub knows this install by,
// and which version is installed. community-gallery.js is a browser IIFE, so the
// three functions that decide it are lifted out of the source and run against a
// stubbed settings blob and package list.
const SRC = readFileSync(fileURLToPath(new URL('../js/community-gallery.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const MGR = readFileSync(fileURLToPath(new URL('../js/installed-manager.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function lift(src, header) {
  const at = src.indexOf(header);
  assert.ok(at > 0, header + ' not found — did it move?');
  const end = src.indexOf('\n  }', at);
  assert.ok(end > at, header + ' block not delimited as expected');
  return src.slice(at, end + 4);
}

function load({ packages = [], installs = [] } = {}) {
  const ctx = vm.createContext({
    api: async () => ({ packages }),
    hubSettings: { contentInstalls: installs },
  });
  vm.runInContext([
    'let installIndex = null;',
    lift(SRC, '  function installedPkgVersion(rec) {'),
    lift(SRC, '  function ownedTargetFor(entry) {'),
    lift(SRC, '  async function refreshInstallIndex() {'),
    'this.refresh = refreshInstallIndex; this.ownedTargetFor = ownedTargetFor; this.index = () => installIndex;',
  ].join('\n'), ctx);
  return ctx;
}

test('a receipt with NO version is still indexed, so versionless content shows as installed', async () => {
  // The receipt normalizer leaves sourceVersion out when it is empty; requiring a
  // string here dropped exactly those receipts (most themes, pages and decks).
  const g = load({ installs: [{ id: 'xi_1', sourceId: 'ember-nights', source: 'catalog' }] });
  const idx = await g.refresh();
  assert.equal(idx.receipts.has('ember-nights'), true);
  assert.equal(idx.receipts.get('ember-nights'), '');
});

test('a versionless receipt can never produce an update offer', async () => {
  const g = load({ installs: [{ id: 'xi_1', sourceId: 'ember-nights', source: 'catalog' }] });
  await g.refresh();
  // The same lines findUpdates / entryInstallState use: no entry.version, or an
  // unparseable installed one, means "current", never "update".
  const have = g.index().receipts.get('ember-nights');
  assert.equal(have == null, false);
  assert.match(SRC, /if \(entry\.version && verLess\(have, entry\.version\)\) return 'update';/);
});

test('a numbered copy is addressed by its COPY id, not the catalog entry id', async () => {
  const g = load({ installs: [{ id: 'xi_1', sourceId: 'vanguard-50-01', sourceVersion: '2.0', source: 'catalog' }] });
  await g.refresh();
  const entry = { id: 'vanguard-50', limited: { numbered: true, total: 50, dropId: 'vanguard-50' } };
  assert.deepEqual({ ...g.ownedTargetFor(entry) }, { entryId: 'vanguard-50-01', have: '2.0' });
});

test('an ordinary entry whose id merely ends in digits is never taken for a numbered copy', async () => {
  const g = load({ installs: [{ id: 'xi_1', sourceId: 'theme-2', sourceVersion: '1.0', source: 'catalog' }] });
  await g.refresh();
  // Receipt matches directly.
  assert.deepEqual({ ...g.ownedTargetFor({ id: 'theme-2', locked: true }) }, { entryId: 'theme-2', have: '1.0' });
  // And a different, NOT limited entry 'theme' must not borrow theme-2's receipt as a copy.
  assert.equal(g.ownedTargetFor({ id: 'theme', locked: true }), null);
});

test('a package widget reports the catalog stamp, then the manifest version', async () => {
  const stamped = load({ packages: [{ id: 'river', version: '1.0.0-sdk3', catalogVersion: '1.0.0' }] });
  await stamped.refresh();
  assert.deepEqual({ ...stamped.ownedTargetFor({ id: 'workload-river', pkgId: 'river', locked: true }) }, { entryId: 'workload-river', have: '1.0.0' });
  const legacy = load({ packages: [{ id: 'river', version: '0.9.0', catalogVersion: '' }] });
  await legacy.refresh();
  assert.equal(legacy.ownedTargetFor({ id: 'workload-river', pkgId: 'river', locked: true }).have, '0.9.0');
});

test('nothing installed means no owner target, so no hub call is made', async () => {
  const g = load();
  await g.refresh();
  assert.equal(g.ownedTargetFor({ id: 'vanguard-50', limited: { numbered: true } }), null);
  assert.equal(g.ownedTargetFor(null), null);
});

// ── the Installed tab ────────────────────────────────────────────────────────

test('the Installed tab uses the receipt id and installed version, and leaves locked rows out of "update all"', () => {
  const target = lift(MGR, '  function ownedTarget(upd, row) {');
  const ctx = vm.createContext({});
  vm.runInContext(target + '\nthis.ownedTarget = ownedTarget;', ctx);
  const upd = { id: 'vanguard-50' };
  // Receipt wins over the catalog id; its recorded version is what is installed.
  assert.deepEqual({ ...ctx.ownedTarget(upd, { record: { sourceId: 'vanguard-50-07', sourceVersion: '2.0' } }) }, { entryId: 'vanguard-50-07', have: '2.0' });
  // A package row falls back to the stamp, then the manifest.
  assert.deepEqual({ ...ctx.ownedTarget({ id: 'wr' }, { pkg: { catalogVersion: '1.2.0', version: '9.9.9' } }) }, { entryId: 'wr', have: '1.2.0' });
  assert.deepEqual({ ...ctx.ownedTarget({ id: 'wr' }, { pkg: { version: '3.0.0' } }) }, { entryId: 'wr', have: '3.0.0' });
  assert.deepEqual({ ...ctx.ownedTarget({ id: 'wr' }, {}) }, { entryId: 'wr', have: '' });
  // "Update all" must skip them: each opens its own review dialog.
  assert.match(MGR, /cat\.updates\.has\(row\.pkg\.id\) && !\(u\.locked === true \|\| u\.limited\)/);
});

test('a locked or limited update asks the hub as the owner BEFORE anything else, and never installs silently', () => {
  const at = MGR.indexOf('  async function applyUpdate(upd, row) {');
  assert.ok(at > 0);
  const body = MGR.slice(at, MGR.indexOf('  function renderRow', at));
  assert.ok(body.indexOf('applyOwnedUpdate') > 0 && body.indexOf('applyOwnedUpdate') < body.indexOf('/sdk/install'),
    'the owner path comes before the silent widget install');
  const owned = lift(MGR, '  async function applyOwnedUpdate(upd, row) {');
  assert.match(owned, /PresetShare\.updateOwned/);
  assert.ok(!/\/sdk\/install/.test(owned), 'the owner path never installs by itself: the import dialog owns the review');
  // A limited copy has no public file, so none is fetched for it.
  assert.match(owned, /if \(!upd\.limited\) \{/);
});
