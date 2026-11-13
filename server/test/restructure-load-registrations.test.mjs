// The second list of tools/restructure: load statements that only hand over
// functions (load-registrations.json). A listed statement stops holding what only
// its callbacks reach, and an entry counts only while every check on it passes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyze, toJson } from '../../tools/restructure/analyze.mjs';
import { planExtraction, Refusal } from '../../tools/restructure/extract-plan.mjs';
import { registrationsFor, textHash } from '../../tools/restructure/load-registrations.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { proveMove } from '../../tools/restructure/verify.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const fileOf = (spec) => (spec.startsWith('./') ? `server/${spec.slice(2)}.js` : null);
const listed = (statement, callees = ['server/early.js']) => [{ statement, callees, current: true }];
const read = (text, registrations = []) => analyze(text, parser, 'server/demo.js', { registrations, fileOf });
const record = (analysis, name) => analysis.bindings.get(name).record;
const codes = (analysis, name) => record(analysis, name).blockers.map((blocker) => blocker.code);

const HUB = 'const hub = early.create({ onEnd: () => save(), now: stamp });';
const SOURCE = ['const early = require("./early");', HUB, 'const late = require("./late");',
  'function save() { return late.write(1); }', 'function stamp() { return late.now(); }', ''].join('\n');

test('a listed statement frees what only the functions it hands over reach', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.deepEqual(codes(read(SOURCE), 'save'), ['needs-a-module-loaded-later'], 'not listed: the callback may run at once');
  const a = read(SOURCE, listed(HUB));
  assert.deepEqual(a.listProblems, []);
  assert.equal(record(a, 'save').movable, true, 'called only from inside the callback, which runs later');
  const [blocker] = record(a, 'stamp').blockers;
  assert.equal(blocker.code, 'needs-a-module-loaded-later', 'handed over by name: it has to exist on line 2, and its module with it');
  assert.equal(blocker.usedFromLine, 2);
});

test('another load statement that goes through a listed one still holds everything', (t) => {
  if (!parser) return t.skip(SKIP);
  const text = SOURCE.replace('const late', 'hub.start();\nconst late');
  const a = read(text, listed(HUB));
  assert.deepEqual(a.listProblems, []);
  assert.deepEqual(codes(a, 'save'), ['needs-a-module-loaded-later'], 'hub.start() is not on the list and may call onEnd');
});

test('an entry does not count when the statement calls or feeds something nobody read', (t) => {
  if (!parser) return t.skip(SKIP);
  const held = (statement, callees) => {
    const a = read(SOURCE.replace(HUB, statement), listed(statement, callees));
    assert.deepEqual(codes(a, 'save'), ['needs-a-module-loaded-later'], statement);
    return a.listProblems.join('\n');
  };
  assert.match(held('const hub = early.create({ onEnd: () => save(), id: stamp() });'), /it calls stamp, which is not from a file in callees/);
  assert.match(held('const hub = early.create({ onEnd: (() => save())() });'), /it calls save/, 'a function called in place runs now');
  assert.match(held('const hub = early.create({ list: [1].map((n) => save(n)) });'), /hands a function to a call the tool cannot name/);
  assert.match(held('const hub = early.create({ list: Object.keys({}).map((n) => save(n)) });'), /hands a function to Object/);
  assert.match(held('const hub = early.create({ onEnd: () => save() }, require("./more").wrap(() => save()));'),
    /it loads require\('\.\/more'\), which is not in callees/);
  assert.match(held(HUB, ['server/other.js']), /it calls early, which is not from a file in callees/);
  assert.match(held('const hub = early.create(late.wrap(() => save()));'), /it calls late.*it hands a function to late/);
  const tagged = 'const hub = early.create({ onEnd: () => save(), id: stamp`x` });';
  assert.match(held(tagged), /it calls stamp/, 'a tagged template is a call');
});

test('a module loaded in place is a callee like any other, and a Node module needs no entry', (t) => {
  if (!parser) return t.skip(SKIP);
  const statement = 'const hub = require("./early").create({ onEnd: () => save(), dir: path.join("a", "b"), power: require("./power") });';
  const text = `const path = require("path");\n${SOURCE.replace(HUB, statement)}`;
  const a = read(text, listed(statement, ['server/early.js', 'server/power.js']));
  assert.deepEqual(a.listProblems, []);
  assert.equal(record(a, 'save').movable, true);
});

