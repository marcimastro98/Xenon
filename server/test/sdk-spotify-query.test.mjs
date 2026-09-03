import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const { createSpotifyProvider } = require('../stream-spotify.js');

// A widget that browses a Spotify library needs authenticated reads, and there
// are two ways to give it those: hand over the token, or name the reads. This
// names them — an `op` indexes a table of functions, so an op we do not have is
// not a request, and no path a widget sends can become a URL.
//
// Requested by a widget author who had built the browser against a private
// sidecar of his own and wanted to delete it.

/** A connected provider wired to a fake fetch, so the paths it builds can be
 *  read back. Same shape as stream-spotify.test.mjs: a live token on disk. */
function probe(onUrl, status = 200, body = { ok: 1 }) {
  const file = join(tmpdir(), `xe-sq-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 },
  }));
  return createSpotifyProvider({
    clientId: 'cid',
    tokensFile: file,
    fetch: async (url) => {
      onUrl(String(url));
      return { ok: status < 400, status, json: async () => body };
    },
  });
}

/** Same, but the fetch does not answer until `gate` resolves — for the two
 *  callers that have to fold into one upstream call. */
function probeSlow(onUrl, gate, status = 200, body = { ok: 1 }) {
  const file = join(tmpdir(), `xe-sq-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 },
  }));
  return createSpotifyProvider({
    clientId: 'cid',
    tokensFile: file,
    fetch: async (url) => {
      onUrl(String(url));
      await gate;
      return { ok: status < 400, status, json: async () => body };
    },
  });
}

test('every documented op maps to a real Spotify path', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  const OPS = [
    ['player', {}, '/me/player'],
    ['queue', {}, '/me/player/queue'],
    ['devices', {}, '/me/player/devices'],
    ['playlists', {}, '/me/playlists?'],
    ['savedAlbums', {}, '/me/albums?'],
    ['savedTracks', {}, '/me/tracks?'],
    ['recent', {}, '/me/player/recently-played?'],
    ['followedArtists', {}, '/me/following?type=artist'],
    ['artistAlbums', { id: '4Z8W4fKeB5YxbusRsdQVPb' }, '/artists/4Z8W4fKeB5YxbusRsdQVPb/albums?'],
    ['albumTracks', { id: '4Z8W4fKeB5YxbusRsdQVPb' }, '/albums/4Z8W4fKeB5YxbusRsdQVPb/tracks?'],
    ['playlistTracks', { id: '4Z8W4fKeB5YxbusRsdQVPb' }, '/playlists/4Z8W4fKeB5YxbusRsdQVPb/tracks?'],
    ['search', { q: 'radiohead' }, '/search?type='],
  ];
  for (const [op, params, expect] of OPS) {
    seen.length = 0;
    const r = await p.query(op, params);
    assert.equal(r.ok, true, `${op} failed: ${r.error}`);
    assert.ok(seen[0] && seen[0].includes(expect), `${op} built ${seen[0]}`);
  }
});

test('an op we do not have is not a request', async () => {
  let called = false;
  const p = probe(() => { called = true; });
  for (const op of ['', 'nope', 'constructor', '__proto__', 'toString', '/me/tracks']) {
    const r = await p.query(op, {});
    assert.equal(r.ok, false, op);
    assert.equal(r.error, 'bad_op', op);
  }
  assert.equal(called, false, 'a rejected op must never reach the network');
});

test('an id can never carry a path, and a missing one is refused', async () => {
  let called = false;
  const p = probe(() => { called = true; });
  for (const id of ['../../me/tracks', 'abc/def', 'a?b=c', '', null, 'x'.repeat(80)]) {
    const r = await p.query('albumTracks', { id });
    assert.equal(r.ok, false, String(id));
    assert.equal(r.error, 'bad_params', String(id));
  }
  assert.equal(called, false, 'a rejected id must never reach the network');
});

test('paging is clamped, so one call cannot ask for a whole library', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  await p.query('savedTracks', { limit: 5000, offset: -20 });
  assert.match(seen[0], /limit=50/);
  assert.match(seen[0], /offset=0/);
  seen.length = 0;
  await p.query('playlistTracks', { id: '4Z8W4fKeB5YxbusRsdQVPb', limit: 999 });
  assert.match(seen[0], /limit=100/, 'playlist tracks get the larger page and no more');
});

