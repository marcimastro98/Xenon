'use strict';
// The sensor history's store: read from disk once and made safe, written whole, handed to and
// taken from a backup.

const fs = require('node:fs');
const { writeFileAtomic } = require('../atomic-write.js');
const Recent = require('./recent.js');
const { MAX_HOURS, MAX_DAYS } = require('./guardian-limits.js');
const { METRICS } = require('./guardian-metrics.js');

function makeStore({ FILE, state }) {
  function normalizeStore(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      hours: Array.isArray(src.hours) ? src.hours.slice(-MAX_HOURS) : [],
      days: Array.isArray(src.days) ? src.days.slice(-MAX_DAYS) : [],
      apps: normalizeApps(src.apps),
      recent: Recent.normalizeRecent(src.recent, METRICS),
    };
  }

  // Usage buckets are persisted data → rebuild from the known shape only (never
  // trust arbitrary keys/values), the same boundary discipline as the sensors.
  function normalizeApps(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const b of raw.slice(-MAX_DAYS)) {
      if (!b || typeof b !== 'object' || typeof b.d !== 'string' || !b.a || typeof b.a !== 'object') continue;
      const a = {};
      for (const name of Object.keys(b.a)) {
        const e = b.a[name];
        const s = e && typeof e.s === 'number' && Number.isFinite(e.s) && e.s > 0 ? e.s : 0;
        if (!s) continue;
        a[name] = { s, g: e && e.g ? 1 : 0 };
      }
      out.push({ d: b.d, a });
    }
    return out;
  }

  // The read that has not settled yet. start() asks for the store without waiting, so a second
  // caller can arrive while the file is still being read: it waits for the same read. Two reads
  // would each build a store, and the later would replace the one the first caller already changed.
  const reading = { now: null };

  async function load() {
    if (state.store) return state.store;
    if (!reading.now) reading.now = readOnce().finally(() => { reading.now = null; });
    return reading.now;
  }

  async function readOnce() {
    let fresh;
    try {
      fresh = normalizeStore(JSON.parse(await fs.promises.readFile(FILE, 'utf8')));
    } catch {
      fresh = { hours: [], days: [], apps: [], recent: [] };
    }
    // A backup restored while the file was being read is the newer store: what the file held before stays out.
    if (!state.store) state.store = fresh;
    return state.store;
  }

  // Atomic write (shared primitive): a crash mid-write must never truncate
  // the history store into a corrupt file that load() would reset to empty,
  // discarding weeks of collected data (the durable-store invariant).
  // Returns whether the write reached the disk so callers can retry later.
  async function persist() {
    if (!state.store) return false;
    try { await writeFileAtomic(FILE, JSON.stringify(state.store)); return true; }
    catch (e) { console.error('Guardian persist failed:', e.message); return false; }
  }

  // Backup bridge: the whole history store, already in its normalized shape.
  async function exportStore() {
    await load();
    return state.store;
  }

  // Wholesale replace from a backup bundle — same boundary normalization as
  // load(), then an immediate atomic flush. Unlike the sampler's best-effort
  // persist(), a failed write here THROWS so the backup import can honestly
  // report the section as failed instead of "restored" into RAM only.
  async function importStore(raw) {
    state.store = normalizeStore(raw);
    state.usageDirty = false;
    await writeFileAtomic(FILE, JSON.stringify(state.store));
    return { ok: true, hours: state.store.hours.length, days: state.store.days.length };
  }

  return { load, persist, exportStore, importStore };
}

module.exports = { makeStore };
