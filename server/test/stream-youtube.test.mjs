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

// ---------------------------------------------------------------------------
// Viewer mode: playlists
// ---------------------------------------------------------------------------

test('listPlaylists maps id/title/count/thumbnail and serves the second read from cache', async () => {
  const calls = [];
  const p = connectedYt([{
    match: '/playlists?', calls,
    json: { items: [{ id: 'PL1', snippet: { title: 'Mix', thumbnails: { medium: { url: 'https://i.ytimg.com/x.jpg' } } }, contentDetails: { itemCount: 12 } }, { snippet: { title: 'no id — dropped' } }] },
  }]);
  const r = await p.listPlaylists();
  assert.equal(r.ok, true);
  assert.deepEqual(r.playlists, [{ id: 'PL1', title: 'Mix', count: 12, image: 'https://i.ytimg.com/x.jpg' }]);
  await p.listPlaylists();
  assert.equal(calls.length, 1);   // 5-min cache: one Data API call, not two
});

test('listPlaylists reports not_connected when logged out', async () => {
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  assert.deepEqual(await p.listPlaylists(), { ok: false, error: 'not_connected' });
});

test('resolvePlaylistUrl refuses ids that are not playlist tokens', async () => {
  const p = connectedYt([]);
  assert.deepEqual(await p.resolvePlaylistUrl('PL1/../etc'), { ok: false, error: 'bad_id' });
  assert.deepEqual(await p.resolvePlaylistUrl(''), { ok: false, error: 'bad_id' });
  assert.deepEqual(await p.resolvePlaylistUrl('a b'), { ok: false, error: 'bad_id' });
});

test('resolvePlaylistUrl returns the first-video watch URL, playlist page as fallback', async () => {
  const p = connectedYt([{ match: '/playlistItems', json: { items: [{ contentDetails: { videoId: 'v123' } }] } }]);
  assert.deepEqual(await p.resolvePlaylistUrl('PL1'), { ok: true, url: 'https://www.youtube.com/watch?v=v123&list=PL1' });
  // The LL liked-videos id (or a private first video) can refuse via the API —
  // the playlist page still opens fine in the user's signed-in browser.
  const empty = connectedYt([{ match: '/playlistItems', status: 404, json: { error: { errors: [{ reason: 'playlistNotFound' }] } } }]);
  assert.deepEqual(await empty.resolvePlaylistUrl('LL'), { ok: true, url: 'https://www.youtube.com/playlist?list=LL' });
});

// ---------------------------------------------------------------------------
// Viewer mode: video lists (liked / playlist contents / subscriptions / search)
// ---------------------------------------------------------------------------

test('likedVideos maps the list in one call and caches it', async () => {
  const calls = [];
  const p = connectedYt([{
    match: 'myRating=like', calls,
    json: { items: [
      { id: 'vid00001', snippet: { title: 'A song', channelTitle: 'Band', thumbnails: { medium: { url: 'https://i.ytimg.com/a.jpg' } } }, contentDetails: { duration: 'PT3M42S' } },
      { snippet: { title: 'no id — dropped' } },
    ] },
  }]);
  const r = await p.likedVideos();
  assert.equal(r.ok, true);
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0].id, 'vid00001');
  assert.equal(r.videos[0].channel, 'Band');
  assert.equal(r.videos[0].seconds, 222);
  await p.likedVideos();
  assert.equal(calls.length, 1);   // cached, not re-fetched
});

test('durations parse hours and survive a value the API never sends', async () => {
  const p = connectedYt([
    { match: 'myRating=like', json: { items: [
      { id: 'vid00001', snippet: { title: 'Long' }, contentDetails: { duration: 'PT1H2M3S' } },
      { id: 'vid00002', snippet: { title: 'Odd' }, contentDetails: { duration: 'nonsense' } },
    ] } },
  ]);
  const r = await p.likedVideos();
  assert.equal(r.videos[0].seconds, 3723);
  assert.equal(r.videos[1].seconds, null);   // never a wrong number
});

