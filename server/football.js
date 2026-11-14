'use strict';

// ── Football (Calcio) data source ────────────────────────────────────────────
// Pure data library: fetches a user's favorite teams' upcoming fixtures, recent
// results and league standings from a free provider, and normalizes the Settings
// config. The server owns the cache, the refresh timer and the SSE push (mirrors
// stocks.js) — this module never touches disk, never keeps a timer, and never
// calls Date (the caller stamps time), so it stays cheap and deterministic.
//
// KEYLESS by default: TheSportsDB v1 with the public test key `123` returns
// fixtures, results, crests and league tables for every major league — no signup.
// An OPTIONAL TheSportsDB Premium key (sportsDbKey) is the SAME API with higher
// limits and unlocks the v2 livescore feed, so followed matches show live scores
// while they're being played. The key is a SERVER-ONLY secret (football-creds.js).

require('./net-guard');

const { fetchJson, pool } = require('./ticker/football-fetch.js');
const {
  FREE_KEY, cleanId, cleanKey, apiBase, str, intOrNull, safeImg, safeColour, cleanSeason,
} = require('./ticker/football-clean.js');
const {
  MAX_TEAMS, normalizeTeams, DEFAULT_FOOTBALL, normalizeFootball,
} = require('./ticker/football-settings.js');

const {
  FETCH_CONCURRENCY, searchTeams, parseTeamInfo, fetchTeamInfo,
} = require('./ticker/football-teams.js');

const FREE_TABLE_ROWS = 5;         // rows lookuptable.php returns without a Premium key

// ── small helpers ─────────────────────────────────────────────────────────────



// ── config normalization ──────────────────────────────────────────────────────

// ── hardened JSON fetch (mirrors stocks.js / ics-feeds.js) ────────────────────

// ── event parsing ─────────────────────────────────────────────────────────────

const { soccerEvents, parseEvent, badgeFor, nameFor } = require('./ticker/football-events.js');


// ── live scores (Premium key only, v2) ────────────────────────────────────────
// Returns a Map idEvent → { homeScore, awayScore, progress } for matches in play.
// Only called when a key is present; keyless degrades to fixtures/results.
async function fetchLive(key) {
  const j = await fetchJson('https://www.thesportsdb.com/api/v2/json/livescore/soccer',
    { 'X-API-KEY': cleanKey(key) }).catch(() => null);
  const rows = j && (Array.isArray(j.livescore) ? j.livescore : (Array.isArray(j.events) ? j.events : []));
  const map = new Map();
  for (const r of (rows || [])) {
    const id = cleanId(r && r.idEvent);
    if (!id) continue;
    map.set(id, {
      homeScore: intOrNull(r.intHomeScore),
      awayScore: intOrNull(r.intAwayScore),
      progress: str(r.strProgress || r.strStatus, 12),
    });
  }
  return map;
}

// ── public fetch API ──────────────────────────────────────────────────────────

// Fetch each favorite team's next fixture + last result (and short lists for the
// detail view), merging live scores when a Premium key is set. Never throws.
async function fetchFixtures(teams, opts) {
  const list = normalizeTeams(teams);
  if (!list.length) return { teams: [], live: false };
  const key = (opts && opts.sportsDbKey) || '';
  const live = key ? await fetchLive(key).catch(() => null) : null;
  const applyLive = (ev) => {
    if (live && ev && ev.id && live.has(ev.id)) {
      const L = live.get(ev.id);
      if (L.homeScore != null) ev.homeScore = L.homeScore;
      if (L.awayScore != null) ev.awayScore = L.awayScore;
      ev.status = 'live';
      if (L.progress) ev.progress = L.progress;
    }
    return ev;
  };
  const base = apiBase(key);
  const results = await pool(list, async (fav) => {
    if (fav.type === 'league') return await fetchLeagueEntry(base, fav, applyLive);
    const [nextJson, lastJson] = await Promise.all([
      fetchJson(base + 'eventsnext.php?id=' + fav.id).catch(() => null),
      fetchJson(base + 'eventslast.php?id=' + fav.id).catch(() => null),
    ]);
    const nextEv = soccerEvents(nextJson && nextJson.events).map(parseEvent).filter(Boolean);
    const lastEv = soccerEvents(lastJson && lastJson.results).map(parseEvent).filter(Boolean);
    nextEv.forEach(applyLive);
    lastEv.forEach(applyLive);
    const next = nextEv[0] || null;
    const last = lastEv[0] || null;
    return {
      id: fav.id, type: 'team',
      name: fav.name || nameFor(last, fav.id) || nameFor(next, fav.id) || fav.id,
      badge: fav.badge || badgeFor(last, fav.id) || badgeFor(next, fav.id),
      leagueId: (last && last.leagueId) || (next && next.leagueId) || fav.leagueId || '',
      league: (last && last.league) || (next && next.league) || fav.league || '',
      season: (last && last.season) || (next && next.season) || '',
      next, last,
      // The widget merges every followed team's fixtures into one chronological
      // feed, so it wants the whole window the provider returns rather than the
      // single next/last it used to render. Same two requests either way.
      nextList: nextEv.slice(0, 8),
      lastList: lastEv.slice(0, 8),
    };
  }, FETCH_CONCURRENCY);
  const out = results.filter(Boolean);
  // `live` = a followed match is actually in play right now (drives the header
  // "LIVE" pill), NOT merely "a Premium key is configured" — otherwise the pill
  // would show 24/7. Keyless has no live data, so this stays false there.
  const anyLive = out.some(td => [td.next, td.last].some(e => e && e.status === 'live'));
  return { teams: out, live: anyLive };
}

