'use strict';
// What the Xenon mod inside Claude Code reports: the key of an approval it handed back, and its
// usage measure as the status the tile reads.

const { str } = require('./bridge-clamp.js');

// How long after a mod approval is handed back the hook's own request for the
// same call is still recognised as that call (takeHandBack).
const HANDBACK_MS = 10 * 1000;
function handBackKey(sessionId, tool) { return sessionId + '|' + tool; }

// A mod `measure` message in the statusline's shape, so applyStatus stays the
// one place quota and context are read. The mod reports reset times as ISO
// 8601; the statusline (and the widget) use epoch seconds.
const MOD_LIMIT_KINDS = { five_hour: 'five_hour', seven_day: 'seven_day' };
function modMeasureAsStatus(sessionId, d) {
  const rate = {};
  for (const w of Array.isArray(d.rateLimits) ? d.rateLimits.slice(0, 4) : []) {
    const key = w && MOD_LIMIT_KINDS[w.kind];
    if (!key) continue;
    const resetMs = Date.parse(str(w.resetsAt, 40));
    rate[key] = {
      used_percentage: w.percentUsed,
      // undefined, not null: num(null) reads as 0, a reset at the epoch.
      resets_at: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : undefined,
    };
  }
  return {
    session_id: sessionId,
    context_window: { used_percentage: d.contextPct },
    cost: { total_cost_usd: d.costUsd },
    ...(Object.keys(rate).length ? { rate_limits: rate } : {}),
  };
}

module.exports = { HANDBACK_MS, handBackKey, MOD_LIMIT_KINDS, modMeasureAsStatus };
