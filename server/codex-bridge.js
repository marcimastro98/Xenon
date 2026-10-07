'use strict';

// ── OpenAI Codex live bridge ─────────────────────────────────────────────────
// What Codex sessions on this PC are doing right now, and the approvals they
// are waiting on, fed by the hooks codex-link.js installs (via codex-hook.js).
// The Codex twin of claude-bridge.js, deliberately smaller, because Codex hooks
// can do less, and every control here must do a real thing in the session:
//
//   • A PermissionRequest can be ALLOWED or DENIED, nothing more. Codex
//     reserves `updatedInput` / `updatedPermissions` and fails closed on them
//     (codex-rs hooks, 0.160), so there is no plan card and no question card
//     here: offering them would draw controls that do nothing.
//   • While our hook is waiting, Codex shows NO prompt of its own: the hook
//     runs first and the normal prompt only appears when the hook declines to
//     decide (learn.chatgpt.com/docs/hooks). So the wait is short by default
//     (`waitMs`), and the card always has "Answer in Codex", which declines at
//     once and puts the decision back in the terminal or the app.
//
// The one rule, the same as the Claude bridge's: every path that is not an
// explicit tap on Allow or Deny resolves to NO decision (`{}` on the wire).
// A timeout, a closed socket, a full queue, a malformed body, a shutdown: all
// of them give the prompt back to Codex. A non-answer never becomes an allow.
//
// In-memory and per-boot. `cwd` is kept for the risk line and never leaves
// this module; the snapshot carries a folder name, and the SDK projection
// carries counts only.

const path = require('path');
const { describeRisk, isDestructive } = require('./claude-bridge');

const MAX_SESSIONS = 20;
const MAX_PENDING = 8;
const MAX_STR = 220;
const MAX_DETAIL = 800;
const MAX_FILES = 12;
const SESSION_STALE_MS = 60 * 60 * 1000;
const SESSION_RESTING_MS = 8 * 60 * 1000;
const ENDED_KEEP_MS = 10 * 60 * 1000;
const URGENT_AFTER_MS = 25 * 1000;
const DEFAULT_WAIT_MS = 90 * 1000;

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ').trim();
  if (!s) return '';
  const cap = max || MAX_STR;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}
function firstLine(v, max) {
  return str(String(v || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '', max);
}

// ── what a request is about ──────────────────────────────────────────────────
// apply_patch arrives as the patch text itself. Its file headers are the part
// a person needs to decide: which files, and whether any is deleted.
function parsePatch(text) {
  const files = [];
  let added = 0, removed = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { if (files.length < MAX_FILES) files.push({ verb: m[1].toLowerCase(), path: m[2].trim() }); continue; }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && files.length) { files[files.length - 1].verb = 'move'; files[files.length - 1].to = mv[1].trim(); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { files, added, removed };
}
function shown(p, cwd) {
  if (!p) return '';
  const abs = path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p);
  if (cwd) {
    const rel = path.relative(cwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return str(rel, 200);
  }
  return str(abs, 200);
}

// { kind, text, note, files?, added?, removed?, server?, name? }
function describeCodexTool(tool, input, cwd) {
  const t = str(tool, 80);
  const i = input && typeof input === 'object' ? input : {};
  if (t === 'Bash') return { kind: 'command', text: str(i.command, MAX_DETAIL), note: str(i.description, 160) };
  if (t === 'apply_patch') {
    const p = parsePatch(i.command);
    return {
      kind: 'patch', text: '', note: '',
      files: p.files.map((f) => Object.assign({ verb: f.verb, path: shown(f.path, cwd) }, f.to ? { to: shown(f.to, cwd) } : {})),
      added: p.added, removed: p.removed,
    };
  }
  if (t === 'write_stdin') return { kind: 'stdin', text: str(i.chars, 200), note: '' };
  if (t === 'request_permissions') return { kind: 'permissions', text: str(i.reason, 300), note: '' };
  if (t === 'spawn_agent') return { kind: 'agent', text: str(i.message || i.prompt || i.task, 300), note: '' };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
  if (mcp) {
    const firstArg = Object.values(i).find((v) => typeof v === 'string' && v.trim());
    return { kind: 'mcp', server: str(mcp[1], 60), name: str(mcp[2], 80), text: str(firstArg || '', 300), note: '' };
  }
  let raw = '';
  try { raw = JSON.stringify(i); } catch { raw = ''; }
  return { kind: 'other', text: str(raw === '{}' ? '' : raw, 300), note: '' };
}

// The risk line describes; it never decides (same rule as the Claude card).
// Codes: the Claude vocabulary plus `widen` (the request asks for more
// sandbox access than the session has).
function codexRisks(tool, input, cwd) {
  const t = str(tool, 80);
  const i = input && typeof input === 'object' ? input : {};
  const out = new Set();
  if (t === 'Bash') {
    for (const r of describeRisk('Bash', String(i.command || ''), cwd)) out.add(r);
    if (/^network-access\b/i.test(String(i.description || ''))) { out.add('network'); out.delete('readonly'); }
  } else if (t === 'apply_patch') {
    const p = parsePatch(i.command);
    for (const f of p.files) {
      if (f.verb === 'delete') out.add('irreversible');
      for (const target of [f.path, f.to]) {
        if (!target) continue;
        const abs = path.isAbsolute(target) || !cwd ? target : path.resolve(cwd, target);
        for (const r of describeRisk('Edit', abs, cwd)) out.add(r);
      }
    }
  } else if (t === 'request_permissions') {
    out.add('widen');
  }
  return Array.from(out);
}
function irreversible(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return isDestructive('Bash', String(i.command || ''));
  if (tool === 'apply_patch') return parsePatch(i.command).files.some((f) => f.verb === 'delete');
  return false;
}

// What the hook script prints back to Codex. Only an explicit verdict becomes
// a decision; every other outcome is "no decision".
function toHookOutput(result) {
  const v = result && result.verdict;
  if (v === 'allow') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };
  if (v === 'deny') return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from Xenon' } } };
  return {};
}

