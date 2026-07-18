import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { nextSettingsRev } = require('../settings-rev.js');

// ── The monotonic contract ──────────────────────────────────────────────────
// Every settings writer assigns the rev through this helper. Two properties
// matter, and a violation of either is a cross-surface sync bug, not a cosmetic
// one: the result must be STRICTLY greater than the stored rev (or the broadcast
// that follows lands at or below a peer's own rev and the peer ignores it), and
// it must never fall BELOW a client that is already ahead (or that client stops
// adopting the server copy at all).

test('a client at or behind the stored rev gets the stored rev bumped', () => {
  assert.equal(nextSettingsRev(10, 10), 11);   // same base — two surfaces racing
  assert.equal(nextSettingsRev(10, 3), 11);    // stale client
  assert.equal(nextSettingsRev(10, 0), 11);    // client sent nothing
  assert.equal(nextSettingsRev(0, 0), 1);      // factory-fresh store
});

test('a client already ahead keeps its rev — the server never assigns a lower one', () => {
  // This is the case POST /api/weather/config got wrong in v4.6.1: the city field
  // bumps the local rev per keystroke while only the last debounced save reaches
  // the server, so the client legitimately arrives several revisions ahead.
  assert.equal(nextSettingsRev(10, 17), 17);
  assert.equal(nextSettingsRev(0, 5), 5);
});

test('the result is ALWAYS strictly greater than the stored rev', () => {
  // The property the broadcast depends on, over the whole interesting range.
  for (const prev of [0, 1, 7, 999, 100000]) {
    for (const incoming of [undefined, null, NaN, -5, 0, 1, prev - 1, prev, prev + 1, prev + 50]) {
      const next = nextSettingsRev(prev, incoming);
      assert.ok(next > prev, `nextSettingsRev(${prev}, ${incoming}) = ${next} must exceed ${prev}`);
    }
  }
});

test('the result never regresses below a well-formed client rev', () => {
  for (const prev of [0, 3, 500]) {
    for (const incoming of [1, 4, 501, 9999]) {
      assert.ok(nextSettingsRev(prev, incoming) >= incoming);
    }
  }
});

test('garbage revs degrade to a bump instead of corrupting the counter', () => {
  // Persisted/wire values are untrusted: a NaN or negative rev must never travel
  // into the store, where it would make every later comparison meaningless.
  for (const bad of [undefined, null, NaN, 'abc', {}, [], -1, -999, Infinity]) {
    assert.equal(nextSettingsRev(bad, bad), 1, `prev=incoming=${String(bad)}`);
  }
  assert.equal(nextSettingsRev(5, 'abc'), 6);
  assert.equal(nextSettingsRev('abc', 5), 5);
  assert.equal(nextSettingsRev(5, -3), 6);
  // Fractional revs are floored, matching normalizeHubSettings' Math.floor.
  assert.equal(nextSettingsRev(5, 8.7), 8);
  assert.equal(nextSettingsRev(5.9, 0), 6);
});

// ── Both writers actually go through it ─────────────────────────────────────
// The helper only prevents the bug if every settings-writing endpoint calls it.
// v4.6.1 shipped a second endpoint that re-implemented the rule and got it wrong,
// so assert on the source that neither endpoint has drifted back to hand-rolling
// it. Cheap, and it fails loudly the moment someone adds a third writer.

test('server.js assigns settings revs only through nextSettingsRev', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/settings-rev'\)/, 'server.js must require the shared helper');
  // Both known writers call it: POST /settings and POST /api/weather/config.
  const calls = src.match(/nextSettingsRev\(/g) || [];
  assert.ok(calls.length >= 2, `expected both settings writers to call it, saw ${calls.length}`);
  // No hand-rolled "prevRev + 1" rev assignment left behind on a settings write.
  assert.doesNotMatch(src, /\brev:\s*prevRev\s*\+\s*1\b/,
    'a settings writer is hand-rolling the rev again — route it through nextSettingsRev');
});
