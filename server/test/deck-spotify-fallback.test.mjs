// A Deck Spotify key while Spotify's Web API refuses the app (reported on
// Discord: "can't run due to being rate limited", still there after 12 hours
// without using Spotify). Play/pause and skip fall back to Windows' media keys,
// which never touch the API, but only when the media session in use is Spotify.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

function load({ api, media }) {
  const start = SRC.indexOf('const SPOTIFY_LOCAL_FALLBACK');
  const end = SRC.indexOf('\n};', start) + 3;
  assert.ok(start > 0 && end > start, 'Spotify fallback block moved');
  const calls = [];
  const ctx = {
    streamSpotify: { runAction: async () => api },
    getMediaInfo: async () => media,
    mediaAction: async (cmd) => { calls.push(cmd); },
    deckRegistryDeps: {},
  };
  vm.runInNewContext(SRC.slice(start, end), ctx);
  // Results come from another vm context, so compare them as plain JSON.
  return { run: async (a) => JSON.parse(JSON.stringify(await ctx.deckRegistryDeps.spotify(a))), calls: calls };
}

const LIMITED = { ok: false, error: 'rate_limited', status: 429 };
const SPOTIFY = (status) => ({ active: true, app: 'Spotify.exe', playbackStatus: status });

test('a rate-limited skip goes through the media keys when Spotify is the session', async () => {
  const w = load({ api: LIMITED, media: SPOTIFY('Playing') });
  assert.deepEqual(await w.run({ type: 'spotifyNext' }), { ok: true });
  assert.deepEqual(await w.run({ type: 'spotifyPrev' }), { ok: true });
  assert.deepEqual(await w.run({ type: 'spotifyPlay' }), { ok: true });
  assert.deepEqual([...w.calls], ['next', 'previous', 'playpause']);
});

test('play and pause stay idempotent under the rate limit', async () => {
  const playing = load({ api: LIMITED, media: SPOTIFY('Playing') });
  assert.deepEqual(await playing.run({ type: 'spotifyPlay', mode: 'play' }), { ok: true });
  assert.equal(playing.calls.length, 0, 'already playing: nothing to press');
  const paused = load({ api: LIMITED, media: SPOTIFY('Paused') });
  await paused.run({ type: 'spotifyPlay', mode: 'play' });
  assert.deepEqual([...paused.calls], ['playpause']);
});

test('another app\'s session is never skipped, and other errors pass through', async () => {
  const other = load({ api: LIMITED, media: { active: true, app: 'chrome.exe', playbackStatus: 'Playing' } });
  assert.deepEqual(await other.run({ type: 'spotifyNext' }), LIMITED);
  assert.equal(other.calls.length, 0);
  const idle = load({ api: LIMITED, media: { active: false, app: '' } });
  assert.deepEqual(await idle.run({ type: 'spotifyNext' }), LIMITED);
  const premium = { ok: false, error: 'premium_required' };
  assert.deepEqual(await load({ api: premium, media: SPOTIFY('Playing') }).run({ type: 'spotifyNext' }), premium);
});

test('only play, next and previous have a local twin', async () => {
  const w = load({ api: LIMITED, media: SPOTIFY('Playing') });
  assert.deepEqual(await w.run({ type: 'spotifyLike' }), LIMITED);
  assert.deepEqual(await w.run({ type: 'spotifyVolume', mode: 'set', value: '30' }), LIMITED);
  assert.equal(w.calls.length, 0);
});

test('a success is returned untouched', async () => {
  const w = load({ api: { ok: true }, media: SPOTIFY('Playing') });
  assert.deepEqual(await w.run({ type: 'spotifyNext' }), { ok: true });
  assert.equal(w.calls.length, 0);
});
