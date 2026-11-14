// Plans turning what a factory remembers (the `let`s declared straight in its body) into the
// properties of one constant object declared where the first of them stood. Every read and write
// of `name` in the factory becomes `object.name`; who writes, when, and in which order stays.
//
//   before, in the factory                 after, in the factory
//     let calls = 0;                         const memory = {
//     let last;                                calls: 0,
//     function count() { calls += 1; }         last: undefined,
//                                            };
//                                            function count() { memory.calls += 1; }
//
// The object can then be handed to functions that leave the factory (`inner`), which a `let`
// cannot. Which name means the factory's own variable is read off the scopes (scope-uses.mjs),
// not off the text: a parameter or a local of the same name is another variable and stays.
// Pure: text in, text out, or a refusal with every reason.

import { analyze } from './analyze.mjs';
import { Refusal } from './extract-plan.mjs';
import { unprovenCalled } from './gather-called.mjs';
import { AFTER_SHORT, bodyAssignment } from './gather-undo.mjs';
import { readFactory } from './inner-plan.mjs';
import { PLAIN_GLOBALS } from './load-time-calls.mjs';
import { readForms, readReferences } from './state-refs.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
export const GATHER_KEPT_NOTE = 'given its first value further down, where it was declared';

// One `let` of the body: how it is written, and whether its first value can stand in the object (it needs nothing
// but the language, and is on one plain line) or stays as an assignment on the line where the `let` stood.
function readDeclaration({ text, tree, lineStart, lineText, record, node, forms }) {
  const declaration = node.declarationList.declarations[0];
  const start = node.getStart(tree);
  if (start !== lineStart + 2 || text.slice(start, declaration.name.getStart(tree)) !== 'let ') {
    return { reason: 'is not written as `let name` at the start of a line of the body' };
  }
  const nameEnd = declaration.name.end;
  if (forms.named.has(nameEnd)) return { reason: 'holds a function without a name of its own: it takes the name of the variable, and would lose it' };
  const init = declaration.initializer;
  const plain = !record.loadTime && [...record.uses.keys()].every((name) => PLAIN_GLOBALS.has(name));
  if (plain && record.line[0] === record.line[1]) {
    const rest = text.slice(init ? init.end : nameEnd, lineStart + lineText.length);
    const eq = init ? text.slice(nameEnd, init.getStart(tree)) : '';
    if (rest.startsWith(';') && /^\s*(?:\/\/.*)?$/.test(rest.slice(1)) && (!init || /^\s*=\s*$/.test(eq))) {
      return { start, nameEnd, moved: { eq, value: init ? text.slice(init.getStart(tree), init.end) : null, trail: rest.slice(1) } };
    }
  }
  if (!init) return { reason: 'has no first value and is not on one plain line: there is nothing to leave in its place' };
  return { start, nameEnd, moved: null };
}

// Why a use cannot become `object.name`, and how it is written when it can.
function readUses({ refs, forms, text, starts, source, object }) {
  const reasons = [];
  const edits = [];
  for (const ref of refs) {
    const where = `${source}:${lineAt(starts, ref.start) + 1}`;
    const target = `${object}.${ref.name}`;
    if (text.slice(ref.start, ref.end) !== ref.name) reasons.push(`${ref.name} (${where}) is not written plainly`);
    if (forms.named.has(ref.end)) reasons.push(`${ref.name} (${where}) is given a function without a name of its own: it takes the name of the variable, and would lose it`);
    if (forms.deleted.has(ref.end)) reasons.push(`${ref.name} (${where}) is the operand of delete`);
    const shorthand = forms.shorthand.has(ref.end);
    const closes = new RegExp(`^${AFTER_SHORT}`).test(text.slice(ref.end, ref.end + 2000));
    if (shorthand && !closes) {
      reasons.push(`${where}: something stands between the short \`{ ${ref.name} }\` and the comma, the } or the first value after it: undone, it could not be found again`);
    }
    // `name: name` written out reads, rewritten, like a `{ name }` written out: the plan says which were long, and the proof puts them back.
    const long = !shorthand && closes && new RegExp(`(?<![\\w$.])${ref.name.replace(/[$]/g, '\\$&')}: $`).test(text.slice(0, ref.start));
    edits.push({ start: ref.start, end: ref.end, put: shorthand ? `${ref.name}: ${target}` : target, written: shorthand || long, long });
  }
  return { reasons, edits };
}

