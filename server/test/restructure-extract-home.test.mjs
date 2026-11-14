// A function that says `__dirname` can leave its file (tools/restructure, extract-home.mjs): the new module
// works out the old folder in one line and the moved lines say SERVER_DIR for it, the only moved text that
// changes. The proof puts the old word back, refuses any other change and works the line out for both kinds
// of path; `extract` records the step (`home`), `verify` redoes it, and the tests that read the engine as
// text get the old word back.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { extract, replay } from '../../tools/restructure/extract.mjs';
import { homeLine } from '../../tools/restructure/extract-home.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { homeLine as pathsHomeLine } from '../../tools/restructure/paths.mjs';
import { oldPathsText } from '../../tools/restructure/paths-undo.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT] = ['server/demo.js', 'server/part/x.js', 'What the part does.'];
const rewrite = (spec) => ({ spec, kind: 'builtin', file: null });
const read = (text) => analyze(text, parser, OLD, { fileOf: () => null });
const planOf = (text, names, target = NEW) => planExtraction({ text, analysis: read(text), names, source: OLD, target, about: ABOUT, rewrite });
const paths = { source: OLD, target: NEW, fileOf: () => null };
const proofOf = (text, plan, moduleText = plan.moduleText, where = paths) => proveMove({ before: text, after: plan.newSource, moduleText, plan, paths: where });
const record = (analysis, name) => analysis.bindings.get(name).record;

const TOOL = file("const path = require('path');", '', '// Where the tool is: next to __dirname or one up.', 'function toolPath(name) {',
  "  return [path.join(__dirname, name), path.join(__dirname, '..', name), __dirname];", '}', '',
  'function run() { return toolPath("x"); }', 'module.exports = { run };');

test('saying __dirname inside a function is all that ties it to the file, and it is not held back for it', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(file('function here() { return [__dirname, __dirname]; }', 'const now = { dir: __dirname };',
    'function both() { return require("./net")(__dirname); }', 'function named() { const SERVER_DIR = 1; return __dirname + SERVER_DIR; }',
    'function prop(x) { return x.__dirname; }', ''));
  assert.deepEqual(record(a, 'here').homeUses, [{ line: 0, column: 26 }, { line: 0, column: 37 }]);
  assert.equal(record(a, 'here').movable, true);
  assert.deepEqual(record(a, 'here').fileBound, ['__dirname'], 'what it uses is still said');
  const stuck = (name) => [record(a, name).homeUses, record(a, name).homeWhy, record(a, name).blockers.some((b) => b.code === 'bound-to-this-file')];
  assert.deepEqual(stuck('now'), [null, 'it reads __dirname while the file loads, not inside a function', true]);
  assert.deepEqual(stuck('both'), [null, '', true], 'two ties at once stay');
  assert.deepEqual(stuck('named'), [null, 'it already says SERVER_DIR, the word __dirname would become', true]);
  assert.deepEqual([record(a, 'prop').homeUses, record(a, 'prop').fileBound], [null, []], 'a property of that name is not the folder');
});

test('the word is respelled, the module works the old folder out in one line, and nothing else changes', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(TOOL, ['toolPath']);
  assert.equal(plan.moduleText, file('// What the part does.', '', "const path = require('path');", "const SERVER_DIR = path.join(__dirname, '..');", '',
    '// Where the tool is: next to __dirname or one up.', 'function toolPath(name) {',
    "  return [path.join(SERVER_DIR, name), path.join(SERVER_DIR, '..', name), SERVER_DIR];", '}', '', 'module.exports = { toolPath };'));
  assert.deepEqual(plan.glue.home, [{ at: 7, first: 4, column: 20 }, { at: 7, first: 4, column: 48 }, { at: 7, first: 4, column: 72 }]);
  assert.deepEqual(proofOf(TOOL, plan), []);
  // Two folders down, two steps up; the line is the one a module of places gets.
  assert.ok(planOf(TOOL, ['toolPath'], 'server/a/b/x.js').moduleText.includes("const SERVER_DIR = path.join(__dirname, '..', '..');"));
  for (const target of [NEW, 'server/a/b/x.js', 'tools/x.js']) assert.equal(homeLine(OLD, target), pathsHomeLine(OLD, target));
});

test('code that cannot work the folder out is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const bare = file('function here() { return __dirname; }', 'function run() { return here(); }', 'module.exports = { run };');
  assert.throws(() => planOf(bare, ['here']), /does not use `path`/);
  assert.throws(() => planOf(TOOL, ['toolPath'], 'server/x.js'), /is in the folder of server\/demo\.js/);
});

