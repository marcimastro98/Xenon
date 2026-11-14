// Does one extraction on disk: plan, check the target, prove the plan, write both
// files, check them, and put everything back if a check fails. Also redoes the
// recorded extractions from a git revision, to show the files on disk are exactly
// what the tool produces.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { redoBranches } from './branches.mjs';
import { planExtraction, Refusal } from './extract-plan.mjs';
import { appendLedger, groupsOf, LEDGER, protectedNames, quietModules, readLedger } from './ledger.mjs';
import { planLiftFor, proveLift, repoFileReader } from './lift.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { planPathsFor, provePaths } from './paths.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { planSpreadFor, proveSpread } from './spread.mjs';
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

/** @param {string} root @param {string} rev @param {string} file repo-relative @returns {string | null} the file at that revision, null when it has none */
export function gitShow(root, rev, file) {
  const run = spawnSync('git', ['show', `${rev}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return run.status === 0 ? run.stdout : null;
}

// The cuts of a frozen object (spread.mjs) the revision's own list does not have yet.
function cutsToRedo(root, base, show, source) {
  const had = new Set((JSON.parse(show(root, base, LEDGER) ?? '{}').spreads?.[source] ?? []).map((spread) => spread.name));
  return (readLedger(root).spreads?.[source] ?? []).filter((spread) => !had.has(spread.name));
}

// Redoes the cuts recorded after `count` entries. Returns the new text, or null when one cannot be redone.
function redoCuts({ root, parser, source, base, cuts, count, text, problems }) {
  let out = text;
  for (const spread of cuts.filter((cut) => cut.after === count)) {
    try {
      const plan = planSpreadFor({ root, parser, text: out, source, name: spread.name, parts: spread.parts });
      problems.push(...proveSpread({ before: out, after: plan.newSource, parser, source, spread }).map((p) => `${spread.name}: ${p}`));
      out = plan.newSource;
    } catch (error) {
      problems.push(`${spread.name}: the recorded cut cannot be redone from ${base}: ${error.message}`);
      return null;
    }
  }
  return out;
}

// The moves of route bodies (branches.mjs) the revision's own list does not have yet: the list only grows at its end.
function bodiesToRedo(root, base, show, source) {
  const had = (JSON.parse(show(root, base, LEDGER) ?? '{}').branches?.[source] ?? []).length;
  return (readLedger(root).branches?.[source] ?? []).slice(had);
}

/**
 * Redoes every recorded extraction whose module the revision does not have yet,
 * every cut of a frozen object and every move of route bodies it does not have
 * either, starting from the revision's copy of the old file, and compares the
 * result with the files on disk byte for byte.
 * @param {{ root: string, parser: any, base: string, show?: (root: string, rev: string, file: string) => string | null }} job
 * @returns {{ problems: string[], replayed: number, files: string[][] }} `files`: per old file, itself and its modules
 */
export function replay({ root, parser, base, show = gitShow }) {
  const problems = [];
  const files = [];
  let replayed = 0;
  const ledger = readLedger(root);
  for (const group of groupsOf(ledger)) {
    const source = group[0];
    const entries = ledger.sources[source] ?? [];
    files.push(group);
    let text = show(root, base, source);
    if (text === null) { problems.push(`${base} has no ${source}`); continue; }
    const earlier = [];
    const cuts = cutsToRedo(root, base, show, source);
    const bodies = bodiesToRedo(root, base, show, source);
    const tables = new Map(bodies.map((record) => [record.file, show(root, base, record.file)]));
    replayed += cuts.length + bodies.length;
    // What was done to the file between two entries: the cuts first, then the bodies. The two never touch the same lines.
    const redo = (count) => {
      const cut = redoCuts({ root, parser, source, base, cuts, count, text, problems });
      return cut === null ? null : redoBranches({ root, parser, source, base, records: bodies, count, text: cut, modules: tables, earlier: entries.slice(0, count), problems });
    };
    let stopped = false;
    for (const entry of entries) {
      text = redo(earlier.length);
      stopped = text === null;
      if (stopped) break;
      const ownModules = quietModules(earlier);
      earlier.push(entry);
      if (show(root, base, entry.file) !== null) continue;
      replayed += 1;
      const step = { root, parser, text, source, target: entry.file, about: entry.about };
      let plan;
      try {
        if (entry.lift) plan = planLiftFor({ ...step, name: entry.names[0] });
        else if (entry.paths) plan = planPathsFor({ ...step, names: entry.names });
        else if (entry.state) {
          plan = planStateFor({ ...step, object: entry.state.object, vars: Object.entries(entry.state.props).map(([name, prop]) => ({ name, prop })) });
        } else plan = planFor({ ...step, names: entry.names, withDeps: false, ownModules });
      } catch (error) {
        problems.push(`${entry.file}: the recorded ${entry.lift ? 'lift' : entry.state ? 'rewrite' : 'move'} cannot be redone from ${base}: ${error.message}`);
        stopped = true;
        break;
      }
      const texts = { before: text, after: plan.newSource, moduleText: plan.moduleText, plan };
      const proof = entry.paths ? provePaths({ ...texts, parser, source, target: entry.file })
        : entry.lift ? proveLift({ ...texts, parser, source, target: entry.file, fileOf: repoFileReader(root) })
        : entry.state ? proveState({ ...texts, parser, source }) : proveMove(texts);
      problems.push(...proof.map((p) => `${entry.file}: ${p}`));
      const onDisk = existsSync(path.join(root, entry.file)) ? readFileSync(path.join(root, entry.file), 'utf8') : null;
      if (onDisk !== plan.moduleText) problems.push(`${entry.file} is not what the tool writes: it was edited by hand after the move, or is missing`);
      text = plan.newSource;
    }
    if (!stopped) text = redo(entries.length);
    if (text === null) continue;
    for (const [file, made] of tables) {
      const onDisk = existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null;
      if (onDisk !== made) problems.push(`${file} is not what the tool writes: it was edited by hand in the same step as a move, or is missing`);
    }
    if (readFileSync(path.join(root, source), 'utf8') !== text) {
      problems.push(`${source} differs from ${base} by more than the recorded moves: commit other edits apart from a move`);
    }
  }
  return { problems, replayed, files };
}
