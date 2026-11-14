// Proves that moving bodies of a chain (routes, or tools the assistant runs) into
// a table changed nothing but where they are written. Reads the old file, the new file and the module again from scratch;
// the planner's own results are used only to say which requires lost a name.
//
//   a. with the bodies put back and the requires as they were, the new file is the
//      old one byte for byte;
//   b. each body in the module is the old lines, byte for byte, once the two words that
//      mean the file's folder are written back as text (branches-text.mjs `oldPlaces`);
//   c. the chain has the same tests in the same order, the handler is the same
//      text up to the chain and after it, and so are the protected stretches of
//      the file; what a body is handed is never assigned by the handler, and a
//      result a body gives back is empty when the chain starts (branches-handler.mjs);
//      a call says `return` exactly when its body gives a value back, and names exactly
//      the extra values of the handler its function takes;
//   d. each body takes from outside exactly what it took before: the same names,
//      read and changed as often, none assigned but the result it gives back; every
//      one of them is a handler value handed over under the same name, a name the module requires
//      from the same file as the old file did, something Node gives everyone, or a
//      name of the file its call hands over (f); where the old body said `__dirname` the
//      new one says SERVER_DIR, which the table works out on the one line that gives the
//      old folder on every kind of system, and a path it requires leads to the same file
//      from the new folder (branches-place.mjs);
//   e. the module is nothing but requires, the table and its export; what the new
//      bodies need is loaded by the old file before the handler, and the file
//      requires the table right above the handler, so loading it runs nothing new;
//      nothing that runs while the file loads can reach the handler before that line;
//   f. a name of the file a call hands over is one the file declares once, for good,
//      and has its value before anything can run the handler (branches-own.mjs), in
//      the old file and in the new one; the handler declares nothing under that name,
//      so the call reads the file's; the call lists plain names and nothing else, the
//      ones the body uses, in order, and the function takes them under the same names;
//   g. the one lint line a table may carry (branches-text.mjs) is there exactly when the table had it or a body
//      that sets the result once in a line of its own came in, once, and silences nothing else.

import { analyze } from './analyze.mjs';
import { calledBeforeItsTable, handlerProblems } from './branches-handler.mjs';
import { kindOf } from './branches-kinds.mjs';
import { ownRule } from './branches-own.mjs';
import { homeProblem, PLACE_WORDS, placeProblems, placeUses } from './branches-place.mjs';
import { paramsFor } from './branches-plan.mjs';
import { placeBoundIn, readBranches } from './branches-scope.mjs';
import { callLine, extraOf, HOME_LINE, oldPlaces, ownOf, putBack, readModule, readRequire, SET_ONCE_LINE } from './branches-text.mjs';
import { HOME, OLD_HOME } from './paths-undo.mjs';
import { requireEditProblem } from './require-edits.mjs';
import { createUseReader } from './scope-uses.mjs';

const profile = (uses, skip) => [...uses].filter(([name]) => !skip.has(name)).map(([name, use]) => `${name} ${use.read} ${use.write} ${use.change}`).sort().join('\n');

// The functions of the table, by key, each with its parameters as written, and the statements of the module that are
// not a require, the table or the export.
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
        const params = plain && made.parameters.length ? moduleText.slice(made.parameters[0].getStart(sourceFile), made.parameters.at(-1).end) : '';
        if (plain) functions.set(property.name.text, { made, params }); else strange.push(`an entry of the table that is not 'KEY': async (...) => { ... }`);
      }
    } else if (text !== 'module.exports = { branches };' && text !== HOME_LINE && !/^const (?:\{[^}]*\}|[\w$]+) = require\('[^']+'\)(?:\.[\w$]+)?;$/.test(text)) {
      strange.push(`a statement that is not a require, the table or the export: ${JSON.stringify(text.slice(0, 60))}`);
    }
  }
  return { functions, strange, sourceFile };
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
 * @param {string} [move.handler] the kind's own when left out (the kind is said by the target's file name)
 * @param {(string | null)[][]} [move.between] the protected stretches of the file, as pairs of names (protected.json)
 * @param {(spec: string, from: string) => string} move.idOf what a require leads to, as one text per module
 * @param {Parameters<typeof analyze>[3]} [move.rules] the lists the files are read with (analyze.mjs); the ones of this folder when left out
 * @returns {string[]} problems; empty when the move is proven
 */
