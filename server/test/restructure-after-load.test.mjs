// A function that nothing runs while its file loads (tools/restructure/after-load.json):
// the request handler, which only a server of Node calls, when a request arrives. A
// body of it can then be handed any const of the file, wherever the file declares it.
// An entry counts only while every check on it passes.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { afterLoadFor } from '../../tools/restructure/after-load.mjs';
import { analyze } from '../../tools/restructure/analyze.mjs';
import { firstReach, ownRule } from '../../tools/restructure/branches-own.mjs';
import { planBranches } from '../../tools/restructure/branches-plan.mjs';
import { proveBranches } from '../../tools/restructure/branches-proof.mjs';
import { textHash } from '../../tools/restructure/load-registrations.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { ALLOWED, idOf, OLD, rewrite, SOURCE, TABLE } from './restructure-branches-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const swap = (text, from, to) => { assert.equal(text.split(from).length, 2, `the sample has ${JSON.stringify(from)} once`); return text.replace(from, () => to); };
const fileOf = (spec) => (spec.startsWith('./') ? `server/${spec.slice(2).replace(/(?:\.js)?$/, '.js')}` : null);
// The sample, with the handler given to a server above every const and exported no more.
const SERVE = 'lights.serve((req, res) => handleRequest(req, res));';
const KEPT = swap(swap(SOURCE, 'const LIMIT = 3;', `${SERVE}\nconst LIMIT = 3;`), 'module.exports = { handleRequest, helper', 'module.exports = { helper');
const entry = (more = {}) => ({ name: 'handleRequest', statements: [[SERVE, textHash(SERVE)]], read: ['server/lights-lib.js'],
  reason: 'serve keeps the function and calls it when a request arrives.', problem: '', ...more });
const read = (text, entries = [entry()]) => analyze(text, parser, OLD, { afterLoad: entries, fileOf });
const wrong = (text, entries) => read(text, entries).afterLoadProblems.join('\n');

test('with an entry that counts, nothing reaches the handler while the file loads', (t) => {
  if (!parser) return t.skip(SKIP);
  const held = read(KEPT, []);
  assert.equal(firstReach(held, 'handleRequest').line[0], 5, 'not listed: the line that hands the function over may run it at once');
  assert.match(ownRule(held, 'handleRequest').whyNot('LIMIT'), /^it gets its value on line 6, and line 5 may already run handleRequest/);
  const freed = read(KEPT);
  assert.deepEqual([[...freed.afterLoad], freed.afterLoadProblems], [['handleRequest'], []]);
  assert.equal(firstReach(freed, 'handleRequest'), null);
  const rule = ownRule(freed, 'handleRequest');
  assert.deepEqual([rule.whyNot('LIMIT'), rule.whyNot('late'), rule.whyNot('helper')], [null, null, null], 'a const has its value by the time a request arrives, wherever it is declared');
  assert.match(rule.whyNot('turns'), /^it is declared with `let`/, 'what can change while a body runs is still not handed');
  assert.deepEqual([rule.required('lights'), rule.required('late')], [true, false], 'and a module required below the handler is still handed, not required by the table');
});