// Whether a video may play outside youtube.com rides the SAME request as the
// duration, and the widget marks the ones that may not. The direction of the
// default is the whole point: an answer that does not say has to mean "nothing
// says otherwise", because a wrong `false` hides a video that plays perfectly.
test('embeddable: only an explicit false marks a video as YouTube-only', async () => {
  const p = connectedYt([
    { match: 'myRating=like', json: { items: [
      { id: 'vid00001', snippet: { title: 'Refused' }, status: { embeddable: false } },
      { id: 'vid00002', snippet: { title: 'Allowed' }, status: { embeddable: true } },
      { id: 'vid00003', snippet: { title: 'No status block at all' } },
      { id: 'vid00004', snippet: { title: 'Status, but silent on it' }, status: { privacyStatus: 'public' } },
    ] } },
  ]);
  const r = await p.likedVideos();
  assert.deepEqual(r.videos.map(v => v.embeddable), [false, true, true, true]);
});

test('the liked list asks for the status part, or there is nothing to read', async () => {
  const calls = [];
  const p = connectedYt([{ match: 'myRating=like', calls, json: { items: [] } }]);
  await p.likedVideos();
  assert.match(calls[0], /part=snippet%2CcontentDetails%2Cstatus|part=snippet,contentDetails,status/);
});

test('the batched call carries both parts, and marks the rows it covers', async () => {
  const calls = [];
  const p = connectedYt([
    { match: '/playlistItems', json: { items: [
      { contentDetails: { videoId: 'vid00001' }, snippet: { title: 'One' } },
      { contentDetails: { videoId: 'vid00002' }, snippet: { title: 'Two' } },
    ] } },
    { match: '/videos', calls, json: { items: [
      { id: 'vid00001', contentDetails: { duration: 'PT4M' }, status: { embeddable: false } },
      { id: 'vid00002', contentDetails: { duration: 'PT2M' }, status: { embeddable: true } },
    ] } },
  ]);
  const r = await p.playlistVideos('PLxxxxxxxxxxxxxxxxxx');
  assert.match(calls[0], /part=contentDetails%2Cstatus|part=contentDetails,status/);
  assert.deepEqual(r.videos.map(v => [v.seconds, v.embeddable]), [[240, false], [120, true]]);
});

test('a row the batched call never answered for keeps playing, and has no duration', async () => {
  const p = connectedYt([
    { match: '/playlistItems', json: { items: [{ contentDetails: { videoId: 'vid00009' }, snippet: { title: 'Missed' } }] } },
    { match: '/videos', json: { items: [] } },
  ]);
  const r = await p.playlistVideos('PLxxxxxxxxxxxxxxxxxx');
  assert.equal(r.videos[0].seconds, null);
  assert.equal(r.videos[0].embeddable, true);
});

test('thumbnails that are not https are dropped, never painted', async () => {
  const p = connectedYt([{ match: 'myRating=like', json: { items: [
    { id: 'vid00001', snippet: { title: 'X', thumbnails: { medium: { url: 'javascript:alert(1)' } } } },
  ] } }]);
  const r = await p.likedVideos();
  assert.equal(r.videos[0].image, '');
});

test('playlistVideos refuses a bad id before any request, then maps + adds durations', async () => {
  const none = connectedYt([]);
  assert.deepEqual(await none.playlistVideos('PL1/../etc'), { ok: false, error: 'bad_id' });
  assert.deepEqual(await none.playlistVideos(''), { ok: false, error: 'bad_id' });

  const p = connectedYt([
    { match: '/playlistItems', json: { items: [
      { contentDetails: { videoId: 'vid00001' }, snippet: { title: 'One', videoOwnerChannelTitle: 'Chan' } },
      { contentDetails: { videoId: 'bad id' }, snippet: { title: 'dropped' } },
    ] } },
    { match: '/videos?part=contentDetails', json: { items: [{ id: 'vid00001', contentDetails: { duration: 'PT10S' } }] } },
  ]);
  const r = await p.playlistVideos('PL1');
  assert.equal(r.videos.length, 1);
  assert.deepEqual(
    { id: r.videos[0].id, channel: r.videos[0].channel, seconds: r.videos[0].seconds },
    { id: 'vid00001', channel: 'Chan', seconds: 10 });
});

