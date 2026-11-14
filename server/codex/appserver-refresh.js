'use strict';
// What the Codex app-server is asked on a clock: the account, the limits, the usage, the
// conversations and the hooks read when each is due, and the next read planned.

const {
  LIMITS_VISIBLE_MS, LIMITS_HIDDEN_MS, USAGE_MS, THREADS_VISIBLE_MS, THREADS_HIDDEN_MS,
  HOOKS_TTL_MS,
} = require('./appserver-limits.js');
const { MAX_THREADS, parseThreads } = require('./appserver-parse-threads.js');
const {
  parseAccount, parseRateLimits, parseUsage, parseHooks,
} = require('./appserver-parse-account.js');

function makeRefresh({
  isOurHook, now, setTimer, clearTimer, log, caRun, caps, data, busy, changed, setState, ask,
}) {
  // ── refreshes ──
  async function refresh(kind) {
    if (busy[kind] || !caRun.rpc) return;   // skip, never queue: a slow answer must not pile up
    busy[kind] = true;
    try {
      if (kind === 'account') {
        const r = await ask('account/read', { refreshToken: false });
        if (r !== undefined) {
          data.account = parseAccount(r);
          if (data.account.signedIn === false) setState('signedOut', '');
          else if (caRun.state === 'signedOut') setState('ready');
        }
      } else if (kind === 'limits') {
        const r = await ask('account/rateLimits/read', {});
        if (r !== undefined) { data.limits = parseRateLimits(r); data.limitsAt = now(); }
      } else if (kind === 'usage') {
        const r = await ask('account/usage/read', {});
        if (r !== undefined) { data.usage = parseUsage(r, now()); data.usageAt = now(); }
      } else if (kind === 'threads') {
        const r = await listThreads();
        if (r !== undefined) { data.threads = parseThreads(r); data.threadsAt = now(); }
      } else if (kind === 'hooks') {
        const r = await ask('hooks/list', {});
        if (r !== undefined) { data.hooks = parseHooks(r, isOurHook); data.hooksAt = now(); }
      }
      changed();
    } catch (e) {
      log('codex app-server: ' + kind + ': ' + ((e && e.message) || e));
    } finally {
      busy[kind] = false;
    }
  }

  // By last activity where this copy knows the key. An older one refuses an
  // unknown sort key as a bad request; that must cost the order, never the
  // list, so the refusal is caught here instead of going through ask(), which
  // would mark thread/list itself as missing.
  async function listThreads() {
    const params = { limit: MAX_THREADS + 8, archived: false };
    if (caRun.byRecency && caps['thread/list'] !== false) {
      try { return await caRun.rpc.call('thread/list', Object.assign({ sortKey: 'recency_at' }, params)); } catch (e) {
        if (!(e && e.rpc)) throw e;
        caRun.byRecency = false;
      }
    }
    return ask('thread/list', params);
  }

  function due(at, every) { return !at || now() - at >= every; }
  async function tick() {
    caRun.tickTimer = null;
    if (!caRun.rpc || caRun.stopped) return;
    if (caRun.state !== 'signedOut') {
      const v = caRun.demand.visible;
      const jobs = [];
      if (due(data.limitsAt, v ? LIMITS_VISIBLE_MS : LIMITS_HIDDEN_MS)) jobs.push(refresh('limits'));
      if (due(data.usageAt, USAGE_MS)) jobs.push(refresh('usage'));
      if (due(data.threadsAt, v ? THREADS_VISIBLE_MS : THREADS_HIDDEN_MS)) jobs.push(refresh('threads'));
      if (due(data.hooksAt, HOOKS_TTL_MS * 4)) jobs.push(refresh('hooks'));
      await Promise.all(jobs);
    } else {
      // Signed out: check now and then whether the user signed in.
      await refresh('account');
    }
    schedule(caRun.demand.visible ? 10000 : 30000);
  }
  function schedule(ms) {
    clearTimer(caRun.tickTimer);
    if (!caRun.rpc || caRun.stopped) return;
    caRun.tickTimer = setTimer(() => { tick(); }, ms);
  }

  // Link status asks this right after a link: fresh, but never more than the TTL.
  async function hooksStatus({ fresh = false } = {}) {
    if (!caRun.rpc) return data.hooks;
    if (fresh || due(data.hooksAt, HOOKS_TTL_MS)) await refresh('hooks');
    return data.hooks;
  }

  return { refresh, schedule, hooksStatus };
}

module.exports = { makeRefresh };
