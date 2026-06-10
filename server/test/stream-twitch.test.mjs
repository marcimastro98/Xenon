import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createTwitchProvider, normalizeStreamTwitch } = require('../stream-twitch.js');
const { createRegistry } = require('../actions/registry.js');

// A fresh temp token file per provider so tests never touch the real store.
function tmpTokens() {
  return path.join(os.tmpdir(), `xe-twitch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}
// Minimal fetch stub: hand it a queue of { match, status, json } and it replies
// in order to matching URLs.
function stubFetch(routes) {
  return async (url, init) => {
    const u = String(url);
    const r = routes.find(x => u.includes(x.match));
    if (!r) throw new Error('unexpected fetch: ' + u);
    if (r.calls) r.calls.push({ url: u, init });
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json };
  };
}

test('normalizeStreamTwitch fills a clean shape and drops junk', () => {
  assert.deepEqual(normalizeStreamTwitch({ accessToken: 'a', junk: 1, expiresAt: 5 }),
    { accessToken: 'a', refreshToken: '', expiresAt: 5, login: '', userId: '' });
  assert.deepEqual(normalizeStreamTwitch(null),
    { accessToken: '', refreshToken: '', expiresAt: 0, login: '', userId: '' });
});

test('configured() is false without a client_id and calls short-circuit', async () => {
  const p = createTwitchProvider({ clientId: '', tokensFile: tmpTokens(), fetch: async () => { throw new Error('must not fetch'); } });
  assert.equal(p.configured(), false);
  assert.deepEqual(await p.startDeviceLogin(), { ok: false, error: 'no_client_id' });
  assert.deepEqual(await p.pollDeviceToken('x'), { ok: false, error: 'no_client_id' });
});

test('startDeviceLogin returns the user code + verification URL', async () => {
  const p = createTwitchProvider({
    clientId: 'cid', tokensFile: tmpTokens(),
    fetch: stubFetch([{ match: '/oauth2/device', json: { device_code: 'DEV', user_code: 'ABCD-EFGH', verification_uri: 'https://twitch.tv/activate', interval: 5, expires_in: 1800 } }]),
  });
  const r = await p.startDeviceLogin();
  assert.equal(r.ok, true);
  assert.equal(r.userCode, 'ABCD-EFGH');
  assert.equal(r.verificationUri, 'https://twitch.tv/activate');
  assert.equal(r.deviceCode, 'DEV');
});

test('pollDeviceToken reports pending without persisting', async () => {
  const file = tmpTokens();
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/oauth2/token', status: 400, json: { message: 'authorization_pending' } }]) });
  assert.deepEqual(await p.pollDeviceToken('DEV'), { ok: false, pending: true });
  assert.equal(fs.existsSync(file), false, 'no token file written while pending');
  assert.deepEqual(await p.status(), { connected: false, login: '', configured: true });
});

test('pollDeviceToken persists tokens + login on success, status reflects it (no tokens leaked)', async () => {
  const file = tmpTokens();
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([
      { match: '/oauth2/token', json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
      { match: '/helix/users', json: { data: [{ id: '42', login: 'streamer' }] } },
    ]) });
  const r = await p.pollDeviceToken('DEV');
  assert.equal(r.ok, true);
  assert.equal(r.login, 'streamer');
  const st = await p.status();
  assert.deepEqual(st, { connected: true, login: 'streamer', configured: true });
  assert.equal('accessToken' in st, false, 'status must never expose tokens');
  assert.equal(await p.getAccessToken(), 'AT');
  assert.equal(await p.broadcasterId(), '42');
});

test('getAccessToken refreshes when expired, and clears creds if refresh fails', async () => {
  const file = tmpTokens();
  // Seed an already-expired token + a refresh token.
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1, login: 'streamer', userId: '42' } }));

  const okRefresh = createTwitchProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/oauth2/token', json: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600 } }]) });
  assert.equal(await okRefresh.getAccessToken(), 'NEW');

  // Now make refresh fail → creds cleared → not connected.
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1, login: 'streamer', userId: '42' } }));
  const badRefresh = createTwitchProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/oauth2/token', status: 400, json: { message: 'invalid refresh token' } }]) });
  assert.equal(await badRefresh.getAccessToken(), '');
  assert.equal((await badRefresh.status()).connected, false);
});

test('helix returns not_connected when there is no token', async () => {
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await p.helix('GET', '/streams'), { ok: false, error: 'not_connected' });
});

// ---------------------------------------------------------------------------
// Phase 2 action methods (require a live, connected channel)
// ---------------------------------------------------------------------------

function connectedProvider(routes) {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, login: 'streamer', userId: '42' } }));
  return createTwitchProvider({ clientId: 'cid', tokensFile: file, fetch: stubFetch(routes) });
}

test('createClip succeeds when live, maps 404 to not_live', async () => {
  assert.deepEqual(await connectedProvider([{ match: '/helix/clips', status: 202, json: { data: [{ id: 'c1' }] } }]).createClip(), { ok: true });
  assert.deepEqual(await connectedProvider([{ match: '/helix/clips', status: 404, json: {} }]).createClip(), { ok: false, error: 'not_live' });
});

test('createMarker posts user_id + trimmed description', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/streams/markers', json: { data: [{}] }, calls }]);
  assert.deepEqual(await p.createMarker('  big play  '), { ok: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.user_id, '42');
  assert.equal(body.description, 'big play');
});

test('runAd coerces a bogus length to 30', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/channels/commercial', json: { data: [{}] }, calls }]);
  assert.deepEqual(await p.runAd(999), { ok: true });
  assert.equal(JSON.parse(calls[0].init.body).length, 30);
});

test('streamStatus reports live with viewers, and offline', async () => {
  const live = connectedProvider([{ match: '/helix/streams', json: { data: [{ viewer_count: 1234, title: 'T', game_name: 'G' }] } }]);
  assert.deepEqual(await live.streamStatus(), { ok: true, live: true, viewers: 1234, title: 'T', game: 'G' });
  const off = connectedProvider([{ match: '/helix/streams', json: { data: [] } }]);
  assert.deepEqual(await off.streamStatus(), { ok: true, live: false });
});

test('action methods report not_connected when logged out', async () => {
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await p.createClip(), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.runAd(60), { ok: false, error: 'not_connected' });
});

// ---------------------------------------------------------------------------
// registry dispatch for the twitch actions
// ---------------------------------------------------------------------------

test('registry: twitch actions are unavailable without their deps', async () => {
  const reg = createRegistry({});
  assert.deepEqual(await reg.run({ type: 'twitchClip' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(await reg.run({ type: 'twitchMarker' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(await reg.run({ type: 'twitchAd' }), { ok: false, error: 'unavailable' });
});

test('registry: twitchAd forwards the length and surfaces not_live', async () => {
  let got = null;
  const reg = createRegistry({ twitchAd: async (len) => { got = len; return { ok: false, error: 'not_live' }; } });
  assert.deepEqual(await reg.run({ type: 'twitchAd', length: '60' }), { ok: false, error: 'not_live' });
  assert.equal(got, '60');
});

test('registry: twitchClip reports ok on success', async () => {
  const reg = createRegistry({ twitchClip: async () => ({ ok: true }) });
  assert.deepEqual(await reg.run({ type: 'twitchClip' }), { ok: true });
});

test('logout revokes and clears persisted creds', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, login: 'streamer', userId: '42' } }));
  const calls = [];
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: file,
    fetch: stubFetch([{ match: '/oauth2/revoke', json: {}, calls }]) });
  assert.deepEqual(await p.logout(), { ok: true });
  assert.equal(calls.length, 1, 'revoke called');
  assert.equal((await p.status()).connected, false);
});
