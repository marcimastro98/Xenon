// Cuts the object a function returns into part functions, in the file where it stands:
//
//   function all(value) {                function one(source) {
//     const source = value || {};          return {
//     return {                               a: source.a,
//       a: source.a,                       };
//       b: source.b,                     }
//     };                            ->
//   }                                    function two(source) {
//                                          return {
//                                            b: source.b,
//                                          };
//                                        }
//
//                                        function all(value) {
//                                          const source = value || {};
//                                          return {
//                                            ...one(source),
//                                            ...two(source),
//                                          };
//                                        }
//
// Each part is an ordinary function afterwards, small enough for `extract` to move
// into a module. No line of a key changes, the parts are called in the old order and
// each is handed, under the same names, the arguments and constants of the function
// its keys read, so every value is worked out at the same moment as before. The rules:
//   - the function is `function name(a, b) {` at the margin, with plain names as
//     arguments; before its return it only declares constants (`const x = ...;`);
//     it ends with `  return {`, `  };` and `}` on lines of their own;
//   - the object holds only plain `key: value` entries (as `spread`: no spread, no
//     method, no getter, no computed or numeric key, no `__proto__`, no key twice),
//     and nothing in it says `this`, `arguments`, `super`, `await`, `yield` or
//     `new.target`, or gives an argument or a constant of the function another value;
//   - a part starts at a key that begins its line, together with the comment lines
//     right above it; the first part starts with the object;
//   - the part names are new words in the file.
// The proof reads both texts again from scratch (proveReturned).

import { analyze } from './analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { protectedNames } from './ledger.mjs';
import { listNames, wordsOf } from './returned-list.mjs';
import { CLOSE_LINE, callLine, partHead, returnLines, returnedLines, undoReturnedInPlace } from './returned-undo.mjs';
import { createUseReader } from './scope-uses.mjs';
import { cutLines, literalKeys, spreadObject } from './spread.mjs';
import { sameReturnProblems } from './spread-eval.mjs';
import { topStatements } from './state-refs.mjs';

const WORD = /^[A-Za-z_$][\w$]*$/;
const wholeWord = (name) => new RegExp(String.raw`(?<![\w$])${name.replace(/[$]/g, String.raw`\$&`)}(?![\w$])`, 'g');
const timesIn = (text, name) => (text.match(wholeWord(name)) ?? []).length;
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length - 1;
const sameList = (one, other) => one.length === other.length && one.every((item, index) => item === other[index]);

// `function name(...) { const ...; return { ... }; }` at the top level of a parsed file: its place among the
// statements, the object it returns (null when it does not end with one), and the names its body can read.
// With `list` it is the list written out that is looked for (returned-list.mjs).
const entriesOf = (literal) => literal.properties ?? literal.elements;
const namesOf = (literal, K, list) => (list ? listNames(literal, K) : literalKeys(literal, K));

