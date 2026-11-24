'use strict';
// While Xenon holds the fans, the engine runs above normal priority.
//
// Windows starts the engine from a scheduled task, and a task runs below normal unless
// told otherwise. Below normal waits behind every busy normal thread: on a real PC a
// test run on all sixteen threads left the engine without CPU for three minutes, the
// fan service saw a silent brain and gave the fans to the BIOS, which ran them loud on
// the hot processor (23 Nov 2026). The loop that holds the fans must not wait behind
// the work that heats the PC, so while it holds them the engine moves above normal (its
// work is light, about a tenth of one core) and goes back to its own place when it lets
// go. Windows passes only below normal and idle on to child processes, so what the
// engine starts meanwhile runs at normal, and readers lower themselves anyway
// (programs/child-priority.js). Linux and macOS ask a privilege the engine lacks: it
// keeps its place there, said once in the log, and their schedulers share the CPU
// fairly at the same nice level, so the engine is not starved the same way.

const os = require('os');

const { PRIORITY_ABOVE_NORMAL: ABOVE } = os.constants.priority;

/**
 * @param {{ system?: { getPriority: (pid: number) => number, setPriority: (pid: number, level: number) => void },
 *   warn?: (msg: string) => void }} [deps]
 */
function createEnginePriority({ system = os, warn = (_msg) => {} } = {}) {
  // Where the engine was before Xenon moved it, while moved; node's numbers run the other
  // way round: the lower, the sooner it runs.
  let before = null;
  let told = false;
  return {
    /** @param {boolean} on whether Xenon holds the fans now */
    holding(on) {
      try {
        if (on && before == null) {
          const now = system.getPriority(0);
          if (now <= ABOVE) return;
          system.setPriority(0, ABOVE);
          before = now;
        } else if (!on && before != null) {
          const was = before;
          before = null;
          // Someone else moved it meanwhile: their choice stays.
          if (system.getPriority(0) === ABOVE) system.setPriority(0, was);
        }
      } catch (e) {
        if (!told) warn(`airflow: the engine keeps its CPU priority while it holds the fans (${e.code || e.message})`);
        told = true;
      }
    },
  };
}

module.exports = { createEnginePriority };
