import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// The join that decides "is an update available" lives in one shared module,
// read by the Store in the browser and by the server for the Xenon menu
// (packages/core/src/store-updates.js), so it is required here directly.
const require = createRequire(import.meta.url);
const SU = require('../../packages/core/src/store-updates.js');
const SRC = readFileSync(fileURLToPath(new URL('../js/community-gallery.js', import.meta.url)), 'utf8');
const loadVersionCompare = () => SU;

test('update join: a prerelease install is not stranded on its beta', () => {
  const { verLess } = loadVersionCompare();
  // THE regression. sdk-widgets.js normalizeManifest accepts [0-9A-Za-z._-], so
  // '2.0.0-beta' and 'v1.2.3' are versions that really get installed — and the
  // old numeric-dotted-only parse read them as junk. Fail-closed then meant "no
  // update, ever": no badge, no toast, no error, forever.
  assert.equal(verLess('2.0.0-beta', '2.0.0'), true);
  assert.equal(verLess('v1.2.3', '1.3.0'), true);
  assert.equal(verLess('1.0.0+build7', '1.0.1'), true);
  // A release is never "less than" its own prerelease — no downgrade prompts.
  assert.equal(verLess('2.0.0', '2.0.0-beta'), false);
  // Successive prereleases still move forward.
  assert.equal(verLess('2.0.0-beta.1', '2.0.0-beta.2'), true);
});

test('update join: ordinary version ordering still holds', () => {
  const { verLess } = loadVersionCompare();
  assert.equal(verLess('1.0.0', '1.0.1'), true);
  assert.equal(verLess('1.0.1', '1.0.0'), false);
  assert.equal(verLess('1.0.0', '1.0.0'), false);
  assert.equal(verLess('1.2', '1.2.1'), true, 'a short version is padded, not rejected');
  assert.equal(verLess('1.9.0', '1.10.0'), true, 'compared numerically, not as text');
  assert.equal(verLess('1.10.0', '1.9.0'), false);
});

test('update join: junk on either side never claims an update', () => {
  const { verLess } = loadVersionCompare();
  // Fail-closed is the load-bearing property: coercing junk to 0.0.0 would show
  // a false "update available" badge that invites a downgrade-reinstall.
  for (const junk of ['garbage', '', null, undefined, 'v', '1..2', {}]) {
    assert.equal(verLess(junk, '1.0.0'), false, `junk installed: ${String(junk)}`);
    assert.equal(verLess('1.0.0', junk), false, `junk published: ${String(junk)}`);
  }
});

test('update join: the Installed tab keys updates by pkgId AND by entry id', () => {
  // Receipt-installed content (themes, decks, packs) has no pkgId. The tab used
  // to keep only the pkgId half, so a theme with a published update showed no
  // button at all — while the gallery, reading the same findUpdates result, did.
  const src = readFileSync(fileURLToPath(new URL('../js/installed-manager.js', import.meta.url)), 'utf8');
  assert.match(src, /updatesById/, 'the entry-id keyed update map is gone');
  assert.match(src, /else out\.updatesById\.set\(entry\.id, entry\)/);
  assert.match(src, /function updateFor/, 'rows must resolve updates through both joins');
});

const loadInstalledPkgVersion = () => SU.installedPkgVersion;

test('update join: a catalog stamp is preferred over the package manifest', () => {
  const installedPkgVersion = loadInstalledPkgVersion();
  const { verLess } = loadVersionCompare();

  // THE regression this pair exists for. A publisher versions the catalog ENTRY
  // ('0.1.2') while the package they built reports '0.1.2-sdk3e'. Those are two
  // different numbering systems, and the suffix parses as a PRERELEASE, so the
  // manifest compares as older than the entry — forever. Every open of the Store
  // offered the update, "Update all" installed it and truthfully reported
  // success, the package still reported '0.1.2-sdk3e', and the badge came back.
  // Observed live on dgm-news-sports, dgm-news-technology and explorador-de-mapas.
  assert.equal(verLess('0.1.2-sdk3e', '0.1.2'), true, 'the raw compare is what loops');

  // With the catalog stamp recorded at install time, like is compared with like.
  const stamped = { manifest: '0.1.2-sdk3e', catalog: '0.1.2' };
  assert.equal(installedPkgVersion(stamped), '0.1.2');
  assert.equal(verLess(installedPkgVersion(stamped), '0.1.2'), false, 'the phantom update is gone');

  // A genuinely newer entry is still offered.
  assert.equal(verLess(installedPkgVersion(stamped), '0.1.3'), true);

  // No stamp (installed before this record existed, or never from the catalog)
  // → fall back to the manifest, i.e. exactly the previous behaviour.
  const legacy = { manifest: '2.0.0-beta', catalog: '' };
  assert.equal(installedPkgVersion(legacy), '2.0.0-beta');
  assert.equal(verLess(installedPkgVersion(legacy), '2.0.0'), true, 'beta → stable must still be offered');

  assert.equal(installedPkgVersion(null), null);
});