test('search takes only the four types it documents', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  await p.query('search', { q: 'x', types: 'track,evil,album' });
  assert.match(seen[0], /type=track,album/, 'an unknown type is dropped, not passed on');
  const bad = await p.query('search', { q: 'x', types: 'evil' });
  assert.equal(bad.error, 'bad_params');
  const empty = await p.query('search', { q: '   ' });
  assert.equal(empty.error, 'bad_params');
});

test('a 403 is named, because it means "reconnect" and nothing the widget did', async () => {
  // The two new scopes are the only ones a CONNECTED user might lack: their
  // token stays valid for everything else, so this must not read as a failure
  // of the widget or of Spotify.
  const p = probe(() => {}, 403, {});
  const r = await p.query('recent', {});
  assert.deepEqual(r, { ok: false, error: 'insufficient_scope', status: 403 });
});

test('playUri takes the four kinds a browser needs, and nothing else', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  assert.equal((await p.playUri('spotify:album:4Z8W4fKeB5YxbusRsdQVPb')).ok, true);
  for (const bad of ['spotify:user:me', 'https://evil/x', 'spotify:track:../x', '', 'spotify:track:' + 'x'.repeat(80)]) {
    const r = await p.playUri(bad);
    assert.equal(r.ok, false, bad);
    assert.equal(r.error, 'bad_uri', bad);
  }
});

test('a track plays as a track, a collection as a context', () => {
  // Spotify's play endpoint draws that distinction itself; getting it wrong
  // plays one song from an album instead of the album.
  const src = read('server/stream-spotify.js');
  assert.match(src, /u\.startsWith\('spotify:track:'\) \? \{ uris: \[u\] \} : \{ context_uri: u \}/);
});

test('the two new scopes are requested', () => {
  const src = read('server/stream-spotify.js');
  assert.match(src, /'user-read-recently-played'/);
  assert.match(src, /'user-follow-read'/);
});

test('reading is a separate grant from controlling playback', () => {
  // "Control Spotify playback" is play/pause/skip. Listening history, saved
  // music and followed artists are a different thing to hand over, and a
  // permission already granted for the first must not become the second.
  const sdk = require('../sdk-widgets.js');
  assert.ok(sdk.SDK_STREAMS.includes('spotify'), 'the reads need a grant of their own');
  assert.ok(!sdk.SDK_ACTION_CATEGORIES.spotify.includes('spotifyQuery'),
    'reading must not ride the playback action category');
  const bridge = read('server/js/custom-widget.js');
  assert.match(bridge, /if \(!grant\.streams\.includes\('spotify'\)\) \{ reply\(\{ ok: false, error: 'not_allowed' \}\); return; \}/);
  const server = read('server/server.js');
  assert.match(server, /sdkGrantsFor\(pkgId\)\.streams\.includes\('spotify'\)/,
    'the server has to check it too — the bridge is convenience, not the boundary');
});

test('the endpoint is rate-gated, because the quota is the user\'s', () => {
  // These calls spend the USER's Spotify quota, shared with the dashboard's own
  // Spotify tile: a widget searching on every keystroke would stop their music
  // working, and it would look like Xenon broke.
  const server = read('server/server.js');
  const start = server.indexOf("reqPath === '/stream/spotify/query'");
  const body = server.slice(start, start + 1600);
  assert.match(body, /sdkTileGate\(pkgId/, 'no gate on a route that spends someone else\'s quota');
  assert.match(body, /rate_limited/);
});

// ── Absorbing the bursts ─────────────────────────────────────────────────────
// The same widget author came back with "spotify's api burst rates": paging a
// library ten albums at a time, plus the covers, spends the USER's quota — the
// same quota the dashboard's own Spotify tile needs to keep playing music. The
// host collapses repeats so a widget does not have to build a cache of its own.

test('two identical reads in flight at once cost one call to Spotify', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const p = probeSlow((u) => seen.push(u), gate);
  const a = p.query('savedAlbums', { limit: 10 });
  const b = p.query('savedAlbums', { limit: 10 });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(seen.length, 1, 'a re-render mid-fetch must fold into the read already running');
  assert.equal(ra.ok, true);
  assert.deepEqual(rb, ra);
});

test('a repeat within the window is answered from memory', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  await p.query('playlists', {});
  await p.query('playlists', {});
  assert.equal(seen.length, 1, 'scrolling back to a page just read must not spend the quota again');
});

