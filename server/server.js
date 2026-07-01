/*
 * Xenon — Copyright (c) 2026 Marcello Mastroeni (marcimastro98).
 * Custom non-commercial license. Personal use only; no commercial use or
 * redistribution as your own. Attribution required. See LICENSE for terms.
 */
const http = require('http');
const { exec, execFile, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const fpsMonitor = require('./fpsmon');
const gameDetect = require('./gamedetect');
// Windowed-game detection: the fullscreen heuristic misses borderless/windowed
// titles, so the game detector also gets PresentMon's busiest flip-model
// presenter as a hint — when it matches the focused window, that's a game.
gameDetect.setGameHint(() => fpsMonitor.getGamingProcess());
const lighting = require('./lighting');
const deckStore = require('./js/deck-store'); // pure per-instance Deck merge helpers (shared with the client + tests)
const aiLocal = require('./ai-local');
const { createGuardian } = require('./guardian');
const icsFeeds = require('./ics-feeds.js');
const { createRegistry } = require('./actions/registry');
const { createPerfRegistry } = require('./actions/perf-registry');
const { createObs, scenePreviewRequest } = require('./actions/obs');
const { createStreamerbot } = require('./actions/streamerbot');
const { createEmbeddedBrowser } = require('./embedded-browser');
const { createSecondScreen } = require('./second-screen');
const { createScreenCapture } = require('./screen-capture');
const obsLaunch = require('./actions/obs-launch');
const { normalizeRemoteControl, preserveRemoteCreds, redactRemoteCreds } = require('./remote-control/settings');
const { createRemoteControl } = require('./remote-control');
const { createSelfUpdate } = require('./self-update');
const { createTwitchProvider } = require('./stream-twitch');
const { createYouTubeProvider } = require('./stream-youtube');

// App version — read once from package.json so the in-app indicator always
// matches the shipped build. Falls back gracefully if the file is unreadable.
let APP_VERSION = '';
// Normalize away a stray leading "v" so the reported version is always plain
// semver (e.g. "3.2.6"). A "v"-prefixed package.json version once shipped and
// broke self-update: the staged build's "v3.2.6" never equalled the normalized
// release tag "3.2.6", so prepare failed with version_mismatch (and the modal
// showed "from vv3.2.4"). Stripping here keeps /version and /update/check clean
// regardless of what package.json holds.
try { APP_VERSION = String(require('../package.json').version || '').trim().replace(/^v/i, ''); } catch {}

// ── Update check ──────────────────────────────────────────────────────────────
// Soft probe of the latest GitHub release so the dashboard can show a discreet
// "update available" hint in Settings. No token, never auto-downloads, and
// fail-silent: any network/API problem just means "no hint" until the next
// probe window. One probe serves every open dashboard.
const UPDATE_REPO = 'marcimastro98/Xenon';
const UPDATE_CHECK_TTL = 24 * 60 * 60 * 1000;   // reuse a successful probe for a day
const UPDATE_CHECK_RETRY = 60 * 60 * 1000;      // a failed probe retries after an hour
const UPDATE_NOTES_MAX = 8000;                  // cap the release-notes body we keep/serve
let _updateCache = { at: 0, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '' };
const { parseSemver, semverNewer } = require('./semver');

// Probe the latest GitHub release. `force` bypasses the cache (the manual
// "check now" button); otherwise a successful probe is reused for a day.
async function checkLatestRelease(force) {
  const now = Date.now();
  const ttl = _updateCache.ok ? UPDATE_CHECK_TTL : UPDATE_CHECK_RETRY;
  if (!force && _updateCache.at && now - _updateCache.at < ttl) return _updateCache;
  _updateCache = { at: now, ok: false, latest: '', tag: '', url: '', notes: '', name: '', publishedAt: '' };
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'XenonEdgeHub', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const rel = await res.json();
      const tag = String((rel && rel.tag_name) || '');
      if (parseSemver(tag)) {
        _updateCache = {
          at: now, ok: true, latest: tag.replace(/^v/i, ''), tag,
          url: String((rel && rel.html_url) || `https://github.com/${UPDATE_REPO}/releases/latest`),
          notes: String((rel && rel.body) || '').slice(0, UPDATE_NOTES_MAX),
          name: String((rel && rel.name) || tag),
          publishedAt: String((rel && rel.published_at) || ''),
        };
      }
    }
  } catch { /* offline / rate-limited — retry next window */ }
  return _updateCache;
}

let isMuted = false;
let cachedSpeakerId   = null; // full CLI ID — for SetDefault
let cachedSpeakerName = null; // short endpoint name — for SetVolume/ToggleMute
let cachedMicId       = null;
let cachedMicLabel    = null; // friendly name (F.NAME) used to match DirectShow devices
let _lastSpeakerVolume = 50;  // updated by getAudioInfo — used for duck/restore
let _duckActive        = false;
let _duckSavedVolume   = null;
let _aiFocusedScreen   = null; // last monitor the AI captured — its "focus" for follow-ups

const SVV = path.join(__dirname, 'soundvolumeview-x64', 'SoundVolumeView.exe');
const MEDIA_SCRIPT = path.join(__dirname, 'media.ps1');
// Xenon Helper — optional native companion exe (built from helper/, or shipped
// with the release). When present it replaces the persistent PowerShell hosts
// module by module; when absent everything runs on the PS scripts as before.
const HELPER_EXE = path.join(__dirname, 'helper', 'xenon-helper.exe');
const CPU_TEMP_SCRIPT = path.join(__dirname, 'cpu-temp.ps1');
const GPU_SCRIPT = path.join(__dirname, 'gpu.ps1');
const NETWORK_SCRIPT = path.join(__dirname, 'network.ps1');
const WINDOWS_SCRIPT = path.join(__dirname, 'windows.ps1');
const DECK_ACTIONS_SCRIPT = path.join(__dirname, 'deck-actions.ps1');
const DECK_HOTKEY_SCRIPT = path.join(__dirname, 'deck-hotkey.ps1');
const PERFORMANCE_SCRIPT = path.join(__dirname, 'performance.ps1');
const PERF_PRIORITY_SCRIPT = path.join(__dirname, 'perf-priority.ps1');
// All runtime user data (settings, notes, calendar, tasks, timers, deck, uploads,
// streaming config/tokens) lives in a single DATA_DIR instead of being scattered
// loose in server/. Tool binaries (presentmon/, whisper/, vendor/, …) stay put.
const DATA_DIR = path.join(__dirname, 'data');
const NOTES_FILE = path.join(DATA_DIR, 'notes.txt');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const TASKS_MAX = 100;
const TIMERS_FILE = path.join(DATA_DIR, 'timers.json');
const TIMERS_MAX = 20;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DECK_FILE = path.join(DATA_DIR, 'deck.json');
const STREAM_CONFIG_FILE = path.join(DATA_DIR, 'stream-config.json');
const STREAM_TOKENS_FILE = path.join(DATA_DIR, 'stream-tokens.json');
// Deck configs hold image-icon data URLs (up to ~1.5 MB each), so the store can
// run to several MB across many keys; cap generously to bound disk use.
const DECK_MAX_BYTES = 8 * 1024 * 1024;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// One-time migration: earlier versions stored runtime data loose in server/.
// Move any legacy files/dirs into DATA_DIR so existing installs keep their data.
// Runs synchronously at startup, before anything reads these paths. Skips a file
// when the new copy already exists, so it never clobbers current data.
(function migrateLegacyData() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  const moves = [
    [path.join(__dirname, 'notes.txt'), NOTES_FILE],
    [path.join(__dirname, 'events.json'), EVENTS_FILE],
    [path.join(__dirname, 'tasks.json'), TASKS_FILE],
    [path.join(__dirname, 'timers.json'), TIMERS_FILE],
    [path.join(__dirname, 'settings.json'), SETTINGS_FILE],
    [path.join(__dirname, 'deck.json'), DECK_FILE],
    [path.join(__dirname, 'stream-config.json'), STREAM_CONFIG_FILE],
    [path.join(__dirname, 'stream-tokens.json'), STREAM_TOKENS_FILE],
    [path.join(__dirname, 'uploads'), UPLOADS_DIR],
  ];
  for (const [oldPath, newPath] of moves) {
    try {
      if (!fs.existsSync(oldPath) || fs.existsSync(newPath)) continue;
      fs.renameSync(oldPath, newPath);
    } catch {
      // Locked file or cross-device move: fall back to copy + best-effort remove.
      try {
        fs.cpSync(oldPath, newPath, { recursive: true });
        fs.rmSync(oldPath, { recursive: true, force: true });
      } catch (copyErr) {
        console.error(`[data-migration] could not move ${oldPath}:`, copyErr.message);
      }
    }
  }
})();
const BACKGROUND_MAX_BYTES = 200 * 1024 * 1024;
const BACKGROUND_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;
const SETTINGS_MIN_PANEL_ALPHA = 0.18;
const BACKGROUND_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);
const BACKGROUND_EXT_BY_MIME = new Map([...BACKGROUND_MIME_BY_EXT.entries()].map(([ext, mime]) => [mime, ext]));

// CSV column indices for SoundVolumeView /scomma (no header row)
const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// Persistent icon cache keyed by process exe path — avoids repeated PowerShell spawns.
// Bounded LRU (oldest evicted past the cap) so a long-running session that sees
// many distinct executables can't grow it without limit — mirrors artworkCache.
const appIconCache = new Map();
const APP_ICON_CACHE_MAX = 200;
function setAppIcon(key, value) {
  if (appIconCache.size >= APP_ICON_CACHE_MAX && !appIconCache.has(key)) {
    appIconCache.delete(appIconCache.keys().next().value);
  }
  appIconCache.set(key, value);
}

function parseJsonOutput(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON output');
  return JSON.parse(stdout.slice(start, end + 1));
}

function powerShellUtf8Command(command) {
  return `$utf8NoBom = New-Object System.Text.UTF8Encoding $false; [Console]::OutputEncoding = $utf8NoBom; $OutputEncoding = $utf8NoBom; ${command}`;
}

function runPowerShellScript(script, args = [], timeout = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let resolvedEarly = false;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // Resolve the promise as soon as we have valid JSON, but DO NOT kill the
    // PowerShell process — let it exit on its own so WinRT/COM handles (SMTC
    // session, thumbnail stream, DataReader, …) get released cleanly. Killing
    // mid-flight is what leaks broker handles and eventually wedges Windows
    // shutdown.
    const finishOk = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const finishErr = err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed && child.exitCode === null) child.kill();
      reject(err);
    };

    const resolveIfJsonReady = () => {
      if (resolvedEarly) return;
      if (!stdout.trimEnd().endsWith('}')) return;
      try {
        const value = parseJsonOutput(stdout);
        resolvedEarly = true;
        finishOk(value);
      } catch { }
    };

    const timer = setTimeout(() => {
      try { finishOk(parseJsonOutput(stdout)); }
      catch { finishErr(new Error(stderr || `PowerShell timeout: ${path.basename(script)}`)); }
    }, timeout);

    child.stdout.on('data', chunk => { stdout += chunk; resolveIfJsonReady(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', e => finishErr(e));
    child.on('close', code => {
      if (settled) return;
      try { finishOk(parseJsonOutput(stdout)); }
      catch (e) { finishErr(new Error(stderr || e.message || `PowerShell exited with ${code}`)); }
    });
  });
}

// One-shot run of the native helper (e.g. `xenon-helper windows list`). Unlike
// the persistent media/foreground hosts this spawns per request — the trimmed
// native exe starts in tens of ms, versus ~1s of PowerShell engine start plus
// an Add-Type C# compile for windows.ps1 — which is what makes the Apps panel
// open near-instantly. Resolves the parsed JSON from stdout, rejects on any
// problem so the caller can fall back to the PowerShell path.
function runHelperOneShot(args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(HELPER_EXE, args, { windowsHide: true }); }
    catch (e) { reject(e); return; }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => {
      try { if (!child.killed) child.kill(); } catch { }
      finish(reject, new Error('helper timeout'));
    }, timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', e => finish(reject, e));
    child.on('close', code => {
      if (code !== 0) { finish(reject, new Error(stderr || `helper exited with ${code}`)); return; }
      try { finish(resolve, parseJsonOutput(stdout)); }
      catch (e) { finish(reject, e); }
    });
  });
}

// App-switcher windows tool: prefer the native helper when the exe exists, fall
// back to windows.ps1 transparently on ANY helper problem (missing, crashed,
// bad output) — the PowerShell path is the permanent safety net.
async function runWindowsTool(args, timeout) {
  if (fs.existsSync(HELPER_EXE)) {
    try { return await runHelperOneShot(['windows', ...args], timeout); }
    catch { /* fall through to the PowerShell path */ }
  }
  return runPowerShellScript(WINDOWS_SCRIPT, args, timeout);
}

function runPowerShellCommand(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShellUtf8Command(command)], {
      timeout,
      windowsHide: true,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); return; }
      try { resolve(parseJsonOutput(stdout)); }
      catch (e) { reject(e); }
    });
  });
}

// ── "Open dashboard in browser at logon" task ────────────────────────────────
// A per-user Scheduled Task ("Xenon Edge Dashboard") that runs open-dashboard.vbs
// at logon. The server already auto-starts at logon via its own task; this one
// just opens the browser tab for people who use the dashboard in a real browser
// (Xeneon Edge loads the iframe itself, so it never wants this). Registered on
// demand from the client and reflected back so the toggle shows the true state.
const BROWSER_TASK_NAME = 'Xenon Edge Dashboard';
const OPEN_DASHBOARD_VBS = path.join(__dirname, 'open-dashboard.vbs');
const AUTO_OPEN_SUPPORTED = process.platform === 'win32';

function psSingleQuote(value) {
  return String(value).replace(/'/g, "''");
}

// Returns { enabled } reflecting whether the logon task currently exists.
async function getBrowserAutoOpenState() {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false };
  const cmd =
    `$t = Get-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -ErrorAction SilentlyContinue; ` +
    `Write-Output (@{ ok = $true; enabled = [bool]$t } | ConvertTo-Json -Compress)`;
  try {
    const out = await runPowerShellCommand(cmd, 8000);
    return { enabled: out && out.enabled === true };
  } catch {
    return { enabled: false };
  }
}

// Registers (enabled) or removes the logon task. Returns { enabled }.
async function setBrowserAutoOpen(enabled) {
  if (!AUTO_OPEN_SUPPORTED) return { enabled: false };
  let cmd;
  if (enabled) {
    const vbs = psSingleQuote(OPEN_DASHBOARD_VBS);
    cmd =
      `$ErrorActionPreference = 'Stop'; ` +
      `try { ` +
        `$wscript = Join-Path $env:WINDIR 'System32\\wscript.exe'; ` +
        `$user = "$env:USERDOMAIN\\$env:USERNAME"; ` +
        `$action = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + '${vbs}' + '"'); ` +
        `$trigger = New-ScheduledTaskTrigger -AtLogon -User $user; ` +
        // Interactive + Limited so the browser opens in the user's visible session
        // (a SYSTEM/Highest task would open invisibly in session 0).
        `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; ` +
        `$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero); ` +
        `Register-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null; ` +
        `Write-Output '{"ok":true,"enabled":true}' ` +
      `} catch { Write-Output (@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress) }`;
  } else {
    cmd =
      `try { Unregister-ScheduledTask -TaskName '${psSingleQuote(BROWSER_TASK_NAME)}' -Confirm:$false -ErrorAction SilentlyContinue } catch { }; ` +
      `Write-Output '{"ok":true,"enabled":false}'`;
  }
  const out = await runPowerShellCommand(cmd, 12000);
  if (out && out.ok === false) throw new Error(out.error || 'Task registration failed');
  return { enabled: enabled === true };
}

// ── Persistent PowerShell collector worker ───────────────────────────────────
// Spawning powershell.exe per poll (~150ms CLR+engine startup) is the server's
// dominant steady-state CPU cost. This long-lived host runs the read-only sensor
// collectors (gpu / cpu-temp / network) in one process, paying that cost once.
// Only exit-free, SMTC-free scripts go through it — media.ps1 has its own
// dedicated persistent host below (it holds WinRT broker handles and needs
// graceful retirement, while this worker may be hard-killed when wedged).
// Any worker problem falls back transparently to runPowerShellScript, so
// behaviour degrades to the one-shot model and never breaks.
const PWSH_WORKER_SCRIPT = path.join(__dirname, 'pwsh-worker.ps1');
const _worker = { proc: null, buf: '', nextId: 1, pending: new Map() };

function _workerReject(id, err) {
  const p = _worker.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _worker.pending.delete(id);
  p.reject(err);
}

function _killWorker(reason) {
  const proc = _worker.proc;
  _worker.proc = null;
  _worker.buf = '';
  for (const id of [..._worker.pending.keys()]) _workerReject(id, new Error(reason || 'worker down'));
  if (proc) { try { proc.kill(); } catch {} }
}

function _ensureWorker() {
  if (_worker.proc) return _worker.proc;
  let proc;
  try {
    proc = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PWSH_WORKER_SCRIPT],
      { windowsHide: true });
  } catch { return null; }
  _worker.proc = proc;
  _worker.buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _worker.buf += chunk;
    let nl;
    while ((nl = _worker.buf.indexOf('\n')) !== -1) {
      const line = _worker.buf.slice(0, nl).trim();
      _worker.buf = _worker.buf.slice(nl + 1);
      if (!line.startsWith('XEHWK ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _worker.pending.get(env.id);
      if (!p) continue;
      clearTimeout(p.timer);
      _worker.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'worker error'));
    }
  });
  proc.stderr.on('data', () => {}); // collectors trap their own errors; ignore
  proc.on('error', () => _killWorker('worker spawn error'));
  proc.on('exit', () => { if (_worker.proc === proc) _killWorker('worker exited'); });
  proc.unref(); // never keep the event loop alive on the worker's account
  return proc;
}

function runPowerShellWorker(scriptPath, args = [], timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureWorker();
    if (!proc) { reject(new Error('worker unavailable')); return; }
    const id = _worker.nextId++;
    const timer = setTimeout(() => {
      // The worker processes requests serially; a timeout means it is wedged on
      // this one. Reject and kill so the next call gets a fresh host — safe here
      // because these collectors hold no SMTC/WinRT handles (OS reclaims theirs
      // on process death).
      _workerReject(id, new Error('worker timeout'));
      _killWorker('worker timeout');
    }, timeout);
    _worker.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, script: path.basename(scriptPath), args }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _worker.pending.delete(id);
      reject(e);
    }
  });
}

// Run a read-only collector through the persistent worker, falling back to a
// one-shot spawn on any worker problem. Returns the same parsed-JSON object as
// runPowerShellScript, so call sites are unchanged.
async function runCollector(scriptPath, args = [], timeout = 8000) {
  try {
    return parseJsonOutput(await runPowerShellWorker(scriptPath, args, timeout));
  } catch {
    return runPowerShellScript(scriptPath, args, timeout);
  }
}

// ── Persistent SMTC media host ────────────────────────────────────────────────
// media.ps1 used to be spawned one-shot for EVERY media poll (the SSE stream
// broadcasts media every 2s), paying ~150-300ms of CLR + WinRT startup each
// time — the single largest source of steady-state CPU/temp churn, visible to
// users as powershell.exe popping in and out of Task Manager. `media.ps1 -Serve`
// keeps ONE process alive holding the SMTC session manager, answers polls
// in-proc and caches the album-art stream per track. Protocol mirrors the
// sensor worker ("XEMED " + base64 frames), but it gets its OWN process: media
// holds WinRT broker handles, so unlike the sensor worker it is retired
// GRACEFULLY — stdin close lets the serve loop exit and release its handles
// cleanly; a hard kill only fires 3s later if the process refuses to die.
// Any problem falls back to the unchanged one-shot spawn path.
const _mediaHost = { proc: null, buf: '', nextId: 1, pending: new Map(), diedAt: 0, isHelper: false, bornAt: 0, helperBadUntil: 0 };
const MEDIA_HOST_RETRY_MS = 10000; // after a host death, poll one-shot for a while instead of respawn-storming
const MEDIA_HELPER_BAD_MS = 10 * 60 * 1000; // a helper exe that dies young is pinned out in favour of the PS host

function _mediaHostReject(id, err) {
  const p = _mediaHost.pending.get(id);
  if (!p) return;
  clearTimeout(p.timer);
  _mediaHost.pending.delete(id);
  p.reject(err);
}

function _retireMediaHost(reason) {
  const proc = _mediaHost.proc;
  _mediaHost.proc = null;
  _mediaHost.buf = '';
  _mediaHost.diedAt = Date.now();
  // A helper exe that dies or misbehaves within seconds of spawning is likely
  // broken (corrupt download, AV block): pin the PS host for a while instead
  // of ping-ponging between the two on every retry window.
  if (_mediaHost.isHelper && reason !== 'shutdown' && Date.now() - _mediaHost.bornAt < 15000) {
    _mediaHost.helperBadUntil = Date.now() + MEDIA_HELPER_BAD_MS;
  }
  for (const id of [..._mediaHost.pending.keys()]) _mediaHostReject(id, new Error(reason || 'media host down'));
  if (!proc) return;
  // Closing stdin ends the serve loop → clean process exit → SMTC/WinRT broker
  // handles released the safe way (killing mid-flight is what wedges the broker).
  try { proc.stdin.end(); } catch {}
  const force = setTimeout(() => { try { proc.kill(); } catch {} }, 3000);
  force.unref();
  proc.once('exit', () => clearTimeout(force));
}

function _ensureMediaHost() {
  if (_mediaHost.proc) return _mediaHost.proc;
  if (Date.now() - _mediaHost.diedAt < MEDIA_HOST_RETRY_MS) return null;
  let useHelper = false;
  if (Date.now() >= _mediaHost.helperBadUntil) {
    try { useHelper = fs.existsSync(HELPER_EXE); } catch { useHelper = false; }
  }
  let proc;
  try {
    proc = useHelper
      ? spawn(HELPER_EXE, ['media-serve'], { windowsHide: true })
      : spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MEDIA_SCRIPT, '-Serve'],
          { windowsHide: true });
  } catch { return null; }
  _mediaHost.proc = proc;
  _mediaHost.isHelper = useHelper;
  _mediaHost.bornAt = Date.now();
  _mediaHost.buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    _mediaHost.buf += chunk;
    let nl;
    while ((nl = _mediaHost.buf.indexOf('\n')) !== -1) {
      const line = _mediaHost.buf.slice(0, nl).trim();
      _mediaHost.buf = _mediaHost.buf.slice(nl + 1);
      if (!line.startsWith('XEMED ')) continue; // ignore any stray output
      let env;
      try { env = JSON.parse(Buffer.from(line.slice(6), 'base64').toString('utf8')); }
      catch { continue; }
      const p = _mediaHost.pending.get(env.id);
      if (!p) {
        // Unsolicited frame: the native helper pushes {event:"media-changed"}
        // when the OS reports a track/playback change.
        if (env.event === 'media-changed') _onMediaChangedPush();
        continue;
      }
      clearTimeout(p.timer);
      _mediaHost.pending.delete(env.id);
      if (env.ok) p.resolve(env.out || '');
      else p.reject(new Error(env.err || 'media host error'));
    }
  });
  proc.stderr.on('data', () => {}); // the host traps its own errors; ignore
  proc.on('error', () => _retireMediaHost('media host spawn error'));
  proc.on('exit', () => { if (_mediaHost.proc === proc) _retireMediaHost('media host exited'); });
  proc.unref(); // never keep the event loop alive on the host's account
  return proc;
}

function runMediaHostRequest(action, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proc = _ensureMediaHost();
    if (!proc) { reject(new Error('media host unavailable')); return; }
    const id = _mediaHost.nextId++;
    const timer = setTimeout(() => {
      _mediaHostReject(id, new Error('media host timeout'));
      _retireMediaHost('media host timeout');
    }, timeout);
    _mediaHost.pending.set(id, { resolve, reject, timer });
    try {
      proc.stdin.write(JSON.stringify({ id, action, preferredSource: mediaPreferredSource || '' }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      _mediaHost.pending.delete(id);
      reject(e);
    }
  });
}

// Track/playback changed at the OS level (pushed by the native helper):
// invalidate the cache and broadcast right away instead of waiting for the
// next 2s poll tick. The tiny debounce coalesces bursts into one refresh.
let _mediaPushTimer = null;
function _onMediaChangedPush() {
  if (_mediaPushTimer) return;
  _mediaPushTimer = setTimeout(async () => {
    _mediaPushTimer = null;
    mediaCache.updatedAt = 0;
    if (sseClients.size === 0) return;
    try { broadcastSSE('media', await getMediaInfo()); } catch {}
  }, 150);
  _mediaPushTimer.unref();
}

// Run a media request through the persistent host, falling back to the original
// one-shot spawn on any host problem. Same parsed-JSON result either way.
async function runMediaRequest(action, timeout = 8000) {
  try {
    return parseJsonOutput(await runMediaHostRequest(action, timeout));
  } catch {
    return runPowerShellScript(MEDIA_SCRIPT, mediaScriptArgs(action), timeout);
  }
}

function cpuSnapshot() {
  return os.cpus().map(cpu => {
    const times = cpu.times;
    const total = times.user + times.nice + times.sys + times.idle + times.irq;
    return { idle: times.idle, total };
  });
}

let lastCpu = cpuSnapshot();
let cachedCpuUsage = 0;
// Continuous CPU sampler — avoids 0% sampling artifacts when /system is polled less often than CPU times update.
setInterval(() => {
  const now = cpuSnapshot();
  let idle = 0, total = 0;
  now.forEach((cpu, i) => {
    idle  += cpu.idle  - lastCpu[i].idle;
    total += cpu.total - lastCpu[i].total;
  });
  lastCpu = now;
  if (total > 0) {
    const pct = Math.max(0, Math.min(100, Math.round(100 - (idle / total * 100))));
    cachedCpuUsage = pct;
  }
}, 1500).unref();
let gpuCache = { gpu: null, gpuName: null, gpuTemp: null, updatedAt: 0 };
let cpuTempCache = { cpuTemp: null, updatedAt: 0 };
let mediaCache = { data: null, updatedAt: 0 };
let weatherCache = { data: null, updatedAt: 0, cacheKey: '' };
let gpuPending = null;
let cpuTempPending = null;
let mediaPending = null;
let weatherPending = null;
let audioPending = null;
// STT via ffmpeg — WASAPI preferred (fast init), dshow fallback
let _sttDeviceReady = false;
let _sttUseWasapi   = false;
let _sttDshowDevice = null;
let _boundMicLabel  = null; // mic label we last bound to. Drives re-init on device changes.
const _sttDeviceWaiters = [];
const _sttPending = new Map(); // id → { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved }

const STT_SPEECH_MIN         = 420;
const STT_START_SILENCE_GRACE_MS       = 3200;
const STT_AFTER_SPEECH_SILENCE_GRACE_MS = 2500;

function _pcmRms(pcm) {
  if (!pcm || pcm.length < 2) return 0;
  const n = pcm.length - (pcm.length % 2);
  let sum = 0;
  for (let i = 0; i < n; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (n / 2));
}

function _pcmRmsStats(pcm, sampleRate = 16000, frameMs = 80) {
  const full = _pcmRms(pcm);
  const n = pcm ? pcm.length - (pcm.length % 2) : 0;
  const frameBytes = Math.max(2, Math.floor(sampleRate * frameMs / 1000) * 2);
  let peak = 0;
  for (let offset = 0; offset < n; offset += frameBytes) {
    const end = Math.min(n, offset + frameBytes);
    const frame = pcm.slice(offset, end - ((end - offset) % 2));
    if (frame.length >= 2) peak = Math.max(peak, _pcmRms(frame));
  }
  return { rms: full, peak: Math.max(peak, full) };
}

function _dbFromRms(rms) {
  if (!Number.isFinite(rms) || rms <= 0) return -60;
  return 20 * Math.log10(Math.max(1, rms) / 32768);
}

// End-of-speech silence threshold (raw input, BEFORE the gain boost is applied).
// Kept lenient so a quiet mic — e.g. a Bluetooth headset in hands-free mode,
// whose speech sits well below a normal mic's — is not mistaken for silence and
// cut off mid-sentence. Noisy mics whose idle hum exceeds this just fall back to
// the client-side auto-stop timer, which is the safe degradation.
function _sttSilenceDb() {
  return -42;
}

// Input gain applied to the captured audio. A Bluetooth hands-free mic produces
// a very low signal (the browser's getUserMedia hides this with automatic gain
// control; our raw ffmpeg capture does not), so we boost it both for end-of-
// speech detection and so Gemini receives an audible clip. The "Microphone
// sensitivity" slider drives the amount: 0 → 1.5×, 50 → ~3.25×, 100 → 5×.
function _sttGain() {
  const s = (_serverHubSettings && Number.isFinite(_serverHubSettings.aiMicSensitivity))
    ? _serverHubSettings.aiMicSensitivity : 50;
  return Math.round((1.5 + (s / 100) * 3.5) * 10) / 10;
}

// Speech gate runs on the gain-boosted clip. The boost lifts real speech above
// the floor while idle noise — proportionally lower — stays beneath it, so this
// still rejects near-silent clips before they reach Gemini.
function _sttLooksLikeSpeech(stats) {
  if (!stats) return false;
  if (stats.rms >= STT_SPEECH_MIN) return true;
  return stats.rms >= 330 && stats.peak >= 620;
}


let mediaPreferredSource = '';
const MEDIA_CACHE_MS = 1200;
const WEATHER_CACHE_MS = 10 * 60 * 1000;
const WEATHER_LANGS = new Set(['it', 'en', 'ko', 'ja', 'zh']);
const artworkCache = new Map();
const weatherLocationCache = new Map();

function sanitizeMediaSourcePreference(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240);
}

function setMediaPreferredSource(value) {
  const next = sanitizeMediaSourcePreference(value);
  if (next !== mediaPreferredSource) {
    mediaPreferredSource = next;
    mediaCache.updatedAt = 0;
  }
  return mediaPreferredSource;
}

function mediaScriptArgs(action) {
  const args = [action];
  if (mediaPreferredSource) args.push(mediaPreferredSource);
  return args;
}

function makeCsvPath() {
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return path.join(os.tmpdir(), `xenonedge-svv-${stamp}.csv`);
}

function readSoundVolumeRows() {
  return new Promise((resolve, reject) => {
    const csv = makeCsvPath();
    execFile(SVV, ['/scomma', csv, '/AvoidPrompts'], { timeout: 6000 }, err => {
      if (err) return reject(err);
      setTimeout(() => {
        try {
          const rows = fs.readFileSync(csv, 'latin1')
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .map(parseCsvLine);
          fs.unlink(csv, () => {});
          resolve(rows);
        } catch (e) {
          fs.unlink(csv, () => {});
          reject(e);
        }
      }, 250);
    });
  });
}

async function resolveAppIcons(appPaths) {
  // Extract the associated exe icon for each process path, exactly like windows.ps1
  // does for the app switcher. Keyed by path so each app resolves once and is cached.
  const keys = appPaths.map(p => (p || '').toLowerCase());
  const uncached = [...new Set(keys)].filter(k => k && !appIconCache.has(k));
  if (uncached.length) {
    const psArr = uncached.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
    const psCmd = `
      $paths = @(${psArr})
      $out = @{}
      try { Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue } catch {}
      foreach ($p in $paths) {
        $key = $p
        try {
          if ($p -and (Test-Path -LiteralPath $p)) {
            $ico = [System.Drawing.Icon]::ExtractAssociatedIcon($p)
            if ($ico) {
              $bmp = New-Object System.Drawing.Bitmap(32, 32)
              $g = [System.Drawing.Graphics]::FromImage($bmp)
              $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
              $g.DrawImage($ico.ToBitmap(), 0, 0, 32, 32)
              $g.Dispose()
              $ms = New-Object System.IO.MemoryStream
              $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
              $out[$key] = 'data:image/png;base64,' + [Convert]::ToBase64String($ms.ToArray())
              $bmp.Dispose(); $ms.Dispose(); $ico.Dispose()
            }
          }
        } catch {}
        if (-not $out.ContainsKey($key)) { $out[$key] = $null }
      }
      $out | ConvertTo-Json -Compress
    `;
    try {
      const result = await runPowerShellCommand(psCmd, 10000);
      if (result && typeof result === 'object') {
        for (const [k, v] of Object.entries(result)) {
          setAppIcon(k.toLowerCase(), v || null);
        }
      }
    } catch {}
    for (const k of uncached) {
      if (!appIconCache.has(k)) setAppIcon(k, null);
    }
  }
  return keys.map(k => appIconCache.get(k) || null);
}

function fetchJson(url, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout, headers: { 'User-Agent': 'Xenon/1.0' } }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Artwork lookup timeout')); });
    req.on('error', reject);
  });
}

async function hydrateArtwork(data) {
  if (!data || !data.active || data.thumbnail) return data;
  const title = (data.title || '').trim();
  const artist = (data.artist || '').trim();
  if (!title || !artist) return data;

  const key = `${artist}::${title}`.toLowerCase();
  if (artworkCache.has(key)) {
    data.thumbnail = artworkCache.get(key);
    return data;
  }

  try {
    const term = encodeURIComponent(`${artist} ${title}`);
    const result = await fetchJson(`https://itunes.apple.com/search?term=${term}&entity=song&limit=1`, 2500);
    const art = result && result.results && result.results[0] && result.results[0].artworkUrl100;
    const bigArt = art ? art.replace('100x100bb', '600x600bb') : null;
    // LRU eviction: cap cache at 200 entries to prevent unbounded growth.
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, bigArt);
    data.thumbnail = bigArt;
  } catch {
    if (artworkCache.size >= 200) artworkCache.delete(artworkCache.keys().next().value);
    artworkCache.set(key, null);
  }

  return data;
}

function firstWeatherValue(value) {
  if (Array.isArray(value) && value[0] && typeof value[0].value === 'string') return value[0].value;
  return '';
}

function normalizeWeatherCode(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function sanitizeWeatherCity(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>`"'\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function normalizeWeatherLocation(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : 'auto';
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function resolveWeatherLocation(value) {
  const location = normalizeWeatherLocation(value);
  if (location.mode === 'manual' && location.city) return location;
  return { mode: 'auto', city: '' };
}

function normalizeWeatherCityKey(value) {
  return sanitizeWeatherCity(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function pickWeatherLocationResult(results, requestedCity) {
  if (!Array.isArray(results) || !results.length) return null;
  const requestedKey = normalizeWeatherCityKey(requestedCity);
  return results.find(item => normalizeWeatherCityKey(item && item.name) === requestedKey)
    || results.find(item => requestedKey.startsWith(normalizeWeatherCityKey(item && item.name)))
    || results.find(item => normalizeWeatherCityKey(item && item.name).startsWith(requestedKey))
    || results[0];
}

function splitWeatherDisplayLocation(value) {
  const parts = String(value || '').split(',').map(part => part.trim()).filter(Boolean);
  return {
    location: parts[0] || '',
    region: parts[1] || '',
    country: parts.slice(2).join(', '),
  };
}

async function resolveManualWeatherPlace(city, lang) {
  const requestedCity = sanitizeWeatherCity(city);
  if (!requestedCity) return { placePath: '', resolvedCity: '' };

  const cacheKey = `${lang}|${requestedCity.toLowerCase()}`;
  const cached = weatherLocationCache.get(cacheKey);
  if (cached && (Date.now() - cached.updatedAt) < WEATHER_CACHE_MS) return cached.value;

  let value = {
    placePath: `/${encodeURIComponent(requestedCity)}`,
    resolvedCity: requestedCity,
  };

  try {
    const query = encodeURIComponent(requestedCity);
    const geo = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${query}&count=10&language=${lang}&format=json`, 3000);
    const match = pickWeatherLocationResult(geo && geo.results, requestedCity);
    const latitude = Number(match && match.latitude);
    const longitude = Number(match && match.longitude);
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      value = {
        placePath: `/${latitude.toFixed(4)},${longitude.toFixed(4)}`,
        resolvedCity: [match.name, match.admin1, match.country].filter(Boolean).join(', ') || requestedCity,
      };
    }
  } catch {
    // Fall back to the raw city name when geocoding is unavailable.
  }

  weatherLocationCache.set(cacheKey, { value, updatedAt: Date.now() });
  return value;
}

function weatherDescription(item, lang) {
  if (!item) return '';
  return firstWeatherValue(item[`lang_${lang}`]) || firstWeatherValue(item.weatherDesc) || '';
}

