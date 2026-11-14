'use strict';
// Reads a quote and its small chart out of what Yahoo Finance answers.

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

module.exports = { yahooUrl, parseYahooChart, quoteFromYahoo, downsample };
