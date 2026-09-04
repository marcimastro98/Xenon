// Six named YouTube reads for community widgets — and nothing else.
//
// Asked for by the author of a YouTube widget who had built a private sidecar to
// get at authenticated reads and wanted to delete it. Same answer the Spotify
// browser got: an `op` indexes a table of functions, so an op we do not have is
// not a request, no path a widget sends can become a URL, and the account's
// token never leaves the server.
//
// What differs from the Spotify surface, and why:
//   · POST, on the CSRF list. One searchVideos is 100 of the account's 10,000
//     daily units, which makes a drive-by loop able to end someone's YouTube day.
//   · Xenon's compact rows, not Google's raw objects. These are the same rows the
//     built-in tile draws, so one place stays responsible for Google's shape.
//   · Paging by opaque token, because a YouTube library does not fit in a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const { createYouTubeProvider } = require('../stream-youtube.js');

const CH = 'UCuAXFkgsw1L7xaCfnd5JJOw';   // a real-shaped channel id

/** A connected provider whose fetch records every URL and answers from `routes`. */
function probe(routes, seen = []) {
  const file = join(tmpdir(), `xe-yq-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    youtube: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, channel: 'C', channelId: 'UC' },
  }));
  return createYouTubeProvider({
    clientId: 'cid', clientSecret: 'sec', tokensFile: file,
    fetch: async (url) => {
      const u = String(url);
      seen.push(u);
      const r = routes.find((x) => u.includes(x.match));
      if (!r) throw new Error('unexpected fetch: ' + u);
      return { ok: true, status: 200, json: async () => r.json };
    },
  });
}

const VIDEOS = { match: '/videos?part=contentDetails', json: { items: [] } };
const ITEMS = (nextPageToken) => ({
  match: '/playlistItems',
  json: { nextPageToken, items: [{ contentDetails: { videoId: 'vid00001' }, snippet: { title: 'One', videoOwnerChannelTitle: 'Chan' } }] },
});

// ── The table ────────────────────────────────────────────────────────────────

test('an op we do not have is not a request', async () => {
  const seen = [];
  const p = probe([], seen);
  for (const op of ['', 'nope', 'constructor', '__proto__', 'toString', 'likedVideos', '/playlistItems']) {
    const r = await p.query(op, {});
    assert.equal(r.ok, false, op);
    assert.equal(r.error, 'bad_op', op);
  }
  assert.deepEqual(seen, [], 'a rejected op must never reach Google');
});

test('the six documented ops each map to a real read', async () => {
  const seen = [];
  const p = probe([
    { match: '/subscriptions', json: { items: [{ snippet: { resourceId: { channelId: CH }, title: 'A', thumbnails: { medium: { url: 'https://i/1.jpg' } } } }] } },
    { match: '/channels', json: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] } },
    { match: '/playlists', json: { items: [{ id: 'PLx', snippet: { title: 'P' }, contentDetails: { itemCount: 4 } }] } },
    { match: '/search', json: { items: [{ id: { videoId: 'vid00002' }, snippet: { title: 'S' } }] } },
    ITEMS(''), VIDEOS,
  ], seen);
  const OPS = [
    ['subscriptionFeed', {}, 'videos'],
    ['subscriptionChannels', {}, 'channels'],
    ['searchVideos', { q: 'radiohead' }, 'videos'],
    ['channelVideos', { id: CH }, 'videos'],
    ['channelPlaylists', { id: CH }, 'playlists'],
    ['playlistVideos', { id: 'PLabc' }, 'videos'],
  ];
  for (const [op, params, key] of OPS) {
    const r = await p.query(op, params);
    assert.equal(r.ok, true, `${op}: ${r.error}`);
    assert.ok(Array.isArray(r.data[key]), `${op} must answer with ${key}`);
    assert.equal(typeof r.data.nextPageToken, 'string', `${op} must always say whether there is more`);
  }
});

test('the answer carries only the rows, never the provider object', async () => {
  const p = probe([ITEMS(''), VIDEOS]);
  const r = await p.query('playlistVideos', { id: 'PLabc' });
  assert.deepEqual(Object.keys(r.data).sort(), ['nextPageToken', 'videos'],
    'a future field added to a provider answer must not reach widgets by accident');
  assert.deepEqual(Object.keys(r.data.videos[0]).sort(),
    ['channel', 'embeddable', 'id', 'image', 'published', 'seconds', 'title'],
    'the documented row shape');
});

// ── Ids and tokens ───────────────────────────────────────────────────────────

test('a channel id must be a channel id, and is checked before any request', async () => {
  const seen = [];
  const p = probe([], seen);
  for (const id of ['', null, 'PLabc', '../channels', 'UC', 'UC' + 'x'.repeat(40), CH + '/x']) {
    for (const op of ['channelVideos', 'channelPlaylists']) {
      const r = await p.query(op, { id });
      assert.equal(r.ok, false, `${op} ${id}`);
      assert.equal(r.error, 'bad_id', `${op} ${id}`);
    }
  }
  assert.deepEqual(seen, []);
});

test('a page token is opaque but not unchecked', async () => {
  const seen = [];
  const p = probe([], seen);
  for (const tok of ['a b', 'x&maxResults=50', '../x', '#frag', 'y'.repeat(500)]) {
    const r = await p.query('playlistVideos', { id: 'PLabc', pageToken: tok });
    assert.equal(r.error, 'bad_page', tok);
  }
  assert.deepEqual(seen, [], 'a token that could not be one never reaches a query string');
});

test('a bad token is refused rather than dropped', async () => {
  // Dropping it would answer page one under the name of page two, which is how a
  // widget ends up paging forever over the same rows.
  const p = probe([ITEMS('CAoQAA'), VIDEOS]);
  const bad = await p.query('playlistVideos', { id: 'PLabc', pageToken: 'has space' });
  assert.equal(bad.ok, false);
  const good = await p.query('playlistVideos', { id: 'PLabc' });
  assert.equal(good.ok, true);
});

test('the token is passed on, and comes back for the next page', async () => {
  const seen = [];
  const p = probe([ITEMS('CAoQAA'), VIDEOS], seen);
  const first = await p.query('playlistVideos', { id: 'PLabc' });
  assert.equal(first.data.nextPageToken, 'CAoQAA');
  await p.query('playlistVideos', { id: 'PLabc', pageToken: 'CAoQAA' });
  assert.ok(seen.some((u) => u.includes('pageToken=CAoQAA')), 'the second page must ask for the second page');
});

test('a token Google sends that we would not accept back is not handed out', async () => {
  const p = probe([ITEMS('not a token'), VIDEOS]);
  const r = await p.query('playlistVideos', { id: 'PLabc' });
  assert.equal(r.data.nextPageToken, '', 'handing out a token our own check would refuse is a dead end');
});

test('page two is not served from page one', async () => {
  const seen = [];
  const p = probe([ITEMS('CAoQAA'), VIDEOS], seen);
  await p.query('playlistVideos', { id: 'PLabc' });
  await p.query('playlistVideos', { id: 'PLabc' });
  const one = seen.filter((u) => u.includes('/playlistItems')).length;
  assert.equal(one, 1, 'the same page twice is one read — the cache is the quota defence');
  await p.query('playlistVideos', { id: 'PLabc', pageToken: 'CAoQAA' });
  assert.equal(seen.filter((u) => u.includes('/playlistItems')).length, 2, 'a different page is a different read');
});

// ── Ordering ─────────────────────────────────────────────────────────────────
// The widget author found this by tracing his old private backend: it asked for
// order=relevance, the native op hard-coded alphabetical, and the SDK forwarded
// only pageToken — so his "YouTube order" mode was A–Z wearing another name.

test('the order reaches YouTube, and defaults to alphabetical', async () => {
  const seen = [];
  const p = probe([{ match: '/subscriptions', json: { items: [] } }], seen);
  await p.query('subscriptionChannels', {});
  assert.ok(seen[0].includes('order=alphabetical'), seen[0]);
  for (const order of ['relevance', 'unread']) {   // alphabetical is the default above, and cached by now
    seen.length = 0;
    const r = await p.query('subscriptionChannels', { order });
    assert.equal(r.ok, true, order);
    assert.ok(seen[0].includes('order=' + order), `${order}: ${seen[0]}`);
  }
});

test('an order we do not have is refused, never quietly replaced', async () => {
  // Silently defaulting is exactly the bug being fixed: a list labelled
  // "Pertinence" that was alphabetical underneath. An error is a thing the
  // widget can show; a confident wrong answer is not.
  const seen = [];
  const p = probe([], seen);
  for (const order of ['date', 'ALPHABETICAL', 'relevance ', 'unread&maxResults=50', 'reverse']) {
    const r = await p.query('subscriptionChannels', { order });
    assert.equal(r.error, 'bad_order', String(order));
  }
  assert.deepEqual(seen, [], 'a refused order never reaches Google');
});

test('two orders are two lists, not one cache entry', async () => {
  const seen = [];
  const p = probe([{ match: '/subscriptions', json: { items: [] } }], seen);
  await p.query('subscriptionChannels', { order: 'relevance' });
  await p.query('subscriptionChannels', { order: 'alphabetical' });
  await p.query('subscriptionChannels', { order: 'relevance' });
  assert.equal(seen.length, 2, 'the third is the first one again — the second is a different list');
  assert.ok(seen[1].includes('order=alphabetical'));
});

test('the order survives the bridge and the route', () => {
  // Both forward a fixed list of param names, so a param missing from either
  // one is dropped between the widget and the provider that reads it.
  assert.match(read('server/js/custom-widget.js'), /for \(const k of \['id', 'q', 'pageToken', 'order'\]\)/);
  assert.match(read('server/server.js'), /for \(const k of \['id', 'q', 'pageToken', 'order'\]\)/);
});

// ── Quota ────────────────────────────────────────────────────────────────────

test("a channel's uploads playlist is resolved once, then paged like any playlist", async () => {
  // channels.list is 1 unit and the id never changes, so paying it per page would
  // be paying for nothing.
  const seen = [];
  const p = probe([
    { match: '/channels', json: { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UUabc' } } }] } },
    ITEMS('CAoQAA'), VIDEOS,
  ], seen);
  await p.query('channelVideos', { id: CH });
  await p.query('channelVideos', { id: CH, pageToken: 'CAoQAA' });
  assert.equal(seen.filter((u) => u.includes('/channels')).length, 1);
  assert.ok(seen.some((u) => u.includes('playlistId=UUabc')));
});

test('a channel with no uploads playlist is not_found, not a broken read', async () => {
  const p = probe([{ match: '/channels', json: { items: [] } }]);
  assert.deepEqual(await p.query('channelVideos', { id: CH }), { ok: false, error: 'not_found' });
});

test('signing out drops the library rather than lending it to the next account', async () => {
  const seen = [];
  const p = probe([ITEMS(''), VIDEOS, { match: 'oauth2.googleapis.com/revoke', json: {} }], seen);
  await p.query('playlistVideos', { id: 'PLabc' });
  await p.logout();
  const after = await p.query('playlistVideos', { id: 'PLabc' });
  assert.deepEqual(after, { ok: false, error: 'not_connected' });
});

// ── The boundary ─────────────────────────────────────────────────────────────

test('the route costs quota, so it is POST and on the CSRF list', () => {
  const server = read('server/server.js');
  assert.match(server, /reqPath === '\/stream\/youtube\/query' && req\.method === 'POST'/,
    'a GET here is one drive-by loop away from 100 quota units a request');
  const csrf = server.slice(server.indexOf('const CSRF_MUTATION_PATHS = new Set(['));
  assert.ok(csrf.slice(0, csrf.indexOf(']);')).includes("'/stream/youtube/query'"));
  const remote = read('server/remote-access.js');
  assert.ok(remote.includes("'/stream/youtube/query'"),
    'a paired phone must not be able to reach it by navigation either');
});

test('the route is gated per package, on the read grant and not on a playback one', () => {
  const server = read('server/server.js');
  const start = server.indexOf("reqPath === '/stream/youtube/query'");
  const body = server.slice(start, start + 1800);
  assert.match(body, /sdkGrantsFor\(pkgId\)\.streams\.includes\('youtube'\)/);
  assert.match(body, /sdkTileGate\(pkgId/);
  const bridge = read('server/js/custom-widget.js');
  assert.match(bridge, /if \(!grant\.streams\.includes\('youtube'\)\) \{ reply\(\{ ok: false, error: 'not_allowed' \}\); return; \}/,
    'the bridge checks too — it is convenience, the server is the boundary');
});

test('reading is its own grant, and rides no existing one', () => {
  const sdk = require('../sdk-widgets.js');
  assert.ok(sdk.SDK_STREAMS.includes('youtube'));
  assert.ok(!sdk.SDK_ACTION_CATEGORIES.youtube.includes('youtubeQuery'),
    'reading a library must not ride "control your YouTube stream"');
  assert.ok(sdk.SDK_STREAMS.includes('youtubeLive'),
    'and it must not have replaced the broadcast stream either');
  // The five mirrors of the SDK surface (see the header of sdk-widgets.js).
  assert.ok(read('server/js/settings.js').includes("'youtubeLive', 'youtube'"));
  const labels = read('server/js/custom-widget.js');
  assert.match(labels, /youtube: \['cw_stream_youtube',/);
});

test('the SDK guide documents the ops, the rows and the quota', () => {
  const doc = read('docs/WIDGET_SDK.md');
  assert.match(doc, /### 3f\. Reading YouTube/);
  for (const op of ['subscriptionFeed', 'subscriptionChannels', 'searchVideos',
    'channelVideos', 'channelPlaylists', 'playlistVideos']) {
    assert.ok(doc.includes('| `' + op + '`'), `${op} is undocumented`);
  }
  assert.match(doc, /nextPageToken/);
  assert.match(doc, /one `searchVideos` costs 100 of\s*\nthem/,
    'the one number a widget author has to design around');
  assert.match(doc, /The rows are Xenon's, not Google's/);
  assert.match(doc, /`relevance` — YouTube's own ranking/);
  assert.match(doc, /refused as `bad_order`/);
});
