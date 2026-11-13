// How often the calendars and feeds from other services are fetched again while a dashboard is
// open.

// Warm shortly after boot, then every 15 minutes — but only while a dashboard
// is connected (SSE-timer gating invariant: no network/disk work with nobody
// listening). A stale cache is refreshed on demand from the /events handler, so
// the first client after an idle stretch still gets fresh feeds. unref() so
// these timers never keep the process alive on shutdown.
const EXTERNAL_FEEDS_INTERVAL_MS = 15 * 60 * 1000;

module.exports = { EXTERNAL_FEEDS_INTERVAL_MS };
