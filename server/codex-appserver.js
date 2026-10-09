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

const path = require('path');
const { spawn } = require('child_process');

const REQUEST_TIMEOUT_MS = 15000;
const IDLE_MS = 3 * 60 * 1000;          // no demand for this long → stop the child
const FAST_FAIL_MS = 10000;             // a child that dies younger than this counts as a failure
const MAX_FAST_FAILS = 5;               // then stay down for PIN_MS
const PIN_MS = 10 * 60 * 1000;
const MAX_LINE = 4 * 1024 * 1024;       // one JSON message; a thread/list page is far below this
const STOP_GRACE_MS = 2000;

// Refresh cadence. "visible" = a tile is on the current page of some surface.
const LIMITS_VISIBLE_MS = 60 * 1000;
const LIMITS_HIDDEN_MS = 5 * 60 * 1000;
const USAGE_MS = 10 * 60 * 1000;
const THREADS_VISIBLE_MS = 20 * 1000;
const THREADS_HIDDEN_MS = 2 * 60 * 1000;
const HOOKS_TTL_MS = 30 * 1000;

const MAX_THREADS = 12;
const MAX_BUCKETS = 6;
const USAGE_DAYS = 30;

function str(v, n) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : ''; }
function int(v) { return Number.isFinite(v) ? Math.round(v) : null; }
function pct(v) { return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null; }

// ── wire format ─────────────────────────────────────────────────────────────
// One JSON object per line (measured on 0.155 and 0.160; responses carry no
// "jsonrpc" field). Lines that are not JSON are ignored, and one that grows
// past MAX_LINE is dropped whole rather than buffered without limit.
function createLineDecoder(onMessage, maxLine = MAX_LINE) {
  let buf = '';
  let dropping = false;
  return function push(chunk) {
    buf += String(chunk);
    for (;;) {
      const i = buf.indexOf('\n');
      if (i < 0) break;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; }
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg && typeof msg === 'object') onMessage(msg);
    }
    if (buf.length > maxLine) { buf = ''; dropping = true; }
  };
}

// "This copy does not have that method." Codex answers an unknown method with
// -32600 "unknown variant" (measured), JSON-RPC proper says -32601; both mean
// the same thing here.
function isUnsupported(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code === -32601) return true;
  return err.code === -32600 && /unknown variant/i.test(String(err.message || ''));
}

class RpcError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

function createRpc({ write, onNotification, timeoutMs = REQUEST_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let nextId = 1;
  const pending = new Map();
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new RpcError('timeout', method + ' timed out'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { write({ id, method, params: params || {} }); } catch (e) {
        pending.delete(id); clearTimer(timer);
        reject(new RpcError('write', String((e && e.message) || e)));
      }
    });
  }
  function handle(msg) {
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === 'string') {
      // A request FROM the server (an approval, an auth refresh). We never do
      // those; saying so at once keeps the child from waiting on us.
      try { write({ id: msg.id, error: { code: -32601, message: 'not supported by this client' } }); } catch { /* closed */ }
      return;
    }
    if (hasId) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimer(p.timer);
      if (msg.error) p.reject(Object.assign(new RpcError(msg.error.code, String(msg.error.message || 'error')), { rpc: msg.error }));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string' && typeof onNotification === 'function') onNotification(msg.method, msg.params || {});
  }
  function rejectAll(reason) {
    for (const [id, p] of pending) { clearTimer(p.timer); p.reject(new RpcError('closed', reason || 'closed')); pending.delete(id); }
  }
  return { call, handle, rejectAll, get pendingCount() { return pending.size; } };
}

// ── parsers (pure; fixture-tested against captured answers) ─────────────────
// account/read → whether Codex is signed in and on which plan. The email is
// never read out of the answer.
function parseAccount(r) {
  if (!r || typeof r !== 'object') return { signedIn: null, type: '', plan: '' };
  const a = r.account && typeof r.account === 'object' ? r.account : null;
  if (!a) return { signedIn: false, type: '', plan: '' };
  return { signedIn: true, type: str(a.type, 24), plan: str(a.planType, 48) };
}

function parseWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const used = pct(w.usedPercent);
  if (used === null) return null;
  return {
    pct: used,
    windowMins: int(w.windowDurationMins),
    // seconds since epoch on the wire; milliseconds everywhere in Xenon
    resetsAt: Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? w.resetsAt * 1000 : null,
  };
}
function parseBucket(s, fallbackId) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: str(s.limitId, 48) || fallbackId || 'codex',
    name: str(s.limitName, 60),
    primary: parseWindow(s.primary),
    secondary: parseWindow(s.secondary),
    reached: str(s.rateLimitReachedType, 48) || null,
  };
}
function parseCredits(c) {
  if (!c || typeof c !== 'object') return null;
  return { has: c.hasCredits === true, unlimited: c.unlimited === true, balance: str(c.balance, 24) || null };
}
// account/rateLimits/read → every limit bucket (a plan can have more than one,
// keyed by limitId), each with up to two windows. The window LENGTH comes from
// Codex: a Plus plan reads 5 hours + 1 week, the Free plan one 30-day window
// (measured), so the tile labels from windowMins and never assumes.
function parseRateLimits(r) {
  if (!r || typeof r !== 'object') return null;
  const byId = r.rateLimitsByLimitId && typeof r.rateLimitsByLimitId === 'object' ? r.rateLimitsByLimitId : null;
  const buckets = [];
  if (byId) {
    for (const k of Object.keys(byId).slice(0, MAX_BUCKETS)) {
      const b = parseBucket(byId[k], str(k, 48));
      if (b) buckets.push(b);
    }
  }
  if (!buckets.length) { const b = parseBucket(r.rateLimits); if (b) buckets.push(b); }
  // The main bucket first: the one rateLimits names.
  const mainId = r.rateLimits && str(r.rateLimits.limitId, 48);
  if (mainId) buckets.sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0));
  const main = r.rateLimits && typeof r.rateLimits === 'object' ? r.rateLimits : {};
  const resets = r.rateLimitResetCredits && Number.isFinite(r.rateLimitResetCredits.availableCount) ? r.rateLimitResetCredits.availableCount : null;
  return {
    buckets,
    credits: parseCredits(main.credits),
    plan: str(main.planType, 48),
    allowed: typeof r.ordinaryUsageAllowed === 'boolean' ? r.ordinaryUsageAllowed : null,
    resetCredits: resets,
  };
}
// account/rateLimits/updated carries one bucket and may leave a window out.
// An absent window keeps the last reading (the same "never 0 for unknown"
// rule the Claude bridge keeps); the next full read replaces everything.
function mergeRateLimitUpdate(prev, snap) {
  const b = parseBucket(snap);
  if (!b) return prev;
  const base = prev && Array.isArray(prev.buckets) ? prev : { buckets: [], credits: null, plan: '', allowed: null, resetCredits: null };
  const buckets = base.buckets.slice();
  const i = buckets.findIndex((x) => x.id === b.id);
  const old = i >= 0 ? buckets[i] : null;
  const merged = {
    id: b.id,
    name: b.name || (old && old.name) || '',
    primary: b.primary || (old && old.primary) || null,
    secondary: b.secondary || (old && old.secondary) || null,
    reached: b.reached,
  };
  if (i >= 0) buckets[i] = merged; else if (buckets.length < MAX_BUCKETS) buckets.push(merged);
  const credits = snap && snap.credits ? parseCredits(snap.credits) : base.credits;
  return Object.assign({}, base, { buckets, credits, plan: str(snap && snap.planType, 48) || base.plan });
}

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// account/usage/read → tokens per day for the account (every device and app
// that uses it, which is what "my Codex usage" means). Only days with work are
// listed, so the last USAGE_DAYS are rebuilt with zeros for the chart.
function parseUsage(r, nowMs) {
  if (!r || typeof r !== 'object') return null;
  const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const byDay = new Map();
  for (const b of Array.isArray(r.dailyUsageBuckets) ? r.dailyUsageBuckets : []) {
    if (!b || typeof b.startDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.startDate)) continue;
    if (!Number.isFinite(b.tokens) || b.tokens < 0) continue;
    byDay.set(b.startDate, (byDay.get(b.startDate) || 0) + Math.round(b.tokens));
  }
  const days = [];
  const today = new Date(nowMs);
  for (let i = USAGE_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const k = dayKey(d.getTime());
    days.push({ date: k, tokens: byDay.get(k) || 0 });
  }
  const sum = (n) => days.slice(-n).reduce((a, d) => a + d.tokens, 0);
  let lastActive = null;
  for (const k of byDay.keys()) if (!lastActive || k > lastActive) lastActive = k;
  return {
    lifetime: int(s.lifetimeTokens),
    peakDaily: int(s.peakDailyTokens),
    streak: int(s.currentStreakDays),
    longestStreak: int(s.longestStreakDays),
    longestTurnSec: int(s.longestRunningTurnSec),
    days,
    today: sum(1),
    last7: sum(7),
    last30: sum(USAGE_DAYS),
    lastActive,
  };
}

