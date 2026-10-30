// favorites-ai.js: "aggiungi Tesla", "togli la Juve", "segui le notizie sull'AI".
// Pinned here: adding goes through the tile's search and picks the exact name,
// news words become a topic, a duplicate is "already", removing finds by words
// (ambiguous = the matches to ask about), the caps hold, and the server wires
// the tool with the search outside the settings lock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planFavorite, applyFavorite } = require('../favorites-ai.js');

const search = {
  stocks: async (q) => (/tesla/i.test(q) ? [{ symbol: 'TSLA', name: 'Tesla, Inc.' }, { symbol: 'TL0.DE', name: 'Tesla' }] : []),
  teams: async (q) => (/juve/i.test(q) ? [{ id: '133676', type: 'team', name: 'Juventus', league: 'Italian Serie A', leagueId: '4332' }] : []),
};
const settings = () => ({
  stocks: { watchlist: [{ symbol: 'AAPL', name: 'Apple Inc.' }, { symbol: 'ENI.MI', name: 'Eni' }] },
  football: { teams: [{ id: '133670', type: 'team', name: 'Napoli' }, { id: '133671', type: 'team', name: 'Inter Milan' }, { id: '133672', type: 'team', name: 'AC Milan' }] },
  news: { feeds: [{ id: 'ai', type: 'topic', name: 'AI', query: 'AI' }] },
});
const run = async (args, s = settings()) => {
  const plan = await planFavorite(args, search);
  return plan.error ? { result: plan } : applyFavorite(s, plan);
};

test('a stock is added by name, a ticker as it is; a duplicate is already there', async () => {
  const tesla = await run({ list: 'stocks', name: 'Tesla' });
  assert.equal(tesla.result.added, 'Tesla (TL0.DE)', 'the exact name wins over the first result');
  assert.deepEqual(tesla.patch.stocks.watchlist.map((w) => w.symbol), ['AAPL', 'ENI.MI', 'TL0.DE']);
  const tsla = await run({ list: 'stocks', name: 'tsla' });
  assert.equal(tsla.patch.stocks.watchlist.at(-1).symbol, 'TSLA');
  assert.deepEqual((await run({ list: 'stocks', name: 'xyz1' })).patch.stocks.watchlist.at(-1), { symbol: 'XYZ1', name: '' });
  assert.equal((await run({ list: 'stocks', name: 'nessun titolo' })).result.error, 'not_found');
  const dup = await run({ list: 'stocks', name: 'aapl' });
  assert.equal(dup.patch, null);
  assert.equal(dup.result.already, 'Apple Inc. (AAPL)');
});

test('a team or a competition is added from the search', async () => {
  const juve = await run({ list: 'teams', name: 'Juve' });
  assert.equal(juve.result.added, 'Juventus');
  assert.equal(juve.patch.football.teams.at(-1).id, '133676');
  const serieA = await run({ list: 'teams', name: 'Serie A' });
  assert.equal(serieA.patch.football.teams.at(-1).type, 'league');
  assert.equal((await run({ list: 'teams', name: 'Squadra inventata' })).result.error, 'not_found');
});

test('news: a known source, otherwise a topic; an https feed as it is', async () => {
  const src = (await import('../news.js')).default.SOURCES[0];
  const bySource = await run({ list: 'news', name: src.name.toUpperCase() });
  assert.equal(bySource.patch.news.feeds.at(-1).type, 'source');
  const topic = await run({ list: 'news', name: 'intelligenza artificiale' });
  assert.deepEqual(topic.patch.news.feeds.at(-1), { id: topic.patch.news.feeds.at(-1).id, type: 'topic', name: 'intelligenza artificiale', query: 'intelligenza artificiale' });
  assert.equal((await run({ list: 'news', name: 'ai' })).result.already, 'AI');
  assert.equal((await run({ list: 'news', name: 'https://127.0.0.1/feed.xml' })).result.error, 'bad_feed');
});

test('remove by words; several matches are listed, none lists what there is', async () => {
  const napoli = await run({ list: 'teams', action: 'remove', name: 'napoli' });
  assert.equal(napoli.result.removed, 'Napoli');
  assert.deepEqual(napoli.patch.football.teams.map((t) => t.name), ['Inter Milan', 'AC Milan']);
  const milan = await run({ list: 'teams', action: 'remove', name: 'milan' });
  assert.deepEqual([milan.patch, milan.result.error, milan.result.matches], [null, 'ambiguous', ['Inter Milan', 'AC Milan']]);
  const none = await run({ list: 'teams', action: 'remove', name: 'roma' });
  assert.deepEqual([none.result.error, none.result.items], ['not_found', ['Napoli', 'Inter Milan', 'AC Milan']]);
  assert.equal((await run({ list: 'stocks', action: 'remove', name: 'eni.mi' })).result.removed, 'Eni (ENI.MI)');
  assert.deepEqual((await run({ list: 'news', action: 'list' })).result, { ok: true, list: 'news', items: ['AI'] });
});

test('refusals: unknown list, nothing named, list full', async () => {
  assert.equal((await run({ list: 'crypto', name: 'x' })).result.error, 'bad_list');
  assert.equal((await run({ list: 'stocks', action: 'remove' })).result.error, 'missing_name');
  const full = settings();
  full.football.teams = Array.from({ length: 20 }, (_, i) => ({ id: String(i + 1), type: 'team', name: 'T' + i }));
  assert.deepEqual((await run({ list: 'teams', name: 'Juve' }, full)).result, { ok: false, list: 'teams', error: 'full', max: 20 });
});

test('the server wires the tool, searching before the settings lock', () => {
  const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(src, /name: 'edit_favorites'/);
  assert.match(src, /fnName === 'edit_favorites'\) \{\s+fnResult = await editFavorites\(fnArgs\);/);
  const fn = src.slice(src.indexOf('async function editFavorites('));
  assert.ok(fn.indexOf('planFavorite') < fn.indexOf('withHubSettingsLock'), 'search outside the lock');
  assert.match(fn.slice(0, 900), /applyFavorite\(cur, plan\)/);
});
