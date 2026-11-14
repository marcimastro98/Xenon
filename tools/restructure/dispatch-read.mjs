// Reads the request handler's chain of `if (address and method) { ... } else if ...` as it is written and says,
// for every branch in order: which method and address it asks for, how it asks (one address exactly, a beginning,
// or something else), and what answers (a function of a feature's table, or lines of the handler itself).
//
// It also answers the one question a table of exact addresses needs before a branch may leave the chain: can
// this other test be true for this method and this address? (`canMatch`). A test is read as far as it only asks
// about the method and the address; anything else in it (a header, the caller, a setting) counts as "may be true".
//
//   node tools/restructure/dispatch-read.mjs [--file server/server.js] [--json]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyOf } from './branches-kinds.mjs';
import { readCall } from './branches-text.mjs';
import { openParser, REPO_ROOT } from './parser.mjs';
import { routeChain } from './routes-list.mjs';

export const ENGINE = 'server/server.js';
// A key that names whole addresses only: one or two methods, one address or several, no beginning (`*`).
const EXACT_KEY = /^([A-Z]+(?:\|[A-Z]+)?) (\/[^*|]*(?:\|\/[^*|]*)*)$/;

/**
 * @param {string | null} key a branch's key (branches-kinds.mjs)
 * @returns {string[]} every `METHOD /address` the key stands for, none when it asks for a beginning or is no key
 */
export function exactRoutes(key) {
  const found = key ? EXACT_KEY.exec(key) : null;
  if (!found) return [];
  return found[1].split('|').flatMap((method) => found[2].split('|').map((address) => `${method} ${address}`));
}

/**
 * Whether a test can be true for one method and one address. Three answers: false (it cannot, whatever else
 * the request says), true (it is, whatever else the request says), null (it depends on something else).
 * @param {any} node the test's tree @param {{ K: any }} parser @param {string} method @param {string} address
 * @param {{ maps?: Record<string, string[]>, texts?: Record<string, string> }} [known] what is known of the file's own names:
 *   `maps` are objects asked as `NAME[reqPath]`, with their keys (every value a function); `texts` are names that stand for one text
 * @returns {boolean | null}
 */
export function canMatch(node, parser, method, address, known = {}) {
  const { K } = parser;
  const isName = (part, name) => part?.kind === K.Identifier && part.text === name;
  const isMethod = (part) => part?.kind === K.PropertyAccessExpression && isName(part.expression, 'req') && part.name.text === 'method';
  const named = (part) => (part?.kind === K.PropertyAccessExpression && part.expression.kind === K.Identifier ? `${part.expression.text}.${part.name.text}` : null);
  const text = (part) => (part?.kind === K.StringLiteral || part?.kind === K.NoSubstitutionTemplateLiteral ? part.text : known.texts?.[named(part)] ?? null);
  const standsFor = (part) => (isName(part, 'reqPath') ? address : isMethod(part) ? method : null);
  const read = (part) => {
    if (part.kind === K.ParenthesizedExpression) return read(part.expression);
    if (part.kind === K.PrefixUnaryExpression && part.operator === K.ExclamationToken) {
      const inner = read(part.operand);
      return inner === null ? null : !inner;
    }
    if (part.kind === K.ElementAccessExpression && part.expression.kind === K.Identifier && isName(part.argumentExpression, 'reqPath')) {
      const keys = known.maps?.[part.expression.text];
      return keys ? keys.includes(address) : null;
    }
    if (part.kind === K.BinaryExpression) {
      const operator = part.operatorToken.kind;
      if (operator === K.AmpersandAmpersandToken || operator === K.BarBarToken) {
        const left = read(part.left);
        const right = read(part.right);
        const ends = operator === K.BarBarToken;
        if (left === ends || right === ends) return ends;
        return left === null || right === null ? null : !ends;
      }
      if (operator === K.EqualsEqualsEqualsToken || operator === K.ExclamationEqualsEqualsToken) {
        const pairs = [[part.left, part.right], [part.right, part.left]];
        for (const [asked, literal] of pairs) {
          const value = standsFor(asked);
          const wanted = text(literal);
          if (value !== null && wanted !== null) return (value === wanted) === (operator === K.EqualsEqualsEqualsToken);
        }
      }
      return null;
    }
    if (part.kind === K.CallExpression && part.expression.kind === K.PropertyAccessExpression && part.arguments.length === 1) {
      const on = part.expression.expression;
      const how = part.expression.name.text;
      const argument = part.arguments[0];
      if (isName(on, 'reqPath') && text(argument) !== null && ['startsWith', 'endsWith', 'includes'].includes(how)) return address[how](text(argument));
      if (how === 'test' && on.kind === K.RegularExpressionLiteral && isName(argument, 'reqPath')) {
        const written = /^\/(.*)\/([a-z]*)$/s.exec(on.text);
        if (written && !/[gy]/.test(written[2])) return new RegExp(written[1], written[2]).test(address);
      }
    }
    return null;
  };
  return read(node);
}

