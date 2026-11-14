'use strict';
// The limits of file search: how long the search process may idle and how long it is given, how
// many results, rows and stashed answers are kept, and how long a typed query may be.

const HOST_IDLE_MS = 5 * 60 * 1000;   // retire the PS host after 5 min without queries
const HOST_RETRY_MS = 10 * 1000;      // after a host death, wait before respawning
const REQ_TIMEOUT_MS = 6000;
const RESULTS_CACHE_MAX = 1000;       // resolvable ids (FIFO eviction)
const WDS_MAX = 100;                  // rows asked of the catalog per query
const USAGE_SAVE_DEBOUNCE_MS = 2000;
const CATALOG_STASH_MS = 15000;      // a catalog answer is collectable this long
const CATALOG_STASH_MAX = 20;
const FOLDERS_MAX = 8;                // folder results asked of the index
const POOL_MAX = 12;                  // usage-log files re-checked per query
const QUERY_MAX = 200;                // typed queries; a pasted path may be longer
const PASTED_STAT_MS = 1500;          // a mapped drive that does not answer is not a result

module.exports = {
  HOST_IDLE_MS, HOST_RETRY_MS, REQ_TIMEOUT_MS, RESULTS_CACHE_MAX, WDS_MAX, USAGE_SAVE_DEBOUNCE_MS,
  CATALOG_STASH_MS, CATALOG_STASH_MAX, FOLDERS_MAX, POOL_MAX, QUERY_MAX, PASTED_STAT_MS,
};
