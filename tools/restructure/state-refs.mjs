// Finds every place a file's code names one of its top-level variables, and the
// shapes of code around a name that a rename to `object.property` would not keep:
// the state rewrite turns each place into a property of a shared object and has
// to refuse where that would change what the code means.

import { createUseReader } from './scope-uses.mjs';

const codeOnly = (K, NodeFlags) => (node) => (node.flags & NodeFlags.Reparsed) === 0
  && !(node.kind >= K.FirstTypeNode && node.kind <= K.LastTypeNode)
  && !(node.kind >= K.FirstJSDocNode && node.kind <= K.LastJSDocNode);

/** @param {any} sourceFile @param {{K: any, NodeFlags: any}} parser @returns {any[]} the statements `readTopLevel` numbers */
export function topStatements(sourceFile, { NodeFlags }) {
  return sourceFile.statements.filter((s) => (s.flags & NodeFlags.Reparsed) === 0);
}

/**
 * Every identifier that stands for one of `names` as the file's own top-level variable (a local of the same
 * name is another variable and is left out), in file order.
 * @param {any} sourceFile @param {{K: any, NodeFlags: any}} parser
 * @param {Set<string>} names @param {string} object the name the rewrite will put in front
 * @returns {{ name: string, start: number, end: number, statement: number, how: Set<string>, hidden: boolean }[]}
 *   `statement` is the position of the top-level statement around it, `how` what is done to it (read, write, change),
 *   `hidden` true when a local called `object` is in scope there.
 */
export function readReferences(sourceFile, parser, names, object) {
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const byEnd = new Map();
  topStatements(sourceFile, parser).forEach((statement, index) => {
    usesOf(statement, new Set(), (node, how, isLocal) => {
      if (!names.has(node.text)) return;
      let ref = byEnd.get(node.end);
      if (!ref) {
        ref = { name: node.text, start: node.end - node.text.length, end: node.end, statement: index, how: new Set(), hidden: isLocal(object) };
        byEnd.set(node.end, ref);
      }
      ref.how.add(how);
    });
  });
  return [...byEnd.values()].sort((a, b) => a.end - b.end);
}

/**
 * Where an identifier stands in a shape a rename would not keep, each as the set of the identifiers' end offsets:
 * `called` (`x()` and x`...`: as `o.x()` the function would get `o` as `this`), `shorthand` (`{ x }`),
 * `named` (`x = () => {}`: a function without a name takes the variable's, and would lose it), `deleted`.
 * @param {any} sourceFile @param {{K: any, NodeFlags: any}} parser
 * @returns {{ called: Set<number>, shorthand: Set<number>, named: Set<number>, deleted: Set<number>, withStatement: boolean }}
 */
export function readForms(sourceFile, { K, NodeFlags }) {
  const isCode = codeOnly(K, NodeFlags);
  const forms = { called: new Set(), shorthand: new Set(), named: new Set(), deleted: new Set(), withStatement: false };
  const bare = (node) => {
    let at = node;
    while (at && (at.kind === K.ParenthesizedExpression || at.kind === K.NonNullExpression)) at = at.expression;
    return at;
  };
  const nameless = (node) => {
    const at = bare(node);
    if (!at) return false;
    return at.kind === K.ArrowFunction || ((at.kind === K.FunctionExpression || at.kind === K.ClassExpression) && !at.name);
  };
  const identifierEnd = (node) => { const at = bare(node); return at && at.kind === K.Identifier ? at.end : -1; };
  const walk = (node) => {
    if (!node || !isCode(node)) return;
    switch (node.kind) {
      case K.CallExpression: forms.called.add(identifierEnd(node.expression)); break;
      case K.TaggedTemplateExpression: forms.called.add(identifierEnd(node.tag)); break;
      case K.ShorthandPropertyAssignment: forms.shorthand.add(node.name.end); break;
      case K.DeleteExpression: forms.deleted.add(identifierEnd(node.expression)); break;
      case K.WithStatement: forms.withStatement = true; break;
      case K.BinaryExpression:
        if (node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment
          && node.left.kind === K.Identifier && nameless(node.right)) forms.named.add(node.left.end);
        break;
      case K.VariableDeclaration:
        if (node.name.kind === K.Identifier && nameless(node.initializer)) forms.named.add(node.name.end);
        break;
      default:
    }
    node.forEachChild(walk);
  };
  walk(sourceFile);
  return forms;
}

/**
 * The names a top-level statement declares inside itself: parameters, locals, catch variables, inner functions
 * and classes. Its own top-level names (`own`) are not locals and are left out.
 * @param {any} statement @param {{K: any, NodeFlags: any}} parser @param {string[]} [own] @returns {Set<string>}
 */
export function localNames(statement, { K, NodeFlags }, own = []) {
  const isCode = codeOnly(K, NodeFlags);
  const out = new Set();
  const DECLARES = new Set([K.VariableDeclaration, K.Parameter, K.BindingElement, K.FunctionDeclaration, K.FunctionExpression,
    K.ClassDeclaration, K.ClassExpression]);
  const collect = (node) => {
    if (!node || !isCode(node)) return;
    if (DECLARES.has(node.kind) && node.name && node.name.kind === K.Identifier) out.add(node.name.text);
    node.forEachChild(collect);
  };
  if (statement.kind === K.VariableStatement) {
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.kind !== K.Identifier) collect(declaration.name);
      collect(declaration.initializer);
    }
  } else if (statement.kind === K.FunctionDeclaration || statement.kind === K.ClassDeclaration) {
    statement.forEachChild((child) => { if (child !== statement.name) collect(child); });
  } else collect(statement);
  for (const name of own) out.delete(name);
  return out;
}
