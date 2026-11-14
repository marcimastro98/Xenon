// What `browser inner` prints, and the move it hands to browser-extract.mjs.
//
//   browser inner <script> [--json]        the functions of the script's wrapper: which may leave, in which groups, what keeps the others
//   browser inner --survey [--all] [--json]   the same in numbers for every wrapped script over 300 lines (--all: every wrapped script)
//   browser inner --from <script> --to <script's name>/<what it does>.js --about "<one sentence>" [--recorded <before.json>] [--dry-run] <function | group:N> ...

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { windowNameOf } from './browser-inner-plan.mjs';
import { renderSurvey, surveyAll, surveyScript } from './browser-inner-survey.mjs';
import { readBrowserLedger } from './browser-ledger.mjs';
import { Refusal } from './extract-plan.mjs';

/** @param {string} root @param {any} parser @param {{ flags: any, rest: string[] }} args @returns {number} exit code */
export function showInner(root, parser, { flags, rest }) {
  const file = rest[0];
  const found = surveyScript(readFileSync(path.join(root, file), 'utf8'), file, parser);
  if (flags.json) { console.log(JSON.stringify(found, null, 1)); return 0; }
  if (!found.wrapped) { console.error(found.why); return 1; }
  console.log(`${file}: ${found.lines} lines, ${found.all.functions} functions in its wrapper (${found.all.lines} lines). ${found.free.functions} may leave (${found.free.lines} lines).`);
  for (const row of found.rows) console.log(`${row.stays.length ? 'stays' : 'moves'} ${String(row.lines[0]).padStart(6)}-${String(row.lines[1]).padEnd(6)} ${row.name}${row.stays.length ? `  # ${row.stays[0]}` : ''}`);
  console.log(`Groups that use nothing of each other (each can be a script of its own, \`group:N\` names one):`);
  for (const [at, group] of found.groups.entries()) console.log(`  group:${at + 1}  ${String(group.lines).padStart(4)} lines  ${group.names.join(', ')}`);
  console.log(`If the wrapper's lets and vars could be shared ${found.ifState.functions} functions (${found.ifState.lines} lines) could leave; if its constants could go along ${found.ifConst.functions} (${found.ifConst.lines}), only written-out values and functions ${found.ifFixed.functions} (${found.ifFixed.lines}); both ${found.ifBoth.functions} (${found.ifBoth.lines}).`);
  return 0;
}

/** @param {string} root @param {any} parser @param {{ flags: any }} args @returns {number} exit code */
export function showSurvey(root, parser, { flags }) {
  const survey = surveyAll(root, parser, readBrowserLedger(root));
  if (flags.json) { console.log(JSON.stringify(survey.scripts.map(({ rows, groups, ...rest }) => rest), null, 1)); return 0; }
  console.log(renderSurvey(survey, Boolean(flags.all)).join('\n'));
  return 0;
}

/**
 * @param {any} parser
 * @param {{ inner: string, to: string, about: string, names: string[], recorded?: string }} job `names`: functions, or `group:N` as `browser inner <script>` numbers them
 * @param {(file: string) => string | null} read the files as the move will find them
 * @returns {any} the move for browser-extract.mjs
 */
export function innerMoveOf(parser, job, read) {
  const from = job.inner;
  const names = [];
  const groups = job.names.some((pick) => pick.startsWith('group:')) ? surveyScript(read(from) ?? '', from, parser).groups ?? [] : [];
  for (const pick of job.names) {
    if (!pick.startsWith('group:')) { names.push(pick); continue; }
    const group = groups[Number(pick.slice('group:'.length)) - 1];
    if (!group) throw new Refusal([`${from} has no ${pick}: \`browser inner ${from}\` lists the groups`]);
    names.push(...group.names);
  }
  const move = { kind: 'inner', from, file: job.to, about: job.about, names };
  if (job.recorded) Object.defineProperty(move, 'recorded', { value: JSON.parse(readFileSync(job.recorded, 'utf8')), enumerable: false });
  if (!windowNameOf(from, job.to)) throw new Refusal([`${job.to} must be ${from.replace(/\.js$/, '')}/<what it does>.js in lowercase kebab-case: the name it leaves on window is read off its place`]);
  return move;
}