function normalizeWeatherHour(hour, lang, date) {
  const rawTime = String(hour && hour.time || '0').padStart(4, '0');
  const time = `${rawTime.slice(0, -2).padStart(2, '0')}:${rawTime.slice(-2)}`;
  const tempC = Number(hour && hour.tempC);
  const feelsC = Number(hour && hour.FeelsLikeC);
  const rain = Number(hour && hour.chanceofrain);
  const windKph = Number(hour && hour.windspeedKmph);
  return {
    date,
    time,
    code: normalizeWeatherCode(hour && hour.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    rain: Number.isFinite(rain) ? Math.round(rain) : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    condition: weatherDescription(hour, lang),
  };
}

function normalizeWeatherDay(day, lang) {
  const astronomy = day && day.astronomy && day.astronomy[0] || {};
  const noon = day && Array.isArray(day.hourly) ? (day.hourly.find(h => String(h.time) === '1200') || day.hourly[0]) : null;
  return {
    date: String(day && day.date || ''),
    code: normalizeWeatherCode(noon && noon.weatherCode),
    minC: Number.isFinite(Number(day && day.mintempC)) ? Math.round(Number(day.mintempC)) : null,
    maxC: Number.isFinite(Number(day && day.maxtempC)) ? Math.round(Number(day.maxtempC)) : null,
    avgC: Number.isFinite(Number(day && day.avgtempC)) ? Math.round(Number(day.avgtempC)) : null,
    uv: Number.isFinite(Number(day && day.uvIndex)) ? Number(day.uvIndex) : null,
    sunHour: Number.isFinite(Number(day && day.sunHour)) ? Number(day.sunHour) : null,
    sunrise: String(astronomy.sunrise || ''),
    sunset: String(astronomy.sunset || ''),
    moonPhase: String(astronomy.moon_phase || ''),
    condition: weatherDescription(noon, lang),
  };
}

function normalizeWeather(raw, lang) {
  const current = raw && raw.current_condition && raw.current_condition[0] || {};
  const area = raw && raw.nearest_area && raw.nearest_area[0] || {};
  const tempC = Number(current.temp_C);
  const feelsC = Number(current.FeelsLikeC);
  const humidity = Number(current.humidity);
  const windKph = Number(current.windspeedKmph);
  const pressure = Number(current.pressure);
  const visibility = Number(current.visibility);
  const uv = Number(current.uvIndex);
  const cloudCover = Number(current.cloudcover);
  const precipMM = Number(current.precipMM);
  const lat = Number(area.latitude);
  const lon = Number(area.longitude);
  const condition = weatherDescription(current, lang);
  const location = firstWeatherValue(area.areaName) || firstWeatherValue(area.region) || firstWeatherValue(area.country) || '';
  const region = firstWeatherValue(area.region);
  const country = firstWeatherValue(area.country);
  const days = Array.isArray(raw && raw.weather) ? raw.weather : [];
  const nowHour = new Date().getHours();
  const hourly = days.flatMap(day => (Array.isArray(day.hourly) ? day.hourly : [])
    .map(hour => normalizeWeatherHour(hour, lang, String(day.date || ''))))
    .filter(hour => !hour.date || hour.date !== days[0]?.date || Number(hour.time.slice(0, 2)) >= nowHour)
    .slice(0, 8);
  const todayAstro = days[0] && days[0].astronomy && days[0].astronomy[0] || {};

  return {
    ok: Number.isFinite(tempC),
    code: normalizeWeatherCode(current.weatherCode),
    tempC: Number.isFinite(tempC) ? Math.round(tempC) : null,
    feelsC: Number.isFinite(feelsC) ? Math.round(feelsC) : null,
    humidity: Number.isFinite(humidity) ? humidity : null,
    windKph: Number.isFinite(windKph) ? Math.round(windKph) : null,
    windDir: String(current.winddir16Point || ''),
    pressure: Number.isFinite(pressure) ? pressure : null,
    visibility: Number.isFinite(visibility) ? visibility : null,
    uv: Number.isFinite(uv) ? uv : null,
    cloudCover: Number.isFinite(cloudCover) ? cloudCover : null,
    precipMM: Number.isFinite(precipMM) ? precipMM : null,
    condition,
    location,
    region,
    country,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    sunrise: String(todayAstro.sunrise || ''),
    sunset: String(todayAstro.sunset || ''),
    hourly,
    forecast: days.slice(0, 3).map(day => normalizeWeatherDay(day, lang)),
    updatedAt: Date.now(),
    aqi: null, pm25: null, pm10: null, no2: null,
  };
}

async function getWeather(lang = 'it', requestedLocation = null) {
  const safeLang = WEATHER_LANGS.has(lang) ? lang : 'it';
  const settings = await readHubSettings().catch(() => null);
  const hasRequestLocation = requestedLocation && (requestedLocation.mode !== undefined || requestedLocation.city !== undefined);
  const location = resolveWeatherLocation(hasRequestLocation ? requestedLocation : settings && settings.weather);
  const cacheKey = `${safeLang}|${location.mode}|${location.city.toLowerCase()}`;
  const age = Date.now() - weatherCache.updatedAt;
  if (weatherCache.data && weatherCache.cacheKey === cacheKey && age < WEATHER_CACHE_MS) return weatherCache.data;
  if (weatherPending && weatherPending.cacheKey === cacheKey) return weatherPending.promise;

  const manualPlace = location.mode === 'manual'
    ? await resolveManualWeatherPlace(location.city, safeLang)
    : { placePath: '', resolvedCity: '' };
  const placePath = manualPlace.placePath;

  const promise = fetchJson(`https://wttr.in${placePath}?format=j1&lang=${safeLang}`, 3500)
    .then(async raw => {
      const data = normalizeWeather(raw, safeLang);
      data.locationMode = location.mode;
      data.requestedCity = location.city;
      data.resolvedCity = manualPlace.resolvedCity;
      if (location.mode === 'manual' && manualPlace.resolvedCity) {
        const displayLocation = splitWeatherDisplayLocation(manualPlace.resolvedCity);
        data.location = displayLocation.location || data.location;
        data.region = displayLocation.region || '';
        data.country = displayLocation.country || '';
      }
      if (data.lat !== null && data.lon !== null) {
        try {
          const aqiRaw = await fetchJson(
            `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${data.lat}&longitude=${data.lon}&current=european_aqi,pm2_5,pm10,nitrogen_dioxide`,
            4000
          );
          const cur = aqiRaw && aqiRaw.current || {};
          data.aqi  = Number.isFinite(Number(cur.european_aqi))     ? Math.round(Number(cur.european_aqi))           : null;
          data.pm25 = Number.isFinite(Number(cur.pm2_5))            ? Math.round(Number(cur.pm2_5) * 10) / 10        : null;
          data.pm10 = Number.isFinite(Number(cur.pm10))             ? Math.round(Number(cur.pm10))                   : null;
          data.no2  = Number.isFinite(Number(cur.nitrogen_dioxide)) ? Math.round(Number(cur.nitrogen_dioxide) * 10) / 10 : null;
        } catch { }
      }
      weatherCache = { data, updatedAt: Date.now(), cacheKey };
      return data;
    })
    .catch(e => {
      if (weatherCache.data && weatherCache.cacheKey === cacheKey) return { ...weatherCache.data, stale: true };
      throw e;
    })
    .finally(() => {
      if (weatherPending && weatherPending.cacheKey === cacheKey) weatherPending = null;
    });

  weatherPending = { cacheKey, promise };
  return promise;
}

function splitMediaTitle(rawTitle, appName) {
  const title = (rawTitle || '').trim();
  if (!title) return { title: '', artist: '' };
  if (/spotify/i.test(appName) && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      return { artist: parts.shift().trim(), title: parts.join(' - ').trim() };
    }
  }
  return { title, artist: '' };
}

function displayAppName(name) {
  if (/spotify/i.test(name || '')) return 'Spotify';
  if (/chrome|edge|firefox|brave|opera|youtube/i.test(name || '')) return 'YouTube';
  if (/zunemusic|zunevideo|microsoftmediaplayer|windowsmediaplayer/i.test(name || '')) return 'Lettore Multimediale';
  if (!name) return 'Media';
  // Strip Windows package format: Publisher.Name_hash!AppId → Name
  const pkg = (name || '').match(/^(?:[^.]+\.)+([^._!]+)[_!]/);
  if (pkg) return pkg[1];
  return name;
}

function liveMediaSnapshot(data, ageMs) {
  if (!data) return data;
  const snapshot = { ...data };
  if (snapshot.playbackStatus === 'Playing' && snapshot.duration) {
    const position = Number(snapshot.position) || 0;
    const duration = Number(snapshot.duration) || 0;
    snapshot.position = Math.min(duration, position + Math.floor(ageMs / 1000));
  }
  return snapshot;
}

function getCpuUsage() {
  return cachedCpuUsage;
}

function getCpuName() {
  try {
    const cpus = os.cpus();
    if (cpus && cpus.length && cpus[0].model) {
      return cpus[0].model.replace(/\s+/g, ' ').replace(/\(R\)|\(TM\)|CPU\s+@.*$/g, '').trim();
    }
  } catch { }
  return null;
}

async function getCpuTemp() {
  const age = Date.now() - cpuTempCache.updatedAt;
  if (age < 5000) return cpuTempCache.cpuTemp;
  if (cpuTempPending) return cpuTempPending;

  cpuTempPending = (async () => {
    try {
      const data = await runCollector(CPU_TEMP_SCRIPT, [], 10000);
      cpuTempCache = {
        cpuTemp: data.cpuTemp === null || data.cpuTemp === undefined ? null : Number(data.cpuTemp),
        updatedAt: Date.now(),
      };
    } catch {
      cpuTempCache.updatedAt = Date.now();
    }
    cpuTempPending = null;
    return cpuTempCache.cpuTemp;
  })();

  return cpuTempPending;
}

async function getGpuInfo() {
  const age = Date.now() - gpuCache.updatedAt;
  if (age < 5000) return gpuCache;
  if (gpuPending) return gpuPending;
  gpuPending = (async () => {
  try {
    const data = await runCollector(GPU_SCRIPT, [], 12000);
    gpuCache = {
      gpu: data.gpu === null || data.gpu === undefined ? gpuCache.gpu : data.gpu,
      gpuName: data.gpuName || gpuCache.gpuName || null,
      gpuTemp: (data.gpuTemp === null || data.gpuTemp === undefined) ? gpuCache.gpuTemp : data.gpuTemp,
      updatedAt: Date.now(),
    };
  } catch {
    gpuCache.updatedAt = Date.now();
  }
  gpuPending = null;
  return gpuCache;
  })();
  return gpuPending;
}

