'use strict';

// ── Claude Code live bridge ──────────────────────────────────────────────────
// Claude Code reports its own state to the hub instead of the hub inferring it
// from transcript mtimes. Two feeds, both originating on this machine from the
// `claude` process itself:
//
//   • the STATUSLINE command (settings.json → statusLine) POSTs the session JSON
//     it receives on stdin. That payload is the ONLY supported source of real
//     subscription quota: rate_limits.five_hour / .seven_day carry a consumed
//     percentage and a reset epoch. It also carries model, cost, context window
//     and session name, all of which the transcript reader can only approximate.
//   • HOOKS (settings.json → hooks) POST lifecycle events. SessionStart/End,
//     UserPromptSubmit, Pre/PostToolUse, Notification and Stop give exact live
//     state; PermissionRequest is the blocking one — Claude Code waits on our
//     HTTP response, so the user can approve a tool call from the touchscreen.
//
// Everything here is IN-MEMORY and per-boot: this is live state, not history
// (claude-usage.js still owns the durable token aggregate read off disk). The
// module holds no timers of its own beyond one expiry timer per pending
// approval, and never writes to disk.
//
// Trust: callers must authenticate the request BEFORE handing a payload here
// (server.js checks the bridge token). Every string that reaches a snapshot is
// length-clamped at this boundary because it renders in the dashboard.

const path = require('path');

// A session we haven't heard from in this long is dropped from the live list.
// Generous because a long tool call (a build, a test suite) is silent, the
// statusline only re-runs on assistant messages, and — the reason this is an
// hour rather than the 15 minutes it started at — a session that has finished
// answering is exactly the one you come back to later. Losing it means losing
// the only handle for sending it a follow-up.
const SESSION_STALE_MS = 60 * 60 * 1000;
// Past this, a session is shown as finished rather than merely quiet: it stops
// competing for room with the ones actually working, without disappearing.
const SESSION_RESTING_MS = 8 * 60 * 1000;
// How long a permission request waits for a tap before we hand the decision
// back to the terminal. Must stay comfortably BELOW the hook's own timeout
// (600s default) so Claude Code gets our response rather than cancelling us.
const APPROVAL_TTL_MS = 9 * 60 * 1000;
// An unanswered request older than this escalates from the tile to a fullscreen
// overlay: at that point the user plainly hasn't noticed the tile.
const URGENT_AFTER_MS = 25 * 1000;
// A question NOTICE is not a permission and nobody is blocked on it, so it does
// not get the full approval window — it is just a heads-up that self-clears if
// the user answered in the terminal and never dismissed the card.
const NOTICE_TTL_MS = 3 * 60 * 1000;

const MAX_SESSIONS = 20;      // bounds the live list (and therefore the payload)
const MAX_PENDING = 8;        // bounds concurrent approvals
const MAX_STR = 220;          // per-field clamp for anything rendered
const MAX_INPUT_CHARS = 800;  // tool-input preview clamp

// Tool calls whose blast radius is wide enough that the tile alone is not
// enough of a prompt — these escalate to the fullscreen overlay immediately
// rather than after URGENT_AFTER_MS. Deliberately conservative: this only
// changes how loudly we ASK, never whether we ask.
const MAX_QUESTIONS = 4;    // matches AskUserQuestion's own cap
const MAX_OPTIONS = 5;      // 4 authored + the implicit "Other"
const DESTRUCTIVE_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'KillShell']);
const DESTRUCTIVE_RE = /\b(rm\s+-[rf]|rmdir|del\s+\/|format\s|mkfs|dd\s+if=|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|drop\s+(table|database)|truncate\s+table|shutdown|Remove-Item)/i;

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s) return '';
  const cap = max || MAX_STR;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 0-100, or null when the field is absent. Each rate-limit window is
// independently optional (and absent entirely for API-key users), so an absent
// window must render as "unknown", never as 0%.
function pct(v) {
  const n = num(v);
  if (n === null) return null;
  return Math.max(0, Math.min(100, n));
}

function projectName(cwd) {
  const c = str(cwd, 400);
  if (!c) return '';
  return str(path.basename(c.replace(/[\\/]+$/, '')) || c, 60);
}

