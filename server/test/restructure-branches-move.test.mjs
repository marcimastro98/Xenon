// Moving the bodies of routes out of the request handler, on disk (tools/restructure
// branches): the move is written and recorded, `verify` redoes it, the handler
// answers as before, and the tables of the real engine are what the list says.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moveBranches, renderSurvey, surveyBranches } from '../../tools/restructure/branches.mjs';
import { KINDS, ROUTES } from '../../tools/restructure/branches-kinds.mjs';
import { planBranches, tableOf } from '../../tools/restructure/branches-plan.mjs';
import { readCall, readModule, requireLine, typeLine } from '../../tools/restructure/branches-text.mjs';
import { replay } from '../../tools/restructure/extract.mjs';
import { LEDGER, PROTECTED, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { bodiesBack } from './engine-source.mjs';
import { ALLOWED, OLD, rewrite, SOURCE, TABLE } from './restructure-branches-fixture.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function demoRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'xenon-branches-'));
  for (const folder of ['server/http', 'tools/restructure', 'tools/map']) mkdirSync(path.join(root, folder), { recursive: true });
  writeFileSync(path.join(root, PROTECTED), '{ "files": { "server/demo.js": { "names": ["handleRequest"], "branches": ["handleRequest"] } } }\n');
  writeFileSync(path.join(root, 'tools', 'map', 'frozen-paths.json'), '{}\n');
  writeFileSync(path.join(root, 'server', 'lights-lib.js'), "module.exports = { count: () => 7, name: 'lamp' };\n");
  writeFileSync(path.join(root, 'server', 'late.js'), 'module.exports = { late: () => 1 };\n');
  writeFileSync(path.join(root, 'server', 'http', 'read-body.js'), "module.exports = { readBody: async (req) => req.body, sendFile: () => {} };\n");
  writeFileSync(path.join(root, OLD), SOURCE);
  return root;
}

// What the handler of a folder answers to a few requests, as text.
async function answersOf(root) {
  const { handleRequest } = createRequire(path.join(root, 'server', 'x.js'))('./demo.js');
  const out = [];
  for (const [method, url, body] of [['GET', '/a'], ['POST', '/b', '{"ok":true,"file":"."}'], ['POST', '/b', '{}'], ['POST', '/b', '{'], ['GET', '/c'], ['GET', '/g'], ['GET', '/j'], ['GET', '/k'], ['GET', '/nowhere']]) {
    const said = [];
    await handleRequest({ method, url, body }, { writeHead: (status) => said.push(status), end: (text) => said.push(text ?? '') });
    out.push(`${method} ${url} ${JSON.stringify(said)}`);
  }
  return out;
}

test('a move is written, recorded with its place in the order, redone by the replay, and the handler answers as before', async (t) => {
  if (!parser) return t.skip(SKIP);
  const [root, untouched] = [demoRepo(), demoRepo()];
  try {
    const dry = moveBranches({ root, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys: ['GET /a'], dryRun: true });
    assert.deepEqual([dry.keys, dry.added, existsSync(path.join(root, TABLE)), readFileSync(path.join(root, OLD), 'utf8') === SOURCE], [['GET /a'], true, false, true], 'a dry run writes nothing');
    moveBranches({ root, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys: ['GET /a'] });
    const afterOne = { [OLD]: readFileSync(path.join(root, OLD), 'utf8'), [TABLE]: readFileSync(path.join(root, TABLE), 'utf8'), [LEDGER]: readFileSync(path.join(root, LEDGER), 'utf8') };
    const added = moveBranches({ root, parser, source: OLD, target: TABLE, keys: ['POST /b', 'GET /j', 'GET /g', 'GET /c'] });
    assert.equal(added.added, false);
    assert.deepEqual(readLedger(root).branches, { [OLD]: [{ file: TABLE, about: 'What the lights answer.', keys: ['GET /a'], after: 0 }, { file: TABLE, about: '', keys: ['POST /b', 'GET /c', 'GET /g', 'GET /j'], after: 0 }] });
    assert.deepEqual(await answersOf(root), await answersOf(untouched), 'run for real, both handlers say the same');
    assert.equal((await answersOf(root))[0], 'GET /a ["{\\"a\\":7}"]');
    assert.deepEqual((await answersOf(root)).slice(4, 6), ['GET /c ["{\\"c\\":3,\\"limit\\":3}"]', 'GET /g ["{\\"g\\":1}"]'], 'a body handed a function, a const and a name required further down runs with them');

    const fromStart = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromStart }), { problems: [], replayed: 2, files: [[OLD, TABLE]] });
    const fromOne = (_root, _rev, file) => afterOne[file] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromOne }), { problems: [], replayed: 1, files: [[OLD, TABLE]] }, 'a table the revision has is taken from there and added to');
    assert.ok(readFileSync(path.join(root, TABLE), 'utf8').includes(typeLine(ROUTES, true)) && afterOne[TABLE].includes(typeLine(ROUTES)), 'the table says its functions may take names of the file once one of them does');
    // A hand edit in the same step as a move is seen, in the table and in the file.
    const table = readFileSync(path.join(root, TABLE), 'utf8');
    writeFileSync(path.join(root, TABLE), table.replace('lights.count()', 'lights.count() + 1'));
    assert.match(replay({ root, parser, base: 'BASE', show: fromOne }).problems.join('\n'), /server\/lights\/routes\.js is not what the tool writes/);
    writeFileSync(path.join(root, TABLE), table);
    writeFileSync(path.join(root, OLD), readFileSync(path.join(root, OLD), 'utf8').replace('const LIMIT = 3;', 'const LIMIT = 4;'));
    assert.match(replay({ root, parser, base: 'BASE', show: fromOne }).problems.join('\n'), /server\/demo\.js differs from BASE by more than the recorded moves/);
    // A file that is there and is not a table of ours is never written over.
    writeFileSync(path.join(root, 'server', 'lights', 'routes-own.js'), "'use strict';\nmodule.exports = { routes: {} };\n");
    assert.throws(() => moveBranches({ root, parser, source: OLD, target: 'server/lights/routes-own.js', about: 'x', keys: ['GET /c'] }), /exists and is not a table this command made/);
  } finally {
    for (const folder of [root, untouched]) rmSync(folder, { recursive: true, force: true });
  }
});

