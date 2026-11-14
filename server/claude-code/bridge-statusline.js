'use strict';
// What the statusline reports: the model, the context, the cost and the account's limits of a
// session.

const { str, num, pct, projectName } = require('./bridge-clamp.js');

function makeStatusline({ now, readings, touchSession, emit }) {
  // ── statusline feed ────────────────────────────────────────────────────────
  // Called on every assistant message (and on refreshInterval, when set). This
  // is where the real quota comes from.
  function applyStatus(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const rl = (d.rate_limits && typeof d.rate_limits === 'object') ? d.rate_limits : null;
    if (rl) {
      const five = (rl.five_hour && typeof rl.five_hour === 'object') ? rl.five_hour : {};
      const seven = (rl.seven_day && typeof rl.seven_day === 'object') ? rl.seven_day : {};
      const fivePct = pct(five.used_percentage);
      const sevenPct = pct(seven.used_percentage);
      // Only replace a known reading with another known reading: a session that
      // reports no rate_limits (API-key user, or before the first API response)
      // must not blank out a good value another session just gave us.
      // Each window is kept on its own: a post that carries only one of them
      // used to null the other out.
      if (fivePct !== null || sevenPct !== null) {
        const prev = readings.limits || {};
        readings.limits = {
          fiveHour: fivePct === null ? (prev.fiveHour || null) : { pct: fivePct, resetsAt: num(five.resets_at) },
          sevenDay: sevenPct === null ? (prev.sevenDay || null) : { pct: sevenPct, resetsAt: num(seven.resets_at) },
          at: now(),
        };
      }
    }

    const model = (d.model && typeof d.model === 'object') ? d.model : {};
    const cw = (d.context_window && typeof d.context_window === 'object') ? d.context_window : {};
    const cost = (d.cost && typeof d.cost === 'object') ? d.cost : {};
    const ws = (d.workspace && typeof d.workspace === 'object') ? d.workspace : {};
    const gitBranch = str(d.branch || ws.branch || (d.git && d.git.branch), 80);

    const statusCwd = str(d.cwd || ws.current_dir || ws.project_dir, 400);
    const patch = {
      cwd: statusCwd || undefined,
      project: projectName(statusCwd) || undefined,
      model: str(model.id || model.display_name, 60) || undefined,
      name: str(d.session_name, 80) || undefined,
      contextPct: pct(cw.used_percentage),
      cost: num(cost.total_cost_usd),
      // Already arriving on every statusline post and never read until now. It
      // is the one number that says what a session has actually DONE to the
      // repo, which no token count can.
      linesAdded: num(cost.total_lines_added),
      linesRemoved: num(cost.total_lines_removed),
    };
    if (gitBranch) patch.branch = gitBranch;
    // Strip anything we could not resolve, so an absent field never clobbers a
    // good value. context_window.used_percentage is documented as null early in
    // a session and again after /compact, and cost is absent for some providers
    // — holding the last known figure beats blanking the row.
    for (const k of Object.keys(patch)) if (patch[k] === undefined || patch[k] === null) delete patch[k];

    const s = touchSession(d.session_id, patch);
    if (s) emit();
    return !!s;
  }


  return { applyStatus };
}

module.exports = { makeStatusline };
