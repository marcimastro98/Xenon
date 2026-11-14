// Proves a planned or recorded `block` step (block.mjs) by undoing it: the lines of the new module, put back
// where the call stands, give the old file byte for byte. Then it reads the old file again for what the step
// may rely on (block-scope.mjs), and the new module for what it is: one function that names nothing it was
// not handed.

import { wrapComment } from './extract-plan.mjs';
import { readBlock } from './block-scope.mjs';
import { noteSentence, PARAM, readCall, readModule, requireLine, specOf, undoBlockText } from './block-text.mjs';
import { createUseReader } from './scope-uses.mjs';

/**
 * @param {object} job
 * @param {string} job.before the old file @param {string} job.after the file after the step @param {string} job.moduleText the new module
 * @param {any} job.parser from parser.mjs @param {{ bindings: Map<string, any> }} job.analysis of `before` (analyze.mjs)
 * @param {string} job.source @param {string} job.target repo-relative
 * @param {string} job.handler @param {string} job.test @param {string} job.name @param {string} job.about
 * @returns {string[]} problems, empty when the step is proven
 */
export function proveBlock({ before, after, moduleText, parser, analysis, source, target, handler, test, name, about }) {
  const { K, NodeFlags } = parser;
  const problems = [];
  const undone = undoBlockText(after, moduleText, name);
  if (undone.problems.length) return undone.problems;
  if (undone.text !== before) problems.push(`the lines of ${target} put back under \`if (${test})\` do not give ${source} as it was`);
  if (!after.split('\n').includes(requireLine(name, specOf(source, target)))) problems.push(`${source} does not require ${name} from ${target}`);

  const read = readBlock({ text: before, parser, analysis, handler, test });
  problems.push(...read.reasons.map((reason) => `read again in the old file, the block cannot move: ${reason}`));
  const made = readModule(moduleText, name);
  const called = readCall(after, name);
  const same = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
  if (!same(made.names, read.handed)) problems.push(`${name} takes ${made.names.join(', ')} and the lines read ${read.handed.join(', ')}`);
  if (!called || !same(called.names, made.names)) problems.push(`the call hands over other names than ${name} takes`);
  const comment = [...wrapComment(about), '', ...wrapComment(noteSentence(handler, source, test))];
  if (!same(made.before, comment)) problems.push(`${target} does not open with what it is and where its lines stood`);

  // The module: one function and its export, and the function names only what it is handed or every program has.
  const sourceFile = parser.parse(moduleText, target);
  const statements = sourceFile.statements.filter((statement) => (statement.flags & NodeFlags.Reparsed) === 0);
  const fn = statements[0];
  if (statements.length !== 2 || fn.kind !== K.FunctionDeclaration || fn.name?.text !== name) {
    problems.push(`${target} is not one function and its export`);
    return problems;
  }
  for (const [used] of createUseReader(K, NodeFlags)(fn.body)) {
    if (used !== PARAM && !(used in globalThis)) problems.push(`${name} names ${used}, which it is not handed`);
  }
  return problems;
}
