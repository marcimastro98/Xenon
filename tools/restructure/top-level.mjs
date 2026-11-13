// Reads the top-level statements of a CommonJS file: what each one declares, the
// lines it covers together with its comment, and whether it runs code when the
// file loads.

import { createUseReader } from './scope-uses.mjs';

const PURE_CALLS = new Set(['Object.freeze', 'Object.seal', 'Object.keys', 'Object.values', 'Object.entries',
  'Object.fromEntries', 'Array.from', 'Array.of', 'Symbol', 'Symbol.for', 'Number', 'String', 'Boolean', 'BigInt',
  'parseInt', 'parseFloat', 'Math.max', 'Math.min', 'Math.round', 'Math.floor', 'Math.ceil', 'Math.pow']);
const PURE_NEW = new Set(['Set', 'Map', 'WeakMap', 'WeakSet', 'RegExp', 'Array']);
const PURE_METHODS = new Set(['split', 'join', 'concat', 'slice', 'toLowerCase', 'toUpperCase', 'trim', 'repeat',
  'padStart', 'padEnd', 'flat']);
const CALLBACK_METHODS = new Set(['map', 'filter', 'flatMap']);

/** @param {string} text @returns {number[]} offset of the first character of every line */
export function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/** @param {number[]} starts @param {number} offset @returns {number} 0-based line */
export function lineAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= offset) low = mid; else high = mid - 1;
  }
  return low;
}

function createPurity(K) {
  const SIMPLE = new Set([K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.RegularExpressionLiteral,
    K.NoSubstitutionTemplateLiteral, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.Identifier, K.OmittedExpression,
    K.FunctionExpression, K.ArrowFunction, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.MethodDeclaration,
    K.ComputedPropertyName]);
  const dotted = (node) => (node.kind === K.Identifier ? node.text
    : node.kind === K.PropertyAccessExpression && node.expression.kind === K.Identifier
      ? `${node.expression.text}.${node.name.text}` : '');
  const every = (node) => {
    let ok = true;
    node.forEachChild((child) => { if (ok && !pure(child)) ok = false; });
    return ok;
  };
  // An inline `x => expression` handed to map/filter runs now, so its body counts.
  const pureCallback = (node) => node && node.kind === K.ArrowFunction && node.body.kind !== K.Block && pure(node.body);
  function pure(node) {
    if (!node) return true;
    if (SIMPLE.has(node.kind)) return node.kind !== K.ComputedPropertyName || pure(node.expression);
    switch (node.kind) {
      case K.PropertyAccessExpression: return pure(node.expression);
      case K.NewExpression:
        return node.expression.kind === K.Identifier && PURE_NEW.has(node.expression.text)
          && (node.arguments ?? []).every(pure);
      case K.CallExpression: {
        const callee = node.expression;
        if (PURE_CALLS.has(dotted(callee))) return node.arguments.every(pure);
        if (callee.kind !== K.PropertyAccessExpression || !pure(callee.expression)) return false;
        if (PURE_METHODS.has(callee.name.text)) return node.arguments.every(pure);
        return CALLBACK_METHODS.has(callee.name.text) && node.arguments.length === 1 && pureCallback(node.arguments[0]);
      }
      case K.BinaryExpression:
        return !(node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment)
          && pure(node.left) && pure(node.right);
      case K.ConditionalExpression: return pure(node.condition) && pure(node.whenTrue) && pure(node.whenFalse);
      case K.PrefixUnaryExpression:
        return node.operator !== K.PlusPlusToken && node.operator !== K.MinusMinusToken && pure(node.operand);
      case K.ArrayLiteralExpression: case K.ObjectLiteralExpression: case K.PropertyAssignment:
      case K.ShorthandPropertyAssignment: case K.SpreadElement: case K.SpreadAssignment: case K.TemplateExpression:
      case K.TemplateSpan: case K.ParenthesizedExpression: case K.TypeOfExpression:
      case K.ElementAccessExpression: case K.VoidExpression:
        return every(node);
      default: return false;
    }
  }
  return pure;
}

function bindingNames(K, name, out = []) {
  if (!name) return out;
  if (name.kind === K.Identifier) out.push(name.text);
  else name.forEachChild((element) => { if (element.kind === K.BindingElement) bindingNames(K, element.name, out); });
  return out;
}

// What a top-level `if`, `try` or block leaves in the file's scope: its `var`s and functions.
function leakedNames(K, NodeFlags, node, out = []) {
  node.forEachChild((child) => {
    if (child.kind === K.FunctionDeclaration && child.name) { out.push(child.name.text); return; }
    if ([K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.ClassDeclaration, K.ClassExpression].includes(child.kind)) return;
    if (child.kind === K.VariableDeclarationList && (child.flags & NodeFlags.BlockScoped) === 0) {
      for (const d of child.declarations) bindingNames(K, d.name, out);
    }
    leakedNames(K, NodeFlags, child, out);
  });
  return out;
}

