'use strict';
// A cleanup asked for: the items found again by their ids, each one passed by the guard, and
// the job started; and a folder emptied into the bin for the Deck.

const { CATEGORY_ITEMS_MAX } = require('./limits.js');

function makeClean({
  cmpKey, guardCtx, probeFlags, guardDelete, canRecycle, scan, cleanRuns, cleanJob, overviews,
  emitClean, runCleanJob, runShellDelete, resolveRoot,
}) {
  // ── clean (category + ids → guard → helper recycle delete) ───────────────
  // Two enumeration sources, one contract: with `body.root` (an index into the
  // configured roots) the ids resolve against that root's cached overview
  // (the Living-Index path); without it, against the legacy scan. Either way
  // no path ever comes from the wire and the guard re-checks everything.
  //
  // Runs as a background JOB: this returns as soon as the work is accepted, and
  // the actual deletion streams progress over SSE and lands in cleanJob.report.
  // Emptying the Recycle Bin is fast and stays synchronous.
  async function clean(body) {
    if (!canRecycle()) return { ok: false, error: 'helper_missing' };
    if (cleanJob.running) return { ok: false, error: 'busy' };
    const cat = String((body && body.category) || '');

    // Emptying the Recycle Bin is its own explicit, permanent action. It is a
    // real per-file deletion, so a large Bin takes minutes — it runs as the
    // same background job (permanent:true), not inside the HTTP response.
    if (cat === 'recycleBin') {
      const id = ++cleanRuns.jobSeq;
      const binKey = (body && body.root != null) ? String(await resolveRoot(body.root) || '').toLowerCase() : null;
      cleanJob.id = id;
      cleanJob.running = true;
      cleanJob.cat = cat;
      cleanJob.root = (body && body.root != null) ? body.root : null;
      cleanJob.total = 0;
      cleanJob.totalBytes = 0;
      cleanJob.processed = 0;
      cleanJob.deleted = 0;
      cleanJob.freed = 0;
      cleanJob.refusedCount = 0;
      cleanJob.phase = 'processing';
      cleanJob.permanent = true;
      cleanJob.cancelled = false;
      cleanJob.startedAt = Date.now();
      cleanJob.doneAt = 0;
      cleanJob.report = null;
      emitClean();
      (async () => {
        let report;
        try {
          const res = await runShellDelete({ emptyRecycleBin: true });
          report = res.ok ? { ok: true, emptied: true } : { ok: false, error: 'empty_failed' };
        } catch { report = { ok: false, error: 'empty_failed' }; }
        if (cleanJob.id === id) {
          if (report.ok && binKey) overviews.delete(binKey);
          cleanJob.report = report;
          cleanJob.running = false;
          cleanJob.phase = 'done';
          cleanJob.doneAt = Date.now();
          emitClean();
        }
      })();
      return { ok: true, started: true, id };
    }

    let c, sourceRoot, overviewKey = null;
    if (body && body.root != null) {
      const rootPath = await resolveRoot(body.root);
      if (!rootPath) return { ok: false, error: 'bad_root' };
      overviewKey = cmpKey(rootPath);
      const ov = overviews.get(overviewKey);
      if (!ov) return { ok: false, error: 'no_overview' };
      // A snapshot taken while the index was still walking the drive has
      // partial sizes and partial item lists — deleting against it acts on
      // wrong data (empirically: uv\cache listed at 291 MB of its real
      // 1.96 GB mid-build). Refuse; the widget re-offers when the map is real.
      if (ov.index && ov.index.building === true) return { ok: false, error: 'index_building' };
      c = ov.categories[cat];
      sourceRoot = rootPath;
    } else {
      if (scan.running) return { ok: false, error: 'scan_running' };
      c = scan.categories[cat];
      sourceRoot = scan.root;
    }
    if (!c) return { ok: false, error: 'unknown_category' };
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, CATEGORY_ITEMS_MAX) : [];
    if (!ids.length) return { ok: false, error: 'no_items' };

    // Resolve + guard the whole selection up front, so the job's `total` is the
    // number we will actually attempt (a refused-by-guard item never counts as
    // work to do). Resolve by stable id, never array position.
    const gctx = guardCtx(sourceRoot);
    const approved = [];
    const refused = [];
    const byId = new Map(c.items.map((it) => [it.i, it]));
    for (const rawId of ids) {
      const idx = Number(rawId);
      const item = Number.isInteger(idx) && idx >= 0 ? byId.get(idx) : null;
      if (!item) { refused.push({ id: rawId, reason: 'unknown_id' }); continue; }
      const flags = await probeFlags(item.p);
      const verdict = guardDelete(item.p, gctx, flags);
      if (verdict.ok) approved.push(item);
      else refused.push({ path: item.p, reason: verdict.reason });
    }
    if (!approved.length) return { ok: false, error: 'nothing_approved', refused };

    // Accept the job. Everything past here runs in the background; the HTTP
    // caller gets { ok, started, id } immediately.
    const id = ++cleanRuns.jobSeq;
    cleanJob.id = id;
    cleanJob.running = true;
    cleanJob.cat = cat;
    cleanJob.root = (body && body.root != null) ? body.root : null;
    cleanJob.total = approved.length;
    cleanJob.totalBytes = approved.reduce((sum, it) => sum + (it.s || 0), 0);
    cleanJob.processed = 0;
    cleanJob.deleted = 0;
    cleanJob.freed = 0;
    cleanJob.refusedCount = refused.length;
    cleanJob.phase = 'processing';
    cleanJob.permanent = false;
    cleanJob.cancelled = false;
    cleanJob.startedAt = Date.now();
    cleanJob.doneAt = 0;
    cleanJob.report = null;
    emitClean();

    runCleanJob({ id, approved, refused, c, overviewKey, gctx })
      .catch(() => { /* runCleanJob settles cleanJob itself */ });
    return { ok: true, started: true, id };
  }

  // The Recycle-Bin delete for a caller outside the Disk widget's categories
  // (Dev cleanup's stale editor workspace folders). Same last gate: every path
  // is re-probed and must pass the guard against `root`, the folder the caller
  // enumerated. Returns the paths actually moved.
  async function trashUnder(root, paths) {
    const gctx = guardCtx(root);
    const allowed = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      if (guardDelete(p, gctx, await probeFlags(p)).ok) allowed.push(p);
    }
    if (!allowed.length) return { ok: false, moved: [] };
    const res = await runShellDelete({ paths: allowed });
    const moved = [];
    for (const p of allowed) if (!(await probeFlags(p)).exists) moved.push(p);
    return { ok: !!(res && res.ok) && moved.length === allowed.length, moved };
  }

  return { clean, trashUnder };
}

module.exports = { makeClean };
