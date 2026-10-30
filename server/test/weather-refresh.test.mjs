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
// fetchWeather is the one fetcher whose catch RENDERS instead of swallowing. A
// throw there escapes the function, `fetchingWeather` stays true and every later
// poll returns at the guard: weather is retired for the whole page and freezes on
// its last good reading until a reload — indistinguishable from a stale forecast,
// which is exactly what the report above looked like.
//
// The other way into that same state is a request that never settles, which is
// what actually shipped and was reported against v4.11.3; the deadline covering
// it, and the same guarantee for the sibling pollers, live in
// test/poller-deadline.test.mjs.

test('fetchWeather clears its guard in a finally, and its failure render cannot escape', () => {
  const src = read('js/system.js');
  const fn = src.slice(src.indexOf('async function fetchWeather('));
  const body = fn.slice(0, fn.indexOf('\nasync function '));
  assert.match(body, /\}\s*finally\s*\{\s*[\s\S]*?fetchingWeather\s*=\s*false;/, 'the guard must clear in a finally');
  // What is rendered on failure changed (a recent reading is kept and marked
  // stale rather than blanked); that the render is WRAPPED has not.
  assert.match(body, /try\s*\{\s*applyWeather\(.*\);\s*\}\s*catch/, 'the failure render must be guarded');
});

// ── The city chosen by hand, on the light pages too ─────────────────────────
// layer-lite.html and scene.html load system.js without settings.js. Its
// normalizer was missing there, so fetchWeather fell back to "auto" and a
// widget on the desktop showed the IP's town instead of the city the user typed.
test('fetchWeather keeps a manual city where settings.js is not loaded', async () => {
  const src = read('js/system.js');
  const fn = src.slice(src.indexOf('async function fetchWeather('));
  const body = fn.slice(0, fn.indexOf('\nasync function '));
  const urls = [];
  const run = new Function('hubSettings', 'fetchWithDeadline', 'applyWeather', 'weatherStaleFallback',
    `let fetchingWeather = false; const lang = 'it'; const SERVER = ''; const WEATHER_FETCH_TIMEOUT_MS = 1;
     ${body}
     return fetchWeather();`);
  const fetchStub = async (url) => { urls.push(url); return { ok: true, json: async () => ({ ok: true }) }; };
  await run({ weather: { mode: 'manual', city: 'Trento' } }, fetchStub, () => {}, () => null);
  await run({}, fetchStub, () => {}, () => null);
  const q0 = new URLSearchParams(urls[0].split('?')[1]);
  assert.equal(q0.get('mode'), 'manual');
  assert.equal(q0.get('city'), 'Trento');
  assert.equal(new URLSearchParams(urls[1].split('?')[1]).get('mode'), 'auto');
});
