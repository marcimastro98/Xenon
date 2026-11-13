// Says, for every top-level declaration of a CommonJS file, what it reads, what it
// writes, which shared state it touches, and whether it can be taken out as is.

import { isBuiltin } from 'node:module';

import { afterLoadFor, afterLoadNames } from './after-load.mjs';
import { markRegistrations, namesHeldAtLoad, namesRunAtLoad, registrationsFor, repoFileOf } from './load-registrations.mjs';
import { readTopLevel } from './top-level.mjs';

// Names whose meaning depends on the file the code sits in.
export const FILE_BOUND = new Set(['__dirname', '__filename', 'require', 'module', 'exports']);
const CAN_MOVE = new Set(['function', 'class', 'const']);

/**
 * @param {string} text the file's source
 * @param {any} parser from parser.mjs
 * @param {string} [file] name shown in the result
 * @param {{ calls?: import('./load-time-calls.mjs').LoadTimeCalls, registrations?: { statement: string, callees?: string[], current: boolean }[],
 *   afterLoad?: ReturnType<typeof afterLoadFor>, fileOf?: (spec: string) => string | null }} [rules]
 *   what may run at load and still move, the load statements that only hand over functions, and the functions nothing
 *   runs while the file loads (with where a require of this file leads, to check them); the lists of this folder when left out
 * @returns {{ file: string, lineCount: number, records: any[], bindings: Map<string, any>, listProblems: string[],
 *   afterLoad: Set<string>, afterLoadProblems: string[] }}
 *   `afterLoad` are the functions of after-load.json whose entry passed every check, `afterLoadProblems` what was wrong with the others;
 *   `records` are the top-level statements with, added here: `deps` (other top-level
 *   names used), `requires` (required modules used), `writes`, `changes`, `state`,
 *   `fileBound`, `movable` and `blockers`.
 */
export function analyze(text, parser, file = 'file.js', rules = {}) {
  const records = readTopLevel(parser.parse(text, file), parser, rules.calls);
  const bindings = new Map();
  const duplicates = new Set();
  for (const record of records) {
    for (const name of record.names) {
      if (bindings.has(name)) duplicates.add(name);
      bindings.set(name, { name, record, kind: record.kind, reassigned: false, changed: false, shared: false, state: false });
    }
  }
  for (const record of records) {
    for (const [name, use] of record.uses) {
      const binding = bindings.get(name);
      if (!binding) continue;
      if (use.write > 0) binding.reassigned = true;
      if (use.change > 0 && binding.kind !== 'require') binding.changed = true;
    }
  }
  // A const that is never assigned again and whose value needs nothing from the file is one object for
  // everyone who requires it: changing it in place is seen by all, wherever the declaration lives.
  for (const binding of bindings.values()) {
    binding.shared = binding.kind === 'const' && !binding.reassigned && !duplicates.has(binding.name) && binding.record.selfContained
      && ![...binding.record.uses.keys()].some((name) => bindings.has(name));
    binding.state = binding.kind === 'let' || binding.kind === 'var' || binding.reassigned || (binding.changed && !binding.shared);
  }
  const fileOf = rules.fileOf ?? repoFileOf(file);
  const listProblems = markRegistrations(records, text, rules.registrations ?? registrationsFor(file), { bindings, fileOf });
  const served = afterLoadNames(records, text, rules.afterLoad ?? afterLoadFor(file), { bindings, fileOf });
  for (const record of records) describe(record, bindings, duplicates);
  markLateModules(records, bindings);
  settleMovable(records, bindings);
  return { file, lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), records, bindings, listProblems,
    afterLoad: served.names, afterLoadProblems: served.problems };
}

function describe(record, bindings, duplicates) {
  const own = new Set(record.names);
  const pick = (test) => [...record.uses].filter(([name, use]) => bindings.has(name) && test(name, use)).map(([name]) => name);
  record.requires = pick((name) => bindings.get(name).kind === 'require' && !own.has(name));
  record.deps = pick((name) => bindings.get(name).kind !== 'require' && !own.has(name));
  record.writes = pick((_name, use) => use.write > 0);
  record.changes = pick((name, use) => use.change > 0 && bindings.get(name).kind !== 'require');
  record.state = record.deps.filter((name) => bindings.get(name).state);
  record.fileBound = [...record.uses.keys()].filter((name) => FILE_BOUND.has(name) && !(record.kind === 'require' && name === 'require'));
  record.globals = [...record.uses.keys()].filter((name) => !bindings.has(name) && !FILE_BOUND.has(name));
  const blockers = [];
  const block = (code, names) => { if (!names || names.length) blockers.push(names ? { code, names } : { code }); };
  if (!CAN_MOVE.has(record.kind)) block(`is-a-${record.kind}`);
  else if (record.loadTime) block('runs-code-at-load');
  if (record.sharesLine) block('shares-a-line');
  block('bound-to-this-file', record.fileBound);
  block('declared-twice', record.names.filter((name) => duplicates.has(name)));
  if (CAN_MOVE.has(record.kind)) block('is-shared-state', record.names.filter((name) => bindings.get(name).state));
  block('reassigns', record.writes);
  block('changes-in-place', record.changes.filter((name) => !bindings.get(name).shared));
  block('reads-state', record.state.filter((name) => !record.writes.includes(name) && !record.changes.includes(name)));
  record.blockers = blockers;
}

