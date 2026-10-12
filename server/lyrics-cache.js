'use strict';

// ── Lyrics cache ─────────────────────────────────────────────────────────────
// Bounded LRU of LRCLIB answers, keyed by lyrics.trackKey(). Found lyrics and
// "nothing found" survive a restart in DATA_DIR/lyrics-cache.json, so a song
// played again is instant, works offline and never re-asks LRCLIB. Transient
// outcomes (busy, error) stay in memory for a short while only, so a network
// blip is retried soon and is never written to disk.
//
// Storage, re-validation on load and the atomic, debounced write are json-lru.js.

const { createJsonLru } = require('./json-lru.js');

const FILE = 'lyrics-cache.json';
const MAX_ENTRIES = 300;
const MAX_LINES = 2000;
const MAX_LINE_CHARS = 300;
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // none / instrumental: LRCLIB grows
const TRANSIENT_TTL_MS = 2 * 60 * 1000;        // busy / error: retry soon

const DURABLE = new Set(['synced', 'plain', 'instrumental', 'none']);
const TRANSIENT = new Set(['busy', 'error']);

function cleanLines(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  for (const l of value.slice(0, MAX_LINES)) {
    if (!l || !Number.isSafeInteger(l.t) || l.t < 0 || typeof l.text !== 'string') continue;
    out.push({ t: l.t, text: l.text.slice(0, MAX_LINE_CHARS) });
  }
  return out;
}

function cleanPlain(value) {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_LINES).filter(s => typeof s === 'string').map(s => s.slice(0, MAX_LINE_CHARS));
}

// One entry, rebuilt from known fields. Returns null when it is not usable.
function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !DURABLE.has(raw.state) && !TRANSIENT.has(raw.state)) return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const entry = { state: raw.state, at };
  if (Number.isSafeInteger(raw.matchId)) entry.matchId = raw.matchId;
  if (raw.state === 'synced') {
    const lines = cleanLines(raw.lines);
    if (!lines || !lines.length) return null;
    entry.lines = lines;
  } else if (raw.state === 'plain') {
    const plain = cleanPlain(raw.plain);
    if (!plain || !plain.length) return null;
    entry.plain = plain;
  } else if (TRANSIENT.has(raw.state) && Number.isFinite(raw.until)) {
    entry.until = raw.until;
  }
  return entry;
}

function expired(entry, now) {
  if (TRANSIENT.has(entry.state)) return now >= (entry.until || entry.at + TRANSIENT_TTL_MS);
  if (entry.state === 'none' || entry.state === 'instrumental') return now - entry.at >= MISS_TTL_MS;
  return false;
}

function createLyricsCache({ dataDir, now = Date.now, writeFile, debounceMs } = {}) {
  const store = createJsonLru({
    dataDir, fileName: FILE, maxEntries: MAX_ENTRIES, normalize: normalizeEntry,
    durable: (entry) => DURABLE.has(entry.state), expired,
    now, writeFile, debounceMs,
  });
  return {
    get: store.get,
    set: (key, result, opts = {}) => store.set(key, { ...result, at: now(), until: opts.until }),
    flush: store.flush,
    stop: store.stop,
  };
}

module.exports = { createLyricsCache, normalizeEntry, MAX_ENTRIES, MISS_TTL_MS, TRANSIENT_TTL_MS };
