// What the route check keeps of an answer, and how two records are compared.
//
// An answer is kept at the finest level that came out the same from two copies of
// the same engine: the whole body, or only its shape (which keys, what kind of
// value under each), or only the status and the kind of content. A clock, an id
// made at start or a reading of this PC differ from one start to the next without
// anything being wrong; what differs between two starts of the same code cannot
// tell a move apart from an accident, so it is left out of the comparison.

import { createHash } from 'node:crypto';

const short = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The shape of a JSON value: its keys in order of name and the kind of each value, never the values. */
export function shapeOf(value) {
  if (Array.isArray(value)) return value.length ? ['list of', shapeOf(value[0])] : ['list of', 'nothing'];
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOf(value[key])]));
}

/**
 * @param {{ status: number, type: string, body: Buffer } | null} answer null when nothing came back in time
 * @returns {{ status: number, type: string, bytes: number, body: string, shape: string | null }}
 */
export function kept(answer) {
  if (!answer) return { status: 0, type: 'no answer in time', bytes: 0, body: '', shape: null };
  let shape = null;
  try { shape = short(JSON.stringify(shapeOf(JSON.parse(answer.body.toString('utf8'))))); } catch { /* not JSON: no shape */ }
  return { status: answer.status, type: answer.type, bytes: answer.body.length, body: short(answer.body), shape };
}

/**
 * One record out of two runs of the same engine.
 * @param {Record<string, ReturnType<typeof kept>>} first @param {Record<string, ReturnType<typeof kept>>} second
 * @returns {Record<string, { level: 'body' | 'shape' | 'status' | 'unsteady', status?: number, type?: string, body?: string, shape?: string }>}
 */
export function settle(first, second) {
  const out = {};
  for (const label of Object.keys(first)) {
    const a = first[label];
    const b = second[label];
    if (!b || a.status !== b.status || a.type !== b.type) out[label] = { level: 'unsteady' };
    else if (a.body === b.body) out[label] = { level: 'body', status: a.status, type: a.type, body: a.body };
    else if (a.shape !== null && a.shape === b.shape) out[label] = { level: 'shape', status: a.status, type: a.type, shape: a.shape };
    else out[label] = { level: 'status', status: a.status, type: a.type };
  }
  return out;
}

const LEVELS = ['unsteady', 'status', 'shape', 'body'];

/** How many answers are kept at each level. */
export function levelCounts(answers) {
  return Object.fromEntries(LEVELS.toReversed().map((level) => [level, Object.values(answers).filter((answer) => answer.level === level).length]));
}

/**
 * @param {{ answers: Record<string, any>, shapes?: Record<string, string> }} before
 * @param {{ answers: Record<string, any>, shapes?: Record<string, string> }} after
 * @returns {string[]} what differs, one sentence each; empty when the two engines answer the same
 */
export function recordProblems(before, after) {
  const problems = [];
  const labels = new Set([...Object.keys(before.answers), ...Object.keys(after.answers)]);
  for (const label of [...labels].sort()) {
    const a = before.answers[label];
    const b = after.answers[label];
    if (!a || !b) { problems.push(`${label} was ${a ? 'asked before and not after' : 'asked after and not before'}`); continue; }
    const level = LEVELS[Math.min(LEVELS.indexOf(a.level), LEVELS.indexOf(b.level))];
    if (level === 'unsteady') continue;
    if (a.status !== b.status) problems.push(`${label} answered ${a.status} before and ${b.status} after`);
    else if (a.type !== b.type) problems.push(`${label} answered "${a.type}" before and "${b.type}" after`);
    else if (level === 'body' && a.body !== b.body) problems.push(`${label} answers the same status with another body`);
    else if (level === 'shape' && shapeAt(a, before, label) !== shapeAt(b, after, label)) problems.push(`${label} answers JSON with other keys or other kinds of values`);
  }
  return problems;
}

// An answer kept whole still has its shape on the side, so it can be compared with one kept by shape only.
function shapeAt(answer, record, label) {
  return answer.shape ?? record.shapes?.[label] ?? null;
}
