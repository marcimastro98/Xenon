'use strict';
// Looks teams up at the football service: a search by name, and a team's badge, colours and
// ground.

const { fetchJson, pool } = require('./football-fetch.js');
const { cleanId, apiBase, str, intOrNull, safeImg, safeColour } = require('./football-clean.js');
const { MAX_TEAMS } = require('./football-settings.js');

const FETCH_CONCURRENCY = 4;       // TheSportsDB is per-team; keep the burst polite

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

// Pure: parse one lookupteam.php row. Exported for tests.
function parseTeamInfo(tm, lang) {
  if (!tm || typeof tm !== 'object') return null;
  const name = str(tm.strTeam, 60);
  if (!name) return null;
  const l = String(lang || 'en').trim().slice(0, 2).toUpperCase();
  // TheSportsDB carries per-language descriptions (strDescriptionIT, …) but not
  // for every club; English is the fallback that always exists.
  const desc = str(tm['strDescription' + l], 400) || str(tm.strDescriptionEN, 400);
  return {
    name,
    short: str(tm.strTeamShort, 6),
    badge: safeImg(tm.strBadge || tm.strTeamBadge),
    colour: safeColour(tm.strColour1),
    colour2: safeColour(tm.strColour2),
    stadium: str(tm.strStadium, 60),
    capacity: intOrNull(tm.intStadiumCapacity),
    founded: intOrNull(tm.intFormedYear),
    country: str(tm.strCountry, 40),
    league: str(tm.strLeague, 60),
    leagueId: cleanId(tm.idLeague),
    desc,
  };
}

// Fetch identity for a list of TEAM ids → { [id]: info }. League favorites have
// no equivalent endpoint on the free key; their badge already rides along on
// every event as strLeagueBadge. Never throws.
async function fetchTeamInfo(ids, opts) {
  const list = [];
  const seen = new Set();
  for (const raw of (Array.isArray(ids) ? ids : [])) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
    if (list.length >= MAX_TEAMS) break;
  }
  if (!list.length) return {};
  const base = apiBase((opts && opts.sportsDbKey) || '');
  const lang = (opts && opts.lang) || 'en';
  const rows = await pool(list, async (id) => {
    const j = await fetchJson(base + 'lookupteam.php?id=' + id).catch(() => null);
    const tm = j && Array.isArray(j.teams) ? j.teams[0] : null;
    const info = parseTeamInfo(tm, lang);
    return info ? { id, info } : null;
  }, FETCH_CONCURRENCY);
  const out = {};
  for (const r of rows) if (r) out[r.id] = r.info;
  return out;
}

module.exports = { FETCH_CONCURRENCY, searchTeams, parseTeamInfo, fetchTeamInfo };
