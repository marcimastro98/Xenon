// Finds one block `if (<test>) { ... return; }` inside a long function and says whether its lines can stand in
// a function of another module and still mean the same. Reading only: the plan (block.mjs) refuses on what
// this finds, and the proof (block-proof.mjs) reads it again from the old file.
//
// The new function is called where the lines stood, with every name they read handed over in one object. A name
// written at the call means what it meant in the lines, because the call stands in their place. What changes is
// WHEN a name is read: all at once at the call, where the lines read each one when they reached it. So:
//
//   - a name of the function (a parameter, a `const`, a `let`, a caught error) must be declared above the block,
//     the lines must not assign it, and no function written elsewhere in the function may assign it either: one
//     of those could run while the lines wait for something, and the lines would keep the old value. Lines that
//     run straight through cannot: they are before the block, or after it, and the block always ends the function;
//   - a name of the file must mean one value for good and have it by then (branches-own.mjs): a `const`, a
//     `require`, a declared function nothing assigns again. Never a `let` of the file;
//   - what every Node program has (`JSON`, `Buffer`, `setTimeout`) is named as it is.
//
// And the lines must not depend on the function around them in any other way: they end with `return;`, every
// other `return` in them is bare too (the call is followed by the block's own `return;`, so leaving the new
// function early is leaving the old one), no `break` or `continue` that leaves the block, no `this`, `arguments`,
// `require`, `__dirname`, `var`, function declared straight in the block, label or `eval`.

import { ownRule } from './branches-own.mjs';
import { placeBound } from './branches-scope.mjs';
import { PARAM } from './block-text.mjs';
import { createUseReader } from './scope-uses.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const BOUND_TO_PLACE = new Set(['require', 'module', 'exports', '__dirname', '__filename', 'arguments', 'eval']);

function declared(K, name, out) {
  if (!name) return out;
  if (name.kind === K.Identifier) out.push(name.text);
  else name.forEachChild((element) => { if (element.kind === K.BindingElement) declared(K, element.name, out); });
  return out;
}

// The function, by its name at the top of the file: `async function name(` or `const name = async (...) => {`.
function findHandler(sourceFile, K, name) {
  for (const statement of sourceFile.statements) {
    if (statement.kind === K.FunctionDeclaration && statement.name?.text === name) return statement;
    if (statement.kind !== K.VariableStatement) continue;
    const made = statement.declarationList.declarations.find((declaration) => declaration.name.kind === K.Identifier && declaration.name.text === name)?.initializer;
    if (made && (made.kind === K.ArrowFunction || made.kind === K.FunctionExpression)) return made;
  }
  return null;
}

/**
 * @param {object} job
 * @param {string} job.text the file @param {any} job.parser from parser.mjs
 * @param {{ bindings: Map<string, any> }} job.analysis from analyze.mjs, of the same text
 * @param {string} job.handler the function the block is in @param {string} job.test the block's test as written
 * @returns {{ reasons: string[], first: number, last: number, indent: string, handed: string[], locals: string[], own: string[] }}
 *   `first`/`last`: 0-based lines of what moves (everything between the line of the test and the block's last `return;`),
 *   `handed`: the names the call hands over, the function's first (`locals`) and the file's after them (`own`), each sorted;
 *   `reasons`: everything that keeps the block where it is
 */
