// Gives a run of statements the file works through while it loads a module of its own: the statements go there
// unchanged, in their order, and the file requires the module on the line where the first of them stood. So the
// same code runs at the same moment, between the same neighbours, and the file gets the same values under the
// same names.
//
//   node tools/restructure/cli.mjs wire --from <file> --to <dir>/<feature>/<file>.js --about "<one sentence>" [--dry-run] <first> [<last>]
//
// `lift` does this for one value that needs nothing of its file. Here the run may hold several values, the
// functions and variables they name, and statements that declare nothing; what it reads from outside itself must
// be a plain `require` standing above it, which the new module asks for again (loaded already: nothing loads
// earlier). The rules:
//   - the run is consecutive: from the first named declaration to the last, with everything between;
//   - every name it reads is its own, a `require` above it, or the language's; nothing that means "this file";
//   - no name of the run is assigned outside it, and a name the run assigns again later is not handed out
//     (the file would keep the first value);
//   - no statement above the run can reach one of its functions while the file loads: a function declaration
//     could be called from the first line of the file, a required one only after its require.
// The proof is in wire-proof.mjs, written apart. The module is recorded as one that runs code at load
// (`wire` in extracted.json): later moves never drop its require line and never let it load earlier.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze, FILE_BOUND } from './analyze.mjs';
import { loadUseTest, MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { appendLedger, protectedNames, readLedger } from './ledger.mjs';
import { readShape, repoFileReader } from './lift.mjs';
import { createSpecRewriter, requireLines, wrapNames } from './module-requires.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { topStatements } from './state-refs.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';
import { proveWire } from './wire-proof.mjs';

const STRICT = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/;

/** @param {string[]} names @param {string} source @param {string} target @returns {string[]} the lines that stand where the run stood */
export function glueLines(names, source, target) {
  const from = path.posix.relative(path.posix.dirname(source), target);
  return wrapNames(names, 'const {', `} = require('${from.startsWith('.') ? from : `./${from}`}');`);
}

/** @param {string[]} names @returns {string} the last line of the new module */
export const exportLine = (names) => `module.exports = { ${names.join(', ')} };`;

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative old file
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.first the first declaration of the run
 * @param {string} [job.last] the last one (the first, when the run is one declaration)
 * @param {(spec: string, from: string, to: string) => { spec: string, kind: string, file: string | null }} job.rewrite
 * @param {Set<string>} [job.protectedNames] names that never leave the file
 * @param {number[][]} [job.protectedStretches] statements that are never edited, as pairs of positions
 * @param {(file: string | null) => string | null} [job.readFile] the text of a repo file, to look into what the run requires
 * @param {number} [job.maxLines]
 * @returns {{ names: string[], exports: string[], newSource: string, moduleText: string, first: number, last: number, glue: string[],
 *   needs: string[], requires: { from: string, to: string, file: string | null }[], files: string[] }}
 *   `first`..`last` are the 0-based lines that left. Throws a Refusal.
 */
export function planWire({ text, parser, source, target, about, first: firstName, last: lastName = firstName, rewrite,
  protectedNames: kept = new Set(), protectedStretches = [], readFile = () => null, maxLines = MAX_LINES }) {
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: the tools work on LF text only`]);
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file does (--about)']);
  const sourceFile = parser.parse(text, source);
  const nodes = topStatements(sourceFile, parser);
  const { records, bindings } = analyze(text, parser, source);
  const ends = [firstName, lastName].map((name) => bindings.get(name)?.record);
  const missing = [firstName, lastName].filter((_name, at) => !ends[at]);
  if (missing.length) throw new Refusal(missing.map((name) => `${name} is not a top-level declaration of ${source}`));
  if (ends[0].index > ends[1].index) throw new Refusal([`${lastName} stands above ${firstName}: name the first declaration of the run, then the last`]);
  const run = records.slice(ends[0].index, ends[1].index + 1);
  const inRun = new Set(run);
  const names = run.flatMap((record) => record.names);
  const own = new Set(names);
  const reasons = [];
  const needs = new Set();
  const requires = [];

  for (const record of run) {
    const at = `line ${record.line[0]}`;
    if (record.sharesLine) reasons.push(`${at} shares its line with another statement`);
    if (record.kind === 'var') reasons.push(`${at} declares with var`);
    if (record.names.some((name) => kept.has(name)) || protectedStretches.some(([from, to]) => record.index >= from && record.index <= to)) {
      reasons.push(`${at} is protected code and stays where it is`);
    }
    for (const used of record.uses.keys()) {
      if (own.has(used)) continue;
      if ((FILE_BOUND.has(used) && used !== 'require') || used === 'arguments') { reasons.push(`${at} uses ${used}, which means another thing in another file`); continue; }
      const binding = bindings.get(used);
      if (!binding) continue;
      if (binding.kind === 'require' && binding.record.index < run[0].index) needs.add(used);
      else if (binding.kind === 'require') reasons.push(`${at} uses ${used}, which ${source} requires only at line ${binding.record.line[0]}, below the run`);
      else reasons.push(`${at} uses ${used} of ${source} (line ${binding.record.line[0]}): the run may read only itself and what is required above it`);
    }
    const shape = readShape(nodes[record.index], parser.K);
    if (shape.self) reasons.push(`${at} uses this, which is the file's own exports`);
    if (shape.oddRequires) reasons.push(`${at} uses require as something other than require('<text>')`);
    for (const literal of shape.requires) {
      if (!literal.text.startsWith('.')) continue;
      let to;
      try { to = rewrite(literal.text, source, target); } catch (error) { reasons.push(`${at}: ${error.message}`); continue; }
      // A module can ask who required it first: that would be the new module now.
      if (record.kind === 'require' && /\bmodule\s*\.\s*parent\b/.test(readFile(to.file) ?? '')) reasons.push(`${to.file} reads module.parent, which would be the new module`);
      requires.push({ from: literal.text, to: to.spec, file: to.file, start: literal.getStart(sourceFile), end: literal.end });
    }
  }

  const outside = records.filter((record) => !inRun.has(record));
  const exports = names.filter((name) => outside.some((record) => record.uses.has(name)));
  for (const name of names) {
    const writer = outside.find((record) => (record.uses.get(name)?.write ?? 0) > 0);
    if (writer) reasons.push(`line ${writer.line[0]} assigns ${name}, which the run declares: the file would write to its own copy`);
    else if (bindings.get(name).reassigned && exports.includes(name)) {
      reasons.push(`${name} is assigned again inside the run and read outside it: the file would keep the value it had when the module loaded`);
    }
  }
  if (exports.length === 0) reasons.push('nothing outside the run uses a name it declares: there is nothing for the file to require');
  const functions = run.filter((record) => record.kind === 'function');
  const reachesAtLoad = loadUseTest({ records, seeds: functions, names: functions.flatMap((record) => record.names), bindings });
  for (const record of records.slice(0, run[0].index)) {
    if (functions.length && reachesAtLoad(record)) {
      reasons.push(`line ${record.line[0]} runs while the file loads and can reach a function of the run, which today is callable from the first line `
        + 'of the file and afterwards only below its require');
    }
  }
  if (reasons.length) throw new Refusal([...new Set(reasons)]);

  const lines = text.split('\n');
  const first = run[0].range[0] - 1;
  const last = run.at(-1).line[1] - 1;
  // Respell from the last one back, so the offsets before it stay true. The quotes stay the ones that were there.
  let moved = text;
  for (const spec of [...requires].sort((a, b) => b.start - a.start)) moved = `${moved.slice(0, spec.start + 1)}${spec.to}${moved.slice(spec.end - 1)}`;
  const grown = requires.reduce((sum, spec) => sum + spec.to.length - spec.from.length, 0);
  const starts = lines.reduce((list, line) => { list.push(list.at(-1) + line.length + 1); return list; }, [0]);
  const blockText = moved.slice(starts[first], starts[last + 1] - 1 + grown);
  const head = requireLines([...needs], bindings, (spec) => rewrite(spec, source, target));
  const moduleText = [...(STRICT.test(text) ? ["'use strict';"] : []), ...wrapComment(about), '', ...head.lines, ...(head.lines.length ? [''] : []),
    blockText, '', exportLine(exports), ''].join('\n');
  if (moduleText.split('\n').length - 1 > maxLines) {
    throw new Refusal([`${target} would be ${moduleText.split('\n').length - 1} lines, the limit for a new file is ${maxLines}`]);
  }
  const glue = glueLines(exports, source, target);
  const newSource = [...lines.slice(0, first), ...glue, ...lines.slice(last + 1)].join('\n');
  return { names, exports, newSource, moduleText, first, last, glue, needs: [...needs],
    requires: requires.map(({ from, to, file }) => ({ from, to, file })),
    files: [...new Set([...head.modules, ...requires].map((spec) => spec.file).filter(Boolean))] };
}

