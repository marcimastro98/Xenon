// A kWh chip by the clock with no tile anywhere: a background service frame may
// refresh `energy`, and only `energy`. Every other pulled stream costs a collector
// run, so out of sight it stays refused; a tile that is not on screen stays refused
// for every stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CUSTOM = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const DOC = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');

const loaders = () => {
  const start = CUSTOM.indexOf('const LOCAL_STREAM_LOADERS');
  const end = CUSTOM.indexOf('\n  });', start);
  assert.ok(start > 0 && end > start, 'the loader table is where it was');
  return CUSTOM.slice(start, end);
};

test('only the energy loader may be pulled out of sight', () => {
  const table = loaders();
  const marked = [...table.matchAll(/^\s{4}(\w+): Object\.freeze\(\{[^\n]*outOfSight: true/gm)].map((m) => m[1]);
  assert.deepEqual(marked, ['energy']);
});

test('a service frame refreshes only an out-of-sight stream; a hidden tile is still refused', () => {
  const fn = CUSTOM.slice(CUSTOM.indexOf('function entryCanRefreshLocalStream'), CUSTOM.indexOf('async function loadLocalStream'));
  assert.match(fn, /document\.hidden/, 'a hidden dashboard asks nothing');
  assert.match(fn, /if \(entry\.service\) return LOCAL_STREAM_LOADERS\[stream\]\.outOfSight === true;/);
  assert.match(fn, /onVisiblePage\(entry\.frame\)/, 'tiles still need their page on screen');
  assert.match(CUSTOM, /if \(!entryCanRefreshLocalStream\(entry, stream\)\)/);
});

test('the SDK guide says so', () => {
  assert.match(DOC, /`energy` is the one pulled stream a background service\s+frame may `refresh`/);
  assert.match(DOC, /may `refresh` only `energy`/);
});
