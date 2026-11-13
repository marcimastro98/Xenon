// Reads the top-level statements of a CommonJS file: what each one declares, the
// lines it covers together with its comment, and whether it runs code when the
// file loads.

import { isBuiltin } from 'node:module';

import { createLoadTimeCheck, repoLoadTimeCalls } from './load-time-calls.mjs';
import { createUseReader } from './scope-uses.mjs';

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

// The Node modules the file holds whole under a name that cannot change: `const os = require('os')`.
function builtinModules(K, NodeFlags, statements, sourceFile) {
  const moduleOf = new Map();
  for (const node of statements) {
    if (node.kind !== K.VariableStatement || (node.declarationList.flags & NodeFlags.Const) === 0) continue;
    for (const declaration of node.declarationList.declarations) {
      const required = declaration.name.kind === K.Identifier ? requireOf(K, declaration, sourceFile, 0) : null;
      if (required && !required.property && isBuiltin(required.spec)) moduleOf.set(declaration.name.text, required.spec.replace(/^node:/, ''));
    }
  }
  return moduleOf;
}

/**
 * @param {any} sourceFile a tree from parser.mjs
 * @param {{K: any, NodeFlags: any, commentsBefore: Function}} parser
 * @param {import('./load-time-calls.mjs').LoadTimeCalls} [calls] the calls a value may make at load and still move
 * @returns {any[]} one record per top-level statement, in file order. Lines are 1-based:
 *   `line` is the code, `range` adds the comment block above it and the blank
 *   lines after it that go with it when it is taken out. `loadCalls` names what a
 *   declaration runs at load that is not on the list. `handedTo` names the calls the
 *   statement hands a function to (scope-uses.mjs).
 */
export function readTopLevel(sourceFile, parser, calls = repoLoadTimeCalls()) {
  const { K, NodeFlags } = parser;
  const text = sourceFile.text;
  const starts = lineStarts(text);
  const lineText = (line) => text.slice(starts[line], line + 1 < starts.length ? starts[line + 1] - 1 : text.length);
  const isBlank = (line) => line >= 0 && line < starts.length && lineText(line).trim() === '';
  const usesOf = createUseReader(K, NodeFlags);
  const statements = sourceFile.statements.filter((s) => (s.flags & NodeFlags.Reparsed) === 0);
  const blocker = createLoadTimeCheck(K, calls, builtinModules(K, NodeFlags, statements, sourceFile));
  const blockersOf = (nodes) => nodes.map(blocker).filter(Boolean);

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
    const handedTo = new Set();
    const record = {
      index, kind: 'statement', names: [], loadTime: true, loadCalls: [], require: null, isAsync: false,
      line: [first + 1, last + 1], range: [top + 1, last + 1 + (takesBlanks ? blanks : 0)],
      sharesLine: false, uses: usesOf(node, handedTo), handedTo: [...handedTo],
    };
    if (node.kind === K.FunctionDeclaration && node.name) {
      Object.assign(record, { kind: 'function', names: [node.name.text], loadTime: false });
    } else if (node.kind === K.ClassDeclaration && node.name) {
      // Only `static` members run when the class is declared.
      const statics = node.members.filter((m) => m.kind === K.PropertyDeclaration
        && (m.modifiers ?? []).some((mod) => mod.kind === K.StaticKeyword));
      record.loadCalls = [...(node.members.some((m) => m.kind === K.ClassStaticBlockDeclaration) ? ['static { }'] : []),
        ...blockersOf(statics.map((m) => m.initializer))];
      Object.assign(record, { kind: 'class', names: [node.name.text], loadTime: record.loadCalls.length > 0 });
    } else if (node.kind === K.VariableStatement) {
      const list = node.declarationList;
      const requires = list.declarations.map((d) => requireOf(K, d, sourceFile, codeStart));
      record.kind = (list.flags & NodeFlags.Const) ? 'const' : (list.flags & NodeFlags.Let) ? 'let' : 'var';
      record.names = list.declarations.flatMap((d) => bindingNames(K, d.name));
      if (record.kind === 'const' && requires.length === 1 && requires[0]) {
        Object.assign(record, { kind: 'require', require: requires[0], loadTime: false });
      } else {
        record.loadCalls = blockersOf(list.declarations.map((d) => d.initializer));
        record.loadTime = record.loadCalls.length > 0;
      }
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
