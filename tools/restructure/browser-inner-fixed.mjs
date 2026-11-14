// Says whether a `const` of a browser script's wrapper is a value that comes out the
// same whenever it is worked out, so it may go to a script that loads earlier together
// with the functions that use it (browser-inner-plan.mjs).
//
// A script made of moved code runs before the old one, and other code of the page can
// run between the two. So only a value that asks nothing of the page may travel:
//   - a string, number, boolean, null, regex or template written out;
//   - a function or an arrow (its body runs later, and obeys the rule of moved functions);
//   - a list or an object of such values, `new Set([...])`, `new Map([...])`,
//     `Object.freeze(...)` of one written in place;
//   - the name of a function or of another constant that moves with it;
//   - arithmetic and joined strings of numbers and strings.
// Anything that calls a function, reads the page (`window`, `document`, storage, any
// name the wrapper does not declare) or a name of the wrapper that stays is refused.
//
// One object is handed over (`window.<Name> = { ... }`), so a list, an object, a Set or
// a function is the same one on both sides: changing what it holds is seen by both.
// What is read here is the shape; who moves is judged in browser-inner-plan.mjs.

/** Names of the language that are a value by themselves. */
const PLAIN = new Set(['undefined', 'NaN', 'Infinity']);
const SHOWN = 50;

const shown = (node) => {
  const text = node.getText().split('\n')[0];
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text;
};

/**
 * Reads the shape of one `const` statement.
 * @param {Record<string, number>} K SyntaxKind @param {any} statement a VariableStatement
 * @returns {{ reasons: string[], kinds: Map<string, 'primitive' | 'reference' | { same: string }>,
 *   reads: { name: string, how: 'value' | 'number' | 'through', by: string }[] }}
 *   `reasons`: why the value is not one that is the same whenever it is worked out, empty when it is.
 *   `kinds`: per declared name, a number/string/boolean/null (`primitive`), a thing with an identity (`reference`), or whatever another name is.
 *   `reads`: the names the statement reads while it runs (not the ones inside a function body), by the name it declares:
 *   `value` takes the name as it is, `number` computes with it, `through` copies what it holds at that moment (a spread, `new Set(name)`).
 */