// Labels/filesystem/type only — free space is read live via statfs on every
// cycle. Volumes change only on plug/unplug, so 10 minutes is plenty: at 60s
// this was the last recurring powershell.exe spawn left on an idle server.
const DISK_DETAILS_TTL_MS = 10 * 60 * 1000;
let diskDetailsCache = { data: null, updatedAt: 0 };
async function getDiskDetails() {
  if (diskDetailsCache.data && Date.now() - diskDetailsCache.updatedAt < DISK_DETAILS_TTL_MS) return diskDetailsCache.data;
  const command = `
    $ErrorActionPreference = 'Stop'
    try {
      $volumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.DriveLetter } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DriveLetter + ':')
          label = ([string]$_.FileSystemLabel).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.DriveType).Trim()
        }
      })
    } catch {
      $volumes = @(Get-CimInstance Win32_LogicalDisk -ErrorAction Stop | Where-Object { $_.DeviceID } | ForEach-Object {
        [pscustomobject]@{
          drive = ([string]$_.DeviceID).Trim()
          label = ([string]$_.VolumeName).Trim()
          fileSystem = ([string]$_.FileSystem).Trim()
          driveType = ([string]$_.Description).Trim()
        }
      })
    }
    [pscustomobject]@{ volumes = $volumes } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    const map = {};
    const volumes = Array.isArray(data.volumes) ? data.volumes : (data.volumes ? [data.volumes] : []);
    volumes.forEach(volume => {
      if (volume && volume.drive) map[String(volume.drive).toUpperCase()] = volume;
    });
    diskDetailsCache = { data: map, updatedAt: Date.now() };
    return map;
  } catch {
    diskDetailsCache = { data: {}, updatedAt: Date.now() };
    return {};
  }
}

let _diskLettersCache = { letters: null, at: 0 };
const DISK_LETTERS_TTL = 60 * 1000;

async function getAllDisksInfo() {
  const drives = [];
  const details = await getDiskDetails();
  // Probing all 24 letters with statfs every cycle (~7s) is wasteful — valid
  // letters change rarely. Cache the set that resolved for 60s and probe only
  // those; a stale (or empty) cache triggers a full A–Z re-scan so a newly
  // mounted/removed drive still appears within a minute. Free-space is still
  // read live on each call — only the dead letters are skipped.
  const now = Date.now();
  const fresh = _diskLettersCache.letters && _diskLettersCache.letters.length &&
                (now - _diskLettersCache.at) < DISK_LETTERS_TTL;
  const letters = fresh ? _diskLettersCache.letters : 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const valid = [];
  for (const letter of letters) {
    try {
      if (typeof fs.promises.statfs === 'function') {
        const s = await fs.promises.statfs(letter + ':\\');
        const total = Number(s.blocks) * Number(s.bsize);
        const free = Number(s.bfree) * Number(s.bsize);
        if (total > 0) {
          valid.push(letter);
          const drive = letter + ':';
          const detail = details[drive.toUpperCase()] || {};
          drives.push({
            drive,
            total,
            used: total - free,
            free,
            percent: Math.round(((total - free) / total) * 100),
            label: detail.label || '',
            fileSystem: detail.fileSystem || '',
            driveType: detail.driveType || '',
          });
        }
      }
    } catch { }
  }
  // Only refresh the cache after a full scan, and never store an empty result
  // (a transient failure must not pin us to "no drives" for 60s).
  if (!fresh && valid.length) _diskLettersCache = { letters: valid, at: now };
  return drives.length ? drives : null;
}

let ramInfoCache = null;
async function getRamInfo() {
  if (ramInfoCache) return ramInfoCache;
  const command = `
    $types = @{ 20='DDR'; 21='DDR2'; 22='DDR2 FB'; 24='DDR3'; 26='DDR4'; 34='DDR5' }
    $modules = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | ForEach-Object {
      $smbios = 0
      try { $smbios = [int]$_.SMBIOSMemoryType } catch { }
      $type = $types[$smbios]
      $speed = 0
      if ($_.ConfiguredClockSpeed) { $speed = [int]$_.ConfiguredClockSpeed }
      elseif ($_.Speed) { $speed = [int]$_.Speed }
      [pscustomobject]@{
        type = $type
        speed = $speed
        capacity = [uint64]$_.Capacity
        manufacturer = ([string]$_.Manufacturer).Trim()
        partNumber = ([string]$_.PartNumber).Trim()
      }
    })
    if ($modules.Count -eq 0) {
      [pscustomobject]@{ ram = $null } | ConvertTo-Json -Depth 4 -Compress
      exit 0
    }
    $type = ($modules | Where-Object { $_.type } | Select-Object -First 1 -ExpandProperty type)
    $speed = ($modules | Measure-Object -Property speed -Maximum).Maximum
    $total = ($modules | Measure-Object -Property capacity -Sum).Sum
    $moduleCount = $modules.Count
    $moduleGb = if ($moduleCount -gt 0 -and $total) { [Math]::Round(($total / $moduleCount) / 1GB, 0) } else { 0 }
    $manufacturer = ($modules | Where-Object { $_.manufacturer -and $_.manufacturer -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty manufacturer)
    $partNumber = ($modules | Where-Object { $_.partNumber -and $_.partNumber -notmatch '^(Unknown|Undefined|Default|string|To Be Filled)' } | Select-Object -First 1 -ExpandProperty partNumber)
    $labelParts = @()
    if ($type) { $labelParts += $type }
    if ($speed) { $labelParts += (([int]$speed).ToString() + ' MHz') }
    $layout = if ($moduleCount -gt 0 -and $moduleGb -gt 0) { $moduleCount.ToString() + 'x' + $moduleGb.ToString() + ' GB' } else { $null }
    $detailParts = @()
    if ($labelParts.Count -gt 0) { $detailParts += ($labelParts -join ' ') }
    if ($layout) { $detailParts += $layout }
    $nameParts = @()
    if ($manufacturer) { $nameParts += $manufacturer }
    if ($partNumber) { $nameParts += $partNumber }
    [pscustomobject]@{
      ram = [pscustomobject]@{
        name = ($labelParts -join ' ')
        detail = ($detailParts -join ' - ')
        moduleName = ($nameParts -join ' ')
        modules = $moduleCount
        speed = $speed
        type = $type
      }
    } | ConvertTo-Json -Depth 4 -Compress
  `;

  try {
    const data = await runPowerShellCommand(command, 5000);
    ramInfoCache = data.ram || null;
  } catch {
    ramInfoCache = null;
  }
  return ramInfoCache;
}

async function getSystemInfo() {
  const [gpu, disks, ramInfo, cpuTemp] = await Promise.all([getGpuInfo(), getAllDisksInfo(), getRamInfo(), getCpuTemp()]);
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    now: new Date().toISOString(),
    hostname: os.hostname(),
    uptime: Math.round(os.uptime()),
    cpu: getCpuUsage(),
    cpuTemp,
    cpuName: getCpuName(),
    memory: {
      used: usedMem,
      total: totalMem,
      percent: Math.round((usedMem / totalMem) * 100),
    },
    ramName: ramInfo && ramInfo.name ? ramInfo.name : null,
    ramDetail: ramInfo,
    gpu: gpu.gpu,
    gpuName: gpu.gpuName,
    gpuTemp: gpu.gpuTemp,
    disks,
  };
}

// --- Network info: bandwidth requires a delta between two readings ---
let _netPrev = null; // { rx, tx, t }
let _netPending = null;
async function getNetworkInfo() {
  // In-flight dedup: with two dashboards open the 3s polls interleave, and two
  // concurrent runs would both rewrite _netPrev — corrupting the bandwidth
  // delta — while doubling the collector work. Latecomers share the result.
  if (_netPending) return _netPending;
  _netPending = _getNetworkInfoRaw().finally(() => { _netPending = null; });
  return _netPending;
}
async function _getNetworkInfoRaw() {
  // PresentMon's FPS wins anyway when it is available, so tell the collector to
  // skip its own FPS sampling — the DWM fallback sleeps 600ms inside the serial
  // worker, delaying every other queued sensor read.
  let skipFps = false;
  try { skipFps = fpsMonitor.isAvailable(); } catch { skipFps = false; }
  const data = await runCollector(NETWORK_SCRIPT, skipFps ? ['-SkipFps'] : [], 8000);
  const now = Date.now();
  const rx = Number(data.rxBytes) || 0;
  const tx = Number(data.txBytes) || 0;

  let downBps = null, upBps = null;
  if (_netPrev && now > _netPrev.t) {
    const dt = (now - _netPrev.t) / 1000; // seconds
    const dRx = rx - _netPrev.rx;
    const dTx = tx - _netPrev.tx;
    if (dt > 0 && dRx >= 0 && dTx >= 0) {
      downBps = Math.round(dRx / dt);
      upBps   = Math.round(dTx / dt);
    }
  }
  _netPrev = { rx, tx, t: now };

  // Prefer PresentMon's real in-game FPS (works in exclusive fullscreen);
  // fall back to the PowerShell DWM/LHM reading when it isn't available.
  let fps = null;
  try { fps = fpsMonitor.getCurrentFps(); } catch { fps = null; }
  if (fps == null) fps = data.fps ?? null;

  return {
    ping: data.ping ?? null,
    latency: data.latency ?? null,
    fps,
    gpuLatency: data.gpuLatency ?? null,
    downloadBps: downBps,
    uploadBps: upBps,
  };
}

async function getMediaInfo(force = false) {
  const age = Date.now() - mediaCache.updatedAt;
  if (!force && mediaCache.data && age < MEDIA_CACHE_MS) return liveMediaSnapshot(mediaCache.data, age);
  if (mediaPending) return mediaPending;
  mediaPending = (async () => {
  try {
    const data = await runMediaRequest('info', 12000);
    const hydrated = await hydrateArtwork(data);
    mediaCache = { data: hydrated, updatedAt: Date.now() };
    mediaPending = null;
    return hydrated;
  } catch (e) {
    if (mediaCache.data) {
      mediaPending = null;
      return mediaCache.data;
    }
    const fallback = await getMediaFallback(e.message);
    const hydratedFallback = await hydrateArtwork(fallback);
    mediaCache = { data: hydratedFallback, updatedAt: Date.now() };
    mediaPending = null;
    return hydratedFallback;
  }
  })();
  return mediaPending;
}

function getMediaFallback(error) {
  return new Promise(resolve => {
    readSoundVolumeRows().then(rows => {
        try {
          const app = rows.find(f =>
            f[F.TYPE] === 'Application' &&
            f[F.DIR] === 'Render' &&
            f[F.STATE] === 'Active' &&
            f[F.NAME] &&
            !/windows|system sounds|operating system/i.test(`${f[F.NAME]} ${f[F.WINDOW_TITLE] || ''}`) &&
            (f[F.WINDOW_TITLE] || /spotify|chrome|edge|firefox|browser|youtube/i.test(f[F.NAME]))
          );

          if (!app) {
            resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
            return;
          }

          const appName = displayAppName(app[F.NAME]);
          const rawTitle = app[F.WINDOW_TITLE] || app[F.NAME] || 'Media attivo';
          const split = splitMediaTitle(rawTitle, appName);

          resolve({
            active: true,
            app: appName,
            source: appName,
            title: split.title || rawTitle,
            artist: split.artist || '',
            album: '',
            playbackStatus: 'Unknown',
            thumbnail: null,
            position: 0,
            duration: 0,
            fallback: true,
            error,
          });
        } catch {
          resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
        }
      }).catch(() => {
        resolve({ active: false, app: '', source: '', title: '', artist: '', album: '', playbackStatus: 'Unavailable', thumbnail: null, position: 0, duration: 0, error });
      });
    });
}

async function mediaAction(action) {
  const data = await runMediaRequest(action, 5000);
  mediaCache.updatedAt = 0;
  return data;
}

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { fields.push(cur); cur = ''; }
    else { cur += ch; }
  }
  fields.push(cur);
  return fields;
}

async function _getAudioInfoRaw() {
  const allRows = await readSoundVolumeRows();

  // ── Device-level (master) ────────────────────────────────────
  const deviceRows = allRows.filter(f => f[F.TYPE] === 'Device' && f[F.STATE] === 'Active');
  const speakers   = deviceRows.filter(f => f[F.DIR] === 'Render');
  const mics       = deviceRows.filter(f => f[F.DIR] === 'Capture');

  const defSpk = speakers.find(f => f[F.DEFAULT] === 'Render') || speakers[0];
  const defMic = mics.find(f => f[F.DEFAULT] === 'Capture')    || mics[0];

  if (defSpk) { cachedSpeakerId = defSpk[F.CLI_ID]; cachedSpeakerName = defSpk[F.NAME]; _lastSpeakerVolume = parseInt(defSpk[F.VOL_PCT]) || _lastSpeakerVolume; }
  if (defMic) { cachedMicId = defMic[F.CLI_ID]; cachedMicLabel = defMic[F.NAME]; _maybeRebindSttDevice(); }

  const toDevice = (f, isDefault) => ({
    name:      f[F.DEVICE_NAME],
    label:     f[F.NAME],
    id:        f[F.CLI_ID],
    isDefault,
    volume:    parseInt(f[F.VOL_PCT]) || 0,
    muted:     f[F.MUTED] === 'Yes',
  });

  // ── Application-level sessions ───────────────────────────────
  // Show only sessions that are currently Active — this mirrors the Windows 11
  // Volume Mixer, which lists an app while it actually holds an audio stream and
  // drops it otherwise. Keeping Inactive sessions surfaced apps that Windows
  // hides (e.g. RtkUWP, Explorer), so we filter them out here. Requiring a real
  // exe path also excludes the "System Sounds" pseudo-sessions (empty Process
  // Path). Dedupe per process path (an app can open one session per tab/stream).
  // The exe basename (e.g. "spotify", "icue") is the most reliable label: the
  // client runs it through prettyAppName for friendly names, sidestepping bad
  // session metadata like "Qt6" that some apps report in the NAME column.
  const procName = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');

  // Browser processes whose audio-session window title reveals the actual site
  // (Twitch / YouTube / SoundCloud …). SMTC only reports the host browser, so we
  // forward this title — for browser sessions only — and the client resolves the
  // real source from it. Non-browser titles are never sent (keeps the payload
  // lean and avoids surfacing unrelated window titles).
  const BROWSER_PROC_RE = /^(?:chrome|msedge|firefox|brave|opera|vivaldi)$/i;

  const collectApps = dir => {
    const sessions = allRows.filter(f =>
      f[F.TYPE] === 'Application' &&
      f[F.DIR]  === dir &&
      f[F.PROC_PATH] &&
      f[F.STATE] === 'Active'
    );
    const byPath = new Map();
    for (const f of sessions) {
      const key = f[F.PROC_PATH].toLowerCase();
      const existing = byPath.get(key);
      // Prefer an Active session over an Inactive one for the visible row.
      if (!existing || (f[F.STATE] === 'Active' && existing[F.STATE] !== 'Active')) {
        byPath.set(key, f);
      }
    }
    return [...byPath.values()].map(f => {
      const proc = procName(f);
      return {
        name:   f[F.NAME] || f[F.WINDOW_TITLE] || proc || 'App',
        proc,
        id:     f[F.CLI_ID],
        path:   f[F.PROC_PATH],
        volume: parseInt(f[F.VOL_PCT]) || 0,
        muted:  f[F.MUTED] === 'Yes',
        icon:   null,
        win:    BROWSER_PROC_RE.test(proc) ? (f[F.WINDOW_TITLE] || '') : '',
      };
    });
  };

  const speakerApps = collectApps('Render');
  const micApps     = collectApps('Capture');

  // Resolve icons from the exe path (cached; only slow on first appearance).
  const allPaths = [...speakerApps, ...micApps].map(a => a.path);
  if (allPaths.length) {
    const icons = await resolveAppIcons(allPaths);
    let i = 0;
    speakerApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
    micApps.forEach(a => { a.icon = icons[i++]; delete a.path; });
  }

  return {
    speaker:     defSpk ? toDevice(defSpk, true) : null,
    mic:         defMic ? toDevice(defMic, true)  : null,
    speakers:    speakers.map(f => toDevice(f, f === defSpk)),
    mics:        mics.map(f => toDevice(f, f === defMic)),
    speakerApps,
    micApps,
  };
}

async function getAudioInfo() {
  if (audioPending) return audioPending;
  const p = _getAudioInfoRaw();
  audioPending = p;
  try { return await p; } finally { if (audioPending === p) audioPending = null; }
}

function setMicMute(mute) {
  const action = mute ? '/Mute' : '/Unmute';
  // Use the cached mic CLI ID (resolved from SoundVolumeView output) so the call works
  // regardless of the Windows display language. Falls back silently if the cache is empty.
  if (cachedMicId) {
    execFile(SVV, [action, cachedMicId], err => { if (err) console.error(err.message); });
  } else if (cachedSpeakerName) {
    // Last-resort: try the generic 'DefaultCaptureDevice' selector understood by SVV
    execFile(SVV, [action, 'DefaultCaptureDevice'], err => { if (err) console.error(err.message); });
  }
}

// Promise wrapper around a single SoundVolumeView call.
function svvExec(args) {
  return new Promise((resolve, reject) => execFile(SVV, args, e => (e ? reject(e) : resolve())));
}

// Normalise a per-app audio target for SoundVolumeView: a bare process name with
// a .exe suffix (the durable identifier the Deck stores, vs. the volatile CLI id).
function appAudioTarget(app) {
  const base = String(app || '').split(/[\\/]/).pop().trim();
  return /\.exe$/i.test(base) ? base : base + '.exe';
}

// Lazy OBS WebSocket client — reads live settings on each new connection so
// changes in Settings take effect without a server restart.
const deckObs = createObs(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.obsHost, port: s.obsPort, password: s.obsPassword };
});

// Lazy Streamer.bot WebSocket client — same on-demand/idle-close model as OBS, so
// a closed dashboard or an unconfigured streamer.bot keeps zero sockets open.
// Reads live settings on each new connection (no restart needed after Settings).
const deckSb = createStreamerbot(async () => {
  const s = (await readHubSettings().catch(() => null)) || {};
  return { host: s.streamerbotHost, port: s.streamerbotPort, password: s.streamerbotPassword };
});

// Embedded-browser host for the "Browser" dashboard widget. Launches ONE headless
// Edge on demand (when a tile opens) and kills it when the last tile closes, so an
// unused widget costs nothing. Frames/input are relayed over a loopback WebSocket
// (see the /embedded-browser/ws upgrade handler near the bottom of this file).
const embeddedBrowser = createEmbeddedBrowser({ dataDir: DATA_DIR });
// Second-screen prerequisite check + one-click VDD install (UI not wired yet).
const secondScreen = createSecondScreen();
// Second-screen capture host: spawns the Xenon Helper `screen-serve` mode on
// demand and relays its JPEG frames over the /second-screen/ws loopback socket.
const screenCapture = createScreenCapture({ helperExe: HELPER_EXE });

// Apply a resolution to the virtual display. Fast path: commit the advertised mode
// live via the helper (no UAC, no device churn) — this is what actually makes the
// chosen resolution stick (a new VDD monitor sits at a stale 800x600 default until
// a mode is committed). Fallback: if the mode isn't advertised yet (display missing
// or created by an older single-mode config), (re)create it with the full preset
// config — which is elevated but idempotent (remove-then-install one, never spam) —
// then commit again.
async function applySecondScreenMode(mode, opts) {
  const soft = !!(opts && opts.soft);
  let width = mode && mode.width;
  let height = mode && mode.height;
  // Soft auto-restore (the tile re-asserting the saved resolution on every load):
  // trust the *persisted* resolution from settings.json, not the client-sent one.
  // On a fresh page load the tile may fire this before its hubSettings is populated
  // and would otherwise send the 1080p default — silently clobbering the user's
  // saved mode, which is exactly the "I have to re-apply every time" bug. The server
  // always has the authoritative saved value, so resolve it here.
  if (soft) {
    try {
      const s = await readHubSettings();
      const ss = s && s.secondScreen;
      if (ss && ss.width > 0 && ss.height > 0) { width = ss.width; height = ss.height; }
    } catch (e) { /* fall back to the client-sent mode */ }
  }
  const m = { monitor: 'virtual', width, height };
  if (!(m.width > 0 && m.height > 0)) return { ok: false, code: 'bad_args' };

  try {
    const r = await screenCapture.setMode(m);
    if (r && r.ok) return { ok: true, code: 'mode_applied', width: r.width, height: r.height };
  } catch (e) { /* fall through to (re)create */ }

  // Silent auto-restore path (tile re-asserting the saved resolution on load): never
  // fall back to the elevated device (re)create — a UAC prompt on every restart is
  // exactly what we're avoiding. The user can re-apply manually from Settings.
  if (soft) return { ok: false, code: 'needs_apply' };

  const created = await secondScreen.createDisplay(mode);
  if (!(created && created.ok)) return created;
  if (created.code === 'display_needs_reboot') return created;

  try {
    const r2 = await screenCapture.setMode(m);
    if (r2 && r2.ok) return { ok: true, code: 'mode_applied', width: r2.width, height: r2.height };
  } catch (e) { /* display exists; mode may settle after a reboot */ }
  return { ok: true, code: 'display_ready' };
}

// Live OBS state pushed to the dashboard while it's open and OBS is configured.
// The persistent OBS connection is held only when both are true, so a closed
// dashboard or an unconfigured OBS keeps zero sockets open.
let obsState = { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {} };
let obsStopWatch = null;
// Live thumbnail of the OBS program (on-air) scene, pushed on its own SSE event so
// the (larger) image never rides the frequent small `obs` state updates.
let obsPreview = { scene: '', image: '' };
let obsPreviewTimer = null;

function applyObsPartial(partial) {
  if (!partial) return;
  const sceneChanged = ('obsScene' in partial) && partial.obsScene !== obsState.obsScene;
  if (partial.obsMutes) obsState.obsMutes = Object.assign({}, obsState.obsMutes, partial.obsMutes);
  for (const k of ['obsRecording', 'obsStreaming', 'obsScene']) if (k in partial) obsState[k] = partial[k];
  broadcastSSE('obs', obsState);
  if (sceneChanged && obsPreviewTimer) captureScenePreview(); // refresh the preview instantly on a scene switch
}

async function captureScenePreview() {
  const scene = obsState.obsScene;
  if (!scene) return;                         // no program scene yet
  try {
    const r = scenePreviewRequest(scene);
    const resp = await deckObs.request(r.requestType, r.requestData);
    if (resp && resp.imageData) {
      obsPreview = { scene, image: resp.imageData };
      broadcastSSE('obs_preview', obsPreview);
    }
  } catch (e) { /* keep the last image on a failed/again-later capture */ }
}

async function refreshObsWatch() {
  const s = (await readHubSettings().catch(() => null)) || {};
  const want = !!s.obsHost && sseClients.size > 0;
  if (want && !obsStopWatch) {
    obsStopWatch = deckObs.watch(applyObsPartial);
    if (!obsPreviewTimer) obsPreviewTimer = setInterval(captureScenePreview, 5000);
    captureScenePreview();                    // one immediate capture so the thumbnail appears fast
  } else if (!want && obsStopWatch) {
    obsStopWatch(); obsStopWatch = null;
    if (obsPreviewTimer) { clearInterval(obsPreviewTimer); obsPreviewTimer = null; }
    obsState = { obsRecording: false, obsStreaming: false, obsScene: '', obsMutes: {} };
    obsPreview = { scene: '', image: '' };
    broadcastSSE('obs', obsState);            // clear stale record/stream/scene indicators
    broadcastSSE('obs_preview', obsPreview);  // clear the client thumbnail
  }
}

// ── OBS auto-launch: open OBS when an OBS action is clicked while it's closed,
// then run the action once it connects. ──────────────────────────────────────
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let obsLaunching = false;

// Read OBS's install dir from the registry (HKLM\SOFTWARE\OBS Studio default).
// Returns the path string or null; never throws.
function readObsInstallDir() {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-Command', "$ErrorActionPreference='SilentlyContinue'; (Get-ItemProperty 'HKLM:\\SOFTWARE\\OBS Studio').'(default)'"],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const dir = String(stdout || '').trim();
        resolve(dir || null);
      });
  });
}

// Launch obs64.exe with its required working directory (bin\64bit). Best-effort.
function launchObs(exe) {
  try { spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: false }).unref(); }
  catch (e) { console.error('OBS launch failed:', e.message); }
}

function _finishObsLaunch(ok) {
  if (!obsLaunching) return;
  obsLaunching = false;
  broadcastSSE('obs_launching', { launching: false, ok: !!ok });
}

// Run an OBS request; if it fails because OBS is unreachable AND auto-launch is on
// AND OBS is found, launch OBS and retry the SAME request until it connects (≤25s).
async function ensureObsRun(runFn) {
  try { return await runFn(); }
  catch (err) {
    if (!obsLaunch.isConnError(err)) throw err;                 // a real request error: surface it
    const s = (await readHubSettings().catch(() => null)) || {};
    if (s.obsAutoLaunch === false) throw err;                   // user opted out
    const exe = await obsLaunch.findObsExe({ readInstallDir: readObsInstallDir, fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } } });
    if (!exe) throw err;                                        // OBS not installed / not found
    if (!obsLaunching) { obsLaunching = true; broadcastSSE('obs_launching', { launching: true }); launchObs(exe); }
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      await _sleep(3000);
      try { const r = await runFn(); _finishObsLaunch(true); return r; }
      catch (e2) { if (!obsLaunch.isConnError(e2)) { _finishObsLaunch(true); throw e2; } } // OBS is up; the action itself failed
    }
    _finishObsLaunch(false);                                    // OBS never came up in time
    throw err;
  }
}

// Sort 'app-1.2.3'-style names newest-first by their numeric parts.
function _compareAppDirDesc(a, b) {
  const va = (a.match(/\d+/g) || []).map(Number);
  const vb = (b.match(/\d+/g) || []).map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const diff = (vb[i] || 0) - (va[i] || 0);
    if (diff) return diff;
  }
  return 0;
}

// Resolve a FOLDER the user pointed an "open app" key at to the executable that
// should actually launch — so pointing at an app's install directory just works.
// Handled shapes (newest version first; re-resolved on every tap so updates don't
// break the key):
//   1. Squirrel layout (Discord/Slack/Teams classic): a dir with Update.exe and
//      'app-X.Y.Z' subfolders → newest app-*/<Name>.exe.
//   2. A versioned dir itself (…/Discord/app-1.2.3) → an exe named after the parent.
//   3. A plain app dir holding exactly one executable.
// Returns '' when the path isn't a directory or no single clear target exists.
function resolveExecInDir(dir) {
  try {
    const d = String(dir || '').trim();
    if (!d) return '';
    let st;
    try { st = fs.statSync(d); } catch { return ''; }
    if (!st.isDirectory()) return '';
    const names = fs.readdirSync(d);
    const exes = names.filter((n) => /\.exe$/i.test(n));
    const leaf = path.basename(d).toLowerCase();
    const parentLeaf = path.basename(path.dirname(d)).toLowerCase();

    // 1) Squirrel: Update.exe + app-* subfolders → newest version's <leaf>.exe.
    if (exes.some((n) => n.toLowerCase() === 'update.exe')) {
      const appDirs = names
        .filter((n) => { try { return /^app-[\d.]+$/i.test(n) && fs.statSync(path.join(d, n)).isDirectory(); } catch { return false; } })
        .sort(_compareAppDirDesc);
      for (const ad of appDirs) {
        const inner = path.join(d, ad);
        let innerExes;
        try { innerExes = fs.readdirSync(inner).filter((n) => /\.exe$/i.test(n) && n.toLowerCase() !== 'update.exe'); }
        catch { continue; }                                    // unreadable; try next version
        const match = innerExes.find((n) => n.toLowerCase() === leaf + '.exe');  // e.g. Discord/app-*/Discord.exe
        if (match) return path.join(inner, match);
        if (innerExes.length === 1) return path.join(inner, innerExes[0]);
      }
    }

    // 2) An exe named after this folder, or after its parent (versioned-dir case).
    const named = exes.find((n) => n.toLowerCase() === leaf + '.exe')
      || exes.find((n) => n.toLowerCase() === parentLeaf + '.exe');
    if (named) return path.join(d, named);

    // 3) Exactly one launchable executable → unambiguous.
    const launchable = exes.filter((n) => n.toLowerCase() !== 'update.exe');
    if (launchable.length === 1) return path.join(d, launchable[0]);
    return '';
  } catch { return ''; }
}

// The Deck action dispatcher. Effects are injected here; security/validation
// lives inside the registry. This is the only place key actions execute.
// deckRegistryDeps is kept mutable so that deps created after this point
// (e.g. remoteControl, which is initialised below) can be injected lazily
// by assigning to the object — the registry closes over the same reference.
const deckRegistryDeps = {
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  openExternal: (p) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['open', p], 8000),
  // Resolve a folder target (the app's install dir) to its launch executable, so
  // a Deck "open app" key pointed at a folder (e.g. Discord's) still launches.
  resolveAppDir: (p) => resolveExecInDir(p),
  // Launch a Store/UWP app by AppUserModelID (shell:AppsFolder\<aumid>). The AUMID is
  // validated in the registry before reaching this dep.
  openStoreApp: (aumid) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['openapp', aumid], 8000),
  mediaAction: (cmd) => mediaAction(cmd),
  micMute: async (mode) => {
    if (mode === 'mute') isMuted = true;
    else if (mode === 'unmute') isMuted = false;
    else isMuted = !isMuted;          // 'toggle'
    setMicMute(isMuted);
    return { muted: isMuted };
  },
  volume: async (mode) => {
    if (!cachedSpeakerId) throw new Error('Cache not ready');
    if (mode === 'mute') return svvExec(['/Switch', cachedSpeakerId]);
    if (mode === 'up') return svvExec(['/ChangeVolume', cachedSpeakerId, '5']);
    if (mode === 'down') return svvExec(['/ChangeVolume', cachedSpeakerId, '-5']);
  },
  appVolume: async (app, mode) => {
    const target = appAudioTarget(app);
    return svvExec(['/ChangeVolume', target, mode === 'down' ? '-5' : '5']);
  },
  appMute: async (app, mode) => {
    const target = appAudioTarget(app);
    const verb = mode === 'mute' ? '/Mute' : mode === 'unmute' ? '/Unmute' : '/Switch';
    return svvExec([verb, target]);
  },
  // Send a keyboard shortcut to the app the user was last using. Tapping the
  // touchscreen gives focus to the dashboard, so the runner finds the window
  // beneath it in the Z-order and targets that (covers Zoom, Meet, Slack, …).
  // `keys` is already normalised by the registry to a safe token set.
  sendHotkey: async (keys) => {
    try {
      const r = await runPowerShellScript(DECK_HOTKEY_SCRIPT, ['-Keys', keys], 6000);
      return (r && r.ok === false) ? { ok: false, error: r.error || 'hotkey_failed' } : { ok: true };
    } catch { return { ok: false, error: 'hotkey_failed' }; }
  },
  obs: (requestType, requestData) => ensureObsRun(() => deckObs.request(requestType, requestData)),
  obsNext: () => ensureObsRun(() => deckObs.nextScene()),
  // Fire a Streamer.bot action over its WebSocket. The connection is lazy/idle-
  // closed; an unreachable streamer.bot surfaces as a clean {ok:false} via run().
  streamerbot: (r) => deckSb.request(r.request, { action: r.action }),
  // Deck LED reaction: drive the lighting hub via a TRANSIENT overlay that never
  // touches the user's persisted manual colour or animation. 'restore' removes the
  // overlay so the LEDs return to the user's own configured lighting (not a blank
  // default). No-op-safe: if lighting is disabled nothing renders. color/style are
  // already validated by the catalog.
  lighting: async (action) => {
    if (action.mode === 'restore') { lighting.clearDeckReaction(); return true; }
    return lighting.setDeckReaction(action.color, action.style);
  },
  // remote: injected below once remoteControl is created (see createRemoteControl call)
};
const deckRegistry = createRegistry(deckRegistryDeps);

// Performance Mode runner: guided, reversible app management. Side-effects are
// injected so the allowlist/validation stays the only execution path. The
// window helper does the graceful close and protected-process refusal.
const perfRegistry = createPerfRegistry({
  closeWindow: (id) => runWindowsTool(['close', id], 8000),
  openExternal: (p) => runPowerShellScript(DECK_ACTIONS_SCRIPT, ['open', p], 8000),
  fileExists: (p) => { try { return fs.existsSync(p); } catch { return false; } },
  setPriority: (name, level) => runPowerShellScript(PERF_PRIORITY_SCRIPT, ['set', name, level === 'high' ? 'high' : 'normal'], 6000),
});

// Default body cap for JSON/text routes. Generous enough for the largest legit
// payload (AI chat carries base64 screenshots, a few MB) while bounding memory
// against a buggy/looping local client that would otherwise grow the string
// without limit. Mirrors the reject pattern of readBodyBuffer; every caller is
// try/catch-wrapped, so the rejection surfaces as a normal 500.
const READ_BODY_MAX_BYTES = 64 * 1024 * 1024;
function readBody(req, maxBytes = READ_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function readBodyBuffer(req, maxBytes = BACKGROUND_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('Payload too large');
        err.code = 'PAYLOAD_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipartBackground(req, body) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Missing multipart boundary');

  const boundaryText = match[1] || match[2];
  const boundary = Buffer.from(`--${boundaryText}`);
  const separator = Buffer.from('\r\n\r\n');
  const nextBoundaryPrefix = Buffer.from(`\r\n--${boundaryText}`);
  let offset = body.indexOf(boundary);

  while (offset !== -1) {
    let partStart = offset + boundary.length;
    if (body[partStart] === 45 && body[partStart + 1] === 45) break;
    if (body[partStart] === 13 && body[partStart + 1] === 10) partStart += 2;

    const headerEnd = body.indexOf(separator, partStart);
    if (headerEnd === -1) break;
    const headers = body.slice(partStart, headerEnd).toString('latin1');
    const dataStart = headerEnd + separator.length;
    const dataEnd = body.indexOf(nextBoundaryPrefix, dataStart);
    if (dataEnd === -1) break;

    const disposition = headers.match(/content-disposition:\s*([^\r\n]+)/i);
    const name = disposition && disposition[1].match(/name="([^"]+)"/i);
    const filename = disposition && disposition[1].match(/filename="([^"]*)"/i);
    if (name && name[1] === 'background' && filename && filename[1]) {
      const typeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
      return {
        originalName: path.basename(filename[1]).replace(/[^A-Za-z0-9._ -]/g, '').slice(0, 120) || 'background',
        contentType: typeMatch ? typeMatch[1].trim().toLowerCase() : '',
        data: body.slice(dataStart, dataEnd),
      };
    }
    offset = body.indexOf(boundary, dataEnd);
  }
  throw new Error('Missing background file');
}

function cleanupOldBackgrounds(keepName) {
  fs.promises.readdir(UPLOADS_DIR).then(files => Promise.all(files
    .filter(file => file.startsWith('background-') && file !== keepName)
    .map(file => fs.promises.unlink(path.join(UPLOADS_DIR, file)).catch(() => {}))
  )).catch(() => {});
}

// ── Screen enumeration + capture (shared by /api/screens, /api/screenshot,
//    and the AI capture_screen function) ───────────────────────────────────
async function listScreens() {
  const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
  try {
    const stdout = await new Promise((resolve, reject) =>
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
        { maxBuffer: 64 * 1024, windowsHide: true },
        (err, out) => err ? reject(err) : resolve(out)
      )
    );
    return stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
      const [x, y, w, h, primary, dev] = line.trim().split('|');
      const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
      return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
    });
  } catch {
    return [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }];
  }
}

// Capture a screenshot; `monitor` is an optional {x,y,width,height} region.
// Returns base64 JPEG.
async function captureScreenshot(monitor) {
  const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
  try {
    const ffmpeg = getFfmpegPath();
    const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
    if (monitor && monitor.width > 0 && monitor.height > 0) {
      ffmpegArgs.push('-offset_x', String(monitor.x), '-offset_y', String(monitor.y), '-video_size', `${monitor.width}x${monitor.height}`);
    }
    ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
    await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
    const imgBuffer = await fs.promises.readFile(tmpPath);
    return imgBuffer.toString('base64');
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// ── Server-side audio output (voice + chimes) ──────────────────────────────
// Plays through the system default device so audio works regardless of which
// window has focus (the browser WebView blocks autoplay without a user gesture).
let _speakProc = null;
let _speakGenToken = 0; // incremented on each stopServerSpeak to abort in-flight generation

// Duck/restore helpers — lower device volume so music quiets while Xenon speaks,
// then restore to the saved level. Safe to call multiple times (guarded by flag).
function _duckSpeakerVolume() {
  if (!_duckActive && cachedSpeakerId) {
    _duckSavedVolume = _lastSpeakerVolume;
    _duckActive = true;
    execFile(SVV, ['/SetVolume', cachedSpeakerId, '30'], () => {});
    process.stdout.write(`[Duck] volume ${_duckSavedVolume} → 30\n`);
  }
}
function _restoreSpeakerVolume() {
  if (_duckActive && cachedSpeakerId) {
    const vol = _duckSavedVolume != null ? _duckSavedVolume : 70;
    _duckActive = false;
    _duckSavedVolume = null;
    execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], () => {});
    process.stdout.write(`[Duck] restored → ${vol}\n`);
  }
}

function stopServerSpeak() {
  _speakGenToken++;
  if (_speakProc) { try { _speakProc.kill(); } catch {} _speakProc = null; }
  _restoreSpeakerVolume(); // restore if ducked during interrupted TTS
}

// Gemini native TTS (prebuilt neural voice). Returns a Promise<Buffer> with WAV
// audio, or rejects on error (quota, offline, no audio). Voice names are
// language-agnostic — the model speaks whatever language the text is in.
function _geminiTtsToWav(text, apiKey, voice = 'Charon') {
  return new Promise((resolve, reject) => {
    const safeVoice = String(voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
    const payload = JSON.stringify({
      contents: [{ parts: [{ text: String(text || '').slice(0, 1000) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: safeVoice } } },
      },
    });
    const t0 = Date.now();
    const ttsReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (ttsRes) => {
      let d = '';
      ttsRes.on('data', c => { d += c; });
      ttsRes.on('end', () => {
        process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini tts error'));
          const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          if (!part || !part.data) return reject(new Error('no audio data'));
          const pcmBytes = Buffer.from(part.data, 'base64');
          const rateMatch = String(part.mimeType || '').match(/rate=(\d+)/);
          const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
          resolve(pcmToWav(pcmBytes, sampleRate));
        } catch (e) { reject(e); }
      });
    });
    ttsReq.on('error', reject);
    ttsReq.setTimeout(20000, () => { ttsReq.destroy(); reject(new Error('gemini tts timeout')); });
    ttsReq.write(payload);
    ttsReq.end();
  });
}

// One-shot Gemini text generation (no tools, no history). Used by the opt-in
// advanced features (Game Companion, Guardian) for single fire-and-forget
// analyses. `parts` follows the Gemini content-part shape (text / inlineData).
function _geminiOneShot(apiKey, parts, systemText, maxTokens = 512) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      ...(systemText ? { system_instruction: { parts: [{ text: String(systemText) }] } } : {}),
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
    });
    const gReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (gRes) => {
      let d = '';
      gRes.on('data', c => { d += c; });
      gRes.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return reject(new Error(parsed.error.message || 'gemini error'));
          const text = (parsed?.candidates?.[0]?.content?.parts || [])
            .filter(p => typeof p.text === 'string' && !p.thought).map(p => p.text).join('').trim();
          if (!text) return reject(new Error('empty response'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    gReq.on('error', reject);
    gReq.setTimeout(30000, () => { gReq.destroy(); reject(new Error('gemini timeout')); });
    gReq.write(payload);
    gReq.end();
  });
}

// Play a WAV file via Windows SoundPlayer (synchronous, focus-independent).
// Resolves when playback finishes or is cancelled. Honours the cancel token.
function _playWavFile(wavPath, myToken) {
  return new Promise((resolve) => {
    if (_speakGenToken !== myToken) { fs.promises.unlink(wavPath).catch(() => {}); return resolve(); }
    _duckSpeakerVolume(); // lower music/media volume while Xenon speaks
    broadcastSSE('speak_start', {}); // tell the UI the voice is actually starting now
    const ps = `(New-Object System.Media.SoundPlayer -ArgumentList '${wavPath}').PlaySync();` +
               `try { Remove-Item -LiteralPath '${wavPath}' -Force -EA SilentlyContinue } catch {}`;
    const psProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    _speakProc = psProc;
    let _settled = false;
    const done = () => {
      if (_settled) return;
      _settled = true;
      clearTimeout(_guard);
      if (_speakProc === psProc) _speakProc = null;
      _restoreSpeakerVolume(); // bring music back when Xenon finishes speaking
      resolve();
    };
    const _guard = setTimeout(() => { try { psProc.kill(); } catch {} done(); }, 28000);
    psProc.on('exit', done);
    psProc.on('error', done);
  });
}

// Speak text server-side using Gemini neural TTS (voice: Charon).
// Playback is server-side so it works regardless of window focus or WebView quirks.
// Resolves when speech finishes (or is stopped). Silently resolves on TTS error.
function speakOnServer(text, langPrefix, apiKey, provider) {
  return new Promise(async (resolve) => {
    stopServerSpeak();
    const myToken = _speakGenToken;
    const clean = String(text || '').slice(0, 2000);
    if (!clean) return resolve();

    const useLocal = provider === 'ollama';
    if (!useLocal) {
      const key = String(apiKey || '').trim();
      if (!key) return resolve();
    }

    const gWavPath = path.join(os.tmpdir(), `xenon-gtts-${Date.now()}-${myToken}.wav`);
    try {
      const wavBuf = useLocal
        ? await aiLocal.localTts(clean, langPrefix, getFfmpegPath())
        : await _geminiTtsToWav(clean, String(apiKey || '').trim(), 'Charon');
      if (_speakGenToken !== myToken) return resolve();
      if (!wavBuf || wavBuf.length === 0) return resolve();
      await fs.promises.writeFile(gWavPath, wavBuf);
      if (_speakGenToken !== myToken) { fs.promises.unlink(gWavPath).catch(() => {}); return resolve(); }
      await _playWavFile(gWavPath, myToken);
    } catch (e) {
      process.stdout.write(`[TTS] ${useLocal ? 'Edge' : 'Gemini'} failed (${e.message})\n`);
      fs.promises.unlink(gWavPath).catch(() => {});
    }
    resolve();
  });
}

// Provider-agnostic tool dispatch shared by the Gemini and Ollama chat loops.
// `deps` carries the per-request context the handlers need.
// Persist the bridge's current lighting config into settings.json so AI-driven
// (and endpoint-driven) changes survive a restart. Best-effort; never throws.
async function _persistLighting() {
  try { _serverHubSettings = await writeHubSettings({ ..._serverHubSettings, lighting: lighting.getConfig() }); }
  catch (e) { console.error('Lighting persist failed:', e.message); }
}

// Returns { fnResult, clientActions, pendingScreenImage }.
async function executeAiTool(fnName, fnArgs, deps) {
  const {
    apiKey, uiLang, latestUserText,
    latestLooksLikeClothingWeather, latestExplicitlyWantsScreen,
    provider,
  } = deps;
  const clientActions = [];
  let pendingScreenImage = null;
  let fnResult;

  const CLIENT_ACTIONS = new Set(['open_weather_panel', 'open_settings', 'open_app_switcher', 'show_lock_screen', 'change_theme', 'close_ai_panel', 'refresh_tasks', 'refresh_calendar', 'refresh_timers', 'go_to_page', 'switch_deck_profile', 'optimize_performance', 'restore_performance', 'genesis_compose_page', 'genesis_add_widgets', 'genesis_duplicate_widget', 'genesis_remove_page', 'genesis_setup_deck']);

  if (CLIENT_ACTIONS.has(fnName)) {
    clientActions.push({ action: fnName, args: fnArgs });
    fnResult = { ok: true };
    return { fnResult, clientActions, pendingScreenImage };
  }

  try {
    if (fnName === 'guardian_report') {
      // Guardian (opt-in): deterministic local digest of the sensor history —
      // the model turns it into a human health report. Zero extra API calls.
      fnResult = await guardian.getDigest();
    } else if (fnName === 'toggle_mic') {
      isMuted = !isMuted; setMicMute(isMuted);
      fnResult = { ok: true, muted: isMuted };
    } else if (fnName === 'mute_mic') {
      isMuted = true; setMicMute(true);
      fnResult = { ok: true, muted: true };
    } else if (fnName === 'unmute_mic') {
      isMuted = false; setMicMute(false);
      fnResult = { ok: true, muted: false };
    } else if (fnName === 'media_playpause') {
      fnResult = await mediaAction('playpause');
    } else if (fnName === 'media_next') {
      fnResult = await mediaAction('next');
    } else if (fnName === 'media_previous') {
      fnResult = await mediaAction('previous');
    } else if (fnName === 'set_volume') {
      const vol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (cachedSpeakerId) {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => e ? reject(e) : resolve());
        });
      }
      fnResult = { ok: true, level: vol };
    } else if (fnName === 'toggle_speaker_mute') {
      if (!cachedSpeakerId) { fnResult = { error: 'audio not ready' }; }
      else {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/Switch', cachedSpeakerId], e => e ? reject(e) : resolve());
        });
        fnResult = { ok: true };
      }
    } else if (fnName === 'set_mic_volume') {
      const micVol = Math.max(0, Math.min(100, parseInt(fnArgs.level || 50)));
      if (!cachedMicId) { fnResult = { error: 'mic not ready' }; }
      else {
        await new Promise((resolve, reject) => {
          execFile(SVV, ['/SetVolume', cachedMicId, String(micVol)], e => e ? reject(e) : resolve());
        });
        fnResult = { ok: true, level: micVol };
      }
    } else if (fnName === 'lock_pc') {
      await new Promise((resolve, reject) => {
        exec('rundll32.exe user32.dll,LockWorkStation', e => e ? reject(e) : resolve());
      });
      fnResult = { ok: true };
    } else if (fnName === 'capture_screen') {
      if (latestLooksLikeClothingWeather && !latestExplicitlyWantsScreen) {
        const weatherForAdvice = await getWeather(uiLang || 'it', null).catch(e => ({ error: e.message }));
        fnResult = {
          error: 'screen_capture_not_requested',
          instruction: 'The latest request is about weather/clothing, not screen vision. Do not ask which monitor. Use the included weather data and answer what the user should wear.',
          weather: weatherForAdvice,
          latest_user_text: latestUserText,
        };
      } else {
        const screens = await listScreens();
        const reqMon = fnArgs.monitor != null ? parseInt(fnArgs.monitor) - 1 : -1;
        if (screens.length > 1 && (reqMon < 0 || reqMon >= screens.length)) {
          // Ambiguous on a multi-monitor setup — show a clickable picker in the UI
          // and let Gemini inform the user verbally at the same time.
          clientActions.push({
            action: 'show_monitor_picker',
            args: {
              screens: screens.map((s, i) => ({
                index: i + 1, primary: s.primary,
                width: s.width, height: s.height,
                x: s.x, y: s.y,
              })),
            },
          });
          fnResult = {
            needs_monitor_choice: true,
            monitor_count: screens.length,
            monitors: screens.map((s, i) => ({ number: i + 1, primary: s.primary, resolution: `${s.width}x${s.height}` })),
          };
        } else {
          const target = screens.length === 1 ? screens[0]
            : (reqMon >= 0 ? screens[reqMon] : (screens.find(s => s.primary) || screens[0]));
          _aiFocusedScreen = target;
          try {
            pendingScreenImage = await captureScreenshot(target);
            fnResult = { ok: true, captured: true, monitor: screens.indexOf(target) + 1, resolution: `${target.width}x${target.height}` };
          } catch (capErr) {
            fnResult = { error: 'capture failed: ' + capErr.message };
          }
        }
      }
    } else if (fnName === 'get_system_info') {
      fnResult = await getSystemInfo();
    } else if (fnName === 'set_lights') {
      const ok = lighting.setManualColor(fnArgs.color);
      fnResult = ok ? { ok: true, color: String(fnArgs.color || '') }
                    : { error: 'unknown_colour', hint: 'use a colour name or #RRGGBB' };
    } else if (fnName === 'clear_lights') {
      lighting.clearManual();
      fnResult = { ok: true };
    } else if (fnName === 'set_effect') {
      const eff = String(fnArgs.effect || '');
      let ok = false;
      if (eff === 'temperature' || eff === 'volume') {
        lighting.applyConfig({ effects: { [eff]: !!fnArgs.enabled } }); ok = true;
      } else if (['timer', 'notification', 'reminder'].includes(eff)) {
        lighting.applyConfig({ effects: { [eff]: { enabled: !!fnArgs.enabled } } }); ok = true;
      }
      if (ok) await _persistLighting();
      fnResult = ok ? { ok: true, effect: eff, enabled: !!fnArgs.enabled }
                    : { error: 'unknown_effect', hint: 'one of: temperature, volume, timer, notification, reminder' };
    } else if (fnName === 'set_event_effect') {
      const eff = String(fnArgs.effect || '');
      if (!['timer', 'notification', 'reminder'].includes(eff)) {
        fnResult = { error: 'unknown_effect', hint: 'one of: timer, notification, reminder' };
      } else {
        const patch = {};
        if (fnArgs.color != null) {
          const c = lighting._fx.parseColorName(fnArgs.color);
          if (c) patch.color = `#${[c.r, c.g, c.b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
        }
        if (['blink', 'pulse', 'solid'].includes(fnArgs.style)) patch.style = fnArgs.style;
        if (typeof fnArgs.enabled === 'boolean') patch.enabled = fnArgs.enabled;
        lighting.applyConfig({ effects: { [eff]: patch } });
        await _persistLighting();
        fnResult = { ok: true, effect: eff, config: lighting.getConfig().effects[eff] };
      }
    } else if (fnName === 'set_lighting_bridge') {
      lighting.setEnabled(!!fnArgs.enabled);
      if (fnArgs.enabled) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      fnResult = { ok: true, enabled: !!fnArgs.enabled, status: lighting.getStatus() };
    } else if (fnName === 'show_sensor') {
      const sys = await getSystemInfo().catch(() => null);
      const value = (fnArgs.sensor === 'cpuTemp' && sys) ? sys.cpuTemp : null;
      fnResult = { sensor: fnArgs.sensor, value, lightingAvailable: lighting.getStatus().available };
    } else if (fnName === 'get_weather') {
      fnResult = await getWeather(uiLang || 'it', null);
    } else if (fnName === 'web_search') {
      // Local provider stays key-free: search via DuckDuckGo instead of Gemini
      // grounding. Cloud (Gemini) provider keeps the richer grounded search.
      const searchRes = provider === 'ollama'
        ? await aiLocal.localWebSearch(fnArgs.query)
        : await _geminiWebSearch(fnArgs.query, apiKey);
      fnResult = searchRes.error
        ? { error: searchRes.error, note: 'web search unavailable — answer from your own knowledge and say it may not be up to date' }
        : { query: String(fnArgs.query || ''), result: searchRes.answer, sources: searchRes.sources, note: 'Search results may be in another language — answer in the user\'s language.' };
    } else if (fnName === 'read_notes') {
      const notesText = await fs.promises.readFile(NOTES_FILE, 'utf8').catch(() => '');
      fnResult = { notes: notesText };
    } else if (fnName === 'write_notes') {
      const safe = String(fnArgs.content || '').slice(0, 200_000);
      // Guard: never silently erase the notes with an empty string.
      // The model must use clear_all_tasks-style explicit intent for destructive ops.
      if (safe.trim() === '') { fnResult = { error: 'content is empty — to clear notes, send a single space or ask the user to confirm' }; }
      else {
        await fs.promises.writeFile(NOTES_FILE, safe, 'utf8');
        clientActions.push({ action: 'refresh_notes', args: {} });
        fnResult = { ok: true };
      }
    } else if (fnName === 'list_tasks') {
      const tasks = await readTasks();
      fnResult = { tasks: tasks.map(t => ({ id: t.id, text: t.text, priority: t.priority, completed: t.completed })) };
    } else if (fnName === 'create_task') {
      const taskText = String(fnArgs.text || '').trim();
      if (!taskText) { fnResult = { error: 'empty text' }; }
      else {
        const tasks = await readTasks();
        const newTask = normalizeTask({
          text: taskText,
          priority: TASK_PRIORITIES.includes(fnArgs.priority) ? fnArgs.priority : 'medium',
          recurrence: 'never',
        });
        tasks.push(newTask);
        await writeTasks(tasks);
        clientActions.push({ action: 'refresh_tasks', args: {} });
        fnResult = { ok: true, task: { id: newTask.id, text: newTask.text, priority: newTask.priority } };
      }
    } else if (fnName === 'delete_task') {
      const delId = String(fnArgs.id || '').trim();
      if (!delId) { fnResult = { error: 'missing id' }; }
      else {
        const tasks = await readTasks();
        const before = tasks.length;
        const remaining = tasks.filter(t => t.id !== delId);
        if (remaining.length === before) { fnResult = { error: 'task not found', id: delId }; }
        else {
          await writeTasks(remaining);
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, deleted: delId };
        }
      }
    } else if (fnName === 'clear_all_tasks') {
      await writeTasks([]);
      clientActions.push({ action: 'refresh_tasks', args: {} });
      fnResult = { ok: true, deleted: 'all' };
    } else if (fnName === 'complete_task') {
      const taskId = String(fnArgs.id || '').trim();
      const makeCompleted = fnArgs.completed !== false; // defaults to true
      if (!taskId) { fnResult = { error: 'missing id' }; }
      else {
        const tasks = await readTasks();
        const task = tasks.find(t => t.id === taskId);
        if (!task) { fnResult = { error: 'task not found', id: taskId }; }
        else {
          task.completed = makeCompleted;
          task.completedAt = makeCompleted ? new Date().toISOString() : null;
          await writeTasks(tasks);
          clientActions.push({ action: 'refresh_tasks', args: {} });
          fnResult = { ok: true, id: taskId, completed: makeCompleted };
        }
      }
    } else if (fnName === 'list_calendar_events') {
      // Return ALL events (past included): the model needs every event to be
      // able to delete or reference them. Past events were previously filtered
      // out, which made "delete all events" wrongly report an empty calendar.
      const events = await readEvents();
      const sorted = events
        .slice()
        .sort((a, b) => (a.startsAt || '').localeCompare(b.startsAt || ''))
        .slice(0, 50);
      fnResult = { count: events.length, events: sorted.map(e => ({ id: e.id, title: e.title, startsAt: e.startsAt, notes: e.notes })) };
    } else if (fnName === 'create_calendar_event') {
      const evTitle = String(fnArgs.title || '').trim();
      if (!evTitle) { fnResult = { error: 'empty title' }; }
      else {
        const events = await readEvents();
        const newEvent = {
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          title: evTitle.slice(0, 120),
          notes: String(fnArgs.notes || '').trim().slice(0, 600),
          startsAt: String(fnArgs.starts_at || '').trim(),
          reminderAt: String(fnArgs.reminder_at || '').trim(),
          notifiedAt: '',
          createdAt: new Date().toISOString(),
        };
        events.push(newEvent);
        await writeEvents(events);
        clientActions.push({ action: 'refresh_calendar', args: {} });
        fnResult = { ok: true, event: { id: newEvent.id, title: newEvent.title, startsAt: newEvent.startsAt } };
      }
    } else if (fnName === 'delete_calendar_event') {
      const evId = String(fnArgs.id || '').trim();
      if (!evId) { fnResult = { error: 'missing id' }; }
      else {
        const events = await readEvents();
        const before = events.length;
        const remaining = events.filter(e => e.id !== evId);
        if (remaining.length === before) { fnResult = { error: 'event not found', id: evId }; }
        else {
          await writeEvents(remaining);
          clientActions.push({ action: 'refresh_calendar', args: {} });
          fnResult = { ok: true, deleted: evId };
        }
      }
    } else if (fnName === 'clear_all_calendar_events') {
      const events = await readEvents();
      const removed = events.length;
      await writeEvents([]);
      clientActions.push({ action: 'refresh_calendar', args: {} });
      fnResult = { ok: true, deleted: 'all', count: removed };
    } else if (fnName === 'open_application') {
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Some apps are more reliably opened via their registered URI protocol
        // than via App Paths name lookup (e.g. Steam doesn't always resolve by
        // name). Use canonical deep links that actually open a window — a bare
        // "steam://" invokes the handler but opens nothing visible.
        const PROTOCOL_MAP = {
          'steam': 'steam://open/main', 'steam client': 'steam://open/main',
          'discord': 'discord://',
          'whatsapp': 'whatsapp://',
          'slack': 'slack://',
          'zoom': 'zoommtg://',
          'epic': 'com.epicgames.launcher://apps',
          'epic games': 'com.epicgames.launcher://apps',
        };
        const resolved = PROTOCOL_MAP[rawTarget.toLowerCase()] || rawTarget;
        // Escape single quotes for PowerShell single-quoted strings
        const psEscaped = resolved.replace(/'/g, "''");
        // Use ShellExecute (UseShellExecute=true) for reliable App Paths & protocol lookup.
        // Unlike `cmd /c start`, this gives a real exception on failure → detectable error.
        const ps = `try{[void][System.Diagnostics.Process]::Start([System.Diagnostics.ProcessStartInfo]@{FileName='${psEscaped}';UseShellExecute=$true})}catch{exit 1}`;
        try {
          await new Promise((resolve, reject) =>
            execFile('powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', ps],
              { windowsHide: true, timeout: 10000 },
              (err) => err ? reject(new Error(`"${rawTarget}" non trovato o non installato`)) : resolve()
            )
          );
          fnResult = { ok: true, opened: rawTarget };
        } catch (launchErr) {
          fnResult = { error: launchErr.message };
        }
      }
    } else if (fnName === 'close_application') {
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Map friendly names → common process names (without .exe)
        const CLOSE_MAP = {
          'spotify': 'spotify', 'chrome': 'chrome', 'google chrome': 'chrome',
          'firefox': 'firefox', 'edge': 'msedge', 'microsoft edge': 'msedge',
          'notepad': 'notepad', 'vlc': 'vlc', 'discord': 'discord',
          'steam': 'steam', 'obs': 'obs64', 'obs studio': 'obs64',
          'word': 'winword', 'excel': 'excel', 'powerpoint': 'powerpnt',
          'teams': 'teams', 'zoom': 'zoom', 'slack': 'slack',
          'whatsapp': 'whatsapp',
        };
        const procName = (CLOSE_MAP[rawTarget.toLowerCase()] || rawTarget).replace(/\.exe$/i, '');
        const psEsc = procName.replace(/'/g, "''");
        const ps = `$p=Get-Process -Name '*${psEsc}*' -EA SilentlyContinue; if($p){$p|Stop-Process -Force;exit 0}else{exit 1}`;
        try {
          await new Promise((resolve, reject) =>
            execFile('powershell.exe',
              ['-NoProfile', '-NonInteractive', '-Command', ps],
              { windowsHide: true, timeout: 10000 },
              (err) => {
                if (!err) resolve();
                else if (err.code === 1) reject(new Error(`"${rawTarget}" not found or already closed`));
                else reject(err);
              }
            )
          );
          fnResult = { ok: true, closed: rawTarget };
        } catch (closeErr) {
          fnResult = { error: closeErr.message };
        }
      }
    } else if (fnName === 'start_timer') {
      const durSecs = Math.max(1, Math.round(Number(fnArgs.duration_secs) || 60));
      const timerLabel = String(fnArgs.label || 'Timer').trim().slice(0, 40);
      if (_timers.length >= TIMERS_MAX) {
        fnResult = { error: 'Too many timers active' };
      } else {
        const newTimer = _normalizeTimer({ label: timerLabel, durationSecs: durSecs, status: 'running', startedAt: Date.now(), pausedElapsed: 0 });
        _timers.push(newTimer);
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: _timers });
        const mins = Math.floor(durSecs / 60), secs = durSecs % 60;
        const durationLabel = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins} min`) : `${secs}s`;
        fnResult = { ok: true, id: newTimer.id, label: timerLabel, duration: durationLabel };
      }
    } else if (fnName === 'list_timers') {
      fnResult = {
        timers: _timers.map(t => ({
          id: t.id, label: t.label, status: t.status,
          remaining_secs: Math.ceil(_getTimerRemaining(t)),
          duration_secs: t.durationSecs,
        })),
      };
    } else if (fnName === 'delete_timer') {
      const delId = String(fnArgs.id || '').trim();
      const before = _timers.length;
      _timers = _timers.filter(t => t.id !== delId);
      if (_timers.length < before) {
        await _saveTimers();
        clientActions.push({ action: 'refresh_timers', args: {} });
        broadcastSSE('timer_update', { timers: _timers });
        fnResult = { ok: true };
      } else {
        fnResult = { error: 'timer not found' };
      }
    } else if (fnName === 'app_audio') {
      // Per-app mixer via the same allowlisted registry the Deck uses.
      const app = String(fnArgs.app || '').trim();
      const action = String(fnArgs.action || '');
      const map = {
        volume_up: { type: 'appVolume', app, mode: 'up' },
        volume_down: { type: 'appVolume', app, mode: 'down' },
        mute: { type: 'appMute', app, mode: 'mute' },
        unmute: { type: 'appMute', app, mode: 'unmute' },
        toggle_mute: { type: 'appMute', app, mode: 'toggle' },
      };
      const act = map[action];
      fnResult = !app ? { error: 'no_app' } : (act ? await deckRegistry.run(act) : { error: 'bad_action' });
    } else if (fnName === 'obs_control') {
      // Route through the same allowlisted deck registry that Deck keys use, so
      // validation/normalisation lives in one place. A missing OBS connection
      // comes back as {error:'obs_unavailable'} — the model tells the user.
      const map = {
        start_recording: { type: 'obsRecord', mode: 'start' },
        stop_recording: { type: 'obsRecord', mode: 'stop' },
        toggle_recording: { type: 'obsRecord', mode: 'toggle' },
        start_streaming: { type: 'obsStream', mode: 'start' },
        stop_streaming: { type: 'obsStream', mode: 'stop' },
        toggle_streaming: { type: 'obsStream', mode: 'toggle' },
        switch_scene: { type: 'obsScene', scene: String(fnArgs.scene || '') },
        next_scene: { type: 'obsSceneNext' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await deckRegistry.run(action) : { error: 'bad_action' };
    } else if (fnName === 'twitch_action') {
      const value = String(fnArgs.value || '');
      const map = {
        create_clip: { type: 'twitchClip' },
        set_title: { type: 'twitchTitle', title: value },
        set_game: { type: 'twitchGame', game: value },
        send_chat: { type: 'twitchChat', message: value },
        marker: { type: 'twitchMarker', description: value },
        shoutout: { type: 'twitchShoutout', login: value },
        chat_mode: { type: 'twitchChatMode', mode: value },
        run_ad: { type: 'twitchAd', length: value || '60' },
      };
      const action = map[String(fnArgs.action || '')];
      fnResult = action ? await deckRegistry.run(action) : { error: 'bad_action' };
    } else if (fnName === 'youtube_broadcast') {
      fnResult = await deckRegistry.run({ type: 'ytBroadcast', mode: String(fnArgs.mode || 'toggle') });
    } else if (fnName === 'streamerbot_action') {
      const act = String(fnArgs.action || '').trim();
      fnResult = act ? await deckRegistry.run({ type: 'sbDoAction', action: act }) : { error: 'no_action' };
    } else {
      fnResult = { error: 'unknown_function' };
    }
  } catch (fnErr) {
    fnResult = { error: fnErr.message };
  }

  return { fnResult, clientActions, pendingScreenImage };
}

// Build a short two-note chime WAV in memory (sine + decay envelope).
let _chimeCache = {};
function _buildChimeWav(kind) {
  const rate = 24000, dur = 0.6;
  const notes = kind === 'close' ? [[660, 0], [440, 0.13]] : [[784, 0], [1046, 0.13]];
  const total = Math.floor(rate * dur);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    const t = i / rate;
    let s = 0;
    for (const [freq, start] of notes) {
      if (t >= start) {
        const lt = t - start;
        const env = Math.exp(-lt * 4) * (1 - Math.exp(-lt * 80));
        s += Math.sin(2 * Math.PI * freq * lt) * env;
      }
    }
    s = Math.max(-1, Math.min(1, s * 0.08));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return pcmToWav(buf, rate, 1, 16);
}

function playChimeOnServer(kind) {
  const k = kind === 'close' ? 'close' : 'wake';
  if (!_chimeCache[k]) {
    try { _chimeCache[k] = _buildChimeWav(k); } catch { return; }
  }
  const wavPath = path.join(os.tmpdir(), `xenon-chime-${k}.wav`);
  fs.promises.writeFile(wavPath, _chimeCache[k]).then(() => {
    const ps = "(New-Object System.Media.SoundPlayer -ArgumentList '" + wavPath + "').PlaySync();";
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    proc.on('error', () => {});
  }).catch(() => {});
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function getFfmpegPath() {
  if (process.env.XEH_FFMPEG) return process.env.XEH_FFMPEG;
  const localCandidates = [
    path.join(__dirname, 'ffmpeg.exe'),
    path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'),
  ];
  const local = localCandidates.find(candidate => fs.existsSync(candidate));
  if (local) return local;

  if (process.env.LOCALAPPDATA) {
    const wingetPackages = path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    const wingetFfmpeg = findFirstFile(wingetPackages, 'ffmpeg.exe', 5);
    if (wingetFfmpeg) return wingetFfmpeg;
  }

  return 'ffmpeg.exe';
}

function findFirstFile(root, fileName, maxDepth) {
  if (!root || maxDepth < 0 || !fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const direct = entries.find(entry => entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase());
    if (direct) return path.join(root, direct.name);

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = findFirstFile(path.join(root, entry.name), fileName, maxDepth - 1);
      if (found) return found;
    }
  } catch {}
  return null;
}

function isFfmpegMissing(error) {
  return error && (error.code === 'ENOENT' || /not recognized|ENOENT|cannot find/i.test(String(error.message || '')));
}

async function transcodeMp4BackgroundToWebm(sourcePath, targetPath) {
  const ffmpeg = getFfmpegPath();
  await execFilePromise(ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-i', sourcePath,
    '-vf', 'fps=30,scale=1920:-2',
    '-an',
    '-c:v', 'libvpx',
    '-deadline', 'good',
    '-cpu-used', '4',
    '-b:v', '6M',
    '-maxrate', '8M',
    '-bufsize', '12M',
    '-auto-alt-ref', '0',
    targetPath,
  ], { timeout: BACKGROUND_TRANSCODE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });

  const stat = await fs.promises.stat(targetPath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Converted WebM is empty');
  return stat;
}

const DashboardInstances = require('./js/dashboard-instances.js');

const DASHBOARD_WIDGET_IDS = Object.freeze(['media', 'agenda', 'mic', 'audio', 'system', 'notes', 'tasks', 'calendar', 'timer', 'chat', 'deck', 'remote', 'twitch', 'obs', 'youtube', 'browser', 'secondscreen']);
const DASHBOARD_PAGE_IDS = Object.freeze(['dashboard']);
const DASHBOARD_TAB_IDS = Object.freeze(['main', 'net']);
const CALENDAR_TAB_IDS = Object.freeze(['calendar', 'tasks', 'timer']);
const MEDIA_VIEW_IDS = Object.freeze(['media', 'calendar']);
const DASHBOARD_CARD_IDS = Object.freeze({
  main: ['cpu', 'gpu', 'ram', 'disk'],
  net: ['ping', 'fps', 'latency', 'bandwidth'],
  audio: ['volume', 'speaker', 'microphone'],
  twitch: ['info', 'actions', 'chat'],
  obs: ['preview', 'controls', 'scenes'],
  youtube: ['info', 'actions'],
});
const DASHBOARD_WIDGET_SIZES = Object.freeze(['compact', 'normal', 'wide', 'tall', 'large', 'full']);
const DASHBOARD_CARD_SIZES = Object.freeze(['compact', 'normal', 'wide']);
const DASHBOARD_GRID_COLUMNS = 12;     // GridStack column count
const DASHBOARD_GRID_MAX_ROW = 200;    // generous clamp for y/h
// Bump when the default dashboard layout changes in a way that should override
// users' saved layouts on upgrade. v5 = copies (multi-instance widgets).
const DASHBOARD_LAYOUT_VERSION = 6;
const DEFAULT_DASHBOARD_LAYOUT = Object.freeze({
  widgets: Object.freeze({
    media:    Object.freeze({ x: 0, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    agenda:   Object.freeze({ x: 4, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    system:   Object.freeze({ x: 8, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    mic:      Object.freeze({ x: 0, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    audio:    Object.freeze({ x: 3, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    notes:    Object.freeze({ x: 6, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    tasks:    Object.freeze({ x: 9, y: 4, w: 3, h: 2, visible: false, page: 'dashboard' }),
    calendar: Object.freeze({ x: 0, y: 6, w: 3, h: 2, visible: false, page: 'dashboard' }),
    timer:    Object.freeze({ x: 3, y: 6, w: 3, h: 2, visible: false, page: 'dashboard' }),
    chat:     Object.freeze({ x: 4, y: 0, w: 4, h: 4, visible: true,  page: 'dashboard' }),
    deck:     Object.freeze({ x: 0, y: 6, w: 4, h: 3, visible: false, page: 'dashboard' }),
    remote:   Object.freeze({ x: 4, y: 6, w: 4, h: 3, visible: false, page: 'dashboard' }),
    twitch:   Object.freeze({ x: 8, y: 6, w: 4, h: 2, visible: false, page: 'dashboard' }),
    obs:      Object.freeze({ x: 8, y: 8, w: 4, h: 3, visible: false, page: 'dashboard' }),
    youtube:  Object.freeze({ x: 8, y: 11, w: 4, h: 2, visible: false, page: 'dashboard' }),
    browser:  Object.freeze({ x: 0, y: 9, w: 6, h: 5, visible: false, page: 'dashboard' }),
    secondscreen: Object.freeze({ x: 6, y: 9, w: 6, h: 5, visible: false, page: 'dashboard' }),
  }),
  groups: Object.freeze({
    'media-group': Object.freeze({ id: 'media-group', members: Object.freeze(['media', 'chat']), active: 'media', x: 0, y: 0, w: 4, h: 4, page: 'dashboard', seeded: true, autoTabByMedia: true }),
  }),
  pages: Object.freeze([
    Object.freeze({ id: 'dashboard', name: '', nameKey: 'page_dashboard' }),
  ]),
  cards: Object.freeze({
    main: Object.freeze({
      cpu: Object.freeze({ order: 0, size: 'normal', visible: true }),
      gpu: Object.freeze({ order: 1, size: 'normal', visible: true }),
      ram: Object.freeze({ order: 2, size: 'normal', visible: true }),
      disk: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    net: Object.freeze({
      ping: Object.freeze({ order: 0, size: 'normal', visible: true }),
      fps: Object.freeze({ order: 1, size: 'normal', visible: true }),
      latency: Object.freeze({ order: 2, size: 'normal', visible: true }),
      bandwidth: Object.freeze({ order: 3, size: 'normal', visible: true }),
    }),
    audio: Object.freeze({
      volume: Object.freeze({ order: 0, size: 'wide', visible: true }),
      speaker: Object.freeze({ order: 1, size: 'normal', visible: true }),
      microphone: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    twitch: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
      chat: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    obs: Object.freeze({
      preview: Object.freeze({ order: 0, size: 'normal', visible: true }),
      controls: Object.freeze({ order: 1, size: 'normal', visible: true }),
      scenes: Object.freeze({ order: 2, size: 'normal', visible: true }),
    }),
    youtube: Object.freeze({
      info: Object.freeze({ order: 0, size: 'normal', visible: true }),
      actions: Object.freeze({ order: 1, size: 'normal', visible: true }),
    }),
  }),
  tabs: Object.freeze({ order: ['main', 'net'], active: 'main' }),
  calendarTabs: Object.freeze({ order: ['calendar', 'tasks', 'timer'], active: 'calendar' }),
  mediaView: Object.freeze({ active: 'media' }),
  topbarHidden: false,
});

const CALENDAR_FEED_PALETTE = Object.freeze(['#1ed760', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']);

const DEFAULT_HUB_SETTINGS = Object.freeze({
  appearance: 'dark',
  accent: '#1ed760',
  background: '#070808',
  text: '#f0f3f1',
  panelAlpha: 0.94,
  bgDim: 0.48,
  bgBlur: 0,
  backgroundMedia: null,
  lockWidgets: Object.freeze({ clock: true, weather: true, media: true, calendar: true }),
  weather: Object.freeze({ mode: 'auto', city: '' }),
  tempUnit: 'c', // 'c' | 'f' — weather temperature display unit
  clockFormat: 'auto', // 'auto' | '12' | '24' — auto follows the UI language
  // Open the dashboard in the default browser at Windows logon. The user's
  // intent (default on); the actual scheduled task is registered/removed by
  // /startup/auto-open and only ever for real-browser use, never Xeneon Edge.
  autoOpenBrowser: true,
  dashboardLayout: DEFAULT_DASHBOARD_LAYOUT,
  dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
  geminiApiKey: '',
  obsHost: '',
  obsPort: 4455,
  obsPassword: '',
  obsAutoLaunch: true,
  streamerbotHost: '',
  streamerbotPort: 8080,
  streamerbotPassword: '',
  aiProvider: 'gemini', // 'gemini' | 'ollama' — selected AI backend
  ollamaModel: 'auto',  // 'auto' | whitelist key | custom model tag
  ollamaUrl: 'http://localhost:11434',
  hardwareScan: null,   // { ram, vram, cores, tier, recommended } — populated by /api/ai-local/scan
  aiTtsEnabled: true,
  aiMicSensitivity: 50, // 0..100 slider — maps to the STT input gain (see _sttGain)
  aiChatHidden: false,
  // Opt-in advanced AI features (Settings → Funzioni AI) — all OFF by default.
  aiFeatures: Object.freeze({ enabled: false, genesis: false, gameCompanion: false, guardian: false, ambient: false }),
  bgAurora: Object.freeze({ enabled: true, intensity: 55, speed: 50 }),
  bgGrid: Object.freeze({ enabled: true, color: '#1ed760', intensity: 45, speed: 50 }),
  lighting: Object.freeze({
    enabled: false,            // master OFF by default — explicit opt-in, zero cost
    brightness: 1.0,
    pauseDuringGame: true,
    devices: {},               // deviceId → bool opt-in (absent/true = on)
    // All OFF by default — each effect is opt-in and independent of the master.
    effects: Object.freeze({
      temperature: false,      // CPU-temp colour
      volume: false,           // flash on volume change
      musicAlbum: false,       // tint from the now-playing cover
      timer:        Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
      notification: Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
      reminder:     Object.freeze({ enabled: false, color: '#ff0000', style: 'blink' }),
    }),
    animation: Object.freeze({ style: 'none', color: '#1ed760', speed: 50 }), // ambient anim: none|solid|breathing|cycle
    manualColor: '',               // persisted manual fixed colour ('' = none)
    providers: Object.freeze({}),  // external (non-iCUE) providers → { providerId: { devices: [...] } }
    deviceModes: Object.freeze({}), // per-device override → { deviceId: { mode, color?, anim? } }
  }),
  calendarFeeds: [],
  remoteControl: Object.freeze({ enabled: false, sunshineInstalled: false, tailscaleInstalled: false, sunshineUser: '', sunshinePass: '', selectedMonitors: [], selectedScreen: '' }),
  language: '', // '' = follow the browser; a WEATHER_LANGS code persists the user's chosen UI language across browser-storage resets
});

// In-memory mirror of the hub settings — the wake loop reads it on every clip and
// must not hit the disk that often. Populated at startup and on every POST.
let _serverHubSettings = { ...DEFAULT_HUB_SETTINGS };

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, numeric));
}

function normalizeHex(value, fallback) {
  const raw = String(value || '').trim();
  const short = raw.match(/^#?([0-9a-f]{3})$/i);
  if (short) return '#' + short[1].split('').map(ch => ch + ch).join('').toLowerCase();
  const full = raw.match(/^#?([0-9a-f]{6})$/i);
  return full ? '#' + full[1].toLowerCase() : fallback;
}

function sanitizeSettingsBackgroundMedia(value) {
  if (!value || typeof value !== 'object') return null;
  const url = String(value.url || '').trim();
  const name = String(value.name || '').trim().slice(0, 120);
  const type = String(value.type || '').trim().slice(0, 60);
  const version = String(value.version || '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  if (!url.startsWith('/uploads/')) return null;
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url)) return null;
  if (!/^(image|video)\//.test(type)) return null;
  return { url, name: name || url.split('/').pop(), type, version };
}

function normalizeLockWidgets(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.lockWidgets;
  return {
    clock: source.clock !== undefined ? !!source.clock : defaults.clock,
    weather: source.weather !== undefined ? !!source.weather : defaults.weather,
    media: source.media !== undefined ? !!source.media : defaults.media,
    calendar: source.calendar !== undefined ? !!source.calendar : defaults.calendar,
  };
}

function normalizeSettingsWeather(value) {
  const source = value && typeof value === 'object' ? value : {};
  const mode = source.mode === 'manual' ? 'manual' : DEFAULT_HUB_SETTINGS.weather.mode;
  return {
    mode,
    city: sanitizeWeatherCity(source.city),
  };
}

function normalizeBgAurora(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgAurora;
  return {
    enabled: source.enabled !== false,
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function normalizeBgGrid(value) {
  const source = value && typeof value === 'object' ? value : {};
  const defaults = DEFAULT_HUB_SETTINGS.bgGrid;
  return {
    enabled: source.enabled !== false,
    color: normalizeHex(source.color, defaults.color),
    intensity: clampNumber(source.intensity, 0, 100, defaults.intensity),
    speed: clampNumber(source.speed, 0, 100, defaults.speed),
  };
}

function cloneDashboardLayout(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeDashboardOrder(value, fallback, maxOrder) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.max(0, Math.min(maxOrder, numeric));
}

function normalizeDashboardSize(value, allowedSizes, fallback) {
  return allowedSizes.includes(value) ? value : fallback;
}

// Grid geometry for a widget (drag&drop model): {x,y,w,h,visible} in cells.
function normalizeDashboardGeom(sourceItem, fallbackItem) {
  const s = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  const intIn = (v, min, max, fb) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fb; };
  return {
    x: intIn(s.x, 0, DASHBOARD_GRID_COLUMNS - 1, fallbackItem.x),
    y: intIn(s.y, 0, DASHBOARD_GRID_MAX_ROW, fallbackItem.y),
    w: intIn(s.w, 1, DASHBOARD_GRID_COLUMNS, fallbackItem.w),
    h: intIn(s.h, 1, DASHBOARD_GRID_MAX_ROW, fallbackItem.h),
    visible: s.visible === undefined ? fallbackItem.visible : s.visible !== false,
  };
}

function normalizeDashboardItem(sourceItem, fallbackItem, maxOrder, allowedSizes) {
  const source = sourceItem && typeof sourceItem === 'object' ? sourceItem : {};
  return {
    order: normalizeDashboardOrder(source.order, fallbackItem.order, maxOrder),
    size: normalizeDashboardSize(source.size, allowedSizes, fallbackItem.size),
    visible: source.visible === undefined ? true : source.visible !== false,
  };
}

function sortDashboardIds(collection) {
  return Object.keys(collection).sort((left, right) => {
    const diff = collection[left].order - collection[right].order;
    return diff || left.localeCompare(right);
  });
}

function reindexDashboardCollection(collection) {
  sortDashboardIds(collection).forEach((id, index) => { collection[id].order = index; });
}

const DASHBOARD_PAGES_MAX = 8;
function normalizeDashboardPages(value) {
  const seed = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT.pages);
  if (!Array.isArray(value)) return seed;
  const out = [];
  const seen = new Set();
  value.forEach(p => {
    if (!p || typeof p !== 'object') return;
    const id = String(p.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const page = { id, name: String(p.name == null ? '' : p.name).trim().slice(0, 40) };
    if (p.nameKey) page.nameKey = String(p.nameKey).slice(0, 64);
    out.push(page);
  });
  return out.length ? out.slice(0, DASHBOARD_PAGES_MAX) : seed;
}

function normalizeDashboardGroups(value, widgets, pageIds, copies) {
  const copyIds = new Set((Array.isArray(copies) ? copies : []).map(c => c.id));
  const isInstance = (m) => (widgets && widgets[m]) || copyIds.has(m);
  const out = {};
  const src = value && typeof value === 'object' ? value : {};
  const used = new Set();
  Object.keys(src).forEach(gid => {
    const g = src[gid] && typeof src[gid] === 'object' ? src[gid] : {};
    let members = Array.isArray(g.members) ? g.members.filter(m => isInstance(m) && !used.has(m)) : [];
    members = members.filter((m, i) => members.indexOf(m) === i);
    if (members.length < 2) return;
    members.forEach(m => used.add(m));
    const id = String(gid).slice(0, 64);
    out[id] = {
      id, members,
      active: members.includes(g.active) ? g.active : members[0],
      x: Math.max(0, Math.round(Number(g.x)) || 0),
      y: Math.max(0, Math.round(Number(g.y)) || 0),
      w: Math.max(1, Math.round(Number(g.w)) || 4),
      h: Math.max(1, Math.round(Number(g.h)) || 4),
      page: pageIds.includes(g.page) ? g.page : pageIds[0],
      seeded: g.seeded === true,
      autoTabByMedia: g.autoTabByMedia === true,
    };
  });
  return out;
}

function normalizeDashboardTabs(sourceTabs) {
  const source = sourceTabs && typeof sourceTabs === 'object' ? sourceTabs : {};
  const sourceOrder = Array.isArray(source.order) ? source.order : DEFAULT_DASHBOARD_LAYOUT.tabs.order;
  const order = sourceOrder.filter(tab => DASHBOARD_TAB_IDS.includes(tab));
  DASHBOARD_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['main', 'net', 'volume', 'mic'].includes(source.active) ? source.active : DEFAULT_DASHBOARD_LAYOUT.tabs.active,
  };
}

function normalizeCalendarTabs(source) {
  const src = source && typeof source === 'object' ? source : {};
  const srcOrder = Array.isArray(src.order) ? src.order : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.order;
  const order = srcOrder.filter(tab => CALENDAR_TAB_IDS.includes(tab));
  CALENDAR_TAB_IDS.forEach(tab => { if (!order.includes(tab)) order.push(tab); });
  return {
    order,
    active: ['calendar', 'tasks', 'timer', 'notes'].includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.calendarTabs.active,
  };
}

function normalizeMediaView(source) {
  const src = source && typeof source === 'object' ? source : {};
  return {
    active: MEDIA_VIEW_IDS.includes(src.active) ? src.active : DEFAULT_DASHBOARD_LAYOUT.mediaView.active,
  };
}

function normalizeDashboardLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  const layout = cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT);
  const sourceWidgets = source.widgets && typeof source.widgets === 'object' ? source.widgets : {};

  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    const fb = DEFAULT_DASHBOARD_LAYOUT.widgets[widgetId];
    const geom = normalizeDashboardGeom(sourceWidgets[widgetId], fb);
    const srcPage = sourceWidgets[widgetId] && sourceWidgets[widgetId].page;
    // Keep ANY saved page id (incl. user-created pages); it's clamped to a real
    // page below against the actual page list. Validating here against the static
    // default ids would wrongly reset widgets added to a user page back to their
    // default page — making "+ add" land on the wrong page.
    geom.page = (typeof srcPage === 'string' && srcPage) ? srcPage : (fb.page || 'dashboard');
    layout.widgets[widgetId] = geom;
  });

  Object.keys(DASHBOARD_CARD_IDS).forEach(groupId => {
    const sourceCards = source.cards && source.cards[groupId] && typeof source.cards[groupId] === 'object'
      ? source.cards[groupId]
      : {};
    DASHBOARD_CARD_IDS[groupId].forEach(cardId => {
      layout.cards[groupId][cardId] = normalizeDashboardItem(
        sourceCards[cardId],
        DEFAULT_DASHBOARD_LAYOUT.cards[groupId][cardId],
        DASHBOARD_CARD_IDS[groupId].length - 1,
        DASHBOARD_CARD_SIZES,
      );
    });
    reindexDashboardCollection(layout.cards[groupId]);
  });

  layout.pages = normalizeDashboardPages(source.pages);
  const pageIds = layout.pages.map(p => p.id);
  const firstPage = pageIds[0];
  DASHBOARD_WIDGET_IDS.forEach(widgetId => {
    if (!pageIds.includes(layout.widgets[widgetId].page)) layout.widgets[widgetId].page = firstPage;
  });

  // Extra placements (duplicated widgets). Validated against known widgets/pages.
  layout.copies = DashboardInstances.normalizeCopies(source.copies, layout.widgets, pageIds);

  // Fall back to the seeded default groups when the source has none (e.g. reset,
  // or a pre-groups saved layout) — otherwise the welcome media-group is lost.
  layout.groups = normalizeDashboardGroups(
    source.groups !== undefined ? source.groups : DEFAULT_DASHBOARD_LAYOUT.groups,
    layout.widgets, pageIds, layout.copies);

  layout.tabs = normalizeDashboardTabs(source.tabs);
  layout.calendarTabs = normalizeCalendarTabs(source.calendarTabs);
  layout.mediaView = normalizeMediaView(source.mediaView);
  layout.topbarHidden = source.topbarHidden === true;
  return layout;
}

// Hardware scan result is server-generated; when echoed back from the client we
// keep only the known numeric/string fields and drop anything unexpected.
function normalizeHardwareScan(value) {
  if (!value || typeof value !== 'object') return null;
  const tiers = ['incompatible', 'minimum', 'recommended', 'optimal'];
  const tier = tiers.includes(value.tier) ? value.tier : 'incompatible';
  return {
    ram: clampNumber(value.ram, 0, 4096, 0),
    vram: clampNumber(value.vram, 0, 4096, 0),
    cores: clampNumber(value.cores, 0, 512, 0),
    tier,
    recommended: aiLocal.sanitizeModel(value.recommended),
  };
}

// Mirrors the client-side normalizeAiFeatures: every flag must be exactly
// `true` to count — anything else collapses to false (opt-in by design).
function normalizeServerAiFeatures(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: v.enabled === true,
    genesis: v.genesis === true,
    gameCompanion: v.gameCompanion === true,
    guardian: v.guardian === true,
    ambient: v.ambient === true,
  };
}

function normalizeHubSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  // One-time migration: saved layouts older than the current version are
  // replaced with the new default on upgrade (other settings preserved).
  const layoutVersion = Number(source.dashboardLayoutVersion) || 0;
  const resetLayout = layoutVersion < DASHBOARD_LAYOUT_VERSION;
  return {
    appearance: ['light', 'dark', 'auto'].includes(source.appearance) ? source.appearance : DEFAULT_HUB_SETTINGS.appearance,
    accent: normalizeHex(source.accent, DEFAULT_HUB_SETTINGS.accent),
    background: normalizeHex(source.background, DEFAULT_HUB_SETTINGS.background),
    text: normalizeHex(source.text, DEFAULT_HUB_SETTINGS.text),
    panelAlpha: clampNumber(source.panelAlpha, SETTINGS_MIN_PANEL_ALPHA, 1, DEFAULT_HUB_SETTINGS.panelAlpha),
    bgDim: clampNumber(source.bgDim, 0.05, 0.9, DEFAULT_HUB_SETTINGS.bgDim),
    bgBlur: clampNumber(source.bgBlur, 0, 24, DEFAULT_HUB_SETTINGS.bgBlur),
    backgroundMedia: sanitizeSettingsBackgroundMedia(source.backgroundMedia),
    lockWidgets: normalizeLockWidgets(source.lockWidgets),
    weather: normalizeSettingsWeather(source.weather),
    tempUnit: source.tempUnit === 'f' ? 'f' : 'c',
    clockFormat: ['auto', '12', '24'].includes(source.clockFormat) ? source.clockFormat : 'auto',
    autoOpenBrowser: source.autoOpenBrowser !== false,
    dashboardLayout: resetLayout
      ? cloneDashboardLayout(DEFAULT_DASHBOARD_LAYOUT)
      : normalizeDashboardLayout(source.dashboardLayout),
    dashboardLayoutVersion: DASHBOARD_LAYOUT_VERSION,
    // Client-owned saved presets (widget/tab-group/page templates). Re-validated
    // by the client (DashboardPresets); the server just round-trips a bounded
    // array so they survive a restart instead of being stripped.
    dashboardPresets: sanitizeDashboardPresets(source.dashboardPresets),
    geminiApiKey: String(source.geminiApiKey || '').trim().slice(0, 200),
    obsHost: String(source.obsHost || '').trim().slice(0, 200),
    obsPort: Math.max(1, Math.min(65535, parseInt(source.obsPort, 10) || 4455)),
    obsPassword: String(source.obsPassword || '').slice(0, 200),
    obsAutoLaunch: typeof source.obsAutoLaunch === 'boolean' ? source.obsAutoLaunch : true,
    streamerbotHost: String(source.streamerbotHost || '').trim().slice(0, 200),
    streamerbotPort: Math.max(1, Math.min(65535, parseInt(source.streamerbotPort, 10) || 8080)),
    streamerbotPassword: String(source.streamerbotPassword || '').slice(0, 200),
    // Per-instance Browser-widget URLs (client-owned). Round-tripped so they
    // survive a browser-storage reset; the relay re-validates before navigating.
    browserTiles: normalizeServerBrowserTiles(source.browserTiles),
    aiProvider: aiLocal.sanitizeProvider(source.aiProvider),
    ollamaModel: aiLocal.sanitizeModel(source.ollamaModel),
    ollamaUrl: aiLocal.sanitizeOllamaUrl(source.ollamaUrl),
    hardwareScan: normalizeHardwareScan(source.hardwareScan),
    aiTtsEnabled: source.aiTtsEnabled !== false,
    aiMicSensitivity: clampNumber(source.aiMicSensitivity, 0, 100, DEFAULT_HUB_SETTINGS.aiMicSensitivity),
    aiChatHidden: source.aiChatHidden === true,
    aiFeatures: normalizeServerAiFeatures(source.aiFeatures),
    bgAurora: normalizeBgAurora(source.bgAurora),
    bgGrid: normalizeBgGrid(source.bgGrid),
    lighting: normalizeLighting(source.lighting),
    calendarFeeds: icsFeeds.normalizeCalendarFeeds(source.calendarFeeds, CALENDAR_FEED_PALETTE),
    remoteControl: normalizeRemoteControl(source.remoteControl),
    // Client-managed settings (the client owns their full schema and re-validates
    // on load): round-trip them so they survive a server restart instead of being
    // stripped. A bounded passthrough keeps settings.json safe.
    gameMode: typeof source.gameMode === 'boolean' ? source.gameMode : true,
    performance: sanitizeServerPassthrough(source.performance),
    // Second-screen capture prefs (client-owned; the client re-validates on load).
    secondScreen: sanitizeServerPassthrough(source.secondScreen),
    // Monotonic save revision (client-owned): round-tripped so the client's
    // boot-time merge can compare it against the local copy and avoid clobbering
    // a newer local layout with a stale server one.
    rev: Number.isFinite(source.rev) && source.rev > 0 ? Math.floor(source.rev) : 0,
    // First-run tutorial state (client-owned): round-tripped so a Xeneon Edge
    // WebView localStorage wipe can't make the tour reappear every boot.
    onboarding: normalizeServerOnboarding(source.onboarding),
    // Persisted UI language ('' = follow the browser). Round-tripped so the
    // user's choice survives a browser-storage reset (e.g. a Windows restart).
    language: WEATHER_LANGS.has(source.language) ? source.language : '',
  };
}

function normalizeServerBrowserTiles(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  let n = 0;
  for (const key of Object.keys(v)) {
    if (n >= 32) break;
    if (!/^browser(~[a-z0-9]+)?$/.test(key)) continue;
    const entry = v[key];
    if (!entry || typeof entry !== 'object') continue;
    const url = String(entry.url || '').slice(0, 2048);
    if (!url) continue;
    out[key] = { url };
    n++;
  }
  return out;
}

function normalizeServerOnboarding(value) {
  const v = value && typeof value === 'object' ? value : {};
  const seen = Number(v.seenVersion);
  return { seenVersion: Number.isFinite(seen) && seen > 0 ? Math.floor(seen) : 0 };
}

// Bounded passthrough for the client-owned saved presets array. Templates are
// small (base widget ids + geometry, no image data), so a generous size cap is
// plenty; anything bigger or malformed is dropped to an empty list.
function sanitizeDashboardPresets(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    if (json.length > 200000) return [];
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.slice(0, 60) : [];
  } catch { return []; }
}

// Defensive passthrough for a client-owned settings object: keep it only if it's
// a plain object that serializes within a sane size, returning a clean copy.
function sanitizeServerPassthrough(value) {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const json = JSON.stringify(value);
    if (json.length > 8000) return undefined;
    return JSON.parse(json);
  } catch { return undefined; }
}

// RGB lighting bridge config. Mirrors the client default (master OFF). Accepts
// the legacy effect-booleans and the new {enabled,color,style} event objects.
const LIGHTING_STYLES = ['blink', 'pulse', 'solid'];
const LIGHTING_ANIM_STYLES = ['none', 'solid', 'breathing', 'cycle'];
const LIGHTING_PROVIDER_IDS = ['govee', 'lifx', 'wled', 'hue', 'nanoleaf'];
function normalizeLightingAnimation(value, fallback) {
  const f = fallback || { style: 'none', color: '#1ed760', speed: 50 };
  const v = value && typeof value === 'object' ? value : {};
  return {
    style: LIGHTING_ANIM_STYLES.includes(v.style) ? v.style : f.style,
    color: normalizeHex(v.color, f.color),
    speed: clampNumber(v.speed, 1, 100, f.speed),
  };
}
function normalizeLightingProviders(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const id of LIGHTING_PROVIDER_IDS) {
    const p = value[id];
    if (!p || typeof p !== 'object' || !Array.isArray(p.devices)) continue;
    const devices = p.devices.map(d => {
      const host = String(d && d.host || '').trim().slice(0, 120);
      if (!host) return null;
      const dev = {
        id: String(d.id || `${id}:${host}`).slice(0, 160),
        name: String(d && d.name || id).slice(0, 80),
        host,
        optedIn: !(d && d.optedIn === false),
      };
      if (d && d.token) dev.token = String(d.token).slice(0, 256); // pairing token (Hue/Nanoleaf)
      return dev;
    }).filter(Boolean).slice(0, 32);
    if (devices.length) out[id] = { devices };
  }
  return out;
}
const LIGHTING_DEVICE_MODES = ['follow', 'color', 'animation', 'temperature', 'album', 'off'];
const LIGHTING_ANIM_SUB = ['solid', 'breathing', 'cycle'];
function normalizeLightingDeviceModes(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [id, v] of Object.entries(value)) {
    if (!v || typeof v !== 'object') continue;
    const key = String(id).slice(0, 160);
    const e = { mode: LIGHTING_DEVICE_MODES.includes(v.mode) ? v.mode : 'follow' };
    if (typeof v.color === 'string' && /^#?[0-9a-f]{6}$/i.test(v.color)) e.color = normalizeHex(v.color, '#1ed760');
    if (v.anim && typeof v.anim === 'object') {
      e.anim = {
        style: LIGHTING_ANIM_SUB.includes(v.anim.style) ? v.anim.style : 'cycle',
        color: normalizeHex(v.anim.color, '#1ed760'),
        speed: clampNumber(v.anim.speed, 1, 100, 50),
      };
    }
    out[key] = e;
  }
  return out;
}
function normalizeLightingEvent(value, fallback) {
  const f = fallback || { enabled: true, color: '#ff0000', style: 'blink' };
  if (typeof value === 'boolean') return { enabled: value, color: f.color, style: f.style }; // legacy
  const v = value && typeof value === 'object' ? value : {};
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : f.enabled,
    color: normalizeHex(v.color, f.color),
    style: LIGHTING_STYLES.includes(v.style) ? v.style : f.style,
  };
}
function normalizeLighting(value) {
  const v = value && typeof value === 'object' ? value : {};
  const d = DEFAULT_HUB_SETTINGS.lighting;
  const fx = v.effects && typeof v.effects === 'object' ? v.effects : {};
  const devices = {};
  if (v.devices && typeof v.devices === 'object') {
    for (const [k, on] of Object.entries(v.devices)) devices[String(k).slice(0, 128)] = on === true;
  }
  return {
    enabled: v.enabled === true,
    brightness: clampNumber(v.brightness, 0, 1, d.brightness),
    pauseDuringGame: v.pauseDuringGame !== false,
    devices,
    effects: {
      temperature: fx.temperature === true,
      volume: fx.volume === true,
      musicAlbum: fx.musicAlbum === true,
      timer: normalizeLightingEvent(fx.timer, d.effects.timer),
      notification: normalizeLightingEvent(fx.notification, d.effects.notification),
      reminder: normalizeLightingEvent(fx.reminder, d.effects.reminder),
    },
    animation: normalizeLightingAnimation(v.animation, d.animation),
    manualColor: /^#[0-9a-f]{6}$/i.test(String(v.manualColor)) ? v.manualColor : '',
    providers: normalizeLightingProviders(v.providers),
    deviceModes: normalizeLightingDeviceModes(v.deviceModes),
  };
}

async function readHubSettings() {
  try {
    const raw = await fs.promises.readFile(SETTINGS_FILE, 'utf8');
    return normalizeHubSettings(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function writeHubSettings(settings) {
  const safe = normalizeHubSettings(settings);
  await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

// The Deck widget's keys live in the browser's localStorage, which the Xeneon
// Edge WebView can wipe on some restarts/updates — silently losing the user's
// programmed keys. We keep a durable server-side backup here. The store is held
// opaquely: { configs: { [instanceId]: deckConfig }, rev }. The server never
// edits the config shape (the client owns normalization via DeckModel); it only
// trusts the monotonic `rev` to resolve which copy is newer (last-writer-wins).
function normalizeDeckStore(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const configs = (src.configs && typeof src.configs === 'object' && !Array.isArray(src.configs)) ? src.configs : {};
  const rev = Number.isFinite(src.rev) ? Math.max(0, Math.floor(src.rev)) : 0;
  const savedAt = Number.isFinite(src.savedAt) ? src.savedAt : 0;
  // Per-instance revisions: a lightweight diagnostic counter applyDeckOps bumps on
  // every write. No longer used to decide a winner (the server is authoritative).
  const instanceRevs = deckStore.sanitizeInstanceRevs(src.instanceRevs);
  // Saved profile + single-key presets (client-owned shape, like configs):
  // bounded arrays round-tripped so reusable profiles/keys survive a WebView
  // storage wipe / restart.
  const presets = Array.isArray(src.presets) ? src.presets.slice(0, 60) : [];
  const keyPresets = Array.isArray(src.keyPresets) ? src.keyPresets.slice(0, 120) : [];
  return { configs, rev, savedAt, instanceRevs, presets, keyPresets };
}

async function readDeckStore() {
  try {
    const raw = await fs.promises.readFile(DECK_FILE, 'utf8');
    return normalizeDeckStore(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return { configs: {}, rev: 0, savedAt: 0, instanceRevs: {}, presets: [], keyPresets: [] };
    throw e;
  }
}

async function writeDeckStore(store) {
  const safe = normalizeDeckStore(store);
  safe.savedAt = Date.now();
  await fs.promises.writeFile(DECK_FILE, JSON.stringify(safe), 'utf8');
  return safe;
}

// ── Configuration backup ──────────────────────────────────────────────────────
// Export/import of the user's configuration as ONE portable JSON file (layout,
// Deck, calendar, tasks, timers, notes, settings). Secrets (API keys, Sunshine
// credentials, OBS password, streaming tokens) and binary uploads are
// deliberately excluded: a backup file must be safe to keep on a cloud drive or
// hand to someone. On import, every section goes through the same normalizers
// as its normal save path, so a tampered file can't smuggle bad shapes in.
const BACKUP_FORMAT = 1;
const BACKUP_MAX_BYTES = 16 * 1024 * 1024;   // deck stores embed image icons

async function buildBackup() {
  const settings = (await readHubSettings().catch(() => null)) || { ...DEFAULT_HUB_SETTINGS };
  const safeSettings = redactRemoteCreds({ ...settings, geminiApiKey: '', obsPassword: '', streamerbotPassword: '' });
  return {
    xenonBackup: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    appVersion: APP_VERSION,
    data: {
      settings: safeSettings,
      deck: await readDeckStore().catch(() => null),
      events: await readEvents().catch(() => []),
      tasks: await readTasks().catch(() => []),
      timers: _timers,
      notes: await fs.promises.readFile(NOTES_FILE, 'utf8').catch(() => ''),
    },
  };
}

// Write the backup bundle to a file on disk and return its absolute path.
// Targets the user's Downloads folder (the natural place for an export); falls
// back to the home dir, then DATA_DIR, if Downloads doesn't exist. The filename
// carries date + time so repeated exports never overwrite one another.
async function saveBackupToDisk() {
  const bundle = await buildBackup();
  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const fileName = `xenon-backup-${stamp}.json`;

  const home = os.homedir();
  const candidates = [path.join(home, 'Downloads'), home, DATA_DIR];
  let dir = DATA_DIR;
  for (const c of candidates) {
    try { if (fs.existsSync(c) && fs.statSync(c).isDirectory()) { dir = c; break; } }
    catch { /* try the next candidate */ }
  }

  const dest = path.join(dir, fileName);
  await fs.promises.writeFile(dest, JSON.stringify(bundle, null, 2), 'utf8');
  return { ok: true, path: dest, fileName };
}

async function applyBackup(bundle) {
  if (!bundle || bundle.xenonBackup !== BACKUP_FORMAT || !bundle.data || typeof bundle.data !== 'object') {
    return { ok: false, error: 'bad_format' };
  }
  const d = bundle.data;
  const restored = [];
  if (d.settings && typeof d.settings === 'object' && !Array.isArray(d.settings)) {
    const prev = await readHubSettings().catch(() => null);
    // Backups never carry secrets — keep the ones configured on THIS machine.
    const incoming = preserveRemoteCreds({ ...d.settings }, prev);
    if (!incoming.geminiApiKey && prev && prev.geminiApiKey) incoming.geminiApiKey = prev.geminiApiKey;
    if (!incoming.obsPassword && prev && prev.obsPassword) incoming.obsPassword = prev.obsPassword;
    if (!incoming.streamerbotPassword && prev && prev.streamerbotPassword) incoming.streamerbotPassword = prev.streamerbotPassword;
    // Bump rev past the current copy so every client's hydrate (which keeps the
    // newer rev) adopts the imported settings instead of clobbering them back.
    incoming.rev = Math.max(Number(incoming.rev) || 0, (prev && prev.rev) || 0) + 1;
    const settings = await writeHubSettings(incoming);
    _serverHubSettings = settings;
    // Same post-save hooks as POST /settings; none of them may fail the import.
    try { lighting.applyConfig(settings.lighting); }
    catch (e) { console.error('Backup lighting apply failed:', e.message); }
    refreshExternalFeeds().catch(() => {});
    refreshObsWatch();
    restored.push('settings');
  }
  if (d.deck && typeof d.deck === 'object' && !Array.isArray(d.deck)) {
    // Bump rev past the current store so every client (including one holding a
    // newer localStorage copy) adopts the imported deck on its next hydrate.
    const cur = await readDeckStore().catch(() => null);
    const store = normalizeDeckStore(d.deck);
    store.rev = Math.max(store.rev, (cur && cur.rev) || 0) + 1;
    const saved = await writeDeckStore(store);
    broadcastSSE('deck', { rev: saved.rev });   // open dashboards re-sync the imported decks live
    restored.push('deck');
  }
  if (Array.isArray(d.events)) { await writeEvents(d.events); restored.push('events'); }
  if (Array.isArray(d.tasks))  { await writeTasks(d.tasks);   restored.push('tasks'); }
  if (Array.isArray(d.timers)) {
    _timers = d.timers.slice(0, TIMERS_MAX).map(_normalizeTimer);
    await _saveTimers();
    restored.push('timers');
  }
  if (typeof d.notes === 'string' && d.notes) {
    await fs.promises.writeFile(NOTES_FILE, d.notes.slice(0, 200_000), 'utf8');
    restored.push('notes');
  }
  return { ok: true, restored };
}

// Remote Control orchestrator — getSettings reads the in-memory mirror so
// currentCreds() stays synchronous; saveSettings persists and normalises via
// writeHubSettings (which updates _serverHubSettings on the next settings read).
const remoteControl = createRemoteControl({
  getSettings: () => _serverHubSettings,
  saveSettings: (s) => writeHubSettings(s).then(safe => { _serverHubSettings = safe; return safe; }),
});
// Wire remoteControl into the Deck action dispatcher now that the orchestrator
// is available. The registry closes over deckRegistryDeps by reference, so this
// assignment is immediately visible to subsequent deckRegistry.run() calls.
deckRegistryDeps.remote = remoteControl;

// Self-update (safe two-step): prepare downloads+validates a new release into
// DATA_DIR without touching the live install; apply hands off to an external
// elevated applier. Disabled on a git checkout.
const selfUpdate = createSelfUpdate({ root: path.join(__dirname, '..'), dataDir: DATA_DIR });

// Guardian — opt-in hardware-health history. The interval only does real work
// while the user has enabled the feature in Settings → Funzioni AI; collection
// is local and free, the AI reads the digest via the guardian_report tool.
const guardian = createGuardian({
  dataDir: DATA_DIR,
  getSystemInfo,
  isEnabled: () => {
    const f = _serverHubSettings && _serverHubSettings.aiFeatures;
    return !!(f && f.enabled === true && f.guardian === true);
  },
  onAlert: ({ type, value }) => broadcastSSE('guardian_alert', { type, value }),
});

// A streaming app client_id is CONFIGURATION, not committed source: resolve it
// from an env var first, then a gitignored `server/stream-config.json`, so the
// id (tied to the owner's personal Twitch/Google app) never lives in the public
// repo. Empty when unconfigured → the provider reports `configured:false`.
function readStreamClientId(configKey, envName) {
  if (process.env[envName]) return String(process.env[envName]).trim();
  try {
    const cfg = JSON.parse(fs.readFileSync(STREAM_CONFIG_FILE, 'utf8'));
    return String((cfg && cfg[configKey]) || '').trim();
  } catch { return ''; }
}

// Twitch + YouTube live integrations. Tokens persist to a server-only file
// (stream-tokens.json). `let` (not const) so the providers can be RE-CREATED when
// the user pastes/saves their app credentials in Settings → Streaming, picking up
// the new client_id/secret without a server restart (see saveStreamConfig).
let streamTwitch = createTwitchProvider({ clientId: readStreamClientId('twitchClientId', 'TWITCH_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
let streamYouTube = createYouTubeProvider({
  clientId: readStreamClientId('youtubeClientId', 'YOUTUBE_CLIENT_ID'),
  clientSecret: readStreamClientId('youtubeClientSecret', 'YOUTUBE_CLIENT_SECRET'),
  tokensFile: STREAM_TOKENS_FILE,
});
// Twitch Deck actions (Phase 2). These arrow deps read `streamTwitch` at call
// time, so a re-created provider is picked up automatically.
deckRegistryDeps.twitchClip = () => streamTwitch.createClip();
deckRegistryDeps.twitchMarker = (description) => streamTwitch.createMarker(description);
deckRegistryDeps.twitchAd = (length) => streamTwitch.runAd(length);
deckRegistryDeps.twitchTitle = (title) => streamTwitch.setTitle(title);
deckRegistryDeps.twitchGame = (game) => streamTwitch.setGame(game);
deckRegistryDeps.twitchChat = (message) => streamTwitch.sendChat(message);
deckRegistryDeps.twitchShoutout = (login) => streamTwitch.shoutout(login);
deckRegistryDeps.twitchChatMode = (mode) => streamTwitch.setChatMode(mode);
// YouTube Deck action: start/stop/toggle the live broadcast.
deckRegistryDeps.ytBroadcast = (mode) => streamYouTube.transitionBroadcast(mode);

// Persist the streaming app credentials (from the Settings → Streaming inputs) to
// the gitignored stream-config.json and re-create the providers so they take
// effect immediately. Only the known credential keys are accepted.
const STREAM_CONFIG_KEYS = ['twitchClientId', 'youtubeClientId', 'youtubeClientSecret'];
async function saveStreamConfig(patch) {
  let cfg = {};
  try { cfg = JSON.parse(await fs.promises.readFile(STREAM_CONFIG_FILE, 'utf8')) || {}; } catch { cfg = {}; }
  for (const k of STREAM_CONFIG_KEYS) {
    if (patch && typeof patch[k] === 'string') cfg[k] = patch[k].trim().slice(0, 200);
  }
  await fs.promises.writeFile(STREAM_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  streamTwitch = createTwitchProvider({ clientId: readStreamClientId('twitchClientId', 'TWITCH_CLIENT_ID'), tokensFile: STREAM_TOKENS_FILE });
  streamYouTube = createYouTubeProvider({
    clientId: readStreamClientId('youtubeClientId', 'YOUTUBE_CLIENT_ID'),
    clientSecret: readStreamClientId('youtubeClientSecret', 'YOUTUBE_CLIENT_SECRET'),
    tokensFile: STREAM_TOKENS_FILE,
  });
}

function normalizeEvents(value) {
  const source = Array.isArray(value) ? value : (Array.isArray(value && value.events) ? value.events : []);
  return source.slice(0, 250).map(item => {
    const title = String(item && item.title || '').trim().slice(0, 120);
    const notes = String(item && item.notes || '').trim().slice(0, 600);
    const startsAt = String(item && item.startsAt || '').trim();
    const reminderAt = String(item && item.reminderAt || '').trim();
    const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
    return {
      id,
      title,
      notes,
      startsAt: Number.isFinite(Date.parse(startsAt)) ? startsAt : '',
      reminderAt: Number.isFinite(Date.parse(reminderAt)) ? reminderAt : '',
      notifiedAt: item && item.notifiedAt ? String(item.notifiedAt).slice(0, 40) : '',
      createdAt: item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString(),
    };
  }).filter(item => item.title || item.startsAt || item.notes);
}

async function readEvents() {
  try {
    const raw = await fs.promises.readFile(EVENTS_FILE, 'utf8');
    return normalizeEvents(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeEvents(events) {
  const safe = normalizeEvents(events);
  await fs.promises.writeFile(EVENTS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

const TASK_PRIORITIES = Object.freeze(['high', 'medium', 'low']);
const TASK_RECURRENCES = Object.freeze(['never', 'daily', 'weekly', 'custom']);

function normalizeTask(item) {
  const text = String(item && item.text || '').trim().slice(0, 200);
  const id = String(item && item.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const priority = TASK_PRIORITIES.includes(item && item.priority) ? item.priority : 'medium';
  const recurrence = TASK_RECURRENCES.includes(item && item.recurrence) ? item.recurrence : 'never';
  const recurrenceDays = (recurrence === 'custom' && Number.isFinite(Number(item && item.recurrenceDays)) && Number(item.recurrenceDays) >= 1)
    ? Math.round(Number(item.recurrenceDays)) : 1;
  const completed = Boolean(item && item.completed);
  const completedAt = completed && item.completedAt ? String(item.completedAt).slice(0, 40) : null;
  const createdAt = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, text, priority, recurrence, recurrenceDays, completed, completedAt, createdAt };
}

function normalizeTasks(value) {
  const source = Array.isArray(value) ? value : [];
  return source.slice(0, TASKS_MAX).map(normalizeTask).filter(t => t.text.length > 0);
}

async function readTasks() {
  try {
    const raw = await fs.promises.readFile(TASKS_FILE, 'utf8');
    return normalizeTasks(JSON.parse(raw));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

async function writeTasks(tasks) {
  const safe = normalizeTasks(tasks);
  await fs.promises.writeFile(TASKS_FILE, JSON.stringify(safe, null, 2), 'utf8');
  return safe;
}

// ── Timers ────────────────────────────────────────────────────────────────────

let _timers = []; // in-memory timer list; persisted to TIMERS_FILE
let _timerCheckInterval = null;

function _normalizeTimer(item) {
  const id          = String(item && item.id || `t${Date.now()}-${Math.random().toString(16).slice(2)}`).slice(0, 80);
  const label       = String(item && item.label || 'Timer').trim().slice(0, 40);
  const durationSecs = Math.max(1, Math.round(Number(item && item.durationSecs) || 60));
  const status      = ['running', 'paused', 'done'].includes(item && item.status) ? item.status : 'running';
  const startedAt   = Number.isFinite(Number(item && item.startedAt)) ? Number(item.startedAt) : Date.now();
  const pausedElapsed = Math.max(0, Number(item && item.pausedElapsed) || 0);
  const createdAt   = item && item.createdAt ? String(item.createdAt).slice(0, 40) : new Date().toISOString();
  return { id, label, durationSecs, status, startedAt, pausedElapsed, createdAt };
}

function _getTimerRemaining(t) {
  if (t.status === 'done')   return 0;
  if (t.status === 'paused') return Math.max(0, t.durationSecs - t.pausedElapsed);
  const elapsed = t.pausedElapsed + (Date.now() - t.startedAt) / 1000;
  return Math.max(0, t.durationSecs - elapsed);
}

async function _saveTimers() {
  try {
    await fs.promises.writeFile(TIMERS_FILE, JSON.stringify(_timers, null, 2), 'utf8');
  } catch {}
}

function _checkTimers() {
  let changed = false;
  for (const t of _timers) {
    if (t.status === 'running' && _getTimerRemaining(t) <= 0) {
      t.status = 'done';
      changed = true;
      broadcastSSE('timer_done', { id: t.id, label: t.label });
      try { lighting.onEvent('timer'); } catch {}
    }
  }
  if (changed) {
    _saveTimers();
    broadcastSSE('timer_update', { timers: _timers });
  }
}

async function _initTimers() {
  try {
    const raw = await fs.promises.readFile(TIMERS_FILE, 'utf8');
    const loaded = JSON.parse(raw);
    _timers = (Array.isArray(loaded) ? loaded : []).slice(0, TIMERS_MAX).map(_normalizeTimer);
  } catch (e) {
    if (e.code !== 'ENOENT') process.stdout.write(`[timers] load error: ${e.message}\n`);
    _timers = [];
  }
  if (_timerCheckInterval) clearInterval(_timerCheckInterval);
  _timerCheckInterval = setInterval(_checkTimers, 1000);
  _timerCheckInterval.unref();
}

// ── External calendar feeds (read-only ICS subscriptions) ──────────────────
// In-memory only: parsed feed events are never written to disk.
let _externalFeedCache = { feeds: [], events: [], refreshedAt: 0 };
let _externalRefreshing = false;

async function refreshExternalFeeds() {
  if (_externalRefreshing) return _externalFeedCache;
  _externalRefreshing = true;
  try {
    const settings = await readHubSettings().catch(() => null);
    const feeds = (settings && Array.isArray(settings.calendarFeeds)) ? settings.calendarFeeds : [];
    const results = await Promise.all(feeds.map(f => icsFeeds.loadFeed(f)));
    const events = [];
    const status = [];
    for (let i = 0; i < feeds.length; i++) {
      const r = results[i];
      status.push({ id: feeds[i].id, name: feeds[i].name, status: r.status, error: r.error, count: r.count, reminders: feeds[i].reminders });
      if (r.events && r.events.length) events.push(...r.events);
    }
    _externalFeedCache = { feeds: status, events, refreshedAt: Date.now() };
  } catch (e) {
    // Keep last good cache; record nothing sensitive.
  } finally {
    _externalRefreshing = false;
  }
  return _externalFeedCache;
}

// Initial load shortly after boot, then every 15 minutes. unref() so these
// timers never keep the process alive on shutdown (matches _timerCheckInterval).
setTimeout(() => { refreshExternalFeeds().catch(() => {}); }, 4000).unref();
setInterval(() => { refreshExternalFeeds().catch(() => {}); }, 15 * 60 * 1000).unref();

// ── Server-Sent Events infrastructure ────────────────────────────────────────
// Clients connect to GET /sse and receive named events instead of polling.
// Each event carries the same JSON payload the old poll endpoints returned,
// so the client-side render functions need no changes — only the fetch trigger
// changes from setInterval to EventSource.

const sseClients = new Set();

function broadcastSSE(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch { sseClients.delete(res); }
  }
}

// Security: only accept connections from loopback addresses.
// Double-checked at both the TCP socket level (remoteAddress) and the HTTP Host header
// level, so DNS-rebinding / Host-spoofing attacks from non-loopback IPs are blocked.
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_HOSTS = new Set([
  '127.0.0.1:3030', 'localhost:3030', '[::1]:3030',
  '127.0.0.1', 'localhost', '[::1]',
]);

// JSONP responses are readable by any page that can inject a <script> tag:
// script loads send no Origin header, so the Origin layer below never sees
// them, and the request still comes from loopback (the user's own browser).
// Restrict callback wrapping to the endpoints the iCUE widget actually polls —
// settings (API keys), stream tokens and deck config must only ever ship as
// plain JSON, which cross-origin pages cannot read.
const JSONP_PATHS = new Set([
  '/system', '/network', '/notes', '/events', '/media', '/audio', '/status',
  '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
]);
function isJsonpAllowed(pathname) {
  return JSONP_PATHS.has(pathname) || pathname.startsWith('/media/');
}

// State-mutating endpoints that also accept GET so the iCUE widget can reach
// them via <script> JSONP (Qt WebEngine blocks fetch). That same shape is a
// CSRF vector: any visited web page can trigger them with a <script> tag, which
// sends no Origin, so the loopback/Origin checks below can't catch it. They are
// guarded by the Sec-Fetch-Site check in the request handler.
const CSRF_MUTATION_PATHS = new Set([
  '/toggle', '/mic/volume', '/volume/set', '/speaker/mute',
  '/audio/app/volume', '/audio/app/mute',
]);

function isAllowedRequest(req) {
  // Layer 1: TCP source IP must be loopback (blocks LAN spoofing regardless of Host)
  const remoteAddr = req.socket.remoteAddress || '';
  if (!LOOPBACK_IPS.has(remoteAddr)) return false;

  // Layer 2: Host header must be a loopback address (protects against DNS rebinding)
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return false;

  // Layer 3: If an Origin header is present, it must also be loopback or opaque.
  // 'null' = opaque origin from Qt WebEngine (file:// or qrc:// page) — allowed.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const u = new URL(origin);
      if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return false;
    } catch { return false; }
  }
  return true;
}

// Enumerate DirectShow audio devices via ffmpeg. Returns an array of friendly device name strings.
async function _enumSttDevice() {
  const ffmpeg = getFfmpegPath();
  let stderr = '';
  try {
    await new Promise(resolve => {
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', resolve);
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 5000);
    });
  } catch {}

  const names = [];
  let inAudioSection = false; // for ffmpeg <7 (section-based format)

  for (const line of stderr.split('\n')) {
    if (/Alternative name/i.test(line)) continue;

    // ffmpeg 7+ format: [in#0 @ ...] "Device Name" (audio)
    const newFmt = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (newFmt && !newFmt[1].startsWith('@device_')) { names.push(newFmt[1]); continue; }

    // ffmpeg <7 format: section header + [dshow @ ...] "Device Name"
    if (/DirectShow audio devices/i.test(line)) { inAudioSection = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudioSection = false; continue; }
    if (inAudioSection) {
      const oldFmt = line.match(/"([^@][^"]+)"/);
      if (oldFmt) names.push(oldFmt[1]);
    }
  }
  return names;
}

async function _initSttDevice() {
  const ffmpeg = getFfmpegPath();

  // Probe WASAPI support — if ffmpeg knows the format, use it (fast init ~200ms)
  let wasapiOk = false;
  try {
    await new Promise(resolve => {
      let stderr = '';
      const p = spawn(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'wasapi', '-i', 'dummy'], { windowsHide: true });
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', d => { stderr += d; });
      p.on('exit', () => { wasapiOk = !/Unknown input format/i.test(stderr); resolve(); });
      p.on('error', resolve);
      setTimeout(() => { try { p.kill(); } catch {} resolve(); }, 4000);
    });
  } catch {}

  if (wasapiOk) {
    _sttUseWasapi = true;
    process.stdout.write('[STT] WASAPI available — fast init\n');
  } else {
    // WASAPI not supported — enumerate DirectShow devices as fallback
    try {
      const names = await _enumSttDevice();
      if (names.length > 0) {
        let chosen = null;
        if (cachedMicLabel) {
          const lbl = cachedMicLabel.toLowerCase();
          chosen = names.find(d => d.toLowerCase().includes(lbl));
        }
        _sttDshowDevice = chosen || names[0];
        process.stdout.write(`[STT] WASAPI unavailable, dshow: "${_sttDshowDevice}"\n`);
      } else {
        process.stdout.write('[STT] No audio input method found\n');
      }
    } catch (e) {
      process.stdout.write('[STT] Device init error: ' + e.message + '\n');
    }
  }

  _sttDeviceReady = true;
  _boundMicLabel = cachedMicLabel || _sttDshowDevice || (wasapiOk ? '__wasapi_default__' : null);
  _sttDeviceWaiters.splice(0).forEach(cb => cb());
}

function _sttDeviceWhenReady() {
  return new Promise(resolve => {
    if (_sttDeviceReady) resolve();
    else _sttDeviceWaiters.push(resolve);
  });
}

// Re-bind the STT capture device when the user changes their default microphone.
// The dshow path pins a device name at startup, so without this, selecting a
// different mic (e.g. plugging in a headset) had no effect and recordings kept
// reading the old — often silent — device ("detected and active but doesn't hear
// me"). The WASAPI path uses "default" and already follows the change on its own,
// so we only rebind for dshow. Debounced and skipped while a recording is live.
let _sttRebindTimer = null;
function _maybeRebindSttDevice() {
  if (!_sttDeviceReady || _sttUseWasapi) return;          // wasapi follows "default" already
  if (!cachedMicLabel || cachedMicLabel === _boundMicLabel) return;
  if (_sttRebindTimer) return;
  _sttRebindTimer = setTimeout(async () => {
    _sttRebindTimer = null;
    if (_sttPending.size > 0) { _maybeRebindSttDevice(); return; } // try again after the current capture
    if (!cachedMicLabel || cachedMicLabel === _boundMicLabel) return;
    process.stdout.write(`[STT] Default mic changed to "${cachedMicLabel}" — rebinding capture device\n`);
    try { await _initSttDevice(); } catch (e) { process.stdout.write('[STT] Rebind error: ' + e.message + '\n'); }
  }, 800);
}

function pcmToWav(pcmBytes, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const buf = Buffer.alloc(44 + pcmBytes.length);
  buf.write('RIFF', 0);         buf.writeUInt32LE(36 + pcmBytes.length, 4);
  buf.write('WAVE', 8);         buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);    buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  buf.writeUInt16LE(channels * bitsPerSample / 8, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36);        buf.writeUInt32LE(pcmBytes.length, 40);
  pcmBytes.copy(buf, 44);
  return buf;
}

const STT_LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

function _transcribeAudio(audioB64, mimeType, apiKey, lang) {
  const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
  const safeMime = ALLOWED_AUDIO.has(mimeType) ? mimeType : 'audio/webm';
  const safeLang = String(lang || 'en').toLowerCase().slice(0, 2);
  const langName = STT_LANG_NAMES[safeLang] || 'English';
  // Build a language-aware transcription prompt. The user may mix the UI language
  // with English proper nouns (app names, brand names) — keep them as separate words.
  const mixExample = safeLang === 'it'
    ? 'e.g. "apri Steam" not "apristim"; "apri Spotify" not "aprispot"'
    : 'e.g. "open Steam" not "opensteam"; "open Spotify" not "openspotify"';
  const sttPrompt = `Transcribe this audio exactly as spoken in ${langName}. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix ${langName} commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (${mixExample}). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.`;
  const payload = JSON.stringify({
    contents: [{ parts: [
      { text: sttPrompt },
      { inline_data: { mime_type: safeMime, data: audioB64 } },
    ] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (geminiRes) => {
      let d = '';
      geminiRes.on('data', c => { d += c; });
      geminiRes.on('end', () => {
        process.stdout.write(`[STT] Gemini status=${geminiRes.statusCode} body=${d.slice(0, 400)}\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) {
            reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
            return;
          }
          resolve(((parsed?.candidates?.[0]?.content?.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || '');
        } catch { reject(new Error('Gemini invalid JSON: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// Recent Gemini models occasionally "leak" a tool call as plain text — e.g.
// `[call:default_api:genesis_compose_page{name:Studio,widgets:[notes,tasks]}]`
// — instead of emitting a structured functionCall part. Without this fallback
// the call is never executed and the raw text is shown/spoken to the user.
// Returns { name, args } when the text contains a leaked call to a known
// function, or null. Pseudo-JSON args (unquoted keys/values) are tolerated.
const LEAKED_CALL_RE = /\[?\s*(?:tool_code\s+|call\s*:\s*)(?:default_api[.:])?\s*([A-Za-z0-9_]+)\s*[{(]([\s\S]*?)[)}]\s*\]?/;
function _parseLeakedToolCall(text, validNames) {
  const m = String(text || '').match(LEAKED_CALL_RE);
  if (!m || !validNames.has(m[1])) return null;
  const raw = m[2].trim();
  if (!raw) return { name: m[1], args: {} };
  // Quote bare words (keys and string values) so the pseudo-JSON parses;
  // already-quoted strings, numbers, true/false/null pass through untouched.
  const fixed = ('{' + raw + '}').replace(
    /"[^"]*"|'[^']*'|([A-Za-z_][A-Za-z0-9_\- ]*)/g,
    (tok, bare) => {
      if (bare === undefined) return tok.startsWith("'") ? JSON.stringify(tok.slice(1, -1)) : tok;
      const t = bare.trim();
      return /^(true|false|null)$/.test(t) ? t : JSON.stringify(t);
    }
  );
  try {
    const args = JSON.parse(fixed);
    return (args && typeof args === 'object') ? { name: m[1], args } : null;
  } catch { return null; }
}

// Web search via Gemini grounding. Runs as a SEPARATE call from the main chat
// because the google_search grounding tool cannot be combined with
// functionDeclarations in the same request (doing so makes Gemini return empty
// responses). Returns a short grounded answer plus source URLs. On any failure
// resolves with an { error } object so the caller can degrade gracefully.
function _geminiWebSearch(query, apiKey) {
  return new Promise((resolve) => {
    const q = String(query || '').trim().slice(0, 500);
    if (!q) return resolve({ error: 'empty query' });
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: q }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 700, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
    });
    const t0 = Date.now();
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (r) => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        process.stdout.write(`[WebSearch] Gemini HTTP ${r.statusCode} in ${Date.now() - t0}ms\n`);
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return resolve({ error: parsed.error.message || 'search error' });
          const cand = parsed?.candidates?.[0];
          const text = (cand?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim();
          // Collect grounding source URLs/titles when present
          const chunks = cand?.groundingMetadata?.groundingChunks || [];
          const sources = chunks
            .map(c => c.web && { title: c.web.title || '', uri: c.web.uri || '' })
            .filter(Boolean).slice(0, 5);
          if (!text) return resolve({ error: 'no result' });
          resolve({ answer: text, sources });
        } catch { resolve({ error: 'invalid JSON' }); }
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'search timeout' }); });
    req.write(payload);
    req.end();
  });
}

