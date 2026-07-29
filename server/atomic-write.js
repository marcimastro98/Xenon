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

// Windows keeps a short-lived handle on a file whenever ANOTHER process has it
// open without FILE_SHARE_DELETE — an antivirus/Defender scan of the freshly
// written data, the Search indexer, or simply a concurrent reader of the SAME
// store mid-write (GET /settings and the SSE broadcasters read settings.json
// outside the write lock, and a second app instance reads it on its own timers).
// While such a handle is open, renaming the temp file over the destination
// fails with EPERM/EACCES/EBUSY even though the write itself is fine — the
// handle closes microseconds later. POSIX rename has no such contention, so a
// single un-retried rename silently failed only on Windows: the documented cause
// of "settings never persist" when a stale second server held the file open
// (every POST /settings 500'd on the rename). Retry the rename a handful of
// times with escalating backoff before giving up — the same remedy write-file-
// atomic applies on Windows.
const _RENAME_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const _RENAME_MAX_RETRIES = 10;

async function _renameWithRetry(tmp, file) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (e) {
      if (attempt >= _RENAME_MAX_RETRIES || !_RENAME_LOCK_CODES.has(e.code)) throw e;
      // 15ms, 30, 45 … capped at 200ms; ~1.2s of retries worst case, which
      // comfortably outlasts a transient scan/read handle without stalling saves.
      await new Promise((r) => setTimeout(r, Math.min(200, 15 * (attempt + 1))));
    }
  }
}

async function _writeTmpAndRename(file, data, encoding) {
  const tmp = `${file}.${process.pid}.tmp`;
  let fh = null;
  try {
    fh = await fs.promises.open(tmp, 'w');
    await fh.writeFile(data, encoding);   // encoding is ignored for Buffers
    await fh.sync();
    await fh.close();
    fh = null;
    await _renameWithRetry(tmp, file);
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

// Streaming twin of writeFileAtomic, for a payload too large to hold in memory
// (a phone sending a 2 GB video: buffering it would be 2 GB of RSS). Same first
// two guarantees — visibility via rename, durability via fsync BEFORE the
// rename — and the same _renameWithRetry, because the Windows contention that
// helper exists for does not care how the bytes got there.
//
// Deliberately NOT enqueued on the per-path chain, which is the third
// guarantee and the one that does not apply: the destination name is unique per
// call (the caller mints an id), so there is no concurrent writer to serialize,
// and holding the chain for the minutes a large upload takes would stall every
// other store writing through this module.
//
// The temp name is `<file>.part` rather than the `.<pid>.tmp` above, and that
// is load-bearing: a `.part` left by a crash has to be recognisable to a
// sweeper that does not know which process wrote it. `wx` (create-exclusive) so
// a duplicated id can never silently append to someone else's temp file.
//
// The caller MUST end with commit() or abort(); neither is implicit, because
// the stream finishing is not the same as the write being good (a truncated
// upload also ends the stream).
async function openAtomicWriteStream(file) {
  const tmp = `${file}.part`;
  // A PATH-based stream that owns and closes its own descriptor, rather than
  // FileHandle.createWriteStream({autoClose:false}). The handle-based shape is
  // the obvious one — hold the handle, fsync it after the stream ends — and it
  // deadlocks: with autoClose:false, `fh.close()` never resolves once the
  // stream has attached to it, so commit() hung forever and every upload would
  // have stalled at 100%. Verified in isolation; the tests below pin it.
  //
  // So the fsync reopens the temp file instead. One extra open per transfer,
  // and the guarantee is unchanged: the data is on the platter before the
  // rename makes it visible.
  const stream = fs.createWriteStream(tmp, { flags: 'wx' });
  let settled = false;

  // createWriteStream opens lazily, so without this the temp file does not
  // exist yet when we hand the stream back — and, worse, a refusal from the
  // exclusive 'wx' open would arrive as an async stream error in the middle of
  // the caller's pipeline instead of as a rejection from this function, where
  // it can still be answered with a clean status.
  await new Promise((resolve, reject) => {
    const ok = () => { stream.off('error', bad); resolve(); };
    const bad = (e) => { stream.off('ready', ok); reject(e); };
    stream.once('ready', ok);
    stream.once('error', bad);
  });

  // Wait for the descriptor to actually be gone, not merely for the stream to
  // be marked destroyed. Windows refuses to unlink a file that still has an
  // open handle, so an abort that raced the close left the `.part` behind for
  // the boot sweep to find — which is exactly the litter this helper exists to
  // prevent. `closed` is set only after the 'close' event.
  function onceClosed() {
    if (stream.closed) return Promise.resolve();
    return new Promise((resolve) => stream.once('close', resolve));
  }

  async function commit() {
    if (settled) return;
    settled = true;
    let fh = null;
    try {
      if (!stream.writableEnded) stream.end();
      await onceClosed();
      fh = await fs.promises.open(tmp, 'r+');
      await fh.sync();
      await fh.close();
      fh = null;
      await _renameWithRetry(tmp, file);
    } catch (e) {
      if (fh) { try { await fh.close(); } catch { /* already closing */ } }
      try { await fs.promises.unlink(tmp); } catch { /* nothing to clean up */ }
      throw e;
    }
  }

  async function abort() {
    if (settled) return;
    settled = true;
    // Destroying a stream with writes still in flight makes those writes fail
    // with ERR_STREAM_DESTROYED. That is the ordinary shape of an interrupted
    // upload, and an unhandled 'error' on a stream takes the whole process
    // down, so it is absorbed here rather than left to whoever happens to be
    // listening at the time.
    stream.on('error', () => {});
    try { stream.destroy(); } catch { /* already torn down by pipeline */ }
    await onceClosed();
    try { await fs.promises.unlink(tmp); } catch { /* never created, or already gone */ }
  }

  return { stream, tmp, commit, abort };
}

module.exports = { writeFileAtomic, updateFileAtomic, openAtomicWriteStream };
