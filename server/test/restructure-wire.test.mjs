// Giving a run of statements the file works through at load a module of its own (tools/restructure wire): the
// statements go there as they are and in their order, the file requires the module on the line where the first
// stood, and what could change a value, its timing or who can call what is refused.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { quietModules } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { planWire, wireSpelled } from '../../tools/restructure/wire.mjs';
import { proveWire } from '../../tools/restructure/wire-proof.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

// The old file is server/demo.js, the new one server/part/x.js: one folder deeper.
const [OLD, NEW] = ['server/demo.js', 'server/part/x.js'];
const FILES = new Set(['server/make.js', 'server/log.js', 'server/extra.js']);
const fileOf = (spec, from) => {
  const base = path.posix.join(path.posix.dirname(from), spec);
  return [base, `${base}.js`].find((file) => FILES.has(file)) ?? null;
};
const rewrite = (spec, from, to) => {
  if (!spec.startsWith('.')) return { spec: `node:${spec.replace(/^node:/, '')}`, kind: 'builtin', file: null };
  const file = fileOf(spec, from);
  if (!file) throw new Error(`require('${spec}') in ${from} points at no file`);
  const relative = path.posix.relative(path.posix.dirname(to), file);
  return { spec: relative.startsWith('.') ? relative : `./${relative}`, kind: 'file', file };
};

const plan = (text, first, last, more = {}) => planWire({ text, parser, source: OLD, target: NEW, about: 'What the part does.', first, last, rewrite, ...more });
const refusal = (text, first, last, more) => {
  try { plan(text, first, last, more); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};
const proven = (text, made) => proveWire({ before: text, after: made.newSource, moduleText: made.moduleText, plan: made, parser, source: OLD, target: NEW, fileOf });

const SOURCE = ['const os = require("os");', "const { make, tune } = require('./make');", "const { log } = require('./log.js');", 'const unused = 1;', '',
  '// The first client.', "const one = make('one', () => os.EOL);", '// How often it was asked.', 'let asked = 0;',
  'function ask() { asked += 1; return one.name + asked; }', "log('made one');", '// The second, with more.',
  "const two = make('two', () => require('./extra').more(one));", '', 'function show() { return `${ask()} ${two.name} ${unused}`; }',
  'process.stdout.write(show());', ''].join('\n');

test('the run goes to the module unchanged and in its order, the file requires it where the first statement stood', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, 'one', 'two');
  const lines = SOURCE.split('\n');
  assert.equal(made.moduleText, ['// What the part does.', '', "const os = require('node:os');", "const { make } = require('../make.js');", "const { log } = require('../log.js');", '',
    ...lines.slice(5, 12), "const two = make('two', () => require('../extra.js').more(one));", '', 'module.exports = { ask, two };', ''].join('\n'));
  assert.equal(made.newSource, [...lines.slice(0, 5), "const { ask, two } = require('./part/x.js');", ...lines.slice(13)].join('\n'));
  assert.deepEqual(made.names, ['one', 'asked', 'ask', 'two']);
  assert.deepEqual(made.exports, ['ask', 'two'], 'only what the file still uses is handed back; the counter stays with the function that changes it');
  assert.deepEqual(wireSpelled(made), { '../extra.js': './extra' });
  assert.deepEqual(proven(SOURCE, made), []);
});

test('the file runs the same with the run in a module: same output, the same lines of the log in the same order', (t) => {
  if (!parser) return t.skip(SKIP);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'xenon-wire-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const made = plan(SOURCE, 'one', 'two');
  const write = (root, files) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
  };
  const shared = {
    'server/make.js': "module.exports = { make: (name, more) => { process.stdout.write(`make ${name};`); return { name, more }; }, tune: 1 };\n",
    'server/log.js': 'module.exports = { log: (text) => process.stdout.write(`${text};`) };\n',
    'server/extra.js': 'module.exports = { more: (one) => one.name };\n',
  };
  write(path.join(dir, 'old'), { ...shared, [OLD]: SOURCE });
  write(path.join(dir, 'new'), { ...shared, [OLD]: made.newSource, [NEW]: made.moduleText });
  const run = (root) => spawnSync(process.execPath, [path.join(dir, root, OLD)], { encoding: 'utf8', timeout: 20000 });
  const [was, now] = [run('old'), run('new')];
  assert.equal(was.status, 0, was.stderr);
  assert.equal(now.status, 0, now.stderr);
  assert.equal(was.stdout, 'make one;made one;make two;one1 two 1');
  assert.equal(now.stdout, was.stdout);
});

