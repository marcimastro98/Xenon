// Reads load-registrations.json: the statements that run when a file loads but only hand
// over functions to be called once the server is up. The note in that file states the rule.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { createSpecRewriter } from './module-requires.mjs';
import { REPO_ROOT } from './parser.mjs';

const LIST = 'tools/restructure/load-registrations.json';
const INLINE_REQUIRE = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g;
const isText = (value) => typeof value === 'string' && value.trim() !== '';

/** @param {string} text @returns {string} the fingerprint kept in the list: SHA-256 of the text with LF line endings */
export function textHash(text) {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * The entries of one file, each with whether it still counts: every callee must be the
 * text that was read when the entry was written.
 * @param {string} file repo-relative, as the list names it
 * @param {object} [options]
 * @param {any} [options.json] the parsed list; the one in this folder when left out
 * @param {(file: string) => string} [options.read] reads a repo-relative file
 * @returns {{ statement: string, callees: string[], reason: string, current: boolean, problem: string }[]}
 */
export function registrationsFor(file, options = {}) {
  const read = options.read ?? ((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8'));
  const json = options.json ?? JSON.parse(read(LIST));
  return (json.files?.[file] ?? []).map((entry) => {
    const callees = entry.callees && typeof entry.callees === 'object' ? Object.entries(entry.callees) : [];
    let problem = '';
    if (!isText(entry.statement) || !isText(entry.reason) || callees.length === 0 || !callees.every(([, hash]) => isText(hash))) {
      problem = 'needs statement, reason and callees (each file with the sha256 of the text that was read)';
    }
    for (const [callee, hash] of problem ? [] : callees) {
      let text = null;
      try { text = read(callee); } catch { problem = `${callee} cannot be read`; }
      if (text !== null && textHash(text) !== hash) problem = `${callee} changed since it was read: read it again, then update its sha256`;
      if (problem) break;
    }
    return { statement: String(entry.statement ?? ''), callees: callees.map(([callee]) => callee), reason: String(entry.reason ?? ''),
      current: problem === '', problem };
  });
}

/**
 * @param {string} file repo-relative file whose requires are followed
 * @returns {(spec: string) => string | null} the repo-relative file a `require(spec)` written there loads, null when it is none
 */
export function repoFileOf(file) {
  const rewrite = createSpecRewriter(REPO_ROOT);
  return (spec) => {
    try { return rewrite(spec, file, file).file; } catch { return null; }
  };
}

// What a statement does that its entry does not cover: the list is only for statements whose
// every call, and every function they hand over, goes to a file someone read.
function uncovered(record, code, callees, bindings, fileOf) {
  const listed = new Set(callees);
  const specOf = (name) => bindings.get(name)?.record.require?.spec;
  const fromCallee = (name) => specOf(name) !== undefined && listed.has(fileOf(specOf(name)) ?? '');
  const wrong = [];
  for (const [name, use] of record.uses) {
    if (!use.called || !bindings.has(name) || fromCallee(name)) continue;
    if (specOf(name) === undefined || !isBuiltin(specOf(name))) wrong.push(`it calls ${name}, which is not from a file in callees`);
  }
  for (const name of record.handedTo ?? []) {
    if (name === 'require' ? bindings.has(name) : !fromCallee(name)) {
      wrong.push(name ? `it hands a function to ${name}, which is not from a file in callees` : 'it hands a function to a call the tool cannot name');
    }
  }
  for (const [, , spec] of code.matchAll(INLINE_REQUIRE)) {
    if (!isBuiltin(spec) && !listed.has(fileOf(spec) ?? '')) wrong.push(`it loads require('${spec}'), which is not in callees`);
  }
  return wrong;
}

/**
 * Marks the load-time statements the list covers with `registersOnly`. A statement is
 * found by its first line; an entry that matches none, or more than one, or that leaves
 * one of the statement's calls unread, marks nothing.
 * @param {any[]} records from top-level.mjs
 * @param {string} text the file's source
 * @param {{ statement: string, callees?: string[], current: boolean, problem?: string }[]} entries
 * @param {{ bindings: Map<string, any>, fileOf: (spec: string) => string | null }} names the file's top-level names and where its requires lead
 * @returns {string[]} what was wrong with entries that did not count
 */
export function markRegistrations(records, text, entries, { bindings, fileOf }) {
  const lines = text.split('\n');
  const problems = [];
  for (const entry of entries) {
    const say = (what) => problems.push(`"${entry.statement}": ${what}`);
    if (!entry.current) { say(entry.problem ?? 'not current'); continue; }
    const found = records.filter((record) => record.loadTime && lines[record.line[0] - 1].trim() === entry.statement.trim());
    if (found.length !== 1) { say(`${found.length} load-time statements start with this line, one is needed`); continue; }
    const code = lines.slice(found[0].line[0] - 1, found[0].line[1]).join('\n');
    const wrong = uncovered(found[0], code, entry.callees ?? [], bindings, fileOf);
    if (wrong.length) say(wrong.join('; '));
    else found[0].registersOnly = true;
  }
  return problems;
}

/**
 * The names whose code a load-time statement can reach while it runs. A statement on the
 * list runs only what it calls itself, never the functions it hands over.
 * @param {any} record
 * @returns {string[]}
 */
export function namesRunAtLoad(record) {
  if (!record.registersOnly) return [...record.uses.keys()];
  return [...record.uses].filter(([, use]) => use.called).map(([name]) => name);
}

/**
 * The names a statement on the list reads or hands over while it runs: they have to exist
 * by then, and none of their code runs.
 * @param {any} record
 * @returns {string[]}
 */
export function namesHeldAtLoad(record) {
  if (!record.registersOnly) return [];
  return [...record.uses].filter(([, use]) => use.eager && !use.called).map(([name]) => name);
}
