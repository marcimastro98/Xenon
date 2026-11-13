// Plans moving the bodies of some branches of a chain (routes of the request
// handler, tools the assistant runs: branches-kinds.mjs) into a table in a module
// of their feature (the forms are in branches-text.mjs, the rules a body must meet
// in branches-scope.mjs, the rules its function must meet in branches-handler.mjs).
// Pure: text in, text out, or a refusal.
//
// What stays exactly as it is: every test of the chain and their order, every
// statement of the handler before the chain, and the rest of the file. The file
// gains one line that requires the table, right above the handler, where every
// module the table needs is loaded already: requiring it runs nothing new.

import path from 'node:path';

import { analyze } from './analyze.mjs';
import { calledBeforeItsTable, handlerProblems } from './branches-handler.mjs';
import { kindOf, ROUTES } from './branches-kinds.mjs';
import { readBranches } from './branches-scope.mjs';
import { callLine, CLOSE_LINE, ENTRY_END, entryLines, EXPORT_LINE, headLine, OPEN_LINE, readModule, readRequire, requireLine, typeLine } from './branches-text.mjs';
import { MAX_LINES, Refusal, wrapComment } from './extract-plan.mjs';
import { wrapNames } from './module-requires.mjs';
import { requireEdit } from './require-edits.mjs';
import { lineStarts } from './top-level.mjs';

const TABLE_FILE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)\/[a-z]+(?:-([a-z0-9]+(?:-[a-z0-9]+)*))?\.js$/;
const camel = (words) => words.split('-').map((word, index) => (index ? word[0].toUpperCase() + word.slice(1) : word)).join('');

/**
 * @param {string} source repo-relative file with the handler @param {string} target repo-relative module
 * @returns {{ local: string, spec: string, kind: typeof ROUTES } | null} the name the file requires the table under, the path
 *   it writes and which chain the table is for; null when the target is not `<feature>/routes.js`, `<feature>/tools.js`
 *   or one of them with `-<word>`, next to the file
 */
export function tableOf(source, target) {
  const relative = path.posix.relative(path.posix.dirname(source), target);
  const shape = TABLE_FILE.exec(relative);
  const kind = kindOf(relative);
  if (!shape || !kind) return null;
  const feature = camel(relative.split('/')[0]);
  const word = shape[1] ? camel(shape[1]) : '';
  return { local: `${feature}${kind.localWord}${word ? word[0].toUpperCase() + word.slice(1) : ''}Branches`, spec: `./${relative}`, kind };
}

/** The parameters of a body's function: only what it uses, so nothing in the new file is declared and left unused. */
export function paramsFor(handed, kind = ROUTES) {
  const context = kind.context.filter((name) => handed.includes(name));
  const parts = kind.leading.map((name) => (handed.includes(name) ? name : `_${name}`));
  if (context.length) parts.push(`{ ${context.join(', ')} }`);
  while (parts.length && parts.at(-1).startsWith('_')) parts.pop();
  return parts.join(', ');
}

// The require lines of the table's module: the ones it has, plus one name per new need, written the way the file binds it.
function requiresOf({ moduleBefore, parser, target, needed, bindings, rewriteSpec }) {
  const groups = [];
  const reasons = [];
  const had = moduleBefore === null ? [] : analyze(moduleBefore, parser, target).records.filter((record) => record.kind === 'require');
  for (const record of had) {
    const { spec, property, bindings: bound } = record.require;
    groups.push({ spec, property, plain: bound[0].text === '' ? bound[0].local : null, texts: bound.map((b) => b.text), locals: bound.map((b) => b.local) });
  }
  const modules = [];
  for (const name of needed) {
    const record = bindings.get(name).record;
    const bound = record.require.bindings.find((binding) => binding.local === name);
    const module = rewriteSpec(record.require.spec);
    modules.push({ ...module, index: record.index, name });
    const wanted = { spec: module.spec, property: record.require.property, plain: bound.text === '' ? name : null };
    const same = (group) => group.spec === wanted.spec && group.property === wanted.property;
    const holder = groups.find((group) => group.locals.includes(name));
    if (holder) {
      const text = holder.texts[holder.locals.indexOf(name)];
      if (!same(holder) || text !== bound.text) reasons.push(`${name} already means something else in ${target}`);
      continue;
    }
    const group = wanted.plain ? null : groups.find((other) => other.plain === null && same(other));
    if (group) { group.texts.push(bound.text); group.locals.push(name); } else groups.push({ ...wanted, texts: [bound.text], locals: [name] });
  }
  const lines = groups.flatMap((group) => {
    const call = `require('${group.spec}')${group.property ? `.${group.property}` : ''};`;
    return group.plain ? [`const ${group.plain} = ${call}`] : wrapNames(group.texts, 'const {', `} = ${call}`);
  });
  return { lines, modules, reasons };
}

