// tools/restructure/stale-pointers.mjs: the words about the code, checked against the code.
// Everything here is text handed to the functions: no file is read, so no path of a machine
// is compared and the test is the same on every system.
import test from 'node:test';
import assert from 'node:assert/strict';
import { answersTo, commentsOf, mentionsOf, movedNames, stalePointers } from '../../tools/restructure/stale-pointers.mjs';

const TRACKED = new Set([
  'server/server.js', 'server/big.js', 'server/part/judge.js', 'server/part/store.js',
  'server/js/panel.js', 'server/js/panel/apply.js', 'packages/core/src/format.js', 'DEVELOPER.md',
]);
const LEDGER = { sources: {
  'server/big.js': [{ file: 'server/part/judge.js', about: '', names: ['isAllowed', 'start', 'keepWrite'] }],
  'server/part/judge.js': [{ file: 'server/part/store.js', about: '', names: ['keepWrite'] }],
} };
const BROWSER = { moves: [
  { kind: 'script', from: 'server/index.html', file: 'server/js/page.js' },
  { kind: 'inner', from: 'server/js/panel.js', file: 'server/js/panel/apply.js', names: ['applyHubSettings'] },
] };
const TEXTS = { 'server/big.js': 'one\ntwo\nthree', 'server/part/judge.js': 'function isAllowed() {}' };
const repo = () => ({ tracked: TRACKED, moved: movedNames(LEDGER, BROWSER), read: (file) => TEXTS[file] ?? null });
const run = (file, text) => stalePointers([{ file, text }], repo()).map((row) => `${row.line} ${row.kind} ${row.what} -> ${row.now}`);

test('a path is found with its line, a URL and a pattern are not paths', () => {
  const found = mentionsOf('see server/big.js:12 and `js/panel.js`\nhttps://example.com/a/b.js and server/**/*.js and i18n/<code>.js');
  assert.deepEqual(found.map((m) => [m.line, m.text, m.lineNo]), [[1, 'server/big.js', 12], [1, 'js/panel.js', null]]);
});

test('two files written as one word are two files, the tail of a shortened name is none', () => {
  assert.deepEqual(mentionsOf('one.js/two.js').map((m) => m.text), ['one.js', 'two.js']);
  assert.deepEqual(mentionsOf('tile-decor-frame/-overlays/-extras.js'), []);
});

test('only the comments of a script are read, on their own lines', () => {
  const text = commentsOf("const a = 'server/gone/a.js';\n// see server/gone/b.js\nrun(); // and server/gone/c.js\n/* server/gone/d.js\n   server/gone/e.js */\nconst url = 'x // server/gone/f.js';");
  assert.deepEqual(mentionsOf(text).map((m) => [m.line, m.text]), [[2, 'server/gone/b.js'], [3, 'server/gone/c.js'], [4, 'server/gone/d.js'], [5, 'server/gone/e.js']]);
});

test('a mention answers to the file beside it, to the path from the root, or to the end of a path', () => {
  assert.deepEqual(answersTo('./part/judge.js', 'server/big.js', TRACKED), ['server/part/judge.js']);
  assert.deepEqual(answersTo('server/big.js', 'DEVELOPER.md', TRACKED), ['server/big.js']);
  assert.deepEqual(answersTo('js/panel.js', 'server/part/judge.js', TRACKED), ['server/js/panel.js']);
  assert.deepEqual(answersTo('shared/src/format.js', 'server/js/panel.js', TRACKED), ['packages/core/src/format.js']);
  assert.deepEqual(answersTo('../big.js', 'tools/x/tool.mjs', TRACKED), []);
});

test('a name is told where it lives today, not where it stopped on the way', () => {
  const moved = movedNames(LEDGER, BROWSER);
  assert.equal(moved.get('server/big.js').get('keepWrite'), 'server/part/store.js');
  assert.equal(moved.get('server/big.js').get('isAllowed'), 'server/part/judge.js');
  assert.equal(moved.get('server/js/panel.js').get('applyHubSettings'), 'server/js/panel/apply.js');
  assert.equal(moved.has('server/index.html'), false);
});

test('a file nothing answers to is gone, with the files of the same name', () => {
  assert.deepEqual(run('DEVELOPER.md', 'The check is in `server/judge.js`.'), ['1 gone server/judge.js -> server/part/judge.js']);
});

test('a line number past the end of the file is gone', () => {
  assert.deepEqual(run('DEVELOPER.md', 'server/big.js:3 holds, server/big.js:40 does not'), ['1 gone server/big.js:40 -> server/big.js has 3 lines']);
});

test('a name beside the file it left is moved, on the line or the one next to it', () => {
  assert.deepEqual(run('server/server.js', '// see isAllowed in big.js'), ['1 moved isAllowed in big.js -> server/part/judge.js']);
  assert.deepEqual(run('server/server.js', '// the settings are applied\n// by panel.js (applyHubSettings)'), ['2 moved applyHubSettings in panel.js -> server/js/panel/apply.js']);
});

test('a plain word is a name only when it is written as code', () => {
  assert.deepEqual(run('server/server.js', '// big.js is where we start'), []);
  assert.deepEqual(run('server/server.js', '// big.js calls `start` first'), ['1 moved start in big.js -> server/part/judge.js']);
  assert.deepEqual(run('server/server.js', '// big.js runs start() first'), ['1 moved start in big.js -> server/part/judge.js']);
});

test('nothing is said where the new home is named, in the home itself, or of a made-up file', () => {
  assert.deepEqual(run('server/server.js', '// isAllowed left big.js for part/judge.js'), []);
  assert.deepEqual(run('server/part/judge.js', '// isAllowed came out of big.js'), []);
  assert.deepEqual(run('server/server.js', '// like `./x.js` or settings.json or src/hub-file.js or server/data/notes.js'), []);
});

test('a web address is not a path of the repo', () => {
  assert.deepEqual(mentionsOf('see nodejs.org/api/modules.html and docs.example.com/guide/a.html'), []);
});

test('a document is read by the paragraph: the name may stand lines away, never past an empty line', () => {
  const far = 'The store is `server/big.js`.\nline\nline\nline\nIt asks `isAllowed` first.';
  const wide = (text) => stalePointers([{ file: 'notes.md', text }], { ...repo(), reach: 6 }).map((row) => row.what);
  assert.deepEqual(run('notes.md', far), []);
  assert.deepEqual(wide(far), ['isAllowed in server/big.js']);
  assert.deepEqual(wide('The store is `server/big.js`.\n\nIt asks `isAllowed` first.'), []);
});

test('the same pointer is listed once', () => {
  assert.equal(run('DEVELOPER.md', 'server/judge.js and again server/judge.js').length, 1);
});
