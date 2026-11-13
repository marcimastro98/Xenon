// The headlines last fetched for the news ticker, when, whether a fetch is under way, and the
// signature of what the screens were last sent.

const newsState = {
  // ── News ─────────────────────────────────────────────────────────────────────
  // In-memory only. Headlines from the followed feeds are pulled on a client-gated
  // timer, then pushed over SSE ('news'). Low cadence (feeds don't change fast).
  cache: { items: [], refreshedAt: 0 },
  refreshing: false,
  lastFetch: 0,
  sentSig: null,
};

module.exports = { newsState };
