// Plans turning top-level `let` variables of a CommonJS file into properties of one
// small object that lives in a module of its own: every read and write of `name`
// becomes `object.property`, so other files can share the value by `require`.
// Nothing else changes: who writes, when, and in which order. Pure: text in, text
// out, or a refusal with every reason.

import path from 'node:path';

import { loadUseTest, MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { PLAIN_GLOBALS } from './load-time-calls.mjs';
import { localNames, readForms, readReferences, topStatements } from './state-refs.mjs';
import { assignmentLine, statePattern } from './state-undo.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
export const KEPT_NOTE = 'given its first value where the engine loads';

// One `let`: how it is written, and whether its first value can live in the new module (it needs nothing from the
// file, and stands on one plain line) or stays as an assignment on the line where the `let` stood.
function readDeclaration({ text, starts, lines, record, node, sourceFile, forms }) {
  const declaration = node.declarationList.declarations[0];
  const start = node.getStart(sourceFile);
  const lineStart = starts[record.line[0] - 1];
  const nameEnd = declaration.name.end;
  if (start !== lineStart || text.slice(start, declaration.name.getStart(sourceFile)) !== 'let ') {
    return { reason: 'is not written as `let name` at the start of its line' };
  }
  if (forms.named.has(nameEnd)) return { reason: 'holds a function without a name of its own: it takes the name of the variable, and would lose it' };
  const init = declaration.initializer;
  const plain = !record.loadTime && [...record.uses.keys()].every((name) => PLAIN_GLOBALS.has(name));
  if (plain && record.line[0] === record.line[1]) {
    const rest = text.slice(init ? init.end : nameEnd, lineStart + lines[record.line[0] - 1].length);
    const eq = init ? text.slice(nameEnd, init.getStart(sourceFile)) : '';
    if (rest.startsWith(';') && /^\s*(?:\/\/.*)?$/.test(rest.slice(1)) && (!init || /^\s*=\s*$/.test(eq))) {
      return { start, nameEnd, moved: { eq, value: init ? text.slice(init.getStart(sourceFile), init.end) : null, trail: rest.slice(1) } };
    }
  }
  if (!init) return { reason: 'has no first value and is not on one plain line: there is nothing to leave in its place' };
  return { start, nameEnd, moved: null };
}

function referenceReasons({ refs, forms, text, starts, source, object, names, propOf, statements, records, parser }) {
  const reasons = [];
  const locals = new Map();
  for (const ref of refs) {
    const where = `${source}:${lineAt(starts, ref.start) + 1}`;
    const target = `${object}.${propOf.get(ref.name)}`;
    if (text.slice(ref.start, ref.end) !== ref.name) reasons.push(`${ref.name} (${where}) is not written plainly`);
    if (forms.called.has(ref.end)) reasons.push(`${ref.name} (${where}) is called: as ${target}() the function would get ${object} as \`this\``);
    if (forms.shorthand.has(ref.end)) reasons.push(`${ref.name} (${where}) stands in a { ${ref.name} } shorthand, which has no ${target} form`);
    if (forms.named.has(ref.end)) reasons.push(`${ref.name} (${where}) is given a function without a name of its own: it takes the name of the variable, and would lose it`);
    if (forms.deleted.has(ref.end)) reasons.push(`${ref.name} (${where}) is the operand of delete`);
    if (ref.hidden) reasons.push(`${where}: a local called ${object} is in scope where ${ref.name} is used`);
    if (!locals.has(ref.statement)) locals.set(ref.statement, localNames(statements[ref.statement], parser, records[ref.statement].names));
    const clash = [object, ...names].filter((name) => locals.get(ref.statement).has(name));
    if (clash.length) {
      reasons.push(`the code at ${source}:${records[ref.statement].line[0]} uses ${ref.name} and has a local, parameter or catch variable called ${clash.join(', ')}`);
    }
  }
  return reasons;
}

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {{records: any[], bindings: Map<string, any>}} job.analysis from analyze.mjs, of the same text
 * @param {any} job.sourceFile the tree of the same text
 * @param {{K: any, NodeFlags: any}} job.parser
 * @param {string} job.source repo-relative path of the old file
 * @param {string} job.target repo-relative path of the new module
 * @param {string} job.about one sentence saying what the new file holds: its first comment
 * @param {string} job.object the name of the object
 * @param {{ name: string, prop: string }[]} job.vars the variables and the property each one becomes
 * @param {Set<string>} [job.protectedNames] names that never move
 * @param {number[][]} [job.protectedStretches] runs of the old file that get no new line
 * @param {number} [job.maxLines]
 * @returns {{ newSource: string, moduleText: string, object: string, props: Record<string, string>, kept: string[],
 *   counts: Record<string, { found: number, inProtected: number, moved: boolean }>, glue: { at: number, lines: string[] },
 *   removed: { line: number, lines: string[], name: string, eq: string, value: string | null, trail: string }[] }}
 *   `glue.at` is the 0-based line of the new require in the new text; `removed` are the declarations that left, with
 *   the 1-based line of the old file their block started on.
 */
export function planState(job) {
  const { text, analysis, sourceFile, parser, source, target, about, object, vars,
    protectedNames = new Set(), protectedStretches = [], maxLines = MAX_LINES } = job;
  const { bindings, records } = analysis;
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`]);
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file holds (--about): it becomes its first comment']);
  if (!vars.length) throw new Refusal(['name at least one variable as old=property']);
  const reasons = [];
  if (!IDENTIFIER.test(object) || object in globalThis) reasons.push(`${object} cannot be the name of the object`);
  if (bindings.has(object)) reasons.push(`${source} already declares ${object}`);
  else if (records.some((record) => record.uses.has(object))) reasons.push(`${source} already uses a name ${object} it does not declare`);
  if (records.some((record) => record.uses.has('eval'))) reasons.push(`${source} calls eval, which could name a variable in text no tool can see`);
  const props = vars.map((entry) => entry.prop);
  for (const prop of props) if (!IDENTIFIER.test(prop)) reasons.push(`${prop} cannot be a property name`);
  if (new Set(props).size !== props.length || new Set(vars.map((entry) => entry.name)).size !== vars.length) reasons.push('a variable or a property is named twice');
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const statements = topStatements(sourceFile, parser);
  const forms = readForms(sourceFile, parser);
  if (forms.withStatement) reasons.push(`${source} has a with statement, which hides where a name comes from`);

  const declarations = [];
  for (const { name, prop } of vars) {
    const record = bindings.get(name)?.record;
    if (!record) { reasons.push(`${name} is not a top-level declaration of ${source}`); continue; }
    const fail = (why) => reasons.push(`${name} (${source}:${record.line[0]}) ${why}`);
    if (record.kind !== 'let') { fail(`is a ${record.kind}, not a let`); continue; }
    if (record.names.length !== 1) { fail('is declared together with other names'); continue; }
    if (records.filter((other) => other.names.includes(name)).length > 1) { fail('is declared twice'); continue; }
    if (record.sharesLine) { fail('shares a line with another statement'); continue; }
    if (protectedNames.has(name)) { fail('is part of the security prelude and stays where it is'); continue; }
    if (statePattern(object, prop).test(text)) fail(`cannot become ${object}.${prop}: the file has that text already, the rewrite could not be told apart from it`);
    if (assignmentLine(name).test(text)) fail('is assigned by a statement that starts a line: undone, it could not be told apart from the declaration');
    const read = readDeclaration({ text, starts, lines, record, node: statements[record.index], sourceFile, forms });
    if (read.reason) fail(read.reason); else declarations.push({ name, prop, record, ...read });
  }
  declarations.sort((a, b) => a.record.index - b.record.index);
  const names = new Set(declarations.map((entry) => entry.name));
  const propOf = new Map(declarations.map((entry) => [entry.name, entry.prop]));
  const refs = readReferences(sourceFile, parser, names, object);
  reasons.push(...referenceReasons({ refs, forms, text, starts, source, object, names, propOf, statements, records, parser }));

  // The require stands where the first `let` stood, so a use before that line fails as it does today. A later
  // `let` of the group used to fail until its own line: nothing that runs in between may be able to reach it.
  const anchor = declarations[0];
  for (const later of declarations.slice(1)) {
    const usesAtLoad = loadUseTest({ records, seeds: [later.record], names: [later.name], bindings });
    const early = records.find((record) => record.index > anchor.record.index && record.index < later.record.index && usesAtLoad(record));
    if (early) {
      reasons.push(`${later.name} (${source}:${later.record.line[0]}): the statement at line ${early.line[0]} runs while the file loads and can reach it `
        + 'before its declaration. Today that stops the engine with an error, afterwards it would silently read nothing: give it an object of its own');
    }
  }
  if (anchor && protectedStretches.some(([first, last]) => anchor.record.index > first && anchor.record.index <= last)) {
    reasons.push(`the new require would have to go at line ${anchor.record.range[0]} of ${source}, inside a protected stretch that is never edited`);
  }
  if (reasons.length) throw new Refusal([...new Set(reasons)]);

  // The names become properties, from the end of the text backwards so earlier offsets stay true.
  const edits = refs.map((ref) => ({ start: ref.start, end: ref.end, put: `${object}.${propOf.get(ref.name)}` }));
  for (const entry of declarations) if (!entry.moved) edits.push({ start: entry.start, end: entry.nameEnd, put: `${object}.${entry.prop}` });
  let renamed = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) renamed = renamed.slice(0, edit.start) + edit.put + renamed.slice(edit.end);
  const renamedLines = renamed.split('\n');

  const fromSource = path.posix.relative(path.posix.dirname(source), target);
  const glueLines = [`const { ${object} } = require('${fromSource.startsWith('.') ? fromSource : `./${fromSource}`}');`];
  if (anchor.moved && lines[anchor.record.range[1] - 1].trim() === '') glueLines.push('');
  const gone = new Set();
  const removed = [];
  for (const entry of declarations.filter((d) => d.moved)) {
    const [first, last] = entry.record.range;
    for (let line = first; line <= last; line += 1) gone.add(line - 1);
    removed.push({ line: first, lines: lines.slice(first - 1, last), name: entry.name, ...entry.moved });
  }
  const kept = [];
  let glueAt = -1;
  renamedLines.forEach((line, index) => {
    if (index === anchor.record.range[0] - 1) { glueAt = kept.length; kept.push(...glueLines); }
    if (!gone.has(index)) kept.push(line);
  });

  const strict = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/.test(text);
  const body = [...(strict ? ["'use strict';"] : []), ...wrapComment(about), '', `const ${object} = {`];
  for (const entry of declarations) {
    if (!entry.moved) { body.push(`  ${entry.prop}: undefined, // ${KEPT_NOTE}`); continue; }
    for (const comment of lines.slice(entry.record.range[0] - 1, entry.record.line[0] - 1)) body.push(`  ${comment}`);
    body.push(`  ${entry.prop}: ${entry.moved.value ?? 'undefined'},${entry.moved.trail}`);
  }
  body.push('};', '', `module.exports = { ${object} };`);
  if (body.length > maxLines) throw new Refusal([`${target} would be ${body.length} lines, the limit for a new file is ${maxLines}`]);

  const guarded = (record) => record.names.some((name) => protectedNames.has(name))
    || protectedStretches.some(([first, last]) => record.index >= first && record.index <= last);
  const counts = Object.fromEntries(declarations.map((entry) => {
    const own = refs.filter((ref) => ref.name === entry.name);
    return [entry.name, { found: own.length, inProtected: own.filter((ref) => guarded(records[ref.statement])).length, moved: Boolean(entry.moved) }];
  }));
  return {
    newSource: kept.join('\n'), moduleText: `${body.join('\n')}\n`, object,
    props: Object.fromEntries(declarations.map((entry) => [entry.name, entry.prop])),
    kept: declarations.filter((entry) => !entry.moved).map((entry) => entry.name),
    counts, glue: { at: glueAt, lines: glueLines }, removed,
  };
}
