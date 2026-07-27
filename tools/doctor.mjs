#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// doctor.mjs — "does Xenon actually work on this machine?"
//
// Everything in the macOS and Linux port was written against each tool's
// documented behaviour and unit-tested where it is pure. None of it has been
// run on real hardware. This closes that gap in one command: it calls the real
// collectors, checks what they return against the contract server.js consumes
// (tools/doctor-checks.mjs — unit-tested, so the checker is not itself a guess),
// and prints what works, what is absent-but-supported, and what is broken.
//
// It is READ-ONLY. It starts nothing, installs nothing, changes no setting. The
// backend probe is a plain GET against a server that is already running; if
// none is, that is reported, not fixed.
//
//   npm run doctor
//   npm run doctor -- --capture ./caps    also save each tool's raw output, so
//                                          the synthetic test fixtures can be
//                                          replaced with real ones
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as checks from './doctor-checks.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PLATFORM = process.platform;
// A rehearsal switch, not a feature. This repo is developed on Windows, and a
// diagnostic nobody has ever executed is exactly the thing it exists to prevent;
// forcing a platform runs the whole script so the plumbing gets exercised. Every
// reading it produces is meaningless — it says so, loudly, before it starts.
const FORCED = process.env.XENON_DOCTOR_FORCE || '';
const PLAT = FORCED || REAL_PLATFORM;
const PORT = 3030;

const args = process.argv.slice(2);
const captureIdx = args.indexOf('--capture');
const CAPTURE_DIR = captureIdx >= 0 ? path.resolve(args[captureIdx + 1] || 'xenon-capture') : null;

