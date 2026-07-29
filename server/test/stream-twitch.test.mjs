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

// ---------------------------------------------------------------------------
// Watching: the channel lists behind the viewer widget
// ---------------------------------------------------------------------------

test('followedChannels maps rows, fills the preview placeholders, drops a junk login', async () => {
  const p = connectedProvider([{ match: '/helix/streams/followed', json: { data: [
    { user_login: 'Ninja', user_name: 'Ninja', title: 'T', game_name: 'G', viewer_count: 1234,
      thumbnail_url: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_ninja-{width}x{height}.jpg' },
    // A login that is not a login: never handed on, because the client puts it
    // straight into the player URL.
    { user_login: 'bad login!', user_name: 'X', thumbnail_url: 'https://x/y.jpg' },
    // An http thumbnail is dropped rather than painted: the client sets it as a
    // background-image, so the scheme is allowlisted at this boundary.
    { user_login: 'second', user_name: 'Second', thumbnail_url: 'http://x/y.jpg' },
  ] } }]);
  const r = await p.followedChannels();
  assert.equal(r.ok, true);
  assert.equal(r.channels.length, 2);
  assert.deepEqual(r.channels[0], {
    login: 'ninja', name: 'Ninja', title: 'T', game: 'G', viewers: 1234,
    image: 'https://static-cdn.jtvnw.net/previews-ttv/live_user_ninja-320x180.jpg', live: true,
  });
  assert.equal(r.channels[1].image, '');
});

test('followedChannels tells a missing scope apart from a dead token', async () => {
  const noScope = connectedProvider([{ match: '/helix/streams/followed', status: 401,
    json: { error: 'Unauthorized', status: 401, message: 'Missing scope: user:read:follows' } }]);
  assert.deepEqual(await noScope.followedChannels(), { ok: false, error: 'scope' });
  // The same status without that message is an ordinary rejected token, and the
  // widget must not tell the user to reconnect for a permission when the real
  // answer is "sign in again".
  const dead = connectedProvider([{ match: '/helix/streams/followed', status: 401,
    json: { error: 'Unauthorized', status: 401, message: 'Invalid OAuth token' } }]);
  assert.deepEqual(await dead.followedChannels(), { ok: false, error: 'not_connected' });
});

test('topChannels answers from cache instead of asking Twitch twice', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/streams?first', json: { data: [{ user_login: 'a', user_name: 'A' }] }, calls }]);
  const a = await p.topChannels();
  const b = await p.topChannels();
  assert.equal(a.ok, true);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1, 'the second read came from the cache');
});

test('searchChannels needs two characters and asks for live channels only', async () => {
  const calls = [];
  const p = connectedProvider([{ match: '/helix/search/channels', json: { data: [
    { broadcaster_login: 'someone', display_name: 'Someone', title: 'T', game_name: 'G', is_live: true, thumbnail_url: 'https://x/p.png' },
  ] }, calls }]);
  assert.deepEqual(await p.searchChannels('a'), { ok: false, error: 'bad_request' });
  assert.equal(calls.length, 0, 'a query too short never reaches Twitch');
  const r = await p.searchChannels('someone');
  assert.equal(r.ok, true);
  assert.match(calls[0].url, /live_only=true/);
  // Search results carry no viewer count, and a made-up number is worse than
  // none: the row simply says less.
  assert.equal(r.channels[0].viewers, null);
  assert.equal(r.channels[0].login, 'someone');
});

test('signing a different account in drops the previous one lists', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, login: 'first', userId: '1' } }));
  let top = 0;
  const p = createTwitchProvider({ clientId: 'cid', tokensFile: file, fetch: async (url) => {
    const u = String(url);
    if (u.includes('/helix/streams?first')) {
      top += 1;
      return { ok: true, status: 200, json: async () => ({ data: [{ user_login: top === 1 ? 'before' : 'after', user_name: 'X' }] }) };
    }
    if (u.includes('/oauth2/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 }) };
    if (u.includes('/helix/users')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '2', login: 'second' }] }) };
    throw new Error('unexpected fetch: ' + u);
  } });
  assert.equal((await p.topChannels()).channels[0].login, 'before');
  await p.pollDeviceToken('DEV');
  assert.equal((await p.topChannels()).channels[0].login, 'after', 'the new account must not see the old one cached list');
});

