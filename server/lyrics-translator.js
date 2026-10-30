'use strict';

// ── Lyrics translation: spending guard and cache ─────────────────────────────
// Every new song translated is one request the user may pay for, on their own
// AI provider. This module is where that spending is kept small and visible:
//   • a song is paid once: the answer (including "already in your language")
//     is kept in DATA_DIR/lyrics-translations.json;
//   • a failure is remembered for 10 minutes, so a broken reply is not re-bought
//     on every retry;
//   • one request per song at a time, however many screens ask;
//   • a monthly cap of songs, counted with the tokens the provider reported, in
//     DATA_DIR/lyrics-translate-usage.json, shown to the user in the widget.
// The caller (server.js) supplies `complete({ system, user, maxTokens })` →
// `{ text, tokens, input?, output? }` for whichever provider is configured.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');
const { createJsonLru } = require('./json-lru.js');
const T = require('./lyrics-translate.js');
const { isSurelyLang, surelyOtherLang } = require('./lyrics-language.js');
const { estimate } = require('./lyrics-translate-price.js');

const CACHE_FILE = 'lyrics-translations.json';
const USAGE_FILE = 'lyrics-translate-usage.json';
const MAX_ENTRIES = 500;
const FAIL_TTL_MS = 10 * 60 * 1000;
const CAP_CHOICES = Object.freeze([50, 200, 500]);
const DEFAULT_CAP = 200;
const MAX_LINES = 2000;

function cleanCap(value) {
  const n = Number(value);
  return CAP_CHOICES.includes(n) ? n : DEFAULT_CAP;
}

function monthOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function cleanStrings(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_LINES).map(s => (typeof s === 'string' ? s.slice(0, T.MAX_OUT_CHARS) : ''));
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.failed === true) {
    const until = Number(raw.until);
    return Number.isFinite(until) ? { failed: true, until } : null;
  }
  const tr = cleanStrings(raw.tr);
  const read = cleanStrings(raw.read);
  if (!tr || !read) return null;
  return { same: raw.same === true, tr, read };
}

