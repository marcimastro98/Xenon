// Gives the places a file finds next to itself (`path.join(__dirname, 'data')`) a
// module of their own, so code in other modules can ask for them by require.
//
// `extract` refuses these constants because `__dirname` means another folder in
// another file. Here that one word is respelled: the module works out the old
// folder once (`const SERVER_DIR = path.join(__dirname, '..')`) and every moved
// line says SERVER_DIR where it said __dirname. Nothing else in a line changes.
// The rules:
//   - the value is built from `__dirname`, `path.join(...)`, plain text and
//     `process.platform` compared with plain text, and from nothing else;
//   - the file requires the module on the line where the constant stood, so the
//     name exists from the same line on as before (neighbours share one require);
//   - old and new value are worked out for Windows, macOS and Linux, with both
//     kinds of path, and have to be the same text every time.
// The module runs nothing but those joins: it is recorded as a quiet one.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import { analyze } from './analyze.mjs';
import { MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { appendLedger, protectedNames, readLedger } from './ledger.mjs';
import { wrapNames } from './module-requires.mjs';
import { HOME, homeWord, OLD_HOME, oldSpelling } from './paths-undo.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { topStatements } from './state-refs.mjs';
import { targetReasons } from './target-rules.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

const STRICT = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/;
// A made-up install on each kind of system: the values are compared as text, nothing is read from disk.
export const INSTALLS = [[path.win32, 'C:\\app\\server'], [path.posix, '/opt/app/server']];
const SYSTEMS = ['win32', 'darwin', 'linux'];

const up = (source, target) => path.posix.relative(path.posix.dirname(target), path.posix.dirname(source)).split('/');
/** The line a module one or more folders below `source` works out the folder of `source` with. */
export const homeLine = (source, target) => `const ${HOME} = path.join(${OLD_HOME}, ${up(source, target).map((part) => `'${part}'`).join(', ')});`;
const specOf = (source, target) => {
  const from = path.posix.relative(path.posix.dirname(source), target);
  return from.startsWith('.') ? from : `./${from}`;
};
const glueLines = (names, source, target) => wrapNames(names, 'const {', `} = require('${specOf(source, target)}');`);

// The first thing in a value that is not a join of the home folder, plain text and the system's name. '' when all is.
function oddPart(node, K, home) {
  const text = () => node.getText().split('\n')[0].slice(0, 60);
  const first = (nodes) => { for (const at of nodes) { const odd = oddPart(at, K, home); if (odd) return odd; } return ''; };
  switch (node.kind) {
    case K.StringLiteral: return '';
    case K.Identifier: return node.text === home ? '' : node.text;
    case K.ParenthesizedExpression: return oddPart(node.expression, K, home);
    case K.ConditionalExpression: return first([node.condition, node.whenTrue, node.whenFalse]);
    case K.BinaryExpression:
      return [K.EqualsEqualsEqualsToken, K.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind) ? first([node.left, node.right]) : text();
    case K.PropertyAccessExpression:
      return node.expression.kind === K.Identifier && node.expression.text === 'process' && node.name.text === 'platform' ? '' : text();
    case K.CallExpression: {
      const callee = node.expression;
      const joins = callee.kind === K.PropertyAccessExpression && callee.expression.kind === K.Identifier
        && callee.expression.text === 'path' && callee.name.text === 'join';
      return joins ? first(node.arguments) : text();
    }
    default: return text();
  }
}

// Where the home folder is named in a value, as the end offsets of the identifiers.
function homeTokens(node, K, home, found = []) {
  if (node.kind === K.Identifier && node.text === home) found.push(node.end);
  node.forEachChild((child) => { homeTokens(child, K, home, found); });
  return found;
}

// The one declaration of a statement, when it is `const name = value;` and nothing more.
function declarationOf(statement, K, NodeFlags) {
  if (!statement || statement.kind !== K.VariableStatement || (statement.declarationList.flags & NodeFlags.Const) === 0) return null;
  const list = statement.declarationList.declarations;
  return list.length === 1 && list[0].name.kind === K.Identifier && list[0].initializer ? list[0] : null;
}

// The old file without the runs of lines, one require where each run stood.
function withoutRuns(lines, runs, source, target) {
  const starts = new Map(runs.map((run) => [run.first, run]));
  const gone = new Set(runs.flatMap((run) => Array.from({ length: run.last - run.first + 1 }, (_, i) => run.first + i)));
  const left = [];
  lines.forEach((line, index) => {
    if (starts.has(index)) left.push(...glueLines(starts.get(index).names, source, target));
    if (!gone.has(index)) left.push(line);
  });
  return left.join('\n');
}

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative old file
 * @param {string} job.target repo-relative new module
 * @param {string} job.about one sentence: the new file's first comment
 * @param {string[]} job.names the constants
 * @param {Set<string>} [job.protectedNames] names that never leave the file
 * @param {number} [job.maxLines]
 * @returns {{ names: string[], newSource: string, moduleText: string, runs: { first: number, last: number, names: string[] }[] }}
 *   `runs` are the 0-based lines of the old file that left, neighbours together. Throws a Refusal.
 */
export function planPaths({ text, parser, source, target, about, names, protectedNames: kept = new Set(), maxLines = MAX_LINES }) {
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: the tools work on LF text only`]);
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file holds (--about)']);
  const { K, NodeFlags } = parser;
  const nodes = topStatements(parser.parse(text, source), parser);
  const { bindings } = analyze(text, parser, source);
  const lines = text.split('\n');
  const reasons = [];
  const pathModule = bindings.get('path')?.record.require;
  if (!pathModule || pathModule.property || !/^(?:node:)?path$/.test(pathModule.spec)) reasons.push(`${source} does not hold Node's path module under the name path`);
  if (bindings.has('process') || bindings.has(HOME)) reasons.push(`${source} declares process or ${HOME} itself`);
  const moved = [];
  const tokens = [];
  for (const name of new Set(names)) {
    const record = bindings.get(name)?.record;
    if (!record) { reasons.push(`${name} is not a top-level declaration of ${source}`); continue; }
    const fail = (why) => reasons.push(`${name} (${source}:${record.line[0]}) ${why}`);
    const declaration = declarationOf(nodes[record.index], K, NodeFlags);
    if (!declaration) { fail('is not written as one `const name = value;`'); continue; }
    if (kept.has(name)) fail('is part of the security prelude and stays where it is');
    if (record.sharesLine) fail('shares a line with another statement');
    if (bindings.get(name).reassigned || bindings.get(name).changed) fail('is assigned or changed later');
    const odd = oddPart(declaration.initializer, K, OLD_HOME);
    const found = homeTokens(declaration.initializer, K, OLD_HOME);
    if (odd) fail(`is built from ${odd}: only ${OLD_HOME}, path.join, plain text and process.platform can be respelled`);
    else if (found.length === 0) fail(`does not use ${OLD_HOME}: \`extract\` moves it as it is`);
    if (homeWord().test(lines.slice(record.range[0] - 1, record.line[1]).join('\n'))) fail(`already has the word ${HOME} in its lines`);
    moved.push(record);
    tokens.push(...found);
  }
  if (reasons.length) throw new Refusal(reasons);
  moved.sort((a, b) => a.index - b.index);

  // Neighbours leave together and come back through one require; the comment above a constant goes with it.
  const runs = [];
  for (const record of moved) {
    const [first, last] = [record.range[0] - 1, record.line[1] - 1];
    const before = runs.at(-1);
    if (before && before.last + 1 === first) { before.last = last; before.names.push(record.names[0]); }
    else runs.push({ first, last, names: [record.names[0]] });
  }
  // Only the identifier is respelled, from the last one back: a comment that says __dirname keeps the word.
  let respelled = text;
  for (const end of tokens.sort((a, b) => b - a)) respelled = `${respelled.slice(0, end - OLD_HOME.length)}${HOME}${respelled.slice(end)}`;
  const respelledLines = respelled.split('\n');
  const blocks = runs.map((run) => respelledLines.slice(run.first, run.last + 1).join('\n'));
  const all = moved.map((record) => record.names[0]);
  const moduleText = [...(STRICT.test(text) ? ["'use strict';"] : []), ...wrapComment(about), '', "const path = require('node:path');", '',
    homeLine(source, target), '', blocks.join('\n\n'), '', ...wrapNames(all, 'module.exports = {', '};'), ''].join('\n');
  if (moduleText.split('\n').length - 1 > maxLines) throw new Refusal([`${target} would be ${moduleText.split('\n').length - 1} lines, the limit for a new file is ${maxLines}`]);
  return { names: all, newSource: withoutRuns(lines, runs, source, target), moduleText, runs };
}

// Every value a constant can have: on each kind of system, with each kind of path.
function valuesOf(expression, homeName, homeOf) {
  return INSTALLS.flatMap(([impl, folder]) => SYSTEMS.map((platform) => String(vm.runInNewContext(`(${expression})`,
    { path: impl, [homeName]: homeOf(impl, folder), process: { platform } }, { timeout: 1000 }))));
}

/**
 * The proof, written apart from the planner: it works from the three texts and reads them again from nothing.
 * @param {{ before: string, after: string, moduleText: string, plan: { names: string[], runs: { first: number, last: number, names: string[] }[] },
 *   parser: any, source: string, target: string }} move
 * @returns {string[]} problems, empty when the move is proven
 */
export function provePaths({ before, after, moduleText, plan, parser, source, target }) {
  const problems = [];
  const { K, NodeFlags } = parser;
  const old = before.split('\n');

  // 1. The file is the old file with the constants' lines gone and one require where each run of them stood.
  if (after !== withoutRuns(old, plan.runs, source, target)) problems.push('the old file is not the old text with the constants replaced by a require where they stood');

  // 2. The module is the frame the tool writes around those lines, the same bytes but for SERVER_DIR in place of __dirname.
  const made = moduleText.split('\n');
  const home = made.indexOf(homeLine(source, target));
  const tail = [...wrapNames(plan.names, 'module.exports = {', '};'), ''];
  const frame = made.slice(0, Math.max(home, 0)).filter((line) => line !== '' && !line.startsWith('// ') && line !== "'use strict';");
  const lifted = plan.runs.map((run) => old.slice(run.first, run.last + 1).join('\n')).join('\n\n');
  const bodyText = made.slice(home + 2, made.length - tail.length - 1).join('\n');
  if (home === -1 || frame.join('\n') !== "const path = require('node:path');" || made[home + 1] !== '' || made.at(-tail.length - 1) !== ''
    || made.slice(-tail.length).join('\n') !== tail.join('\n')) problems.push('the new module is not a comment, the path module, the home folder, the moved lines and one export');
  else if (homeWord().test(lifted) || oldSpelling(bodyText) !== lifted) problems.push('the moved lines are not in the new module unchanged but for the home folder');

  // 3. Read again from nothing: what each constant is built from, on both sides, and that the file gets it by require.
  const oldSide = analyze(before, parser, source);
  const oldNodes = topStatements(parser.parse(before, source), parser);
  const newSide = analyze(moduleText, parser, target);
  const newNodes = topStatements(parser.parse(moduleText, target), parser);
  const now = analyze(after, parser, source);
  const homeNode = declarationOf(newNodes[newSide.bindings.get(HOME)?.record.index], K, NodeFlags);
  const steps = up(source, target);
  let respelled = 0;
  for (const name of plan.names) {
    const was = declarationOf(oldNodes[oldSide.bindings.get(name)?.record.index], K, NodeFlags);
    const is = declarationOf(newNodes[newSide.bindings.get(name)?.record.index], K, NodeFlags);
    if (!was || !is || !homeNode) { problems.push(`${name} is not one plain const on both sides`); continue; }
    const odd = oddPart(was.initializer, K, OLD_HOME) || oddPart(is.initializer, K, HOME);
    if (odd) { problems.push(`${name} is built from ${odd}`); continue; }
    respelled += homeTokens(was.initializer, K, OLD_HOME).length;
    const bound = now.bindings.get(name);
    const asked = bound?.record.require ? path.posix.join(path.posix.dirname(source), bound.record.require.spec) : null;
    if (bound?.kind !== 'require' || asked !== target || bound.reassigned) problems.push(`${name} is not what the file requires from ${target}`);
    // 4. The same text on every system: the module's own home line is worked out too, from the folder it will sit in.
    const wasValues = valuesOf(was.initializer.getText(), OLD_HOME, (_impl, folder) => folder);
    const isValues = valuesOf(is.initializer.getText(), HOME, (impl, folder) => vm.runInNewContext(`(${homeNode.initializer.getText()})`,
      { path: impl, [OLD_HOME]: impl.join(folder, ...steps.map(() => 'part')) }, { timeout: 1000 }));
    if (wasValues.join('\n') !== isValues.join('\n')) problems.push(`${name} is another place in the new module: ${wasValues[0]} became ${isValues[0]}`);
  }
  if ((bodyText.match(homeWord('g')) ?? []).length !== respelled) problems.push(`${HOME} stands in the moved lines more often than ${OLD_HOME} stood in the values`);
  // The path module, the home folder, the constants, the export; in a strict file the 'use strict' line before them.
  if (newSide.records.length !== plan.names.length + 3 + (made[0] === "'use strict';" ? 1 : 0)) problems.push('the new module has statements besides the constants');
  return problems;
}

/** Plans a move of `text` with the repo's protected list. Throws a Refusal. */
export function planPathsFor({ root, parser, text, source, target, about, names }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planPaths({ text, parser, source, target, about, names, protectedNames: guard.names });
}

/**
 * @param {{ root: string, parser: any, source: string, target: string, about: string, names: string[], dryRun?: boolean }} job
 * @returns {{ target: string, lines: number, sourceLines: number, names: string[] }}
 *   throws a Refusal before anything is written, an Error after a failed check (files put back)
 */
export function movePaths(job) {
  const { root, parser, source, target, about, names, dryRun = false } = job;
  const before = readFileSync(path.join(root, source), 'utf8');
  const plan = planPathsFor({ root, parser, text: before, source, target, about, names });
  const reasons = targetReasons({ root, source, target, requires: [] });
  if (reasons.length) throw new Refusal(reasons);
  const proof = provePaths({ before, after: plan.newSource, moduleText: plan.moduleText, plan, parser, source, target });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { target, lines: count(plan.moduleText), sourceLines: count(before) - count(plan.newSource), names: plan.names };
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
    throw new Error(`the move failed its checks and was undone:\n${problems.join('\n')}`);
  }
  appendLedger(root, source, { file: target, about, names: plan.names, paths: true });
  return result;
}
