'use strict';
// Linux and macOS: one long-running `ping` per address, for as long as a widget
// reads, instead of a spawn per echo (a process at every reading is a fixed cost
// off Windows). LC_ALL=C keeps the lines in English for parsePingLine. The child
// is not lowered in priority: it is a measurement and has to answer on time.
// A missing binary is remembered and never spawned again in this process.

const { spawn: nodeSpawn } = require('node:child_process');
const { parsePingLine } = require('./parse.js');

const MAX_GAP = 10;          // echoes counted lost for one jump in icmp_seq
const MAX_PENDING = 4096;    // a line longer than this is not ping's

function createPinger({ command, args, spawn = nodeSpawn }) {
  let missing = false;

  return function watch(ip, onSample) {
    const idle = { stop() {}, dead: () => true };
    if (missing) return idle;
    let child = null;
    try {
      child = spawn(command, args(ip), {
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        windowsHide: true,
      });
    } catch {
      return idle;
    }
    let exited = false;
    let lastSeq = null;
    let pending = '';

    child.on('error', (err) => {
      exited = true;
      if (err && err.code === 'ENOENT') missing = true;
    });
    child.on('exit', () => { exited = true; });

    const take = (line) => {
      const p = parsePingLine(line);
      if (!p || (lastSeq !== null && p.seq <= lastSeq)) return;   // late or repeated
      // A jump in the sequence is echoes that never came back, whichever line
      // the platform prints (or does not) for them.
      if (lastSeq !== null) {
        for (let s = lastSeq + 1; s < p.seq && s - lastSeq <= MAX_GAP; s += 1) onSample(null);
      }
      lastSeq = p.seq;
      onSample(p.lost ? null : p.ms);
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      let nl = pending.indexOf('\n');
      while (nl >= 0) {
        take(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
        nl = pending.indexOf('\n');
      }
      if (pending.length > MAX_PENDING) pending = '';
    });

    return {
      stop() {
        if (exited) return;
        exited = true;
        try { child.kill(); } catch { /* already gone */ }
      },
      dead: () => exited,
    };
  };
}

module.exports = { createPinger, MAX_GAP };
