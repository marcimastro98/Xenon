// Takes the tests of whole addresses out of the request handler's chain, table by table. A branch that reads
//
//   } else if (reqPath === '/x' && req.method === 'GET') {
//     await someBranches['GET /x'](req, res, { json, ... }, { aName });
//
// already has its lines in a feature's table (the `branches` step). server/feature-routes.js loads the table's
// file, marked `inChain`; this step takes the mark off, so feature-routes.js answers every key of the table that
// names whole addresses, and takes those branches out of the chain. No file is loaded at another moment for it. The one branch that asks feature-routes.js stays where it is and hands over the same values.
//
// A table moves whole or not at all, and only when nothing can change:
//   * every whole-address key of the table has one branch whose test is that key and whose body is the one call;
//   * no test that stood before the branch, and none that stands before the branch asking feature-routes.js,
//     can be true for the same method and address (dispatch-read.mjs `canMatch`; "it depends" counts as "can");
//   * no other branch or table answers the same method and address;
//   * no test of it is one a side copy of the engine cuts out by its text (side-copy-cuts.mjs): out of the chain,
//     the cut would find nothing and the copy would answer an address it must not.
// A branch that reads `return await table[...]` counts as one that reads `await table[...]`: the chain is the last
// thing the handler does and what the handler gives back is read by nobody (runGuarded, request-boundary.js; a test
// in restructure-dispatch-real.test.mjs keeps both true).
// The names of the file the calls handed over go into `routeHands`, which feature-routes.js reads once: a name assigned again while the engine runs is refused.
//
// Every cut is recorded in dispatch-moves.json with the line it stood next to, so the old file can be had back
// (`chainBack`): the step proves itself by putting its own cuts back and comparing byte for byte.
//
//   node tools/restructure/dispatch-move.mjs [--dry-run] <table name in server.js> [...]   |   --all

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze } from './analyze.mjs';
import { ROUTES } from './branches-kinds.mjs';
import { ownOf, readHead, readRequire } from './branches-text.mjs';
import { canMatch, ENGINE, exactRoutes, knownOf, readDispatch } from './dispatch-read.mjs';
import { chainBack, cut, handsLines, listBack, readHands, readListed, unmark } from './dispatch-undo.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';
import { CUTS } from './side-copy-cuts.mjs';

export const LIST = 'server/feature-routes.js';
export const MOVES = 'tools/restructure/dispatch-moves.json';
export const LOOKUP_TEST = 'featureRoutes.has(req.method, reqPath)';
// Every whole-address key a table's file has, read from its text.
const tableKeys = (moduleText) => moduleText.split('\n').map(readHead).filter(Boolean).map((head) => head.key).filter((key) => exactRoutes(key).length);

/**
 * Which tables can leave the chain, and why the others cannot.
 * @param {object} job
 * @param {string} job.engineText @param {string} job.listText @param {(spec: string) => string} job.moduleTextOf by the path as required
 * @param {string[] | null} job.locals the tables asked for by their name in the engine file, null for every one
 * @param {any} job.parser @param {string[]} [job.claimed] `METHOD /address` pairs something else already answers
 * @param {string[]} [job.pinned] texts of the engine file something finds by reading it: a test in one of them stays
 * @returns {{ moves: { local: string, spec: string, rows: any[], routes: string[], own: string[] }[], refused: { local: string, why: string }[], rows: any[], lookup: number }}
 */
export function planMove({ engineText, listText, moduleTextOf, locals, parser, claimed = [], known = {}, pinned = CUTS.map((made) => made[0]) }) {
  const { rows, lines } = readDispatch(engineText, parser);
  const lookup = rows.findIndex((row) => row.test === LOOKUP_TEST);
  if (lookup < 0) throw new Error(`the chain has no branch that asks feature-routes.js (${LOOKUP_TEST})`);
  const required = new Map(lines.map(readRequire).filter(Boolean).map((found) => [found.local, found.spec]));
  const list = readListed(listText);
  const listed = new Set(list.specs);
  const waiting = new Set(list.waiting);
  const taken = new Set([...claimed, ...[...listed].flatMap((spec) => tableKeys(moduleTextOf(spec)).flatMap(exactRoutes))]);
  const wanted = locals ?? [...new Set(rows.filter((row) => row.call && row.how === 'exact').map((row) => row.call.local))];
  const moves = [];
  const refused = [];
  for (const local of wanted) {
    const spec = required.get(local);
    const why = spec ? whyNot({ local, spec, rows, lines, lookup, taken, listed, waiting, moduleText: moduleTextOf(spec), parser, known, pinned }) : { why: 'the file requires no table under that name' };
    if (why.why) { refused.push({ local, why: why.why }); continue; }
    for (const route of why.routes) taken.add(route);
    moves.push({ local, spec, rows: why.rows, routes: why.routes, own: [...new Set(why.rows.flatMap((row) => row.call.own))].sort() });
  }
  return { moves, refused, rows, lookup };
}

