// The minimal-topbar island segment list lives in THREE places that must agree:
// the renderer's ISLAND_SEG_IDS (js/topbar-minimal.js), the client settings
// normalizer's canonical list (js/settings.js) and its server twin
// (server.js TOPBAR_ISLAND_IDS). The normalizers are allowlists — a segment the
// renderer draws but they omit is stripped from `items` on the next save, so the
// segment silently loses its stored order/visibility. Every id must also carry a
// label, or the Settings island editor renders a raw id at the user.
// Pin all four so they can't drift (same guard shape as sdk-grant-cats-sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

// Pull a single-quoted string array out of `<name> = [...]` source text.
function arrayLiteral(src, pattern, what) {
  const m = src.match(pattern);
  assert.ok(m, what + ' not found');
  return m[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
}

const renderer = arrayLiteral(
  read('server', 'js', 'topbar-minimal.js'),
  /ISLAND_SEG_IDS\s*=\s*\[([^\]]*)\]/,
  'ISLAND_SEG_IDS in topbar-minimal.js',
);

// Slice one top-level `function <name>(…) { … }` out of a source file.
function fnSource(src, signature, what) {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, what + ' implementation not found');
  const open = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > open, what + ' closing brace not found');
  return src.slice(start, end);
}

// normalizeTopbarClock delegates the button list to normalizeTopbarActions, so
// both have to be in scope for the evaluated copy to run.
function clientNormalizer() {
  const src = read('server', 'js', 'settings.js');
  const clock = fnSource(src, 'function normalizeTopbarClock(value, legacyRoot)', 'normalizeTopbarClock');
  const actions = fnSource(src, 'function normalizeTopbarActions(value)', 'normalizeTopbarActions');
  return Function(actions + '\nreturn (' + clock + ')')();
}

// The server keeps its canonical list and its always-shown set in module consts,
// so both come along with the function.
function serverNormalizer() {
  const src = read('server', 'server.js');
  const defaults = src.match(/const TOPBAR_ACTION_DEFAULTS\s*=\s*\[[\s\S]*?\n\];/);
  assert.ok(defaults, 'TOPBAR_ACTION_DEFAULTS not found in server.js');
  const always = src.match(/const TOPBAR_ALWAYS_SHOWN\s*=\s*\[[^\]]*\];/);
  assert.ok(always, 'TOPBAR_ALWAYS_SHOWN not found in server.js');
  return Function(defaults[0] + '\n' + always[0]
    + '\n' + fnSource(src, 'function normalizeTopbarActions(value)', 'server normalizeTopbarActions')
    + '\nreturn normalizeTopbarActions;')();
}

// The chrome-button list lives in the same three places as the island one, plus
// the selector map that turns an id into an element.
const actionRenderer = Object.keys(
  Object.fromEntries(
    [...read('server', 'js', 'topbar-minimal.js')
      .match(/ACTION_SELECTORS\s*=\s*\{([^}]*)\}/)[1]
      .matchAll(/(\w+):\s*'([^']+)'/g)].map(m => [m[1], m[2]]),
  ),
);

test('settings.js normalizeTopbarClock covers every island segment the renderer draws', () => {
  const client = arrayLiteral(
    read('server', 'js', 'settings.js'),
    /normalizeTopbarClock\(value, legacyRoot\)\s*\{\s*const canonical\s*=\s*\[([^\]]*)\]/,
    'canonical list in settings.js normalizeTopbarClock',
  );
  assert.deepEqual([...client].sort(), [...renderer].sort());
});

test('server.js TOPBAR_ISLAND_IDS mirrors the client canonical list', () => {
  const server = arrayLiteral(
    read('server', 'server.js'),
    /TOPBAR_ISLAND_IDS\s*=\s*\[([^\]]*)\]/,
    'TOPBAR_ISLAND_IDS in server.js',
  );
  assert.deepEqual([...server].sort(), [...renderer].sort());
});

test('v2 migration folds the former Claude and Vitals switches into item visibility once', () => {
  const normalize = clientNormalizer();
  const migrated = normalize({
    align: 'left',
    items: renderer.map((id) => ({ id, hidden: false })),
  }, {
    claudeWidget: { topbar: false },
    vitals: { topbar: false },
  });
  assert.equal(migrated.version, 2);
  assert.equal(migrated.items.find((item) => item.id === 'claude').hidden, true);
  assert.equal(migrated.items.find((item) => item.id === 'vitals').hidden, true);

  // Once v2 owns the setting, stale feature-local booleans cannot overwrite an
  // eye toggle on a later save/hydrate.
  const v2 = normalize({ ...migrated, items: migrated.items.map((item) => ({ ...item, hidden: false })) }, {
    claudeWidget: { topbar: false },
    vitals: { topbar: false },
  });
  assert.equal(v2.items.find((item) => item.id === 'claude').hidden, false);
  assert.equal(v2.items.find((item) => item.id === 'vitals').hidden, false);
});

test('fresh settings keep the formerly opt-in Vitals chips hidden', () => {
  const normalize = clientNormalizer();
  const fresh = normalize(null, {});
  assert.equal(fresh.items.find((item) => item.id === 'vitals').hidden, true);
  assert.equal(fresh.items.find((item) => item.id === 'claude').hidden, false);
});