test('subscriptionsFeed merges the channels newest-first and stays within its cap', async () => {
  const plCalls = [];
  const p = connectedYt([
    { match: '/subscriptions', json: { items: Array.from({ length: 30 }, (_, i) => ({ snippet: { resourceId: { channelId: 'UCchannel' + String(i).padStart(2, '0') } } })) } },
    { match: '/channels', json: { items: Array.from({ length: 15 }, (_, i) => ({ contentDetails: { relatedPlaylists: { uploads: 'UUchannel' + String(i).padStart(2, '0') } } })) } },
    { match: '/videos?part=contentDetails', json: { items: [] } },
    { match: '/playlistItems', calls: plCalls, json: { items: [
      { contentDetails: { videoId: 'old00001' }, snippet: { title: 'Old', publishedAt: '2026-01-01T00:00:00Z' } },
      { contentDetails: { videoId: 'new00001' }, snippet: { title: 'New', publishedAt: '2026-07-01T00:00:00Z' } },
    ] } },
  ]);
  const r = await p.subscriptionsFeed();
  assert.equal(r.ok, true);
  assert.equal(plCalls.length, 15, 'the 30 subscriptions are capped at 15 channel reads');
  assert.equal(r.videos[0].title, 'New', 'newest upload first');
  assert.ok(r.videos.length <= 30);
});

test('subscriptionsFeed answers an empty feed rather than failing when nothing is subscribed', async () => {
  const p = connectedYt([{ match: '/subscriptions', json: { items: [] } }]);
  assert.deepEqual(await p.subscriptionsFeed(), { ok: true, videos: [] });
});

test('searchVideos needs a real query, keeps only video results, and caches per query', async () => {
  const calls = [];
  const p = connectedYt([
    { match: '/search?', calls, json: { items: [
      { id: { videoId: 'vid00001' }, snippet: { title: 'Hit', channelTitle: 'Chan' } },
      { id: { channelId: 'UCnope' }, snippet: { title: 'a channel, not a video' } },
    ] } },
    { match: '/videos?part=contentDetails', json: { items: [] } },
  ]);
  assert.deepEqual(await p.searchVideos(' a '), { ok: false, error: 'empty' });
  assert.equal(calls.length, 0, 'a one-character query must never cost 100 quota units');
  const r = await p.searchVideos('lofi');
  assert.equal(r.videos.length, 1);
  assert.equal(r.videos[0].id, 'vid00001');
  await p.searchVideos('LOFI');
  assert.equal(calls.length, 1, 'the same query, any case, is served from cache');
});

test('the viewer lists all report not_connected when logged out', async () => {
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(), fetch: async () => { throw new Error('no'); } });
  for (const call of [p.likedVideos(), p.playlistVideos('PL1'), p.subscriptionsFeed(), p.searchVideos('lofi')]) {
    assert.deepEqual(await call, { ok: false, error: 'not_connected' });
  }
});

test('signing a different account in drops the cached library instead of inheriting it', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  const calls = [];
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([
      { match: 'myRating=like', calls, json: { items: [{ id: 'vid00001', snippet: { title: 'Private taste' } }] } },
      { match: '/token', json: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 } },
      { match: '/channels', json: { items: [{ id: 'UC999', snippet: { title: 'Someone else' } }] } },
    ]) });
  assert.equal((await p.likedVideos()).videos.length, 1);
  await p.likedVideos();
  assert.equal(calls.length, 1, 'same account, still cached');
  assert.equal((await p.pollDeviceToken('DEV')).login, 'Someone else');
  await p.likedVideos();
  assert.equal(calls.length, 2, 'the new account re-reads rather than seeing the previous one library');
});

test('logging out leaves the lists refusing rather than serving a cached copy', async () => {
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: stubFetch([
      { match: 'myRating=like', json: { items: [{ id: 'vid00001', snippet: { title: 'Private taste' } }] } },
      { match: '/revoke', json: {} },
    ]) });
  assert.equal((await p.likedVideos()).videos.length, 1);
  await p.logout();
  assert.deepEqual(await p.likedVideos(), { ok: false, error: 'not_connected' });
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

// ---------------------------------------------------------------------------
// Creator mode: starting a stream from nothing, chat, privacy, the stream key
// ---------------------------------------------------------------------------

