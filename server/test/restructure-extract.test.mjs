// Taking declarations out of a file (tools/restructure): the moved text is the
// same bytes, the old file changes only where the plan says, and what cannot be
// moved safely is refused with a reason.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { planExtraction, Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const BUILT_IN = new Set(['fs', 'path', 'os']);
// The old file is server/demo.js, the new one server/part/x.js: one folder deeper.
const rewrite = (spec) => (BUILT_IN.has(spec) ? { spec: `node:${spec}`, kind: 'builtin', file: null }
  : { spec: `.${spec}.js`, kind: 'file', file: `server/${spec.slice(2)}.js` });

function plan(text, names, more = {}) {
  return planExtraction({ text, analysis: analyze(text, parser, 'server/demo.js'), names, source: 'server/demo.js',
    target: 'server/part/x.js', about: 'What the part does.', rewrite, ...more });
}
const refusal = (text, names, more) => {
  try { plan(text, names, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveMove({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made });

const SOURCE = ['const path = require("path");', 'const { clean, other } = require("./lib");', 'let seen = 0;', '',
  '// Joins and cleans.', 'function tidy(a) {', '  return clean(path.join(a, SEP));', '}', '', 'const SEP = "/";',
  'function count() { seen += 1; return other(seen); }', 'function run(a) { count(); return tidy(a); }', ''].join('\n');

test('the moved text is unchanged, the module gets its requires and exports, the old file one require', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['tidy', 'SEP']);
  assert.equal(made.moduleText, ['// What the part does.', '', "const path = require('node:path');", "const { clean } = require('../lib.js');", '',
    '// Joins and cleans.', 'function tidy(a) {', '  return clean(path.join(a, SEP));', '}', '', 'const SEP = "/";', '',
    'module.exports = { tidy, SEP };', ''].join('\n'));
  assert.equal(made.newSource, ['const { other } = require("./lib");', 'let seen = 0;', '',
    "const { tidy } = require('./part/x.js');", '',
    'function count() { seen += 1; return other(seen); }', 'function run(a) { count(); return tidy(a); }', ''].join('\n'));
  assert.deepEqual(made.imported, ['tidy'], 'the old file asks back only for what it still uses');
  assert.ok(!made.newSource.includes('require("path")'), 'a built-in module nothing uses any more is not required for nothing');
  assert.deepEqual(proven(SOURCE, made), []);
});

test('a required name only the moved code used leaves the old file, the module stays required', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = ['const { a } = require("./lib");', 'const {', '  b,', '  c,', '} = require("./more");', 'const made = require("./made");',
    'function f() { return a() + c() + made.go(); }', 'function g() { return f() + b(); }', ''].join('\n');
  const hand = plan(text, ['f']);
  assert.deepEqual(hand.newSource.split('\n').slice(0, 6), ['require("./lib");', 'const {', '  b,', '} = require("./more");', 'require("./made");',
    "const { f } = require('./part/x.js');"], 'the load order of ./lib and ./made is what it was');
  assert.deepEqual(proven(text, hand), []);
  const own = plan(text, ['f'], { ownModules: new Set(['server/made.js', 'server/more.js']) });
  assert.deepEqual(own.newSource.split('\n').slice(0, 3), ['require("./lib");', "const { b } = require(\"./more\");", "const { f } = require('./part/x.js');"],
    'a module the tool made itself has nothing to run: its line is rewritten, or goes');
  assert.deepEqual(proven(text, own), []);
});

test('the new require goes before the first statement that may use a moved name while the file loads', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = ['const table = build();', 'function helper() { return 1; }', 'function build() { return helper(); }',
    'function later() { return helper(); }', ''].join('\n');
  const made = plan(text, ['helper']);
  assert.equal(made.newSource.split('\n')[0], "const { helper } = require('./part/x.js');", 'a function was callable from line 1: so is its require');
  assert.deepEqual(proven(text, made), []);
  const late = ['const table = build();', 'const lib = require("./lib");', 'function helper() { return lib.one(); }',
    'function build() { return helper(); }', ''].join('\n');
  assert.match(refusal(late, ['helper']), /it would load earlier than today/);
});

