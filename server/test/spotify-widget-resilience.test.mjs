// A list that failed to load is not an empty list.
//
// The Spotify widget already rode out Spotify's 429s everywhere that mattered:
// the player keeps its last state, the queue is explicitly kept ("transient —
// keep the last known queue"), transport falls back to SMTC. Two loaders did
// the opposite and set the list to [], which renders as "No devices found" /
// "No playlists" — a confident statement that the account has none.
//
// The Devices tab is reloaded on EVERY poll while it is open, so a single
// refused request replaced the user's speakers with "No devices found" until a
// later tick happened to succeed. Reported as "preserve loaded content during
// temporary failures and provide clearer status messages".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'spotify-widget.js'), 'utf8');

// Run the real loaders against a stubbed `api`, with the module's own state.
function harness() {
  const body = `
    let playlists = null, devices = null, playlistsProblem = '', devicesProblem = '';
    ${/function reasonFor\(d\) \{[\s\S]*?\n  \}/.exec(SRC)[0]}
    ${/function loadPlaylists\(\) \{[\s\S]*?\n  \}/.exec(SRC)[0]}
    ${/function loadDevices\(\) \{[\s\S]*?\n  \}/.exec(SRC)[0]}
    return {
      loadPlaylists, loadDevices,
      state: () => ({ playlists, devices, playlistsProblem, devicesProblem }),
    };
  `;
  let answer = null;
  // eslint-disable-next-line no-new-func
  const make = new Function('api', body);
  const h = make(() => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)));
  h.answers = (v) => { answer = v; };
  return h;
}

test('a good answer fills the list and clears the problem', async () => {
  const h = harness();
  h.answers({ ok: true, devices: [{ name: 'Sonos' }], playlists: [{ name: 'Focus' }] });
  await h.loadDevices();
  await h.loadPlaylists();
  assert.deepEqual(h.state().devices, [{ name: 'Sonos' }]);
  assert.deepEqual(h.state().playlists, [{ name: 'Focus' }]);
  assert.equal(h.state().devicesProblem, '');
  assert.equal(h.state().playlistsProblem, '');
});

test('a genuinely empty account still reads as empty', async () => {
  // The whole fix would be worthless if it also stopped saying "no devices"
  // when there really are none.
  const h = harness();
  h.answers({ ok: true, devices: [], playlists: [] });
  await h.loadDevices();
  await h.loadPlaylists();
  assert.deepEqual(h.state().devices, []);
  assert.deepEqual(h.state().playlists, []);
  assert.equal(h.state().devicesProblem, '');
});

for (const [label, answer, reason] of [
  ['a 429', { error: 'rate_limited' }, 'rate_limited'],
  ['an unlinked account', { error: 'not_connected' }, 'not_connected'],
  ['a refused request', { ok: false }, 'failed'],
  ['no answer at all', null, 'failed'],
  ['a thrown request', new Error('offline'), 'failed'],
]) {
  test(`${label} leaves the loaded list alone`, async () => {
    const h = harness();
    h.answers({ ok: true, devices: [{ name: 'Sonos' }, { name: 'Desk' }], playlists: [{ name: 'Focus' }] });
    await h.loadDevices();
    await h.loadPlaylists();
    h.answers(answer);
    await h.loadDevices();
    await h.loadPlaylists();
    assert.deepEqual(h.state().devices, [{ name: 'Sonos' }, { name: 'Desk' }], 'the speakers vanished');
    assert.deepEqual(h.state().playlists, [{ name: 'Focus' }], 'the playlists vanished');
    assert.equal(h.state().devicesProblem, reason);
    assert.equal(h.state().playlistsProblem, reason);
  });

  test(`${label} on a list that never loaded says why`, async () => {
    const h = harness();
    h.answers(answer);
    await h.loadDevices();
    assert.equal(h.state().devices, null, 'an unloaded list must stay unloaded, not become empty');
    assert.equal(h.state().devicesProblem, reason);
  });
}

test('recovery replaces the kept list', async () => {
  const h = harness();
  h.answers({ ok: true, devices: [{ name: 'Sonos' }] });
  await h.loadDevices();
  h.answers({ error: 'rate_limited' });
  await h.loadDevices();
  h.answers({ ok: true, devices: [{ name: 'Sonos' }, { name: 'Kitchen' }] });
  await h.loadDevices();
  assert.deepEqual(h.state().devices, [{ name: 'Sonos' }, { name: 'Kitchen' }]);
  assert.equal(h.state().devicesProblem, '');
});

