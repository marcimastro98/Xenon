'use strict';

// ── Lyrics translation: what 100 songs cost ─────────────────────────────────
// The estimate shown next to the translation switch. Prices are the providers'
// published standard prices in US dollars per million tokens, copied from their
// pricing pages on the `checked` date; the widget names that date and links the
// page, so a stale number is visibly a dated one. A model not listed gets no
// estimate (never a guessed one), only the link.
//
// The table ships inside Xenon and is also published on the site
// (docs/community/ai-prices.json), so a price change reaches every install
// without a release. The published one is used only when it parses and is at
// least as recent as the built-in one; it can only change a displayed figure.

const { CATALOG_BASE, fetchText } = require('./community-catalog');

const PRICES_URL = CATALOG_BASE + 'ai-prices.json';
const TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_MODELS = 100;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PREFIX_RE = /^[a-z0-9][a-z0-9.-]{1,60}$/;

const BUILT_IN = Object.freeze({
  checked: '2026-10-12',
  models: Object.freeze([
    ['gemini-3.5-flash-lite', 0.30, 2.50],
    ['gemini-3.1-flash-lite', 0.25, 1.50],
    ['gemini-2.5-flash-lite', 0.10, 0.40],
    ['gpt-5.4-mini', 0.75, 4.50],
    ['gpt-5.4-nano', 0.20, 1.25],
    ['gpt-5-mini', 0.25, 2.00],
    ['gpt-5-nano', 0.05, 0.40],
    ['gpt-4.1-mini', 0.40, 1.60],
    ['gpt-4.1-nano', 0.10, 0.40],
    ['gpt-4o-mini', 0.15, 0.60],
    ['claude-haiku-5-5', 0.10, 0.50],
    ['claude-haiku-4-5', 1.00, 5.00],
  ].map(([prefix, input, output]) => Object.freeze({ prefix, input, output }))),
});

// Before any song has been translated here. Measured on 12 Oct 2026 with
// Gemini 3.5 Flash-Lite and 40 unique invented lines: 730 in / 880 out for a
// translation, 620 in / 1380 out with the reading. Rounded up.
const TYPICAL_SONG = Object.freeze({ input: 750, output: 1200 });
const SONGS = 100;

const price = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n <= 1000 ? n : null;
};

// The published file, rebuilt key by key; null when it is not a usable table.
function normalizeTable(payload) {
  if (!payload || typeof payload !== 'object' || !DATE_RE.test(String(payload.checked))) return null;
  if (payload.currency !== 'USD' || !Array.isArray(payload.models)) return null;
  const models = [];
  for (const m of payload.models.slice(0, MAX_MODELS)) {
    const prefix = m && typeof m.prefix === 'string' ? m.prefix.trim().toLowerCase() : '';
    const input = price(m && m.input);
    const output = price(m && m.output);
    if (PREFIX_RE.test(prefix) && input && output) models.push({ prefix, input, output });
  }
  return models.length ? { checked: payload.checked, models } : null;
}

let remote = null;
let fetchedAt = 0;
let failedAt = 0;
let pending = null;
let fetcher = fetchText;

// The table in use: the published one when it is not older than ours.
function table() {
  return remote && remote.checked >= BUILT_IN.checked ? remote : BUILT_IN;
}

// Fetch the published table at most every 12 h (30 min after a failure).
// Never throws; on any failure the table in use stays as it was.
function refresh() {
  const now = Date.now();
  if (pending) return pending;
  if (failedAt && now - failedAt < RETRY_MS) return Promise.resolve(table());
  if (fetchedAt && now - fetchedAt < TTL_MS) return Promise.resolve(table());
  pending = (async () => {
    try {
      const resp = await fetcher(PRICES_URL, null);
      const next = normalizeTable(JSON.parse(resp.text));
      if (!next) throw new Error('not a price table');
      remote = next;
      fetchedAt = Date.now();
      failedAt = 0;
    } catch {
      failedAt = Date.now();
    } finally {
      pending = null;
    }
    return table();
  })();
  return pending;
}

// Longest prefix wins, so `gpt-5-mini` never borrows `gpt-5`'s price.
function priceFor(model, models = table().models) {
  const id = String(model || '').toLowerCase();
  let best = null;
  for (const p of models) {
    if (id.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

// `usage` is this month's counter: `priced` songs with their `inTokens` and
// `outTokens` split. → { usd, measured, songs, checked } or null.
function estimate(model, usage) {
  const t = table();
  const p = priceFor(model, t.models);
  if (!p) return null;
  const u = usage || {};
  const measured = Number.isSafeInteger(u.priced) && u.priced > 0;
  const perSong = measured
    ? { input: u.inTokens / u.priced, output: u.outTokens / u.priced }
    : TYPICAL_SONG;
  const usd = SONGS * (perSong.input * p.input + perSong.output * p.output) / 1e6;
  return { usd: Math.round(usd * 1000) / 1000, measured, songs: SONGS, checked: t.checked };
}

module.exports = {
  estimate, priceFor, refresh, normalizeTable, BUILT_IN, TYPICAL_SONG, PRICES_URL,
  // Test seams: inject the fetcher and forget what was fetched.
  _setFetcher(fn) { fetcher = fn || fetchText; },
  _reset() { remote = null; fetchedAt = 0; failedAt = 0; pending = null; },
};
