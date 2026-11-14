// The request handler's chain and the tables of feature-routes.js, on the real files:
// what must stay true whatever steps of tools/restructure/dispatch-move.mjs were made.
// An address a table answers has one answer and no test of the chain can take it; the
// files load in the order they always did; and the tests that left can be put back.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { readHead, readRequire } from '../../tools/restructure/branches-text.mjs';
import { engineRequired, featureRoutesClaimed, LOOKUP_TEST, standingProblems } from '../../tools/restructure/dispatch-move.mjs';
import { exactRoutes, knownOf, readDispatch } from '../../tools/restructure/dispatch-read.mjs';
import { chainBack, readHands, readListed } from '../../tools/restructure/dispatch-undo.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';
const read = (file) => readFileSync(fileURLToPath(new URL(`../../${file}`, import.meta.url)), 'utf8');
const ENGINE = read('server/server.js');
const LIST = read('server/feature-routes.js');
const STEPS = JSON.parse(read('tools/restructure/dispatch-moves.json')).steps;
const moduleTextOf = (spec) => read(`server/${spec.slice(2)}`);
const LOAD = 'featureRoutes.loadTables();';
// The tables the file names between the line that loads them and the handler.
const namedAfterLoad = (text) => {
  const lines = text.split('\n');
  const from = lines.indexOf(LOAD);
  return lines.slice(from + 1, lines.indexOf('const handleRequest = async (req, res) => {')).map(readRequire).filter(Boolean).map((found) => found.spec);
};

test('no test of the chain can answer an address a table answers, and every name a table is handed is there', (t) => {
  if (!parser) return t.skip(SKIP);
  const known = knownOf(ENGINE, parser, engineRequired());
  assert.deepEqual(known.maps.BIT_MESSAGE_ROUTES?.length > 0, true, 'the addresses of the object the chain asks are known');
  assert.equal(typeof known.texts['remoteAccessLib.WIDGET_ASSET_PREFIX'], 'string');
  assert.deepEqual(standingProblems({ engineText: ENGINE, listText: LIST, moduleTextOf, parser, claimed: featureRoutesClaimed(LIST, moduleTextOf), known }), []);
  const { rows } = readDispatch(ENGINE, parser);
  assert.equal(rows.filter((row) => row.test === LOOKUP_TEST).length, 1, 'one branch asks feature-routes.js');
});

test('the files of tables load where they always loaded, in the order they always loaded', () => {
  const lines = ENGINE.split('\n');
  assert.equal(lines.filter((line) => line === LOAD).length, 1);
  const listed = readListed(LIST);
  const named = namedAfterLoad(ENGINE);
  // A table the engine file still calls is one the list loaded already, so its line there loads nothing.
  for (const spec of named) assert.ok(listed.all.includes(spec), `${spec} is called by server.js and loaded by feature-routes.js first`);
  assert.deepEqual(named, listed.all.filter((spec) => named.includes(spec)), 'and the two keep the same order');
  // With every step undone the engine file names every file of the list, in the list's order: that was the order of loading.
  const before = chainBack(ENGINE, STEPS);
  assert.deepEqual(namedAfterLoad(before), listed.all);
  assert.equal(new Set(listed.all).size, listed.all.length);
  assert.deepEqual(STEPS.flatMap((step) => step.listed).sort(), [...listed.specs].sort(), 'the list answers for the files the steps took the mark off, and no other');
});

test('a file the list only loads has every test of its whole addresses still in the chain', (t) => {
  if (!parser) return t.skip(SKIP);
  const asked = new Set(readDispatch(ENGINE, parser).rows.flatMap((row) => row.routes));
  for (const spec of readListed(LIST).waiting) {
    for (const head of moduleTextOf(spec).split('\n').map(readHead).filter(Boolean)) {
      for (const route of exactRoutes(head.key)) assert.ok(asked.has(route), `${route} of ${spec}`);
    }
  }
});

test('putting the steps back gives a chain with every address a table answers, each asked once', (t) => {
  if (!parser) return t.skip(SKIP);
  const before = readDispatch(chainBack(ENGINE, STEPS), parser).rows;
  const now = readDispatch(ENGINE, parser).rows;
  const answered = readListed(LIST).specs.flatMap((spec) => moduleTextOf(spec).split('\n').map(readHead).filter(Boolean).flatMap((head) => exactRoutes(head.key)));
  const count = (rows) => rows.flatMap((row) => row.routes).length;
  assert.equal(count(before), count(now) + answered.length);
  const old = before.flatMap((row) => row.routes);
  assert.equal(new Set(old).size, old.length);
  for (const route of answered) assert.ok(old.includes(route), route);
  assert.deepEqual(readHands(chainBack(ENGINE, STEPS).split('\n')).names, [], 'and hands the tables nothing');
});

test('what the handler gives back is read by nobody, so a branch may give back what its table gave', () => {
  const calls = ENGINE.split('\n').filter((line) => /\bhandleRequest\b/.test(line) && !line.trim().startsWith('//'));
  assert.equal(calls.filter((line) => line.startsWith('const handleRequest = async (req, res) => {')).length, 1);
  for (const line of calls.filter((other) => !other.startsWith('const handleRequest'))) assert.match(line, /runGuarded\(handleRequest, req, res\)/);
  const boundary = read('server/http/request-boundary.js');
  assert.match(boundary, /async function runGuarded\(handler, req, res, log = defaultLog\) \{\n {2}try \{\n {4}await handler\(req, res\);\n {2}\} catch/);
});
