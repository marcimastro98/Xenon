// Does one extraction on disk: plan, check the target, prove the plan, write both
// files, check them, and put everything back if a check fails. Also redoes the
// recorded extractions from a git revision, to show the files on disk are exactly
// what the tool produces.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { planExtraction, Refusal } from './extract-plan.mjs';
import { appendLedger, protectedNames, quietModules, readLedger } from './ledger.mjs';
import { planLiftFor, proveLift, repoFileReader } from './lift.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { planStateFor, proveState } from './state.mjs';
import { targetReasons } from './target-rules.mjs';
import { proveMove, syntaxProblems, unknownNameProblems } from './verify.mjs';

function planFor({ root, parser, text, source, target, about, names, withDeps, ownModules }) {
  const analysis = analyze(text, parser, source);
  const guard = protectedNames(root, source, analysis.records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planExtraction({ text, analysis, names, source, target, about, withDeps, ownModules,
    rewrite: createSpecRewriter(root), protectedNames: guard.names, protectedStretches: guard.stretches });
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file the code leaves
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string[]} job.names declarations to move
 * @param {boolean} [job.withDeps] also move what they need from the old file
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ moved: string[], imported: string[], lines: number, sourceLines: number, target: string }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function extract(job) {
  const { root, source, target, about, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const entries = readLedger(root).sources[source] ?? [];
  const earlier = entries.map((entry) => entry.file);
  const plan = planFor({ ...job, text: before, ownModules: quietModules(entries) });
  const requires = plan.requires.map((module) => module.file).filter(Boolean);
  const reasons = targetReasons({ root, source, target, requires });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveMove({ before, after: plan.newSource, moduleText: plan.moduleText, plan });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { moved: plan.moved, imported: plan.imported, target,
    lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource) };
  if (dryRun) return result;

  const folder = path.dirname(path.join(root, target));
  const madeFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(root, target), plan.moduleText);
  writeFileSync(path.join(root, source), plan.newSource);
  const group = [source, ...earlier, target];
  const problems = syntaxProblems(root, [source, target]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), group));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    rmSync(path.join(root, target));
    if (madeFolder && readdirSync(folder).length === 0) rmdirSync(folder);
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  appendLedger(root, source, { file: target, about, names: plan.moved });
  return result;
}

function gitShow(root, rev, file) {
  const run = spawnSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

/**
 * Redoes every recorded extraction whose module the revision does not have yet,
 * starting from the revision's copy of the old file, and compares the result with
 * the files on disk byte for byte.
 * @param {{ root: string, parser: any, base: string, show?: (root: string, rev: string, file: string) => string | null }} job
 * @returns {{ problems: string[], replayed: number, files: string[][] }} `files`: per old file, itself and its modules
 */
export function replay({ root, parser, base, show = gitShow }) {
  const problems = [];
  const files = [];
  let replayed = 0;
  for (const [source, entries] of Object.entries(readLedger(root).sources)) {
    files.push([source, ...entries.map((entry) => entry.file)]);
    let text = show(root, base, source);
    if (text === null) { problems.push(`${base} has no ${source}`); continue; }
    const earlier = [];
    for (const entry of entries) {
      const ownModules = quietModules(earlier);
      earlier.push(entry);
      if (show(root, base, entry.file) !== null) continue;
      replayed += 1;
      const step = { root, parser, text, source, target: entry.file, about: entry.about };
      let plan;
      try {
        if (entry.lift) plan = planLiftFor({ ...step, name: entry.names[0] });
        else if (entry.state) {
          plan = planStateFor({ ...step, object: entry.state.object, vars: Object.entries(entry.state.props).map(([name, prop]) => ({ name, prop })) });
        } else plan = planFor({ ...step, names: entry.names, withDeps: false, ownModules });
      } catch (error) {
        problems.push(`${entry.file}: the recorded ${entry.lift ? 'lift' : entry.state ? 'rewrite' : 'move'} cannot be redone from ${base}: ${error.message}`);
        break;
      }
      const texts = { before: text, after: plan.newSource, moduleText: plan.moduleText, plan };
      const proof = entry.lift ? proveLift({ ...texts, parser, source, target: entry.file, fileOf: repoFileReader(root) })
        : entry.state ? proveState({ ...texts, parser, source }) : proveMove(texts);
      problems.push(...proof.map((p) => `${entry.file}: ${p}`));
      const onDisk = existsSync(path.join(root, entry.file)) ? readFileSync(path.join(root, entry.file), 'utf8') : null;
      if (onDisk !== plan.moduleText) problems.push(`${entry.file} is not what the tool writes: it was edited by hand after the move, or is missing`);
      text = plan.newSource;
    }
    if (readFileSync(path.join(root, source), 'utf8') !== text) {
      problems.push(`${source} differs from ${base} by more than the recorded moves: commit other edits apart from a move`);
    }
  }
  return { problems, replayed, files };
}
