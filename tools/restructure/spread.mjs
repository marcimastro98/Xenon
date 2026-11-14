// Cuts one big frozen object into parts, in the file where it stands:
//
//   const BIG = Object.freeze({        const BIG_ONE = Object.freeze({
//     a: 1,                              a: 1,
//     b: 2,                            });
//   });                           ->
//                                      const BIG_TWO = Object.freeze({
//                                        b: 2,
//                                      });
//
//                                      const BIG = Object.freeze({
//                                        ...BIG_ONE,
//                                        ...BIG_TWO,
//                                      });
//
// Each part is an ordinary constant afterwards, small enough for `extract` to move
// into a module. No line of a key changes and the parts stand in the old order
// right before the object, so every value is worked out at the same moment as
// before. The rules:
//   - the object is `const NAME = Object.freeze({`, a line of its own, closed by
//     `});` on a line of its own, and holds only plain `key: value` entries: no
//     spread, no method, no getter, no computed or numeric key, no `__proto__`,
//     no key twice;
//   - a part starts at a key that begins its line, together with the comment
//     lines right above it; the first part starts with the object;
//   - the part names are new words in the file.
// The proof reads both texts again from scratch (proveSpread).

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { analyze } from './analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { protectedNames, readLedger, recordSpread } from './ledger.mjs';
import { checksAvailable, typeBaseline, typeCounts } from './ratchets.mjs';
import { sameObjectProblems } from './spread-eval.mjs';
import { END_LINE, headLine, innerLines, spreadLine, undoSpreadInPlace } from './spread-undo.mjs';
import { topStatements } from './state-refs.mjs';
import { syntaxProblems, unknownNameProblems } from './verify.mjs';

const WORD = /^[A-Za-z_$][\w$]*$/;
const wholeWord = (name) => new RegExp(String.raw`(?<![\w$])${name.replace(/[$]/g, String.raw`\$&`)}(?![\w$])`, 'g');
const timesIn = (text, name) => (text.match(wholeWord(name)) ?? []).length;
const lineOf = (text, offset) => text.slice(0, offset).split('\n').length - 1;

// `const name = Object.freeze({ ... });` at the top level of a parsed file, with its place among the statements.
function frozenLiteral(sourceFile, parser, name) {
  const { K, NodeFlags } = parser;
  const statements = topStatements(sourceFile, parser);
  for (const [index, statement] of statements.entries()) {
    const list = statement.kind === K.VariableStatement ? statement.declarationList : null;
    const first = list?.declarations[0];
    if (!first || first.name.kind !== K.Identifier || first.name.text !== name) continue;
    const value = first.initializer;
    const plain = (list.flags & NodeFlags.Const) !== 0 && list.declarations.length === 1 && value?.kind === K.CallExpression
      && value.expression.getText(sourceFile) === 'Object.freeze' && value.arguments.length === 1
      && value.arguments[0].kind === K.ObjectLiteralExpression;
    return plain ? { index, statement, literal: value.arguments[0] } : null;
  }
  return null;
}

// The key of an entry that can be cut apart from its neighbours, or why it cannot.
function plainKey(property, K) {
  if (property.kind !== K.PropertyAssignment && property.kind !== K.ShorthandPropertyAssignment) return { reason: 'an entry that is not `key: value`' };
  const key = property.name;
  if (key.kind !== K.Identifier && key.kind !== K.StringLiteral) return { reason: 'a computed or numeric key' };
  if (key.text === '__proto__' || /^(?:0|[1-9]\d*)$/.test(key.text)) return { reason: `the key ${key.text}, which is not kept in written order` };
  return { key: key.text };
}

/** @returns {{ keys: string[], reasons: string[] }} the keys of a literal in written order, and what keeps it from being cut */
function literalKeys(literal, K) {
  const keys = [];
  const reasons = new Set();
  for (const property of literal.properties) {
    const { key, reason } = plainKey(property, K);
    if (reason) reasons.add(reason);
    else if (keys.includes(key)) reasons.add(`the key ${key} twice`);
    else keys.push(key);
  }
  return { keys, reasons: [...reasons] };
}

