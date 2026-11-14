// Plans taking function declarations out of the wrapper of a classic browser script
// (`(function () { ... })();`) into a new classic script that loads right before it.
// A function inside a wrapper is private to it, so it cannot leave as a plain move:
// the new script is a wrapper of its own that keeps the functions, text unchanged,
// and leaves exactly one name on `window`; the old script takes them back by name
// on one line.
//
//   before, in js/deck-editor.js               after, in js/deck-editor.js
//     function keyOf(e) { ... }                  const { keyOf } = window.DeckEditorKeys;
//
//   the new script, js/deck-editor/keys.js
//     (function () {
//       function keyOf(e) { ... }
//       window.DeckEditorKeys = { keyOf };
//     })();
//
// No rule here asks for a judgement. A function moves when every name it takes
// from outside itself is a function moved with it, or a name the old wrapper does
// not declare (then it is read from the page at the moment of the call, in the new
// script exactly as in the old one). It stays when it uses anything else the
// wrapper declares, when anything assigns it again, or when it says
// `arguments.callee`. A script that says `eval` or `with` is left whole.
//
// A function declaration can be called from the wrapper's first line; a `const`
// cannot. So the line that takes the functions back stands where the first moved
// function stood, or higher: above the first statement that could reach a moved
// function while the script loads, through any chain of uses.
// `this` needs no rule: the old script still calls the functions by their bare
// names, and the new script runs in the same mode (strict or not) as the old one.
// Pure: text in, text out, or a refusal.

import { headerOf, MAX_LINES } from './browser-plan.mjs';
import { Refusal } from './extract-plan.mjs';
import { wrapNames } from './module-requires.mjs';
import { lineAt, lineStarts, readTopLevel } from './top-level.mjs';

/** The two lines of a wrapper as they may be written, and as a new script writes them. */
export const OPENS = ['(function () {', '(() => {'];
export const CLOSES = ['})();', '}());'];
const STATE = new Set(['let', 'var']);
/** A comment line that opens a section of a script (`// ── Painting ──`): it names what follows it there, and stays when the function under it leaves. */
export const SECTION_TITLE = /^\s*\/\/\s*[─━═=-]{2,}/;

const real = (parser, list) => list.filter((node) => (node.flags & parser.NodeFlags.Reparsed) === 0);
const isDirective = (K, node) => node.kind === K.ExpressionStatement && node.expression.kind === K.StringLiteral;
const isStrict = (K, node) => Boolean(node) && isDirective(K, node) && node.expression.text === 'use strict';

/**
 * The name a new script leaves on `window`, read off where the script lives: js/deck-editor/keys.js gives DeckEditorKeys.
 * @param {string} source repo-relative old script @param {string} target repo-relative new script
 * @returns {string | null} null when the new script is not `<old script's name>/<job>.js` next to the old one
 */
export function windowNameOf(source, target) {
  const home = source.replace(/\.js$/, '');
  if (!target.startsWith(`${home}/`) || !/^[a-z0-9]+(?:-[a-z0-9]+)*\.js$/.test(target.slice(home.length + 1))) return null;
  const words = `${home.slice(home.lastIndexOf('/') + 1)}-${target.slice(home.length + 1, -3)}`.split('-');
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join('');
  return /^[A-Z]/.test(name) ? name : null;
}

// What the code of a function says that no list of names shows.
function wordsIn(K, node) {
  const found = new Set();
  const visit = (at) => {
    if (at.kind === K.Identifier && at.text === 'eval') found.add('eval');
    if (at.kind === K.WithStatement) found.add('with');
    if (at.kind === K.PropertyAccessExpression && at.name.text === 'callee' && at.expression.kind === K.Identifier && at.expression.text === 'arguments') found.add('arguments.callee');
    at.forEachChild(visit);
  };
  visit(node);
  return found;
}

/**
 * Reads a script that is one wrapper around all its code.
 * @param {string} text @param {string} file @param {any} parser
 * @returns {{ problems: string[], open: number, close: number, indent: string, strictFile: boolean, strictInside: boolean,
 *   records: any[], bindings: Map<string, any>, twice: Set<string>, words: Set<string> }}
 *   `open` and `close` are the 0-based lines of the wrapper's two lines; a record's line n (1-based, as top-level.mjs
 *   counts) is line `open + n` (0-based) of the file. `words`: eval, with, as the whole script says them.
 */
