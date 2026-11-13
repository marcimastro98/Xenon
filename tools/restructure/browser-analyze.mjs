// Reads classic browser scripts the way a page runs them: one after the other, in
// one shared scope. Says for every top-level declaration what it needs while the
// page loads, and whether it may live in a script that loads earlier.
//
// What may go earlier: a function (its body runs only when called), and a `const`,
// `let` or class whose first value needs nothing but values already there.
// What stays: every statement that does something when the script loads. One
// statement does nothing at all and goes with its function: `window.name = name;`
// for a function declared in the script, which a classic script has already put
// on `window` under that name before its first line runs.

import { readTopLevel } from './top-level.mjs';

// Values every script can read at any moment, and nothing can replace.
const ALWAYS_THERE = new Set(['Object', 'Array', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Math', 'Number', 'String', 'Boolean',
  'Symbol', 'BigInt', 'JSON', 'RegExp', 'Infinity', 'NaN', 'undefined', 'parseInt', 'parseFloat']);
const LEXICAL = new Set(['const', 'let', 'class']);

const isStrict = (parser, sourceFile) => {
  const first = sourceFile.statements[0];
  return Boolean(first && first.kind === parser.K.ExpressionStatement && first.expression.kind === parser.K.StringLiteral
    && first.expression.text === 'use strict');
};

// What a statement hands to a call while it runs: `inline` when a function is written
// in the argument list (it may be called at once), `names` for the plain names passed
// (one of them may be a function the call runs).
function handedOver(parser, node) {
  const { K } = parser;
  const BODIES = new Set([K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor, K.SetAccessor, K.Constructor]);
  const found = { inline: false, names: [] };
  const visit = (at, inBody) => {
    if (!inBody && (at.kind === K.CallExpression || at.kind === K.NewExpression)) {
      for (const argument of at.arguments ?? []) {
        if (argument.kind === K.FunctionExpression || argument.kind === K.ArrowFunction) found.inline = true;
        else if (argument.kind === K.Identifier) found.names.push(argument.text);
      }
    }
    const body = inBody || BODIES.has(at.kind);
    at.forEachChild((child) => { visit(child, body); });
  };
  visit(node, false);
  return found;
}

// `window.name = name;` and nothing else on the statement: the name, or null.
function namedOnWindow(parser, statement) {
  const { K } = parser;
  const said = statement.kind === K.ExpressionStatement ? statement.expression : null;
  if (!said || said.kind !== K.BinaryExpression || said.operatorToken.kind !== K.EqualsToken) return null;
  const { left, right } = said;
  if (left.kind !== K.PropertyAccessExpression || left.expression.kind !== K.Identifier || left.expression.text !== 'window') return null;
  return right.kind === K.Identifier && right.text === left.name.text ? right.text : null;
}

// One script read alone. A split is analyzed again after every move and most of its
// scripts have not changed in between, so what a text gave is kept with the parser.
function readScript(parser, text, file) {
  parser.read ??= new Map();
  if (parser.read.has(text)) return parser.read.get(text);
  const sourceFile = parser.parse(text, file);
  const strict = isStrict(parser, sourceFile);
  const statements = sourceFile.statements.filter((s) => (s.flags & parser.NodeFlags.Reparsed) === 0);
  const rows = readTopLevel(sourceFile, parser).map((record, index) => ({ ...record, directive: index === 0 && strict,
    onWindow: namedOnWindow(parser, statements[index]),
    handed: record.kind === 'function' ? { inline: false, names: [] } : handedOver(parser, statements[index]) }));
  parser.read.set(text, { strict, rows });
  return parser.read.get(text);
}

/**
 * @param {{ file: string, text: string }[]} scripts the scripts of one split, in the order a page loads them
 * @param {any} parser from parser.mjs
 * @returns {{ records: any[], bindings: Map<string, any>, strict: boolean[], duplicates: Set<string> }}
 *   `records`: every top-level statement of every script, in load order, each with `fileIndex`, `file`,
 *   `order` (its place in the whole run) and `needs` (the names it touches while it runs);
 *   `bindings`: who declares a name, and whether anything ever assigns or changes it (`state`);
 *   a record has `echo` (a function's name) when it is that function's `window.name = name;`.
 */
