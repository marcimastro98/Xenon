'use strict';
// The session's priority boost, by process id through the OS, with no PowerShell.
//
// It only ever raises to AboveNormal and only ever undoes what it did: a game that
// runs at High on its own stays there, and goes back to the level it had.

const os = require('os');
const { processKey, isProtected } = require('./process-names');

const { PRIORITY_ABOVE_NORMAL: ABOVE, PRIORITY_NORMAL: NORMAL } = os.constants.priority;

function createPriority({ table, system = os }) {
  const saved = new Map();   // pid -> { startedAt, level }

  function raise(row) {
    const level = system.getPriority(row.pid);
    saved.set(row.pid, { startedAt: row.startedAt, level });
    // On this scale a smaller number is more urgent.
    if (level > ABOVE) system.setPriority(row.pid, ABOVE);
  }

  function lower(row) {
    const mine = saved.get(row.pid);
    saved.delete(row.pid);
    if (mine && mine.startedAt === row.startedAt) {
      system.setPriority(row.pid, mine.level);
    } else if (system.getPriority(row.pid) === ABOVE) {
      // A session that outlived a server restart: the level is the only trace of it.
      system.setPriority(row.pid, NORMAL);
    }
  }

  async function rowsNamed(key) {
    const rows = await table.read();
    return rows ? rows.filter((r) => r.name === key) : null;
  }

  async function set(name, level) {
    const key = processKey(name);
    if (!key || isProtected(key)) return { ok: false, error: 'protected' };
    const rows = await rowsNamed(key);
    if (!rows) return { ok: false, error: 'unavailable' };
    if (!rows.length) return { ok: false, error: 'not_found' };
    let count = 0;
    for (const row of rows) {
      // An anti-cheat or an elevated game refuses, and that is its right.
      try { (level === 'high' ? raise : lower)(row); count += 1; } catch { /* next one */ }
    }
    return count ? { ok: true, count } : { ok: false, error: 'denied' };
  }

  // Exact, and three-valued for the caller: a table nobody could read says nothing
  // about the process.
  async function isRunning(name) {
    const rows = await rowsNamed(processKey(name));
    return rows ? { ok: true, running: rows.length > 0 } : { ok: false, error: 'unavailable' };
  }

  return { set, isRunning };
}

module.exports = { createPriority };