test('a body that waits on a const below the line that serves the handler moves, and the proof reads the list again', (t) => {
  if (!parser) return t.skip(SKIP);
  const job = { text: KEPT, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys: ['GET /c', 'GET /g'], moduleBefore: null, rewrite, allowed: ALLOWED };
  assert.throws(() => planBranches({ ...job, analysis: read(KEPT, []) }), (error) => /GET \/c \(server\/demo\.js:\d+\): it needs LIMIT, which cannot be handed over/.test(error.reasons?.join('\n')));
  const made = planBranches({ ...job, analysis: read(KEPT) });
  assert.match(made.newSource, /await lightsBranches\['GET \/c'\]\(req, res, \{ json, err500, reqPath, urlObj, isRemote \}, \{ LIMIT, helper \}\);/);
  assert.match(made.moduleText, /'GET \/g': async \(_req, _res, \{ json \}, \{ late \}\) => \{/);
  const proof = (rules) => proveBranches({ before: KEPT, after: made.newSource, moduleBefore: null, moduleText: made.moduleText, plan: made, parser, source: OLD, target: TABLE, idOf, rules });
  assert.deepEqual(proof({ afterLoad: [entry()], fileOf }), []);
  assert.match(proof({ afterLoad: [], fileOf }).join('\n'), /GET \/c is handed LIMIT: it gets its value on line 6, and line 5 may already run handleRequest/, 'without the entry the same move is not proven');
});

test('an entry counts for nothing when the file says otherwise', (t) => {
  if (!parser) return t.skip(SKIP);
  assert.match(wrong(KEPT, [entry({ statements: [[SERVE, textHash(`${SERVE} `)]] })]), /^handleRequest: line 5 changed since it was read: read it again, then update its sha256$/);
  assert.match(wrong(`${KEPT}lights.later(() => handleRequest({}, {}));\n`), /^handleRequest: line 54 names it and is not in statements$/);
  assert.match(wrong(KEPT, [entry({ statements: [[SERVE, textHash(SERVE)], ['lights.gone(() => handleRequest());', 'x']] })]), /no statement that names it starts with "lights\.gone/);
  // The sample as it is exports the handler: whoever requires the file may call it.
  const exported = swap(SOURCE, 'const LIMIT = 3;', `${SERVE}\nconst LIMIT = 3;`);
  const last = exported.split('\n').find((line) => line.startsWith('module.exports'));
  assert.match(wrong(exported, [entry({ statements: [[SERVE, textHash(SERVE)], [last, textHash(last)]] })]), /^handleRequest: line 52 names it outside a function, so the line itself may run it or give it away$/);
  const named = 'function again() { return handleRequest; }';
  assert.match(wrong(`${KEPT}${named}\n`, [entry({ statements: [[SERVE, textHash(SERVE)], [named, textHash(named)]] })]), /line 54 declares something that names it, and anything may call that/);
  const wrapped = 'helper((req, res) => handleRequest(req, res));';
  assert.match(wrong(`${KEPT}${wrapped}\n`, [entry({ statements: [[SERVE, textHash(SERVE)], [wrapped, textHash(wrapped)]] })]), /line 54 hands a function to helper, which is not a module the file requires/);
  assert.match(wrong(KEPT, [entry({ read: [] })]), /^handleRequest: line 5 hands a function to lights, which is not from a file in read$/);
  assert.match(wrong(`${KEPT}lights.emit('request', {}, {});\n`), /the file emits 'request' by hand, which runs the listeners of a server at once/);
  assert.match(wrong(`${KEPT}handleRequest = null;\n`), /the file assigns it again after declaring it/);
  assert.match(wrong(KEPT, [entry({ name: 'nowhere' })]), /^nowhere: the file does not declare it at its top$/);
  assert.match(wrong(KEPT, [entry({ problem: 'server/lights-lib.js changed since it was read' })]), /^handleRequest: server\/lights-lib\.js changed since it was read$/);
  for (const text of [`${KEPT}lights.emit('request', {}, {});\n`, `${KEPT}handleRequest = null;\n`]) assert.equal(read(text).afterLoad.size, 0);
  assert.equal(read(KEPT, [entry({ read: [] })]).afterLoad.size, 0, 'and the handler is held as before');
});

test('an entry is current only while every file that was read is the text that was read', () => {
  const lib = 'exports.serve = (fn) => { kept = fn; };\n';
  const json = (more = {}) => ({ files: { [OLD]: [{ name: 'handleRequest', statements: { [SERVE]: textHash(SERVE) }, read: { 'server/lights-lib.js': textHash(lib) }, reason: 'serve keeps it.', ...more }] } });
  const of = (list, text = lib) => afterLoadFor(OLD, { json: list, read: () => text })[0];
  assert.deepEqual(of(json()), { name: 'handleRequest', statements: [[SERVE, textHash(SERVE)]], read: ['server/lights-lib.js'], reason: 'serve keeps it.', problem: '' });
  assert.match(of(json(), `${lib}kept();\n`).problem, /^server\/lights-lib\.js changed since it was read: read it again, then update its sha256$/);
  assert.equal(of(json(), lib.replace(/\n/g, '\r\n')).problem, '', 'line endings are not a change');
  assert.match(afterLoadFor(OLD, { json: json(), read: () => { throw new Error('gone'); } })[0].problem, /cannot be read/);
  for (const broken of [{ reason: '' }, { statements: {} }, { name: '' }, { read: { 'server/lights-lib.js': '' } }]) assert.match(of(json(broken)).problem, /^needs name, reason, statements/);
  assert.deepEqual(afterLoadFor('server/other.js', { json: json(), read: () => lib }), []);
});

test('the list in the repo explains itself, and every entry of it counts today', (t) => {
  const json = JSON.parse(readFileSync(new URL('../../tools/restructure/after-load.json', import.meta.url), 'utf8'));
  assert.match(json.note, /only after the file has loaded/);
  assert.match(json.note, /When in doubt, leave the function held/);
  for (const [file, entries] of Object.entries(json.files)) {
    for (const found of afterLoadFor(file)) {
      assert.equal(found.problem, '', `${file}: ${found.name}`);
      assert.ok(found.reason.length > 120, `${found.name}: the reason says who keeps the function and when they call it`);
    }
    assert.equal(new Set(entries.map((found) => found.name)).size, entries.length, 'one entry per function');
    if (!parser) continue;
    const a = analyze(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'), parser, file);
    assert.deepEqual(a.afterLoadProblems, [], `${file}: every entry finds its statements as they were read`);
    assert.deepEqual([...a.afterLoad], entries.map((found) => found.name));
    for (const found of entries) assert.equal(firstReach(a, found.name), null);
  }
  if (!parser) t.diagnostic(SKIP);
});
