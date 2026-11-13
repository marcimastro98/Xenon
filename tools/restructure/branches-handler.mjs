// What must be true of the function a chain sits in for a body to mean the same
// in a function of its own. Reading only; the plan refuses on these and the proof
// reads them again from the old file.
//
//   - every value a call hands over is declared by the function before the chain,
//     and one a body uses is never assigned in the function: the body gets it once,
//     when it is called, and must see what it would have seen in place;
//   - where a body assigns the result (branches-kinds.mjs `result`), the result
//     has no value yet when the chain starts and is set again first thing when a
//     body throws: the call then leaves it exactly as the body in place did;
//   - a function declared with `function` can be called from above its own line
//     while the file loads, and the table is required right above it: nothing
//     that runs at load above that line may reach the function.
//
// Which names of the file a call may hand over as well is in branches-own.mjs.

import { firstReach } from './branches-own.mjs';
import { createUseReader } from './scope-uses.mjs';

// The names a function has when it reaches one of its statements: its parameters and what it declared above.
function namesBefore(handler, stop, K) {
  const names = new Set();
  const declare = (name) => {
    if (name.kind === K.Identifier) names.add(name.text);
    else name.forEachChild((element) => { if (element.kind === K.BindingElement) declare(element.name); });
  };
  for (const parameter of handler.parameters) declare(parameter.name);
  for (const statement of handler.body.statements) {
    if (statement === stop) break;
    if (statement.kind === K.VariableStatement) for (const declaration of statement.declarationList.declarations) declare(declaration.name);
  }
  return names;
}

/**
 * @param {{ handler: any, chain: any, tryStatement?: any }} chain from the kind's `chainOf`
 * @param {{ K: any, NodeFlags: any }} parser @param {{ result: string | null, leading: readonly string[], context: readonly string[] }} kind
 * @param {string[]} handed the handler values the bodies to move use
 * @param {(node: any) => string} textOf the text of a node
 * @returns {string[]} what is wrong, empty when nothing is
 */
export function handlerProblems(chain, parser, kind, handed, textOf) {
  const { K } = parser;
  const usesOf = createUseReader(K, parser.NodeFlags);
  const statements = chain.handler.body.statements;
  const writes = (node, name) => (usesOf(node).get(name)?.write ?? 0) > 0;
  const has = namesBefore(chain.handler, chain.tryStatement ?? chain.chain, K);
  const problems = [...kind.leading, ...kind.context].filter((name) => !has.has(name)).map((name) => `the function has no ${name} above the chain, and every call hands it over`);
  problems.push(...handed.filter((name) => statements.some((statement) => writes(statement, name)))
    .map((name) => `the function assigns ${name}, which a body would be handed once, at its call`));
  if (!kind.result) return problems;

  const name = kind.result;
  const listOf = (node) => (node.kind === K.Block ? node.statements : [node]);
  // A list of statements leaves the result alone, or sets it and returns at once.
  const safe = (list) => list.every((statement, index) => {
    if (!writes(statement, name)) return true;
    if (statement.kind === K.IfStatement) {
      return !writes(statement.expression, name) && safe(listOf(statement.thenStatement)) && (!statement.elseStatement || safe(listOf(statement.elseStatement)));
    }
    return statement.kind === K.ExpressionStatement && index < list.length - 1 && list.at(-1).kind === K.ReturnStatement;
  });
  const before = statements.slice(0, statements.indexOf(chain.tryStatement));
  if (!before.some((statement) => textOf(statement) === `let ${name};`)) problems.push(`the function does not declare ${name} with \`let ${name};\` before the chain`);
  if (!safe(before)) problems.push(`${name} may have a value when the chain starts: something above the chain sets it and goes on`);
  const { catchClause, finallyBlock } = chain.tryStatement;
  if (finallyBlock) problems.push('the chain sits in a try with a `finally`, which would read the result at another moment');
  const first = catchClause?.block.statements[0];
  const resets = first?.kind === K.ExpressionStatement && first.expression.kind === K.BinaryExpression && first.expression.operatorToken.kind === K.EqualsToken
    && first.expression.left.kind === K.Identifier && first.expression.left.text === name && !usesOf(first.expression.right).has(name);
  if (catchClause && !resets) problems.push(`when a body throws, the function does not set ${name} again first thing`);
  return problems;
}

/**
 * @param {{ records: any[], bindings: Map<string, any> }} analysis from analyze.mjs
 * @param {string} handler
 * @returns {number | null} the line of the first statement above a `function` handler that runs while the file loads
 *   and may reach it (through anything it names, callbacks included); null when there is none or the handler is not
 *   declared with `function`
 */
export function calledBeforeItsTable(analysis, handler) {
  const target = analysis.bindings.get(handler)?.record;
  if (target?.kind !== 'function') return null;
  const start = firstReach(analysis, handler);
  return start && start.index < target.index ? start.line[0] : null;
}