function whyNot({ local, spec, rows, lines, lookup, taken, listed, waiting, moduleText, parser, known, pinned }) {
  if (listed.has(spec)) return { why: 'feature-routes.js answers for its file already' };
  if (!waiting.has(spec)) return { why: `feature-routes.js does not load its file: write \`inChain(require('${spec}')),\` in TABLE_FILES at the place server.js loads it` };
  const keys = tableKeys(moduleText);
  if (keys.length === 0) return { why: 'no key of it names whole addresses' };
  const mine = [];
  for (const key of keys) {
    const calls = rows.filter((row) => row.call?.local === local && row.call.key === key);
    if (calls.length !== 1) return { why: `${calls.length} branches call '${key}', one was expected` };
    const [row] = calls;
    if (row.key !== key) return { why: `the branch on line ${row.line} calls '${key}' and its test asks for something else` };
    if (pinned.some((text) => text.includes(row.test))) return { why: `a side copy of the engine cuts the test on line ${row.line} out by its text (side-copy-cuts.mjs)` };
    if (row.at === 0) return { why: `'${key}' is the first branch of the chain, which the others hang from` };
    const plain = lines.slice(row.from, row.body).join('\n') === `  } else if (${row.test}) {` && lines.slice(row.body + 1, row.to + 1).every((line) => line === '');
    if (!plain) return { why: `the branch on line ${row.line} is not its test and its call, with nothing but empty lines after` };
    mine.push(row);
  }
  const routes = mine.flatMap((row) => row.routes);
  for (const row of mine) {
    for (const route of row.routes) {
      const [method, address] = route.split(' ');
      if (taken.has(route)) return { why: `${route} is answered by a table or a feature already` };
      for (const other of rows) {
        if (other === row) continue;
        if (other.how === 'exact') {
          if (other.routes.includes(route)) return { why: `${route} is asked for twice: lines ${row.line} and ${other.line}` };
        } else if (other.at !== lookup && (other.at < row.at || other.at < lookup) && canMatch(other.node, parser, method, address, known) !== false) {
          return { why: `the test on line ${other.line} stands before ${route} and can be true for it: ${other.test.replace(/\s+/g, ' ').slice(0, 90)}` };
        }
      }
    }
  }
  if (new Set(routes).size !== routes.length) return { why: 'two of its keys name the same address' };
  return { rows: mine, routes };
}

/**
 * The new texts and the record of the step. Pure.
 * @param {{ engineText: string, listText: string, moves: ReturnType<typeof planMove>['moves'] }} job
 * @returns {{ engineText: string, listText: string, step: { modules: { local: string, spec: string }[], cuts: any[], hands: string[], listed: string[] } }}
 */
export function applyMove({ engineText, listText, moves }) {
  const lines = engineText.split('\n');
  const cuts = [];
  for (const row of moves.flatMap((move) => move.rows).sort((a, b) => b.from - a.from)) cuts.push(cut(lines, row.from, row.to - row.from + 1));
  for (const { local } of moves) {
    if (lines.some((line) => line.includes(`${local}[`))) continue; // a test that asks for a beginning still calls it
    const at = lines.findIndex((line) => readRequire(line)?.local === local);
    const alone = !readRequire(lines[at - 1] ?? '') && !readRequire(lines[at + 1] ?? '');
    cuts.push(cut(lines, at, alone && lines[at + 1] === '' ? 2 : 1));
  }
  const hands = readHands(lines);
  const added = [...new Set(moves.flatMap((move) => move.own))].filter((name) => !hands.names.includes(name)).sort();
  lines.splice(hands.from + 1, hands.to - hands.from - 1, ...handsLines([...hands.names, ...added]));
  const listed = moves.map((move) => move.spec);
  return { engineText: lines.join('\n'), listText: unmark(listText, listed),
    step: { modules: moves.map(({ local, spec }) => ({ local, spec })), cuts, hands: added, listed } };
}

/**
 * What is wrong with a step that was worked out, none when it proves itself.
 * @param {object} job the texts before and after, the step, and how to read a table's file
 * @returns {string[]}
 */
export function moveProblems({ before, after, listBefore, listAfter, step, moduleTextOf, parser, claimed = [], known = {} }) {
  const problems = [];
  if (chainBack(after, [step]) !== before) problems.push('putting the cuts back does not give the engine file as it was');
  if (listBack(listAfter, step) !== listBefore) problems.push('taking the new lines out of feature-routes.js does not give the file as it was');
  return [...problems, ...standingProblems({ engineText: after, listText: listAfter, moduleTextOf, parser, claimed, known })];
}

/**
 * @param {string} engineText @param {any} parser @param {string[]} names
 * @returns {string[]} the ones of `names` that are a `let` or a `var` of the file, or are assigned to anywhere in it
 */
export function assignedAgain(engineText, parser, names) {
  const { bindings } = analyze(engineText, parser, ENGINE);
  return names.filter((name) => {
    const found = bindings.get(name);
    return Boolean(found) && (found.kind === 'let' || found.kind === 'var' || found.reassigned);
  });
}