function threadStatus(s) {
  const t = s && typeof s === 'object' ? s.type : '';
  if (t === 'active') {
    const flags = Array.isArray(s.activeFlags) ? s.activeFlags : [];
    return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'waiting' : 'active';
  }
  if (t === 'idle') return 'idle';
  if (t === 'systemError') return 'error';
  return 'saved';   // notLoaded: a conversation on disk, not open in this process
}
function threadSource(t) {
  const o = str(t.originator, 40).toLowerCase();
  if (/desktop|chatgpt/.test(o)) return 'app';
  const s = t.source;
  if (s === 'cli') return 'cli';
  if (s === 'vscode') return 'ide';
  if (s === 'exec') return 'exec';
  if (s && typeof s === 'object' && s.subAgent) return 'agent';
  return 'other';
}
// thread/list → the conversations Codex lists, most recently active first
// (asked by recency, and sorted again here: a copy that does not know the sort
// key lists by creation, which buried a busy old chat). Only the folder's
// last segment is kept: the full path is the user's disk layout and never needs
// to leave the PC to say "xenon". Ephemeral threads (Xenon AI's own one-shot
// turns among them) are not the user's work and are skipped.
function parseThreads(r) {
  const list = r && Array.isArray(r.data) ? r.data : [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || t.ephemeral === true) continue;
    const preview = cleanUserText(t.preview).text;
    const firstLine = str(preview.split(/\r?\n/).find((l) => l.trim()) || '', 120);
    const cwd = typeof t.cwd === 'string' ? t.cwd : '';
    const branch = t.gitInfo && typeof t.gitInfo === 'object' ? str(t.gitInfo.branch, 60) : '';
    const updated = Number.isFinite(t.recencyAt) ? t.recencyAt : t.updatedAt;
    out.push({
      id: str(t.id, 64),
      title: str(cleanUserText(t.name).text, 120) || firstLine,
      project: cwd ? str(path.basename(cwd.replace(/[\\/]+$/, '')), 60) : '',
      branch,
      model: str(t.model, 48),
      effort: str(t.reasoningEffort, 16),
      source: threadSource(t),
      status: threadStatus(t.status),
      updatedAt: Number.isFinite(updated) ? updated * 1000 : null,
    });
  }
  out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return out.slice(0, MAX_THREADS);
}

