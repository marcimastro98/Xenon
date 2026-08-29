// The Deck key whose path had spaces in it.
//
// Reported on macOS: an "Open app" key pointed at an application whose name
// contains spaces did nothing, and renaming the application to remove them made
// the same key work.
//
// The launch itself was never the problem — openExternalPath execs
// `/usr/bin/open -- <path>` with an argv array, where a space is just a space.
// What breaks is one step earlier, in what lands in the field: the ordinary way
// to get a path on a Mac is to drag the file into Terminal, and what that writes
// is `/Applications/Epic\ Games\ Launcher.app`, with every space escaped for a
// shell. Some copy helpers wrap the whole path in quotes instead. Either string
// names a file that does not exist, so the key answers not_found forever while
// the field looks exactly right.
//
// This is the POSIX counterpart of unquotePath (js/deck-actions.js), which
// already strips the double quotes Explorer's "Copy as path" adds on Windows.
// The difference: a backslash and a single quote are both LEGAL in a POSIX
// filename, so the characters alone cannot decide it — the filesystem does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { completePosixTypedPath } = require('../actions/registry.js');

const REAL = new Set([
  '/Applications/Epic Games Launcher.app',
  '/Users/p/My Documents',
  String.raw`/Users/p/back\slash`,     // a real name containing a backslash
  "/Users/p/it's here",                // a real name containing an apostrophe
  "/Users/p/'quoted'",                 // a real name that IS wrapped in quotes
]);
const exists = (p) => REAL.has(p);
const complete = (p, plat = 'darwin') => completePosixTypedPath(p, plat, exists);

test('a path dragged into Terminal resolves to the file it names', () => {
  assert.equal(complete(String.raw`/Applications/Epic\ Games\ Launcher.app`),
    '/Applications/Epic Games Launcher.app');
});

test('a quoted path resolves too, single or double', () => {
  assert.equal(complete("'/Applications/Epic Games Launcher.app'"),
    '/Applications/Epic Games Launcher.app');
  assert.equal(complete('"/Applications/Epic Games Launcher.app"'),
    '/Applications/Epic Games Launcher.app');
  // Quoted AND escaped — what you get by dragging into Terminal inside quotes.
  assert.equal(complete(String.raw`'/Applications/Epic\ Games\ Launcher.app'`),
    '/Applications/Epic Games Launcher.app');
});

// The whole safety argument. A backslash and a quote are legal in a POSIX name,
// so the only thing that makes this safe is that a path which already exists is
// never reinterpreted, and a rewrite is only ever returned when it exists.
test('a path that already exists is never second-guessed', () => {
  for (const real of REAL) {
    assert.equal(complete(real), '', `${real} must be left exactly as typed`);
  }
});

test('a path that resolves to nothing is not guessed at', () => {
  assert.equal(complete(String.raw`/nowhere/at\ all.app`), '');
  assert.equal(complete("'/nowhere/at all.app'"), '');
  assert.equal(complete(''), '');
  assert.equal(complete(null), '');
});

// Windows has its own rule (unquotePath, double quotes only) and a backslash is
// its path separator — unescaping there would take every path apart.
test('nothing of this happens on Windows', () => {
  assert.equal(completePosixTypedPath(String.raw`C:\Program Files\App\app.exe`, 'win32', () => false), '');
  assert.equal(completePosixTypedPath(String.raw`C:\a\ b`, 'win32', exists), '');
});

test('a caller with no way to check the filesystem gets no answer', () => {
  assert.equal(completePosixTypedPath(String.raw`/Applications/Epic\ Games\ Launcher.app`, 'darwin', null), '');
});

// It has to run before the gates, or they judge a string the user never meant —
// and it must be reached by every action that takes a path someone types.
test('every path action resolves before it validates', () => {
  const SRC = require('node:fs').readFileSync(new URL('../actions/registry.js', import.meta.url), 'utf8');
  for (const kase of ['openApp', 'openFile', 'runScript']) {
    const at = SRC.indexOf(`case '${kase}': {`);
    assert.ok(at > 0, `${kase} exists`);
    const body = SRC.slice(at, SRC.indexOf('\n        case ', at + 10));
    assert.match(body, /completePosixTypedPath\(/, `${kase} completes the typed path`);
    // Before the first gate it feeds.
    const complete = body.indexOf('completePosixTypedPath(');
    const gate = Math.min(...[body.indexOf('fileExists('), body.indexOf('isAllowedAppPath('),
      body.indexOf('isBlockedOpenPath('), body.indexOf('isRunnableScriptPath(')].filter((i) => i > 0));
    assert.ok(complete < gate, `${kase}: the completion runs before the checks`);
  }
});
