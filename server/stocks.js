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

const https = require('https');

const MAX_SYMBOLS = 30;            // watchlist / ticker cap (bounds fan-out + payload)
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 3 * 1024 * 1024;
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

const PROVIDERS = Object.freeze(new Set(['auto', 'yahoo', 'twelvedata', 'finnhub']));

// ── config normalization ─────────────────────────────────────────────────────

// A ticker symbol: uppercase letters, digits and the few punctuation marks real
// tickers use (dot for `.MI`, dash for `BRK-B`, caret for `^GSPC`, `=X` for FX).
// Anything else is dropped — this string is interpolated into the provider URL.
function cleanSymbol(value) {
  const s = String(value || '').trim().toUpperCase().slice(0, 20);
  return /^[A-Z0-9.\-^=]+$/.test(s) ? s : '';
}

function normalizeWatchlist(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const symbol = cleanSymbol(entry && typeof entry === 'object' ? entry.symbol : entry);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    const name = String((entry && entry.name) || '').trim().slice(0, 60);
    out.push(name ? { symbol, name } : { symbol });
    if (out.length >= MAX_SYMBOLS) break;
  }
  return out;
}

const DEFAULT_STOCKS = Object.freeze({
  watchlist: Object.freeze([
    Object.freeze({ symbol: 'FTSEMIB.MI', name: 'FTSE MIB' }),
    Object.freeze({ symbol: '^GSPC', name: 'S&P 500' }),
    Object.freeze({ symbol: 'AAPL', name: 'Apple' }),
    Object.freeze({ symbol: 'BTC-EUR', name: 'Bitcoin' }),
  ]),
  provider: 'auto',
  refreshSec: 60,
  alertPercent: 2,
  tile: Object.freeze({ chart: true, sparklines: true }),
});

function normalizeStocks(value) {
  const src = value && typeof value === 'object' ? value : {};
  const provider = PROVIDERS.has(src.provider) ? src.provider : DEFAULT_STOCKS.provider;
  // 30s floor so nobody hammers the free endpoints; 15min ceiling.
  const refreshSec = clampInt(src.refreshSec, 30, 900, DEFAULT_STOCKS.refreshSec);
  const alertPercent = clampFloat(src.alertPercent, 0.5, 25, DEFAULT_STOCKS.alertPercent);
  const wl = src.watchlist !== undefined
    ? normalizeWatchlist(src.watchlist)
    : DEFAULT_STOCKS.watchlist.map(w => ({ ...w }));
  const srcTile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  return {
    watchlist: wl,
    provider,
    refreshSec,
    alertPercent,
    tile: {
      chart: srcTile.chart !== false,
      sparklines: srcTile.sparklines !== false,
    },
  };
}

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function clampFloat(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ── hardened JSON fetch (mirrors ics-feeds.js) ───────────────────────────────

function fetchJson(url, headers) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => { if (!done) { done = true; fn(arg); } };
    const req = https.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      headers: { 'User-Agent': 'Mozilla/5.0 (Xenon Dashboard)', 'Accept': 'application/json', ...(headers || {}) },
    }, res => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return finish(reject, new Error('redirect not followed'));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return finish(reject, new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(new Error('body too large')); return; }
        body += chunk;
      });
      res.on('end', () => {
        try { finish(resolve, JSON.parse(body)); }
        catch (e) { finish(reject, e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => finish(reject, e));
  });
}

// Run promise-returning tasks with a small concurrency cap so a big watchlist
// doesn't open 30 sockets at once. Rejections resolve to null (never throws).
async function pool(items, worker, limit) {
  const out = new Array(items.length).fill(null);
  let i = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await worker(items[idx], idx); }
      catch { out[idx] = null; }
    }
  });
  await Promise.all(runners);
  return out;
}

// ── Yahoo Finance (keyless default) ──────────────────────────────────────────

function yahooUrl(symbol, range, interval) {
  const q = `range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&includePrePost=false`;
  return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${q}`;
}

// Parse a Yahoo chart response into { meta, points }. `points` is the close
// series (timestamps + closes, nulls dropped) used for sparkline + chart.
function parseYahooChart(json) {
  const result = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  if (!result || !result.meta) return null;
  const meta = result.meta;
  const ts = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result.indicators && Array.isArray(result.indicators.quote) ? result.indicators.quote[0] : null;
  const closes = quote && Array.isArray(quote.close) ? quote.close : [];
  const points = [];
  for (let k = 0; k < ts.length; k++) {
    const c = closes[k];
    if (typeof c === 'number' && Number.isFinite(c)) points.push({ t: ts[k], c });
  }
  return { meta, points };
}

function quoteFromYahoo(symbol, parsed, fallbackName) {
  const m = parsed.meta;
  const price = Number(m.regularMarketPrice);
  const prevClose = Number(m.chartPreviousClose ?? m.previousClose);
  if (!Number.isFinite(price)) return null;
  const change = Number.isFinite(prevClose) ? price - prevClose : 0;
  const changePct = Number.isFinite(prevClose) && prevClose !== 0 ? (change / prevClose) * 100 : 0;
  return {
    symbol,
    name: fallbackName || m.shortName || m.longName || symbol,
    price,
    prevClose: Number.isFinite(prevClose) ? prevClose : null,
    change,
    changePct,
    currency: m.currency || '',
    exchange: m.fullExchangeName || m.exchangeName || '',
    marketState: m.marketState || '',
    dayHigh: Number(m.regularMarketDayHigh) || null,
    dayLow: Number(m.regularMarketDayLow) || null,
    high52: Number(m.fiftyTwoWeekHigh) || null,
    low52: Number(m.fiftyTwoWeekLow) || null,
    // Compact sparkline: down-sample the intraday closes to ~24 points.
    spark: downsample(parsed.points.map(p => p.c), 24),
  };
}

function downsample(arr, target) {
  if (!Array.isArray(arr) || arr.length <= target) return arr.slice ? arr.slice() : arr;
  const step = arr.length / target;
  const out = [];
  for (let k = 0; k < target; k++) out.push(arr[Math.floor(k * step)]);
  out.push(arr[arr.length - 1]);
  return out;
}

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

function createAlertTracker() {
  let state = new Map(); // symbol → { up: bool, down: bool, day }
  return {
    evaluate(quotes, alertPercent, dayKey) {
      const alerts = [];
      const threshold = Math.abs(Number(alertPercent) || 0);
      if (!threshold) return alerts;
      for (const q of (quotes || [])) {
        const pct = Number(q.changePct);
        if (!Number.isFinite(pct)) continue;
        // Latch EACH direction independently, once per day — so an intraday
        // oscillation (+2% → -2% → +2%) fires up once and down once, never the
        // same direction twice. A new day resets both latches.
        let s = state.get(q.symbol);
        if (!s || s.day !== dayKey) { s = { up: false, down: false, day: dayKey }; state.set(q.symbol, s); }
        const push = (dir) => alerts.push({ symbol: q.symbol, name: q.name, dir, changePct: pct, price: q.price, currency: q.currency });
        if (pct >= threshold && !s.up) { s.up = true; push('up'); }
        else if (pct <= -threshold && !s.down) { s.down = true; push('down'); }
      }
      return alerts;
    },
    reset() { state = new Map(); },
  };
}

module.exports = {
  MAX_SYMBOLS,
  RANGES,
  DEFAULT_STOCKS,
  normalizeStocks,
  normalizeWatchlist,
  cleanSymbol,
  fetchQuotes,
  fetchChart,
  searchSymbols,
  createAlertTracker,
  resolveProvider: pickProvider,   // the provider actually used for given opts
};