// The line each part starts on: its first key's line, moved up over the comment lines right above it.
function cutLines({ text, sourceFile, literal, keys, parts, inner }) {
  const lines = text.split('\n');
  const reasons = [];
  const cuts = [];
  for (const part of parts) {
    const at = keys.indexOf(part.first);
    if (at === -1) { reasons.push(`${part.first} is not a key of the object`); continue; }
    const property = literal.properties[at];
    let line = lineOf(text, property.getStart(sourceFile));
    if (!lines[line].trimStart().startsWith(property.name.getText(sourceFile))) reasons.push(`the key ${part.first} does not begin its line`);
    while (line - 1 > inner.first && /^\s*\/\//.test(lines[line - 1])) line -= 1;
    const offset = lines.slice(0, line).join('\n').length + 1;
    const between = at === 0 ? '' : text.slice(literal.properties[at - 1].end, offset);
    if (at > 0 && !/^,[ \t]*(?:\/\/[^\n]*)?\n\s*$/.test(between)) reasons.push(`the entry before ${part.first} does not end on a line of its own`);
    if (cuts.length && line <= cuts.at(-1)) reasons.push(`${part.first} does not come after the part before it`);
    cuts.push(line);
  }
  if (reasons.length === 0 && cuts[0] !== inner.first + 1) reasons.push(`the first part has to start with the object: ${keys[0]} is its first key`);
  return { cuts, reasons };
}

/**
 * @param {object} job
 * @param {string} job.text the file
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative, for messages
 * @param {string} job.name the frozen object
 * @param {{ name: string, first: string }[]} job.parts the parts in order: the constant's name and the first key it holds
 * @param {Set<string>} [job.protectedNames] names that never change
 * @returns {{ newSource: string, name: string, parts: { name: string, first: string, keys: number }[] }} throws a Refusal
 */
export function planSpread({ text, parser, source, name, parts, protectedNames: kept = new Set() }) {
  const reasons = [];
  if (kept.has(name)) reasons.push(`${name} is protected (tools/restructure/protected.json)`);
  if (parts.length < 2) reasons.push('a cut needs two parts or more');
  for (const part of parts) {
    if (!WORD.test(part.name) || parts.filter((other) => other.name === part.name).length > 1) reasons.push(`${part.name} is not a name of its own`);
    else if (timesIn(text, part.name)) reasons.push(`${source} already has the word ${part.name}`);
  }
  const sourceFile = parser.parse(text, source);
  const found = frozenLiteral(sourceFile, parser, name);
  const inner = innerLines(text, name);
  if (!found || !inner || lineOf(text, found.statement.getStart(sourceFile)) !== inner.first || lineOf(text, found.statement.end - 1) !== inner.last) {
    throw new Refusal([...reasons, `${name} is not \`${headLine(name)}\` on a line of its own, closed by \`${END_LINE}\` on a line of its own, at the top level of ${source}`]);
  }
  const { keys, reasons: keyReasons } = literalKeys(found.literal, parser.K);
  reasons.push(...keyReasons.map((reason) => `${name} holds ${reason}`));
  if (reasons.length) throw new Refusal(reasons);
  const { cuts, reasons: cutReasons } = cutLines({ text, sourceFile, literal: found.literal, keys, parts, inner });
  if (cutReasons.length) throw new Refusal(cutReasons);

  const lines = text.split('\n');
  const ends = [...cuts.slice(1), inner.last];
  const block = parts.flatMap((part, index) => [headLine(part.name), ...lines.slice(cuts[index], ends[index]), END_LINE, '']);
  block.push(headLine(name), ...parts.map((part) => spreadLine(part.name)), END_LINE);
  const firstKeys = parts.map((part) => keys.indexOf(part.first));
  return { newSource: [...lines.slice(0, inner.first), ...block, ...lines.slice(inner.last + 1)].join('\n'), name,
    parts: parts.map((part, index) => ({ name: part.name, first: part.first, keys: (firstKeys[index + 1] ?? keys.length) - firstKeys[index] })) };
}

// The statements of a cut as the new text has them: every part right before the object, the object made of them only.
function readCut(sourceFile, parser, spread) {
  const whole = frozenLiteral(sourceFile, parser, spread.name);
  const parts = spread.parts.map((part) => frozenLiteral(sourceFile, parser, part.name));
  if (!whole || parts.some((part) => !part)) return { problems: [`${spread.name} or one of its parts is no longer a frozen object written out at the top level`] };
  const problems = [];
  if (parts.some((part, index) => part.index !== whole.index - parts.length + index)) problems.push(`the parts of ${spread.name} do not stand right before it, in order`);
  const made = whole.literal.properties.map((property) => (property.kind === parser.K.SpreadAssignment ? property.expression.getText(sourceFile) : null));
  if (made.join('\n') !== spread.parts.map((part) => part.name).join('\n')) problems.push(`${spread.name} is not its parts spread in order and nothing else`);
  return { problems, whole, parts };
}

/**
 * Reads both texts again and checks the cut changed nothing but where the keys are written.
 * @param {{ before: string, after: string, parser: any, source: string, spread: { name: string, parts: { name: string }[] } }} job
 * @returns {string[]} problems; empty when the cut is proven
 */
export function proveSpread({ before, after, parser, source, spread }) {
  let undone;
  try { undone = undoSpreadInPlace(after, spread); } catch (error) { return [error.message]; }
  if (undone !== before) return [`with the keys of the parts put back, ${source} is not the old file byte for byte`];
  const oldFile = parser.parse(before, source);
  const newFile = parser.parse(after, source);
  const old = frozenLiteral(oldFile, parser, spread.name);
  if (!old) return [`${spread.name} was not one frozen object written out at the top level of the old ${source}`];
  const cut = readCut(newFile, parser, spread);
  if (!cut.whole) return cut.problems;
  const problems = [...cut.problems];
  for (const reason of literalKeys(old.literal, parser.K).reasons) problems.push(`${spread.name} holds ${reason}: spread together it may come out in another order`);
  const texts = (file, literal) => literal.properties.map((property) => property.getText(file));
  if (texts(oldFile, old.literal).join('\n\u0000') !== cut.parts.flatMap((part) => texts(newFile, part.literal)).join('\n\u0000')) {
    problems.push(`the entries of the parts, one after the other, are not the entries ${spread.name} had`);
  }
  for (const part of spread.parts) {
    if (timesIn(before, part.name) !== 0 || timesIn(after, part.name) !== 2) problems.push(`${part.name} is named somewhere else than where it is declared and where it is spread`);
  }
  if (problems.length) return problems;
  const record = analyze(before, parser, source).records.find((entry) => entry.names.includes(spread.name));
  const oldLines = innerLines(before, spread.name);
  const newLines = after.split('\n').slice(innerLines(after, spread.parts[0].name).first, innerLines(after, spread.name).last + 1);
  return sameObjectProblems({ oldCode: before.split('\n').slice(oldLines.first, oldLines.last + 1).join('\n'), newCode: newLines.join('\n'),
    name: spread.name, outside: [...record.uses.keys()] });
}

/** Plans a cut of `text` with the repo's protected list. Throws a Refusal. */
export function planSpreadFor({ root, parser, text, source, name, parts }) {
  const guard = protectedNames(root, source, analyze(text, parser, source).records);
  if (guard.missing.length) {
    throw new Refusal([`tools/restructure/protected.json names ${guard.missing.join(', ')}, which ${source} no longer declares: correct the list first`]);
  }
  return planSpread({ text, parser, source, name, parts, protectedNames: guard.names });
}

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative file that declares the object
 * @param {string} job.name the frozen object
 * @param {{ name: string, first: string }[]} job.parts
 * @param {boolean} [job.dryRun] plan and prove, write nothing
 * @returns {{ name: string, parts: { name: string, first: string, keys: number }[], sourceLines: number }}
 *   `sourceLines` is how many lines the file grew by; throws a Refusal before anything is written, an Error after a
 *   failed check (file put back)
 */
export function spreadObject({ root, parser, source, name, parts, dryRun = false }) {
  const before = readFileSync(path.join(root, source), 'utf8');
  const plan = planSpreadFor({ root, parser, text: before, source, name, parts });
  const proof = proveSpread({ before, after: plan.newSource, parser, source, spread: plan });
  if (proof.length) throw new Error(`the plan does not prove itself, nothing was written:\n${proof.join('\n')}`);
  const count = (text) => text.split('\n').length - 1;
  const result = { name, parts: plan.parts, sourceLines: count(plan.newSource) - count(before) };
  if (dryRun) return result;

  writeFileSync(path.join(root, source), plan.newSource);
  const entries = readLedger(root).sources[source] ?? [];
  const problems = syntaxProblems(root, [source]);
  if (problems.length === 0 && checksAvailable(root)) problems.push(...unknownNameProblems(typeCounts(root), typeBaseline(root), [source, ...entries.map((entry) => entry.file)]));
  if (problems.length) {
    writeFileSync(path.join(root, source), before);
    throw new Error(`the cut failed its checks and was undone:\n${problems.join('\n')}`);
  }
  recordSpread(root, source, { name, parts: parts.map((part) => ({ name: part.name, first: part.first })), after: entries.length });
  return result;
}

/**
 * The `spread` command of cli.mjs.
 * @param {any} parser @param {string} root @param {{ flags: Record<string, any>, rest: string[] }} args
 * @returns {number} the exit code
 */
export function runSpread(parser, root, { flags, rest }) {
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  const dryRun = Boolean(flags['dry-run']);
  const parts = rest.map((pair) => { const [name, first] = pair.split('='); return { name, first }; });
  const done = spreadObject({ root, parser, source: posix(flags.from), name: flags.name, parts, dryRun });
  console.log(`${dryRun ? 'would cut' : 'cut'} ${done.name} into ${done.parts.length} parts; ${posix(flags.from)} ${dryRun ? 'would grow' : 'grew'} by ${done.sourceLines} lines. `
    + 'Worked out with stand-ins, old and new have the same keys in the same order, the same values, the same things frozen.');
  for (const part of done.parts) console.log(`  ${part.name}: ${part.keys} keys, from ${part.first}`);
  if (!dryRun) console.log('Next: move each part with extract, then node tools/restructure/gate.mjs');
  return 0;
}
