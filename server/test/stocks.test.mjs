import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pure-logic tests for the stock-market (Borsa) data module — no network. Covers
// the config normalizer (bounds + dedup + symbol cleaning) and the alert tracker
// (one alert per symbol/direction/day, resets on a new day).
const require = createRequire(import.meta.url);
const stocks = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'stocks.js'));

test('cleanSymbol keeps real ticker charset, rejects the rest', () => {
  assert.equal(stocks.cleanSymbol('aapl'), 'AAPL');
  assert.equal(stocks.cleanSymbol('ftsemib.mi'), 'FTSEMIB.MI');
  assert.equal(stocks.cleanSymbol('BRK-B'), 'BRK-B');
  assert.equal(stocks.cleanSymbol('^GSPC'), '^GSPC');
  assert.equal(stocks.cleanSymbol('EURUSD=X'), 'EURUSD=X');
  assert.equal(stocks.cleanSymbol('bad symbol!'), '');   // space + !
  assert.equal(stocks.cleanSymbol('<script>'), '');
  assert.equal(stocks.cleanSymbol(''), '');
});

test('normalizeStocks clamps, dedups and defaults', () => {
  const n = stocks.normalizeStocks({
    watchlist: ['aapl', { symbol: 'ENI.MI', name: 'Eni SpA' }, 'aapl', 'bad sym!'],
    provider: 'nonsense',
    refreshSec: 5,      // below the 30s floor
    alertPercent: 99,   // above the 25 ceiling
  });
  assert.deepEqual(n.watchlist, [{ symbol: 'AAPL' }, { symbol: 'ENI.MI', name: 'Eni SpA' }]);
  assert.equal(n.provider, 'auto');       // unknown provider → auto
  assert.equal(n.refreshSec, 30);         // clamped up to the floor
  assert.equal(n.alertPercent, 25);       // clamped down to the ceiling
  assert.equal(n.tile.chart, true);
  assert.equal(n.tile.sparklines, true);
});

test('normalizeStocks caps the watchlist at MAX_SYMBOLS', () => {
  const many = Array.from({ length: stocks.MAX_SYMBOLS + 10 }, (_, i) => 'SYM' + i);
  const n = stocks.normalizeStocks({ watchlist: many });
  assert.equal(n.watchlist.length, stocks.MAX_SYMBOLS);
});

test('normalizeStocks uses the default watchlist when none is given', () => {
  const n = stocks.normalizeStocks({});
  assert.ok(n.watchlist.length >= 1);
  assert.ok(n.watchlist.some(w => w.symbol === 'FTSEMIB.MI'));
});

test('alert tracker fires once per symbol/direction/day, resets on a new day', () => {
  const tr = stocks.createAlertTracker();
  const quotes = [
    { symbol: 'AAPL', name: 'Apple', changePct: 3.2, price: 100, currency: 'USD' },
    { symbol: 'FLAT', changePct: 0.4 },
  ];
  const a1 = tr.evaluate(quotes, 2, '2026-07-05');
  assert.equal(a1.length, 1);
  assert.equal(a1[0].symbol, 'AAPL');
  assert.equal(a1[0].dir, 'up');
  // Same direction, same day → deduped.
  assert.deepEqual(tr.evaluate(quotes, 2, '2026-07-05'), []);
  // New day → allowed to alert again.
  assert.equal(tr.evaluate(quotes, 2, '2026-07-06').length, 1);
});

test('alert tracker fires down and switches direction same day', () => {
  const tr = stocks.createAlertTracker();
  const up = [{ symbol: 'X', changePct: 4, price: 10 }];
  const down = [{ symbol: 'X', changePct: -4, price: 9 }];
  assert.equal(tr.evaluate(up, 2, 'd').length, 1);
  assert.equal(tr.evaluate(up, 2, 'd').length, 0);     // dedup up
  assert.equal(tr.evaluate(down, 2, 'd').length, 1);   // direction flipped → new alert
});

test('alert tracker with threshold 0 never fires', () => {
  const tr = stocks.createAlertTracker();
  assert.deepEqual(tr.evaluate([{ symbol: 'X', changePct: 50 }], 0, 'd'), []);
});
