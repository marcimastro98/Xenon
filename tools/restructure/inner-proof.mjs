// Proves that functions taken out of a factory's body (inner-plan.mjs) mean what they meant: the
// moved text is unchanged and every other line is accounted for (the proof of a plain move), and
// every name the moved functions take from outside themselves stands, in the new module, for the
// same thing it stood for in the factory. Reads the three texts on its own: nothing here comes
// from the planner but the places it says it wrote to.

import path from 'node:path';

import { analyze, FILE_BOUND } from './analyze.mjs';
import { proveMove } from './verify.mjs';

const HANDED_OVER = new Set(['function', 'const', 'class', 'require']);
const STRICT = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/;

// A function declared at the top of a file, with its body read as a file of its own.
function scopeOf(text, parser, name, functionName) {
  const { K } = parser;
  const tree = parser.parse(text, name);
  const node = tree.statements.find((statement) => statement.kind === K.FunctionDeclaration && statement.name?.text === functionName);
  if (!node?.body) return null;
  const lineOf = (offset) => text.slice(0, offset).split('\n').length - 1;
  const open = lineOf(node.body.getStart(tree));
  const close = lineOf(node.end - 1);
  const params = [];
  const collect = (binding) => {
    if (binding.kind === K.Identifier) params.push(binding.text);
    else binding.forEachChild((element) => { if (element.kind === K.BindingElement) collect(element.name); });
  };
  for (const parameter of node.parameters) collect(parameter.name);
  const body = text.split('\n').slice(open + 1, close).map((line) => (line.startsWith('  ') ? line.slice(2) : line));
  const file = analyze(text, parser, name);
  return { file, params, open, inner: analyze(`${body.join('\n')}\n`, parser, name, { registrations: [], afterLoad: [] }) };
}

// Where a require leads, as one spelling: './runner' in server/x/ and '../x/runner.js' in server/y/ are the same file.
function fileOfSpec(spec, from) {
  if (!spec.startsWith('.')) return spec.replace(/^node:/, '');
  return path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)).replace(/(?:\/index)?\.js$/, '');
}

const sameSet = (a, b) => a.length === b.length && a.every((name) => b.includes(name));
const namesIn = (list) => (list ?? '').split(',').map((name) => name.trim()).filter(Boolean);

/**
 * @param {object} move
 * @param {string} move.before the old file before @param {string} move.after the old file after @param {string} move.moduleText the new module
 * @param {{ ranges: number[][], glue: { sourceAt: number, sourceLines: string[], bodyAt: number, bodyLines: string[], moduleLines: number[],
 *   edits: { at: number, oldLines: string[], newLines: string[] }[] } }} move.plan
 * @param {any} move.parser from parser.mjs @param {string} move.source repo-relative old file @param {string} move.target repo-relative new module
 * @param {string} move.factory @param {string} move.make
 * @returns {string[]} problems, empty when the move is proven
 */
