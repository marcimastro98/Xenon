'use strict';
// FFmpeg on Windows, added from the app. Until 5.1.0 the installer put it in
// through winget; the single setup no longer does, and voice chat, local
// voices, MP4 backgrounds and screenshots need it. The pin is one exact build
// (gyan.dev's "essentials", published on GitHub by its author) and the SHA-256
// of its bytes as gyan.dev lists it: a swapped asset fails the check and is
// deleted before anything is unpacked (pinned-hash.js). Bump the three together.
//
// Only ffmpeg.exe and ffplay.exe are kept (ffplay plays Deck sounds the system
// player cannot), in server/ffmpeg/bin, the first folder getFfmpegPath() looks
// in. Unpacking uses Windows' own tar.exe with an argv, never a shell.
// macOS and Linux get FFmpeg from their package manager: nothing to do here.

const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile } = require('node:child_process');
const { checkPinnedSha256 } = require('../pinned-hash.js');

const FFMPEG_VERSION = '9.0.2';
const FFMPEG_URL = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip';
const FFMPEG_SHA256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba';
const ZIP_BIN = 'ffmpeg-9.0.2-essentials_build/bin/';
const KEEP = Object.freeze(['ffmpeg.exe', 'ffplay.exe']);
const MAX_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// True when `p` (what getFfmpegPath() answered) is a file, or a bare name found
// on PATH. No spawn: this runs every time Settings asks.
function ffmpegPresent(p, env = process.env, fsImpl = fs) {
  if (!p) return false;
  if (path.isAbsolute(p)) return fsImpl.existsSync(p);
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => { try { return fsImpl.existsSync(path.join(d, p)); } catch { return false; } });
}

async function downloadPinned(url, dest, onProgress, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'XenonEdgeHub' }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res || !res.ok || !res.body) throw new Error('download failed (HTTP ' + (res && res.status) + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  if (total > MAX_BYTES) throw new Error('download larger than expected');
  let got = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (got > MAX_BYTES) { cb(new Error('download larger than expected')); return; }
      if (onProgress) onProgress(got, total);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest));
}

function extractWithTar(zip, outDir, members) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const tar = path.join(root, 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', outDir, '--strip-components', '2', ...members],
      { windowsHide: true, timeout: 180000 },
      (err) => (err ? reject(new Error('unpacking failed: ' + err.message)) : resolve()));
  });
}

// deps (injectable for tests): serverDir, getFfmpegPath, platform, download,
// extract, fsImpl, env, sha256 (tests only: the pin for their fake bytes).
function createFfmpegInstall(deps) {
  const d = deps || {};
  const platform = d.platform || process.platform;
  const fsp = (d.fsImpl || fs).promises;
  const download = d.download || downloadPinned;
  const extract = d.extract || extractWithTar;
  const present = () => ffmpegPresent(d.getFfmpegPath(), d.env, d.fsImpl);
  const home = path.join(d.serverDir, 'ffmpeg');
  let running = null;
  let percent = 0;
  let lastError = null;

  function status() {
    return {
      supported: platform === 'win32',
      installed: present(),
      installing: !!running,
      percent: running ? percent : null,
      error: running ? null : lastError,
      version: FFMPEG_VERSION,
    };
  }

  async function run() {
    const work = path.join(home, '.download');
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.mkdir(path.join(work, 'bin'), { recursive: true });
    const zip = path.join(work, 'ffmpeg.zip');
    await download(FFMPEG_URL, zip, (got, total) => { percent = total ? Math.min(95, Math.round((got / total) * 95)) : 0; });
    await checkPinnedSha256(zip, d.sha256 || FFMPEG_SHA256, 'FFmpeg ' + FFMPEG_VERSION, d.fsImpl);
    await extract(zip, path.join(work, 'bin'), KEEP.map((n) => ZIP_BIN + n));
    const bin = path.join(home, 'bin');
    await fsp.mkdir(bin, { recursive: true });
    for (const name of KEEP) {
      await fsp.rm(path.join(bin, name), { force: true });
      await fsp.rename(path.join(work, 'bin', name), path.join(bin, name));
    }
    await fsp.rm(work, { recursive: true, force: true });
    percent = 100;
  }

  // One install at a time; a second click joins the one running.
  async function install() {
    if (platform !== 'win32') return { ok: false, error: 'unsupported_platform' };
    if (running) return running;
    if (present()) return { ok: true, alreadyInstalled: true };
    percent = 0;
    lastError = null;
    running = run()
      .then(() => ({ ok: true, installed: true }))
      .catch((e) => {
        lastError = String((e && e.message) || e);
        return { ok: false, error: 'install_failed', message: lastError };
      })
      .finally(() => { running = null; });
    return running;
  }

  return { status, install };
}

module.exports = { createFfmpegInstall, ffmpegPresent, FFMPEG_URL, FFMPEG_SHA256, FFMPEG_VERSION, ZIP_BIN, KEEP };
