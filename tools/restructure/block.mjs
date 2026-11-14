// Moves the lines of one block `if (<test>) { ... return; }` out of a long function into a function of a new
// module, on disk: plan, check the target, prove the plan by undoing it (block-proof.mjs), write both files,
// check them, and put everything back if a check fails. What the block may rely on is in block-scope.mjs, the
// few lines written around the moved ones in block-text.mjs.
//
// The step is recorded in extracted.json like a move (`block: { handler, test }`), so `verify` redoes it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { proveBlock } from './block-proof.mjs';
import { readBlock } from './block-scope.mjs';
import { callLines, exportLine, headLine, noteSentence, placeRequire, requireLine, specOf, takeLines, TYPE_LINE } from './block-text.mjs';
import { MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { appendLedger, branchHandlers, protectedNames, readLedger } from './ledger.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

/**
 * @param {object} job
 * @param {string} job.text the old file @param {any} job.parser @param {{ records: any[], bindings: Map<string, any> }} job.analysis of the same text
 * @param {string} job.source @param {string} job.target repo-relative @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.handler the function the block is in @param {string} job.test the block's test as written @param {string} job.name the new function
 * @param {Set<string>} job.allowed the functions of the file a step may take lines out of
 * @param {number[][]} [job.stretches] runs of the file that get no new line, as [first, last] positions in the records
 * @returns {{ newSource: string, moduleText: string, moved: string[], handed: string[], requires: any[], lines: number, sourceLines: number }}
 *   throws a Refusal with every reason at once
 */
export function planBlock({ text, parser, analysis, source, target, about, handler, test, name, allowed, stretches = [] }) {
  const reasons = [];
  if (!allowed.has(handler)) reasons.push(`${handler} is not a function lines may be taken out of (\`branches\` of ${source} in tools/restructure/protected.json)`);
  if (!/^[A-Za-z_$][\w$]*$/.test(name ?? '')) throw new Refusal([`${name} is not a name a function can have`]);
  if (new RegExp(`(?<![\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(text) || name in globalThis) reasons.push(`${source} has the word ${name} already: give the new function a name of its own`);
  if (!String(about ?? '').trim()) reasons.push('the new module needs one sentence saying what it does (--about)');
  const read = readBlock({ text, parser, analysis, handler, test });
  reasons.push(...read.reasons);
  if (reasons.length) throw new Refusal(reasons);

  const lines = text.split('\n');
  const body = lines.slice(read.first, read.last + 1);
  const moduleLines = [...wrapComment(about), '', ...wrapComment(noteSentence(handler, source, test)), TYPE_LINE, headLine(name), ...takeLines(read.handed),
    ...body, '}', '', exportLine(name), ''];
  if (moduleLines.length - 1 > MAX_LINES) throw new Refusal([`${target} would have ${moduleLines.length - 1} lines, over the limit of ${MAX_LINES}: the block is too long to move in one piece`]);

  lines.splice(read.first, body.length, ...callLines(name, read.handed, `${read.indent}  `));
  const record = analysis.bindings.get(handler).record;
  const landed = placeRequire(lines, record.range[0] - 1, requireLine(name, specOf(source, target)));
  // The require is a new line, and a protected stretch gets no new line.
  const next = analysis.records.findIndex((other) => other.range[0] - 1 >= landed);
  if (stretches.some(([first, last]) => next > first && next <= last)) {
    throw new Refusal([`the require of ${name} would stand at line ${landed + 1} of ${source}, inside a protected stretch that is never edited`]);
  }
  const newSource = lines.join('\n');
  return { newSource, moduleText: moduleLines.join('\n'), moved: [name], handed: read.handed, requires: [],
    lines: moduleLines.length - 1, sourceLines: text.split('\n').length - lines.length };
}

/** Plans a step on `text` with the repo's own lists. Throws a Refusal. */
export function planBlockFor({ root, parser, text, source, target, about, handler, test, name }) {
  const analysis = analyze(text, parser, source);
  const guard = protectedNames(root, source, analysis.records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planBlock({ text, parser, analysis, source, target, about, handler, test, name, allowed: branchHandlers(root, source), stretches: guard.stretches });
}

/** Proves a planned or recorded step. @returns {string[]} problems */
export function proveBlockFor({ parser, before, after, moduleText, source, target, about, handler, test, name }) {
  return proveBlock({ before, after, moduleText, parser, analysis: analyze(before, parser, source), source, target, handler, test, name, about });
}

/**
 * @param {object} job
 * @param {string} job.root repo root @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file of the function @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.handler the function the block is in @param {string} job.test the block's test as written @param {string} job.name the new function
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ name: string, handed: string[], lines: number, sourceLines: number, target: string }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function moveBlock({ root, parser, source, target, about, handler, test, name, dryRun = false }) {
  const before = readFileSync(path.join(root, source), 'utf8');
  const entries = readLedger(root).sources[source] ?? [];
  const plan = planBlockFor({ root, parser, text: before, source, target, about, handler, test, name });
  const reasons = targetReasons({ root, source, target });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveBlockFor({ parser, before, after: plan.newSource, moduleText: plan.moduleText, source, target, about, handler, test, name });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const result = { name, handed: plan.handed, lines: plan.lines, sourceLines: plan.sourceLines, target };
  if (dryRun) return result;

  const folder = path.dirname(path.join(root, target));
  const madeFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(root, target), plan.moduleText);
  writeFileSync(path.join(root, source), plan.newSource);
  const problems = syntaxProblems(root, [source, target]);
  if (problems.length === 0 && checksAvailable(root)) {
    problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), [source, ...entries.map((entry) => entry.file), target]));
  }
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    rmSync(path.join(root, target));
    if (madeFolder && readdirSync(folder).length === 0) rmdirSync(folder);
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  appendLedger(root, source, { file: target, about, names: [name], block: { handler, test } });
  return result;
}