function createBridge({ now = Date.now, onChange = () => {}, waitMs = () => DEFAULT_WAIT_MS } = {}) {
  const sessions = new Map();
  const pending = new Map();
  let seq = 0;

  let emitScheduled = false;
  function emit() {
    if (emitScheduled) return;
    emitScheduled = true;
    setImmediate(() => { emitScheduled = false; try { onChange(); } catch { /* a listener never breaks ingest */ } });
  }

  function touch(d) {
    const id = str(d && d.session_id, 80);
    if (!id) return null;
    const t = now();
    let s = sessions.get(id);
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) {
        // Make room: the quietest session goes first.
        let oldest = null;
        for (const x of sessions.values()) if (!oldest || x.lastAt < oldest.lastAt) oldest = x;
        if (oldest) sessions.delete(oldest.id);
      }
      s = { id, project: '', cwd: '', model: '', task: '', state: 'idle', permissionMode: '', startedAt: t, lastAt: t, endedAt: 0, turns: 0 };
      sessions.set(id, s);
    }
    s.lastAt = t;
    const cwd = typeof d.cwd === 'string' ? d.cwd : '';
    if (cwd) { s.cwd = cwd; s.project = str(path.basename(cwd.replace(/[\\/]+$/, '')), 60); }
    if (d.model) s.model = str(d.model, 48);
    if (d.permission_mode) s.permissionMode = str(d.permission_mode, 24);
    return s;
  }

  function applyHook(d) {
    if (!d || typeof d !== 'object') return;
    const ev = str(d.hook_event_name, 40);
    const s = touch(d);
    if (!s) return;
    if (ev === 'SessionStart') {
      s.endedAt = 0;
      if (s.state !== 'running' && s.state !== 'waiting') s.state = 'idle';
    } else if (ev === 'UserPromptSubmit') {
      const task = firstLine(d.prompt, 160);
      if (task) s.task = task;
      s.state = 'running';
      s.endedAt = 0;
      s.turns++;
    } else if (ev === 'Stop') {
      if (!hasPending(s.id)) s.state = 'idle';
    } else if (ev === 'SessionEnd') {
      s.state = 'ended';
      s.endedAt = now();
    }
    emit();
  }

  function hasPending(sessionId) {
    for (const p of pending.values()) if (p.sessionId === sessionId) return true;
    return false;
  }

  // → { id, promise } where promise resolves { verdict }, or null when the
  // queue is full or the body is not a request (the caller answers `{}`).
  function requestPermission(d) {
    if (!d || typeof d !== 'object' || typeof d.tool_name !== 'string') return null;
    if (pending.size >= MAX_PENDING) return null;
    const s = touch(d);
    const t = now();
    const tool = str(d.tool_name, 80);
    const input = d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {};
    const cwd = s ? s.cwd : (typeof d.cwd === 'string' ? d.cwd : '');
    const id = 'x' + t.toString(36) + (++seq).toString(36);
    const ttl = Math.max(15000, Math.min(10 * 60 * 1000, Number(waitMs()) || DEFAULT_WAIT_MS));
    const danger = irreversible(tool, input);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const rec = {
      id, sessionId: s ? s.id : '', tool,
      detail: describeCodexTool(tool, input, cwd),
      risks: codexRisks(tool, input, cwd),
      project: s ? s.project : '', model: s ? s.model : str(d.model, 48), task: s ? s.task : '',
      createdAt: t, expiresAt: t + ttl, urgentAt: danger ? t : t + URGENT_AFTER_MS,
      resolve, timer: null,
    };
    rec.timer = setTimeout(() => settle(id, { verdict: 'timeout' }), ttl);
    if (rec.timer.unref) rec.timer.unref();
    pending.set(id, rec);
    if (s) s.state = 'waiting';
    emit();
    return { id, promise };
  }

  function settle(id, result) {
    const p = pending.get(id);
    if (!p) return false;
    pending.delete(id);
    clearTimeout(p.timer);
    const s = sessions.get(p.sessionId);
    if (s && s.state === 'waiting' && !hasPending(s.id)) s.state = 'running';
    try { p.resolve(result); } catch { /* resolved */ }
    emit();
    return true;
  }

  // The tap. `handback` = "Answer in Codex": no decision, at once.
  function decide(id, behavior) {
    if (behavior !== 'allow' && behavior !== 'deny' && behavior !== 'handback') return false;
    return settle(String(id || ''), { verdict: behavior });
  }
  function cancel(id) { return settle(String(id || ''), { verdict: 'cancel' }); }
  function stop() { for (const id of Array.from(pending.keys())) settle(id, { verdict: 'shutdown' }); }

  function prune() {
    const t = now();
    for (const [k, s] of sessions) {
      if (hasPending(k)) continue;
      if (s.endedAt ? t - s.endedAt > ENDED_KEEP_MS : t - s.lastAt > SESSION_STALE_MS) sessions.delete(k);
    }
  }

  function snapshot() {
    prune();
    const t = now();
    const live = Array.from(sessions.values())
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((s) => ({
        id: s.id, project: s.project, model: s.model, task: s.task, state: s.state,
        permissionMode: s.permissionMode, turns: s.turns,
        startedAt: s.startedAt, ageMs: t - s.lastAt,
        ended: !!s.endedAt,
        resting: !!s.endedAt || (s.state === 'idle' && t - s.lastAt > SESSION_RESTING_MS),
      }));
    const approvals = Array.from(pending.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => ({
        id: p.id, sessionId: p.sessionId, tool: p.tool, detail: p.detail, risks: p.risks,
        project: p.project, model: p.model, task: p.task,
        waitedMs: t - p.createdAt, expiresInMs: Math.max(0, p.expiresAt - t), urgent: t >= p.urgentAt,
      }));
    return {
      now: t,
      sessions: live,
      approvals,
      sig: live.map((s) => [s.id, s.state, s.task, s.model, s.ended ? 'e' : '', s.resting ? 1 : 0].join(':')).join(',')
        + '|' + approvals.map((a) => a.id + (a.urgent ? '!' : '')).join(','),
    };
  }

  function counts() {
    let running = 0, waiting = 0;
    for (const s of sessions.values()) {
      if (s.endedAt) continue;
      if (s.state === 'running') running++;
      else if (s.state === 'waiting') waiting++;
    }
    return { running, waiting, approvals: pending.size };
  }

  // A session the hooks reported: lets the tile open its conversation.
  function hasSession(id) { return sessions.has(String(id || '')); }

  return {
    applyHook, requestPermission, decide, cancel, stop, snapshot, counts, hasSession,
    get pendingCount() { return pending.size; },
  };
}