/**
 * What must hold of the two files whatever steps made them: every address a table answers has one answer, no test of
 * the chain can answer it instead, every name a table's function is handed is one `routeHands` holds, and none of them is assigned again (they are read once).
 * @param {{ engineText: string, listText: string, moduleTextOf: (spec: string) => string, parser: any, claimed?: string[], known?: object }} job
 * @returns {string[]}
 */
export function standingProblems({ engineText, listText, moduleTextOf, parser, claimed = [], known = {} }) {
  const problems = [];
  const { rows, lines } = readDispatch(engineText, parser);
  const lookup = rows.findIndex((row) => row.test === LOOKUP_TEST);
  const hands = new Set(readHands(lines).names);
  problems.push(...assignedAgain(engineText, parser, [...hands]).map((name) => `${name} is assigned again while the engine runs, and routeHands is read once: it would keep the first value`));
  const answered = new Set(claimed);
  for (const spec of readListed(listText).specs) {
    const moduleText = moduleTextOf(spec);
    for (const head of moduleText.split('\n').map(readHead).filter(Boolean)) {
      for (const route of exactRoutes(head.key)) {
        const [method, address] = route.split(' ');
        if (answered.has(route)) problems.push(`${route} is answered twice`);
        answered.add(route);
        for (const row of rows) {
          if (row.at === lookup) continue;
          if (row.how === 'exact' ? row.routes.includes(route) : row.at < lookup && canMatch(row.node, parser, method, address, known) !== false) {
            problems.push(`line ${row.line} of the chain can still answer ${route}, which ${spec} answers`);
          }
        }
      }
      for (const name of exactRoutes(head.key).length ? ownOf(head.params, ROUTES) : []) if (!hands.has(name)) problems.push(`'${head.key}' of ${spec} is handed ${name}, which routeHands does not hold`);
    }
  }
  return problems;
}

/** The `METHOD /address` pairs the features listed at the top of feature-routes.js answer, read from their files. */
export function featureRoutesClaimed(listText, read) {
  const top = listText.slice(listText.indexOf('const FEATURES'), listText.indexOf(']);'));
  return [...top.matchAll(/require\('([^']+)'\)/g)].flatMap((found) => [...read(found[1]).matchAll(/'([A-Z]+ \/[^'*|\s]*)'/g)].map((key) => key[1]));
}

/** The modules of the engine whose texts a test of the chain names, loaded as the engine loads them. */
export function engineRequired() {
  const load = createRequire(path.join(REPO_ROOT, 'server', 'server.js'));
  return { remoteAccessLib: { spec: './remote-access', values: load('./remote-access') } };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const names = args.filter((arg) => !arg.startsWith('--'));
  if (names.length === 0 && !args.includes('--all')) {
    console.log('usage: dispatch-move.mjs [--dry-run] <table name in server.js> [...] | --all');
    process.exitCode = 2;
    return;
  }
  const read = (file) => readFileSync(path.join(REPO_ROOT, file), 'utf8');
  const moduleTextOf = (spec) => read(path.posix.join('server', spec));
  const [before, listBefore] = [read(ENGINE), read(LIST)];
  const claimed = featureRoutesClaimed(listBefore, moduleTextOf);
  const parser = await openParser();
  try {
    const known = knownOf(before, parser, engineRequired());
    const plan = planMove({ engineText: before, listText: listBefore, moduleTextOf, locals: names.length ? names : null, parser, claimed, known });
    for (const { local, why } of plan.refused) console.log(`stays: ${local}: ${why}`);
    if (plan.moves.length === 0) { console.log('Nothing leaves the chain.'); process.exitCode = plan.refused.length ? 1 : 0; return; }
    const made = applyMove({ engineText: before, listText: listBefore, moves: plan.moves });
    const problems = moveProblems({ before, after: made.engineText, listBefore, listAfter: made.listText, step: made.step, moduleTextOf, parser, claimed,
      known: knownOf(made.engineText, parser, engineRequired()) });
    if (problems.length) { console.error(['The step does not prove itself, nothing was written:', ...problems.map((line) => `  ${line}`)].join('\n')); process.exitCode = 1; return; }
    const routes = plan.moves.reduce((sum, move) => sum + move.routes.length, 0);
    for (const move of plan.moves) console.log(`${dryRun ? 'would leave' : 'left'} the chain: ${move.local} (${move.spec}), ${move.rows.length} branches, ${move.routes.length} addresses`);
    console.log(`${plan.moves.length} tables, ${routes} addresses; ${ENGINE} ${dryRun ? 'would lose' : 'lost'} ${before.split('\n').length - made.engineText.split('\n').length} lines; `
      + 'putting the cuts back gives the old file byte for byte, and no test left in the chain can answer an address of a table.');
    if (dryRun) return;
    const ledger = JSON.parse(read(MOVES));
    ledger.steps.push(made.step);
    writeFileSync(path.join(REPO_ROOT, ENGINE), made.engineText);
    writeFileSync(path.join(REPO_ROOT, LIST), made.listText);
    writeFileSync(path.join(REPO_ROOT, MOVES), `${JSON.stringify(ledger, null, 1)}\n`);
  } finally {
    parser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