test('a run that reads the file, is written to from outside, or would hand out a stale value is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(refusal(SOURCE.replace('() => os.EOL', '() => unused'), 'one', 'two'), /line 7 uses unused of server\/demo\.js \(line 4\)/);
  assert.match(refusal(SOURCE.replace("const { log } = require('./log.js');\n", '').replace('process.stdout', "const { log } = require('./log.js');\nprocess.stdout"), 'one', 'two'),
    /uses log, which server\/demo\.js requires only at line \d+, below the run/);
  assert.match(refusal(SOURCE.replace('() => os.EOL', '() => __dirname'), 'one', 'two'), /uses __dirname, which means another thing in another file/);
  assert.match(refusal(SOURCE.replace('() => os.EOL', '() => this'), 'one', 'two'), /uses this/);
  assert.match(refusal(SOURCE.replace('${unused}', '${asked}'), 'one', 'two'), /asked is assigned again inside the run and read outside it/);
  assert.match(refusal(`${SOURCE}function reset() { asked = 0; }\n`, 'one', 'two'), /line 17 assigns asked, which the run declares/);
  assert.match(refusal(SOURCE, 'two', 'one'), /one stands above two/);
  assert.match(refusal(SOURCE, 'nobody'), /nobody is not a top-level declaration/);
  assert.match(refusal(["const { make } = require('./make');", "const lone = make('x');", ''].join('\n'), 'lone'), /nothing outside the run uses a name it declares/);
  assert.match(refusal(SOURCE, 'one', 'two', { protectedNames: new Set(['ask']) }), /line 10 is protected code and stays where it is/);
  assert.match(refusal(SOURCE.replace("log('made one');", "log('made one'); log('twice');"), 'one', 'two'), /shares its line with another statement/);
});

test('a function of the run that a statement above it can reach while the file loads is refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const early = SOURCE.replace('const unused = 1;', 'const unused = (() => { try { return ask(); } catch { return 1; } })();');
  assert.match(refusal(early, 'one', 'two'), /line 4 runs while the file loads and can reach a function of the run/);
  // Reached from below, the function is there already: the require stands above.
  assert.equal(refusal(SOURCE, 'one', 'two'), '');
});

test('the proof reads the three texts again and catches what the planner let through', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(SOURCE, 'one', 'two');
  const broken = (change) => proven(SOURCE, { ...made, ...change }).join('\n');
  assert.match(broken({ newSource: made.newSource.replace('const unused = 1;', 'const unused = 2;') }), /not the old text with the run replaced by one statement/);
  assert.match(broken({ moduleText: made.moduleText.replace("make('one'", "make('uno'") }), /line 7 is not in the new module unchanged/);
  assert.match(broken({ moduleText: made.moduleText.replace("require('../extra.js')", "require('../make.js')") }), /became require\('\.\.\/make\.js'\), which is not the same file/);
  assert.match(broken({ moduleText: made.moduleText.replace("const { make } = require('../make.js');", "const { make } = require('../extra.js');") }),
    /requires make otherwise than server\/demo\.js does above the run/);
  assert.match(broken({ moduleText: made.moduleText.replace("const { log } = require('../log.js');", "const log = console.log.bind(console);") }),
    /runs before the run and is not a require/);
  assert.match(broken({ moduleText: made.moduleText.replace('module.exports = { ask, two };', 'module.exports = { ask, two, asked };') }),
    /asked is not what the file requires|the file still uses|asked is assigned again/);
  assert.match(broken({ first: made.first + 1 }), /not whole statements of the old file|not the old text|is not a comment, its requires, the lines of the run and one export/);
  const written = `${SOURCE}function reset() { asked = 0; }\n`;
  assert.match(proveWire({ before: written, after: `${made.newSource}function reset() { asked = 0; }\n`, moduleText: made.moduleText, plan: made, parser, source: OLD, target: NEW, fileOf }).join('\n'),
    /assigns asked|still uses asked/);
});

test('the module of a run runs code when it loads: a later move never drops its require, nor lets it load earlier', () => {
  assert.deepEqual([...quietModules([{ file: 'server/a/moved.js' }, { file: NEW, wire: { first: 'one', last: 'two' } }, { file: 'server/b/lifted.js', lift: true }])], ['server/a/moved.js']);
});
