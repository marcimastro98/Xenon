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

import { moveBranches, surveyBranches } from '../../tools/restructure/branches.mjs';
import { planBranches, tableOf } from '../../tools/restructure/branches-plan.mjs';
import { readCall, readModule, requireLine } from '../../tools/restructure/branches-text.mjs';
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
  for (const [method, url, body] of [['GET', '/a'], ['POST', '/b', '{"ok":true,"file":"."}'], ['POST', '/b', '{}'], ['POST', '/b', '{'], ['GET', '/c'], ['GET', '/j'], ['GET', '/nowhere']]) {
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
    const added = moveBranches({ root, parser, source: OLD, target: TABLE, keys: ['POST /b', 'GET /j'] });
    assert.equal(added.added, false);
    assert.deepEqual(readLedger(root).branches, { [OLD]: [{ file: TABLE, about: 'What the lights answer.', keys: ['GET /a'], after: 0 }, { file: TABLE, about: '', keys: ['POST /b', 'GET /j'], after: 0 }] });
    assert.deepEqual(await answersOf(root), await answersOf(untouched), 'run for real, both handlers say the same');
    assert.equal((await answersOf(root))[0], 'GET /a ["{\\"a\\":7}"]');

    const fromStart = (_root, _rev, file) => (file === OLD ? SOURCE : null);
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromStart }), { problems: [], replayed: 2, files: [[OLD, TABLE]] });
    const fromOne = (_root, _rev, file) => afterOne[file] ?? null;
    assert.deepEqual(replay({ root, parser, base: 'BASE', show: fromOne }), { problems: [], replayed: 1, files: [[OLD, TABLE]] }, 'a table the revision has is taken from there and added to');
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
  assert.deepEqual([survey.branches, survey.moved, survey.movable.map((row) => row.key)], [10, 0, ['GET /a', 'POST /b', 'GET /g', 'GET /j']]);
  assert.deepEqual(survey.held, [{ name: 'helper', branches: 1, alone: 1, lines: 1 }]);
  assert.ok(survey.other.some((row) => row.reason === 'it uses … which the handler works out for itself' || /works out for itself/.test(row.reason)));
  const moved = surveyBranches({ parser, source: OLD,
    text: planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys: ['GET /a'], moduleBefore: null, rewrite, allowed: ALLOWED }).newSource });
  assert.deepEqual([moved.moved, moved.movable.map((row) => row.key)], [1, ['POST /b', 'GET /g', 'GET /j']]);
});

test('the real engine: every table on the list is there, and each of its bodies stands under one test of the handler', () => {
  const records = readLedger(REPO).branches?.['server/server.js'] ?? [];
  const engine = readFileSync(path.join(REPO, 'server', 'server.js'), 'utf8');
  const calls = engine.split('\n').map(readCall).filter(Boolean);
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
  assert.ok(!bodiesBack('server/server.js', engine).split('\n').some(readCall), 'read as text for the tests, every body is back under its test');
});
