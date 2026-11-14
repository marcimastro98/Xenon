// Does one extraction on disk: plan, check the target, prove the plan, write both
// files, check them, and put everything back if a check fails. Also redoes the
// recorded extractions from a git revision, to show the files on disk are exactly
// what the tool produces.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { planBlockFor, proveBlockFor } from './block.mjs';
import { redoBranches } from './branches.mjs';
import { diskTree, dropOnDisk } from './dead-requires-disk.mjs';
import { spelledOf } from './extract-inline.mjs';
import { planExtraction, Refusal } from './extract-plan.mjs';
import { tidyPlan } from './extract-tidy.mjs';
import { gathersToRedo, redoGathers } from './gather.mjs';
import { planInnerFor } from './inner.mjs';
import { proveInner } from './inner-proof.mjs';
import { appendLedger, groupsOf, LEDGER, protectedNames, quietModules, readLedger } from './ledger.mjs';
import { planLiftFor, proveLift, repoFileReader } from './lift.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { planPathsFor, provePaths } from './paths.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { planReturnedFor, proveReturned } from './returned.mjs';
import { planSpreadFor, proveSpread } from './spread.mjs';
import { planStateFor, proveState } from './state.mjs';
import { targetReasons } from './target-rules.mjs';
import { proveMove, syntaxProblems, unknownNameProblems } from './verify.mjs';

