// When functions leave a wrapper, the old script may stop using a name it took back
// from a script made of the same wrapper before: the function that used it is gone.
//
//   js/leaf.js, before                         js/leaf.js, after `label` left for js/leaf/labels.js
//     const { LIMIT, STEP } = window.LeafSizes;  const { STEP } = window.LeafSizes;
//     function label(n) { ... LIMIT ... }        const { label } = window.LeafLabels;
//     function next(n) { return n + STEP; }      function next(n) { return n + STEP; }
//
// The planner rewrites that line to the names the old script still uses, and takes the
// line away when none is left (with the empty line under it). Nothing else of the line
// changes: the names keep their order, and it is written the way the tool writes it.
// A name no script takes any more stays on the line: somebody has to take what an
// earlier script hands over, or the standing check asks who does (a hand edit took
// its last user away, and that is for a person to look at).
//
// The proof does not trust the planner. It puts the old lines back where the plan says
// they were, proves the move on that text the way a move without a rewrite is proven
// (browser-inner-proof.mjs), and then holds the rewrite to what it may be: each old line
// was a line that takes names from an earlier script, the new one takes some of the same
// names in the same order, no name that went is used by the script any more, and every
// name that stayed is used, or taken by no later script.

import { takeLines, takeOf, takeText } from './browser-inner-takes.mjs';

const blank = (line) => line !== undefined && line.trim() === '';
const same = (a, b) => a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * The lines of an old script that take names from earlier scripts and would keep one nothing uses once `moved` has left.
 * @param {any} shell the wrapper of the old script @param {string} text of the same script
 * @param {Set<any>} moved the records that leave @param {string[]} order the names on window of the earlier scripts
 * @param {Set<string>} claimed `<Script>.<name>` for every name a script made of this wrapper before takes from another one
 * @returns {{ first: number, last: number, was: string[], now: string[] }[]} 0-based lines of `text`, in the order they stand
 */
export function retakesOf(shell, text, moved, order, claimed) {
  const lines = text.split('\n');
  const staying = shell.records.filter((record) => !moved.has(record));
  const leaves = (name) => [...moved].some((record) => record.uses.has(name));
  const found = [];
  for (const line of takeLines(shell, text)) {
    if (!order.includes(line.from)) continue;
    const kept = line.names.filter((name) => staying.some((record) => record !== line.record && record.uses.has(name)) || !(leaves(name) || claimed.has(`${line.from}.${name}`)));
    if (kept.length === line.names.length) continue;
    const first = shell.open + line.record.line[0];
    let last = shell.open + line.record.line[1];
    if (kept.length === 0 && blank(lines[last + 1])) last += 1;
    found.push({ first, last, was: lines.slice(first, last + 1), now: kept.length ? takeText(kept, line.from, shell.indent) : [] });
  }
  return found;
}

/**
 * The old script after the move with the rewritten lines as they were.
 * @param {string} after @param {{ glue: { at: number }, retakes: { at: number, was: string[], now: string[] }[] }} plan `at`: 0-based line of `after`
 * @returns {{ problems: string[], text: string, glueAt: number, places: { at: number, was: string[], now: string[] }[] }} `glueAt` and `places[].at`: lines of `text`
 */
export function undoRetakes(after, plan) {
  const lines = after.split('\n');
  const inOrder = [...plan.retakes].sort((a, b) => a.at - b.at);
  for (const retake of inOrder) {
    if (!same(lines.slice(retake.at, retake.at + retake.now.length), retake.now)) {
      return { problems: ['a line that takes names from an earlier script is not where the plan rewrote it'], text: after, glueAt: plan.glue.at, places: [] };
    }
  }
  let glueAt = plan.glue.at;
  let grown = 0;
  const places = [];
  for (const retake of inOrder) {
    places.push({ at: retake.at + grown, was: retake.was, now: retake.now });
    grown += retake.was.length - retake.now.length;
    // A line that went whole stands where the next line begins: it stood above the line the plan put in.
    if (retake.at <= plan.glue.at) glueAt += retake.was.length - retake.now.length;
  }
  for (const retake of [...inOrder].reverse()) lines.splice(retake.at, retake.now.length, ...retake.was);
  return { problems: [], text: lines.join('\n'), glueAt, places };
}

/**
 * Why a rewrite of the lines that take names from earlier scripts is not one the tool may make.
 * @param {object} job
 * @param {{ at: number, names: string[], from: string }[]} job.taking the lines of the old script that took names, with the rewrite undone: 0-based line, names, script
 * @param {{ at: number, was: string[], now: string[] }[]} job.places from undoRetakes
 * @param {any} job.now the wrapper of the old script as it is after the move @param {string} job.source
 * @param {Map<string, any>} job.known the names on window of the earlier scripts
 * @param {Set<string>} job.claimed `<Script>.<name>` for every name a later script of the wrapper takes, the new one included
 * @returns {string[]}
 */
export function retakeProblems({ taking, places, now, source, known, claimed }) {
  const problems = [];
  for (const place of places) {
    const line = taking.find((entry) => entry.at === place.at);
    if (!line || !known.has(line.from)) { problems.push(`${source}: a rewritten line was not one that takes names from a script made of the same wrapper before`); continue; }
    const indent = /^\s*/.exec(place.was[0])[0];
    const whole = takeText(line.names, line.from, indent);
    const kept = place.now.length ? takeOf(place.now) : { names: [], from: line.from };
    if (!same(place.was, whole) && !(kept?.names.length === 0 && same(place.was, [...whole, '']))) problems.push(`${source}: the line that took ${line.names.join(', ')} from window.${line.from} was not written the way the tool writes it`);
    if (!kept || kept.from !== line.from || kept.names.length >= line.names.length || !same(kept.names, line.names.filter((name) => kept.names.includes(name)))
      || !same(place.now, kept.names.length ? takeText(kept.names, line.from, indent) : [])) {
      problems.push(`${source}: the line that takes names from window.${line.from} was not rewritten to some of the same names in the same order`);
      continue;
    }
    for (const name of line.names) {
      const used = now.records.some((record) => record.uses.has(name) && !(record.names.includes(name) && record.kind === 'const'));
      if (kept.names.includes(name) && !used && claimed.has(`${line.from}.${name}`)) problems.push(`${source} still takes ${name} from window.${line.from} and uses it nowhere`);
      if (!kept.names.includes(name) && (used || now.bindings.has(name))) problems.push(`${source} no longer takes ${name} from window.${line.from}, and still ${used ? 'uses' : 'declares'} it`);
    }
  }
  return problems;
}
