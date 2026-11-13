// The news searches already fetched, kept in memory.

const _newsSearchCache = new Map(); // bounded LRU: `query` → { at, results }

module.exports = { _newsSearchCache };
