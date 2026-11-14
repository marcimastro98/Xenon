'use strict';
// The running programs of a Mac with their processor time and memory, read from ps.

const { runSoft, splitLines } = require('./darwin-read.js');

// [[dd-]hh:]mm:ss[.cc] -> milliseconds.
function parsePsTime(s) {
  const raw = String(s || '').trim();
  if (!raw) return null;
  let days = 0;
  let rest = raw;
  const dash = rest.indexOf('-');
  if (dash > 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
    if (!Number.isFinite(days)) return null;
  }
  const parts = rest.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [h, m, sec] = parts.length === 3 ? nums : [0, nums[0], nums[1]];
  return (((days * 24 + h) * 60 + m) * 60 + sec) * 1000;
}

// comm is last on purpose: it is a full executable path and may contain spaces,
// so it takes the remainder of the line instead of a fixed column.
const PS_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/;

function parsePsProcesses(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = PS_ROW_RE.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const rssKb = Number(m[2]);
    const cpuMs = parsePsTime(m[3]);
    if (!Number.isInteger(pid) || pid <= 0 || cpuMs === null) continue;
    const name = String(m[4]).trim().split('/').pop();
    if (!name) continue;
    out.set(pid, { name, cpuMs, rss: (Number.isFinite(rssKb) ? rssKb : 0) * 1024 });
  }
  return out;
}

// Every process for Performance Mode, the rows process-table-windows.js gives. lstart is
// five words in the C locale and only ever compared, so it tells a reused pid apart. The
// owner is the uid: a process of another user is not this person's to move.
const PS_TABLE_ROW_RE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/;

function parsePsTable(text) {
  const rows = [];
  for (const line of splitLines(text)) {
    const m = PS_TABLE_ROW_RE.exec(line);
    if (!m) continue;
    const cpuMs = parsePsTime(m[5]);
    const name = String(m[7]).trim().split('/').pop().toLowerCase();
    if (cpuMs === null || !name) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name, cpuMs, memBytes: Number(m[4]) * 1024, startedAt: Date.parse(m[6]) || 0, owner: Number(m[3]) });
  }
  return rows;
}

async function processTable() {
  const columns = ['pid=', 'ppid=', 'uid=', 'rss=', 'time=', 'lstart=', 'comm='].flatMap((c) => ['-o', c]);
  const out = await runSoft('/bin/ps', ['-A', ...columns], 6000, { ...process.env, LC_ALL: 'C' });
  if (out === null) return null;
  const rows = parsePsTable(out);
  return rows.length ? rows : null;
}

async function sampleProcesses() {
  const out = await runSoft('/bin/ps', ['-Ao', 'pid=,rss=,time=,comm='], 6000);
  if (out === null) return null;
  const sample = parsePsProcesses(out);
  return sample.size ? sample : null;
}

module.exports = {
  parsePsTime, PS_ROW_RE, parsePsProcesses, PS_TABLE_ROW_RE, parsePsTable, processTable,
  sampleProcesses,
};
