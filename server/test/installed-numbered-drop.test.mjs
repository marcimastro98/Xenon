// A NUMBERED limited drop hands out one artifact per copy — 'vanguard-50-01' —
// while the catalog publishes ONE entry for the drop, 'vanguard-50'. The install
// receipt records the copy id, so every lookup keyed on the catalog id missed:
// the owner of a numbered edition got the generic glyph instead of the drop's
// screenshot, and was never offered its updates. The most special thing a user
// can install was the one thing the list could not recognise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Normalised: the working tree may hold CRLF, and this test slices source by
// exact lines — a checkout's line endings must not decide whether it runs.
const SRC = readFileSync(join(ROOT, 'server', 'js', 'installed-manager.js'), 'utf8').replace(/\r\n/g, '\n');

// The real shape, from docs/community/catalog.json.
const VANGUARD = {
  id: 'vanguard-50',
  kind: 'bundle',
  name: 'VANGUARD 50 // VOICE RELAY',
  shots: 4,
  limited: { total: 50, numbered: true, dropId: 'vanguard-50', fulfillment: 'hub' },
};
const PLAIN = { id: 'ambra', kind: 'bundle', name: 'Ambra', shots: 2 };
// An unnumbered drop must NOT get copy ids invented for it.
const UNNUMBERED = { id: 'monthly', kind: 'theme', name: 'Monthly', shots: 1, limited: { total: 20, numbered: false, dropId: 'monthly' } };

/**
 * Run the real index builder and the two id-resolving helpers, lifted verbatim
 * from installed-manager.js so the test cannot drift from the shipped code. Only
 * the network read is swapped for the fixture.
 */
function load(list, updatesById = new Map()) {
  let mapping = SRC.slice(
    SRC.indexOf('const out = { updates: new Map()'),
    SRC.indexOf('const updates = (window.CommunityGallery'),
  );
  const fetchLine = "      const cat = await fetch('/api/community/catalog').then((r) => r.json());\n";
  assert.ok(mapping.includes(fetchLine), 'catalogIndex fetch line moved — update this test');
  mapping = mapping.replace(fetchLine, '').replace('    try {\n', '');

  const context = vm.createContext({ FIXTURE: { entries: list } });
  vm.runInContext(
    'function buildIndex() {\n  const cat = FIXTURE;\n' + mapping + '\n  return out;\n}\n'
    + SRC.slice(SRC.indexOf('function entryFor'), SRC.indexOf('// A single 1st-screenshot thumbnail'))
    + SRC.slice(SRC.indexOf('function updateFor'), SRC.indexOf('// Apply an available update')),
    context,
  );
  const cat = context.buildIndex();
  cat.updatesById = updatesById;
  return { cat, entryFor: context.entryFor, updateFor: context.updateFor };
}

const receipt = (sourceId) => ({ record: { source: 'catalog', sourceId }, pkg: null });

test('a plain catalog receipt still resolves directly', () => {
  const { cat, entryFor } = load([VANGUARD, PLAIN]);
  assert.equal(entryFor(receipt('ambra'), cat).id, 'ambra');
});

test('a numbered copy resolves to the drop entry, so it gets the real screenshot', () => {
  const { cat, entryFor } = load([VANGUARD, PLAIN]);
  const e = entryFor(receipt('vanguard-50-01'), cat);
  assert.ok(e, 'copy 01 found no entry — this is the reported "no preview" bug');
  assert.equal(e.id, 'vanguard-50');
  assert.equal(e.shots, 4);
});

test('every copy in the edition resolves, not just the first', () => {
  const { cat, entryFor } = load([VANGUARD]);
  for (const id of ['vanguard-50-01', 'vanguard-50-07', 'vanguard-50-50']) {
    assert.equal(entryFor(receipt(id), cat).id, 'vanguard-50', id + ' did not resolve');
  }
});

