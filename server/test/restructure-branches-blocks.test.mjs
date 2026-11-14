// `branches` and `block` on the same body. `block` leaves, in a long body, one call of a function that holds the lines
// it took out; the readers of the engine's text put those lines back where that call stands, and look for it in the file
// the lines came from. If `branches` later moved the body, the call would be in a table and the readers would throw on
// every test that asks for the engine's text. So `branches` refuses such a body, and says why.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moveBranches, surveyBranches } from '../../tools/restructure/branches.mjs';
import { planBranches } from '../../tools/restructure/branches-plan.mjs';
import { Refusal } from '../../tools/restructure/extract-plan.mjs';
import { blockFunctions, readLedger } from '../../tools/restructure/ledger.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';
import { ALLOWED, OLD, rewrite, SOURCE, TABLE } from './restructure-branches-fixture.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const plan = (keys, more = {}) => planBranches({ text: SOURCE, parser, source: OLD, target: TABLE, about: 'What the lights answer.', keys,
  moduleBefore: null, rewrite, allowed: ALLOWED, ...more });
const refusal = (run) => {
  try { run(); } catch (error) { if (error instanceof Refusal) return error.reasons.join('\n'); throw error; }
  return '';
};

test('the functions that hold a block are read from the list: one per entry made by `block`, none for any other entry', () => {
  assert.deepEqual([...blockFunctions([{ file: 'a.js', names: ['one', 'two'] }, { file: 'b.js', names: ['held'], block: { handler: 'h', test: 't' } }])], ['held']);
  assert.deepEqual([...blockFunctions([])], []);
});

test('a body that calls a function holding a block stays, with the reason; the same body moves when no block was taken out of it', (t) => {
  if (!parser) return t.skip(SKIP);
  // `GET /c` calls helper(), a function of the file: handed over by the call, it moves.
  assert.deepEqual(plan(['GET /c']).keys, ['GET /c']);
  assert.deepEqual(plan(['GET /c'], { blocks: new Set(['other']) }).keys, ['GET /c'], 'a block of another body does not hold this one');
  const why = refusal(() => plan(['GET /c', 'GET /a'], { blocks: new Set(['helper', 'other']) }));
  assert.match(why, /^GET \/c \(server\/demo\.js:\d+\): it calls helper, which holds lines of a block taken out of this body: the readers of the engine's text put them back where the call stands, and look for it in server\/demo\.js$/m);
  assert.ok(!why.includes('GET /a'), 'the body next to it has no reason against it');
  // The survey says the same as the plan: the body is counted as one that stays, under a reason of its own.
  const stateOf = (survey) => survey.bodies.find((body) => body.key === 'GET /c').state;
  assert.equal(stateOf(surveyBranches({ text: SOURCE, parser, source: OLD })), 'handed');
  const survey = surveyBranches({ text: SOURCE, parser, source: OLD, blocks: new Set(['helper']) });
  assert.equal(stateOf(survey), 'kept');
  assert.ok(survey.other.some((row) => row.branches === 1 && row.reason.startsWith('it calls … which holds lines of a block taken out of this body')), JSON.stringify(survey.other));
});

test('in the engine, the chat route holds every block taken out so far, and `branches` refuses to move it for that', (t) => {
  if (!parser) return t.skip(SKIP);
  const held = [...blockFunctions(readLedger(REPO).sources['server/server.js'])];
  assert.ok(held.length >= 5, String(held.length));
  const why = refusal(() => moveBranches({ root: REPO, parser, source: 'server/server.js', target: 'server/ai/routes-chat.js',
    about: 'A chat turn.', keys: ['POST /api/ai'], dryRun: true }));
  assert.match(why, new RegExp(`POST /api/ai \\(server/server\\.js:\\d+\\): it calls ${held.join(', ')}, which hold lines of a block taken out of this body`));
});
