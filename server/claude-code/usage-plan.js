'use strict';
// The Claude plan the user picked for the usage tile: the presets, the cleaned setting and the
// weekly budget it gives.

// ── config normalization (used by settings + the widget) ─────────────────────
// The "remaining" gauge needs a weekly token ceiling. There is no official quota
// API, so the user picks one: a plan preset (a tunable estimate) or a custom
// budget. weeklyTokenBudget of 0 = "auto" (the reactor scales to observed usage
// instead of a fixed cap). The plan presets are STARTING POINTS the user adjusts.
const PLAN_PRESETS = Object.freeze({
  pro:   30000000,    // ~30M tok/week   (estimate — tune in Settings)
  max5:  300000000,   // ~300M tok/week  (estimate)
  max20: 1200000000,  // ~1.2B tok/week  (estimate)
});
const PLANS = Object.freeze(new Set(['custom', 'pro', 'max5', 'max20']));

const DEFAULT_CLAUDE = Object.freeze({
  plan: 'custom',
  weeklyTokenBudget: 0,     // 0 = auto-scale (no fixed cap)
  refreshSec: 60,
  tile: Object.freeze({ reactor: true, projects: true, cost: true }),
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeClaude(value) {
  const src = value && typeof value === 'object' ? value : {};
  const plan = PLANS.has(src.plan) ? src.plan : DEFAULT_CLAUDE.plan;
  // 0 (auto) or a real ceiling up to 100B/week. Non-finite → default.
  const weeklyTokenBudget = clampInt(src.weeklyTokenBudget, 0, 100000000000, DEFAULT_CLAUDE.weeklyTokenBudget);
  const refreshSec = clampInt(src.refreshSec, 20, 900, DEFAULT_CLAUDE.refreshSec);
  const srcTile = src.tile && typeof src.tile === 'object' ? src.tile : {};
  return {
    plan,
    weeklyTokenBudget,
    refreshSec,
    tile: {
      reactor: srcTile.reactor !== false,
      projects: srcTile.projects !== false,
      cost: srcTile.cost !== false,
    },
  };
}

// The effective weekly ceiling for a config: an explicit custom budget wins;
// otherwise the plan preset; 0 stays 0 ("auto"). Kept here so client + server
// agree on the number.
function effectiveWeeklyBudget(cfg) {
  const c = normalizeClaude(cfg);
  if (c.weeklyTokenBudget > 0) return c.weeklyTokenBudget;
  if (c.plan !== 'custom') return PLAN_PRESETS[c.plan] || 0;
  return 0;
}

module.exports = {
  PLAN_PRESETS, PLANS, DEFAULT_CLAUDE, clampInt, normalizeClaude, effectiveWeeklyBudget,
};
