'use strict';
// How often an upload in flight tells its progress, and after how long without a byte it is
// given up.

const PROGRESS_MIN_MS = 500;         // one SSE frame per id per half second, no more
const INFLIGHT_STALE_MS = 10 * 60 * 1000;

module.exports = { PROGRESS_MIN_MS, INFLIGHT_STALE_MS };