// A protected (locked) supporter drop is updatable like any other: the update is
// the import dialog, which unlocks with the saved pass or asks for the code once.
// It used to be skipped here, so owners of a locked pack never saw a badge.
function loadFindUpdates(idx) {
  return async (entries) => SU.findUpdates(entries, idx);
}

test('update join: a locked entry you own offers its update', async () => {
  const findUpdates = loadFindUpdates({
    pkg: new Map([['workload-river', { manifest: '1.0.0', catalog: '' }]]),
    receipts: new Map([['nitrato', '1.0.0'], ['cards', '2.0.0']]),
    dropReceipts: new Map(),
    dropCopyIds: new Map(),
  });
  const out = await findUpdates([
    { id: 'nitrato', version: '1.1.0', locked: true },
    { id: 'workload-river', pkgId: 'workload-river', version: '1.0.1', locked: true },
    { id: 'cards', version: '2.0.0', locked: true },   // current: no update
    { id: 'other', version: '1.0.0', locked: true },   // not owned: no update
  ]);
  assert.deepEqual(out.map((e) => e.id), ['nitrato', 'workload-river']);
});

test('update action: a protected drop goes to the import dialog, not a silent install', () => {
  const mgr = readFileSync(fileURLToPath(new URL('../js/installed-manager.js', import.meta.url)), 'utf8');
  const at = mgr.indexOf('async function applyUpdate');
  assert.ok(at > 0);
  const body = mgr.slice(at, mgr.indexOf('function renderRow', at));
  assert.ok(body.indexOf('peekLocked') > 0 && body.indexOf('peekLocked') < body.indexOf('decodePreset'),
    'the locked check must come before decodePreset, which returns null for a locked code');
  const shared = readFileSync(fileURLToPath(new URL('../../packages/core/src/store-updates.js', import.meta.url)), 'utf8');
  assert.match(shared, /function findUpdates[\s\S]{0,300}!e \|\| !e\.version\) return false;/);
});

test('update join: the Store keeps no second copy of it', () => {
  // Two copies are how the menu window and the Store came to disagree. The Store
  // reads the shared module, and the page loads it before the Store.
  assert.doesNotMatch(SRC, /const verParse =|function verParse/, 'a version parser is back in community-gallery.js');
  assert.match(SRC, /storeUpdates\.findUpdates\(entries, idx\)/);
  assert.match(SRC, /storeUpdates\.buildIndex\(packages, installs\)/);
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  const shared = html.indexOf('<script src="shared/src/store-updates.js">');
  assert.ok(shared > 0 && shared < html.indexOf('<script src="js/community-gallery.js">'), 'store-updates.js must load before the Store');
});

test('update join: packages by id, receipts by entry, edition copies by their base', () => {
  const idx = SU.buildIndex(
    [{ id: 'orbit-clock', version: '1.0.2-sdk3', catalogVersion: '1.0.2' }, { id: 'desk-notes', version: '0.3.0' }, null, { id: '' }],
    [
      { sourceId: 'ember-nights' },                                  // a theme: no version, still installed
      { sourceId: 'nitrato', sourceVersion: '1.0.0' },
      { sourceId: 'nitrato', sourceVersion: '1.1.0' },               // a later re-import wins
      { sourceId: 'vanguard-50-01', sourceVersion: '2.0' },          // a numbered copy
      { sourceVersion: '9.9' }, null,
    ],
  );
  assert.deepEqual([...idx.pkg.keys()], ['orbit-clock', 'desk-notes']);
  assert.equal(SU.installedPkgVersion(idx.pkg.get('orbit-clock')), '1.0.2');
  assert.equal(SU.installedPkgVersion(idx.pkg.get('desk-notes')), '0.3.0');
  assert.equal(idx.receipts.get('ember-nights'), '');
  assert.equal(idx.receipts.get('nitrato'), '1.1.0');
  assert.equal(idx.dropCopyIds.get('vanguard-50'), 'vanguard-50-01');
  const ups = SU.findUpdates([
    { id: 'orbit-clock', pkgId: 'orbit-clock', version: '1.1.0' },
    { id: 'desk-notes', pkgId: 'desk-notes', version: '0.3.0' },
    { id: 'ember-nights', version: '' },
    { id: 'nitrato', version: '1.1.0' },
    { id: 'vanguard-50', version: '2.1', limited: { dropId: 'vanguard-50' } },
    { id: 'vanguard', version: '3.0' },                              // not limited: never joined by a copy
  ], idx);
  assert.deepEqual(ups.map((e) => e.id), ['orbit-clock', 'vanguard-50']);
  assert.deepEqual(SU.findUpdates([{ id: 'x', version: '1.0.0' }], SU.buildIndex([], [])), [], 'nothing installed, nothing to update');
});
