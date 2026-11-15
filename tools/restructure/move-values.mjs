// Works out the file a path ends at when a test or a tool puts it together from pieces:
// `join(HERE, '..', 'x.js')`, `new URL('../x.js', import.meta.url)`, `read('x.js')` with `read` a small function
// of the same file that joins its argument to a folder. It reads the code, it runs nothing. A piece it does not
// know (a variable filled at run time, `process.cwd()`, a template) gives no answer, and no answer stops the move.
//
// A path is written here from the repo root with a leading slash: `/server/x.js`.

import path from 'node:path';

const posix = path.posix;
const DEPTH = 12;
const JOINS = new Set(['join', 'resolve']);
const PASSES = new Set(['fileURLToPath', 'pathToFileURL', 'normalize', 'toNamespacedPath']);

const lastName = (K, node) => (node.kind === K.Identifier ? node.text : node.kind === K.PropertyAccessExpression ? node.name.text : '');
const dotted = (K, node) => (node.kind === K.Identifier ? node.text
  : node.kind === K.PropertyAccessExpression ? `${dotted(K, node.expression)}.${node.name.text}`
    : node.kind === K.MetaProperty ? 'import.meta' : '?');

/**
 * @param {{ K: any, file: string, consts: Map<string, any>, functions: Map<string, any> }} where
 * @returns {(node: any, given?: Map<string, any>, depth?: number) => { abs?: string, piece?: string } | null}
 *   `abs` is a whole path, `piece` a part still to be joined to one
 */
export function makeValueOf({ K, file, consts }) {
  const here = `/${file}`;
  const joined = (name, parts) => {
    if (parts.some((part) => !part)) return null;
    let out = null;
    for (const part of parts) {
      if (out === null || (part.abs !== undefined && name === 'resolve')) out = part;
      else if (part.abs !== undefined) return null;
      else out = out.abs !== undefined ? { abs: posix.join(out.abs, part.piece) } : { piece: posix.join(out.piece, part.piece) };
    }
    if (out === null) return null;
    if (out.abs !== undefined) return { abs: posix.normalize(out.abs) };
    return name === 'resolve' ? null : out;
  };
  const pathOf = (node, given = new Map(), depth = 0) => {
    if (!node || depth > DEPTH) return null;
    if (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral) return { piece: node.text };
    if (node.kind === K.ParenthesizedExpression) return pathOf(node.expression, given, depth + 1);
    if (node.kind === K.Identifier) {
      if (given.has(node.text)) return given.get(node.text);
      if (node.text === '__dirname') return { abs: posix.dirname(here) };
      if (node.text === '__filename') return { abs: here };
      return consts.has(node.text) ? pathOf(consts.get(node.text), new Map(), depth + 1) : null;
    }
    if (node.kind === K.PropertyAccessExpression) {
      const name = dotted(K, node);
      if (name === 'import.meta.dirname') return { abs: posix.dirname(here) };
      return name === 'import.meta.filename' || name === 'import.meta.url' ? { abs: here } : null;
    }
    if (node.kind === K.NewExpression && lastName(K, node.expression) === 'URL') {
      const [spec, base] = (node.arguments ?? []).map((argument) => pathOf(argument, given, depth + 1));
      return spec?.piece !== undefined && base?.abs !== undefined ? { abs: posix.resolve(posix.dirname(base.abs), spec.piece) } : null;
    }
    if (node.kind !== K.CallExpression) return null;
    const name = lastName(K, node.expression);
    const parts = node.arguments.map((argument) => pathOf(argument, given, depth + 1));
    if (JOINS.has(name)) return joined(name, parts);
    if (name === 'dirname') return parts[0]?.abs !== undefined ? { abs: posix.dirname(parts[0].abs) } : null;
    return PASSES.has(name) && parts.length === 1 ? parts[0] : null;
  };
  return pathOf;
}

// The widest expression around a string that is still a path being put together.
function widest(K, node, above) {
  let top = node;
  for (const parent of above) {
    const call = parent.kind === K.CallExpression && (JOINS.has(lastName(K, parent.expression)) || PASSES.has(lastName(K, parent.expression)));
    const url = parent.kind === K.NewExpression && lastName(K, parent.expression) === 'URL';
    if (!call && !url && parent.kind !== K.ParenthesizedExpression) break;
    top = parent;
  }
  return top;
}

// Every join, resolve and `new URL` inside a function's body.
function pathsBuiltIn(K, body) {
  const found = [];
  const walk = (node) => {
    const isJoin = node.kind === K.CallExpression && JOINS.has(lastName(K, node.expression));
    const isUrl = node.kind === K.NewExpression && lastName(K, node.expression) === 'URL';
    if (isJoin || isUrl) found.push(node);
    else node.forEachChild(walk);
  };
  walk(body);
  return found;
}

/**
 * The file a string ends at, with everything it is joined to.
 * @param {{ K: any, file: string, node: any, above: any[], consts: Map<string, any>, functions: Map<string, any> }} site
 * @returns {string | null} `/server/x.js`, or null when the code does not say
 */
export function pathValueOf({ K, file, node, above, consts, functions }) {
  const pathOf = makeValueOf({ K, file, consts });
  const top = widest(K, node, above);
  const value = pathOf(top);
  if (value?.abs !== undefined) return value.abs;
  if (value?.piece === undefined) return null;
  // Still a piece: is it handed to a function of this file that joins it to a folder?
  const call = above[above.indexOf(top) + 1];
  if (!call || call.kind !== K.CallExpression || call.expression.kind !== K.Identifier) return null;
  const fn = functions.get(call.expression.text);
  const index = call.arguments.indexOf(top);
  const parameter = fn?.parameters?.[index];
  if (!parameter || parameter.name.kind !== K.Identifier || !fn.body) return null;
  const given = new Map([[parameter.name.text, value]]);
  const withIt = pathsBuiltIn(K, fn.body).filter((built) => pathOf(built) === null);
  const ends = new Set(withIt.map((built) => pathOf(built, given)?.abs).filter((abs) => abs !== undefined));
  return ends.size === 1 ? [...ends][0] : null;
}
