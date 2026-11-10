#!/usr/bin/env node
// Times one Living Index build: starts the helper's index-serve on the given
// roots, waits for "ready", and prints the CPU the walk cost, the peak memory,
// what the index holds and a digest of it. Two exes on the same root must give
// the same digest; that is how a change to the walk proves it changed nothing.
//
//   node tools/perf/index-walk.mjs [--exe path\to\xenon-helper.exe] [--runs N] <root> [root ...]
//
// Windows only (the helper is). It never touches the running helper: it starts
// its own copy and closes it at the end.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function parseArgs(argv) {
  const out = { exe: path.join(REPO, 'server', 'helper', 'xenon-helper.exe'), runs: 1, roots: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe') out.exe = argv[++i];
    else if (argv[i] === '--runs') out.runs = Math.max(1, Number(argv[++i]) || 1);
    else out.roots.push(argv[i]);
  }
  return out;
}

// One stdout line from the host: "XEIDX " + base64 JSON, anything else ignored.
export function decodeLine(line) {
  if (!line.startsWith('XEIDX ')) return null;
  try { return JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); } catch { return null; }
}

function processFigures(pid) {
  const ps = `$p = Get-Process -Id ${Number(pid)}; [string]::Format([cultureinfo]::InvariantCulture, '{0} {1} {2} {3}', $p.TotalProcessorTime.TotalSeconds, $p.PrivilegedProcessorTime.TotalSeconds, $p.PeakWorkingSet64, $p.PeakPagedMemorySize64)`;
  const [cpu, kernel, peakWs, peakPrivate] = execFileSync('powershell.exe', ['-NoProfile', '-c', ps]).toString().trim().split(' ').map(Number);
  return { cpuS: cpu, kernelS: kernel, peakWsMB: Math.round(peakWs / 1048576), peakPrivateMB: Math.round(peakPrivate / 1048576) };
}

async function runOnce(exe, roots) {
  const child = spawn(exe, ['index-serve', ...roots], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let ready;
  const readyP = new Promise((r) => { ready = r; });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const msg = decodeLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
      if (!msg) continue;
      if (msg.event === 'ready') ready();
      else if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    }
  });
  let next = 1;
  const ask = (op, extra = {}) => new Promise((resolve) => {
    const id = next++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ id, op, ...extra }) + '\n');
  });
  const started = Date.now();
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await Promise.race([readyP, exited.then(() => { throw new Error('index-serve exited before ready'); })]);
    const wallS = (Date.now() - started) / 1000;
    const figures = processFigures(child.pid);
    const stats = await ask('stats');
    const hash = createHash('sha256');
    for (const root of roots) {
      hash.update(JSON.stringify((await ask('sizes', { path: root })).dirs || []));
      hash.update(JSON.stringify((await ask('top', { path: root, max: 500 })).items || []));
    }
    return { wallS, ...figures, files: stats.files, dirs: stats.dirs, bytes: stats.bytes, ramMB: stats.ramMB, digest: hash.digest('hex').slice(0, 16) };
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}

async function main() {
  const { exe, runs, roots } = parseArgs(process.argv.slice(2));
  if (process.platform !== 'win32') throw new Error('the helper runs on Windows only');
  if (!roots.length) throw new Error('usage: index-walk.mjs [--exe path] [--runs N] <root> [root ...]');
  for (let i = 0; i < runs; i++) {
    const r = await runOnce(exe, roots);
    console.log(`run ${i + 1}: cpu ${r.cpuS.toFixed(1)} s (kernel ${r.kernelS.toFixed(1)}), wall ${r.wallS.toFixed(1)} s, peak ${r.peakPrivateMB} MB private / ${r.peakWsMB} MB ws, after ${r.ramMB} MB | ${r.files} files ${r.dirs} dirs ${r.bytes} bytes | digest ${r.digest}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
