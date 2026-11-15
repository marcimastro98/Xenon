'use strict';

// ── Disk space orchestrator ─────────────────────────────────────────────────
// Drives the helper's `disk-scan` (streaming full-tree size accounting),
// classifies what came back through the CLOSED category list
// (disk-categories.js), guards every deletion through the hard blocklist
// (disk-guard.js) and executes it ONLY via the helper's recycle-bin delete.
// Helper-gated by design (like the Second screen): without the exe the widget
// shows a clear hint and nothing else runs.
//
// Wire contract (the Slideshow shape): the client addresses items as
// categoryId + item ids resolved against THIS module's enumeration — no path
// ever travels client→server. Before deletion each resolved path is re-stated
// live (exists? reparse?) and re-checked against the guard; a refusal is
// reported, never silently dropped.
//
// Duplicates are honest: same-size candidates from the scan are verified by
// full SHA-256 (async streams, bounded per-file and per-scan) and only
// verified groups are shown as duplicates.

const path = require('path');
require('./disk-categories'); // nothing is taken from it here, but it runs code when it loads
require('./disk-guard'); // nothing is taken from it here, but it runs code when it loads
require('../js/disk/disk-intelligence'); // nothing is taken from it here, but it runs code when it loads
require('./disk-kinds'); // nothing is taken from it here, but it runs code when it loads
const { createDupeVerifier } = require('./disk-dupes');

const SUMMARY_FILE = 'disk-summary.json';

const { makeDeleteGuard } = require('../disk-space/delete-guard.js');

const { makeVolumes } = require('../disk-space/volumes.js');

const { makeBrowse } = require('../disk-space/browse.js');

const { makeScan } = require('../disk-space/scan.js');

const { makeSavedOverviews } = require('../disk-space/saved-overviews.js');

const { makeCleanJob } = require('../disk-space/clean-job.js');

const { makeClean } = require('../disk-space/clean.js');

const { makeOverview } = require('../disk-space/overview.js');

const { makeStatus } = require('../disk-space/status.js');

