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

const https = require('https');

const MAX_TEAMS = 20;              // favorite-teams cap (bounds fan-out + payload)
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const FETCH_CONCURRENCY = 4;       // TheSportsDB is per-team; keep the burst polite
const FREE_KEY = '123';            // public keyless test key

// ── small helpers ─────────────────────────────────────────────────────────────

// TheSportsDB ids are numeric strings. Anything else is dropped — these are
// interpolated into the provider URL.
function cleanId(value) {
  const s = String(value == null ? '' : value).trim();
  return /^[0-9]{1,12}$/.test(s) ? s : '';
}
// A Premium key is alphanumeric; fall back to the public key on anything odd so
// a malformed key can never break the URL path.
function cleanKey(value) {
  const s = String(value || '').trim();
  return /^[A-Za-z0-9]{1,40}$/.test(s) ? s : FREE_KEY;
}
function apiBase(key) { return `https://www.thesportsdb.com/api/v1/json/${cleanKey(key)}/`; }

function str(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 80); }
function intOrNull(value) {
  if (value == null || value === '') return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
// A badge/crest URL is rendered as an <img src>; only allow https on the
// provider's own image host (scheme + host allowlist — see CLAUDE.md invariant).
function safeImg(value) {
  const s = String(value || '').trim().slice(0, 300);
  if (!/^https:\/\//i.test(s)) return '';
  try {
    const u = new URL(s);
    return /(^|\.)thesportsdb\.com$/i.test(u.hostname) ? s : '';
  } catch { return ''; }
}
function cleanSeason(value) {
  const s = String(value || '').trim();
  return /^\d{4}-\d{4}$/.test(s) ? s : '';
}

// Map TheSportsDB's strStatus into three buckets the UI cares about.
function statusClass(strStatus, strPostponed) {
  if (String(strPostponed || '').toLowerCase() === 'yes') return 'pp';
  const s = String(strStatus || '').trim().toUpperCase();
  if (!s || s === 'NS' || s === 'NOT STARTED' || s === 'TBD' || s === 'TBA') return 'ns';
  if (['FT', 'AET', 'PEN', 'FT_PEN', 'MATCH FINISHED', 'AWARDED', 'WO'].includes(s)) return 'ft';
  if (['PP', 'POSTP', 'POSTPONED', 'CANC', 'CANCELLED', 'ABD', 'ABANDONED', 'SUSP'].includes(s)) return 'pp';
  return 'live'; // 1H, 2H, HT, ET, BT, P, LIVE, or a minute number
}

// ── config normalization ──────────────────────────────────────────────────────

// A favorite is either a TEAM (default) or a LEAGUE/competition (type:'league').
// Both carry a numeric TheSportsDB id; `type` is the discriminator that decides
// which fetch path and detail view the widget uses. A league+team can share the
// same numeric space, so dedup is keyed on `type:id`.
function normalizeTeams(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const id = cleanId(entry && typeof entry === 'object' ? entry.id : entry);
    if (!id) continue;
    const isLeague = !!(entry && typeof entry === 'object' && entry.type === 'league');
    const key = (isLeague ? 'L:' : 'T:') + id;
    if (seen.has(key)) continue;
    seen.add(key);
    const fav = { id };
    if (isLeague) fav.type = 'league';
    if (entry && typeof entry === 'object') {
      const name = str(entry.name, 60);
      const badge = safeImg(entry.badge);
      const league = str(entry.league, 60);
      const leagueId = cleanId(entry.leagueId);
      if (name) fav.name = name;
      if (badge) fav.badge = badge;
      if (league) fav.league = league;
      if (leagueId) fav.leagueId = leagueId;
    }
    out.push(fav);
    if (out.length >= MAX_TEAMS) break;
  }
  return out;
}

const DEFAULT_FOOTBALL = Object.freeze({
  teams: Object.freeze([
    Object.freeze({ id: '133670', name: 'Napoli', league: 'Italian Serie A', leagueId: '4332' }),
    Object.freeze({ id: '133681', name: 'Inter Milan', league: 'Italian Serie A', leagueId: '4332' }),
    Object.freeze({ id: '133682', name: 'Roma', league: 'Italian Serie A', leagueId: '4332' }),
    Object.freeze({ id: '4480', type: 'league', name: 'UEFA Champions League', league: 'UEFA Champions League' }),
  ]),
  refreshSec: 120,
  alerts: true,
  tile: Object.freeze({ results: true, standings: true }),
});

function normalizeFootball(value) {
  const src = value && typeof value === 'object' ? value : {};
  // 60s floor (live matches move fast); 15min ceiling.
  const refreshSec = clampInt(src.refreshSec, 60, 900, DEFAULT_FOOTBALL.refreshSec);
  const teams = src.teams !== undefined
    ? normalizeTeams(src.teams)
    : DEFAULT_FOOTBALL.teams.map(t => ({ ...t }));
  const srcTile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  return {
    teams,
    refreshSec,
    alerts: src.alerts !== false,
    tile: {
      results: srcTile.results !== false,
      standings: srcTile.standings !== false,
    },
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ── hardened JSON fetch (mirrors stocks.js / ics-feeds.js) ────────────────────

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/json', ...(headers || {}) },
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return finish(reject, new Error('redirect not followed'));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        body += chunk;
      });
      res.on('end', () => {
        try { finish(resolve, JSON.parse(body)); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
  });
}

// Run promise-returning tasks with a small concurrency cap. Rejections resolve to
// null (never throws).
async function pool(items, worker, limit) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

// ── event parsing ─────────────────────────────────────────────────────────────

function soccerEvents(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.filter(e => e && (!e.strSport || e.strSport === 'Soccer'));
}

function parseEvent(e) {
  if (!e) return null;
  const home = str(e.strHomeTeam, 60);
  const away = str(e.strAwayTeam, 60);
  if (!home || !away) return null;
  return {
    id: cleanId(e.idEvent),
    home, away,
    homeId: cleanId(e.idHomeTeam), awayId: cleanId(e.idAwayTeam),
    homeBadge: safeImg(e.strHomeTeamBadge), awayBadge: safeImg(e.strAwayTeamBadge),
    homeScore: intOrNull(e.intHomeScore), awayScore: intOrNull(e.intAwayScore),
    ts: str(e.strTimestamp, 40), date: str(e.dateEvent, 12), time: str(e.strTime, 12),
    league: str(e.strLeague, 60), leagueId: cleanId(e.idLeague), leagueBadge: safeImg(e.strLeagueBadge),
    round: str(e.intRound, 8), venue: str(e.strVenue, 80),
    status: statusClass(e.strStatus, e.strPostponed), statusRaw: str(e.strStatus, 20),
    season: cleanSeason(e.strSeason),
  };
}

function badgeFor(ev, teamId) {
  if (!ev) return '';
  if (ev.homeId === teamId) return ev.homeBadge;
  if (ev.awayId === teamId) return ev.awayBadge;
  return '';
}
function nameFor(ev, teamId) {
  if (!ev) return '';
  if (ev.homeId === teamId) return ev.home;
  if (ev.awayId === teamId) return ev.away;
  return '';
}

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
      nextList: nextEv.slice(0, 5),
      lastList: lastEv.slice(0, 5),
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
    nextList: nextEv.slice(0, 6),
    lastList: lastEv.slice(0, 6),
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
  return { leagueId: lid, league: str(table[0] && table[0].strLeague, 60), season: s, rows };
}

