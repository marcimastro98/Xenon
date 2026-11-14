'use strict';

// ── Stock-market data source (Borsa) ─────────────────────────────────────────
// Pure data library: fetches quotes + chart candles from a free provider and
// normalizes the Settings config. The server owns the cache, the refresh timer
// and the SSE push (mirrors how the weather cache lives in server.js) — this
// module never touches disk and never keeps a timer, so it stays cheap.
//
// KEYLESS by default: Yahoo Finance chart endpoints (no signup) cover Borsa
// Italiana `.MI`, indices, crypto and FX — the only free source that returns
// them all. Optional user keys unlock richer/official providers:
//   • Twelve Data (twelveDataKey) — official quotes + intraday candles, 800/day
//   • Finnhub (finnhubKey)        — realtime US quotes
// Yahoo's endpoints are unofficial (no SLA); a keyed provider is the fallback.

require('./net-guard'); // nothing is taken from it here, but it runs code when it loads

const {
  MAX_SYMBOLS, cleanSymbol, normalizeWatchlist, DEFAULT_STOCKS, isDefaultWatchlist, normalizeStocks,
} = require('./ticker/stocks-settings.js');
const { fetchJson, pool } = require('./ticker/stocks-fetch.js');
const FETCH_CONCURRENCY = 6;       // Yahoo is per-symbol; keep the burst polite

// Chart ranges the widget exposes → Yahoo range + candle interval. Kept small so
// a fresh chart is one request and the payload never balloons.
const RANGES = Object.freeze({
  '1d':  { range: '1d',  interval: '5m'  },
  '1w':  { range: '5d',  interval: '30m' },
  '1m':  { range: '1mo', interval: '1d'  },
  '1y':  { range: '1y',  interval: '1d'  },
});
const DEFAULT_RANGE = '1d';

// ── config normalization ─────────────────────────────────────────────────────


// ── hardened JSON fetch (mirrors ics-feeds.js) ───────────────────────────────

// ── Yahoo Finance (keyless default) ──────────────────────────────────────────

const { yahooUrl, parseYahooChart, quoteFromYahoo } = require('./ticker/stocks-yahoo.js');

// ── Twelve Data (optional, keyed) ────────────────────────────────────────────

async function quoteFromTwelveData(symbol, key, fallbackName) {
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`;
  const j = await fetchJson(url);
  if (!j || j.status === 'error' || j.code) return null;
  const price = Number(j.close);
  const prevClose = Number(j.previous_close);
  if (!Number.isFinite(price)) return null;
  const change = Number.isFinite(prevClose) ? price - prevClose : Number(j.change) || 0;
  const changePct = Number.isFinite(prevClose) && prevClose !== 0
    ? (change / prevClose) * 100 : Number(j.percent_change) || 0;
  return {
    symbol,
    name: fallbackName || j.name || symbol,
    price, prevClose: Number.isFinite(prevClose) ? prevClose : null,
    change, changePct,
    currency: j.currency || '',
    exchange: j.exchange || '',
    marketState: j.is_market_open === false ? 'CLOSED' : 'REGULAR',
    dayHigh: Number(j.high) || null, dayLow: Number(j.low) || null,
    high52: j.fifty_two_week ? Number(j.fifty_two_week.high) || null : null,
    low52: j.fifty_two_week ? Number(j.fifty_two_week.low) || null : null,
    spark: [],
  };
}

// ── Finnhub (optional, keyed — US realtime) ──────────────────────────────────

async function quoteFromFinnhub(symbol, key, fallbackName) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
  const j = await fetchJson(url);
  if (!j || typeof j.c !== 'number' || j.c === 0) return null;
  const price = Number(j.c);
  const prevClose = Number(j.pc);
  const change = Number(j.d) || (Number.isFinite(prevClose) ? price - prevClose : 0);
  const changePct = Number(j.dp) || (Number.isFinite(prevClose) && prevClose !== 0 ? (change / prevClose) * 100 : 0);
  return {
    symbol, name: fallbackName || symbol,
    price, prevClose: Number.isFinite(prevClose) ? prevClose : null,
    change, changePct, currency: 'USD', exchange: '', marketState: 'REGULAR',
    dayHigh: Number(j.h) || null, dayLow: Number(j.l) || null, high52: null, low52: null,
    spark: [],
  };
}

// ── public fetch API ─────────────────────────────────────────────────────────

function pickProvider(opts) {
  const p = (opts && opts.provider) || 'auto';
  if (p === 'twelvedata' && opts.twelveDataKey) return 'twelvedata';
  if (p === 'finnhub' && opts.finnhubKey) return 'finnhub';
  return 'yahoo';
}

// Fetch quotes for a list of {symbol,name} (or bare symbols). Returns an array
// of quote objects (failed symbols are dropped). Never throws.
async function fetchQuotes(watchlist, opts) {
  const list = normalizeWatchlist(watchlist);
  if (!list.length) return [];
  const provider = pickProvider(opts || {});
  const results = await pool(list, async (entry) => {
    const { symbol, name } = entry;
    try {
      if (provider === 'twelvedata') {
        return (await quoteFromTwelveData(symbol, opts.twelveDataKey, name))
          || (await yahooQuote(symbol, name)); // graceful fallback per-symbol
      }
      if (provider === 'finnhub') {
        return (await quoteFromFinnhub(symbol, opts.finnhubKey, name))
          || (await yahooQuote(symbol, name));
      }
      return await yahooQuote(symbol, name);
    } catch { return null; }
  }, FETCH_CONCURRENCY);
  return results.filter(Boolean);
}

async function yahooQuote(symbol, name) {
  const json = await fetchJson(yahooUrl(symbol, '1d', '5m'));
  const parsed = parseYahooChart(json);
  return parsed ? quoteFromYahoo(symbol, parsed, name) : null;
}

// Fetch a single chart series for the detail view. Yahoo is used for candles
// regardless of the quote provider (Twelve Data/Finnhub candle history is
// paid/limited); the keyless path is the most reliable for OHLC.
async function fetchChart(symbol, rangeKey, opts) {
  const sym = cleanSymbol(symbol);
  if (!sym) return null;
  const r = RANGES[rangeKey] || RANGES[DEFAULT_RANGE];
  const provider = pickProvider(opts || {});
  if (provider === 'twelvedata' && opts.twelveDataKey) {
    const tv = await twelveDataChart(sym, rangeKey, opts.twelveDataKey).catch(() => null);
    if (tv && tv.points.length) return tv;
  }
  const json = await fetchJson(yahooUrl(sym, r.range, r.interval));
  const parsed = parseYahooChart(json);
  if (!parsed) return null;
  return {
    symbol: sym,
    range: rangeKey in RANGES ? rangeKey : DEFAULT_RANGE,
    currency: parsed.meta.currency || '',
    name: parsed.meta.shortName || parsed.meta.longName || sym,
    prevClose: Number(parsed.meta.chartPreviousClose ?? parsed.meta.previousClose) || null,
    points: parsed.points,
  };
}

async function twelveDataChart(symbol, rangeKey, key) {
  const map = { '1d': { interval: '5min', outputsize: 78 }, '1w': { interval: '30min', outputsize: 120 }, '1m': { interval: '1day', outputsize: 30 }, '1y': { interval: '1day', outputsize: 260 } };
  const cfg = map[rangeKey] || map['1d'];
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${cfg.interval}&outputsize=${cfg.outputsize}&order=ASC&apikey=${encodeURIComponent(key)}`;
  const j = await fetchJson(url);
  if (!j || j.status === 'error' || !Array.isArray(j.values)) return null;
  const points = j.values
    .map(v => ({ t: Math.floor(new Date(v.datetime).getTime() / 1000), c: Number(v.close) }))
    .filter(p => Number.isFinite(p.c) && Number.isFinite(p.t));
  return { symbol, range: rangeKey, currency: (j.meta && j.meta.currency) || '', name: symbol, prevClose: null, points };
}

