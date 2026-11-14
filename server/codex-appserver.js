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
const {
  IDLE_MS, FAST_FAIL_MS, MAX_FAST_FAILS, PIN_MS, STOP_GRACE_MS,
} = require('./codex/appserver-limits.js');


const {
  MAX_THREADS, threadStatus, parseThreads, cleanUserText, parseTurns,
} = require('./codex/appserver-parse-threads.js');

const {
  USAGE_DAYS, parseAccount, parseRateLimits, mergeRateLimitUpdate, dayKey, parseUsage, parseHooks,
  versionFromUserAgent,
} = require('./codex/appserver-parse-account.js');





const { makeRefresh } = require('./codex/appserver-refresh.js');

const { makeAnswers } = require('./codex/appserver-answers.js');

// ── the child ───────────────────────────────────────────────────────────────
// `resolveExe()` → { cmd, pre } | null (ai-cli.js resolveCodex);
// `env()` → the child's environment; `cwd()` → a folder of ours.
function createAppServer({
  resolveExe, env, cwd, clientVersion = '0.0.0', isOurHook = () => false,
  onChange = () => {}, now = Date.now, spawnFn = spawn,
  setTimer = setTimeout, clearTimer = clearTimeout, log = () => {},
}) {
  const caRun = {
    child: null,
    rpc: null,
    state: 'off',          // off | starting | ready | missing | signedOut | error
    reason: '',
    version: '',
    startedAt: 0,
    fastFails: 0,
    pinnedUntil: 0,
    starting: null,
    demand: { wanted: false, visible: false },
    idleTimer: null,
    tickTimer: null,
    stopped: false,
    byRecency: true,       // false once this copy refused thread/list's sortKey
  };

  const caps = Object.create(null);   // method → false once this copy said it does not know it
  const data = { account: null, limits: null, limitsAt: 0, usage: null, usageAt: 0, threads: null, threadsAt: 0, hooks: null, hooksAt: 0 };
  const busy = Object.create(null);

  function changed() { try { onChange(); } catch { /* listener */ } }
  function setState(s, why) {
    if (s === caRun.state && (why || '') === caRun.reason) return;
    caRun.state = s; caRun.reason = why || '';
    changed();
  }

  async function ask(method, params) {
    if (caps[method] === false) return undefined;
    if (!caRun.rpc) throw new RpcError('closed', 'not running');
    try {
      return await caRun.rpc.call(method, params);
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
    if (caRun.child || caRun.starting) return caRun.starting;
    if (now() < caRun.pinnedUntil) return null;
    caRun.starting = (async () => {
      setState('starting');
      let exe = null;
      try { exe = await resolveExe(); } catch { exe = null; }
      if (!exe) { setState('missing', 'Codex is not installed on this computer'); return null; }
      if (caRun.stopped || !caRun.demand.wanted) { setState('off'); return null; }
      let c;
      try { c = spawnChild(exe); } catch (e) { noteDeath(String((e && e.message) || e)); return null; }
      caRun.child = c;
      caRun.startedAt = now();
      const decode = createLineDecoder((m) => caRun.rpc && caRun.rpc.handle(m));
      caRun.rpc = createRpc({ write: (o) => { if (c.stdin && !c.stdin.destroyed) c.stdin.write(JSON.stringify(o) + '\n'); }, onNotification, setTimer, clearTimer });
      let stderrTail = '';
      c.stdout.on('data', decode);
      c.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-400); });
      c.stdin.on('error', () => { /* exited before reading: reported via exit */ });
      c.on('error', (e) => { stderrTail += ' ' + String((e && e.message) || e); });
      c.on('exit', (code) => {
        if (caRun.child !== c) return;
        const r = caRun.rpc; caRun.child = null; caRun.rpc = null;
        if (r) r.rejectAll('exited');
        clearTimer(caRun.tickTimer); caRun.tickTimer = null;
        if (caRun.stopped || caRun.state === 'off') return;
        noteDeath('exit ' + code + (stderrTail.trim() ? ' · ' + stderrTail.trim().split(/\r?\n/).pop() : ''));
      });
      try {
        const init = await caRun.rpc.call('initialize', { clientInfo: { name: 'xenon', title: 'Xenon', version: clientVersion } });
        caRun.version = versionFromUserAgent(init && init.userAgent);
        c.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
      } catch (e) {
        log('codex app-server: initialize failed: ' + ((e && e.message) || e));
        kill(c);
        return null;
      }
      caRun.fastFails = 0;
      await refresh('account').catch(() => {});
      if (caRun.state === 'starting') setState('ready');
      schedule(0);
      return c;
    })().finally(() => { caRun.starting = null; });
    return caRun.starting;
  }

  function noteDeath(why) {
    caRun.child = null; caRun.rpc = null;
    if (now() - caRun.startedAt < FAST_FAIL_MS) caRun.fastFails++;
    if (caRun.fastFails >= MAX_FAST_FAILS) {
      caRun.pinnedUntil = now() + PIN_MS;
      caRun.fastFails = 0;
      setState('error', why);
      return;
    }
    setState('error', why);
    if (caRun.demand.wanted && !caRun.stopped) {
      const wait = Math.min(PIN_MS, 5000 * Math.pow(2, Math.max(0, caRun.fastFails - 1)));
      clearTimer(caRun.tickTimer);
      caRun.tickTimer = setTimer(() => { caRun.tickTimer = null; if (caRun.demand.wanted && !caRun.child) start(); }, wait);
    }
  }

  function kill(c) {
    if (!c) return;
    try { c.stdin.end(); } catch { /* closed */ }
    const t = setTimer(() => { try { c.kill(); } catch { /* gone */ } }, STOP_GRACE_MS);
    c.once('exit', () => clearTimer(t));
  }

  function stopChild() {
    clearTimer(caRun.tickTimer); caRun.tickTimer = null;
    const c = caRun.child;
    caRun.child = null;
    if (caRun.rpc) { caRun.rpc.rejectAll('stopped'); caRun.rpc = null; }
    kill(c);
    if (caRun.state !== 'missing') setState('off');
  }

  const {
    refresh, schedule, hooksStatus,
  } = makeRefresh({ isOurHook, now, setTimer, clearTimer, log, caRun, caps, data, busy, changed, setState, ask });


  // ── public ──
  function setDemand({ wanted, visible } = {}) {
    const was = caRun.demand.visible;
    caRun.demand = { wanted: !!wanted, visible: !!wanted && !!visible };
    if (caRun.stopped) return;
    if (caRun.demand.wanted) {
      if (caRun.idleTimer) { clearTimer(caRun.idleTimer); caRun.idleTimer = null; }
      if (!caRun.child) start();
      else if (caRun.demand.visible && !was) schedule(0);   // came into view: catch up now
    } else if (caRun.child && !caRun.idleTimer) {
      caRun.idleTimer = setTimer(() => { caRun.idleTimer = null; if (!caRun.demand.wanted) stopChild(); }, IDLE_MS);
    }
  }

  const { readThread, knowsThread, snapshot } = makeAnswers({ caRun, caps, data, ask, start });

  function stop() {
    caRun.stopped = true;
    if (caRun.idleTimer) { clearTimer(caRun.idleTimer); caRun.idleTimer = null; }
    stopChild();
  }

  return {
    setDemand, refresh, hooksStatus, snapshot, stop, readThread, knowsThread,
    get state() { return caRun.state; },
    get running() { return !!caRun.child; },
  };
}

module.exports = {
  createAppServer,
  createLineDecoder, createRpc, isUnsupported,
  parseAccount, parseRateLimits, mergeRateLimitUpdate, parseUsage, parseThreads, parseHooks, versionFromUserAgent,
  cleanUserText, parseTurns,
  _internal: { IDLE_MS, FAST_FAIL_MS, MAX_FAST_FAILS, PIN_MS, MAX_THREADS, USAGE_DAYS, dayKey },
};