// `const x = require('spec')`, `const { a, b: c } = require('spec')`, `const x = require('spec').prop`.
// `span` is where a destructured name sits in the text, `head` what stands before the `require(`.
function requireOf(K, declaration, sourceFile, statementStart) {
  let init = declaration.initializer;
  let property = '';
  if (init && init.kind === K.PropertyAccessExpression) { property = init.name.text; init = init.expression; }
  if (!init || init.kind !== K.CallExpression || init.expression.kind !== K.Identifier) return null;
  if (init.expression.text !== 'require' || init.arguments.length !== 1 || init.arguments[0].kind !== K.StringLiteral) return null;
  const spec = init.arguments[0].text;
  const head = [statementStart, declaration.initializer.getStart(sourceFile)];
  if (declaration.name.kind === K.Identifier) return { spec, property, head, bindings: [{ local: declaration.name.text, text: '' }] };
  if (declaration.name.kind !== K.ObjectBindingPattern) return null;
  const bindings = [];
  for (const element of declaration.name.elements) {
    if (element.name.kind !== K.Identifier || element.initializer || element.dotDotDotToken) return null;
    bindings.push({ local: element.name.text, text: element.getText(), span: [element.getStart(sourceFile), element.end] });
  }
  return { spec, property, head, bindings };
}

/**
 * @param {any} sourceFile a tree from parser.mjs
 * @param {{K: any, NodeFlags: any, commentsBefore: Function}} parser
 * @returns {any[]} one record per top-level statement, in file order. Lines are 1-based:
 *   `line` is the code, `range` adds the comment block above it and the blank
 *   lines after it that go with it when it is taken out.
 */
export function readTopLevel(sourceFile, parser) {
  const { K, NodeFlags } = parser;
  const text = sourceFile.text;
  const starts = lineStarts(text);
  const lineText = (line) => text.slice(starts[line], line + 1 < starts.length ? starts[line + 1] - 1 : text.length);
  const isBlank = (line) => line >= 0 && line < starts.length && lineText(line).trim() === '';
  const usesOf = createUseReader(K, NodeFlags);
  const pure = createPurity(K);
  const statements = sourceFile.statements.filter((s) => (s.flags & NodeFlags.Reparsed) === 0);

  const records = statements.map((node, index) => {
    const codeStart = node.getStart(sourceFile);
    const first = lineAt(starts, codeStart);
    const last = lineAt(starts, Math.max(codeStart, node.end - 1));
    // The comment block that touches the statement: whole comment lines, no blank line between.
    const comments = parser.commentsBefore(text, node.pos);
    const inComment = (line) => {
      const from = starts[line] + (lineText(line).length - lineText(line).trimStart().length);
      const to = starts[line] + lineText(line).trimEnd().length;
      return to > from && comments.some((c) => c.pos <= from && c.end >= to);
    };
    let top = first;
    while (top > 0 && inComment(top - 1)) top -= 1;
    let blanks = 0;
    while (isBlank(last + 1 + blanks) && last + 1 + blanks < starts.length - 1) blanks += 1;
    const takesBlanks = blanks > 0 && (top === 0 || isBlank(top - 1));
    const record = {
      index, kind: 'statement', names: [], loadTime: true, require: null, isAsync: false,
      line: [first + 1, last + 1], range: [top + 1, last + 1 + (takesBlanks ? blanks : 0)],
      sharesLine: false, uses: usesOf(node),
    };
    if (node.kind === K.FunctionDeclaration && node.name) {
      Object.assign(record, { kind: 'function', names: [node.name.text], loadTime: false });
    } else if (node.kind === K.ClassDeclaration && node.name) {
      // Only `static` members run when the class is declared.
      const runsNow = node.members.some((m) => m.kind === K.ClassStaticBlockDeclaration || (m.kind === K.PropertyDeclaration
        && (m.modifiers ?? []).some((mod) => mod.kind === K.StaticKeyword) && !pure(m.initializer)));
      Object.assign(record, { kind: 'class', names: [node.name.text], loadTime: runsNow });
    } else if (node.kind === K.VariableStatement) {
      const list = node.declarationList;
      const requires = list.declarations.map((d) => requireOf(K, d, sourceFile, codeStart));
      record.kind = (list.flags & NodeFlags.Const) ? 'const' : (list.flags & NodeFlags.Let) ? 'let' : 'var';
      record.names = list.declarations.flatMap((d) => bindingNames(K, d.name));
      if (record.kind === 'const' && requires.length === 1 && requires[0]) {
        Object.assign(record, { kind: 'require', require: requires[0], loadTime: false });
      } else record.loadTime = !list.declarations.every((d) => pure(d.initializer));
    } else record.names = leakedNames(K, NodeFlags, node);
    return record;
  });
  for (let i = 1; i < records.length; i += 1) {
    if (records[i].line[0] <= records[i - 1].line[1]) records[i].sharesLine = records[i - 1].sharesLine = true;
    // A comment block can only belong to one statement.
    if (records[i].range[0] <= records[i - 1].line[1]) records[i].range[0] = records[i - 1].line[1] + 1;
  }
  return records;
}

/**
 * The text of 1-based lines `from`..`to` with their line breaks.
 * @param {string} text @param {number[]} starts @param {number} from @param {number} to
 */
export function sliceLines(text, starts, from, to) {
  return text.slice(starts[from - 1], to < starts.length ? starts[to] : text.length);
}
