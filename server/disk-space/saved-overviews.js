'use strict';
// The last overview of each drive and the drive's history, kept on disk: read once, written a
// little after they change, and shown marked as old while the index cannot answer yet.

const path = require('node:path');
const fs = require('node:fs');
const DiskHistory = require('../disk-history.js');
const { writeFileAtomic } = require('../atomic-write.js');

function makeSavedOverviews({ dataDir, cmpKey, SNAPSHOT_FILE, HISTORY_FILE, saved, resolveRoot }) {
  async function loadPersisted() {
    if (saved.snapshots && saved.history) return;
    saved.snapshots = new Map();
    saved.history = DiskHistory.normalize(null);
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(dataDir, SNAPSHOT_FILE), 'utf8'));
      if (raw && raw.v === 1 && raw.roots && typeof raw.roots === 'object') {
        for (const [k, v] of Object.entries(raw.roots)) {
          if (v && typeof v === 'object' && typeof v.root === 'string') saved.snapshots.set(k, v);
        }
      }
    } catch { /* absent or corrupt: nothing to show yet */ }
    try {
      saved.history = DiskHistory.normalize(JSON.parse(await fs.promises.readFile(path.join(dataDir, HISTORY_FILE), 'utf8')));
    } catch { /* absent or corrupt: history starts today */ }
  }

  function schedulePersist() {
    if (saved.persistTimer) return;
    saved.persistTimer = setTimeout(() => { saved.persistTimer = null; void persistNow(); }, 5000);
    if (saved.persistTimer.unref) saved.persistTimer.unref();
  }

  async function persistNow() {
    if (!saved.snapshots || !saved.history) return;
    const roots = {};
    for (const [k, v] of saved.snapshots) roots[k] = v;
    try { await writeFileAtomic(path.join(dataDir, SNAPSHOT_FILE), JSON.stringify({ v: 1, roots })); } catch { /* next build retries */ }
    try { await writeFileAtomic(path.join(dataDir, HISTORY_FILE), JSON.stringify(saved.history)); } catch { /* next build retries */ }
  }

  // The persisted copy: display data only. Category item lists and every id are
  // dropped — they belong to a live overview, and a snapshot must never be
  // something a cleanup or a drill-down can be aimed at.
  function snapshotOf(client) {
    return {
      root: client.root, total: client.total, files: client.files,
      volume: client.volume, index: client.index, generatedAt: client.generatedAt,
      kinds: client.kinds, insights: client.insights,
      tree: client.tree.map(({ p, s, n, m }) => ({ p, s, n, m })),
      topFiles: client.topFiles.slice(0, 50).map(({ p, n, s, m }) => ({ p, n, s, m })),
      staleFiles: (client.staleFiles || []).map(({ p, n, s, m }) => ({ p, n, s, m })),
      dupes: client.dupes.map(({ s, wasted, paths }) => ({ s, wasted, paths: paths.map((x) => x.p) })),
      categories: Object.fromEntries(Object.entries(client.categories).map(([cat, c]) => [cat, { bytes: c.bytes, count: c.count }])),
    };
  }

  // The last persisted overview of a root, marked stale, for the time the
  // index cannot answer yet. Read only.
  async function snapshot(rawIndex) {
    const root = await resolveRoot(rawIndex);
    if (!root) return { ok: false, error: 'bad_root' };
    await loadPersisted();
    const snap = saved.snapshots.get(cmpKey(root));
    if (!snap) return { ok: false, error: 'no_snapshot' };
    return { ok: true, stale: true, ...snap };
  }

  return { loadPersisted, schedulePersist, persistNow, snapshotOf, snapshot };
}

module.exports = { makeSavedOverviews };