// A new module is required before the first statement that may use it while the
// file loads, and that is only possible when every module it needs is loaded by
// then. A statement that runs at load "may use" whatever it can reach, callbacks
// it hands over included: nothing here can tell whether they are called at once,
// unless someone read the callee and put the statement in load-registrations.json.
function markLateModules(records, bindings) {
  const firstUse = new Map();
  for (const start of records) {
    if (!start.loadTime) continue;
    const seen = new Set([start]);
    const queue = [];
    const follow = (names) => {
      for (const name of names) {
        const next = bindings.get(name)?.record;
        if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
      }
    };
    follow(namesRunAtLoad(start));
    while (queue.length) follow(queue.pop().uses.keys());
    for (const name of namesHeldAtLoad(start)) if (bindings.has(name)) seen.add(bindings.get(name).record);
    for (const record of seen) if (!firstUse.has(record)) firstUse.set(record, start.index);
  }
  for (const record of records) {
    const before = firstUse.get(record);
    if (before === undefined || !CAN_MOVE.has(record.kind) || record.loadTime) continue;
    const late = record.requires.filter((name) => {
      const required = bindings.get(name).record;
      return required.index >= before && !isBuiltin(required.require.spec);
    });
    if (late.length) record.blockers.push({ code: 'needs-a-module-loaded-later', names: late, usedFromLine: records[before].line[0] });
  }
}

// A declaration can move when it is clean itself and so is everything it needs.
function settleMovable(records, bindings) {
  for (const record of records) record.movable = record.blockers.length === 0;
  for (let changed = true; changed;) {
    changed = false;
    for (const record of records) {
      if (!record.movable) continue;
      const stuck = record.deps.filter((name) => !bindings.get(name).record.movable);
      if (stuck.length === 0) continue;
      record.movable = false;
      record.blockers.push({ code: 'needs', names: stuck });
      changed = true;
    }
  }
}

/**
 * Everything `names` needs from the same file, themselves included, in file order.
 * @param {{bindings: Map<string, any>}} analysis
 * @param {string[]} names
 * @returns {any[]} records
 */
export function closureOf(analysis, names) {
  const seen = new Set();
  const queue = names.map((name) => analysis.bindings.get(name)?.record).filter(Boolean);
  while (queue.length) {
    const record = queue.pop();
    if (seen.has(record)) continue;
    seen.add(record);
    for (const name of record.deps) queue.push(analysis.bindings.get(name).record);
  }
  return [...seen].sort((a, b) => a.index - b.index);
}

/**
 * The plain-data form of an analysis, for `analyze --json`.
 * @param {ReturnType<typeof analyze>} analysis
 */
export function toJson(analysis) {
  const declarations = analysis.records.filter((r) => r.names.length > 0 && r.kind !== 'require').map((r) => ({
    names: r.names, kind: r.kind, line: r.line, range: r.range, lines: r.range[1] - r.range[0] + 1,
    reads: r.deps, requires: r.requires, writes: r.writes, changes: r.changes, state: r.state,
    fileBound: r.fileBound, loadTime: r.loadTime, loadTimeCalls: r.loadCalls, movable: r.movable, blockers: r.blockers,
  }));
  const statements = analysis.records.filter((r) => r.names.length === 0).map((r) => ({
    line: r.line, reads: r.deps, writes: r.writes, changes: r.changes,
  }));
  const state = [...analysis.bindings.values()].filter((b) => b.state)
    .map((b) => ({ name: b.name, kind: b.kind, line: b.record.line[0], reassigned: b.reassigned, changed: b.changed }));
  const movable = declarations.filter((d) => d.movable);
  return {
    file: analysis.file, lines: analysis.lineCount, listProblems: analysis.listProblems,
    totals: {
      declarations: declarations.length, statements: statements.length, state: state.length,
      movable: movable.length, movableLines: movable.reduce((sum, d) => sum + d.lines, 0),
    },
    movable: movable.flatMap((d) => d.names), state, declarations, statements,
  };
}
