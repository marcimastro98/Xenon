'use strict';
// Reads one match out of what the football service answers: the teams, the score, the time and
// the state.

const {
  cleanId, str, intOrNull, safeImg, cleanSeason, statusClass,
} = require('./football-clean.js');

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

module.exports = { soccerEvents, parseEvent, badgeFor, nameFor };
