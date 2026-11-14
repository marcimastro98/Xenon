'use strict';
// What Claude Code usage would cost at API prices: the price table per model and the cost of
// one usage record.

// ── pricing (equivalent API value, per 1,000,000 tokens) ─────────────────────
// Subscription users don't pay this: it is "what the same work would have cost
// on the API". Rates are the published list prices (platform.claude.com, About
// Claude → Pricing, read 27 Sep 2026): [input, output, 5-minute cache write,
// 1-hour cache write, cache read]. Cache reads are NOT a flat 0.1x any more
// (Opus 5.5 is 0.05x, Fable 5.1 0.025x), and a 1-hour cache write costs 2x
// input where a 5-minute one costs 1.25x; Claude Code writes both, so they are
// priced apart. First match wins, so the more specific id comes first.
const PRICE_TABLE = [
  [/^claude-(fable|mythos)-5-1/, [10, 50, 12.5, 20, 0.25]],
  [/^claude-(fable|mythos)-5/,   [10, 50, 12.5, 20, 1]],
  [/^claude-opus-5-5/,           [4, 20, 5, 8, 0.20]],
  [/^claude-opus-5/,             [5, 25, 6.25, 10, 0.50]],
  [/^claude-opus-4-[5-9]/,       [5, 25, 6.25, 10, 0.50]],
  [/^claude-opus-4/,             [15, 75, 18.75, 30, 1.50]],
  [/^claude-sonnet-5/,           [2, 10, 2.5, 4, 0.20]],
  [/^claude-sonnet-4/,           [3, 15, 3.75, 6, 0.30]],
  [/^claude-haiku-4/,            [1, 5, 1.25, 2, 0.10]],
  [/^claude-(3-5-haiku|haiku-3)/, [0.8, 4, 1, 1.6, 0.08]],
];
// An id we do not know is priced like the current Opus: the value is labelled
// an estimate on screen, and Opus is what Claude Code runs by default.
const DEFAULT_PRICE = [5, 25, 6.25, 10, 0.50];
function priceForModel(model) {
  const m = String(model || '');
  for (const [re, rates] of PRICE_TABLE) if (re.test(m)) return rates;
  return DEFAULT_PRICE;
}
function recordCost(r) {
  const [inRate, outRate, w5Rate, w1hRate, readRate] = priceForModel(r.model);
  // A record written before the 5m/1h split existed carries only the total.
  const w1h = r.cc1h || 0;
  const w5 = Math.max(0, r.cc - w1h);
  return (
    r.in * inRate +
    r.out * outRate +
    w5 * w5Rate +
    w1h * w1hRate +
    r.cr * readRate
  ) / 1e6;
}

module.exports = { PRICE_TABLE, DEFAULT_PRICE, priceForModel, recordCost };
