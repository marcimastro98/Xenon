// What a route's body takes from outside itself, and whether it can live in a
// function of another module and still mean the same. Reading only.
//
// A body can move when everything it names from outside is one of:
//   - `req`, `res` or one of the few handler values handed over (branches-text.mjs CONTEXT);
//   - a name the file gets from `require` (the new module requires the same module);
//   - something every Node program has (`JSON`, `Buffer`, `setTimeout`).
// and when it has nothing whose meaning depends on the function around it: no
// `this`, no `arguments`, no `return` with a value, no `var` and no function
// declared straight in the body (both would be seen by the whole handler today),
// no label, no `eval`.

import { routeChain } from './routes-list.mjs';
import { createUseReader } from './scope-uses.mjs';
import { CONTEXT, frameLine, readCall } from './branches-text.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const HANDED = new Set(['req', 'res', ...CONTEXT]);
// Names that mean the file or the function the code sits in.
const BOUND_TO_PLACE = new Set(['require', 'module', 'exports', '__dirname', '__filename', 'arguments', 'eval']);
const METHOD_AND_PATH = [/^reqPath === '(\/[^'\\]*)' && req\.method === '([A-Z]+)'$/, /^req\.method === '([A-Z]+)' && reqPath === '(\/[^'\\]*)'$/];

/** @param {string} test a branch's test as written @returns {string | null} `METHOD /path` when the test is exactly that */
export function keyOf(test) {
  const first = METHOD_AND_PATH[0].exec(test);
  if (first) return `${first[2]} ${first[1]}`;
  const second = METHOD_AND_PATH[1].exec(test);
  return second ? `${second[1]} ${second[2]}` : null;
}

/**
 * What in a piece of code depends on the function it is written in.
 * @param {any} node @param {{ K: any, NodeFlags: any }} parser
 * @returns {string[]} one phrase per kind of thing found, empty when there is none
 */
export function placeBound(node, { K, NodeFlags }) {
  const OWN_THIS = new Set([K.FunctionDeclaration, K.FunctionExpression, K.MethodDeclaration, K.GetAccessor, K.SetAccessor,
    K.Constructor, K.ClassDeclaration, K.ClassExpression]);
  const found = new Set();
  const walk = (at, nested, ownThis) => {
    if (at.kind === K.ThisKeyword && !ownThis) found.add('`this`');
    if (at.kind === K.MetaProperty && !ownThis) found.add('`new.target` or `import.meta`');
    if (at.kind === K.WithStatement) found.add('a `with` block');
    if (!nested) {
      if (at.kind === K.ReturnStatement && at.expression) found.add('a `return` with a value');
      if (at.kind === K.VariableDeclarationList && (at.flags & NodeFlags.BlockScoped) === 0) found.add('a `var`');
      if (at.kind === K.FunctionDeclaration) found.add('a function declared straight in it');
      if (at.kind === K.LabeledStatement) found.add('a label');
    }
    const own = OWN_THIS.has(at.kind);
    const inner = nested || own || at.kind === K.ArrowFunction;
    at.forEachChild((child) => { walk(child, inner, ownThis || own); });
  };
  node.forEachChild((child) => { walk(child, false, false); });
  return [...found];
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
 * @returns {{ sourceFile: any, chain: ReturnType<typeof routeChain>, locals: Set<string>, branches: { key: string | null, test: string,
 *   line: number, first: number, last: number, lines: number, moved: boolean, block: any, uses: Map<string, any>, handed: string[],
 *   needed: string[], holders: string[], reasons: string[] }[] }}
 *   `first`/`last` are 0-based lines of the body, `handed` the handler values it uses, `needed` the required names it uses,
 *   `holders` the names the file still declares that keep it, `reasons` everything that keeps it (holders included);
 *   `moved` is true when the body is one call of a table already
 */
export function readBranches({ text, parser, analysis, handler = 'handleRequest' }) {
  const chain = routeChain(text, parser, handler);
  const { sourceFile } = chain;
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const locals = handlerNames(chain.handler, parser);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const branches = chain.branches.map(({ test, block }) => {
    const at = bodyLines(block, sourceFile, starts, lines);
    const key = keyOf(test);
    const uses = usesOf(block);
    const reasons = [];
    const holders = [];
    const needed = [];
    const handed = [];
    if (!key) reasons.push('its test is not one address asked with one method');
    if (!at) reasons.push('its body is not on lines of its own between `{` and `}`');
    const moved = Boolean(at && at.first === at.last && readCall(lines[at.first]));
    if (at && lines.slice(at.first, at.last + 1).some(frameLine)) reasons.push('a line of its body reads like the frame of a table of branches');
    for (const [name, use] of uses) {
      if (locals.has(name)) {
        if (!HANDED.has(name)) reasons.push(`it uses ${name}, which the handler works out for itself`);
        else if (use.write > 0) reasons.push(`it assigns ${name}`);
        else handed.push(name);
      } else if (BOUND_TO_PLACE.has(name)) reasons.push(`it uses \`${name}\`, which means another thing in another file or function`);
      else if (analysis.bindings.has(name)) {
        if (analysis.bindings.get(name).kind === 'require') { needed.push(name); if (use.write > 0) reasons.push(`it assigns ${name}`); }
        else holders.push(name);
      } else if (!(name in globalThis)) reasons.push(`it uses ${name}, which nothing declares`);
      else if (use.write > 0) reasons.push(`it assigns ${name}`);
    }
    reasons.push(...placeBound(block, parser).map((what) => `it has ${what}`));
    reasons.push(...holders.map((name) => `it needs ${name}, which the file still declares (line ${analysis.bindings.get(name).record.line[0]})`));
    return { key, test, line: lineAt(starts, block.getStart(sourceFile)) + 1, first: at?.first ?? -1, last: at?.last ?? -1,
      lines: at ? at.last - at.first + 1 : 0, moved, block, uses, handed, needed, holders, reasons };
  });
  return { sourceFile, chain, locals, branches };
}