export function proveBranches({ before, after, moduleBefore, moduleText, plan, parser, source, target, handler: named, between = [], idOf, rules }) {
  const problems = [];
  const kind = kindOf(target);
  if (!kind) return [`${target} is not named as a table of routes or of tools`];
  const handler = named ?? kind.handler;
  const PARAMETERS = new Set([...kind.leading, ...kind.context, ...kind.extra]);
  const VALUED = 'a `return` with a value';
  const NOT_COMPARED = new Set([...PARAMETERS, ...(kind.result ? [kind.result] : [])]);
  const keys = new Set(plan.keys);
  let table;
  try { table = readModule(moduleText); } catch (error) { return [`${target}: ${error.message}`]; }
  if (table.kind !== kind) return [`${target} holds a table of ${table.kind.id}, its name says ${kind.id}`];
  const asked = after.split('\n').map(readRequire).find((found) => found?.local === plan.local);
  if (!asked) return [`${source} does not require the table as ${plan.local}`];
  // Every body as it stood in the file: the table holds it written for its own folder.
  const bodies = new Map(table.entries.map((entry) => [entry.key, oldPlaces(entry.lines, { home: table.home, spec: asked.spec })]));
  const ownOfKey = new Map(table.entries.map((entry) => [entry.key, ownOf(entry.params, kind)]));
  const extraOfKey = new Map(table.entries.map((entry) => [entry.key, extraOf(entry.params, kind)]));

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
  try { restored = putBack(undone.join('\n'), { local: plan.local, bodies, keys, dropRequire: !hadRequire, kind }); } catch (error) { return [...problems, error.message]; }
  if (restored !== before) problems.push(`with the bodies put back, ${source} is not the old file byte for byte`);

  // b, c. Both chains, read again.
  const [oldFile, newFile] = [analyze(before, parser, source, rules), analyze(after, parser, source, rules)];
  const old = readBranches({ text: before, parser, analysis: oldFile, kind, handler });
  const now = readBranches({ text: after, parser, analysis: newFile, kind, handler });
  const tests = (read) => read.branches.map((branch) => branch.test).join('\n');
  if (tests(old) !== tests(now)) problems.push(`the tests of ${handler} are not the same, in the same order`);
  const upTo = (read, text) => text.slice(read.chain.handler.getStart(read.sourceFile), read.chain.chain.getStart(read.sourceFile));
  if (upTo(old, before) !== upTo(now, after)) problems.push(`${handler} changed before its chain`);
  const rest = (read, text) => text.slice(read.chain.chain.end, read.chain.handler.end);
  if (rest(old, before) !== rest(now, after)) problems.push(`${handler} changed after its chain`);
  const moving = old.branches.filter((branch) => keys.has(branch.key));
  const textOf = (node) => before.slice(node.getStart(old.sourceFile), node.end);
  problems.push(...handlerProblems(old.chain, parser, kind, [...new Set(moving.flatMap((branch) => branch.handed))], textOf).map((what) => `${handler}: ${what}`));
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  for (const [index, branch] of old.branches.entries()) {
    const other = now.branches[index];
    if (!other) break;
    const [was, is] = [oldLines.slice(branch.first, branch.last + 1), newLines.slice(other.first, other.last + 1)];
    if (!keys.has(branch.key)) { if (was.join('\n') !== is.join('\n')) problems.push(`the body of ${branch.key ?? branch.test} changed and was not asked to move`); continue; }
    if (is.join('\n') !== callLine(plan.local, branch.key, kind, ownOfKey.get(branch.key), extraOfKey.get(branch.key), branch.returns)) {
      problems.push(`${branch.key} is not one call of the table that hands over what its function takes${branch.returns ? ' and gives back what it gives back' : ''}`);
    }
    if ((bodies.get(branch.key) ?? []).join('\n') !== was.join('\n')) problems.push(`the body of ${branch.key} in ${target} is not the old lines byte for byte`);
  }
  if (moving.length !== keys.size) problems.push(`${keys.size} bodies were to move, ${moving.length} branches have those keys`);
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
  const { functions, strange, sourceFile: tableFile } = readTable(moduleText, parser, target);
  problems.push(...strange.map((what) => `${target} has ${what}`));
  const module = analyze(moduleText, parser, target);
  const usesOf = createUseReader(parser.K, parser.NodeFlags);
  const home = oldFile.bindings.get(handler)?.record.index ?? -1;
  const [ruleBefore, ruleAfter] = [ownRule(oldFile, handler), ownRule(newFile, handler)];
  const loadedAt = new Map();
  for (const record of oldFile.records.filter((entry) => entry.require).toReversed()) loadedAt.set(idOf(record.require.spec, source), record.index);
  const wantsHome = (moduleBefore !== null && readModule(moduleBefore).home) || moving.some((branch) => branch.place.homes.length > 0);
  if (table.home !== wantsHome) problems.push(`${target} ${table.home ? 'works out' : 'does not work out'} ${HOME}, and ${wantsHome ? 'a' : 'no'} body of it said ${OLD_HOME}`);
  if (table.home) {
    const wrong = homeProblem(source, target);
    if (wrong) problems.push(wrong);
    if (originOf(module, 'path', target, idOf) !== 'node:path  ') problems.push(`${target} works out ${HOME} with a \`path\` that is not node's own`);
  }
  for (const branch of moving) {
    const { made, params } = functions.get(branch.key) ?? {};
    if (!made) { problems.push(`${target} has no function for ${branch.key}`); continue; }
    const words = [];
    const uses = usesOf(made.body, undefined, (node) => { if (PLACE_WORDS.has(node.text)) words.push(node); });
    const placed = placeUses(words, parser, (node) => moduleText.slice(node.getStart(tableFile), node.end), tableFile);
    problems.push(...placeProblems(branch.place, placed, { source, target, idOf }).map((what) => `${branch.key}: ${what}`));
    // The old body's `__dirname` is the table's SERVER_DIR: the same word for the comparison.
    const asBefore = new Map([...uses].map(([name, use]) => [table.home && name === HOME ? OLD_HOME : name, use]));
    // f. What the call hands over of the file: exactly the names the body takes from it that the table does not require.
    const own = ownOfKey.get(branch.key);
    const taken = [...uses.keys()].filter((name) => !NOT_COMPARED.has(name) && oldFile.bindings.has(name) && !ruleBefore.required(name)).sort();
    if (taken.join(' ') !== own.join(' ')) problems.push(`${branch.key} is not handed exactly the names of ${source} it uses, in order`);
    if (params !== paramsFor([...PARAMETERS].filter((name) => uses.has(name)), kind, own)) problems.push(`the function of ${branch.key} does not take exactly what it uses, under the same names`);
    for (const name of own) {
      const why = ruleBefore.whyNot(name) ?? ruleAfter.whyNot(name);
      if (why) problems.push(`${branch.key} is handed ${name}: ${why}`);
      if (old.locals.has(name) || now.locals.has(name)) problems.push(`${branch.key} is handed ${name}, which ${handler} declares for itself`);
    }
    if (profile(asBefore, NOT_COMPARED) !== profile(branch.uses, NOT_COMPARED)) problems.push(`${branch.key} does not take the same names from outside as before`);
    for (const [name, use] of uses) {
      if (use.write > 0) problems.push(`${branch.key} assigns ${name}`);
      if (PARAMETERS.has(name)) {
        if (!old.locals.has(name)) problems.push(`${branch.key} uses ${name}, which its function is not handed`);
      } else if (own.includes(name) || name === 'require' || (table.home && name === HOME)) {
        continue; // a handed name (f); a path required the plain way, or the folder the table works out (checked above)
      } else if (module.bindings.has(name)) {
        const [here, there] = [originOf(module, name, target, idOf), originOf(oldFile, name, source, idOf)];
        if (!here || here !== there) { problems.push(`${name} in ${target} is not what ${source} required under that name`); continue; }
        const id = idOf(module.bindings.get(name).record.require.spec, target);
        if (!id.startsWith('node:') && !(loadedAt.get(id) < home)) problems.push(`${target} requires ${id}, which ${source} has not loaded before ${handler}`);
      } else if (!(name in globalThis) || oldFile.bindings.has(name) || old.locals.has(name)) problems.push(`${branch.key} uses ${name}, which ${target} does not have`);
    }
    // A function that gives a result back is the line that declares it, the body, and the line that returns it (readModule saw both).
    const inside = kind.result ? made.body.statements.slice(1, -1) : [...made.body.statements];
    const bound = placeBoundIn(inside, parser, { anyReturn: Boolean(kind.result) });
    if (kind.returns && bound.includes(VALUED) !== branch.returns) problems.push(`${branch.key} ${branch.returns ? 'gave a value back and no longer does' : 'gives a value back and did not'}`);
    problems.push(...bound.filter((what) => !(kind.returns && what === VALUED)).map((what) => `${branch.key} has ${what}`));
  }

  // e. The file requires the table right above the handler; what the module had, it still has.
  const requireAt = newFile.bindings.get(plan.local)?.record.index ?? -1;
  const handlerAt = newFile.bindings.get(handler)?.record.index ?? -1;
  const early = calledBeforeItsTable(newFile, handler);
  if (early !== null) problems.push(`line ${early} of ${source} runs while the file loads and may reach ${handler} before the table is required`);
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

  // g. The lint line of a result set once.
  const wanted = (moduleBefore !== null && readModule(moduleBefore).setOnce) || moving.some((branch) => branch.once);
  if (table.setOnce && !wanted) problems.push(`${target} silences a lint finding and has no body that sets its result once in a line of its own`);
  if (!table.setOnce && wanted) problems.push(`${target} has a body that sets ${kind.result} once in a line of its own, and not the line that says so to the lint check`);
  const quiet = moduleText.split('\n').filter((line) => /^\s*(?:\/\/|\/\*+|\*)\s*biome-ignore/.test(line));
  if (quiet.length > 1 || quiet.some((line) => line !== SET_ONCE_LINE)) problems.push(`${target} silences more of the lint check than the one line of a result set once`);
  return problems;
}