export function readWrapper(text, file, parser) {
  const { K } = parser;
  const none = { open: 0, close: 0, indent: '  ', strictFile: false, strictInside: false, records: [], bindings: new Map(), twice: new Set(), words: new Set() };
  if (text.includes('\r')) return { ...none, problems: [`${file} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`] };
  const tree = parser.parse(text, file);
  const statements = real(parser, tree.statements);
  if (statements.some((node) => [K.ImportDeclaration, K.ExportDeclaration, K.ExportAssignment].includes(node.kind))) {
    return { ...none, problems: [`${file} is a module: its names are its own already, take declarations out of it another way`] };
  }
  const code = statements.filter((node, index) => !(isDirective(K, node) && statements.slice(0, index).every((before) => isDirective(K, before))));
  let call = code.length === 1 && code[0].kind === K.ExpressionStatement ? code[0].expression : null;
  if (call?.kind === K.ParenthesizedExpression && call.expression.kind === K.CallExpression) call = call.expression;
  let made = call?.kind === K.CallExpression ? call.expression : null;
  while (made?.kind === K.ParenthesizedExpression) made = made.expression;
  if (!made || ![K.FunctionExpression, K.ArrowFunction].includes(made.kind) || made.body?.kind !== K.Block) {
    return { ...none, problems: [`${file} is not one wrapper function around all its code: there is no wrapper to take functions out of`] };
  }
  const problems = [];
  if (call.arguments.length || made.parameters.length) problems.push(`${file}: the wrapper is handed values when it is called: a new script would not have them`);
  if ((made.modifiers ?? []).some((modifier) => modifier.kind === K.AsyncKeyword) || made.asteriskToken || made.name) problems.push(`${file}: the wrapper is async, a generator or has a name: only a plain wrapper is read`);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const open = lineAt(starts, code[0].getStart(tree));
  const close = lineAt(starts, code[0].end - 1);
  const pairs = made.kind === K.ArrowFunction ? lines[open] === OPENS[1] && lines[close] === CLOSES[0] : lines[open] === OPENS[0] && CLOSES.includes(lines[close]);
  if (!pairs) problems.push(`${file}: the wrapper's two lines are not \`${OPENS[0]}\` and \`${CLOSES[0]}\`, each alone on its line: ${JSON.stringify(lines[open])} and ${JSON.stringify(lines[close])}`);
  if (problems.length) return { ...none, problems };

  // The wrapper's body read as a file of its own: one indent less, line for line.
  const inside = real(parser, made.body.statements);
  const body = lines.slice(open + 1, close).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
  const bodyTree = parser.parse(`${body.join('\n')}\n`, file);
  const nodes = real(parser, bodyTree.statements);
  const records = readTopLevel(bodyTree, parser);
  if (nodes.length !== inside.length) return { ...none, problems: [`${file}: the wrapper's code cannot be read line by line (${inside.length} statements in the wrapper, ${nodes.length} read)`] };
  const bindings = new Map();
  const twice = new Set();
  records.forEach((record, index) => {
    record.words = wordsIn(K, nodes[index]);
    // A constant that is a value written out, or a function under a const: the survey asks what it would free if it could go along.
    record.fixed = record.kind === 'const' && (record.selfContained || nodes[index].declarationList.declarations.every((made) => made.name.kind === K.Identifier
      && made.initializer && [K.ArrowFunction, K.FunctionExpression].includes(made.initializer.kind)));
    for (const name of record.names) {
      if (bindings.has(name)) twice.add(name);
      else bindings.set(name, { name, record, kind: record.kind });
    }
  });
  const firstLine = inside.length ? lines[lineAt(starts, inside[0].getStart(tree))] : '  ';
  return { problems, open, close, indent: /^[ \t]*/.exec(firstLine)[0], strictFile: statements.some((node) => node !== code[0] && isStrict(K, node)),
    strictInside: isStrict(K, inside[0]), records, bindings, twice, words: new Set(records.flatMap((record) => [...record.words])) };
}

// Why a function cannot leave on its own account, whatever moves with it. `kind` sorts the reasons for the survey.
function ownReasons(shell, record, label) {
  const name = record.names[0];
  const reasons = [];
  if (record.sharesLine) reasons.push({ kind: 'other', text: `${label} shares a line with another statement` });
  if (shell.twice.has(name)) reasons.push({ kind: 'other', text: `${label} is declared twice in the wrapper` });
  if (shell.records.some((other) => (other.uses.get(name)?.write ?? 0) > 0)) {
    reasons.push({ kind: 'reassigned', text: `${label} is assigned again in the script: the old script would keep a copy that never changes` });
  }
  if (record.words.has('arguments.callee')) reasons.push({ kind: 'other', text: `${label} says arguments.callee` });
  return reasons;
}

