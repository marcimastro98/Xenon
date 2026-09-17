import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// A Deck key pointed at an app that "doesn't exist (but again, it does)".
//
// Windows writes `%APPDATA%\Spotify\Spotify.exe` in its own dialogs, every
// install guide quotes it that way, and both Win+R and the Explorer address bar
// expand it on the spot — so it reads as a real path everywhere a person can
// look. `fs.existsSync` does not expand it, so the key answered not_found
// forever about a file that was plainly there.
//
// Same shape as the two completers already here (the hidden .app extension on
// macOS, shell-escaped paths on POSIX): it changes WHICH string the gates are
// asked about, never the gates.

const require = createRequire(import.meta.url);
const reg = require('../actions/registry.js');
const { completeWindowsEnvPath: expand } = reg;

const ENV = {
  APPDATA: 'C:\\Users\\wade\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\wade\\AppData\\Local',
  EMPTY: '',
};
const SPOTIFY = 'C:\\Users\\wade\\AppData\\Roaming\\Spotify\\Spotify.exe';
const exists = (p) => p === SPOTIFY;

test('the path Windows itself shows you now resolves', () => {
  assert.equal(expand('%APPDATA%\\Spotify\\Spotify.exe', 'win32', exists, ENV), SPOTIFY);
});

test('variable names are matched the way Windows matches them', () => {
  // Environment variables are case-insensitive on Windows; a user typing
  // %appdata% has typed the same thing.
  assert.equal(expand('%appdata%\\Spotify\\Spotify.exe', 'win32', exists, ENV), SPOTIFY);
  assert.equal(expand('%AppData%\\Spotify\\Spotify.exe', 'win32', exists, ENV), SPOTIFY);
});

test('an unknown variable abandons the attempt instead of eating the segment', () => {
  // `%NOPE%\x.exe` must never become `\x.exe` — a path pointing somewhere the
  // user did not name is worse than the honest failure.
  assert.equal(expand('%NOPE%\\Spotify\\Spotify.exe', 'win32', exists, ENV), '');
  assert.equal(expand('%EMPTY%\\Spotify\\Spotify.exe', 'win32', exists, ENV), '',
    'a variable that exists but is blank is no better');
});

test('a path that already exists is never second-guessed', () => {
  assert.equal(expand(SPOTIFY, 'win32', exists, ENV), '');
});

test('a rewritten path is only offered when it actually exists', () => {
  assert.equal(expand('%APPDATA%\\Nowhere\\Nothing.exe', 'win32', exists, ENV), '',
    'expanding is not the same as finding');
});

test('it stays on Windows, and off paths with nothing to expand', () => {
  assert.equal(expand('%APPDATA%\\Spotify\\Spotify.exe', 'darwin', exists, ENV), '');
  assert.equal(expand('%APPDATA%\\Spotify\\Spotify.exe', 'linux', exists, ENV), '');
  assert.equal(expand('C:\\Program Files\\App\\App.exe', 'win32', exists, ENV), '');
});

test('a stray percent sign is not a variable', () => {
  // `C:\100% Folder\a.exe` is a legal Windows path and must be left alone.
  assert.equal(expand('C:\\100% Folder\\a.exe', 'win32', exists, ENV), '');
  assert.equal(expand('%\\a.exe', 'win32', exists, ENV), '');
});

test('it is wired into the actions that take a path, not just exported', () => {
  const src = require('node:fs').readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
  const calls = src.split('completeWindowsEnvPath(').length - 1;
  // One definition, one export, and the three call sites the POSIX completer has
  // (open app, open file/folder, run script).
  assert.ok(calls >= 4, `expected it to be applied at every path action, saw ${calls - 1} call sites`);
  const posix = src.split('completePosixTypedPath(').length - 1;
  assert.equal(calls, posix, 'both completers must cover the same actions');
});

test('the gates after it are untouched — it only changes the string they judge', () => {
  // The expanded path still has to be an allowed app path.
  assert.equal(reg.isAllowedAppPath(SPOTIFY, 'win32'), true);
  assert.equal(reg.isAllowedAppPath('C:\\Users\\wade\\notes.txt', 'win32'), false,
    'expansion must not become a way to launch a non-app');
});
