// Plans taking functions out of the body of a factory (a function that builds an object out of
// functions declared inside it) into a module of their own. The moved text is copied unchanged
// into a function of the new module that takes, as one argument, what the functions used from
// the factory, and gives the functions back; the factory calls it where they stood.
//
//   before, in the factory                     after, in the factory
//     function a() { ... which() ... }           const { a } = makeSteps({ runner, which });
//
//   the new module
//     function makeSteps({ runner, which }) {
//       function a() { ... which() ... }
//       return { a };
//     }
//
// No rule here asks for a judgement: a function moves when everything it takes from outside itself
// is a function moved with it, an argument of the factory nobody assigns again, a function or a
// constant of the factory's body, a module the file requires, or a name no file declares.
// Pure: text in, text out, or a refusal.

import path from 'node:path';

import { analyze, FILE_BOUND } from './analyze.mjs';
import { MAX_LINES, placeRequire, Refusal, wrapComment } from './extract-plan.mjs';
import { requireLines, wrapNames } from './module-requires.mjs';
import { requireEdits } from './require-edits.mjs';
import { lineAt, lineStarts } from './top-level.mjs';

const HANDED_OVER = new Set(['function', 'const', 'class', 'require']);
const indent = (lines) => lines.map((line) => (line ? `  ${line}` : line));

function paramNames(K, name, out = []) {
  if (name.kind === K.Identifier) out.push(name.text);
  else name.forEachChild((element) => { if (element.kind === K.BindingElement) paramNames(K, element.name, out); });
  return out;
}

/**
 * The body of a factory read as if it were a file of its own: one indent less, line for line.
 * @param {string} text the file @param {any} parser from parser.mjs @param {string} source repo-relative @param {string} factory
 * @returns {{ open: number, close: number, params: string[], bodyText: string }} `open` and `close` are the 0-based
 *   lines of the factory's `{` and `}`; line n (1-based) of `bodyText` is line `open + n` (0-based) of the file
 */
export function readFactory(text, parser, source, factory) {
  const { K } = parser;
  const tree = parser.parse(text, source);
  const node = tree.statements.find((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === factory);
  if (!node?.body) throw new Refusal([`${factory} is not a function declared at the top level of ${source}`]);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const first = lineAt(starts, node.getStart(tree));
  const open = lineAt(starts, node.body.getStart(tree));
  const close = lineAt(starts, node.end - 1);
  if (!lines[first].startsWith(`function ${factory}(`)) throw new Refusal([`${factory} (${source}:${first + 1}) is not a plain function: an async one or a generator runs its body another way`]);
  if (!lines[open].endsWith('{') || lines[close] !== '}' || close <= open) {
    throw new Refusal([`${factory} (${source}:${first + 1}) must open with { at the end of a line and close with } on a line of its own`]);
  }
  const body = lines.slice(open + 1, close).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
  return { open, close, params: node.parameters.flatMap((parameter) => paramNames(K, parameter.name)), bodyText: `${body.join('\n')}\n` };
}

// Why a function cannot leave the factory, read off what it takes from outside itself.
function sortUses({ record, label, inner, file, shell, movedNames, source, factory, passed, needed }) {
  const reasons = [];
  const params = new Set(shell.params);
  for (const name of record.uses.keys()) {
    if (movedNames.includes(name)) continue;
    const own = inner.bindings.get(name);
    if (own) {
      if (HANDED_OVER.has(own.kind) && !own.reassigned) passed.add(name);
      else {
        reasons.push(`${label} uses ${name}, a variable of ${factory} that can be assigned again: a copy handed over would not follow it. `
          + `Leave the function where it is, or first keep what ${factory} remembers in one object`);
      }
    } else if (params.has(name)) {
      if (inner.records.some((other) => (other.uses.get(name)?.write ?? 0) > 0)) reasons.push(`${label} uses the argument ${name}, which ${factory} assigns again`);
      else passed.add(name);
    } else if (FILE_BOUND.has(name)) reasons.push(`${label} uses ${name}, which would mean another file there`);
    else if (name === 'eval') reasons.push(`${label} uses eval, which reads names nobody can list`);
    else if (file.bindings.has(name)) {
      const top = file.bindings.get(name);
      if (top.kind === 'require') needed.add(name);
      else {
        reasons.push(`${label} uses ${name}, declared in ${source} itself (line ${top.record.line[0]}): the new module would have to require `
          + `${source} back. Take ${name} out with extract first`);
      }
    }
  }
  return reasons;
}

// Where the call of the new module can stand in the factory: after every constant it hands over exists, and before the
// first statement that could reach a moved function while the factory itself runs.
function placeCall({ inner, moved, movedSet, passed, factory, source, real }) {
  const reaches = new Set(moved);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of inner.records) {
      if (reaches.has(record)) continue;
      if ([...record.uses.keys()].some((name) => inner.bindings.has(name) && reaches.has(inner.bindings.get(name).record))) { reaches.add(record); grew = true; }
    }
  }
  const user = inner.records.find((record) => !movedSet.has(record) && record.kind !== 'function' && reaches.has(record));
  const before = user ? user.index : inner.records.length;
  const late = [...passed].map((name) => inner.bindings.get(name)).filter((binding) => binding && binding.kind !== 'function')
    .reduce((last, binding) => (!last || binding.record.index > last.record.index ? binding : last), null);
  const after = late ? late.record.index : -1;
  if (after >= before) {
    return { reason: `${late.name} (${source}:${real(late.record.line[0])}) is declared after line ${real(user.line[0])}, where ${factory} may already use a moved function: `
      + 'the functions would have to be handed over before what they need exists' };
  }
  return { anchor: Math.max(Math.min(moved[0].index, before), after + 1) };
}