/**
 * What `canMatch` may know of the file's own names. Read before the chain: a later parse ends the tree of an earlier one.
 * A map counts when it is a `const NAME = { '/address': function, ... }` at the top of the file that nothing mentions
 * but `NAME[reqPath]`; a text counts when the file requires its module under the name given, as one whole line.
 * @param {string} text the engine file @param {any} parser
 * @param {Record<string, { spec: string, values: Record<string, any> }>} [required] by the name in the file: the path as
 *   written and what the module gives (only its texts are kept)
 * @returns {{ maps: Record<string, string[]>, texts: Record<string, string> }}
 */
export function knownOf(text, parser, required = {}) {
  const { K } = parser;
  const maps = {};
  for (const statement of parser.parse(text, 'engine.js').statements) {
    if (statement.kind !== K.VariableStatement) continue;
    for (const declaration of statement.declarationList.declarations) {
      const made = declaration.initializer;
      if (declaration.name.kind !== K.Identifier || made?.kind !== K.ObjectLiteralExpression || made.properties.length === 0) continue;
      const name = declaration.name.text;
      const plain = made.properties.every((property) => property.kind === K.PropertyAssignment && property.name.kind === K.StringLiteral
        && (property.initializer.kind === K.ArrowFunction || property.initializer.kind === K.FunctionExpression));
      const mentions = text.match(new RegExp(`\\b${name}\\b(?!\\[reqPath\\])`, 'g')) ?? [];
      if (plain && mentions.length === 1 && new RegExp(`^const ${name} = \\{$`, 'm').test(text)) maps[name] = made.properties.map((property) => property.name.text);
    }
  }
  const texts = {};
  for (const [local, { spec, values }] of Object.entries(required)) {
    if (!text.split('\n').includes(`const ${local} = require('${spec}');`)) continue;
    for (const [name, value] of Object.entries(values)) if (typeof value === 'string') texts[`${local}.${name}`] = value;
  }
  return { maps, texts };
}

/**
 * Every branch of the chain, in order.
 * @param {string} text the engine file @param {any} parser from parser.mjs
 * @returns {{ rows: { at: number, line: number, test: string, key: string | null, routes: string[], how: 'exact' | 'beginning' | 'other',
 *   call: ReturnType<typeof readCall>, from: number, to: number, bodyLines: number, node: any }[], lines: string[], lastLine: number }}
 *   `routes`: the `METHOD /address` pairs an exact test asks for; `call`: the table function that answers, null when
 *   the lines of the handler answer; `from`/`to`: the 0-based lines of the branch, from the line of its test to the
 *   line before the next branch's test; `body`: the 0-based line its body starts on; `lastLine`: the 0-based line the chain's last `}` or `} else {` stands on
 */
export function readDispatch(text, parser) {
  const { sourceFile, branches, last } = routeChain(text, parser);
  const lines = text.split('\n');
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line;
  const starts = branches.map(({ node }, at) => (at === 0 ? lineOf(node.getStart(sourceFile)) : lineOf(branches[at - 1].block.end - 1)));
  const end = lineOf((last ?? branches.at(-1).block).end - 1);
  const lastLine = last ? lineOf(branches.at(-1).block.end - 1) : end;
  const rows = branches.map(({ test, node, block }, at) => {
    const key = keyOf(test);
    const routes = exactRoutes(key);
    const from = starts[at];
    const to = (at + 1 < branches.length ? starts[at + 1] : lastLine) - 1;
    const first = lineOf(block.getStart(sourceFile)) + 1;
    let final = lineOf(block.end - 1) - 1;
    while (final > first && lines[final].trim() === '') final -= 1;
    const call = first === final ? readCall(lines[first]) : null;
    return { at, line: from + 1, test, key, routes, how: routes.length ? 'exact' : key ? 'beginning' : 'other', call, from, to, body: first,
      bodyLines: final - first + 1, node: node.expression };
  });
  return { rows, lines, lastLine };
}

/** @param {ReturnType<typeof readDispatch>['rows']} rows @returns {string[]} one line per branch, then the counts */
export function renderDispatch(rows) {
  const out = rows.map((row) => {
    const asks = row.routes.length ? row.routes.join(', ') : row.key ?? row.test.replace(/\s+/g, ' ');
    const answers = row.call ? `${row.call.local}['${row.call.key}']${row.call.own.length ? ` handed ${row.call.own.join(', ')}` : ''}` : `${row.bodyLines} lines of the handler`;
    return `${String(row.line).padStart(6)}  ${row.how.padEnd(9)}  ${asks}  ->  ${answers}`;
  });
  const count = (how) => rows.filter((row) => row.how === how).length;
  out.push(`${rows.length} branches: ${count('exact')} ask for whole addresses, ${count('beginning')} for a beginning, ${count('other')} another way; `
    + `${rows.filter((row) => row.call).length} are answered by a table's function, ${rows.filter((row) => !row.call).length} by lines of the handler.`);
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.includes('--file') ? args[args.indexOf('--file') + 1] : ENGINE;
  const parser = await openParser();
  try {
    const { rows } = readDispatch(readFileSync(path.join(REPO_ROOT, file), 'utf8'), parser);
    if (args.includes('--json')) console.log(JSON.stringify(rows.map(({ node, ...row }) => row), null, 1));
    else for (const line of renderDispatch(rows)) console.log(line);
  } finally {
    parser.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