// Zero-padding follows the total's width; a copy id outside the edition is not ours.
test('ids outside the declared edition are not claimed', () => {
  const { cat, entryFor } = load([VANGUARD]);
  assert.equal(entryFor(receipt('vanguard-50-51'), cat), null);
  assert.equal(entryFor(receipt('vanguard-50-00'), cat), null);
  assert.equal(entryFor(receipt('vanguard-50-1'), cat), null);   // unpadded is a different id
});

// The whole reason this maps through limited.dropId instead of trimming a suffix.
test('an unrelated entry that merely ends in -01 is never mistaken for a copy', () => {
  const { cat, entryFor } = load([VANGUARD, { id: 'nocturne-01', kind: 'theme', name: 'Nocturne 01', shots: 1 }]);
  assert.equal(entryFor(receipt('nocturne-01'), cat).id, 'nocturne-01');
  assert.equal(entryFor(receipt('ambra-01'), cat), null);
});

test('an unnumbered drop gets no invented copy ids', () => {
  const { cat, entryFor } = load([UNNUMBERED]);
  assert.equal(entryFor(receipt('monthly'), cat).id, 'monthly');
  assert.equal(entryFor(receipt('monthly-01'), cat), null);
});

test('an update published for the drop reaches every copy', () => {
  const updates = new Map([['vanguard-50', { id: 'vanguard-50', version: '2.1.0' }]]);
  const { cat, updateFor } = load([VANGUARD], updates);
  assert.equal(updateFor(receipt('vanguard-50-01'), cat).version, '2.1.0');
  assert.equal(updateFor(receipt('vanguard-50-33'), cat).version, '2.1.0');
});

test('no update published means no update offered', () => {
  const { cat, updateFor } = load([VANGUARD], new Map());
  assert.equal(updateFor(receipt('vanguard-50-01'), cat), null);
});

// An installed-but-ungranted package is an installed dead package; the list that
// shows it must offer the fix.
test('the Installed list offers permissions for an ungranted package', () => {
  const row = SRC.slice(SRC.indexOf('function renderRow'));
  assert.match(row, /!CustomWidget\.packageGranted\(row\.pkg\)/);
  assert.match(row, /settings_sdk_grant_btn/);
  assert.match(row, /CustomWidget\.requestGrant\(row\.pkg, repaint\)/);
});

// A bundle's widgets are listed individually as well as under the download they
// came in, so the same thing shows up twice. The widget half had nothing to look
// itself up with — the catalog publishes the BUNDLE, not its parts — so one row
// carried the artwork and the other a grey glyph, and they read as two unrelated
// installs.
test('a widget that arrived inside a package inherits that package artwork', () => {
  const { cat, entryFor } = load([VANGUARD]);
  const owner = { source: 'catalog', sourceId: 'vanguard-50-01', resources: { widgetIds: ['vanguard-discord'] } };
  const widgetRow = { record: null, pkg: { id: 'vanguard-discord' }, owner };
  assert.equal(entryFor(widgetRow, cat).id, 'vanguard-50');
});

test('a widget published in its own right still wins on pkgId', () => {
  const own = { id: 'teleprompter', kind: 'widget', name: 'Teleprompter', pkgId: 'teleprompter', shots: 2 };
  const { cat, entryFor } = load([own, VANGUARD]);
  const owner = { source: 'catalog', sourceId: 'vanguard-50-01', resources: { widgetIds: ['teleprompter'] } };
  assert.equal(entryFor({ record: null, pkg: { id: 'teleprompter' }, owner }, cat).id, 'teleprompter');
});

// An import records no catalog id, so there is nothing to inherit — the glyph is
// the honest answer rather than artwork picked by guessing at the name.
test('a widget from an imported package inherits nothing', () => {
  const { cat, entryFor } = load([VANGUARD]);
  const owner = { source: 'import', sourceId: '', resources: { widgetIds: ['pow-system'] } };
  assert.equal(entryFor({ record: null, pkg: { id: 'pow-system' }, owner }, cat), null);
});

test('an orphan package with no owning receipt is unaffected', () => {
  const { cat, entryFor } = load([VANGUARD]);
  assert.equal(entryFor({ record: null, pkg: { id: 'stray' }, owner: null }, cat), null);
});
