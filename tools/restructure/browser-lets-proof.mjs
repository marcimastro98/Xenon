// Proves a rewrite of a wrapper's lets into one object (browser-lets-plan.mjs)
// from the two texts, without trusting how the plan was made:
//   1. undone, the script is the old script byte for byte: the object goes, the
//      names come back, the declarations return to their lines;
//   2. the object holds exactly the values that left, as they were written, with
//      their comments, and a row for every first value that stayed in its place;
//   3. read again from nothing, no old name is declared or used, and the object
//      is used exactly as often as the old names were found, always as one of
//      the new properties.

import { readWrapper } from './browser-inner-plan.mjs';
import { keptLine, KEPT_NOTE } from './browser-lets-plan.mjs';
import { commentMentions, readReferences, tokenRanges } from './state-refs.mjs';
import { statePattern, undoStateText } from './state-undo.mjs';

/**
 * @param {{ before: string, after: string, plan: ReturnType<typeof import('./browser-lets-plan.mjs').planLets>, parser: any, source: string }} job
 * @returns {string[]} what does not hold; empty when the rewrite is proven
 */
export function proveLets({ before, after, plan, parser, source }) {
  const problems = [];
  const { object, names, kept, counts, glue, removed, indent } = plan;
  const state = { object, props: Object.fromEntries(names.map((name) => [name, name])), kept: [] };

  // 1. Undone, the script is the old script.
  const now = after.split('\n');
  if (now.slice(glue.at, glue.at + glue.lines.length).join('\n') !== glue.lines.join('\n')) problems.push('the object is not where the plan put it');
  now.splice(glue.at, glue.lines.length);
  let undone = undoStateText(now.join('\n'), state);
  for (const name of kept) undone = undone.replace(keptLine(indent, name), () => `${indent}let ${name}`);
  const rows = undone.split('\n');
  for (const block of [...removed].sort((a, b) => a.line - b.line)) rows.splice(block.line, 0, ...block.lines);
  if (rows.join('\n') !== before) problems.push('undoing the rewrite does not give the old script back byte for byte');

  // 2. The object holds every value that left, as it was written, with its comments, and nothing else.
  const expected = [`${indent}const ${object} = {`];
  for (const name of names) {
    const block = removed.find((entry) => entry.name === name);
    if (!block) { expected.push(`${indent}  ${name}: undefined, // ${KEPT_NOTE}`); continue; }
    const code = block.lines.findIndex((line) => line.startsWith(`${indent}let `));
    const written = `${indent}let ${name}${block.value === null ? '' : `${block.eq}${block.value}`};${block.trail}`;
    if (block.lines[code] !== written) problems.push(`${name}: the declaration that left is not the one the plan describes`);
    if (block.lines.slice(code + 1).some((line) => line.trim() !== '')) problems.push(`${name}: code after the declaration left with it`);
    if (block.lines.slice(0, code).some((line) => !line.trimStart().startsWith('//'))) problems.push(`${name}: something other than its comment left with it`);
    expected.push(...block.lines.slice(0, code).map((line) => `  ${line}`), `${indent}  ${name}: ${block.value ?? 'undefined'},${block.trail}`);
  }
  expected.push(`${indent}};`);
  // A comment that came along may name a variable by its new name: with the old names back it is the old comment.
  const held = glue.lines.slice(0, glue.lines.at(-1) === '' ? -1 : glue.lines.length).map((row) => undoStateText(row, state));
  if (held.join('\n') !== expected.join('\n')) problems.push('the object does not hold exactly the values that left their lines');

  // 3. Read again from nothing.
  const shell = readWrapper(after, source, parser);
  if (shell.problems.length) return [...problems, ...shell.problems];
  const own = shell.bindings.get(object)?.record;
  if (own?.kind !== 'const' || own.names.length !== 1 || own.fixed.reasons.length || own.fixed.reads.length) problems.push(`${object} is not a constant whose value is written out`);
  for (const name of names) {
    if (shell.bindings.has(name)) problems.push(`${name} is still declared`);
    if (shell.records.some((record) => record.uses.has(name))) problems.push(`${name} is still used`);
  }
  const seen = Object.fromEntries(names.map((name) => [name, 0]));
  for (const use of readReferences(shell.tree, parser, new Set([object]), object, shell.inside)) {
    const prop = /^\.([A-Za-z_$][\w$]*)/.exec(after.slice(use.end, use.end + 200))?.[1];
    if (prop && Object.hasOwn(seen, prop)) seen[prop] += 1;
    else problems.push(`${object} is used at offset ${use.start} as something other than one of the new properties`);
  }
  const ranges = tokenRanges(shell.tree, parser);
  for (const [name, count] of Object.entries(counts)) {
    const wanted = count.found + (count.moved ? 0 : 1);
    if (seen[name] !== wanted) problems.push(`${name}: ${count.found} uses were found, the new text has ${seen[name]} of ${object}.${name} (${wanted} expected)`);
    // As text the new name stands once for each use and once for each comment that named the variable, nowhere else:
    // not in a string, not in a property of something else.
    const inComments = commentMentions(after, ranges, `${object}.${name}`).length;
    if (inComments !== count.mentions) problems.push(`${name}: ${count.mentions} comments named it, ${inComments} name ${object}.${name} now`);
    const asText = (after.match(statePattern(object, name)) ?? []).length;
    if (asText !== wanted + count.mentions) problems.push(`${name}: the text ${object}.${name} stands ${asText} times in the new script, ${wanted + count.mentions} expected`);
  }
  return problems;
}

/**
 * @param {string} text a script at some revision @param {{ file: string, object: string, names: string[] }} move a recorded rewrite
 * @param {any} parser @returns {boolean} true when that text has the rewrite: its wrapper has the object and none of the lets
 */
export function letsDone(text, move, parser) {
  const shell = readWrapper(text, move.file, parser);
  return shell.problems.length === 0 && shell.bindings.get(move.object)?.kind === 'const' && !move.names.some((name) => shell.bindings.has(name));
}
