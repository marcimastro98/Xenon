// Plans taking top-level declarations out of a CommonJS file into a new module:
// the moved text is copied unchanged, the new module gets its requires and exports,
// the old file gets one require in their place. Pure: text in, text out, or a refusal.

import path from 'node:path';

import { closureOf } from './analyze.mjs';
import { namesRunAtLoad } from './load-registrations.mjs';
import { requireLines, wrapNames } from './module-requires.mjs';
import { requireEdit } from './require-edits.mjs';
import { lineStarts } from './top-level.mjs';

export const MAX_LINES = 300;
const MOVABLE_KINDS = new Set(['function', 'class', 'const', 'let', 'var']);
const COMMENT_WIDTH = 96;

/** Thrown with every reason at once, so one run shows all there is to fix. */
export class Refusal extends Error {
  /** @param {string[]} reasons */
  constructor(reasons) {
    super(reasons.join('\n'));
    this.name = 'Refusal';
    this.reasons = reasons;
  }
}

/** @param {string} sentence @returns {string[]} the sentence as `//` lines of a readable width */
export function wrapComment(sentence) {
  const lines = [];
  let row = '//';
  for (const word of sentence.trim().split(/\s+/)) {
    if (row.length + word.length + 1 > COMMENT_WIDTH && row !== '//') { lines.push(row); row = '//'; }
    row += ` ${word}`;
  }
  return [...lines, row];
}

function selfReasons(record, at, protectedNames) {
  const label = record.names.join(', ') || `the statement at ${at(record)}`;
  const reasons = [];
  if (!MOVABLE_KINDS.has(record.kind)) reasons.push(`${label} (${at(record)}) is a ${record.kind}, not a declaration that can move`);
  else if (record.loadTime) {
    const calls = record.loadCalls?.length ? ` (${record.loadCalls.join(', ')}, not on the list in load-time-calls.json)` : '';
    reasons.push(`${label} (${at(record)}) runs code when the file loads${calls}: moving it would change the load order`);
  }
  if (record.sharesLine) reasons.push(`${label} (${at(record)}) shares a line with another statement`);
  if (record.fileBound.length) reasons.push(`${label} (${at(record)}) uses ${record.fileBound.join(', ')}, which would mean another file there`);
  const guarded = record.names.filter((name) => protectedNames.has(name));
  if (guarded.length) reasons.push(`${guarded.join(', ')} (${at(record)}) is part of the security prelude and stays where it is`);
  return reasons;
}

/**
 * Says which statements could use `names` while the file is still loading: the ones that touch a name as they run,
 * and the ones that run code which reaches `seeds` (the declarations of the names) through any chain of uses.
 * @param {{ records: any[], seeds: any[], names: string[], bindings: Map<string, any> }} job
 * @returns {(record: any) => boolean}
 */
export function loadUseTest({ records, seeds, names, bindings }) {
  const seedSet = new Set(seeds);
  const remaining = records.filter((record) => !seedSet.has(record));
  const reaches = new Set(seeds);
  for (let grew = true; grew;) {
    grew = false;
    for (const record of remaining) {
      if (reaches.has(record)) continue;
      for (const name of record.uses.keys()) {
        const binding = bindings.get(name);
        if (binding && reaches.has(binding.record)) { reaches.add(record); grew = true; break; }
      }
    }
  }
  // A statement that only hands over functions (load-registrations.json) runs what stands outside them, nothing else.
  const runsMoved = (record) => (record.registersOnly
    ? namesRunAtLoad(record).some((name) => bindings.has(name) && reaches.has(bindings.get(name).record)) : reaches.has(record));
  return (record) => (record.loadTime && runsMoved(record)) || names.some((name) => record.uses.get(name)?.eager);
}

