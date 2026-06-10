import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { createYouTubeProvider, normalizeStreamYouTube } = require('../stream-youtube.js');
const { createRegistry } = require('../actions/registry.js');

function tmpTokens() {
  return path.join(os.tmpdir(), `xe-yt-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}
function stubFetch(routes) {
  return async (url) => {
    const u = String(url);
    const r = routes.find(x => u.includes(x.match));
    if (!r) throw new Error('unexpected fetch: ' + u);
    if (r.calls) r.calls.push(u);
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.json };
  };
}

test('normalizeStreamYouTube fills a clean shape and drops junk', () => {
  assert.deepEqual(normalizeStreamYouTube({ accessToken: 'a', junk: 1, channel: 'Me' }),
    { accessToken: 'a', refreshToken: '', expiresAt: 0, channel: 'Me', channelId: '' });
});

test('configured() needs both client id and secret', async () => {
  assert.equal(createYouTubeProvider({ clientId: 'x', clientSecret: '' }).configured(), false);
  assert.equal(createYouTubeProvider({ clientId: '', clientSecret: 'y' }).configured(), false);
  assert.equal(createYouTubeProvider({ clientId: 'x', clientSecret: 'y' }).configured(), true);
});

test('startDeviceLogin returns user code + verification URL (Google verification_url)', async () => {
  const p = createYouTubeProvider({
    clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(),
    fetch: stubFetch([{ match: '/device/code', json: { device_code: 'DEV', user_code: 'ABC-DEF', verification_url: 'https://www.google.com/device', interval: 5, expires_in: 1800 } }]),
  });
  const r = await p.startDeviceLogin();
  assert.equal(r.ok, true);
  assert.equal(r.userCode, 'ABC-DEF');
  assert.equal(r.verificationUri, 'https://www.google.com/device');
});

test('pollDeviceToken reports pending on authorization_pending', async () => {
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(),
    fetch: stubFetch([{ match: '/token', status: 428, json: { error: 'authorization_pending' } }]) });
  assert.deepEqual(await p.pollDeviceToken('DEV'), { ok: false, pending: true });
});

test('pollDeviceToken persists tokens + channel on success (no tokens leaked in status)', async () => {
  const file = tmpTokens();
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([
      { match: '/token', json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 } },
      { match: '/channels', json: { items: [{ id: 'UC123', snippet: { title: 'My Channel' } }] } },
    ]) });
  const r = await p.pollDeviceToken('DEV');
  assert.equal(r.ok, true);
  assert.equal(r.login, 'My Channel');
  const stt = await p.status();
  assert.deepEqual(stt, { connected: true, login: 'My Channel', configured: true });
  assert.equal('accessToken' in stt, false);
  assert.equal(await p.getAccessToken(), 'AT');
});

test('getAccessToken refreshes when expired and keeps the stored refresh token', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1, channel: 'C', channelId: 'UC' } }));
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([{ match: '/token', json: { access_token: 'NEW', expires_in: 3600 } }]) }); // no refresh_token in response
  assert.equal(await p.getAccessToken(), 'NEW');
  const stt = await p.status();
  assert.equal(stt.connected, true);
});

test('getAccessToken clears creds when refresh fails', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: 1, channel: 'C', channelId: 'UC' } }));
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([{ match: '/token', status: 400, json: { error: 'invalid_grant' } }]) });
  assert.equal(await p.getAccessToken(), '');
  assert.equal((await p.status()).connected, false);
});

test('apiRequest returns not_connected without a token', async () => {
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await p.apiRequest('GET', '/liveBroadcasts?mine=true'), { ok: false, error: 'not_connected' });
});

// ---------------------------------------------------------------------------
// Phase 4: broadcast status + transition
// ---------------------------------------------------------------------------

function connectedYt(routes) {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  return createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file, fetch: stubFetch(routes) });
}

test('broadcastStatus reports offline when there is no broadcast', async () => {
  const p = connectedYt([{ match: '/liveBroadcasts', json: { items: [] } }]);
  assert.deepEqual(await p.broadcastStatus(), { ok: true, live: false, health: '' });
});

test('broadcastStatus reports live with viewer count', async () => {
  const p = connectedYt([
    { match: '/liveBroadcasts', json: { items: [{ id: 'VID', status: { lifeCycleStatus: 'live' }, snippet: { title: 'Stream' } }] } },
    { match: '/videos', json: { items: [{ liveStreamingDetails: { concurrentViewers: '321' } }] } },
  ]);
  const r = await p.broadcastStatus();
  assert.equal(r.ok, true); assert.equal(r.live, true); assert.equal(r.viewers, 321); assert.equal(r.title, 'Stream');
});

test('transitionBroadcast: no_broadcast when none exists, not_connected when logged out', async () => {
  const none = connectedYt([{ match: '/liveBroadcasts', json: { items: [] } }]);
  assert.deepEqual(await none.transitionBroadcast('start'), { ok: false, error: 'no_broadcast' });
  const off = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await off.transitionBroadcast('toggle'), { ok: false, error: 'not_connected' });
});

test('transitionBroadcast: start transitions an upcoming broadcast to live', async () => {
  const calls = [];
  const p = connectedYt([
    { match: '/liveBroadcasts/transition', json: { id: 'VID' }, calls },   // must match before generic /liveBroadcasts
    { match: '/liveBroadcasts', json: { items: [{ id: 'VID', status: { lifeCycleStatus: 'ready' } }] } },
  ]);
  assert.deepEqual(await p.transitionBroadcast('start'), { ok: true });
  assert.ok(calls.some(u => u.includes('broadcastStatus=live')));
});

test('registry: ytBroadcast unavailable without dep, forwards mode + surfaces failure', async () => {
  assert.deepEqual(await createRegistry({}).run({ type: 'ytBroadcast', mode: 'start' }), { ok: false, error: 'unavailable' });
  let got = null;
  const reg = createRegistry({ ytBroadcast: async (m) => { got = m; return { ok: false, error: 'no_broadcast' }; } });
  assert.deepEqual(await reg.run({ type: 'ytBroadcast', mode: 'start' }), { ok: false, error: 'no_broadcast' });
  assert.equal(got, 'start');
  const okReg = createRegistry({ ytBroadcast: async () => ({ ok: true }) });
  assert.deepEqual(await okReg.run({ type: 'ytBroadcast', mode: 'toggle' }), { ok: true });
});

test('logout revokes and clears persisted creds', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  const calls = [];
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([{ match: '/revoke', json: {}, calls }]) });
  assert.deepEqual(await p.logout(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal((await p.status()).connected, false);
});
