// A declaration that asks for a module inside one of its functions (`require('./net-guard').armDeadline(...)`)
// is tied to its file by the spelling of that path only. It can move like any other when the path is
// spelled again for the new folder and still reaches the same file: that one piece of text is all that changes,
// and the module is still loaded the first time the function runs, not before.
//
// Read here: which declarations are of that kind (for analyze.mjs), and the new spelling of each path (for
// extract-plan.mjs). The proof that the new spelling reaches the same file is in verify.mjs, written apart.

/**
 * @typedef {{ from: string, line: number, column: number }} InlineRequire a relative path asked for inside the
 *   declaration: `line` and `column` are the 0-based place of its opening quote in the file
 */

/**
 * @param {any} record a top-level statement from top-level.mjs, with `fileBound` set
 * @param {any} node its node
 * @param {{ sourceFile: any, K: any, fileOf: (spec: string) => string | null }} file
 * @returns {{ list: InlineRequire[] | null, why: string }} the relative paths it asks for, when asking for modules is
 *   all that ties it to its file and every one can be spelled again; otherwise null and the reason ('' when it is
 *   tied by something else altogether)
 */
export function readInlineRequires(record, node, { sourceFile, K, fileOf }) {
  if (record.kind === 'require' || record.fileBound.length !== 1 || record.fileBound[0] !== 'require') return { list: null, why: '' };
  if (record.uses.get('require')?.eager) return { list: null, why: 'it asks for a module while the file loads, not inside a function' };
  const literals = [];
  let odd = 0;
  const visit = (at, parent) => {
    if (at.kind === K.Identifier && at.text === 'require') {
      const call = parent && parent.kind === K.CallExpression && parent.expression === at ? parent : null;
      const plain = call && call.arguments.length === 1 && call.arguments[0].kind === K.StringLiteral;
      // `{ require: 1 }` and `x.require` name a property, not the function.
      const isProperty = parent && ((parent.kind === K.PropertyAccessExpression && parent.name === at)
        || (parent.kind === K.PropertyAssignment && parent.name === at));
      if (plain) literals.push(call.arguments[0]);
      else if (!isProperty) odd += 1;
    }
    at.forEachChild((child) => visit(child, at));
  };
  visit(node, null);
  if (odd) return { list: null, why: "it uses require as something other than require('<text>')" };
  const list = [];
  for (const literal of literals) {
    if (!literal.text.startsWith('.')) continue;
    if (fileOf(literal.text) === null) return { list: null, why: `require('${literal.text}') reaches no file` };
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
    list.push({ from: literal.text, line, column: character });
  }
  return { list, why: '' };
}

/**
 * @param {{ glue: { respells?: { from: string, to: string }[] } }} plan
 * @returns {Record<string, string> | null} new spelling to old, as the list of moves records it (`spelled`): null when the
 *   move spelled nothing again. Throws when two old spellings became one, which could not be told apart afterwards.
 */
export function spelledOf(plan) {
  const rows = plan.glue.respells ?? [];
  if (rows.length === 0) return null;
  const spelled = {};
  for (const { from, to } of [...rows].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0))) {
    if (spelled[to] !== undefined && spelled[to] !== from) throw new Error(`'${spelled[to]}' and '${from}' are two spellings of ${to}: spell them alike first`);
    spelled[to] = from;
  }
  return spelled;
}

/**
 * @param {any[]} moved the records that move, each with `inlineRequires` from the analysis
 * @param {object} job
 * @param {string} job.source repo-relative old file
 * @param {string} job.target repo-relative new module
 * @param {(spec: string, from: string, to: string) => { spec: string, file: string | null }} job.rewrite from module-requires.mjs
 * @param {(file: string | null) => string | null} [job.readFile] the text of a repo file, to look into what is asked for
 * @returns {{ respells: { record: any, from: string, to: string, file: string | null, line: number, column: number }[], reasons: string[] }}
 *   every relative path with its spelling for the new folder; `reasons` why the set cannot move
 */
export function respellsFor(moved, { source, target, rewrite, readFile = () => null }) {
  const respells = [];
  const reasons = [];
  for (const record of moved) {
    for (const asked of record.inlineRequires ?? []) {
      let to;
      try { to = rewrite(asked.from, source, target); } catch (error) { reasons.push(`${source}:${asked.line + 1}: ${error.message}`); continue; }
      // A module can ask who required it first: that would be the new module now.
      if (/\bmodule\s*\.\s*parent\b/.test(readFile(to.file) ?? '')) {
        reasons.push(`${source}:${asked.line + 1}: ${to.file} reads module.parent, which would be the new module`);
      }
      respells.push({ record, ...asked, to: to.spec, file: to.file });
    }
  }
  return { respells, reasons: [...new Set(reasons)] };
}

/**
 * Writes the new spellings into the lines of the new module.
 * @param {string[]} body the lines of the new module, changed in place
 * @param {ReturnType<typeof respellsFor>['respells']} respells
 * @param {(record: any) => number} moduleLineOf 0-based line of the new module where the record's first line stands
 * @returns {{ at: number, first: number, column: number, from: string, to: string }[]} what changed, by line of the new module
 *   (`at`) and then by column: `first` and `column` are the place of the opening quote in the old file
 */
export function writeRespells(body, respells, moduleLineOf) {
  const rows = respells.filter((row) => row.to !== row.from)
    .map(({ record, from, to, line, column }) => ({ at: moduleLineOf(record) + line - (record.range[0] - 1), first: line, column, from, to }));
  // From the right, so the columns to the left of each stay the ones of the old line.
  for (const row of [...rows].sort((a, b) => b.at - a.at || b.column - a.column)) {
    const line = body[row.at];
    body[row.at] = `${line.slice(0, row.column + 1)}${row.to}${line.slice(row.column + 1 + row.from.length)}`;
  }
  return rows.sort((a, b) => a.at - b.at || a.column - b.column);
}
