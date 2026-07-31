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
//
// ── What a hook can and cannot do, measured rather than assumed ──────────────
// Three things in here look like clever tricks and are not: each was tested
// against Claude Code 2.1.220 before any of it was written, because the whole
// point of this module is that a control on the touchscreen does a real thing
// in the session. The results, so the next person does not have to re-derive
// them (or, worse, "fix" one of them back into a control that does nothing):
//
//   1. PreToolUse → hookSpecificOutput.updatedInput REWRITES the tool input
//      before it runs. Verified: a Bash call for `echo HELLO_ORIGINAL` executed
//      as the rewritten command instead.
//   2. PreToolUse → permissionDecision:'deny' + permissionDecisionReason puts
//      the reason IN FRONT OF THE MODEL, and it acts on it. Verified: a denied
//      Bash call whose reason carried a chosen option made Claude reply with
//      that option. This is what answers a question from the tile (see
//      askQuestion) — it is proven, whereas (1) on AskUserQuestion specifically
//      could not be tested headlessly, since that tool exists only in an
//      interactive session.
//   3. Stop → { decision:'block', reason } does NOT end the turn: the reason
//      arrives as a new instruction in the SAME session and Claude carries on.
//      Verified end to end. This is how a follow-up typed on the dashboard
//      reaches the session you are looking at instead of spawning a second one.
//
// The rule those three serve: every control this module puts on screen either
// does something real in the session, or is not drawn. A card that can only be
// dismissed is a bug report waiting to happen — that is exactly what the old
// AskUserQuestion notice was.

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
// A question waits like a permission does — Claude Code is genuinely blocked on
// it — but shorter, because the same question is also sitting in the terminal
// and the user may well answer it there. When this runs out we return no
// decision, which lets the tool proceed and ask in the terminal exactly as it
// would have without us.
const QUESTION_TTL_MS = 4 * 60 * 1000;
// A follow-up typed on the dashboard is delivered when the current turn ends.
// If that turn never ends (the session was killed, or it went quiet without a
// Stop) the text must not sit in a queue forever pretending to be on its way.
const FOLLOWUP_TTL_MS = 15 * 60 * 1000;

const MAX_SESSIONS = 20;      // bounds the live list (and therefore the payload)
const MAX_PENDING = 8;        // bounds concurrent approvals
const MAX_STR = 220;          // per-field clamp for anything rendered
const MAX_INPUT_CHARS = 800;  // tool-input preview clamp
const MAX_TODOS = 12;         // the plan lane; a longer list is scrolled, not stored
const MAX_ACTIVITY = 30;      // per-session ring of finished tool calls
const MAX_SUBAGENTS = 8;
const MAX_FOLLOWUP_CHARS = 4000;

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
// These are answerable from the tile: see askQuestion, and note 2 in the header
// for how. What is NOT possible is substituting a tool RESULT, so the answer
// travels as a decision reason rather than as the tool's return value — which
// is why the reason text below is written as carefully as it is.
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

// TodoWrite's input is Claude's own plan for the work in front of it, and it is
// the single most useful thing a dashboard can show: not "it is busy" but where
// it has got to. Read it off the tool call rather than out of the transcript.
function describeTodos(input) {
  const raw = input && Array.isArray(input.todos) ? input.todos : null;
  if (!raw) return null;
  const out = [];
  for (const it of raw.slice(0, MAX_TODOS)) {
    if (!it || typeof it !== 'object') continue;
    // `activeForm` is the present-tense phrasing Claude uses while a step runs
    // ("Running the tests"); it reads better than the imperative on a tile that
    // is showing what is happening right now.
    const st = str(it.status, 20).toLowerCase();
    const status = st === 'completed' ? 'done' : (st === 'in_progress' ? 'doing' : 'todo');
    const text = str(status === 'doing' ? (it.activeForm || it.content) : (it.content || it.activeForm), 120);
    if (text) out.push({ text, status });
  }
  return out.length ? out : null;
}