const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[90m', head: '\x1b[36m', off: '\x1b[0m' }
  : { ok: '', warn: '', bad: '', dim: '', head: '', off: '' };

const MARK = { ok: `${C.ok}  ok  ${C.off}`, warn: `${C.warn} warn ${C.off}`, fail: `${C.bad} FAIL ${C.off}` };
const tally = { ok: 0, warn: 0, fail: 0 };

function section(title) { console.log(`\n${C.head}── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}${C.off}`); }

function report(name, result, ms) {
  tally[result.level]++;
  const took = ms === undefined ? '' : `${C.dim} ${ms}ms${C.off}`;
  console.log(`${MARK[result.level]} ${name.padEnd(22)} ${result.summary}${took}`);
  for (const n of result.notes || []) console.log(`       ${C.dim}${n}${C.off}`);
}

function run(cmd, cmdArgs, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

async function which(bin) {
  // Keyed on the REAL platform: under the rehearsal switch the script pretends
  // to be elsewhere, but the machine looking things up is still this one.
  const out = await run(REAL_PLATFORM === 'win32' ? 'where' : '/usr/bin/which', [bin], 5000);
  return out ? out.split(/\r?\n/)[0].trim() : null;
}

// Time a collector and route whatever it produced (or threw) through its check.
async function probe(name, fn, check, ...rest) {
  const t = Date.now();
  let value;
  try {
    value = await fn();
  } catch (e) {
    report(name, { level: 'fail', summary: `threw: ${e && e.message ? e.message : e}`, notes: [] }, Date.now() - t);
    return null;
  }
  report(name, check(value, ...rest), Date.now() - t);
  return value;
}

async function capture(file, cmd, cmdArgs) {
  if (!CAPTURE_DIR) return;
  const out = await run(cmd, cmdArgs, 20000);
  if (out === null) { console.log(`       ${C.dim}capture ${file}: ${cmd} failed${C.off}`); return; }
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, file), out);
  console.log(`       ${C.dim}captured ${file} (${out.length} bytes)${C.off}`);
}

// ── 1) The machine ──────────────────────────────────────────────────────────
section('This machine');
console.log(`       ${REAL_PLATFORM} ${process.arch}, node ${process.version}`);
if (FORCED) {
  console.log(`
${C.warn}  REHEARSAL: forced to "${FORCED}" on a ${REAL_PLATFORM} machine.${C.off}`);
  console.log(`${C.dim}  This proves the script runs end to end. Every reading below is meaningless.${C.off}`);
}

if (PLAT === 'win32') {
  console.log(`\n${C.warn}  This diagnostic covers the macOS and Linux collectors.${C.off}`);
  console.log(`${C.dim}  On Windows the sensors run through pwsh-worker.ps1 and the helper, which have${C.off}`);
  console.log(`${C.dim}  their own paths and are exercised by the app itself. Nothing was checked.${C.off}\n`);
  process.exit(0);
}

const TOOLS = PLAT === 'darwin'
  ? [['node', true], ['perl', false], ['ffmpeg', false], ['macmon', false], ['SwitchAudioSource', false], ['unzip', false]]
  // busctl and xprop are listed because a whole feature turns on each: busctl
  // is the no-install MPRIS reader, xprop is the foreground/game probe. Both
  // are ordinarily present (systemd, x11-utils), which is exactly why their
  // absence is worth naming rather than leaving as a silently dead tile.
  : [['node', true], ['ffmpeg', false], ['nvidia-smi', false], ['wpctl', false],
     ['busctl', false], ['playerctl', false], ['xprop', false], ['wmctrl', false],
     ['mangohud', false], ['gio', false], ['unzip', false]];

for (const [bin, required] of TOOLS) {
  const at = await which(bin);
  if (at) report(bin, { level: 'ok', summary: at, notes: [] });
  else report(bin, { level: required ? 'fail' : 'warn', summary: 'not on PATH', notes: [] });
}

// ── 2) The collectors ───────────────────────────────────────────────────────
section('Collectors (what the tiles read)');
const collectors = require(path.join(ROOT, 'server', PLAT === 'darwin' ? 'darwin-collectors.js' : 'linux-collectors.js'));

await probe('disks', () => collectors.disks(), checks.checkDisks);
// The sensor collectors never block the request path: they answer from a TTL
// cache and refresh BEHIND the answer, so the very first call on both platforms
// returns the empty sample by design. Probing once read that as "no load or
// temperature" and printed three lines of remediation on a machine where both
// work — measured on an M2, where the helper reports GPU load the first call
// could not see. So ask once to prime it, then time the reading that counts.
await collectors.gpu().catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
await probe('gpu', () => collectors.gpu(), checks.checkGpu);
await probe('cpu temperature', () => collectors.cpuTemp(), checks.checkCpuTemp);
await probe('network', () => collectors.network(), checks.checkNetwork);
await probe('open applications', () => collectors.windows('list'), checks.checkWindows);
await probe('audio devices', () => collectors.audioRows(), checks.checkAudioRows);

// ── 3) Now playing ──────────────────────────────────────────────────────────
{
  section('Now playing');
  const host = PLAT === 'darwin'
    ? require(path.join(ROOT, 'server', 'darwin-media.js')).createDarwinMedia({ dir: path.join(ROOT, 'server', 'mediaremote') })
    : require(path.join(ROOT, 'server', 'linux-media.js')).createLinuxMedia({});
  const missing = PLAT === 'darwin'
    ? {
        name: 'mediaremote-adapter',
        notes: [
          'server/mediaremote/ has no adapter, so the media tile stays empty.',
          'server/install.sh downloads it; it only exists on releases built after this feature shipped.',
        ],
      }
    : {
        // Reaching this on Linux now means BOTH transports are gone, which is
        // why the note names busctl: playerctl being absent is ordinary and no
        // longer costs anything, but a machine without busctl either has no
        // systemd — and Xenon's own autostart would not work there.
        name: 'MPRIS reader',
        notes: [
          'Neither playerctl nor busctl is available, so nothing can read MPRIS and the media tile stays empty.',
          'busctl ships with systemd; playerctl is optional (`sudo dnf install playerctl` / `sudo apt install playerctl`) and only makes updates instant instead of polled.',
        ],
      };
  if (!host.available()) {
    report(missing.name, { level: 'warn', summary: 'not installed', notes: missing.notes });
  } else {
    host.start();
    // The adapter streams on CHANGE, so a first read right after start has
    // nothing yet. Give it a moment before judging.
    await new Promise((r) => setTimeout(r, 2500));
    await probe('now playing', async () => host.info(), checks.checkMedia, true);
    host.stop();
  }
}

// ── 4) The backend ──────────────────────────────────────────────────────────
section('Backend');
async function get(pathname) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}${pathname}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { body: await res.json() };
  } catch (e) {
    return { error: e && e.message ? e.message : String(e) };
  }
}