// Fetch a followed LEAGUE/competition: its next scheduled match and most recent
// result (eventsnextleague is soonest-first, eventspastleague most-recent-first).
async function fetchLeagueEntry(base, fav, applyLive) {
  const [nextJson, pastJson] = await Promise.all([
    fetchJson(base + 'eventsnextleague.php?id=' + fav.id).catch(() => null),
    fetchJson(base + 'eventspastleague.php?id=' + fav.id).catch(() => null),
  ]);
  const nextEv = soccerEvents(nextJson && nextJson.events).map(parseEvent).filter(Boolean);
  const lastEv = soccerEvents(pastJson && pastJson.events).map(parseEvent).filter(Boolean);
  nextEv.forEach(applyLive);
  lastEv.forEach(applyLive);
  const next = nextEv[0] || null;
  const last = lastEv[0] || null;
  const known = COMPETITION_BY_ID.get(fav.id);
  return {
    id: fav.id, type: 'league',
    name: fav.name || (known && known.name) || (next && next.league) || (last && last.league) || fav.id,
    badge: fav.badge || (next && next.leagueBadge) || (last && last.leagueBadge) || '',
    leagueId: fav.id,
    league: (known && known.name) || (next && next.league) || (last && last.league) || '',
    season: (last && last.season) || (next && next.season) || '',
    next, last,
    nextList: nextEv.slice(0, 10),
    lastList: lastEv.slice(0, 10),
  };
}

// ── curated competitions (keyless discovery) ──────────────────────────────────
// TheSportsDB's free key can't list/search leagues (its list endpoints are capped
// to a handful of alphabetical rows), so league discovery is a curated set of
// major competitions with verified, stable ids + search aliases (EN + IT). This
// is what lets a user follow "Serie A", "Champions League" or the "World Cup".
function L(id, name, country, aliases) { return { id, name, country, aliases }; }
const COMPETITIONS = Object.freeze([
  L('4429', 'FIFA World Cup', 'World', ['world cup', 'fifa world cup', 'mondiale', 'mondiali', 'coppa del mondo']),
  L('5518', 'World Cup Qualifying UEFA', 'World', ['world cup qualifying', 'qualificazioni mondiali', 'qualifiers']),
  L('4480', 'UEFA Champions League', 'Europe', ['champions league', 'champions', 'uefa champions', 'ucl']),
  L('4481', 'UEFA Europa League', 'Europe', ['europa league', 'europa', 'uel']),
  L('5071', 'UEFA Conference League', 'Europe', ['conference league', 'conference']),
  L('4490', 'UEFA Nations League', 'Europe', ['nations league', 'nations']),
  L('4502', 'UEFA European Championship', 'Europe', ['euro', 'europeo', 'europei', 'european championship']),
  L('5519', 'European Championship Qualifying', 'Europe', ['euro qualifying', 'qualificazioni europei']),
  L('4332', 'Italian Serie A', 'Italy', ['serie a', 'italia', 'italian', 'campionato italiano']),
  L('4506', 'Coppa Italia', 'Italy', ['coppa italia']),
  L('4507', 'Supercoppa Italiana', 'Italy', ['supercoppa', 'supercoppa italiana']),
  L('4328', 'English Premier League', 'England', ['premier league', 'premier', 'inghilterra', 'epl', 'english']),
  L('4335', 'Spanish La Liga', 'Spain', ['la liga', 'liga', 'spagna', 'spanish']),
  L('4331', 'German Bundesliga', 'Germany', ['bundesliga', 'germania', 'german']),
  L('4334', 'French Ligue 1', 'France', ['ligue 1', 'francia', 'french']),
  L('4337', 'Dutch Eredivisie', 'Netherlands', ['eredivisie', 'olanda', 'dutch']),
  L('4344', 'Portuguese Primeira Liga', 'Portugal', ['primeira liga', 'portogallo', 'portuguese', 'liga portugal']),
  L('4351', 'Brazilian Serie A', 'Brazil', ['brazilian serie a', 'brasile', 'brasileirao', 'brazil']),
  L('4346', 'American Major League Soccer', 'USA', ['mls', 'major league soccer']),
]);
const COMPETITION_BY_ID = new Map(COMPETITIONS.map(c => [c.id, c]));