test('a different page is a different read', async () => {
  const seen = [];
  const p = probe((u) => seen.push(u));
  await p.query('savedAlbums', { offset: 0 });
  await p.query('savedAlbums', { offset: 10 });
  assert.equal(seen.length, 2, 'the cache is keyed on the path, not on the op');
});

test('a failure is never cached', async () => {
  // Ten seconds of a widget that looks broken, from one blip, is worse than the
  // extra call — and a rate-limit answer held past its own cooldown would keep
  // telling a widget to wait after the way is clear.
  const seen = [];
  const p = probe((u) => seen.push(u), 500, {});
  await p.query('playlists', {});
  await p.query('playlists', {});
  assert.equal(seen.length, 2);
});

test('a 429 says how long to wait', async () => {
  // Without the number a widget guesses, and a widget that guesses short keeps
  // the whole account — Xenon's own tile included — pinned in the penalty box.
  const p = probe(() => {}, 429, {});
  const r = await p.query('playlists', {});
  assert.equal(r.error, 'rate_limited');
  assert.equal(r.status, 429);
  assert.ok(r.retryAfterMs > 0, 'a widget cannot back off for an unknown length of time');
  // The breaker is now up: the next read is refused without touching Spotify.
  let called = false;
  const again = await p.query('savedTracks', {});
  assert.equal(again.error, 'rate_limited');
  assert.ok(again.retryAfterMs > 0);
  assert.equal(called, false);
});

test('playing something drops what was cached about playback', async () => {
  // A widget that starts an album and immediately re-reads the queue must not be
  // handed the queue from before it pressed play.
  const seen = [];
  const p = probe((u) => seen.push(u));
  await p.query('queue', {});
  await p.playUri('spotify:album:4Z8W4fKeB5YxbusRsdQVPb');
  await p.query('queue', {});
  const queues = seen.filter((u) => u.includes('/me/player/queue'));
  assert.equal(queues.length, 2, 'a mutation has to invalidate the reads it changes');
});

test('signing out drops the previous account\'s library', async () => {
  // Sign out, sign a different account in: the cache is keyed on the PATH, and
  // /me/playlists is the same path for both people. Without this the second
  // account would be shown the first one's playlists.
  const seen = [];
  const p = probe((u) => seen.push(u));
  const before = await p.query('playlists', {});
  assert.equal(before.ok, true);
  await p.logout();
  const after = await p.query('playlists', {});
  assert.equal(after.ok, false, 'a signed-out read must not be answered from memory');
  assert.equal(after.error, 'not_connected');
  assert.equal(seen.length, 1, 'and it must not reach Spotify either');
  assert.match(read('server/stream-spotify.js'),
    /async function logout\(\) \{ await clearCreds\(\); queryCacheClear\(\);/);
});

test('the cache stays small and short — a burst absorber, not a store', () => {
  const src = read('server/stream-spotify.js');
  assert.match(src, /const QUERY_CACHE_MAX = 16;/);
  assert.match(src, /const QUERY_TTL_MS = 10000;/);
  assert.match(src, /const QUERY_TTL_VOLATILE_MS = 3000;/);
  assert.match(src, /QUERY_VOLATILE = new Set\(\['player', 'queue', 'devices'\]\)/,
    'what is playing right now cannot be held for ten seconds');
  assert.match(src, /while \(_queryCache\.size > QUERY_CACHE_MAX\)/,
    'an unbounded map of Spotify pages is a memory leak with a nice name');
});

test('the SDK guide documents the ops, the clamps and the two grants', () => {
  const doc = read('docs/WIDGET_SDK.md');
  assert.match(doc, /### 3e\. Reading Spotify/);
  for (const op of ['player', 'queue', 'devices', 'playlists', 'savedAlbums', 'savedTracks',
    'recent', 'followedArtists', 'artistAlbums', 'albumTracks', 'playlistTracks', 'search']) {
    assert.ok(doc.includes('| `' + op + '`'), `${op} is undocumented`);
  }
  assert.match(doc, /insufficient_scope/);
  assert.match(doc, /retryAfterMs/, 'a widget cannot back off for an unknown length of time');
  assert.match(doc, /absorbs bursts, so don't build a cache of your own/);
  assert.match(doc, /page 2 is a different read from page 1/,
    'the one thing the host CANNOT collapse has to be said, or the advice is misleading');
  assert.match(doc, /Why two grants/);
  assert.match(doc, /passed through unshaped/);
});