// Where the new require can go: after every module it needs is loaded, and before
// the first statement that could use a moved name while the file is still loading.
function placeRequire({ records, moved, movedSet, movedNames, bindings, modules, source, stretches }) {
  const firstUse = records.filter((record) => !movedSet.has(record)).find(loadUseTest({ records, seeds: moved, names: movedNames, bindings }));
  const before = firstUse ? firstUse.index : records.length;
  const loaded = modules.filter((m) => m.kind !== 'builtin').reduce((max, m) => Math.max(max, m.index), -1);
  if (loaded >= before) {
    const late = modules.find((m) => m.index === loaded);
    return { reason: `the new module needs require('${late.spec}'), which ${source} loads at line ${records[loaded].line[0]}, `
      + `after line ${firstUse.line[0]} where a moved name may already be used: it would load earlier than today` };
  }
  let anchor = Math.min(moved[0].index, before);
  if (anchor <= loaded) anchor = loaded + 1;
  // The require is a new line, and a protected stretch gets no new line: it goes just above the stretch instead.
  const inside = stretches.find(([first, last]) => anchor > first && anchor <= last);
  if (inside) {
    const [first, last] = inside;
    if (first <= loaded) {
      return { reason: `the new require would have to go between lines ${records[Math.max(first, 0)].line[0]} and ${records[last].line[0]} of ${source}, `
        + 'a protected stretch that is never edited' };
    }
    anchor = first;
  }
  return anchor < records.length ? { anchor } : { reason: `no place in ${source} is left for the new require` };
}

/**
 * @param {object} job
 * @param {string} job.text the old file
 * @param {{records: any[], bindings: Map<string, any>}} job.analysis from analyze.mjs, of the same text
 * @param {string[]} job.names declarations to move
 * @param {string} job.source repo-relative path of the old file
 * @param {string} job.target repo-relative path of the new module
 * @param {string} job.about one sentence saying what the new file does: its first comment
 * @param {(spec: string, from: string, to: string) => any} job.rewrite from module-requires.mjs
 * @param {boolean} [job.withDeps] also move everything the names need from the old file
 * @param {Set<string>} [job.protectedNames] names that never move
 * @param {number[][]} [job.protectedStretches] runs of the old file that get no new line, as [first, last] positions
 *   in the analysis records (first = -1: from the start of the file)
 * @param {Set<string>} [job.ownModules] repo-relative modules earlier extractions made out of this file
 * @param {number} [job.maxLines]
 * @returns {{ newSource: string, moduleText: string, moved: string[], exported: string[], imported: string[],
 *   ranges: number[][], requires: any[], glue: { sourceAt: number, sourceLines: string[], moduleLines: number[],
 *   edits: { at: number, oldLines: string[], newLines: string[] }[] } }}
 *   `edits` are requires of the old file that lost names only the moved code used, in the order of the old file; `at` and
 *   `sourceAt` are 0-based lines of the new text.
 */
