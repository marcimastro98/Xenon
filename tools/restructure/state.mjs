// Does one state rewrite on disk: plan, check the target, prove the plan, write
// both files, check them, put everything back if a check fails, and record it in
// the list `verify` redoes (extracted.json). Also the proof itself, written apart
// from the planner so a mistake there shows up here.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { appendLedger, protectedNames, readLedger } from './ledger.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { KEPT_NOTE, planState } from './state-plan.mjs';
import { readReferences } from './state-refs.mjs';
import { statePattern, undoStateText } from './state-undo.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

/** Plans a rewrite of `text` with the repo's protected list. Throws a Refusal. */
export function planStateFor({ root, parser, text, source, target, about, object, vars }) {
  const analysis = analyze(text, parser, source);
  const guard = protectedNames(root, source, analysis.records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planState({ text, analysis, sourceFile: parser.parse(text, source), parser, source, target, about, object, vars,
    protectedNames: guard.names, protectedStretches: guard.stretches });
}

// The lines of the new module that hold the values, without the frame the tool writes around them.
function moduleRows(moduleText, object) {
  const lines = moduleText.split('\n');
  const open = lines.indexOf(`const ${object} = {`);
  const close = lines.indexOf('};', open + 1);
  const frame = [...lines.slice(0, open), ...lines.slice(close + 1)].filter((line) => line !== '' && !line.startsWith('//') && line !== "'use strict';");
  return { rows: open === -1 || close === -1 ? null : lines.slice(open + 1, close), frame };
}

/**
 * The checks that need only the texts and a parser.
 * @param {object} rewrite
 * @param {string} rewrite.before the old file before
 * @param {string} rewrite.after the old file after
 * @param {string} rewrite.moduleText the new module
 * @param {ReturnType<typeof planState>} rewrite.plan
 * @param {any} rewrite.parser
 * @param {string} [rewrite.source]
 * @returns {string[]} problems, empty when the rewrite is proven
 */
export function proveState({ before, after, moduleText, plan, parser, source = 'file.js' }) {
  const problems = [];
  const { object, props, kept, counts, glue, removed } = plan;

  // 1. Undone, the file is the old file byte for byte: the require goes, the names come back, the declarations return.
  const now = after.split('\n');
  if (now.slice(glue.at, glue.at + glue.lines.length).join('\n') !== glue.lines.join('\n')) problems.push('the new require is not where the plan put it');
  now.splice(glue.at, glue.lines.length);
  const undone = undoStateText(now.join('\n'), { object, props, kept }).split('\n');
  for (const block of [...removed].sort((a, b) => a.line - b.line)) undone.splice(block.line - 1, 0, ...block.lines);
  if (undone.join('\n') !== before) problems.push('undoing the rewrite does not give the old file back byte for byte');

  // 2. The module holds every value that left, as it was written, with its comments, and nothing else.
  const expected = [];
  for (const name of Object.keys(props)) {
    const block = removed.find((entry) => entry.name === name);
    if (!block) { expected.push(`  ${props[name]}: undefined, // ${KEPT_NOTE}`); continue; }
    const code = block.lines.findIndex((line) => line.startsWith('let '));
    const written = block.value === null ? `let ${name};${block.trail}` : `let ${name}${block.eq}${block.value};${block.trail}`;
    if (block.lines[code] !== written) problems.push(`${name}: the declaration that left is not the one the plan describes`);
    if (block.lines.slice(code + 1).some((line) => line.trim() !== '')) problems.push(`${name}: code after the declaration left with it`);
    if (block.lines.slice(0, code).some((line) => !line.startsWith('//'))) problems.push(`${name}: something other than its comment left with it`);
    expected.push(...block.lines.slice(0, code).map((line) => `  ${line}`), `  ${props[name]}: ${block.value ?? 'undefined'},${block.trail}`);
  }
  const { rows, frame } = moduleRows(moduleText, object);
  if (!rows || rows.join('\n') !== expected.join('\n')) problems.push('the new module does not hold exactly the values that left the file');
  if (frame.join('\n') !== `module.exports = { ${object} };`) problems.push('the new module has code besides the object and its export');

  // 3. Read again from nothing: no old name is declared or used, and the object is used exactly as often as the old
  //    names were found, always as one of the properties.
  const analysis = analyze(after, parser, source);
  for (const name of Object.keys(props)) {
    if (analysis.bindings.has(name)) problems.push(`${name} is still declared`);
    if (analysis.records.some((record) => record.uses.has(name))) problems.push(`${name} is still used`);
  }
  const uses = readReferences(parser.parse(after, source), parser, new Set([object]), object);
  const seen = Object.fromEntries(Object.keys(props).map((name) => [name, 0]));
  const nameOf = new Map(Object.entries(props).map(([name, prop]) => [prop, name]));
  for (const use of uses) {
    const prop = /^\.([A-Za-z_$][\w$]*)/.exec(after.slice(use.end, use.end + 200))?.[1];
    if (prop && nameOf.has(prop)) seen[nameOf.get(prop)] += 1;
    else problems.push(`${object} is used at offset ${use.start} as something other than one of the new properties`);
  }
  for (const [name, count] of Object.entries(counts)) {
    const wanted = count.found + (count.moved ? 0 : 1);
    if (seen[name] !== wanted) problems.push(`${name}: ${count.found} uses were found, the new text has ${seen[name]} of ${object}.${props[name]} (${wanted} expected)`);
    const asText = (after.match(statePattern(object, props[name])) ?? []).length;
    if (asText !== wanted) problems.push(`${name}: the text ${object}.${props[name]} stands ${asText} times in the new file, ${wanted} expected`);
  }
  return problems;
}

/**
 * The list of statements that only hand over functions while the file loads (load-registrations.json) finds each
 * statement by its first line. A line that holds a renamed variable reads differently now: the entry follows it.
 * Only the spelling of that one line changes; an entry whose line is not found exactly once stays as it is and the
 * analysis reports it.
 * @param {any} json the parsed list @param {string} source @param {string} after the rewritten file
 * @param {{ object: string, props: Record<string, string> }} state
 * @returns {string[]} the first lines that were respelled, as they read now
 */
export function followRegistrations(json, source, after, { object, props }) {
  const lines = after.split('\n').map((line) => line.trim());
  const changed = [];
  for (const entry of json.files?.[source] ?? []) {
    const old = String(entry.statement ?? '').trim();
    if (lines.includes(old)) continue;
    const now = [...new Set(lines.filter((line) => undoStateText(line, { object, props, kept: [] }) === old))];
    if (now.length !== 1) continue;
    entry.statement = now[0];
    changed.push(now[0]);
  }
  return changed;
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file that holds the variables
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.object the name of the object
 * @param {{ name: string, prop: string }[]} job.vars
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ target: string, counts: Record<string, { found: number, inProtected: number, moved: boolean }>, sourceLines: number, lines: number }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function rewriteState(job) {
  const { root, parser, source, target, about, object, vars, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const plan = planStateFor({ root, parser, text: before, source, target, about, object, vars });
  const reasons = targetReasons({ root, source, target, requires: [] });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveState({ before, after: plan.newSource, moduleText: plan.moduleText, plan, parser, source });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { target, counts: plan.counts, sourceLines: count(before) - count(plan.newSource), lines: count(plan.moduleText) };
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
    throw new Error(`the rewrite failed its checks and was undone:\n${problems.join('\n')}`);
  }
  const listFile = path.join(root, 'tools/restructure/load-registrations.json');
  const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, 'utf8')) : null;
  if (list && followRegistrations(list, source, plan.newSource, plan).length) writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
  appendLedger(root, source, { file: target, about, names: Object.keys(plan.props), state: { object, props: plan.props, kept: plan.kept, bare: plan.removed.filter((block) => block.value === null).map((block) => block.name) } });
  return result;
}