test('createBroadcast makes the broadcast and binds it to the channel stream', async () => {
  const calls = [];
  const p = connectedYt([
    // The stub matches on a substring, and every creator call lands on
    // /liveBroadcasts — so the more specific tails come first.
    { match: '/liveBroadcasts/bind', json: { id: 'BC1' }, calls },
    { match: '/liveStreams', json: { items: [{ id: 'ST1', cdn: {} }] }, calls },
    { match: '/liveBroadcasts', json: { items: [], id: 'BC1' }, calls },
  ]);
  const r = await p.createBroadcast('Stasera si gioca', 'public');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'BC1');
  assert.equal(r.privacy, 'public');
  // The bind is what makes the broadcast usable: without it OBS pushes to an
  // endpoint no broadcast is listening on.
  assert.ok(calls.some(u => u.includes('/liveBroadcasts/bind') && u.includes('streamId=ST1')));
});

test('createBroadcast refuses a second one rather than making a duplicate', async () => {
  const p = connectedYt([
    { match: '/liveBroadcasts', json: { items: [{ id: 'OLD', status: { lifeCycleStatus: 'ready' }, snippet: { title: 'T' } }] } },
  ]);
  assert.deepEqual(await p.createBroadcast('x', 'public'), { ok: false, error: 'already_exists' });
});

