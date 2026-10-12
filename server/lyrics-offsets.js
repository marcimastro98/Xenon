'use strict';

// ── Per-song lyrics timing ───────────────────────────────────────────────────
// The supporter Lyrics widget can nudge ONE song's lines earlier or later (a
// live recording, an intro the lyrics file does not have). The nudge is kept per
// lyrics.trackKey() in DATA_DIR/lyrics-offsets.json, so the song is right again
// the next time it plays. The client adds it to the global lyricsOffsetMs (the
// player's own delay). 0 is not stored: it means "no nudge for this song".

const { createJsonLru } = require('./json-lru.js');

const FILE = 'lyrics-offsets.json';
const MAX_ENTRIES = 2000;
const LIMIT_MS = 3000;
const STEP_MS = 100;

// A request value to a stored step: whole 100 ms steps inside ±3 s, or null.
function cleanOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.max(-LIMIT_MS, Math.min(LIMIT_MS, n)) / STEP_MS) * STEP_MS;
}

function normalize(raw) {
  const ms = raw && cleanOffset(raw.ms);
  return ms ? { ms } : null;
}

function createLyricsOffsets({ dataDir, writeFile, debounceMs } = {}) {
  const store = createJsonLru({ dataDir, fileName: FILE, maxEntries: MAX_ENTRIES, normalize, writeFile, debounceMs });

  async function get(key) {
    const entry = await store.get(key);
    return entry ? entry.ms : null;
  }

  async function set(key, ms) {
    const clean = cleanOffset(ms);
    if (clean === null) return null;
    if (clean === 0) await store.remove(key);
    else await store.set(key, { ms: clean });
    return clean;
  }

  return { get, set, flush: store.flush, stop: store.stop };
}

module.exports = { createLyricsOffsets, cleanOffset, LIMIT_MS, STEP_MS };
