// A file that already sits in a feature folder can be taken apart too (tools/restructure
// extract): what leaves it stays next to it, the requires are spelled from the new
// place, the move is recorded and redone like any other, and the code answers as before.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extract, replay } from '../../tools/restructure/extract.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { homeOf, targetReasons } from '../../tools/restructure/target-rules.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// A folder the map owns whole, so a new file in it has an owner on the day it is made.
const OLD = 'server/remote-control/demo.js';
const NEW = 'server/remote-control/demo-tidy.js';
const SOURCE = ["'use strict';", "const path = require('path');", "const { clean } = require('../lib');", "const { near } = require('./near');", '',
  '// Joins and cleans.', 'function tidy(a) {', '  return clean(path.posix.join(a, SEP)) + near();', '}', '', "const SEP = 'x';", '',
  'function run(a) { return tidy(a); }', '', 'module.exports = { run, tidy };', ''].join('\n');

const reasons = (source, target) => targetReasons({ root: REPO, source, target }).join('\n');

test('the folder of a new module: one level down from the engine folder, next to a file that is in a feature folder', () => {
  assert.deepEqual(homeOf('server/server.js'), { home: 'server', feature: null });
  assert.deepEqual(homeOf('server/actions/registry.js'), { home: 'server', feature: 'actions' });
  assert.deepEqual(homeOf('server/remote-control/tailscale.js'), { home: 'server', feature: 'remote-control' });
  assert.deepEqual(homeOf('tools/restructure/cli.mjs'), { home: 'tools/restructure', feature: null }, 'only the engine folder has features');
});

test('what is taken out of a file in a feature folder stays in that folder, one level deep', () => {
  const from = 'server/remote-control/tailscale.js';
  for (const target of ['server/remote-control/deep/x.js', 'server/paired/x.js', 'server/x.js', 'server/remote-control/someFile.js',
    'server/remote-control/x.mjs', 'tools/remote-control/x.js']) {
    assert.match(reasons(from, target), /is not server\/remote-control\/<file>\.js in lowercase kebab-case: .* stays next to it/, target);
  }
  assert.equal(reasons(from, 'server/remote-control/a-name-nothing-has-yet.js'), '');
  assert.match(reasons(from, 'server/remote-control/installer.js'), /exists already: give the new module its own file/);
  assert.match(reasons('server/actions/registry.js', 'server/actions/a-name-nothing-has-yet.js'), /no feature owns .*tools\/map\/features\.json/,
    'a folder shared by several features still asks for an owner by name');
  assert.match(reasons('server/js/app.js', 'server/js/part.js'), /is served to the browser or holds tests/, 'a served folder is never a home for engine code');
  assert.match(reasons('server/server.js', 'server/weather.js'), /is not server\/<feature>\/<file>\.js in lowercase kebab-case$/, 'a file of the engine folder is asked what it always was');
});

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-feature-folder-'));
  for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), '{}\n');
  writeFileSync(path.join(root, PROTECTED), '{ "files": {} }\n');
  writeFileSync(path.join(root, 'server', 'lib.js'), 'module.exports = { clean: (text) => text.toUpperCase() };\n');
  writeFileSync(path.join(root, 'server', 'remote-control', 'near.js'), "module.exports = { near: () => '!' };\n");
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}
const answerOf = (root) => createRequire(path.join(root, 'server', 'x.js'))('./remote-control/demo.js').run('a');

test('a move out of a file in a feature folder is written next to it, recorded, redone by the replay, and runs as before', (t) => {
  if (!parser) return t.skip(SKIP);
  const [root, untouched] = [demoRepo(), demoRepo()];
  try {
    const job = { root, parser, source: OLD, target: NEW, about: 'Joins and cleans a name.', names: ['tidy', 'SEP'] };
    assert.throws(() => extract({ ...job, target: 'server/remote-control/tidy/demo.js' }), (error) => error instanceof Refusal && /stays next to it/.test(error.message));
    assert.throws(() => extract({ ...job, target: 'server/paired/demo-tidy.js' }), Refusal);
    assert.equal(existsSync(path.join(root, 'server', 'paired')), false, 'a refusal writes nothing');

    const done = extract(job);
    assert.deepEqual([done.moved, done.imported, done.target], [['tidy', 'SEP'], ['tidy'], NEW]);
    assert.equal(readFileSync(path.join(root, NEW), 'utf8'), ["'use strict';", '// Joins and cleans a name.', '', "const path = require('node:path');",
      "const { clean } = require('../lib.js');", "const { near } = require('./near.js');", '',
      '// Joins and cleans.', 'function tidy(a) {', '  return clean(path.posix.join(a, SEP)) + near();', '}', '', "const SEP = 'x';", '',
      'module.exports = { tidy, SEP };', ''].join('\n'), 'each require is spelled from the folder the code is in now');
    const left = readFileSync(path.join(root, OLD), 'utf8');
    assert.ok(left.includes("const { tidy } = require('./demo-tidy.js');"), 'the old file asks its neighbour for the name');
    assert.ok(!left.includes("\nrequire('"),'the two files only the moved code used only declare: their requires leave with it');
    assert.deepEqual(readLedger(root).sources, { [OLD]: [{ file: NEW, about: 'Joins and cleans a name.', names: ['tidy', 'SEP'], bare: ['../lib', './near'] }] });
    assert.equal(answerOf(root), answerOf(untouched), 'run for real, both give the same');
    assert.equal(answerOf(root), 'A/X!');

    const fromStart = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromStart }), { problems: [], replayed: 1, files: [[OLD, NEW]] });
    writeFileSync(path.join(root, NEW), readFileSync(path.join(root, NEW), 'utf8').replace("'x'", "'y'"));
    assert.match(replay({ root, parser, base: 'BASE', show: fromStart }).problems.join('\n'), /demo-tidy\.js is not what the tool writes/);
  } finally {
    for (const folder of [root, untouched]) rmSync(folder, { recursive: true, force: true });
  }
});