test('createBroadcast creates an ingestion endpoint for a channel that has none', async () => {
  const calls = [];
  let streamListed = false;
  const file = tmpTokens();
  fs.writeFileSync(file, JSON.stringify({ youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' } }));
  const p = createYouTubeProvider({
    clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: async (url, init) => {
      const u = String(url);
      calls.push(((init && init.method) || 'GET') + ' ' + u);
      if (u.includes('/liveBroadcasts/bind')) return { ok: true, status: 200, json: async () => ({}) };
      if (u.includes('/liveStreams')) {
        // First read: this channel has never streamed. The POST then makes one.
        if (!streamListed) { streamListed = true; return { ok: true, status: 200, json: async () => ({ items: [] }) }; }
        return { ok: true, status: 200, json: async () => ({ id: 'NEW' }) };
      }
      if (u.includes('/liveBroadcasts')) return { ok: true, status: 200, json: async () => ({ items: [], id: 'BC9' }) };
      throw new Error('unexpected ' + u);
    },
  });
  const r = await p.createBroadcast('First', 'unlisted');
  assert.equal(r.ok, true);
  assert.ok(calls.some(c => c.startsWith('POST') && c.includes('/liveStreams')), 'no stream was created');
  assert.ok(calls.some(c => c.includes('streamId=NEW')), 'bound to the wrong stream');
});

test('cancelBroadcast refuses to delete one that is already live', async () => {
  const p = connectedYt([
    { match: '/liveBroadcasts', json: { items: [{ id: 'B', status: { lifeCycleStatus: 'live' }, snippet: { title: 'T' } }] } },
  ]);
  assert.deepEqual(await p.cancelBroadcast(), { ok: false, error: 'is_live' });
});

test('setPrivacy only accepts the three YouTube knows', async () => {
  const p = connectedYt([{ match: '/liveBroadcasts', json: { items: [{ id: 'B', status: {}, snippet: { title: 'T' } }] } }]);
  assert.deepEqual(await p.setPrivacy('everyone'), { ok: false, error: 'bad_privacy' });
  assert.equal((await p.setPrivacy('unlisted')).ok, true);
});

test('streamKey returns the ingest address and key, and says so when there is none', async () => {
  const p = connectedYt([{ match: '/liveStreams', json: { items: [{ cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a/live2', streamName: 'abcd-1234' } } }] } }]);
  assert.deepEqual(await p.streamKey(), { ok: true, url: 'rtmp://a/live2', key: 'abcd-1234' });
  const none = connectedYt([{ match: '/liveStreams', json: { items: [] } }]);
  assert.deepEqual(await none.streamKey(), { ok: false, error: 'no_stream' });
});

test('chatMessages maps the page and reports the poll interval YouTube asked for', async () => {
  const p = connectedYt([
    { match: '/liveChat/messages', json: {
      nextPageToken: 'PAGE2', pollingIntervalMillis: 7000,
      items: [
        { id: 'm1', snippet: { displayMessage: 'ciao' }, authorDetails: { displayName: 'Ann', profileImageUrl: 'https://i/x.jpg', isChatOwner: true } },
        { id: 'm2', snippet: { textMessageDetails: { messageText: 'yo' } }, authorDetails: { displayName: 'Bob', profileImageUrl: 'http://insecure/x.jpg' } },
        { id: 'm3', snippet: {}, authorDetails: { displayName: 'Empty' } },
      ] } },
    { match: '/liveBroadcasts', json: { items: [{ id: 'B', status: { lifeCycleStatus: 'live' }, snippet: { title: 'T', liveChatId: 'CHAT1' } }] } },
  ]);
  const r = await p.chatMessages('');
  assert.equal(r.ok, true);
  assert.equal(r.pageToken, 'PAGE2');
  assert.equal(r.pollMs, 7000);
  // A message with no text is not a message; a non-https avatar is dropped
  // because the client paints it as a CSS background-image.
  assert.deepEqual(r.messages.map(m => m.id), ['m1', 'm2']);
  assert.equal(r.messages[0].owner, true);
  assert.equal(r.messages[0].avatar, 'https://i/x.jpg');
  assert.equal(r.messages[1].avatar, '');
});

test('chatMessages holds its answer for the interval, so asking harder costs nothing', async () => {
  const calls = [];
  const p = connectedYt([
    { match: '/liveChat/messages', json: { nextPageToken: 'P', pollingIntervalMillis: 5000, items: [] }, calls },
    { match: '/liveBroadcasts', json: { items: [{ id: 'B', status: { lifeCycleStatus: 'live' }, snippet: { title: 'T', liveChatId: 'CHAT1' } }] }, calls },
  ]);
  await p.chatMessages('');
  const after = calls.filter(u => u.includes('/liveChat/messages')).length;
  for (let i = 0; i < 20; i++) await p.chatMessages('');
  assert.equal(calls.filter(u => u.includes('/liveChat/messages')).length, after,
    'the throttle is what lets this route stay a plain GET');
});

test('chatMessages refuses a page token that is not one', async () => {
  const p = connectedYt([
    { match: '/liveChat/messages', json: { items: [] } },
    { match: '/liveBroadcasts', json: { items: [{ id: 'B', status: { lifeCycleStatus: 'live' }, snippet: { title: 'T', liveChatId: 'CHAT1' } }] } },
  ]);
  assert.deepEqual(await p.chatMessages('../../evil?x=1'), { ok: false, error: 'bad_token' });
});

test('the chat says so when there is no broadcast to have one', async () => {
  const p = connectedYt([{ match: '/liveBroadcasts', json: { items: [] } }]);
  assert.deepEqual(await p.chatMessages(''), { ok: false, error: 'no_chat' });
  assert.deepEqual(await p.sendChat('hello'), { ok: false, error: 'no_chat' });
});

test('sendChat refuses an empty message before spending anything', async () => {
  const calls = [];
  const p = connectedYt([{ match: '/liveBroadcasts', json: { items: [] }, calls }]);
  assert.deepEqual(await p.sendChat('   '), { ok: false, error: 'empty' });
  assert.equal(calls.length, 0);
});

test('every creator call answers not_connected when signed out', async () => {
  const p = createYouTubeProvider({ clientId: 'cid', clientSecret: 'sec', tokensFile: tmpTokens(), fetch: stubFetch([]) });
  const results = [
    await p.createBroadcast('x'), await p.cancelBroadcast(), await p.setPrivacy('public'),
    await p.streamKey(), await p.chatMessages(''), await p.sendChat('x'),
  ];
  for (const r of results) assert.deepEqual(r, { ok: false, error: 'not_connected' });
});

test('broadcastStatus carries what the live widget needs to act on', async () => {
  const p = connectedYt([
    { match: '/liveStreams', json: { items: [{ status: { healthStatus: { status: 'good' } } }] } },
    { match: '/videos', json: { items: [{ liveStreamingDetails: { concurrentViewers: '12' }, statistics: { viewCount: '99', likeCount: '5' } }] } },
    { match: '/liveBroadcasts', json: { items: [{ id: 'BID', status: { lifeCycleStatus: 'live', privacyStatus: 'unlisted' }, snippet: { title: 'T', liveChatId: 'CH' } }] } },
  ]);
  const r = await p.broadcastStatus();
  assert.equal(r.id, 'BID');
  assert.equal(r.privacy, 'unlisted');
  assert.equal(r.chat, true);
  assert.equal(r.viewers, 12);
});
