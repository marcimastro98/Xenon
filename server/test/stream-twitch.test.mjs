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

// ---------------------------------------------------------------------------
// v3.1.2 new action methods: title / game / chat / shoutout / chat mode
// ---------------------------------------------------------------------------

test('setTitle trims, targets the broadcaster, and rejects empty before fetching', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/channels', status: 204, json: {}, calls }]);
  assert.deepEqual(await p.setTitle('  New title  '), { ok: true });
  assert.match(calls[0].url, /broadcaster_id=42/);
  assert.equal(JSON.parse(calls[0].init.body).title, 'New title');
  // empty title → bad_request, and no fetch (empty routes would throw on any call)
  assert.deepEqual(await connectedProvider([]).setTitle('   '), { ok: false, error: 'bad_request' });
});

test('setGame resolves the name to a game_id, then PATCHes the channel', async () => {
  const calls = [];
  const p = connectedProvider([
    { match: '/helix/search/categories', json: { data: [{ id: '509658', name: 'Just Chatting' }] }, calls },
    { match: '/helix/channels', status: 204, json: {}, calls },
  ]);
  assert.deepEqual(await p.setGame('just chatting'), { ok: true });
  assert.match(calls[0].url, /\/helix\/search\/categories/);
  assert.equal(JSON.parse(calls[1].init.body).game_id, '509658');
  // no category match → no_category, no PATCH
  assert.deepEqual(await connectedProvider([{ match: '/helix/search/categories', json: { data: [] } }]).setGame('zzz'),
    { ok: false, error: 'no_category' });
});

test('sendChat posts broadcaster+sender+message and treats is_sent:false as not_sent', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/chat/messages', json: { data: [{ is_sent: true }] }, calls }]);
  assert.deepEqual(await p.sendChat('hi chat'), { ok: true });
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.broadcaster_id, '42');
  assert.equal(body.sender_id, '42');
  assert.equal(body.message, 'hi chat');
  const dropped = connectedProvider([{ match: '/helix/chat/messages', json: { data: [{ is_sent: false }] } }]);
  assert.deepEqual(await dropped.sendChat('x'), { ok: false, error: 'not_sent' });
});

test('shoutout resolves the target login (lowercased, @ stripped) then posts from/to/moderator ids', async () => {
  const calls = [];
  const p = connectedProvider([
    { match: '/helix/users', json: { data: [{ id: '99', login: 'friend' }] }, calls },
    { match: '/helix/chat/shoutouts', status: 204, json: {}, calls },
  ]);
  assert.deepEqual(await p.shoutout('@Friend'), { ok: true });
  assert.match(calls[0].url, /login=friend/);
  assert.match(calls[1].url, /from_broadcaster_id=42/);
  assert.match(calls[1].url, /to_broadcaster_id=99/);
  assert.match(calls[1].url, /moderator_id=42/);
  // unknown channel → no_user, no shoutout posted
  assert.deepEqual(await connectedProvider([{ match: '/helix/users', json: { data: [] } }]).shoutout('ghost'),
    { ok: false, error: 'no_user' });
});

test('setChatMode maps each mode to a chat-settings body; unknown falls back to off', async () => {
  const onCalls = [];
  const p = connectedProvider([{ match: '/helix/chat/settings', status: 204, json: {}, calls: onCalls }]);
  assert.deepEqual(await p.setChatMode('emoteonly'), { ok: true });
  assert.deepEqual(JSON.parse(onCalls[0].init.body), { emote_mode: true });
  assert.match(onCalls[0].url, /broadcaster_id=42&moderator_id=42/);
  const offCalls = [];
  await connectedProvider([{ match: '/helix/chat/settings', status: 204, json: {}, calls: offCalls }]).setChatMode('bogus');
  assert.deepEqual(JSON.parse(offCalls[0].init.body), { emote_mode: false, follower_mode: false, subscriber_mode: false, slow_mode: false });
});

test('new action methods report not_connected when logged out', async () => {
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await p.setTitle('x'), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.setGame('x'), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.sendChat('x'), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.shoutout('x'), { ok: false, error: 'not_connected' });
  assert.deepEqual(await p.setChatMode('off'), { ok: false, error: 'not_connected' });
});

test('registry: new twitch actions forward their params and surface provider errors', async () => {
  const got = {};
  const reg = createRegistry({
    twitchTitle: async (v) => { got.title = v; return { ok: true }; },
    twitchGame: async (v) => { got.game = v; return { ok: true }; },
    twitchChat: async (v) => { got.msg = v; return { ok: true }; },
    twitchShoutout: async (v) => { got.login = v; return { ok: false, error: 'not_live' }; },
    twitchChatMode: async (v) => { got.mode = v; return { ok: true }; },
  });
  assert.deepEqual(await reg.run({ type: 'twitchTitle', title: 'T' }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'twitchGame', game: 'G' }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'twitchChat', message: 'M' }), { ok: true });
  assert.deepEqual(await reg.run({ type: 'twitchShoutout', login: 'L' }), { ok: false, error: 'not_live' });
  assert.deepEqual(await reg.run({ type: 'twitchChatMode', mode: 'slow' }), { ok: true });
  assert.deepEqual(got, { title: 'T', game: 'G', msg: 'M', login: 'L', mode: 'slow' });
});

test('registry: new twitch actions are unavailable without their deps', async () => {
  const reg = createRegistry({});
  for (const type of ['twitchTitle', 'twitchGame', 'twitchChat', 'twitchShoutout', 'twitchChatMode']) {
    assert.deepEqual(await reg.run({ type }), { ok: false, error: 'unavailable' });
  }
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
