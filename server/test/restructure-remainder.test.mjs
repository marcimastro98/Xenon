// The planning side of tools/restructure: what is left in a file by feature, the
// names that can move now, and the order several extractions have to run in.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { orderJobs } from '../../tools/restructure/plan-order.mjs';
import { featuresOf, remainder, renderMovable, renderRemainder } from '../../tools/restructure/remainder.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const SOURCE = ['const weather = require("./weather");', 'let cache = null;', '',
  'function gate(req) { return req.ok; }', 'function weatherCity(raw) { return weather.clean(raw); }',
  'const NOTES_MAX = 5;', 'function notesTrim(list) { return list.slice(0, NOTES_MAX); }',
  'function readCache() { return cache; }', ''].join('\n');
const MAP = {
  ownerOfSpec: (spec) => (spec === './weather' ? 'weather' : null),
  words: new Map([['notes', 'time']]),
  kept: new Set(['gate']),
};

test('a declaration is filed under the module it requires, then the words in its name', (t) => {
  if (!parser) return t.skip(SKIP);
  const analysis = analyze(SOURCE, parser, 'demo.js');
  const features = new Map([...featuresOf(analysis, MAP)].map(([record, id]) => [record.names[0], id]));
  assert.equal(features.get('weatherCity'), 'weather');
  assert.equal(features.get('NOTES_MAX'), 'time');
  assert.equal(features.get('notesTrim'), 'time');
  assert.equal(features.get('gate'), 'engine-core', 'a protected name is the engine itself');
});

test('protected code has its own column and is never offered as movable', (t) => {
  if (!parser) return t.skip(SKIP);
  const analysis = analyze(SOURCE, parser, 'demo.js');
  const rows = remainder(analysis, MAP);
  const core = rows.find((row) => row.feature === 'engine-core');
  assert.equal(core.kept, 1, 'the one line of gate()');
  assert.equal(core.movable, 0);
  assert.match(renderRemainder(rows), /kept/);
  const listed = renderMovable(analysis, MAP);
  assert.match(listed, /weather: 1 declarations, 1 lines\n\s+5\s+1\s+weatherCity/);
  assert.match(listed, /time: 2 declarations, 2 lines/);
  assert.doesNotMatch(listed, /gate|readCache/, 'neither the protected name nor the one that reads shared state');
});

const PLAN_SOURCE = ['const LIMIT = 3;', 'function clamp(n) { return Math.min(n, LIMIT); }',
  'function size(list) { return clamp(list.length); }', 'function a() { return b(); }', 'function b() { return a(); }',
  'console.log(size([]), a);', ''].join('\n');

test('several extractions run dependencies first, whatever order the plan lists them in', (t) => {
  if (!parser) return t.skip(SKIP);
  const analysis = analyze(PLAN_SOURCE, parser, 'demo.js');
  const jobs = [{ to: 'x/size.js', names: ['size'] }, { to: 'x/clamp.js', names: ['clamp'] }, { to: 'x/limit.js', names: ['LIMIT'] }];
  assert.deepEqual(orderJobs(analysis, jobs).map((job) => job.to), ['x/limit.js', 'x/clamp.js', 'x/size.js']);
  const free = [{ to: 'x/one.js', names: ['LIMIT'] }, { to: 'x/two.js', names: ['a', 'b'] }];
  assert.deepEqual(orderJobs(analysis, free), free, 'jobs that do not need each other keep their order');
});

test('two new modules that need each other, or one name in two modules, are refused', (t) => {
  if (!parser) return t.skip(SKIP);
  const analysis = analyze(PLAN_SOURCE, parser, 'demo.js');
  assert.throws(() => orderJobs(analysis, [{ to: 'x/a.js', names: ['a'] }, { to: 'x/b.js', names: ['b'] }]),
    (error) => error instanceof Refusal && /circular require: x\/a\.js, x\/b\.js/.test(error.message));
  assert.throws(() => orderJobs(analysis, [{ to: 'x/a.js', names: ['LIMIT'] }, { to: 'x/b.js', names: ['LIMIT'] }]),
    (error) => error instanceof Refusal && /LIMIT is listed for x\/a\.js and for x\/b\.js/.test(error.message));
});
