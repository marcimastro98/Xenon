// The stock charts and stock searches already fetched, kept in memory.

const _stocksChartCache = new Map(); // bounded LRU: `${symbol}|${range}` → { at, data }
const _stocksSearchCache = new Map(); // bounded LRU: `query` → { at, results }

module.exports = { _stocksChartCache, _stocksSearchCache };