// A short, human description of what a tool call is about to do. Built from the
// tool's own input shape; falls back to nothing rather than dumping raw JSON,
// because this line is what the user reads before tapping Allow.
function describeTool(toolName, input) {
  const t = str(toolName, 60);
  const i = (input && typeof input === 'object') ? input : {};
  if (t === 'Bash') return str(i.command, MAX_INPUT_CHARS);
  if (t === 'Read' || t === 'Write' || t === 'Edit' || t === 'NotebookEdit') return str(i.file_path || i.notebook_path, MAX_INPUT_CHARS);
  if (t === 'Glob' || t === 'Grep') return str(i.pattern, MAX_INPUT_CHARS);
  if (t === 'WebFetch') return str(i.url, MAX_INPUT_CHARS);
  if (t === 'WebSearch') return str(i.query, MAX_INPUT_CHARS);
  if (t === 'Agent' || t === 'Task') return str(i.description || i.prompt, MAX_INPUT_CHARS);
  // Unknown/MCP tool: show the first short string field, if any.
  for (const k of Object.keys(i)) {
    const v = i[k];
    if (typeof v === 'string' && v.trim()) return str(v, MAX_INPUT_CHARS);
  }
  return '';
}

// AskUserQuestion carries the question and its options in the tool input. The
// generic describeTool() saw only an array and produced nothing, so the card
// said "AskUserQuestion" and offered Allow/Deny over a question the user could
// not read. Project the questions so the card can show what is being asked.
//
// Note what this is NOT: approving here lets Claude ASK, it does not answer.
// A hook cannot substitute a tool result, so the answer is still given in the
// terminal. Only a run started through the Agent SDK can be answered from
// outside (its canUseTool callback returns the answers as updated input).
function describeQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : null;
  if (!qs || !qs.length) return null;
  const out = [];
  for (const q of qs.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object') continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    out.push({
      question: str(q.question, MAX_INPUT_CHARS),
      header: str(q.header, 40),
      multiSelect: q.multiSelect === true,
      options: opts.slice(0, MAX_OPTIONS).map((o) => ({
        label: str(o && o.label, 120),
        description: str(o && o.description, 240),
      })).filter((o) => o.label),
    });
  }
  return out.length ? out : null;
}

// Is this "user" text actually the harness talking? Claude Code delivers task
// notifications, system reminders, skill preambles and command output through
// the same user-turn channel a person types into, so both the live bridge and
// the transcript reader have to tell them apart. ONE definition, used by both
// (claude-usage.js requires it) — two copies would drift and the drift shows up
// as internal plumbing rendered on the user's dashboard.
const INJECTED_RE = /^(Base directory for this skill\b|Caveat:|The user (opened|selected)|This session is)/;
function isInjectedPrompt(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  // Anything opening as a tag or a bracketed marker: <task-notification>,
  // <system-reminder>, <command-name>, [Request interrupted…].
  if (s.charAt(0) === '<' || s.charAt(0) === '[') return true;
  return INJECTED_RE.test(s);
}

function isDestructive(toolName, detail) {
  if (!DESTRUCTIVE_TOOLS.has(str(toolName, 60))) return false;
  return DESTRUCTIVE_RE.test(String(detail || ''));
}

