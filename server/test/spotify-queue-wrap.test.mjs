// The Spotify queue that is not a queue.
//
// Reported by a widget author: playing a short album, /me/player/queue answers
// with the remaining tracks and then the whole context again, and again. Five
// tracks A B C D E sitting on C comes back as "D E A B C D E A B C …". With
// repeat off none of that will ever play — after E, playback stops.
//
// The trap in fixing it is that deduplicating by track is the WRONG tool: a
// playlist may hold the same song twice on purpose, and a queue may genuinely
// play one twice in a row. So this works on the ORDER, never on the set, and
// only cuts when three things agree that the repetition is padding:
//
//   · repeat is off      (with repeat on, the album really does play again)
//   · shuffle is off     (shuffled, the queue is not the context's order at all)
//   · the repeating block ENDS on the track that is playing — the shape a
//     context wrap always has, and the one thing a coincidental repeat does not
//
// Every case below is the sequence a real player produces, run through the pure
// function. None of it needs a Spotify account, which is the point: the rules
// are the risky part, not the HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createSpotifyProvider } = require('../stream-spotify.js');

const provider = createSpotifyProvider({
  clientId: 'cid',
  tokensFile: join(tmpdir(), `xe-q-${Date.now()}-${Math.random().toString(36).slice(2)}.json`),
  fetch: async () => { throw new Error('the normaliser must not reach the network'); },
});
const { normalizeQueue } = provider;

// Tracks as the provider shapes them: a URI is the identity, the rest is drawing.
const t = (name) => ({ name, uri: 'spotify:track:' + name, artist: 'X', image: '' });
const list = (...names) => names.map(t);
const names = (rows) => rows.map((r) => r.name);
const PLAYING = { repeat: 'off', shuffle: false };

// ── The reported shape ───────────────────────────────────────────────────────

test('the album playing round and round collapses to what is left of it', () => {
  // A B C D E, sitting on C. The wrap is everything from A onwards; what this
  // can prove is the repetition and the current track, so D E A B survives.
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C');
  assert.deepEqual(names(normalizeQueue(raw, t('C'), PLAYING)), ['D', 'E', 'A', 'B']);
});

test('a partial second lap is still a lap', () => {
  // Spotify pads to a fixed length, so the last cycle is usually cut off.
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E');
  assert.deepEqual(names(normalizeQueue(raw, t('C'), PLAYING)), ['D', 'E', 'A', 'B']);
});

test('a one-track context repeating is collapsed to nothing, not to itself', () => {
  const raw = list('A', 'A', 'A', 'A');
  assert.deepEqual(names(normalizeQueue(raw, t('A'), PLAYING)), []);
});

// ── What must survive ────────────────────────────────────────────────────────

test('a playlist that holds the same song twice keeps both', () => {
  // The case a URI-set dedupe would destroy, and the reason this works on order.
  const raw = list('A', 'B', 'A', 'C');
  assert.deepEqual(names(normalizeQueue(raw, t('Z'), PLAYING)), ['A', 'B', 'A', 'C']);
});

test('the same song twice in a row is a real queue, not a cycle', () => {
  const raw = list('A', 'A', 'B');
  assert.deepEqual(names(normalizeQueue(raw, t('Z'), PLAYING)), ['A', 'A', 'B']);
});

test('a queue that repeats a run but not around the current track is left alone', () => {
  // [A B C A B C] looks exactly like a cycle — and would be cut, if the block
  // ended on the track playing now. It ends on C and X is playing, so it is
  // somebody's actual queue and it survives whole.
  const raw = list('A', 'B', 'C', 'A', 'B', 'C');
  assert.deepEqual(names(normalizeQueue(raw, t('X'), PLAYING)), ['A', 'B', 'C', 'A', 'B', 'C']);
});

test('an ordinary queue comes back byte for byte', () => {
  const raw = list('D', 'E', 'F', 'G');
  const out = normalizeQueue(raw, t('C'), PLAYING);
  assert.deepEqual(names(out), ['D', 'E', 'F', 'G']);
  assert.equal(out[0], raw[0], 'and the same objects, not copies');
});

