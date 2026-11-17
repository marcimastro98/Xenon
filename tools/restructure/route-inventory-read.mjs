// Reads, from the engine's own text, every address it answers and where the answer is
// written: a test of the chain in handleRequest (its body in server.js, or a call into a
// table of a feature), a table that feature-routes.js dispatches to, a route of its
// FEATURES list, or a socket of the `upgrade` handler. Reading only: nothing is loaded.
//
// A test of the chain this file cannot read stops it, by name: an inventory that skips
// a route without saying so would be worse than none.

import path from 'node:path';

import { keyOf } from './branches-kinds.mjs';
import { readListed } from './dispatch-undo.mjs';
import { routeChain } from './routes-list.mjs';

export const ENGINE = 'server/server.js';
export const FEATURE_ROUTES = 'server/feature-routes.js';
const inServer = (spec) => path.posix.join('server', spec);

/** @param {string} key a key as keyOf writes it @returns {{ method: string, path: string, key: string }[]} one per method and address */
export function routesOfKey(key) {
  const space = key.indexOf(' ');
  const methods = key.slice(0, space).split('|');
  const addresses = key.slice(space + 1).split('|');
  return methods.flatMap((method) => addresses.map((address) => ({ method, path: address, key })));
}

/**
 * The names of the object literal a file declares or exports, read with the parser.
 * @param {any} sourceFile @param {{ K: any }} parser
 * @param {(statement: any) => any} pick hands back the object literal a statement holds, or nothing
 * @returns {string[] | null} null when no statement holds one
 */
function objectKeys(sourceFile, parser, pick) {
  const { K } = parser;
  for (const statement of sourceFile.statements) {
    const object = pick(statement);
    if (!object) continue;
    if (object.kind !== K.ObjectLiteralExpression) throw new Error('a list of routes is not written as a plain object');
    return object.properties.map((property) => {
      if (property.kind !== K.PropertyAssignment || property.name.kind !== K.StringLiteral) {
        throw new Error(`a list of routes holds something that is not 'METHOD /address': ${sourceFile.text.slice(property.getStart(sourceFile), property.end).slice(0, 60)}`);
      }
      return property.name.text;
    });
  }
  return null;
}

const declared = (parser, name) => (statement) => (statement.kind === parser.K.VariableStatement
  ? statement.declarationList.declarations.find((one) => one.name.text === name)?.initializer : null);

const exportedRoutes = (parser) => (statement) => {
  const { K } = parser;
  const made = statement.kind === K.ExpressionStatement ? statement.expression : null;
  const left = made?.kind === K.BinaryExpression ? made.left : null;
  if (left?.kind !== K.PropertyAccessExpression || left.expression.text !== 'module' || left.name.text !== 'exports') return null;
  if (made.right.kind !== K.ObjectLiteralExpression) return null;
  return made.right.properties.find((property) => property.name?.text === 'routes')?.initializer ?? null;
};

/** @returns {string[]} the keys of `const branches = { ... }` in a table file */
export function tableKeys(text, parser) {
  const keys = objectKeys(parser.parse(text, 'table.js'), parser, declared(parser, 'branches'));
  if (!keys) throw new Error('the file declares no `const branches = { ... }`');
  return keys;
}

/** @returns {string[]} the keys of `routes` in the module.exports of a FEATURES file */
export function featureKeys(text, parser) {
  const keys = objectKeys(parser.parse(text, 'feature.js'), parser, exportedRoutes(parser));
  if (!keys) throw new Error('the file exports no `routes: { ... }`');
  return keys;
}

/** @param {string} listText feature-routes.js @returns {string[]} the files of FEATURES, as required there */
export function featureFiles(listText) {
  const open = listText.indexOf('const FEATURES = Object.freeze([\n');
  const close = listText.indexOf(']);', open);
  if (open === -1 || close === -1) throw new Error('feature-routes.js has no `const FEATURES = Object.freeze([ ... ]);`');
  const lines = listText.slice(open, close).split('\n').slice(1).filter((line) => line.trim() !== '');
  return lines.map((line) => {
    const found = /^ {2}require\('\.\/([^']+)'\),$/.exec(line);
    if (!found) throw new Error(`FEATURES holds a line that is not one required file: ${line.trim()}`);
    return found[1];
  });
}

