'use strict';
// The program a climb of the fans is for, told with the climb (rise.js): "the processor is
// working" says what, not who. The processor's heat names the program that used the most of
// it over a couple of seconds, read once per climb told (minutes apart at most) from the
// process table Performance Mode reads (perf-session: native on Windows, the collectors on
// Linux, no PowerShell). The system's own programs are named too: a Defender scan or Windows
// Update is what most often makes a PC at rest loud. A graphics card's heat, or a game getting
// ready, names the game in front, never a processor figure (it would point at the wrong part).
// Something too hot, or fans at their limit, names nothing: their sentence is long already.
const { processKey } = require('../perf-session/process-names.js');

const WINDOW_MS = 2000;
// A read that hangs never holds the notice: it goes without the program.
const TIMEOUT_MS = 5000;
// Of the whole processor: one busy core of a 16-thread CPU is 6.
const MIN_CPU_PCT = 5;
const NAME_MAX = 40;
// Rows that are no program: the time nothing ran.
const NOT_PROGRAMS = new Set(['idle', 'system idle process', '_total']);
const GAME_REASONS = new Set(['heat-gpu', 'game-prepare']);
// Names a person knows, for the system programs that most often keep a PC busy and whose
// file name says nothing.
const KNOWN = Object.freeze({
  msmpeng: 'Microsoft Defender', mpdefendercoreservice: 'Microsoft Defender', nissrv: 'Microsoft Defender',
  tiworker: 'Windows Update', trustedinstaller: 'Windows Update', usocoreworker: 'Windows Update', wuauclt: 'Windows Update',
  searchindexer: 'Windows Search', searchprotocolhost: 'Windows Search', searchfilterhost: 'Windows Search',
  compattelrunner: 'Microsoft Compatibility Telemetry', msedge: 'Microsoft Edge', chrome: 'Google Chrome',
});

/** The name to show for a process: bare, without .exe, capitalised (the tables lower-case it). */
function nameOf(proc) {
  const key = processKey(proc);
  if (KNOWN[key]) return KNOWN[key];
  const bare = String(proc).trim().replace(/\.exe$/i, '').slice(0, NAME_MAX);
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/**
 * The program that used the most processor, or null when none used enough to matter.
 * @param {{ proc: string, cpuPct: number }[]} apps perf-session stats() rows
 * @returns {{ name: string, cpu: number }|null}
 */
function busiestOf(apps) {
  let best = null;
  for (const a of Array.isArray(apps) ? apps : []) {
    if (!a || typeof a.proc !== 'string') continue;
    const key = processKey(a.proc);
    const cpu = Number(a.cpuPct);
    if (!key || NOT_PROGRAMS.has(key) || !Number.isFinite(cpu)) continue;
    if (!best || cpu > best.cpu) best = { proc: a.proc, cpu };
  }
  return best && best.cpu >= MIN_CPU_PCT ? { name: nameOf(best.proc), cpu: Math.round(best.cpu) } : null;
}

/**
 * @param {{ read: (o: { by: 'cpu', windowMs: number }) => Promise<any>, game: () => string|null,
 *   timeoutMs?: number }} deps read: perf-session stats(); game: the game in front, or null
 * @returns {(reason: string) => Promise<{ name: string, cpu?: number, game?: true }|null>}
 */
function createRiseCause({ read, game, timeoutMs = TIMEOUT_MS }) {
  async function busiest() {
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, null); });
    try {
      const stats = await Promise.race([Promise.resolve().then(() => read({ by: 'cpu', windowMs: WINDOW_MS })), late]);
      return stats && stats.ok !== false ? busiestOf(stats.apps) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return async (reason) => {
    if (reason === 'heat-cpu') return busiest();
    const g = GAME_REASONS.has(reason) ? game() : null;
    return g ? { name: nameOf(g), game: true } : null;
  };
}

module.exports = { createRiseCause, busiestOf, nameOf, MIN_CPU_PCT, WINDOW_MS };
