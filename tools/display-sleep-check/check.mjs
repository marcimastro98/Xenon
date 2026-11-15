#!/usr/bin/env node
// Screens off and on in a loop with Xenon running, and after each wake what Windows
// logged: display driver resets (TDR, event 4101 and LiveKernelEvent 117/141/193),
// crashes, new kernel live dumps, and Xenon windows that stopped answering. A
// recorder writes down every screens on/off Windows announces, so each cycle also
// says whether the screens really went off. Made for a report of a PC that froze
// when its screens woke up while Xenon ran.
//
//   node tools/display-sleep-check/check.mjs [--idle] [--cycles 5] [--off 90] [--settle 20] [--out <folder>]
//
// Default: the screens are switched off at once (SC_MONITORPOWER). --idle lets the
// real idle timer do it instead: the display timeout on mains power is set to one
// minute for the run and put back at the end (also on Ctrl+C); with no input the
// screens go off after that minute and stay off for --off seconds.
//
// Windows only. It blanks every screen: say so before running it on someone's PC,
// and nobody may touch mouse or keyboard meanwhile. Kernel live dumps are listed
// only when the folder is readable (an elevated shell).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { IDLE_TIMEOUT_S, acIndexOf, cycleResult, newReports, parseArgs, screenStates, summary, wentOff } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sys32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
const powershell = path.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const psArgs = (action, extra) => ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(here, 'power.ps1'), '-Action', action, ...extra];

function power(action, extra = []) {
  const out = execFileSync(powershell, psArgs(action, extra), { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return JSON.parse(out.trim() || 'null');
}

const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const powercfg = (...args) => execFileSync(path.join(sys32, 'powercfg.exe'), args, { encoding: 'utf8', windowsHide: true });

function setDisplayTimeout(seconds) {
  powercfg('/setacvalueindex', 'SCHEME_CURRENT', 'SUB_VIDEO', 'VIDEOIDLE', String(seconds));
  powercfg('/setactive', 'SCHEME_CURRENT');
}

async function oneCycle(n, opts, before, recorded) {
  const startedMs = Date.now();
  if (opts.idle) {
    console.log(`cycle ${n}: waiting for the idle timer (${IDLE_TIMEOUT_S} s), then ${opts.offSeconds} s off`);
    await sleep((IDLE_TIMEOUT_S + opts.offSeconds) * 1000);
  } else {
    console.log(`cycle ${n}: screens off for ${opts.offSeconds} s`);
    power('off');
    await sleep(opts.offSeconds * 1000);
  }
  const wokeMs = Date.now();
  power('wake');
  await sleep(opts.settleSeconds * 1000);
  const events = asList(power('events', ['-SinceMs', String(startedMs)]));
  const after = power('reports');
  const hung = power('hung');
  const result = cycleResult({ events, reports: newReports(before.files, after.files), hung: asList(hung.hung), sinceMs: startedMs });
  const off = wentOff(screenStates(fs.existsSync(recorded) ? fs.readFileSync(recorded, 'utf8') : ''), startedMs, wokeMs);
  console.log(`cycle ${n}: screens went off: ${off}; ${result.ok ? 'clean' : 'TRACE'} ${JSON.stringify({ findings: result.findings, reports: result.reports, hung: result.hung })}`);
  return { result: { cycle: n, at: new Date(startedMs).toISOString(), screensWentOff: off, ...result }, reports: after };
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const opts = parseArgs(process.argv.slice(2));
  const outDir = opts.out || path.join(os.tmpdir(), 'xenon-display-sleep-check');
  fs.mkdirSync(outDir, { recursive: true });
  const recorded = path.join(outDir, `screens-${Date.now()}.txt`);
  const perCycle = (opts.idle ? IDLE_TIMEOUT_S : 0) + opts.offSeconds + opts.settleSeconds + 30;
  const recorder = spawn(powershell, psArgs('watch', ['-Out', recorded, '-Seconds', String(opts.cycles * perCycle + 60)]), { windowsHide: true, stdio: 'ignore' });
  const before = opts.idle ? acIndexOf(powercfg('/q', 'SCHEME_CURRENT', 'SUB_VIDEO', 'VIDEOIDLE')) : null;
  const restore = () => { if (before !== null) setDisplayTimeout(before); };
  process.once('SIGINT', () => { restore(); process.exit(130); });
  let reports = power('reports');
  if (!reports.readable) console.log(`kernel live dumps not readable (${reports.error}); run elevated to list them`);
  const results = [];
  try {
    if (opts.idle) setDisplayTimeout(IDLE_TIMEOUT_S);
    for (let n = 1; n <= opts.cycles; n++) {
      const step = await oneCycle(n, opts, reports, recorded);
      results.push(step.result);
      reports = step.reports;
    }
  } finally {
    restore();
    power('wake');
    recorder.kill();
    const file = path.join(outDir, `report-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ opts, displayTimeoutBefore: before, results, summary: summary(results) }, null, 2));
    console.log(`${summary(results)}; display timeout put back to ${before ?? 'untouched'}; report: ${file}`);
  }
}

main().catch((err) => { console.error(err.message); process.exitCode = 1; });
