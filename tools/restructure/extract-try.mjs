// Asks the planner itself whether a set of declarations can leave a file in one step, without
// writing anything: `remainder --movable` uses it, so what it lists is what `extract` accepts.
// A declaration that can move alone may still be refused with others, because one new require
// has to stand above the first use of all of them.

import path from 'node:path';

import { planExtraction, Refusal } from './extract-plan.mjs';
import { protectedNames, quietModules, readLedger } from './ledger.mjs';
import { createSpecRewriter } from './module-requires.mjs';

/**
 * @param {object} job
 * @param {string} job.root repo root
 * @param {string} job.text the old file
 * @param {string} job.source its repo-relative path
 * @param {{ records: any[], bindings: Map<string, any> }} job.analysis from analyze.mjs, of the same text
 * @returns {(names: string[]) => string | null} the planner's reasons for refusing the set, null when it would move.
 *   The size of the new file is not asked: how to split by size is for whoever makes the move.
 */
export function moveRefusal({ root, text, source, analysis }) {
  const guard = protectedNames(root, source, analysis.records);
  const rewrite = createSpecRewriter(root);
  const ownModules = quietModules(readLedger(root).sources[source] ?? []);
  // A new module goes one folder under the old file, as every feature folder does.
  const target = path.posix.join(path.posix.dirname(source), 'a-feature', 'part.js');
  return (names) => {
    try {
      planExtraction({ text, analysis, names, source, target, about: 'Asked, not written.', rewrite, ownModules,
        protectedNames: guard.names, protectedStretches: guard.stretches, maxLines: Infinity });
      return null;
    } catch (error) {
      if (error instanceof Refusal) return error.reasons.join('; ');
      throw error;
    }
  };
}

/**
 * Puts declarations into as few sets as it finds, each of which the planner accepts as one step: every
 * declaration goes into the first set that still moves with it in.
 * @template T
 * @param {T[]} list in the order of the file
 * @param {(item: T) => string[]} namesOf
 * @param {(names: string[]) => string | null} refusal from moveRefusal
 * @returns {{ sets: T[][], alone: { item: T, reason: string }[] }} `alone`: refused even on their own, with the reason
 */
export function movableSets(list, namesOf, refusal) {
  const sets = [];
  const alone = [];
  for (const item of list) {
    const reason = refusal(namesOf(item));
    if (reason) { alone.push({ item, reason }); continue; }
    const home = sets.find((set) => refusal([...set.flatMap(namesOf), ...namesOf(item)]) === null);
    if (home) home.push(item); else sets.push([item]);
  }
  return { sets, alone };
}
