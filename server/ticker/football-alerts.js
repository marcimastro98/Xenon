'use strict';
// Remembers the last score of each match so a goal or a final whistle is announced once.

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

module.exports = { createAlertTracker };