// Match the curated competitions against free text (name or alias substring).
// Instant, keyless. Returns compact league-typed results for the add box.
function searchLeagues(query) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const out = [];
  for (const c of COMPETITIONS) {
    const name = c.name.toLowerCase();
    const hit = name.includes(q) || c.aliases.some(a => a.includes(q) || q.includes(a));
    if (hit) out.push({ id: c.id, name: c.name, country: c.country, type: 'league' });
    if (out.length >= 6) break;
  }
  return out;
}

// League table for the detail view (on-demand). `season` is derived by the
// caller from the team's own fixtures ("2025-2026"); TheSportsDB needs it.
async function fetchStandings(leagueId, season, opts) {
  const lid = cleanId(leagueId);
  if (!lid) return null;
  const key = (opts && opts.sportsDbKey) || '';
  const s = cleanSeason(season);
  const url = apiBase(key) + 'lookuptable.php?l=' + lid + (s ? '&s=' + encodeURIComponent(s) : '');
  const j = await fetchJson(url).catch(() => null);
  const table = j && Array.isArray(j.table) ? j.table : [];
  const rows = table.map(r => ({
    rank: intOrNull(r.intRank),
    teamId: cleanId(r.idTeam),
    team: str(r.strTeam, 60),
    badge: safeImg(r.strBadge),
    played: intOrNull(r.intPlayed),
    win: intOrNull(r.intWin), draw: intOrNull(r.intDraw), loss: intOrNull(r.intLoss),
    gf: intOrNull(r.intGoalsFor), ga: intOrNull(r.intGoalsAgainst), gd: intOrNull(r.intGoalDifference),
    points: intOrNull(r.intPoints),
    form: str(r.strForm, 10),
  })).filter(r => r.team);
  if (!rows.length) return null;
  // The keyless tier caps lookuptable.php at FREE_TABLE_ROWS rows for every
  // competition (measured: Serie A and the Premier League both come back with
  // five, with and without a season, on both public keys). That is a provider
  // limit and not something the widget can work around, so it is REPORTED
  // rather than silently drawn as if it were the whole table — a five-row
  // "Classifica" with no explanation reads as a bug, and it is also useless to
  // anyone whose club sits below fifth. A Premium key lifts the cap.
  const partial = !key && rows.length === FREE_TABLE_ROWS;
  return { leagueId: lid, league: str(table[0] && table[0].strLeague, 60), season: s, rows, partial };
}

// ── team identity ─────────────────────────────────────────────────────────────
// A club's crest used to be harvested from its next/last MATCH, which meant a
// team with no fixture in the window (off-season, an international break, a
// freshly seeded favorite) had no crest either — the widget fell back to letter
// initials and had nothing else to show. Identity is its own thing and barely
// changes, so it is fetched once per team and cached by the caller for a day:
// crest, club colours, stadium, capacity, year founded and a description in the
// user's language. This is the content that survives an empty fixture list.

// ── news queries ──────────────────────────────────────────────────────────────
// TheSportsDB has no news feed, so headlines come from the RSS machinery news.js
// already owns: each followed team/competition becomes a Google News TOPIC in the
// user's language. This module only builds the queries (pure, testable); the
// caller hands them to news.fetchHeadlines, which does the fetching, merging and
// deduping it already does for the News widget.

// The word that keeps "Napoli" about football and not about the city. One per UI
// language, because the query is sent to the user's own Google News locale.
const NEWS_QUALIFIER = Object.freeze({
  it: 'calcio', en: 'football', es: 'fútbol', fr: 'football', de: 'Fußball',
  pt: 'futebol', nl: 'voetbal', ru: 'футбол', ko: '축구', ja: 'サッカー', zh: '足球',
});
const MAX_NEWS_FEEDS = 4;   // polite: one Google News request each, on demand only

function newsQualifier(lang) {
  const l = String(lang || 'en').trim().toLowerCase().slice(0, 2);
  return NEWS_QUALIFIER[l] || NEWS_QUALIFIER.en;
}

// Favorites → news.js topic feeds. A competition is searched by its own name; a
// club gets the football qualifier appended so "Roma" and "Napoli" (both cities)
// return match reports rather than local news.
function newsQueries(favorites, lang) {
  const qualifier = newsQualifier(lang);
  const out = [];
  const seen = new Set();
  for (const fav of normalizeTeams(favorites)) {
    const known = fav.type === 'league' ? COMPETITION_BY_ID.get(fav.id) : null;
    const name = fav.name || (known && known.name) || '';
    if (!name) continue;
    const query = fav.type === 'league' ? name : name + ' ' + qualifier;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: 'topic', name, query });
    if (out.length >= MAX_NEWS_FEEDS) break;
  }
  return out;
}

const { createAlertTracker } = require('./ticker/football-alerts.js');

module.exports = {
  MAX_TEAMS,
  MAX_NEWS_FEEDS,
  FREE_TABLE_ROWS,
  DEFAULT_FOOTBALL,
  FREE_KEY,
  normalizeFootball,
  normalizeTeams,
  cleanId,
  safeColour,
  fetchFixtures,
  fetchStandings,
  fetchTeamInfo,
  parseTeamInfo,
  newsQueries,
  newsQualifier,
  searchTeams,
  searchLeagues,
  createAlertTracker,
};