test('what is not safe is refused, each with its reason', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE, ['nope']), /nope is not a top-level declaration/);
  assert.match(refusal(SOURCE, ['seen']), /seen is reassigned and server\/demo\.js still uses it/);
  assert.match(refusal(SOURCE, ['run']), /needs count \(line 11\), tidy \(line 6\).*circular require read at load time/s);
  const state = ['let seen = 0;', 'function count() { seen += 1; return seen; }', 'function run() { return count(); }',
    'function peek() { return seen; }', 'setTimeout(() => run() + peek(), 1);', ''].join('\n');
  assert.match(refusal(state, ['run'], { withDeps: true }), /seen is reassigned and server\/demo\.js still uses it: a require would hand over a copy/);
  assert.match(refusal(SOURCE, ['tidy', 'SEP'], { protectedNames: new Set(['SEP']) }), /SEP .* security prelude and stays/);
  assert.match(refusal(SOURCE, ['tidy', 'SEP'], { maxLines: 5 }), /would be 13 lines, the limit for a new file is 5/);
  assert.match(refusal(SOURCE, ['tidy', 'SEP'], { about: ' ' }), /say in one sentence what the new file does/);
  assert.match(refusal('function dead() {}\nfunction live() {}\nlive();\n', ['dead']), /nothing left in server\/demo\.js uses dead/);
  assert.match(refusal('const HOME = process.cwd();\nfunction f() { return HOME; }\n', ['HOME']), /runs code when the file loads/);
  assert.match(refusal('function f() { return __dirname; }\nf();\n', ['f']), /uses __dirname/);
  assert.match(refusal(SOURCE.replace(/\n/g, '\r\n'), ['tidy', 'SEP']), /Windows line endings/);
});

test('a variable moves only together with everything that uses it, and is not handed back', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = ['let seen = 0;', 'function count() { seen += 1; return seen; }', 'function run() { return count(); }',
    'setTimeout(() => run(), 1);', ''].join('\n');
  const made = plan(text, ['run'], { withDeps: true });
  assert.deepEqual(made.moved, ['seen', 'count', 'run']);
  assert.match(made.moduleText, /\nmodule\.exports = \{ count, run \};\n$/);
  assert.equal(made.newSource, "const { run } = require('./part/x.js');\nsetTimeout(() => run(), 1);\n");
  assert.deepEqual(proven(text, made), []);
});

test('the proof notices a changed byte, inside the moved text or outside it', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, ['tidy', 'SEP']);
  const bent = { ...made, moduleText: made.moduleText.replace('path.join(a, SEP)', 'path.join(a,  SEP)') };
  assert.match(proven(SOURCE, bent).join('\n'), /lines 5-9 of the old file are not in the new module unchanged/);
  const touched = { ...made, newSource: made.newSource.replace('let seen = 0;', 'let seen = 1;') };
  assert.match(proven(SOURCE, touched).join('\n'), /text outside the moved ranges changed/);
  const extra = { ...made, moduleText: made.moduleText.replace('module.exports', 'tidy("x");\nmodule.exports') };
  assert.match(proven(SOURCE, extra).join('\n'), /lines are not accounted for/);
  const widened = { ...made, newSource: made.newSource.replace('const { other } = require("./lib");', 'const { other, evil } = require("./lib");'),
    glue: { ...made.glue, edits: made.glue.edits.map((edit) => ({ ...edit, newLines: ['const { other, evil } = require("./lib");'] })) } };
  assert.match(proven(SOURCE, widened).join('\n'), /gained evil/);
});

test('the new require never lands inside a protected stretch: it goes just above it, or the move is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  // `start()` runs while the file loads and reaches `late`, so the require must come before it:
  // without the rule it would land between `guard` and `start()`, inside the stretch.
  const text = ['const first = 1;', 'function guard() { return first; }', 'function begin() { return late(); }', 'begin();',
    'function gate() { return guard(); }', 'function late() { return 2; }', 'function use() { return late() + gate(); }', ''].join('\n');
  const records = analyze(text, parser, 'server/demo.js').records;
  const at = (name) => records.findIndex((record) => record.names.includes(name));
  const open = plan(text, ['late']);
  assert.equal(open.newSource.split('\n')[3], "const { late } = require('./part/x.js');", 'with nothing protected: right before the call that needs it');
  const kept = plan(text, ['late'], { protectedStretches: [[at('guard'), at('gate')]] });
  assert.deepEqual(kept.newSource.split('\n').slice(0, 3), ['const first = 1;', "const { late } = require('./part/x.js');", ''],
    'above the stretch, which keeps every line it had');
  assert.ok(kept.newSource.includes(['function guard() { return first; }', 'function begin() { return late(); }', 'begin();',
    'function gate() { return guard(); }'].join('\n')), 'the stretch is in one piece');
  assert.deepEqual(proven(text, kept), []);
  assert.match(refusal(text, ['late'], { protectedStretches: [[-1, at('gate')]] }), /a protected stretch that is never edited/,
    'a stretch that starts with the file has no line above it');
});
