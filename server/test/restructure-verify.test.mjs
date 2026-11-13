// The checks around a move (tools/restructure): where a new module may live,
// which names never leave their file, and how the saved type and lint numbers
// follow code that moved without letting a new finding in.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from '../../tools/restructure/analyze.mjs';
import { protectedNames, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { carryCounts } from '../../tools/restructure/ratchets.mjs';
import { requireEditProblem } from '../../tools/restructure/require-edits.mjs';
import { targetReasons } from '../../tools/restructure/target-rules.mjs';
import { unknownNameProblems } from '../../tools/restructure/verify.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = 'server/server.js';
const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const reasons = (target, requires) => targetReasons({ root: ROOT, source: ENGINE, target, requires }).join('\n');

test('a new module lives in server/<feature>/<file>.js, lowercase with dashes', () => {
  for (const target of ['server/weather.js', 'server/weather/deep/x.js', 'server/Weather/x.js', 'server/weather/someFile.js',
    'server/weather/x.mjs', 'tools/weather/x.js']) {
    assert.match(reasons(target), /is not server\/<feature>\/<file>\.js in lowercase kebab-case/, target);
  }
  assert.equal(reasons('server/weather/a-name-nothing-has-yet.js'), '');
});

test('a folder cannot take the name of a file that installs already have', () => {
  for (const feature of ['lighting', 'phone', 'calls']) {
    assert.match(reasons(`server/${feature}/x.js`), new RegExp(`server/${feature}\\.js exists: .* can never become ${feature}/`), feature);
  }
});

test('served folders, existing files and folders nobody owns are refused', () => {
  for (const folder of ['js', 'styles', 'shared', 'vendor', 'test']) {
    assert.match(reasons(`server/${folder}/x.js`), /is served to the browser or holds tests/, folder);
  }
  assert.match(reasons('server/data/x.js'), /ignored by git: it would be missing from every install/);
  assert.match(reasons('server/actions/registry.js'), /exists already: give the new module its own file/);
  assert.match(reasons('server/a-folder-nobody-owns/x.js'), /no feature owns .*tools\/map\/features\.json/);
});

test('the names that never move are still where the list says', (t) => {
  if (!parser) return t.skip(SKIP);
  const { records } = analyze(readFileSync(join(ROOT, ENGINE), 'utf8'), parser, ENGINE);
  const kept = protectedNames(ROOT, ENGINE, records);
  assert.deepEqual(kept.missing, [], 'every anchor of protected.json is declared in server.js');
  for (const name of ['LOOPBACK_IPS', 'CSRF_MUTATION_PATHS', 'isAllowedRequest', 'remoteAccess', 'remoteAccessEnabled', '_remoteGate',
    'handleRequest', 'server']) {
    assert.ok(kept.names.has(name), `${name} is protected`);
  }
  const moved = (readLedger(ROOT).sources[ENGINE] ?? []).flatMap((entry) => entry.names);
  assert.deepEqual(moved.filter((name) => kept.names.has(name)), [], 'nothing protected was ever moved');
  assert.deepEqual(protectedNames(ROOT, 'server/other.js', records), { names: new Set(), missing: [] });
});

test('saved numbers follow the code, and a new finding does not hide in the move', () => {
  const files = ['server/a.js', 'server/a/part.js'];
  const baseline = { 'server/a.js TS2339': 5, 'server/a.js TS7006': 2, 'server/b.js TS2339': 9 };
  const moved = { 'server/a.js TS2339': 3, 'server/a/part.js TS2339': 2, 'server/a.js TS7006': 1, 'server/b.js TS2339': 4 };
  const carried = carryCounts(baseline, moved, files);
  assert.deepEqual(carried.problems, []);
  assert.deepEqual(carried.next, { 'server/b.js TS2339': 9, 'server/a.js TS2339': 3, 'server/a/part.js TS2339': 2, 'server/a.js TS7006': 1 },
    'the group gets today\'s numbers, a file outside it keeps its saved one');
  const worse = carryCounts(baseline, { ...moved, 'server/a/part.js TS2339': 3 }, files);
  assert.deepEqual(worse.problems, ['TS2339: 5 before the move, 6 after, across server/a.js and its modules']);
  const fresh = carryCounts(baseline, { ...moved, 'server/a/part.js TS2551': 1 }, files);
  assert.match(fresh.problems.join('\n'), /TS2551: 0 before the move, 1 after/);
});

test('a name that lost its declaration is caught, an old one is not blamed on the move', () => {
  const files = ['server/a.js', 'server/a/part.js'];
  assert.deepEqual(unknownNameProblems({ 'server/a.js TS2304': 1, 'server/a/part.js TS2304': 1 }, { 'server/a.js TS2304': 2 }, files), []);
  assert.deepEqual(unknownNameProblems({ 'server/a.js TS2304': 2, 'server/a/part.js TS2552': 1 }, { 'server/a.js TS2304': 2 }, files),
    ['1 new TS2552 (cannot find name) in server/a/part.js: a moved name lost its declaration']);
  assert.deepEqual(unknownNameProblems({ 'server/b.js TS2304': 7 }, {}, files), [], 'another file is not this move\'s business');
});

test('a require line of the old file may only lose names', () => {
  const module = "const { a } = require('../lib.js');\nconst path = require('node:path');\n";
  assert.equal(requireEditProblem(['const { a, b } = require("./lib");'], ['const { b } = require("./lib");'], module), null);
  assert.equal(requireEditProblem(['const { a } = require("./lib");'], ['require("./lib");'], module), null);
  assert.equal(requireEditProblem(['const path = require("path");'], [], module), null);
  assert.match(requireEditProblem(['const { a } = require("./lib");'], ['const { a, evil } = require("./lib");'], module), /gained evil/);
  assert.match(requireEditProblem(['const { a } = require("./gone");'], [], module), /was dropped but the new module does not require it/);
  assert.ok(requireEditProblem(['const { a } = require("./lib");'], ['const { a } = require("./other");'], module));
});
