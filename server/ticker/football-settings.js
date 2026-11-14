'use strict';
// The football widget's saved settings: the followed teams and the defaults, cleaned.

const { cleanId, str, safeImg } = require('./football-clean.js');

const MAX_TEAMS = 20;              // favorite-teams cap (bounds fan-out + payload)

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

module.exports = { MAX_TEAMS, normalizeTeams, DEFAULT_FOOTBALL, normalizeFootball, clampInt };