// What a person typed, without what Codex wrapped around it. Two wrappers are
// measured on 0.160: an attachment block ("# Files mentioned by the user:" with
// one "## name: <absolute path>" per file, then "## My request for Codex:" and
// the request), and skill mentions written as markdown links to a local file
// ("[$xenon-creator](C:\\Users\\…\\SKILL.md)"). Both carry absolute paths, which
// stay on the PC: the request is kept, a link to anything that is not http(s)
// keeps only its label, and the attachments become a count.
function cleanUserText(raw) {
  let s = String(raw || '');
  let files = 0;
  const req = s.indexOf('## My request for Codex:');
  if (/^\s*# Files mentioned by the user:/.test(s)) {
    const head = req >= 0 ? s.slice(0, req) : s;
    files = (head.match(/^## [^\n]+$/gm) || []).length;
    s = req >= 0 ? s.slice(req + '## My request for Codex:'.length) : '';
  }
  // The target may contain spaces ("Marci Progetti"): a local path is not a URL.
  s = s.replace(/\[([^\]\n]{1,120})\]\(([^)\n]{1,600})\)/g, (m, label, target) => (/^https?:\/\//i.test(target.trim()) ? m : label));
  return { text: s.trim(), files };
}

// thread/turns/list (itemsView "summary") → the conversation as a person reads
// it: each turn's request and Codex's final answer, oldest first. Tool calls,
// reasoning and command output are left out, the same choice the Claude tile's
// reader makes. Bounded per message and in count.
// A turn still running also shows Codex's interim notes ("commentary": what it
// is doing now) as `progress`; once the turn ends only its answer stays, the
// way Codex itself folds them away. The summary view has no commentary, so
// readThread swaps in the full items of a running turn.
const MAX_THREAD_MESSAGES = 30;
const MAX_MESSAGE_TEXT = 6000;
// Like str() but keeps line breaks: a message is paragraphs, a title is not.
function keepLines(v, n) {
  return String(v || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, '').trim().slice(0, n);
}
function parseTurns(r) {
  const turns = r && Array.isArray(r.data) ? r.data.slice() : [];
  // Asked newest first so the limit keeps the recent end; shown oldest first.
  turns.sort((a, b) => (Number(a && a.startedAt) || 0) - (Number(b && b.startedAt) || 0));
  const out = [];
  for (const t of turns) {
    if (!t || !Array.isArray(t.items)) continue;
    const at = Number.isFinite(t.startedAt) ? t.startedAt * 1000 : null;
    for (const it of t.items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'userMessage') {
        const parts = Array.isArray(it.content) ? it.content : [];
        let files = parts.filter((p) => p && (p.type === 'localImage' || p.type === 'image')).length;
        const text = parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => {
          const c = cleanUserText(p.text);
          files = Math.max(files, c.files);
          return c.text;
        }).join('\n').trim();
        if (text || files) out.push({ role: 'user', text: keepLines(text, MAX_MESSAGE_TEXT), files, at });
      } else if (it.type === 'agentMessage' && typeof it.text === 'string' && it.text.trim()) {
        if (it.phase !== 'commentary') out.push({ role: 'assistant', text: keepLines(it.text, MAX_MESSAGE_TEXT), at });
        else if (t.status === 'inProgress') out.push({ role: 'progress', text: keepLines(it.text, MAX_MESSAGE_TEXT), at });
      }
    }
    if (t.status === 'failed' || t.status === 'interrupted') out.push({ role: 'note', text: t.status, at });
  }
  return out.slice(-MAX_THREAD_MESSAGES);
}

// hooks/list → only Xenon's own handlers (recognised by `isOurs(command)`),
// with Codex's own verdict on whether the user has trusted them.
function parseHooks(r, isOurs) {
  const entries = r && Array.isArray(r.data) ? r.data : [];
  const ours = [];
  for (const e of entries) {
    for (const h of (e && Array.isArray(e.hooks) ? e.hooks : [])) {
      if (!h || h.handlerType !== 'command' || typeof h.command !== 'string' || !isOurs(h.command)) continue;
      ours.push({ event: str(h.eventName, 40), trust: str(h.trustStatus, 16) || 'unknown', enabled: h.enabled !== false });
    }
  }
  if (!ours.length) return { found: 0, trusted: null, untrusted: 0, modified: 0, disabled: 0 };
  const untrusted = ours.filter((h) => h.trust === 'untrusted').length;
  const modified = ours.filter((h) => h.trust === 'modified').length;
  const disabled = ours.filter((h) => !h.enabled).length;
  return {
    found: ours.length,
    trusted: untrusted === 0 && modified === 0 && disabled === 0,
    untrusted, modified, disabled,
  };
}

function versionFromUserAgent(ua) {
  const m = /\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/.exec(String(ua || ''));
  return m ? m[1].slice(0, 32) : '';
}

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