// The text handed to Claude when the user answers a question from the tile.
//
// This is the load-bearing string of the whole feature, because the mechanism
// available to us is a DENIED tool call with a reason (header note 2): Claude
// has to read this and understand that it received an answer, not a refusal. So
// it states the answer plainly, quotes the option labels verbatim so there is
// nothing to infer, and closes the loop explicitly — without the last line the
// obvious next move for a model whose tool just failed is to ask again.
function answerReason(questions, selections) {
  const lines = [];
  const qs = Array.isArray(questions) ? questions : [];
  for (let i = 0; i < qs.length; i++) {
    const picked = Array.isArray(selections[i]) ? selections[i].filter(Boolean) : [];
    if (!picked.length) continue;
    lines.push(`- ${qs[i].question || qs[i].header || 'Question ' + (i + 1)}\n  Answer: ${picked.join(', ')}`);
  }
  if (!lines.length) return '';
  return 'The user answered from the Xenon dashboard instead of the terminal, so this '
    + 'AskUserQuestion call was intercepted and carries their answer.\n\n'
    + lines.join('\n')
    + '\n\nTreat this as the answer to the question you just asked. Do not ask it again; '
    + 'continue with the work using these choices.';
}

// The text handed to Claude when a follow-up typed on the dashboard is delivered
// at the end of a turn (header note 3). It is framed as what it is — the user
// speaking, a moment late — because an unlabelled instruction arriving out of
// nowhere reads like an injection attempt, and is correctly treated as one.
function followUpReason(text) {
  const t = str(text, MAX_FOLLOWUP_CHARS);
  if (!t) return '';
  return 'The user sent this from the Xenon dashboard while you were finishing. '
    + 'It is a follow-up in this same conversation, from the same person:\n\n'
    + t;
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
      s = {
        id: key, project: '', cwd: '', branch: '', model: '', name: '', task: '',
        // What is running RIGHT NOW. `tool` alone used to be all we kept, which
        // is why a working session said "Bash" and could not say which command.
        tool: '', toolDetail: '', toolAt: 0,
        state: 'idle',
        // WHY the session is waiting, when it is. Held as a reason rather than a
        // bare flag because "waiting" with nothing to show is the state the old
        // widget could not explain, and an unexplained wait is indistinguishable
        // from a hang.
        waitFor: null,
        todos: [], plan: '', subagents: [], activity: [],
        compacting: false, permissionMode: '', effort: '',
        lastSaid: '', linesAdded: null, linesRemoved: null,
        startedAt: now(), lastAt: now(), cost: null, contextPct: null,
        endedAt: 0, endedReason: '',
        // Corroboration from Claude Code's own registry (claude-sessions.js).
        pid: null, alive: true,
        queued: null,
      };
      sessions.set(key, s);
    }
    Object.assign(s, patch, { lastAt: now() });
    return s;
  }

  // A session is waiting only while the thing it waits for is unresolved. The
  // old code cleared `waiting` on any PostToolUse, so a tool finishing somewhere
  // else in the turn made a session that was still blocked on you look busy.
  function setWait(s, kind, text) {
    if (!s) return;
    s.state = 'waiting';
    s.waitFor = { kind, text: str(text, MAX_STR), at: now() };
  }
  function clearWait(s, kind) {
    if (!s || !s.waitFor) return;
    if (kind && s.waitFor.kind !== kind) return;
    s.waitFor = null;
    if (s.state === 'waiting') s.state = 'running';
  }

  function pushActivity(s, entry) {
    if (!s) return;
    s.activity.push(entry);
    if (s.activity.length > MAX_ACTIVITY) s.activity.splice(0, s.activity.length - MAX_ACTIVITY);
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
      // Already arriving on every statusline post and never read until now. It
      // is the one number that says what a session has actually DONE to the
      // repo, which no token count can.
      linesAdded: num(cost.total_lines_added),
      linesRemoved: num(cost.total_lines_removed),
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

    // Present on every event since 2.1.x and worth showing: a session running in
    // acceptEdits or bypassPermissions will never send a permission card, and a
    // user waiting for one deserves to know that rather than wonder.
    const ambient = {};
    const pm = str(d.permission_mode, 30);
    if (pm) ambient.permissionMode = pm;
    const eff = d.effort && typeof d.effort === 'object' ? str(d.effort.level, 20) : '';
    if (eff) ambient.effort = eff;
    if (Object.keys(ambient).length) touchSession(id, ambient);

    switch (ev) {
      case 'SessionStart':
        touchSession(id, {
          project: projectName(d.cwd), state: 'idle', tool: '', toolDetail: '',
          startedAt: now(), endedAt: 0, endedReason: '', waitFor: null,
          // `source` tells resume/compact apart from a genuinely new session, so
          // a resumed one does not present itself as starting from nothing.
          startSource: str(d.source, 30),
        });
        break;
      case 'UserPromptSubmit': {
        // The hook fires for harness-injected "user" turns too — task
        // notifications, system reminders, skill preambles — and one of those
        // as the session's headline reads like the user asked for it. Keep the
        // last REAL prompt instead of overwriting it with plumbing.
        const patch = { state: 'running', tool: '', toolDetail: '', waitFor: null };
        const prompt = str(d.prompt, MAX_STR);
        if (prompt && !isInjectedPrompt(prompt)) patch.task = prompt;
        touchSession(id, patch);
        break;
      }
      case 'PreToolUse': {
        const tool = str(d.tool_name, 60);
        const s = touchSession(id, {
          tool,
          // describeTool() already existed and was called only when ASKING for
          // permission, so a session running unattended showed a tool name with
          // no argument. It is the same one line either way.
          toolDetail: describeTool(tool, d.tool_input),
          toolAt: now(),
          state: 'running',
        });
        // A tool starting means Claude is moving again, so whatever notification
        // it raised is over. A permission or a question is NOT over — those are
        // settled by their own path, and clearing them here would un-block a
        // session that is still blocked.
        clearWait(s, 'notification');
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const tool = str(d.tool_name, 60);
        const s = touchSession(id, { tool: '', toolDetail: '' });
        // TodoWrite is not an action to log, it IS the plan. Read it here rather
        // than on PreToolUse so the lane only ever shows a list that was really
        // written.
        if (tool === 'TodoWrite') {
          const todos = describeTodos(d.tool_input);
          if (todos) s.todos = todos;
        }
        pushActivity(s, {
          tool,
          detail: describeTool(tool, d.tool_input),
          ok: ev !== 'PostToolUseFailure',
          // Claude Code sends the real figure; no pairing with PreToolUse needed.
          ms: num(d.duration_ms),
          at: now(),
          agent: str(d.agent_type || d.agent_id, 40),
        });
        // NOT a state write. A tool finishing says nothing about whether the
        // session is waiting on the user — this line used to force 'running' and
        // was the reason a blocked session kept claiming to be working.
        if (s.state !== 'waiting') s.state = 'running';
        break;
      }
      case 'Notification':
        setWait(touchSession(id, {}), 'notification', d.message);
        break;
      case 'SubagentStart': {
        const s = touchSession(id, {});
        const agentId = str(d.agent_id, 60);
        if (agentId && !s.subagents.some((a) => a.id === agentId)) {
          s.subagents.push({ id: agentId, type: str(d.agent_type, 40), at: now() });
          if (s.subagents.length > MAX_SUBAGENTS) s.subagents.shift();
        }
        break;
      }
      case 'SubagentStop': {
        const s = touchSession(id, {});
        const agentId = str(d.agent_id, 60);
        s.subagents = s.subagents.filter((a) => a.id !== agentId);
        break;
      }
      case 'PreCompact':
        // Without this the context gauge collapses for no visible reason and
        // reads as a glitch. It is an event, so it gets said.
        touchSession(id, { compacting: true });
        break;
      case 'PostCompact':
        touchSession(id, { compacting: false, contextPct: null });
        break;
      case 'Stop': {
        const s = touchSession(id, {
          state: 'idle', tool: '', toolDetail: '', compacting: false,
          // What Claude actually said, straight off the hook — the transcript
          // reader exists for history, and this is the live line.
          lastSaid: str(d.last_assistant_message, MAX_STR),
        });
        clearWait(s, 'notification');
        break;
      }
      case 'StopFailure':
        // The turn ended on an API error rather than an answer. Distinct from
        // idle: nothing is coming, and the user is the one who has to notice.
        setWait(touchSession(id, { tool: '', toolDetail: '' }), 'error', d.error || d.reason);
        break;
      case 'SessionEnd': {
        // Not a delete. A session that has just ended is exactly the one the
        // user looks at next ("did it finish, or did I kill it?"), and dropping
        // the record answered neither. It is filed as ended and pruned normally.
        const s = touchSession(id, {
          state: 'idle', tool: '', toolDetail: '', waitFor: null, subagents: [],
          endedAt: now(), endedReason: str(d.reason, 40) || 'other',
        });
        if (s) s.queued = null;   // nothing will ever deliver it now
        break;
      }
      default:
        // Unknown/other event: still a liveness signal, nothing more.
        touchSession(id, {});
        break;
    }
    emit();
    return true;
  }

  // ── follow-ups into a live session ─────────────────────────────────────────
  // Delivered by the Stop hook (header note 3), so this only works on a session
  // that is going to finish a turn. An idle session will never fire Stop again;
  // the caller resumes it as a run instead, and the tile says which of the two
  // is about to happen rather than offering one box that behaves as either.
  function queueFollowUp(sessionId, text) {
    const s = sessions.get(str(sessionId, 80));
    if (!s) return { ok: false, error: 'unknown_session' };
    if (s.endedAt) return { ok: false, error: 'session_ended' };
    const t = str(text, MAX_FOLLOWUP_CHARS);
    if (!t) return { ok: false, error: 'empty' };
    if (s.queued) return { ok: false, error: 'already_queued' };
    s.queued = { text: t, at: now() };
    emit();
    return { ok: true };
  }

  function cancelFollowUp(sessionId) {
    const s = sessions.get(str(sessionId, 80));
    if (!s || !s.queued) return false;
    s.queued = null;
    emit();
    return true;
  }

  // Called from the Stop hook handler. Hands over the queued text ONCE and
  // clears it — which is also the loop guard: a blocked Stop fires Stop again,
  // and an empty queue answers with no decision, so the turn ends normally.
  function takeFollowUp(sessionId) {
    const s = sessions.get(str(sessionId, 80));
    if (!s || !s.queued) return '';
    const { text, at } = s.queued;
    s.queued = null;
    // Too old to still be what the user meant: they typed it, walked away, and
    // the turn only ended a quarter of an hour later.
    if (now() - at > FOLLOWUP_TTL_MS) { emit(); return ''; }
    s.state = 'running';
    s.lastAt = now();
    emit();
    return followUpReason(text);
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
    if (s) { setWait(s, 'permission', detail || tool); s.lastAt = now(); }

    const id = 'p' + (++seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      kind: 'permission',
      project: (s && s.project) || projectName(d.cwd),
      tool,
      detail,
      questions,
      // ExitPlanMode's whole payload is the plan the user is being asked to
      // approve. Showing "ExitPlanMode" and an Allow button over it asked the
      // user to approve something they could not read.
      plan: tool === 'ExitPlanMode' ? str(d.tool_input && d.tool_input.plan, 4000) : '',
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
      clearWait(s, 'permission');
      rec.resolve({ verdict: 'timeout' });
      emit();
    }, APPROVAL_TTL_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // AskUserQuestion — a real question, answered from the touchscreen.
  //
  // This used to be a notice: a card showing the question with untappable
  // options and a Dismiss button, because the belief was that a hook cannot
  // answer. Half right. A hook cannot supply a tool RESULT — but it can deny the
  // call with a reason, and the reason is put in front of the model, which acts
  // on it (header note 2, measured). So the answer travels as a reason, and the
  // card gets to be what it always looked like.
  //
  // It arrives on PreToolUse rather than PermissionRequest for two reasons:
  // PreToolUse always fires, and it fires BEFORE the terminal prompt is drawn,
  // which is the only moment an outside answer can still save the user a trip.
  //
  // Nothing here can auto-answer. Running out of time resolves 'skip', which is
  // an empty hook response, which is the tool proceeding and asking in the
  // terminal exactly as it would have if Xenon were not installed.
  function askQuestion(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const questions = describeQuestions(d.tool_input);
    if (!questions) return null;                   // nothing readable to show
    if (pending.size >= MAX_PENDING) return null;

    const sessionId = str(d.session_id, 80);
    const s = sessions.get(sessionId);
    if (s) { setWait(s, 'question', questions[0] && questions[0].question); s.lastAt = now(); }

    const id = 'q' + (++seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      kind: 'question',
      project: (s && s.project) || projectName(d.cwd),
      tool: 'AskUserQuestion',
      detail: '',
      questions,
      plan: '',
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + QUESTION_TTL_MS,
      // A question never seizes the whole screen. It blocks Claude, but it is
      // not destructive and it is also sitting in the terminal — hijacking the
      // display over a choice of approach is out of proportion.
      urgentAt: Infinity,
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => { rec.resolve = resolve; });
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      clearWait(s, 'question');
      rec.resolve({ verdict: 'skip' });
      emit();
    }, QUESTION_TTL_MS);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // The user chose. `selections` is one array of labels per question, in the
  // order the card showed them. Labels are matched against the options we
  // published rather than trusted: the reason string goes to the model, and the
  // only strings allowed in it are ones Claude itself wrote.
  function answer(id, selections) {
    const rec = pending.get(str(id, 80));
    if (!rec || rec.kind !== 'question') return false;

    const picked = [];
    let any = false;
    for (let i = 0; i < rec.questions.length; i++) {
      const allowed = new Set(rec.questions[i].options.map((o) => o.label));
      const raw = Array.isArray(selections) && Array.isArray(selections[i]) ? selections[i] : [];
      const keep = [];
      for (const label of raw) {
        const l = str(label, 120);
        // "Other" is offered by the tool itself and never appears in options.
        if (l && (allowed.has(l) || l === 'Other')) keep.push(l);
        if (keep.length >= MAX_OPTIONS) break;
      }
      if (!rec.questions[i].multiSelect && keep.length > 1) keep.length = 1;
      if (keep.length) any = true;
      picked.push(keep);
    }
    // Nothing recognisable chosen: refuse rather than send Claude an answer that
    // says nothing. The card stays up and the user can try again.
    if (!any) return false;

    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'question');
    if (s) s.lastAt = now();
    rec.resolve({ verdict: 'answer', reason: answerReason(rec.questions, picked) });
    emit();
    return true;
  }

  // The user wants this one in the terminal after all. Resolves 'skip', which is
  // the same empty response the timeout gives: the tool runs and asks there.
  function skipQuestion(id) {
    const rec = pending.get(str(id, 80));
    if (!rec || rec.kind !== 'question') return false;
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    clearWait(sessions.get(rec.sessionId), 'question');
    rec.resolve({ verdict: 'skip' });
    emit();
    return true;
  }

  // The user tapped. Returns true when this actually settled a live request —
  // a stale tap (already expired, or answered on another surface) returns false
  // so the caller can tell the surface its decision arrived too late.
  function decide(id, behavior) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    // A question is not a permission and is never settled by Allow/Deny — it
    // has its own answer path, which carries the choice. Routing it here would
    // reintroduce exactly the card that could not do what it showed.
    if (rec.kind === 'question') return false;
    const verdict = behavior === 'allow' ? 'allow' : 'deny';
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'permission');
    if (s) s.lastAt = now();
    rec.resolve({ verdict });
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
    clearWait(s, rec.kind === 'question' ? 'question' : 'permission');
    if (rec.resolve) rec.resolve({ verdict: rec.kind === 'question' ? 'skip' : 'timeout' });
    emit();
    return true;
  }

  // ── corroboration from Claude Code's own registry ──────────────────────────
  // Rows come from claude-sessions.js. Advisory, never authoritative: it fills
  // in sessions the hook feed cannot know about and retires ones whose process
  // is gone. Everything a hook told us wins over everything a file says, because
  // the hook came from the session itself and this is a snapshot on disk.
  function mergeRegistry(rows) {
    if (!Array.isArray(rows) || !rows.length) return false;
    let moved = false;
    const seen = new Set();
    for (const r of rows) {
      if (!r || !r.sessionId) continue;
      seen.add(r.sessionId);
      const known = sessions.get(r.sessionId);

      if (!r.alive) {
        // The one thing the registry knows that no hook can say: this process
        // is gone. A session killed with Ctrl-C sends no SessionEnd and used to
        // sit in the live list for an hour, tappable, offering a follow-up that
        // nothing would ever deliver.
        if (known && !known.endedAt) {
          known.endedAt = now();
          known.endedReason = 'gone';
          known.state = 'idle';
          known.tool = ''; known.toolDetail = ''; known.waitFor = null;
          known.subagents = []; known.queued = null;
          moved = true;
        }
        continue;
      }

      if (known) {
        // Liveness and identity only. State stays with the hooks: 'busy' here is
        // a coarse flag written on a timer, while the hook feed knows which tool
        // is running and whether the session is blocked on the user.
        if (known.pid !== r.pid || known.alive !== true) moved = true;
        known.pid = r.pid;
        known.alive = true;
        if (!known.name && r.name && !r.nameDerived) known.name = r.name;
        if (!known.cwd && r.cwd) { known.cwd = r.cwd; known.project = projectName(r.cwd); }
        if (known.endedAt) { known.endedAt = 0; known.endedReason = ''; moved = true; }
        continue;
      }

      // Unknown to us and running: Claude Code was started before Xenon, or
      // before it was linked. Show it, marked as something we can see but are
      // not wired into — the widget explains the difference rather than drawing
      // a session whose controls would all fail.
      const s = touchSession(r.sessionId, {
        cwd: r.cwd,
        project: projectName(r.cwd),
        name: r.nameDerived ? '' : r.name,
        state: r.status === 'busy' ? 'running' : 'idle',
        startedAt: r.startedAt || now(),
        pid: r.pid,
        alive: true,
        unlinked: true,
      });
      if (s) moved = true;
    }

    // A session we know about that has NO registry file, while the registry is
    // otherwise readable, has exited without telling us. Only conclude that for
    // sessions the registry could plausibly have listed — one that never had a
    // pid was never in there to begin with.
    for (const [, s] of sessions) {
      if (s.endedAt || seen.has(s.id) || s.pid === null) continue;
      s.endedAt = now();
      s.endedReason = 'gone';
      s.state = 'idle';
      s.tool = ''; s.toolDetail = ''; s.waitFor = null; s.queued = null;
      moved = true;
    }

    if (moved) emit();
    return moved;
  }

  // ── snapshot ───────────────────────────────────────────────────────────────
  function prune() {
    const t = now();
    for (const [k, s] of sessions) {
      // An ended session is kept only long enough to be read, not for the full
      // hour a quiet-but-live one gets: it cannot be continued, so it is history
      // the moment the user has seen it.
      const limit = s.endedAt ? SESSION_RESTING_MS : SESSION_STALE_MS;
      const since = s.endedAt || s.lastAt;
      if (t - since > limit) sessions.delete(k);
    }
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
        // What the tool is actually doing. The row said "Bash" for as long as
        // this field did not exist.
        toolDetail: s.toolDetail,
        toolForMs: s.toolAt ? t - s.toolAt : null,
        state: s.state,
        // Why it is waiting, when it is — never a bare "waiting".
        waitFor: s.waitFor ? { kind: s.waitFor.kind, text: s.waitFor.text, forMs: t - s.waitFor.at } : null,
        todos: s.todos,
        subagents: s.subagents,
        activity: s.activity,
        compacting: s.compacting,
        permissionMode: s.permissionMode,
        effort: s.effort,
        lastSaid: s.lastSaid,
        contextPct: s.contextPct,
        cost: s.cost,
        linesAdded: s.linesAdded,
        linesRemoved: s.linesRemoved,
        startedAt: s.startedAt,
        runForMs: t - s.startedAt,
        ageMs: t - s.lastAt,
        ended: !!s.endedAt,
        endedReason: s.endedReason,
        // A session Xenon can see (its own registry file) but is not wired into,
        // because it started before Claude Code was linked. Its controls would
        // all fail, so the widget says so instead of offering them.
        unlinked: !!s.unlinked,
        queued: s.queued ? { text: s.queued.text, ageMs: t - s.queued.at } : null,
        // Quiet for long enough that it reads as finished. The widget files
        // these under their own heading instead of dropping them, so a session
        // stays reachable for the follow-up you think of ten minutes later.
        resting: !!s.endedAt || (t - s.lastAt) > SESSION_RESTING_MS,
      }));

    const approvals = Array.from(pending.values())
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(p => ({
        id: p.id,
        sessionId: p.sessionId,
        // 'permission' → Allow/Deny, runs on the PC. 'question' → pick an
        // option, answers Claude. The client renders a different card for each
        // and must never guess from the tool name.
        kind: p.kind,
        project: p.project,
        tool: p.tool,
        detail: p.detail,
        questions: p.questions || null,
        plan: p.plan || '',
        task: p.task,
        model: p.model,
        waitedMs: t - p.createdAt,
        expiresInMs: Math.max(0, p.expiresAt - t),
        urgent: t >= p.urgentAt,
      }));

    return {
      limits: limits ? { ...limits, ageMs: t - limits.at } : null,
      sessions: live,
      approvals,
      // Cheap change key so the caller can skip an unchanged SSE push. Covers
      // everything a repaint exists for — and the plan lane is in it, because a
      // todo ticking over with no other change is precisely the update this
      // widget was rebuilt to show.
      sig: live.map(s => [
        s.id, s.state, s.tool, s.toolDetail,
        s.waitFor ? s.waitFor.kind : '',
        s.todos.map(x => x.status).join(''),
        s.subagents.length, s.activity.length,
        s.queued ? 'q' : '', s.ended ? 'e' : '', s.resting ? 1 : 0,
      ].join(':')).join(',')
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
      // Both non-answers: the permission goes back to the terminal prompt, the
      // question is asked there. Shutting down must never look like a decision.
      if (rec.resolve) rec.resolve({ verdict: rec.kind === 'question' ? 'skip' : 'timeout' });
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

  // Is this session one we can still act on? The composer asks before offering
  // a box, so it can say which of the two things will happen instead of
  // discovering it on send. 'followup' = a turn is running and Stop will deliver
  // it; 'resume' = idle, so the caller continues the same conversation as a run;
  // 'none' = ended or never ours.
  function replyModeFor(id) {
    const s = sessions.get(str(id, 80));
    if (!s || s.endedAt) return 'none';
    if (s.queued) return 'queued';
    return (s.state === 'running' || s.state === 'waiting') ? 'followup' : 'resume';
  }

  return {
    applyStatus, applyHook, requestPermission, askQuestion, answer, skipQuestion,
    decide, cancel, snapshot, stop, cwdFor, mergeRegistry,
    queueFollowUp, cancelFollowUp, takeFollowUp, replyModeFor,
    get pendingCount() { return pending.size; },
  };
}

module.exports = {
  createBridge,
  describeTool,
  describeTodos,
  answerReason,
  followUpReason,
  isDestructive,
  isInjectedPrompt,
  APPROVAL_TTL_MS,
  URGENT_AFTER_MS,
  QUESTION_TTL_MS,
  FOLLOWUP_TTL_MS,
  SESSION_STALE_MS,
  SESSION_RESTING_MS,
};