test('nothing is ever reordered — only a tail is removed', () => {
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C');
  const out = normalizeQueue(raw, t('C'), PLAYING);
  assert.deepEqual(out, raw.slice(0, out.length), 'the survivors are a prefix, in order');
});

// ── When the repetition is the truth ─────────────────────────────────────────

test('with repeat on, the album really does play again', () => {
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C');
  for (const repeat of ['context', 'track']) {
    assert.deepEqual(names(normalizeQueue(raw, t('C'), { repeat, shuffle: false })).length, raw.length, repeat);
  }
});

test('with shuffle on, a repeating sequence says nothing about a wrap', () => {
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C');
  assert.equal(normalizeQueue(raw, t('C'), { repeat: 'off', shuffle: true }).length, raw.length);
});

test('with no player state at all, nothing is touched', () => {
  // getPlayer can fail on its own (no active device, a 403 on an old token).
  // Guessing in the dark is how a real queue gets truncated.
  const raw = list('D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C');
  assert.equal(normalizeQueue(raw, t('C'), null).length, raw.length);
  assert.equal(normalizeQueue(raw, null, PLAYING).length, raw.length, 'nor without a current track');
});

test('degenerate inputs answer with a list, never a throw', () => {
  assert.deepEqual(normalizeQueue(null, t('C'), PLAYING), []);
  assert.deepEqual(normalizeQueue([], t('C'), PLAYING), []);
  assert.deepEqual(names(normalizeQueue(list('A'), t('A'), PLAYING)), ['A'], 'one track cannot be a cycle');
});

// ── The wiring ───────────────────────────────────────────────────────────────

test('getQueue runs it, with the player state it already had in hand', () => {
  const src = readFileSync(new URL('../stream-spotify.js', import.meta.url), 'utf8');
  assert.match(src, /queue: normalizeQueue\(raw, current, p && p\.ok \? p : null\)/);
  assert.match(src, /const p = await getPlayer\(\);/,
    'no extra call: getQueue already reads the player for `reliable`');
});

// ── Both ways in ─────────────────────────────────────────────────────────────
// The first fix reached the built-in tile and not the SDK, which is the surface
// the person who reported it actually uses — so it missed its own reporter.

test("the SDK's queue op is normalised too, not just the tile's", async () => {
  const raw = {
    currently_playing: { uri: 'spotify:track:C', name: 'C' },
    queue: ['D', 'E', 'A', 'B', 'C', 'D', 'E', 'A', 'B', 'C'].map((n) => ({ uri: 'spotify:track:' + n, name: n })),
  };
  const player = { is_playing: true, repeat_state: 'off', shuffle_state: false, item: { uri: 'spotify:track:C', name: 'C', artists: [], album: { images: [] } }, device: {} };
  const file = join(tmpdir(), `xe-q2-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({
    spotify: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6 },
  }));
  const p = createSpotifyProvider({
    clientId: 'cid',
    tokensFile: file,
    fetch: async (url) => ({
      ok: true, status: 200,
      json: async () => (String(url).includes('/me/player/queue') ? raw : player),
    }),
  });
  const r = await p.query('queue', {});
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.data.queue.map((x) => x.name), ['D', 'E', 'A', 'B']);
  assert.equal(r.data.currently_playing.name, 'C', 'everything else is Spotify\'s own, untouched');
});

test('the rows stay Spotify\'s objects — this removes, it does not reshape', () => {
  const src = readFileSync(new URL('../stream-spotify.js', import.meta.url), 'utf8');
  assert.match(src, /const QUERY_AFTER = Object\.freeze\(\{/);
  assert.match(src, /Object\.hasOwn\(QUERY_AFTER, name\)/,
    'the same own-keys guard the op table uses — constructor is not a shaper either');
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  assert.match(doc, /One exception, and it is a removal rather than a reshaping/);
});

test('what is deliberately NOT solved is written down', () => {
  // The wrap BEFORE the current track ("A B" above) is still returned. Telling
  // it from a real playlist that runs E then A then B needs the context's own
  // track order, which the queue does not carry. Left in rather than guessed at,
  // and said out loud so the next reader does not think it was missed.
  const src = readFileSync(new URL('../stream-spotify.js', import.meta.url), 'utf8');
  assert.match(src, /NOT solved here, deliberately/);
});
