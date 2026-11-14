'use strict';
// Reads MangoHud's log files on Linux: the columns, the newest rows as frames per second, the
// program a log belongs to, and Xenon's lines merged into its config.

// Rows older than this are ignored even inside a fresh file (elapsed is a
// per-row timestamp, so a paused game's stale tail is still detectable).
const ROW_WINDOW_MS = 5000;

// Names that present frames under MangoHud but are not a game. MangoHud is
// opt-in per launch, so this list is far shorter than the Windows one — the
// realistic false positive is a user who put MANGOHUD=1 in their environment
// and now has the layer in every GL/Vulkan client, including the dashboard's
// own browser and Xenon itself.
const IGNORE_RE = /^(?:chrome|chromium|firefox|brave|opera|vivaldi|msedge|epiphany|gnome-shell|kwin_wayland|kwin_x11|mutter|plasmashell|xenon|xenon-native|xenon-helper|vkcube|glxgears|mpv|vlc|obs)$/i;

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

module.exports = {
  ROW_WINDOW_MS, IGNORE_RE, parseLogColumns, elapsedToMs, parseLogTail, fpsFromRows,
  programFromLogName, isIgnoredProgram, configLines, mergeConfig,
};