// The module: its first comment, its requires, the table with every body it had and the new ones after them.
function moduleFor({ moduleBefore, about, requireLines, added, target, kind }) {
  const before = moduleBefore === null ? { head: wrapComment(about), entries: [], tail: ['', EXPORT_LINE, ''] } : readModule(moduleBefore);
  if (before.kind && before.kind !== kind) throw new Refusal([`${target} is a table of ${before.kind.id}, not of ${kind.id}`]);
  const comment = before.head.filter((_line, index) => before.head.slice(0, index + 1).every((other) => other.startsWith('//')));
  const taken = added.filter((entry) => before.entries.some((other) => other.key === entry.key)).map((entry) => entry.key);
  if (taken.length) throw new Refusal([`${target} already has a body for ${taken.join(', ')}`]);
  const entries = [...before.entries, ...added];
  const table = entries.flatMap((entry, index) => [...(index ? [''] : []), headLine(entry.key, entry.params), ...entryLines(entry.lines, kind), ENTRY_END]);
  return [...comment, '', ...requireLines, ...(requireLines.length ? [''] : []), typeLine(kind), OPEN_LINE, ...table, CLOSE_LINE, ...before.tail].join('\n');
}

// The requires of the file that lost names only the moved bodies used, as edits of `text`, top to bottom.
function orphanEdits({ text, parser, source, needed, modules, ownModules, kept }) {
  const after = analyze(text, parser, source);
  const used = (name) => after.records.some((record) => record !== after.bindings.get(name).record && record.uses.has(name));
  const orphaned = new Set(needed.filter((name) => !used(name)));
  const stuck = [...orphaned].filter((name) => kept.has(name));
  if (stuck.length) throw new Refusal([`only the moved code uses ${stuck.join(', ')}, required in a protected stretch of ${source} that is never edited`]);
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const edits = new Map();
  for (const record of new Set([...orphaned].map((name) => after.bindings.get(name).record))) {
    const module = modules.find((entry) => record.names.includes(entry.name));
    const edit = requireEdit({ text, starts, record, orphaned, ownModule: ownModules.has(module.file), builtin: module.kind === 'builtin' });
    if (edit) edits.set(edit.first, { ...edit, oldLines: lines.slice(edit.first, edit.first + edit.count) });
  }
  const out = [];
  const done = [];
  for (let at = 0; at < lines.length; at += 1) {
    const edit = edits.get(at);
    if (!edit) { out.push(lines[at]); continue; }
    done.push({ at: out.length, oldLines: edit.oldLines, newLines: edit.newLines });
    out.push(...edit.newLines);
    at += edit.count - 1;
  }
  return { text: out.join('\n'), edits: done };
}

/**
 * @param {object} job
 * @param {string} job.text the file with the handler
 * @param {any} job.parser from parser.mjs
 * @param {any} [job.analysis] from analyze.mjs, of the same text, when the caller has it
 * @param {string} job.source repo-relative path of that file
 * @param {string} job.target repo-relative module of the table: `<feature>/routes.js`, `<feature>/tools.js` or one of them
 *   with `-<word>`; the name says which chain the bodies come from
 * @param {string} [job.about] one sentence, the first comment of a new module
 * @param {string[]} job.keys `METHOD /path` (or the tool's name) of every branch whose body moves
 * @param {string | null} job.moduleBefore the module as it is, null when it is new
 * @param {(spec: string, from: string, to: string) => any} job.rewrite from module-requires.mjs
 * @param {string} [job.handler]
 * @param {Set<string>} [job.allowed] handlers whose bodies may move (protected.json `branches`)
 * @param {Set<string>} [job.protectedNames] names of the file's protected stretches
 * @param {Set<string>} [job.ownModules] modules earlier steps made out of this file that run nothing when they load
 * @param {number} [job.maxLines]
 * @returns {{ newSource: string, moduleText: string, local: string, spec: string, keys: string[], addedRequire: boolean,
 *   edits: { at: number, oldLines: string[], newLines: string[] }[], requires: any[], lines: number, sourceLines: number }}
 *   `keys` in the order of the chain; throws a Refusal
 */