// ── the panels have to notice ───────────────────────────────────────────────
test('the repaint signature carries the problem', () => {
  // Both panels skip the repaint when their signature is unchanged. A list that
  // is still null has the same signature whatever went wrong, so without this
  // the reason would be computed and never drawn.
  for (const [panel, flag] of [['paintPlaylists', 'playlistsProblem'], ['paintDevices', 'devicesProblem']]) {
    const m = new RegExp(`function ${panel}\\(mount\\) \\{[\\s\\S]*?\\n  \\}`).exec(SRC);
    assert.ok(m, `${panel} is gone`);
    assert.match(m[0], new RegExp(`const sig = [^\\n]*'l' \\+ ${flag}`), `${panel}: the signature ignores the problem`);
    assert.match(m[0], new RegExp(`${flag} \\? problemLine\\(${flag}\\)`), `${panel}: the reason is never shown`);
  }
});

test('unlinking clears the reason with the lists', () => {
  // Otherwise a stale "Spotify is busy" outlives the reconnect it has nothing
  // to do with.
  const m = /player = null; queue = null; playlists = null; devices = null;[^\n]*/.exec(SRC);
  assert.ok(m, 'the unlink reset is gone');
  assert.match(m[0], /playlistsProblem = ''/);
  assert.match(m[0], /devicesProblem = ''/);
});

test('every reason has a line to print', () => {
  const m = /function problemLine\(problem\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(m, 'problemLine is gone');
  for (const reason of ['rate_limited', 'not_connected']) {
    assert.ok(m[0].includes(`'${reason}'`), `no line for ${reason}`);
  }
  // …and the fallback, which is what 'failed' lands on.
  assert.match(m[0], /spotify_w_unreachable/);
});

// ── How long, not just "busy" ───────────────────────────────────────────────
// "Spotify is busy — retrying shortly" is right for the few seconds a 429
// usually lasts. It is wrong for the hours Spotify imposes on an app that has
// burnt its quota, which is what was reported: "I hit the rate limit, waited 24
// hours, and the limit persists" — against a dashboard still promising shortly.
// The server already knew how long (it holds the breaker to Retry-After); it
// simply never said.
const SERVER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'stream-spotify.js'), 'utf8');

test('the refusal carries how long the breaker holds', () => {
  const m = /async function apiRequest\(method, pathWithQuery, bodyObj\) \{[\s\S]*?\n  \}/.exec(SERVER);
  assert.ok(m, 'apiRequest is gone');
  const refusals = m[0].match(/error: 'rate_limited'[^}]*/g) || [];
  assert.equal(refusals.length, 2, 'expected the pre-check and the live 429');
  for (const r of refusals) assert.match(r, /retryAfterMs: retryAfterMs\(\)/, `a refusal says nothing about the wait: ${r}`);
});

test('the device list passes the wait on rather than flattening it', () => {
  const m = /async function getDevices\(\) \{[\s\S]*?\n  \}/.exec(SERVER);
  assert.ok(m, 'getDevices is gone');
  assert.match(m[0], /error: r\.error \|\| 'failed', retryAfterMs: r\.retryAfterMs/);
});

test('the widget names the wait once it is worth naming', () => {
  const m = /function busyLine\(\) \{[\s\S]*?\n  \}/.exec(SRC);
  assert.ok(m, 'busyLine is gone');
  // Under two minutes the old wording is still the honest one.
  assert.match(m[0], /mins >= 2/);
  assert.match(m[0], /spotify_w_busy_for/);
  assert.match(m[0], /spotify_w_busy'/);
});

test('every place that says "busy" says it the same way', () => {
  // Four of them, and three used to hardcode the short wording — so the same
  // wait read as minutes in one corner of the tile and as "shortly" in another.
  const stray = SRC.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /t\('spotify_w_busy',/.test(line) && !/function busyLine/.test(line));
  assert.equal(stray.length, 1,
    'the short wording is used outside busyLine():\n  ' + stray.map((s) => s.n + ': ' + s.line.trim()).join('\n  '));
});

test('the wait resets when the limit clears', () => {
  // A stale figure would keep a recovered integration reading "about 40 min".
  const m = /if \(p && p\.error === 'rate_limited'\)[\s\S]{0,160}/.exec(SRC);
  assert.ok(m, 'the rate-limit branch is gone');
  assert.match(m[0], /rateLimitMs = Number\(p\.retryAfterMs\) \|\| 0;/);
  assert.match(m[0], /rateLimited = false;\s*\n\s*rateLimitMs = 0;/);
});
