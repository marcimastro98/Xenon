// tile-play.js: "metti la live di ibai", "metti questo video", "apri ilmeteo.it
// nel browser". Pinned here: links and names are read the same way the tiles
// read them, words become a search, the Browser tile never opens this PC or the
// home network, the first window to claim wins, nobody claiming = no_tile, and
// both pages and the server are wired to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseTilePlay, createTilePlay } = require('../tile-play.js');
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('Twitch: link, @name or login plays; words search', () => {
  assert.deepEqual(parseTilePlay({ tile: 'twitch', target: 'https://www.twitch.tv/Ibai/videos' }), { tile: 'twitch', value: 'ibai' });
  assert.deepEqual(parseTilePlay({ tile: 'twitch', target: '@zeRo_' }), { tile: 'twitch', value: 'zero_' });
  assert.deepEqual(parseTilePlay({ tile: 'TWITCH', target: 'minecraft speedrun' }), { tile: 'twitch', search: 'minecraft speedrun' });
  assert.deepEqual(parseTilePlay({ tile: 'twitch', search: 'lofi' }), { tile: 'twitch', search: 'lofi' });
  assert.equal(parseTilePlay({ tile: 'twitch', target: 'twitch.tv/' }).error, 'bad_channel');
});

test('YouTube: every link shape or the id plays; words search', () => {
  for (const link of ['https://youtu.be/dQw4w9WgXcQ?t=3', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=x',
    'youtube.com/shorts/dQw4w9WgXcQ', 'https://m.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ']) {
    assert.deepEqual(parseTilePlay({ tile: 'youtube', target: link }), { tile: 'youtube', value: 'dQw4w9WgXcQ' }, link);
  }
  assert.deepEqual(parseTilePlay({ tile: 'youtube', target: 'lofi hip hop' }), { tile: 'youtube', search: 'lofi hip hop' });
  assert.equal(parseTilePlay({ tile: 'youtube', target: 'https://www.youtube.com/@channel' }).error, 'bad_video');
});

test('Browser: an address only, never this PC or the home network', () => {
  assert.deepEqual(parseTilePlay({ tile: 'browser', target: 'ilmeteo.it/meteo/Roma' }), { tile: 'browser', value: 'https://ilmeteo.it/meteo/Roma' });
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x']) {
    assert.equal(parseTilePlay({ tile: 'browser', target: bad }).error, 'bad_url', bad);
  }
  for (const near of ['http://127.0.0.1:3030/settings', 'http://192.168.1.1', 'https://localhost:3030', 'http://nas.local', 'http://[::1]/']) {
    assert.equal(parseTilePlay({ tile: 'browser', target: near }).error, 'blocked_host', near);
  }
  assert.equal(parseTilePlay({ tile: 'browser', target: 'meteo' }).error, 'need_address');
  assert.equal(parseTilePlay({ tile: 'browser', search: 'meteo' }).error, 'need_address');
});

test('nothing named or an unknown tile is refused', () => {
  assert.equal(parseTilePlay({ tile: 'spotify', target: 'x' }).error, 'bad_tile');
  assert.equal(parseTilePlay({ tile: 'youtube' }).error, 'missing_target');
  assert.equal(parseTilePlay({ tile: 'twitch', search: 'a' }).error, 'missing_target');
  assert.equal(parseTilePlay(null).error, 'bad_tile');
});

test('the first claim wins; nobody claiming = not played', async () => {
  const sent = [];
  const tp = createTilePlay({ broadcast: (event, data) => sent.push([event, data]), claimMs: 40 });
  const played = tp.offer('twitch', 'ibai');
  const [event, data] = sent[0];
  assert.equal(event, 'tile_play');
  assert.deepEqual([data.tile, data.value], ['twitch', 'ibai']);
  assert.match(data.nonce, /^[0-9a-f]{24}$/);
  assert.equal(tp.claim(data.nonce), true);
  assert.equal(tp.claim(data.nonce), false, 'a second window loses');
  assert.equal(await played, true);
  assert.equal(await tp.offer('youtube', 'dQw4w9WgXcQ'), false);
  assert.equal(tp.claim(sent[1][1].nonce), false, 'too late');
  assert.equal(tp.claim('made-up'), false);
});

test('the server, both pages and the phone rule are wired', () => {
  const server = read('../server.js');
  assert.match(server, /name: 'play_in_tile'/);
  assert.match(server, /fnName === 'play_in_tile'\) \{\s+fnResult = await playInTile\(fnArgs\);/);
  assert.match(server, /reqPath === '\/tiles\/play-claim' && req\.method === 'POST'[\s\S]{0,400}tilePlay\.claim/);
  const csrf = server.slice(server.indexOf('CSRF_MUTATION_PATHS'));
  assert.ok(csrf.includes("'/tiles/play-claim'"), 'CSRF');
  assert.ok(read('../remote-access.js').includes("'/tiles/play-claim'"), 'phones refused');
  assert.match(read('../js/main.js'), /window\.TilePlay\.listen\(es\)/);
  assert.match(read('../js/layer-lite.js'), /TilePlay\.listen\(es\)/);
  const html = read('../index.html');
  assert.ok(html.indexOf('js/tile-play.js') > 0 && html.indexOf('js/tile-play.js') < html.indexOf('js/main.js'));
  const client = read('../js/tile-play.js');
  for (const entry of ['TwitchWatchWidget.playFromSdk', 'YouTubeWidget.playFromSdk', 'BrowserTile.openFromSdk']) {
    assert.ok(client.includes(entry), entry);
  }
});
