// Takes the wrapper off a script that is a module already. A classic script keeps
// its names to itself by running inside `(function () { ... })();`. A module's
// names are its own without that, so the two lines of the wrapper can go, and
// what was inside becomes the module's top level, where `browser extract` can
// reach it. Nothing else changes: every line between the two keeps its bytes,
// its indent too.
//
// The wrapper goes only where its code means the same without it:
//   - the script is a recorded module (`browser module`): when it runs is settled;
//   - the wrapper is all its code, beside 'use strict' and `export {};`;
//   - it is called with nothing and takes nothing: a wrapper that is handed values
//     (`(function (root, factory) { ... })(window, ...)`) would have to get them another way;
//   - it is not async, not a generator, has no name;
//   - nothing in it, outside the functions it declares, says `return`, `arguments`
//     or `new.target`: a module has none of the three.
// `this` needs no rule: it is undefined in a wrapper called this way inside a
// module, and undefined at a module's top level.

import { Refusal } from './extract-plan.mjs';

// The two lines as they may be written. Any other way of writing them is refused, not understood.
const OPENS = ['(function () {', '(() => {'];
const CLOSES = ['})();', '}());'];

const isDirective = (K, node) => node.kind === K.ExpressionStatement && node.expression.kind === K.StringLiteral;
const isEmptyExport = (K, node) => node.kind === K.ExportDeclaration && !node.moduleSpecifier && (node.exportClause?.elements?.length ?? 1) === 0;
const real = (parser, sourceFile) => sourceFile.statements.filter((node) => (node.flags & parser.NodeFlags.Reparsed) === 0);
const lineOf = (text, at) => text.slice(0, at).split('\n').length;

// The call and the function of `(function () { ... })();` or `(function () { ... }());`, null for anything else.
function wrapperCall(K, statement) {
  if (statement.kind !== K.ExpressionStatement) return null;
  let call = statement.expression;
  if (call.kind === K.ParenthesizedExpression && call.expression.kind === K.CallExpression) call = call.expression;
  if (call.kind !== K.CallExpression) return null;
  let made = call.expression;
  while (made.kind === K.ParenthesizedExpression) made = made.expression;
  return made.kind === K.FunctionExpression || made.kind === K.ArrowFunction ? { call, made } : null;
}

// What the wrapper's own code says that a module's top level cannot: looked for outside the functions declared in
// it. An arrow function has no `arguments` and no `new.target` of its own, so there the search goes on for those two.
function onlyInFunction(K, body, startOf) {
  const OWN = new Set([K.FunctionDeclaration, K.FunctionExpression, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor, K.ClassStaticBlockDeclaration]);
  const found = [];
  const visit = (node, inArrow) => {
    if (OWN.has(node.kind)) return;
    if (node.kind === K.ReturnStatement && !inArrow) found.push({ what: 'return', at: startOf(node) });
    if (node.kind === K.Identifier && node.text === 'arguments') found.push({ what: 'arguments', at: startOf(node) });
    if (node.kind === K.MetaProperty && node.keywordToken === K.NewKeyword) found.push({ what: 'new.target', at: startOf(node) });
    node.forEachChild((child) => { visit(child, inArrow || node.kind === K.ArrowFunction); });
  };
  for (const statement of body.statements) visit(statement, false);
  return found;
}

/**
 * Reads a script's wrapper.
 * @param {string} text @param {string} file @param {any} parser
 * @returns {{ wrapped: boolean, problems: string[], cut: null | { open: number[], close: number[] }, inside: string[], around: string[][] }}
 *   `wrapped`: one wrapper call is all the code; `cut`: where the two lines start and end, line break included, when
 *   they may go; `inside`: the text of every statement in the wrapper; `around`: of the statements before and after it
 */
