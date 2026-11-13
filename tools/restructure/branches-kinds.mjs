// The two chains of `if ... else if ...` the `branches` command takes bodies out of,
// and what differs between them. Everything else (the plan, the proof, the record)
// is the same code for both.
//
//   routes  the request handler: `if (reqPath === '/x' && req.method === 'GET') {`.
//           A body is handed the request, the answer and five values of the handler;
//           it gives nothing back, so a bare `return;` in it still ends the request.
//   tools   the function that runs a tool for the assistant: `if (fnName === 'x') {`.
//           A body is handed twelve values of the function and gives back the one
//           thing it may assign, the tool's result; it may not `return` at all,
//           because the function goes on after the chain. A body that sets the
//           result just once, straight in its lines, stays (branches-scope.mjs).

import { routeChain } from './routes-list.mjs';

const METHOD_AND_PATH = [/^reqPath === '(\/[^'\\]*)' && req\.method === '([A-Z]+)'$/, /^req\.method === '([A-Z]+)' && reqPath === '(\/[^'\\]*)'$/];
const TOOL_NAME = /^fnName === '([a-z][a-z0-9_]*)'$/;

/** @param {string} test a branch's test as written @returns {string | null} `METHOD /path` when the test is exactly that */
export function keyOf(test) {
  const first = METHOD_AND_PATH[0].exec(test);
  if (first) return `${first[2]} ${first[1]}`;
  const second = METHOD_AND_PATH[1].exec(test);
  return second ? `${second[1]} ${second[2]}` : null;
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
  result: null,
  indent: '    ',
  key: String.raw`[A-Z]+ /[^'\\]*`,
  keyOf,
  notKey: 'its test is not one address asked with one method',
  chainOf: routeChain,
  type: '(req: any, res: any, context: any) => Promise<void>',
});

export const TOOLS = Object.freeze({
  id: 'tools',
  handler: 'runAiTool',
  fileWord: 'tools',
  localWord: 'Tools',
  leading: Object.freeze([]),
  context: Object.freeze(['fnName', 'fnArgs', 'clientActions', 'runAction', 'phoneRefusal', 'provider', 'remote', 'pictures', 'uiLang', 'surface', 'apiKey', 'latestUserText']),
  result: 'fnResult',
  indent: '      ',
  key: '[a-z][a-z0-9_]*',
  keyOf: (test) => TOOL_NAME.exec(test)?.[1] ?? null,
  notKey: 'its test is not one tool asked by its name',
  chainOf: chainInTry,
  type: '(context: any) => Promise<any>',
});

export const KINDS = Object.freeze([ROUTES, TOOLS]);

/** @param {string} file a module's path or the path a require is written with @returns {typeof ROUTES | typeof TOOLS | null} by its file name */
export function kindOf(file) {
  const name = file.split('/').at(-1);
  return KINDS.find((kind) => name === `${kind.fileWord}.js` || (name.startsWith(`${kind.fileWord}-`) && name.endsWith('.js'))) ?? null;
}
