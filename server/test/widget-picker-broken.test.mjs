// Saying so when an installed widget did not load.
//
// Reported on Discord: a supporter installed Workload, the Store showed
// "Installed", and typing "workload" into a tile's widget picker answered "No
// widget matches this search." The two surfaces read different things — the
// Store reads the install receipt, the picker reads what the rescan accepted —
// so a package whose files land but whose manifest fails validation is
// installed and invisible at the same time.
//
// The rescan has always reported those folders: GET /sdk/widgets returns
// { packages, invalid } and listPackages fills `invalid` with a reason per
// folder. The client cached that array (custom-widget.js: `pkgCache`) and
// nothing ever rendered it, which is why the symptom was silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackages } = require('../sdk-widgets.js');

const CW = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/CustomWidget/CustomWidget.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const KEYS = [
  'cw_pick_broken',
  'cw_pick_broken_hint',
  'cw_pick_broken_no_manifest',
  'cw_pick_broken_bad_manifest',
  'cw_pick_broken_no_entry',
  'cw_pick_broken_api',
];
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];

/** Which languages define `key`, by walking the file and tracking the namespace. */
function langsDefining(key) {
  const found = new Set();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const trimmed = line.trimStart();
    if (trimmed.startsWith(key + ':') || trimmed.startsWith('"' + key + '":')) found.add(current);
  }
  return found;
}

// The reported shape, end to end on the input side: one folder that loads and
// one that does not, told apart by the same scan the endpoint serves.
test('a package with a manifest but no entry file is reported, not hidden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'xenon-pkgs-'));
  try {
    mkdirSync(join(root, 'goodwidget'));
    writeFileSync(join(root, 'goodwidget', 'manifest.json'), JSON.stringify({
      api: 1, id: 'goodwidget', name: 'Good Widget', version: '2.0.0', entry: 'index.html',
    }));
    writeFileSync(join(root, 'goodwidget', 'index.html'), '<!doctype html><p>ok');

    // Exactly Workload's shape as reported: installed, manifest present, and the
    // file it names as its entry point absent.
    mkdirSync(join(root, 'workload'));
    writeFileSync(join(root, 'workload', 'manifest.json'), JSON.stringify({
      api: 1, id: 'workload', name: 'Workload', version: '1.0.0', entry: 'index.html',
    }));

    const out = await listPackages(root);
    assert.deepEqual(out.packages.map((p) => p.id), ['goodwidget'], 'only the loadable one is a package');
    assert.deepEqual(out.invalid, [{ id: 'workload', reason: 'missing_entry' }],
      'and the other is reported with a reason rather than dropped');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Reasons the user can act on read as sentences; anything else must still reach
// the screen as its raw code. Swallowing an unrecognised reason is how this
// became invisible in the first place, and that code is what a bug report needs.
test('every explained reason is one listPackages can actually emit', () => {
  const table = CW.slice(CW.indexOf('const PICK_BROKEN_REASONS = {'));
  const body = table.slice(0, table.indexOf('\n  };'));
  const explained = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
  assert.ok(explained.length, 'the table has entries');
  const SDK = readFileSync(new URL('../sdk-widgets.js', import.meta.url), 'utf8');
  for (const reason of explained) {
    assert.match(SDK, new RegExp("reason: '" + reason + "'"),
      `${reason} is a reason sdk-widgets.js emits`);
  }
});

test('an unrecognised reason still reaches the screen as its code', () => {
  const fn = CW.slice(CW.indexOf('const broken = (pkgCache'));
  const body = fn.slice(0, fn.indexOf('body.replaceChildren'));
  assert.match(body, /const said = known \? t\(known\.key, known\.fb\) : code;/,
    'no known sentence falls back to the raw reason, never to nothing');
});

// The whole point: the panel is showing this precisely when a search has
// emptied the list, so it must not be inside the block the search filters.
test('the notice is outside renderRows, so a search cannot hide it', () => {
  const paint = CW.slice(CW.indexOf('function paintPicker('));
  const fn = paint.slice(0, paint.indexOf('\n  }\n'));
  const renderEnds = fn.indexOf('list.replaceChildren(rows);');
  const noticeAt = fn.indexOf('const broken = (pkgCache');
  assert.ok(renderEnds > -1 && noticeAt > -1, 'both blocks exist');
  assert.ok(noticeAt > renderEnds, 'the notice is built after the filtered rows, not inside them');
  // Appended to the fragment, not to the list: the list scrolls, this stays put.
  assert.match(fn.slice(noticeAt), /frag\.appendChild\(box\);/);
});

// Folder names and reasons come off the disk, so they are untrusted text.
test('ids and reasons go through el(), which sets textContent', () => {
  const fn = CW.slice(CW.indexOf('const broken = (pkgCache'));
  const body = fn.slice(0, fn.indexOf('body.replaceChildren'));
  assert.doesNotMatch(body, /innerHTML|insertAdjacentHTML/, 'nothing is written as HTML');
  assert.match(body, /el\('div', 'cw-pick-broken-row'/, 'the row is built with el()');
});

test('a folder full of junk cannot push the widgets off the panel', () => {
  const fn = CW.slice(CW.indexOf('const broken = (pkgCache'));
  assert.match(fn.slice(0, 400), /\.slice\(0, PICK_BROKEN_MAX\)/, 'the list is capped');
});

test('the notice is styled, not unstyled text', () => {
  for (const cls of ['cw-pick-broken', 'cw-pick-broken-title', 'cw-pick-broken-row', 'cw-pick-broken-hint']) {
    assert.match(CSS, new RegExp('\\.' + cls + '\\b'), cls + ' has a rule');
  }
});

test('the notice is translated in every language the app ships', () => {
  for (const key of KEYS) {
    const have = langsDefining(key);
    const missing = LANGS.filter((l) => !have.has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});
