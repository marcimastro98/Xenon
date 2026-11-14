'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// linux-fps.js — in-game FPS on Linux, via MangoHud.
//
// fpsmon.js reads PresentMon, which taps ETW: an OS-level record of every frame
// any process presents. Linux has no counterpart. Under Wayland each client
// presents to the compositor on its own and no per-process frame counter is
// exposed; i915/amdgpu PMU counters are per-GPU, not per-process, and reading
// them needs perf_event_paranoid lowered or CAP_PERFMON. There is no way to
// learn a game's frame rate without the game's own cooperation.
//
// MangoHud is that cooperation: a Vulkan layer / GL shim the game loads, which
// therefore counts real presented frames. The cost is honest and worth stating
// plainly — FPS appears only for games actually launched under MangoHud
// (`mangohud %command%` as a Steam launch option, or `mangohud ./game`). Games
// started without it report nothing, and this reports nothing rather than
// inventing a number.
//
// The transport is MangoHud's CSV log rather than a socket, because that is the
// only channel it offers a reader: MangoHud has a control socket, but it only
// accepts commands and returns no telemetry. So Xenon points MangoHud's logging
// at a folder of its own and tails the newest file.
//
// Everything here degrades to "no FPS": no MangoHud, no folder, no recent file,
// an unparsable header — every one of those is getCurrentFps() === null, which
// is exactly what the dashboard already renders as "--".
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

// A log file must have been written to this recently for its rows to count as
// live. MangoHud flushes on its log_interval, so this has to comfortably clear
// the 1s interval Xenon configures without keeping a finished game "playing".
const FRESH_MS = 5000;
// How much of the file tail to read. Rows are ~100 bytes, so this is a couple
// of minutes of samples at 1 Hz — plenty to median, tiny to read.
const TAIL_BYTES = 16384;
// Enough of the file head to reach the column header past MangoHud's two
// system-info lines, which carry the GPU/driver strings and can be long.
const HEAD_BYTES = 8192;
const {
  parseLogColumns, elapsedToMs, parseLogTail, fpsFromRows, programFromLogName, isIgnoredProgram,
  configLines, mergeConfig,
} = require('./performance/mangohud-log.js');
const POLL_MS = 1000;
// Logs are per-run and never read again once superseded. Keeping a bounded
// number stops a folder Xenon created from growing without limit on a machine
// that plays a lot.
const MAX_KEPT_LOGS = 40;
const GAMING_GRACE_MS = 10000;

// ── pure parsers (exported for tests) ────────────────────────────────────────

// ── runtime ──────────────────────────────────────────────────────────────────

function defaultLogDir() {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'xenon', 'mangohud');
}

function defaultConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'MangoHud', 'MangoHud.conf');
}