export function analyzeRun(scripts, parser) {
  const records = [];
  const strict = [];
  scripts.forEach(({ file, text }, fileIndex) => {
    const read = readScript(parser, text, file);
    strict.push(read.strict);
    for (const row of read.rows) records.push({ ...row, file, fileIndex, order: records.length });
  });
  const bindings = new Map();
  const duplicates = new Set();
  for (const record of records) {
    for (const name of record.names) {
      if (bindings.has(name)) duplicates.add(name);
      else bindings.set(name, { name, record, kind: record.kind, state: record.kind === 'let' || record.kind === 'var' });
    }
  }
  for (const record of records) {
    for (const [name, use] of record.uses) {
      const binding = bindings.get(name);
      if (binding && (use.write > 0 || use.change > 0) && !record.names.includes(name)) binding.state = true;
    }
  }
  const said = new Map();
  for (const record of records) if (record.onWindow) said.set(record.onWindow, (said.get(record.onWindow) ?? 0) + 1);
  for (const record of records) {
    const binding = bindings.get(record.onWindow);
    // Nothing else may give the name another value, or the statement would not be a repeat of what is there.
    const repeats = binding && binding.kind === 'function' && !binding.state && !duplicates.has(record.onWindow) && said.get(record.onWindow) === 1;
    record.echo = repeats ? record.onWindow : null;
    record.handsFunction = record.handed.names.filter((name) => bindings.get(name)?.kind === 'function');
    // A function written inside a call's arguments may run at once: then what its body uses counts too.
    record.needs = [...record.uses].filter(([, use]) => use.eager || record.handed.inline).map(([name]) => name)
      .filter((name) => !record.names.includes(name));
  }
  return { records, bindings, strict, duplicates };
}

/**
 * Why a declaration cannot leave its script at all, whatever else moves with it.
 * @param {any} record @param {{ duplicates: Set<string> }} run
 * @returns {string[]} reasons, empty when it may move
 */
export function stayReasons(record, run) {
  const what = record.names.join(', ') || `the statement at line ${record.line[0]}`;
  if (record.echo) return record.sharesLine ? [`${what} shares a line with another statement`] : [];
  if (record.names.length === 0 || record.kind === 'statement') return [`${what} runs when the script loads: it keeps its place`];
  const reasons = [];
  if (record.kind !== 'function' && !LEXICAL.has(record.kind)) reasons.push(`${what} is a ${record.kind}: only functions, const, let and classes move`);
  else if (record.loadTime) reasons.push(`${what} runs code to get its first value: it keeps its place`);
  if (record.handsFunction.length) reasons.push(`${what} hands the function ${record.handsFunction.join(', ')} to a call while the script loads`);
  if (record.sharesLine) reasons.push(`${what} shares a line with another statement`);
  const twice = record.names.filter((name) => run.duplicates.has(name));
  if (twice.length) reasons.push(`${twice.join(', ')} is declared twice`);
  return reasons;
}

/**
 * Checks an arrangement of scripts: everything a `const`, `let` or class needs for
 * its first value is already there when its script runs.
 * @param {ReturnType<typeof analyzeRun>} run the arrangement, analyzed
 * @param {(record: any) => boolean} [only] the records to check (default: all that hold no load-time code)
 * @returns {string[]} problems
 */
export function orderProblems(run, only = () => true) {
  const problems = [];
  for (const record of run.records) {
    if (!LEXICAL.has(record.kind) || record.loadTime || !only(record)) continue;
    for (const name of record.needs) {
      const binding = run.bindings.get(name);
      const who = `${record.names.join(', ')} (${record.file})`;
      if (!binding) {
        if (!ALWAYS_THERE.has(name)) problems.push(`${who} reads ${name} for its first value, which another script provides: its value at an earlier moment is not proven the same`);
      } else if (binding.kind === 'function') {
        if (binding.record.fileIndex > record.fileIndex) problems.push(`${who} needs the function ${name} while loading, and ${binding.record.file} loads later`);
      } else if (binding.state) {
        problems.push(`${who} reads ${name} for its first value, and ${name} changes while the page runs`);
      } else if (binding.record.loadTime) {
        problems.push(`${who} reads ${name} for its first value, and ${name} is computed when ${binding.record.file} loads`);
      } else if (binding.record.order > record.order) {
        problems.push(`${who} reads ${name} for its first value, and ${name} is declared after it (${binding.record.file})`);
      }
    }
  }
  return problems;
}

/**
 * A `let` in a script where nothing assigns it reads as a mistake (the lint asks
 * for a `const`), and the code that changes it is the code to read with it.
 * @param {ReturnType<typeof analyzeRun>} run
 * @returns {Map<string, any[]>} per `let` or `var`: the other statements of its own script that assign it
 */
export function assignedAtHome(run) {
  const home = new Map();
  for (const [name, binding] of run.bindings) {
    if (binding.kind !== 'let' && binding.kind !== 'var') continue;
    home.set(name, run.records.filter((record) => record !== binding.record && record.fileIndex === binding.record.fileIndex
      && (record.uses.get(name)?.write ?? 0) > 0));
  }
  return home;
}

/**
 * @param {any} record @param {ReturnType<typeof analyzeRun>} run
 * @returns {boolean} true when the statement does something while its script loads; a function's
 *   `window.name = name;` in the script that declares the function does not
 */
export function runsOnLoad(record, run) {
  if (record.directive || !(record.loadTime || record.kind === 'statement')) return false;
  return !(record.echo && run.bindings.get(record.echo).record.fileIndex === record.fileIndex);
}

/** @param {string} name @returns {boolean} true for a value no script can replace */
export const alwaysThere = (name) => ALWAYS_THERE.has(name);
