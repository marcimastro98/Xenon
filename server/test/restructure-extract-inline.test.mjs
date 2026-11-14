// A function that asks for a module inside its body (`require('./net').arm(...)`) can leave its file
// (tools/restructure, extract-inline.mjs): the path is spelled again for the new folder and that is the
// only moved text that changes. The proof follows both spellings to the file they reach and refuses any
// other change; `extract` records the spellings, `verify` redoes them, and the tests that read the
// engine as text get the old spelling back.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { extract, replay } from '../../tools/restructure/extract.mjs';
import { spelledOf } from '../../tools/restructure/extract-inline.mjs';
import { planExtraction } from '../../tools/restructure/extract-plan.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';
import { oldSpellings } from './engine-source.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const file = (...lines) => `${lines.join('\n')}\n`;
const [OLD, NEW, ABOUT] = ['server/demo.js', 'server/part/x.js', 'What the part does.'];

// The files of a pretend repo: a path reaches one of them or nothing.
const FILES = new Set(['server/net.js', 'server/lib/tool.js', 'server/parent.js']);
const reach = (spec, from) => {
  const base = posix.join(posix.dirname(from), spec);
  return [base, `${base}.js`].find((name) => FILES.has(name)) ?? null;
};
const rewrite = (spec, from, to) => {
  if (!spec.startsWith('.')) return { spec, kind: 'package', file: null };
  const found = reach(spec, from);
  if (!found) throw new Error(`require('${spec}') in ${from} points at no file`);
  const relative = posix.relative(posix.dirname(to), found);
  return { spec: relative.startsWith('.') ? relative : `./${relative}`, kind: 'file', file: found };
};
const read = (text) => analyze(text, parser, OLD, { fileOf: (spec) => reach(spec, OLD) });
const planOf = (text, names, more = {}) => planExtraction({ text, analysis: read(text), names, source: OLD, target: NEW, about: ABOUT, rewrite, ...more });
const paths = { source: OLD, target: NEW, fileOf: reach };
const proofOf = (text, plan, moduleText = plan.moduleText, where = paths) => proveMove({ before: text, after: plan.newSource, moduleText, plan, paths: where });
const record = (analysis, name) => analysis.bindings.get(name).record;

const ARM = file('const limit = 4;', '', '// Arms it.', 'function arm(req) {', "  require('./net').arm(req, limit);", "  return require('ws') && require(\"./lib/tool.js\").ok(require('./net'));", '}', '',
  'function run(req) { return arm(req); }', 'module.exports = { run };');

const ALONE = ARM.replace('const limit = 4;', 'const other = 4;').replace('arm(req, limit)', 'arm(req, 4)');

test('asking for a module inside a function is all that ties it to the file, and it is not held back for it', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(file('function lazy() { return require("./net"); }', 'function lost() { return require("./nowhere"); }',
    'function odd() { return require.resolve("./net"); }', 'function made(name) { return require(name); }',
    'function here() { return require("./net")(__dirname); }', 'const now = { net: require("./net") };', 'function plain() { return require("ws"); }',
    'function shadow() { return { require: 1 }.require; }', ''));
  assert.deepEqual(record(a, 'lazy').inlineRequires, [{ from: './net', line: 0, column: 33 }]);
  assert.equal(record(a, 'lazy').movable, true);
  assert.deepEqual(record(a, 'lazy').fileBound, ['require'], 'what it uses is still said');
  assert.deepEqual(record(a, 'plain').inlineRequires, [], 'a package or a built-in module is asked for the same way from any folder');
  assert.equal(record(a, 'plain').movable, true);
  const stuck = (name) => [record(a, name).inlineRequires, record(a, name).inlineWhy, record(a, name).blockers.some((b) => b.code === 'bound-to-this-file')];
  assert.deepEqual(stuck('lost'), [null, "require('./nowhere') reaches no file", true]);
  assert.deepEqual(stuck('odd'), [null, "it uses require as something other than require('<text>')", true]);
  assert.deepEqual(stuck('made'), [null, "it uses require as something other than require('<text>')", true]);
  assert.deepEqual(stuck('here'), [null, '', true], '__dirname is another matter');
  assert.deepEqual(stuck('now'), [null, 'it asks for a module while the file loads, not inside a function', true]);
});

test('the paths are spelled for the new folder and nothing else of the moved text changes', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(ALONE, ['arm']);
  assert.equal(plan.moduleText, file('// What the part does.', '', '// Arms it.', 'function arm(req) {', "  require('../net.js').arm(req, 4);",
    "  return require('ws') && require(\"../lib/tool.js\").ok(require('../net.js'));", '}', '', 'module.exports = { arm };'));
  assert.deepEqual(plan.glue.respells, [{ at: 4, first: 4, column: 10, from: './net', to: '../net.js' },
    { at: 5, first: 5, column: 34, from: './lib/tool.js', to: '../lib/tool.js' }, { at: 5, first: 5, column: 62, from: './net', to: '../net.js' }]);
  assert.deepEqual(plan.asked, ['server/net.js', 'server/lib/tool.js']);
  assert.deepEqual(spelledOf(plan), { '../lib/tool.js': './lib/tool.js', '../net.js': './net' });
  assert.ok(plan.newSource.includes("const { arm } = require('./part/x.js');"));
});

test('a moved function keeps what it needs from the file by the old rules', (t) => {
  if (!parser) return t.skip(SKIP);
  // `limit` stays in the old file, so the function cannot go without it: asking for modules does not change that.
  assert.throws(() => planOf(ARM, ['arm']), /needs limit/);
});

