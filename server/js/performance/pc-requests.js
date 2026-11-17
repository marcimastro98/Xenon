// The two requests that change the PC for a session: the power plan, and the allowlisted
// Performance actions (priority, close, relaunch, is it running).
'use strict';

(() => {
  async function powerPlan(method, value) {
    const opts = { method };
    if (value != null) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify({ value });
    }
    const res = await fetch(SERVER + '/api/performance/powerplan', opts);
    return res.json().catch(() => ({ ok: false }));
  }

  async function perfAction(action) {
    const res = await fetch(SERVER + '/actions/perf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    return res.json().catch(() => ({ ok: false }));
  }

  window.PerformancePcRequests = { powerPlan, perfAction };
})();