function createBridge(opts) {
  const options = opts || {};
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};

  const sessions = new Map();   // session_id → live session record
  const pending = new Map();    // approval id → { …, resolve, timer }
  let limits = null;            // latest rate-limit reading (account-wide)
  let seq = 0;                  // approval id counter (ids are per-boot)

  function touchSession(id, patch) {
    const key = str(id, 80);
    if (!key) return null;
    let s = sessions.get(key);
    if (!s) {
      // Bound the map: drop the least recently seen session rather than growing.
      if (sessions.size >= MAX_SESSIONS) {
        let oldestKey = null, oldestAt = Infinity;
        for (const [k, v] of sessions) if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestKey = k; }
        if (oldestKey) sessions.delete(oldestKey);
      }
      s = { id: key, project: '', cwd: '', branch: '', model: '', name: '', task: '', tool: '', state: 'idle', startedAt: now(), lastAt: now(), cost: null, contextPct: null };
      sessions.set(key, s);
    }
    Object.assign(s, patch, { lastAt: now() });
    return s;
  }

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
      if (fivePct !== null || sevenPct !== null) {
        limits = {
          fiveHour: fivePct === null ? null : { pct: fivePct, resetsAt: num(five.resets_at) },
          sevenDay: sevenPct === null ? null : { pct: sevenPct, resetsAt: num(seven.resets_at) },
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

  // ── hook feed ──────────────────────────────────────────────────────────────
  // Non-blocking lifecycle events. Returns true when the event moved state.
  function applyHook(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const ev = str(d.hook_event_name, 60);
    const id = str(d.session_id, 80);
    if (!id) return false;

    // EVERY hook payload carries `cwd`, and it used to be read on SessionStart
    // alone. A session whose first event reaches us later than its start (Xenon
    // started after it, the hooks were installed mid-session, a permission
    // request arriving before anything else) then had no project at all and the
    // widget drew it as "?" — unnameable, and impossible to continue, because
    // continuing resolves the folder from the project. Record it whenever it
    // shows up, and keep the full path: the folder is what a resume needs, and
    // the basename alone cannot tell two `xenon` folders apart.
    const cwd = str(d.cwd, 400);
    if (cwd) touchSession(id, { cwd, project: projectName(cwd) });

    switch (ev) {
      case 'SessionStart':
        touchSession(id, { project: projectName(d.cwd), state: 'idle', tool: '', startedAt: now() });
        break;
      case 'UserPromptSubmit': {
        // The hook fires for harness-injected "user" turns too — task
        // notifications, system reminders, skill preambles — and one of those
        // as the session's headline reads like the user asked for it. Keep the
        // last REAL prompt instead of overwriting it with plumbing.
        const patch = { state: 'running', tool: '' };
        const prompt = str(d.prompt, MAX_STR);
        if (prompt && !isInjectedPrompt(prompt)) patch.task = prompt;
        touchSession(id, patch);
        break;
      }
      case 'PreToolUse':
        touchSession(id, { tool: str(d.tool_name, 60), state: 'running' });
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        touchSession(id, { tool: '', state: 'running' });
        break;
      case 'Notification':
        // Claude Code surfaced something that wants the user: treat as waiting.
        touchSession(id, { state: 'waiting', note: str(d.message, MAX_STR) });
        break;
      case 'Stop':
        touchSession(id, { state: 'idle', tool: '' });
        break;
      case 'SessionEnd':
        sessions.delete(id);
        break;
      default:
        // Unknown/other event: still a liveness signal, nothing more.
        touchSession(id, {});
        break;
    }
    emit();
    return true;
  }

  // ── blocking permission requests ───────────────────────────────────────────
  // Returns { id, promise }. The promise resolves to 'allow' | 'deny' | 'timeout'.
  // 'timeout' means WE decline to answer, so the caller must respond in a way
  // that hands the choice back to Claude Code's own terminal prompt — never an
  // implicit allow.
  function requestPermission(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const sessionId = str(d.session_id, 80);
    const tool = str(d.tool_name, 60) || 'tool';
    const detail = describeTool(tool, d.tool_input);
    const questions = tool === 'AskUserQuestion' ? describeQuestions(d.tool_input) : null;

    // Too many already waiting → refuse to queue another. The caller hands this
    // back to the terminal rather than letting the tile become a backlog.
    if (pending.size >= MAX_PENDING) return null;

    const s = sessions.get(sessionId);
    if (s) { s.state = 'waiting'; s.lastAt = now(); }

    const id = 'p' + (++seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      project: (s && s.project) || projectName(d.cwd),
      tool,
      detail,
      questions,
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      urgentAt: isDestructive(tool, detail) ? createdAt : createdAt + URGENT_AFTER_MS,
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => { rec.resolve = resolve; });
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      if (s) s.state = 'running';
      rec.resolve('timeout');
      emit();
    }, APPROVAL_TTL_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // AskUserQuestion, shown but never blocked on.
  //
  // It is the one tool that cannot touch anything: it asks, and that is all. So
  // a permission prompt over it was a trap in both directions. Approving only
  // meant "put the question in the terminal" — the card could show the question
  // but never take the answer, because a hook cannot supply a tool's result —
  // and denying silently destroyed a question the user then never saw anywhere,
  // leaving Claude to guess at exactly the point it had decided to ask.
  //
  // The caller answers "no decision" immediately instead, which is already the
  // path that routes the prompt to Claude Code's own terminal UI. This leaves a
  // card behind purely as a heads-up, so someone at the display still learns
  // they are being asked something and where to answer. It resolves nothing and
  // holds no response open: dismissing it is housekeeping, not a decision.
  function postQuestion(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const questions = describeQuestions(d.tool_input);
    if (!questions) return null;                   // nothing readable to show
    if (pending.size >= MAX_PENDING) return null;

    const sessionId = str(d.session_id, 80);
    const s = sessions.get(sessionId);
    const id = 'q' + (++seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      project: (s && s.project) || projectName(d.cwd),
      tool: 'AskUserQuestion',
      detail: '',
      questions,
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + NOTICE_TTL_MS,
      urgentAt: Infinity,          // never hijacks the display: nothing is blocked
      notice: true,
      resolve: null,
      timer: null,
    };
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      emit();
    }, NOTICE_TTL_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return id;
  }

  // The user tapped. Returns true when this actually settled a live request —
  // a stale tap (already expired, or answered on another surface) returns false
  // so the caller can tell the surface its decision arrived too late.
  function decide(id, behavior) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    const verdict = behavior === 'allow' ? 'allow' : 'deny';
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    // A notice blocks nothing, so a tap on it is a dismissal and must NOT touch
    // the session state: the session is still legitimately waiting on the user,
    // in the terminal, and marking it 'running' would show it as unblocked.
    if (rec.notice) { emit(); return true; }
    if (s) { s.state = 'running'; s.lastAt = now(); }
    rec.resolve(verdict);
    emit();
    return true;
  }

  // Claude Code went away while we were waiting (Ctrl-C, or it cancelled the
  // hook). Drop the request without resolving a decision — nobody is listening
  // for one, and leaving it on the tile would invite a tap that goes nowhere.
  function cancel(id) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    if (s) s.state = 'running';
    if (rec.resolve) rec.resolve('timeout');   // a notice has nobody waiting
    emit();
    return true;
  }

  // ── snapshot ───────────────────────────────────────────────────────────────
  function prune() {
    const t = now();
    for (const [k, s] of sessions) if (t - s.lastAt > SESSION_STALE_MS) sessions.delete(k);
  }

  function snapshot() {
    prune();
    const t = now();
    const live = Array.from(sessions.values())
      .sort((a, b) => b.lastAt - a.lastAt)
      .map(s => ({
        id: s.id,
        project: s.project,
        branch: s.branch,
        model: s.model,
        name: s.name,
        task: s.task,
        tool: s.tool,
        state: s.state,
        contextPct: s.contextPct,
        cost: s.cost,
        ageMs: t - s.lastAt,
        // Quiet for long enough that it reads as finished. The widget files
        // these under their own heading instead of dropping them, so a session
        // stays reachable for the follow-up you think of ten minutes later.
        resting: (t - s.lastAt) > SESSION_RESTING_MS,
      }));

    const approvals = Array.from(pending.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(p => ({
        id: p.id,
        project: p.project,
        tool: p.tool,
        detail: p.detail,
        questions: p.questions || null,
        task: p.task,
        model: p.model,
        waitedMs: t - p.createdAt,
        expiresInMs: Math.max(0, p.expiresAt - t),
        urgent: t >= p.urgentAt,
        notice: !!p.notice,
      }));

    return {
      limits: limits ? { ...limits, ageMs: t - limits.at } : null,
      sessions: live,
      approvals,
      // Cheap change key so the caller can skip an unchanged SSE push. Includes
      // per-session state and the pending set, because those are exactly what a
      // repaint is for.
      sig: live.map(s => `${s.id}:${s.state}:${s.tool}:${s.resting ? 1 : 0}`).join(',')
        + '|' + approvals.map(a => a.id + (a.urgent ? '!' : '')).join(',')
        + '|' + (limits ? `${limits.fiveHour && limits.fiveHour.pct}/${limits.sevenDay && limits.sevenDay.pct}` : ''),
    };
  }

  let emitScheduled = false;
  function emit() {
    // Coalesce bursts (a hook and a statusline post often land together) into
    // one notification on the next tick.
    if (emitScheduled) return;
    emitScheduled = true;
    setImmediate(() => { emitScheduled = false; try { onChange(); } catch { /* never let a listener break ingest */ } });
  }

  // Shutdown: settle everything still waiting so no Claude Code process is left
  // hanging on a response the hub will never send.
  function stop() {
    for (const [, rec] of pending) {
      if (rec.timer) clearTimeout(rec.timer);
      if (rec.resolve) rec.resolve('timeout');   // a notice has nobody waiting
    }
    pending.clear();
    sessions.clear();
  }

  // Server-side only, deliberately NOT in the snapshot: the folder a session
  // lives in is what a resume needs, and the page has no business receiving
  // absolute paths it never has to send back. The client names a session by id
  // and the server turns that into a folder, which keeps "a path never arrives
  // from the wire" intact while letting a resume find its own project.
  function cwdFor(id) {
    const s = sessions.get(str(id, 80));
    return (s && s.cwd) || '';
  }

  return { applyStatus, applyHook, requestPermission, postQuestion, decide, cancel, snapshot, stop, cwdFor,
    get pendingCount() { return pending.size; } };
}

module.exports = {
  createBridge,
  describeTool,
  isDestructive,
  isInjectedPrompt,
  APPROVAL_TTL_MS,
  URGENT_AFTER_MS,
  NOTICE_TTL_MS,
  SESSION_STALE_MS,
  SESSION_RESTING_MS,
};
