'use strict';
// The frames the FPS reader keeps for each process PresentMon reports: the entry of a process,
// the rows added to it, and a PresentMon stream cut into rows.

const { createFrameRing } = require('../frame-stats.js');
const { parseHeader, rowValues } = require('./presentmon-rows.js');

const MAX_SAMPLES = 240;         // rolling frame-time samples kept per process
// Frames kept per process for the readers by mark (game sessions on the 3 s
// status tick, benchmarks every second): 6000 = nothing lost below 2000 FPS
// between two looks. The live stats still read the newest STATS_SAMPLES.
const RING_FRAMES = 6000;

const _csv = { buffer: '', cols: null };  // what the main process has sent: unfinished line, header
const _byPid = new Map();        // pid -> { name, samples:number[], usesFps:bool, lastSeen:number }

function entryFor(r) {
  let entry = _byPid.get(r.pid);
  if (!entry) {
    entry = { name: r.name, samples: [], display: [], usesFps: r.usesFps, lastSeen: 0, presentRing: createFrameRing(RING_FRAMES), displayRing: createFrameRing(RING_FRAMES) };
    _byPid.set(r.pid, entry);
  }
  return entry;
}

function record(entry, r) {
  entry.name = r.name || entry.name;
  entry.usesFps = r.usesFps;
  if (r.present != null) { push(entry.samples, r.present); entry.presentRing.push(r.present); }
  if (r.display != null) { push(entry.display, r.display); entry.displayRing.push(r.display); }
  entry.lastSeen = Date.now();
}

// A row of the second session (fps-game-session.js): every frame, present side
// only. The rows the main session left behind go, or their gaps of seconds would
// read as stutter and their display side would win over the complete one.
function handleGameRow(fields, game) {
  const r = rowValues(_gameCsv.cols, fields, game);
  if (!r) return;
  const entry = entryFor(r);
  if (entry.displayRing.size()) {
    entry.samples.length = 0;
    entry.display.length = 0;
    entry.presentRing.clear();
    entry.displayRing.clear();
  }
  record(entry, r);
}

function push(arr, v) {
  arr.push(v);
  if (arr.length > MAX_SAMPLES) arr.shift();
}

// Splits a PresentMon stream into rows. `csv` holds what one process has sent so
// far: the unfinished line and its header.
function readRows(csv, chunk, onRow) {
  csv.buffer += chunk;
  let nl;
  while ((nl = csv.buffer.indexOf('\n')) >= 0) {
    const line = csv.buffer.slice(0, nl).replace(/\r$/, '').trim();
    csv.buffer = csv.buffer.slice(nl + 1);
    if (!line) continue;
    const fields = line.split(',');
    if (!csv.cols) {
      // The header is the first line containing recognisable column names.
      if (/application|processid|presents/i.test(line)) csv.cols = parseHeader(fields);
      continue;
    }
    try { onRow(fields); } catch { /* ignore a malformed row */ }
  }
}

const _gameCsv = { buffer: '', cols: null };

module.exports = {
  MAX_SAMPLES, RING_FRAMES, _csv, _byPid, entryFor, record, handleGameRow, push, readRows, _gameCsv,
};