function createDiskSpace(opts) {
  const o = opts || {};
  const dataDir = o.dataDir;
  const helperExe = o.helperExe;
  const appRoot = o.appRoot || path.join(__dirname, '..', '..');
  const getSettings = typeof o.getSettings === 'function' ? o.getSettings : () => ({});
  const shellDeleteRunner = typeof o.shellDelete === 'function' ? o.shellDelete : null;
  // A cleanup can take minutes (500 items, many of them folders with thousands
  // of files), so it runs as a background JOB, not inside the HTTP response.
  // The client is told progress over SSE (`disk_clean`) and can re-attach to a
  // running job after a reload through status(). `onCleanProgress` broadcasts;
  // absent (tests) it is a no-op.
  const onCleanProgress = typeof o.onCleanProgress === 'function' ? o.onCleanProgress : () => {};
  // Told when a cached overview gained something after it was answered (the
  // background duplicate pass), so the dashboard can refetch. No-op in tests.
  const onDiskUpdate = typeof o.onDiskUpdate === 'function' ? o.onDiskUpdate : () => {};
  // "Show in folder", injected by server.js (revealInFileManager of files/reveal-in-file-manager.js) for the same
  // reason filesearch.js takes it: one platform switch, not two that drift.
  const revealExternal = typeof o.revealExternal === 'function' ? o.revealExternal : null;
  // The Living Index (living-index.js). When it is on, the widget needs no
  // scan at all: sizes/top/dupes/categories come from the always-current
  // in-RAM index, per root, on demand.
  const livingIndex = o.livingIndex || null;
  // The index roots as the user configured them (searchSettings.indexRoots) —
  // the ONLY roots /disk/overview will resolve. The wire carries an INDEX into
  // this list, never a path (the Slideshow shape).
  const getIndexRoots = typeof o.getIndexRoots === 'function' ? o.getIndexRoots : async () => [];
  // Display-only volume metadata comes from server.js' existing, cached
  // Get-Volume probe. It never participates in root resolution or cleanup.
  const getDriveDetails = typeof o.getDriveDetails === 'function' ? o.getDriveDetails : async () => ({});
  // Which volumes could become an index root. On Windows that is the
  // drive-letter probe further down; off Windows there are no letters, and the
  // collector seam ALREADY enumerates the real mounts in the shape the system
  // tile consumes (darwin-collectors.disks() / linux-collectors.disks(): `/`
  // plus /Volumes, pseudo-filesystems filtered, label and fileSystem
  // included). Reusing it is the seam's whole point — a second enumeration here
  // would be a second thing to keep in step with what the disks tile shows.
  const getVolumes = typeof o.getVolumes === 'function' ? o.getVolumes : null;
  const summaryFile = path.join(dataDir, SUMMARY_FILE);

  const {
    PLATFORM, IS_WIN, IS_MAC, SEP, cmpKey, trimSep, isBelow, userProfile, localAppData, windir,
    programFiles, programFilesX86, tempDirs, xdgDirs, downloads, known, trashDirs, containerDirs,
    oneDrive,
  } = makeMachinePlaces({ o });




  const {
    guardCtx, isContainerDir, probeFlags, remainingBytes, guardDelete, helperPresent, canRecycle,
  } = makeDeleteGuard({ dataDir, helperExe, appRoot, shellDeleteRunner, PLATFORM, IS_WIN, IS_MAC, userProfile, windir, programFiles, programFilesX86, tempDirs, xdgDirs, known, containerDirs, oneDrive });

  // ── scan state ───────────────────────────────────────────────────────────
  const scan = {
    proc: null, running: false, root: '', startedAt: 0,
    progress: { dirs: 0, files: 0, bytes: 0 },
    dirs: [],            // [{p,s,n,m,d}] every reported dir (server-side full list)
    detailFiles: [],     // [{p,n,s,m}] files under the detail roots
    topFiles: [],
    dupeCandidates: [],  // [{s, paths:[]}] same-size candidates from the helper
    dupes: [],           // verified groups [{s, paths:[], wasted}]
    categories: {},      // cat -> { bytes, count, items: [{i,p,s,m,kind}] }
    error: null, doneAt: 0, cancelled: false, timer: null,
    buf: '',
  };
  const lastScan = {
    lastSummary: null,      // persisted lite summary for at-rest rendering
    summaryLoaded: false,
  };

  const {
    catCtx, loadSummary, killScan, byPathAsc, persistSummary, flushSummary, startScan, cancelScan,
  } = makeScan({ helperExe, getSettings, summaryFile, PLATFORM, IS_WIN, cmpKey, trimSep, isBelow, userProfile, localAppData, windir, tempDirs, downloads, trashDirs, isContainerDir, helperPresent, scan, lastScan });

  const cleanRuns = {
    // ── clean-job state ──────────────────────────────────────────────────────
    // A single cleanup at a time (a second request while one runs is refused
    // with `busy`), tracked here so status() can re-expose it to a reloaded page
    // and _gracefulShutdown can cancel it. `jobSeq` gives each run an id so a
    // late progress event from a previous run can't paint over a new one.
    jobSeq: 0,
  };
  const cleanJob = {
    id: 0, running: false, cat: '', root: null,
    total: 0, totalBytes: 0,          // what this run set out to remove
    processed: 0, deleted: 0, freed: 0, refusedCount: 0,
    phase: 'idle',                    // idle | processing | refreshing | done
    permanent: false, cancelled: false,
    startedAt: 0, doneAt: 0,
    report: null,                     // final machine-readable outcome
  };
  const liveDeleteProcs = new Set();  // shell-delete children in flight (no job object)

  // ── which drive letters exist ────────────────────────────────────────────
  // Never synchronously: this runs on the /disk/status request path, which the
  // widget polls while the index builds, and a single existsSync on a
  // mapped-but-disconnected network drive or an empty optical drive blocks the
  // event loop for seconds — taking SSE, sensors and media down with it. Async,
  // in parallel, cached, and stale-while-revalidate so a slow letter never
  // holds a response open twice.
  const DRIVES_TTL_MS = 30000;
  const drivesCache = { at: 0, list: [], pending: null };

  // ── volumes offered as one-tap index roots (POSIX) ───────────────────────
  // Same stale-while-revalidate shape as the letter probe above, for the same
  // reason: this sits on the /disk/status path the widget polls, and `df`
  // blocks on a stalled network mount.
  const volumesCache = { at: 0, list: [], pending: null };
  const {
    listDrives, addableRoots,
  } = makeVolumes({ getVolumes, IS_WIN, DRIVES_TTL_MS, drivesCache, volumesCache });

  // ── Living-Index overviews (the no-scan path) ────────────────────────────
  // One overview per configured root, computed on demand from the live index.
  // It is reused while it is fresh: younger than OVERVIEW_TTL_MS, or built at
  // the index version the helper still reports (an index that has not moved
  // has nothing new to say). Item ids for /disk/clean are indices into the
  // cached category lists — the same opaque-id contract as the scan path.
  const OVERVIEW_TTL_MS = 30 * 1000;
  const overviews = new Map();   // rootLower -> { at, version, root, total, files, tree, topFiles, dupes, categories, ... }
  const {
    cleanSnapshot, emitClean, runCleanJob, cancelClean, runShellDelete,
  } = makeCleanJob({ helperExe, shellDeleteRunner, onCleanProgress, probeFlags, remainingBytes, guardDelete, persistSummary, cleanJob, liveDeleteProcs, overviews });

  const overviewBuilds = new Map(); // rootLower -> Promise (dedupe UI + AI requests)
  const STALE_MIN_BYTES = 500 * 1024 * 1024;   // "large and untouched": at least this big…
  const STALE_AFTER_DAYS = 365;                // …and not modified for this long

  // Verified duplicates come from a background pass with a hash cache
  // (disk-dupes.js); the overview answers from what is already proven and is
  // updated, and the dashboard told, when the pass finds more.
  let held = false;   // a game is running: see hold()
  const dupeVerifier = createDupeVerifier({ dataDir, held: () => held });

  // The last overview of each drive, persisted, so the widget has something
  // true to show while the index rebuilds after a restart (minutes on a big
  // drive) instead of a spinner. Display only: it is never a cleanup target.
  const SNAPSHOT_FILE = 'disk-snapshot.json';
  const HISTORY_FILE = 'disk-history.json';
  const saved = {
    snapshots: null,           // rootLower -> client overview
    history: null,             // disk-history.js shape
    persistTimer: null,
  };

  const {
    resolveRoot, toClientOverview, reveal, browse,
  } = makeBrowse({ revealExternal, livingIndex, getIndexRoots, IS_WIN, SEP, cmpKey, trimSep, isBelow, overviews });

  const {
    clean, trashUnder,
  } = makeClean({ cmpKey, guardCtx, probeFlags, guardDelete, canRecycle, scan, cleanRuns, cleanJob, overviews, emitClean, runCleanJob, runShellDelete, resolveRoot });

  const {
    loadPersisted, schedulePersist, flushPersist, snapshotOf, snapshot,
  } = makeSavedOverviews({ dataDir, cmpKey, SNAPSHOT_FILE, HISTORY_FILE, saved, resolveRoot });

  const {
    overview,
  } = makeOverview({ onDiskUpdate, livingIndex, cmpKey, trimSep, isBelow, tempDirs, downloads, isContainerDir, catCtx, byPathAsc, OVERVIEW_TTL_MS, overviews, overviewBuilds, STALE_MIN_BYTES, STALE_AFTER_DAYS, dupeVerifier, saved, resolveRoot, toClientOverview, loadPersisted, schedulePersist, snapshotOf });

  const {
    status, insights,
  } = makeStatus({ livingIndex, getIndexRoots, getDriveDetails, IS_WIN, helperPresent, scan, lastScan, loadSummary, listDrives, addableRoots, cleanSnapshot, overview });

  function hold(on) { held = on === true; }

  // On shutdown: stop a running scan, cancel the clean loop so it opens no new
  // batches, and give any in-flight shell-delete child a moment to finish its
  // current move before killing it (the moves it already handed to Windows
  // complete; we just stop launching more and don't orphan the child).
  function stop() {
    killScan('shutdown');
    cleanJob.cancelled = true;
    // Ends the background hash pass between files and saves what it learned.
    void dupeVerifier.stop();
    void Promise.all([flushPersist(), flushSummary()]);   // what waits for its timer, and what a save could not write
    for (const proc of liveDeleteProcs) {
      try { proc.stdin.end(); } catch {}
      const kill = setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
      kill.unref();
      proc.once('exit', () => clearTimeout(kill));
    }
  }

  return {
    startScan, cancelScan, status, overview, browse, clean, cancelClean,
    insights, hold, stop, helperPresent, snapshot, reveal, trashUnder,
  };
}

const { parseXdgUserDirs } = require('../disk-space/xdg-user-dirs.js');

const { makeMachinePlaces } = require('../disk-space/machine-places.js');

module.exports = { createDiskSpace, parseXdgUserDirs };
