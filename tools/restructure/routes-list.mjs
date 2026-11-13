// Reads the engine's request handler as it is written: the chain of
// `if (path and method) { ... } else if ...` that picks a route, in order, and the
// lists of addresses that change something. Reading only.

/**
 * @param {string} text the file
 * @param {{ K: any, parse: (text: string, name: string) => any }} parser
 * @param {string} [name] the handler
 * @returns {{ sourceFile: any, handler: any, chain: any, branches: { test: string, node: any, block: any }[], last: any }}
 *   the handler, the first `if` of its chain, every branch in order (its test as written, its `if`, its body),
 *   and what stands after the last `else`
 */
export function routeChain(text, parser, name = 'handleRequest') {
  const { K } = parser;
  const sourceFile = parser.parse(text, 'engine.js');
  const textOf = (node) => text.slice(node.getStart(sourceFile), node.end);
  const declared = sourceFile.statements.filter((statement) => statement.kind === K.VariableStatement)
    .flatMap((statement) => statement.declarationList.declarations).find((declaration) => declaration.name.text === name);
  const handler = declared?.initializer;
  if (!handler?.body?.statements) throw new Error(`${name} is not a function declared at the top of the file`);
  const chains = handler.body.statements.filter((statement) => statement.kind === K.IfStatement && statement.elseStatement
    && /\breqPath\b/.test(textOf(statement.expression)));
  if (chains.length !== 1) throw new Error(`${name} has ${chains.length} chains of routes, one was expected`);
  if (handler.body.statements.at(-1) !== chains[0]) throw new Error(`${name} goes on after its chain of routes`);
  const branches = [];
  let node = chains[0];
  while (node && node.kind === K.IfStatement) {
    branches.push({ test: textOf(node.expression), node, block: node.thenStatement });
    node = node.elseStatement;
  }
  return { sourceFile, handler, chain: chains[0], branches, last: node };
}

const EXACT_GET = [/^reqPath === '([^'\\]+)' && req\.method === 'GET'$/, /^req\.method === 'GET' && reqPath === '([^'\\]+)'$/];

/**
 * @param {{ test: string }[]} branches
 * @returns {string[]} the addresses answered by a branch whose whole test is "this address, asked with GET", in order
 */
export function exactGetPaths(branches) {
  return branches.flatMap(({ test }) => EXACT_GET.map((shape) => shape.exec(test)?.[1]).filter(Boolean));
}

/**
 * The texts in `const NAME = new Set([ ... ])` at the top of a file. A list that holds anything but plain
 * texts is refused: half a list of addresses that change something would be worse than none.
 * @param {string} text @param {{ K: any, parse: (text: string, name: string) => any }} parser @param {string} name
 * @returns {string[]}
 */
export function setOfTexts(text, parser, name) {
  const { K } = parser;
  const sourceFile = parser.parse(text, 'list.js');
  const declared = sourceFile.statements.filter((statement) => statement.kind === K.VariableStatement)
    .flatMap((statement) => statement.declarationList.declarations).find((declaration) => declaration.name.text === name);
  const made = declared?.initializer;
  const list = made?.kind === K.NewExpression && made.expression.text === 'Set' && made.arguments?.length === 1 ? made.arguments[0] : null;
  if (!list || list.kind !== K.ArrayLiteralExpression) throw new Error(`${name} is not written as new Set([ ... ])`);
  const strange = list.elements.find((element) => element.kind !== K.StringLiteral);
  if (strange) throw new Error(`${name} holds something that is not a plain text: ${text.slice(strange.getStart(sourceFile), strange.end).slice(0, 60)}`);
  return list.elements.map((element) => element.text);
}

/**
 * @param {object} job
 * @param {string[]} job.paths every address a GET branch answers
 * @param {string[]} job.mutators the addresses that change something, from the engine's own lists
 * @param {Record<string, string>} job.skip address to the reason it is not asked
 * @returns {{ ask: string[], skipped: { path: string, reason: string }[], stale: string[] }}
 *   what to ask, what is left out and why, and the entries of the skip list that name no GET branch any more
 */
export function askable({ paths, mutators, skip }) {
  const changes = new Set(mutators);
  const ask = [];
  const skipped = [];
  for (const path of paths) {
    if (changes.has(path)) skipped.push({ path, reason: 'it changes something: the engine lists it among the addresses a page elsewhere must never trigger' });
    else if (Object.hasOwn(skip, path)) skipped.push({ path, reason: skip[path] });
    else ask.push(path);
  }
  return { ask, skipped, stale: Object.keys(skip).filter((path) => !paths.includes(path)) };
}