// Resolve free text ("napoli", "arsenal") to real teams so the widget's add box
// is a search, not a "know the numeric id" field. Soccer only, keyless.
async function searchTeams(query, opts) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) return [];
  const key = (opts && opts.sportsDbKey) || '';
  const url = apiBase(key) + 'searchteams.php?t=' + encodeURIComponent(q);
  const j = await fetchJson(url).catch(() => null);
  const teams = j && Array.isArray(j.teams) ? j.teams : [];
  const out = [];
  const seen = new Set();
  for (const tm of teams) {
    if (tm && tm.strSport && tm.strSport !== 'Soccer') continue;
    // Drop TheSportsDB's internal buckets ("_Defunct Soccer Teams", "_No League")
    // so a partial query doesn't surface a dead club over a real one.
    const lg = str(tm && tm.strLeague, 60);
    if (lg.charAt(0) === '_') continue;
    const id = cleanId(tm && tm.idTeam);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: 'team',
      name: str(tm.strTeam, 60),
      badge: safeImg(tm.strTeamBadge || tm.strBadge),
      league: lg,
      leagueId: cleanId(tm.idLeague),
      country: str(tm.strCountry, 40),
    });
    if (out.length >= 10) break;
  }
  return out;
}

// ── alert tracker ─────────────────────────────────────────────────────────────
// Transition-based: the first time a favorite team's live/finished match is seen
// its state is recorded SILENTLY (no startup spam); an alert fires only when a
// known match's score or status changes (a goal, or the final whistle). State is
// in-memory and bounded. Live goal alerts need the Premium key (livescore); the
// full-time transition can fire keyless if the match was seen live first.
function createAlertTracker() {
  let state = new Map(); // idEvent → "home-away:status"
  return {
    evaluate(teamsData, opts) {
      const alerts = [];
      if (!opts || opts.alerts === false) return alerts;
      for (const td of (teamsData || [])) {
        if (td && td.type === 'league') continue; // whole-league match alerts are too noisy
        for (const ev of [td && td.last, td && td.next]) {
          if (!ev || !ev.id) continue;
          if (ev.status !== 'live' && ev.status !== 'ft') continue;
          if (ev.homeScore == null || ev.awayScore == null) continue;
          const comp = ev.homeScore + '-' + ev.awayScore + ':' + ev.status;
          const prev = state.get(ev.id);
          if (prev === comp) continue;
          state.set(ev.id, comp);
          if (prev === undefined) continue; // first observation → record, don't alert
          alerts.push({
            team: td.name, teamId: td.id, event: ev.id,
            home: ev.home, away: ev.away,
            homeScore: ev.homeScore, awayScore: ev.awayScore,
            status: ev.status, league: ev.league,
          });
        }
      }
      // Bound the state map (keep the most recent ~150 matches).
      if (state.size > 300) state = new Map(Array.from(state).slice(-150));
      return alerts;
    },
    reset() { state = new Map(); },
  };
}

module.exports = {
  MAX_TEAMS,
  DEFAULT_FOOTBALL,
  FREE_KEY,
  normalizeFootball,
  normalizeTeams,
  cleanId,
  fetchFixtures,
  fetchStandings,
  searchTeams,
  searchLeagues,
  createAlertTracker,
};
