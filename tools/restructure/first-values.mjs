#!/usr/bin/env node
// Records that variables of a state module (state.mjs) no longer get their first value in the file they were
// taken out of. The `state` step leaves a first value where its `let` stood when it cannot go to the module
// (`kept` in extracted.json), as a line `<object>.<property> = <value>` of the file. When a person later moves
// such lines into a function of another module, called where the file loads, the list still says `kept` and
// the tests that read the engine as text look for a `let` that is not there.
//
//   node tools/restructure/first-values.mjs --from <file> --object <name> --in <dir>/<feature>/<file>.js --by <function> [--dry-run]
//
// Nothing is rewritten: the files are read and, when what they say is so, the entry of the state module gains
// `firstValue: { <variable>: { file, by } }` for every variable of the object the function gives a value.
// `kept` stays as the step wrote it. The readers (server/test/engine-source.mjs) then hand such a variable out
// as declared without a value, which is what the file declares today. Refused, with every reason, unless:
//
//   - the file has no line of its own that starts by assigning the property any more;
//   - the function is declared at the top of the named module, is exported by it, and gives the property a
//     value on one line of its own body, once;
//   - the file requires the function from that module on one line and calls it on a line of its own,
//     with no arguments, where it loads.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readLedger, recordFirstValues } from './ledger.mjs';
import { REPO_ROOT } from './parser.mjs';

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} moduleText @param {string} by @returns {string[] | null} the lines of the function's body, or null */
function bodyOf(moduleText, by) {
  const lines = moduleText.split('\n');
  const head = lines.findIndex((line) => new RegExp(`^(?:async )?function ${escaped(by)}\\(\\) \\{$`).test(line));
  if (head === -1) return null;
  const end = lines.indexOf('}', head);
  return end === -1 ? null : lines.slice(head + 1, end);
}

/**
 * @param {object} job
 * @param {string} job.sourceText the file the variables were taken out of @param {string} job.makerText the module with the function
 * @param {string} job.source @param {string} job.file repo-relative paths of the two
 * @param {string} job.object @param {Record<string, string>} job.props variable to property, of the state entry
 * @param {string} job.by the function
 * @returns {{ names: string[], problems: string[] }} the variables the function gives a value, and what is not so
 */
export function checkFirstValues({ sourceText, makerText, source, file, object, props, by }) {
  const problems = [];
  const body = bodyOf(makerText, by);
  if (!body) return { names: [], problems: [`${file} declares no function ${by}() at its top`] };
  const exported = /^module\.exports = \{([^}]*)\};$/m.exec(makerText)?.[1].split(',').map((name) => name.trim()) ?? [];
  if (!exported.includes(by)) problems.push(`${file} does not export ${by}`);
  const assigns = (prop) => new RegExp(`^\\s*${escaped(object)}\\.${escaped(prop)}\\s*=(?![=>])`);
  const names = Object.keys(props).filter((name) => body.some((line) => assigns(props[name]).test(line)));
  if (names.length === 0) problems.push(`${by} gives no property of ${object} a value`);
  for (const name of names) {
    const prop = props[name];
    const times = makerText.split('\n').filter((line) => assigns(prop).test(line)).length;
    if (times !== 1) problems.push(`${file} assigns ${object}.${prop} ${times} times, once was expected`);
    if (sourceText.split('\n').some((line) => new RegExp(`^${escaped(object)}\\.${escaped(prop)}\\s*=(?![=>])`).test(line))) {
      problems.push(`${source} still gives ${object}.${prop} its first value on a line of its own`);
    }
  }
  const spec = path.posix.relative(path.posix.dirname(source), file);
  const asked = `const { ${by} } = require('${spec.startsWith('.') ? spec : `./${spec}`}');`;
  const lines = sourceText.split('\n');
  if (!lines.includes(asked)) problems.push(`${source} has no line \`${asked}\``);
  if (!lines.includes(`${by}();`)) problems.push(`${source} does not call ${by}() on a line of its own where it loads`);
  else if (lines.includes(asked) && lines.indexOf(`${by}();`) < lines.indexOf(asked)) problems.push(`${source} calls ${by}() above the line that requires it`);
  return { names, problems };
}