export function readFixed(K, statement) {
  const LITERALS = new Set([K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.NoSubstitutionTemplateLiteral, K.TrueKeyword, K.FalseKeyword, K.NullKeyword]);
  const ARITHMETIC = new Set([K.PlusToken, K.MinusToken, K.AsteriskToken, K.SlashToken, K.PercentToken, K.AsteriskAsteriskToken,
    K.LessThanLessThanToken, K.GreaterThanGreaterThanToken, K.GreaterThanGreaterThanGreaterThanToken, K.AmpersandToken, K.BarToken, K.CaretToken]);
  const SIGNS = new Set([K.MinusToken, K.PlusToken, K.ExclamationToken, K.TildeToken]);
  const OWN_THIS = new Set([K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor]);
  const WRITTEN_IN_PLACE = new Set([K.ArrayLiteralExpression, K.ObjectLiteralExpression, K.NewExpression, K.CallExpression]);
  const reasons = [];
  const reads = [];
  const kinds = new Map();
  let by = '';

  // An arrow has no `this`, `arguments` or `new.target` of its own: it would take the new wrapper's.
  const takesFromWrapper = (node) => {
    if (OWN_THIS.has(node.kind)) return;
    if (node.kind === K.ThisKeyword) reasons.push('an arrow in it says `this`, which is the wrapper\'s');
    if (node.kind === K.MetaProperty) reasons.push('an arrow in it says `new.target`, which is the wrapper\'s');
    node.forEachChild(takesFromWrapper);
  };
  const read = (node, how) => { reads.push({ name: node.text, how, by }); return { same: node.text }; };
  const keyProblem = (name) => {
    if (name.kind !== K.ComputedPropertyName || LITERALS.has(name.expression.kind)) return;
    reasons.push(`the key \`${shown(name)}\` is worked out, not written out`);
  };
  // What is copied at that moment: `...name`, `new Set(name)`.
  const through = (node) => {
    if (node.kind === K.Identifier && !PLAIN.has(node.text)) { read(node, 'through'); return; }
    if (node.kind === K.ArrayLiteralExpression || node.kind === K.ObjectLiteralExpression) { kindOfValue(node); return; }
    reasons.push(`\`${shown(node)}\` is copied from something that is not a name or a list written out`);
  };
  const numberOf = (node) => {
    const before = reads.length;
    const kind = kindOfValue(node);
    if (kind === 'reference') reasons.push(`\`${shown(node)}\` is computed with, and is not a number or a string`);
    else if (typeof kind === 'object' && reads.length === before + 1) reads[before].how = 'number';
  };
  const member = (property) => {
    switch (property.kind) {
      case K.PropertyAssignment: keyProblem(property.name); kindOfValue(property.initializer); return;
      case K.ShorthandPropertyAssignment:
        if (property.objectAssignmentInitializer) reasons.push(`\`${shown(property)}\` is not a value`);
        else if (!PLAIN.has(property.name.text)) read(property.name, 'value');
        return;
      case K.MethodDeclaration: keyProblem(property.name); return;
      case K.SpreadAssignment: through(property.expression); return;
      default: reasons.push(`\`${shown(property)}\` is a getter or a setter: it runs when the value is read`);
    }
  };

  function kindOfValue(node) {
    if (LITERALS.has(node.kind)) return 'primitive';
    switch (node.kind) {
      case K.RegularExpressionLiteral: return 'reference';
      case K.Identifier: return PLAIN.has(node.text) ? 'primitive' : read(node, 'value');
      case K.ParenthesizedExpression: return kindOfValue(node.expression);
      case K.ArrowFunction: takesFromWrapper(node); return 'reference';
      case K.FunctionExpression: return 'reference';
      case K.PrefixUnaryExpression:
        if (!SIGNS.has(node.operator)) break;
        numberOf(node.operand);
        return 'primitive';
      case K.BinaryExpression:
        if (!ARITHMETIC.has(node.operatorToken.kind)) break;
        numberOf(node.left);
        numberOf(node.right);
        return 'primitive';
      case K.TemplateExpression:
        for (const span of node.templateSpans) numberOf(span.expression);
        return 'primitive';
      case K.ArrayLiteralExpression:
        for (const element of node.elements) {
          if (element.kind === K.SpreadElement) through(element.expression);
          else if (element.kind !== K.OmittedExpression) kindOfValue(element);
        }
        return 'reference';
      case K.ObjectLiteralExpression:
        for (const property of node.properties) member(property);
        return 'reference';
      case K.NewExpression: {
        const args = node.arguments ?? [];
        if (node.expression.kind !== K.Identifier || !['Set', 'Map'].includes(node.expression.text) || args.length > 1) break;
        if (args.length) through(args[0]);
        return 'reference';
      }
      case K.CallExpression: {
        const callee = node.expression;
        const freeze = callee.kind === K.PropertyAccessExpression && callee.expression.kind === K.Identifier && callee.expression.text === 'Object' && callee.name.text === 'freeze';
        if (!freeze || node.arguments.length !== 1) { reasons.push(`it calls \`${shown(callee)}()\`: the answer could be another when asked earlier`); return 'reference'; }
        if (!WRITTEN_IN_PLACE.has(node.arguments[0].kind)) { reasons.push(`\`${shown(node)}\` freezes something not written in place: frozen earlier, it could not be changed where it was before`); return 'reference'; }
        kindOfValue(node.arguments[0]);
        return 'reference';
      }
      default:
    }
    reasons.push(`\`${shown(node)}\` is not a value written out`);
    return 'reference';
  }

  for (const declaration of statement.declarationList.declarations) {
    if (declaration.name.kind !== K.Identifier) { reasons.push(`\`${shown(declaration.name)}\` takes its names out of a value`); continue; }
    by = declaration.name.text;
    if (!declaration.initializer) { reasons.push(`${by} has no value`); continue; }
    kinds.set(by, kindOfValue(declaration.initializer));
  }
  return { reasons, kinds, reads };
}

/**
 * @param {Map<string, any>} bindings the wrapper's names (from readWrapper) @param {string} name
 * @returns {'primitive' | 'reference' | null} what a constant holds, following names; null when that cannot be read
 */
export function kindOfName(bindings, name) {
  const seen = new Set();
  let at = name;
  while (!seen.has(at)) {
    seen.add(at);
    const record = bindings.get(at)?.record;
    if (record?.kind === 'function') return 'reference';
    const kind = record?.fixed?.kinds.get(at);
    if (!kind) return null;
    if (typeof kind === 'string') return kind;
    at = kind.same;
  }
  return null;
}

/**
 * Who could reach a statement while the script loads, through any chain of uses.
 * @param {any[]} records of the wrapper @param {Map<string, any>} bindings
 * @returns {(target: any) => Set<any>} the records that use the target, or use something that does (the target itself is not in the set)
 */
export function createReach(records, bindings) {
  const usedBy = new Map(records.map((record) => [record, new Set()]));
  for (const record of records) {
    for (const name of record.uses.keys()) {
      const own = bindings.get(name);
      if (own && own.record !== record) usedBy.get(own.record).add(record);
    }
  }
  const known = new Map();
  return (target) => {
    if (known.has(target)) return known.get(target);
    const found = new Set();
    const queue = [target];
    while (queue.length) {
      for (const user of usedBy.get(queue.pop())) {
        if (user === target || found.has(user)) continue;
        found.add(user);
        queue.push(user);
      }
    }
    known.set(target, found);
    return found;
  };
}