test('the proof passes the respelled move and refuses every other change', (t) => {
  if (!parser) return t.skip(SKIP);
  const plan = planOf(ALONE, ['arm']);
  assert.deepEqual(proofOf(ALONE, plan), []);
  assert.match(proofOf(ALONE, plan, plan.moduleText, null).join('\n'), /the proof was not told where the two files are/);
  // A new spelling that reaches another file.
  const astray = plan.moduleText.replace("require('../net.js').arm", "require('../lib/tool.js').arm");
  const lied = { ...plan, glue: { ...plan.glue, respells: plan.glue.respells.map((row) => (row.at === 4 ? { ...row, to: '../lib/tool.js' } : row)) } };
  assert.match(proofOf(ALONE, lied, astray).join('\n'), /line 5: require\('\.\/net'\) is require\('\.\.\/lib\/tool\.js'\) in server\/part\/x\.js, which is not the same file/);
  // A path that moved as it was spelled: from the new folder it reaches nothing.
  const [, ...rest] = plan.glue.respells;
  const unspelled = plan.moduleText.replace("require('../net.js').arm", "require('./net').arm");
  assert.match(proofOf(ALONE, { ...plan, glue: { ...plan.glue, respells: rest } }, unspelled).join('\n'), /line 5: require\('\.\/net'\) is require\('\.\/net'\) in server\/part\/x\.js, which is not the same file/);
  // The module says something else than the plan at the place of a spelling.
  assert.match(proofOf(ALONE, plan, unspelled).join('\n'), /line 5 of the new module does not ask for '\.\.\/net\.js'/);
  // Any other change of the moved text is still a change.
  assert.match(proofOf(ALONE, plan, plan.moduleText.replace('arm(req, 4)', 'arm(req, 5)')).join('\n'), /not in the new module unchanged/);
  // A spelling changed in text that asks for nothing.
  const quoted = { ...plan, glue: { ...plan.glue, respells: [...plan.glue.respells, { at: 3, first: 3, column: 9, from: 'arm', to: 'arm' }] } };
  assert.ok(proofOf(ALONE, quoted).length > 0);
});

test('a module that asks who required it first is not asked for from another file', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = file('function who() { return require("./parent").name; }', 'function run() { return who(); }', 'module.exports = { run };');
  const readFile = (name) => (name === 'server/parent.js' ? 'module.exports = { name: module.parent.filename };\n' : null);
  assert.throws(() => planOf(text, ['who'], { readFile }), /server\/parent\.js reads module\.parent, which would be the new module/);
  assert.deepEqual(proofOf(text, planOf(text, ['who'], { readFile: () => '' })), []);
});

test('extract spells the path on disk and records it; the function loads the same file; verify redoes it', (t) => {
  if (!parser) return t.skip(SKIP);
  const at = (name) => `server/${name}`;
  const root = mkdtempSync(join(tmpdir(), 'xenon-extract-inline-'));
  try {
    for (const folder of ['server/remote-control', 'tools/restructure', 'tools/map']) mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, 'tools/map/frozen-paths.json'), '{}\n');
    writeFileSync(join(root, PROTECTED), '{ "files": {} }\n');
    const demo = file("'use strict';", '// Arms it.', 'function arm(n) {', "  return require('./net').arm(n);", '}', '', 'function run(n) { return arm(n); }', 'module.exports = { run };');
    writeFileSync(join(root, at('demo.js')), demo);
    writeFileSync(join(root, at('net.js')), file("'use strict';", 'module.exports = { arm: (n) => n + 1, me: module.filename };'));

    const done = extract({ root, parser, source: at('demo.js'), target: at('remote-control/demo-arm.js'), about: ABOUT, names: ['arm'] });
    assert.deepEqual(done.moved, ['arm']);
    const made = readFileSync(join(root, at('remote-control/demo-arm.js')), 'utf8');
    assert.ok(made.includes("  return require('../net.js').arm(n);"));
    assert.deepEqual(readLedger(root).sources[at('demo.js')], [{ file: at('remote-control/demo-arm.js'), about: ABOUT, names: ['arm'], spelled: { '../net.js': './net' } }]);
    const load = createRequire(join(root, 'x.js'));
    assert.equal(load(`./${at('demo.js')}`).run(1), 2, 'the moved function reaches the same module');

    const show = (_root, _rev, name) => ({ [at('demo.js')]: demo })[name] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show }), { problems: [], replayed: 1, files: [[at('demo.js'), at('remote-control/demo-arm.js')]] });
    // The module with the old spelling is not what the tool writes, and a list that forgot the spelling is not the tool's.
    writeFileSync(join(root, at('remote-control/demo-arm.js')), made.replace('../net.js', './net'));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /demo-arm\.js is not what the tool writes/);
    writeFileSync(join(root, at('remote-control/demo-arm.js')), made);
    writeFileSync(join(root, LEDGER), readFileSync(join(root, LEDGER), 'utf8').replace(',"spelled":{"../net.js":"./net"}', ''));
    assert.ok(!('spelled' in readLedger(root).sources[at('demo.js')][0]));
    assert.match(replay({ root, parser, base: 'BASE', show }).problems.join('\n'), /the list does not record the paths the move spells again/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a test that reads the engine as text gets the path as the old file spelled it', () => {
  const module = file("const { a } = require('../a.js');", 'function arm(req) {', "  require('../net-guard.js').armDeadline(req);", '  return require("../other.js");', '}');
  assert.equal(oldSpellings(module, { '../net-guard.js': './net-guard' }),
    file("const { a } = require('../a.js');", 'function arm(req) {', "  require('./net-guard').armDeadline(req);", '  return require("../other.js");', '}'));
});
