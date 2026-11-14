'use strict';

// ── OpenAI Codex: plan limits, usage and recent work, from Codex itself ─────
// What the Codex tile shows about the ACCOUNT (the plan's usage windows, tokens
// per day, the conversations listed in Codex) comes from `codex app-server`,
// the JSON-RPC program the ChatGPT desktop app and the VS Code extension use to
// talk to Codex. Xenon runs its own copy, read-only, the way it runs `codex
// login status` for Xenon AI.
//
// Why not the files under ~/.codex the way the Claude tile reads transcripts.
// Since mid-2026 Codex keeps its history in its own sqlite databases with a
// private schema (the old rollout-*.jsonl files simply stop), and the rate
// limits are never written to disk at all. app-server is the documented door,
// and the one that keeps working when the files change shape again.
//
// The rules this module keeps:
//
//  - ONE child, and only while someone is looking. `setDemand()` is driven by
//    server.js from "is the tile placed / is a widget granted the stream / is a
//    dashboard connected"; with no demand the child is stopped after IDLE_MS.
//    It is stopped in _gracefulShutdown like every long-lived child.
//  - Read-only. The only requests sent are reads (account, rateLimits, usage,
//    thread/list, hooks/list). Nothing here starts a turn, writes config or
//    marks a hook trusted. A request the SERVER sends us (an approval, a login
//    prompt) is answered "method not found" at once so the child never waits on
//    us for something we will never do.
//  - Tolerant. app-server is labelled experimental and two copies of different
//    versions often sit on one PC (the desktop app's and the editor's). Every
//    method is probed on first use; one this copy does not know turns its
//    section off instead of failing the tile.
//  - Private by construction. The account's email, the folders conversations
//    ran in and their full text never leave this module: only a plan name, a
//    project's folder NAME, a clamped title and numbers do.
//  - argv, never a shell; the API-key variables are removed from the child's
//    environment (ai-cli.js childEnv) so nothing here can bill per token.

const { spawn } = require('child_process');

const {
  createLineDecoder, isUnsupported, RpcError, createRpc,
} = require('./codex/appserver-rpc.js');
const IDLE_MS = 3 * 60 * 1000;          // no demand for this long → stop the child
const FAST_FAIL_MS = 10000;             // a child that dies younger than this counts as a failure
const MAX_FAST_FAILS = 5;               // then stay down for PIN_MS
const PIN_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 2000;

// Refresh cadence. "visible" = a tile is on the current page of some surface.
const LIMITS_VISIBLE_MS = 60 * 1000;
const LIMITS_HIDDEN_MS = 5 * 60 * 1000;
const USAGE_MS = 10 * 60 * 1000;
const THREADS_VISIBLE_MS = 20 * 1000;
const THREADS_HIDDEN_MS = 2 * 60 * 1000;
const HOOKS_TTL_MS = 30 * 1000;

const {
  MAX_THREADS, threadStatus, parseThreads, cleanUserText, parseTurns,
} = require('./codex/appserver-parse-threads.js');

const {
  USAGE_DAYS, parseAccount, parseRateLimits, mergeRateLimitUpdate, dayKey, parseUsage, parseHooks,
  versionFromUserAgent,
} = require('./codex/appserver-parse-account.js');





