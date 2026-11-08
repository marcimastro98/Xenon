// May the 7-day trial open this catalog entry? The site's copy of the rule, for the
// item pages built by tools/build-seo.mjs. The hub decides (trial-redeem.js
// trialCovers); the app's server/js/trial-pass-ui.js and docs/catalog/index.html
// carry the same rule, and server/test/site-trial-rule.test.mjs runs all three on
// one table so they cannot drift.

const FRESH_MS = 30 * 24 * 3600 * 1000;
const NEVER_IN_TRIAL = new Set(['feature-devclean']);

export function trialCovers(entry, now) {
  if (!entry || entry.limited || !(entry.locked || entry.supportersOnly)) return false;
  if (NEVER_IN_TRIAL.has(entry.id) || entry.trial === 'never') return false;
  if (entry.sparks > 0 && !entry.supportersOnly) return false;
  if (entry.trial === 'now' || String(entry.id || '').startsWith('feature-')) return true;
  const added = Date.parse(String(entry.addedAt || ''));
  return Number.isFinite(added) && now - added >= FRESH_MS;
}
