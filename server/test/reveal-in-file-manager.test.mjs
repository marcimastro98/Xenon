import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// revealInFileManager() answers "show me where this is" for BOTH the Spotlight
// search results and the transfer widget, on three platforms. It shipped with a
// Windows spelling that silently did the wrong thing whenever the path had a
// space in it, which is nearly always: explorer.exe does not parse its command
// line with CommandLineToArgvW, so Node's own quoting ('/select,C:\a b\c' became
// one quoted argument) left it unable to see the /select verb. It then opened
// the user's default folder — Documents — and reported nothing. The bug is
// invisible in code review and invisible in a path without spaces, which is why
// the exact argv shape is pinned here rather than left to a manual check.
//
// server.js cannot be imported (it starts a listener), so the function is
// extracted and evaluated against stubbed spawn/path/process. Nothing here
// re-implements it: a copy would keep passing after the shipped one regressed.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');

function extractFn(name) {
  const at = SRC.indexOf('function ' + name + '(');
  assert.notEqual(at, -1, 'server.js must still declare ' + name);
  const open = SRC.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}' && --depth === 0) return SRC.slice(at, i + 1);
  }
  throw new Error(name + ' never closes');
}

// Run the real function on a given platform, capturing the spawn it performed.
function reveal(platform, target, dir) {
  const calls = [];
  const child = { handled: false, unrefed: false, on() { child.handled = true; return child; }, unref() { child.unrefed = true; } };
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  const warnings = [];
  const fn = new Function(
    'spawn', 'path', 'process', 'console',
    extractFn('revealInFileManager') + '; return revealInFileManager;',
  )(spawn, platform === 'win32' ? path.win32 : path.posix,
    { platform }, { warn: (...a) => warnings.push(a.join(' ')) });
  fn(target, dir);
  return { calls, child, warnings };
}

const WIN_PATH = 'C:\\Users\\marce\\Desktop\\Marci Progetti\\xenon-suite\\xenon\\tools\\wavelink-probe.mjs';

test('Windows quotes the PATH, not the whole /select token', () => {
  const { calls } = reveal('win32', WIN_PATH);
  assert.equal(calls.length, 1);
  const { cmd, args, opts } = calls[0];
  assert.equal(cmd, 'explorer.exe');
  assert.deepEqual(args, ['/select,"' + WIN_PATH + '"']);
  // Without this, Node re-quotes the argument and explorer is back to opening
  // Documents. The flag and the quotes only work as a pair.
  assert.equal(opts.windowsVerbatimArguments, true);
});

test('the /select verb stays outside the quotes', () => {
  const [{ args }] = reveal('win32', WIN_PATH).calls;
  assert.ok(args[0].startsWith('/select,"'), 'explorer must be able to see the verb');
  assert.ok(args[0].endsWith('"'));
  // The exact regression: the whole token quoted as one string.
  assert.notEqual(args[0], '/select,' + WIN_PATH);
  assert.ok(!args[0].startsWith('"'), 'a leading quote is what broke it');
});

test('a path with no spaces takes the same shape', () => {
  const [{ args, opts }] = reveal('win32', 'C:\\tmp\\a.txt').calls;
  assert.deepEqual(args, ['/select,"C:\\tmp\\a.txt"']);
  assert.equal(opts.windowsVerbatimArguments, true);
});

// Node is no longer escaping, so the one character that could re-cut the
// argument list is refused. It is illegal in a Windows path, so a real file can
// never hit this.
test('a quote in the path is refused instead of spawned', () => {
  const { calls, warnings } = reveal('win32', 'C:\\tmp\\a" b.txt');
  assert.deepEqual(calls, []);
  assert.equal(warnings.length, 1);
});

test('macOS reveals with open -R and no verbatim flag', () => {
  const [{ cmd, args, opts }] = reveal('darwin', '/Users/m/My Files/a.txt').calls;
  assert.equal(cmd, 'open');
  assert.deepEqual(args, ['-R', '/Users/m/My Files/a.txt']);
  assert.notEqual(opts.windowsVerbatimArguments, true);
});

// Linux has no portable "select this file" verb, so it opens the containing
// folder — the honest answer rather than a selection nobody can make.
test('Linux opens the containing folder', () => {
  assert.deepEqual(reveal('linux', '/home/m/My Files/a.txt', '/home/m/My Files').calls[0].args,
    ['/home/m/My Files']);
  // No dir supplied: it must derive one rather than passing the file.
  assert.deepEqual(reveal('linux', '/home/m/My Files/a.txt').calls[0].args, ['/home/m/My Files']);
});

// A missing file manager raises an ASYNC error the caller's try/catch cannot
// see. POST /api/transfer/reveal is reachable from a paired phone, so an
// unhandled one would let a single tap end the backend.
test('the child is error-handled and unref-ed on every platform', () => {
  for (const p of ['win32', 'darwin', 'linux']) {
    const { child } = reveal(p, p === 'win32' ? WIN_PATH : '/tmp/a.txt');
    assert.equal(child.handled, true, p + ' must handle the spawn error');
    assert.equal(child.unrefed, true, p + ' must not hold the event loop open');
  }
});
