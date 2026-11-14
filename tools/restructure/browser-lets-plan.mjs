// Plans turning `let` variables of a classic browser script's wrapper into
// properties of one object, declared where the first of them stood: every read
// and write of `name` becomes `object.name`. Nothing else changes: who writes,
// when, and in which order. A `let` can never leave its wrapper, because a script
// that loads earlier could not follow it; an object written out can, and takes
// along the functions that use it (browser-inner-plan.mjs).
//
//   before                                after
//     let paused = false;                   const state = {
//     // The poll, while one runs.            paused: false,
//     let timer = null;                       // The poll, while one runs.
//     let root = document.body;               timer: null,
//                                             root: undefined, // given its first value further down, where it was declared
//                                           };
//                                           state.root = document.body;
//
// A first value goes into the object when it is written out, asks nothing of the
// page or of another name, and stands on one plain line; its `//` comments go with
// it. Any other first value stays where it was, as an assignment, so it is worked
// out at the same moment as today.
//
// Refused, each with the line: a script that says `eval` or `with`; a name the
// object would hide or that would hide it; a let declared with others, twice, or
// not as `let name` at the wrapper's indent; a name that is called (`x()` would
// hand the object over as `this`), stands in a `{ x }` shorthand, is given a
// function without a name, or is written by a pattern or the head of a loop; and
// a later let that code running while the script loads could reach between the
// object and its own line, where today it is an error and afterwards would not be.
// Pure: text in, text out, or a refusal with every reason.

import { readFixed } from './browser-inner-fixed.mjs';
import { lineOf } from './browser-inner-judge.mjs';
import { readWrapper, SECTION_TITLE } from './browser-inner-plan.mjs';
import { loadUseTest, Refusal } from './extract-plan.mjs';
import { referenceReasons } from './state-plan.mjs';
import { commentMentions, readForms, readReferences, tokenRanges } from './state-refs.mjs';
import { statePattern } from './state-undo.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
export const KEPT_NOTE = 'given its first value further down, where it was declared';

/** @param {string} indent @param {string} name @returns {RegExp} a line of the wrapper that starts by assigning `name` */
export function keptLine(indent, name) {
  return new RegExp(`^${indent}${name.replace(/[$]/g, '\\$&')}(?=\\s*=(?![=>]))`, 'gm');
}

// Every name inside the left side of `[a, b] = ...` and `({ a } = ...)`, and in the head of `for (a of ...)`.
function patternTargets(tree, { K }) {
  const ends = new Set();
  const collect = (node) => { if (node.kind === K.Identifier) ends.add(node.end); else node.forEachChild(collect); };
  const walk = (node) => {
    const pattern = node.kind === K.BinaryExpression && node.operatorToken.kind === K.EqualsToken
      && (node.left.kind === K.ArrayLiteralExpression || node.left.kind === K.ObjectLiteralExpression);
    if (pattern) collect(node.left);
    if ((node.kind === K.ForOfStatement || node.kind === K.ForInStatement) && node.initializer.kind !== K.VariableDeclarationList) collect(node.initializer);
    node.forEachChild(walk);
  };
  walk(tree);
  return ends;
}

// Whether a statement runs a function while it runs itself: a call, `new`, a class (its static parts), or a step the
// language takes through a function of the value (spread, `for of`, a template that joins values). A statement
// that only writes functions down, `window.Name = () => { ... }`, runs none of them.
function runsCode(node, K) {
  const BODIES = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor]);
  const RUNS = new Set([K.CallExpression, K.NewExpression, K.TaggedTemplateExpression, K.ClassDeclaration, K.ClassExpression, K.AwaitExpression, K.YieldExpression,
    K.SpreadElement, K.SpreadAssignment, K.ForOfStatement, K.ForInStatement, K.TemplateExpression, K.ArrayBindingPattern]);
  let found = false;
  const walk = (at) => {
    if (found || BODIES.has(at.kind)) return;
    if (RUNS.has(at.kind)) { found = true; return; }
    at.forEachChild(walk);
  };
  walk(node);
  return found;
}

// One `let`: how it is written, and whether its first value can go into the object or stays as an assignment in its place.
function readLet({ shell, text, starts, lines, record, forms, K, top }) {
  const node = shell.inside[record.index];
  const declaration = node.declarationList.declarations[0];
  const line = shell.open + record.line[0];
  const start = node.getStart(shell.tree);
  const nameEnd = declaration.name.end;
  const written = `${shell.indent}let ${declaration.name.text}`;
  if (start !== starts[line] + shell.indent.length || text.slice(starts[line], nameEnd) !== written) {
    return { reason: 'is not written as `let name` at the indent of the wrapper' };
  }
  if (forms.named.has(nameEnd)) return { reason: 'holds a function without a name of its own: it takes the name of the variable, and would lose it' };
  const init = declaration.initializer;
  const fixed = init ? readFixed(K, node) : { reasons: [], reads: [] };
  const plainAbove = lines.slice(top, line).every((above) => above.trimStart().startsWith('//'));
  if (fixed.reasons.length === 0 && fixed.reads.length === 0 && record.line[0] === record.line[1] && plainAbove) {
    const rest = text.slice(init ? init.end : nameEnd, starts[line] + lines[line].length);
    const eq = init ? text.slice(nameEnd, init.getStart(shell.tree)) : '';
    if (rest.startsWith(';') && /^\s*(?:\/\/.*)?$/.test(rest.slice(1)) && (!init || /^\s*=\s*$/.test(eq))) {
      return { start, nameEnd, moved: { eq, value: init ? text.slice(init.getStart(shell.tree), init.end) : null, trail: rest.slice(1) } };
    }
  }
  if (!init) return { reason: 'has no first value and is not one plain line under `//` comments: there is nothing to leave in its place' };
  return { start, nameEnd, moved: null };
}