test('sendChatTo speaks in ANOTHER channel, resolving its login once', async () => {
  const calls = [];
  const p = connectedProvider([
    { match: '/helix/users?login=', json: { data: [{ id: '99', login: 'someone' }] }, calls },
    { match: '/helix/chat/messages', json: { data: [{ is_sent: true }] }, calls },
  ]);
  assert.deepEqual(await p.sendChatTo('Someone', '  hello  '), { ok: true });
  const body = JSON.parse(calls[1].init.body);
  // The target is the channel being watched; the sender stays the user.
  assert.equal(body.broadcaster_id, '99');
  assert.equal(body.sender_id, '42');
  assert.equal(body.message, 'hello');
  // A second message to the same channel must not re-resolve the login.
  await p.sendChatTo('someone', 'again');
  assert.equal(calls.filter(c => c.url.includes('/users?login=')).length, 1);
});

test('sendChatTo refuses a junk channel or an empty message before any network', async () => {
  const p = connectedProvider([{ match: '/helix/', json: {} }]);
  assert.deepEqual(await p.sendChatTo('bad name!', 'x'), { ok: false, error: 'bad_request' });
  assert.deepEqual(await p.sendChatTo('someone', '   '), { ok: false, error: 'bad_request' });
});

test('sendChatTo maps 403 to refused, not to a broken connection', async () => {
  // 403 here means the CHANNEL said no (followers-only, slow mode, a ban). Calling
  // that 'not_connected' would send the user to reconnect an account that is fine.
  const p = connectedProvider([
    { match: '/helix/users?login=', json: { data: [{ id: '99' }] } },
    { match: '/helix/chat/messages', status: 403, json: { message: 'forbidden' } },
  ]);
  assert.deepEqual(await p.sendChatTo('someone', 'hi'), { ok: false, error: 'refused' });
});

test('sendChatTo reports a message Twitch accepted and then dropped', async () => {
  // HTTP 200 with is_sent false: AutoMod ate it. Reporting success would leave the
  // user watching for a message that never arrives.
  const p = connectedProvider([
    { match: '/helix/users?login=', json: { data: [{ id: '99' }] } },
    { match: '/helix/chat/messages', json: { data: [{ is_sent: false, drop_reason: { code: 'automod_held' } }] } },
  ]);
  assert.deepEqual(await p.sendChatTo('someone', 'hi'), { ok: false, error: 'not_sent' });
});

test('channelEmotes merges the channel set with the global one and drops junk', async () => {
  const p = connectedProvider([
    { match: '/helix/users?login=', json: { data: [{ id: '99' }] } },
    { match: '/helix/chat/emotes?broadcaster_id', json: { data: [
      { name: 'berlinoWhatt', images: { url_1x: 'https://cdn/1.png' } },
      // http, not https: the client sets it as an <img> src, so it is dropped here
      { name: 'insecure', images: { url_1x: 'http://cdn/2.png' } },
      // a name that could not be typed into a chat message anyway
      { name: 'bad name <script>', images: { url_1x: 'https://cdn/3.png' } },
    ] } },
    { match: '/helix/chat/emotes/global', json: { data: [
      { name: 'Kappa', images: { url_1x: 'https://cdn/k.png' } },
      // the channel's own copy wins, and the duplicate is not listed twice
      { name: 'berlinoWhatt', images: { url_1x: 'https://cdn/dup.png' } },
    ] } },
  ]);
  const r = await p.channelEmotes('Berlino');
  assert.equal(r.ok, true);
  assert.deepEqual(r.emotes, [
    { name: 'berlinoWhatt', url: 'https://cdn/1.png' },
    { name: 'Kappa', url: 'https://cdn/k.png' },
  ]);
});

test('channelEmotes still answers when the channel has none of its own', async () => {
  // A channel with no emotes is ordinary, and the global set alone is a useful
  // picker — so only BOTH calls failing is a failure.
  const p = connectedProvider([
    { match: '/helix/users?login=', json: { data: [{ id: '99' }] } },
    { match: '/helix/chat/emotes?broadcaster_id', status: 404, json: {} },
    { match: '/helix/chat/emotes/global', json: { data: [{ name: 'Kappa', images: { url_1x: 'https://cdn/k.png' } }] } },
  ]);
  const r = await p.channelEmotes('someone');
  assert.deepEqual(r.emotes, [{ name: 'Kappa', url: 'https://cdn/k.png' }]);
});

test('channelEmotes refuses a junk channel before any network', async () => {
  const p = connectedProvider([{ match: '/helix/', json: {} }]);
  assert.deepEqual(await p.channelEmotes('bad name!'), { ok: false, error: 'bad_request' });
});