// MangoHud is installed when the launcher is on PATH. The Vulkan layer alone is
// not enough to check for: distros place its JSON in several directories and a
// layer without the wrapper cannot be started by the user anyway.
function findMangoHud(pathEnv) {
  const dirs = String(pathEnv == null ? process.env.PATH : pathEnv || '').split(':').filter(Boolean);
  for (const dir of dirs) {
    const p = path.join(dir, 'mangohud');
    try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

function createLinuxFps(o = {}) {
  const logDir = o.logDir || defaultLogDir();
  const configPath = o.configPath || defaultConfigPath();
  const pollMs = Number(o.pollMs) > 0 ? Number(o.pollMs) : POLL_MS;
  const locate = typeof o.findMangoHud === 'function' ? o.findMangoHud : findMangoHud;

  let timer = null;
  let stopped = false;
  let paused = true;
  let reading = false;
  let current = null;       // { name, fps, at }
  let lastGamingAt = 0;
  let installed = null;     // lazily resolved, refreshed by reload()

  function available() {
    if (installed === null) installed = !!locate();
    return installed;
  }

  // Point MangoHud's logging at Xenon's folder. Best-effort by design: a
  // read-only config, a missing home, a MangoHud that is not installed — none
  // of those are errors worth surfacing, they just mean no FPS.
  async function configure() {
    if (!available()) return false;
    try {
      await fsp.mkdir(logDir, { recursive: true });
      await fsp.mkdir(path.dirname(configPath), { recursive: true });
      let existing = '';
      try { existing = await fsp.readFile(configPath, 'utf8'); } catch { /* new file */ }
      const merged = mergeConfig(existing, logDir);
      if (merged !== existing) await fsp.writeFile(configPath, merged, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  // The most recently modified log, and only if it was written to just now.
  async function newestLog() {
    let names;
    try { names = await fsp.readdir(logDir); } catch { return null; }
    const csvs = names.filter((n) => n.toLowerCase().endsWith('.csv'));
    if (!csvs.length) return null;
    const stats = await Promise.all(csvs.map(async (n) => {
      try { return { n, mtime: (await fsp.stat(path.join(logDir, n))).mtimeMs }; }
      catch { return null; }
    }));
    const live = stats.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
    if (!live.length) return null;
    if (Date.now() - live[0].mtime > FRESH_MS) return null;
    return live[0].n;
  }

  // The column header sits at the TOP of the file and the live rows at the
  // bottom, so a tail-only read finds no header once a session runs past a few
  // minutes — and the FPS would vanish exactly when someone is actually playing.
  // Head and tail are therefore read separately, and the columns are cached per
  // file so the head is read once per game rather than once per second.
  let headerCache = { file: null, columns: null };

  async function readAt(file, start, len) {
    const full = path.join(logDir, file);
    let fh;
    try {
      fh = await fsp.open(full, 'r');
      const { size } = await fh.stat();
      const from = start < 0 ? Math.max(0, size + start) : Math.min(start, size);
      const count = Math.min(len, size - from);
      if (count <= 0) return { text: '', from, size };
      const buf = Buffer.alloc(count);
      await fh.read(buf, 0, count, from);
      return { text: buf.toString('utf8'), from, size };
    } catch {
      return { text: '', from: 0, size: 0 };
    } finally {
      if (fh) { try { await fh.close(); } catch { /* ignore */ } }
    }
  }

  async function columnsFor(file) {
    if (headerCache.file === file && headerCache.columns) return headerCache.columns;
    const { text } = await readAt(file, 0, HEAD_BYTES);
    let columns = null;
    for (const line of text.split('\n')) {
      const c = parseLogColumns(line);
      if (c) { columns = c; break; }
    }
    headerCache = { file, columns };
    return columns;
  }

  async function readTail(file) {
    const { text, from } = await readAt(file, -TAIL_BYTES, TAIL_BYTES);
    // A read from mid-file almost always lands inside a row; drop that fragment
    // so a truncated number is never parsed as a real frame rate.
    if (from > 0) {
      const nl = text.indexOf('\n');
      return nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  }

  async function tick() {
    if (reading || stopped || paused) return;
    reading = true;
    try {
      const file = await newestLog();
      if (!file) { current = null; return; }
      const name = programFromLogName(file);
      if (isIgnoredProgram(name)) { current = null; return; }
      const columns = await columnsFor(file);
      if (!columns) { current = null; return; }
      const text = await readTail(file);
      const { rows } = parseLogTail(text, { columns });
      const fps = fpsFromRows(rows);
      current = fps == null ? null : { name, fps, at: Date.now() };
      if (current) lastGamingAt = current.at;
    } catch {
      current = null;
    } finally {
      reading = false;
    }
  }

  function fresh() {
    return current && (Date.now() - current.at) <= FRESH_MS ? current : null;
  }

  function startTimer() {
    if (timer || stopped || paused) return;
    tick();
    timer = setInterval(tick, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stopTimer() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Prune old logs so Xenon's own folder stays bounded. Never touches the file
  // currently being written (it is the newest, and the newest are kept).
  async function prune() {
    try {
      const names = (await fsp.readdir(logDir)).filter((n) => n.toLowerCase().endsWith('.csv'));
      if (names.length <= MAX_KEPT_LOGS) return;
      const stats = (await Promise.all(names.map(async (n) => {
        try { return { n, mtime: (await fsp.stat(path.join(logDir, n))).mtimeMs }; }
        catch { return null; }
      }))).filter(Boolean).sort((a, b) => b.mtime - a.mtime);
      for (const s of stats.slice(MAX_KEPT_LOGS)) {
        try { await fsp.unlink(path.join(logDir, s.n)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  return {
    isAvailable: available,
    getCurrentFps() { const c = fresh(); return c ? c.fps : null; },
    getGamingProcess() { const c = fresh(); return c ? { name: c.name, fps: c.fps } : null; },
    isGaming() {
      if (fresh()) { lastGamingAt = Date.now(); return true; }
      return lastGamingAt > 0 && (Date.now() - lastGamingAt) < GAMING_GRACE_MS;
    },
    async start() {
      if (stopped) return;
      await configure();
      prune();
      paused = false;
      startTimer();
    },
    pause() { paused = true; current = null; stopTimer(); },
    resume() { if (stopped) return; paused = false; startTimer(); },
    stop() { stopped = true; paused = true; current = null; stopTimer(); },
    // Re-check for a MangoHud installed after Xenon started.
    async reload() { installed = null; if (available()) await configure(); },
    logDir,
    configPath,
  };
}

module.exports = {
  createLinuxFps,
  parseLogColumns,
  parseLogTail,
  fpsFromRows,
  elapsedToMs,
  programFromLogName,
  isIgnoredProgram,
  mergeConfig,
  configLines,
  findMangoHud,
  defaultLogDir,
  defaultConfigPath,
};
