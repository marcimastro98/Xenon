import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

// ── A hung request must not retire a poller for the whole page ──────────────
// `fetch` has no timeout of its own, so a request that never settles leaves its
// awaiting function pending forever. In a poller guarded by an "already
// fetching" flag that is permanent: the flag never clears, every later tick
// returns at the guard, and the reading is dead until the user reloads by hand.
// Reported on Discord against v4.11.3 — the weather tile emptied after a while
// and only a manual reload brought it back, while `/weather` answered correctly
// in a browser at that same moment, which is what ruled out the server and the
// providers. The dashboard is left open for days on the Edge and in the kiosk
// app, so one hung connection only has to happen once.
//
// Both halves are required and each is useless alone: the deadline (so the await
// ends) and the `finally` (so the flag clears even when it ends by throwing).
const __dirname = dirname(fileURLToPath(import.meta.url));
const JS = join(__dirname, '..', 'js');
const read = (f) => readFileSync(join(JS, f), 'utf8');

// The real helper, lifted out of utils.js and run against a fetch that never
// settles — the exact condition the bug needs, which no amount of reading the
// source proves.
function deadlineHelper(fetchImpl) {
  const src = read('utils.js').match(/function fetchWithDeadline\(url, ms, opts\) \{[\s\S]*?\n\}/);
  assert.ok(src, 'fetchWithDeadline not found in js/utils.js');
  const ctx = { fetch: fetchImpl, AbortController, setTimeout, clearTimeout };
  vm.createContext(ctx);
  vm.runInContext(`${src[0]}\nglobalThis.__f = fetchWithDeadline;`, ctx, { filename: 'utils.js' });
  return ctx.__f;
}

test('a request that never settles is abandoned, and the abort is observable', async () => {
  let seenSignal = null;
  const hang = (url, opts) => new Promise((_resolve, reject) => {
    seenSignal = opts.signal;
    opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(deadlineHelper(hang)('/weather', 20), /aborted/);
  assert.ok(seenSignal.aborted, 'the signal must actually be aborted, not merely passed');
});

test('the deadline timer is cleared on the normal path too', async () => {
  // Left armed, every poll would leave a pending timer behind — on a dashboard
  // open for days that is a slow leak in the one place we are fixing a hang.
  const armed = new Set();
  const src = read('utils.js').match(/function fetchWithDeadline\(url, ms, opts\) \{[\s\S]*?\n\}/)[0];
  const ctx = {
    fetch: async () => ({ ok: true }),
    AbortController,
    setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); armed.add(id); return id; },
    clearTimeout: (id) => { armed.delete(id); clearTimeout(id); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${src}\nglobalThis.__f = fetchWithDeadline;`, ctx, { filename: 'utils.js' });
  await ctx.__f('/system', 5000);
  assert.equal(armed.size, 0, 'the timer must be cleared when the request succeeds');
});

test('a caller-supplied option cannot drop the abort signal', () => {
  // `{...opts, signal}` and `{signal, ...opts}` differ by exactly this: the
  // second lets a caller passing its own signal silently disable the deadline.
  const src = read('utils.js');
  assert.match(src, /\{\s*\.\.\.\(opts \|\| \{\}\),\s*signal: ctrl\.signal\s*\}/);
});

// Every flag-guarded poller, and what it fetches. A new one belongs in this
// list: the failure mode is invisible in review and permanent in production.
const POLLERS = [
  { file: 'system.js', fn: 'fetchWeather', flag: 'fetchingWeather' },
  { file: 'system.js', fn: 'fetchSystem', flag: 'fetchingSystem' },
  { file: 'network.js', fn: 'fetchNetwork', flag: 'fetchingNetwork' },
  { file: 'volume.js', fn: 'fetchAudio', flag: 'fetchingAudio' },
];

function body(file, fn) {
  const src = read(file);
  const start = src.search(new RegExp(`async function ${fn}\\(\\)\\s*\\{`));
  assert.ok(start >= 0, `${fn} not found in js/${file}`);
  // To the next top-level declaration — these are classic scripts, so a
  // function's body ends where the next one starts at column 0.
  const rest = src.slice(start + 1);
  const end = rest.search(/^(async function|function|const|let) /m);
  return rest.slice(0, end > 0 ? end : rest.length);
}

test('every flag-guarded poller clears its flag in a finally', () => {
  for (const { file, fn, flag } of POLLERS) {
    const src = body(file, fn);
    assert.match(src, new RegExp(`${flag} = true`), `${fn} does not set ${flag}`);
    assert.match(
      src,
      new RegExp(`finally\\s*\\{[^}]*${flag} = false`),
      `${fn} must clear ${flag} in a finally — a throw or an abort otherwise strands it`,
    );
  }
});

test('every flag-guarded poller fetches behind a deadline', () => {
  for (const { file, fn } of POLLERS) {
    const src = body(file, fn);
    assert.match(src, /fetchWithDeadline\(/, `${fn} must fetch through fetchWithDeadline`);
    assert.doesNotMatch(
      src,
      /await fetch\(/,
      `${fn} still has a bare fetch — that one can hang forever and the guard makes it permanent`,
    );
  }
});

test('a failed weather poll keeps the last reading instead of blanking the tile', () => {
  // A request that did not arrive says nothing about the weather, and a forecast
  // from 15 minutes ago is still worth reading. Bounded, though: one from this
  // morning shown as current is worse than an empty card.
  const src = read('system.js');
  const fn = src.match(/function weatherStaleFallback\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'weatherStaleFallback not found in js/system.js');
  const ctx = { lastGoodWeather: null, WEATHER_STALE_MAX_MS: 3 * 60 * 60 * 1000, Date };
  vm.createContext(ctx);
  vm.runInContext(`${fn[0]}\nglobalThis.__f = weatherStaleFallback;`, ctx, { filename: 'system.js' });

  assert.equal(ctx.__f(), null, 'nothing to fall back on before the first success');
  ctx.lastGoodWeather = { ok: true, tempC: 21, updatedAt: Date.now() - 15 * 60 * 1000 };
  const recent = ctx.__f();
  assert.equal(recent.tempC, 21);
  assert.equal(recent.stale, true, 'the tile must be told it is showing an old reading');
  ctx.lastGoodWeather = { ok: true, tempC: 21, updatedAt: Date.now() - 4 * 60 * 60 * 1000 };
  assert.equal(ctx.__f(), null, 'past the cap the failure is reported honestly');
  ctx.lastGoodWeather = { ok: true, tempC: 21, updatedAt: Date.now() + 60 * 1000 };
  assert.equal(ctx.__f(), null, 'a clock jump must not make a reading immortal');

  // Only a fresh success may become the fallback — re-storing a stale copy would
  // keep renewing its own age and the cap above would never be reached.
  assert.match(read('system.js'), /if \(data && data\.ok && !data\.stale\) lastGoodWeather = data;/);
});