/**
 * Every function declared in the wrapper, with what keeps it there.
 * @param {ReturnType<typeof readWrapper>} shell
 * @param {{ free?: Set<string>, along?: boolean }} [options] questions asked for the survey, never for a move. `free`: kinds of wrapper
 *   names ('let', 'var', 'const', 'class', 'statement') counted as if a function could take them along; `along`: the constants that
 *   are a value written out or a function are judged like functions, and are in the answer
 * @returns {Map<any, { kind: string, text: string, needs?: string }[]>} per function record its reasons, empty when it may move
 *   together with every function it uses that may move too
 */
export function heldFunctions(shell, { free = new Set(), along = false } = {}) {
  const judged = (record) => (record.kind === 'function' && record.names.length === 1) || (along && record.fixed);
  const functions = shell.records.filter(judged);
  const why = new Map();
  for (const record of functions) {
    const label = `${record.names[0]} (line ${shell.open + record.line[0] + 1})`;
    const reasons = ownReasons(shell, record, label);
    for (const name of record.uses.keys()) {
      const own = shell.bindings.get(name);
      if (!own || own.record === record || judged(own.record) || free.has(own.kind)) continue;
      const what = STATE.has(own.kind) ? `a ${own.kind} of the wrapper that changes while the page runs` : `a ${own.kind === 'statement' ? 'name a statement' : own.kind} of the wrapper${own.kind === 'statement' ? ' leaves there' : ''}`;
      reasons.push({ kind: STATE.has(own.kind) ? 'state' : own.kind === 'const' ? 'const' : 'other', text: `${label} uses ${name}, ${what} (line ${shell.open + own.record.line[0] + 1}), which stays` });
    }
    why.set(record, reasons);
  }
  // A function that uses a function which stays, stays too.
  for (let again = true; again;) {
    again = false;
    for (const record of functions) {
      if (why.get(record).length) continue;
      const held = [...record.uses.keys()].map((name) => shell.bindings.get(name)).find((own) => own && judged(own.record) && own.record !== record && (why.get(own.record)?.length ?? 1) > 0);
      if (!held) continue;
      why.get(record).push({ kind: 'needs', needs: held.name, text: `${record.names[0]} (line ${shell.open + record.line[0] + 1}) uses ${held.kind === 'function' ? 'the function ' : ''}${held.name}, which stays` });
      again = true;
    }
  }
  return why;
}

// Where the line that takes the functions back can stand: at the first moved function, or above the first
// statement that could reach a moved function while the script loads.
function anchorOf(shell, moved, movedSet) {
  const reaches = new Set(moved);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of shell.records) {
      if (reaches.has(record)) continue;
      if ([...record.uses.keys()].some((name) => shell.bindings.has(name) && reaches.has(shell.bindings.get(name).record))) { reaches.add(record); grew = true; }
    }
  }
  const user = shell.records.find((record) => !movedSet.has(record) && record.kind !== 'function' && reaches.has(record));
  return Math.min(moved[0].index, user ? user.index : shell.records.length);
}

/**
 * @param {object} job
 * @param {string} job.text the old script @param {any} job.parser from parser.mjs
 * @param {string} job.source repo-relative old script @param {string} job.target repo-relative new script
 * @param {string} job.about one sentence saying what the new script does: its first comment
 * @param {string[]} job.names functions declared in the wrapper
 * @param {number} [job.maxLines]
 * @returns {{ newSource: string, targetText: string, moved: string[], gives: string[], name: string, ranges: number[][],
 *   glue: { at: number, lines: string[] } }} `ranges` are 1-based lines of the old script, `glue.at` the 0-based line of the
 *   new text of the old script where the line that takes the functions back stands. Throws a Refusal with every reason.
 */
