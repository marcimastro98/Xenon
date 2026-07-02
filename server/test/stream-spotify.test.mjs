import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createSpotifyProvider, normalizeStreamSpotify } = require('../stream-spotify.js');
const { createRegistry } = require('../actions/registry.js');

function tmpTokens() {
  return path.join(os.tmpdir(), `xe-sp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}
// Match by URL substring, in array order (put the more specific path first). A
// route may set `status` (204 → no JSON body, like most Spotify control calls).
function stubFetch(routes) {
  return async (url, init) => {
    const u = String(url);
    const r = routes.find(x => u.includes(x.match));
    if (!r) throw new Error('unexpected fetch: ' + u);
    if (r.calls) r.calls.push({ url: u, init });
    const status = r.status || 200;
    return { ok: status < 400, status, json: async () => (r.json !== undefined ? r.json : null) };
  };
}

test('normalizeStreamSpotify fills a clean shape and drops junk', () => {
  assert.deepEqual(normalizeStreamSpotify({ accessToken: 'a', junk: 1, login: 'Me' }),
    { accessToken: 'a', refreshToken: '', expiresAt: 0, login: 'Me', userId: '' });
});

test('configured() needs a client id', () => {
  assert.equal(createSpotifyProvider({ clientId: '' }).configured(), false);
  assert.equal(createSpotifyProvider({ clientId: 'x' }).configured(), true);
});

test('buildAuthUrl includes PKCE challenge + state; exchangeCode rejects an unknown state', async () => {
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: tmpTokens() });
  const r = p.buildAuthUrl('http://127.0.0.1:3030/stream/spotify/callback');
  assert.equal(r.ok, true);
  const url = new URL(r.authUrl);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.equal(url.searchParams.get('state'), r.state);
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:3030/stream/spotify/callback');
  // A forged / unknown state must be refused (this is the CSRF guard for the callback).
  assert.deepEqual(await p.exchangeCode('CODE', 'not-a-real-state'), { ok: false, error: 'bad_state' });
});

test('exchangeCode persists tokens + login and never leaks them in status()', async () => {
  const file = tmpTokens();
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([
      { match: '/api/token', json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
      { match: '/me', json: { id: 'u1', display_name: 'Marci' } },
    ]) });
  const r = p.buildAuthUrl('http://127.0.0.1:3030/stream/spotify/callback');
  const ex = await p.exchangeCode('CODE', r.state);
  assert.equal(ex.ok, true);
  assert.equal(ex.login, 'Marci');
  const stt = await p.status();
  assert.deepEqual(stt, { connected: true, login: 'Marci', configured: true });
  assert.equal('accessToken' in stt, false);
  assert.equal(await p.getAccessToken(), 'AT');
});

test('getAccessToken refreshes when expired and keeps the stored refresh token', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1, login: 'Marci', userId: 'u1' } }));
  const calls = [];
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/api/token', calls, json: { access_token: 'NEW', expires_in: 3600 } }]) });
  assert.equal(await p.getAccessToken(), 'NEW');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')).spotify;
  assert.equal(stored.refreshToken, 'RT');   // provider omitted refresh_token → keep the old one
});

test('getQueue trims to { current, queue } with joined artists + smallest cover', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/me/player/queue', json: {
      currently_playing: { name: 'Now', uri: 'spotify:track:1', artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'big' }, { url: 'small' }] } },
      queue: [{ name: 'Next', uri: 'spotify:track:2', artists: [{ name: 'C' }], album: { images: [{ url: 'x' }] } }],
    } }]) });
  const q = await p.getQueue();
  assert.equal(q.ok, true);
  assert.deepEqual(q.current, { name: 'Now', uri: 'spotify:track:1', artist: 'A, B', image: 'small' });
  assert.equal(q.queue.length, 1);
  assert.equal(q.queue[0].name, 'Next');
});

test('getPlaylists + getDevices trim to client-safe shapes', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([
      { match: '/me/playlists', json: { items: [{ name: 'Mix', uri: 'spotify:playlist:9', images: [{ url: 'cover' }], tracks: { total: 42 } }] } },
      { match: '/me/player/devices', json: { devices: [{ id: 'd1', name: 'PC', type: 'Computer', is_active: true, volume_percent: 80 }] } },
    ]) });
  const pl = await p.getPlaylists();
  assert.deepEqual(pl.playlists[0], { name: 'Mix', uri: 'spotify:playlist:9', image: 'cover', tracks: 42 });
  const dv = await p.getDevices();
  assert.deepEqual(dv.devices[0], { id: 'd1', name: 'PC', type: 'computer', active: true, volume: 80 });
});

test('playPlaylist accepts an id, a URI or an open.spotify.com link; rejects junk', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const calls = [];
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/me/player/play', calls, status: 204 }]) });
  assert.deepEqual(await p.playPlaylist('https://open.spotify.com/playlist/37i9dQ?si=x'), { ok: true });
  assert.equal(JSON.parse(calls[0].init.body).context_uri, 'spotify:playlist:37i9dQ');
  assert.deepEqual(await p.playPlaylist('!!!'), { ok: false, error: 'bad_playlist' });
});

test('setShuffle toggle reads current state then PUTs the inverse', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const calls = [];
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([
      { match: '/me/player/shuffle', calls, status: 204 },   // more specific → first
      { match: '/me/player', json: { shuffle_state: false } },
    ]) });
  assert.deepEqual(await p.setShuffle('toggle'), { ok: true });
  assert.ok(calls[0].url.includes('state=true'));
});

test('transferDevice matches by name; device_not_found otherwise', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const devices = { match: '/me/player/devices', json: { devices: [{ id: 'd1', name: 'Living Room', type: 'speaker' }] } };
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([devices, { match: '/me/player', status: 204 }]) });
  assert.deepEqual(await p.transferDevice('living'), { ok: true });   // case-insensitive substring
  assert.deepEqual(await p.transferDevice('Kitchen'), { ok: false, error: 'device_not_found' });
});

test('control calls map 403 → premium_required and 404 → no_active_device', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const p403 = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/me/player/play', status: 403, json: {} }]) });
  assert.deepEqual(await p403.playPlaylist('spotify:playlist:9'), { ok: false, error: 'premium_required' });
  const p404 = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/me/player/play', status: 404, json: {} }]) });
  assert.deepEqual(await p404.playPlaylist('spotify:playlist:9'), { ok: false, error: 'no_active_device' });
});

test('library calls (save/like) map 403 to forbidden (scope), not premium_required', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([
      { match: '/me/tracks', status: 403, json: {} },                     // save/like write → 403
      { match: '/me/player/currently-playing', json: { item: { id: 't1' } } },
    ]) });
  // Saving to Liked Songs never needs Premium — a 403 there is a missing scope.
  assert.deepEqual(await p.saveCurrent(), { ok: false, error: 'forbidden' });
});

test('action methods report not_connected when logged out', async () => {
  const p = createSpotifyProvider({ clientId: 'cid', tokensFile: tmpTokens() });
  assert.deepEqual(await p.saveCurrent(), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.getQueue(), { ok: false, error: 'not_connected' });
});

test('registry: spotify actions are unavailable without the dep, and surface provider errors', async () => {
  const bare = createRegistry({});
  assert.deepEqual(await bare.run({ type: 'spotifySave' }), { ok: false, error: 'spotify_unavailable' });

  const calls = [];
  const reg = createRegistry({ spotify: (a) => { calls.push(a); return a.type === 'spotifyShuffle' ? { ok: false, error: 'premium_required' } : { ok: true }; } });
  assert.deepEqual(await reg.run({ type: 'spotifyPlaylist', playlist: 'spotify:playlist:9' }), { ok: true });
  assert.equal(calls[0].playlist, 'spotify:playlist:9');
  assert.deepEqual(await reg.run({ type: 'spotifyShuffle', mode: 'toggle' }), { ok: false, error: 'premium_required' });
  // The new transport actions route through the same single dep.
  assert.deepEqual(await reg.run({ type: 'spotifyNext' }), { ok: true });
  assert.equal(calls[calls.length - 1].type, 'spotifyNext');
  assert.deepEqual(await reg.run({ type: 'spotifyPlay', mode: 'toggle' }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'spotifyVolume', mode: 'set', value: '55' }), { ok: true });
});

// ── Now-playing hero: getPlayer + transport / like / volume / seek ──────────
function loggedIn(routes) {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  return createSpotifyProvider({ clientId: 'cid', tokensFile: file, fetch: stubFetch(routes) });
}

test('getPlayer returns a rich hero shape with largest cover + liked state', async () => {
  const p = loggedIn([
    { match: '/me/tracks/contains', json: [true] },
    { match: '/me/player', json: {
      is_playing: true, progress_ms: 1000, shuffle_state: true, repeat_state: 'context',
      device: { name: 'PC', volume_percent: 70, supports_volume: true },
      item: { id: 't1', name: 'Song', duration_ms: 200000, artists: [{ name: 'A' }], album: { name: 'Alb', images: [{ url: 'big' }, { url: 'small' }] } },
    } },
  ]);
  assert.deepEqual(await p.getPlayer(), {
    ok: true, playing: true,
    track: { id: 't1', name: 'Song', uri: '', artist: 'A', album: 'Alb', image: 'big' },
    progressMs: 1000, durationMs: 200000, shuffle: true, repeat: 'context',
    device: 'PC', volume: 70, supportsVolume: true, liked: true,
  });
});

test('getPlayer maps a 204 (no active device, nothing loaded) to a clean nothing-playing state', async () => {
  // Both /me/player and its currently-playing fallback are 204 → genuinely nothing.
  const p = loggedIn([{ match: '/me/player', status: 204 }]);
  assert.deepEqual(await p.getPlayer(), { ok: true, playing: false, track: null });
});

test('getPlayer falls back to currently-playing when the device is inactive (paused track)', async () => {
  // /me/player 204 (device went idle after a pause) but a track is still loaded:
  // the fallback endpoint reports it, so the hero shows the paused track instead
  // of going blank — matching what the SMTC-based Media tile shows.
  const p = loggedIn([
    { match: '/me/player/currently-playing', json: {
      is_playing: false, progress_ms: 5000,
      item: { id: 't9', name: 'Paused', duration_ms: 180000, artists: [{ name: 'A' }], album: { name: 'Alb', images: [{ url: 'big' }] } },
    } },
    { match: '/me/tracks/contains', json: [false] },
    { match: '/me/player', status: 204 },
  ]);
  const r = await p.getPlayer();
  assert.equal(r.ok, true);
  assert.equal(r.playing, false);
  assert.equal(r.track.name, 'Paused');
  assert.equal(r.progressMs, 5000);
  assert.equal(r.durationMs, 180000);
  assert.equal(r.device, '');       // currently-playing carries no device/volume
  assert.equal(r.liked, false);
});

test('playPause toggle reads is_playing then PUTs the opposite endpoint', async () => {
  const calls = [];
  const p = loggedIn([
    { match: '/me/player/play', calls, status: 204 },
    { match: '/me/player/pause', calls, status: 204 },
    { match: '/me/player', json: { is_playing: false } },
  ]);
  assert.deepEqual(await p.playPause('toggle'), { ok: true });
  assert.ok(calls[0].url.endsWith('/me/player/play'));
});

test('playPause play wakes an idle device on 404 (transfer with play) instead of erroring', async () => {
  const calls = [];
  const p = loggedIn([
    { match: '/me/player/play', status: 404, json: {} },            // no active device
    { match: '/me/player/devices', json: { devices: [{ id: 'd1', name: 'PC', type: 'Computer', is_active: false }] } },
    { match: '/me/player', calls, status: 204 },                    // transfer PUT
  ]);
  assert.deepEqual(await p.playPause('play'), { ok: true });
  const transfer = calls.find(c => c.init && c.init.method === 'PUT');
  assert.ok(transfer, 'transferred playback to a device');
  assert.deepEqual(JSON.parse(transfer.init.body), { device_ids: ['d1'], play: true });
});

test('playPause play → no_active_device when 404 and there are no devices to wake', async () => {
  const p = loggedIn([
    { match: '/me/player/play', status: 404, json: {} },
    { match: '/me/player/devices', json: { devices: [] } },
  ]);
  assert.deepEqual(await p.playPause('play'), { ok: false, error: 'no_active_device' });
});

test('skipNext / skipPrev POST the right transport endpoints', async () => {
  const calls = [];
  const p = loggedIn([{ match: '/me/player/next', calls, status: 204 }, { match: '/me/player/previous', calls, status: 204 }]);
  assert.deepEqual(await p.skipNext(), { ok: true });
  assert.deepEqual(await p.skipPrev(), { ok: true });
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].url.endsWith('/me/player/next'));
});

test('setRepeat toggle advances off → context', async () => {
  const calls = [];
  const p = loggedIn([{ match: '/me/player/repeat', calls, status: 204 }, { match: '/me/player', json: { repeat_state: 'off' } }]);
  assert.deepEqual(await p.setRepeat('toggle'), { ok: true });
  assert.ok(calls[0].url.includes('state=context'));
});

test('toggleLike toggle: reads current track, checks saved, then flips it', async () => {
  const calls = [];
  const p = loggedIn([
    { match: '/me/tracks/contains', json: [false] },
    { match: '/me/tracks', calls, status: 200, json: {} },
    { match: '/me/player/currently-playing', json: { item: { id: 't1' } } },
  ]);
  assert.deepEqual(await p.toggleLike('toggle'), { ok: true });
  assert.equal(calls[0].init.method, 'PUT');            // not saved → add
  assert.ok(calls[0].url.includes('ids=t1'));
});

test('setVolume set clamps; up steps +10 from the live volume', async () => {
  const calls = [];
  const pSet = loggedIn([{ match: '/me/player/volume', calls, status: 204 }]);
  assert.deepEqual(await pSet.setVolume('set', '150'), { ok: true });
  assert.ok(calls[0].url.includes('volume_percent=100'));   // clamped to 100
  const calls2 = [];
  const pUp = loggedIn([{ match: '/me/player/volume', calls: calls2, status: 204 }, { match: '/me/player', json: { device: { volume_percent: 80 } } }]);
  assert.deepEqual(await pUp.setVolume('up'), { ok: true });
  assert.ok(calls2[0].url.includes('volume_percent=90'));
});

test('seek clamps and PUTs an absolute position_ms', async () => {
  const calls = [];
  const p = loggedIn([{ match: '/me/player/seek', calls, status: 204 }]);
  assert.deepEqual(await p.seek('1234'), { ok: true });
  assert.ok(calls[0].url.includes('position_ms=1234'));
  assert.deepEqual(await p.seek('-5'), { ok: true });
  assert.ok(calls[1].url.includes('position_ms=0'));       // clamped to 0
});

// ── AI: search + play/queue a song by name ──────────────────────────────────
test('search trims the requested bucket and requires a query', async () => {
  const calls = [];
  const p = loggedIn([{ match: '/search', calls, json: { tracks: { items: [
    { name: 'Song', uri: 'spotify:track:1', artists: [{ name: 'A' }, { name: 'B' }] },
  ] } } }]);
  const r = await p.search('some song', 'track', 3);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'track');
  assert.deepEqual(r.results[0], { name: 'Song', uri: 'spotify:track:1', artist: 'A, B' });
  assert.ok(calls[0].url.includes('type=track') && calls[0].url.includes('q=some%20song'));
  assert.deepEqual(await p.search('  '), { ok: false, error: 'no_query' });
});

test('playSearch plays the top TRACK via uris[] and the top CONTEXT via context_uri', async () => {
  const calls = [];
  const pt = loggedIn([
    { match: '/me/player/play', calls, status: 204 },
    { match: '/search', json: { tracks: { items: [{ name: 'Song', uri: 'spotify:track:1', artists: [{ name: 'A' }] }] } } },
  ]);
  const r = await pt.playSearch('song', 'track');
  assert.equal(r.ok, true);
  assert.equal(r.playing.uri, 'spotify:track:1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { uris: ['spotify:track:1'] });

  const calls2 = [];
  const pp = loggedIn([
    { match: '/me/player/play', calls: calls2, status: 204 },
    { match: '/search', json: { playlists: { items: [{ name: 'Chill', uri: 'spotify:playlist:9' }] } } },
  ]);
  assert.equal((await pp.playSearch('chill', 'playlist')).ok, true);
  assert.deepEqual(JSON.parse(calls2[0].init.body), { context_uri: 'spotify:playlist:9' });
});

test('playSearch surfaces not_found when the search is empty', async () => {
  const p = loggedIn([{ match: '/search', json: { tracks: { items: [] } } }]);
  assert.deepEqual(await p.playSearch('zzz'), { ok: false, error: 'not_found' });
});

test('queueSearch adds the top track to the queue and reports premium_required on 403', async () => {
  const calls = [];
  const p = loggedIn([
    { match: '/me/player/queue', calls, status: 204 },
    { match: '/search', json: { tracks: { items: [{ name: 'Song', uri: 'spotify:track:7', artists: [{ name: 'A' }] }] } } },
  ]);
  const r = await p.queueSearch('song');
  assert.equal(r.ok, true);
  assert.equal(r.queued.uri, 'spotify:track:7');
  assert.ok(calls[0].url.includes('uri=spotify%3Atrack%3A7'));

  const p403 = loggedIn([
    { match: '/me/player/queue', status: 403, json: {} },
    { match: '/search', json: { tracks: { items: [{ name: 'S', uri: 'spotify:track:7' }] } } },
  ]);
  assert.deepEqual(await p403.queueSearch('song'), { ok: false, error: 'premium_required' });
});
