'use strict';

// ── Shared atomic-write primitive for every durable store ────────────────────
// Durable stores (settings/deck/tasks/timers/events/notes/tokens/AI memory/
// guardian history) are written with a temp-file + atomic rename so a crash
// mid-write can never leave a truncated file behind. A plain in-place writeFile
// truncates first, and the next boot's JSON.parse then throws — for the stores
// whose loaders reset to an empty default on parse failure that silently wipes
// the user's data (the documented cause of past notes/deck data loss).
//
// Guarantees, in order:
//  1. Visibility atomicity — `rename` on the same volume is atomic, so a reader
//     only ever sees the old or the new file, never a partial one.
//  2. Durability — the temp file is fsync'd BEFORE the rename, so a power loss
//     right after the rename can't surface a zero-length file on filesystems
//     that reorder metadata vs data. Rename alone does not give this.
//  3. Serialization — a per-path promise chain serializes concurrent writers
//     (last write still wins, but no interleaving, and the shared `.pid.tmp`
//     name can never collide with itself).
//
// `updateFileAtomic` extends the same per-path chain to read-modify-write
// cycles: the read happens INSIDE the chain, so two concurrent updaters of the
// same file can never lose each other's changes (e.g. two OAuth providers
// refreshing tokens in the same store at the same moment).

const fs = require('fs');

const _chains = new Map();

async function _writeTmpAndRename(file, data, encoding) {
  const tmp = `${file}.${process.pid}.tmp`;
  let fh = null;
  try {
    fh = await fs.promises.open(tmp, 'w');
    await fh.writeFile(data, encoding);   // encoding is ignored for Buffers
    await fh.sync();
    await fh.close();
    fh = null;
    await fs.promises.rename(tmp, file);
  } catch (e) {
    if (fh) { try { await fh.close(); } catch { /* already closing */ } }
    try { await fs.promises.unlink(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

function _enqueue(file, run) {
  const prev = _chains.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  _chains.set(file, next);
  return next.finally(() => {
    if (_chains.get(file) === next) _chains.delete(file);
  });
}

// Atomically replace `file` with `data`. Concurrent writers to the same path
// are serialized; every caller awaits a real settled result.
function writeFileAtomic(file, data, encoding = 'utf8') {
  return _enqueue(file, () => _writeTmpAndRename(file, data, encoding));
}

// Atomic read-modify-write: `update(currentContent)` runs inside the per-path
// chain (currentContent is null when the file is missing/unreadable) and
// returns the new content, or null/undefined to leave the file untouched.
// Resolves with whatever `update` returned.
function updateFileAtomic(file, update, encoding = 'utf8') {
  return _enqueue(file, async () => {
    let current = null;
    try { current = await fs.promises.readFile(file, encoding); }
    catch { current = null; }
    const next = await update(current);
    if (next != null) await _writeTmpAndRename(file, next, encoding);
    return next;
  });
}

module.exports = { writeFileAtomic, updateFileAtomic };