export function planInnerScript({ text, parser, source, target, about, names, maxLines = MAX_LINES }) {
  const shell = readWrapper(text, source, parser);
  if (shell.problems.length) throw new Refusal(shell.problems);
  const name = windowNameOf(source, target);
  const reasons = [];
  if (!name) reasons.push(`${target} must be ${source.replace(/\.js$/, '')}/<what it does>.js in lowercase kebab-case: the name it leaves on window is read off its place`);
  if (!String(about ?? '').trim()) reasons.push('the new script needs one sentence saying what it does (--about)');
  for (const word of ['eval', 'with']) if (shell.words.has(word)) reasons.push(`${source} says \`${word}\`, which reads names nobody can list: the script stays whole`);
  if (name && new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(text)) reasons.push(`${name} is a word ${source} already uses: give the new script another name`);
  const declared = (wanted) => shell.records.filter((record) => record.names.includes(wanted));
  const wrong = names.filter((wanted) => declared(wanted).length !== 1 || declared(wanted)[0].kind !== 'function' || declared(wanted)[0].names.length !== 1);
  reasons.push(...wrong.map((wanted) => `${wanted} is not a function declared once in the wrapper of ${source}`));
  if (reasons.length) throw new Refusal(reasons);

  const moved = [...new Set(names.map((wanted) => shell.bindings.get(wanted).record))].sort((a, b) => a.index - b.index);
  const movedSet = new Set(moved);
  const movedNames = moved.map((record) => record.names[0]);
  for (const record of moved) {
    const label = `${record.names[0]} (${source}:${shell.open + record.line[0] + 1})`;
    reasons.push(...ownReasons(shell, record, label).map((reason) => reason.text));
    for (const used of record.uses.keys()) {
      const own = shell.bindings.get(used);
      if (!own || movedSet.has(own.record)) continue;
      const what = own.kind === 'function' ? 'a function of the wrapper that stays: move it too, or leave both'
        : STATE.has(own.kind) ? `a ${own.kind} of the wrapper that changes while the page runs: the new script could not follow it`
          : `a ${own.kind === 'statement' ? 'name a statement of the wrapper leaves there' : `${own.kind} of the wrapper`} that stays: the new script would not have it`;
      reasons.push(`${label} uses ${used} (line ${shell.open + own.record.line[0] + 1}), ${what}`);
    }
  }
  const staying = shell.records.filter((record) => !movedSet.has(record));
  const gives = movedNames.filter((moving) => staying.some((record) => record.uses.has(moving)));
  if (gives.length === 0) reasons.push(`nothing left in ${source} uses ${movedNames.join(', ')}: delete dead code instead of moving it`);
  if (reasons.length) throw new Refusal(reasons);

  // The old script: the functions go, and one line takes back the ones it still uses.
  const lines = text.split('\n');
  const blank = (line) => line !== undefined && line.trim() === '';
  // A function takes the comment above it along, but not the title of the section it happened to open.
  const topOf = (record) => { let top = record.range[0]; while (top < record.line[0] && SECTION_TITLE.test(lines[shell.open + top])) top += 1; return top; };
  const rangeLines = (record) => lines.slice(shell.open + topOf(record), shell.open + record.range[1] + 1);
  const anchor = shell.records[anchorOf(shell, moved, movedSet)];
  const glue = wrapNames(gives, 'const {', `} = window.${name};`).map((line) => shell.indent + line);
  if (anchor && (!movedSet.has(anchor) || blank(rangeLines(anchor).at(-1)))) glue.push('');
  const glueLine = anchor ? shell.open + (movedSet.has(anchor) ? topOf(anchor) : anchor.range[0]) : shell.close;
  const moving = new Set(moved.flatMap((record) => Array.from({ length: record.range[1] - topOf(record) + 1 }, (_, i) => shell.open + topOf(record) + i)));
  const kept = [];
  let at = -1;
  lines.forEach((line, index) => {
    if (index === glueLine) { at = kept.length; kept.push(...glue); }
    if (!moving.has(index)) kept.push(line);
  });

  // The new script: first comment, a wrapper in the old script's mode, the moved text, the one name on window.
  const body = [...headerOf(about, shell.strictFile).split('\n').slice(0, -1), OPENS[0]];
  if (shell.strictInside) body.push(`${shell.indent}'use strict';`, '');
  moved.forEach((record, i) => {
    const piece = rangeLines(record);
    while (piece.length && blank(piece.at(-1))) piece.pop();
    if (i > 0) body.push('');
    body.push(...piece);
  });
  body.push('', ...wrapNames(gives, `window.${name} = {`, '};').map((line) => shell.indent + line), CLOSES[0]);
  if (body.length > maxLines) {
    throw new Refusal([`${target} would be ${body.length} lines, the limit for a new file is ${maxLines}: move fewer functions per file, split by what they do`]);
  }
  return { newSource: kept.join('\n'), targetText: `${body.join('\n')}\n`, moved: movedNames, gives, name,
    ranges: moved.map((record) => [shell.open + topOf(record) + 1, shell.open + record.range[1] + 1]), glue: { at, lines: glue } };
}