// ── Performance Mode AI planner ──────────────────────────────────────────
// Given the current activity and the list of open apps, ask the configured
// provider which BACKGROUND apps are worth closing for this activity, plus a
// one-sentence explanation. The AI only curates app selection and reasoning —
// the blanket levers (pause animations, power plan) stay governed by the user's
// own toggles, and the result is re-validated against the actually-open apps so
// the model can never name something that isn't there. Returns null on any
// failure so the client falls back to the deterministic (manual) flow.
const PERF_LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };

function _perfPlanPrompt(activity, appNames, opts, lang, stats) {
  const langName = PERF_LANG_NAMES[String(lang || 'en').slice(0, 2)] || 'English';
  const levers = [];
  if (opts.pauseAnimations) levers.push('pausing the dashboard animations');
  if (opts.powerPlan && opts.powerPlan !== 'none') levers.push('switching Windows to a high-performance power plan');
  const leverText = levers.length ? `The user has also enabled: ${levers.join(' and ')}. ` : '';
  // Real measurements (when the stats probe succeeded): per-app RAM/CPU and the
  // system memory pressure, so the model reasons about actual cost, not name vibes.
  const byProc = new Map((stats && Array.isArray(stats.apps) ? stats.apps : [])
    .map(a => [String(a.proc || '').toLowerCase(), a]));
  const appList = appNames.map(n => {
    const s = byProc.get(String(n).toLowerCase());
    return s ? { name: n, ramMB: s.memMB, cpuPct: s.cpuPct } : { name: n };
  });
  const memLine = (stats && stats.totalMB)
    ? `System memory: ${stats.totalMB - stats.freeMB} of ${stats.totalMB} MB in use (${Math.round((1 - stats.freeMB / stats.totalMB) * 100)}%). `
    : '';
  return [
    `You help optimize a desktop PC for the user's current activity: "${activity}".`,
    leverText, memLine,
    `Here are the currently-open background apps with their measured RAM/CPU where known: ${JSON.stringify(appList)}.`,
    'Choose ONLY the apps that are clearly NOT needed for this activity and worth closing to free RAM/CPU',
    '(e.g. music players, chat apps, game launchers, update helpers). Prefer the apps that actually cost the',
    'most RAM/CPU; closing a 40 MB tray app is not worth it. Be CONSERVATIVE:',
    'never choose the app central to the activity (the game itself while gaming, the code editor while coding,',
    'the writing app while writing, the streaming software while streaming, the conferencing app during a meeting),',
    'browsers, or anything you are unsure about. It is fine to choose none.',
    `Respond with ONLY a JSON object (no markdown, no prose) of the form:`,
    `{"explanation":"<one short sentence in ${langName} describing what will be optimized and why — cite the measured RAM when relevant>","closeApps":["<exact app name from the list>"]}`,
  ].join(' ');
}

