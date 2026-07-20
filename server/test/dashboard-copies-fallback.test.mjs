import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Regression guard for a real production bug: a tab group holding an SDK widget
// vanished after some restarts, permanently.
//
// normalizeDashboardLayout() built layout.copies with `(typeof DashboardInstances
// !== 'undefined') ? ... : []`. dashboard-instances.js loads AFTER settings.js, so
// at the parse-time loadHubSettings() that ternary always took the [] branch and
// every duplicated-widget placement was dropped. normalizeDashboardGroups then
// filtered out the members it could no longer resolve and DELETED any group left
// under two members (`if (members.length < 2) return`) — and every SDK widget
// joins a group as a copy (dashboard-tabgroups.js `alwaysCopy`), so SDK tab groups
// were erased on every single boot. The hydrate normally rebuilt them, but a
// GridStack mount `change` firing first serialized the mutilated layout and bumped
// `rev`, at which point the stripped local copy won the merge against the server
// and the group was gone for good.
//
// The fix is a bounded RAW passthrough when the module is missing, matching
// normalizeAmbientScenes and dashboardPresets. settings.js is a browser script
// that self-executes against the DOM, so evaluate the function out of its source
// rather than importing it.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'js', 'settings.js'), 'utf8');

// Slice a top-level `function name(...) { ... }` out of the source by brace match.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found in settings.js`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

// Build the function with DashboardInstances genuinely undefined — the parse-time
// condition. A `typeof` guard is the only safe test for that, which is why the
// function under test uses one.
function loadCopiesNormalizer() {
  const src = extractFunction(SRC, 'normalizeDashboardCopies');
  return new Function(`${src}; return normalizeDashboardCopies;`)();
}

const WIDGETS = { custom: { visible: true }, system: { visible: true } };
const PAGES = ['dashboard'];

test('copies survive when DashboardInstances has not loaded yet', () => {
  const normalizeDashboardCopies = loadCopiesNormalizer();
  const raw = [{ id: 'custom~7n4z', widget: 'custom', x: 16, y: 0, w: 8, h: 24, page: 'dashboard' }];
  const out = normalizeDashboardCopies(raw, WIDGETS, PAGES);
  assert.equal(out.length, 1, 'the copy must not be dropped at the parse-time normalize');
  assert.equal(out[0].id, 'custom~7n4z');
  assert.equal(out[0].widget, 'custom');
});

test('the fallback still refuses input it cannot vouch for', () => {
  const normalizeDashboardCopies = loadCopiesNormalizer();
  assert.deepEqual(normalizeDashboardCopies(null, WIDGETS, PAGES), []);
  assert.deepEqual(normalizeDashboardCopies('nope', WIDGETS, PAGES), []);
  // No '~' → not a copy id; unknown widget → not a widget we render; duplicates
  // would give a group two members with the same id.
  const out = normalizeDashboardCopies([
    { id: 'custom', widget: 'custom' },
    { id: 'evil~1', widget: 'notAWidget' },
    { id: 'custom~a1', widget: 'custom' },
    { id: 'custom~a1', widget: 'custom' },
    null,
    'string',
  ], WIDGETS, PAGES);
  assert.deepEqual(out.map(c => c.id), ['custom~a1']);
});

test('the fallback is bounded', () => {
  const normalizeDashboardCopies = loadCopiesNormalizer();
  const many = Array.from({ length: 500 }, (_, i) => ({ id: `custom~x${i}`, widget: 'custom' }));
  assert.ok(normalizeDashboardCopies(many, WIDGETS, PAGES).length <= 60);
});

test('a tab group whose second member is a copy keeps both members', () => {
  // The end-to-end shape of the bug: ['system', 'custom~7n4z'] must not fall to
  // one member, because normalizeDashboardGroups deletes the whole group then.
  const normalizeDashboardCopies = loadCopiesNormalizer();
  const copies = normalizeDashboardCopies(
    [{ id: 'custom~7n4z', widget: 'custom', page: 'dashboard' }], WIDGETS, PAGES);
  const copyIds = new Set(copies.map(c => c.id));
  const isInstance = (m) => WIDGETS[m] || copyIds.has(m);
  const members = ['system', 'custom~7n4z'].filter(isInstance);
  assert.equal(members.length, 2, 'the group would be deleted at members.length < 2');
});

test('normalizeDashboardLayout routes copies through the guarded helper', () => {
  // Pins the call site: reintroducing an inline `: []` here is the whole bug.
  assert.match(
    SRC,
    /layout\.copies = normalizeDashboardCopies\(source\.copies, layout\.widgets, pageIds\);/,
    'layout.copies must be built through normalizeDashboardCopies');
  assert.doesNotMatch(
    SRC,
    /layout\.copies = \(typeof DashboardInstances/,
    'the fail-closed ternary must not come back');
});

test('contentInstalls does not fail closed at the parse-time normalize either', () => {
  // Same load-order hazard, same amplifier: a pre-hydrate save would persist the
  // emptied receipt list and the Store's Installed tab would forget everything.
  assert.match(
    SRC,
    /ContentInstalls\.normalizeContentInstalls\(value\.contentInstalls\)\s*[\r\n]+\s*:\s*\(Array\.isArray\(value\.contentInstalls\)/,
    'contentInstalls needs a raw passthrough when ContentInstalls is not loaded');
});