test('an entry that names no statement, or more than one, counts for nothing', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(read(SOURCE, listed('const hub = early.make({')).listProblems[0], /0 load-time statements start with this line/);
  const twice = SOURCE.replace(HUB, 'early.on(() => save());\nearly.on(() => save());');
  const a = read(twice, listed('early.on(() => save());'));
  assert.match(a.listProblems[0], /2 load-time statements start with this line, one is needed/);
  assert.deepEqual(codes(a, 'save'), ['needs-a-module-loaded-later']);
  assert.deepEqual(toJson(a).listProblems, a.listProblems, '`analyze --json` carries them');
});

test('an entry is current only while every callee is the text that was read', () => {
  const files = { 'server/early.js': 'function create() {}\n', 'server/more.js': 'x\n' };
  const entry = { statement: 'const hub = early.create({', reason: 'create keeps what it is handed.',
    callees: { 'server/early.js': textHash(files['server/early.js']), 'server/more.js': textHash('x\r\n') } };
  const forFile = (json, read = (name) => { if (!(name in files)) throw new Error('absent'); return files[name]; }) => (
    registrationsFor('server/demo.js', { json: { files: { 'server/demo.js': [json] } }, read }));
  assert.deepEqual(forFile(entry), [{ statement: entry.statement, callees: ['server/early.js', 'server/more.js'], reason: entry.reason,
    current: true, problem: '' }], 'line endings do not change the fingerprint');
  const changed = forFile(entry, (name) => `${files[name]}// edited\n`);
  assert.equal(changed[0].current, false);
  assert.match(changed[0].problem, /server\/early\.js changed since it was read/);
  assert.match(forFile({ ...entry, callees: { 'server/gone.js': 'abc' } })[0].problem, /server\/gone\.js cannot be read/);
  for (const broken of [{ ...entry, reason: ' ' }, { ...entry, callees: {} }, { ...entry, callees: undefined }, { ...entry, statement: '' }]) {
    assert.match(forFile(broken)[0].problem, /needs statement, reason and callees/);
  }
  assert.deepEqual(registrationsFor('server/none.js', { json: { files: {} }, read: () => '' }), []);
});

test('an entry that is not current marks nothing', (t) => {
  if (!parser) return t.skip(SKIP);
  const a = read(SOURCE, [{ statement: HUB, callees: ['server/early.js'], current: false, problem: 'server/early.js changed since it was read' }]);
  assert.match(a.listProblems[0], /changed since it was read/);
  assert.deepEqual(codes(a, 'save'), ['needs-a-module-loaded-later']);
});

test('taking out what a listed statement freed leaves its require where the code was', (t) => {
  if (!parser) return t.skip(SKIP);
  const rewrite = (spec) => ({ spec: `.${spec}.js`, kind: 'file', file: `server/${spec.slice(2)}.js` });
  const plan = (registrations, names) => planExtraction({ text: SOURCE, analysis: read(SOURCE, registrations), names,
    source: 'server/demo.js', target: 'server/part/x.js', about: 'What the part does.', rewrite });
  const refusal = (registrations, names) => {
    try { plan(registrations, names); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
    return '';
  };
  assert.match(refusal([], ['save']), /it would load earlier than today/);
  const made = plan(listed(HUB), ['save']);
  assert.deepEqual(made.newSource.split('\n').slice(1, 4), [HUB, 'const late = require("./late");', "const { save } = require('./part/x.js');"]);
  assert.deepEqual(proveMove({ before: SOURCE, after: made.newSource, moduleText: made.moduleText, plan: made }), []);
  assert.match(refusal(listed(HUB), ['stamp']), /it would load earlier than today/, 'handed over by name on line 2: still refused');
});

test('the list in the repo explains itself, and every entry of it counts today', (t) => {
  const json = JSON.parse(readFileSync(new URL('../../tools/restructure/load-registrations.json', import.meta.url), 'utf8'));
  assert.match(json.note, /only keeps what it is handed/);
  assert.match(json.note, /When in doubt, leave the statement blocked/);
  for (const [file, entries] of Object.entries(json.files)) {
    for (const entry of registrationsFor(file)) {
      assert.equal(entry.problem, '', `${file}: ${entry.statement}`);
      assert.ok(entry.reason.length > 40, `${entry.statement}: the reason says what the callee does with what it is handed`);
    }
    assert.equal(new Set(entries.map((entry) => entry.statement)).size, entries.length, 'one entry per statement');
    if (!parser) continue;
    const a = analyze(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), parser, file);
    assert.deepEqual(a.listProblems, [], `${file}: every entry finds its statement and covers its calls`);
    assert.equal(a.records.filter((r) => r.registersOnly).length, entries.length);
  }
  if (!parser) t.diagnostic(SKIP);
});