test('the survey says what can move and which name keeps the rest', (t) => {
  if (!parser) return t.skip(SKIP);
  const survey = surveyBranches({ text: SOURCE, parser, source: OLD });
  assert.deepEqual([survey.branches, survey.moved, survey.movable.map((row) => [row.key, row.own])], [11, 0, [['GET /a', []], ['POST /b', []], ['GET /c', ['LIMIT', 'helper']], ['GET /g', ['late']], ['GET /j', []]]]);
  assert.deepEqual(survey.bodies.map((row) => row.state), ['now', 'now', 'handed', 'kept', 'kept', 'kept', 'handed', 'kept', 'kept', 'now', 'kept'], 'every body is said: it moves, it moves with names handed over, or it stays');
  assert.deepEqual(survey.held, [{ name: 'turns', branches: 1, alone: 1, lines: 1 }]);
  const said = renderSurvey(survey, OLD, { bodies: true });
  for (const line of ['Move as they are: 3 bodies, 8 lines.', 'Move when their call hands them names of the file: 2 bodies, 2 lines, 3 different names.', '  GET /a (line 17, 2 lines): moves now',
    '  GET /c (line 27, 1 lines): moves with these handed names: LIMIT, helper', '  GET /k (line 43, 1 lines): stays: it needs turns, which cannot be handed over: it is declared with `let` (line 52), so it can change while a body runs']) {
    assert.ok(said.split('\n').includes(line), `the survey says: ${line}`);
  }
  assert.ok(!renderSurvey(survey, OLD).includes('Body by body'));
  assert.ok(survey.other.some((row) => row.reason === 'it uses … which the handler works out for itself' || /works out for itself/.test(row.reason)));
  const moved = surveyBranches({ parser, source: OLD,
    text: planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys: ['GET /a'], moduleBefore: null, rewrite, allowed: ALLOWED }).newSource });
  assert.deepEqual([moved.moved, moved.movable.map((row) => row.key)], [1, ['POST /b', 'GET /c', 'GET /g', 'GET /j']]);
});

test('the survey and the plan agree on a required name of a protected stretch that one body alone uses', (t) => {
  if (!parser) return t.skip(SKIP);
  // `fs` is used by POST /b alone, `lights` by GET /a and GET /j: with both protected, only the first keeps its body.
  const kept = new Set(['fs', 'lights']);
  const survey = surveyBranches({ text: SOURCE, parser, source: OLD, kept });
  const row = (key) => survey.bodies.find((body) => body.key === key);
  assert.deepEqual([row('POST /b').state, row('POST /b').reasons], ['kept', ['it alone uses fs, required in a protected stretch of the file that is never edited']]);
  assert.deepEqual([row('GET /a').state, row('GET /j').state], ['now', 'now'], 'a name two bodies use stays in use when one of them moves');
  assert.ok(survey.other.some((entry) => entry.reason === 'it alone uses … required in a protected stretch of the file that is never edited' && entry.branches === 1));
  const plan = (keys) => planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys, moduleBefore: null, rewrite, allowed: ALLOWED, protectedNames: kept });
  assert.throws(() => plan(['POST /b']), /only the moved code uses fs, required in a protected stretch/);
  assert.equal(plan(['GET /a']).keys.length, 1);
  assert.equal(surveyBranches({ text: SOURCE, parser, source: OLD }).bodies.find((body) => body.key === 'POST /b').state, 'now', 'without a protected list nothing is kept for it');
});

test('the real engine: every table on the list is there, and each of its bodies stands under one test of the handler', () => {
  const records = readLedger(REPO).branches?.['server/server.js'] ?? [];
  const engine = readFileSync(path.join(REPO, 'server', 'server.js'), 'utf8');
  const calls = engine.split('\n').flatMap((line) => KINDS.map((kind) => readCall(line, kind))).filter(Boolean);
  const tables = new Map();
  for (const record of records) tables.set(record.file, [...(tables.get(record.file) ?? []), ...record.keys]);
  for (const [file, keys] of tables) {
    const text = readFileSync(path.join(REPO, file), 'utf8');
    assert.ok(!text.includes('\r') && text.split('\n').length - 1 <= 300, `${file} has LF line endings and stays under 300 lines`);
    const local = tableOf('server/server.js', file).local;
    assert.deepEqual(readModule(text).entries.map((entry) => entry.key), keys, `${file} holds the recorded bodies in order`);
    assert.deepEqual(calls.filter((call) => call.local === local).map((call) => call.key).sort(), [...keys].sort(), `each body of ${file} is called once`);
    assert.ok(engine.includes(`\n${requireLine(local, `./${file.slice('server/'.length)}`)}\n`), `the engine requires ${file}`);
  }
  assert.equal(calls.length, [...tables.values()].flat().length, 'no call without a recorded body');
  assert.ok(!bodiesBack('server/server.js', engine).split('\n').some((line) => KINDS.some((kind) => readCall(line, kind))), 'read as text for the tests, every body is back under its test');
});
