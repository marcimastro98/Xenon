// Moves the bodies of some branches of a chain (routes of the request handler, or
// tools the assistant runs) into a table in a module of their feature, on disk: plan (branches-plan.mjs), prove (branches-proof.mjs),
// write both files, check them, and put everything back if a check fails. Also
// redoes recorded moves for `verify`, and says what keeps the other bodies.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { planBranches } from './branches-plan.mjs';
import { proveBranches } from './branches-proof.mjs';
import { kindOf, ROUTES } from './branches-kinds.mjs';
import { readBranches } from './branches-scope.mjs';
import { Refusal } from './extract-plan.mjs';
import { branchHandlers, protectedBetween, protectedNames, quietModules, readLedger, recordBranches } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

/** Plans a move of `text` with the repo's protected list. Throws a Refusal. */
export function planBranchesFor({ root, parser, text, source, target, about, keys, moduleBefore, ownModules }) {
  const analysis = analyze(text, parser, source);
  const guard = protectedNames(root, source, analysis.records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planBranches({ text, parser, analysis, source, target, about, keys, moduleBefore, rewrite: createSpecRewriter(root),
    allowed: branchHandlers(root, source), protectedNames: guard.names, ownModules });
}

/** Proves a planned move with the repo's protected stretches. @returns {string[]} problems */
export function proveBranchesFor({ root, parser, before, moduleBefore, plan, source, target }) {
  const rewrite = createSpecRewriter(root);
  const idOf = (spec, from) => { const found = rewrite(spec, from, from); return found.file ?? found.spec; };
  return proveBranches({ before, after: plan.newSource, moduleBefore, moduleText: plan.moduleText, plan, parser, source, target,
    between: protectedBetween(root, source), idOf });
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file with the handler
 * @param {string} job.target repo-relative module of the table
 * @param {string} [job.about] one sentence, the first comment of a new module
 * @param {string[]} job.keys `METHOD /path` of each route, or the name of each tool
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ keys: string[], target: string, lines: number, sourceLines: number, added: boolean }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function moveBranches({ root, parser, source, target, about, keys, dryRun = false }) {
  const before = readFileSync(path.join(root, source), 'utf8');
  const file = path.join(root, target);
  const ledger = readLedger(root);
  const entries = ledger.sources[source] ?? [];
  const records = ledger.branches?.[source] ?? [];
  const known = records.some((record) => record.file === target);
  if (existsSync(file) && !known) throw new Refusal([`${target} exists and is not a table this command made: give the bodies a file of their own (${kindOf(target)?.fileWord ?? 'routes'}-<word>.js)`]);
  const moduleBefore = known ? readFileSync(file, 'utf8') : null;
  const plan = planBranchesFor({ root, parser, text: before, source, target, about, keys, moduleBefore, ownModules: quietModules(entries) });
  const reasons = targetReasons({ root, source, target, requires: plan.requires.map((module) => module.file).filter(Boolean), existing: known });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveBranchesFor({ root, parser, before, moduleBefore, plan, source, target });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const result = { keys: plan.keys, target, lines: plan.lines, sourceLines: plan.sourceLines, added: !known };
  if (dryRun) return result;

  const folder = path.dirname(file);
  const madeFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(file, plan.moduleText);
  writeFileSync(path.join(root, source), plan.newSource);
  const group = [...new Set([source, ...entries.map((entry) => entry.file), ...records.map((record) => record.file), target])];
  const problems = syntaxProblems(root, [source, target]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), group));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    if (moduleBefore === null) rmSync(file); else writeFileSync(file, moduleBefore);
    if (madeFolder && readdirSync(folder).length === 0) rmdirSync(folder);
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  recordBranches(root, source, { file: target, about: about ?? '', keys: plan.keys, after: entries.length });
  return result;
}

/**
 * For `verify`: redoes the recorded moves made when the file had `count` entries, on the replay's own texts.
 * @param {object} job
 * @param {{ file: string, about: string, keys: string[], after: number }[]} job.records the moves the revision does not have
 * @param {Map<string, string | null>} job.modules the text of each table so far (null: not there yet); updated here
 * @param {{ file: string, lift?: boolean }[]} job.earlier the file's entries so far
 * @returns {string | null} the file's text after them, null when one cannot be redone (said in `problems`)
 */
