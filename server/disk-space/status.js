'use strict';
// What the disk space module says of itself: the state the widget draws, and the figures Bit
// may read and explain.

const DiskIntelligence = require('../js/disk-intelligence.js');
const { CLIENT_DIRS_MAX, CLIENT_FILES_MAX } = require('./limits.js');

function makeStatus({
  livingIndex, getIndexRoots, getDriveDetails, IS_WIN, helperPresent, scan, lastScan, loadSummary,
  listDrives, addableRoots, cleanSnapshot, overview,
}) {
  // ── status (what the widget renders) ─────────────────────────────────────
  async function status() {
    await loadSummary();
    const out = {
      ok: true,
      // The question the widget is really asking is "can you analyse my disk?",
      // and the helper is only one of the two answers. Off Windows the map is
      // built from the Living Index (see buildOverview, and startScan's own
      // `scan_unsupported` refusal), so a machine with a working index was
      // still being told to install a native companion — on Linux, with a
      // sentence naming INSTALL.bat, a file that platform does not have.
      // The wire name stays `helper` because the client keys on it.
      helper: helperPresent() || !!(livingIndex && livingIndex.available()),
      running: scan.running,
      progress: scan.progress,
      last: lastScan.lastSummary,
    };
    // Living-Index state + the configured roots (by index — the wire contract)
    // + which drive letters exist, so the widget can offer them as one-tap
    // additions.
    out.index = livingIndex ? await livingIndex.stats() : { on: false };
    const details = (await getDriveDetails().catch(() => ({}))) || {};
    const metadata = (drive) => {
      const raw = details[String(drive || '').toUpperCase()] || {};
      return {
        drive: String(drive || '').slice(0, 2).toUpperCase(),
        label: String(raw.label || '').trim().slice(0, 80),
        model: String(raw.model || '').trim().slice(0, 120),
        fileSystem: String(raw.fileSystem || '').trim().slice(0, 24),
        driveType: String(raw.driveType || '').trim().slice(0, 40),
      };
    };
    const volumes = await addableRoots(metadata);
    // Annotating a configured root with its volume's label. On Windows the key
    // is the drive letter; off Windows it is the longest mount path the root
    // sits under, which is what makes a root inside /Volumes/Backup read as
    // that volume rather than as `/`.
    const annotate = (rootPath) => {
      if (IS_WIN) {
        const match = /^([A-Za-z]:)/.exec(rootPath);
        return metadata(match ? match[1] : '');
      }
      let best = null;
      for (const v of volumes) {
        if (rootPath === v.path || rootPath.startsWith(v.path.replace(/\/+$/, '') + '/')) {
          if (!best || v.path.length > best.path.length) best = v;
        }
      }
      return best
        ? { drive: best.path, label: best.label, model: '', fileSystem: best.fileSystem, driveType: best.driveType }
        : { drive: '', label: '', model: '', fileSystem: '', driveType: '' };
    };
    out.roots = ((await getIndexRoots().catch(() => [])) || []).map((p, i) => {
      const rootPath = String(p || '');
      return { i, path: rootPath, ...annotate(rootPath) };
    });
    out.driveDetails = volumes;
    // Legacy field: bare drive letters, which only exist on Windows. The client
    // falls back to it when driveDetails is absent, so it stays.
    out.drives = await listDrives();
    // Whether a full scan is possible at all. The Living Index is the primary
    // path on every platform; the scan is the fallback for a machine without
    // it, and it needs the helper's `disk-scan` mode, which only the Windows
    // helper has. Saying so lets the widget not offer a button that refuses.
    out.canScan = IS_WIN;
    // A running (or just-finished) cleanup so a reloaded page re-attaches to it
    // instead of showing a spinner that resolves against nothing.
    out.clean = cleanSnapshot();
    if (!scan.running && scan.doneAt) {
      const dirsBySize = [...scan.dirs].sort((a, b) => b.s - a.s).slice(0, CLIENT_DIRS_MAX);
      out.result = {
        root: scan.root,
        cancelled: scan.cancelled,
        error: scan.error,
        bytes: scan.progress.bytes, files: scan.progress.files, dirs: scan.progress.dirs,
        tree: dirsBySize,
        topFiles: scan.topFiles.slice(0, CLIENT_FILES_MAX),
        dupes: scan.dupes.map((g) => ({ s: g.s, wasted: g.wasted, paths: g.paths })),
        categories: Object.fromEntries(Object.entries(scan.categories).map(([cat, c]) => [cat, {
          bytes: c.bytes, count: c.count,
          items: c.items.slice(0, 500).map((it) => ({ i: it.i, p: it.p, s: it.s, m: it.m, kind: it.kind })),
        }])),
      };
    }
    return out;
  }

  // ── AI insight (read-only; the AI can explain, never delete) ─────────────
  async function insights(rawIndex) {
    await loadSummary();
    const s = await status();
    const out = { helper: s.helper, lastScanAt: lastScan.lastSummary ? lastScan.lastSummary.at : null };
    // Living-Index path: current stats plus the requested configured root
    // (default first). The AI receives a root INDEX, never an arbitrary path.
    if (s.index && s.index.on && s.index.ready && s.roots && s.roots.length) {
      const requested = Number(rawIndex);
      const rootRec = Number.isInteger(requested)
        ? s.roots.find((r) => r.i === requested)
        : null;
      const selected = rootRec || s.roots[0];
      const ov = await overview(selected.i).catch(() => null);
      if (ov && ov.ok) {
        out.rootIndex = selected.i;
        out.root = ov.root;
        out.drive = {
          drive: selected.drive,
          label: selected.label,
          model: selected.model,
          fileSystem: selected.fileSystem,
          driveType: selected.driveType,
        };
        out.livingIndex = {
          files: s.index.files,
          ramMB: s.index.ramMB,
          capped: s.index.capped === true,
          roots: s.roots.map((r) => ({ index: r.i, path: r.path })),
        };
        out.totalBytes = ov.total;
        out.volume = ov.volume;
        out.categories = Object.fromEntries(Object.entries(ov.categories).map(([k, v]) => [k, { bytes: v.bytes, count: v.count }]));
        out.topFolders = ov.tree.slice(0, 15).map((d) => ({ path: d.p, bytes: d.s }));
        out.topFiles = ov.topFiles.slice(0, 15).map((f) => ({ path: f.p, bytes: f.s, modified: f.m ? new Date(f.m).toISOString() : '' }));
        out.duplicatesWastedBytes = ov.dupes.reduce((a, g) => a + g.wasted, 0);
        out.advice = DiskIntelligence.analyze(ov);
        out.note = 'consistent snapshot from the living index; cleanup re-checks every target against the live filesystem';
        return out;
      }
    }
    if (s.result) {
      out.totalBytes = s.result.bytes;
      out.categories = Object.fromEntries(Object.entries(s.result.categories).map(([k, v]) => [k, { bytes: v.bytes, count: v.count }]));
      out.topFolders = s.result.tree.slice(0, 15).map((d) => ({ path: d.p, bytes: d.s }));
      out.topFiles = s.result.topFiles.slice(0, 15).map((f) => ({ path: f.p, bytes: f.s, modified: f.m ? new Date(f.m).toISOString() : '' }));
      out.duplicatesWastedBytes = s.result.dupes.reduce((a, g) => a + g.wasted, 0);
    } else if (lastScan.lastSummary) {
      out.totalBytes = lastScan.lastSummary.bytes;
      out.categories = lastScan.lastSummary.byCategory;
      out.note = 'summary of the previous scan; run a new scan from the disk widget for details';
    } else {
      out.note = 'no scan has been run yet; the user starts one from the disk widget';
    }
    return out;
  }

  return { status, insights };
}

module.exports = { makeStatus };