/**
 * @param {object} job
 * @param {string} job.text the old file @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative path of the old file @param {string} job.target repo-relative path of the new module
 * @param {string} job.about one sentence saying what the new file does: its first comment
 * @param {string} job.factory the top-level function whose body the functions leave
 * @param {string} job.make the name of the function the new module gives
 * @param {string[]} job.names functions declared in the factory's body
 * @param {(spec: string, from: string, to: string) => any} job.rewrite from module-requires.mjs
 * @param {Set<string>} [job.protectedNames] @param {number[][]} [job.protectedStretches] @param {Set<string>} [job.ownModules] as in extract-plan.mjs
 * @param {number} [job.maxLines]
 * @returns {{ newSource: string, moduleText: string, moved: string[], returned: string[], passed: string[], ranges: number[][], requires: any[],
 *   glue: { sourceAt: number, sourceLines: string[], bodyAt: number, bodyLines: string[], moduleLines: number[],
 *   edits: { at: number, oldLines: string[], newLines: string[] }[] } }} `ranges` are 1-based lines of the old file; `sourceAt`,
 *   `bodyAt` and `at` are 0-based lines of the new text
 */
export function planInner(job) {
  const { text, parser, source, target, about, factory, make, names, rewrite,
    protectedNames = new Set(), protectedStretches = [], ownModules = new Set(), maxLines = MAX_LINES } = job;
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`]);
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file does (--about): it becomes its first comment']);
  if (!/^[A-Za-z_]\w*$/.test(make ?? '')) throw new Refusal(['--make needs the name of the function the new module gives, for example makeInstallSteps']);
  if (new RegExp(`\\b${make}\\b`).test(text)) throw new Refusal([`${make} is a word ${source} already uses: give the new function another name`]);
  if (protectedNames.has(factory)) throw new Refusal([`${factory} is part of the security prelude and stays as it is`]);
  const file = analyze(text, parser, source);
  const shell = readFactory(text, parser, source, factory);
  const inner = analyze(shell.bodyText, parser, source, { registrations: [], afterLoad: [] });
  const real = (line) => shell.open + line + 1;
  const declared = (name) => inner.records.filter((record) => record.names.includes(name));
  const wrong = names.filter((name) => declared(name).length !== 1 || declared(name)[0].kind !== 'function');
  if (wrong.length) throw new Refusal(wrong.map((name) => `${name} is not a function declared once in the body of ${factory}`));

  const moved = [...new Set(names.map((name) => inner.bindings.get(name).record))].sort((a, b) => a.index - b.index);
  const movedSet = new Set(moved);
  const movedNames = moved.flatMap((record) => record.names);
  const staying = inner.records.filter((record) => !movedSet.has(record));
  const passed = new Set();
  const needed = new Set();
  const reasons = [];
  for (const record of moved) {
    const label = `${record.names[0]} (${source}:${real(record.line[0])})`;
    if (record.sharesLine) reasons.push(`${label} shares a line with another statement`);
    if (inner.bindings.get(record.names[0]).reassigned) reasons.push(`${label} is assigned again in ${factory}: the factory would keep a copy that never changes`);
    reasons.push(...sortUses({ record, label, inner, file, shell, movedNames, source, factory, passed, needed }));
  }
  const returned = movedNames.filter((name) => staying.some((record) => record.uses.has(name)));
  if (returned.length === 0) reasons.push(`nothing left in ${factory} uses ${movedNames.join(', ')}: delete dead code instead of moving it`);
  if (reasons.length) throw new Refusal(reasons);

  const call = placeCall({ inner, moved, movedSet, passed, factory, source, real });
  if (call.reason) throw new Refusal([call.reason]);
  const required = requireLines([...needed], file.bindings, (spec) => rewrite(spec, source, target));
  const place = placeRequire({ records: file.records, moved: [file.bindings.get(factory).record], movedSet: new Set(), movedNames: [factory],
    bindings: file.bindings, modules: required.modules, source, stretches: protectedStretches });
  if (place.reason) throw new Refusal([place.reason]);

  // The old file: the functions go, the call of the new module stands in the factory, its require above.
  const lines = text.split('\n');
  const blank = (line) => line !== undefined && line.trim() === '';
  const rangeLines = (record) => lines.slice(shell.open + record.range[0], shell.open + record.range[1] + 1);
  const order = [...shell.params.filter((name) => passed.has(name)), ...inner.records.flatMap((record) => record.names).filter((name) => passed.has(name))];
  const handed = order.length ? `{ ${order.join(', ')} }` : '';
  const anchorRecord = inner.records[call.anchor];
  const bodyGlue = indent(wrapNames(returned, 'const {', `} = ${make}(${handed});`));
  if (anchorRecord && (!movedSet.has(anchorRecord) || blank(rangeLines(anchorRecord).at(-1)))) bodyGlue.push('');
  const fromSource = path.posix.relative(path.posix.dirname(source), target);
  const sourceGlue = [`const { ${make} } = require('${fromSource.startsWith('.') ? fromSource : `./${fromSource}`}');`, ''];
  const bodyLine = anchorRecord ? shell.open + anchorRecord.range[0] : shell.close;
  const topLine = file.records[place.anchor].range[0] - 1;
  const moving = new Set(moved.flatMap((record) => Array.from({ length: record.range[1] - record.range[0] + 1 }, (_, i) => shell.open + record.range[0] + i)));
  const build = (edits) => {
    const gone = new Set(moving);
    for (const edit of edits.values()) for (let i = 0; i < edit.count; i += 1) gone.add(edit.first + i);
    const kept = [];
    const at = {};
    lines.forEach((line, index) => {
      if (index === topLine) { at.source = kept.length; kept.push(...sourceGlue); }
      if (index === bodyLine) { at.body = kept.length; kept.push(...bodyGlue); }
      const edit = edits.get(index);
      if (edit) { edit.at = kept.length; kept.push(...edit.newLines); }
      if (!gone.has(index)) kept.push(line);
    });
    return { text: kept.join('\n'), at };
  };
  // Required names only the moved functions used: the old file stops asking for them. Read off the file as it will be.
  const left = analyze(build(new Map()).text, parser, source);
  const orphaned = new Set([...needed].filter((name) => !left.records.some((record) => record !== left.bindings.get(name).record && record.uses.has(name))));
  const requires = required.modules.map((module) => ({ record: file.records[module.index], ownModule: ownModules.has(module.file), builtin: module.kind === 'builtin' }));
  const edits = new Map(requireEdits({ text, starts: lineStarts(text), requires, orphaned })
    .map((edit) => [edit.first, { ...edit, oldLines: lines.slice(edit.first, edit.first + edit.count) }]));
  const built = build(edits);

  // The new module: first comment, requires, the function that takes what the moved text needs, the moved text, what it gives back.
  const strict = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/.test(text);
  const body = [...(strict ? ["'use strict';"] : []), ...wrapComment(about), '', ...required.lines];
  if (required.lines.length) body.push('');
  body.push(...(order.length ? wrapNames(order, `function ${make}({`, '}) {') : [`function ${make}() {`]));
  const moduleGlue = body.map((_, index) => index);
  const glueLine = (line) => { moduleGlue.push(body.length); body.push(line); };
  moved.forEach((record, i) => {
    const apart = i > 0 && record.range[0] !== moved[i - 1].range[1] + 1;
    if (apart && !blank(body.at(-1))) glueLine('');
    body.push(...rangeLines(record));
  });
  if (!blank(body.at(-1))) glueLine('');
  for (const line of [...indent(wrapNames(returned, 'return {', '};')), '}', '', `module.exports = { ${make} };`]) glueLine(line);
  if (body.length > maxLines) {
    throw new Refusal([`${target} would be ${body.length} lines, the limit for a new file is ${maxLines}: move fewer functions per file, split by what they do`]);
  }
  return {
    newSource: built.text, moduleText: `${body.join('\n')}\n`, moved: movedNames, returned, passed: order,
    ranges: moved.map((record) => [real(record.range[0]), real(record.range[1])]), requires: required.modules,
    glue: { sourceAt: built.at.source, sourceLines: sourceGlue, bodyAt: built.at.body, bodyLines: bodyGlue, moduleLines: moduleGlue,
      edits: [...edits.values()].sort((a, b) => a.first - b.first).map(({ at, oldLines, newLines }) => ({ at, oldLines, newLines })) },
  };
}