function returningFunction(sourceFile, parser, name, list = false) {
  const { K, NodeFlags } = parser;
  const statements = topStatements(sourceFile, parser);
  const index = statements.findIndex((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === name);
  if (index === -1) return null;
  const declared = statements[index];
  const body = declared.body.statements.filter((statement) => (statement.flags & NodeFlags.Reparsed) === 0);
  const returns = body.at(-1);
  const literal = returns?.kind === K.ReturnStatement && returns.expression?.kind === (list ? K.ArrayLiteralExpression : K.ObjectLiteralExpression) ? returns.expression : null;
  const params = declared.parameters.map((parameter) => (parameter.name.kind === K.Identifier ? parameter.name.text : null));
  const constants = body.slice(0, -1).map((statement) => {
    const list = statement.kind === K.VariableStatement ? statement.declarationList : null;
    const plain = list && (list.flags & NodeFlags.Const) !== 0 && list.declarations.every((one) => one.name.kind === K.Identifier);
    return plain ? list.declarations.map((one) => one.name.text) : null;
  });
  const plain = !params.includes(null) && !constants.includes(null);
  return { index, declared, returns, literal, params, before: body.length - 1, locals: plain ? [...params, ...constants.flat()] : null };
}

// The words an object written in one function cannot keep its meaning with in another.
function boundWords(node, K) {
  const kinds = new Map([[K.ThisKeyword, 'this'], [K.SuperKeyword, 'super'], [K.AwaitExpression, 'await'], [K.YieldExpression, 'yield'], [K.MetaProperty, 'new.target']]);
  const found = new Set();
  const walk = (at) => {
    if (kinds.has(at.kind)) found.add(kinds.get(at.kind));
    else if (at.kind === K.Identifier && at.text === 'arguments') found.add('arguments');
    at.forEachChild(walk);
  };
  walk(node);
  return [...found];
}

// What keeps the object of a function from being cut, read from the tree: the same list for the plan and the proof.
function objectReasons(found, parser, name, list = false) {
  const { whole } = wordsOf(list);
  const reasons = namesOf(found.literal, parser.K, list).reasons.map((reason) => `the ${whole} ${name} returns holds ${reason}`);
  for (const word of boundWords(found.literal, parser.K)) reasons.push(`the ${whole} ${name} returns says \`${word}\`, which would mean something else in a part`);
  const uses = createUseReader(parser.K, parser.NodeFlags)(found.returns);
  for (const local of found.locals) if (uses.get(local)?.write) reasons.push(`the ${whole} ${name} returns gives ${local} another value: a part would change its own copy`);
  return reasons;
}

// The arguments and constants of the function the entries from `from` up to `to` read, in the order they are declared.
function handedTo(found, parser, from, to) {
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const read = new Set(entriesOf(found.literal).slice(from, to).flatMap((property) => [...usesOf(property).keys()]));
  return found.locals.filter((local) => read.has(local));
}

/**
 * @param {object} job
 * @param {string} job.text the file @param {any} job.parser from parser.mjs @param {string} job.source repo-relative, for messages
 * @param {string} job.name the function
 * @param {{ name: string, first: string }[]} job.parts the parts in order: the function's name and the first key it returns
 * @param {Set<string>} [job.protectedNames] names that never change
 * @param {boolean} [job.list] the function returns a list written out, and a part is said by the name of its first entry (returned-list.mjs)
 * @returns {{ newSource: string, name: string, list?: true, parts: { name: string, first: string, keys: number, params: string[] }[] }} throws a Refusal
 */
export function planReturned({ text, parser, source, name, parts, protectedNames: kept = new Set(), list = false }) {
  const { open, end } = returnLines(list);
  const words = wordsOf(list);
  const reasons = [];
  if (kept.has(name)) reasons.push(`${name} is protected (tools/restructure/protected.json)`);
  if (parts.length < 2) reasons.push('a cut needs two parts or more');
  for (const part of parts) {
    if (!WORD.test(part.name) || parts.filter((other) => other.name === part.name).length > 1) reasons.push(`${part.name} is not a name of its own`);
    else if (timesIn(text, part.name)) reasons.push(`${source} already has the word ${part.name}`);
  }
  const sourceFile = parser.parse(text, source);
  const found = returningFunction(sourceFile, parser, name, list);
  const where = returnedLines(text, name, list);
  const onLines = found?.literal && where && lineOf(text, found.declared.getStart(sourceFile)) === where.head && lineOf(text, found.declared.end - 1) === where.close
    && lineOf(text, found.returns.getStart(sourceFile)) === where.first && lineOf(text, found.returns.end - 1) === where.last;
  if (!onLines) {
    throw new Refusal([...reasons, `${name} is not \`${partHead(name, ['…'])}\` at the top level of ${source}, ending with \`${open.trim()}\`, \`${end.trim()}\` and \`${CLOSE_LINE}\` on lines of their own`]);
  }
  if (!found.locals) reasons.push(`${name} takes an argument that is not a plain name, or does something before its return that is not \`const name = ...\``);
  else reasons.push(...objectReasons(found, parser, name, list));
  if (reasons.length) throw new Refusal(reasons);
  const keys = namesOf(found.literal, parser.K, list).keys;
  const { cuts, reasons: cutReasons } = cutLines({ text, sourceFile, literal: found.literal, keys, parts, inner: where, entries: entriesOf(found.literal), words });
  if (cutReasons.length) throw new Refusal(cutReasons);

  const lines = text.split('\n');
  const ends = [...cuts.slice(1), where.last];
  const firstKeys = parts.map((part) => keys.indexOf(part.first));
  const made = parts.map((part, index) => ({ name: part.name, first: part.first, keys: (firstKeys[index + 1] ?? keys.length) - firstKeys[index],
    params: handedTo(found, parser, firstKeys[index], firstKeys[index + 1] ?? keys.length) }));
  // The parts stand right before the function, above the comment written on it.
  let top = where.head;
  while (top > 0 && /^\s*(?:\/\/|\/\*|\*)/.test(lines[top - 1])) top -= 1;
  const block = made.flatMap((part, index) => [partHead(part.name, part.params), open, ...lines.slice(cuts[index], ends[index]), end, CLOSE_LINE, '']);
  const calls = made.map((part) => callLine(part.name, part.params));
  return { newSource: [...lines.slice(0, top), ...block, ...lines.slice(top, where.first + 1), ...calls, ...lines.slice(where.last)].join('\n'), name, ...(list ? { list: true } : {}), parts: made };
}

// The cut as the new text has it: every part a function right before the old one that only returns an object,
// handed exactly what its entries read, and the old function returning the parts called in order and nothing else.
function readCut(newFile, parser, cut, locals) {
  const { K } = parser;
  const whole = returningFunction(newFile, parser, cut.name, cut.list);
  const parts = cut.parts.map((part) => returningFunction(newFile, parser, part.name, cut.list));
  const said = cut.list ? 'a list' : 'an object';
  if (!whole?.literal || parts.some((part) => !part?.literal)) return { problems: [`${cut.name} or one of its parts is no longer a function that ends by returning ${said} written out`] };
  const problems = [];
  if (parts.some((part, index) => part.index !== whole.index - parts.length + index)) problems.push(`the parts of ${cut.name} do not stand right before it, in order`);
  const usesOf = createUseReader(K, parser.NodeFlags);
  parts.forEach((part, index) => {
    const named = cut.parts[index].name;
    if (part.before !== 0) problems.push(`${named} does more than return ${said}`);
    const read = usesOf(part.returns);
    if (!sameList(part.params, locals.filter((local) => read.has(local)))) problems.push(`${named} is not handed exactly what its keys read of ${cut.name}: ${locals.filter((local) => read.has(local)).join(', ') || 'nothing'}`);
    const call = entriesOf(whole.literal)[index];
    const called = call?.kind === (cut.list ? K.SpreadElement : K.SpreadAssignment) && call.expression.kind === K.CallExpression && call.expression.expression.kind === K.Identifier
      && call.expression.expression.text === named && call.expression.arguments.every((argument) => argument.kind === K.Identifier)
      && sameList(call.expression.arguments.map((argument) => argument.text), part.params);
    if (!called) problems.push(`${cut.name} does not return ${named} called with ${part.params.join(', ') || 'nothing'} at place ${index + 1}`);
  });
  if (entriesOf(whole.literal).length !== parts.length) problems.push(`${cut.name} returns something else than its parts`);
  return { problems, whole, parts };
}

/**
 * Reads both texts again and checks the cut changed nothing but where the keys are written.
 * @param {{ before: string, after: string, parser: any, source: string, spread: { name: string, parts: { name: string }[] } }} job
 * @returns {string[]} problems; empty when the cut is proven
 */
export function proveReturned({ before, after, parser, source, spread: cut }) {
  let undone;
  try { undone = undoReturnedInPlace(after, cut); } catch (error) { return [error.message]; }
  if (undone !== before) return [`with the keys of the parts put back, ${source} is not the old file byte for byte`];
  const oldFile = parser.parse(before, source);
  const newFile = parser.parse(after, source);
  const old = returningFunction(oldFile, parser, cut.name, cut.list);
  if (!old?.literal || !old.locals) return [`${cut.name} was not a function of the old ${source} that declares constants and returns ${cut.list ? 'a list' : 'an object'} written out`];
  const made = readCut(newFile, parser, cut, old.locals);
  if (!made.whole) return made.problems;
  const problems = [...made.problems, ...objectReasons(old, parser, cut.name, cut.list)];
  if (!sameList(made.whole.locals ?? [], old.locals)) problems.push(`${cut.name} no longer has the arguments and constants it had`);
  const texts = (file, literal) => entriesOf(literal).map((property) => property.getText(file));
  if (texts(oldFile, old.literal).join('\n\u0000') !== made.parts.flatMap((part) => texts(newFile, part.literal)).join('\n\u0000')) {
    problems.push(`the entries of the parts, one after the other, are not the entries ${cut.name} returned`);
  }
  for (const part of cut.parts) {
    if (timesIn(before, part.name) !== 0 || timesIn(after, part.name) !== 2) problems.push(`${part.name} is named somewhere else than where it is declared and where it is called`);
  }
  if (problems.length) return problems;
  const record = analyze(before, parser, source).records.find((entry) => entry.names.includes(cut.name));
  const [was, now] = [returnedLines(before, cut.name, cut.list), returnedLines(after, cut.name, cut.list)];
  const first = returnedLines(after, cut.parts[0].name, cut.list).head;
  return sameReturnProblems({ oldCode: before.split('\n').slice(was.head, was.close + 1).join('\n'), newCode: after.split('\n').slice(first, now.close + 1).join('\n'),
    name: cut.name, outside: [...record.uses.keys()] });
}

/** Plans a cut of `text` with the repo's protected list. Throws a Refusal. */
export function planReturnedFor({ root, parser, text, source, name, parts, list = false }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planReturned({ text, parser, source, name, parts, protectedNames: guard.names, list });
}

/**
 * Cuts, proves, writes and records, as `spreadObject` does for a frozen object: the record is marked `returns`.
 * @param {{ root: string, parser: any, source: string, name: string, parts: { name: string, first: string }[], dryRun?: boolean, list?: boolean }} job
 *   `list`: what the function returns is a list (returned-list.mjs); the record says so too
 * @returns {{ name: string, parts: { name: string, first: string, keys: number, params: string[] }[], sourceLines: number }}
 */
export function cutReturned(job) {
  const planFor = (asked) => planReturnedFor({ ...asked, list: Boolean(job.list) });
  return spreadObject({ ...job, planFor, prove: proveReturned, mark: job.list ? { returns: true, list: true } : { returns: true } });
}

/**
 * The `spread --returned` command of cli.mjs.
 * @param {any} parser @param {string} root @param {{ flags: Record<string, any>, rest: string[] }} args
 * @returns {number} the exit code
 */
export function runReturned(parser, root, { flags, rest }) {
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  const dryRun = Boolean(flags['dry-run']);
  const parts = rest.map((pair) => { const [name, first] = pair.split('='); return { name, first }; });
  const list = Boolean(flags.list);
  const done = cutReturned({ root, parser, source: posix(flags.from), name: flags.name, parts, dryRun, list });
  console.log(`${dryRun ? 'would cut' : 'cut'} what ${done.name} returns into ${done.parts.length} functions; ${posix(flags.from)} ${dryRun ? 'would grow' : 'grew'} by ${done.sourceLines} lines. `
    + 'Run with stand-ins, old and new return the same ' + (list ? 'entries' : 'keys') + ' in the same order with the same values.');
  for (const part of done.parts) console.log(`  ${part.name}(${part.params.join(', ')}): ${part.keys} ${list ? 'entries' : 'keys'}, from ${part.first}`);
  if (!dryRun) console.log('Next: move each part with extract, then node tools/restructure/gate.mjs');
  return 0;
}
