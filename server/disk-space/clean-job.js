'use strict';
// One cleanup as it runs: each item checked again and put in the bin a batch at a time, a
// folder in use opened up, the progress told as it goes, and the helper call behind every
// delete.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {
  DELETE_BATCH_MAX, SHELL_DELETE_TIMEOUT_MS, IN_USE_RCS, DESCEND_MAX_DEPTH,
} = require('./limits.js');

function makeCleanJob({
  helperExe, shellDeleteRunner, onCleanProgress, probeFlags, remainingBytes, guardDelete,
  persistSummary, cleanJob, liveDeleteProcs, overviews,
}) {
  function cleanSnapshot() {
    if (cleanJob.phase === 'idle') return null;
    return {
      id: cleanJob.id, running: cleanJob.running, cat: cleanJob.cat, root: cleanJob.root,
      total: cleanJob.total, totalBytes: cleanJob.totalBytes,
      processed: cleanJob.processed, deleted: cleanJob.deleted,
      freedBytes: cleanJob.freed, refusedCount: cleanJob.refusedCount,
      phase: cleanJob.phase, permanent: cleanJob.permanent, cancelled: cleanJob.cancelled,
      startedAt: cleanJob.startedAt, doneAt: cleanJob.doneAt,
      report: cleanJob.report,
    };
  }
  function emitClean() { try { onCleanProgress(cleanSnapshot()); } catch { /* never break a delete */ } }

  // The actual deletion loop, off the request path. Streams progress and always
  // settles cleanJob (running:false, a report) exactly once.
  async function runCleanJob({ id, approved, refused, c, overviewKey, gctx }) {
    // One locked cache file must not make a large cleanup look like a total
    // failure after Windows already recycled everything else. Small batches
    // isolate failures; a failed batch is split until the stubborn path is
    // identified. The live filesystem remains the final source of truth.
    const attempted = new Set();
    const shellFailed = [];
    // Top-level items we had to open up because something inside was in use.
    const descended = new Set();

    // Recycling a folder is ONE rename, so one file held open by a running
    // program (an npm debug log, uv's .lock) refuses the entire folder — the
    // empirically-proven "2 GB cache never moves" case. When Windows answers
    // with an in-use code for a single directory, open it up and recycle its
    // children individually: everything movable moves, and only the locked
    // subtree stays behind. Every child is re-checked against the guard —
    // descending must never reach further than the approved item could.
    async function descendInto(dirPath, depth) {
      if (cleanJob.cancelled || depth > DESCEND_MAX_DEPTH) return;
      let entries;
      try { entries = await fs.promises.readdir(dirPath, { withFileTypes: true }); } catch { return; }
      const files = [];
      const dirs = [];
      for (const e of entries) {
        const p = path.join(dirPath, e.name);
        const flags = await probeFlags(p);
        if (!flags.exists) continue;
        if (guardDelete(p, gctx, flags).ok !== true) continue;   // silently keep what the guard protects
        if (flags.isDir) dirs.push(p); else files.push(p);
      }
      // Files in one call; on refusal isolate per file like the main loop.
      for (let i = 0; i < files.length && !cleanJob.cancelled; i += DELETE_BATCH_MAX) {
        const batch = files.slice(i, i + DELETE_BATCH_MAX);
        const res = await runShellDelete({ paths: batch });
        if (!res.ok || res.aborted === true) {
          for (const p of batch) {
            const r1 = await runShellDelete({ paths: [p] });
            if (!r1.ok || r1.aborted === true) {
              shellFailed.push({ path: p, reason: (IN_USE_RCS.has(r1.rc) || r1.aborted === true) ? 'in_use' : 'shell_refused' });
            }
          }
        }
      }
      // Directories one by one; any refusal recurses a level deeper until the
      // depth bound, so the locked leaf is isolated as precisely as possible.
      for (const p of dirs) {
        if (cleanJob.cancelled) return;
        const res = await runShellDelete({ paths: [p] });
        if (res.ok && res.aborted !== true) continue;
        if (depth < DESCEND_MAX_DEPTH) await descendInto(p, depth + 1);
        else {
          const inUse = IN_USE_RCS.has(res.rc) || res.aborted === true;
          shellFailed.push({ path: p, reason: inUse ? 'in_use' : 'shell_refused' });
        }
      }
    }

    async function deleteBatch(items) {
      if (cleanJob.cancelled) return;
      const pending = [];
      for (const it of items) {
        // Re-probe AND re-guard LIVE at the batch boundary — not just for
        // existence. The up-front guard in clean() ran moments ago; between
        // then and now the path could have been swapped to a junction/symlink,
        // and recycling a reparse point must never become a delete of its
        // target. Mirrors descendInto's per-child check so a top-level item is
        // held to the same live test as a descended one. A vanished item counts
        // as attempted (verified gone below); a now-refused one is reported, not
        // deleted.
        const flags = await probeFlags(it.p);
        if (!flags.exists) { attempted.add(it); continue; }
        if (guardDelete(it.p, gctx, flags).ok !== true) {
          shellFailed.push({ path: it.p, reason: 'guard_refused' });
          continue;
        }
        pending.push(it);
      }
      if (!pending.length) return;
      const res = await runShellDelete({ paths: pending.map((it) => it.p) });
      pending.forEach((it) => attempted.add(it));
      if (res.ok) return;
      if (pending.length === 1) {
        const it = pending[0];
        // A refused DIRECTORY is always opened up, whatever the code: the
        // shell answers in-use (5/32/120), rc 0 + aborted (FOF_NOERRORUI turns
        // the error dialog into a silent cancel), or 124 DE_INVALIDFILES for a
        // tree holding hardlinks whose target is loaded by a running process
        // (uv's archive cache, empirically). Descending isolates the exact
        // locked leaf and moves everything else; the guard re-checks every
        // child, so this never reaches further than the approved item could.
        if (it.kind === 'dir') {
          descended.add(it);
          await descendInto(it.p, 0);
        } else {
          const inUse = IN_USE_RCS.has(res.rc) || res.aborted === true;
          shellFailed.push({ path: it.p, reason: inUse ? 'in_use' : 'shell_refused' });
        }
        return;
      }
      const mid = Math.ceil(pending.length / 2);
      await deleteBatch(pending.slice(0, mid));
      await deleteBatch(pending.slice(mid));
    }

    try {
      for (let i = 0; i < approved.length; i += DELETE_BATCH_MAX) {
        if (cleanJob.cancelled) break;
        const batch = approved.slice(i, i + DELETE_BATCH_MAX);
        await deleteBatch(batch);
        // Progress is measured on what has been ATTEMPTED (moved or proven
        // stubborn), not on batch index, so a re-split batch still counts once.
        cleanJob.processed = Math.min(attempted.size, approved.length);
        emitClean();
      }

      // Verify what is actually gone and report partial success honestly. A
      // descended container that still exists is measured: what it lost is
      // freed space, what it kept is reported as in use.
      let deleted = 0, freed = 0;
      const gone = new Set();
      const remaining = [];
      for (const it of attempted) {
        try { await fs.promises.lstat(it.p); }
        catch { deleted++; freed += it.s; gone.add(it); }
        if (gone.has(it)) continue;
        if (descended.has(it)) {
          const left = await remainingBytes(it.p);
          const clearedHere = left == null ? 0 : Math.max(0, (it.s || 0) - left);
          if (clearedHere > 0) {
            freed += clearedHere;
            remaining.push({ path: it.p, reason: 'partly_in_use', freedBytes: clearedHere });
            continue;
          }
        }
        remaining.push({ path: it.p, reason: 'still_present' });
      }
      // Order matters for the per-path dedup below (the Map keeps the LAST
      // entry): specific reasons (in_use, partly_in_use, shell_refused) must
      // win over the generic still_present, so `remaining` goes first.
      const allRefused = [...refused, ...remaining, ...shellFailed];
      // A cancelled run reports the not-yet-attempted items as such, so the
      // count the user sees adds up to the whole selection.
      if (cleanJob.cancelled) {
        for (const it of approved) {
          if (!attempted.has(it)) allRefused.push({ path: it.p, reason: 'cancelled' });
        }
      }
      const uniqueRefused = [...new Map(allRefused.map((entry) => {
        const key = entry.path ? 'path:' + String(entry.path).toLowerCase() : 'id:' + String(entry.id);
        return [key, entry];
      })).values()];

      cleanJob.deleted = deleted;
      cleanJob.freed = freed;
      cleanJob.refusedCount = uniqueRefused.length;

      // Success = bytes actually left the drive, whether items vanished whole
      // or a container was cleared around a locked file (deleted 0, freed 2 GB
      // is a SUCCESS the old `if (deleted)` gate reported as total failure).
      if (freed > 0) {
        // Drop the deleted items so a second click can't re-address them, and
        // subtract only what this run verified as gone (bytes/count describe
        // the whole category, the in-memory item list is capped).
        c.items = c.items.filter((it) => !gone.has(it));
        c.bytes = Math.max(0, c.bytes - freed);
        c.count = Math.max(0, c.count - deleted);
        if (overviewKey) overviews.delete(overviewKey);
        else await persistSummary();
      }

      cleanJob.report = freed > 0
        ? {
            ok: true, deleted, attempted: attempted.size, freedBytes: freed,
            toRecycleBin: true, partial: uniqueRefused.length > 0,
            cancelled: cleanJob.cancelled, refused: uniqueRefused,
          }
        : {
            ok: false, error: cleanJob.cancelled ? 'cancelled' : 'delete_failed',
            deleted: 0, freedBytes: 0, cancelled: cleanJob.cancelled, refused: uniqueRefused,
          };
    } catch (e) {
      cleanJob.report = { ok: false, error: 'clean_failed', deleted: cleanJob.deleted, freedBytes: cleanJob.freed };
    } finally {
      // A stale progress event from a superseded run must never revive this.
      if (cleanJob.id === id) {
        cleanJob.running = false;
        cleanJob.phase = 'done';
        cleanJob.doneAt = Date.now();
        emitClean();
      }
    }
  }

  function cancelClean() {
    if (!cleanJob.running) return { ok: true, idle: true };
    cleanJob.cancelled = true;
    // The current shell-delete batch is allowed to finish (killing it mid-move
    // could orphan a half-done operation); the loop stops before the next one.
    emitClean();
    return { ok: true };
  }

  function runShellDelete(payload) {
    if (shellDeleteRunner) {
      return Promise.resolve().then(() => shellDeleteRunner(payload)).catch(() => ({ ok: false }));
    }
    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(helperExe, ['shell-delete'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
      } catch { resolve({ ok: false }); return; }
      // Tracked so _gracefulShutdown can wait a beat and then kill: a
      // shell-delete child has no job object, so process.exit would orphan it
      // (the bug that kept moving files after the server was killed).
      liveDeleteProcs.add(proc);
      let out = '';
      let settled = false;
      const done = (r) => { if (!settled) { settled = true; liveDeleteProcs.delete(proc); resolve(r); } };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (ch) => { out += ch; });
      const timer = setTimeout(() => { try { proc.kill(); } catch {} done({ ok: false }); }, SHELL_DELETE_TIMEOUT_MS);
      proc.on('exit', () => {
        clearTimeout(timer);
        try { done(JSON.parse(out.trim() || '{}')); } catch { done({ ok: false }); }
      });
      proc.on('error', () => { clearTimeout(timer); done({ ok: false }); });
      // EPIPE on a child that died before reading the payload arrives as an
      // 'error' event on the stream, not as a throw from write() — unhandled,
      // it takes the whole server down. The exit handler already settles this
      // call, so there is nothing to do but not crash.
      proc.stdin.on('error', () => {});
      try {
        proc.stdin.write(JSON.stringify(payload) + '\n');
        proc.stdin.end();
      } catch { /* exit handler resolves */ }
    });
  }

  return { cleanSnapshot, emitClean, runCleanJob, cancelClean, runShellDelete };
}

module.exports = { makeCleanJob };
