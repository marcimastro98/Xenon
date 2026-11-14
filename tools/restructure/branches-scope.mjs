// What a route's body takes from outside itself, and whether it can live in a
// function of another module and still mean the same. Reading only.
//
// A body can move when everything it names from outside is one of:
//   - one of the few values of its function that are handed over (branches-kinds.mjs);
//   - a name the file gets from `require` above the function (the new module
//     requires the same module);
//   - a name of the file that means one value for good and has it by then: the
//     call hands it over (branches-own.mjs);
//   - something every Node program has (`JSON`, `Buffer`, `setTimeout`);
//   - `__dirname`, or `require('<a plain text>')`: the two words that mean the folder
//     of the file, written for the table's folder when the body lands there
//     (branches-place.mjs).
// and when it has nothing whose meaning depends on the function around it: no
// `this`, no `arguments`, no `return` at all where the function goes on after the
// chain (where the chain is the last thing the function does, a `return` with a value
// is marked, `returns`, and the call gives the value back), no `var` and no function
// declared straight in the body (both would be seen by the whole handler today), no
// label, no `eval`.
// The one name a body may assign is the result its kind of chain gives back. A body
// that sets it once, in a statement of its own straight in the body, is marked (`once`):
// its function declares the result on one line and sets it once further down, which
// the lint check reads as code to rewrite (style/useConst), so its table carries the
// one line that silences that finding for the file (branches-text.mjs).

import { ROUTES } from './branches-kinds.mjs';
import { ownRule } from './branches-own.mjs';
import { PLACE_WORDS, placeUses } from './branches-place.mjs';
import { HOME, homeWord, OLD_HOME } from './paths-undo.mjs';
import { createUseReader } from './scope-uses.mjs';
import { frameLine, readCall } from './branches-text.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

// Names that mean the file or the function the code sits in.
const BOUND_TO_PLACE = new Set(['require', 'module', 'exports', '__dirname', '__filename', 'arguments', 'eval']);

export { keyOf } from './branches-kinds.mjs';

/**
 * What in pieces of code depends on the function they are written in.
 * @param {any[]} nodes @param {{ K: any, NodeFlags: any }} parser
 * @param {{ anyReturn?: boolean }} [options] `anyReturn`: a bare `return;` counts too
 * @returns {string[]} one phrase per kind of thing found, empty when there is none
 */
export function placeBoundIn(nodes, { K, NodeFlags }, { anyReturn = false } = {}) {
  const OWN_THIS = new Set([K.FunctionDeclaration, K.FunctionExpression, K.MethodDeclaration, K.GetAccessor, K.SetAccessor,
    K.Constructor, K.ClassDeclaration, K.ClassExpression]);
  const found = new Set();
  const walk = (at, nested, ownThis) => {
    if (at.kind === K.ThisKeyword && !ownThis) found.add('`this`');
    if (at.kind === K.MetaProperty && !ownThis) found.add('`new.target` or `import.meta`');
    if (at.kind === K.WithStatement) found.add('a `with` block');
    if (!nested) {
      if (at.kind === K.ReturnStatement && (at.expression || anyReturn)) found.add(anyReturn ? 'a `return`' : 'a `return` with a value');
      if (at.kind === K.VariableDeclarationList && (at.flags & NodeFlags.BlockScoped) === 0) found.add('a `var`');
      if (at.kind === K.FunctionDeclaration) found.add('a function declared straight in it');
      if (at.kind === K.LabeledStatement) found.add('a label');
    }
    const own = OWN_THIS.has(at.kind);
    const inner = nested || own || at.kind === K.ArrowFunction;
    at.forEachChild((child) => { walk(child, inner, ownThis || own); });
  };
  for (const node of nodes) walk(node, false, false);
  return [...found];
}

/** The same for everything inside one node (a body between its braces). */
export function placeBound(node, parser, options) {
  const inside = [];
  node.forEachChild((child) => { inside.push(child); });
  return placeBoundIn(inside, parser, options);
}

// Every name the handler itself declares: its parameters, what it declares before the chain, and every `var`
// or function declared anywhere in it outside a nested function (those belong to the whole handler).
function handlerNames(handler, { K, NodeFlags }) {
  const names = new Set();
  const declare = (name) => {
    if (!name) return;
    if (name.kind === K.Identifier) names.add(name.text);
    else name.forEachChild((element) => { if (element.kind === K.BindingElement) declare(element.name); });
  };
  for (const parameter of handler.parameters) declare(parameter.name);
  for (const statement of handler.body.statements) {
    if (statement.kind === K.VariableStatement) for (const declaration of statement.declarationList.declarations) declare(declaration.name);
    if ((statement.kind === K.FunctionDeclaration || statement.kind === K.ClassDeclaration) && statement.name) names.add(statement.name.text);
  }
  const NESTED = new Set([K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor,
    K.ClassDeclaration, K.ClassExpression]);
  const hoisted = (node) => {
    if (node.kind === K.FunctionDeclaration) { if (node.name) names.add(node.name.text); return; }
    if (NESTED.has(node.kind)) return;
    if (node.kind === K.VariableDeclarationList && (node.flags & NodeFlags.BlockScoped) === 0) for (const declaration of node.declarations) declare(declaration.name);
    node.forEachChild(hoisted);
  };
  handler.body.forEachChild(hoisted);
  return names;
}

// True when a body sets the result exactly once and does so in a statement straight in the body.
function setsOnceAtTop(block, name, uses, K) {
  const sets = (statement) => statement.kind === K.ExpressionStatement && statement.expression.kind === K.BinaryExpression
    && statement.expression.left.kind === K.Identifier && statement.expression.left.text === name;
  return uses.get(name)?.write === 1 && block.statements.some(sets);
}

