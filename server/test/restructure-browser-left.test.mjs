// `tools/restructure/browser-left.mjs` lists what is left of the browser scripts over the
// size limit, for the person who decides which ones to write again: lines, the biggest
// function, whether Node loads the script too, and what `browser inner` would still move.
// It only reads: the checkout is the same after a run.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { biggestFunction, leftOf, renderLeft } from '../../tools/restructure/browser-left.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const wrapper = (...inside) => ["'use strict';", '(function () {', ...inside, '})();', ''].join('\n');
const LONG = ['  function long(n) {', '    let sum = 0;', '    for (let i = 0; i < n; i += 1) sum += i;', '    return sum;', '  }'];
const FILES = {
  'server/js/page-only.js': wrapper('  function double(n) { return n * 2; }', ...LONG, '  window.PageOnly = { double, long };'),
  'server/js/shared.js': wrapper(...LONG, "  if (typeof module !== 'undefined' && module.exports) module.exports = { long };"),
  'server/sums.js': "'use strict';\nconst Shared = require('./js/shared.js');\nmodule.exports = Shared.long(2);\n",
  'server/js/loose.js': "'use strict';\nconst held = {\n  paint: () => {\n    return 1;\n  },\n};\nvoid held;\n",
  // Under the limit, so not in the baseline: never listed.
  'server/js/small.js': wrapper('  window.Small = 1;'),
  'server/index.html': '<body>\n<script src="js/page-only.js"></script>\n<script src="js/shared.js"></script>\n<script src="js/loose.js"></script>\n<script src="js/small.js"></script>\n</body>\n',
  'tools/restructure/extracted-browser.json': '{ "moves": [] }\n',
  'tools/quality/baseline/sizes.json': JSON.stringify({ limit: 300, files: { 'server/js/page-only.js': 10, 'server/js/shared.js': 9, 'server/js/loose.js': 7, 'server/sums.js': 3, 'apps/other.rs': 400 } }),
};

function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-left-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

test('the biggest function is named and measured; the wrapper of a script is not one', { skip: parser ? false : SKIP }, () => {
  assert.deepEqual(biggestFunction(FILES['server/js/page-only.js'], 'page-only.js', parser), { name: 'long', lines: 5, line: 4 });
  assert.deepEqual(biggestFunction(FILES['server/js/loose.js'], 'loose.js', parser), { name: 'paint', lines: 3, line: 3 });
  const handed = ['(function (root, factory) {', '  root.Thing = factory();', '})(this, function () {', '  const run = function () {', '    return 1;', '  };', '  return { run };', '});', ''].join('\n');
  assert.deepEqual(biggestFunction(handed, 'handed.js', parser), { name: 'run', lines: 3, line: 4 });
  assert.equal(biggestFunction("'use strict';\nwindow.Nothing = 1;\n", 'none.js', parser), null);
});

test('one row per server/js file of the sizes baseline, longest first, with what Node loads and what may still leave', { skip: parser ? false : SKIP }, (t) => {
  const root = checkout(t);
  const before = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  const rows = leftOf(root, parser);
  assert.deepEqual(rows.map((row) => [row.file, row.lines]), [['server/js/page-only.js', 10], ['server/js/shared.js', 9], ['server/js/loose.js', 7]]);
  const [page, shared, loose] = rows;
  assert.equal(page.node, null);
  assert.deepEqual(page.inner, { functions: 2, constants: 0, lines: 6 });
  assert.match(shared.node, /^server\/js\/shared\.js is loaded by Node too \(required by server\/sums\.js:2\)/);
  assert.deepEqual(shared.inner, { nothing: 'Node loads it too' });
  assert.equal(loose.node, null);
  assert.ok(loose.inner.nothing, 'a script with no wrapper gives nothing, with the reason');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout, before, 'nothing is written');

  const lines = renderLeft(rows);
  assert.match(lines[1], /^page-only\.js +10 {2}long 5 \(line 4\) +no {4}2 functions and 0 constants, 6 lines$/);
  assert.match(lines[2], /^shared\.js +9 {2}long 5 \(line 3\) +yes {3}nothing: Node loads it too$/);
  assert.equal(lines.at(-1), '3 scripts of server/js are over the limit (26 lines). Node loads 1 of them too. `browser inner` would still move 6 lines out of 1.');
  assert.match(renderLeft(rows, 1).at(-1), /^3 scripts of server\/js are over the limit \(26 lines\), the 1 longest shown\. /);
  assert.equal(renderLeft(rows, 1).length, 4);
});
