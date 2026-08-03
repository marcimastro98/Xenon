import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// ── One dashboard, one forecast ─────────────────────────────────────────────
// Weather is the only live reading that is client-polled rather than pushed over
// SSE (the server cache is keyed by language, so a shared broadcast could not
// serve two surfaces on different languages). That leaves every surface holding
// its own timer, started whenever that surface happened to open — so the Xeneon
// Edge kiosk left on for hours and a browser tab opened a minute ago could ask
// half an hour apart and show two different forecasts side by side on the same
// PC. Reported on Discord against v4.10.1 ("20° cloudy" in the app, "19° drizzle"
// in the browser, same city, same minute). The fix is that the poll lands on the
// wall clock, so every surface asks at the same instant and the server's
// in-flight dedup hands them all the same object.

test('the weather poll is anchored to the wall clock, not to page-load time', () => {
  const main = read('js/main.js');
  assert.match(
    main,
    /periodMs\s*-\s*\(Date\.now\(\)\s*%\s*periodMs\)/,
    'startWeatherPolling must schedule against the epoch grid',
  );
  assert.doesNotMatch(
    main,
    /setInterval\(\s*fetchWeather/,
    'a plain setInterval re-introduces per-surface drift',
  );
});

test('a timer firing on the boundary cannot re-arm into a tight loop', () => {
  // Date.now() % periodMs is ~0 at the moment the timer fires, so without the
  // floor the next delay is a few milliseconds and the poll runs twice.
  assert.match(read('js/main.js'), /delay\s*<\s*1000\)\s*delay\s*\+=\s*periodMs/);
});

// ── The re-entrancy guard must always clear ─────────────────────────────────
// fetchWeather is the one fetcher whose catch RENDERS (applyWeather(null)) instead
// of swallowing. A throw there escapes the function, `fetchingWeather` stays true
// and every later poll returns at the guard: weather is retired for the whole page
// and freezes on its last good reading until a reload — indistinguishable from a
// stale forecast, which is exactly what the report above looked like.

test('fetchWeather clears its guard in a finally, and its failure render cannot escape', () => {
  const src = read('js/system.js');
  const fn = src.slice(src.indexOf('async function fetchWeather('));
  const body = fn.slice(0, fn.indexOf('\nasync function '));
  assert.match(body, /\}\s*finally\s*\{\s*[\s\S]*?fetchingWeather\s*=\s*false;/, 'the guard must clear in a finally');
  assert.match(body, /try\s*\{\s*applyWeather\(null\);\s*\}\s*catch/, 'the failure render must be guarded');
});
