// The stock prices read last.

const stocksState = {
  // ── Stock market (Borsa) ─────────────────────────────────────────────────────
  // In-memory only. Quotes are pulled from a free provider (Yahoo keyless by
  // default; optional Twelve Data/Finnhub keys) on a client-gated timer whose
  // cadence follows the user's refreshSec, then pushed over SSE ('stocks'). When a
  // watched symbol crosses ±alertPercent an 'stocks_alert' event fires (→ client
  // toast + LED, gated by the master Notifiche switch).
  cache: { quotes: [], provider: 'yahoo', refreshedAt: 0 },
};

module.exports = { stocksState };
