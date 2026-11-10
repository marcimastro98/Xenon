'use strict';
// The bug report package: one press puts what a developer needs into a .zip
// in <Documents>/Xenon/Bug reports (or the folder the user chose):
//   screenshot.png  the window in front (the whole monitor if there is none)
//   video.mp4       the last seconds from Instant Replay, when it is running
//   system.txt      the PC, the OS, Xenon's version and the app in front
//   logs/           the newest files of the log folder the user chose, if any
//   README.txt      what is inside, and what is missing and why
// The pictures are taken into a temp folder that is removed afterwards; the
// replay clip and the screenshot are NOT added to the gallery. One package at
// a time. The zip's path stays here: callers get its name, "reveal" shows it.
// Never a window title, never the user name or the PC name.

const path = require('path');

const SECONDS = Object.freeze([10, 30, 60]);
const DEFAULT_SECONDS = 30;
// The log folder: plain files only (no links, no subfolders), newest first.
const LOG_MAX_FILES = 20;
const LOG_MAX_TOTAL = 50 * 1024 * 1024;
const LOG_MAX_FILE = 20 * 1024 * 1024;   // a bigger file keeps its newest part
const LOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const SHOT_PASS = new Set(['no_window', 'no_monitor']);

const pad = n => String(n).padStart(2, '0');
function stampOf(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// README and system.txt are read by a developer anywhere: one plain date, not
// the user's locale. "2026-10-27 23:52:56 (UTC+01:00)".
function whenOf(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  const tz = `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} (${tz})`;
}

// "chrome.exe" → "chrome"; anything a file name cannot hold is dropped.
function appName(proc) {
  const s = String(proc || '').replace(/\.exe$/i, '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').trim().slice(0, 40);
  return s || 'Desktop';
}

function secondsOf(v) {
  const n = Number(v);
  return SECONDS.includes(n) ? n : DEFAULT_SECONDS;
}

// The newest log files to add: [{ name, file, start, size, cut }], within the
// limits above. `entries` are { name, file, size, mtimeMs, isFile }.
function pickLogs(entries, now) {
  const fresh = (entries || [])
    .filter(e => e && e.isFile === true && e.size > 0 && now - e.mtimeMs <= LOG_MAX_AGE_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  let total = 0;
  for (const e of fresh) {
    if (out.length >= LOG_MAX_FILES) break;
    const size = Math.min(e.size, LOG_MAX_FILE);
    if (total + size > LOG_MAX_TOTAL) continue;
    total += size;
    out.push({ name: e.name, file: e.file, start: e.size - size, size, cut: size < e.size });
  }
  return out;
}

const gb = b => (Number(b) > 0 ? (Number(b) / 1073741824).toFixed(1) + ' GB' : 'unknown');

// system.txt: plain lines a person reads. `s` comes from the server.
function systemText(s) {
  const v = s || {};
  const lines = [
    `Xenon ${v.xenon || 'unknown'}`,
    `Time: ${v.time || ''}`,
    `OS: ${[v.os, v.osRelease, v.arch].filter(Boolean).join(' ') || 'unknown'}`,
    `CPU: ${v.cpu || 'unknown'}${v.cores ? ` (${v.cores} threads)` : ''}`,
    `RAM: ${gb(v.ramTotal)}${v.ramPercent != null ? `, ${v.ramPercent}% in use` : ''}`,
    `GPU: ${v.gpu || 'unknown'}${v.vramTotal ? `, ${gb(v.vramTotal)} VRAM` : ''}`,
  ];
  for (const d of Array.isArray(v.displays) ? v.displays : []) {
    lines.push(`Display: ${d.width}x${d.height}${d.scale ? ` at ${Math.round(d.scale * 100)}%` : ''}${d.primary ? ' (main)' : ''}`);
  }
  lines.push(`App in front: ${v.app || 'none'}`);
  if (v.uptime) lines.push(`PC on for: ${Math.round(v.uptime / 60)} minutes`);
  return lines.join('\r\n') + '\r\n';
}

// README.txt: what the package holds and, for each missing part, why.
// Why there is no video, by what Instant Replay answered (replay.js saveTo).
const NO_VIDEO = Object.freeze({
  off: 'No video: Instant Replay is off. Turn it on in Xenon, Settings, Capture, to add the last seconds next time.',
  not_running: 'No video: Instant Replay is on but was not recording (it records only while a game runs unless it is set to always).',
  saving: 'No video: Instant Replay was busy saving a clip. Make the report again in a moment.',
});
const NO_VIDEO_OTHER = 'No video: Instant Replay could not save the last seconds.';

function readmeText({ app, when, seconds, video, noVideo, shot, logs, logsWanted, logsMissing }) {
  const lines = [`Bug report from Xenon`, `App: ${app}`, `Made: ${when}`, '', 'Inside:'];
  if (shot) lines.push('- screenshot.png: the window in front when it was made');
  if (video) lines.push(`- video.mp4: the last ${video} seconds of the screen`);
  lines.push('- system.txt: the PC, the system and the app in front');
  for (const l of logs) lines.push(`- logs/${l.name}${l.cut ? ' (its newest 20 MB)' : ''}`);
  const missing = [];
  if (!shot) missing.push('No screenshot: no window could be captured.');
  if (!video && seconds) missing.push(NO_VIDEO[noVideo] || NO_VIDEO_OTHER);
  if (logsMissing) missing.push('No logs: the log folder chosen in Xenon is not there.');
  else if (logsWanted && !logs.length) missing.push('No logs: nothing in the log folder changed in the last 7 days.');
  if (missing.length) lines.push('', ...missing);
  return lines.join('\r\n') + '\r\n';
}

// A remembered package is a .zip named like the ones build() writes.
function knownPackage(v) {
  if (!v || typeof v.file !== 'string' || typeof v.name !== 'string') return false;
  return path.isAbsolute(v.file) && path.basename(v.file) === v.name && /^Bug report .+\.zip$/.test(v.name);
}

function createBugReport({
  host, replay = () => null, folder = async () => ({ dir: '' }), defaultDir, logFolder = async () => ({ dir: '' }),
  system = async () => ({}), foreground = () => '', fs, tmpRoot, writeZip,
  reveal = () => {}, now = Date.now, when = whenOf, onSaved = () => {},
  remember = { load: async () => null, save: () => {} },
}) {
  let busy = null;
  let last = null;   // { file, name } of the last package written
  // The one from before a restart (capture-last.js), checked like a name this server gave.
  const loading = Promise.resolve()
    .then(() => remember.load())
    .then((v) => { if (!last && knownPackage(v)) last = { file: v.file, name: v.name }; })
    .catch(() => {});

  // { ok, exe }: `exe` is the app the engine captured, read at the same instant
  // (the foreground probe polls and can name a window that flashed past).
  async function screenshot(file) {
    let reply = await host.request('screenshot', { target: 'window', path: file }).catch(() => null);
    if (reply && reply.ok !== true && SHOT_PASS.has(reply.error)) {
      reply = await host.request('screenshot', { target: 'screen', path: file }).catch(() => null);
    }
    const ok = !!(reply && reply.ok === true);
    return { ok, exe: ok && typeof reply.exe === 'string' ? reply.exe : '' };
  }

  async function clip(file, seconds) {
    const r = replay();
    if (!r || typeof r.saveTo !== 'function') return { ok: false, error: 'off' };
    return r.saveTo(file, { seconds }).catch(() => ({ ok: false, error: 'save_failed' }));
  }

  async function logsOf(dir) {
    const names = await fs.readdir(dir).catch(() => null);
    if (!names) return null;
    const entries = [];
    for (const name of names) {
      const file = path.join(dir, name);
      // lstat: a link is never followed out of the chosen folder.
      const st = await fs.lstat(file).catch(() => null);
      if (st) entries.push({ name, file, size: st.size, mtimeMs: st.mtimeMs, isFile: st.isFile() });
    }
    return pickLogs(entries, now());
  }

  // Two presses in the same second share a stamp: the second package gets " (2)"
  // instead of replacing the first. One package at a time, so no race here.
  async function freeName(dir, base) {
    for (let n = 1; n < 100; n++) {
      const name = n === 1 ? `${base}.zip` : `${base} (${n}).zip`;
      const taken = await fs.stat(path.join(dir, name)).then(() => true, () => false);
      if (!taken) return name;
    }
    return `${base} (${Date.now()}).zip`;
  }

  async function build(seconds) {
    const at = now();
    let where = { dir: '' };
    try { where = (await folder()) || where; } catch { /* the default folder */ }
    const dir = where.dir || await defaultDir();
    try { await fs.mkdir(dir, { recursive: true }); } catch { return { ok: false, error: 'write_failed' }; }
    const tmp = await fs.mkdtemp(path.join(tmpRoot, 'xenon-bug-'));
    try {
      const shotFile = path.join(tmp, 'screenshot.png');
      const videoFile = path.join(tmp, 'video.mp4');
      const [taken, video, sys] = await Promise.all([
        screenshot(shotFile), clip(videoFile, seconds), system().catch(() => ({})),
      ]);
      const shot = taken.ok;
      const app = appName(taken.exe || foreground());
      let logsWanted = false;
      let logsMissing = false;
      let logs = [];
      const lf = await logFolder().catch(() => ({ dir: '' }));
      if (lf && lf.missing) logsMissing = true;
      else if (lf && lf.dir) {
        logsWanted = true;
        const found = await logsOf(lf.dir);
        if (found) logs = found;
        else logsMissing = true;
      }
      const videoSeconds = video && video.ok ? Math.round(Number(video.seconds) || seconds) : 0;
      const videoWhy = videoSeconds ? '' : String((video && video.error) || '');
      const stamp = when(at);
      const entries = [
        { name: 'README.txt', data: readmeText({ app, when: stamp, seconds, video: videoSeconds, noVideo: videoWhy, shot, logs, logsWanted, logsMissing }) },
        { name: 'system.txt', data: systemText({ ...sys, app: app === 'Desktop' ? '' : app + '.exe', time: stamp }) },
      ];
      if (shot) entries.push({ name: 'screenshot.png', file: shotFile });
      if (videoSeconds) entries.push({ name: 'video.mp4', file: videoFile });
      for (const l of logs) entries.push({ name: 'logs/' + l.name, file: l.file, start: l.start });
      const name = await freeName(dir, `Bug report ${app} ${stampOf(at)}`);
      const file = path.join(dir, name);
      let zipped;
      try { zipped = await writeZip(file, entries); } catch (e) {
        return { ok: false, error: e && e.code === 'too_big' ? 'too_big' : e && e.code === 'ENOSPC' ? 'disk_full' : 'write_failed' };
      }
      last = { file, name };
      try { remember.save(last); } catch { /* remembered in memory either way */ }
      const result = {
        ok: true, saved: true, name, bytes: zipped.bytes, app,
        video: videoSeconds, screenshot: shot, logs: logs.length,
      };
      if (!videoSeconds) result.noVideo = videoWhy === 'off' ? 'off' : 'not_running';
      if (logsMissing) result.logsMissing = true;
      if (where.missing === true) result.folderMissing = true;
      try { onSaved({ ...result, kind: 'bugreport' }); } catch { /* the package is saved either way */ }
      return result;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  function make({ seconds } = {}) {
    if (!host.available()) return Promise.resolve({ ok: false, error: 'unavailable' });
    if (busy) return Promise.resolve({ ok: false, error: 'busy' });
    busy = build(secondsOf(seconds)).catch(() => ({ ok: false, error: 'write_failed' }));
    return busy.finally(() => { busy = null; });
  }

  async function show() {
    await loading;
    if (!last) return { ok: false, error: 'no_file' };
    const there = await fs.stat(last.file).then(() => true, () => false);
    if (!there) return { ok: false, error: 'no_file' };
    reveal(last.file);
    return { ok: true, shown: true, name: last.name };
  }

  return { make, reveal: show, busy: () => !!busy };
}

module.exports = {
  createBugReport, knownPackage, pickLogs, systemText, readmeText, appName, secondsOf, stampOf, whenOf,
  SECONDS, DEFAULT_SECONDS, LOG_MAX_FILES, LOG_MAX_TOTAL, LOG_MAX_FILE, LOG_MAX_AGE_MS,
};