// The lines of a body: between the line its test ends on and the line its `}` starts, blank lines at both ends left out.
function bodyLines(block, sourceFile, starts, lines) {
  const open = lineAt(starts, block.getStart(sourceFile));
  const close = lineAt(starts, block.end - 1);
  if (!lines[open].endsWith('{') || block.getStart(sourceFile) !== starts[open] + lines[open].length - 1) return null;
  if (lines[close].trimStart()[0] !== '}' || starts[close] + lines[close].indexOf('}') !== block.end - 1) return null;
  let first = open + 1;
  let last = close - 1;
  while (first <= last && lines[first].trim() === '') first += 1;
  while (last >= first && lines[last].trim() === '') last -= 1;
  return first <= last ? { first, last } : null;
}

/**
 * Every branch of a handler's chain with what it would take to move its body.
 * @param {object} job
 * @param {string} job.text the file
 * @param {any} job.parser from parser.mjs
 * @param {{ bindings: Map<string, any> }} job.analysis from analyze.mjs, of the same text
 * @param {string} [job.handler]
 * @param {typeof ROUTES} [job.kind] which chain (branches-kinds.mjs)
 * @returns {{ sourceFile: any, chain: any, locals: Set<string>, branches: { key: string | null, test: string,
 *   line: number, first: number, last: number, lines: number, moved: boolean, block: any, uses: Map<string, any>, handed: string[],
 *   needed: string[], own: string[], holders: string[], once: boolean, returns: boolean, place: ReturnType<typeof placeUses>, reasons: string[] }[] }}
 *   `first`/`last` are 0-based lines of the body, `handed` the handler values it uses, `needed` the names it uses that its
 *   table would require, `own` the names of the file its call would hand over (sorted), `holders` the names of the file
 *   that cannot be handed and keep it, `once` whether it sets the result of its chain once in a line of its own,
 *   `returns` whether it gives a value back with `return`, `place` where it says `__dirname` or requires a path,
 *   `reasons` everything that keeps it (one per holder, last);
 *   `moved` is true when the body is one call of a table already
 */
export function readBranches({ text, parser, analysis, kind = ROUTES, handler = kind.handler }) {
  const chain = kind.chainOf(text, parser, handler);
  const HANDED = new Set([...kind.leading, ...kind.context, ...kind.extra]);
  const { sourceFile } = chain;
  const VALUED = 'a `return` with a value';
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const locals = handlerNames(chain.handler, parser);
  const rule = ownRule(analysis, handler);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const branches = chain.branches.map(({ test, block }) => {
    const at = bodyLines(block, sourceFile, starts, lines);
    const key = kind.keyOf(test);
    const words = [];
    const uses = usesOf(block, undefined, (node) => { if (PLACE_WORDS.has(node.text)) words.push(node); });
    const reasons = [];
    const holders = [];
    const needed = [];
    const own = [];
    const handed = [];
    if (!key) reasons.push(kind.notKey);
    if (!at) reasons.push('its body is not on lines of its own between `{` and `}`');
    const moved = Boolean(at && at.first === at.last && readCall(lines[at.first], kind));
    if (at && lines.slice(at.first, at.last + 1).some(frameLine)) reasons.push('a line of its body reads like the frame of a table of branches');
    for (const [name, use] of uses) {
      if (name === kind.result && locals.has(name)) continue; // the one name a body may assign: its function gives it back
      if (locals.has(name)) {
        if (!HANDED.has(name)) reasons.push(`it uses ${name}, which the handler works out for itself`);
        else if (use.write > 0) reasons.push(`it assigns ${name}`);
        else handed.push(name);
      } else if (PLACE_WORDS.has(name)) { if (use.write + use.change > 0) reasons.push(`it assigns or changes \`${name}\``); }
      else if (BOUND_TO_PLACE.has(name)) reasons.push(`it uses \`${name}\`, which means another thing in another file or function`);
      else if (analysis.bindings.has(name)) {
        if (rule.required(name)) { needed.push(name); if (use.write > 0) reasons.push(`it assigns ${name}`); }
        else if (rule.whyNot(name) === null) own.push(name);
        else holders.push(name);
      } else if (!(name in globalThis)) reasons.push(`it uses ${name}, which nothing declares`);
      else if (use.write > 0) reasons.push(`it assigns ${name}`);
    }
    const place = placeUses(words.filter((node) => !locals.has(node.text)), parser, (node) => text.slice(node.getStart(sourceFile), node.end), sourceFile);
    reasons.push(...place.reasons);
    if (place.homes.length && at && lines.slice(at.first, at.last + 1).some((line) => homeWord().test(line))) {
      reasons.push(`it says ${OLD_HOME} and has the word ${HOME} too, which ${OLD_HOME} is written as in a table`);
    }
    const bound = placeBound(block, parser, { anyReturn: Boolean(kind.result) });
    const returns = kind.returns && bound.includes(VALUED);
    reasons.push(...bound.filter((what) => !(kind.returns && what === VALUED)).map((what) => `it has ${what}`));
    reasons.push(...holders.map((name) => `it needs ${name}, which cannot be handed over: ${rule.whyNot(name)}`));
    return { key, test, line: lineAt(starts, block.getStart(sourceFile)) + 1, first: at?.first ?? -1, last: at?.last ?? -1,
      lines: at ? at.last - at.first + 1 : 0, moved, block, uses, handed, needed, own: own.sort(), holders,
      once: Boolean(kind.result) && setsOnceAtTop(block, kind.result, uses, parser.K), returns, place, reasons };
  });
  return { sourceFile, chain, locals, branches };
}