function planFor({ root, parser, text, source, target, about, names, withDeps, ownModules }) {
  // Where a path leads is asked of the repo the step works in.
  const reach = repoFileReader(root);
  const analysis = analyze(text, parser, source, { fileOf: (spec) => reach(spec, source) });
  const guard = protectedNames(root, source, analysis.records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  const readFile = (file) => (file && existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);
  return planExtraction({ text, analysis, names, source, target, about, withDeps, ownModules, readFile,
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
 * @returns {{ moved: string[], imported: string[], lines: number, sourceLines: number, target: string,
 *   bare?: { dropped: { spec: string, why: string }[], kept: { spec: string, why: string }[] } }}
 *   `bare`: the requires the moved code was the last user of, taken out when proven dead (dead-requires.mjs) or left with the reason;
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function extract(job) {
  const { root, source, target, about, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const entries = readLedger(root).sources[source] ?? [];
  const earlier = entries.map((entry) => entry.file);
  const bare = dropOnDisk({ root, parser: job.parser, source, target, plan: planFor({ ...job, text: before, ownModules: quietModules(entries) }) });
  const plan = tidyPlan(before, bare.plan);
  const requires = [...plan.requires.map((module) => module.file).filter(Boolean), ...plan.asked];
  let spelled;
  try { spelled = spelledOf(plan); } catch (error) { throw new Refusal([error.message]); }
  const reasons = targetReasons({ root, source, target, requires });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveMove({ before, after: plan.newSource, moduleText: plan.moduleText, plan, paths: { source, target, fileOf: repoFileReader(root) } });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { moved: plan.moved, imported: plan.imported, target,
    lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource) };
  if (bare.dropped.length || bare.kept.length) result.bare = { dropped: bare.dropped, kept: bare.kept };
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
  appendLedger(root, source, { file: target, about, names: plan.moved, ...(bare.dropped.length ? { bare: bare.dropped.map((row) => row.spec) } : {}),
    ...(plan.glue.blanks?.length ? { tidy: true } : {}), ...(spelled ? { spelled } : {}), ...(plan.glue.home?.length ? { home: true } : {}) });
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
      // A cut of the object a function returns (returned.mjs) is recorded in the same list, marked `returns`;
      // `list` besides when what it returns is a list (returned-list.mjs).
      const [planFor, prove] = spread.returns ? [planReturnedFor, proveReturned] : [planSpreadFor, proveSpread];
      const plan = planFor({ root, parser, text: out, source, name: spread.name, parts: spread.parts, list: spread.list });
      problems.push(...prove({ before: out, after: plan.newSource, parser, source, spread }).map((p) => `${spread.name}: ${p}`));
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
 * every cut of a frozen object, every move of route bodies and every gather of a
 * factory's variables it does not have either, starting from the revision's copy of the old file, and compares the
 * result with the files on disk byte for byte.
 * @param {{ root: string, parser: any, base: string, show?: (root: string, rev: string, file: string) => string | null }} job
 * @returns {{ problems: string[], replayed: number, files: string[][] }} `files`: per old file, itself and its modules
 */
export function replay({ root, parser, base, show = gitShow }) {
  const problems = [];
  const files = [];
  let replayed = 0;
  let tree = null;
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
    const gathers = gathersToRedo(root, base, show, source);
    replayed += cuts.length + bodies.length + gathers.length;
    // What was done to the file between two entries: the cuts first, then the bodies (the two never touch the same lines),
    // then what a factory remembers gathered into one object (never in a file that has cuts or bodies: gather.mjs refuses it).
    const redo = (count) => {
      const cut = redoCuts({ root, parser, source, base, cuts, count, text, problems });
      const moved = cut === null ? null : redoBranches({ root, parser, source, base, records: bodies, count, text: cut, modules: tables, earlier: entries.slice(0, count), problems });
      return moved === null ? null : redoGathers({ root, parser, source, base, records: gathers, count, text: moved, problems });
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
        else if (entry.inner) plan = planInnerFor({ ...step, ...entry.inner, names: entry.names, ownModules });
        else if (entry.block) plan = planBlockFor({ ...step, ...entry.block, name: entry.names[0] });
        else if (entry.state) {
          plan = planStateFor({ ...step, object: entry.state.object, vars: Object.entries(entry.state.props).map(([name, prop]) => ({ name, prop })) });
        } else plan = planFor({ ...step, names: entry.names, withDeps: false, ownModules });
      } catch (error) {
        problems.push(`${entry.file}: the recorded ${entry.lift ? 'lift' : entry.state ? 'rewrite' : 'move'} cannot be redone from ${base}: ${error.message}`);
        stopped = true;
        break;
      }
      if (entry.bare) {
        // A require the step recorded as taken out: asked again of the tree on disk, with the line back in its place.
        tree ??= diskTree(root);
        const redone = dropOnDisk({ root, parser, plan, source, target: entry.file, only: entry.bare, tree });
        problems.push(...redone.problems.map((p) => `${entry.file}: ${p}`));
        plan = redone.plan;
      }
      // Recorded only when the step took blank lines out, so the steps made before it could are redone as they were.
      if (entry.tidy) plan = tidyPlan(text, plan);
      const texts = { before: text, after: plan.newSource, moduleText: plan.moduleText, plan };
      const proof = entry.paths ? provePaths({ ...texts, parser, source, target: entry.file })
        : entry.lift ? proveLift({ ...texts, parser, source, target: entry.file, fileOf: repoFileReader(root) })
        : entry.inner ? proveInner({ ...texts, parser, source, target: entry.file, ...entry.inner })
        : entry.block ? proveBlockFor({ ...texts, parser, source, target: entry.file, about: entry.about, ...entry.block, name: entry.names[0] })
        : entry.state ? proveState({ ...texts, parser, source }) : proveMove({ ...texts, paths: { source, target: entry.file, fileOf: repoFileReader(root) } });
      // The paths a move spelled again are in the list (engine-source.mjs reads them): the list says what the tool does.
      const plain = !entry.lift && !entry.paths && !entry.inner && !entry.state && !entry.block;
      if (plain && JSON.stringify(spelledOf(plan)) !== JSON.stringify(entry.spelled ?? null)) {
        problems.push(`${entry.file}: the list does not record the paths the move spells again ("spelled")`);
      }
      // The same for a module that says SERVER_DIR where the old file said __dirname.
      if (plain && Boolean(plan.glue.home?.length) !== Boolean(entry.home)) {
        problems.push(`${entry.file}: the list does not say whether the move respells __dirname ("home")`);
      }
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