export function wrapperOf(text, file, parser) {
  const { K } = parser;
  const sourceFile = parser.parse(text, file);
  const statements = real(parser, sourceFile);
  const code = statements.filter((node, index) => !(isDirective(K, node) && statements.slice(0, index).every((before) => isDirective(K, before))) && !isEmptyExport(K, node));
  const found = code.length === 1 ? wrapperCall(K, code[0]) : null;
  const none = { wrapped: false, cut: null, inside: [], around: [[], []] };
  if (!found) return { ...none, problems: [`${file} is not one wrapper around all its code: there is no wrapper to take off`] };
  const { call, made } = found;
  const say = (node) => text.slice(node.getStart(sourceFile), node.end);
  const at = statements.indexOf(code[0]);
  const around = [statements.slice(0, at).map(say), statements.slice(at + 1).map(say)];
  const problems = [];
  if (call.arguments.length || made.parameters.length) problems.push(`${file}: the wrapper is handed values when it is called: a module would have to get them another way`);
  if ((made.modifiers ?? []).some((modifier) => modifier.kind === K.AsyncKeyword)) problems.push(`${file}: the wrapper is async: its code goes on after the script has ended, a module's top level would hold the page instead`);
  if (made.asteriskToken) problems.push(`${file}: the wrapper is a generator`);
  if (made.name) problems.push(`${file}: the wrapper has a name (${made.name.text}) its own code can call`);
  if (call.questionDotToken) problems.push(`${file}: the wrapper is called with ?.`);
  if (!made.body || made.body.kind !== K.Block) return { ...none, wrapped: true, around, problems: [...problems, `${file}: the wrapper is one expression, not a block of code`] };
  const inside = made.body.statements.map(say);
  for (const { what, at: where } of onlyInFunction(K, made.body, (node) => node.getStart(sourceFile))) {
    problems.push(`${file}:${lineOf(text, where)} says \`${what}\` outside every function of its own: a module's top level has no ${what}`);
  }
  // The two lines, each alone on its line and written one of the known ways.
  const start = code[0].getStart(sourceFile);
  const brace = made.body.getStart(sourceFile);
  const end = code[0].end;
  const shut = made.body.end - 1;
  const openLine = text.slice(start, brace + 1);
  const closeLine = text.slice(shut, end);
  const alone = (from, to) => (from === 0 || text[from - 1] === '\n') && text[to] === '\n';
  const pairs = made.kind === K.ArrowFunction ? openLine === OPENS[1] && closeLine === CLOSES[0] : openLine === OPENS[0] && CLOSES.includes(closeLine);
  if (!pairs || !alone(start, brace + 1) || !alone(shut, end)) {
    problems.push(`${file}: the wrapper's two lines are not \`${OPENS[0]}\` (or \`${OPENS[1]}\`) and \`${CLOSES[0]}\`, each alone on its line: `
      + `${JSON.stringify(text.split('\n')[lineOf(text, start) - 1])} and ${JSON.stringify(text.split('\n')[lineOf(text, shut) - 1])}`);
  }
  return { wrapped: true, problems, cut: problems.length ? null : { open: [start, brace + 2], close: [shut, end + 1] }, inside, around };
}

/**
 * The proof of one unwrap, from the two texts alone. Written apart from the planner, so a mistake there shows up here.
 * @param {string} before @param {string} after @param {string} file @param {any} parser
 * @returns {string[]} problems, empty when the new text is the old one without its wrapper and the same code
 */
export function proveUnwrap(before, after, file, parser) {
  const problems = [];
  // 1. The new text is the old one without two lines, the wrapper's, and every other byte is where it was.
  const [old, now] = [before.split('\n'), after.split('\n')];
  const gone = [];
  let j = 0;
  for (let i = 0; i < old.length; i += 1) {
    if (j < now.length && old[i] === now[j] && !(gone.length === 0 && OPENS.includes(old[i]))) j += 1;
    else gone.push(i);
  }
  if (j !== now.length || gone.length !== 2 || !OPENS.includes(old[gone[0]]) || !CLOSES.includes(old[gone[1]])) {
    return [`${file} is not the old file without the two lines of its wrapper`];
  }
  // 2. What was inside the wrapper is now the top level, statement for statement: taking a line away joined no two statements.
  const was = wrapperOf(before, file, parser);
  const { K } = parser;
  const tree = parser.parse(after, file);
  const stands = real(parser, tree).map((node) => after.slice(node.getStart(tree), node.end));
  if (JSON.stringify(stands) !== JSON.stringify([...was.around[0], ...was.inside, ...was.around[1]])) problems.push(`${file}: the code without the wrapper is not the same statements as inside it`);
  // 3. It still says it is a module, and nothing of the wrapper is left.
  if (!real(parser, tree).some((node) => isEmptyExport(K, node))) problems.push(`${file} no longer says it is a module`);
  return problems;
}

/**
 * The move as texts.
 * @param {{ get: (file: string) => string | null }} tree @param {{ kind: 'unwrap', file: string }} move
 * @param {{ parser: any, earlier: any[] }} context
 * @returns {{ files: Map<string, string>, made: string[], record: any }} Throws a Refusal with every reason when the wrapper has to stay.
 */
export function unwrapMove(tree, move, { parser, earlier }) {
  const text = tree.get(move.file);
  if (text === null) throw new Refusal([`${move.file} does not exist`]);
  if (!earlier.some((entry) => entry.kind === 'module' && entry.file === move.file)) {
    throw new Refusal([`${move.file} is not a recorded module: as a classic script its wrapper is what keeps its names to itself (browser module first)`]);
  }
  const read = wrapperOf(text, move.file, parser);
  if (read.problems.length || !read.cut) throw new Refusal(read.problems);
  const { open, close } = read.cut;
  const made = text.slice(0, open[0]) + text.slice(open[1], close[0]) + text.slice(close[1]);
  const problems = proveUnwrap(text, made, move.file, parser);
  if (problems.length) throw new Refusal(problems);
  return { files: new Map([[move.file, made]]), made: [], record: { kind: 'unwrap', file: move.file } };
}
