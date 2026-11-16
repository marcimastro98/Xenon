'use strict';

// ── Bounded JSON LRU on disk ─────────────────────────────────────────────────
// A Map capped at `maxEntries` (least recently used dropped first) that survives
// a restart in DATA_DIR/<fileName>. The lyrics stores (found lyrics, per-song
// timing, translations) are all this shape; each brings its own `normalize`.
//
// `normalize(raw)` rebuilds one entry from known fields (never a spread of what
// was read) or returns null. `durable(entry)` says whether it reaches disk;
// `expired(entry, now)` drops it on read and on load. The file is re-validated
// entry by entry on load and written atomically behind a short debounce.

const fsp = require('fs').promises;
const path = require('path');
const { writeFileAtomic } = require('./atomic-write.js');

const MAX_KEY_CHARS = 600;
const WRITE_DEBOUNCE_MS = 5000;

function createJsonLru({
  dataDir, fileName, maxEntries, normalize,
  durable = () => true, expired = () => false,
  now = Date.now, writeFile = writeFileAtomic, debounceMs = WRITE_DEBOUNCE_MS,
}) {
  const file = dataDir ? path.join(dataDir, fileName) : '';
  const map = new Map();
  let loading = null;
  let timer = null;

  function load() {
    if (loading) return loading;
    loading = (async () => {
      if (!file) return;
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
        const rows = raw && Array.isArray(raw.entries) ? raw.entries.slice(-maxEntries) : [];
        for (const row of rows) {
          if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0] || row[0].length > MAX_KEY_CHARS) continue;
          const entry = normalize(row[1]);
          if (entry && durable(entry) && !expired(entry, now())) map.set(row[0], entry);
        }
      } catch { /* absent or corrupt: start empty, use refills it */ }
    })();
    return loading;
  }

  function persistSoon() {
    if (!file || timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, debounceMs);
    if (timer.unref) timer.unref();
  }

  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!file) return;
    const entries = [];
    for (const [k, v] of map) if (durable(v)) entries.push([k, v]);
    try { await writeFile(file, JSON.stringify({ entries })); }
    catch { /* best effort: the memory copy still serves this run */ }
  }

  async function get(key) {
    await load();
    const entry = map.get(key);
    if (!entry) return null;
    if (expired(entry, now())) { map.delete(key); return null; }
    map.delete(key);           // LRU: most recently used goes last
    map.set(key, entry);
    return entry;
  }

  async function set(key, raw) {
    if (typeof key !== 'string' || !key || key.length > MAX_KEY_CHARS) return;
    await load();
    const entry = normalize(raw);
    if (!entry) return;
    map.delete(key);
    map.set(key, entry);
    while (map.size > maxEntries) map.delete(map.keys().next().value);
    if (durable(entry)) persistSoon();
  }

  async function remove(key) {
    await load();
    if (map.delete(key)) persistSoon();
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return { get, set, remove, flush, stop };
}

module.exports = { createJsonLru, MAX_KEY_CHARS };