test('island source opt-outs are deduped, bounded and fail closed on ids', () => {
  const normalize = clientNormalizer();
  const valid = Array.from({ length: 70 }, (_, index) => `source-${index}`);
  const result = normalize({
    version: 2,
    hiddenSources: ['github-stars', 'github-stars', 'Bad Source', '../escape', ...valid],
    takeovers: false,
  }, {});
  assert.equal(result.takeovers, false);
  assert.equal(result.hiddenSources[0], 'github-stars');
  assert.equal(result.hiddenSources.filter((id) => id === 'github-stars').length, 1);
  assert.equal(result.hiddenSources.length, 64);
  assert.equal(result.hiddenSources.includes('Bad Source'), false);
  assert.equal(result.hiddenSources.includes('../escape'), false);
});

test('both normalizers cover every chrome button the renderer can place', () => {
  const client = clientNormalizer()(null, {}).actions.map(a => a.id);
  const server = serverNormalizer()(null).map(a => a.id);
  assert.deepEqual([...client].sort(), [...actionRenderer].sort());
  assert.deepEqual([...server].sort(), [...actionRenderer].sort());
  // Order matters too: the two lists seed a user's initial layout, and a bar that
  // comes out differently depending on which side answered first is a bug the
  // user would see as the buttons rearranging themselves.
  assert.deepEqual(client, server);
});

test('the two doors back in can be moved and reordered but never hidden', () => {
  // Settings (undo anything) and Layout (rearrange the dashboard again) are the
  // only ways back in, and on a touchscreen there is no keyboard shortcut to fall
  // back on. The repair belongs to the normalizer, not the editor: this input is
  // exactly what a hand-edited settings.json, an old backup or a hostile payload
  // looks like, and none of those go through the editor's disabled eye.
  const hostile = [
    { id: 'settings', hidden: true, side: 'left' },
    { id: 'layout', hidden: true, side: 'left' },
  ];
  for (const out of [clientNormalizer()({ actions: hostile }, {}).actions, serverNormalizer()(hostile)]) {
    for (const id of ['settings', 'layout']) {
      const row = out.find(a => a.id === id);
      assert.equal(row.hidden, false, id + ' must never be hidden');
      assert.equal(row.side, 'left');   // moving it IS allowed
    }
    // ...and the rule is narrow: every other button still honours `hidden`.
    const other = clientNormalizer()({ actions: [{ id: 'search', hidden: true }] }, {}).actions;
    assert.equal(other.find(a => a.id === 'search').hidden, true);
  }
});

test('the button list drops unknown ids and duplicates, and keeps every canonical one', () => {
  for (const run of [
    (v) => clientNormalizer()({ actions: v }, {}).actions,
    (v) => serverNormalizer()(v),
  ]) {
    const out = run([
      { id: 'search', hidden: true, side: 'right' },
      { id: 'search', hidden: false, side: 'left' },   // duplicate: dropped
      { id: 'nope', hidden: true },                     // unknown: dropped
      { id: 'lock', side: 'sideways' },                 // bad side: default
    ]);
    assert.equal(out.filter(a => a.id === 'search').length, 1);
    assert.equal(out.find(a => a.id === 'search').hidden, true);
    assert.equal(out.find(a => a.id === 'search').side, 'right');
    assert.equal(out.find(a => a.id === 'lock').side, 'left');
    assert.equal(out.some(a => a.id === 'nope'), false);
    assert.deepEqual([...out.map(a => a.id)].sort(), [...actionRenderer].sort());
    // The ids the caller DID send keep their order, ahead of the appended rest.
    assert.equal(out[0].id, 'search');
  }
});

test('every chrome button has an editor label key, and that key exists in i18n', () => {
  const labelsSrc = read('server', 'js', 'settings.js')
    .match(/TOPBAR_ACTION_LABELS\s*=\s*\{([^}]*)\}/);
  assert.ok(labelsSrc, 'TOPBAR_ACTION_LABELS not found in settings.js');
  const labels = new Map();
  for (const m of labelsSrc[1].matchAll(/(\w+):\s*'([^']+)'/g)) labels.set(m[1], m[2]);
  const i18n = read('server', 'js', 'i18n.js');
  for (const id of actionRenderer) {
    const key = labels.get(id);
    assert.ok(key, 'chrome button "' + id + '" has no TOPBAR_ACTION_LABELS entry');
    assert.ok(new RegExp('"?' + key + '"?:\\s*[\'"]').test(i18n),
      'label key "' + key + '" is missing from i18n.js');
  }
});

test('every island segment has an editor label key, and that key exists in i18n', () => {
  const labelsSrc = read('server', 'js', 'settings.js')
    .match(/TOPBAR_ISLAND_LABELS\s*=\s*\{([^}]*)\}/);
  assert.ok(labelsSrc, 'TOPBAR_ISLAND_LABELS not found in settings.js');
  const labels = new Map();
  for (const m of labelsSrc[1].matchAll(/(\w+):\s*'([^']+)'/g)) labels.set(m[1], m[2]);
  const i18n = read('server', 'js', 'i18n.js');
  for (const id of renderer) {
    const key = labels.get(id);
    assert.ok(key, 'island segment "' + id + '" has no TOPBAR_ISLAND_LABELS entry');
    // en is the guaranteed fallback tier in i18n.js's t(); a key missing there
    // would render as the raw key name.
    assert.ok(new RegExp('"?' + key + '"?:\\s*[\'"]').test(i18n),
      'label key "' + key + '" is missing from i18n.js');
  }
});