export function planBranches(job) {
  const { text, parser, source, target, about, keys, moduleBefore, rewrite, allowed = new Set(),
    protectedNames = new Set(), ownModules = new Set(), maxLines = MAX_LINES } = job;
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`]);
  const table = tableOf(source, target);
  if (!table) throw new Refusal([`${target} is not <feature>/routes.js, <feature>/tools.js or one of them with -<word>, next to ${source}`]);
  const { kind } = table;
  const handler = job.handler ?? kind.handler;
  if (!allowed.has(handler)) throw new Refusal([`tools/restructure/protected.json does not let the bodies of ${handler} move ("branches")`]);
  if (moduleBefore === null && !about?.trim()) throw new Refusal(['say in one sentence what the new file does (--about): it becomes its first comment']);
  const analysis = job.analysis ?? analyze(text, parser, source);
  let read;
  try { read = readBranches({ text, parser, analysis, kind, handler }); } catch (error) { throw new Refusal([error.message]); }
  const reasons = [];
  const picked = [];
  for (const key of new Set(keys)) {
    const found = read.branches.filter((branch) => branch.key === key);
    if (found.length !== 1) { reasons.push(`${found.length} branches of ${handler} answer ${key}, one was expected`); continue; }
    if (found[0].moved) reasons.push(`${key} is a call of a table already`);
    reasons.push(...found[0].reasons.map((reason) => `${key} (${source}:${found[0].line}): ${reason}`));
    picked.push(found[0]);
  }
  if (picked.length === 0) reasons.push('no branch was named');
  if (reasons.length) throw new Refusal(reasons);
  const textOf = (node) => text.slice(node.getStart(read.sourceFile), node.end);
  reasons.push(...handlerProblems(read.chain, parser, kind, [...new Set(picked.flatMap((branch) => branch.handed))], textOf).map((what) => `${handler}: ${what}`));
  const early = calledBeforeItsTable(analysis, handler);
  if (early !== null) reasons.push(`line ${early} of ${source} runs while the file loads and may reach ${handler} before the line that requires the table`);
  if (reasons.length) throw new Refusal(reasons);
  picked.sort((a, b) => a.first - b.first);

  const lines = text.split('\n');
  const hasRequire = lines.some((line) => readRequire(line)?.local === table.local);
  if (hasRequire !== (moduleBefore !== null)) throw new Refusal([`${target} and the line of ${source} that requires it do not go together: one is there without the other`]);
  if (!hasRequire && new RegExp(String.raw`(?<![\w$.])${table.local.replace(/\$/g, String.raw`\$`)}(?![\w$])`).test(text)) {
    throw new Refusal([`${source} already has the word ${table.local}`]);
  }
  const needed = [...new Set(picked.flatMap((branch) => branch.needed))];
  const required = requiresOf({ moduleBefore, parser, target, needed, bindings: analysis.bindings, rewriteSpec: (spec) => rewrite(spec, source, target) });
  const home = analysis.bindings.get(handler).record;
  const late = required.modules.filter((module) => module.kind !== 'builtin' && module.index > home.index);
  reasons.push(...required.reasons, ...late.map((module) => `the table would need require('${module.spec}') for ${module.name}, which ${source} loads `
    + `after ${handler} (line ${analysis.records[module.index].line[0]}): it would load earlier than today`));
  if (reasons.length) throw new Refusal(reasons);

  const added = picked.map((branch) => ({ key: branch.key, params: paramsFor(branch.handed, kind), lines: lines.slice(branch.first, branch.last + 1) }));
  const moduleText = moduleFor({ moduleBefore, about, requireLines: required.lines, added, target, kind });
  const moduleLines = moduleText.split('\n').length - 1;
  if (moduleLines > maxLines) {
    throw new Refusal([`${target} would be ${moduleLines} lines, the limit for a new file is ${maxLines}: put some of the branches in ${kind.fileWord}-<word>.js`]);
  }

  // The file: each body becomes its call, bottom up so the lines above keep their numbers; then the require.
  const out = [...lines];
  for (const branch of picked.toReversed()) out.splice(branch.first, branch.last - branch.first + 1, callLine(table.local, branch.key, kind));
  if (!hasRequire) {
    const at = home.range[0] - 1;
    if (out[at - 1] === '' && readRequire(out[at - 2] ?? '')) out.splice(at - 1, 0, requireLine(table.local, table.spec));
    else out.splice(at, 0, requireLine(table.local, table.spec), '');
  }
  const { text: newSource, edits } = orphanEdits({ text: out.join('\n'), parser, source, needed, modules: required.modules, ownModules, kept: protectedNames });
  return { newSource, moduleText, local: table.local, spec: table.spec, keys: picked.map((branch) => branch.key), addedRequire: !hasRequire, edits,
    requires: required.modules, lines: moduleLines, sourceLines: lines.length - newSource.split('\n').length };
}