// The tests of the chain that are not one of keyOf's plain ways. Each gives its routes, or the dispatch to the tables.
const OTHER_TESTS = [
  { test: /^featureRoutes\.has\(req\.method, reqPath\)$/, read: () => 'tables' },
  { test: /^(\w+)\[reqPath\] && req\.method === '([A-Z]+)'$/,
    read: (found, own) => own.keysOf(found[1]).map((address) => ({ method: found[2], path: address })) },
  { test: /^reqPath\.startsWith\('(\/[^']*)'\) && !\(await featureUnlock\.isUnlocked\('([a-z-]+)'\)\)$/,
    read: (found) => [{ method: '*', path: `${found[1]}*`, note: `answers "locked" until the ${found[2]} feature is unlocked, before the routes under it` }] },
  { test: /^req\.method === 'GET' && \/\^\\\/\(([a-z|]+)\)\(\\\/\|\$\)\/\.test\(reqPath\)$/,
    read: (found) => found[1].split('|').map((folder) => ({ method: 'GET', path: `/${folder}/*`, note: `static files; /${folder} itself too` })) },
  { test: /^req\.method === '([A-Z]+)' && \((reqPath\.startsWith\([^)]+\)(?: \|\| reqPath\.startsWith\([^)]+\))+)\)$/,
    read: (found, own) => [...found[2].matchAll(/reqPath\.startsWith\(([^)]+)\)/g)].map((part) => ({ method: found[1], path: `${own.valueOf(part[1])}*` })) },
];

/**
 * @param {(file: string) => string} read reads a repo-relative file
 * @param {any} parser from openParser
 * @param {Record<string, string>} names values of the names a test of the chain may use for an address
 * @returns {{ method: string, path: string, asked: string, body: string, note?: string, order: number }[]}
 *   every route in the order handleRequest asks for it (`order`); `asked` says by what: chain, table, feature, socket
 */
export function readRoutes(read, parser, names = {}) {
  const engine = read(ENGINE);
  const listText = read(FEATURE_ROUTES);
  const { branches, sourceFile } = routeChain(engine, parser);
  const tableOf = new Map();
  const { all, specs } = readListed(listText);
  for (const spec of all) for (const key of tableKeys(read(inServer(spec)), parser)) tableOf.set(key, inServer(spec));
  const localFile = new Map([...engine.matchAll(/^const \{ branches: (\w+) \} = require\('\.\/([^']+)'\);$/gm)].map((found) => [found[1], inServer(found[2])]));
  const own = {
    keysOf: (name) => objectKeys(sourceFile, parser, declared(parser, name)) ?? [],
    valueOf: (written) => {
      const plain = /^'(\/[^']*)'$/.exec(written);
      if (plain) return plain[1];
      if (Object.hasOwn(names, written)) return names[written];
      throw new Error(`a test of handleRequest names an address the inventory does not know: ${written}`);
    },
  };
  const rows = [{ method: 'OPTIONS', path: '*', asked: 'before the chain', body: ENGINE, note: 'answered 204 before any route' }];
  for (const branch of branches) {
    const test = branch.test.replace(/\s*\n\s*/g, ' ');
    const key = keyOf(test);
    const other = key ? null : OTHER_TESTS.map((way) => ({ way, found: way.test.exec(test) })).find((one) => one.found);
    if (!key && !other) throw new Error(`a test of handleRequest the inventory cannot read: ${test.slice(0, 160)}`);
    const routes = key ? routesOfKey(key) : other.way.read(other.found, own);
    if (routes === 'tables') {
      for (const spec of featureFiles(listText)) {
        for (const one of featureKeys(read(inServer(spec)), parser)) rows.push(...routesOfKey(one).map((route) => ({ ...route, asked: 'feature', body: inServer(spec) })));
      }
      for (const spec of specs) for (const one of tableKeys(read(inServer(spec)), parser)) {
        if (/\*/.test(one)) continue; // a beginning stays a test of the chain
        rows.push(...routesOfKey(one).map((route) => ({ ...route, asked: 'table', body: inServer(spec) })));
      }
      continue;
    }
    const statement = branch.block.statements?.[0];
    const first = statement ? engine.slice(statement.getStart(sourceFile), statement.end) : '';
    const call = /^await (\w+)\['([^']+)'\]\(/.exec(first);
    if (call && tableOf.get(call[2]) !== localFile.get(call[1])) throw new Error(`a body of handleRequest calls a table the inventory cannot place: ${call[1]}['${call[2]}']`);
    const body = call ? localFile.get(call[1]) : ENGINE;
    rows.push(...routes.map((route) => ({ ...route, asked: 'chain', body })));
  }
  const sockets = [...engine.matchAll(/^ {2}const WS_PATHS = \[([^\]]*)\];$/gm)];
  if (sockets.length !== 1) throw new Error(`server.js has ${sockets.length} lists of socket addresses (WS_PATHS), one was expected`);
  for (const found of sockets[0][1].matchAll(/'(\/[^']*)'/g)) rows.push({ method: 'WS', path: found[1], asked: 'socket', body: ENGINE, note: 'upgrade handler' });
  return rows.map((row, order) => ({ ...row, order }));
}
