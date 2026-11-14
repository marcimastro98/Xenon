// A variable that is called: `run()` becomes `memory.run()`, and a function called that way is
// handed `memory` as `this`. That changes nothing only when no function the variable can ever hold
// looks at `this`. It is proven here from the text alone, and strictly: every value the variable
// is ever given (its first value and every `name = value`) must be written right there as
//   - an arrow function (it has no `this` of its own),
//   - a call of `.bind(...)` (its `this` was fixed when it was bound), or
//   - a function expression in which the words `this`, `arguments` and `eval` do not stand.
// Anything else is not proven: a value that comes from somewhere else (a parameter, a call, another
// name), no first value or null (called then, the error would name the property instead of the
// variable), and every write that is not `name = value` (`+=`, `||=`, `++`, a pattern, a loop).
// Pure: a tree in, reasons out. The planner asks it about the old file, the proof about the new one.

/**
 * @param {{ K: any, NodeFlags: any }} parser
 * @returns {(node: any) => string} why a value is not proven to be a function that ignores `this`; '' when it is
 */
export function createFunctionCheck({ K, NodeFlags }) {
  const isCode = (node) => (node.flags & NodeFlags.Reparsed) === 0;
  const looks = (node) => {
    if (!node || !isCode(node)) return false;
    if (node.kind === K.ThisKeyword || (node.kind === K.Identifier && (node.text === 'arguments' || node.text === 'eval'))) return true;
    let found = false;
    node.forEachChild((child) => { found = found || looks(child); });
    return found;
  };
  return (value) => {
    let at = value;
    while (at && at.kind === K.ParenthesizedExpression) at = at.expression;
    if (!at || at.kind === K.NullKeyword || (at.kind === K.Identifier && at.text === 'undefined')) {
      return 'it can hold nothing: called then, the error would name the property and not the variable';
    }
    if (at.kind === K.ArrowFunction) return '';
    if (at.kind === K.CallExpression && at.expression.kind === K.PropertyAccessExpression && at.expression.name.text === 'bind') return '';
    if (at.kind === K.FunctionExpression) return looks(at) ? 'it is given a function that reads `this`, `arguments` or eval' : '';
    const first = at.getText().split('\n')[0];
    return `it is given \`${first.length > 40 ? `${first.slice(0, 40)}...` : first}\`, which is not a function written there: what it holds is not known`;
  };
}

/**
 * Every write of the things `match` names, with what is written.
 * @param {any} tree @param {{ K: any, NodeFlags: any }} parser
 * @param {(node: any) => string | null} match the name a node stands for, null when it is not one of the things asked about
 * @returns {{ name: string, value: any | null, start: number }[]} `value`: the right side of a plain `name = value`, null for any other write
 */
export function writesOf(tree, { K, NodeFlags }, match) {
  const CARRIES = new Set([K.ArrayLiteralExpression, K.ObjectLiteralExpression, K.PropertyAssignment, K.ShorthandPropertyAssignment, K.SpreadElement,
    K.SpreadAssignment, K.ParenthesizedExpression]);
  const isCode = (node) => (node.flags & NodeFlags.Reparsed) === 0 && !(node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode)
    && !(node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode);
  const writes = [];
  // `written`: false for a read, true for a write that is not a plain assignment, the value for `name = value`.
  const walk = (node, written) => {
    if (!node || !isCode(node)) return;
    const name = match(node);
    if (name !== null) {
      if (written !== false) writes.push({ name, value: written === true ? null : written, start: node.getStart(tree) });
      return;
    }
    const assigns = node.kind === K.BinaryExpression && node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment;
    const plain = assigns && written === false && node.operatorToken.kind === K.EqualsToken;
    const loops = node.kind === K.ForInStatement || node.kind === K.ForOfStatement;
    const steps = (node.kind === K.PrefixUnaryExpression || node.kind === K.PostfixUnaryExpression)
      && (node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken);
    const carries = written !== false && CARRIES.has(node.kind);
    node.forEachChild((child) => {
      if (assigns) walk(child, child === node.left ? (plain ? node.right : true) : false);
      else if (loops) walk(child, child === node.initializer);
      else if (steps) walk(child, true);
      else walk(child, carries && !(node.kind === K.PropertyAssignment && child === node.name));
    });
  };
  walk(tree, false);
  return writes;
}

/**
 * For the planner: the called variables of the old file that are not proven, each with the first reason.
 * @param {object} job
 * @param {any} job.tree the old file @param {{ K: any, NodeFlags: any }} job.parser
 * @param {{ name: string, end: number }[]} job.refs the uses of the called variables, as scope-uses.mjs found them
 * @param {Map<string, any>} job.firstValues the first value of each called variable, undefined when it has none
 * @returns {Map<string, string>}
 */
export function unprovenCalled({ tree, parser, refs, firstValues }) {
  const check = createFunctionCheck(parser);
  const names = new Map(refs.map((ref) => [ref.end, ref.name]));
  const why = new Map();
  const fail = (name, reason) => { if (reason && !why.has(name)) why.set(name, reason); };
  for (const [name, value] of firstValues) fail(name, check(value));
  const { K } = parser;
  for (const write of writesOf(tree, parser, (node) => (node.kind === K.Identifier ? names.get(node.end) ?? null : null))) {
    fail(write.name, write.value === null ? 'it is written in another way than `name = value`' : check(write.value));
  }
  return why;
}

/**
 * For the proof: the same question asked of the new file, where the variable is `object.name`. Nothing is taken
 * from the planner but the names: which ones are called, their first values and their writes are read here.
 * @param {object} job
 * @param {any} job.tree the new file @param {{ K: any, NodeFlags: any }} job.parser
 * @param {string} job.object @param {string[]} job.names the gathered variables @param {string[]} job.kept the ones given their first value further down
 * @returns {string[]} problems, empty when every called property is proven
 */
export function calledProblems({ tree, parser, object, names, kept }) {
  const { K, NodeFlags } = parser;
  const check = createFunctionCheck(parser);
  const own = (node) => (node.kind === K.PropertyAccessExpression && node.expression.kind === K.Identifier && node.expression.text === object
    && names.includes(node.name.text) ? node.name.text : null);
  const called = new Set();
  const firstValues = new Map();
  const walk = (node) => {
    if (!node || (node.flags & NodeFlags.Reparsed) !== 0) return;
    const callee = node.kind === K.CallExpression ? node.expression : node.kind === K.TaggedTemplateExpression ? node.tag : null;
    let at = callee;
    while (at && (at.kind === K.ParenthesizedExpression || at.kind === K.NonNullExpression)) at = at.expression;
    if (at && own(at) !== null) called.add(own(at));
    if (node.kind === K.VariableDeclaration && node.name.kind === K.Identifier && node.name.text === object && node.initializer?.kind === K.ObjectLiteralExpression) {
      for (const property of node.initializer.properties) {
        if (property.kind === K.PropertyAssignment && property.name.kind === K.Identifier) firstValues.set(property.name.text, property.initializer);
      }
    }
    node.forEachChild(walk);
  };
  walk(tree);
  const problems = [];
  const fail = (name, reason) => { if (reason) problems.push(`${object}.${name} is called, and ${reason}`); };
  // A first value given further down is the first write: the placeholder in the object is never read before it.
  for (const name of called) if (!kept.includes(name)) fail(name, check(firstValues.get(name)));
  for (const write of writesOf(tree, parser, own)) {
    if (called.has(write.name)) fail(write.name, write.value === null ? 'it is written in another way than `name = value`' : check(write.value));
  }
  return [...new Set(problems)];
}