test('the proof refuses every other change', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(TOOL, ['toolPath']);
  const [first, ...rest] = plan.glue.home;
  const said = (problems) => problems.join('\n');
  assert.match(said(proofOf(TOOL, plan, plan.moduleText, null)), /the proof was not told where the two files are/);
  // A word that moved as it was: it would mean the folder of the new module.
  const unspelled = plan.moduleText.replace('path.join(SERVER_DIR, name)', 'path.join(__dirname, name)');
  assert.match(said(proofOf(TOOL, { ...plan, glue: { ...plan.glue, home: rest } }, unspelled)), /line 5: __dirname moves as it is, and means another folder in server\/part\/x\.js/);
  assert.match(said(proofOf(TOOL, plan, unspelled)), /line 8 of the new module does not say SERVER_DIR/);
  // The line that works the folder out: missing, twice, or leading somewhere else.
  const line = "const SERVER_DIR = path.join(__dirname, '..');";
  assert.match(said(proofOf(TOOL, plan, plan.moduleText.replace(line, '// gone'))), /does not work out the old folder in one line of its own/);
  assert.match(said(proofOf(TOOL, plan, plan.moduleText.replace(line, "const SERVER_DIR = path.join(__dirname, '..', '..');"))), /is not the folder of server\/demo\.js/);
  assert.match(said(proofOf(TOOL, plan, plan.moduleText.replace(line, 'const SERVER_DIR = __dirname;'))), /does not work out the old folder in one line of its own/);
  assert.match(said(proofOf(TOOL, plan, plan.moduleText, { ...paths, target: 'server/a/b/x.js' })), /is not the folder of server\/demo\.js/);
  // A respelled word that was something else, and any other change of the moved text.
  assert.match(said(proofOf(TOOL, { ...plan, glue: { ...plan.glue, home: [{ ...first, first: 3 }, ...rest] } })), /respells a __dirname that is not in a moved line there/);
  assert.match(said(proofOf(TOOL, plan, plan.moduleText.replace("'..', name", "'.', name"))), /not in the new module unchanged/);
  // A moved line that said SERVER_DIR before could not be told from a respelled one.
  const twice = TOOL.replace('__dirname];', '__dirname, "SERVER_DIR"];');
  assert.match(said(proofOf(twice, { ...plan, newSource: plan.newSource }, plan.moduleText.replace('SERVER_DIR];', 'SERVER_DIR, "SERVER_DIR"];'))), /line 5 says SERVER_DIR already/);
});

test('extract writes the module and records the step; the function finds the same folder; verify redoes it', (t) => {
  if (!parser) return t.skip(SKIP);
  const at = (name) => `server/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'xenon-extract-home-'));
  try {
    for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    const demo = file("'use strict';", "const path = require('path');", '// Where it is.', 'function beside(name) {', '  return path.join(__dirname, name);', '}', '',
      'function run(name) { return beside(name); }', 'module.exports = { run, here: __dirname };');
    writeFileSync(join(root, at('demo.js')), demo);

    const done = extract({ root, parser, source: at('demo.js'), target: at('remote-control/demo-beside.js'), about: ABOUT, names: ['beside'] });
    assert.deepEqual(done.moved, ['beside']);
    const made = readFileSync(join(root, at('remote-control/demo-beside.js')), 'utf8');
    assert.ok(made.includes("const SERVER_DIR = path.join(__dirname, '..');\n") && made.includes('  return path.join(SERVER_DIR, name);\n'));
    assert.deepEqual(readLedger(root).sources[at('demo.js')], [{ file: at('remote-control/demo-beside.js'), about: ABOUT, names: ['beside'], home: true }]);
    const loaded = createRequire(join(root, 'x.js'))(`./${at('demo.js')}`);
    assert.equal(loaded.run('tool.exe'), join(loaded.here, 'tool.exe'), 'the moved function names the same file');
    assert.equal(realpathSync(loaded.here), realpathSync(join(root, 'server')));
    // A reader of the engine as text gets the lines as the old file had them.
    assert.ok(oldPathsText(made).includes('  return path.join(__dirname, name);\n') && !oldPathsText(made).includes('SERVER_DIR'));

    const show = (_root, _rev, name) => ({ [at('demo.js')]: demo })[name] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[at('demo.js'), at('remote-control/demo-beside.js')]] });
    writeFileSync(join(root, at('remote-control/demo-beside.js')), made.replace('path.join(SERVER_DIR, name)', 'path.join(__dirname, name)'));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /demo-beside\.js is not what the tool writes/);
    writeFileSync(join(root, at('remote-control/demo-beside.js')), made);
    writeFileSync(join(root, LEDGER), readFileSync(join(root, LEDGER), 'utf8').replace(',"home":true', ''));
    assert.ok(!('home' in readLedger(root).sources[at('demo.js')][0]));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /the list does not say whether the move respells __dirname/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
