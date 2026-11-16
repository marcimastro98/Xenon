// A change made on a release branch to a file this branch moved or split is carried into the file that holds those
// lines today (tools/restructure/port-upstream.mjs): found exactly once, or not written at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { filesToday, pathToday, placeHunks, readHunks } from '../../tools/restructure/port-upstream.mjs';

const DIFF = [
  'diff --git a/server/js/leaf.js b/server/js/leaf.js',
  '--- a/server/js/leaf.js',
  '+++ b/server/js/leaf.js',
  '@@ -3,3 +3,3 @@',
  '   function row(box) {',
  '-    box.textContent = 1;',
  '+    box.textContent = 2;',
  '   }',
  '@@ -10,2 +10,3 @@',
  '   function paint() {',
  '+    count += 1;',
  '   }',
  '\\ No newline at end of file',
].join('\n');

test('a diff is read into pieces: the old lines with their context, the new ones, where they began', () => {
  assert.deepEqual(readHunks(DIFF), [
    { old: ['  function row(box) {', '    box.textContent = 1;', '  }'], now: ['  function row(box) {', '    box.textContent = 2;', '  }'], at: 3 },
    { old: ['  function paint() {', '  }'], now: ['  function paint() {', '    count += 1;', '  }'], at: 10 },
  ]);
});

test('each piece goes to the one file that holds its lines, line ends kept', () => {
  const texts = {
    'server/js/leaf/rows.js': 'window.LeafRows = (wrapper) => {\r\n  function row(box) {\r\n    box.textContent = 1;\r\n  }\r\n};\r\n',
    'server/js/leaf.js': '(function () {\n  function paint() {\n  }\n})();\n',
  };
  const done = placeHunks(readHunks(DIFF), texts);
  assert.deepEqual(done.unplaced, []);
  assert.deepEqual(done.placed, [{ at: 3, file: 'server/js/leaf/rows.js' }, { at: 10, file: 'server/js/leaf.js' }]);
  assert.equal(done.texts['server/js/leaf/rows.js'], 'window.LeafRows = (wrapper) => {\r\n  function row(box) {\r\n    box.textContent = 2;\r\n  }\r\n};\r\n');
  assert.equal(done.texts['server/js/leaf.js'], '(function () {\n  function paint() {\n    count += 1;\n  }\n})();\n');
});

test('a piece found twice or nowhere is not placed; one already in is said to be', () => {
  const [row, paint] = readHunks(DIFF);
  const twice = '  function row(box) {\n    box.textContent = 1;\n  }\n';
  assert.match(placeHunks([row], { a: twice, b: twice }).unplaced[0].why, /stand in 2 places: a:1, b:1/);
  assert.match(placeHunks([row], { a: '  function row(box) {\n    box.textContent = 7;\n  }\n' }).unplaced[0].why, /stand nowhere/);
  const done = placeHunks([paint], { a: '  function paint() {\n    count += 1;\n  }\n' });
  assert.deepEqual([done.placed, done.already, done.unplaced], [[], [{ at: 10, file: 'a' }], []]);
});

test('the old path is followed through the moves and the splits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-port-upstream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'tools/restructure/browser-moved.json': JSON.stringify({ moves: [{ from: 'server/js/leaf.js', to: 'server/js/leaf/leaf.js' }] }),
    'tools/restructure/moved.json': JSON.stringify({ moves: [{ from: 'server/tree.js', to: 'server/tree/tree.js' }] }),
    'tools/restructure/extracted-browser.json': JSON.stringify({ moves: [{ kind: 'inner', from: 'server/js/leaf/leaf.js', file: 'server/js/leaf/leaf/rows.js' }] }),
    'tools/restructure/extracted.json': JSON.stringify({ sources: { 'server/tree/tree.js': [{ file: 'server/tree/branch.js' }] } }),
    'server/js/leaf/leaf.js': '', 'server/js/leaf/leaf/rows.js': '', 'server/tree/tree.js': '', 'server/tree/branch.js': '',
  };
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  assert.equal(pathToday(root, 'server/js/leaf.js'), 'server/js/leaf/leaf.js');
  assert.deepEqual(filesToday(root, 'server/js/leaf.js'), ['server/js/leaf/leaf.js', 'server/js/leaf/leaf/rows.js']);
  assert.deepEqual(filesToday(root, 'server/tree.js'), ['server/tree/tree.js', 'server/tree/branch.js']);
});

test('on this repo, an old path of a split script reaches its entry and every part', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
  const today = filesToday(root, 'server/js/topbar-minimal.js');
  assert.ok(today.includes('server/js/topbar/topbar-minimal.js'));
  assert.ok(today.includes('server/js/topbar/topbar-minimal/notch-cuts.js'));
});
