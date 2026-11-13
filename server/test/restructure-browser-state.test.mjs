// The guard for the browser files that tools/restructure has split. A split is
// only safe while every page loads the parts in a row, every new script runs
// nothing while it loads, and whoever reads the old file as text reads the parts.
// This test fails the day one of those stops being true, with the place to fix.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserSource, fileDeclaring, partsOf, readFileSync } from './browser-source.mjs';
import { builtListsWith, consumerProblems, keptNames, knownConsumers, mentionsOf, withoutComments } from '../../tools/restructure/browser-consumers.mjs';
import { readBrowserLedger, runOf, splitFiles } from '../../tools/restructure/browser-ledger.mjs';
import { firstReadCounts } from '../../tools/restructure/browser-cli.mjs';
import { compareRecordings } from '../../tools/restructure/browser-page-check.mjs';
import { stateProblems } from '../../tools/restructure/browser-state.mjs';
import { retarget } from '../../tools/restructure/browser-test-readers.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const ledger = readBrowserLedger(ROOT);

test('every split browser file still loads in a row, runs nothing new on load, and is read through the reader', (t) => {
  if (!parser) return t.skip('TypeScript is not installed here (npm run quality:install)');
  assert.deepEqual(stateProblems({ root: ROOT, parser }).problems, []);
});

test('every file the list of moves names is there, once', () => {
  const made = ledger.moves.flatMap((move) => (move.kind === 'style' ? move.parts.map((part) => part.file) : [move.file]));
  assert.deepEqual(made.filter((file, at) => made.indexOf(file) !== at), [], 'a file is the target of one move');
  assert.deepEqual([...made, ...ledger.moves.map((move) => move.from)].filter((file) => !fs.existsSync(path.join(ROOT, file))), []);
});

test('a declaration another file reads out of the old script stays in it', () => {
  for (const file of Object.keys(knownConsumers(ROOT))) {
    const moved = ledger.moves.filter((move) => move.kind === 'script' && move.from === file).flatMap((move) => move.names);
    for (const [name, consumer] of keptNames(ROOT, file)) {
      assert.ok(!moved.includes(name), `${name} left ${file}, where ${consumer} reads it`);
      assert.equal(fileDeclaring(name, file), file);
    }
    assert.deepEqual(Object.keys(knownConsumers(ROOT)[file]).filter((consumer) => !fs.existsSync(path.join(ROOT, consumer))), [],
      'a consumer that is gone leaves the list');
  }
});

test('the reader hands a test the parts in the order the page loads them', () => {
  const never = 'server/js/state.js';
  assert.deepEqual(partsOf(never), [never]);
  assert.equal(readFileSync(path.join(ROOT, never), 'utf8'), fs.readFileSync(path.join(ROOT, never), 'utf8'));
  assert.ok(Buffer.isBuffer(readFileSync(path.join(ROOT, never))), 'without an encoding it is the bytes, as node:fs gives them');
  assert.equal(readFileSync(new URL('./browser-source.mjs', import.meta.url), 'utf8'), fs.readFileSync(new URL('./browser-source.mjs', import.meta.url), 'utf8'));
  for (const file of splitFiles(ledger)) {
    const run = runOf(ledger, file);
    assert.deepEqual(partsOf(file), run);
    const whole = run.map((part) => fs.readFileSync(path.join(ROOT, part), 'utf8')).join('');
    assert.equal(browserSource(file), whole);
    assert.equal(readFileSync(path.join(ROOT, file), 'utf8'), whole, 'by absolute path');
    assert.equal(readFileSync(path.join(ROOT, file)).toString('utf8'), whole, 'as bytes');
    assert.equal(readFileSync(new URL(`../../${file}`, import.meta.url), { encoding: 'utf8' }), whole, 'by URL');
  }
});

test('a test moves to the reader by changing where readFileSync comes from, and nothing else', () => {
  const to = './browser-source.mjs';
  assert.equal(retarget("import { readFileSync } from 'node:fs';\nreadFileSync('a');\n", to), "import { readFileSync } from './browser-source.mjs';\nreadFileSync('a');\n");
  assert.equal(retarget("import { existsSync, readFileSync as read } from 'fs';\nread('a');\n", to),
    "import { existsSync } from 'fs';\nimport { readFileSync as read } from './browser-source.mjs';\nread('a');\n");
  assert.equal(retarget("import fs from 'node:fs';\nfs.readFileSync('a');\nfs.existsSync('a');\n", to),
    "import fs from 'node:fs';\nimport { readFileSync } from './browser-source.mjs';\nreadFileSync('a');\nfs.existsSync('a');\n");
  assert.equal(retarget("const { readFileSync } = await import('node:fs');\n", to), "const { readFileSync } = await import('./browser-source.mjs');\n");
  const done = "import { readFileSync } from './browser-source.mjs';\nreadFileSync('a');\n";
  assert.equal(retarget(done, to), done, 'a second run changes nothing');
  assert.equal(retarget("import fs from 'node:fs';\nconst readFileSync = (file) => fs.readFileSync(file);\n", to), null, 'left for a person');
  assert.equal(retarget("import { existsSync } from 'node:fs';\n", to), null);
});