// ── the child ───────────────────────────────────────────────────────────────
// `resolveExe()` → { cmd, pre } | null (ai-cli.js resolveCodex);
// `env()` → the child's environment; `cwd()` → a folder of ours.
function createAppServer({
  resolveExe, env, cwd, clientVersion = '0.0.0', isOurHook = () => false,
  onChange = () => {}, now = Date.now, spawnFn = spawn,
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
}) {
  let child = null;
  let rpc = null;
  let state = 'off';          // off | starting | ready | missing | signedOut | error
  let reason = '';
  let version = '';
  let startedAt = 0;
  let fastFails = 0;
  let pinnedUntil = 0;
  let starting = null;
  let demand = { wanted: false, visible: false };
  let idleTimer = null;
  let tickTimer = null;
  let stopped = false;
  let byRecency = true;       // false once this copy refused thread/list's sortKey

  const caps = Object.create(null);   // method → false once this copy said it does not know it
  const data = { account: null, limits: null, limitsAt: 0, usage: null, usageAt: 0, threads: null, threadsAt: 0, hooks: null, hooksAt: 0 };
  const busy = Object.create(null);

  function changed() { try { onChange(); } catch { /* listener */ } }
  function setState(s, why) {
    if (s === state && (why || '') === reason) return;
    state = s; reason = why || '';
    changed();
  }

  async function ask(method, params) {
    if (caps[method] === false) return undefined;
    if (!rpc) throw new RpcError('closed', 'not running');
    try {
      return await rpc.call(method, params);
    } catch (e) {
      if (e && e.rpc && isUnsupported(e.rpc)) { caps[method] = false; changed(); return undefined; }
      throw e;
    }
  }

  function onNotification(method, params) {
    if (method === 'account/rateLimits/updated' && params && params.rateLimits) {
      data.limits = mergeRateLimitUpdate(data.limits, params.rateLimits);
      data.limitsAt = now();
      changed();
    } else if (method === 'account/updated') {
      // Signed in or out from another Codex window: re-read the account.
      refresh('account').catch(() => {});
    } else if (method === 'thread/status/changed' && params && data.threads) {
      const t = data.threads.find((x) => x.id === params.threadId);
      if (t) { t.status = threadStatus(params.status); changed(); }
    }
  }

  function spawnChild(exe) {
    const args = exe.pre.concat(['app-server', '-c', 'features.hooks=false']);
    return spawnFn(exe.cmd, args, { cwd: cwd(), env: env(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  async function start() {
    if (child || starting) return starting;
    if (now() < pinnedUntil) return null;
    starting = (async () => {
      setState('starting');
      let exe = null;
      try { exe = await resolveExe(); } catch { exe = null; }
      if (!exe) { setState('missing', 'Codex is not installed on this computer'); return null; }
      if (stopped || !demand.wanted) { setState('off'); return null; }
      let c;
      try { c = spawnChild(exe); } catch (e) { noteDeath(String((e && e.message) || e)); return null; }
      child = c;
      startedAt = now();
      const decode = createLineDecoder((m) => rpc && rpc.handle(m));
      rpc = createRpc({ write: (o) => { if (c.stdin && !c.stdin.destroyed) c.stdin.write(JSON.stringify(o) + '\n'); }, onNotification, setTimer, clearTimer });
      let stderrTail = '';
      c.stdout.on('data', decode);
      c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-400); });
      c.stdin.on('error', () => { /* exited before reading: reported via exit */ });
      c.on('error', (e) => { stderrTail += ' ' + String((e && e.message) || e); });
      c.on('exit', (code) => {
        if (child !== c) return;
        const r = rpc; child = null; rpc = null;
        if (r) r.rejectAll('exited');
        clearTimer(tickTimer); tickTimer = null;
        if (stopped || state === 'off') return;
        noteDeath('exit ' + code + (stderrTail.trim() ? ' · ' + stderrTail.trim().split(/\r?\n/).pop() : ''));
      });
      try {
        const init = await rpc.call('initialize', { clientInfo: { name: 'xenon', title: 'Xenon', version: clientVersion } });
        version = versionFromUserAgent(init && init.userAgent);
        c.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      } catch (e) {
        log('codex app-server: initialize failed: ' + ((e && e.message) || e));
        kill(c);
        return null;
      }
      fastFails = 0;
      await refresh('account').catch(() => {});
      if (state === 'starting') setState('ready');
      schedule(0);
      return c;
    })().finally(() => { starting = null; });
    return starting;
  }

  function noteDeath(why) {
    child = null; rpc = null;
    if (now() - startedAt < FAST_FAIL_MS) fastFails++;
    if (fastFails >= MAX_FAST_FAILS) {
      pinnedUntil = now() + PIN_MS;
      fastFails = 0;
      setState('error', why);
      return;
    }
    setState('error', why);
    if (demand.wanted && !stopped) {
      const wait = Math.min(PIN_MS, 5000 * Math.pow(2, Math.max(0, fastFails - 1)));
      clearTimer(tickTimer);
      tickTimer = setTimer(() => { tickTimer = null; if (demand.wanted && !child) start(); }, wait);
    }
  }

  function kill(c) {
    if (!c) return;
    try { c.stdin.end(); } catch { /* closed */ }
    const t = setTimer(() => { try { c.kill(); } catch { /* gone */ } }, STOP_GRACE_MS);
    c.once('exit', () => clearTimer(t));
  }

  function stopChild() {
    clearTimer(tickTimer); tickTimer = null;
    const c = child;
    child = null;
    if (rpc) { rpc.rejectAll('stopped'); rpc = null; }
    kill(c);
    if (state !== 'missing') setState('off');
  }

  // ── refreshes ──
  async function refresh(kind) {
    if (busy[kind] || !rpc) return;   // skip, never queue: a slow answer must not pile up
    busy[kind] = true;
    try {
      if (kind === 'account') {
        const r = await ask('account/read', { refreshToken: false });
        if (r !== undefined) {
          data.account = parseAccount(r);
          if (data.account.signedIn === false) setState('signedOut', '');
          else if (state === 'signedOut') setState('ready');
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
    if (byRecency && caps['thread/list'] !== false) {
      try { return await rpc.call('thread/list', Object.assign({ sortKey: 'recency_at' }, params)); } catch (e) {
        if (!(e && e.rpc)) throw e;
        byRecency = false;
      }
    }
    return ask('thread/list', params);
  }

  function due(at, every) { return !at || now() - at >= every; }
  async function tick() {
    tickTimer = null;
    if (!rpc || stopped) return;
    if (state !== 'signedOut') {
      const v = demand.visible;
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
    schedule(demand.visible ? 10000 : 30000);
  }
  function schedule(ms) {
    clearTimer(tickTimer);
    if (!rpc || stopped) return;
    tickTimer = setTimer(() => { tick(); }, ms);
  }

  // ── public ──
  function setDemand({ wanted, visible } = {}) {
    const was = demand.visible;
    demand = { wanted: !!wanted, visible: !!wanted && !!visible };
    if (stopped) return;
    if (demand.wanted) {
      if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
      if (!child) start();
      else if (demand.visible && !was) schedule(0);   // came into view: catch up now
    } else if (child && !idleTimer) {
      idleTimer = setTimer(() => { idleTimer = null; if (!demand.wanted) stopChild(); }, IDLE_MS);
    }
  }

  // One conversation, read on request (a tap on the tile). Only a thread this
  // module listed, or one the caller vouches for (a session the hooks report),
  // so the route is never a way to read an arbitrary id.
  // `running`: the newest turn is still going, so the tile reads again soon.
  async function readThread(threadId) {
    if (!rpc) await start();
    if (!rpc) return { ok: false, error: state === 'missing' ? 'missing' : 'unavailable' };
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

  // Link status asks this right after a link: fresh, but never more than the TTL.
  async function hooksStatus({ fresh = false } = {}) {
    if (!rpc) return data.hooks;
    if (fresh || due(data.hooksAt, HOOKS_TTL_MS)) await refresh('hooks');
    return data.hooks;
  }

  function snapshot() {
    return {
      state,
      reason,
      version,
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

  function stop() {
    stopped = true;
    if (idleTimer) { clearTimer(idleTimer); idleTimer = null; }
    stopChild();
  }

  return {
    setDemand, refresh, hooksStatus, snapshot, stop, readThread, knowsThread,
    get state() { return state; },
    get running() { return !!child; },
  };
}

module.exports = {
  createAppServer,
  createLineDecoder, createRpc, isUnsupported,
  parseAccount, parseRateLimits, mergeRateLimitUpdate, parseUsage, parseThreads, parseHooks, versionFromUserAgent,
  cleanUserText, parseTurns,
  _internal: { IDLE_MS, FAST_FAIL_MS, MAX_FAST_FAILS, PIN_MS, MAX_THREADS, USAGE_DAYS, dayKey },
};
