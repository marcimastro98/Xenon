// Several browser moves as one: the whole plan is worked out in memory first, each move judged after the ones
// before it, and written only when none was refused. A move that fails a check after it was written takes the
// moves written before it back too, so a plan leaves the tree either done or as it found it.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { newPlan, perform } from './browser-extract.mjs';
import { BROWSER_LEDGER } from './browser-ledger.mjs';

const textOf = (root, file) => (existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : null);

/** Puts every file back as `before` has it: its text, or gone when it had none (with the folder the plan made for it). */
function putBack(root, before) {
  for (const [file, text] of before) {
    const full = path.join(root, file);
    if (text !== null) { mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, text); continue; }
    rmSync(full, { force: true });
    const folder = path.dirname(full);
    if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  }
}

/**
 * @param {{ root: string, parser: any, jobs: any[], moveOf: (job: any, plan: ReturnType<typeof newPlan> | null) => any, dryRun?: boolean }} job
 *   `moveOf` turns one entry of the plan into a move, reading the files as the moves before it leave them (`plan`, or the disk when null)
 * @returns {{ move: any, done: ReturnType<typeof perform> }[]} one per entry, in order. Throws what the first move that cannot be done throws,
 *   with nothing written (a refusal) or everything put back (a failed check).
 */
export function performPlan({ root, parser, jobs, moveOf, dryRun = false }) {
  const plan = newPlan();
  const tried = jobs.map((job) => {
    const move = moveOf(job, plan);
    return { move, done: perform({ root, parser, move, dryRun: true, plan }) };
  });
  if (dryRun) return tried;
  const before = new Map([...plan.texts.keys(), BROWSER_LEDGER].map((file) => [file, textOf(root, file)]));
  try {
    return jobs.map((job) => {
      const move = moveOf(job, null);
      return { move, done: perform({ root, parser, move }) };
    });
  } catch (error) {
    putBack(root, before);
    throw error;
  }
}
