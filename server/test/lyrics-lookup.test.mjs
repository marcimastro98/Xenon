// LRCLIB lookup order, picking and back-off, against a fake transport.
// Fixture lyrics are invented, never real song text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lookup, MAX_REQUESTS } = require('../lyrics.js');

const MEDIA = { title: 'Glass Harbor', artist: 'Nova Reyes', duration: 200 };
const SYNCED = '[00:01.00]first made-up line\n[00:04.00]second made-up line';
const row = (over) => ({ id: 7, trackName: 'Glass Harbor', artistName: 'Nova Reyes', duration: 200, instrumental: false, plainLyrics: null, syncedLyrics: null, ...over });

function transport(answers) {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next || { status: 404, body: null, retryAfter: 5 };
  };
  return { calls, opts: { request, sleep: async () => {} } };
}

test('a synced search hit ends the lookup after one request', async () => {
  const { calls, opts } = transport([{ status: 200, body: [row({ syncedLyrics: SYNCED })] }]);
  const out = await lookup(MEDIA, opts);
  assert.equal(out.state, 'synced');
  assert.equal(out.lines.length, 2);
  assert.equal(out.matchId, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/api\/search\?track_name=Glass\+Harbor&artist_name=Nova\+Reyes$/);
});

test('search prefers the synced row over a lower-id plain row', async () => {
  const { opts } = transport([{ status: 200, body: [row({ id: 1, plainLyrics: 'plain one' }), row({ id: 2, syncedLyrics: SYNCED })] }]);
  const out = await lookup(MEDIA, opts);
  assert.equal(out.state, 'synced');
  assert.equal(out.matchId, 2);
});

test('plain-only search falls through to /api/get, without album, with duration', async () => {
  const { calls, opts } = transport([
    { status: 200, body: [row({ plainLyrics: 'plain one\nplain two' })] },
    { status: 200, body: row({ id: 9, syncedLyrics: SYNCED }) },
  ]);
  const out = await lookup({ ...MEDIA, album: 'Some Album' }, opts);
  assert.equal(out.state, 'synced');
  assert.equal(out.matchId, 9);
  assert.match(calls[1], /\/api\/get\?/);
  assert.match(calls[1], /duration=200/);
  assert.doesNotMatch(calls[1], /album/);
});

test('plain lyrics are returned when nothing synced exists', async () => {
  const { opts } = transport([{ status: 200, body: [row({ plainLyrics: 'plain one\nplain two' })] }]);
  const out = await lookup(MEDIA, opts);
  assert.equal(out.state, 'plain');
  assert.deepEqual(out.plain, ['plain one', 'plain two']);
});

test('instrumental is its own state', async () => {
  const { opts } = transport([{ status: 200, body: [row({ instrumental: true })] }]);
  assert.equal((await lookup(MEDIA, opts)).state, 'instrumental');
});

test('a row outside the duration window or with another title is ignored', async () => {
  const { opts } = transport([{ status: 200, body: [row({ duration: 230, syncedLyrics: SYNCED }), row({ trackName: 'Other Song', syncedLyrics: SYNCED })] }]);
  assert.equal((await lookup(MEDIA, opts)).state, 'none');
});

test('404 everywhere is "none"; network failures are "error"', async () => {
  assert.equal((await lookup(MEDIA, transport([]).opts)).state, 'none');
  const { opts } = transport([new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline')]);
  assert.equal((await lookup(MEDIA, opts)).state, 'error');
});

test('429 stops at once and reports Retry-After', async () => {
  const { calls, opts } = transport([{ status: 429, body: null, retryAfter: 30 }]);
  const out = await lookup(MEDIA, opts);
  assert.deepEqual(out, { state: 'busy', retryAfter: 30 });
  assert.equal(calls.length, 1);
});

test('503 is "busy" too', async () => {
  const { opts } = transport([{ status: 503, body: null, retryAfter: 1 }, { status: 503, body: null, retryAfter: 1 }]);
  assert.equal((await lookup(MEDIA, opts)).state, 'busy');
});

test('a 1 s overload is waited out once, inside the lookup', async () => {
  const waits = [];
  const { calls, opts } = transport([{ status: 503, body: null, retryAfter: 1 }, { status: 200, body: [row({ syncedLyrics: SYNCED })] }]);
  opts.sleep = async (ms) => { waits.push(ms); };
  const out = await lookup(MEDIA, opts);
  assert.equal(out.state, 'synced');
  assert.equal(calls.length, 2);
  assert.equal(calls[1], calls[0], 'the same request again');
  assert.ok(waits.includes(1000), 'after the Retry-After it asked for');
});

test('never more than MAX_REQUESTS, with a gap between them', async () => {
  let slept = 0;
  const { calls, opts } = transport([]);
  opts.sleep = async () => { slept++; };
  await lookup({ title: 'A - B (feat. C)', artist: 'Some Channel', duration: 200 }, opts);
  assert.ok(calls.length <= MAX_REQUESTS);
  assert.equal(slept, calls.length - 1);
});

test('no timeline: no request at all', async () => {
  const { calls, opts } = transport([]);
  assert.equal((await lookup({ ...MEDIA, duration: 0 }, opts)).state, 'none');
  assert.equal(calls.length, 0);
});
