'use strict';
// The stocks widget's saved settings: the watchlist, the data provider and the defaults,
// cleaned.

const MAX_SYMBOLS = 30;            // watchlist / ticker cap (bounds fan-out + payload)

const PROVIDERS = Object.freeze(new Set(['auto', 'yahoo', 'twelvedata', 'finnhub']));

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

// True while the person has not chosen what to watch: same symbols as a new install.
function isDefaultWatchlist(list) {
  const symbols = (entries) => entries.map((w) => w && w.symbol).sort();
  const mine = symbols(Array.isArray(list) ? list : []);
  const base = symbols(DEFAULT_STOCKS.watchlist);
  return mine.length === base.length && mine.every((s, i) => s === base[i]);
}

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

module.exports = {
  MAX_SYMBOLS, PROVIDERS, cleanSymbol, normalizeWatchlist, DEFAULT_STOCKS, isDefaultWatchlist,
  normalizeStocks, clampInt, clampFloat,
};