test('a file named in a comment is not a use of it', () => {
  assert.equal(withoutComments('a(); // see settings.js\n/* settings.js */ b("https://example.com/settings.js");\n', 'x.js'),
    'a();                   \n                  b("https://example.com/settings.js");\n');
  assert.equal(withoutComments('<!-- settings.js -->\n<script src="js/settings.js"></script>\n', 'x.html'), '                    \n<script src="js/settings.js"></script>\n');
  assert.equal(withoutComments('{ "a": "// settings.js" }', 'x.json'), '{ "a": "// settings.js" }');
});

test('a browser file named in code somewhere new is caught before it is split', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-consumers-'));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  try {
    write('server/js/big.js', 'function big() {}\n');
    write('server/index.html', '<script src="js/big.js"></script>\n');
    write('server/test/old.test.mjs', "import { readFileSync } from 'node:fs';\nreadFileSync('server/js/big.js');\n");
    write('server/test/new.test.mjs', "import { readFileSync } from './browser-source.mjs';\nreadFileSync('server/js/big.js');\n");
    write('tools/build.mjs', "copy('js/big.js');\n");
    write('tools/listed.mjs', "patch('server/js/big.js');\n");
    write('tools/other.mjs', "// big.js is only named in this comment\ncopy('remote/big.js');\n");
    write('docs/notes.md', 'big.js is a large file.\n');
    write('server/components/Big/Big.css', '.big { color: red; }\n');
    write('server/styles/frame.css', '.frame { color: red; }\n');
    write('server/frame.html', '<link rel="stylesheet" href="styles/frame.css">\n');
    write('server/js/layer-tiles.js', "const name = 'Big';\nmodule.exports = { TILES: { big: { css: ['components/' + name + '/' + name + '.css'], js: [] } } };\n");
    write('tools/restructure/browser-consumers.json', JSON.stringify({ known: { 'server/js/big.js': { 'tools/listed.mjs': { how: 'Patches the last script.', keeps: ['big'] } } } }));
    for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
    assert.deepEqual(consumerProblems(root, 'server/js/big.js'), [
      'server/test/old.test.mjs:2 reads or names big.js without server/test/browser-source.mjs: read it through the reader, or say in tools/restructure/browser-consumers.json why it need not',
      'tools/build.mjs:1 names big.js in code: make it follow the split, then say how in tools/restructure/browser-consumers.json',
    ]);
    assert.equal(consumerProblems(root, 'server/js/big.js', { tests: false }).length, 1, 'the tests are moved over after the first split');
    assert.deepEqual([...keptNames(root, 'server/js/big.js')], [['big', 'tools/listed.mjs']]);
    assert.deepEqual(mentionsOf(root, 'server/components/Big/Big.css').map((mention) => [mention.file, mention.kind]), [['server/js/layer-tiles.js', 'list']],
      'a name put together in code is found by asking the list, not by searching for the name');
    assert.deepEqual(consumerProblems(root, 'server/components/Big/Big.css'), [], 'the tool writes the parts into the list itself, as it does with a page');
    assert.deepEqual(consumerProblems(root, 'server/styles/frame.css'),
      ['server/frame.html loads frame.css, and the page check never opens that page: add it to tools/restructure/browser-check-pages.mjs first']);
    assert.deepEqual(builtListsWith(ROOT, 'server/components/DiskWidget/DiskWidget.css'), ['server/js/layer-tiles.js'],
      'the pages for widgets on the desktop load the stylesheet of a tile by a name they build');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the lint numbers of a script that came out of a page are saved once, and only for that script', () => {
  const saved = { 'server/js/a.js rule/one': 2, 'server/js/out.js rule/old': 1 };
  const today = { 'server/js/a.js rule/one': 3, 'server/js/a.js rule/two': 1, 'server/js/out.js rule/old': 4, 'server/js/out.js rule/new': 2, 'server/js/b.js rule/one': 1 };
  const carried = firstReadCounts(saved, today, ['server/js/out.js']);
  assert.deepEqual(carried.next, { ...saved, 'server/js/out.js rule/new': 2 }, 'a number that is saved already never goes up this way');
  assert.deepEqual(carried.added, ['server/js/out.js rule/new: 2']);
  assert.deepEqual(firstReadCounts(saved, today, []), { next: saved, added: [] });
});