// ── symbol search (keyless Yahoo autocomplete) ───────────────────────────────
// Resolves free text ("apple", "facebook", "ftse mib") to real tickers, so the
// user never has to know the exact symbol — the #1 reason an "add" silently did
// nothing (typing FACEBOOK/GOOGLE instead of META/GOOGL). Keyless; results are
// mapped to a compact { symbol, name, exchange, type } shape.
const SEARCH_TYPES = Object.freeze(new Set(['EQUITY', 'ETF', 'INDEX', 'CRYPTOCURRENCY', 'CURRENCY', 'MUTUALFUND', 'FUTURE']));

async function searchSymbols(query) {
  const q = String(query || '').trim().slice(0, 60);
  if (!q) return [];
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&listsCount=0&lang=en-US&region=US`;
  let j;
  try { j = await fetchJson(url); } catch { return []; }
  const quotes = j && Array.isArray(j.quotes) ? j.quotes : [];
  const out = [];
  const seen = new Set();
  for (const it of quotes) {
    const symbol = cleanSymbol(it && it.symbol);
    if (!symbol || seen.has(symbol)) continue;
    const type = String((it && it.quoteType) || '').toUpperCase();
    if (type && !SEARCH_TYPES.has(type)) continue;   // skip news/options/etc.
    seen.add(symbol);
    out.push({
      symbol,
      name: String((it.shortname || it.longname || it.name || symbol)).slice(0, 80),
      exchange: String((it.exchDisp || it.exchange || '')).slice(0, 30),
      type: String((it.typeDisp || type || '')).slice(0, 24),
    });
    if (out.length >= 10) break;
  }
  return out;
}

// ── alert tracker ────────────────────────────────────────────────────────────
// Fires when a watched symbol's day change crosses ±alertPercent. State is kept
// per symbol+direction+day so the same move alerts at most once per direction
// per day (no spam on every 60s refresh). `dayKey` is passed in (the caller
// stamps the date — this module never calls Date.now()).

const { createAlertTracker } = require('./ticker/stocks-alerts.js');

module.exports = {
  MAX_SYMBOLS,
  RANGES,
  DEFAULT_STOCKS,
  isDefaultWatchlist,
  normalizeStocks,
  normalizeWatchlist,
  cleanSymbol,
  fetchQuotes,
  fetchChart,
  searchSymbols,
  createAlertTracker,
  resolveProvider: pickProvider,   // the provider actually used for given opts
};