function _geminiGenerateJSON(prompt, apiKey, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 500, candidateCount: 1, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    });
    const r = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
    }, (resp) => {
      let d = '';
      resp.on('data', c => { d += c; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.error) return resolve(null);
          resolve((parsed?.candidates?.[0]?.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || null);
        } catch { resolve(null); }
      });
    });
    r.on('error', () => resolve(null));
    r.setTimeout(timeoutMs, () => { r.destroy(); resolve(null); });
    r.write(payload);
    r.end();
  });
}

// Parse + clamp the model's JSON against what's actually allowed: only apps that
// were in the open list (case-insensitive), unique, capped.
function _normalizePerfPlan(rawText, appNames) {
  if (!rawText) return null;
  let obj;
  try { obj = JSON.parse(String(rawText).replace(/^```(?:json)?\s*|\s*```$/g, '')); }
  catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const lower = new Map(appNames.map(n => [String(n).toLowerCase(), n]));
  const seen = new Set();
  const closeApps = (Array.isArray(obj.closeApps) ? obj.closeApps : [])
    .map(n => lower.get(String(n).toLowerCase()))
    .filter(n => n && !seen.has(n) && seen.add(n))
    .slice(0, 12);
  return {
    explanation: String(obj.explanation || '').slice(0, 300),
    closeApps,
  };
}

