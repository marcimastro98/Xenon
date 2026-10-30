'use strict';
// The user's own folders (Desktop, Downloads, Documents, Pictures, Videos), where Xenon saves what
// it makes for them. On Windows they are read from the shell folders key,
// because OneDrive moves them out of the profile on most new PCs; a failed read
// falls back to the profile's own folder of that name, which is also the answer
// on macOS. On Linux they come from xdg-user-dirs (`~/.config/user-dirs.dirs`),
// which names them in the desktop's language (~/Immagini on an Italian one).

const fs = require('fs');
const os = require('os');
const path = require('path');

// Registry value name, xdg-user-dirs key → the folder's name in the profile.
const FOLDERS = Object.freeze({
  desktop: { value: 'Desktop', xdg: 'XDG_DESKTOP_DIR', name: 'Desktop' },
  downloads: { value: '{374DE290-123F-4565-9164-39C4925E467B}', xdg: 'XDG_DOWNLOAD_DIR', name: 'Downloads' },
  documents: { value: 'Personal', xdg: 'XDG_DOCUMENTS_DIR', name: 'Documents' },
  pictures: { value: 'My Pictures', xdg: 'XDG_PICTURES_DIR', name: 'Pictures' },
  videos: { value: 'My Video', xdg: 'XDG_VIDEOS_DIR', name: 'Videos' },
});

// One `KEY="$HOME/Name"` (or absolute) line of user-dirs.dirs; '' when the
// folder is missing, odd, or set to the home itself (xdg's way to turn it off).
function parseXdgDir(text, key, homedir) {
  const m = new RegExp(`^\\s*${key}="([^"\\n]*)"`, 'm').exec(String(text || ''));
  if (!m) return '';
  const raw = m[1].replace(/^\$HOME(?=\/|$)/, homedir);
  if (!path.isAbsolute(raw) || raw.includes('$')) return '';
  const dir = path.normalize(raw);
  return path.relative(homedir, dir) === '' ? '' : dir;
}

function xdgFolder(f, fallback, { homedir, env, readFile }) {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(homedir, '.config');
  return readFile(path.join(config, 'user-dirs.dirs'), 'utf8')
    .then((text) => parseXdgDir(text, f.xdg, homedir) || fallback, () => fallback);
}

function resolveUserFolder(kind, {
  platform = process.platform, homedir = os.homedir(), execFile,
  env = process.env, readFile = fs.promises.readFile,
} = {}) {
  const f = FOLDERS[kind];
  if (!f) return Promise.reject(new Error(`unknown folder: ${kind}`));
  const fallback = path.join(homedir || '', f.name);
  if (platform === 'linux' && homedir) return xdgFolder(f, fallback, { homedir, env, readFile });
  if (platform !== 'win32' || typeof execFile !== 'function') return Promise.resolve(fallback);
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';
  const re = new RegExp(`${f.value.replace(/[{}]/g, '\\$&').replace(/ /g, '\\s')}\\s+REG_\\w+\\s+(.+)`);
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', key, '/v', f.value], { windowsHide: true, timeout: 5000 }, (err, out) => {
        const m = !err && re.exec(String(out || ''));
        const dir = m && m[1].trim();
        resolve(dir && path.isAbsolute(dir) ? dir : fallback);
      });
    } catch { resolve(fallback); }
  });
}

// Where Instant Replay keeps its ring of segments. On Linux /tmp is often in
// memory (tmpfs), and the ring must be on disk: the user's cache folder. On
// macOS the user's own Caches folder, never /tmp.
function replayRingDir({
  platform = process.platform, homedir = os.homedir(), env = process.env, tmpdir = os.tmpdir(),
} = {}) {
  if (platform === 'darwin' && homedir) return path.join(homedir, 'Library', 'Caches', 'Xenon', 'Replay');
  if (platform !== 'linux' || !homedir) return path.join(tmpdir, 'Xenon Replay');
  const cache = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)
    ? env.XDG_CACHE_HOME : path.join(homedir, '.cache');
  return path.join(cache, 'xenon', 'Replay');
}

module.exports = { resolveUserFolder, parseXdgDir, replayRingDir, FOLDERS };