export function redoBranches({ root, parser, source, base, records, count, text, modules, earlier, problems }) {
  let out = text;
  for (const record of records.filter((entry) => entry.after === count)) {
    const moduleBefore = modules.get(record.file) ?? null;
    try {
      const plan = planBranchesFor({ root, parser, text: out, source, target: record.file, about: record.about, keys: record.keys, moduleBefore,
        ownModules: quietModules(earlier) });
      problems.push(...proveBranchesFor({ root, parser, before: out, moduleBefore, plan, source, target: record.file }).map((p) => `${record.file}: ${p}`));
      out = plan.newSource;
      modules.set(record.file, plan.moduleText);
    } catch (error) {
      problems.push(`${record.file}: the recorded move of ${record.keys.length} bodies cannot be redone from ${base}: ${error.message}`);
      return null;
    }
  }
  return out;
}

const groupOf = (branch) => {
  if (branch.key && !branch.key.includes(' ')) return 'tools';
  const parts = (branch.key?.split(' ')[1] ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return branch.key ? '/' : '(no single address)';
  return parts[0] === 'api' ? `/api/${parts[1] ?? ''}` : `/${parts[0]}`;
};

/**
 * What can move now and what keeps the rest.
 * @param {{ text: string, parser: any, source: string, kind?: typeof ROUTES, handler?: string }} job
 * @returns {{ branches: number, moved: number, movable: { key: string, group: string, lines: number, line: number }[],
 *   held: { name: string, branches: number, alone: number, lines: number }[], other: { reason: string, branches: number }[] }}
 *   `held`: per name the file still declares, how many bodies wait on it, how many on it alone, and those bodies' lines
 */
export function surveyBranches({ text, parser, source, kind = ROUTES, handler = kind.handler }) {
  const { branches } = readBranches({ text, parser, analysis: analyze(text, parser, source), kind, handler });
  const open = branches.filter((branch) => !branch.moved);
  const movable = open.filter((branch) => branch.reasons.length === 0).map((branch) => ({ key: branch.key, group: groupOf(branch), lines: branch.lines, line: branch.line }));
  const held = new Map();
  const other = new Map();
  for (const branch of open) {
    const others = branch.reasons.length - branch.holders.length;
    for (const name of branch.holders) {
      const row = held.get(name) ?? { name, branches: 0, alone: 0, lines: 0 };
      row.branches += 1;
      if (others === 0 && branch.holders.length === 1) { row.alone += 1; row.lines += branch.lines; }
      held.set(name, row);
    }
    for (const reason of branch.reasons.slice(0, others)) {
      const kind = reason.replace(/^it (uses|assigns) \S+/, 'it $1 …');
      other.set(kind, (other.get(kind) ?? 0) + 1);
    }
  }
  return { branches: branches.length, moved: branches.length - open.length, movable,
    held: [...held.values()].sort((a, b) => b.branches - a.branches || a.name.localeCompare(b.name)),
    other: [...other].map(([reason, count]) => ({ reason, branches: count })).sort((a, b) => b.branches - a.branches) };
}

/** @param {ReturnType<typeof surveyBranches>} survey @param {string} source @returns {string} */
export function renderSurvey(survey, source) {
  const sum = (rows) => rows.reduce((total, row) => total + row.lines, 0);
  const groups = new Map();
  for (const row of survey.movable) groups.set(row.group, [...(groups.get(row.group) ?? []), row]);
  const out = [`${source}: ${survey.branches} branches, ${survey.moved} of them a call of a table already.`,
    `Can move now: ${survey.movable.length} bodies, ${sum(survey.movable)} lines.`];
  for (const [group, rows] of [...groups].sort((a, b) => sum(b[1]) - sum(a[1]))) out.push(`  ${group.padEnd(28)} ${String(rows.length).padStart(3)} bodies ${String(sum(rows)).padStart(5)} lines`);
  out.push('', 'Kept by a name the file still declares (bodies waiting on it, of which on it alone, and the lines of those):');
  for (const row of survey.held.slice(0, 60)) out.push(`  ${row.name.padEnd(34)} ${String(row.branches).padStart(3)} ${String(row.alone).padStart(3)} ${String(row.lines).padStart(5)}`);
  if (survey.held.length > 60) out.push(`  ... and ${survey.held.length - 60} more names`);
  out.push('', 'Kept by something else:');
  for (const row of survey.other) out.push(`  ${String(row.branches).padStart(3)}  ${row.reason}`);
  return out.join('\n');
}
