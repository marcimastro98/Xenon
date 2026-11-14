// Does one gather on disk: plan (gather-plan.mjs), prove the plan (gather-proof.mjs), write the
// file, check it, put it back if a check fails, and record the step in the list `verify` redoes
// (extracted.json, under "gathers"). No new file is made: the object stands in the factory.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { planGather } from './gather-plan.mjs';
import { proveGather } from './gather-proof.mjs';
import { LEDGER, protectedNames, readLedger, recordGather } from './ledger.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

/** Plans a gather of `text` with the repo's protected list. Throws a Refusal. */
export function planGatherFor({ root, parser, text, source, factory, object, names }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  return planGather({ text, parser, source, factory, object, names, protectedNames: guard.names });
}

/**
 * @param {object} job
 * @param {string} job.root repo root @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file of the factory @param {string} job.factory the top-level function
 * @param {string} job.object the name of the object @param {string[]} [job.names] the variables; every let of the body when left out
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ names: string[], kept: string[], counts: Record<string, { found: number, shorthand: number, moved: boolean }>, between: number[], sourceLines: number }}
 *   throws a Refusal before anything is written, an Error after a failed check (file put back)
 */
export function gather(job) {
  const { root, parser, source, factory, object, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const ledger = readLedger(root);
  const tabled = ['branches', 'spreads'].filter((list) => ledger[list]?.[source]);
  if (tabled.length) throw new Refusal([`${source} has ${tabled.join(' and ')} recorded: a gather in the same file could not be redone in a known order`]);
  const plan = planGatherFor({ ...job, text: before });
  const proof = proveGather({ before, after: plan.newSource, plan, parser, source });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { names: plan.names, kept: plan.kept, counts: plan.counts, between: plan.between, sourceLines: count(plan.newSource) - count(before) };
  if (dryRun) return result;

  writeFileSync(path.join(root, source), plan.newSource);
  const entries = ledger.sources[source] ?? [];
  const problems = syntaxProblems(root, [source]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), [source, ...entries.map((entry) => entry.file)]));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    throw new Error(`the rewrite failed its checks and was undone:\n${problems.join('\n')}`);
  }
  recordGather(root, source, { factory, object, names: plan.names, kept: plan.kept, bare: plan.bare, after: entries.length });
  return result;
}

/**
 * The gathers of a file the revision's own list does not have yet: the list only grows at its end.
 * @param {string} root @param {string} base @param {(root: string, rev: string, file: string) => string | null} show @param {string} source
 */
export function gathersToRedo(root, base, show, source) {
  const had = (JSON.parse(show(root, base, LEDGER) ?? '{}').gathers?.[source] ?? []).length;
  return (readLedger(root).gathers?.[source] ?? []).slice(had);
}

/**
 * Redoes the gathers recorded after `count` entries of the file's list of moves.
 * @returns {string | null} the new text, null when one cannot be redone
 */
export function redoGathers({ root, parser, source, base, records, count, text, problems }) {
  let out = text;
  for (const record of records.filter((entry) => entry.after === count)) {
    const label = `${source}, ${record.object} of ${record.factory}`;
    try {
      const plan = planGatherFor({ root, parser, text: out, source, factory: record.factory, object: record.object, names: record.names });
      problems.push(...proveGather({ before: out, after: plan.newSource, plan, parser, source }).map((problem) => `${label}: ${problem}`));
      if (plan.kept.join() !== record.kept.join() || plan.bare.join() !== record.bare.join()) problems.push(`${label}: the recorded gather is not the one the tool makes from ${base}`);
      out = plan.newSource;
    } catch (error) {
      problems.push(`${label}: the recorded gather cannot be redone from ${base}: ${error.message}`);
      return null;
    }
  }
  return out;
}

/**
 * The `gather` command of cli.mjs.
 * @param {any} parser @param {string} root @param {{ flags: Record<string, any>, rest: string[] }} args
 * @returns {number} the exit code
 */
export function runGather(parser, root, { flags, rest }) {
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  if (!(flags.from && flags.factory && flags.object)) {
    throw new Refusal(['gather needs --from <file> --factory <function> --object <name>, and the variables when not every let of the body is meant']);
  }
  const dryRun = Boolean(flags['dry-run']);
  const source = posix(flags.from);
  const done = gather({ root, parser, source, factory: flags.factory, object: flags.object, names: rest, dryRun });
  console.log(`${dryRun ? 'would gather' : 'gathered'} ${done.names.length} variables of ${flags.factory} into ${flags.object}; ${source} ${dryRun ? 'would grow' : 'grew'} by ${done.sourceLines} lines.`);
  for (const [name, count] of Object.entries(done.counts)) {
    console.log(`  ${name} -> ${flags.object}.${name}: ${count.found} uses rewritten${count.shorthand ? ` (${count.shorthand} of them a { ${name} } written out)` : ''}; `
      + (count.moved ? 'its first value is in the object' : 'its first value is still given on the line where the let stood'));
  }
  if (done.between.length) {
    console.log(`  Statements that call something between the first let and the last (${source}, lines ${done.between.join(', ')}): none can reach a later let by a name. `
      + 'A function kept in an object by an earlier line and called through that object is not seen: read these lines.');
  }
  if (!dryRun) console.log('Next: node tools/restructure/gate.mjs');
  return 0;
}
