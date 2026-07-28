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
// Rows older than this are ignored even inside a fresh file (elapsed is a
// per-row timestamp, so a paused game's stale tail is still detectable).
const ROW_WINDOW_MS = 5000;
const POLL_MS = 1000;
// Logs are per-run and never read again once superseded. Keeping a bounded
// number stops a folder Xenon created from growing without limit on a machine
// that plays a lot.
const MAX_KEPT_LOGS = 40;
const GAMING_GRACE_MS = 10000;

// Names that present frames under MangoHud but are not a game. MangoHud is
// opt-in per launch, so this list is far shorter than the Windows one — the
// realistic false positive is a user who put MANGOHUD=1 in their environment
// and now has the layer in every GL/Vulkan client, including the dashboard's
// own browser and Xenon itself.
const IGNORE_RE = /^(?:chrome|chromium|firefox|brave|opera|vivaldi|msedge|epiphany|gnome-shell|kwin_wayland|kwin_x11|mutter|plasmashell|xenon|xenon-native|xenon-helper|vkcube|glxgears|mpv|vlc|obs)$/i;

// ── pure parsers (exported for tests) ────────────────────────────────────────

// MangoHud writes two headers: a system-info line and its values, then the
// per-frame column header, then rows. Locating the column header by NAME (not
// by line number) is what keeps this working when MangoHud adds a column —
// which it has done repeatedly across versions.
function parseLogColumns(line) {
  const cols = String(line || '').split(',').map((s) => s.trim().toLowerCase());
  const fps = cols.indexOf('fps');
  if (fps < 0) return null;
  return { fps, frametime: cols.indexOf('frametime'), elapsed: cols.indexOf('elapsed'), width: cols.length };
}

// `elapsed` is NANOSECONDS since logging started (MangoHud writes a duration,
// not a wall clock). Treating it as ms would make every row look ancient and
// the FPS would never appear — the kind of unit slip that produces a feature
// that is silently always off.
function elapsedToMs(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1e6 : null;
}

// Parse a tail of the CSV into rows. A partial first line (the tail read almost
// always starts mid-row) is discarded, and so is any row whose width does not
// match the header — a torn write while MangoHud is appending.
function parseLogTail(text, opts = {}) {
  const lines = String(text || '').split('\n');
  let cols = opts.columns || null;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!cols) {
      const c = parseLogColumns(line);
      if (c) cols = c;
      continue;
    }
    const f = line.split(',');
    if (f.length !== cols.width) continue;
    const fps = Number(f[cols.fps]);
    if (!Number.isFinite(fps) || fps <= 0 || fps > 10000) continue;
    const elapsedMs = cols.elapsed >= 0 ? elapsedToMs(f[cols.elapsed]) : null;
    rows.push({ fps, elapsedMs });
  }
  return { columns: cols, rows };
}

// The FPS to report from a tail: the median of the rows inside the trailing
// window. Median, not mean, because a loading screen or an alt-tab drops a few
// rows to single digits and a mean would drag the whole reading down.
function fpsFromRows(rows, windowMs = ROW_WINDOW_MS) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const last = rows[rows.length - 1];
  let kept = rows;
  if (last && Number.isFinite(last.elapsedMs)) {
    const cutoff = last.elapsedMs - windowMs;
    kept = rows.filter((r) => !Number.isFinite(r.elapsedMs) || r.elapsedMs >= cutoff);
  }
  if (!kept.length) return null;
  const vals = kept.map((r) => r.fps).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const m = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return Number.isFinite(m) && m > 0 ? Math.round(m) : null;
}

// MangoHud names logs "<program>_<date>_<time>.csv". The program name is what
// the Game Companion shows, so the timestamp tail has to come off — and the
// program name itself may contain underscores, so only the two trailing
// timestamp groups are stripped, never everything after the first underscore.
function programFromLogName(file) {
  const base = String(file || '').replace(/\.csv$/i, '');
  return base.replace(/_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/, '')
    .replace(/_\d{8}_\d{6}$/, '');
}

function isIgnoredProgram(name) {
  return !name || IGNORE_RE.test(String(name));
}

// The MangoHud config keys Xenon needs. Written into the user's own config so
// that a game launched with `mangohud` logs without any further setup.
function configLines(logDir) {
  return [
    'output_folder=' + logDir,
    'autostart_log=1',
    'log_interval=1000',
    'log_duration=0',
  ];
}

// Merge Xenon's keys into an existing MangoHud.conf, preserving everything
// else. A user's MangoHud config is theirs — their font size, their position,
// their chosen metrics — and this must only ever set the four logging keys,
// replacing them in place if present so the file does not grow on each start.
function mergeConfig(existing, logDir) {
  const want = new Map(configLines(logDir).map((l) => [l.split('=')[0], l]));
  const out = [];
  const seen = new Set();
  for (const raw of String(existing || '').split('\n')) {
    const key = raw.trim().split('=')[0].trim();
    if (want.has(key)) {
      if (seen.has(key)) continue; // drop duplicates rather than keep both
      out.push(want.get(key));
      seen.add(key);
    } else {
      out.push(raw);
    }
  }
  const missing = [...want.keys()].filter((k) => !seen.has(k));
  if (missing.length) {
    if (out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push('# Added by Xenon so the dashboard can read in-game FPS.');
    for (const k of missing) out.push(want.get(k));
  }
  let text = out.join('\n');
  if (!text.endsWith('\n')) text += '\n';
  return text;
}

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
