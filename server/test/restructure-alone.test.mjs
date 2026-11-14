// tools/restructure: when a module may be loaded earlier than the line that loads it today.
// alone.mjs loads a file in a world that holds only the language and writes down everything
// it reaches for; analyze.mjs and extract-plan.mjs let a move through only on that proof.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { createAloneTest, repoAloneTest } from '../../tools/restructure/alone.mjs';
import { analyze } from '../../tools/restructure/analyze.mjs';
import { planExtraction, Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const strict = (...lines) => ["'use strict';", ...lines, ''].join('\n');
const FILES = new Map(Object.entries({
  'm/plain.js': strict('const doubled = [1, 2].map((n) => n * 2);', 'module.exports = { doubled };'),
  'm/asks.js': strict("const node = typeof process !== 'undefined' && typeof window === 'undefined';", "if (typeof window !== 'undefined') window.Asks = node;",
    "if (typeof module !== 'undefined' && module.exports) module.exports = { node };"),
  'm/platform.js': strict("module.exports = { win: process.platform === 'win32' };"),
  'm/caught.js': strict('let pid = 0;', 'try { pid = process.pid; } catch { pid = -1; }', 'module.exports = { pid };'),
  'm/now.js': strict('module.exports = { at: Date.now() };'),
  'm/today.js': strict('module.exports = { at: new Date() };'),
  'm/epoch.js': strict('module.exports = { at: new Date(0).getTime(), is: new Date(5) instanceof Date };'),
  'm/dice.js': strict('module.exports = { id: Math.random() };'),
  'm/patch.js': strict('try { Array.prototype.last = function last() { return this[this.length - 1]; }; } catch { /* quiet */ }', 'module.exports = {};'),
  'm/global.js': 'globalThis.leak = 1;\nmodule.exports = {};\n',
  'm/sloppy.js': '(function () { this.leak = 1; })();\nmodule.exports = {};\n',
  'm/built.js': strict("const g = (() => {}).constructor('return this')();", 'module.exports = { pid: g.process && g.process.pid };'),
  'm/parent.js': strict('module.exports = { first: module.parent };'),
  'm/main.js': strict('module.exports = { main: require.main === module };'),
  'm/circle-a.js': strict("const b = require('./circle-b.js');", 'module.exports = { b };'),
  'm/circle-b.js': strict("const a = require('./circle-a');", 'module.exports = { a };'),
  'm/on-plain.js': strict("const { doubled } = require('./plain');", 'exports.sum = doubled.length;'),
  'm/on-platform.js': strict("const platform = require('./platform.js');", 'module.exports = { platform };'),
  'm/throws.js': strict("throw new Error('no');"),
  'm/promise.js': strict('Promise.resolve().then(() => process.title);', 'module.exports = {};'),
  'm/says.js': strict("console.log('loaded');", 'module.exports = {};'),
  'm/timer.js': strict('setInterval(() => {}, 10);', 'module.exports = {};'),
  'm/here.js': strict('module.exports = { here: __dirname };'),
  'm/missing.js': strict("module.exports = require('./nowhere.js');"),
  // What a moved-out module looks like: Node's own modules by name, declarations, one export.
  'm/declares.js': strict("const fs = require('node:fs');", "const { join } = require('path');", "const { EventEmitter } = require('events');",
    "const { doubled } = require('./plain.js');", '', 'const LIMIT = 3;', 'class Feed extends EventEmitter {}',
    'function read(name) { return fs.readFileSync(join(name, String(doubled[0])), "utf8").slice(0, LIMIT); }', '', 'module.exports = { read, LIMIT, Feed };'),
  'm/lazy-fs.js': strict("module.exports = { read: () => require('fs').readFileSync('x') };"),
  'm/joins.js': strict("const path = require('path');", "module.exports = { file: path.join('a', 'b') };"),
  'm/reads.js': strict("const { readFileSync } = require('node:fs');", "module.exports = { text: readFileSync('x', 'utf8') };"),
  'm/emits.js': strict("const { EventEmitter } = require('events');", 'module.exports = { bus: new EventEmitter() };'),
  'm/patches-fs.js': strict("const fs = require('fs');", 'fs.readFileSync = () => "";', 'module.exports = {};'),
  'm/package.js': strict("const ws = require('ws');", 'module.exports = { ws };'),
  'm/worker.js': strict("const { Worker } = require('node:worker_threads');", 'module.exports = { Worker };'),
}));
const read = (file) => FILES.get(file) ?? null;

test('a file that takes nothing from outside itself while it loads passes, loaded alone', () => {
  const alone = createAloneTest({ read });
  for (const file of ['m/plain.js', 'm/asks.js', 'm/epoch.js', 'm/on-plain.js']) assert.equal(alone(file), '', file);
});

test('everything a file reaches for while it loads is written down, also when it catches the error', () => {
  const alone = createAloneTest({ read });
  assert.equal(alone('m/platform.js'), 'm/platform.js uses process while it loads');
  assert.equal(alone('m/caught.js'), 'm/caught.js uses process while it loads', 'the catch hides nothing');
  assert.equal(alone('m/says.js'), 'm/says.js uses console while it loads');
  assert.equal(alone('m/timer.js'), 'm/timer.js uses setInterval while it loads');
  assert.equal(alone('m/built.js'), 'm/built.js uses process while it loads', 'code built from a string runs in the same world');
  assert.equal(alone('m/promise.js'), 'm/promise.js uses process while it loads', 'work left to a Promise runs before the verdict');
  assert.match(alone('m/here.js'), /m\/here\.js does not finish when it is loaded alone: __dirname is not defined/);
  assert.equal(alone('m/throws.js'), 'm/throws.js does not finish when it is loaded alone: no');
});

test('the clock and the dice are not the same at another moment', () => {
  const alone = createAloneTest({ read });
  assert.equal(alone('m/now.js'), 'm/now.js uses the clock (Date.now()) while it loads');
  assert.equal(alone('m/today.js'), 'm/today.js uses the clock (new Date()) while it loads');
  assert.equal(alone('m/dice.js'), 'm/dice.js uses Math.random() while it loads');
});

test('a change to the language or to the global names shows, slot by slot', () => {
  const alone = createAloneTest({ read });
  assert.equal(alone('m/patch.js'), 'loading m/patch.js changes Array.prototype');
  assert.equal(alone('m/global.js'), 'loading m/global.js changes the list of global names');
  assert.equal(alone('m/sloppy.js'), 'loading m/sloppy.js changes the list of global names');
});

test('require gives a file next to it, module gives exports, and neither gives anything else', () => {
  const alone = createAloneTest({ read });
  assert.match(alone('m/missing.js'), /^m\/missing\.js asks for "\.\/nowhere\.js" while it loads, which is neither a file next to it nor a module of Node/);
  assert.match(alone('m/package.js'), /^m\/package\.js asks for "ws" while it loads, which is neither/);
  assert.match(alone('m/worker.js'), /^m\/worker\.js asks for "node:worker_threads" while it loads, which is neither/, 'not on the list of modules that do nothing when loaded');
  assert.equal(alone('m/parent.js'), 'm/parent.js uses module.parent while it loads', 'who loaded it first is not the same at another moment');
  assert.equal(alone('m/main.js'), 'm/main.js uses require.main while it loads');
  assert.equal(alone('m/on-platform.js'), 'm/platform.js uses process while it loads', 'the file it asks for is loaded the same way');
  assert.match(alone('m/circle-a.js'), /m\/circle-a\.js is asked for while it is still loading: a circle of requires/);
  assert.equal(alone('m/nowhere.js'), 'm/nowhere.js is no file here');
});

test('a module of Node lends its names, and nothing of it can be used while the file loads', () => {
  const alone = createAloneTest({ read });
  assert.equal(alone('m/declares.js'), '', 'names taken, a class built on one of them, functions that will call them later');
  assert.equal(alone('m/lazy-fs.js'), '', 'a require inside a function is not run by loading');
  assert.equal(alone('m/joins.js'), 'm/joins.js uses path.join() while it loads');
  assert.equal(alone('m/reads.js'), 'm/reads.js uses fs.readFileSync() while it loads');
  assert.equal(alone('m/emits.js'), 'm/emits.js uses new events.EventEmitter() while it loads');
  assert.equal(alone('m/patches-fs.js'), 'm/patches-fs.js uses fs.readFileSync = while it loads');
});

// Moves out of server.js rest on these two: the modules made from it ask for them earlier than server.js did.
test('the layout rules the engine shares with the page load the same at any moment, the engine itself does not', () => {
  const alone = repoAloneTest();
  assert.equal(alone('server/js/dashboard-instances.js'), '');
  assert.equal(alone('server/js/dashboard-portrait.js'), '');
  assert.notEqual(alone('server/server.js'), '');
});

const rewrite = (spec) => (spec === 'path' ? { spec: 'node:path', kind: 'builtin', file: null } : { spec: `.${spec}.js`, kind: 'file', file: `server/${spec.slice(2)}.js` });
const rules = (proven) => ({ fileOf: (spec) => `server/${spec.slice(2)}.js`, early: (file) => (proven.includes(file) ? '' : `${file} is not proven`) });
const SOURCE = ['const hub = require("./hub");', 'const table = hub.create({ onEnd: () => save() });', 'const late = require("./late");',
  'function save() { return late.write(table); }', 'function other() { return late.read(); }', 'function user() { return other(); }', ''].join('\n');
const MOVING = ['const hub = require("./hub");', 'const table = hub.create(() => helper());', 'const late = require("./late");',
  'function helper() { return late.one(); }', 'function later() { return helper() + late.two(); }', ''].join('\n');
const plan = (text, names, analysis) => planExtraction({ text, analysis, names, source: 'server/demo.js', target: 'server/part/x.js',
  about: 'What the part does.', rewrite });

test('a module loaded further down holds a declaration back unless it is proven to load the same at any moment', (t) => {
  if (!parser) return t.skip(SKIP);
  const late = (analysis, name) => analysis.bindings.get(name).record.blockers.filter((blocker) => blocker.code === 'needs-a-module-loaded-later');
  const held = analyze(SOURCE, parser, 'server/demo.js', rules([]));
  assert.deepEqual(late(held, 'save').map((blocker) => blocker.names), [['late']]);
  const free = analyze(SOURCE, parser, 'server/demo.js', rules(['server/late.js']));
  assert.deepEqual(late(free, 'save'), []);
  assert.equal(free.anyTime(free.bindings.get('late').record), true);
  assert.equal(free.anyTime(free.bindings.get('save').record), false, 'only a require statement is ever proven');
  const nowhere = analyze(SOURCE, parser, 'server/demo.js', { fileOf: () => null, early: () => '' });
  assert.deepEqual(late(nowhere, 'save').map((blocker) => blocker.names), [['late']], 'a package or a file that is not there is never proven');
});

test('the proof is asked only for a module that is late: a file with none reads no other file', (t) => {
  if (!parser) return t.skip(SKIP);
  const asked = [];
  const text = ['const lib = require("./lib");', 'function one() { return lib.one(); }', 'one();', ''].join('\n');
  analyze(text, parser, 'server/demo.js', { fileOf: (spec) => `server/${spec.slice(2)}.js`, early: (file) => { asked.push(file); return ''; } });
  assert.deepEqual(asked, []);
});

test('a move that needs a late module is made when the module is proven, and refused when it is not', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.throws(() => plan(MOVING, ['helper'], analyze(MOVING, parser, 'server/demo.js', rules([]))),
    (error) => error instanceof Refusal && /it would load earlier than today/.test(error.reasons.join('\n')));
  const made = plan(MOVING, ['helper'], analyze(MOVING, parser, 'server/demo.js', rules(['server/late.js'])));
  const lines = made.newSource.split('\n');
  assert.ok(lines.indexOf("const { helper } = require('./part/x.js');") < lines.indexOf('const table = hub.create(() => helper());'),
    'the new require stands before the line that may call the moved function');
  assert.ok(lines.includes('const late = require("./late");'), 'the old file keeps its own require of the late module: it still uses it');
  assert.match(made.moduleText, /const late = require\('\.\.\/late\.js'\);/);
  assert.deepEqual(proveMove({ before: MOVING, after: made.newSource, moduleText: made.moduleText, plan: made }), []);
});

test('a move that was already possible is made the same way, whatever is proven', (t) => {
  if (!parser) return t.skip(SKIP);
  const without = plan(SOURCE, ['other'], analyze(SOURCE, parser, 'server/demo.js', rules([])));
  const withProof = plan(SOURCE, ['other'], analyze(SOURCE, parser, 'server/demo.js', rules(['server/late.js', 'server/hub.js'])));
  assert.equal(withProof.newSource, without.newSource);
  assert.equal(withProof.moduleText, without.moduleText);
  const lines = without.newSource.split('\n');
  assert.ok(lines.indexOf("const { other } = require('./part/x.js');") > lines.indexOf('const late = require("./late");'), 'after the require of ./late, as before the rule');
});
