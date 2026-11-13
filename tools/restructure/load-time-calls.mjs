// Says whether a top-level value can be worked out at another moment of the file's
// load and still be the same value: every call in it has to be on the list in
// load-time-calls.json, which also explains the rule.

import { readFileSync } from 'node:fs';

const LIST = new URL('./load-time-calls.json', import.meta.url);
const NAME_LISTS = ['functions', 'constructors', 'methods', 'methodsTakingAFunction'];
const SHOWN = 60;

/**
 * The names of the language itself a value may use and still need nothing from its file:
 * the same in every module, at any moment. (Calling them is a separate question, answered
 * by the list in load-time-calls.json.)
 */
export const PLAIN_GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'Array', 'BigInt', 'Boolean', 'Map', 'Math', 'Number', 'Object',
  'RegExp', 'Set', 'String', 'Symbol', 'WeakMap', 'WeakSet', 'parseFloat', 'parseInt']);

/**
 * @typedef {{ functions: Set<string>, constructors: Set<string>, methods: Set<string>,
 *   methodsTakingAFunction: Set<string>, moduleFunctions: Map<string, Set<string>> }} LoadTimeCalls
 */

/**
 * @param {any} json the parsed list
 * @returns {LoadTimeCalls}
 */
export function readLoadTimeCalls(json) {
  const names = (value, key) => {
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || !name)) {
      throw new Error(`load-time-calls.json: ${key} must be a list of names`);
    }
    return new Set(value);
  };
  const rules = Object.fromEntries(NAME_LISTS.map((key) => [key, names(json[key] ?? [], key)]));
  rules.moduleFunctions = new Map(Object.entries(json.moduleFunctions ?? {})
    .map(([module, list]) => [module, names(list, `moduleFunctions.${module}`)]));
  return /** @type {LoadTimeCalls} */ (rules);
}

let repoList;
/** @returns {LoadTimeCalls} the list kept next to this file */
export function repoLoadTimeCalls() {
  repoList ??= readLoadTimeCalls(JSON.parse(readFileSync(LIST, 'utf8')));
  return repoList;
}

/**
 * @param {Record<string, number>} K SyntaxKind
 * @param {LoadTimeCalls} rules
 * @param {Map<string, string>} moduleOf local name -> the Node module a top-level `const x = require('module')` gave it
 * @returns {(node: any) => string} '' when the expression only computes a value, else the first call that is not on the list
 */
export function createLoadTimeCheck(K, rules, moduleOf) {
  const SIMPLE = new Set([K.StringLiteral, K.NumericLiteral, K.BigIntLiteral, K.RegularExpressionLiteral,
    K.NoSubstitutionTemplateLiteral, K.TrueKeyword, K.FalseKeyword, K.NullKeyword, K.Identifier, K.OmittedExpression,
    K.FunctionExpression, K.ArrowFunction, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.MethodDeclaration,
    K.ComputedPropertyName]);
  const WHOLE = new Set([K.ArrayLiteralExpression, K.ObjectLiteralExpression, K.PropertyAssignment,
    K.ShorthandPropertyAssignment, K.SpreadElement, K.SpreadAssignment, K.TemplateExpression, K.TemplateSpan,
    K.ParenthesizedExpression, K.TypeOfExpression, K.ElementAccessExpression, K.VoidExpression]);
  const dotted = (node) => (node.kind === K.Identifier ? node.text
    : node.kind === K.PropertyAccessExpression && node.expression.kind === K.Identifier
      ? `${node.expression.text}.${node.name.text}` : '');
  const shown = (node) => {
    const text = node.getText().split('\n')[0];
    return text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text;
  };
  const firstOf = (nodes) => {
    for (const node of nodes) {
      const found = blocker(node);
      if (found) return found;
    }
    return '';
  };
  const children = (node) => {
    const list = [];
    node.forEachChild((child) => { list.push(child); });
    return list;
  };
  const moduleFunction = (callee) => callee.kind === K.PropertyAccessExpression && callee.expression.kind === K.Identifier
    && Boolean(rules.moduleFunctions.get(moduleOf.get(callee.expression.text) ?? '')?.has(callee.name.text));
  const boundNames = (name, out = []) => {
    if (name.kind === K.Identifier) out.push(name.text);
    else name.forEachChild((element) => { if (element.kind === K.BindingElement) boundNames(element.name, out); });
    return out;
  };
  // An inline `x => expression` handed to map/filter runs now, so its expression counts. A parameter
  // named like a required module would hide the module, and a default value would run too: neither is accepted.
  const inlineFunction = (node) => node && node.kind === K.ArrowFunction && node.body.kind !== K.Block
    && node.parameters.every((parameter) => !parameter.initializer && boundNames(parameter.name).every((name) => !moduleOf.has(name)));

  function callBlocker(node) {
    const callee = node.expression;
    if (rules.functions.has(dotted(callee)) || moduleFunction(callee)) return firstOf(node.arguments);
    if (callee.kind !== K.PropertyAccessExpression) return `${shown(callee)}()`;
    const method = callee.name.text;
    if (rules.methods.has(method)) return blocker(callee.expression) || firstOf(node.arguments);
    if (!rules.methodsTakingAFunction.has(method) || node.arguments.length !== 1 || !inlineFunction(node.arguments[0])) {
      return `${shown(callee)}()`;
    }
    return blocker(callee.expression) || blocker(node.arguments[0].body);
  }

  function blocker(node) {
    if (!node) return '';
    if (SIMPLE.has(node.kind)) return node.kind === K.ComputedPropertyName ? blocker(node.expression) : '';
    if (WHOLE.has(node.kind)) return firstOf(children(node));
    switch (node.kind) {
      case K.PropertyAccessExpression: return blocker(node.expression);
      case K.NewExpression:
        return node.expression.kind === K.Identifier && rules.constructors.has(node.expression.text)
          ? firstOf(node.arguments ?? []) : `new ${shown(node.expression)}()`;
      case K.CallExpression: return callBlocker(node);
      case K.BinaryExpression:
        return node.operatorToken.kind >= K.FirstAssignment && node.operatorToken.kind <= K.LastAssignment
          ? shown(node) : blocker(node.left) || blocker(node.right);
      case K.ConditionalExpression: return blocker(node.condition) || blocker(node.whenTrue) || blocker(node.whenFalse);
      case K.PrefixUnaryExpression:
        return node.operator === K.PlusPlusToken || node.operator === K.MinusMinusToken ? shown(node) : blocker(node.operand);
      default: return shown(node);
    }
  }
  return blocker;
}
