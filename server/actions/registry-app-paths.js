'use strict';
// Which program a Deck key or the assistant may launch: the kinds of file that count as an
// application on each system, how a typed path is completed, and how the launch arguments are
// read. Part of the action registry: only registry.js requires this file.

// What openApp may launch — per platform, because the extension is how each OS
// spells "an application". Windows: .exe/.lnk, exactly what it always was.
// macOS adds `.app` bundles (directories, which fileExists() answers for).
// Linux has no extension convention at all: an app is a .desktop entry, an
// AppImage, or a plain executable whose name carries no extension
// (/usr/bin/firefox) — a dotted name is refused so openApp cannot become a
// second openFile for documents. Takes `platform` like the two gates of registry-open-paths.js, so
// each rule is testable off the OS it targets; before that parameter existed
// the Linux branch fell back to the Windows list and every openApp key on
// Linux validated nothing and failed with bad_app_path.
const APP_PATH_EXT = /\.(exe|lnk)$/i;
const APP_PATH_EXT_DARWIN = /\.(exe|lnk|app)$/i;
const APP_PATH_EXT_LINUX = /\.(desktop|appimage)$/i;
function isAllowedAppPath(p, platform) {
  if (typeof p !== 'string') return false;
  const v = p.trim();
  if (!v) return false;
  const plat = platform || process.platform;
  if (plat === 'darwin') return APP_PATH_EXT_DARWIN.test(v);
  if (plat === 'linux') {
    if (APP_PATH_EXT_LINUX.test(v)) return true;
    const base = v.split('/').pop();
    return !!base && !base.includes('.');
  }
  return APP_PATH_EXT.test(v);
}