async function _aiPerformancePlan({ activity, appNames, opts, provider, key, model, ollamaUrl, hardwareScan, lang, stats }) {
  const names = Array.isArray(appNames) ? appNames.filter(n => typeof n === 'string').slice(0, 40) : [];
  const safeActivity = ['gaming', 'coding', 'writing', 'streaming', 'creating', 'meeting', 'other'].includes(activity) ? activity : 'other';
  const prompt = _perfPlanPrompt(safeActivity, names, opts || {}, lang, stats);
  try {
    if (provider === 'ollama') {
      const baseUrl = aiLocal.sanitizeOllamaUrl(ollamaUrl);
      const concreteModel = aiLocal.resolveModel(model, hardwareScan);
      const r = await aiLocal.localChat({
        baseUrl, model: concreteModel, geminiTools: [], history: [{ role: 'user', parts: [{ text: prompt }] }],
        systemText: 'You output only a single JSON object, never prose or markdown.',
        executeTool: async () => ({ fnResult: {}, clientActions: [] }),
      });
      return _normalizePerfPlan(r && r.text, names);
    }
    if (!key) return null;
    const text = await _geminiGenerateJSON(prompt, key);
    return _normalizePerfPlan(text, names);
  } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  if (!isAllowedRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  // CORS headers required for the iCUE widget WebView (opaque origin, qrc:// or file://).
  // Access-Control-Allow-Private-Network is required by Chrome 104+ (Private Network
  // Access spec) when a non-secure context (file://) fetches a private-network address.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // JSONP support: if ?cb=<name> is present, wrap the response in a JS callback.
  // Used by the iCUE widget where fetch() is blocked by Qt WebEngine's
  // LocalContentCanAccessRemoteUrls policy; <script> tag injection bypasses it.
  const urlObj  = new URL(req.url, 'http://localhost');
  const jsonpCb = urlObj.searchParams.get('cb');
  const json    = data => {
    const body = JSON.stringify(data);
    // Local API responses are live state — never let the browser/WebView cache them
    // (a cached /api/lighting/status was masking real changes during diagnosis).
    if (jsonpCb && /^[A-Za-z_$][\w$]*$/.test(jsonpCb) && isJsonpAllowed(urlObj.pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(jsonpCb + '(' + body + ');');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(body);
    }
  };
  const err500 = msg  => { res.writeHead(500); res.end(String(msg)); };

  const reqPath = urlObj.pathname;

  // CSRF guard: reject cross-site drive-by requests to state-mutating endpoints.
  // The browser stamps Sec-Fetch-Site and a page can't forge it — a cross-site
  // <script>/<img>/fetch is 'cross-site', while the same-origin dashboard's own
  // fetch is 'same-origin'. Only the cross-site case is blocked; an absent header
  // (non-browser caller / older WebView) is allowed, same as the /deck/sound gate.
  if (CSRF_MUTATION_PATHS.has(reqPath) &&
      String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (reqPath === '/' && req.method === 'GET') {
    const html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    // Never let the WebView serve a stale entry document: index.html carries the
    // early boot-scale recovery script, so a cached copy would pin an old fix.
    // The doc is tiny and loopback-served, so no-store costs nothing. (CSS/JS
    // already revalidate via no-cache + ETag below.)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);

  } else if (reqPath === '/toggle' && (req.method === 'POST' || req.method === 'GET')) {
    isMuted = !isMuted;
    setMicMute(isMuted);
    json({ muted: isMuted });

  } else if (reqPath === '/ping' && req.method === 'GET') {
    // 1×1 transparent GIF — used by the iCUE widget to probe connectivity via
    // Image() instead of fetch(), bypassing Qt WebEngine's LocalContentCanAccessRemoteUrls block.
    const gif = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    res.end(gif);

  } else if (reqPath === '/status' && req.method === 'GET') {
    json(statusPayload());

  } else if (reqPath === '/system/theme' && req.method === 'GET') {
    // Reliable OS theme for the "Auto" appearance: the embedded WebView's
    // prefers-color-scheme is unreliable, so read Windows' app theme from the
    // registry. AppsUseLightTheme: 0x0 = dark apps, 0x1 = light apps.
    execFile('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'],
      { windowsHide: true, timeout: 4000 }, (e, stdout) => {
        let osDark = null;
        if (!e && stdout) {
          const m = stdout.match(/AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-fA-F]+)/i);
          if (m) osDark = parseInt(m[1], 16) === 0;
        }
        json({ osDark });
      });

  } else if (reqPath === '/audio' && req.method === 'GET') {
    try   { json(await getAudioInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/system' && req.method === 'GET') {
    try   { json(await getSystemInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/network' && req.method === 'GET') {
    try   { json(await getNetworkInfo()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/api/gamemode/status' && req.method === 'GET') {
    // Game mode runs off foreground full-screen detection (no PresentMon needed).
    // PresentMon is reported only so Settings can offer the optional FPS-readout
    // install button. The foreground field is a live diagnostic for false positives.
    try {
      json({
        presentMonAvailable: fpsMonitor.isAvailable(),
        gaming: gameDetect.isGaming(),
        gameRunning: gameDetect.isGameRunning(),
        gameProcess: gameDetect.getGameProcess(),
        activity: gameDetect.getActivity(),
        foreground: gameDetect.getGamingWindow(),
        diag: (typeof gameDetect.getGameDiag === 'function') ? gameDetect.getGameDiag() : null,
        fps: fpsMonitor.getGamingProcess(),
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/performance/stats' && req.method === 'GET') {
    // Read-only system snapshot for Performance Mode: memory pressure + the top
    // processes by RAM with a CPU% estimate. Feeds the optimization sheet (per-app
    // memory chips), the deterministic preselect, and the AI planner.
    try   { json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['stats'], 9000)); }
    catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/powerplan' && req.method === 'GET') {
    // Performance Mode: read the active Windows power scheme so the client can
    // remember it before switching, then restore it on exit. Fully reversible.
    try   { json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['get'], 6000)); }
    catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/powerplan' && req.method === 'POST') {
    // Switch to a known high-performance plan ('high'/'ultimate') or restore a
    // previously-saved scheme by GUID. The .ps1 rejects anything else.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const value = String(body.value || '').trim();
      const isPreset = value === 'high' || value === 'ultimate';
      const isGuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
      if (!isPreset && !isGuid) { res.writeHead(400); res.end('Invalid power plan'); return; }
      json(await runPowerShellScript(PERFORMANCE_SCRIPT, ['set', value], 8000));
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/performance/plan' && req.method === 'POST') {
    // AI planner for Performance Mode: returns { explanation, closeApps } curated
    // for the current activity, or { ok:false } so the client falls back to the
    // deterministic flow. The AI only picks among the open apps it's given.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const settings = (await readHubSettings().catch(() => null)) || {};
      const provider = aiLocal.sanitizeProvider(body.provider);
      const opts = (body.opts && typeof body.opts === 'object') ? body.opts : {};
      // Measure here (server-side) so the plan reasons on real RAM/CPU numbers;
      // a failed probe degrades to the old name-only prompt.
      const stats = await runPowerShellScript(PERFORMANCE_SCRIPT, ['stats'], 9000).catch(() => null);
      const plan = await _aiPerformancePlan({
        activity: String(body.activity || 'other'),
        appNames: Array.isArray(body.apps) ? body.apps : [],
        opts,
        provider,
        key: String(body.key || settings.geminiApiKey || '').trim(),
        model: aiLocal.sanitizeModel(body.model || settings.ollamaModel),
        ollamaUrl: body.ollamaUrl || settings.ollamaUrl,
        hardwareScan: settings.hardwareScan,
        lang: String(body.lang || 'en'),
        stats: (stats && stats.ok) ? stats : null,
      });
      if (!plan) { json({ ok: false }); return; }
      json({ ok: true, plan });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/status' && req.method === 'GET') {
    try {
      // If the session is up but the device list looks incomplete — empty, or a
      // device enumerated with 0 LEDs (the iCUE LINK hub reports 0 until iCUE
      // finishes registering the cooler/fans behind it, common right after a boot)
      // — kick a throttled, bounded re-enumeration so a follow-up status refresh
      // (and the next paint) see the real LED layout.
      if (lighting.isConnected()) {
        Promise.resolve(lighting.boundedReenumerate()).catch(() => {});
      }
      json(lighting.getStatus());
    }
    catch (e) { json({ available: false, reason: e.message }); }

  } else if (reqPath === '/api/lighting/effects' && req.method === 'POST') {
    // Apply a partial config change immediately, then persist it so Lighting-page
    // (and AI-driven) toggles survive a server restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.applyConfig(body);
      // Enabling connects asynchronously — wait briefly so the response carries
      // the connected state and the freshly-enumerated device list.
      if (body && body.enabled === true) { try { await lighting.ensureConnected(); } catch {} }
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/manual' && req.method === 'POST') {
    // Manual fixed colour — persisted so it survives a restart.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      let ok = true;
      if (body && body.clear) lighting.clearManual();
      else ok = lighting.setManualColor(body && body.color);
      await _persistLighting();
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/album' && req.method === 'POST') {
    // Live now-playing cover colour from the client. Transient (not persisted),
    // like the manual override; the bridge ignores it when the effect is off.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (body && body.clear) { lighting.clearAlbum(); json({ ok: true }); }
      else json({ ok: lighting.setAlbumColor(body && body.color, body && body.palette) });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/event' && req.method === 'POST') {
    // Client-originated event flash (reminder / notification). Timer is fired
    // server-side from _checkTimers. Never throws; unknown/disabled type = no-op.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.onEvent(String(body && body.type || ''));
      json({ ok: true });
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/lighting/animation' && req.method === 'POST') {
    // Ambient animation (none|solid|breathing|cycle). Persisted so it survives a
    // restart. The render loop only spins while a dynamic style is actively painting.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      lighting.setAnimation(body);
      await _persistLighting();
      json(lighting.getStatus());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/device-mode' && req.method === 'POST') {
    // Per-device override: { id, mode, color?, anim? }. Persisted.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = lighting.setDeviceMode(String(body && body.id || ''), body || {});
      await _persistLighting();
      json({ ok, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/scan' && req.method === 'POST') {
    // On-demand LAN discovery for external providers (WLED, …). No background scan.
    try {
      const result = await lighting.scanExternal();
      await _persistLighting();
      json({ ok: true, found: result.found, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/device' && req.method === 'POST') {
    // Add / remove / opt-in an external device. body: { provider, action, host?, id?, optedIn? }
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const action = String(body && body.action || '');
      let result = { ok: false };
      if (action === 'add') {
        const dev = await lighting.addExternalDevice(provider, String(body.host || ''));
        result = { ok: !!dev, device: dev || null };
      } else if (action === 'pair') {
        const r = await lighting.pairExternalDevice(provider, String(body.host || ''));
        result = { ok: !!(r && r.ok), needsButton: !!(r && r.needsButton) };
      } else if (action === 'remove') {
        result = { ok: lighting.removeExternalDevice(provider, String(body.id || '')) };
      } else if (action === 'optin') {
        result = { ok: lighting.setExternalDeviceOptIn(provider, String(body.id || ''), body.optedIn !== false) };
      }
      await _persistLighting();
      json({ ...result, status: lighting.getStatus() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/lighting/open-download' && req.method === 'POST') {
    // Open a provider's official download page in the default browser. The URL is
    // resolved server-side from the provider catalogue, never taken from the client.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const provider = String(body && body.provider || '');
      const entry = lighting.getExternalStatus().providers.find(p => p.id === provider);
      const url = entry && entry.download;
      if (url && /^https:\/\//i.test(url)) {
        execFile('cmd', ['/c', 'start', '', url], () => {});
        json({ ok: true, url });
      } else {
        json({ ok: false, error: 'no download url' });
      }
    } catch (e) { json({ ok: false, error: e.message }); }

  } else if (reqPath === '/api/guardian/history' && req.method === 'GET') {
    // Guardian hardware-health history for the dashboard charts (same local data
    // the AI digest summarises). Read-only; harmless when Guardian is disabled —
    // it just returns whatever buckets were collected while it was last on.
    try { json(await guardian.getHistory()); }
    catch (e) { json({ enabled: false, hours: [], days: [], error: e.message }); }

  } else if (reqPath === '/api/gamemode/install-presentmon' && req.method === 'POST') {
    // One-click download of the classic single-binary PresentMon CLI (the same
    // v1.10.0 asset install.ps1 fetches), placed in server/presentmon/.
    try {
      if (fpsMonitor.isAvailable()) { json({ ok: true, alreadyInstalled: true }); }
      else {
        const ps = [
          "$ErrorActionPreference='Stop';",
          "$dir=$env:PM_DIR; $exe=Join-Path $dir 'PresentMon.exe';",
          "if(-not(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force | Out-Null};",
          '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;',
          "$h=@{'User-Agent'='XenonEdgeHub';'Accept'='application/vnd.github+json'};",
          "$rel=Invoke-RestMethod -Uri 'https://api.github.com/repos/GameTechDev/PresentMon/releases/tags/v1.10.0' -Headers $h -TimeoutSec 25;",
          "$a=$rel.assets | Where-Object { $_.name -match 'PresentMon.*x64.*\\.exe$' } | Select-Object -First 1;",
          "if(-not $a){$a=$rel.assets | Where-Object { $_.name -match '\\.exe$' } | Select-Object -First 1};",
          "if(-not $a){throw 'no PresentMon x64 executable in release assets'};",
          "Invoke-WebRequest -Uri $a.browser_download_url -OutFile $exe -Headers @{'User-Agent'='XenonEdgeHub'} -TimeoutSec 120 -UseBasicParsing;",
          "if(-not(Test-Path $exe)){throw 'download did not produce PresentMon.exe'}",
        ].join(' ');
        await new Promise((resolve, reject) =>
          execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
            { windowsHide: true, timeout: 180000, env: { ...process.env, PM_DIR: path.join(__dirname, 'presentmon') } },
            (psErr) => psErr ? reject(psErr) : resolve()
          )
        );
        try { fpsMonitor.reload(); } catch { /* monitor will retry on its own */ }
        json({ ok: true, installed: true });
      }
    } catch (e) {
      err500('PresentMon non installato: ' + (e && e.message ? e.message : 'download fallito'));
    }

  } else if (reqPath === '/weather' && req.method === 'GET') {
    try {
      const requestedWeather = urlObj.searchParams.has('mode') || urlObj.searchParams.has('city')
        ? { mode: urlObj.searchParams.get('mode'), city: urlObj.searchParams.get('city') }
        : null;
      json(await getWeather(urlObj.searchParams.get('lang') || 'it', requestedWeather));
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media' && req.method === 'GET') {
    try {
      if (urlObj.searchParams.has('source')) setMediaPreferredSource(urlObj.searchParams.get('source'));
      json(await getMediaInfo());
    }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/source' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let body = {};
      if (req.method === 'POST') body = JSON.parse(await readBody(req) || '{}');
      const source = body.source ?? urlObj.searchParams.get('source') ?? '';
      json({ ok: true, preferredSource: setMediaPreferredSource(source) });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/media/playpause' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('playpause')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/next' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('next')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/media/previous' && (req.method === 'POST' || req.method === 'GET')) {
    try   { json(await mediaAction('previous')); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows' && req.method === 'GET') {
    try   { json(await runWindowsTool(['list'], 12000)); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/windows/focus' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      if (!id || typeof id !== 'string' || !/^\d{1,24}$/.test(id)) {
        res.writeHead(400); res.end('Invalid window id'); return;
      }
      json(await runWindowsTool(['focus', id], 5000));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/volume/set' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedSpeakerId) { err500('Cache not ready'); return; }
      execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], e => {
        if (e) err500(e.message); else json({ ok: true, level: vol });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let level;
      if (req.method === 'GET') {
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ level } = JSON.parse(await readBody(req)));
      }
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      if (!cachedMicId) { err500('Cache not ready'); return; }
      // Natural behaviour: 0 = silent (muted), >0 = audible at that level.
      execFile(SVV, ['/SetVolume', cachedMicId, String(vol)], e1 => {
        if (e1) { err500(e1.message); return; }
        execFile(SVV, [vol === 0 ? '/Mute' : '/Unmute', cachedMicId], e => {
          if (e) err500(e.message); else json({ ok: true, level: vol });
        });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/speaker/mute' && (req.method === 'POST' || req.method === 'GET')) {
    if (!cachedSpeakerId) { err500('Cache not ready'); return; }
    execFile(SVV, ['/Switch', cachedSpeakerId], e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/audio/app/volume' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let id, level, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        level = parseInt(urlObj.searchParams.get('level'));
      } else {
        ({ id, level, proc } = JSON.parse(await readBody(req)));
      }
      if (!id && !proc) { err500('Missing id'); return; }
      // Prefer the durable process-name target over the session CLI id, which
      // SoundVolumeView rotates across app restarts (a stale id is a silent miss).
      const target = proc ? appAudioTarget(proc) : id;
      const vol = Math.max(0, Math.min(100, parseInt(level)));
      // Natural behaviour: 0 = silent (muted) for that app, >0 = audible.
      execFile(SVV, ['/SetVolume', target, String(vol)], e1 => {
        if (e1) { err500(e1.message); return; }
        execFile(SVV, [vol === 0 ? '/Mute' : '/Unmute', target], e => {
          if (e) err500(e.message); else json({ ok: true, level: vol });
        });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/app/mute' && (req.method === 'POST' || req.method === 'GET')) {
    try {
      let id, muted, proc;
      if (req.method === 'GET') {
        id = urlObj.searchParams.get('id');
        proc = urlObj.searchParams.get('proc');
        muted = urlObj.searchParams.get('muted');
      } else {
        ({ id, muted, proc } = JSON.parse(await readBody(req)));
      }
      if (!id && !proc) { err500('Missing id'); return; }
      // Prefer the durable process-name target over the volatile session CLI id.
      const target = proc ? appAudioTarget(proc) : id;
      // Explicit state (deterministic) when the client tells us; else toggle.
      const action = muted === undefined || muted === null
        ? '/Switch'
        : ((muted === true || muted === 'true' || muted === '1') ? '/Mute' : '/Unmute');
      execFile(SVV, [action, target], e => {
        if (e) err500(e.message); else json({ ok: true });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/audio/apps' && req.method === 'GET') {
    // Broader app list for the Deck editor's app picker: every application audio
    // session (active OR inactive) that has a real exe, deduped by process name.
    // Wider than /audio (which only surfaces apps currently producing sound) so a
    // key can be configured for an app that isn't playing right now.
    try {
      const rows = await readSoundVolumeRows();
      const SYS_RE = /^(audiodg|rtkuwp|system|dwm|explorer|searchhost|shellexperiencehost|startmenuexperiencehost|textinputhost|applicationframehost|nvcontainer)$/i;
      const procOf = f => ((f[F.PROC_PATH] || '').split('\\').pop() || '').replace(/\.exe$/i, '');
      const seen = new Map();
      for (const f of rows) {
        if (f[F.TYPE] !== 'Application' || !f[F.PROC_PATH]) continue;
        const proc = procOf(f);
        if (!proc || SYS_RE.test(proc)) continue;
        const key = proc.toLowerCase();
        if (!seen.has(key)) seen.set(key, { proc, name: f[F.NAME] || f[F.WINDOW_TITLE] || proc });
      }
      json({ ok: true, apps: [...seen.values()] });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }

  } else if (reqPath === '/deck/sound' && req.method === 'GET') {
    // Stream a user-chosen local audio file for the Deck soundboard. The browser
    // plays it; the file path comes from the user's own Deck config (same trust
    // level as the open-file/open-app actions). This is the only route that returns
    // raw file CONTENTS for a client-supplied path, so it is hardened two ways:
    //   1. Fetch Metadata gate — reject cross-site requests. The browser stamps
    //      `Sec-Fetch-Site` and a page can't forge it, so a malicious site can't
    //      point an <audio> at this route to read/play local files; only the
    //      same-origin dashboard can. (Absent header = non-browser caller, which
    //      already has direct filesystem access — no escalation.)
    //   2. Extension allowlist — only audio files, so it can't read documents/secrets.
    // Range is supported so <audio> seeking works.
    if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
      res.writeHead(403); res.end(); return;
    }
    try {
      const SOUND_MIME = {
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus', '.weba': 'audio/webm',
      };
      const abs = path.resolve(urlObj.searchParams.get('path') || '');
      const mime = SOUND_MIME[path.extname(abs).toLowerCase()];
      if (!mime) { res.writeHead(415); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
      const range = req.headers.range;
      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) { res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); res.end(); return; }
        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` }); res.end(); return;
        }
        res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }
      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (reqPath === '/apps/store' && req.method === 'GET') {
    // Installed Store/UWP apps for the Deck "open Store app" picker. Get-StartApps
    // lists every Start-menu entry; we keep only UWP ones (an AppID carrying the
    // PackageFamilyName!AppId separator) so a key can launch e.g. the Store Spotify,
    // which lives in a protected WindowsApps folder and can't be opened by path.
    try {
      const out = await new Promise((resolve) => {
        execFile('powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
            "Get-StartApps | Where-Object { $_.AppID -like '*!*' } | Select-Object Name,AppID | ConvertTo-Json -Compress"],
          { timeout: 9000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
          (e, stdout) => resolve(e ? '' : String(stdout || '')));
      });
      const apps = [];
      if (out.trim()) {
        const parsed = JSON.parse(out);
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        const seen = new Set();
        for (const a of arr) {
          const value = (a && a.AppID) ? String(a.AppID) : '';
          if (!value || !value.includes('!') || seen.has(value.toLowerCase())) continue;
          seen.add(value.toLowerCase());
          apps.push({ value, label: (a && a.Name) ? String(a.Name) : value });
        }
        apps.sort((x, y) => x.label.localeCompare(y.label));
      }
      json({ ok: true, apps });
    } catch (e) { json({ ok: false, apps: [], error: e.message }); }

  } else if (reqPath === '/speaker/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) err500(e.message); else { cachedSpeakerId = id; json({ ok: true }); }
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/mic/set' && req.method === 'POST') {
    try {
      const { id } = JSON.parse(await readBody(req));
      execFile(SVV, ['/SetDefault', id, 'all'], e => {
        if (e) { err500(e.message); return; }
        cachedMicId = id;
        if (isMuted) setMicMute(true);
        json({ ok: true });
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/run' && req.method === 'POST') {
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      json(await deckRegistry.run(action));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/perf' && req.method === 'POST') {
    // Performance Mode system actions (guided app close/relaunch). Allowlisted
    // and validated inside perfRegistry — never an arbitrary command.
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      json(await perfRegistry.run(action));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/actions/catalog' && req.method === 'GET') {
    try {
      const { ACTION_CATALOG } = require('./js/deck-actions.js');
      const s = (await readHubSettings().catch(() => null)) || {};
      const rc = (s.remoteControl && typeof s.remoteControl === 'object') ? s.remoteControl : {};
      // "configured" = la presenza delle credenziali Sunshine (le scrive
      // configureSunshine al termine del setup). I flag *Installed non vengono
      // mai persistiti, quindi non sono un segnale affidabile.
      const remoteConfigured = !!(rc.sunshineUser && rc.sunshinePass);
      // Twitch actions are only useful when logged in — surface that so the editor
      // can hide them until the user connects (mirrors obs/remote gating).
      const tw = await streamTwitch.status().catch(() => ({ connected: false }));
      const yt = await streamYouTube.status().catch(() => ({ connected: false }));
      json({ catalog: ACTION_CATALOG, capabilities: { powershell: true, soundVolumeView: fs.existsSync(SVV), obsConfigured: !!s.obsHost, streamerbotConfigured: !!s.streamerbotHost, remoteConfigured, twitchConnected: !!tw.connected, youtubeConnected: !!yt.connected } });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/embedded-browser/available' && req.method === 'GET') {
    // Lets the Browser widget render a friendly "Edge not found" state instead of
    // silently failing when Microsoft Edge isn't installed.
    json({ available: embeddedBrowser.available() });

  } else if (reqPath === '/obs/scenes' && req.method === 'GET') {
    try {
      const d = await deckObs.request('GetSceneList', {});
      json({ ok: true, current: d.currentProgramSceneName || '', scenes: (d.scenes || []).map((s) => s.sceneName).filter(Boolean) });
    } catch (e) {
      json({ ok: false, scenes: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/obs/sources' && req.method === 'GET') {
    try {
      const d = await deckObs.request('GetInputList', {});
      const inputs = Array.isArray(d.inputs) ? d.inputs : [];
      // Prefer audio inputs (mic / desktop / app audio); if the kind filter matches
      // none, fall back to every input so the user can still pick one.
      const audio = inputs.filter((i) => /audio|wasapi|coreaudio|pulse|sndio|alsa/i.test(i.inputKind || ''));
      const sources = (audio.length ? audio : inputs).map((i) => i.inputName).filter(Boolean);
      json({ ok: true, sources });
    } catch (e) {
      json({ ok: false, sources: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/streamerbot/actions' && req.method === 'GET') {
    // Live list of Streamer.bot actions for the Deck editor + Settings card. The
    // editor stores each key's action by id (stable across renames); the name is
    // only the label. Returns {ok:false} (not an error) when streamer.bot is off.
    try {
      const d = await deckSb.request('GetActions', {});
      const actions = (Array.isArray(d.actions) ? d.actions : [])
        .map((a) => ({ id: String(a.id || ''), name: String(a.name || '') }))
        .filter((a) => a.id);
      json({ ok: true, actions });
    } catch (e) {
      json({ ok: false, actions: [], error: String((e && e.message) || e) });
    }

  } else if (reqPath === '/notes' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    fs.promises.readFile(NOTES_FILE, 'utf8')
      .then(notes => json({ notes }))
      .catch(e => {
        if (e.code === 'ENOENT') json({ notes: '' });
        else err500(e.message);
      });

  } else if (reqPath === '/notes' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let notes;
      if (req.method === 'GET') {
        notes = urlObj.searchParams.get('data') || '';
      } else {
        const body = JSON.parse(await readBody(req));
        notes = typeof body.notes === 'string' ? body.notes : (typeof body.text === 'string' ? body.text : '');
      }
      // Cap at 200 KB to prevent disk exhaustion via repeated saves.
      const safe = String(notes).slice(0, 200_000);
      fs.promises.writeFile(NOTES_FILE, safe, 'utf8')
        .then(() => json({ ok: true, savedAt: Date.now() }))
        .catch(e => err500(e.message));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/version' && req.method === 'GET') {
    json({ version: APP_VERSION });

  } else if (reqPath === '/update/check' && req.method === 'GET') {
    // Latest released version vs the running one (probed at most daily,
    // fail-silent — offline simply reports no update). `?force=1` bypasses the
    // cache for the manual "check now" button.
    try {
      const u = await checkLatestRelease(urlObj.searchParams.get('force') === '1');
      json({
        current: APP_VERSION,
        latest: u.ok ? u.latest : '',
        url: u.ok ? u.url : '',
        notes: u.ok ? u.notes : '',
        name: u.ok ? u.name : '',
        publishedAt: u.ok ? u.publishedAt : '',
        updateAvailable: !!(u.ok && semverNewer(u.latest, APP_VERSION)),
      });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/update/self-status' && req.method === 'GET') {
    // Whether one-click self-update is possible here (not a git checkout, applier
    // present), and whether a validated build is already staged and ready to apply.
    try {
      json({ supported: selfUpdate.supported(), staged: selfUpdate.staged() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/update/prepare' && req.method === 'POST') {
    // Non-destructive: download + extract + validate the latest release into
    // DATA_DIR. The live install is never touched here.
    try {
      await readBody(req);
      if (!selfUpdate.supported()) { json({ ok: false, error: 'unsupported' }); return; }
      const u = await checkLatestRelease(true);
      if (!u.ok || !semverNewer(u.latest, APP_VERSION)) { json({ ok: false, error: 'no_update' }); return; }
      const r = await selfUpdate.prepare({ tag: u.tag, version: u.latest });
      json(r);
    } catch (e) { json({ ok: false, error: String(e && e.message || e) }); }

  } else if (reqPath === '/update/apply' && req.method === 'POST') {
    // Hand off to the external applier (elevated, detached). Only valid once a
    // build is staged; from here the swap happens outside this process.
    try {
      await readBody(req);
      json(selfUpdate.apply());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/export' && req.method === 'GET') {
    // One portable JSON file with the user's configuration (no secrets, no
    // uploaded binaries). Served as a download.
    try {
      const bundle = await buildBackup();
      const name = 'xenon-backup-' + new Date().toISOString().slice(0, 10) + '.json';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      res.end(JSON.stringify(bundle, null, 2));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/import' && req.method === 'POST') {
    try {
      const raw = await readBody(req, BACKUP_MAX_BYTES);
      json(await applyBackup(JSON.parse(raw || '{}')));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/backup/save' && req.method === 'POST') {
    // Embedded-view fallback: the iCUE WebView (and some kiosk browsers) have no
    // download manager, so a blob/anchor download silently does nothing there.
    // Since the server runs on the same PC, write the backup straight to the
    // user's Downloads folder and report the path back for a confirmation toast.
    try { json(await saveBackupToDisk()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'GET') {
    // Redact server-only secrets (remote-control creds) before sending to the browser.
    try { json({ settings: redactRemoteCreds(await readHubSettings()) }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/settings' && req.method === 'POST') {
    try {
      const body    = JSON.parse(await readBody(req));
      const prev    = await readHubSettings().catch(() => null);
      // The browser settings model doesn't carry the server-only remote-control
      // creds, so carry them over from the persisted copy — a client save must
      // never wipe them (that's what left Sunshine stuck at "Not ready").
      const incoming = preserveRemoteCreds(body.settings || body, prev);
      // lighting.providers / deviceModes are bridge-owned (set only via
      // /api/lighting/*) and the client mirror never carries them — refill them
      // from the live bridge so a client save can't wipe external devices and
      // their pairing tokens from settings.json.
      incoming.lighting = {
        ...(incoming.lighting && typeof incoming.lighting === 'object' ? incoming.lighting : {}),
        providers: lighting.getExternalConfig(),
        deviceModes: lighting.getConfig().deviceModes,
      };
      const settings = await writeHubSettings(incoming);
      _serverHubSettings = settings;
      // The save itself succeeded; a lighting apply failure must not fail the
      // request, but it must be visible (log + flag) instead of a silent no-op.
      let lightingApplied = true;
      try { lighting.applyConfig(settings.lighting); }
      catch (e) { lightingApplied = false; console.error('Lighting apply failed:', e.message); }
      refreshExternalFeeds().catch(() => {}); // pick up feed add/remove immediately
      refreshObsWatch();                       // start/stop the live OBS watch if its config changed
      json({ ok: true, settings: redactRemoteCreds(settings), savedAt: Date.now(), lightingApplied });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/startup/auto-open' && req.method === 'GET') {
    // Reports whether opening the dashboard in the browser at logon is supported
    // (Windows only) and whether the logon task currently exists.
    try {
      const state = await getBrowserAutoOpenState();
      json({ ok: true, supported: AUTO_OPEN_SUPPORTED, enabled: state.enabled });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/startup/auto-open' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const state = await setBrowserAutoOpen(body && body.enabled === true);
      json({ ok: true, supported: AUTO_OPEN_SUPPORTED, enabled: state.enabled });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/deck-config' && req.method === 'GET') {
    try {
      const store = await readDeckStore();
      json({ configs: store.configs, rev: store.rev, savedAt: store.savedAt, instanceRevs: store.instanceRevs, presets: store.presets, keyPresets: store.keyPresets });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/deck-config' && req.method === 'POST') {
    try {
      const raw = await readBody(req);
      if (raw.length > DECK_MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Deck config too large' }));
        return;
      }
      const body = JSON.parse(raw);
      const current = await readDeckStore();

      // Current protocol: the client sends only the changes it actually made, as
      // precise ops ({ ops: [...] }). The server owns the store and assigns every
      // revision, so two clients' uncoordinated local counters can never fight —
      // a stale open dashboard simply has no ops to send and can't overwrite or
      // delete decks it never touched (the "edit reverted / second deck wiped
      // after a reboot" loss).
      if (Array.isArray(body.ops)) {
        const applied = deckStore.applyDeckOps(current, body.ops);
        if (!applied.changed) {
          json({ ok: true, rev: current.rev, savedAt: current.savedAt });
          return;
        }
        applied.store.rev = current.rev + 1;
        const saved = await writeDeckStore(applied.store);
        // Nudge every other open dashboard to re-sync its decks right away.
        broadcastSSE('deck', { rev: saved.rev });
        json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
        return;
      }

      // LEGACY whole-blob push (a client still running the previous deck.js, or an
      // old queued beacon). Made strictly ADDITIVE: it can RESTORE an instance the
      // server is missing entirely, but it never overwrites one the server already
      // has. The server is authoritative — its decks got there via precise ops from
      // up-to-date clients — so a stale dashboard can no longer revert a key edit by
      // racing its beacon after a reboot (the reported "my button reverted" loss).
      const incoming = normalizeDeckStore(body);
      const applied = deckStore.applyLegacyBlob(current, incoming);
      if (!applied.changed) {
        json({ ok: true, rev: current.rev, savedAt: current.savedAt });
        return;
      }
      applied.store.rev = current.rev + 1;   // revs are server-assigned — never adopt a client counter
      const saved = await writeDeckStore(applied.store);
      broadcastSSE('deck', { rev: saved.rev });
      json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && req.method === 'GET' && !urlObj.searchParams.has('save')) {
    try { json({ events: await readEvents() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/events' && (req.method === 'POST' || (req.method === 'GET' && urlObj.searchParams.has('save')))) {
    try {
      let body;
      if (req.method === 'GET') {
        body = JSON.parse(urlObj.searchParams.get('data') || '[]');
      } else {
        body = JSON.parse(await readBody(req));
      }
      const events = await writeEvents(body.events || body);
      json({ ok: true, events, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/external-events' && req.method === 'GET') {
    try {
      if (urlObj.searchParams.has('refresh')) await refreshExternalFeeds();
      json({ feeds: _externalFeedCache.feeds, events: _externalFeedCache.events, refreshedAt: _externalFeedCache.refreshedAt });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/external-events/refresh' && req.method === 'POST') {
    try { await refreshExternalFeeds(); json({ ok: true, feeds: _externalFeedCache.feeds, refreshedAt: _externalFeedCache.refreshedAt }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'GET') {
    try { json({ tasks: await readTasks() }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/tasks' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const tasks = await writeTasks(body.tasks || body);
      json({ ok: true, tasks, savedAt: Date.now() });
    } catch (e) { err500(e.message); }

  // ── Timers API ────────────────────────────────────────────────────────────
  } else if (reqPath === '/api/timers' && req.method === 'GET') {
    json({ timers: _timers });

  } else if (reqPath === '/api/timers' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      if (_timers.length >= TIMERS_MAX) { res.writeHead(400); res.end(JSON.stringify({ error: 'max timers reached' })); return; }
      const timer = _normalizeTimer({
        label: String(body.label || 'Timer').trim(),
        durationSecs: Math.max(1, Math.round(Number(body.duration_secs) || 60)),
        status: 'running',
        startedAt: Date.now(),
        pausedElapsed: 0,
      });
      _timers.push(timer);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'PATCH') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      const body = JSON.parse(await readBody(req));
      const action = String(body.action || '').trim();
      const idx = _timers.findIndex(t => t.id === tid);
      if (idx < 0) { res.writeHead(404); res.end(JSON.stringify({ error: 'not found' })); return; }
      const t = { ..._timers[idx] };
      if (action === 'pause' && t.status === 'running') {
        t.pausedElapsed += (Date.now() - t.startedAt) / 1000;
        t.status = 'paused';
      } else if (action === 'resume' && t.status === 'paused') {
        t.startedAt = Date.now();
        t.status = 'running';
      } else if (action === 'reset') {
        t.startedAt = Date.now();
        t.pausedElapsed = 0;
        t.status = 'running';
      }
      _timers[idx] = t;
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ timer: t });
    } catch (e) { err500(e.message); }

  } else if (reqPath.startsWith('/api/timers/') && req.method === 'DELETE') {
    try {
      const tid = decodeURIComponent(reqPath.slice('/api/timers/'.length));
      _timers = _timers.filter(t => t.id !== tid);
      await _saveTimers();
      broadcastSSE('timer_update', { timers: _timers });
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/lock' && req.method === 'POST') {
    exec('rundll32.exe user32.dll,LockWorkStation', e => {
      if (e) err500(e.message); else json({ ok: true });
    });

  } else if (reqPath === '/api/companion/insight' && req.method === 'POST') {
    // Game Companion (opt-in, Settings → Funzioni AI): capture the primary
    // screen and ask Gemini for a short in-game insight. Each call costs one
    // vision request, so the client only calls it on demand (overlay opened
    // or manual refresh) — never on a background timer while hidden.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const apiKey = String(body.key || '').trim().slice(0, 200);
      if (!apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese' };
      const langName = LANG_NAMES[String(body.lang || '').toLowerCase().slice(0, 2)] || 'English';
      const question = String(body.question || '').trim().slice(0, 300);
      let fgProc = '';
      try { fgProc = gameDetect.getForegroundProcess() || ''; } catch {}
      const screens = await listScreens();
      const primary = screens.find(s => s.primary) || screens[0];
      const shot = await captureScreenshot(primary);
      const sysText = 'You are Xenon\'s Game Companion, shown on a small secondary touchscreen next to the user\'s main monitor while they play. You receive a live screenshot of their game.';
      const task = question
        ? `The user asks: «${question}». Answer their question, grounded in what you see on screen. Reply in ${langName}: short plain sentences, no markdown, no preamble.`
        : `Identify the game and the current in-game situation, then give ONE concrete, immediately useful tip (strategy, mechanic, objective, build…). Reply in ${langName}: 2-3 short plain sentences, no markdown, no preamble. If the screen is clearly not a game, briefly say what you see instead.`;
      const userParts = [
        { text: `Live screenshot of the user's primary monitor${fgProc ? ` (foreground process: "${fgProc}")` : ''}. ${task}` },
        { inlineData: { mimeType: 'image/jpeg', data: shot } },
      ];
      const text = await _geminiOneShot(apiKey, userParts, sysText, 512);
      let fps = null;
      try { fps = fpsMonitor.getCurrentFps(); } catch { fps = null; }
      json({ text, process: fgProc, fps });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/api/ai' && req.method === 'POST') {
    try {
      const aiRaw = await readBodyBuffer(req, 10 * 1024 * 1024); // 10 MB — accommodate base64 images
      const aiBody = JSON.parse(aiRaw.toString('utf8') || '{}');
      const apiKey = String(aiBody.key || '').trim().slice(0, 200);
      const messages = Array.isArray(aiBody.messages) ? aiBody.messages.slice(0, 50) : [];
      const isVoice = aiBody.voice === true;
      // The UI language. Used to force the reply language — without it Gemini tends
      // to answer in English when the turn carries an image or audio (little text to
      // infer from), which breaks an otherwise Italian conversation.
      const _uiLang2 = String(aiBody.lang || '').toLowerCase().slice(0, 2);
      const LANG_NAMES = { it: 'Italian', en: 'English', ko: 'Korean', ja: 'Japanese', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese' };
      const langName = LANG_NAMES[_uiLang2] || '';

      const provider = aiLocal.sanitizeProvider(aiBody.provider);
      const ollModel = aiLocal.sanitizeModel(aiBody.model);

      if (provider === 'gemini' && !apiKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_key' })); return;
      }
      if (!messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no_messages' })); return;
      }

      const AI_FUNCTIONS = [
        // ── Microphone ──
        { name: 'toggle_mic', description: 'Toggle microphone mute/unmute', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'mute_mic', description: 'Mute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'unmute_mic', description: 'Unmute the microphone', parameters: { type: 'OBJECT', properties: {} } },
        // ── Media ──
        { name: 'media_playpause', description: 'Play or pause current media playback', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_next', description: 'Skip to the next track', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'media_previous', description: 'Go to the previous track', parameters: { type: 'OBJECT', properties: {} } },
        // ── Volume / Audio ──
        { name: 'set_volume', description: 'Set master speaker volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Volume level 0-100' } }, required: ['level'] } },
        { name: 'toggle_speaker_mute', description: 'Toggle the speaker/audio output mute on or off', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_mic_volume', description: 'Set microphone input volume (0-100)', parameters: { type: 'OBJECT', properties: { level: { type: 'NUMBER', description: 'Mic volume 0-100' } }, required: ['level'] } },
        { name: 'app_audio', description: 'Adjust the audio of a SPECIFIC running application (per-app mixer) — turn one app up or down, or mute/unmute it, without touching the master volume. e.g. "lower Spotify", "mute Chrome".', parameters: { type: 'OBJECT', properties: {
          app: { type: 'STRING', description: 'The application name or process, e.g. "Spotify", "chrome", "Discord"' },
          action: { type: 'STRING', description: 'One of: volume_up, volume_down, mute, unmute, toggle_mute' },
        }, required: ['app', 'action'] } },
        // ── System ──
        { name: 'lock_pc', description: 'Lock the Windows workstation', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_system_info', description: 'Get current CPU, GPU, RAM and disk usage stats', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'get_weather', description: 'Get current weather conditions and forecast', parameters: { type: 'OBJECT', properties: {} } },
        // ── Web search ──
        { name: 'web_search', description: 'Search the internet for current, recent, or real-time information you are not certain about (news, prices, sports scores, release dates, live facts, anything after your training cutoff). Returns a grounded summary with sources. Use it instead of guessing whenever freshness matters.', parameters: { type: 'OBJECT', properties: {
          query: { type: 'STRING', description: 'The search query, phrased clearly (e.g. "EUR USD exchange rate today", "latest iPhone model 2026")' },
        }, required: ['query'] } },
        // ── Screen vision ──
        { name: 'capture_screen', description: 'Capture a fresh screenshot of the user\'s screen so you can see what is currently displayed. Use it whenever the user asks about what is on their screen, asks you to read/look at/check something visual, or references on-screen content. The capture is always live (current moment). On multi-monitor setups, pass the 1-based monitor number; if the user did not say which monitor and there are several, omit it to receive the monitor list and then ask which one to focus on.', parameters: { type: 'OBJECT', properties: { monitor: { type: 'NUMBER', description: '1-based monitor index to capture (e.g. 1, 2). Omit on single-monitor setups or to list monitors first.' } } } },
        // ── Notes ──
        { name: 'read_notes', description: 'Read the current notes/scratchpad content', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'write_notes', description: 'Replace the notes content with new text', parameters: { type: 'OBJECT', properties: { content: { type: 'STRING', description: 'New notes content' } }, required: ['content'] } },
        // ── Tasks ──
        { name: 'list_tasks', description: 'List all tasks in the task list', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_task', description: 'Create a new task in the task list', parameters: { type: 'OBJECT', properties: {
          text: { type: 'STRING', description: 'Task description' },
          priority: { type: 'STRING', description: 'Priority: high, medium, or low (default: medium)' },
        }, required: ['text'] } },
        { name: 'delete_task', description: 'Delete a specific task by its id. Use list_tasks first to get the id if not known.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to delete' },
        }, required: ['id'] } },
        { name: 'clear_all_tasks', description: 'Delete ALL tasks at once. Use only when the user explicitly asks to clear or delete all tasks.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'complete_task', description: 'Mark a task as completed or uncompleted. Use list_tasks first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Task id to mark' },
          completed: { type: 'BOOLEAN', description: 'true to mark done, false to unmark (default true)' },
        }, required: ['id'] } },
        // ── Calendar ──
        { name: 'list_calendar_events', description: 'List upcoming calendar events', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'create_calendar_event', description: 'Create a new calendar event', parameters: { type: 'OBJECT', properties: {
          title: { type: 'STRING', description: 'Event title' },
          starts_at: { type: 'STRING', description: 'Start datetime in ISO 8601, e.g. 2026-05-25T14:00:00' },
          notes: { type: 'STRING', description: 'Optional notes' },
          reminder_at: { type: 'STRING', description: 'Optional reminder datetime in ISO 8601' },
        }, required: ['title', 'starts_at'] } },
        { name: 'delete_calendar_event', description: 'Delete a calendar event by its id. Use list_calendar_events first if you do not know the id.', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Event id to delete' },
        }, required: ['id'] } },
        { name: 'clear_all_calendar_events', description: 'Delete ALL calendar events at once. Use only when the user explicitly asks to clear or delete all events.', parameters: { type: 'OBJECT', properties: {} } },
        // ── Dashboard UI ──
        { name: 'open_weather_panel', description: 'Open the weather details panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_settings', description: 'Open the settings panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'open_app_switcher', description: 'Open the app switcher panel', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'show_lock_screen', description: 'Show the focus lock screen overlay', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'change_theme', description: 'Change the dashboard color theme (xenon, ocean, ember, violet, mono)', parameters: { type: 'OBJECT', properties: { preset: { type: 'STRING', description: 'Theme name' } }, required: ['preset'] } },
        { name: 'close_ai_panel', description: 'Close the Xenon AI chat panel', parameters: { type: 'OBJECT', properties: {} } },
        // ── Performance Mode ──
        { name: 'optimize_performance', description: 'Open Performance Mode optimization (shows the confirmation sheet listing what will be done). Use when the user asks to optimize performance, free up resources, or boost the PC for gaming/work. It never applies anything without the user confirming on the sheet.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'restore_performance', description: 'Undo Performance Mode: restore the previous power plan, resume animations, and reopen any apps that were closed. Use when the user asks to restore performance settings or undo the optimization.', parameters: { type: 'OBJECT', properties: {} } },
        // ── Timers ──
        { name: 'start_timer', description: 'Start a new countdown timer. Use for user requests like "set a timer for 5 minutes", "remind me in 30 seconds", etc.', parameters: { type: 'OBJECT', properties: {
          label: { type: 'STRING', description: 'Short label for the timer, e.g. "Pasta", "Break", "Meeting"' },
          duration_secs: { type: 'NUMBER', description: 'Duration in seconds (e.g. 300 for 5 minutes, 3600 for 1 hour)' },
        }, required: ['duration_secs'] } },
        { name: 'list_timers', description: 'List all active timers and their remaining time', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'delete_timer', description: 'Delete a timer by its id', parameters: { type: 'OBJECT', properties: {
          id: { type: 'STRING', description: 'Timer id to delete' },
        }, required: ['id'] } },
        // ── System launcher ──
        { name: 'open_application', description: 'Open an app, website, or file on the user\'s Windows PC. For well-known apps use their plain name (spotify, chrome, notepad, obs, vlc…). For Steam use exactly "steam", for Discord use "discord". Full URLs (https://…) and absolute file paths also work.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name (e.g. "spotify", "steam", "discord"), full URL, or absolute file path' },
        }, required: ['target'] } },
        { name: 'close_application', description: 'Close / terminate a running application on the user\'s Windows PC. Use the plain app name (e.g. "spotify", "chrome", "notepad", "discord", "steam", "obs", "vlc"). Works for any process.', parameters: { type: 'OBJECT', properties: {
          target: { type: 'STRING', description: 'App name to close, e.g. "spotify", "chrome", "discord"' },
        }, required: ['target'] } },
        // ── RGB Lighting (Corsair / iCUE bridge) ──
        { name: 'set_lights', description: 'Set a manual RGB colour on the Corsair devices (overrides reactive effects until cleared). Accepts a colour name (EN or IT, e.g. "red"/"rosso") or a #RRGGBB hex. Use "off"/"spento" to turn them dark.', parameters: { type: 'OBJECT', properties: {
          color: { type: 'STRING', description: 'Colour name or #RRGGBB, e.g. "red", "rosso", "#00ff88", "off"' },
        }, required: ['color'] } },
        { name: 'clear_lights', description: 'Clear the manual colour override so reactive effects (CPU temperature, timer, volume) resume.', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'set_effect', description: 'Enable or disable a lighting effect (temperature, volume, timer, notification, reminder).', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: temperature, volume, timer, notification, reminder' },
          enabled: { type: 'BOOLEAN', description: 'true to enable, false to disable' },
        }, required: ['effect', 'enabled'] } },
        { name: 'set_event_effect', description: 'Configure an event flash effect (timer, notification, reminder): its colour and animation style, and optionally enable it.', parameters: { type: 'OBJECT', properties: {
          effect: { type: 'STRING', description: 'One of: timer, notification, reminder' },
          color: { type: 'STRING', description: 'Colour name or #RRGGBB (e.g. "red", "rosso", "#00ff88")' },
          style: { type: 'STRING', description: 'Animation style: blink, pulse, or solid' },
          enabled: { type: 'BOOLEAN', description: 'Optional: enable/disable the effect' },
        }, required: ['effect'] } },
        { name: 'set_lighting_bridge', description: 'Turn the whole RGB lighting bridge on or off (master switch). When off, control returns to iCUE.', parameters: { type: 'OBJECT', properties: {
          enabled: { type: 'BOOLEAN', description: 'true to enable the bridge, false to disable' },
        }, required: ['enabled'] } },
        { name: 'show_sensor', description: 'Read a current sensor value to report to the user (e.g. CPU temperature).', parameters: { type: 'OBJECT', properties: {
          sensor: { type: 'STRING', description: 'Sensor to read: cpuTemp' },
        }, required: ['sensor'] } },
        { name: 'go_to_page', description: 'Navigate the dashboard to a page: "dashboard" (page 1) or "lighting" (page 2, RGB controls).', parameters: { type: 'OBJECT', properties: {
          page: { type: 'STRING', description: 'Page id: dashboard or lighting' },
        }, required: ['page'] } },
        { name: 'switch_deck_profile', description: 'Switch the Deck widget (a Stream Deck-style key grid) to one of its profiles. Use the EXACT profile name from the list of available deck profiles given in the system context. Only call this when the user asks to change/switch the deck profile.', parameters: { type: 'OBJECT', properties: {
          profile: { type: 'STRING', description: 'The exact name of the deck profile to activate' },
        }, required: ['profile'] } },
      ];

      // Validate and sanitise attachment parts sent by the client. Gemini accepts
      // images, PDFs and plain text inline; documents are sent as text/plain.
      const ALLOWED_ATTACH_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf', 'text/plain']);
      const rawImageParts = Array.isArray(aiBody.imageParts) ? aiBody.imageParts.slice(0, 4) : [];
      const safeImageParts = rawImageParts
        .filter(p => p && ALLOWED_ATTACH_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 8 * 1024 * 1024) }));

      // Validate and sanitise an optional audio clip sent by the client. When
      // present, Gemini transcribes AND answers the spoken request in this single
      // call — no separate speech-to-text round-trip needed.
      const ALLOWED_AUDIO_TYPES = new Set(['audio/wav', 'audio/webm', 'audio/ogg', 'audio/mp4']);
      const rawAudioParts = Array.isArray(aiBody.audioParts) ? aiBody.audioParts.slice(0, 1) : [];
      const safeAudioParts = rawAudioParts
        .filter(p => p && ALLOWED_AUDIO_TYPES.has(p.mimeType) && typeof p.data === 'string' && p.data.length > 0)
        .map(p => ({ mimeType: p.mimeType, data: p.data.slice(0, 12 * 1024 * 1024) }));
      const hasAudio = safeAudioParts.length > 0;

      // Inject images + audio into the last user message (current turn only — not stored in history)
      let currentMessages = messages.slice();
      const extraParts = [
        ...safeImageParts.map(p => ({ inlineData: p })),
        ...safeAudioParts.map(p => ({ inlineData: p })),
      ];
      if (extraParts.length > 0 && currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (last.role === 'user') {
          currentMessages[currentMessages.length - 1] = {
            role: 'user',
            parts: [...(last.parts || []), ...extraParts],
          };
        }
      }

      const _latestUserText = (() => {
        for (let i = currentMessages.length - 1; i >= 0; i--) {
          const msg = currentMessages[i];
          if (!msg || msg.role !== 'user' || !Array.isArray(msg.parts)) continue;
          return msg.parts.map(p => typeof p.text === 'string' ? p.text : '').join(' ').trim();
        }
        return '';
      })();
      const _latestLooksLikeClothingWeather = /\b(vestit|vesti|vestir|indoss|mettermi|mettere|temperatur|meteo|weather|temperature|wear|outfit|clothes|jacket|giacca|felpa|maglione|cappotto)\b/i.test(_latestUserText);
      const _latestExplicitlyWantsScreen = /\b(schermo|monitor|screenshot|display|desktop|finestra|immagine|foto|screen|look|see|read|guarda|vedi|leggi|analizza|mostrato|visualizzato)\b/i.test(_latestUserText);

      const _now = new Date();
      const _nowDate = _now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const _nowTime = _now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const _tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // Deck profiles live only in the browser; the client sends the current list
      // each turn. Surface their exact names so Xenon can switch by name reliably.
      const _deckProfiles = (Array.isArray(aiBody.deckProfiles) ? aiBody.deckProfiles : [])
        .map((p) => (p && typeof p === 'object') ? { name: String(p.name || '').slice(0, 40), active: !!p.active } : { name: String(p || '').slice(0, 40), active: false })
        .filter((p) => p.name)
        .slice(0, 24);
      const _deckProfilesText = _deckProfiles.length
        ? ` The Deck widget has these profiles (switch with switch_deck_profile using the EXACT name): ${_deckProfiles.map((p) => p.active ? `"${p.name}" (currently active)` : `"${p.name}"`).join(', ')}.`
        : '';
      // ── Opt-in advanced AI features ──────────────────────────────────
      // The client sends only the flags the user enabled in Settings → Funzioni
      // AI. Each flag unlocks its tools + prompt context for this turn only, so
      // disabled features cost zero extra tokens.
      const _features = (aiBody.features && typeof aiBody.features === 'object') ? aiBody.features : {};
      // STREAMING — OBS / Twitch / YouTube / Streamer.bot control. Exposed ONLY
      // when the matching integration is configured/connected (mirrors the deck
      // action-catalog gating), so non-streamers pay zero extra tokens. Every tool
      // routes through the same allowlisted deckRegistry that Deck keys use.
      let _streamingText = '';
      {
        const _s = (await readHubSettings().catch(() => null)) || {};
        const _tw = await streamTwitch.status().catch(() => ({ connected: false }));
        const _yt = await streamYouTube.status().catch(() => ({ connected: false }));
        const _enabled = [];
        if (_s.obsHost) {
          AI_FUNCTIONS.push({ name: 'obs_control', description: 'Control OBS Studio: start/stop/toggle recording or streaming, switch to a scene, or go to the next scene.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: start_recording, stop_recording, toggle_recording, start_streaming, stop_streaming, toggle_streaming, switch_scene, next_scene' },
            scene: { type: 'STRING', description: 'Scene name — required only for switch_scene' },
          }, required: ['action'] } });
          _enabled.push('OBS (recording, streaming, scene switching)');
        }
        if (_tw.connected) {
          AI_FUNCTIONS.push({ name: 'twitch_action', description: 'Control your Twitch channel: create a clip, set the stream title or game/category, send a chat message, drop a stream marker, shout out a channel, change chat mode, or run an ad.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'One of: create_clip, set_title, set_game, send_chat, marker, shoutout, chat_mode, run_ad' },
            value: { type: 'STRING', description: 'The parameter: new title (set_title), game/category (set_game), message (send_chat), marker note (marker), channel login (shoutout), chat mode emoteonly|followers|subscribers|slow|off (chat_mode), or ad length in seconds (run_ad). Omit for create_clip.' },
          }, required: ['action'] } });
          _enabled.push('Twitch (clip, title, game, chat, marker, shoutout, chat mode, ad)');
        }
        if (_yt.connected) {
          AI_FUNCTIONS.push({ name: 'youtube_broadcast', description: 'Start, stop, or toggle your YouTube live broadcast.', parameters: { type: 'OBJECT', properties: {
            mode: { type: 'STRING', description: 'One of: start, stop, toggle' },
          }, required: ['mode'] } });
          _enabled.push('YouTube (start/stop broadcast)');
        }
        if (_s.streamerbotHost) {
          AI_FUNCTIONS.push({ name: 'streamerbot_action', description: 'Trigger a Streamer.bot action by its exact name.', parameters: { type: 'OBJECT', properties: {
            action: { type: 'STRING', description: 'Exact Streamer.bot action name to run' },
          }, required: ['action'] } });
          _enabled.push('Streamer.bot (run actions)');
        }
        if (_enabled.length) {
          _streamingText = ' STREAMING CONTROL is available for: ' + _enabled.join('; ') + '.'
            + ' Use these tools when the user asks to control their stream (e.g. "start recording", "go live", "switch to my Gioco scene", "set the title to…", "clip that"). "Go live" on Twitch means start the OBS stream (obs_control start_streaming).'
            + ' If a tool returns an "unavailable"/"not_connected" error, tell the user that integration isn\'t connected and point them to Settings → Streaming.';
        }
      }
      // GENESIS — AI-composed dashboard pages. The page/widget map is client-
      // owned (like deck profiles), so the client sends a snapshot per turn.
      let _genesisText = '';
      if (_features.genesis === true) {
        const ds = (aiBody.dashboardState && typeof aiBody.dashboardState === 'object') ? aiBody.dashboardState : null;
        const _avail = (ds && Array.isArray(ds.availableWidgets) ? ds.availableWidgets : [])
          .filter(w => typeof w === 'string').slice(0, 32).map(w => w.slice(0, 24));
        const _pages = (ds && Array.isArray(ds.pages) ? ds.pages : [])
          .filter(p => p && typeof p === 'object').slice(0, 8)
          .map(p => ({
            name: String(p.name || '').slice(0, 40),
            widgets: (Array.isArray(p.widgets) ? p.widgets : []).slice(0, 32).map(w => String(w).slice(0, 24)),
          }));
        const _maxPages = (ds && Number.isFinite(ds.maxPages)) ? ds.maxPages : 8;
        AI_FUNCTIONS.push(
          { name: 'genesis_compose_page', description: 'GENESIS: create a NEW dashboard page with the given name and widgets, then switch to it. Call this ONLY once you know what the page is for — if the user just said "create a dashboard/page" with no purpose, ask first. Pick widgets ONLY from the available widget ids in the system context. Use "tabs" to group related widgets into tabbed tiles and "sizes" to make key tiles wider.', parameters: { type: 'OBJECT', properties: {
            name: { type: 'STRING', description: 'Short page name in the user\'s language, e.g. "Streaming"' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to place on the page (3-6 is ideal), from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (all also present in "widgets") to merge into a single tabbed tile. e.g. [["twitch","obs"]] puts Twitch and OBS as tabs in one tile. Use when widgets are related or when the user asks for tabs.' },
            sizes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { widget: { type: 'STRING' }, size: { type: 'STRING', description: 'small | medium | large | wide | full' } }, required: ['widget', 'size'] }, description: 'Optional: make specific tiles wider than the balanced default. Use "wide"/"full" for the page\'s primary tile (e.g. the main video/preview or chat).' },
          }, required: ['name', 'widgets'] } },
          { name: 'genesis_add_widgets', description: 'GENESIS: add widgets to an EXISTING dashboard page (referenced by its exact name from the current pages list), then switch to it. Use "tabs" to group widgets into tabbed tiles without disturbing the rest of the page.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the existing page' },
            widgets: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Widget ids to add, from the available list' },
            tabs: { type: 'ARRAY', items: { type: 'ARRAY', items: { type: 'STRING' } }, description: 'Optional: groups of 2+ widget ids (on this page) to merge into tabbed tiles.' },
          }, required: ['page', 'widgets'] } },
          { name: 'genesis_duplicate_widget', description: 'GENESIS: mirror/duplicate a single widget onto another dashboard page (by its exact name). Duplicable widgets (media, mic, tasks, notes, agenda, system, audio, timer, lighting) become a LIVE copy shown on both pages; use when the user wants the same widget available on more than one page.', parameters: { type: 'OBJECT', properties: {
            widget: { type: 'STRING', description: 'Widget id to duplicate, from the available list' },
            page: { type: 'STRING', description: 'Exact name of the destination page' },
          }, required: ['widget', 'page'] } },
          { name: 'genesis_remove_page', description: 'GENESIS: remove a dashboard page by its exact name. DESTRUCTIVE — always confirm with the user before calling.', parameters: { type: 'OBJECT', properties: {
            page: { type: 'STRING', description: 'Exact name of the page to remove' },
          }, required: ['page'] } },
          { name: 'genesis_setup_deck', description: 'GENESIS: populate the Deck (stream-deck) widget with a ready-to-use profile of keys. Call this in the SAME turn whenever you compose/extend a page that includes the "deck" widget, or when the user asks to configure the deck. Each key needs a short title in the user\'s language, one emoji icon, a theme-fitting accent hex color and an action from the allowed list.', parameters: { type: 'OBJECT', properties: {
            profile: { type: 'STRING', description: 'Short profile name in the user\'s language matching the theme, e.g. "Gaming"' },
            cols: { type: 'NUMBER', description: 'Grid columns (1-8), proportionate to the number of keys' },
            rows: { type: 'NUMBER', description: 'Grid rows (1-8); cols×rows should fit all keys' },
            keys: { type: 'ARRAY', description: 'The deck keys, most essential first (4-10 ideal)', items: { type: 'OBJECT', properties: {
              title: { type: 'STRING', description: 'Short key label in the user\'s language (max ~12 chars)' },
              icon: { type: 'STRING', description: 'A single emoji for the key, e.g. 🎙️' },
              color: { type: 'STRING', description: 'Accent hex color for the key, e.g. #ff3b30' },
              action: { type: 'STRING', description: 'One of: media_playpause, media_next, media_prev, play_sound, mic_toggle, volume_mute, volume_up, volume_down, app_mixer, app_volume_up, app_volume_down, app_mute, ai_voice, ai_chat, ai_prompt, lighting_color, open_app, open_file, open_store_app, open_url, hotkey, webhook, obs_record, obs_stream, obs_scene, obs_scene_next, twitch_clip, twitch_marker, twitch_ad, twitch_title, twitch_game, twitch_chat, twitch_shoutout, twitch_chatmode, yt_broadcast, sb_action, remote_disconnect, remote_block, remote_screen_cycle' },
              value: { type: 'STRING', description: 'Action parameter when needed: prompt text for ai_prompt; hex color for lighting_color; URL for open_url/webhook; app path for open_app/open_file; key combo for hotkey (e.g. "ctrl+shift+m"); scene name for obs_scene; app name for app_volume_up/down and app_mute; new title/game/message/login for twitch_title/twitch_game/twitch_chat/twitch_shoutout. Omit otherwise.' },
              ledColor: { type: 'STRING', description: 'Optional hex color: flashes the RGB lighting when the key fires. Use on the most important keys.' },
            }, required: ['title', 'icon', 'action'] } },
          }, required: ['profile', 'keys'] } },
        );
        _genesisText = ` GENESIS (dashboard composer) is ENABLED. Available widget ids: ${_avail.join(', ') || 'unknown'}.` +
          ` Current pages: ${_pages.map(p => `"${p.name}" [${p.widgets.join(', ') || 'empty'}]`).join('; ') || 'none'} (max ${_maxPages} pages).` +
          ' When the request names a clear activity or theme (e.g. "build me a streaming page"), pick the most relevant widgets (3-6) and call genesis_compose_page with a short fitting name — no need to ask which widgets.' +
          ' When the request is GENERIC ("create a new dashboard/page" with no purpose), do NOT compose yet: first ask, in the user\'s language, one short question about what the page is for, suggesting 2-3 concrete examples (e.g. gaming, work/focus, music, streaming). If useful, follow up with at most ONE more question about what they want to see on it, then compose. Never ask more than two questions before composing.' +
          ' RICH LAYOUT — compose thoughtfully, not just a flat row of tiles:' +
          '  • TABS: pass "tabs" to genesis_compose_page/genesis_add_widgets to merge related widgets into a single tabbed tile. ALWAYS honour an explicit request for tabs, AND use tabs on your own when two or more widgets are closely related or the page would otherwise be crowded — e.g. group [obs, twitch] or [obs, twitch, youtube] on a streaming page, [tasks, agenda, notes] on a work page, [media, audio, mic] for sound. Never group a widget the user wants prominent on its own.' +
          '  • SIZES: pass "sizes" to make the page\'s primary tile wider ("wide" or "full") — e.g. the OBS/preview tile on a streaming page, the media tile on a music page — so the layout has a clear focal point.' +
          '  • DUPLICATE: call genesis_duplicate_widget to mirror a widget (media, mic, tasks, notes, agenda, system, audio, timer, lighting) onto another page when the user wants it available in more than one place (e.g. "keep the player on every page").' +
          ' DECK: the "deck" widget is a programmable stream-deck key grid — NEVER leave it empty. Whenever a page you compose or extend includes "deck" (or the user asks to set up the deck), ALSO call genesis_setup_deck in the same turn: pick the most essential keys for the theme (4-10) — e.g. for gaming: mic toggle, app mixer, play/pause, lighting color, OBS record; for streaming: OBS stream/record/scene, mic toggle, mixer — each with a short title in the user\'s language, one fitting emoji, an accent hex color matching the theme, and add ledColor on the most important keys so the RGB lighting reacts on press. Choose cols×rows proportionate to the key count (4 keys → 2x2, 6 → 3x2, 8 → 4x2).' +
          ' After all genesis calls, ALWAYS recap briefly in the user\'s language what you created: the page, its widgets, and each deck key with its function.' +
          ' Confirm before genesis_remove_page.';
      }
      // GUARDIAN — long-term hardware health. Exposes a single read-only tool
      // that returns the locally-computed digest (no extra API calls).
      let _guardianText = '';
      if (_features.guardian === true) {
        AI_FUNCTIONS.push({
          name: 'guardian_report',
          description: 'GUARDIAN: get the hardware-health digest — CPU/GPU load and temperature plus RAM usage aggregated over the last 24h / 7 days / 30 days, with 7d-vs-30d trend deltas. Call BEFORE answering any question about PC health, temperatures over time, thermal trends, or "is my PC ok".',
          parameters: { type: 'OBJECT', properties: {} },
        });
        _guardianText = ' GUARDIAN (hardware health history) is ENABLED: when the user asks about PC health, temperatures, or long-term trends, call guardian_report and base your analysis ONLY on its real data — mention notable maxima and 7d-vs-30d trends, suggest practical fixes (dust, fan curve, background apps) only when the data justifies them, and say so plainly when everything looks healthy. If collectedDays is low, note that the history is still short.';
      }
      const SYS_BASE = `Current date and time: ${_nowDate}, ${_nowTime} (${_tz}). ` +
        'You are Xenon, a capable, helpful AI assistant embedded in Xenon — a real-time dashboard for the CORSAIR Xeneon Edge 14.5" display.' +
        ' Answer ANY question the user asks, drawing on your broad general knowledge (technology, science, history, everyday topics, etc.).' +
        ' For anything recent, live, or that you are not certain about (news, prices, sports results, weather elsewhere, release dates, "what is X today"…), call web_search instead of guessing — then answer using the results.' +
        ' YOU CAN DIRECTLY CONTROL THE WHOLE DASHBOARD — this is a core part of your job, not an afterthought. Whenever the user asks for something a tool covers, DO IT with the tool instead of only describing it. Your controls, by area:' +
        '  • Audio & mic: mute/unmute the mic, set mic volume, set speaker volume, mute the speaker, and turn a single app up/down or mute it (per-app mixer).' +
        '  • Media: play/pause, next, previous track.' +
        '  • Productivity: read/replace notes; list/create/complete/delete tasks (and clear all); list/create/delete calendar events (and clear all); start/list/delete countdown timers.' +
        '  • RGB lighting: set a manual colour, clear it, enable/disable reactive effects, configure event-flash effects, and turn the whole lighting bridge on/off.' +
        '  • System & apps: read live CPU/GPU/RAM/disk stats and individual sensors (e.g. CPU temp), open or close any app/website/file on Windows, lock the PC, and turn Performance Mode on/off.' +
        '  • Dashboard UI: change the colour theme, navigate between dashboard pages, switch the Deck to one of its profiles, and open the weather / settings / app-switcher panels or the focus lock screen.' +
        '  • Screen vision: capture and analyse any monitor.' +
        ' Feature-gated extras appear as extra tools ONLY when the user enabled them: composing/editing dashboard pages (Genesis — pages, tabbed tiles, widget duplication, Deck setup), controlling OBS/Twitch/YouTube/Streamer.bot (Streaming), and reading long-term hardware-health history (Guardian). When such a tool is present, prefer it over a generic answer. When the user asks for something you genuinely have no tool for, say so plainly rather than pretending you did it.' +
        ' SCREEN VISION SAFETY: call capture_screen ONLY when the latest user message explicitly asks you to inspect/read/look at the screen, monitor, screenshot, image, window, or visible UI. Do not ask which monitor unless the user actually requested screen vision. For weather, temperature, clothing, outfit, or "what should I wear" questions, use get_weather and answer directly; never route those to capture_screen, even if speech-to-text produced a short/garbled phrase such as "che vesti".' +

        // ── Conversational data collection ──────────────────────────────────
        ' CONVERSATIONAL BEHAVIOUR — follow these rules every time:' +
        ' (1) COLLECT BEFORE ACTING: when the user asks you to do something but has not provided the information you need to call the function, ask for it conversationally — one concise question at a time — and wait for the answer. Do NOT call the function with invented, empty, or guessed required fields.' +
        '     Examples: "aggiungimi un task" → ask what the task is; "metti un timer" → ask for how long; "crea un evento" → ask title then date/time; "scrivi nelle note" → ask what to write; "cambia tema" → ask which (xenon/ocean/ember/violet/mono).' +
        ' (2) IDENTIFY BEFORE DELETE/COMPLETE: when the user says "elimina il task", "segna come fatto il timer", etc. without specifying which one, call list_tasks/list_timers/list_calendar_events first and then ask the user to confirm which item.' +
        ' (3) CONFIRM DESTRUCTIVE ACTIONS: before running clear_all_tasks, clear_all_calendar_events, write_notes (overwrite), delete_calendar_event, or any bulk delete, briefly state what you are about to do ("Sto per cancellare tutti i task, procedo?") and wait for confirmation. Exception: if the user\'s message already makes the intent unambiguous and explicit ("sì cancella tutto", "svuota tutto"), proceed directly.' +
        ' (4) COLLECT KEY OPTIONAL FIELDS TOO — after required fields, also ask for these specific optional ones before calling the function:' +
        '   • create_task → after the task text, ask for priority (alta / media / bassa).' +
        '   • start_timer → after the duration, ask for a label (e.g. "Come lo chiamo?" — skip if user seems in a hurry or already answered).' +
        '   • create_calendar_event → collect in this exact order before calling the function: (a) title if missing, (b) date if missing, (c) time if missing — ask as one short question e.g. "A che ora?" — do NOT skip this, do NOT default to 00:00, (d) then ask once about a reminder ("Vuoi un promemoria? Se sì, quando?"). Call create_calendar_event EXACTLY ONCE with all collected fields — never call it before the reminder question, never call it twice.' +
        '   For all other optional fields (recurrence, notes on events, etc.) use sensible defaults and do NOT ask unless the user explicitly mentions them.' +
        '   Exception: if the request already contains everything ("crea evento riunione domani alle 15"), call immediately — no further questions.' +
        ' (5) VOLUME WITHOUT A NUMBER: if the user says "alza", "abbassa", "aumenta", "diminuisci" volume/microfono without a number, infer a reasonable delta (±20 from the current value or a sensible target like 80 for "alza" and 40 for "abbassa") and act without asking.' +
        ' (6) ACT ONLY ON THE CURRENT REQUEST: earlier turns in this conversation may show actions you already completed (e.g. a task you added). NEVER repeat or re-execute a past action unless the user explicitly asks again in their latest message. Each new user message is a fresh request — respond to THAT, do not carry over or replay a previous command.' +

        // ── Other rules ─────────────────────────────────────────────────────
        ' TOOL CALLS: invoke functions ONLY through the native function-calling mechanism. NEVER write a tool call as plain text (e.g. "[call:...]", "default_api.…", code blocks) — anything you write as text is shown and spoken to the user verbatim.' +
        ' Always reply in the same language as the user.' +
        ' IMPORTANT — speech-to-text artefacts: the STT engine may occasionally merge consecutive words when the user mixes Italian with English proper nouns. If you receive something like "apristim", "aprispot", "apridiscord", or similar phonetic mashups, interpret them as the most likely Italian command plus the English app name (e.g. "apristim" → open Steam, "aprispot" → open Spotify). Always prefer a command interpretation over treating the input as gibberish.' +
        _deckProfilesText +
        _streamingText +
        _genesisText +
        _guardianText;
      // Voice turns are spoken aloud, so keep them short and conversational: this
      // also makes both the reply generation and the text-to-speech noticeably faster.
      const SYS_VOICE = ' This is a VOICE conversation — your reply will be spoken aloud. Keep it SHORT and natural, like a spoken answer: 1-2 sentences, no markdown, no lists, no headings. Get straight to the point as if talking to a person.' +
        ' When you need to ask the user a clarifying question (data collection), ask only ONE question per turn and keep it to a single short spoken sentence — the microphone will reopen automatically after your reply so the user can answer immediately.' +
        ' If the user only says a dismissal ("stop", "basta", "ferma", "esci", "lascia stare", "grazie" with nothing else), reply with a single short word like "Ok" and call close_ai_panel.';
      const SYS_AUDIO = ' The user\'s request is provided as an audio clip — transcribe it yourself and act on it. Ignore any bracketed placeholder like "[richiesta vocale]" — it is just an internal label, not something the user said. If a short text snippet also accompanies the audio, it is the BEGINNING of the same spoken sentence (captured a moment earlier) and the audio continues it — treat them as one continuous request and combine them.';
      const SYS_TEXT = ' Be concise but complete; replies may be read aloud.';
      // Strong language lock — placed LAST so it overrides any tendency to drift to
      // English (which happens most when the turn carries an image or audio).
      const SYS_LANG = langName
        ? ` CRITICAL: the user's language is ${langName}. You MUST always reply in ${langName} — including when you describe a screenshot, an image, or anything you "see" — unless the user explicitly writes their latest message in a different language. Never switch to English on your own.`
        : '';
      const callGemini = (msgs) => new Promise((resolve, reject) => {
        const payload = JSON.stringify({
          system_instruction: { parts: [{ text: SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + (hasAudio ? SYS_AUDIO : '') + SYS_LANG }] },
          tools: [{ functionDeclarations: AI_FUNCTIONS }],
          contents: msgs,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024, candidateCount: 1, thinkingConfig: { thinkingBudget: 0 } },
        });
        const aiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'Xenon/2.0' },
        }, (aiRes) => {
          let data = '';
          aiRes.on('data', chunk => { data += chunk; });
          aiRes.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.error) reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              else resolve(parsed);
            } catch (parseErr) { reject(parseErr); }
          });
        });
        aiReq.on('error', reject);
        aiReq.setTimeout(20000, () => { aiReq.destroy(); reject(new Error('Gemini request timed out')); });
        aiReq.write(payload);
        aiReq.end();
      });

      const _AI_FN_NAMES = new Set(AI_FUNCTIONS.map(f => f.name));
      const getCandidate = (r) => {
        let content = r.candidates && r.candidates[0] && r.candidates[0].content;
        const parts = (content && content.parts) || [];
        // Gemini 3 can prepend "thought" parts even with thinking disabled; the
        // functionCall / real answer may sit in any later part. Reading only
        // parts[0] used to skip tool calls and leak thought text to the chat.
        let part = parts.find(p => p.functionCall) || parts.find(p => p.text && !p.thought) || parts[0];
        // Fallback: the model sometimes writes the tool call as plain text
        // ("[call:default_api:fn{…}]"). Recover it as a real functionCall and
        // rewrite the history turn so the functionResponse stays well-formed.
        if (part && !part.functionCall) {
          const visText = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
          const leaked = _parseLeakedToolCall(visText, _AI_FN_NAMES);
          if (leaked) {
            part = { functionCall: { name: leaked.name, args: leaked.args } };
            content = { role: 'model', parts: [part] };
          }
        }
        return { content, part };
      };

      // currentMessages already built above (with optional imageParts injected)
      const clientActions = [];

      if (provider === 'ollama') {
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(aiBody.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(ollModel, settings && settings.hardwareScan);
        // Smaller local models tend to parrot tool output verbatim, so reinforce
        // the language lock: web_search snippets often come back in English and
        // must be translated into the user's language before answering.
        const SYS_LOCAL = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_LOCAL;
        try {
          const result = await aiLocal.localChat({
            baseUrl, model: concreteModel, geminiTools: AI_FUNCTIONS,
            history: currentMessages, systemText,
            executeTool: (fnName, fnArgs) => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              provider: 'ollama',
            }).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions })),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: result.newContent });
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      let geminiResult = await callGemini(currentMessages);
      let { content, part } = getCandidate(geminiResult);

      // Function calling loop — up to 3 server-side iterations
      let pendingScreenImage = null; // base64 JPEG to feed Gemini after capture_screen
      for (let iter = 0; iter < 3 && part && part.functionCall; iter++) {
        const fnName = part.functionCall.name;
        const fnArgs = part.functionCall.args || {};
        currentMessages = [...currentMessages, content];

        const { fnResult, clientActions: fnClientActions, pendingScreenImage: fnScreen } =
          await executeAiTool(fnName, fnArgs, {
            apiKey,
            uiLang: _uiLang2,
            latestUserText: _latestUserText,
            latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
            latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
          });
        for (const a of fnClientActions) clientActions.push(a);
        if (fnScreen) pendingScreenImage = fnScreen;

        currentMessages = [...currentMessages, {
          role: 'user',
          parts: [{ functionResponse: { name: fnName, response: { output: JSON.stringify(fnResult) } } }],
        }];

        // Feed the captured screenshot to Gemini so it can actually see the screen.
        if (pendingScreenImage) {
          currentMessages.push({
            role: 'user',
            parts: [
              { text: 'Here is the current screenshot of the requested monitor.' },
              { inlineData: { mimeType: 'image/jpeg', data: pendingScreenImage } },
            ],
          });
          pendingScreenImage = null;
        }

        geminiResult = await callGemini(currentMessages);
        ({ content, part } = getCandidate(geminiResult));
      }

      const text = ((content && content.parts) || [])
        .filter(p => p.text && !p.thought)
        .map(p => p.text).join('')
        // Never show/speak a leaked text tool call (it was either executed via
        // the fallback above or is plain noise).
        .replace(new RegExp(LEAKED_CALL_RE.source, 'g'), '')
        .trim();
      json({ text, clientActions, newContent: content });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/log' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, 4 * 1024);
      const { msg } = JSON.parse(body.toString('utf8') || '{}');
      if (typeof msg === 'string') process.stdout.write('[CLIENT] ' + msg + '\n');
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/screens' && req.method === 'GET') {
    try {
      const psScript = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { "$($_.Bounds.X)|$($_.Bounds.Y)|$($_.Bounds.Width)|$($_.Bounds.Height)|$($_.Primary)|$($_.DeviceName)" }';
      const stdout = await new Promise((resolve, reject) =>
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript],
          { maxBuffer: 64 * 1024, windowsHide: true },
          (err, out) => err ? reject(err) : resolve(out)
        )
      );
      const screens = stdout.trim().split(/\r?\n/).filter(Boolean).map((line, i) => {
        const [x, y, w, h, primary, dev] = line.trim().split('|');
        const label = (dev || '').replace(/^\\\\.\\/, '').trim() || `DISPLAY${i + 1}`;
        return { index: i, x: parseInt(x) || 0, y: parseInt(y) || 0, width: parseInt(w) || 1920, height: parseInt(h) || 1080, primary: primary === 'True', name: label };
      });
      json({ screens });
    } catch {
      json({ screens: [{ index: 0, x: 0, y: 0, width: 1920, height: 1080, primary: true, name: 'DISPLAY1' }] });
    }

  } else if (reqPath === '/api/screenshot' && req.method === 'GET') {
    const tmpPath = path.join(os.tmpdir(), `xenon_ss_${Date.now()}.jpg`);
    try {
      const ffmpeg = getFfmpegPath();
      const px = urlObj.searchParams.get('x');
      const py = urlObj.searchParams.get('y');
      const pw = urlObj.searchParams.get('w');
      const ph = urlObj.searchParams.get('h');
      const ffmpegArgs = ['-y', '-f', 'gdigrab', '-framerate', '1'];
      if (px !== null && py !== null && pw !== null && ph !== null) {
        const w = parseInt(pw), h = parseInt(ph);
        if (w > 0 && h > 0) {
          ffmpegArgs.push('-offset_x', px, '-offset_y', py, '-video_size', `${w}x${h}`);
        }
      }
      // gdigrab -vframes 1 takes a single screenshot frame
      ffmpegArgs.push('-i', 'desktop', '-vframes', '1', '-q:v', '3', '-vf', 'scale=\'min(1920,iw)\':-2', tmpPath);
      await execFilePromise(ffmpeg, ffmpegArgs, { timeout: 15000 });
      const imgBuffer = await fs.promises.readFile(tmpPath);
      const base64 = imgBuffer.toString('base64');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ base64, mimeType: 'image/jpeg' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

  } else if (reqPath === '/api/stt/start' && req.method === 'POST') {
    try {
      await readBody(req);
      await Promise.race([
        _sttDeviceWhenReady(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('STT device timeout')), 10000)),
      ]);
      if (!_sttUseWasapi && !_sttDshowDevice) throw new Error('No audio device available for recording');
      // Prevent two concurrent STT sessions (e.g. two browser tabs receiving the same wake event)
      if (_sttPending.size > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'already_recording' })); return;
      }
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const wavPath = path.join(os.tmpdir(), `xenon-stt-${id}.wav`);

      let resolveRecording, resolveSaved;
      const recordingStarted = new Promise(r => { resolveRecording = r; });
      const recordingSaved   = new Promise(r => { resolveSaved   = r; });

      const ffmpeg = getFfmpegPath();
      const inputArgs = _sttUseWasapi
        ? ['-f', 'wasapi', '-i', 'default']
        : ['-f', 'dshow', '-i', `audio=${_sttDshowDevice}`];
      const silenceDb = _sttSilenceDb();
      const gain = _sttGain();
      // silencedetect runs on the RAW signal (so end-of-speech is judged before
      // the boost lifts the noise floor); volume then boosts the saved WAV so
      // the transcription clip is audible for a quiet hands-free mic.
      const ffmpegProc = spawn(ffmpeg, [
        '-hide_banner', '-loglevel', 'info',
        ...inputArgs,
        '-af', `silencedetect=noise=${silenceDb.toFixed(1)}dB:d=0.55,volume=${gain}`,
        '-ar', '16000', '-ac', '1', '-acodec', 'pcm_s16le',
        '-y', wavPath,
      ], { windowsHide: true });

      ffmpegProc.stdin.setDefaultEncoding('utf8');
      ffmpegProc.stderr.setEncoding('utf8');

      let stderrAccum = '';
      let didStart = false;
      let silenceNotified = false;
      let sawSpeech = false;
      let _silenceDebounce = null; // fires stt_silence after a short wait when no speech yet
      ffmpegProc.stderr.on('data', d => {
        stderrAccum += d;
        if (!didStart && /Press \[q\] to stop/i.test(stderrAccum)) {
          didStart = true;
          resolveRecording();
        }
        // End-of-speech detection: stop the recorder as soon as the user goes quiet.
        // • silence_end  → audio resumed; the user is actively speaking (sawSpeech).
        // • silence_start → user paused. We ALWAYS wait a bit before deciding end-of-
        //   speech, otherwise a natural mid-sentence pause (e.g. between words or a
        //   breath) would cut the user off. silence_end during the wait cancels it.
        if (!silenceNotified) {
          if (/silence_end:/.test(d)) {
            sawSpeech = true;
            if (_silenceDebounce) { clearTimeout(_silenceDebounce); _silenceDebounce = null; }
          }
          if (/silence_start:/.test(d) && !_silenceDebounce) {
            const startMatch = d.match(/silence_start:\s*([\d.]+)/);
            const silenceStartAt = startMatch ? Number(startMatch[1]) : 0;
            if (Number.isFinite(silenceStartAt) && silenceStartAt > 0.35) sawSpeech = true;
            // Long grace after real speech: people pause mid-sentence to think,
            // and we MUST NOT cut them off. Short grace when no speech happened
            // yet (the user is just slow to start, no need to wait as long).
            const grace = sawSpeech ? STT_AFTER_SPEECH_SILENCE_GRACE_MS : STT_START_SILENCE_GRACE_MS;
            _silenceDebounce = setTimeout(() => {
              if (!silenceNotified) { silenceNotified = true; broadcastSSE('stt_silence', { id }); }
            }, grace);
          }
        }
      });
      ffmpegProc.on('exit', () => resolveSaved());
      ffmpegProc.on('error', e => {
        process.stdout.write('[STT] ffmpeg error: ' + e.message + '\n');
        if (!didStart) { didStart = true; resolveRecording(); }
        resolveSaved();
      });

      _sttPending.set(id, { ffmpegProc, wavPath, recordingStarted, resolveRecording, recordingSaved, resolveSaved, silenceDb, startedAt: Date.now() });

      await Promise.race([
        recordingStarted,
        new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg did not start recording')), 6000)),
      ]);
      process.stdout.write(`[STT] Recording id=${id} via=${_sttUseWasapi ? 'wasapi' : 'dshow'} silence=${silenceDb.toFixed(1)}dB gain=${gain}x\n`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/stt/stop' && req.method === 'POST') {
    try {
      const stopBody = JSON.parse(await readBody(req) || '{}');
      const id = String(stopBody.id || '').trim();
      const apiKey = String(stopBody.key || '').trim().slice(0, 200);
      const sttLang = String(stopBody.lang || 'en').toLowerCase().slice(0, 2);
      const sttProvider = aiLocal.sanitizeProvider(stopBody.provider);
      // mode 'audio' → return the raw recording so the caller can send it straight
      // to the chat model (transcribe + answer in one call). Default → transcribe here.
      // mode 'test'  → mic self-test: report the device/level we captured and whether
      // it passed the speech gate, with no transcription and no API key needed.
      const audioMode = stopBody.mode === 'audio';
      const testMode  = stopBody.mode === 'test';
      const rec = _sttPending.get(id);
      if (!rec) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' })); return;
      }
      // Stop ffmpeg gracefully — send 'q' then close stdin (EOF)
      try { rec.ffmpegProc.stdin.write('q'); rec.ffmpegProc.stdin.end(); } catch {}
      await Promise.race([rec.recordingSaved, new Promise(r => setTimeout(r, 6000))]);
      _sttPending.delete(id);
      let wavData = null;
      try { wavData = await fs.promises.readFile(rec.wavPath); } catch {}
      fs.promises.unlink(rec.wavPath).catch(() => {});
      // Whole-clip RMS — used both for logging and as a speech gate below.
      let clipStats = { rms: 0, peak: 0 };
      if (wavData && wavData.length > 44) {
        clipStats = _pcmRmsStats(wavData.slice(44), 16000, 80);
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData.length} rms=${clipStats.rms.toFixed(1)} peak=${clipStats.peak.toFixed(1)}\n`);
      } else {
        process.stdout.write(`[STT] Stopped id=${id} wavSize=${wavData ? wavData.length : 0}\n`);
      }
      // Mic self-test: surface exactly which device was captured and how loud it
      // was, so a user (or a bug report screenshot) can tell whether the voice
      // capture path actually hears them — independent of the browser mic meter,
      // which reads a different device than this server-side recorder.
      if (testMode) {
        const heard = !!(wavData && wavData.length > 44 && clipStats.rms > 0 && _sttLooksLikeSpeech(clipStats));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          test: true,
          heard,
          via: _sttUseWasapi ? 'wasapi' : 'dshow',
          device: _sttUseWasapi ? (cachedMicLabel || 'Default (WASAPI)') : (_sttDshowDevice || 'unknown'),
          db: Math.round(_dbFromRms(clipStats.rms)),
          gain: _sttGain(),
        })); return;
      }
      if (!wavData || wavData.length < 100) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioMode ? { audio: '', silent: true } : { text: '' })); return;
      }
      if (clipStats.rms > 0 && !_sttLooksLikeSpeech(clipStats)) {
        process.stdout.write(`[STT] Below speech floor (rms=${clipStats.rms.toFixed(1)}, peak=${clipStats.peak.toFixed(1)}) → empty\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(audioMode ? { audio: '', silent: true } : { text: '' })); return;
      }
      if (audioMode) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ audio: wavData.toString('base64'), mimeType: 'audio/wav' })); return;
      }
      let sttText;
      if (sttProvider === 'ollama') {
        process.stdout.write(`[STT] Local whisper transcribe lang=${sttLang}\n`);
        try {
          sttText = await aiLocal.localStt(wavData, sttLang, __dirname);
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '', error: e.message })); return;
        }
      } else {
        if (!apiKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_key' })); return;
        }
        process.stdout.write(`[STT] Transcribing lang=${sttLang}\n`);
        sttText = await _transcribeAudio(wavData.toString('base64'), 'audio/wav', apiKey, sttLang);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: sttText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/transcribe' && req.method === 'POST') {
    try {
      const tRaw = await readBodyBuffer(req, 30 * 1024 * 1024);
      const tBody = JSON.parse(tRaw.toString('utf8') || '{}');
      const apiKey = String(tBody.key || '').trim().slice(0, 200);
      const tProvider = aiLocal.sanitizeProvider(tBody.provider);
      const audioB64 = typeof tBody.audio === 'string' ? tBody.audio.slice(0, 20 * 1024 * 1024) : '';
      const rawMime = typeof tBody.mimeType === 'string' ? tBody.mimeType : 'audio/webm';
      const ALLOWED_AUDIO = new Set(['audio/webm', 'audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/wav']);
      const safeMime = ALLOWED_AUDIO.has(rawMime) ? rawMime : 'audio/webm';
      const safeLang = String(tBody.lang || 'auto').toLowerCase().slice(0, 5).replace(/[^a-z-]/g, '') || 'auto';

      // Local provider: decode → transcode to 16kHz mono WAV via ffmpeg → whisper.cpp.
      // No Gemini key required. Errors degrade gracefully (HTTP 200, empty text).
      if (tProvider === 'ollama') {
        if (!audioB64) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_params' })); return;
        }
        try {
          const inBuf = Buffer.from(audioB64, 'base64');
          const ffmpeg = getFfmpegPath();
          const wavBuffer = await new Promise((resolve, reject) => {
            const ff = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'wav', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', 'pipe:1'], { windowsHide: true });
            const out = [];
            const errBuf = [];
            ff.stdout.on('data', c => out.push(c));
            ff.stderr.on('data', c => errBuf.push(c));
            ff.on('error', reject);
            ff.on('close', code => {
              if (code === 0 && out.length) resolve(Buffer.concat(out));
              else reject(new Error('ffmpeg wav transcode failed: ' + Buffer.concat(errBuf).toString().slice(0, 200)));
            });
            ff.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
            ff.stdin.write(inBuf);
            ff.stdin.end();
          });
          const text = await aiLocal.localStt(wavBuffer, safeLang, __dirname);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text })); return;
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: '', error: e.message })); return;
        }
      }

      if (!apiKey || !audioB64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const tPayload = JSON.stringify({
        contents: [{ parts: [
          { text: 'Transcribe this audio exactly as spoken. Output only the transcribed text, nothing else — no explanations, no punctuation beyond what was said. The user may mix Italian commands with English proper nouns (app names, brand names): always output them as separate words with a space between them (e.g. "apri Steam", not "apristim"; "apri Spotify", not "aprispot"; "apri Discord", not "apridiscord"). The recording may begin with a short notification chime or activation tone — ignore it completely and transcribe only human speech that follows. If the audio contains only silence, background noise, breathing, chimes, or music with no clear human speech, output exactly an empty string. Do NOT guess, invent, or output placeholder text.' },
          { inline_data: { mime_type: safeMime, data: audioB64 } },
        ] }],
        generationConfig: { temperature: 0, maxOutputTokens: 256, candidateCount: 1 },
      });
      const tText = await new Promise((resolve, reject) => {
        const geminiReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(tPayload), 'User-Agent': 'Xenon/2.0' },
        }, (gRes) => {
          let d = '';
          gRes.on('data', c => { d += c; });
          gRes.on('end', () => {
            try {
              const parsed = JSON.parse(d);
              resolve(((parsed?.candidates?.[0]?.content?.parts) || []).filter(p => p.text && !p.thought).map(p => p.text).join('').trim() || '');
            } catch { reject(new Error('invalid JSON')); }
          });
        });
        geminiReq.on('error', reject);
        geminiReq.setTimeout(15000, () => { geminiReq.destroy(); reject(new Error('timeout')); });
        geminiReq.write(tPayload);
        geminiReq.end();
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text: tText }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/tts' && req.method === 'POST') {
    try {
      const ttsRaw = await readBodyBuffer(req, 64 * 1024);
      const ttsBody = JSON.parse(ttsRaw.toString('utf8') || '{}');
      const apiKey = String(ttsBody.key || '').trim().slice(0, 200);
      const rawText = String(ttsBody.text || '').trim().slice(0, 1000);
      // Default to a male Gemini voice; the client may override via `voice`.
      const voice = String(ttsBody.voice || 'Charon').replace(/[^A-Za-z]/g, '').slice(0, 30) || 'Charon';
      if (!apiKey || !rawText) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_params' })); return;
      }
      const ttsPayload = JSON.stringify({
        contents: [{ parts: [{ text: rawText }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      process.stdout.write(`[TTS] request voice=${voice} chars=${rawText.length}\n`);
      const _ttsStart = Date.now();
      const inlineData = await new Promise((resolve, reject) => {
        const ttsReq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: `/v1beta/models/gemini-3.1-flash-tts-preview:generateContent?key=${encodeURIComponent(apiKey)}`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(ttsPayload), 'User-Agent': 'Xenon/2.0' },
        }, (ttsRes) => {
          let d = '';
          ttsRes.on('data', c => { d += c; });
          ttsRes.on('end', () => {
            process.stdout.write(`[TTS] Gemini HTTP ${ttsRes.statusCode} in ${Date.now() - _ttsStart}ms\n`);
            try {
              const parsed = JSON.parse(d);
              if (parsed.error) {
                process.stdout.write(`[TTS] Gemini error: ${parsed.error.message || JSON.stringify(parsed.error).slice(0, 160)}\n`);
                return reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
              }
              const part = parsed?.candidates?.[0]?.content?.parts?.[0]?.inlineData;
              if (!part || !part.data) return reject(new Error('no audio data in TTS response'));
              resolve(part);
            } catch (e) { reject(e); }
          });
        });
        ttsReq.on('error', reject);
        ttsReq.setTimeout(60000, () => { ttsReq.destroy(); reject(new Error('TTS timeout')); });
        ttsReq.write(ttsPayload);
        ttsReq.end();
      });
      const pcmBytes = Buffer.from(inlineData.data, 'base64');
      const rateMatch = String(inlineData.mimeType || '').match(/rate=(\d+)/);
      const sampleRate = rateMatch ? parseInt(rateMatch[1]) : 24000;
      const wavBuf = pcmToWav(pcmBytes, sampleRate);
      process.stdout.write(`[TTS] OK wav=${wavBuf.length} bytes rate=${sampleRate}\n`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wavBuf.length), 'Cache-Control': 'no-store' });
      res.end(wavBuf);
    } catch (e) {
      process.stdout.write(`[TTS] FAIL ${e.message}\n`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak' && req.method === 'POST') {
    // Server-side voice output (Windows SAPI) — instant and focus-independent.
    // Resolves when speech finishes so the client knows when to re-open listening.
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const text = String(b.text || '').slice(0, 2000);
      const langp = String(b.lang || 'en').slice(0, 5);
      const key = String(b.key || '').trim().slice(0, 200);
      if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing_text' })); return; }
      const speakProvider = aiLocal.sanitizeProvider(b.provider);
      await speakOnServer(text, langp, key, speakProvider);
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/speak/stop' && req.method === 'POST') {
    try { await readBody(req); } catch {}
    stopServerSpeak();
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/ai-local/scan' && req.method === 'GET') {
    try {
      const scan = await aiLocal.scanHardware();
      // Persist into settings so the client and resolveModel can use it.
      const current = await readHubSettings().catch(() => null);
      if (current) { current.hardwareScan = scan; await writeHubSettings(current).catch(() => {}); }
      json({ scan });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/status' && req.method === 'GET') {
    try {
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const status = await aiLocal.localStatus(baseUrl, __dirname);
      json({ status });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/models' && req.method === 'GET') {
    try {
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const models = await aiLocal.listOllamaModels(baseUrl);
      json({ models });
    } catch {
      // Graceful: an empty list keeps the UI usable even if Ollama is offline.
      json({ models: [] });
    }

  } else if (reqPath === '/api/ai-local/pull' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const model = aiLocal.sanitizeModel(body.model);
      const settings = await readHubSettings().catch(() => null);
      // Resolve 'auto' exactly as the chat path does (resolveModel + hardwareScan)
      // so the model we pull is the same one the chat will request — otherwise
      // 'auto' could download qwen2.5:3b while chat asks for qwen2.5:7b → 404.
      const concrete = aiLocal.resolveModel(model, settings && settings.hardwareScan);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      await aiLocal.pullModel(baseUrl, concrete, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }

  } else if (reqPath === '/api/ai-local/ollama-start' && req.method === 'POST') {
    try {
      await readBody(req);
      const settings = await readHubSettings().catch(() => null);
      const baseUrl = aiLocal.sanitizeOllamaUrl(settings && settings.ollamaUrl);
      const result = await aiLocal.startOllama(baseUrl);
      json(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/ollama-autostart' && req.method === 'GET') {
    try {
      const enabled = await aiLocal.getOllamaAutostart();
      json({ enabled });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/ollama-autostart' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await aiLocal.setOllamaAutostart(body.enabled === true);
      json(result);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/api/ai-local/whisper-install' && req.method === 'POST') {
    try {
      await readBody(req);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      await aiLocal.installWhisper(__dirname, (p) => {
        res.write(`data: ${JSON.stringify(p)}\n\n`);
      });
      res.write(`data: ${JSON.stringify({ status: 'success', done: true })}\n\n`);
      res.end();
    } catch (e) {
      try { res.write(`data: ${JSON.stringify({ error: e.message, done: true })}\n\n`); res.end(); }
      catch { res.writeHead(500); res.end(); }
    }

  } else if (reqPath === '/api/chime' && req.method === 'POST') {
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      playChimeOnServer(b.kind === 'close' ? 'close' : 'wake');
    } catch {}
    res.writeHead(204); res.end();

  } else if (reqPath === '/api/volume/duck' && req.method === 'POST') {
    // Lower system volume before TTS speaks so Xenon's voice is foregrounded.
    try {
      await readBody(req);
      if (!_duckActive && cachedSpeakerId) {
        _duckSavedVolume = _lastSpeakerVolume;
        _duckActive = true;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, '20'], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/api/volume/restore' && req.method === 'POST') {
    try {
      await readBody(req);
      if (_duckActive && cachedSpeakerId) {
        const vol = _duckSavedVolume != null ? _duckSavedVolume : 70;
        _duckActive = false;
        _duckSavedVolume = null;
        execFile(SVV, ['/SetVolume', cachedSpeakerId, String(vol)], () => {});
      }
      res.writeHead(204); res.end();
    } catch { res.writeHead(204); res.end(); }

  } else if (reqPath === '/background' && req.method === 'POST') {
    try {
      const body = await readBodyBuffer(req, BACKGROUND_MAX_BYTES);
      const file = parseMultipartBackground(req, body);
      const extFromName = path.extname(file.originalName).toLowerCase();
      const ext = BACKGROUND_MIME_BY_EXT.has(extFromName) ? extFromName : BACKGROUND_EXT_BY_MIME.get(file.contentType);
      if (!ext || !BACKGROUND_MIME_BY_EXT.has(ext)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unsupported file type' }));
        return;
      }
      const expectedType = BACKGROUND_MIME_BY_EXT.get(ext);
      if (file.contentType && file.contentType !== 'application/octet-stream' && file.contentType !== expectedType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File type mismatch' }));
        return;
      }
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
      const safeName = `background-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
      const safePath = path.join(UPLOADS_DIR, safeName);
      await fs.promises.writeFile(safePath, file.data);

      let response = { ok: true, url: `/uploads/${safeName}`, name: file.originalName, type: expectedType, size: file.data.length, conversion: 'not-needed' };
      if (expectedType === 'video/mp4') {
        const webmName = safeName.replace(/\.mp4$/i, '.webm');
        const webmPath = path.join(UPLOADS_DIR, webmName);
        try {
          const webmStat = await transcodeMp4BackgroundToWebm(safePath, webmPath);
          await fs.promises.unlink(safePath).catch(() => {});
          response = {
            ok: true,
            url: `/uploads/${webmName}`,
            name: `${path.basename(file.originalName, path.extname(file.originalName))}.webm`,
            type: 'video/webm',
            size: webmStat.size,
            originalName: file.originalName,
            originalType: expectedType,
            converted: true,
            conversion: 'webm-vp8',
          };
          cleanupOldBackgrounds(webmName);
        } catch (conversionError) {
          await fs.promises.unlink(webmPath).catch(() => {});
          response = {
            ...response,
            conversion: isFfmpegMissing(conversionError) ? 'ffmpeg-missing' : 'failed',
          };
          console.warn(`Background MP4 conversion skipped: ${conversionError.message}`);
          cleanupOldBackgrounds(safeName);
        }
      } else {
        cleanupOldBackgrounds(safeName);
      }

      json(response);
    } catch (e) {
      if (e.code === 'PAYLOAD_TOO_LARGE') {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    }

  } else if (req.method === 'GET' && reqPath.startsWith('/uploads/')) {
    try {
      const name = decodeURIComponent(reqPath.slice('/uploads/'.length));
      if (!/^[A-Za-z0-9._-]+$/.test(name)) { res.writeHead(403); res.end('Forbidden'); return; }
      const abs = path.join(UPLOADS_DIR, name);
      const ext = path.extname(name).toLowerCase();
      const mime = BACKGROUND_MIME_BY_EXT.get(ext);
      if (!mime) { res.writeHead(404); res.end(); return; }
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) { res.writeHead(404); res.end(); return; }

      const baseHeaders = {
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable',
      };
      const range = req.headers.range;

      if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        const suffixLength = match[1] === '' ? Number(match[2]) : null;
        const start = suffixLength !== null ? Math.max(0, stat.size - suffixLength) : Number(match[1]);
        const end = match[2] === '' || suffixLength !== null ? stat.size - 1 : Number(match[2]);

        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start < 0 || end >= stat.size) {
          res.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }

        res.writeHead(206, {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': String(end - start + 1),
        });
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...baseHeaders, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      if (e.code === 'ENOENT') { res.writeHead(404); res.end(); }
      else err500(e.message);
    }

  } else if (req.method === 'GET' && /^\/(styles|components|js|vendor|public)(\/|$)/.test(reqPath)) {
    // Static asset handler for refactored CSS/JS files, vendored libs (GridStack),
    // and bundled images under public/. Normalise to an absolute path and reject
    // any traversal outside __dirname.
    const rel = reqPath.replace(/^\//, '');
    const abs = path.normalize(path.join(__dirname, rel));
    if (!abs.startsWith(path.join(__dirname, path.sep)) && abs !== __dirname) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const ext = path.extname(abs).toLowerCase();
    const STATIC_MIME = {
      '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.webp': 'image/webp', '.svg': 'image/svg+xml', '.gif': 'image/gif',
    };
    const mime = STATIC_MIME[ext] || 'application/octet-stream';
    if (ext === '.css' || ext === '.js') {
      // CSS/JS: revalidate on every load (no-cache) but skip the transfer when the
      // file is unchanged. The ETag is derived from size+mtime, so a local edit
      // produces a new tag and shows on refresh — the 304 only fires byte-identical.
      fs.promises.stat(abs).then(stat => {
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { 'Cache-Control': 'no-cache', 'ETag': etag }); res.end(); return;
        }
        return fs.promises.readFile(abs).then(data => {
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache', 'ETag': etag });
          res.end(data);
        });
      }).catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    } else {
      // Images/static assets: cache for a day (effectively immutable filenames).
      fs.promises.readFile(abs)
        .then(data => { res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' }); res.end(data); })
        .catch(e => { if (e.code === 'ENOENT') { res.writeHead(404); res.end(); } else err500(e.message); });
    }

  // ── Twitch live integration (OAuth device flow) ──────────────────────────
  // Responses never include tokens — only { connected, login, configured } or the
  // device-flow code/URL the user authorises on their phone.
  } else if (reqPath === '/stream/twitch/status' && req.method === 'GET') {
    try { json(await streamTwitch.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/login' && req.method === 'POST') {
    try { await readBody(req); json(await streamTwitch.startDeviceLogin()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/login/poll' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamTwitch.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/logout' && req.method === 'POST') {
    try { await readBody(req); json(await streamTwitch.logout()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/twitch/stream' && req.method === 'GET') {
    // Live status for the dashboard tile (viewer count / live-offline). Cheap
    // Helix call; the client polls only while the tile is visible.
    try { json(await streamTwitch.streamStatus()); }
    catch (e) { err500(e.message); }

  // ── YouTube live integration (Google OAuth device flow) ──────────────────
  } else if (reqPath === '/stream/youtube/status' && req.method === 'GET') {
    try { json(await streamYouTube.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/login' && req.method === 'POST') {
    try { await readBody(req); json(await streamYouTube.startDeviceLogin()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/login/poll' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamYouTube.pollDeviceToken(body.deviceCode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/logout' && req.method === 'POST') {
    try { await readBody(req); json(await streamYouTube.logout()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/broadcast' && req.method === 'GET') {
    // Live broadcast status + viewer count for the YouTube widget. Quota-aware:
    // the client polls only while the tile is visible.
    try { json(await streamYouTube.broadcastStatus()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/youtube/title' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await streamYouTube.updateBroadcastTitle(body.title));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/stream/config' && req.method === 'POST') {
    // Save the streaming app credentials pasted in Settings → Streaming (so the
    // user never edits stream-config.json by hand) and re-create the providers.
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      await saveStreamConfig(body);
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/requirements' && req.method === 'GET') {
    try {
      const r = await secondScreen.requirements();
      // The tile also needs the native helper (the GDI capture host); fold its
      // presence into the same payload so the client decides in one round-trip.
      r.captureAvailable = screenCapture.available();
      json(r);
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/install' && req.method === 'POST') {
    try {
      await readBody(req);
      json(await secondScreen.installDriver());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/create-display' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await secondScreen.createDisplay(body && body.mode));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/apply-resolution' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await applySecondScreenMode((body && body.mode) || {}, { soft: !!(body && body.soft) }));
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/second-screen/remove-display' && req.method === 'POST') {
    try {
      await readBody(req);
      json(await secondScreen.removeDisplay());
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/status' && req.method === 'GET') {
    try { json(await remoteControl.status()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/install' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.installTool(body.tool);
      if (ok) { json({ ok }); } else { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/tailscale/login' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.startTailscaleLogin();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/sunshine/configure' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.configureSunshine();
      json({ ok: true });
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }

  } else if (reqPath === '/remote/pin' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = await remoteControl.sendPin(body.pin);
      if (result.ok) { json({ ok: true }); }
      else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, status: result.status })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/kill' && req.method === 'POST') {
    try {
      await readBody(req);
      const ok = await remoteControl.killSwitch();
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/enable' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.enable();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/disable' && req.method === 'POST') {
    try {
      await readBody(req);
      await remoteControl.disable();
      json({ ok: true });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/ondemand' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setOnDemand(body.value === true);
      json({ ok });
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screens' && req.method === 'GET') {
    try { json(await remoteControl.listScreens()); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screen' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const ok = await remoteControl.setScreen(body.id);
      if (ok) { json({ ok: true }); } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); }
    } catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/screen/cycle' && req.method === 'POST') {
    try { await readBody(req); const active = await remoteControl.cycleScreen(); json({ ok: !!active, active }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/session/close' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.closeSession(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/block' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.blockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/remote/unblock' && req.method === 'POST') {
    try { await readBody(req); const ok = await remoteControl.unblockAccess(); json({ ok }); }
    catch (e) { err500(e.message); }

  } else if (reqPath === '/sse' && req.method === 'GET') {
    // Server-Sent Events stream — replaces client-side polling for status, media,
    // system and audio data. Keepalive pings prevent proxy connection timeouts.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    sseClients.add(res);
    refreshObsWatch();
    req.on('close', () => { sseClients.delete(res); refreshObsWatch(); });

    // Push current state immediately so the client doesn't wait for the first tick.
    Promise.all([
      getSystemInfo().catch(() => null),
      getMediaInfo().catch(() => null),
      getAudioInfo().catch(() => null),
    ]).then(([sys, media, audio]) => {
      // Full status payload — a partial {muted}-only seed read as "no game" on the
      // client, hiding the Companion pill on every SSE (re)connect.
      const now = `event: status\ndata: ${JSON.stringify(statusPayload())}\n\n`;
      if (sys)   res.write(`event: system\ndata: ${JSON.stringify(sys)}\n\n`);
      if (media) res.write(`event: media\ndata: ${JSON.stringify(media)}\n\n`);
      if (audio) res.write(`event: audio\ndata: ${JSON.stringify(audio)}\n\n`);
      res.write(now);
    }).catch(() => {});
    // Seed the just-connected client with the current OBS state (if watching).
    if (obsStopWatch) { try { res.write(`event: obs\ndata: ${JSON.stringify(obsState)}\n\n`); } catch (e) { /* ignore */ } }
    if (obsStopWatch && obsPreview.image) { try { res.write(`event: obs_preview\ndata: ${JSON.stringify(obsPreview)}\n\n`); } catch (e) { /* ignore */ } }

  } else {
    res.writeHead(404); res.end();
  }
});

// ── Embedded-browser relay WebSocket ──────────────────────────────────────────
// The Browser widget streams CDP screencast frames over this loopback-only socket
// and sends pointer/keyboard input back. Each client owns its tiles and they are
// closed when it disconnects (which lets the headless Edge idle-shut-down).
const { WebSocketServer } = require('ws');
const embeddedWss = new WebSocketServer({ noServer: true });
let _embConnSeq = 0;

server.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { pathname = ''; }
  if (pathname !== '/embedded-browser/ws' && pathname !== '/second-screen/ws') { socket.destroy(); return; }
  // Same loopback/Host/Origin guard as every HTTP route — the relay is local-only.
  if (!isAllowedRequest(req)) { socket.destroy(); return; }
  if (pathname === '/second-screen/ws') {
    embeddedWss.handleUpgrade(req, socket, head, (client) => _handleSecondScreenClient(client));
    return;
  }
  embeddedWss.handleUpgrade(req, socket, head, (client) => _handleEmbeddedClient(client));
});

// Relay for the Second-screen tile. One capture host is shared, so only one
// client streams at a time; if a second client starts, it takes over the sink.
// The capture process itself self-stops when no tile is visible (the client
// sends 'stop' on hide / perf-pause), keeping idle cost at zero.
function _handleSecondScreenClient(client) {
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  let owns = false;
  const sink = (data, meta) => send({ type: 'frame', data, w: meta.w, h: meta.h, seq: meta.seq });
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    try {
      switch (m.type) {
        case 'list': { const r = await screenCapture.list(); send({ type: 'monitors', monitors: r.monitors || [] }); break; }
        case 'start': {
          owns = true;
          screenCapture.setFrameSink(sink);
          const r = await screenCapture.start({ monitor: m.monitor, fps: m.fps, maxWidth: m.maxWidth, maxHeight: m.maxHeight, quality: m.quality });
          send({ type: 'started', info: r });
          break;
        }
        case 'stop': { owns = false; await screenCapture.stop(); send({ type: 'stopped' }); break; }
        case 'input': { screenCapture.input(m.event); break; }
        default: break;
      }
    } catch (e) {
      send({ type: 'error', error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => { if (owns) screenCapture.stop().catch(() => {}); owns = false; };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

function _handleEmbeddedClient(client) {
  const connId = 'c' + (++_embConnSeq);
  const myTiles = new Set();                 // server-namespaced tile ids owned by this client
  const send = (obj) => { try { client.send(JSON.stringify(obj)); } catch (e) { /* ignore */ } };
  client.on('message', async (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const localId = String(m.tile || '');
    const tid = connId + ':' + localId;        // namespaced so tiles never collide across clients
    try {
      switch (m.type) {
        case 'open': {
          myTiles.add(tid);
          const onFrame = (data, meta) => send({ type: 'frame', tile: localId, data, meta });
          const onNav = (url) => send({ type: 'nav', tile: localId, url });
          const r = await embeddedBrowser.open(tid, m.url, m.w, m.h, m.dpr, onFrame, onNav);
          await embeddedBrowser.startScreencast(tid);
          send({ type: 'opened', tile: localId, url: r.url });
          break;
        }
        case 'navigate': { const r = await embeddedBrowser.navigate(tid, m.url); send({ type: 'nav', tile: localId, url: r.url }); break; }
        case 'resize':    await embeddedBrowser.setSize(tid, m.w, m.h, m.dpr); break;
        case 'input':     await embeddedBrowser.input(tid, m.event); break;
        case 'screencast': if (m.on) await embeddedBrowser.startScreencast(tid); else await embeddedBrowser.stopScreencast(tid); break;
        case 'reload':    await embeddedBrowser.reload(tid); break;
        case 'history':   await embeddedBrowser.navHistory(tid, m.dir < 0 ? -1 : 1); break;
        case 'close':     myTiles.delete(tid); await embeddedBrowser.closeTile(tid); break;
        default: break;
      }
    } catch (e) {
      send({ type: 'error', tile: localId, error: String((e && e.message) || e) });
    }
  });
  const cleanup = () => { for (const tid of myTiles) embeddedBrowser.closeTile(tid).catch(() => {}); myTiles.clear(); };
  client.on('close', cleanup);
  client.on('error', cleanup);
}

function _startListen(host) {
  server.listen(3030, host, () => {
    console.log('Widget server running on http://' + host + ':3030');
    getAudioInfo().then(info => {
      if (info && info.mic && typeof info.mic.muted === 'boolean') isMuted = info.mic.muted;
      console.log('Speaker cache:', cachedSpeakerId);
      console.log('Mic cache:   ', cachedMicId);
      console.log('Mic muted:   ', isMuted);
    }).catch(e => console.error('Audio init failed:', e.message));
    _initSttDevice(); // Enumerate DirectShow audio devices in background
    _initTimers().catch(() => {}); // Load persisted timers + start 1-second check loop
    try { fpsMonitor.startFpsMonitor(); } catch (e) { console.error('FPS monitor init failed:', e.message); } // Real in-game FPS via PresentMon (no-op if absent)
    try { gameDetect.startGameDetect(); } catch (e) { console.error('Game detect init failed:', e.message); } // Game mode via foreground full-screen detection
    try { guardian.start(); } catch (e) { console.error('Guardian init failed:', e.message); } // Opt-in sensor history (no-op while disabled)
    readHubSettings().then(s => {
      if (s) _serverHubSettings = s;
      // Apply persisted lighting config (no-op/zero-cost while master is OFF).
      try { lighting.applyConfig((s || _serverHubSettings).lighting); } catch (e) { console.error('Lighting init failed:', e.message); }
      // OpenRGB was removed from the product. Tear down anything a previous
      // version may have left so it never launches itself again: drop the
      // auto-start scheduled task (one fire-and-forget call, silent if absent).
      try { execFile('schtasks', ['/Delete', '/TN', 'XenonEdge OpenRGB', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ }
    }).catch(() => {});
  });
}

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port 3030 is already in use. Close the other node process before restarting.');
    process.exit(1);
  } else if ((err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') && server.listening === false) {
    // IPv6 not available on this system — fall back to IPv4 loopback
    console.warn('IPv6 not available, falling back to 127.0.0.1');
    _startListen('127.0.0.1');
  } else {
    throw err;
  }
});

// Try IPv6 dual-stack first (accepts both 127.0.0.1 and ::1).
// Falls back to IPv4 via the error handler if IPv6 is unavailable.
_startListen('::');

// ── SSE broadcast timers ──────────────────────────────────────────────────────
// These replace client-side setInterval polling.  Timers only run work when at
// least one SSE client is connected, so they have no cost at idle.

// The ONE shape of a 'status' payload — used by GET /status, the periodic SSE
// broadcast AND the SSE connect-seed. Every 'status' event must carry the full
// set: a partial one (the old seed sent just {muted}) reads as "no game" on the
// client and hid the Game Companion pill / confused Performance Mode on every
// SSE reconnect.
function statusPayload() {
  let gaming = false;
  let activity = 'other';
  try { gaming = gameDetect.isGaming(); } catch { gaming = false; }
  try { activity = gameDetect.getActivity(); } catch { activity = 'other'; }
  let fgProcess = '';
  try { fgProcess = gameDetect.getForegroundProcess(); } catch { fgProcess = ''; }
  // gameRunning = game alive (foreground OR background); drives the Companion pill.
  // Computed before getGameProcess (it prunes the name once the game has exited).
  let gameRunning = false;
  try { gameRunning = gameDetect.isGameRunning(); } catch { gameRunning = false; }
  let gameProcess = '';
  try { gameProcess = gameDetect.getGameProcess(); } catch { gameProcess = ''; }
  return { muted: isMuted, gaming, activity, process: fgProcess, gameRunning, gameProcess };
}

function broadcastStatusNow() {
  if (sseClients.size === 0) return;
  const st = statusPayload();
  broadcastSSE('status', st);
  try { lighting.onStatus({ gaming: st.gaming }); } catch {}
}

setInterval(broadcastStatusNow, 3000).unref();

// Game-mode flips ride the foreground probe's instant push lines: broadcast
// right away so entering/leaving a game doesn't wait for the next 3s tick.
try { gameDetect.onGamingChange(() => broadcastStatusNow()); } catch {}

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { broadcastSSE('media', await getMediaInfo()); } catch {}
}, 2000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { const sys = await getSystemInfo(); broadcastSSE('system', sys); lighting.onSystem(sys); } catch {}
}, 7000).unref();

setInterval(async () => {
  if (sseClients.size === 0) return;
  try { const a = await getAudioInfo(); broadcastSSE('audio', a); lighting.onAudio(a); } catch {}
}, 5000).unref();

// Keepalive ping every 20 s to prevent proxy/load-balancer timeouts.
setInterval(() => {
  if (sseClients.size === 0) return;
  const ping = ':ping\n\n';
  for (const res of sseClients) {
    try { res.write(ping); } catch { sseClients.delete(res); }
  }
}, 20000).unref();

// Graceful shutdown: close SSE streams and the HTTP server so port 3030 is
// released promptly on Ctrl+C / SIGTERM. Without this, long-lived SSE
// connections keep the process alive for 30+ seconds after the signal,
// causing EADDRINUSE on quick restarts (npm run start immediately after Ctrl+C).
// The handler calls process.exit(0) explicitly — the old comment warning
// about suppressing Ctrl+C only applies to handlers that *return* without
// exiting. A 3-second safety timeout force-exits if connections drain slowly.
function _gracefulShutdown() {
  // Terminate all open SSE streams (the main long-lived handles).
  for (const res of sseClients) { try { res.end(); } catch {} }
  sseClients.clear();
  // Release RGB bridge so iCUE reclaims device control immediately.
  try { lighting.releaseAll(); lighting.disconnect(); } catch {}
  // Stop the persistent PowerShell collector host (safe to kill: no SMTC handles).
  try { _killWorker('shutdown'); } catch {}
  // Retire the SMTC media host gracefully (stdin close → clean exit → handles released).
  try { _retireMediaHost('shutdown'); } catch {}
  // Kill the headless embedded-browser Edge instance (if one is running).
  try { embeddedBrowser.shutdown(); } catch {}
  // Stop the second-screen capture host (if one is running).
  try { screenCapture.shutdown(); } catch {}
  // Close the HTTP server; exit once all remaining connections drain.
  server.close(() => process.exit(0));
  // Safety: force-exit after 3 s if some connection refuses to close.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT',  _gracefulShutdown);
process.on('SIGTERM', _gracefulShutdown);
