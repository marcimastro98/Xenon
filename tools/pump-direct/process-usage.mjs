// What a process and everything it started costs: the pure parts of cost.mjs (reading the
// system's process list, finding a process's tree, CPU and memory between two looks) and the
// two readers, Windows (CIM, through PowerShell) and Linux (/proc). Tests:
// server/test/pump-direct-tool.test.mjs.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const MB = 1024 * 1024;
const WIN_TICK_MS = 1e-4;   // Win32_Process times are in 100 ns
const LINUX_TICK_MS = 10;   // /proc times are in USER_HZ, 100 on every Linux Xenon runs on
const PAGE_BYTES = 4096;

/** @typedef {{ pid: number, ppid: number, cpuMs: number, privateBytes: number, workingBytes: number }} Row */

/** The rows of Win32_Process as ConvertTo-Json gives them (one object alone, or a list). @returns {Row[]} */
export function parseWindowsRows(text) {
  const data = JSON.parse(String(text || 'null'));
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.map((p) => ({
    pid: Number(p.ProcessId), ppid: Number(p.ParentProcessId),
    cpuMs: (Number(p.KernelModeTime) + Number(p.UserModeTime)) * WIN_TICK_MS,
    privateBytes: Number(p.PrivatePageCount) || 0, workingBytes: Number(p.WorkingSetSize) || 0,
  })).filter((r) => Number.isFinite(r.pid) && Number.isFinite(r.cpuMs));
}

/**
 * One process from /proc/<pid>/stat (the name can hold spaces and brackets, so the fields
 * are read after its last bracket) and /proc/<pid>/status (RssAnon: memory of its own).
 * @returns {Row | null}
 */
export function parseLinuxProcess(stat, status) {
  const end = String(stat).lastIndexOf(')');
  if (end < 0) return null;
  const pid = Number(String(stat).slice(0, String(stat).indexOf(' ')));
  const f = String(stat).slice(end + 2).split(' ');
  // After the name: state ppid ... utime is the 12th, stime the 13th, rss the 22nd.
  const kb = (name) => Number((String(status).match(new RegExp(`^${name}:\\s+(\\d+)`, 'm')) || [])[1]) || 0;
  return { pid, ppid: Number(f[1]), cpuMs: (Number(f[11]) + Number(f[12])) * LINUX_TICK_MS, privateBytes: kb('RssAnon') * 1024, workingBytes: Number(f[21]) * PAGE_BYTES };
}

/** The process and every process under it. @param {Row[]} rows */
export function treeOf(rows, root) {
  const kids = new Map();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) || []), r]);
  const out = [];
  const todo = rows.filter((r) => r.pid === root);
  while (todo.length) {
    const r = todo.pop();
    if (out.includes(r)) continue;
    out.push(r);
    todo.push(...(kids.get(r.pid) || []).filter((k) => k.pid !== r.pid));
  }
  return out;
}

/**
 * The tree's cost between two looks: share of one core, and memory at the second look. A
 * process that started between the looks counts all its time; one that ended counts none.
 * @param {Row[]} before @param {Row[]} after
 */
export function usageBetween(before, after, ms) {
  const was = new Map(before.map((r) => [r.pid, r.cpuMs]));
  const cpuMs = after.reduce((sum, r) => sum + Math.max(0, r.cpuMs - (was.get(r.pid) ?? 0)), 0);
  const sum = (k) => after.reduce((s, r) => s + r[k], 0);
  return {
    processes: after.length,
    corePercent: ms > 0 ? Math.round((cpuMs / ms) * 1000) / 10 : 0,
    privateMb: Math.round(sum('privateBytes') / MB),
    workingMb: Math.round(sum('workingBytes') / MB),
  };
}

const WIN_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,PrivatePageCount,WorkingSetSize | ConvertTo-Json -Compress';

function windowsRows() {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_QUERY], { windowsHide: true, maxBuffer: 64 * MB }, (err, out) => {
      if (err) reject(err); else resolve(parseWindowsRows(out));
    });
  });
}

function linuxRows() {
  const rows = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const row = parseLinuxProcess(readFileSync(`/proc/${name}/stat`, 'utf8'), readFileSync(`/proc/${name}/status`, 'utf8'));
      if (row) rows.push(row);
    } catch { /* gone between the list and the read */ }
  }
  return rows;
}

/** Every process on this machine, as rows. Windows and Linux. */
export async function processRows(platform = process.platform) {
  if (platform === 'win32') return windowsRows();
  if (platform === 'linux') return linuxRows();
  throw new Error(`no process reader for ${platform}`);
}