// ── what an SDK widget granted the `codex` stream receives ─────────────────
// An allowlist, built here and nowhere else, so what a third-party widget can
// see is one function a test can read. Numbers, the plan name and window
// lengths only: never a folder, a project or conversation name, a prompt, a
// command, an id or the account's email.
function sdkProjection(app, counts) {
  const a = app && typeof app === 'object' ? app : {};
  const lim = a.limits && Array.isArray(a.limits.buckets) ? a.limits : null;
  const win = (w) => (w ? { usedPct: w.pct, windowMins: w.windowMins, resetsAt: w.resetsAt } : null);
  const usage = a.usage && typeof a.usage === 'object' ? a.usage : null;
  const c = counts && typeof counts === 'object' ? counts : {};
  return {
    available: a.state === 'ready' || a.state === 'signedOut',
    signedIn: a.account ? a.account.signedIn === true : null,
    plan: (a.account && a.account.plan) || (lim && lim.plan) || '',
    limits: lim ? lim.buckets.map((b) => ({ id: b.id, label: b.name || '', primary: win(b.primary), secondary: win(b.secondary), reached: !!b.reached })) : [],
    credits: lim && lim.credits ? { has: lim.credits.has, unlimited: lim.credits.unlimited } : null,
    usage: usage ? { today: usage.today, last7: usage.last7, last30: usage.last30, days: usage.days.map((d) => ({ date: d.date, tokens: d.tokens })) } : null,
    activity: { running: c.running || 0, waiting: c.waiting || 0, approvals: c.approvals || 0 },
  };
}

module.exports = {
  createBridge, toHookOutput, sdkProjection,
  describeCodexTool, codexRisks, parsePatch, irreversible,
  DEFAULT_WAIT_MS, URGENT_AFTER_MS, MAX_PENDING,
};
