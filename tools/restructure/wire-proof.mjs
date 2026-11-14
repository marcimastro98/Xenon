// The proof of a `wire` step (wire.mjs), written apart from its planner: it works from the three texts and the
// two line numbers of the plan, and reads everything else again from nothing.
//
//   1. The file is the old file with the run gone and one require in its place. Above it, a require the run alone
//      used is the same require with fewer names, on the same line.
//   2. Put back where that require stands, the lines of the module's body give the old file byte for byte
//      (but for a relative require spelled for the new folder, which is followed to the same file).
//   3. Above its body the module has only its comment and requires, each one a require the old file has above
//      the run, of the same file, for the same names.
//   4. Read again: the file gets every name it still uses from that one require and assigns none; the module
//      uses nothing the old file declares outside the run and nothing that means "this file".
//   5. In the old file no statement outside the run assigns a name of the run, and none above it can reach
//      one of its functions while the file loads.

import path from 'node:path';

import { analyze, FILE_BOUND } from './analyze.mjs';
import { loadUseTest } from './extract-plan.mjs';
import { readShape } from './lift.mjs';
import { requireEditProblem } from './require-edits.mjs';
import { topStatements } from './state-refs.mjs';

const REQUIRE_CALL = /require\((['"])([^'"]+)\1\)/g;
const plainModule = (spec) => spec.replace(/^node:/, '');

// The lines of the module's body, and what stands above them; null when the module is not framed as the tool frames it.
function readFrame(moduleText, count) {
  const made = moduleText.split('\n');
  const tailAt = made.length - 3;
  const bodyAt = tailAt - count;
  if (bodyAt < 2 || made[tailAt] !== '' || made.at(-1) !== '' || !/^module\.exports = \{ [\w$]+(?:, [\w$]+)* \};$/.test(made[tailAt + 1])) return null;
  if (made[bodyAt - 1] !== '') return null;
  return { head: made.slice(0, bodyAt - 1), body: made.slice(bodyAt, tailAt), bodyAt, exports: made[tailAt + 1].slice('module.exports = { '.length, -' };'.length).split(', ') };
}

/**
 * @param {object} step
 * @param {string} step.before the old file before
 * @param {string} step.after the old file after
 * @param {string} step.moduleText the new module
 * @param {{ first: number, last: number, edits?: { first: number, count: number, newLines: string[] }[] }} step.plan the 0-based lines of
 *   the run in the old file, and the lines above it that are requires with fewer names now
 * @param {any} step.parser
 * @param {string} step.source repo-relative old file
 * @param {string} step.target repo-relative new module
 * @param {(spec: string, from: string) => string | null} step.fileOf the repo file a relative require in `from` reaches
 * @returns {string[]} problems, empty when the step is proven
 */
export function proveWire({ before, after, moduleText, plan, parser, source, target, fileOf }) {
  const problems = [];
  const { first, last } = plan;
  const old = before.split('\n');
  const now = after.split('\n');
  const run = old.slice(first, last + 1);
  const frame = readFrame(moduleText, run.length);
  if (!frame) return ['the new module is not a comment, its requires, the lines of the run and one export'];

  // 1. Nothing but the run left the file, and what stands in its place is one require of the new module.
  //    Above it, a require the run alone used is the same require with fewer names (require-edits.mjs checks each).
  const edits = [...(plan.edits ?? [])].sort((a, b) => b.first - a.first);
  const above = old.slice(0, first);
  edits.forEach((edit, index) => {
    const next = edits[index - 1];
    if (edit.first < 0 || edit.count < 1 || edit.first + edit.count > (next ? next.first : first)) { problems.push('a changed require is not above the run, or two changes overlap'); return; }
    const wrong = requireEditProblem(old.slice(edit.first, edit.first + edit.count), edit.newLines, moduleText);
    if (wrong) problems.push(`line ${edit.first + 1}: ${wrong}`);
    above.splice(edit.first, edit.count, ...edit.newLines);
  });
  const at = above.length;
  const glueCount = now.length - at - (old.length - 1 - last);
  const glue = now.slice(at, at + Math.max(0, glueCount)).join('\n');
  const spec = path.posix.relative(path.posix.dirname(source), target);
  const asked = `require('${spec.startsWith('.') ? spec : `./${spec}`}');`;
  if (glueCount < 1 || now.slice(0, at).join('\n') !== above.join('\n') || now.slice(at + glueCount).join('\n') !== old.slice(last + 1).join('\n')) {
    problems.push('the old file is not the old text with the run replaced by one statement');
  } else if (!/^const \{[\s\w$,]+\} = require\('[^']+'\);$/.test(glue) || !glue.endsWith(`} = ${asked}`)) {
    problems.push(`what stands where the run stood is not one require of ${target}`);
  }

  // 2. The body is the run, the same bytes but for a respelled require that reaches the same file.
  frame.body.forEach((line, index) => {
    const was = run[index];
    const shown = `line ${first + index + 1}`;
    const [wasSpecs, nowSpecs] = [was, line].map((row) => [...row.matchAll(REQUIRE_CALL)].map((match) => match[2]));
    const skeleton = (row) => row.replace(REQUIRE_CALL, (_all, quote) => `require(${quote}${quote})`);
    if (skeleton(was) !== skeleton(line) || wasSpecs.length !== nowSpecs.length) { problems.push(`${shown} is not in the new module unchanged`); return; }
    wasSpecs.forEach((oldSpec, at) => {
      const relative = oldSpec.startsWith('.') || nowSpecs[at].startsWith('.');
      if (!relative && oldSpec === nowSpecs[at]) return;
      const [from, to] = [fileOf(oldSpec, source), fileOf(nowSpecs[at], target)];
      if (!oldSpec.startsWith('.') || !nowSpecs[at].startsWith('.') || !from || from !== to) {
        problems.push(`${shown}: require('${oldSpec}') became require('${nowSpecs[at]}'), which is not the same file`);
      }
    });
  });

  // 3. The head: a comment, then requires the old file has above the run.
  const was = analyze(before, parser, source);
  const inRun = (record) => record.line[0] - 1 >= first && record.line[1] - 1 <= last;
  const runRecords = was.records.filter(inRun);
  if (runRecords.length === 0 || runRecords[0].range[0] - 1 !== first || runRecords.at(-1).line[1] - 1 !== last
    || was.records.some((record) => !inRun(record) && record.line[1] - 1 >= first && record.line[0] - 1 <= last)) {
    return [...problems, 'the lines that left are not whole statements of the old file with the comment above the first'];
  }
  const made = analyze(moduleText, parser, target);
  const headRecords = made.records.filter((record) => record.line[1] <= frame.bodyAt);
  const headCode = new Set(headRecords.flatMap((record) => Array.from({ length: record.line[1] - record.line[0] + 1 }, (_, at) => record.line[0] - 1 + at)));
  frame.head.forEach((line, index) => {
    if (!headCode.has(index) && line !== '' && line !== "'use strict';" && !line.startsWith('//')) problems.push(`line ${index + 1} of the new module is neither its comment nor a require`);
  });
  for (const record of headRecords) {
    if (record.kind !== 'require') { problems.push(`line ${record.line[0]} of the new module runs before the run and is not a require`); continue; }
    for (const bound of record.require.bindings) {
      const origin = was.bindings.get(bound.local);
      const there = origin?.kind === 'require' ? origin.record : null;
      const same = there && there.index < runRecords[0].index && (there.require.property ?? null) === (record.require.property ?? null)
        && there.require.bindings.some((other) => other.local === bound.local && other.text === bound.text);
      const [from, to] = there ? [there.require.spec, record.require.spec] : ['', ''];
      const sameFile = from.startsWith('.') || to.startsWith('.') ? Boolean(fileOf(from, source)) && fileOf(from, source) === fileOf(to, target) : plainModule(from) === plainModule(to);
      if (!same || !sameFile) problems.push(`the new module requires ${bound.local} otherwise than ${source} does above the run`);
    }
  }

  // 4. Read again from nothing.
  const names = runRecords.flatMap((record) => record.names);
  const own = new Set(names);
  const file = analyze(after, parser, source);
  for (const name of names) {
    const bound = file.bindings.get(name);
    const used = file.records.some((record) => record.uses.has(name));
    if (frame.exports.includes(name)) {
      const leads = bound?.record.require ? path.posix.join(path.posix.dirname(source), bound.record.require.spec) : null;
      if (bound?.kind !== 'require' || leads !== target) problems.push(`${name} is not what the file requires from ${target}`);
      else if (bound.reassigned) problems.push(`${name} is assigned again in the file`);
      if (was.bindings.get(name).reassigned) problems.push(`${name} is assigned again after it is declared: the file would keep the value it had when the module loaded`);
    } else if (bound || used) problems.push(`the file still uses ${name}, which the module does not hand back`);
  }
  for (const name of was.bindings.keys()) {
    if (!own.has(name) && !file.bindings.has(name) && file.records.some((record) => record.uses.has(name))) problems.push(`the file still uses ${name}, which it no longer requires`);
  }
  for (const name of frame.exports) if (!own.has(name)) problems.push(`the module exports ${name}, which the run does not declare`);
  const nodes = topStatements(parser.parse(moduleText, target), parser);
  const exported = made.records.at(-1);
  for (const record of made.records) {
    for (const used of record.uses.keys()) {
      if (made.bindings.has(used) || used === 'require' || (record === exported && used === 'module')) continue;
      if (was.bindings.has(used)) problems.push(`the new module uses ${used}, which the old file declares and the module does not require`);
      if (FILE_BOUND.has(used) || used === 'arguments') problems.push(`the new module uses ${used}`);
    }
    const shape = readShape(nodes[record.index], parser.K);
    if (shape.self || shape.oddRequires) problems.push(`line ${record.line[0]} of the new module uses this, or require as something other than a plain call`);
  }

  // 5. The old file, outside the run.
  for (const record of was.records) {
    if (inRun(record)) continue;
    for (const name of names) if ((record.uses.get(name)?.write ?? 0) > 0) problems.push(`line ${record.line[0]} of the old file assigns ${name}`);
  }
  const functions = runRecords.filter((record) => record.kind === 'function');
  if (functions.length) {
    const reaches = loadUseTest({ records: was.records, seeds: functions, names: functions.flatMap((record) => record.names), bindings: was.bindings });
    for (const record of was.records.slice(0, runRecords[0].index)) {
      if (reaches(record)) problems.push(`line ${record.line[0]} of the old file runs at load and can reach a function of the run`);
    }
  }
  return [...new Set(problems)];
}
