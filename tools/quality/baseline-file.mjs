// Reads and writes a saved list of numbers (a baseline) the same way for every check.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nextBaseline } from './ratchet.mjs';

/** @param {Record<string, number>} counts @returns {number} */
export function sum(counts) {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

/** @param {string} file @returns {Record<string, number>} empty when nothing was saved yet */
export function readCounts(file) {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, 'utf8')).counts ?? {};
}

/**
 * @param {string} file
 * @param {string} note one line saying what the numbers are
 * @param {Record<string, number>} counts
 * @returns {number} the total saved
 */
export function saveCounts(file, note, counts) {
  const kept = nextBaseline(counts);
  writeFileSync(file, `${JSON.stringify({ note, total: sum(kept), counts: kept }, null, 2)}\n`);
  return sum(kept);
}
