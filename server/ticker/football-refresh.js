// Fetching the matches of the chosen teams: one fetch at a time, goals and final whistles are
// told once, and the fresh scores go to the open dashboards.

const { broadcastSSE } = require('../http/sse-clients.js');
const lighting = require('../lighting.js');
const football = require('../football.js');
const { hub } = require('../settings/current.js');
const { _footballSettings, _footballOpts } = require('./feed-settings.js');
const { footballState } = require('./football-state.js');
const { _footballAlerts } = require('./football-alert-memory.js');
const { _pushFootball, _warmFootballInfo } = require('./football-push.js');

async function refreshFootball() {
  if (footballState.refreshing) return footballState.cache;
  footballState.lastFetch = Date.now();
  const cfg = _footballSettings();
  if (!Array.isArray(cfg.teams) || !cfg.teams.length) {
    footballState.cache = { teams: [], live: false, refreshedAt: Date.now() };
    // Following nothing means holding no identities either.
    _warmFootballInfo([]).then(_pushFootball).catch(() => {});
    _pushFootball();
    return footballState.cache;
  }
  footballState.refreshing = true;
  try {
    const data = await football.fetchFixtures(cfg.teams, _footballOpts());
    if (data.teams.length) footballState.cache = { teams: data.teams, live: data.live, refreshedAt: Date.now() };
    // Alerts: a goal or full-time transition for a followed team (deduped).
    const alerts = _footballAlerts.evaluate(footballState.cache.teams, { alerts: cfg.alerts !== false });
    for (const a of alerts) broadcastSSE('football_alert', a);
    if (alerts.length) {
      const master = hub.settings && hub.settings.notifications;
      if (!(master && master.enabled === false)) { try { lighting.onEvent('notification'); } catch {} }
    }
    _pushFootball();
  } catch { /* keep last good cache */ }
  finally { footballState.refreshing = false; }
  // Identity second, and never blocking the fixtures: the scores are what the
  // user is waiting for, and a crest arriving a beat later pushes on its own.
  _warmFootballInfo(cfg.teams).then(_pushFootball).catch(() => {});
  return footballState.cache;
}

module.exports = { refreshFootball };
