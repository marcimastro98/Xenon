'use strict';
// Engine jobs that answer later: the request returns at once (`queued`) and
// the result comes as an event `{ event, token, ... }` (apps/capture, edit.rs).
// Shared by the gallery (previews, trims) and the covers (capture-covers.js).

function createEngineJobs(host, events, timers = { setTimeout, clearTimeout }) {
  const done = new Set(events);
  const jobs = new Map(); // token → { resolve, timer }

  function settle(token, ev) {
    const job = jobs.get(token);
    if (!job) return;
    jobs.delete(token);
    timers.clearTimeout(job.timer);
    job.resolve(ev);
  }

  host.onEvent((ev) => {
    if (!ev || typeof ev.event !== 'string') return;
    if (done.has(ev.event)) settle(String(ev.token || ''), ev);
    if (ev.event === 'engine_exited') for (const token of [...jobs.keys()]) settle(token, { error: 'engine_exited' });
  });

  // The event for `token`, `{ error: 'timeout' }` after `timeoutMs`, or the
  // request's own error code when the engine refused it.
  async function job(cmd, body, token, timeoutMs) {
    const result = new Promise((resolve) => {
      jobs.set(token, { resolve, timer: timers.setTimeout(() => settle(token, { error: 'timeout' }), timeoutMs) });
    });
    const reply = await host.request(cmd, { ...body, token });
    if (!reply || reply.ok !== true) {
      settle(token, null);
      return { error: (reply && reply.error) || 'failed' };
    }
    return result;
  }

  return { job };
}

module.exports = { createEngineJobs };
