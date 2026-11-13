// Reads after-load.json: the functions that nothing runs while their file loads.
// The note in that file states the rule. What can be checked is checked here, and an
// entry that fails one check counts for nothing: the function is then held like any
// other that a load statement can reach.

import { readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';

import { textHash } from './load-registrations.mjs';
import { REPO_ROOT } from './parser.mjs';

const LIST = 'tools/restructure/after-load.json';
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const pairs = (value) => (value && typeof value === 'object' ? Object.entries(value) : []);
// `server.emit('request', ...)` runs the listeners of a server by hand, at once.
const EMITS_REQUEST = /\.emit\(\s*(['"`])request\1/;

/**
 * The entries of one file, each with what is wrong with it before the file itself is read.
 * @param {string} file repo-relative, as the list names it
 * @param {object} [options]
 * @param {any} [options.json] the parsed list; the one in this folder when left out
 * @param {(file: string) => string} [options.read] reads a repo-relative file
 * @returns {{ name: string, statements: [string, string][], read: string[], reason: string, problem: string }[]}
 */
export function afterLoadFor(file, options = {}) {
  const read = options.read ?? ((name) => readFileSync(path.join(REPO_ROOT, name), 'utf8'));
  const json = options.json ?? JSON.parse(read(LIST));
  return (json.files?.[file] ?? []).map((entry) => {
    const [statements, files] = [pairs(entry.statements), pairs(entry.read)];
    let problem = '';
    if (!isText(entry.name) || !isText(entry.reason) || statements.length === 0 || ![...statements, ...files].every(([, hash]) => isText(hash))) {
      problem = 'needs name, reason, statements (the first line of each, with the sha256 of the whole statement) and read (each file with the sha256 of its text)';
    }
    for (const [name, hash] of problem ? [] : files) {
      let text = null;
      try { text = read(name); } catch { problem = `${name} cannot be read`; }
      if (text !== null && textHash(text) !== hash) problem = `${name} changed since it was read: read it again, then update its sha256`;
      if (problem) break;
    }
    return { name: String(entry.name ?? ''), statements, read: files.map(([name]) => name), reason: String(entry.reason ?? ''), problem };
  });
}

// What the file itself says against an entry.
function entryProblems(entry, records, lines, bindings, fileOf) {
  const binding = bindings.get(entry.name);
  if (!binding) return ['the file does not declare it at its top'];
  const wrong = [];
  if (records.filter((record) => record.names.includes(entry.name)).length !== 1) wrong.push('the file declares it more than once');
  if (binding.reassigned) wrong.push('the file assigns it again after declaring it');
  if (binding.kind !== 'const' && binding.kind !== 'function') wrong.push(`it is declared with \`${binding.kind}\``);
  const listed = new Map(entry.statements.map(([first, hash]) => [first.trim(), hash]));
  const found = new Set();
  const specOf = (name) => bindings.get(name)?.record.require?.spec;
  for (const record of records) {
    const use = record === binding.record ? undefined : record.uses.get(entry.name);
    if (!use) continue;
    const at = `line ${record.line[0]}`;
    const first = lines[record.line[0] - 1].trim();
    if (!listed.has(first)) { wrong.push(`${at} names it and is not in statements`); continue; }
    if (found.has(first)) wrong.push(`${at} starts like another statement that names it`);
    found.add(first);
    if (textHash(lines.slice(record.line[0] - 1, record.line[1]).join('\n')) !== listed.get(first)) {
      wrong.push(`${at} changed since it was read: read it again, then update its sha256`);
    }
    if (use.eager) wrong.push(`${at} names it outside a function, so the line itself may run it or give it away`);
    if (!record.loadTime) wrong.push(`${at} declares something that names it, and anything may call that`);
    for (const to of record.handedTo ?? []) {
      const spec = specOf(to);
      if (spec === undefined) wrong.push(`${at} hands a function to ${to || 'a call the tool cannot name'}, which is not a module the file requires`);
      else if (!isBuiltin(spec) && !entry.read.includes(fileOf(spec) ?? '')) wrong.push(`${at} hands a function to ${to}, which is not from a file in read`);
    }
  }
  for (const first of listed.keys()) if (!found.has(first)) wrong.push(`no statement that names it starts with ${JSON.stringify(first)}`);
  if (EMITS_REQUEST.test(lines.join('\n'))) wrong.push("the file emits 'request' by hand, which runs the listeners of a server at once");
  return wrong;
}

/**
 * The functions of a file that nothing can run while the file loads.
 * @param {any[]} records from top-level.mjs
 * @param {string} text the file's source
 * @param {ReturnType<typeof afterLoadFor>} entries
 * @param {{ bindings: Map<string, any>, fileOf: (spec: string) => string | null }} names the file's top-level names and where its requires lead
 * @returns {{ names: Set<string>, problems: string[] }} the names whose entry passed every check, and what was wrong with the others
 */
export function afterLoadNames(records, text, entries, { bindings, fileOf }) {
  const lines = text.split('\n');
  const names = new Set();
  const problems = [];
  for (const entry of entries) {
    const wrong = entry.problem ? [entry.problem] : entryProblems(entry, records, lines, bindings, fileOf);
    if (wrong.length) problems.push(...wrong.map((what) => `${entry.name || '(no name)'}: ${what}`));
    else names.add(entry.name);
  }
  return { names, problems };
}
