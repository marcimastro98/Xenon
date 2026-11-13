// Puts several extractions out of one file in an order that works: a new module
// that needs a name from another new module is made after it.

import { Refusal } from './extract-plan.mjs';

/**
 * @template {{ from: string, to: string, names: string[] }} Job
 * @param {Record<string, { file: string, names: string[] }[]>} ledger what was moved already, by source file
 * @param {Job[]} jobs
 * @returns {Job[]} the jobs still to do: one whose file the ledger already holds with the same names,
 *   in any order, was done by an earlier run that stopped half way
 */
export function pendingJobs(ledger, jobs) {
  const same = (a, b) => a.length === b.length && a.every((name) => b.includes(name));
  return jobs.filter((job) => !(ledger[job.from] ?? []).some((entry) => entry.file === job.to && same(entry.names, job.names)));
}

/**
 * @template {{ to: string, names: string[] }} Job
 * @param {{ bindings: Map<string, any> }} analysis from analyze.mjs, of the file the jobs take from
 * @param {Job[]} jobs
 * @returns {Job[]} the same jobs, dependencies first, otherwise in the order given
 */
export function orderJobs(analysis, jobs) {
  const owner = new Map();
  const reasons = [];
  jobs.forEach((job, index) => {
    for (const name of job.names) {
      const record = analysis.bindings.get(name)?.record;
      if (!record) continue; // extract says so itself, with the file name
      if (owner.has(record) && owner.get(record) !== index) reasons.push(`${name} is listed for ${jobs[owner.get(record)].to} and for ${job.to}`);
      owner.set(record, index);
    }
  });
  if (reasons.length) throw new Refusal(reasons);
  const needs = jobs.map(() => new Set());
  for (const [record, index] of owner) {
    for (const name of record.deps) {
      const other = owner.get(analysis.bindings.get(name).record);
      if (other !== undefined && other !== index) needs[index].add(other);
    }
  }
  const done = new Set();
  const ordered = [];
  while (ordered.length < jobs.length) {
    const next = jobs.findIndex((_job, index) => !done.has(index) && [...needs[index]].every((other) => done.has(other)));
    if (next === -1) {
      const stuck = jobs.filter((_job, index) => !done.has(index)).map((job) => job.to);
      throw new Refusal([`these new modules need each other, which would be a circular require: ${stuck.join(', ')}`]);
    }
    done.add(next);
    ordered.push(jobs[next]);
  }
  return ordered;
}
