// What the engine remembers of the football tile: the last scores, the refresh under way, and
// what is known of each team.

const footballState = {
  // ── Football (Calcio) ────────────────────────────────────────────────────────
  // In-memory only. Each favorite team's next fixture + last result (with live
  // scores when a Premium key is set) is pulled from TheSportsDB on a client-gated
  // timer, then pushed over SSE ('football'). A followed team's goal / final whistle
  // fires a 'football_alert' event (→ client toast + LED, gated by Notifiche).
  cache: { teams: [], live: false, refreshedAt: 0 },
  refreshing: false,
  lastFetch: 0,
  sig: null,
  info: {},        // id → info
  infoAt: {},      // id → ms stamp of the fetch
  infoLoaded: false,
  infoWarming: false,
};

module.exports = { footballState };
