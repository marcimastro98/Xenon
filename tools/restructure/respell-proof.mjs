// The proof for the one kind of moved text that changes: a relative path asked for inside a moved function
// (`require('./net-guard')`), spelled again for the folder of the new module. Written apart from the planner
// (extract-inline.mjs): it reads the lines as text and follows both spellings to the file they reach.

const REQUIRE_CALL = /require\((['"])([^'"]+)\1\)/g;
const OPEN = 'require('.length;

/** @typedef {{ at: number, first: number, column: number, from: string, to: string }} Respell */

/**
 * @param {string} written the new module as the tool writes it
 * @param {Respell[]} respells
 * @returns {{ text: string, problems: string[] }} the module with every old spelling back, to be checked as a move of
 *   unchanged text; a problem for each spelling that is not where the plan says
 */
export function plainModule(written, respells) {
  if (respells.length === 0) return { text: written, problems: [] };
  const made = written.split('\n');
  const problems = [];
  // From the left: once one is back, the columns to its right are those of the old line again.
  for (const row of [...respells].sort((a, b) => a.at - b.at || a.column - b.column)) {
    const line = made[row.at];
    const quote = line?.[row.column];
    const end = row.column + 1 + row.to.length;
    if (line === undefined || (quote !== "'" && quote !== '"') || line.slice(row.column + 1, end) !== row.to || line[end] !== quote
      || line.slice(row.column - OPEN, row.column) !== 'require(') {
      problems.push(`line ${row.at + 1} of the new module does not ask for '${row.to}' where the plan says it spelled the path again`);
      continue;
    }
    made[row.at] = `${line.slice(0, row.column + 1)}${row.from}${line.slice(end)}`;
  }
  return { text: made.join('\n'), problems };
}

/**
 * @param {object} move
 * @param {string} move.before the old file before
 * @param {{ ranges: number[][], glue: { respells?: Respell[] } }} move.plan
 * @param {{ source: string, target: string, fileOf: (spec: string, from: string) => string | null }} [move.paths]
 * @returns {string[]} problems: a new spelling that does not reach the file the old one reached, a spelling changed
 *   outside the moved lines or outside a `require('...')`, or a relative path that moved as it was spelled and
 *   reaches another file from the new folder. Without `paths` and without respells nothing is asked (a move of a
 *   text made for a test, with no repo to follow paths in).
 */
export function respellProblems({ before, plan, paths }) {
  const respells = plan.glue.respells ?? [];
  if (!paths) return respells.length ? ['the plan spells paths again, and the proof was not told where the two files are'] : [];
  const { source, target, fileOf } = paths;
  const problems = [];
  const old = before.split('\n');
  const moved = new Set();
  for (const [start, end] of plan.ranges) for (let line = start; line <= end; line += 1) moved.add(line - 1);
  const told = new Map(respells.map((row) => [`${row.first}:${row.column}`, row]));
  if (told.size !== respells.length) problems.push('the plan spells the same path again twice');
  const seen = new Set();
  for (const index of [...moved].sort((a, b) => a - b)) {
    const line = old[index] ?? '';
    // A comment that shows a require is text, not a module asked for.
    if (/^\s*(?:\/\/|\*)/.test(line)) continue;
    for (const match of line.matchAll(REQUIRE_CALL)) {
      const spec = match[2];
      const key = `${index}:${match.index + OPEN}`;
      const row = told.get(key);
      if (row) seen.add(key);
      const now = row ? row.to : spec;
      if (row && row.from !== spec) problems.push(`line ${index + 1}: the plan says the path was '${row.from}', the old file says '${spec}'`);
      if (!spec.startsWith('.') && !row) continue;
      const [was, reached] = [fileOf(spec, source), fileOf(now, target)];
      if (!spec.startsWith('.') || !now.startsWith('.') || !was || was !== reached) {
        problems.push(`line ${index + 1}: require('${spec}') is require('${now}') in ${target}, which is not the same file`);
      }
    }
  }
  for (const [key, row] of told) {
    if (!seen.has(key)) problems.push(`line ${row.first + 1}: '${row.from}' was spelled again, and it is not a path asked for with require('...') in a moved line`);
  }
  return problems;
}