const version = await get('/version');
if (version.error) {
  report('server on :3030', {
    level: 'warn',
    summary: `not answering (${version.error})`,
    notes: ['Nothing was started. Run `bash server/install.sh`, or `npm start` to try it in the foreground.'],
  });
} else {
  report('server on :3030', { level: 'ok', summary: `version ${version.body && version.body.version}`, notes: [] });
  const sys = await get('/system');
  if (sys.error) report('/system', { level: 'fail', summary: sys.error, notes: [] });
  else {
    const s = sys.body || {};
    const mem = s.memory && typeof s.memory === 'object' ? s.memory : null;
    const notes = [
      `cpu ${typeof s.cpu === 'number' ? s.cpu + '%' : '--'}  (${s.cpuName || 'unnamed'})`,
      `ram ${mem && typeof mem.percent === 'number' ? mem.percent + '%' : '--'}`,
      `gpu ${typeof s.gpu === 'number' ? s.gpu + '%' : '--'}  temp ${typeof s.cpuTemp === 'number' ? s.cpuTemp + '°C' : '--'}`,
      `disks: ${Array.isArray(s.disks) ? s.disks.length : 0}`,
    ];
    // The tiles read these exact fields, so a live server that answers with a
    // shape the widgets cannot use is worse than one that is down.
    const broken = [];
    if (s.memory !== undefined && !mem) broken.push('memory is present but not an object');
    if (s.disks !== undefined && !Array.isArray(s.disks)) broken.push('disks is present but not an array');
    if (broken.length) report('/system', { level: 'fail', summary: 'the payload does not match what the tiles read', notes: broken });
    else report('/system', { level: typeof s.cpu === 'number' ? 'ok' : 'warn', summary: typeof s.cpu === 'number' ? 'reporting' : 'no cpu figure', notes });
  }
}

// ── 5) The login service ────────────────────────────────────────────────────
section('Starts at login');
if (PLAT === 'darwin') {
  const plist = path.join(process.env.HOME || '', 'Library/LaunchAgents/com.marcimastro98.xenon.backend.plist');
  if (!fs.existsSync(plist)) report('LaunchAgent', { level: 'warn', summary: 'not installed', notes: ['Run `bash server/install.sh`.'] });
  else {
    const list = await run('/bin/launchctl', ['list'], 8000);
    const loaded = list && /com\.marcimastro98\.xenon\.backend/.test(list);
    report('LaunchAgent', { level: loaded ? 'ok' : 'warn', summary: loaded ? 'installed and loaded' : 'installed but not loaded', notes: [plist] });
  }
} else {
  const cfg = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config');
  const unit = path.join(cfg, 'systemd/user/xenon-backend.service');
  const autostart = path.join(cfg, 'autostart/xenon-backend.desktop');
  if (fs.existsSync(unit)) {
    const active = await run('systemctl', ['--user', 'is-active', 'xenon-backend.service'], 8000);
    const state = (active || '').trim();
    report('systemd --user unit', { level: state === 'active' ? 'ok' : 'warn', summary: state || 'not reported', notes: [unit] });
  } else if (fs.existsSync(autostart)) {
    report('XDG autostart', { level: 'warn', summary: 'the fallback entry is installed', notes: [autostart, 'This path has no crash-restart: it only fires at login.'] });
  } else {
    report('login service', { level: 'warn', summary: 'not installed', notes: ['Run `bash server/install.sh`.'] });
  }
}

// ── 6) Capture (opt-in) ─────────────────────────────────────────────────────
if (CAPTURE_DIR) {
  section(`Capturing raw output to ${CAPTURE_DIR}`);
  console.log(`       ${C.dim}These replace the synthetic fixtures in server/test/fixtures/.${C.off}`);
  if (PLAT === 'darwin') {
    await capture('darwin-df.txt', 'df', ['-k', '-P']);
    await capture('darwin-mount.txt', 'mount', []);
    await capture('darwin-netstat-ib.txt', 'netstat', ['-ib']);
    await capture('darwin-displays.json', 'system_profiler', ['SPDisplaysDataType', '-json']);
    await capture('darwin-audio.json', 'system_profiler', ['SPAudioDataType', '-json']);
    if (await which('macmon')) await capture('darwin-macmon.jsonl', 'macmon', ['pipe', '-s', '1']);
  } else {
    await capture('linux-df.txt', 'df', ['-k', '-P']);
    await capture('linux-proc-net-dev.txt', 'cat', ['/proc/net/dev']);
    if (await which('nvidia-smi')) await capture('linux-nvidia-smi.txt', 'nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name', '--format=csv,noheader,nounits']);
    if (await which('wpctl')) await capture('linux-wpctl-status.txt', 'wpctl', ['status']);
  }
}

// ── Verdict ─────────────────────────────────────────────────────────────────
section('Result');
console.log(`       ${tally.ok} ok, ${tally.warn} absent-but-supported, ${tally.fail} broken\n`);
if (tally.fail) {
  console.log(`${C.bad}  Something above the seam will misread this machine.${C.off}`);
  console.log(`${C.dim}  The FAIL lines say exactly which contract is not met — that is the bug report.${C.off}\n`);
}
// `process.exitCode`, never `process.exit()`. Tearing the loop down while the
// fetch timeouts and child-process handles are still settling aborts libuv on
// Windows (observed: "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"),
// which replaces the exit code with a crash — and the exit code is the whole
// point of a diagnostic something else might run.
process.exitCode = tally.fail ? 1 : 0;
