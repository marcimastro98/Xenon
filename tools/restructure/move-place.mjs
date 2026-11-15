// A file that finds its neighbours from the folder it sits in (`path.join(__dirname, 'battery.ps1')`) may still
// move one folder down, when every such path is a join that starts at `__dirname`: the join gets the way back up
// (`path.join(__dirname, '..', 'battery.ps1')`), so it ends at the same file as before. `require.resolve` of a
// name written out stays as it is: a package is found from any folder below the same node_modules, and a relative
// name is a load that move-plan.mjs spells again. Anything else that depends on the place still stops the move.

import path from 'node:path';

const posix = path.posix;
const JOINS = new Set(['join', 'resolve']);
const lastName = (K, node) => (node.kind === K.Identifier ? node.text : node.kind === K.PropertyAccessExpression ? node.name.text : '');

/** @param {{from: string, to: string}} move @returns {string[] | null} the folders from the new place back to the old one */
export function wayBack(move) {
  const back = posix.relative(posix.dirname(move.to), posix.dirname(move.from));
  return /^\.\.(\/\.\.)*$/.test(back) ? back.split('/') : null;
}

/**
 * @param {{from: string, to: string}} move @param {any} tree the parsed file @param {any} K
 * @returns {{ edits: {start: number, end: number, was: string, text: string, kind: string}[], why: string | null }}
 */
export function placeEdits(move, tree, K) {
  const back = wayBack(move);
  const edits = [];
  let why = null;
  const walk = (node, parent) => {
    if (node.kind === K.Identifier && node.text === '__dirname') {
      const joined = parent?.kind === K.CallExpression && parent.arguments[0] === node && JOINS.has(lastName(K, parent.expression));
      if (!joined) why ??= 'it says __dirname outside a join that starts with it: its place is part of what it does';
      else if (!back) why ??= 'it says __dirname and does not move straight down: its place is part of what it does';
      else edits.push({ start: node.end, end: node.end, was: '', text: back.map((part) => `, '${part}'`).join(''), kind: 'place' });
    }
    const resolves = node.kind === K.PropertyAccessExpression && node.name.text === 'resolve' && node.expression.kind === K.Identifier && node.expression.text === 'require';
    if (resolves) {
      const named = parent?.kind === K.CallExpression && parent.expression === node ? parent.arguments[0] : null;
      const written = named && (named.kind === K.StringLiteral || named.kind === K.NoSubstitutionTemplateLiteral);
      if (!written) why ??= 'it says require.resolve of a name worked out at run time: its place is part of what it does';
    }
    node.forEachChild((child) => { walk(child, node); });
  };
  walk(tree, null);
  return { edits: why ? [] : edits, why };
}
