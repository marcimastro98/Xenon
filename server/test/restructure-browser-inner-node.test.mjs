// A browser script that Node loads too (the engine or a test requires it, or it says
// `module.exports`) is one file there, with no script before it and no window. The move
// itself always refused it; the lists of what may leave (`browser inner <script>` and
// `--survey`) used to count its functions as free all the same. They now say first that
// nothing leaves it, and who loads it.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { showInner } from '../../tools/restructure/browser-inner-cli.mjs';
import { renderSurvey, surveyAll } from '../../tools/restructure/browser-inner-survey.mjs';
import { nodeLoadWhy } from '../../tools/restructure/browser-node-loads.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const wrapper = (...inside) => ["'use strict';", '(function () {', ...inside, '})();', ''].join('\n');
const PURE = ['  function double(n) { return n * 2; }', '  function triple(n) { return n * 3; }'];
const FILES = {
  // Required by a file of the engine and by a test.
  'server/js/shared.js': wrapper(...PURE, "  if (typeof window !== 'undefined') window.Shared = { double };", "  if (typeof module !== 'undefined' && module.exports) module.exports = { double, triple };"),
  'server/sums.js': "'use strict';\nconst Shared = require('./js/shared.js');\nmodule.exports = Shared.double(2);\n",
  'server/test/shared.test.mjs': "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\nconst Shared = require('../js/shared.js');\nvoid Shared;\n",
  // Says it exports, though nobody requires it by a name written out.
  'server/js/words.js': wrapper(...PURE, "  if (typeof module !== 'undefined' && module.exports) module.exports = { double };"),
  // Only a page loads it; the comment that names `module.exports` is not code.
  'server/js/page-only.js': wrapper('  // Not for Node: there is no module.exports here.', ...PURE, '  window.PageOnly = { double, triple };'),
  'server/index.html': '<body>\n<script src="js/shared.js"></script>\n<script src="js/words.js"></script>\n<script src="js/page-only.js"></script>\n</body>\n',
  'tools/restructure/extracted-browser.json': '{ "moves": [] }\n',
};

function checkout(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-browser-inner-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(FILES)) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); }
  for (const args of [['init', '-q'], ['add', '-A']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  return root;
}

test('the reason names who requires the script, or the line where it exports; a script only pages load has none', (t) => {
  const root = checkout(t);
  const why = (file) => nodeLoadWhy(root, file, FILES[file]);
  assert.match(why('server/js/shared.js'), /^server\/js\/shared\.js is loaded by Node too \(required by server\/sums\.js:2, server\/test\/shared\.test\.mjs:3\): /);
  assert.match(why('server/js/shared.js'), /nothing leaves its wrapper for a script of its own$/);
  assert.match(why('server/js/words.js'), /it says `module\.exports` on line 5, though no tracked file requires it today/);
  assert.equal(why('server/js/page-only.js'), null);
});

test('`browser inner <script>` refuses such a script with that reason, and lists the functions of the others as before', { skip: parser ? false : SKIP }, (t) => {
  const root = checkout(t);
  const said = { log: [], error: [] };
  t.mock.method(console, 'log', (line) => said.log.push(String(line)));
  t.mock.method(console, 'error', (line) => said.error.push(String(line)));
  for (const file of ['server/js/shared.js', 'server/js/words.js']) {
    said.log.length = 0; said.error.length = 0;
    assert.equal(showInner(root, parser, { flags: {}, rest: [file] }), 1);
    assert.deepEqual(said.log, [], 'no list a person could act on');
    assert.equal(said.error.length, 1);
    assert.ok(said.error[0].startsWith(`${file} is loaded by Node too (`));
  }
  said.log.length = 0; said.error.length = 0;
  assert.equal(showInner(root, parser, { flags: {}, rest: ['server/js/page-only.js'] }), 0);
  assert.deepEqual(said.error, []);
  assert.match(said.log[0], /^server\/js\/page-only\.js: 7 lines, 2 functions in its wrapper \(3 lines\)\. 2 may leave/);
});

test('the survey counts nothing of such a script as free, and lists it with who loads it', { skip: parser ? false : SKIP }, (t) => {
  const root = checkout(t);
  const survey = surveyAll(root, parser, { moves: [] });
  const by = Object.fromEntries(survey.scripts.map((script) => [script.file, script]));
  assert.deepEqual([by['server/js/shared.js'].node, by['server/js/shared.js'].wrapped, by['server/js/words.js'].node], [true, false, true]);
  assert.equal(by['server/js/shared.js'].lines, 7);
  assert.deepEqual([by['server/js/page-only.js'].wrapped, by['server/js/page-only.js'].node, by['server/js/page-only.js'].free.functions], [true, undefined, 2]);
  const lines = renderSurvey(survey, true);
  assert.ok(lines.includes('Can leave today: 2 functions (3 lines), and 0 constants whose value is written out (0 lines).'), lines.join('\n'));
  assert.ok(lines.includes('Loaded by Node too, so nothing leaves them for a script of its own: 2.'));
  assert.ok(lines.some((line) => line.includes('server/js/shared.js is loaded by Node too (required by server/sums.js:2')));
  assert.ok(lines.some((line) => /Not a plain wrapper: 0 are handed values when called \(they stay whole\), 0 have no wrapper or are a module\./.test(line)));
});
