import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// limitedStock() (js/utils.js) is the ONE place a limited-edition drop's numbers
// are derived, and it exists because of a real, visible failure: `left` and
// `soldOut` are added by the server proxy (community-catalog.js), so a surface
// reading a catalog that never passed through it — the published browser demo,
// which is the copy most people see — had neither. The Store's "new drops" card
// announced "undefined di 50 disponibili", and beside it a drop whose every copy
// was already claimed, announced as available.
//
// utils.js is a browser classic script (globals, no exports), so the function is
// lifted out of the source and exercised directly — the technique used by
// community-drop-closed.test.mjs and community-update-join.test.mjs.
const UTILS = readFileSync(fileURLToPath(new URL('../js/utils.js', import.meta.url)), 'utf8');

function loadLimitedStock() {
  const start = UTILS.indexOf('function limitedStock(');
  assert.ok(start > 0, 'limitedStock not found — did utils.js move it?');
  const close = UTILS.indexOf('\n}', start);
  assert.ok(close > start, 'limitedStock block not delimited as expected');
  const ctx = vm.createContext({});
  vm.runInContext(UTILS.slice(start, close + 2) + '\nthis.limitedStock = limitedStock;', ctx);
  return ctx.limitedStock;
}

const limitedStock = loadLimitedStock();

// The exact shape docs/community/catalog.json publishes: total + claimed, and
// nothing else. This is the input that produced the bug.
test('a static catalog entry (total + claimed only) still yields real numbers', () => {
  // Field by field: the object comes back from a vm context, so its prototype is
  // that realm's Object and a strict deep-equal would fail on that alone.
  const s = limitedStock({ total: 50, claimed: 45 });
  assert.equal(s.total, 50);
  assert.equal(s.left, 5);
  assert.equal(s.claimed, 45);
  assert.equal(s.soldOut, false);
  assert.equal(String(s.left), '5', 'never the string "undefined"');
});

test('every copy claimed is sold out, with or without the flag', () => {
  assert.equal(limitedStock({ total: 6, claimed: 6 }).soldOut, true);
  assert.equal(limitedStock({ total: 6, claimed: 6 }).left, 0);
  assert.equal(limitedStock({ total: 6, claimed: 0, soldOut: true }).soldOut, true,
    'an explicit flag still wins even when the counts disagree');
});

// The proxied path must be untouched: its `left` is the live hub count and is
// fresher than the catalog's published `claimed`.
test('an explicit left wins over the published claimed', () => {
  const s = limitedStock({ total: 50, claimed: 45, left: 2, soldOut: false });
  assert.equal(s.left, 2);
  assert.equal(s.claimed, 48);
  assert.equal(s.soldOut, false);
});

test('nonsense is clamped rather than printed', () => {
  assert.equal(limitedStock({ total: 10, left: 999 }).left, 10);
  assert.equal(limitedStock({ total: 10, left: -4 }).left, 0);
  assert.equal(limitedStock({ total: 10, left: -4 }).soldOut, true);
  assert.equal(limitedStock({ total: 10, claimed: 99 }).left, 0);
  assert.equal(limitedStock({ total: 10, left: 'seven' }).left, 10,
    'an unusable left falls back to the published pair, never to NaN');
});

// null is "there is no meter to draw" — the callers branch on it, so it must not
// come back as a zeroed object that renders an empty bar.
test('no usable total answers null', () => {
  assert.equal(limitedStock(null), null);
  assert.equal(limitedStock({}), null);
  assert.equal(limitedStock({ total: 0, claimed: 0 }), null);
  assert.equal(limitedStock('50'), null);
});