export function planExtraction(job) {
  const { text, analysis, names, source, target, about, rewrite, withDeps = false,
    protectedNames = new Set(), protectedStretches = [], ownModules = new Set(), maxLines = MAX_LINES } = job;
  const { bindings, records } = analysis;
  if (text.includes('\r')) throw new Refusal([`${source} has Windows line endings: code files are LF here (.gitattributes), fix the checkout first`]);
  const unknown = names.filter((name) => !bindings.has(name));
  if (unknown.length) throw new Refusal(unknown.map((name) => `${name} is not a top-level declaration of ${source}`));
  if (!about?.trim()) throw new Refusal(['say in one sentence what the new file does (--about): it becomes its first comment']);
  const moved = (withDeps ? closureOf(analysis, names) : [...new Set(names.map((name) => bindings.get(name).record))])
    .sort((a, b) => a.index - b.index);
  const movedSet = new Set(moved);
  const movedNames = moved.flatMap((record) => record.names);
  const at = (record) => `${source}:${record.line[0]}`;
  const reasons = moved.flatMap((record) => selfReasons(record, at, protectedNames));

  for (const record of moved) {
    const stays = record.deps.filter((name) => !movedSet.has(bindings.get(name).record));
    if (stays.length === 0) continue;
    const list = stays.map((name) => `${name} (line ${bindings.get(name).record.line[0]})`).join(', ');
    reasons.push(`${record.names.join(', ')} (${at(record)}) needs ${list} from ${source}: the new module would have to require `
      + `${source} back, a circular require read at load time. Move ${stays.length > 1 ? 'them' : 'it'} first or with it (--with-deps).`);
  }
  const remaining = records.filter((record) => !movedSet.has(record));
  const imported = movedNames.filter((name) => remaining.some((record) => record.uses.has(name)));
  for (const name of imported) {
    if (bindings.get(name).reassigned) reasons.push(`${name} is reassigned and ${source} still uses it: a require would hand over a copy that never changes`);
  }
  if (imported.length === 0) reasons.push(`nothing left in ${source} uses ${movedNames.join(', ')}: delete dead code instead of moving it`);
  if (reasons.length) throw new Refusal(reasons);

  const needed = [...new Set(moved.flatMap((record) => record.requires))];
  const required = requireLines(needed, bindings, (spec) => rewrite(spec, source, target));
  const place = placeRequire({ records, moved, movedSet, movedNames, bindings, modules: required.modules, source,
    stretches: protectedStretches });
  if (place.reason) throw new Refusal([place.reason]);

  const lines = text.split('\n');
  const rangeLines = (record) => lines.slice(record.range[0] - 1, record.range[1]);
  const blank = (line) => line !== undefined && line.trim() === '';

  // Required names only the moved code used: the old file stops asking for them.
  const orphaned = new Set(needed.filter((name) => !remaining.some((record) => record !== bindings.get(name).record && record.uses.has(name))));
  const starts = lineStarts(text);
  const edits = new Map();
  required.modules.forEach((module) => {
    const edit = requireEdit({ text, starts, record: records[module.index], orphaned,
      ownModule: ownModules.has(module.file), builtin: module.kind === 'builtin' });
    if (edit) edits.set(edit.first, { ...edit, oldLines: lines.slice(edit.first, edit.first + edit.count) });
  });

  // The old file: the ranges go, one require comes in.
  const anchorRecord = records[place.anchor];
  const fromSource = path.posix.relative(path.posix.dirname(source), target);
  const call = `} = require('${fromSource.startsWith('.') ? fromSource : `./${fromSource}`}');`;
  const sourceGlue = wrapNames(imported, 'const {', call);
  if (!movedSet.has(anchorRecord) || blank(rangeLines(anchorRecord).at(-1))) sourceGlue.push('');
  const gone = new Set(moved.flatMap((record) => Array.from({ length: record.range[1] - record.range[0] + 1 }, (_, i) => record.range[0] - 1 + i)));
  for (const edit of edits.values()) for (let i = 0; i < edit.count; i += 1) gone.add(edit.first + i);
  const kept = [];
  let sourceAt = -1;
  lines.forEach((line, index) => {
    if (index === anchorRecord.range[0] - 1) { sourceAt = kept.length; kept.push(...sourceGlue); }
    const edit = edits.get(index);
    if (edit) { edit.at = kept.length; kept.push(...edit.newLines); }
    if (!gone.has(index)) kept.push(line);
  });

  // The new module: first comment, requires, the moved text, exports.
  const strict = /^(?:\s|\/\/.*|\/\*[\s\S]*?\*\/)*(['"])use strict\1/.test(text);
  const body = [...(strict ? ["'use strict';"] : []), ...wrapComment(about), '', ...required.lines];
  if (required.lines.length) body.push('');
  const moduleGlue = body.map((_, index) => index);
  const glueLine = (line) => { moduleGlue.push(body.length); body.push(line); };
  moved.forEach((record, i) => {
    const apart = i > 0 && record.range[0] !== moved[i - 1].range[1] + 1;
    if (apart && !blank(body.at(-1))) glueLine('');
    body.push(...rangeLines(record));
  });
  if (!blank(body.at(-1))) glueLine('');
  const exported = movedNames.filter((name) => !bindings.get(name).reassigned);
  for (const line of wrapNames(exported, 'module.exports = {', '};')) glueLine(line);
  if (body.length > maxLines) {
    throw new Refusal([`${target} would be ${body.length} lines, the limit for a new file is ${maxLines}: move fewer names per file, split by what they do`]);
  }
  return {
    newSource: kept.join('\n'), moduleText: `${body.join('\n')}\n`,
    moved: movedNames, exported, imported, ranges: moved.map((record) => record.range), requires: required.modules,
    glue: { sourceAt, sourceLines: sourceGlue, moduleLines: moduleGlue,
      edits: [...edits.values()].sort((a, b) => a.first - b.first).map(({ at, oldLines, newLines }) => ({ at, oldLines, newLines })) },
  };
}
