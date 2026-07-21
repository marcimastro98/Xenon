// Weather location is SERVER-owned: POST /api/weather/config is its sole writer
// and the whole-blob POST /settings preserves the stored copy (server.js
// keep-prev guard, GitHub #109). The client hydrate must honour that — it must
// adopt the server's weather block as authoritative even when the rest of the
// merge takes `base = localRaw` because this surface's unrelated local edits
// pushed its top-level rev past the server's. When it didn't, a surface whose
// localStorage rev ran ahead resurrected its own stale location on boot (a manual
// city flipped back to auto on every restart) and ignored a location set on
// another surface — the app-vs-browser divergence reported as the GitHub #88
// follow-up. The one exception is a local edit not yet acknowledged by the server
// (dirty / parked pre-first-hydrate), which must survive the copy we just fetched.
//
// _hydrateHubSettingsImpl can't be imported (js/settings.js is a classic script
// full of browser globals), so — like settings-rev.test.mjs asserts on the real
// helper — this pulls the actual reconciliation expression out of the source and
// evaluates IT, so the guarantee is tested, not a paraphrase of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');

// The `weather:` reconciliation ternary from the _hydrateHubSettingsImpl merge.
// Captured from `weather: (_weatherConfigDirty …` to the closing `))` of the
// final `(localRaw && localRaw.weather))` — three source lines, one expression.
function weatherReconciler() {
  const m = SRC.match(
    /weather:\s*(\(_weatherConfigDirty[\s\S]*?\(localRaw && localRaw\.weather\)\))/,
  );
  assert.ok(m, 'weather reconciliation expression not found in _hydrateHubSettingsImpl');
  // eslint-disable-next-line no-new-func
  return new Function(
    '_weatherConfigDirty', '_weatherConfigSavePending', 'localRaw', 'data',
    'return ' + m[1] + ';',
  );
}

const SERVER = { mode: 'manual', city: 'Rome' };   // authoritative location
const LOCAL = { mode: 'auto', city: '' };          // this surface's stale copy
const data = { settings: { weather: SERVER } };
const localRaw = { weather: LOCAL };

test('a clean hydrate adopts the SERVER weather, even when localRaw is otherwise the base', () => {
  const pick = weatherReconciler();
  // This is the restart-reverts-to-auto case: local rev ran ahead (so `base` is
  // localRaw) but there is no unacknowledged local weather edit.
  assert.deepEqual(pick(false, false, localRaw, data), SERVER);
});

test('an unacknowledged local weather edit (dirty) is NOT clobbered by the fetched copy', () => {
  const pick = weatherReconciler();
  assert.deepEqual(pick(true, false, localRaw, data), LOCAL);   // save still in flight
  assert.deepEqual(pick(false, true, localRaw, data), LOCAL);   // parked pre-first-hydrate
});

test('falls back to the local copy only when the server has no weather block yet', () => {
  const pick = weatherReconciler();
  const noServerWeather = { settings: {} };
  assert.deepEqual(pick(false, false, localRaw, noServerWeather), LOCAL);
});

// ── The write side keeps this surface's rev in step with the server ──────────
// nextSettingsRev() always returns a rev strictly above the stored one, so after
// a weather save the server sits ABOVE this surface's local rev. If the ack is
// discarded, that gap makes the surface's own later broadcasts look "already
// held" and, at the next boot, flips it to localNewer — the very skew that
// resurrects a stale location. So the POST must READ the ack, not drain it, and
// adopt its rev.

test('postWeatherConfigToServer reads the ack (adopts server rev) instead of discarding it', () => {
  const fn = SRC.match(/function postWeatherConfigToServer\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'postWeatherConfigToServer not found');
  assert.match(fn[0], /res\.json\(\)/, 'must read the JSON ack');
  assert.doesNotMatch(fn[0], /res\.arrayBuffer\(\)/, 'must not blindly drain the ack');
});

test('_adoptWeatherConfigAck raises the local rev to the server’s (never lowers it)', () => {
  const fn = SRC.match(/function _adoptWeatherConfigAck\(ack\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, '_adoptWeatherConfigAck not found');
  assert.match(fn[0], /Math\.max\(\s*localRev\s*,\s*serverRev\s*\)/, 'rev must be Math.max(local, server)');
});

test('commitWeatherChange marks the surface dirty until the server confirms', () => {
  const fn = SRC.match(/function commitWeatherChange\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fn, 'commitWeatherChange not found');
  assert.match(fn[0], /_weatherConfigDirty\s*=\s*true/, 'must set the dirty flag');
});
