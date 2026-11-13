// A ratchet: a number per key that may go down and never up.
// The type check, the lint and the file sizes all use this one rule, so
// "the code may only get better" means the same thing everywhere.

/**
 * Compares today's numbers with the saved ones.
 * @param {Record<string, number>} baseline saved numbers
 * @param {Record<string, number>} current today's numbers
 * @param {number} [allowedForNew] what a key with no saved number may reach
 * @returns {{ worse: {key: string, was: number, now: number}[], better: {key: string, was: number, now: number}[] }}
 */
export function compareCounts(baseline, current, allowedForNew = 0) {
  const worse = [];
  const better = [];
  for (const [key, now] of Object.entries(current)) {
    const known = Object.hasOwn(baseline, key);
    const was = known ? baseline[key] : allowedForNew;
    if (now > was) worse.push({ key, was: known ? was : 0, now });
    else if (known && now < was) better.push({ key, was, now });
  }
  for (const [key, was] of Object.entries(baseline)) {
    if (!Object.hasOwn(current, key)) better.push({ key, was, now: 0 });
  }
  const byKey = (a, b) => a.key.localeCompare(b.key);
  return { worse: worse.sort(byKey), better: better.sort(byKey) };
}

/**
 * The saved numbers after an update: only keys still over the allowance stay,
 * sorted so the file changes by one line when one number changes.
 * @param {Record<string, number>} current
 * @param {number} [allowedForNew]
 * @returns {Record<string, number>}
 */
export function nextBaseline(current, allowedForNew = 0) {
  const kept = Object.entries(current).filter(([, n]) => n > allowedForNew);
  return Object.fromEntries(kept.sort(([a], [b]) => a.localeCompare(b)));
}
