// Proves that moving route bodies into a table changed nothing but where they are
// written. Reads the old file, the new file and the module again from scratch;
// the planner's own results are used only to say which requires lost a name.
//
//   a. with the bodies put back and the requires as they were, the new file is the
//      old one byte for byte;
//   b. each body in the module is the old lines, byte for byte;
//   c. the chain has the same tests in the same order, the handler is the same
//      text up to the chain, and so are the protected stretches of the file;
//   d. each body takes from outside exactly what it took before: the same names,
//      read and changed as often, none assigned; every one of them is `req`, `res`,
//      a handler value handed over under the same name, a name the module requires
//      from the same file as the old file did, or something Node gives everyone;
//   e. the module is nothing but requires, the table and its export; what the new
//      bodies need is loaded by the old file before the handler, and the file
//      requires the table right above the handler, so loading it runs nothing new.

import { analyze } from './analyze.mjs';
import { placeBound, readBranches } from './branches-scope.mjs';
import { callLine, CONTEXT, putBack, readModule, readRequire } from './branches-text.mjs';
import { requireEditProblem } from './require-edits.mjs';
import { createUseReader } from './scope-uses.mjs';

const PARAMETERS = new Set(['req', 'res', ...CONTEXT]);
const profile = (uses, skip) => [...uses].filter(([name]) => !skip.has(name)).map(([name, use]) => `${name} ${use.read} ${use.write} ${use.change}`).sort().join('\n');

// The functions of the table, by key, and the statements of the module that are not a require, the table or the export.
function readTable(moduleText, parser, target) {
  const { K } = parser;
  const sourceFile = parser.parse(moduleText, target);
  const functions = new Map();
  const strange = [];
  for (const statement of sourceFile.statements) {
    const text = moduleText.slice(statement.getStart(sourceFile), statement.end);
    const declaration = statement.kind === K.VariableStatement ? statement.declarationList.declarations[0] : null;
    if (declaration?.name.text === 'branches' && declaration.initializer?.kind === K.ObjectLiteralExpression) {
      for (const property of declaration.initializer.properties) {
        const made = property.initializer;
        const plain = property.kind === K.PropertyAssignment && property.name.kind === K.StringLiteral && made.kind === K.ArrowFunction
          && made.body.kind === K.Block && moduleText.slice(made.getStart(sourceFile), made.end).startsWith('async (');
        if (plain) functions.set(property.name.text, made); else strange.push(`an entry of the table that is not 'KEY': async (...) => { ... }`);
      }
    } else if (text !== 'module.exports = { branches };' && !/^const (?:\{[^}]*\}|[\w$]+) = require\('[^']+'\)(?:\.[\w$]+)?;$/.test(text)) {
      strange.push(`a statement that is not a require, the table or the export: ${JSON.stringify(text.slice(0, 60))}`);
    }
  }
  return { functions, strange };
}

// Where a required name comes from: the file (or the built-in, or the package), the property, the name taken.
function originOf(analysis, name, file, idOf) {
  const binding = analysis.bindings.get(name);
  if (binding?.kind !== 'require') return null;
  const { spec, property, bindings } = binding.record.require;
  return `${idOf(spec, file)} ${property ?? ''} ${bindings.find((bound) => bound.local === name).text}`;
}

/**
 * @param {object} move
 * @param {string} move.before the old file @param {string} move.after the new file
 * @param {string | null} move.moduleBefore the module before, null when it is new @param {string} move.moduleText the module after
 * @param {{ local: string, keys: string[], edits: { at: number, oldLines: string[], newLines: string[] }[] }} move.plan
 * @param {any} move.parser @param {string} move.source @param {string} move.target repo-relative paths
 * @param {string} [move.handler]
 * @param {(string | null)[][]} [move.between] the protected stretches of the file, as pairs of names (protected.json)
 * @param {(spec: string, from: string) => string} move.idOf what a require leads to, as one text per module
 * @returns {string[]} problems; empty when the move is proven
 */
