// Fetching the prices of the chosen stocks: one fetch at a time, the alerts that are due are
// told, and the fresh prices go to the open dashboards.

const { broadcastSSE } = require('../http/sse-clients.js');
const lighting = require('../lighting.js');
const stocks = require('../stocks.js');
const { hub } = require('../settings/current.js');
const { stocksState } = require('./stocks-state.js');
const { stocksRefresh } = require('./stocks-refresh-state.js');
const { _pushStocks } = require('./stocks-push.js');
const { _stocksAlerts } = require('./stocks-alert-memory.js');
const { _stocksSettings, _stocksProviderOpts, _stocksAlertsWanted } = require('./feed-settings.js');

async function refreshStocks() {
  if (stocksRefresh.refreshing) return stocksState.cache;
  stocksRefresh.lastFetch = Date.now();
  const cfg = _stocksSettings();
  if (!Array.isArray(cfg.watchlist) || !cfg.watchlist.length) {
    stocksState.cache = { quotes: [], provider: 'yahoo', refreshedAt: Date.now() };
    _pushStocks();
    return stocksState.cache;
  }
  stocksRefresh.refreshing = true;
  try {
    const opts = _stocksProviderOpts();
    const quotes = await stocks.fetchQuotes(cfg.watchlist, opts);
    if (quotes.length) stocksState.cache = { quotes, provider: stocks.resolveProvider(opts), refreshedAt: Date.now() };
    // Alerts: one per symbol per direction per day (the tracker dedupes on dayKey).
    const dayKey = new Date().toISOString().slice(0, 10);
    const alerts = _stocksAlertsWanted(cfg) ? _stocksAlerts.evaluate(quotes, cfg.alertPercent, dayKey) : [];
    for (const a of alerts) broadcastSSE('stocks_alert', a);
    // LED reaction (same lighting notification effect the other feeds use),
    // gated by the master Notifiche switch — mirrors the client toast gating.
    if (alerts.length) {
      const master = hub.settings && hub.settings.notifications;
      if (!(master && master.enabled === false)) { try { lighting.onEvent('notification'); } catch {} }
    }
    _pushStocks();
  } catch { /* keep last good cache */ }
  finally { stocksRefresh.refreshing = false; }
  return stocksState.cache;
}

module.exports = { refreshStocks };