// `onError(err)` hears why a request failed, so the server can say it in its
// log: a failure is remembered for 10 minutes and must never be silent.
function createLyricsTranslator({ dataDir, complete, now = Date.now, writeFile = writeFileAtomic, debounceMs, onError } = {}) {
  const cache = createJsonLru({
    dataDir, fileName: CACHE_FILE, maxEntries: MAX_ENTRIES, normalize: normalizeEntry,
    durable: (e) => !e.failed, expired: (e, t) => e.failed === true && t >= e.until,
    now, writeFile, debounceMs,
  });
  const usageFile = dataDir ? path.join(dataDir, USAGE_FILE) : '';
  const pending = new Map();
  let usage = null;

  async function loadUsage() {
    if (usage) return usage;
    let raw = null;
    if (usageFile) {
      try { raw = JSON.parse(await fsp.readFile(usageFile, 'utf8')); } catch { /* absent: a fresh month */ }
    }
    const int = (k) => (raw && Number.isSafeInteger(raw[k]) && raw[k] >= 0 ? raw[k] : 0);
    usage = {
      month: raw && typeof raw.month === 'string' ? raw.month.slice(0, 7) : monthOf(now()),
      songs: int('songs'),
      tokens: int('tokens'),
      // Songs whose reply split its tokens into sent and received, which is
      // what the cost estimate is worked out from.
      priced: int('priced'),
      inTokens: int('inTokens'),
      outTokens: int('outTokens'),
    };
    return usage;
  }

  async function currentUsage() {
    const u = await loadUsage();
    const month = monthOf(now());
    if (u.month !== month) Object.assign(u, { month, songs: 0, tokens: 0, priced: 0, inTokens: 0, outTokens: 0 });
    return u;
  }

  const positive = (n) => Number.isSafeInteger(n) && n > 0;

  async function count(tokens, input, output) {
    const u = await currentUsage();
    u.songs += 1;
    if (positive(tokens)) u.tokens += tokens;
    if (positive(input) && positive(output)) { u.priced += 1; u.inTokens += input; u.outTokens += output; }
    if (!usageFile) return;
    try { await writeFile(usageFile, JSON.stringify(u)); }
    catch { /* best effort: the count in memory still holds the cap this run */ }
  }

  function reply(entry, index) {
    return { ok: true, same: entry.same, tr: T.expand(index, entry.tr), read: T.expand(index, entry.read) };
  }

  // `texts` are the song's lines as stored by the lyrics cache (never sent by a
  // client). `cachedOnly` answers from the cache and never spends.
  async function translate({ songKey, texts, lang, reading, cap, cachedOnly }) {
    if (!T.langName(lang)) return { ok: false, error: 'bad_lang' };
    const { unique, index } = T.uniqueLines(texts);
    const wantReading = reading !== false && T.needsReading(unique);
    // Already in the user's language, and surely so: nothing to translate and no
    // reading to make, so no request, no count against the cap, and it answers a
    // cachedOnly ask too. Any doubt falls through to the model (lyrics-language.js).
    if (!wantReading && isSurelyLang(unique, lang)) return { ok: true, same: true, tr: [], read: [] };
    if (!T.fitsBudget(unique)) return { ok: false, error: 'too_long' };
    const key = `${songKey}|${lang}|${wantReading ? 'r' : ''}`;
    // A song surely in another language is never "already in your language", so
    // a model's wrong "same" is neither believed nor served from the cache.
    const sung = surelyOtherLang(unique, lang);
    const cached = await cache.get(key);
    if (cached && cached.failed) return { ok: false, error: 'failed', retryAt: cached.until };
    if (cached && !(cached.same && sung)) return reply(cached, index);
    if (cachedOnly) return { ok: false, error: 'not_cached' };
    const u = await currentUsage();
    if (u.songs >= cleanCap(cap)) return { ok: false, error: 'cap' };
    if (!pending.has(key)) {
      const job = request(key, unique, lang, wantReading, sung).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    const entry = await pending.get(key);
    if (entry.noCredits) return { ok: false, error: 'no_credits' };
    return entry.failed ? { ok: false, error: 'failed', retryAt: entry.until } : reply(entry, index);
  }

  async function request(key, unique, lang, wantReading, sung) {
    const { system, user } = T.buildPrompt(unique, lang, wantReading, sung);
    let out = null;
    let tokens = 0;
    let res = null;
    try {
      res = await complete({ system, user, maxTokens: T.maxTokensFor(unique.length, wantReading) });
      tokens = res && Number.isSafeInteger(res.tokens) ? res.tokens : 0;
      out = T.parseReply(res && res.text, unique.length, wantReading, lang);
      if (out && out.same && sung) { out = null; if (onError) onError(new Error(`the model called a ${sung} song already in the user's language`)); }
      else if (!out && onError) onError(new Error('the reply could not be used'));
    } catch (e) {
      // Bit on Sparks with an empty balance: the hub charged nothing and the song
      // is fine, so it is neither counted nor remembered as failed. It is asked
      // again as soon as there are Sparks.
      if (e && e.code === 'no_credits') return { noCredits: true };
      out = null;
      if (onError) onError(e);
    }
    // A request that reached the provider counts against the month even when
    // its reply was unusable: the user was billed for it either way.
    if (out || tokens) await count(tokens, res && res.input, res && res.output);
    const entry = out
      ? { same: out.same, tr: out.tr, read: out.read }
      : { failed: true, until: now() + FAIL_TTL_MS };
    await cache.set(key, entry);
    return entry;
  }

  // `model` is the one translation runs on now: the estimate prices it.
  async function usageReport(cap, model) {
    const u = await currentUsage();
    return { month: u.month, songs: u.songs, tokens: u.tokens, cap: cleanCap(cap), model: model || '', estimate: estimate(model, u) };
  }

  return { translate, usage: usageReport, flush: cache.flush, stop: cache.stop };
}

module.exports = { createLyricsTranslator, cleanCap, CAP_CHOICES, DEFAULT_CAP, FAIL_TTL_MS };
