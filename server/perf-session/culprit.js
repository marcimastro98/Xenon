'use strict';
// "Which program weighs on the PC?" When the stutter watch blames the processor or the
// memory, the program other than the game and the system that uses the most of it, read
// from the process table (index.js: native on Windows, the collectors on Linux and macOS,
// no PowerShell). One read at a time, at most every READ_EVERY_MS, never on the tick's path.

const { processKey, isProtected, isDesktopSession, isOwnName, isSharedRuntime } = require('./process-names');

const READ_EVERY_MS = 10000;
const MIN_GAP_MS = 3000;    // a verdict that changes reads at once, but never twice in this
const MIN_CPU_PCT = 5;      // of the whole machine: one busy core of a 16-thread CPU is 6
const MIN_RAM_MB = 1024;
const NAME_MAX = 40;

// What each verdict blames, and so what the program is measured by.
const MEASURE = Object.freeze({ cpu_bound: 'cpu', mixed: 'cpu', ram_full: 'ram' });

// The operating system itself, beyond the names Performance Mode leaves alone: nothing a
// person can close.
const OS_OWN = new Set([
  'idle', 'system idle process', 'memory compression', 'secure system',
  'kernel_task', 'launchd', 'mds', 'mds_stores', 'systemd', 'kthreadd', 'init',
]);

function ignored(key, gameKey) {
  return !key || key === gameKey || OS_OWN.has(key) || isProtected(key) || isDesktopSession(key)
    || isOwnName(key) || isSharedRuntime(key);
}

// apps: perf-session stats() rows { proc, memMB, cpuPct }. The program, or null when none
// other than the game and the system uses enough to matter.
function pickCulprit(reason, apps, game) {
  const by = MEASURE[reason];
  if (!by || !Array.isArray(apps)) return null;
  const gameKey = processKey(game);
  let best = null;
  for (const a of apps) {
    if (!a || typeof a.proc !== 'string') continue;
    const key = processKey(a.proc);
    const v = Number(by === 'cpu' ? a.cpuPct : a.memMB);
    if (ignored(key, gameKey) || !Number.isFinite(v)) continue;
    if (!best || v > best.v) best = { name: a.proc.trim().replace(/\.exe$/i, '').slice(0, NAME_MAX), v };
  }
  if (!best || best.v < (by === 'cpu' ? MIN_CPU_PCT : MIN_RAM_MB)) return null;
  return by === 'cpu' ? { name: best.name, cpu: Math.round(best.v) } : { name: best.name, ramMB: Math.round(best.v) };
}

// deps: { read() → stats() or null, available()? → the table can be read, now()? }
function createCulpritWatch({ read, available, now = Date.now, everyMs = READ_EVERY_MS } = {}) {
  let wanted = '';     // 'reason\ngame' the verdict blames now, '' when nothing to look for
  let found = '';      // the 'reason\ngame' the last read answered
  let app = null;
  let busy = false;
  let lastAt = -Infinity;

  const readable = () => {
    try { return typeof read === 'function' && (typeof available !== 'function' || available() === true); } catch { return false; }
  };

  async function look(key, reason, game) {
    busy = true;
    lastAt = now();
    let stats = null;
    try { stats = await read(); } catch { stats = null; }
    busy = false;
    if (key !== wanted) return;   // the verdict moved on while the table was read
    found = key;
    app = stats && stats.ok !== false ? pickCulprit(reason, stats.apps, game) : null;
  }

  // Every stutter-watch tick: shown is its { verdict, reason } or null, game the one in front.
  function onWhy(shown, game) {
    const reason = shown && MEASURE[shown.reason] ? shown.reason : '';
    const name = typeof game === 'string' ? game : '';
    if (!reason || !name) { wanted = ''; found = ''; app = null; return; }
    wanted = reason + '\n' + name;
    if (busy || !readable()) return;
    const since = now() - lastAt;
    if (since < MIN_GAP_MS || (found === wanted && since < everyMs)) return;
    look(wanted, reason, name);
  }

  // The program for the verdict shown now (or for `reason`, when the caller names it).
  function current(reason) {
    if (!wanted || found !== wanted) return null;
    if (reason != null && !wanted.startsWith(reason + '\n')) return null;
    return app;
  }

  return { onWhy, current };
}

module.exports = { createCulpritWatch, pickCulprit, MEASURE, READ_EVERY_MS, MIN_CPU_PCT, MIN_RAM_MB };
