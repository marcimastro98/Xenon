// Which declaration every name of a script means: the scopes of one text, read from its
// tree. `browser-inside.mjs` asks it what the lines taken out of a function use of that
// function and of the wrapper around it. Reads a text, changes nothing.
//
// Scopes as the language makes them in a strict script: a function (its parameters and its
// body are one), a block, the head of a `for`, a `catch`. A `var` belongs to its function,
// everything else to the block it stands in.

/**
 * @typedef {{ name: string, kind: 'function' | 'const' | 'let' | 'var' | 'param' | 'class' | 'catch', pos: number, end: number, scope: any }} Binding
 *   `pos`..`end`: the whole statement (or parameter) that declares it
 * @typedef {{ name: string, pos: number, write: boolean, binding: Binding | null, node: any }} Use `binding` null: a name of the page, or of nobody
 */

const FUNCTIONS = ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunction', 'MethodDeclaration', 'GetAccessor', 'SetAccessor', 'Constructor'];
const LOOPS = ['ForStatement', 'ForInStatement', 'ForOfStatement'];
// On the left of an assignment, a pattern is written as a list or an object.
const PATTERN = ['ArrayLiteralExpression', 'ObjectLiteralExpression', 'PropertyAssignment', 'ShorthandPropertyAssignment', 'SpreadElement', 'SpreadAssignment'];

/**
 * @param {string} text @param {string} file @param {any} parser
 * @returns {{ tree: any, uses: Use[], bindings: Binding[], lineOf: (pos: number) => number, startOf: (node: any) => number, resolve: (name: string, node: any) => Binding | null, isFunction: (node: any) => boolean }}
 *   every use of a name in the order it is written, every declaration, and `resolve`: the declaration a name means where a node stands
 */
export function readScopes(text, file, parser) {
  const { K, NodeFlags } = parser;
  const tree = parser.parse(text, file);
  const kinds = (names) => new Set(names.map((name) => K[name]));
  const functions = kinds(FUNCTIONS);
  const loops = kinds(LOOPS);
  const pattern = kinds(PATTERN);
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const lineOf = (pos) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= pos) low = mid; else high = mid - 1; }
    return low + 1;
  };
  const startOf = (node) => node.getStart(tree);
  const bindings = [];
  const scopeOf = new Map();
  const open = (node, parent, fn) => { const scope = { node, parent, fn, names: new Map() }; scopeOf.set(node, scope); return scope; };
  const declare = (scope, name, kind, by) => {
    const binding = { name, kind, pos: startOf(by), end: by.end, scope };
    // A name declared twice in one scope keeps its first declaration; the tools that cut refuse such a name by its count.
    if (!scope.names.has(name)) scope.names.set(name, binding);
    bindings.push(binding);
  };
  const named = (target, scope, kind, by) => {
    if (!target) return;
    if (target.kind === K.Identifier) declare(scope, target.text, kind, by);
    else target.forEachChild((element) => { if (element.kind === K.BindingElement) named(element.name, scope, kind, by); });
  };
  const functionOf = (scope) => { let at = scope; while (!at.fn && at.parent) at = at.parent; return at; };
  const listKind = (list) => (list.flags & NodeFlags.Const ? 'const' : list.flags & NodeFlags.Let ? 'let' : 'var');

  // First walk: who declares what, and where.
  const declareIn = (node, scope) => {
    let inside = scope;
    if (functions.has(node.kind)) {
      if (node.kind === K.FunctionDeclaration && node.name) declare(scope, node.name.text, 'function', node);
      inside = open(node, scope, true);
      if (node.kind === K.FunctionExpression && node.name) declare(inside, node.name.text, 'function', node);
      for (const parameter of node.parameters ?? []) named(parameter.name, inside, 'param', parameter);
    } else if (node.kind === K.Block && !(node.parent && functions.has(node.parent.kind))) inside = open(node, scope, false);
    else if (loops.has(node.kind) || node.kind === K.CatchClause) inside = open(node, scope, false);
    else if (node.kind === K.ClassDeclaration && node.name) declare(scope, node.name.text, 'class', node);
    if (node.kind === K.VariableDeclarationList) {
      const kind = listKind(node);
      const by = node.parent.kind === K.VariableStatement ? node.parent : node;
      for (const declaration of node.declarations) named(declaration.name, kind === 'var' ? functionOf(inside) : inside, kind, by);
    }
    if (node.kind === K.CatchClause && node.variableDeclaration) named(node.variableDeclaration.name, inside, 'catch', node.variableDeclaration);
    node.forEachChild((child) => { declareIn(child, inside); });
  };
  const top = open(tree, null, true);
  tree.forEachChild((child) => { declareIn(child, top); });

  const isAssign = (node) => node.kind === K.BinaryExpression && node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment;
  const written = (node) => {
    const parent = node.parent;
    if (isAssign(parent) && parent.left === node) return true;
    if ((parent.kind === K.PrefixUnaryExpression || parent.kind === K.PostfixUnaryExpression) && (parent.operator === K.PlusPlusToken || parent.operator === K.MinusMinusToken)) return true;
    if ((parent.kind === K.ForInStatement || parent.kind === K.ForOfStatement) && parent.initializer === node) return true;
    let at = node;
    while (at.parent && pattern.has(at.parent.kind)) at = at.parent;
    return at !== node && isAssign(at.parent) && at.parent.operatorToken.kind === K.EqualsToken && at.parent.left === at;
  };
  const isUse = (node) => {
    const parent = node.parent;
    if (parent.name === node && parent.kind !== K.ShorthandPropertyAssignment) return false;
    if (parent.kind === K.BindingElement && parent.propertyName === node) return false;
    return !(parent.label === node);
  };
  const find = (name, scope) => { for (let at = scope; at; at = at.parent) if (at.names.has(name)) return at.names.get(name); return null; };

  // Second walk: every name that is read or written, with the declaration it means.
  const uses = [];
  const useIn = (node, scope) => {
    const inside = scopeOf.get(node) ?? scope;
    if (node.kind === K.Identifier && isUse(node)) uses.push({ name: node.text, pos: startOf(node), write: written(node), binding: find(node.text, scope), node });
    node.forEachChild((child) => { useIn(child, inside); });
  };
  tree.forEachChild((child) => { useIn(child, top); });
  const resolve = (name, node) => { let at = node; while (at && !scopeOf.has(at)) at = at.parent; return find(name, at ? scopeOf.get(at) : top); };
  return { tree, uses, bindings, lineOf, startOf, resolve, isFunction: (node) => functions.has(node.kind) };
}

/**
 * @param {ReturnType<typeof readScopes>} read @param {any} parser @param {string} name
 * @returns {any[]} the function declarations called so that stand right inside the script's wrapper, or at its top
 */
export function functionsNamed(read, parser, name) {
  const { K } = parser;
  const found = [];
  const visit = (node, depth) => {
    if (node.kind === K.FunctionDeclaration && node.name?.text === name) { found.push(node); return; }
    // Through the wrapper only: `(function () { … })()` or `(() => { … })()`, one deep.
    const wrapper = read.isFunction(node) && depth === 0;
    if (read.isFunction(node) && !wrapper) return;
    node.forEachChild((child) => { visit(child, wrapper ? 1 : depth); });
  };
  visit(read.tree, 0);
  return found;
}
