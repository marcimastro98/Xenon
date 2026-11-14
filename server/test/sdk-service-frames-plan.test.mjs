// Which background packages get a hidden service frame (js/custom-widget.js,
// planServiceFrames). Until v5.1 the first four in install order won and the
// rest were dropped without a word: a badge-only widget installed fifth never
// showed, and switching other packages off in the top bar did not free a place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';

const src = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('  function planServiceFrames(');
const end = src.indexOf('\n  }\n', start) + 4;
const plan = vm.runInNewContext('(' + src.slice(start, end).trim() + ')');

const NO = { handlers: [], badge: false, mini: false, topbarButton: false, island: false, islandDynamic: false };
const grantsOf = (map) => (id) => ({ ...NO, ...(map[id] || {}) });
const opts = (extra) => ({
  max: 2, handlersOnly: false, suspended: () => false, leftPage: () => false, barShows: () => true, ...extra,
});
const island = (id) => ({ id, background: true, islandDynamic: true });
const badge = (id) => ({ id, background: true, badge: true });
const keys = (id) => ({ id, background: true, deck: { handlers: [{ id: 'press' }] } });
const ids = (r) => Array.from(r.run, (p) => p.id);

test('Deck keys first, then what stays on screen, island pop-ups last', () => {
  const pkgs = [island('a'), island('b'), badge('c'), keys('d')];
  const g = grantsOf({
    a: { island: true, islandDynamic: true }, b: { island: true, islandDynamic: true },
    c: { badge: true }, d: { handlers: ['press'] },
  });
  const r = plan(pkgs, g, opts());
  assert.deepEqual(ids(r), ['d', 'c']);
  assert.deepEqual(Array.from(r.left), ['a', 'b'], 'the ones past the cap are named, not dropped in silence');
});

test('a package switched off in the top bar gives its place up, unless it has Deck keys', () => {
  const pkgs = [badge('a'), keys('k'), badge('b')];
  const g = grantsOf({ a: { badge: true }, b: { badge: true }, k: { handlers: ['press'] } });
  const r = plan(pkgs, g, opts({ max: 8, barShows: (id) => id === 'b' }));
  assert.deepEqual(ids(r), ['k', 'b']);
  assert.deepEqual(Array.from(r.left), []);
});

test('ungranted, suspended, stopped or not background: no frame and no place taken', () => {
  const pkgs = [badge('none'), badge('sus'), badge('gone'), { id: 'fg', badge: true }, badge('ok')];
  const all = { badge: true };
  const g = grantsOf({ sus: all, gone: all, fg: all, ok: all });
  const r = plan(pkgs, g, opts({ max: 1, suspended: (id) => id === 'sus', leftPage: (id) => id === 'gone' }));
  assert.deepEqual(ids(r), ['ok']);
  assert.deepEqual(Array.from(r.left), []);
});

test('the widgets-only host runs Deck keys and nothing that shows in a bar it does not have', () => {
  const pkgs = [badge('a'), keys('k')];
  const g = grantsOf({ a: { badge: true }, k: { handlers: ['press'] } });
  assert.deepEqual(ids(plan(pkgs, g, opts({ max: 8, handlersOnly: true }))), ['k']);
});

test('the cap is 8 and the Installed list can read it', () => {
  assert.match(src, /const SERVICE_FRAMES_MAX = 8;/);
  assert.match(src, /serviceLeftOut: \(\) => serviceLeftOut\.slice\(\),\s+serviceFramesMax: SERVICE_FRAMES_MAX,/);
});

test('a single widget import asks for permissions when the widget works with no tile', () => {
  const share = readFileSync(new URL('../js/preset-share.js', import.meta.url), 'utf8');
  assert.match(share, /askIfRunsWithoutTile\(pkgId\);\r?\n[\s\S]{0,200}if \(!offerAddToPage\(\[pkgId\]\)\)/);
  assert.match(share, /if \(offTile\) CW\.requestGrants\(\[pkg\]\);/);
});
