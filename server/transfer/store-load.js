'use strict';
// The transfer store read at start: the manifest checked record by record against the files
// that are really there, so a crash leaves a missing file and never one nobody can see or
// delete.

const fsp = require('node:fs/promises');
const path = require('node:path');

function makeLoad({ dir, filesDir, indexFile, shelf, normalizeRecord, persist }) {
  /**
   * Load the manifest and reconcile it against the directory in BOTH
   * directions: a record whose blob is gone is dropped, a blob no record knows
   * about is deleted, and every `.part` is swept (an in-flight upload cannot
   * survive a restart by definition). Called once at boot so `begin()` can stay
   * synchronous and the pipe can be attached in the tick the route is entered.
   */
  async function init() {
    if (!dir) { shelf.loaded = true; return; }
    await fsp.mkdir(filesDir, { recursive: true }).catch(() => {});
    let parsed = null;
    try { parsed = JSON.parse(await fsp.readFile(indexFile, 'utf8')); } catch { parsed = null; }
    const wanted = [];
    for (const raw of (parsed && Array.isArray(parsed.records)) ? parsed.records : []) {
      const rec = normalizeRecord(raw);
      if (rec && !wanted.some((r) => r.id === rec.id)) wanted.push(rec);
    }

    // A directory we could not READ is not an empty directory, and the whole
    // reconciliation below rests on that difference. This used to swallow the
    // error into `names = []`, which then meant "every blob is gone" — so every
    // record was dropped as a lie and the emptied manifest was written back over
    // the good one. One unreadable moment at boot (antivirus holding the folder,
    // a roaming/OneDrive-backed %LOCALAPPDATA% not yet materialised, a
    // half-mounted profile) permanently destroyed the list while the files
    // themselves were still sitting there, and the dashboard went on showing the
    // old list until the next request made the server answer with nothing.
    //
    // Reported as "if I delete one photo they all get deleted and there is no
    // way back": the delete was not the cause, it was the first request that
    // asked the server and got the truth.
    //
    // So: when the directory cannot be listed we keep every record, reconcile
    // nothing, and persist nothing. The records may be wrong, and a wrong record
    // is recoverable — a deleted one is not.
    let names = null;
    try { names = await fsp.readdir(filesDir); } catch { names = null; }
    if (names === null) {
      shelf.records = wanted;
      shelf.records.sort((a, b) => b.at - a.at);
      shelf.usedBytes = shelf.records.reduce((n, r) => n + (Number(r.size) || 0), 0);
      shelf.loaded = true;
      return;                                          // nothing verified, nothing written
    }
    const onDisk = new Set();
    for (const n of names) {
      if (n.endsWith('.part')) {
        await fsp.unlink(path.join(filesDir, n)).catch(() => {});
        continue;
      }
      onDisk.add(n);
    }

    shelf.records = [];
    shelf.usedBytes = 0;
    for (const rec of wanted) {
      if (!onDisk.has(rec.file)) continue;             // blob gone: the record is a lie
      onDisk.delete(rec.file);
      // The blob is there (readdir just said so), so a stat that fails is the
      // filesystem being momentarily unhelpful, not a missing file. Keep the
      // record with the size it was stored with rather than dropping it — the
      // same rule as above, one file down.
      try {
        const st = await fsp.stat(path.join(filesDir, rec.file));
        rec.size = st.size;                            // the file is the authority, not the record
      } catch { /* keep rec.size */ }
      shelf.records.push(rec);
      shelf.usedBytes += rec.size;
    }
    for (const orphan of onDisk) {
      await fsp.unlink(path.join(filesDir, orphan)).catch(() => {});
    }
    shelf.records.sort((a, b) => b.at - a.at);
    shelf.loaded = true;
    if (wanted.length !== shelf.records.length) await persist();
  }

  return { init };
}

module.exports = { makeLoad };