// Launch arguments for openApp ("--restore-last-session", "--profile-directory=\"Profile 1\"").
// One free-text field becomes an argv ARRAY here, at the boundary: whitespace
// separates tokens, double quotes group, a backslash is literal (Windows paths
// are full of them). Nothing here ever reaches a shell. Returns null for what
// cannot be one honest argument list: an unbalanced quote, control characters,
// or more tokens than any real launch line needs.
const MAX_LAUNCH_ARGS = 32;
function parseLaunchArgs(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return [];
  if (/[\x00-\x1f\x7f]/.test(s)) return null;
  const out = [];
  let cur = '';
  let inQuote = false;
  let started = false;
  for (const ch of s) {
    if (ch === '"') { inQuote = !inQuote; started = true; continue; }
    if (!inQuote && /\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (inQuote) return null;
  if (started) out.push(cur);
  return out.length <= MAX_LAUNCH_ARGS ? out : null;
}

// Which launch routes can really hand arguments to the program. A Windows .lnk
// carries its own, a Linux .desktop entry is started by `gio launch` (which takes
// none): saying so beats starting the app and silently dropping what was typed.
function appPathTakesArgs(p, platform) {
  const v = String(p == null ? '' : p).trim();
  const plat = platform || process.platform;
  if (plat === 'darwin') return /\.app\/?$/i.test(v) || /\.exe$/i.test(v);
  if (plat === 'linux') return !/\.desktop$/i.test(v);
  return /\.exe$/i.test(v);
}

// macOS hides the `.app` extension everywhere a person can see a path: Finder
// shows "Helium", so does Get Info, so does the Applications folder. The path a
// Mac user reads off their own screen and types into a key is therefore
// /Applications/Helium — which is neither a bundle nor a file, so the key failed
// with bad_app_path having never launched anything. Reported on Discord by
// someone whose folder and URL keys worked and whose app keys all did not.
//
// This widens nothing. The completed path still has to pass isAllowedAppPath and
// still has to exist; the only change is that one obvious place is checked before
// giving up. A path that already carries an extension is left alone, so a
// document can never be turned into an app by appending to it.
function completeDarwinBundle(p, platform, fileExists) {
  if ((platform || process.platform) !== 'darwin' || typeof fileExists !== 'function') return '';
  const v = String(p == null ? '' : p).replace(/\/+$/, '');
  const base = v.split('/').pop();
  if (!base || base.includes('.')) return '';
  const bundle = v + '.app';
  return fileExists(bundle) ? bundle : '';
}

// The POSIX counterpart of unquotePath (js/deck-actions.js), and it exists for
// the same reason: the normal way to get a path onto the clipboard hands you a
// path that is escaped for a SHELL, and those escapes are not part of the name.
//
// On Windows that was Explorer's "Copy as path" and its double quotes. On macOS
// it is dragging a file into Terminal, which is how most people get a path at
// all — and what it writes is `/Applications/Epic\ Games\ Launcher.app`, with
// every space backslash-escaped. Some shells and copy helpers wrap the whole
// thing in single quotes instead. Either way the string names a file that does
// not exist, the key answers not_found forever, and the field looks exactly
// right. Reported on Discord by someone who worked around it by renaming the
// application to remove the spaces — which is precisely the shape of a bug that
// only bites paths with spaces in them.
//
// A backslash and a single quote are both LEGAL in a POSIX filename, so unlike
// the Windows case this cannot be decided by the characters alone. It is decided
// by the filesystem instead, and fail-closed twice over: a path that already
// exists is never reinterpreted, and a rewritten candidate is only returned when
// it exists. So the worst case is the behaviour we have today.
//
// Widens nothing: the result still faces every extension gate, every blocklist
// and the existence check that follow. It only changes WHICH string those are
// asked about.
function completePosixTypedPath(p, platform, fileExists) {
  if ((platform || process.platform) === 'win32') return '';
  if (typeof fileExists !== 'function') return '';
  const v = String(p == null ? '' : p).trim();
  if (!v || fileExists(v)) return '';        // a real path is never second-guessed
  const unquote = (x) => {
    if (x.length < 2) return x;
    const q = x[0];
    if ((q !== "'" && q !== '"') || x[x.length - 1] !== q) return x;
    const inner = x.slice(1, -1);
    return (inner && !inner.includes(q)) ? inner : x;
  };
  // `\x` -> `x` for every escaped character, which is what a shell would have
  // done with it. A trailing lone backslash is left alone rather than eaten.
  const unescape = (x) => x.replace(/\\(.)/g, '$1');
  // Ordered so the commonest form is tried first, and the combination last.
  const tried = new Set([v]);
  for (const cand of [unescape(v), unquote(v), unescape(unquote(v)), unquote(unescape(v))]) {
    if (!cand || tried.has(cand)) continue;
    tried.add(cand);
    if (fileExists(cand)) return cand;
  }
  return '';
}

// The Windows counterpart of completePosixTypedPath, and it exists for the same
// reason: the path a user can actually GET hold of is not the one fs.existsSync
// wants.
//
// Windows writes `%APPDATA%\\Spotify\\Spotify.exe` in its own dialogs, every
// install guide quotes it that way, and Win+R and the address bar both expand it
// on the spot — so it reads as a real path everywhere a person looks. Node does
// not expand it, so the key answers not_found forever about a file that is
// plainly there. Reported on #130 as "it tells me the path doesn't exist (but
// again, it does)".
//
// Only whole `%NAME%` pairs are substituted, and only from this process's own
// environment — there is no shell anywhere on this path, so nothing here can be
// injected into one. Fail-closed the same way as the POSIX completer: a path
// that already exists is never reinterpreted, an unknown variable abandons the
// attempt rather than collapsing to an empty segment (`%NOPE%\\x` must not
// become `\\x`), and the rewritten candidate is only returned when it exists.
//
// Widens nothing: the result still faces every extension gate, every blocklist
// and the existence check that follow. It only changes WHICH string they judge.
const WIN_ENV_RE = /%([A-Za-z_][A-Za-z0-9_()]*)%/g;
function completeWindowsEnvPath(p, platform, fileExists, env) {
  if ((platform || process.platform) !== 'win32') return '';
  if (typeof fileExists !== 'function') return '';
  const v = String(p == null ? '' : p).trim();
  if (!v || !v.includes('%') || fileExists(v)) return '';
  const source = env || process.env;
  let unknown = false;
  const expanded = v.replace(WIN_ENV_RE, (whole, name) => {
    // Windows environment variables are case-insensitive; Node's process.env is
    // too on win32, but an explicitly passed map may not be.
    const key = Object.prototype.hasOwnProperty.call(source, name)
      ? name
      : Object.keys(source).find(k => k.toLowerCase() === name.toLowerCase());
    const val = key === undefined ? undefined : source[key];
    if (typeof val !== 'string' || !val) { unknown = true; return whole; }
    return val;
  });
  if (unknown || expanded === v) return '';
  return fileExists(expanded) ? expanded : '';
}

module.exports = {
  APP_PATH_EXT, APP_PATH_EXT_DARWIN, APP_PATH_EXT_LINUX, isAllowedAppPath, MAX_LAUNCH_ARGS,
  parseLaunchArgs, appPathTakesArgs, completeDarwinBundle, completePosixTypedPath, WIN_ENV_RE,
  completeWindowsEnvPath,
};
