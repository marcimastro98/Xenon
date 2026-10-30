'use strict';
// What Bit changes in the user's favourites: the Stocks watchlist, the teams
// and competitions of the Football tile, the sources and topics of the News
// tile ("aggiungi la Juve", "togli Tesla", "segui le notizie sull'AI").
// Adding goes through the same search as the tile's add box, and runs BEFORE
// the settings lock (it is a network call); removing finds the entry by words,
// accents and case ignored, in the list read under the lock. Pure apart from
// the searches, which the caller passes in.

const stocks = require('./stocks');
const football = require('./football');
const news = require('./news');
const { findItem } = require('./agenda-ai');

const KINDS = Object.freeze(['stocks', 'teams', 'news']);
const ACTIONS = Object.freeze(['add', 'remove', 'list']);
const MAX = Object.freeze({ stocks: stocks.MAX_SYMBOLS, teams: football.MAX_TEAMS, news: news.MAX_FEEDS });

const fold = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// The list inside the settings, and the settings patch that writes it back.
function listOf(kind, settings) {
  const s = settings || {};
  const v = kind === 'stocks' ? s.stocks && s.stocks.watchlist
    : kind === 'teams' ? s.football && s.football.teams
      : s.news && s.news.feeds;
  return Array.isArray(v) ? v : [];
}
function patchOf(kind, settings, list) {
  if (kind === 'stocks') return { stocks: { ...settings.stocks, watchlist: list } };
  if (kind === 'teams') return { football: { ...settings.football, teams: list } };
  return { news: { ...settings.news, feeds: list } };
}

const labelOf = (kind, e) => (kind === 'stocks' ? (e.name ? e.name + ' (' + e.symbol + ')' : e.symbol) : e.name || e.query || e.id);
const sameEntry = (kind, a, b) => (kind === 'stocks' ? a.symbol === b.symbol
  : kind === 'teams' ? a.id === b.id && (a.type === 'league') === (b.type === 'league')
    : a.id === b.id && a.type === b.type);

// The result named most exactly by `q`: an exact name (or ticker) first, then
// the search's own best match.
function bestOf(results, q, key) {
  const f = fold(q);
  return results.find((r) => fold(r[key]) === f) || results.find((r) => fold(r.symbol) === f) || results[0] || null;
}

async function addEntry(kind, q, search) {
  if (kind === 'stocks') {
    const found = bestOf(await search.stocks(q).catch(() => []), q, 'name');
    const symbol = stocks.cleanSymbol(found ? found.symbol : q);
    if (!symbol || (!found && /\s/.test(q))) return { error: 'not_found' };
    return { entry: { symbol, name: found ? String(found.name || '').slice(0, 60) : '' } };
  }
  if (kind === 'teams') {
    const results = [...football.searchLeagues(q), ...await search.teams(q).catch(() => [])];
    const found = bestOf(results, q, 'name');
    const entry = found && football.normalizeTeams([found])[0];
    return entry ? { entry } : { error: 'not_found' };
  }
  // News: an https feed address, a source the list knows by that name, or
  // otherwise a topic made of the words ("notizie sull'AI").
  if (/^https:\/\//i.test(q)) {
    const entry = news.normalizeFeeds([{ type: 'custom', url: q }])[0];
    return entry ? { entry } : { error: 'bad_feed' };
  }
  const sources = news.searchSources(q);
  const exact = sources.find((s) => fold(s.name) === fold(q)) || (sources.length === 1 ? sources[0] : null);
  const entry = news.normalizeFeeds([exact ? { type: 'source', id: exact.id } : { type: 'topic', name: q, query: q }])[0];
  return entry ? { entry } : { error: 'not_found' };
}

// → { kind, action, entry? , words? } or { error }. Searches happen here.
async function planFavorite(args, search) {
  const a = args || {};
  const kind = String(a.list || '').toLowerCase();
  if (!KINDS.includes(kind)) return { error: 'bad_list', allowed: KINDS };
  const action = ACTIONS.includes(a.action) ? a.action : 'add';
  const q = String(a.name == null ? '' : a.name).trim().slice(0, 120);
  if (action === 'list') return { kind, action };
  if (!q) return { error: 'missing_name' };
  if (action === 'remove') return { kind, action, words: q };
  const added = await addEntry(kind, q, search);
  return added.error ? added : { kind, action, entry: added.entry };
}

// Pure: the plan applied to the list read under the lock → { patch, result }.
function applyFavorite(settings, plan) {
  const { kind, action } = plan;
  const list = listOf(kind, settings);
  const names = () => list.map((e) => labelOf(kind, e));
  if (action === 'list') return { patch: null, result: { ok: true, list: kind, items: names() } };
  if (action === 'remove') {
    const view = list.map((e) => ({ ...e, label: labelOf(kind, e) }));
    const exactSymbol = kind === 'stocks' ? view.find((e) => fold(e.symbol) === fold(plan.words)) : null;
    const found = exactSymbol ? { item: exactSymbol } : findItem(view, '', plan.words, 'label');
    if (!found.item) return { patch: null, result: { ok: false, list: kind, ...found, items: found.error === 'not_found' ? names() : undefined } };
    const next = list.filter((e) => !sameEntry(kind, e, found.item));
    return { patch: patchOf(kind, settings, next), result: { ok: true, list: kind, removed: found.item.label } };
  }
  const there = list.find((e) => sameEntry(kind, e, plan.entry));
  if (there) return { patch: null, result: { ok: true, list: kind, already: labelOf(kind, there) } };
  if (list.length >= MAX[kind]) return { patch: null, result: { ok: false, list: kind, error: 'full', max: MAX[kind] } };
  return { patch: patchOf(kind, settings, [...list, plan.entry]), result: { ok: true, list: kind, added: labelOf(kind, plan.entry) } };
}

module.exports = { KINDS, planFavorite, applyFavorite };