export function readBlock({ text, parser, analysis, handler, test }) {
  const { K, NodeFlags } = parser;
  const none = (reason) => ({ reasons: [reason], first: -1, last: -1, indent: '', handed: [], locals: [], own: [] });
  const sourceFile = parser.parse(text, 'engine.js');
  const fn = findHandler(sourceFile, K, handler);
  if (!fn?.body || fn.body.kind !== K.Block) return none(`${handler} is not a function declared at the top of the file`);
  if (!text.slice(fn.getStart(sourceFile), fn.body.pos).startsWith('async') || fn.asteriskToken) return none(`${handler} is not a plain async function: the call of the new function waits for it`);
  const NESTED = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor,
    K.Constructor, K.ClassDeclaration, K.ClassExpression]);
  const textOf = (node) => text.slice(node.getStart(sourceFile), node.end);

  // The block, with the nodes around it from the function down, and every function written in the handler outside it.
  const found = [];
  const walk = (node, path) => {
    if (NESTED.has(node.kind)) return;
    if (node.kind === K.IfStatement && textOf(node.expression) === test) found.push({ node, path });
    node.forEachChild((child) => { walk(child, [...path, node]); });
  };
  walk(fn.body, [fn]);
  if (found.length !== 1) return none(`${handler} has ${found.length} blocks \`if (${test})\` of its own, one was expected`);
  const { node, path } = found[0];
  const block = node.thenStatement;
  const reasons = [];
  if (node.elseStatement) reasons.push('the block has an `else`');
  if (path.at(-1).kind !== K.Block) reasons.push('the block is not a statement of its own in a list of statements');
  if (block.kind !== K.Block) return none('what follows the test is not a block between `{` and `}`');
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const open = lineAt(starts, node.getStart(sourceFile));
  const close = lineAt(starts, block.end - 1);
  const indent = /^\s*/.exec(lines[open])[0];
  if (lines[open] !== `${indent}if (${test}) {` || lines[close] !== `${indent}}`) reasons.push('the test and the closing `}` are not each a line of their own');
  const ending = block.statements.at(-1);
  if (!ending || ending.kind !== K.ReturnStatement || ending.expression) return none('the block does not end with `return;`');
  const last = lineAt(starts, ending.getStart(sourceFile)) - 1;
  if (lines[last + 1] !== `${indent}  return;` || last + 2 !== close) reasons.push('the last `return;` is not a line of its own right above the closing `}`');
  if (last < open + 1) reasons.push('the block is only `return;`');
  reasons.push(...placeBound(block, parser).map((what) => `it has ${what}`));

  // A `break` or `continue` that would leave the block.
  const leaves = (at, inLoop, inSwitch) => {
    if (NESTED.has(at.kind)) return;
    if ((at.kind === K.BreakStatement || at.kind === K.ContinueStatement) && (at.label || !(inLoop || (inSwitch && at.kind === K.BreakStatement)))) {
      reasons.push(`it has a \`${at.kind === K.BreakStatement ? 'break' : 'continue'}\` that leaves the block`);
    }
    const loop = [K.ForStatement, K.ForInStatement, K.ForOfStatement, K.WhileStatement, K.DoStatement].includes(at.kind);
    at.forEachChild((child) => { leaves(child, inLoop || loop, inSwitch || at.kind === K.SwitchStatement); });
  };
  leaves(block, false, false);

  // What the function declares around the block: name -> whether it has its value where the block stands.
  const scope = new Map();
  const hoisted = new Set();
  const declare = (names, ready) => { for (const name of names) scope.set(name, ready); };
  const below = (index) => path[index + 1] ?? node;
  path.forEach((around, index) => {
    const inner = below(index);
    if (around === fn) for (const parameter of fn.parameters) declare(declared(K, parameter.name, []), true);
    const statements = around.kind === K.Block ? around.statements : around.kind === K.CaseBlock ? around.clauses.flatMap((clause) => [...clause.statements]) : [];
    for (const statement of statements) {
      if (statement.kind === K.FunctionDeclaration && statement.name) declare([statement.name.text], true);
      if (statement.kind === K.ClassDeclaration && statement.name) declare([statement.name.text], statement.end <= inner.pos);
      if (statement.kind === K.VariableStatement && (statement.declarationList.flags & NodeFlags.BlockScoped) !== 0) {
        for (const declaration of statement.declarationList.declarations) declare(declared(K, declaration.name, []), statement.end <= inner.pos);
      }
    }
    if (around.kind === K.CatchClause && around.variableDeclaration) declare(declared(K, around.variableDeclaration.name, []), true);
    if ([K.ForStatement, K.ForInStatement, K.ForOfStatement].includes(around.kind) && around.initializer?.kind === K.VariableDeclarationList
      && (around.initializer.flags & NodeFlags.BlockScoped) !== 0) {
      for (const declaration of around.initializer.declarations) declare(declared(K, declaration.name, []), true);
    }
  });
  const hoist = (at) => {
    if (NESTED.has(at.kind)) return;
    if (at.kind === K.VariableDeclarationList && (at.flags & NodeFlags.BlockScoped) === 0) for (const declaration of at.declarations) for (const name of declared(K, declaration.name, [])) hoisted.add(name);
    at.forEachChild(hoist);
  };
  hoist(fn.body);

  // Every function written in the handler outside the block: what it assigns could change while the lines wait.
  const usesOf = createUseReader(K, NodeFlags);
  const assignedElsewhere = new Set();
  const others = (at) => {
    if (at === block) return;
    if (NESTED.has(at.kind)) { for (const [name, use] of usesOf(at)) if (use.write > 0) assignedElsewhere.add(name); return; }
    at.forEachChild(others);
  };
  others(fn.body);

  const rule = ownRule(analysis, handler);
  const locals = [];
  const own = [];
  for (const [name, use] of usesOf(block)) {
    if (name === PARAM) reasons.push(`it uses the name ${PARAM}, which the new function calls what it is handed`);
    if (scope.has(name)) {
      if (!scope.get(name)) reasons.push(`it uses ${name}, which ${handler} declares below the block`);
      else if (use.write > 0) reasons.push(`it assigns ${name}, which ${handler} declares outside the block`);
      else if (assignedElsewhere.has(name)) reasons.push(`it reads ${name}, which a function written elsewhere in ${handler} assigns: that could run while the lines wait`);
      else locals.push(name);
    } else if (hoisted.has(name)) reasons.push(`it uses ${name}, which ${handler} declares with \`var\``);
    else if (BOUND_TO_PLACE.has(name)) reasons.push(`it uses \`${name}\`, which means another thing in another file or function`);
    else if (analysis.bindings.has(name)) {
      const why = rule.whyNot(name);
      if (use.write > 0) reasons.push(`it assigns ${name}, a name of the file`);
      else if (why !== null) reasons.push(`it needs ${name}, which cannot be handed over: ${why}`);
      else own.push(name);
    } else if (!(name in globalThis)) reasons.push(`it uses ${name}, which nothing declares`);
    else if (use.write > 0) reasons.push(`it assigns ${name}`);
  }
  locals.sort();
  own.sort();
  if (locals.length + own.length === 0) reasons.push('it reads nothing of the function or the file: there is nothing to hand over');
  return { reasons, first: open + 1, last, indent, handed: [...locals, ...own], locals, own };
}
