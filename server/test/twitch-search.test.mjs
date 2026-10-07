// The Twitch watching tile's search (stream-twitch.js searchChannels). Helix
// /search/channels matches channel NAMES only, so "santa monica", which lives in
// stream titles and tags, found nothing while twitch.tv showed a whole page. The
// search now also reads the live directory and matches titles and tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createTwitchProvider, streamMatches, mergeSearch } = require('../stream-twitch.js');

function provider(routes) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'xtw-')), 'tokens.json');
  fs.writeFileSync(file, JSON.stringify({ twitch: { accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + 1e6, login: 'me', userId: '1' } }));
  const calls = [];
  const fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const r = routes.find(x => u.includes(x.match));
    if (!r) throw new Error('unexpected fetch: ' + u);
    return { ok: !r.status || r.status < 400, status: r.status || 200, json: async () => r.json };
  };
  return { p: createTwitchProvider({ clientId: 'cid', tokensFile: file, fetch }), calls };
}

const stream = (login, title, tags, viewers, game = 'Grand Theft Auto V') =>
  ({ user_login: login, user_name: login, title, tags, viewer_count: viewers, game_name: game, thumbnail_url: 'https://x/{width}x{height}.jpg' });

test('a title or a tag matches, whatever the case, accents or spacing', () => {
  assert.equal(streamMatches(stream('a', '🎡SANTA MONICA🎡 AMIR', []), 'santa monica'), true);
  assert.equal(streamMatches(stream('a', 'DAY 6 | ALVAREZ', ['SantaMonica', 'fivem']), 'santa monica'), true);
  assert.equal(streamMatches(stream('a', 'Giro in città', []), 'citta'), true);
  assert.equal(streamMatches(stream('a', 'Monica e Santa', []), 'santa monica'), true, 'every word, in any order');
  assert.equal(streamMatches(stream('a', 'Santa Clara', ['Roleplay']), 'santa monica'), false);
  assert.equal(streamMatches(null, 'santa'), false);
  assert.equal(streamMatches(stream('a', 'x', []), '  '), false);
});

test('channels named as the query come first, then streams about it by viewers', () => {
  const named = [
    { login: 'other', name: 'Other', viewers: null },
    { login: 'santamonicarp', name: 'SantaMonicaRP', viewers: null },
  ];
  const about = [
    { login: 'small', name: 'small', viewers: 3 },
    { login: 'big', name: 'big', viewers: 444 },
    { login: 'santamonicarp', name: 'SantaMonicaRP', viewers: 12, image: 'https://preview' },
  ];
  const out = mergeSearch('santa monica', named, about);
  assert.deepEqual(out.map(r => r.login), ['santamonicarp', 'big', 'small', 'other']);
  assert.equal(out[0].viewers, 12, 'a channel found both ways keeps the live row with its count');
});

test('searchChannels finds streams by title and tag, in the dashboard language', async () => {
  const { p, calls } = provider([
    { match: '/helix/search/channels', json: { data: [] } },
    { match: 'language=it', json: { data: [
      stream('berlino', '🎡SANTA MONICA🎡 AMIR', ['santamonica'], 444),
      stream('hazy', 'DAY 6', ['SantaMonica'], 9),
      stream('nope', 'Just chatting', ['Italiano'], 900, 'Just Chatting'),
    ], pagination: {} } },
    { match: '/helix/streams?first=100', json: { data: [], pagination: {} } },
  ]);
  const r = await p.searchChannels('santa monica', { language: 'it' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels.map(c => c.login), ['berlino', 'hazy']);
  assert.equal(r.channels[0].viewers, 444);
  assert.equal(r.channels[0].image, 'https://x/320x180.jpg');
  assert.ok(calls.some(u => u.includes('/helix/streams?first=100&language=it')));
});

test('the live directory is read once and shared by the searches that follow', async () => {
  const { p, calls } = provider([
    { match: '/helix/search/channels', json: { data: [] } },
    { match: '/helix/streams?first=100', json: { data: [stream('a', 'santa monica', [], 5)], pagination: {} } },
  ]);
  await p.searchChannels('santa monica');
  await p.searchChannels('monica');
  assert.equal(calls.filter(u => u.includes('/helix/streams?')).length, 1);
});

test('the directory pages are followed with the cursor and stop at the limit', async () => {
  const page = Array.from({ length: 100 }, (_, i) => stream('s' + i, 'x', [], 100 - i));
  const { p, calls } = provider([
    { match: '/helix/search/channels', json: { data: [] } },
    { match: '/helix/streams?first=100', json: { data: page, pagination: { cursor: 'next' } } },
  ]);
  await p.searchChannels('santa monica', { language: 'it' });
  const scans = calls.filter(u => u.includes('/helix/streams?'));
  assert.equal(scans.filter(u => u.includes('language=it')).length, 20, 'twenty pages in the dashboard language');
  assert.equal(scans.filter(u => !u.includes('language=')).length, 3, 'three of the busiest anywhere');
  assert.ok(scans.some(u => u.includes('after=next')));
});

test('a page shorter than 100 is not the last one: only the cursor decides', async () => {
  const page = Array.from({ length: 98 }, (_, i) => stream('s' + i, 'x', [], 100 - i));
  const { p, calls } = provider([
    { match: '/helix/search/channels', json: { data: [] } },
    { match: '/helix/streams?first=100', json: { data: page, pagination: { cursor: 'more' } } },
  ]);
  await p.searchChannels('santa monica', { language: 'it' });
  assert.equal(calls.filter(u => u.includes('language=it')).length, 20);
});

test('a bad language is ignored, and either half failing still answers', async () => {
  const { p, calls } = provider([
    { match: '/helix/search/channels', status: 500, json: {} },
    { match: '/helix/streams?first=100', json: { data: [stream('a', 'santa monica', [], 5)], pagination: {} } },
  ]);
  const r = await p.searchChannels('santa monica', { language: '&first=1' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels.map(c => c.login), ['a']);
  assert.ok(!calls.some(u => u.includes('language=')), 'an invalid language never reaches the URL');
});

test('when both halves fail it is an error, not an empty list', async () => {
  const { p } = provider([
    { match: '/helix/search/channels', status: 500, json: {} },
    { match: '/helix/streams?first=100', status: 500, json: {} },
  ]);
  const r = await p.searchChannels('santa monica');
  assert.equal(r.ok, false);
});