// The lets asked for, each read; `reasons` gets why one cannot be a property.
function readLets({ shell, text, starts, lines, source, object, names, forms, K, topOf, reasons }) {
  const chosen = [];
  for (const name of new Set(names)) {
    const record = shell.bindings.get(name)?.record;
    if (!record) { reasons.push({ name, text: `${name} is not declared in the wrapper of ${source}` }); continue; }
    const fail = (why) => reasons.push({ name, text: `${name} (${source}:${lineOf(shell, record)}) ${why}` });
    if (record.kind !== 'let') { fail(`is a ${record.kind}, not a let`); continue; }
    if (record.names.length !== 1) { fail('is declared together with other names'); continue; }
    if (shell.twice.has(name)) { fail('is declared twice'); continue; }
    if (record.sharesLine) { fail('shares a line with another statement'); continue; }
    if (statePattern(object, name).test(text)) fail(`cannot become ${object}.${name}: the script has that text already, the rewrite could not be told apart from it`);
    const read = readLet({ shell, text, starts, lines, record, forms, K, top: shell.open + topOf(record) });
    if (read.reason) { fail(read.reason); continue; }
    if (!read.moved && keptLine(shell.indent, name).test(text)) fail('is assigned by a statement that starts a line of the wrapper: undone, it could not be told apart from the declaration');
    chosen.push({ name, record, ...read });
  }
  return chosen.sort((a, b) => a.record.index - b.record.index);
}

