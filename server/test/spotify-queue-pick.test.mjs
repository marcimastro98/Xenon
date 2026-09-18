import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Picking a track out of Up Next.
//
// Asked for on #130: "I'd love to be able to actually pick from the spotify
// playlist showing in Up Next. Unfortunately I can see it all, but can't press
// any of them. I can only use back and forward."
//
// The row was a <div> with no handler. Everything else was already in place:
// playUri has taken a track plus the context it sits in since it was written, and
// the playlist rows in the same widget have always been buttons. What was missing
// was the context's IDENTITY — getQueue reported whether a context existed (to
// caption the list "approximate") but never which one it was, so a row had no way
// to ask for the thing that makes a tap behave like Spotify's own: play THIS
// track, then carry on through the rest of the list.

const require = createRequire(import.meta.url);
const { createSpotifyProvider } = require('../stream-spotify.js');
const WIDGET = readFileSync(new URL('../js/spotify-widget.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../components/SpotifyWidget/SpotifyWidget.css', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

// A logged-in provider whose fetch answers from a route list and records every
// request — same shape as stream-spotify.test.mjs's own helper, plus `once` so a
// route can answer differently on the retry.
function provider(routes) {
  const seen = [];
  const file = path.join(os.tmpdir(), `xe-spq-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 } }));
  const p = createSpotifyProvider({
    clientId: 'cid',
    tokensFile: file,
    fetch: async (url, init) => {
      const u = String(url);
      const method = (init && init.method) || 'GET';
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
      seen.push({ url: u, method, body });
      const i = routes.findIndex(r => u.includes(r.match) && (!r.method || r.method === method));
      if (i < 0) throw new Error('unexpected fetch: ' + method + ' ' + u);
      const r = routes[i];
      if (r.once) routes.splice(i, 1);
      const status = r.status || 200;
      return { ok: status < 400, status, json: async () => (r.json !== undefined ? r.json : null) };
    },
  });
  return { p, seen };
}

const PLAYING = {
  is_playing: true, progress_ms: 1, shuffle_state: false, repeat_state: 'off',
  device: { name: 'PC' },
  context: { type: 'playlist', uri: 'spotify:playlist:PL1' },
  item: { id: 't1', uri: 'spotify:track:T1', name: 'One', duration_ms: 1000, artists: [{ name: 'A' }], album: { name: 'Alb', images: [{ url: 'i' }] } },
};

test('the queue now says which playlist it is a queue of', async () => {
  const { p } = provider([
    { match: '/me/tracks/contains', json: [false] },
    { match: '/me/player/queue', json: { currently_playing: PLAYING.item, queue: [
      { id: 't2', uri: 'spotify:track:T2', name: 'Two', artists: [{ name: 'A' }], album: { images: [] } },
    ] } },
    { match: '/me/player', json: PLAYING },
  ]);
  const q = await p.getQueue();
  assert.equal(q.ok, true);
  assert.equal(q.reliable, true);
  assert.equal(q.contextUri, 'spotify:playlist:PL1', 'without this a tapped row has nothing to resume into');
});

test('a loose track reports no context, so a tap will play just that track', async () => {
  const { p } = provider([
    { match: '/me/tracks/contains', json: [false] },
    { match: '/me/player/queue', json: { currently_playing: PLAYING.item, queue: [] } },
    { match: '/me/player', json: Object.assign({}, PLAYING, { context: null }) },
  ]);
  const q = await p.getQueue();
  assert.equal(q.contextUri, '', 'no playlist to carry on through');
  assert.equal(q.reliable, false);
});

test('a picked track plays inside its playlist, so the rest of the list follows', async () => {
  const { p, seen } = provider([{ match: '/me/player/play', method: 'PUT', json: {} }]);
  const r = await p.playUri('spotify:track:T2', 'spotify:playlist:PL1');
  assert.deepEqual(r, { ok: true });
  const play = seen.filter(x => x.url.includes('/me/player/play'));
  assert.equal(play.length, 1, 'one call, no retry needed');
  assert.deepEqual(play[0].body, { context_uri: 'spotify:playlist:PL1', offset: { uri: 'spotify:track:T2' } });
});

test('a track the context never held still plays, on its own', async () => {
  // "Add to queue" puts a track in Up Next that belongs to no playlist, and
  // Spotify rejects an offset naming it. The API cannot tell us which rows those
  // are, so the offset is attempted and the bare track is the fallback.
  const { p, seen } = provider([
    { match: '/me/player/play', method: 'PUT', status: 400, json: { error: { message: 'Invalid offset' } }, once: true },
    { match: '/me/player/play', method: 'PUT', json: {} },
  ]);
  const r = await p.playUri('spotify:track:QUEUED', 'spotify:playlist:PL1');
  assert.deepEqual(r, { ok: true }, 'the tap must not fail silently');
  const play = seen.filter(x => x.url.includes('/me/player/play'));
  assert.equal(play.length, 2, 'offset first, then the track alone');
  assert.deepEqual(play[1].body, { uris: ['spotify:track:QUEUED'] });
});

test('with no context there is no second attempt to make', async () => {
  const { p, seen } = provider([{ match: '/me/player/play', method: 'PUT', status: 400, json: {} }]);
  const r = await p.playUri('spotify:track:T2', '');
  assert.equal(r.ok, false);
  assert.equal(seen.filter(x => x.url.includes('/me/player/play')).length, 1,
    'retrying the identical request would just cost a call');
});

test('an artist context is still dropped rather than playing the wrong song', async () => {
  // Spotify accepts an offset for albums and playlists only. That rule predates
  // this change and the fallback must not have become a way around it.
  const { p, seen } = provider([{ match: '/me/player/play', method: 'PUT', json: {} }]);
  await p.playUri('spotify:track:T2', 'spotify:artist:AR1');
  assert.deepEqual(seen.filter(x => x.url.includes('/me/player/play'))[0].body, { uris: ['spotify:track:T2'] });
});

test('the row is a button that asks to play itself', () => {
  const at = WIDGET.indexOf('function trackRow(');
  assert.ok(at > 0);
  const body = WIDGET.slice(at, WIDGET.indexOf('\n  function paintQueue', at));
  assert.match(body, /el\(playable \? 'button' : 'div'/, 'pressable only when it can act');
  assert.match(body, /type: 'spotifyPlayUri', uri: tk\.uri, contextUri: contextUri \|\| ''/);
  assert.match(body, /queue = null;/, 'the queue is a different queue afterwards');
});

test('a row with nothing to play stays a plain div', () => {
  const at = WIDGET.indexOf('function trackRow(');
  const body = WIDGET.slice(at, WIDGET.indexOf('\n  function paintQueue', at));
  assert.match(body, /const playable = !!\(tk && tk\.uri && connected === true\)/,
    'no uri, or not linked → not pressable');
  // …and the style must not make an unplayable row look pressable.
  assert.match(CSS, /\.sp-track\.is-playable \{[\s\S]*?cursor: pointer;/);
  assert.ok(!/^\.sp-track \{[^}]*cursor: pointer/m.test(CSS), 'the base row keeps no pointer cursor');
});

test('the repaint notices when the context changes, not just the tracks', () => {
  // The same track list can belong to a different playlist after a switch; a
  // signature blind to that would leave every row pointing at the old one.
  assert.match(WIDGET, /'q' \+ \(queueReliable \? '' : '~'\) \+ queueContext \+ ':'/);
});

test('the play affordance is reachable without hover, for the touchscreen', () => {
  assert.match(CSS, /@media \(hover: none\) \{\s*\.sp-track\.is-playable \.sp-track-play \{ opacity: 0\.85/);
});

test('the tooltip is translated wherever its sibling strings live', () => {
  const siblings = I18N.split('spotify_w_no_queue:').length - 1;
  const mine = I18N.split('spotify_w_play_track:').length - 1;
  assert.equal(mine, siblings, `spotify_w_play_track is in ${mine} languages, its siblings in ${siblings}`);
});
