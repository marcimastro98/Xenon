'use strict';

// ── Private temp files ───────────────────────────────────────────────────────
// Screenshots, recordings, TTS audio and the Bluetooth SMS/phonebook exchange
// files used to land in the shared system temp directory under predictable
// names (xenon-msg-<pid>-<ms>.bmsg and friends). On a multi-user POSIX box /tmp
// is world-writable, so another local user could pre-create that exact name (or
// a symlink with it) and then read what we wrote, or swap the SMS text and
// number between our write and obexd's read.
//
// Every such file now lives inside ONE directory per process, made with
// mkdtemp (random name, created exclusively) and mode 0700, so nobody else can
// list, create or open anything inside it. The paths handed out inside it are
// random too, and callers still open them with 'wx' so even a bug in here
// cannot turn into following someone else's file.
//
// $XDG_RUNTIME_DIR is preferred when it is genuinely ours (a per-user tmpfs the
// login session cleans up): it is only trusted if it is a real directory, not a
// symlink, owned by our uid and not accessible to anyone else. Otherwise the
// ordinary os.tmpdir() is used — the mkdtemp'd 0700 subdirectory is what makes
// it safe there.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let _dir = null;

// Exposed for tests: decide whether an XDG_RUNTIME_DIR value is trustworthy.
function usableRuntimeDir(dir, deps = {}) {
  const lstat = deps.lstatSync || fs.lstatSync;
  const getuid = deps.getuid || (typeof process.getuid === 'function' ? process.getuid : null);
  if (!dir || !path.isAbsolute(dir) || !getuid) return false;
  try {
    const st = lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (st.uid !== getuid()) return false;
    if ((st.mode & 0o077) !== 0) return false;
    return true;
  } catch {
    return false;
  }
}

function _baseDir() {
  if (process.platform !== 'win32' && usableRuntimeDir(process.env.XDG_RUNTIME_DIR)) {
    return process.env.XDG_RUNTIME_DIR;
  }
  return os.tmpdir();
}

// The per-process private directory. Re-created if something removed it (a
// tmp cleaner running while the server stays up for weeks).
function privateTmpDir() {
  if (_dir) {
    try {
      const st = fs.lstatSync(_dir);
      const ours = typeof process.getuid !== 'function' || st.uid === process.getuid();
      if (st.isDirectory() && !st.isSymbolicLink() && ours) return _dir;
    } catch { /* gone: make a new one below */ }
    _dir = null;
  }
  const dir = fs.mkdtempSync(path.join(_baseDir(), 'xenon-'));
  // mkdtemp already uses 0700 on POSIX; chmod again so an unusual umask or
  // platform default can never widen it.
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  _dir = dir;
  return dir;
}

// A fresh, unguessable path inside the private directory. Nothing is created:
// the caller opens it with flag 'wx' (or lets a tool like obexd create it).
function privateTmpFile(prefix = 'tmp', ext = '') {
  const safePrefix = String(prefix || 'tmp').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 40);
  let suffix = String(ext || '');
  if (suffix && !suffix.startsWith('.')) suffix = '.' + suffix;
  suffix = suffix.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 16);
  const name = `${safePrefix}${crypto.randomBytes(12).toString('hex')}${suffix}`;
  return path.join(privateTmpDir(), name);
}

// Best-effort removal at exit so per-process directories do not pile up.
// Synchronous because 'exit' handlers cannot await.
process.once('exit', () => {
  if (!_dir) return;
  try { fs.rmSync(_dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

module.exports = { privateTmpDir, privateTmpFile, usableRuntimeDir };