const view = (extra = {}) => ({ name: 'wide', pageErrors: ['old'], consoleErrors: ['one'], failedRequests: [], globals: ['a', 'b'],
  declared: { a: 'function', n: 'number' }, rules: 'same', ruleCount: 3, scripts: ['/js/a/one.js', '/js/a.js', '/js/b.js'],
  stylesheets: ['/styles/a.css', '/styles/a-two.css', '/styles/b.css'], ...extra });
const recording = (extra, settings = { opened: true, changed: true }) => ({ views: [view(extra)], settings });
const MOVES = { moves: [{ kind: 'script', from: 'server/js/a.js', file: 'server/js/a/one.js', about: '', names: ['a'] },
  { kind: 'style', from: 'server/styles/a.css', parts: [{ file: 'server/styles/a-two.css', at: 9 }] }] };

test('the page check says what a split changed in a page, and nothing when it changed nothing', () => {
  const before = recording();
  const diff = (extra, settings) => compareRecordings(before, recording(extra, settings), MOVES).join('\n');
  assert.equal(diff({}), '');
  const whole = recording({ scripts: ['/js/a.js', '/js/b.js'], stylesheets: ['/styles/a.css', '/styles/b.css'] });
  assert.deepEqual(compareRecordings(whole, before, MOVES), [],
    'the files a recorded split made, loaded next to the file they came from, are the point and not a difference');
  assert.match(compareRecordings(before, whole, MOVES).join('\n'), /wide: \/js\/a\.js and its parts do not load in a row: \/js\/a\.js\n/, 'a page that loads a split file without its parts');
  assert.match(diff({ scripts: ['/js/a.js', '/js/a/one.js', '/js/b.js'] }), /wide: \/js\/a\.js and its parts do not load in a row: \/js\/a\.js, \/js\/a\/one\.js/);
  assert.equal(diff({ scripts: ['/js/a/one.js', '/js/a.js'] }), 'wide: the scripts it loads changed: no longer /js/b.js');
  assert.equal(diff({ scripts: ['/js/a/one.js', '/js/a.js', '/js/b.js', '/js/new.js'] }), 'wide: the scripts it loads changed: new /js/new.js', 'a new file no recorded move made');
  assert.equal(diff({ stylesheets: ['/styles/b.css', '/styles/a.css', '/styles/a-two.css'] }), 'wide: it loads the same stylesheets in another order');
  assert.equal(diff({ pageErrors: ['old', 'x is not defined'] }), 'wide: new page error: x is not defined', 'an error the page had before the split is not the split');
  assert.match(diff({ consoleErrors: ['one', 'one'] }), /new console error: one/);
  assert.match(diff({ failedRequests: ['/js/gone.js 404'] }), /new failed request: \/js\/gone\.js 404/);
  assert.equal(diff({ refused: ['http://127.0.0.1:3030', 'https://example.com'] }), 'wide: asks another server of this PC, which the check refused: http://127.0.0.1:3030',
    'a site outside comes and goes with what the page shows; a recording made before the check refused anything has no list');
  assert.equal(compareRecordings(recording({ refused: ['http://127.0.0.1:3030'] }), recording({ refused: ['http://127.0.0.1:3030'] }), MOVES).join('\n'), '');
  assert.match(diff({ globals: ['a', 'c'] }), /no longer on window: b\n.*new on window: c/);
  assert.match(diff({ declared: { a: 'missing', n: 'number' } }), /top-level names that answer differently: a \(function -> missing\)/);
  assert.match(diff({ declared: { a: 'function' } }), /top-level names that answer differently: n \(number -> not there\)/);
  assert.match(diff({ rules: 'other', ruleCount: 2 }), /style rules of the linked stylesheets differ \(3 before, 2 now\)/);
  assert.match(diff({ widgets: 'clock' }), /the widgets on the page differ \(undefined before, clock now\)/);
  assert.equal(diff({ name: 'phone' }), 'wide: opened before, not opened now\nphone: not recorded before');
  assert.equal(diff({}, { opened: true, changed: false }), 'settings: "changed" failed');
});
