// Gives one value the file works out while it loads a module of its own: the
// statements that make the value go there unchanged, and the file requires the
// module on the line where they stood. So the same code runs at the same moment,
// between the same neighbours, and the file gets the same value under the same
// name.
//
// `extract` cannot do this: it only moves what runs nothing at load, and puts its
// require wherever the load order allows. Here the place is the point, so the
// rules are different ones:
//   - the statements use nothing else of the file, and nothing that means "this
//     file" (`__dirname`, `module`, `this`, `require` other than a plain call);
//   - nothing outside them assigns the value again, and no function inside them
//     could do it later: what the module hands over is the value for good;
//   - a relative `require('...')` inside them is respelled for the new folder and
//     must reach the same file. That is the only text that changes.
// The module is recorded as one that runs code at load: later moves never drop
// its require line and never let it load earlier (ledger.mjs quietModules).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze, FILE_BOUND } from './analyze.mjs';
import { MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { appendLedger, liftableNames, protectedNames, readLedger } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { topStatements } from './state-refs.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

const STRICT = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/;
const REQUIRE_CALL = /require\((['"])([^'"]+)\1\)/g;
const glueLine = (name, source, target) => {
  const from = path.posix.relative(path.posix.dirname(source), target);
  return `const { ${name} } = require('${from.startsWith('.') ? from : `./${from}`}');`;
};

// What in a statement means "the file this code sits in", or could run later than the statement itself.
function readShape(node, K, found = { functions: 0, self: 0, requires: [], oddRequires: 0 }) {
  const FUNCTIONS = [K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor,
    K.Constructor, K.ClassDeclaration, K.ClassExpression];
  const visit = (at, parent) => {
    if (FUNCTIONS.includes(at.kind)) found.functions += 1;
    if (at.kind === K.ThisKeyword) found.self += 1;
    if (at.kind === K.Identifier && at.text === 'require') {
      const call = parent && parent.kind === K.CallExpression && parent.expression === at ? parent : null;
      const plain = call && call.arguments.length === 1 && call.arguments[0].kind === K.StringLiteral;
      // `{ require: 1 }` and `x.require` name a property, not the function.
      const isProperty = parent && ((parent.kind === K.PropertyAccessExpression && parent.name === at)
        || (parent.kind === K.PropertyAssignment && parent.name === at));
      if (plain) found.requires.push(call.arguments[0]);
      else if (!isProperty) found.oddRequires += 1;
    }
    at.forEachChild((child) => visit(child, at));
  };
  visit(node, null);
  return found;
}

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative old file
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.name the value
 * @param {(spec: string, from: string, to: string) => { spec: string, kind: string, file: string | null }} job.rewrite
 * @param {Set<string>} [job.protectedNames] names that never leave the file
 * @param {Set<string>} [job.liftable] protected names that may be lifted all the same
 * @param {(file: string) => string | null} [job.readFile] the text of a repo file, to look into what the statements require
 * @param {number} [job.maxLines]
 * @returns {{ name: string, newSource: string, moduleText: string, first: number, last: number, glue: string,
 *   requires: { from: string, to: string, file: string | null }[] }} `first`..`last` are the 0-based lines that left.
 *   Throws a Refusal.
 */
export function planLift({ text, parser, source, target, about, name, rewrite, protectedNames: kept = new Set(), liftable = new Set(),
  readFile = () => null, maxLines = MAX_LINES }) {
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: the tools work on LF text only`]);
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file does (--about)']);
  const { K } = parser;
  const sourceFile = parser.parse(text, source);
  const nodes = topStatements(sourceFile, parser);
  const { records, bindings } = analyze(text, parser, source);
  const binding = bindings.get(name);
  if (!binding) throw new Refusal([`${name} is not a top-level declaration of ${source}`]);
  const declared = binding.record;
  const reasons = [];
  if (!['const', 'let'].includes(declared.kind)) reasons.push(`${name} is a ${declared.kind}: only a const or a let that the file gives its value while it loads can be lifted`);
  if (declared.names.length !== 1) reasons.push(`${name} is declared together with ${declared.names.filter((other) => other !== name).join(', ')}`);
  if (kept.has(name) && !liftable.has(name)) {
    reasons.push(`${name} is in a protected stretch: list it under "liftable" in tools/restructure/protected.json if it may get a module of its own`);
  }
  if (reasons.length) throw new Refusal(reasons);

  // The declaration and the statements right after it that give the value: nothing else writes it.
  const writes = (record) => (record.uses.get(name)?.write ?? 0) > 0;
  let end = declared.index;
  while (end + 1 < records.length && writes(records[end + 1])) end += 1;
  const block = records.slice(declared.index, end + 1);
  for (const record of records) {
    if (!block.includes(record) && writes(record)) reasons.push(`line ${record.line[0]} assigns ${name} again: the module could only hand over the first value`);
  }
  const requires = [];
  for (const record of block) {
    const at = `line ${record.line[0]}`;
    if (record !== declared && record.names.length) reasons.push(`${at} also declares ${record.names.join(', ')}`);
    if (record.sharesLine) reasons.push(`${at} shares its line with another statement`);
    for (const used of record.uses.keys()) {
      if (bindings.has(used) && used !== name) reasons.push(`${at} uses ${used} of ${source}: only what needs nothing else of the file can be lifted`);
      if ((FILE_BOUND.has(used) && used !== 'require') || used === 'arguments') reasons.push(`${at} uses ${used}, which means another thing in another file`);
    }
    const shape = readShape(nodes[record.index], K);
    if (shape.functions) reasons.push(`${at} holds a function: it could change ${name} after the module handed it over`);
    if (shape.self) reasons.push(`${at} uses this, which is the file's own exports`);
    if (shape.oddRequires) reasons.push(`${at} uses require as something other than require('<text>')`);
    for (const literal of shape.requires) {
      if (!literal.text.startsWith('.')) continue;
      let to;
      try { to = rewrite(literal.text, source, target); } catch (error) { reasons.push(`${at}: ${error.message}`); continue; }
      // A module can ask who required it first: that would be the new module now.
      if (/\bmodule\s*\.\s*parent\b/.test(readFile(to.file) ?? '')) reasons.push(`${to.file} reads module.parent, which would be the new module`);
      requires.push({ from: literal.text, to: to.spec, file: to.file, start: literal.getStart(sourceFile), end: literal.end });
    }
  }
  if (reasons.length) throw new Refusal([...new Set(reasons)]);

  const lines = text.split('\n');
  const first = block[0].range[0] - 1;
  const last = block.at(-1).line[1] - 1;
  // Respell from the last one back, so the offsets before it stay true. The quotes stay the ones that were there.
  let moved = text;
  for (const spec of [...requires].sort((a, b) => b.start - a.start)) {
    moved = `${moved.slice(0, spec.start + 1)}${spec.to}${moved.slice(spec.end - 1)}`;
  }
  const grown = requires.reduce((sum, spec) => sum + spec.to.length - spec.from.length, 0);
  const starts = lines.reduce((list, line) => { list.push(list.at(-1) + line.length + 1); return list; }, [0]);
  const blockText = moved.slice(starts[first], starts[last + 1] - 1 + grown);
  const moduleText = [...(STRICT.test(text) ? ["'use strict';"] : []), ...wrapComment(about), '', blockText, '', `module.exports = { ${name} };`, ''].join('\n');
  if (moduleText.split('\n').length - 1 > maxLines) {
    throw new Refusal([`${target} would be ${moduleText.split('\n').length - 1} lines, the limit for a new file is ${maxLines}`]);
  }
  const glue = glueLine(name, source, target);
  const newSource = [...lines.slice(0, first), glue, ...lines.slice(last + 1)].join('\n');
  return { name, newSource, moduleText, first, last, glue, requires: requires.map(({ from, to, file }) => ({ from, to, file })) };
}

/**
 * The proof, written apart from the planner: it works from the three texts and reads them again from nothing.
 * @param {object} lift
 * @param {string} lift.before the old file before
 * @param {string} lift.after the old file after
 * @param {string} lift.moduleText the new module
 * @param {{ name: string, first: number, last: number }} lift.plan
 * @param {any} lift.parser
 * @param {string} lift.source repo-relative old file
 * @param {string} lift.target repo-relative new module
 * @param {(spec: string, from: string) => string | null} lift.fileOf the repo file a relative require in `from` reaches
 * @returns {string[]} problems, empty when the lift is proven
 */
export function proveLift({ before, after, moduleText, plan, parser, source, target, fileOf }) {
  const problems = [];
  const { name, first, last } = plan;
  const old = before.split('\n');
  const glue = glueLine(name, source, target);

  // 1. The file is the old file with those lines gone and one require where they stood: nothing else changed.
  if (after !== [...old.slice(0, first), glue, ...old.slice(last + 1)].join('\n')) {
    problems.push('the old file is not the old text with the lifted lines replaced by one require');
  }

  // 2. The module is those lines between the frame the tool writes, the same bytes but for a respelled require
  //    that reaches the same file.
  const made = moduleText.split('\n');
  const tail = ['', `module.exports = { ${name} };`, ''];
  const lifted = old.slice(first, last + 1);
  const bodyAt = made.length - tail.length - lifted.length;
  const head = made.slice(0, Math.max(0, bodyAt));
  if (bodyAt < 2 || made.slice(-tail.length).join('\n') !== tail.join('\n') || head.at(-1) !== ''
    || head.slice(0, -1).some((line) => !line.startsWith('// ') && line !== "'use strict';")) {
    problems.push('the new module is not a comment, the lifted lines and one export');
  } else {
    made.slice(bodyAt, bodyAt + lifted.length).forEach((line, index) => {
      const was = lifted[index];
      const shown = `line ${first + index + 1}`;
      const [wasSpecs, nowSpecs] = [was, line].map((row) => [...row.matchAll(REQUIRE_CALL)].map((match) => match[2]));
      const skeleton = (row) => row.replace(REQUIRE_CALL, (_all, quote) => `require(${quote}${quote})`);
      if (skeleton(was) !== skeleton(line) || wasSpecs.length !== nowSpecs.length) { problems.push(`${shown} is not in the new module unchanged`); return; }
      // A relative path that stayed as it was spelled would reach another file from the new folder: every one is followed.
      wasSpecs.forEach((spec, at) => {
        const relative = spec.startsWith('.') || nowSpecs[at].startsWith('.');
        if (!relative && spec === nowSpecs[at]) return;
        const [from, to] = [fileOf(spec, source), fileOf(nowSpecs[at], target)];
        if (!spec.startsWith('.') || !nowSpecs[at].startsWith('.') || !from || from !== to) {
          problems.push(`${shown}: require('${spec}') became require('${nowSpecs[at]}'), which is not the same file`);
        }
      });
    });
  }

  // 3. Read again from nothing. In the file the name is what the require gives and nothing assigns it; in the
  //    module nothing is used that the old file declared, nor anything that means "this file".
  const now = analyze(after, parser, source);
  const bound = now.bindings.get(name);
  // The module is not on disk while a plan is proven, so where its require leads is read from the spelling.
  const asked = bound?.record.require ? path.posix.join(path.posix.dirname(source), bound.record.require.spec) : null;
  if (bound?.kind !== 'require' || bound.record.names.length !== 1 || asked !== target) {
    problems.push(`${name} is not what the file requires from ${target}`);
  } else if (bound.reassigned) problems.push(`${name} is assigned again in the file`);
  const declaredBefore = analyze(before, parser, source).bindings;
  const inModule = analyze(moduleText, parser, target);
  const nodes = topStatements(parser.parse(moduleText, target), parser);
  const exported = inModule.records.at(-1);
  for (const record of inModule.records) {
    for (const used of record.uses.keys()) {
      if (used === name || used === 'require' || (record === exported && used === 'module')) continue;
      if (declaredBefore.has(used)) problems.push(`the new module uses ${used}, which the old file declares`);
      if (FILE_BOUND.has(used) || used === 'arguments') problems.push(`the new module uses ${used}`);
    }
    const shape = readShape(nodes[record.index], parser.K);
    if (shape.functions || shape.self || shape.oddRequires) problems.push(`line ${record.line[0]} of the new module holds a function, this or a require that is not a plain call`);
  }
  return problems;
}

/** Plans a lift of `text` with the repo's lists. Throws a Refusal. */
export function planLiftFor({ root, parser, text, source, target, about, name }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  const readFile = (file) => (file && existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);
  return planLift({ text, parser, source, target, about, name, rewrite: createSpecRewriter(root), protectedNames: guard.names,
    liftable: liftableNames(root, source), readFile });
}

/** @param {string} root @returns {(spec: string, from: string) => string | null} the repo file a relative require reaches */
export function repoFileReader(root) {
  const rewrite = createSpecRewriter(root);
  return (spec, from) => {
    try { return rewrite(spec, from, from).file; } catch { return null; }
  };
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file that works the value out
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string} job.name the value
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ target: string, lines: number, sourceLines: number, requires: { from: string, to: string }[] }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function liftValue(job) {
  const { root, parser, source, target, about, name, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const plan = planLiftFor({ root, parser, text: before, source, target, about, name });
  const reasons = targetReasons({ root, source, target, requires: plan.requires.map((spec) => spec.file).filter(Boolean) });
  if (reasons.length) throw new Refusal(reasons);
  const proof = proveLift({ before, after: plan.newSource, moduleText: plan.moduleText, plan, parser, source, target, fileOf: repoFileReader(root) });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { target, lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource), requires: plan.requires };
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
    throw new Error(`the lift failed its checks and was undone:\n${problems.join('\n')}`);
  }
  appendLedger(root, source, { file: target, about, names: [name], lift: true });
  return result;
}
