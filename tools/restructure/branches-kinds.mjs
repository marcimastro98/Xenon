// The two chains of `if ... else if ...` the `branches` command takes bodies out of,
// and what differs between them. Everything else (the plan, the proof, the record)
// is the same code for both.
//
//   routes  the request handler: `if (reqPath === '/x' && req.method === 'GET') {`,
//           or one of the few other plain ways to ask for an address (ROUTE_TESTS).
//           A body is handed the request, the answer and five values of the handler,
//           and after them the few more it uses of those the handler works out before
//           the chain (`extra`: most bodies use none, so a call names only the ones its
//           body uses). A bare `return;` in a body still ends the request. A body that
//           gives a value back with `return` is called with `return await`: the chain is
//           the last thing the handler does, so the handler gives back the same value.
//   tools   the function that runs a tool for the assistant: `if (fnName === 'x') {`.
//           A body is handed twelve values of the function and gives back the one
//           thing it may assign, the tool's result; it may not `return` at all,
//           because the function goes on after the chain. A body that sets the
//           result just once, straight in its lines, stays (branches-scope.mjs).
//
// Both kinds can also hand a body names of the file itself, in one more argument
// (`typeOwn`): see branches-handler.mjs for which names.

import { routeChain } from './routes-list.mjs';

// The tests of a route a body can be named after. The test stays in the file as it is written; the key only says
// which body of the table is its own, so each way of writing a test gives a key no other way gives:
//
//   reqPath === '/x' && req.method === 'GET'                               GET /x       (in either order)
//   reqPath === '/x' && (req.method === 'POST' || req.method === 'GET')    POST|GET /x
//   reqPath.startsWith('/x/') && req.method === 'GET'                      GET /x/*     (in either order)
const ADDRESS = String.raw`'(\/[^'\\*|]*)'`;
const ASKED = String.raw`req\.method === '([A-Z]+)'`;
const whole = (text) => new RegExp(`^${text}$`);
const ROUTE_TESTS = [
  { test: whole(`reqPath === ${ADDRESS} && ${ASKED}`), key: (found) => `${found[2]} ${found[1]}` },
  { test: whole(`${ASKED} && reqPath === ${ADDRESS}`), key: (found) => `${found[1]} ${found[2]}` },
  { test: whole(String.raw`reqPath === ${ADDRESS} && \(${ASKED} \|\| ${ASKED}\)`), key: (found) => `${found[2]}|${found[3]} ${found[1]}` },
  { test: whole(String.raw`reqPath\.startsWith\(${ADDRESS}\) && ${ASKED}`), key: (found) => `${found[2]} ${found[1]}*` },
  { test: whole(String.raw`${ASKED} && reqPath\.startsWith\(${ADDRESS}\)`), key: (found) => `${found[1]} ${found[2]}*` },
];
const TOOL_NAME = /^fnName === '([a-z][a-z0-9_]*)'$/;

/**
 * @param {string} test a branch's test as written
 * @returns {string | null} `METHOD /path`, `METHOD|METHOD /path` or `METHOD /path*` when the test is exactly one of the
 *   ways above
 */
export function keyOf(test) {
  for (const way of ROUTE_TESTS) {
    const found = way.test.exec(test);
    if (found) return way.key(found);
  }
  return null;
}

// The chain of a function written `async function name(...) { ...; try { if ... else if ... } catch ... }`:
// the same shape routeChain gives, plus the `try` the chain is the whole of.
function chainInTry(text, parser, name) {
  const { K } = parser;
  const sourceFile = parser.parse(text, 'engine.js');
  const handler = sourceFile.statements.find((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === name);
  if (!handler?.body) throw new Error(`${name} is not a function declared at the top of the file`);
  const tries = handler.body.statements.filter((statement) => statement.kind === K.TryStatement);
  if (tries.length !== 1) throw new Error(`${name} has ${tries.length} try blocks of its own, one was expected`);
  const inside = tries[0].tryBlock.statements;
  if (inside.length !== 1 || inside[0].kind !== K.IfStatement) throw new Error(`the try block of ${name} is not one chain of tools and nothing else`);
  const branches = [];
  let node = inside[0];
  while (node && node.kind === K.IfStatement) {
    branches.push({ test: text.slice(node.expression.getStart(sourceFile), node.expression.end), node, block: node.thenStatement });
    node = node.elseStatement;
  }
  return { sourceFile, handler, chain: inside[0], branches, last: node, tryStatement: tries[0] };
}

export const ROUTES = Object.freeze({
  id: 'routes',
  handler: 'handleRequest',
  fileWord: 'routes',
  localWord: '',
  leading: Object.freeze(['req', 'res']),
  context: Object.freeze(['json', 'err500', 'reqPath', 'urlObj', 'isRemote']),
  extra: Object.freeze(['jsonpCb', 'remote', 'sendPage']),
  returns: true,
  result: null,
  indent: '    ',
  key: String.raw`[A-Z]+(?:\|[A-Z]+)? /[^'\\*|]*\*?`,
  keyOf,
  notKey: 'its test is not an address, or the start of one, asked with one method or either of two',
  chainOf: routeChain,
  type: '(req: any, res: any, context: any) => Promise<void>',
  typeOwn: '(req: any, res: any, context: any, engine?: any) => Promise<void>',
});

export const TOOLS = Object.freeze({
  id: 'tools',
  handler: 'runAiTool',
  fileWord: 'tools',
  localWord: 'Tools',
  leading: Object.freeze([]),
  context: Object.freeze(['fnName', 'fnArgs', 'clientActions', 'runAction', 'phoneRefusal', 'provider', 'remote', 'pictures', 'uiLang', 'surface', 'apiKey', 'latestUserText']),
  extra: Object.freeze([]),
  returns: false,
  result: 'fnResult',
  indent: '      ',
  key: '[a-z][a-z0-9_]*',
  keyOf: (test) => TOOL_NAME.exec(test)?.[1] ?? null,
  notKey: 'its test is not one tool asked by its name',
  chainOf: chainInTry,
  type: '(context: any) => Promise<any>',
  typeOwn: '(context: any, engine?: any) => Promise<any>',
});

export const KINDS = Object.freeze([ROUTES, TOOLS]);

/** @param {string} file a module's path or the path a require is written with @returns {typeof ROUTES | typeof TOOLS | null} by its file name */
export function kindOf(file) {
  const name = file.split('/').at(-1);
  return KINDS.find((kind) => name === `${kind.fileWord}.js` || (name.startsWith(`${kind.fileWord}-`) && name.endsWith('.js'))) ?? null;
}
