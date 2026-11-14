// Takes functions out of a factory's body on disk: plan (inner-plan.mjs), check the target, prove the
// plan (inner-proof.mjs), write both files, check them, and put everything back if a check fails.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { bareLines } from './dead-requires.mjs';
import { dropOnDisk } from './dead-requires-disk.mjs';
import { Refusal } from './extract-plan.mjs';
import { constantsAlong } from './inner-constants.mjs';
import { leaveReasons, planInner, readBody } from './inner-plan.mjs';
import { proveInner } from './inner-proof.mjs';
import { appendLedger, protectedNames, quietModules, readLedger } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

/**
 * The plan for one step, with the repo's own rules: the protected names of the file and the modules made out of it.
 * @param {{ root: string, parser: any, text: string, source: string, target: string, about: string, factory: string, make: string,
 *   names: string[], ownModules?: Set<string> }} job
 * @returns {ReturnType<typeof planInner>}
 */
export function planInnerFor({ root, parser, text, source, target, about, factory, make, names, ownModules }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  return planInner({ text, parser, source, target, about, factory, make, names, ownModules, rewrite: createSpecRewriter(root),
    protectedNames: guard.names, protectedStretches: guard.stretches });
}

/**
 * @param {object} job
 * @param {string} job.root repo root @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file of the factory @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.factory the top-level function the functions leave @param {string} job.make the function the new module gives
 * @param {string[]} job.names functions declared in the factory's body, and constants of it to move and have handed back
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ moved: string[], returned: string[], passed: string[], lines: number, sourceLines: number, target: string,
 *   bare?: { dropped: { spec: string, why: string }[], kept: { spec: string, why: string }[] },
 *   along?: { added: string[], left: { name: string, why: string }[] } }} `bare` as in extract.mjs; `along`: the constants that
 *   went without being named, and the written-out ones the moved code uses that stayed, each with why (inner-constants.mjs);
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function moveInner(job) {
  const { root, parser, source, target, about, factory, make, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const entries = readLedger(root).sources[source] ?? [];
  // The constants only the moved code uses go along without being named. The step records every name, so redone it adds none.
  const body = readBody(before, parser, source, factory);
  const along = constantsAlong({ inner: body.inner, names: job.names, factory, real: body.real,
    reasonsOf: (record, movedSet) => leaveReasons({ body, record, movedSet, source, factory }) });
  const names = [...job.names, ...along.added];
  const bare = dropOnDisk({ root, parser, source, target, plan: planInnerFor({ ...job, names, text: before, ownModules: quietModules(entries) }) });
  const { plan } = bare;
  const reasons = targetReasons({ root, source, target, requires: plan.requires.map((module) => module.file).filter(Boolean) });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveInner({ before, after: plan.newSource, moduleText: plan.moduleText, plan, parser, source, target, factory, make });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { moved: plan.moved, returned: plan.returned, passed: plan.passed, target,
    lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource) };
  if (bare.dropped.length || bare.kept.length) result.bare = { dropped: bare.dropped, kept: bare.kept };
  if (along.added.length || along.left.length) result.along = along;
  if (dryRun) return result;

  const folder = path.dirname(path.join(root, target));
  const madeFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(root, target), plan.moduleText);
  writeFileSync(path.join(root, source), plan.newSource);
  const group = [source, ...entries.map((entry) => entry.file), target];
  const problems = syntaxProblems(root, [source, target]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), group));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    rmSync(path.join(root, target));
    if (madeFolder && readdirSync(folder).length === 0) rmdirSync(folder);
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  appendLedger(root, source, { file: target, about, names: plan.moved, inner: { factory, make }, ...(bare.dropped.length ? { bare: bare.dropped.map((row) => row.spec) } : {}) });
  return result;
}

/**
 * The `inner` command of cli.mjs.
 * @param {any} parser @param {string} root @param {{ flags: Record<string, any>, rest: string[] }} args
 * @returns {number} the exit code
 */
export function runInner(parser, root, { flags, rest }) {
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  if (!(flags.from && flags.to && flags.factory && flags.make && rest.length)) {
    throw new Refusal(['inner needs --from <file> --factory <function> --to <dir>/<feature>/<file>.js --make <name> --about "<one sentence>" and the functions to move']);
  }
  const dryRun = Boolean(flags['dry-run']);
  const done = moveInner({ root, parser, source: posix(flags.from), target: posix(flags.to), about: flags.about, factory: flags.factory,
    make: flags.make, names: rest, dryRun });
  console.log(`${dryRun ? 'would move' : 'moved'} ${done.moved.join(', ')} out of ${flags.factory} to ${done.target} (${done.lines} lines); `
    + `${posix(flags.from)} ${dryRun ? 'would lose' : 'lost'} ${done.sourceLines} lines.`);
  console.log(`  ${flags.make} is handed ${done.passed.join(', ') || 'nothing'} and gives back ${done.returned.join(', ')}.`);
  if (done.along?.added.length) console.log(`  ${dryRun ? 'would take' : 'took'} along ${done.along.added.join(', ')}: constants only the moved code uses, their values written out.`);
  for (const row of done.along?.left ?? []) console.log(`  ${dryRun ? 'would leave' : 'left'} ${row.name} in ${flags.factory}: ${row.why}.`);
  for (const line of bareLines(done.bare, dryRun)) console.log(line);
  if (!dryRun) console.log('Next: node tools/restructure/gate.mjs');
  return 0;
}
