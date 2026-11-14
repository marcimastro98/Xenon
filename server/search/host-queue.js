'use strict';
// The queue in front of the Windows Search process, which answers one query at a time: one
// query is sent and waited for, and when its answer, its refusal or its timeout comes the one
// waiting is sent.

const { REQ_TIMEOUT_MS } = require('./search-limits.js');

function makeHostQueue({ host, rejectPending, retireHost, bumpIdle, ensureHost, hostQueue }) {
  function dispatch(job) {
    hostQueue.inFlight = true;
    const proc = ensureHost();
    if (!proc) { hostQueue.inFlight = false; job.reject(new Error('wds_unavailable')); drain(); return; }
    const id = host.nextId++;
    const timer = setTimeout(() => {
      rejectPending(id, new Error('search host timeout'));
      retireHost('search host timeout');
    }, REQ_TIMEOUT_MS);
    const settle = (fn) => (v) => { hostQueue.inFlight = false; fn(v); drain(); };
    host.pending.set(id, { resolve: settle(job.resolve), reject: settle(job.reject), timer });
    bumpIdle();
    try {
      proc.stdin.write(JSON.stringify({ id, q: job.q }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      host.pending.delete(id);
      hostQueue.inFlight = false;
      job.reject(e);
      drain();
    }
  }

  function drain() {
    if (hostQueue.inFlight || !hostQueue.waiting) return;
    const next = hostQueue.waiting;
    hostQueue.waiting = null;
    dispatch(next);
  }

  return { dispatch };
}

module.exports = { makeHostQueue };
