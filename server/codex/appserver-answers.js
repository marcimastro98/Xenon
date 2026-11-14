'use strict';
// What the Codex app-server answers the dashboard with: one conversation read with the turn
// that is still running, whether a conversation is one it listed, and the state the tile is
// drawn from.

const { parseTurns } = require('./appserver-parse-threads.js');

function makeAnswers({ caRun, caps, data, ask, start }) {
  // One conversation, read on request (a tap on the tile). Only a thread this
  // module listed, or one the caller vouches for (a session the hooks report),
  // so the route is never a way to read an arbitrary id.
  // `running`: the newest turn is still going, so the tile reads again soon.
  async function readThread(threadId) {
    if (!caRun.rpc) await start();
    if (!caRun.rpc) return { ok: false, error: caRun.state === 'missing' ? 'missing' : 'unavailable' };
    const r = await ask('thread/turns/list', { threadId, limit: 15, sortDirection: 'desc', itemsView: 'summary' })
      .catch((e) => ({ __error: String((e && e.message) || e) }));
    if (r === undefined) return { ok: false, error: 'unsupported' };
    if (r && r.__error) return { ok: false, error: 'failed' };
    const turns = Array.isArray(r && r.data) ? r.data : [];
    const newest = turns.reduce((a, t) => (t && (!a || (Number(t.startedAt) || 0) > (Number(a.startedAt) || 0)) ? t : a), null);
    const running = !!newest && newest.status === 'inProgress';
    if (running) await withLiveItems(threadId, newest);
    return { ok: true, running, messages: parseTurns(r) };
  }
  // The running turn's full items, for its interim notes. Best effort: a turn
  // whose command output makes the page too big to read keeps its summary.
  async function withLiveItems(threadId, turn) {
    const f = await ask('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' }).catch(() => undefined);
    const full = f && Array.isArray(f.data) ? f.data[0] : null;
    if (full && full.id === turn.id && Array.isArray(full.items)) turn.items = full.items;
  }
  function knowsThread(id) { return !!(data.threads && data.threads.some((t) => t.id === id)); }

  function snapshot() {
    return {
      state: caRun.state,
      reason: caRun.reason,
      version: caRun.version,
      account: data.account ? { signedIn: data.account.signedIn, type: data.account.type, plan: data.account.plan } : null,
      limits: data.limits,
      limitsAt: data.limitsAt || null,
      usage: data.usage,
      usageAt: data.usageAt || null,
      threads: data.threads || [],
      caps: {
        limits: caps['account/rateLimits/read'] !== false,
        usage: caps['account/usage/read'] !== false,
        threads: caps['thread/list'] !== false,
        hooks: caps['hooks/list'] !== false,
      },
    };
  }

  return { readThread, knowsThread, snapshot };
}

module.exports = { makeAnswers };