// What the places a name is used say against the rewrite, each with the let it is about.
function useReasons({ shell, text, starts, source, object, chosen, refs, forms, parser }) {
  const names = new Set(chosen.map((entry) => entry.name));
  const records = shell.records.map((record) => ({ names: record.names, line: [lineOf(shell, record)] }));
  const said = referenceReasons({ refs, forms, text, starts, source, object, names, propOf: new Map([...names].map((name) => [name, name])),
    statements: shell.inside, records, parser });
  const reasons = [...new Set(said)].map((reason) => {
    // A local that hides a let is the let to leave alone; a local called like the object asks for another name for the object.
    const hiding = / called (.+)$/.exec(reason)?.[1].split(', ') ?? null;
    const first = /^([A-Za-z_$][\w$]*) \(/.exec(reason)?.[1];
    return { name: hiding ? hiding.find((name) => names.has(name)) ?? null : names.has(first) ? first : null, text: reason };
  });
  const patterned = patternTargets(shell.tree, parser);
  for (const ref of refs.filter((entry) => patterned.has(entry.end))) {
    reasons.push({ name: ref.name, text: `${ref.name} (${source}:${lineAt(starts, ref.start) + 1}) stands in a pattern or in the head of a loop that gives it a value: write a plain assignment first` });
  }
  // The object stands where the first let stood, so a use above that line fails as it does today. A later let
  // used to fail until its own line: nothing that runs in between may be able to reach it.
  const anchor = chosen[0];
  for (const later of chosen.slice(1)) {
    const usesAtLoad = loadUseTest({ records: shell.records, seeds: [later.record], names: [later.name], bindings: shell.bindings });
    const touches = (record) => Boolean(record.uses.get(later.name)?.eager) || (usesAtLoad(record) && runsCode(shell.inside[record.index], parser.K));
    const early = shell.records.find((record) => record.index > anchor.record.index && record.index < later.record.index && touches(record));
    if (!early) continue;
    reasons.push({ name: later.name, text: `${later.name} (${source}:${lineOf(shell, later.record)}): line ${lineOf(shell, early)} runs while the script loads and can reach it before its declaration. `
      + `Today that stops the script with an error, afterwards it would silently read ${later.moved ? 'its first value' : 'nothing'}: leave it a let, or give it an object of its own (--object)` });
  }
  return reasons;
}

/**
 * @param {object} job
 * @param {string} job.text the script @param {any} job.parser from parser.mjs @param {string} job.source its repo-relative path
 * @param {string} [job.object] the name of the object @param {string[]} job.names the lets of the wrapper that become its properties
 * @returns {{ newSource: string, object: string, names: string[], kept: string[], indent: string,
 *   counts: Record<string, { found: number, moved: boolean, mentions: number }>, glue: { at: number, lines: string[] },
 *   removed: { line: number, lines: string[], name: string, eq: string, value: string | null, trail: string }[] }}
 *   `names` in the order they are declared; `kept` the ones whose first value stays where the `let` stood. `glue.at` is the
 *   0-based line of the object in the new text, `removed` the declarations that left with the 0-based line of the old text each
 *   block started on. `counts`: per let the uses in code, whether its first value left, and the comments that name it (renamed too).
 *   Throws a Refusal with every reason; its last line names the lets to leave out when that alone would do.
 */
export function planLets({ text, parser, source, object = 'state', names }) {
  const shell = readWrapper(text, source, parser);
  if (shell.problems.length) throw new Refusal(shell.problems);
  const whole = [];
  if (!names.length) whole.push(`name at least one let of ${source}`);
  if (!IDENTIFIER.test(object) || object in globalThis) whole.push(`${object} cannot be the name of the object`);
  if (shell.bindings.has(object)) whole.push(`the wrapper of ${source} already declares ${object}: give the object another name (--object)`);
  else if (shell.records.some((record) => record.uses.has(object))) whole.push(`${source} already uses a name ${object} that its wrapper does not declare: give the object another name (--object)`);
  for (const word of ['eval', 'with']) if (shell.words.has(word)) whole.push(`${source} says \`${word}\`, which reads names nobody can list: the script stays as it is`);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const forms = readForms(shell.tree, parser);
  // A let takes the comment above it along, but not the title of the section it happened to open.
  const topOf = (record) => { let top = record.range[0]; while (top < record.line[0] && SECTION_TITLE.test(lines[shell.open + top])) top += 1; return top; };
  const reasons = [];
  const chosen = readLets({ shell, text, starts, lines, source, object, names, forms, K: parser.K, topOf, reasons });
  const refs = readReferences(shell.tree, parser, new Set(chosen.map((entry) => entry.name)), object, shell.inside);
  reasons.push(...useReasons({ shell, text, starts, source, object, chosen, refs, forms, parser }));
  if (whole.length || reasons.length) {
    const blamed = [...new Set(reasons.map((reason) => reason.name))];
    const rest = new Set(names).size - blamed.length;
    const hint = whole.length === 0 && !blamed.includes(null) && rest > 0 ? [`to rewrite the other ${rest} and leave these as they are: --not ${blamed.join(',')}`] : [];
    throw new Refusal([...new Set([...whole, ...reasons.map((reason) => reason.text)]), ...hint]);
  }

  // The names become properties, from the end of the text backwards so earlier places stay true. A comment that
  // names a variable follows it, so no comment is left talking about a name the script no longer has.
  const edits = refs.map((ref) => ({ start: ref.start, end: ref.end, put: `${object}.${ref.name}` }));
  const ranges = tokenRanges(shell.tree, parser);
  const mentions = new Map(chosen.map((entry) => [entry.name, commentMentions(text, ranges, entry.name)]));
  for (const [name, places] of mentions) for (const at of places) edits.push({ start: at, end: at + name.length, put: `${object}.${name}` });
  for (const entry of chosen) if (!entry.moved) edits.push({ start: entry.start, end: entry.nameEnd, put: `${object}.${entry.name}` });
  let renamed = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) renamed = renamed.slice(0, edit.start) + edit.put + renamed.slice(edit.end);
  const renamedLines = renamed.split('\n');

  // The object: one row per let in the order they were declared, a value that left with its comments as they read now.
  const anchor = chosen[0];
  const glue = [`${shell.indent}const ${object} = {`];
  const gone = new Set();
  const removed = [];
  for (const entry of chosen) {
    if (!entry.moved) { glue.push(`${shell.indent}  ${entry.name}: undefined, // ${KEPT_NOTE}`); continue; }
    const [first, code, last] = [shell.open + topOf(entry.record), shell.open + entry.record.line[0], shell.open + entry.record.range[1]];
    for (let line = first; line <= last; line += 1) gone.add(line);
    removed.push({ line: first, lines: lines.slice(first, last + 1), name: entry.name, ...entry.moved });
    const written = `${shell.indent}let ${entry.name}${entry.moved.value === null ? '' : `${entry.moved.eq}${entry.moved.value}`};`;
    glue.push(...renamedLines.slice(first, code).map((comment) => `  ${comment}`), `${shell.indent}  ${entry.name}: ${entry.moved.value ?? 'undefined'},${renamedLines[code].slice(written.length)}`);
  }
  glue.push(`${shell.indent}};`);
  if (!anchor.moved || lines[shell.open + anchor.record.range[1]].trim() === '') glue.push('');
  const kept = [];
  let glueAt = -1;
  renamedLines.forEach((line, index) => {
    if (index === shell.open + topOf(anchor.record)) { glueAt = kept.length; kept.push(...glue); }
    if (!gone.has(index)) kept.push(line);
  });
  const counts = Object.fromEntries(chosen.map((entry) => [entry.name,
    { found: refs.filter((ref) => ref.name === entry.name).length, moved: Boolean(entry.moved), mentions: mentions.get(entry.name).length }]));
  return { newSource: kept.join('\n'), object, names: chosen.map((entry) => entry.name), kept: chosen.filter((entry) => !entry.moved).map((entry) => entry.name),
    indent: shell.indent, counts, glue: { at: glueAt, lines: glue }, removed };
}