export function proveInner({ before, after, moduleText, plan, parser, source, target, factory, make }) {
  const problems = [];
  const { bodyAt, bodyLines, sourceAt, sourceLines, moduleLines, edits } = plan.glue;

  // 1. Without the call of the new module, this is a plain move: same bytes, every line accounted for.
  const now = after.split('\n');
  if (now.slice(bodyAt, bodyAt + bodyLines.length).join('\n') !== bodyLines.join('\n')) return ['the call of the new module is not where the plan put it'];
  const plain = [...now];
  plain.splice(bodyAt, bodyLines.length);
  const shift = (at) => (at > bodyAt ? at - bodyLines.length : at);
  problems.push(...proveMove({ before, after: plain.join('\n'), moduleText,
    plan: { ranges: plan.ranges, glue: { sourceAt: shift(sourceAt), sourceLines, moduleLines, edits: edits.map((edit) => ({ ...edit, at: shift(edit.at) })) } } }));

  // 2. The call hands over names as they are and takes the functions back under their names.
  const call = new RegExp(`^const \\{([\\s\\S]*)\\} = ${make}\\((?:\\{([^}]*)\\})?\\);$`).exec(bodyLines.map((line) => line.trim()).join(' ').trim());
  const was = scopeOf(before, parser, source, factory);
  const is = scopeOf(after, parser, source, factory);
  const made = scopeOf(moduleText, parser, target, make);
  if (!call || !was || !is || !made) return [...problems, `the factory ${factory}, the call of ${make} or the function ${make} cannot be read back`];
  const taken = namesIn(call[1]);
  const handed = namesIn(call[2]);
  if (![...taken, ...handed].every((name) => /^[A-Za-z_$][\w$]*$/.test(name))) problems.push(`the call of ${make} renames something: names are handed over and taken back as they are`);
  if (!sameSet(handed, made.params)) problems.push(`${make} takes ${made.params.join(', ') || 'nothing'} and is handed ${handed.join(', ') || 'nothing'}`);

  // 3. The new module is requires, the one function, and its export; the function is the moved functions and what it gives back.
  const top = made.file.records;
  const tail = moduleText.trimEnd().split('\n').at(-1);
  const strictLine = (record) => record.index === 0 && STRICT.test(moduleText);
  if (top.some((record) => record.kind !== 'require' && !record.names.includes(make) && record !== top.at(-1) && !strictLine(record)) || tail !== `module.exports = { ${make} };`) {
    problems.push(`the new module is more than its requires, ${make} and its export`);
  }
  const firstLine = top.find((record) => record.names.includes(make)).line[0] - 1;
  const header = new RegExp(`^function ${make}\\((?:\\{([^}]*)\\})?\\) \\{$`)
    .exec(moduleText.split('\n').slice(firstLine, made.open + 1).map((line) => line.trim()).join(' '));
  if (!header || !sameSet(namesIn(header[1]), handed)) problems.push(`${make} does not take what it is handed under the same names`);
  const inside = made.inner.records;
  if (inside.length === 0) return [...problems, `${make} is empty`];
  const gives =/^return \{([\s\S]*)\};$/.exec(moduleText.split('\n').slice(made.open + inside.at(-1).line[0], made.open + inside.at(-1).line[1] + 1).map((line) => line.trim()).join(' '));
  if (inside.slice(0, -1).some((record) => record.kind !== 'function') || !gives) problems.push(`${make} is more than the moved functions and what it gives back`);
  else if (!sameSet(namesIn(gives[1]), taken)) problems.push(`${make} gives back ${namesIn(gives[1]).join(', ')} and the factory takes ${taken.join(', ')}`);
  const movedNames = inside.slice(0, -1).flatMap((record) => record.names);

  // 4. Every name the moved functions take from outside themselves is the same thing as before.
  const written = (scope, name) => scope.inner.records.some((record) => (record.uses.get(name)?.write ?? 0) > 0);
  const local = (scope, name) => scope.inner.bindings.has(name) || scope.params.includes(name);
  for (const record of inside.slice(0, -1)) {
    for (const name of record.uses.keys()) {
      if (movedNames.includes(name)) {
        if (was.inner.bindings.get(name)?.kind !== 'function') problems.push(`${name} was not a function of ${factory}`);
      } else if (made.params.includes(name)) {
        const own = was.inner.bindings.get(name);
        const fixed = own ? HANDED_OVER.has(own.kind) && !own.reassigned : was.params.includes(name) && !written(was, name);
        if (!fixed || written(is, name)) problems.push(`${name} is handed to ${make} once, and ${factory} had it as something that can change`);
      } else if (made.file.bindings.has(name)) {
        const [mine, old] = [made.file.bindings.get(name).record.require, was.file.bindings.get(name)?.record.require];
        const same = mine && old && !local(was, name) && fileOfSpec(mine.spec, target) === fileOfSpec(old.spec, source) && mine.property === old.property
          && mine.bindings.find((binding) => binding.local === name)?.text === old.bindings.find((binding) => binding.local === name)?.text;
        if (!same) problems.push(`${name} is not the same required name in ${target} as it was in ${source}`);
      } else if (local(was, name) || was.file.bindings.has(name) || FILE_BOUND.has(name) || name === 'eval') {
        problems.push(`${name} meant something of ${source} and means nothing in ${target}`);
      }
    }
  }

  // 5. The functions are taken back before the factory can use one, and after everything handed over exists.
  const callRecord = is.inner.records.find((record) => record.line[0] === bodyAt - is.open);
  if (!callRecord || !sameSet(callRecord.names, taken)) return [...problems, `the call of ${make} is not a statement of ${factory}'s body`];
  const reach = new Set(taken);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of is.inner.records) {
      if (record === callRecord || record.names.every((name) => reach.has(name)) || ![...record.uses.keys()].some((name) => reach.has(name))) continue;
      for (const name of record.names) reach.add(name);
      grew = true;
    }
  }
  for (const record of is.inner.records.slice(0, callRecord.index)) {
    const early = record.kind === 'function' ? [] : [...record.uses.keys()].filter((name) => reach.has(name));
    if (early.length) problems.push(`line ${is.open + record.line[0] + 1} of ${source} may use ${early.join(', ')} before ${make} has given the functions back`);
  }
  for (const name of handed) {
    const own = is.inner.bindings.get(name);
    if (own && own.kind !== 'function' && own.record.index >= callRecord.index) problems.push(`${name} is handed to ${make} before it exists`);
  }
  for (const name of movedNames) {
    if (!taken.includes(name) && is.inner.records.some((record) => record.uses.has(name))) problems.push(`${factory} still uses ${name}, which ${make} does not give back`);
    if (written(is, name)) problems.push(`${factory} assigns ${name} again`);
  }
  if (STRICT.test(before) !== STRICT.test(moduleText)) problems.push(`${source} and ${target} are not both in strict mode`);
  return problems;
}