/**
 * @param {string} root @param {string} source
 * @returns {string[]} what the list says about first values given elsewhere that the files do not bear out
 */
export function firstValueProblems(root, source) {
  const read = (file) => readFileSync(path.join(root, file), 'utf8');
  const problems = [];
  for (const entry of (readLedger(root).sources[source] ?? []).filter((made) => made.state?.firstValue)) {
    const groups = new Map();
    for (const [name, where] of Object.entries(entry.state.firstValue)) {
      if (!(name in entry.state.props)) problems.push(`${entry.file}: ${name} is not a variable of ${entry.state.object}`);
      const key = `${where.file}\n${where.by}`;
      groups.set(key, [...(groups.get(key) ?? []), name]);
    }
    for (const [key, listed] of groups) {
      const [file, by] = key.split('\n');
      const found = checkFirstValues({ sourceText: read(source), makerText: read(file), source, file, object: entry.state.object, props: entry.state.props, by });
      problems.push(...found.problems.map((problem) => `${entry.file}: ${problem}`));
      const missing = listed.filter((name) => !found.names.includes(name));
      if (missing.length) problems.push(`${entry.file}: ${by} of ${file} gives no value to ${missing.join(', ')}`);
    }
  }
  return problems;
}

/**
 * @param {{ root: string, source: string, object: string, file: string, by: string, dryRun?: boolean }} job
 * @returns {{ names: string[], module: string, problems: string[] }} the variables recorded, and the state module they are of
 */
export function noteFirstValues({ root, source, object, file, by, dryRun = false }) {
  const entry = (readLedger(root).sources[source] ?? []).find((made) => made.state?.object === object);
  if (!entry) return { names: [], module: '', problems: [`the list has no state module of ${source} whose object is ${object}`] };
  const read = (name) => readFileSync(path.join(root, name), 'utf8');
  let found;
  try { found = checkFirstValues({ sourceText: read(source), makerText: read(file), source, file, object, props: entry.state.props, by }); }
  catch (error) { return { names: [], module: entry.file, problems: [`a file could not be read: ${error.message}`] }; }
  const moved = found.names.filter((name) => !entry.state.kept.includes(name));
  if (moved.length) found.problems.push(`${moved.join(', ')}: the step moved the first value to ${entry.file}, there is nothing to record`);
  if (found.problems.length === 0 && !dryRun) recordFirstValues(root, source, object, Object.fromEntries(found.names.map((name) => [name, { file, by }])));
  return { names: found.names, module: entry.file, problems: found.problems };
}

function main(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--dry-run' && argv[index].startsWith('--') && argv[index + 1] !== undefined) { flags[argv[index].slice(2)] = argv[index + 1]; index += 1; }
  }
  const wanted = ['from', 'object', 'in', 'by'];
  if (wanted.some((flag) => !flags[flag])) {
    const head = readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
    console.error(head.slice(0, head.findIndex((line) => !line.startsWith('//'))).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    return 2;
  }
  const dryRun = argv.includes('--dry-run');
  const posix = (file) => String(file).split('\\').join('/').replace(/^\.\//, '');
  const done = noteFirstValues({ root: REPO_ROOT, source: posix(flags.from), object: flags.object, file: posix(flags.in), by: flags.by, dryRun });
  if (done.problems.length) { console.error(`Refused:\n  ${done.problems.join('\n  ')}`); return 1; }
  console.log(`${dryRun ? 'would record' : 'recorded'}: ${done.names.join(', ')} of ${done.module} ${done.names.length === 1 ? 'gets its' : 'get their'} first value from ${flags.by}() of ${posix(flags.in)}.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