export function proveBranches({ before, after, moduleBefore, moduleText, plan, parser, source, target, handler = 'handleRequest', between = [], idOf }) {
  const problems = [];
  const keys = new Set(plan.keys);
  let table;
  try { table = readModule(moduleText); } catch (error) { return [`${target}: ${error.message}`]; }
  const bodies = new Map(table.entries.map((entry) => [entry.key, entry.lines]));

  // a. Undo the shrunk requires bottom up, then put the bodies back.
  const undone = after.split('\n');
  for (const edit of plan.edits.toReversed()) {
    if (undone.slice(edit.at, edit.at + edit.newLines.length).join('\n') !== edit.newLines.join('\n')) problems.push('a changed require is not where the plan says');
    undone.splice(edit.at, edit.newLines.length, ...edit.oldLines);
    const wrong = requireEditProblem(edit.oldLines, edit.newLines, moduleText);
    if (wrong) problems.push(wrong);
  }
  const hadRequire = before.split('\n').some((line) => readRequire(line)?.local === plan.local);
  let restored;
  try { restored = putBack(undone.join('\n'), { local: plan.local, bodies, keys, dropRequire: !hadRequire }); } catch (error) { return [...problems, error.message]; }
  if (restored !== before) problems.push(`with the bodies put back, ${source} is not the old file byte for byte`);

  // b, c. Both chains, read again.
  const [oldFile, newFile] = [analyze(before, parser, source), analyze(after, parser, source)];
  const old = readBranches({ text: before, parser, analysis: oldFile, handler });
  const now = readBranches({ text: after, parser, analysis: newFile, handler });
  const tests = (read) => read.branches.map((branch) => branch.test).join('\n');
  if (tests(old) !== tests(now)) problems.push(`the tests of ${handler} are not the same, in the same order`);
  const upTo = (read, text) => text.slice(read.chain.handler.getStart(read.sourceFile), read.chain.chain.getStart(read.sourceFile));
  if (upTo(old, before) !== upTo(now, after)) problems.push(`${handler} changed before its chain of routes`);
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  for (const [index, branch] of old.branches.entries()) {
    const other = now.branches[index];
    if (!other) break;
    const [was, is] = [oldLines.slice(branch.first, branch.last + 1), newLines.slice(other.first, other.last + 1)];
    if (!keys.has(branch.key)) { if (was.join('\n') !== is.join('\n')) problems.push(`the body of ${branch.key ?? branch.test} changed and was not asked to move`); continue; }
    if (is.join('\n') !== callLine(plan.local, branch.key)) problems.push(`${branch.key} is not one call of the table`);
    if ((bodies.get(branch.key) ?? []).join('\n') !== was.join('\n')) problems.push(`the body of ${branch.key} in ${target} is not the old lines byte for byte`);
  }
  const found = old.branches.filter((branch) => keys.has(branch.key)).length;
  if (found !== keys.size) problems.push(`${keys.size} bodies were to move, ${found} branches have those keys`);
  for (const [from, to] of between) {
    const stretch = (analysis, text) => {
      const at = (name) => analysis.records.findIndex((record) => record.names.includes(name));
      const [first, last] = [from === null ? 0 : at(from), at(to)];
      return first === -1 || last === -1 ? null : text.split('\n').slice(from === null ? 0 : analysis.records[first].range[0] - 1, analysis.records[last].range[1]).join('\n');
    };
    const [was, is] = [stretch(oldFile, before), stretch(newFile, after)];
    if (was === null || was !== is) problems.push(`the protected stretch ${from ?? 'start'}..${to} of ${source} is not the same text`);
  }

  // d. What each body takes from outside, in the module.
  const { functions, strange } = readTable(moduleText, parser, target);
  problems.push(...strange.map((what) => `${target} has ${what}`));
  const module = analyze(moduleText, parser, target);
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const home = oldFile.bindings.get(handler)?.record.index ?? -1;
  const loadedAt = new Map();
  for (const record of oldFile.records.filter((entry) => entry.require).toReversed()) loadedAt.set(idOf(record.require.spec, source), record.index);
  for (const branch of old.branches.filter((entry) => keys.has(entry.key))) {
    const made = functions.get(branch.key);
    if (!made) { problems.push(`${target} has no function for ${branch.key}`); continue; }
    const uses = usesOf(made.body);
    const given = new Set(made.parameters.flatMap((parameter) => (parameter.name.kind === parser.K.Identifier ? [parameter.name.text]
      : parameter.name.elements.map((element) => element.name.text))));
    if (profile(uses, PARAMETERS) !== profile(branch.uses, PARAMETERS)) problems.push(`${branch.key} does not take the same names from outside as before`);
    for (const [name, use] of uses) {
      if (use.write > 0) problems.push(`${branch.key} assigns ${name}`);
      if (PARAMETERS.has(name)) {
        if (!given.has(name) || !old.locals.has(name)) problems.push(`${branch.key} uses ${name}, which its function is not handed`);
      } else if (module.bindings.has(name)) {
        const [here, there] = [originOf(module, name, target, idOf), originOf(oldFile, name, source, idOf)];
        if (!here || here !== there) problems.push(`${name} in ${target} is not what ${source} required under that name`);
        const id = idOf(module.bindings.get(name).record.require.spec, target);
        if (!id.startsWith('node:') && !(loadedAt.get(id) < home)) problems.push(`${target} requires ${id}, which ${source} has not loaded before ${handler}`);
      } else if (!(name in globalThis) || oldFile.bindings.has(name) || old.locals.has(name)) problems.push(`${branch.key} uses ${name}, which ${target} does not have`);
    }
    for (const name of given) if (!PARAMETERS.has(name) && !/^_(?:req|res)$/.test(name)) problems.push(`${branch.key} is handed ${name}, which the handler does not hand over`);
    problems.push(...placeBound(made.body, parser).map((what) => `${branch.key} has ${what}`));
  }

  // e. The file requires the table right above the handler; what the module had, it still has.
  const requireAt = newFile.bindings.get(plan.local)?.record.index ?? -1;
  const handlerAt = newFile.bindings.get(handler)?.record.index ?? -1;
  if (requireAt === -1 || requireAt >= handlerAt || newFile.records.slice(requireAt, handlerAt).some((record) => !readRequire(after.split('\n')[record.line[0] - 1]))) {
    problems.push(`${source} does not require the table right above ${handler}`);
  }
  if (moduleBefore !== null) {
    const earlier = readModule(moduleBefore).entries;
    if (earlier.some((entry, index) => table.entries[index]?.key !== entry.key || table.entries[index].lines.join('\n') !== entry.lines.join('\n'))) {
      problems.push(`the bodies ${target} had are not all there, unchanged and in order`);
    }
    const had = analyze(moduleBefore, parser, target);
    for (const name of had.bindings.keys()) {
      if (name !== 'branches' && originOf(had, name, target, idOf) !== originOf(module, name, target, idOf)) problems.push(`${name} in ${target} no longer comes from the same place`);
    }
  }
  return problems;
}