/**
 * @param {object} job
 * @param {string} job.text the file @param {any} job.parser from parser.mjs @param {string} job.source repo-relative path
 * @param {string} job.factory the top-level function whose body holds the variables
 * @param {string} job.object the name of the object
 * @param {string[]} [job.names] the variables; every `let` and `var` of the body when left out
 * @param {Set<string>} [job.protectedNames] names that are never touched
 * @returns {{ newSource: string, object: string, factory: string, names: string[], kept: string[], bare: string[], long: number[],
 *   left: { name: string, why: string }[],
 *   counts: Record<string, { found: number, shorthand: number, moved: boolean }>, between: number[], glue: { at: number, lines: string[] },
 *   removed: { line: number, lines: string[], name: string, eq: string, value: string | null, trail: string }[] }}
 *   `glue.at` is the 0-based line of the object in the new text; `removed` are the declarations that left, with the
 *   1-based line of the old file their block started on; `kept` the variables still given their first value where
 *   the `let` stood, `bare` the ones declared without one; `between` the 1-based lines of the statements that run
 *   between the first `let` and the last and call something; `long` which of the properties written out, counted from the top of the
 *   new text, were `name: name` before; `left` the called variables that stay a `let` because they are not proven (gather-called.mjs)
 */
export function planGather(job) {
  const { text, parser, source, factory, object, protectedNames = new Set() } = job;
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`]);
  if (!IDENTIFIER.test(object ?? '') || object in globalThis) throw new Refusal([`${object} cannot be the name of the object`]);
  if (new RegExp(`(?<![\\w$])${object.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(text)) {
    throw new Refusal([`${object} is a word ${source} already has: the rewrite could not be told apart from it, give the object another name`]);
  }
  if (protectedNames.has(factory)) throw new Refusal([`${factory} is part of the security prelude and stays as it is`]);
  const shell = readFactory(text, parser, source, factory);
  const inner = analyze(shell.bodyText, parser, source, { registrations: [], afterLoad: [] });
  const tree = parser.parse(text, source);
  const { K, NodeFlags } = parser;
  const node = tree.statements.find((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === factory);
  const statements = node.body.statements.filter((statement) => (statement.flags & NodeFlags.Reparsed) === 0);
  if (statements.length !== inner.records.length) throw new Error(`${factory}: the body read alone has ${inner.records.length} statements, the file has ${statements.length}`);
  const real = (line) => shell.open + line + 1;
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const forms = readForms(tree, parser);

  const reasons = [];
  if (forms.withStatement) reasons.push(`${source} has a with statement, which hides where a name comes from`);
  if (inner.records.some((record) => record.uses.has('eval'))) reasons.push(`${factory} calls eval, which could name a variable in text no tool can see`);
  const wanted = job.names?.length ? job.names : inner.records.filter((record) => record.kind === 'let' || record.kind === 'var').flatMap((record) => record.names);
  if (wanted.length === 0) reasons.push(`${factory} declares no let in its body: there is nothing to gather`);
  if (new Set(wanted).size !== wanted.length) reasons.push('a variable is named twice');
  const declarations = [];
  for (const name of new Set(wanted)) {
    const record = inner.bindings.get(name)?.record;
    if (!record) { reasons.push(`${name} is not declared in the body of ${factory}`); continue; }
    const fail = (why) => reasons.push(`${name} (${source}:${real(record.line[0])}) ${why}`);
    if (record.kind === 'var') {
      fail(`is a var: it exists, holding nothing, from the first line of ${factory}, and a property of an object declared further down does not. Make it a let by hand first`);
      continue;
    }
    if (record.kind !== 'let') { fail(`is a ${record.kind}, not a let`); continue; }
    const statement = statements[record.index];
    if (record.names.length !== 1 || statement.declarationList.declarations[0].name.kind !== K.Identifier) { fail('is declared together with other names'); continue; }
    if (inner.records.filter((other) => other.names.includes(name)).length > 1) { fail('is declared twice'); continue; }
    if (record.sharesLine) { fail('shares a line with another statement'); continue; }
    const at = real(record.line[0]) - 1;
    const read = readDeclaration({ text, tree, lineStart: starts[at], lineText: lines[at], record, node: statement, forms });
    if (read.reason) { fail(read.reason); continue; }
    if (!read.moved && bodyAssignment(name).test(text)) fail(`is assigned by a statement that starts a line of a body: undone, it could not be told apart from the declaration`);
    declarations.push({ name, record, ...read });
  }
  declarations.sort((a, b) => a.record.index - b.record.index);
  const refs = readReferences(tree, parser, new Set(declarations.map((entry) => entry.name)), object, statements);
  // A variable that is called becomes a property only when every value it is given ignores `this`. Named, it is refused
  // with the reason; when every let is meant, it stays a let and the others are gathered.
  const calledAt = new Map();
  for (const ref of refs) if (forms.called.has(ref.end) && !calledAt.has(ref.name)) calledAt.set(ref.name, ref.start);
  const firstValues = new Map(declarations.filter((entry) => calledAt.has(entry.name))
    .map((entry) => [entry.name, statements[entry.record.index].declarationList.declarations[0].initializer]));
  const unproven = unprovenCalled({ tree, parser, refs: refs.filter((ref) => calledAt.has(ref.name)), firstValues });
  const left = [];
  for (const [name, why] of unproven) {
    const said = `${name} (${source}:${lineAt(starts, calledAt.get(name)) + 1}) is called: as ${object}.${name}() the function would get ${object} as \`this\`, and ${why}`;
    if (job.names?.length || unproven.size === declarations.length) reasons.push(said);
    else left.push({ name, why: said });
  }
  for (const row of left) declarations.splice(declarations.findIndex((entry) => entry.name === row.name), 1);
  const uses = readUses({ refs: refs.filter((ref) => !left.some((row) => row.name === ref.name)), forms, text, starts, source, object });
  reasons.push(...uses.reasons);

  // The object stands where the first `let` stood, so a use before that line fails as it does today. A later `let`
  // used to fail until its own line: nothing that runs in between may be able to reach it.
  const reaches = (from, name) => {
    const seen = new Set([from]);
    for (const queue = [from]; queue.length;) {
      const record = queue.pop();
      if (record.uses.has(name)) return true;
      for (const used of record.uses.keys()) {
        const next = inner.bindings.get(used)?.record;
        if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    return false;
  };
  const anchor = declarations[0];
  const running = (first, last) => inner.records.filter((record) => record.index > first.index && record.index < last.index && record.kind !== 'function');
  for (const own of declarations.filter((entry) => !entry.moved && reaches(entry.record, entry.name))) {
    reasons.push(`${own.name} (${source}:${real(own.record.line[0])}): working out its first value can reach ${own.name} itself. `
      + `Today a read that early stops ${factory} with an error, afterwards it would silently read nothing: give it a plain first value by hand, or leave it out`);
  }
  for (const later of declarations.slice(1)) {
    const early = running(anchor.record, later.record).find((record) => reaches(record, later.name));
    if (early) {
      reasons.push(`${later.name} (${source}:${real(later.record.line[0])}): the statement at line ${real(early.line[0])} runs before that line and can reach it. `
        + `Today a use that early stops ${factory} with an error, afterwards it would silently read nothing: move the let up by hand, or leave it out`);
    }
  }
  if (reasons.length) throw new Refusal([...new Set(reasons)]);

  // The names become properties, from the end of the text backwards so earlier offsets stay true.
  const edits = [...uses.edits, ...declarations.filter((entry) => !entry.moved).map((entry) => ({ start: entry.start, end: entry.nameEnd, put: `${object}.${entry.name}` }))];
  let renamed = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) renamed = renamed.slice(0, edit.start) + edit.put + renamed.slice(edit.end);
  const renamedLines = renamed.split('\n');

  const rows = [];
  const gone = new Set();
  const removed = [];
  for (const entry of declarations) {
    if (!entry.moved) { rows.push(`    ${entry.name}: undefined, // ${GATHER_KEPT_NOTE}`); continue; }
    const [first, last, code] = [real(entry.record.range[0]), real(entry.record.range[1]), real(entry.record.line[0])];
    for (let line = first; line <= last; line += 1) gone.add(line - 1);
    removed.push({ line: first, lines: lines.slice(first - 1, last), name: entry.name, ...entry.moved });
    rows.push(...lines.slice(first - 1, code - 1).map((comment) => `  ${comment}`), `    ${entry.name}: ${entry.moved.value ?? 'undefined'},${entry.moved.trail}`);
  }
  const glueLines = [`  const ${object} = {`, ...rows, '  };'];
  if (anchor.moved && lines[real(anchor.record.range[1]) - 1].trim() === '') glueLines.push('');
  const kept = [];
  let glueAt = -1;
  renamedLines.forEach((line, index) => {
    if (index === real(anchor.record.range[0]) - 1) { glueAt = kept.length; kept.push(...glueLines); }
    if (!gone.has(index)) kept.push(line);
  });

  const last = declarations.at(-1);
  return {
    newSource: kept.join('\n'), object, factory, names: declarations.map((entry) => entry.name),
    kept: declarations.filter((entry) => !entry.moved).map((entry) => entry.name),
    bare: declarations.filter((entry) => entry.moved && entry.moved.value === null).map((entry) => entry.name),
    counts: Object.fromEntries(declarations.map((entry) => {
      const own = uses.edits.filter((edit) => edit.put.endsWith(`${object}.${entry.name}`));
      return [entry.name, { found: own.length, shorthand: own.filter((edit) => edit.put.includes(': ')).length, moved: Boolean(entry.moved) }];
    })),
    between: running(anchor.record, last.record).filter((record) => record.loadTime && !declarations.some((entry) => entry.record === record)).map((record) => real(record.line[0])),
    glue: { at: glueAt, lines: glueLines }, removed, left,
    long: uses.edits.filter((edit) => edit.written).sort((a, b) => a.start - b.start).flatMap((edit, index) => (edit.long ? [index] : [])),
  };
}
