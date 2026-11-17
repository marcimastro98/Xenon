// What is left of the browser scripts that are still over the size limit: the list a person
// needs to decide which ones are worth writing again. Reads texts, changes nothing.
//
//   node tools/restructure/browser-left.mjs [--top <n>] [--json]
//
// One row per `server/js` file of the sizes baseline (tools/quality/baseline/sizes.json),
// longest first: its lines today, its biggest function with its size, whether Node loads it
// too (then `browser inner` gives nothing), and what `browser inner` would still move.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withOneSearch } from './browser-consumers.mjs';
import { surveyScript } from './browser-inner-survey.mjs';
import { innerFilesOf, readBrowserLedger } from './browser-ledger.mjs';
import { nodeLoadWhy } from './browser-node-loads.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';

const SIZES = 'tools/quality/baseline/sizes.json';
const SCRIPT = /^server\/js\/.+\.js$/;

// The name a person would call a function by: its own, or the one it is stored under.
function nameOf(node, parent, K, textOf) {
  if (node.name) return textOf(node.name);
  if (node.kind === K.Constructor) return 'constructor';
  if (!parent) return '(no name)';
  if ((parent.kind === K.VariableDeclaration || parent.kind === K.PropertyAssignment || parent.kind === K.PropertyDeclaration) && parent.name) return textOf(parent.name);
  if (parent.kind === K.BinaryExpression && parent.right === node) return textOf(parent.left);
  if (parent.kind === K.CallExpression || parent.kind === K.NewExpression) return `(handed to ${textOf(parent.expression).split('\n')[0].slice(0, 40)})`;
  return '(no name)';
}

/**
 * @param {string} text @param {string} file @param {any} parser
 * @returns {{ name: string, lines: number, line: number } | null} the function with the most lines, whatever it is inside of; a function that is
 *   called where it is written (the wrapper of a script) is not one, since it is the script
 */
export function biggestFunction(text, file, parser) {
  const { K } = parser;
  const tree = parser.parse(text, file);
  const kinds = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor]);
  const textOf = (node) => text.slice(node.getStart(tree), node.end);
  const lineOf = (pos) => text.slice(0, pos).split('\n').length;
  const bare = (node) => (node.kind === K.ParenthesizedExpression ? bare(node.expression) : node);
  let best = null;
  const visit = (node, parent, above) => {
    // `(function () { … })()` and `(() => { … })()`: the call is two steps up, through the brackets.
    // `(function (root, factory) { … })(this, function () { … })`: the function handed over is the script as well.
    const called = parent && ((parent.kind === K.CallExpression && parent.expression === node)
      || (parent.kind === K.ParenthesizedExpression && above && above.kind === K.CallExpression && above.expression === parent)
      || (parent.kind === K.CallExpression && kinds.has(bare(parent.expression).kind)));
    if (kinds.has(node.kind) && !called) {
      const line = lineOf(node.getStart(tree));
      const lines = lineOf(node.end) - line + 1;
      if (!best || lines > best.lines) best = { name: nameOf(node, parent, K, textOf), lines, line };
    }
    node.forEachChild((child) => { visit(child, node, parent); });
  };
  visit(tree, null, null);
  return best;
}

/**
 * @param {string} root @param {any} parser
 * @returns {any[]} one row per `server/js` file of the sizes baseline, longest first: `{ file, lines, biggest, node, inner }` where `node` is null or the
 *   sentence that says who loads it in Node, and `inner` is `{ functions, constants, lines }` (what may leave today) or `{ nothing: why }`
 */
export function leftOf(root, parser) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const ledger = readBrowserLedger(root);
  const made = new Map(ledger.moves.filter((move) => ['script', 'inner', 'inline', 'after'].includes(move.kind)).map((move) => [move.file, move.from]));
  const files = Object.keys(JSON.parse(read(SIZES)).files).filter((file) => SCRIPT.test(file));
  const rows = withOneSearch(root, files, () => files.map((file) => {
    const text = read(file);
    const row = { file, lines: text.split('\n').length - 1, biggest: biggestFunction(text, file, parser), node: nodeLoadWhy(root, file, text) };
    if (row.node) return { ...row, inner: { nothing: 'Node loads it too' } };
    if (made.has(file)) return { ...row, inner: { nothing: `it is itself a part moved out of ${made.get(file) ?? 'a page'}` } };
    const found = surveyScript(text, file, parser, innerFilesOf(ledger, file).map((part) => ({ file: part, text: read(part) })));
    if (!found.wrapped) return { ...row, inner: { nothing: found.why } };
    return { ...row, inner: { functions: found.free.functions, constants: found.along.functions, lines: found.free.lines + found.along.lines } };
  }));
  return rows.sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file));
}

/** @param {any[]} rows from `leftOf` @param {number} [top] how many rows, all when left out @returns {string[]} the list as lines of text */
export function renderLeft(rows, top = rows.length) {
  const shown = rows.slice(0, top);
  const out = [`${'script'.padEnd(44)} ${'lines'.padStart(5)}  ${'biggest function'.padEnd(44)} Node  browser inner would still move`];
  for (const row of shown) {
    const biggest = row.biggest ? `${row.biggest.name.slice(0, 30)} ${row.biggest.lines} (line ${row.biggest.line})` : 'none';
    const inner = row.inner.nothing ? `nothing: ${row.inner.nothing.replace(`${row.file} `, '').slice(0, 90)}`
      : row.inner.lines ? `${row.inner.functions} functions and ${row.inner.constants} constants, ${row.inner.lines} lines` : 'nothing: every function is held';
    out.push(`${row.file.slice('server/js/'.length).padEnd(44)} ${String(row.lines).padStart(5)}  ${biggest.padEnd(44)} ${(row.node ? 'yes' : 'no').padEnd(4)}  ${inner}`);
  }
  const movable = rows.filter((row) => !row.inner.nothing);
  out.push('', `${rows.length} scripts of server/js are over the limit (${rows.reduce((sum, row) => sum + row.lines, 0)} lines)${shown.length < rows.length ? `, the ${shown.length} longest shown` : ''}. `
    + `Node loads ${rows.filter((row) => row.node).length} of them too. \`browser inner\` would still move ${movable.reduce((sum, row) => sum + row.inner.lines, 0)} lines out of ${movable.filter((row) => row.inner.lines).length}.`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : undefined;
  if (top !== undefined && !(Number.isInteger(top) && top > 0)) { console.error('--top wants a whole number above 0'); process.exitCode = 1; return; }
  const parser = await openParser();
  try {
    const rows = leftOf(REPO_ROOT, parser);
    if (args.includes('--json')) console.log(JSON.stringify(top ? rows.slice(0, top) : rows, null, 2));
    else for (const line of renderLeft(rows, top)) console.log(line);
  } finally { parser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