/** Plans a run of `text` with the repo's lists. Throws a Refusal. */
export function planWireFor({ root, parser, text, source, target, about, first, last }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  const readFile = (file) => (file && existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);
  return planWire({ text, parser, source, target, about, first, last, rewrite: createSpecRewriter(root), protectedNames: guard.names,
    protectedStretches: guard.stretches, readFile });
}

/** @param {{ requires: { from: string, to: string }[] }} plan @returns {Record<string, string> | null} new spelling of a path to the old one */
export function wireSpelled(plan) {
  const changed = plan.requires.filter((spec) => spec.from !== spec.to);
  return changed.length ? Object.fromEntries(changed.map((spec) => [spec.to, spec.from])) : null;
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file that runs the statements
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.first the first declaration of the run
 * @param {string} [job.last] the last one
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ target: string, lines: number, sourceLines: number, names: string[], exports: string[], needs: string[] }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function wireRun(job) {
  const { root, parser, source, target, about, first, last = first, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const plan = planWireFor({ root, parser, text: before, source, target, about, first, last });
  const reasons = targetReasons({ root, source, target, requires: plan.files });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveWire({ before, after: plan.newSource, moduleText: plan.moduleText, plan, parser, source, target, fileOf: repoFileReader(root) });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { target, lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource), names: plan.names, exports: plan.exports, needs: plan.needs };
  if (dryRun) return result;

  const folder = path.dirname(path.join(root, target));
  const madeFolder = !existsSync(folder);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(root, target), plan.moduleText);
  writeFileSync(path.join(root, source), plan.newSource);
  const earlier = (readLedger(root).sources[source] ?? []).map((entry) => entry.file);
  const problems = syntaxProblems(root, [source, target]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), [source, ...earlier, target]));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    rmSync(path.join(root, target));
    if (madeFolder && readdirSync(folder).length === 0) rmdirSync(folder);
    throw new Error(`the step failed its checks and was undone:\n${problems.join('\n')}`);
  }
  const spelled = wireSpelled(plan);
  appendLedger(root, source, { file: target, about, names: plan.names, wire: { first, last }, ...(spelled ? { spelled } : {}) });
  return result;
}

/** The `wire` command of cli.mjs. */
export function runWire(parser, root, { flags, rest }) {
  const dryRun = Boolean(flags['dry-run']);
  const posix = (file) => String(file).split(path.sep).join('/');
  const done = wireRun({ root, parser, source: posix(flags.from), target: posix(flags.to), about: flags.about, first: rest[0], last: rest[1] ?? rest[0], dryRun });
  console.log(`${dryRun ? 'would make' : 'made'} ${done.target} (${done.lines} lines); ${posix(flags.from)} ${dryRun ? 'would lose' : 'lost'} ${done.sourceLines} lines `
    + 'and requires the module on the line where the run began.');
  console.log(`  runs there, in the same order: ${done.names.join(', ')}`);
  console.log(`  handed back to the file: ${done.exports.join(', ')}`);
  if (done.needs.length) console.log(`  required again by the module (loaded above already): ${done.needs.join(', ')}`);
  if (!dryRun) console.log('Next: node tools/restructure/gate.mjs, and node tools/restructure/load-order.mjs --base HEAD');
  return 0;
}
