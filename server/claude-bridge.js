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
//   2. AskUserQuestion and ExitPlanMode are the two tools whose card IS the
//      interaction (Claude Code: requiresUserInteraction()), and for them an
//      'allow' ALONE IS IGNORED — read in the 2.1.283 binary, where the
//      interactive PermissionRequest path returns "no decision" when a hook
//      allows one of them without updatedInput, and documented for PreToolUse
//      ("Returning 'allow' alone is not sufficient for these tools"). That was
//      the "I tap Allow on the plan and the terminal keeps waiting" bug. So:
//        • a question is answered with PreToolUse allow + updatedInput carrying
//          the tool's own input plus `answers` { question text → label }, which
//          the tool then returns as its result, exactly as if it were typed
//          in the terminal (see askQuestion / buildAnswers);
//        • a plan is approved with PermissionRequest allow + updatedInput (the
//          input Claude Code sent, echoed) + updatedPermissions setMode, which
//          is the same update the terminal's own "Yes, …" rows apply.
//      An earlier version answered questions with a DENY whose reason carried
//      the choice. Claude did act on it, but the terminal drew the question as
//      a refused tool call, which is not what happened.
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
// A message handed to the mod for an idle session (takeForTerminal) is on its
// way until Claude Code starts the turn. Past this with no sign of it, the tile
// stops saying so. It is not offered back either: it may well have arrived, and
// offering it back invites sending it twice.
const HANDED_TTL_MS = 60 * 1000;
// How long a message that did not get into the session is offered back.
const UNDELIVERED_TTL_MS = 2 * 60 * 1000;

const MAX_SESSIONS = 20;      // bounds the live list (and therefore the payload)
const MAX_PENDING = 8;        // bounds concurrent approvals
const MAX_STR = 220;          // per-field clamp for anything rendered
const MAX_INPUT_CHARS = 800;  // tool-input preview clamp
const MAX_TODOS = 12;         // the plan lane; a longer list is scrolled, not stored
const MAX_ACTIVITY = 30;      // per-session ring of finished tool calls
const MAX_SUBAGENTS = 8;
// A finished subagent stays on the tile this long, so its result can be read.
const AGENT_DONE_MS = 2 * 60 * 1000;
const MAX_AGENT_LAST = 200;
const MAX_AGENT_TOKENS = 10_000_000;
// The tile's box takes 4000 characters; the paths of up to six attached files
// ride along after them.
const MAX_FOLLOWUP_CHARS = 6000;

// Tool calls whose blast radius is wide enough that the tile alone is not
// enough of a prompt — these escalate to the fullscreen overlay immediately
// rather than after URGENT_AFTER_MS. Deliberately conservative: this only
// changes how loudly we ASK, never whether we ask.
const MAX_QUESTIONS = 4;    // matches AskUserQuestion's own cap
const MAX_OPTIONS = 5;      // 4 authored, plus one spare
const MAX_TYPED = 2000;     // an "Other" answer typed on the tile
const MAX_PLAN_CHARS = 20000;
// The kinds AskUserQuestion can ask. "text" and "number" have no options and
// are answered by typing; only some hosts enable them, but a card that drew one
// with nothing to tap would be the dead control this module exists to avoid.
const QUESTION_KINDS = new Set(['choice', 'text', 'number']);
// The permission modes a plan can be approved into from the tile, in the words
// of Claude Code's own plan dialog. bypassPermissions is deliberately not one of
// them: the terminal offers it only to a session launched with it, and switching
// every safeguard off is not a choice to make from across the room.
const PLAN_MODES = new Set(['auto', 'acceptEdits', 'default']);
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

// What a file edit changed, for the tile to draw as the terminal does: removed
// lines, then added lines, trimmed to the part that really differs. Bounded in
// lines and width, because it rides in the live payload every client receives.
// Files that usually hold secrets get no body at all (counts only), since the
// payload also reaches paired devices.
const MAX_DIFF_LINES = 16;
const MAX_DIFF_WIDTH = 140;
const MAX_DIFFS_WITH_LINES = 4;
const SECRET_FILE = /(^|[\\/])(\.env(\..*)?|.*\.(pem|key|pfx|p12|keystore)|id_(rsa|ed25519|ecdsa)|.*(secret|credential|token|password)s?[^\\/]*)$/i;

function diffLines(oldText, newText) {
  const a = oldText ? oldText.replace(/\r\n/g, '\n').split('\n') : [];
  const b = newText ? newText.replace(/\r\n/g, '\n').split('\n') : [];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { del: a.slice(head, a.length - tail), add: b.slice(head, b.length - tail) };
}

function describeChange(toolName, input) {
  const i = (input && typeof input === 'object') ? input : {};
  const file = str(i.file_path, 400);
  if (!file) return null;
  let del = [];
  let add = [];
  if (toolName === 'Edit' && typeof i.old_string === 'string' && typeof i.new_string === 'string') {
    ({ del, add } = diffLines(i.old_string, i.new_string));
  } else if (toolName === 'MultiEdit' && Array.isArray(i.edits)) {
    for (const e of i.edits.slice(0, 20)) {
      if (!e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string') continue;
      const d = diffLines(e.old_string, e.new_string);
      del = del.concat(d.del);
      add = add.concat(d.add);
    }
  } else if (toolName === 'Write' && typeof i.content === 'string') {
    add = i.content.replace(/\r\n/g, '\n').split('\n');
  } else {
    return null;
  }
  if (!del.length && !add.length) return null;
  const out = { file: file.split(/[\\/]/).filter(Boolean).pop(), del: del.length, add: add.length, lines: [] };
  if (SECRET_FILE.test(file)) return out;
  const clip = (l) => (l.length > MAX_DIFF_WIDTH ? l.slice(0, MAX_DIFF_WIDTH) + '…' : l);
  const room = MAX_DIFF_LINES;
  const showDel = del.slice(0, Math.ceil(room / 2));
  const showAdd = add.slice(0, room - showDel.length);
  showDel.forEach((l) => out.lines.push({ k: '-', t: clip(l) }));
  showAdd.forEach((l) => out.lines.push({ k: '+', t: clip(l) }));
  return out;
}

// AskUserQuestion carries the question and its options in the tool input. The
// generic describeTool() saw only an array and produced nothing, so the card
// said "AskUserQuestion" and offered Allow/Deny over a question the user could
// not read. Project the questions so the card can show what is being asked.
//
// These are answerable from the tile: see askQuestion, and note 2 in the header
// for how. `keys` is the question text EXACTLY as Claude wrote it, unclamped:
// it is the key of the `answers` map the tool reads, so the shortened copy the
// card shows cannot stand in for it. It stays on the server.
function projectQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : null;
  if (!qs || !qs.length) return null;
  const shown = [];
  const keys = [];
  for (const q of qs.slice(0, MAX_QUESTIONS)) {
    if (!q || typeof q !== 'object' || typeof q.question !== 'string' || !q.question.trim()) continue;
    const opts = Array.isArray(q.options) ? q.options : [];
    const kind = QUESTION_KINDS.has(q.kind) ? q.kind : 'choice';
    const p = {
      question: str(q.question, MAX_INPUT_CHARS),
      header: str(q.header, 40),
      kind,
      multiSelect: kind === 'choice' && q.multiSelect === true,
      options: kind !== 'choice' ? [] : opts.slice(0, MAX_OPTIONS).map((o) => ({
        label: str(o && o.label, 120),
        description: str(o && o.description, 240),
      })).filter((o) => o.label),
    };
    if (kind === 'text') p.placeholder = str(q.placeholder, 120);
    if (kind === 'number') {
      p.min = num(q.min); p.max = num(q.max); p.step = num(q.step); p.unit = str(q.unit, 20);
    }
    shown.push(p);
    keys.push(q.question);
  }
  return shown.length ? { shown, keys } : null;
}
function describeQuestions(input) {
  const p = projectQuestions(input);
  return p ? p.shown : null;
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

// What a pending request would reach, in the few words the card can show next
// to the command. With auto mode on (the default since August 2026) routine
// calls never reach a person, so the ones that do are the unusual ones, and the
// raw command alone does not say what makes them unusual. Every code here is
// derived from the tool and its argument only, and errs toward saying MORE:
//   irreversible  deletes, force-pushes, resets, drops (the same test that
//                 escalates the card to full screen)
//   publish       sends work somewhere others see it (git push, npm publish…)
//   network       reaches another machine
//   outside       a file path that is not inside the session's folder
//   readonly      reads only (Read, Glob, Grep): said, so calm is visible too
const PUBLISH_RE = /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|gh\s+(release|pr\s+(create|merge))|docker\s+push|cargo\s+publish|twine\s+upload)\b/i;
const NETWORK_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|rsync|ftp|sftp|nc|telnet)\b|https?:\/\//i;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
function isInside(file, cwd) {
  if (!file || !cwd) return true;                     // nothing to compare: say nothing
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  const win = process.platform === 'win32';
  const f = win ? norm(file).toLowerCase() : norm(file);
  const c = win ? norm(cwd).toLowerCase() : norm(cwd);
  return f === c || f.startsWith(c + path.sep);
}
function describeRisk(toolName, detail, cwd) {
  const tool = str(toolName, 60);
  const d = String(detail || '');
  const out = [];
  if (isDestructive(tool, d)) out.push('irreversible');
  if (tool === 'Bash' && PUBLISH_RE.test(d)) out.push('publish');
  if (tool === 'WebFetch' || tool === 'WebSearch' || (tool === 'Bash' && NETWORK_RE.test(d) && out.indexOf('publish') === -1)) out.push('network');
  if (FILE_TOOLS.has(tool) && path.isAbsolute(d) && !isInside(d, cwd)) out.push('outside');
  if (!out.length && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) out.push('readonly');
  return out;
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

// One answer for a multi-select question, in the form AskUserQuestion itself
// uses: labels joined with ", ", and a label that contains ", " or a quote
// JSON-quoted so the join stays reversible (Claude Code's own joiner does the
// same, which is what lets it split the string back into picks).
function joinAnswer(labels) {
  return labels.map((l) => (l.includes(', ') || l.includes('"') ? JSON.stringify(l) : l)).join(', ');
}

// A typed answer: trimmed, bounded, and with control characters removed so
// a stray paste cannot put a terminal escape into someone's session.
function typedAnswer(v) {
  if (typeof v !== 'string') return '';
  return str(v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ''), MAX_TYPED);
}

// The `answers` map AskUserQuestion reads: { question text → answer }. Picks are
// matched against the options Claude published, and a typed answer is the
// tile's "Other" box — the same free text the terminal's "Other" row accepts.
// Returns null when nothing was answered, so the card stays up.
function buildAnswers(questions, keys, selections, typed) {
  const answers = {};
  let any = false;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const text = typedAnswer(Array.isArray(typed) ? typed[i] : '');
    let value = '';
    if (q.kind === 'number') {
      const n = Number(text);
      const inRange = text !== '' && Number.isFinite(n)
        && (q.min === null || q.min === undefined || n >= q.min)
        && (q.max === null || q.max === undefined || n <= q.max);
      value = inRange ? String(n) : '';
    } else if (q.kind === 'text') {
      value = text;
    } else {
      const allowed = new Set(q.options.map((o) => o.label));
      const raw = Array.isArray(selections) && Array.isArray(selections[i]) ? selections[i] : [];
      const picks = [];
      for (const label of raw) {
        const l = str(label, 120);
        if (l && allowed.has(l) && picks.indexOf(l) === -1) picks.push(l);
        if (picks.length >= MAX_OPTIONS) break;
      }
      if (q.multiSelect) value = joinAnswer(text ? picks.concat(text) : picks);
      else value = text || picks[0] || '';
    }
    if (value) { answers[keys[i]] = value; any = true; }
  }
  return any ? answers : null;
}

// What Claude reads when the user sends a plan back from the tile. Claude Code's
// own "No, keep planning" row carries the typed feedback the same way: as the
// reason the tool call was declined, with Claude still in plan mode.
function planFeedbackMessage(feedback) {
  const f = typedAnswer(feedback);
  if (f) {
    return 'The user reviewed the plan on the Xenon dashboard and wants changes before you start. '
      + 'Stay in plan mode, revise the plan with this feedback, and present it again:\n\n' + f;
  }
  return 'The user reviewed the plan on the Xenon dashboard and did not approve it. '
    + 'Stay in plan mode and ask what they would like to change.';
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

// How long after a mod approval is handed back the hook's own request for the
// same call is still recognised as that call (takeHandBack).
const HANDBACK_MS = 10 * 1000;
function handBackKey(sessionId, tool) { return sessionId + '|' + tool; }

// A mod `measure` message in the statusline's shape, so applyStatus stays the
// one place quota and context are read. The mod reports reset times as ISO
// 8601; the statusline (and the widget) use epoch seconds.
const MOD_LIMIT_KINDS = { five_hour: 'five_hour', seven_day: 'seven_day' };
function modMeasureAsStatus(sessionId, d) {
  const rate = {};
  for (const w of Array.isArray(d.rateLimits) ? d.rateLimits.slice(0, 4) : []) {
    const key = w && MOD_LIMIT_KINDS[w.kind];
    if (!key) continue;
    const resetMs = Date.parse(str(w.resetsAt, 40));
    rate[key] = {
      used_percentage: w.percentUsed,
      // undefined, not null: num(null) reads as 0, a reset at the epoch.
      resets_at: Number.isFinite(resetMs) ? Math.round(resetMs / 1000) : undefined,
    };
  }
  return {
    session_id: sessionId,
    context_window: { used_percentage: d.contextPct },
    cost: { total_cost_usd: d.costUsd },
    ...(Object.keys(rate).length ? { rate_limits: rate } : {}),
  };
}

function createBridge(opts) {
  const options = opts || {};
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  // Claude Code's configured permissions.defaultMode, when the caller can read
  // it. Only used to decide whether a plan card offers auto mode for a session
  // that entered plan mode before we heard anything else from it.
  const defaultMode = () => {
    try { return typeof options.defaultMode === 'function' ? str(options.defaultMode(), 30) : ''; } catch { return ''; }
  };
  // Is the Xenon mod listening in this session right now (claude-inbox.js)?
  // Then a message for it while it is idle goes into that session instead of a
  // background run.
  const terminal = (id) => {
    try { return typeof options.terminal === 'function' && options.terminal(id) === true; } catch { return false; }
  };

  const sessions = new Map();   // session_id → live session record
  const pending = new Map();    // approval id → { …, resolve, timer }
  let limits = null;            // latest rate-limit reading (account-wide)
  // The mod version each session last reported. Header commands need 0.4.0: an
  // older mod would submit "/effort high" as a message to Claude.
  const modVersions = new Map();
  // The slash commands each session's mod listed (0.5.0+): [{ name, desc }].
  const modCommandLists = new Map();
  // When each session's mod last spoke, so the two maps above are dropped with
  // the session; and the sessions already asked for their list since this boot.
  const modLastAt = new Map();
  const commandsAsked = new Set();
  const modCommands = (id) => {
    const m = /^(\d+)\.(\d+)/.exec(modVersions.get(id) || '');
    return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 4);
  };
  let modSeen = null;           // { at, version } of the mod's last message
  const handBacks = new Map();  // `session|tool` → when a mod approval was handed back
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
        // plan: the last plan Claude wrote for approval (ExitPlanMode), kept after
        // it was approved so the tile can still show what the session is following.
        todos: [], plan: '', planAt: 0, subagents: [], agentDescs: [], activity: [],
        compacting: false, permissionMode: '', effort: '',
        // The last mode seen that was not plan, and whether auto mode has been
        // seen at all: what a plan card needs to offer the same first choice
        // the terminal's plan dialog does.
        prePlanMode: '', sawAuto: false,
        // Is there a turn running? Starts true-for-over, because a session we
        // have only just heard of is not mid-answer. See the Notification case
        // in applyHook for the one thing this exists to decide.
        turnOver: true,
        lastSaid: '', linesAdded: null, linesRemoved: null,
        // turnAt: when the current turn began, for "working for…" on the tile.
        startedAt: now(), turnAt: 0, lastAt: now(), cost: null, contextPct: null,
        endedAt: 0, endedReason: '',
        // Corroboration from Claude Code's own registry (claude-sessions.js).
        pid: null, alive: true,
        queued: null,
        // A message handed to the mod for this idle session, until the turn
        // starts ({ text, at, started }), and one that did not get in, offered
        // back on the tile ({ text, reason, at }). See takeForTerminal.
        handed: null, undelivered: null,
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
  function hasPendingFor(sessionId) {
    for (const rec of pending.values()) if (rec.sessionId === sessionId) return true;
    return false;
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
    // The payload is rebroadcast on every event: only the newest few edits keep
    // their lines, older ones keep the +/- counts.
    let withLines = 0;
    for (let k = s.activity.length - 1; k >= 0; k--) {
      const c = s.activity[k].change;
      if (c && c.lines.length && ++withLines > MAX_DIFFS_WITH_LINES) c.lines = [];
    }
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
      // Each window is kept on its own: a post that carries only one of them
      // used to null the other out.
      if (fivePct !== null || sevenPct !== null) {
        const prev = limits || {};
        limits = {
          fiveHour: fivePct === null ? (prev.fiveHour || null) : { pct: fivePct, resetsAt: num(five.resets_at) },
          sevenDay: sevenPct === null ? (prev.sevenDay || null) : { pct: sevenPct, resetsAt: num(seven.resets_at) },
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

  // ── mod feed ───────────────────────────────────────────────────────────────
  // The Xenon mod for Claude Code (integrations/claude-code/). It adds what the
  // hooks cannot say — each subagent's model, the live context and quota
  // without waiting for a statusline run — and never prompt text, tool
  // arguments or file content. It enriches the records the hooks keep; it never
  // creates a session state of its own. Its one other message is the outcome of
  // a tile message it took from the inbox, as a code: the text never comes back.
  // A subagent's entry, found or started: the hook and the mod each may come
  // first. Over the cap a finished agent goes before a running one.
  function agentEntry(s, agentId, type) {
    let a = s.subagents.find((x) => x.id === agentId);
    if (a) { if (type && !a.type) a.type = type; return a; }
    a = { id: agentId, type: type || '', desc: '', status: 'running', model: '', effort: '', tools: 0, tool: '', detail: '', tokens: 0, at: now(), endedAt: 0, last: '' };
    const i = s.agentDescs.findIndex((x) => !x.type || !type || x.type === type);
    if (i >= 0) a.desc = s.agentDescs.splice(i, 1)[0].desc;
    s.subagents.push(a);
    while (s.subagents.length > MAX_SUBAGENTS) {
      const done = s.subagents.findIndex((x) => x.status !== 'running');
      s.subagents.splice(done >= 0 ? done : 0, 1);
    }
    return a;
  }
  function endAgent(a, lastMessage) {
    if (a.status === 'running') { a.status = 'done'; a.endedAt = now(); a.tool = ''; a.detail = ''; }
    const line = str(String(lastMessage || '').split('\n').find((l) => l.trim()) || '', MAX_AGENT_LAST);
    if (line) a.last = line;
  }

  function applyMod(data) {
    const d = (data && typeof data === 'object') ? data : {};
    if (d.v !== 1) return false;
    const id = str(d.sessionId, 80);
    if (!id) return false;
    modSeen = { at: now(), version: str(d.version, 20) || (modSeen ? modSeen.version : '') };
    if (str(d.version, 20)) modVersions.set(id, str(d.version, 20));
    modLastAt.set(id, now());

    switch (d.kind) {
      case 'hello': {
        const model = str(d.model, 60);
        // The effort is what the session's last model request used, so it is
        // newer than any hook payload this server has kept (a restart loses those).
        const effort = EFFORT_LEVELS.has(str(d.effort, 20)) ? str(d.effort, 20) : '';
        touchSession(id, Object.assign(model ? { model } : {}, effort ? { effort } : {}));
        emit();
        return true;
      }
      case 'measure':
        // Same figures the statusline posts, in the mod's units; one reader.
        return applyStatus(modMeasureAsStatus(id, d));
      case 'commands': {
        const list = [];
        const seen = new Set();
        for (const c of Array.isArray(d.commands) ? d.commands : []) {
          const name = str(c && c.name, 80);
          if (!MOD_COMMAND_NAME.test(name) || seen.has(name) || NEVER_FROM_TILE.has(name)) continue;
          seen.add(name);
          list.push({ name, desc: str(c.description, 140) });
          if (list.length >= MAX_MOD_COMMANDS) break;
        }
        modCommandLists.set(id, { list, at: now() });
        emit();
        return true;
      }
      case 'agent': {
        const agentId = str(d.agentId, 60);
        const model = str(d.model, 60);
        if (!agentId || !model) return false;
        const s = touchSession(id, {});
        // The spawn can land before or after the SubagentStart hook: fill the
        // entry that exists, or start it so the hook finds it by id.
        const a = agentEntry(s, agentId, str(d.type, 40));
        a.model = model;
        const desc = str(d.description, 80);
        if (desc) a.desc = desc;
        emit();
        return true;
      }
      case 'agentStat': {
        // Numbers and levels only, as the mod promises.
        const agentId = str(d.agentId, 60);
        const s = agentId ? sessions.get(id) : null;
        if (!s) return false;
        // A report from an agent started before a restart opens its entry; a
        // late 'done' for one already gone does not bring it back.
        let a = s.subagents.find((x) => x.id === agentId);
        if (!a && d.done === true) return false;
        if (!a) a = agentEntry(s, agentId, '');
        const effort = str(d.effort, 10);
        if (EFFORT_LEVELS.has(effort)) a.effort = effort;
        const tokens = num(d.tokens);
        if (tokens != null && tokens > 0) a.tokens = Math.min(Math.round(tokens), MAX_AGENT_TOKENS);
        if (d.done === true) endAgent(a, '');
        emit();
        return true;
      }
      case 'delivery': {
        // A success only ends the "on its way" state a little sooner than
        // UserPromptSubmit would; a refusal offers the text back on the tile.
        // 'dropped' is a prompt hook's block, whose reason Claude Code shows in
        // the session; anything else is 'refused'.
        const s = sessions.get(id);
        if (!s || !s.handed) return false;
        const { text, started } = s.handed;
        s.handed = null;
        if (d.ok !== true) {
          s.undelivered = { text, reason: d.reason === 'dropped' ? 'dropped' : 'refused', at: now() };
          // Our own UserPromptSubmit hook fired alongside the one that blocked
          // it and marked a turn that never began. Nothing will send Stop.
          if (started && s.state === 'running') { s.state = 'idle'; s.turnOver = true; }
        }
        emit();
        return true;
      }
      default:
        return false;
    }
  }

  function modStatus() {
    return modSeen ? { version: modSeen.version, ageMs: now() - modSeen.at } : null;
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
    // A hook from it means it is wired in after all: the hook feed owns its
    // state from here on, not the registry file.
    const wired = sessions.get(id);
    if (wired && wired.unlinked) wired.unlinked = false;

    // Present on every event since 2.1.x and worth showing: a session running in
    // acceptEdits or bypassPermissions will never send a permission card, and a
    // user waiting for one deserves to know that rather than wonder.
    const ambient = {};
    const pm = str(d.permission_mode, 30);
    if (pm) {
      ambient.permissionMode = pm;
      if (pm !== 'plan') ambient.prePlanMode = pm;
      if (pm === 'auto') ambient.sawAuto = true;
    }
    const eff = d.effort && typeof d.effort === 'object' ? str(d.effort.level, 20) : '';
    if (eff) ambient.effort = eff;
    if (Object.keys(ambient).length) touchSession(id, ambient);

    switch (ev) {
      case 'SessionStart':
        touchSession(id, {
          project: projectName(d.cwd), state: 'idle', tool: '', toolDetail: '',
          startedAt: now(), endedAt: 0, endedReason: '', waitFor: null, turnOver: true,
          // A cleared or fresh session starts with no plan; a resumed one keeps its own.
          ...(d.source === 'resume' || d.source === 'compact' ? {} : { plan: '', planAt: 0 }),
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
        const patch = { state: 'running', tool: '', toolDetail: '', waitFor: null, turnOver: false, turnAt: now() };
        const prompt = str(d.prompt, MAX_STR);
        if (prompt && !isInjectedPrompt(prompt)) patch.task = prompt;
        const s = touchSession(id, patch);
        // A tile message handed to the mod has reached Claude Code. Kept until
        // the mod reports, not cleared: another prompt hook may still block it,
        // and offering it back then needs the text.
        if (s && s.handed) s.handed.started = true;
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
          turnOver: false,
          // A tool starting proves no compaction is running, whether or not the
          // PostCompact hook ever arrived.
          compacting: false,
        });
        // A tool starting means Claude is moving again, so whatever notification
        // it raised is over. A permission or a question is NOT over — those are
        // settled by their own path, and clearing them here would un-block a
        // session that is still blocked.
        clearWait(s, 'notification');
        if (tool === 'ExitPlanMode') {
          const plan = str(d.tool_input && d.tool_input.plan, MAX_PLAN_CHARS);
          if (plan) { s.plan = plan; s.planAt = now(); }
        }
        // The label of a subagent about to start: SubagentStart carries only
        // its type, so the description waits here for it.
        if ((tool === 'Agent' || tool === 'Task') && !d.agent_id) {
          const input = d.tool_input || {};
          const desc = str(input.description, 80);
          if (desc) s.agentDescs = s.agentDescs.concat([{ type: str(input.subagent_type, 40), desc }]).slice(-MAX_SUBAGENTS);
        }
        // A tool call inside an agent this server never saw start (it began
        // before a Xenon restart, or SubagentStart was missed) still opens its entry.
        const inAgent = d.agent_id ? agentEntry(s, str(d.agent_id, 60), str(d.agent_type, 40)) : null;
        if (inAgent) { inAgent.tool = tool; inAgent.detail = describeTool(tool, d.tool_input); }
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
          // Only for an edit that went through: a failed one changed nothing.
          change: ev === 'PostToolUse' ? describeChange(tool, d.tool_input) : null,
          ok: ev !== 'PostToolUseFailure',
          // Claude Code sends the real figure; no pairing with PreToolUse needed.
          ms: num(d.duration_ms),
          at: now(),
          agent: str(d.agent_type || d.agent_id, 40),
        });
        const byAgent = d.agent_id ? agentEntry(s, str(d.agent_id, 60), str(d.agent_type, 40)) : null;
        if (byAgent) {
          byAgent.tools += 1;
          byAgent.tool = tool;
          byAgent.detail = describeTool(tool, d.tool_input);
        }
        // NOT a state write. A tool finishing says nothing about whether the
        // session is waiting on the user — this line used to force 'running' and
        // was the reason a blocked session kept claiming to be working.
        if (s.state !== 'waiting') s.state = 'running';
        break;
      }
      case 'Notification': {
        // Claude Code sends Notification for two things that could not be more
        // different, and the message text is the only thing separating them —
        // in whatever language and wording that version happens to use:
        //
        //   "Claude needs your permission to use Bash"   → genuinely blocked
        //   "Claude is waiting for your input"           → the turn is over,
        //                                                  type when you like
        //
        // Reading the text is a guess. WHEN it arrives is a fact: the second
        // one only ever follows a Stop, with no prompt and no tool since. So
        // that is what decides it. Measured on a real session that had been
        // finished for 47 minutes: it was drawn as "waiting for you", it put
        // the top bar into its blocked state, and it did so while two other
        // sessions were actually working. An idle session is idle.
        const s = touchSession(id, {});
        if (s && s.turnOver) break;
        setWait(s, 'notification', d.message);
        break;
      }
      case 'SubagentStart': {
        const s = touchSession(id, {});
        const agentId = str(d.agent_id, 60);
        if (agentId) agentEntry(s, agentId, str(d.agent_type, 40));
        break;
      }
      case 'SubagentStop': {
        const s = touchSession(id, {});
        const agentId = str(d.agent_id, 60);
        const a = agentId ? s.subagents.find((x) => x.id === agentId) : null;
        // Kept a little while as finished, with the first line of its report.
        if (a) endAgent(a, d.last_assistant_message);
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
          state: 'idle', tool: '', toolDetail: '', compacting: false, turnOver: true,
          // What Claude actually said, straight off the hook — the transcript
          // reader exists for history, and this is the live line.
          lastSaid: str(d.last_assistant_message, MAX_STR),
        });
        // A turn that ended is waiting for nothing, unless a card for it is
        // still open. A permission denied in the terminal left its wait behind,
        // and the session never counted as finished.
        if (s && s.waitFor && !hasPendingFor(id)) s.waitFor = null;
        break;
      }
      case 'StopFailure':
        // The turn ended on an API error rather than an answer. Distinct from
        // idle: nothing is coming, and the user is the one who has to notice.
        setWait(touchSession(id, { tool: '', toolDetail: '', turnOver: true }), 'error', d.error || d.reason);
        break;
      case 'SessionEnd': {
        // Not a delete. A session that has just ended is exactly the one the
        // user looks at next ("did it finish, or did I kill it?"), and dropping
        // the record answered neither. It is filed as ended and pruned normally.
        const s = touchSession(id, {
          state: 'idle', tool: '', toolDetail: '', waitFor: null, subagents: [], turnOver: true,
          endedAt: now(), endedReason: str(d.reason, 40) || 'other',
        });
        // Nothing will ever deliver it now.
        if (s) { giveBack(s, true); s.queued = null; s.handed = null; }
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
  // Two ways in, and the tile says which one is about to happen rather than
  // offering one box that behaves as either:
  //   • 'turn': a turn is running, and the Stop hook delivers the text inside
  //     it (header note 3).
  //   • 'terminal': the session is idle, so no Stop is coming, but the Xenon mod
  //     is listening in it (claude-inbox.js). The mod takes the text and starts
  //     a new turn with it, as if it were typed there (takeForTerminal).
  // An idle session with no mod listening is neither: the caller resumes it as
  // a background run instead.
  function inFlight(s, t) {
    return !!(s.handed && !s.handed.started && t - s.handed.at < HANDED_TTL_MS);
  }

  // The few commands the tile's header may run in an open session. The mod
  // (0.4.0) recognises the same shape and runs them with $.command.run; any
  // other "/" text is still just a message. Kept narrow on purpose: a model
  // name, an effort level, or a compact with optional focus text.
  const TILE_COMMAND = /^\/(?:(?:model|effort)[ ]+[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,39}|compact(?:[ ]+[^\r\n]{1,200})?)$/;
  // Any other command runs only when this session's own mod listed it (0.5.0+
  // sends the terminal's typeahead list), and never one that ends the session.
  const OTHER_COMMAND = /^\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,79})(?:[ ][^\r\n]{1,200})?$/;
  const MOD_COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
  const NEVER_FROM_TILE = new Set(['exit', 'quit', 'logout', 'login']);
  const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
  const MAX_MOD_COMMANDS = 300;
  const isTileCommand = (id, text) => {
    if (TILE_COMMAND.test(text)) return true;
    const m = OTHER_COMMAND.exec(text);
    const have = modCommandLists.get(id);
    return !!(m && have && !NEVER_FROM_TILE.has(m[1]) && have.list.some((c) => c.name === m[1]));
  };
  // Ask a session's mod for its command list once per boot: a mod whose host has
  // no list (or an empty one) would otherwise be asked on every hello.
  function wantsCommandList(sessionId) {
    const id = str(sessionId, 80);
    if (!id || modCommandLists.has(id) || commandsAsked.has(id)) return false;
    commandsAsked.add(id);
    return true;
  }
  function commandListFor(sessionId) {
    const have = modCommandLists.get(str(sessionId, 80));
    return have ? have.list.slice() : null;
  }

  function queueFollowUp(sessionId, text) {
    const s = sessions.get(str(sessionId, 80));
    if (!s) return { ok: false, error: 'unknown_session' };
    if (s.endedAt) return { ok: false, error: 'session_ended' };
    const t = str(text, MAX_FOLLOWUP_CHARS);
    if (!t) return { ok: false, error: 'empty' };
    if (s.queued || inFlight(s, now())) return { ok: false, error: 'already_queued' };
    // Without a value these open a picker in the terminal that nobody here sees.
    if (/^\/(?:model|effort)\s*$/.test(t)) return { ok: false, error: 'needs_value' };
    const busy = s.state === 'running' || s.state === 'waiting';
    const command = isTileCommand(s.id, t);
    if (command && !modCommands(s.id)) return { ok: false, error: 'mod_old' };
    // A command runs between turns, so it must never be delivered as a reply
    // inside the turn. While one is running it waits for the turn to end and
    // the mod takes it then; with no mod listening nothing could ever run it.
    if (command && busy && !terminal(s.id)) return { ok: false, error: 'busy_command' };
    // The turn ended while the text was being typed: queued, it would wait for
    // a Stop that already happened.
    if (!busy && !terminal(s.id)) return { ok: false, error: 'session_idle' };
    // Any other "/" text would reach the session as a message, not run as a
    // command; those are typed in the session itself.
    if (!busy && !command && t.startsWith('/')) return { ok: false, error: 'slash_command' };
    const via = busy && !command ? 'turn' : 'terminal';
    s.queued = { text: t, at: now(), via, command };
    s.undelivered = null;
    emit();
    return { ok: true, via };
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
    // A command waits for the end of the turn, for the mod to run it.
    if (s.queued.command) return '';
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

  // The mod's side (claude-inbox.js). Hands the text over ONCE and raw: the mod
  // submits it as the user's own words, so it needs none of followUpReason's
  // framing. Only to an idle session; one that is working gets it from the
  // Stop hook, inside its turn. Kept as `handed` until the turn starts, so the
  // tile can say it is on its way and offer it back if Claude Code refuses it.
  function takeForTerminal(sessionId) {
    const s = sessions.get(str(sessionId, 80));
    if (!s || s.endedAt || !s.queued) return '';
    // A command may go while a dialog waits: Claude Code runs it once the session is idle.
    if (s.state === 'running' || (s.state === 'waiting' && !s.queued.command)) return '';
    const { text, at, command } = s.queued;
    s.queued = null;
    if (now() - at > FOLLOWUP_TTL_MS) { emit(); return ''; }
    // A command starts no turn, so nothing would ever mark it as arrived: it is
    // not "on its way" and not offered back.
    if (command) { emit(); return text; }
    s.handed = { text, at: now(), started: false };
    emit();
    return text;
  }

  // A message still waiting for this session, or handed over with no sign that
  // it reached Claude Code, did not get in, so it is offered back on the tile
  // instead of disappearing without a word. `turnToo` is for a session that
  // ended: no Stop is coming to deliver a message queued for the turn either.
  function giveBack(s, turnToo) {
    let text = '';
    if (s.queued && (turnToo || s.queued.via === 'terminal')) { text = s.queued.text; s.queued = null; }
    else if (inFlight(s, now())) { text = s.handed.text; s.handed = null; }
    if (!text) return false;
    s.undelivered = { text, reason: 'closed', at: now() };
    return true;
  }

  // The mod in that session stopped listening (claude-inbox.js): the terminal
  // was closed, or Claude Code exited. The session itself may still be running
  // without it, so a message for its turn stays for the Stop hook.
  function terminalGone(sessionId) {
    const s = sessions.get(str(sessionId, 80));
    if (!s || !giveBack(s, false)) return false;
    emit();
    return true;
  }

  // The "Yes" rows of Claude Code's plan dialog, in its order: auto mode when it
  // is available (else auto-accept edits), then manual approval. The terminal
  // knows for certain whether auto is available and a hook is not told, so the
  // evidence is what this session has shown us, then the user's default mode.
  function planChoices(s) {
    const autoOk = !!(s && (s.sawAuto || s.prePlanMode === 'auto')) || defaultMode() === 'auto';
    return [autoOk ? 'auto' : 'acceptEdits', 'default'];
  }

  // ── blocking permission requests ───────────────────────────────────────────
  // Returns { id, promise }. The promise resolves to 'allow' | 'deny' | 'timeout'.
  // 'timeout' means WE decline to answer, so the caller must respond in a way
  // that hands the choice back to Claude Code's own terminal prompt — never an
  // implicit allow.
  // `opts.ttlMs` shortens the wait (the mod's approvals hand back to the
  // terminal after it); `opts.fromMod` marks a request whose expiry must not
  // become a second card when Claude Code's own PermissionRequest hook, which
  // runs right after the mod gives up, asks about the same call (takeHandBack).
  function requestPermission(data, opts) {
    const o = opts || {};
    const ttlMs = Math.max(5000, Math.min(APPROVAL_TTL_MS, num(o.ttlMs) || APPROVAL_TTL_MS));
    const d = (data && typeof data === 'object') ? data : {};
    const sessionId = str(d.session_id, 80);
    const tool = str(d.tool_name, 60) || 'tool';
    const detail = describeTool(tool, d.tool_input);
    const questions = tool === 'AskUserQuestion' ? describeQuestions(d.tool_input) : null;

    // Too many already waiting → refuse to queue another. The caller hands this
    // back to the terminal rather than letting the tile become a backlog.
    if (pending.size >= MAX_PENDING) return null;

    const s = sessions.get(sessionId);
    const isPlan = tool === 'ExitPlanMode';
    if (s) { setWait(s, 'permission', isPlan ? 'plan' : (detail || tool)); s.lastAt = now(); }

    const id = 'p' + (++seq) + '-' + now().toString(36);
    const createdAt = now();
    const rec = {
      id,
      sessionId,
      // 'plan' is a permission with the terminal's plan-dialog choices instead
      // of Allow/Deny: approving one is only possible with the input echoed and
      // a mode chosen (header note 2), so it is its own kind, not a flag.
      kind: isPlan ? 'plan' : 'permission',
      project: (s && s.project) || projectName(d.cwd),
      tool,
      detail,
      questions,
      // ExitPlanMode's whole payload is the plan the user is being asked to
      // approve. Showing "ExitPlanMode" and an Allow button over it asked the
      // user to approve something they could not read.
      plan: isPlan ? str(d.tool_input && d.tool_input.plan, MAX_PLAN_CHARS) : '',
      choices: isPlan ? planChoices(s) : null,
      // Server-side only: the input exactly as Claude Code sent it, to echo back.
      input: isPlan && d.tool_input && typeof d.tool_input === 'object' && !Array.isArray(d.tool_input) ? d.tool_input : {},
      risks: describeRisk(tool, detail, (s && s.cwd) || str(d.cwd, 400)),
      task: (s && s.task) || '',
      model: (s && s.model) || '',
      createdAt,
      expiresAt: createdAt + ttlMs,
      urgentAt: isDestructive(tool, detail) ? createdAt : createdAt + Math.min(URGENT_AFTER_MS, ttlMs / 2),
      handBackKey: o.fromMod ? handBackKey(sessionId, tool) : '',
      resolve: null,
      timer: null,
    };

    const promise = new Promise((resolve) => { rec.resolve = resolve; });
    rec.timer = setTimeout(() => {
      if (pending.get(id) !== rec) return;
      pending.delete(id);
      clearWait(s, 'permission');
      if (rec.handBackKey) handBacks.set(rec.handBackKey, now());
      rec.resolve({ verdict: 'timeout' });
      emit();
    }, ttlMs);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();

    pending.set(id, rec);
    emit();
    return { id, promise };
  }

  // AskUserQuestion — a real question, answered from the touchscreen.
  //
  // The answer goes back as the tool's own input with `answers` filled in
  // (header note 2), so the tool runs and returns it exactly as it would have
  // if the user had picked it in the terminal.
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
    const projected = projectQuestions(d.tool_input);
    if (!projected) return null;                   // nothing readable to show
    if (pending.size >= MAX_PENDING) return null;
    const questions = projected.shown;

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
      // Server-side only: the exact question texts (the answer keys) and the
      // input to echo back with `answers` added.
      keys: projected.keys,
      input: d.tool_input,
      plan: '',
      risks: [],
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
  // order the card showed them, and `typed` one string per question (the
  // "Other" box, or the answer to a text/number question). Picks are matched
  // against the options Claude published rather than trusted; a typed answer is
  // the user's own words, the same thing the terminal's "Other" row sends.
  function answer(id, selections, typed) {
    const rec = pending.get(str(id, 80));
    if (!rec || rec.kind !== 'question') return false;

    const answers = buildAnswers(rec.questions, rec.keys, selections, typed);
    // Nothing recognisable chosen: refuse rather than send Claude an answer that
    // says nothing. The card stays up and the user can try again.
    if (!answers) return false;

    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'question');
    if (s) s.lastAt = now();
    rec.resolve({ verdict: 'answer', updatedInput: { ...rec.input, answers } });
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
  //
  // For a plan, `opts.mode` is the row the user picked (one of rec.choices; an
  // unknown or missing one means the first, which is also the terminal's
  // default row) and `opts.feedback` is what to change when they send it back.
  function decide(id, behavior, opts) {
    const rec = pending.get(str(id, 80));
    if (!rec) return false;
    // A question is not a permission and is never settled by Allow/Deny — it
    // has its own answer path, which carries the choice. Routing it here would
    // reintroduce exactly the card that could not do what it showed.
    if (rec.kind === 'question') return false;
    const o = opts && typeof opts === 'object' ? opts : {};
    const verdict = behavior === 'allow' ? 'allow' : 'deny';
    let out = { verdict };
    if (rec.kind === 'plan') {
      if (verdict === 'allow') {
        const want = str(o.mode, 30);
        const mode = PLAN_MODES.has(want) && rec.choices.indexOf(want) !== -1 ? want : rec.choices[0];
        out = {
          verdict,
          updatedInput: rec.input,
          updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
        };
      } else {
        out = { verdict, message: planFeedbackMessage(o.feedback) };
      }
    }
    pending.delete(rec.id);
    if (rec.timer) clearTimeout(rec.timer);
    const s = sessions.get(rec.sessionId);
    clearWait(s, 'permission');
    if (s) s.lastAt = now();
    rec.resolve(out);
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
    if (rec.handBackKey) handBacks.set(rec.handBackKey, now());
    const s = sessions.get(rec.sessionId);
    clearWait(s, rec.kind === 'question' ? 'question' : 'permission');
    if (rec.resolve) rec.resolve({ verdict: rec.kind === 'question' ? 'skip' : 'timeout' });
    emit();
    return true;
  }

  // The mod asked about this call and got no answer in its short wait, so it
  // let Claude Code go on, and the next thing Claude Code runs is the
  // PermissionRequest hook link() installed, about the same call. Answering
  // that one with "no decision" is the hand back to the terminal the user was
  // promised; a second card waiting 9 minutes would break it. PermissionRequest
  // carries no call id, so the session and tool, seconds apart, identify it.
  // A mod card still pending for that pair (the mod gave up first) is withdrawn.
  function takeHandBack(data) {
    const d = (data && typeof data === 'object') ? data : {};
    const key = handBackKey(str(d.session_id, 80), str(d.tool_name, 60) || 'tool');
    for (const rec of pending.values()) if (rec.handBackKey === key) cancel(rec.id);
    const t = now();
    for (const [k, at] of handBacks) if (t - at > HANDBACK_MS) handBacks.delete(k);
    if (!handBacks.has(key)) return false;
    handBacks.delete(key);
    return true;
  }

  // ── corroboration from Claude Code's own registry ──────────────────────────
  // Rows come from claude-sessions.js. Advisory, never authoritative: it fills
  // in sessions the hook feed cannot know about and retires ones whose process
  // is gone. Everything a hook told us wins over everything a file says, because
  // the hook came from the session itself and this is a snapshot on disk.
  // Sessions that say they are working, with when the turn began, for the
  // interrupt check (an Esc fires no Stop hook).
  function workingSessions() {
    const out = [];
    for (const s of sessions.values()) {
      if (!s.endedAt && s.state === 'running' && !s.compacting && s.turnAt) out.push({ id: s.id, since: s.turnAt });
    }
    return out;
  }

  // The turn was interrupted in the terminal: nothing is running any more.
  function markInterrupted(sessionId) {
    const s = sessions.get(str(sessionId, 80));
    if (!s || s.endedAt || s.state !== 'running') return false;
    s.state = 'idle'; s.tool = ''; s.toolDetail = ''; s.turnOver = true;
    if (s.waitFor && !hasPendingFor(s.id)) s.waitFor = null;
    emit();
    return true;
  }

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
          giveBack(known, true);
          known.subagents = []; known.queued = null; known.handed = null;
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
        // ...except for a session no hook reaches (started before the link):
        // the file is all there is, and a state frozen at first sight left its
        // open conversation without the refresh a working session gets.
        if (known.unlinked && (r.status === 'busy' || r.status === 'idle')) {
          const state = r.status === 'busy' ? 'running' : 'idle';
          if (known.state !== state) { known.state = state; known.lastAt = now(); moved = true; }
        }
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
      giveBack(s, true);
      s.tool = ''; s.toolDetail = ''; s.waitFor = null; s.queued = null; s.handed = null;
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
      if (t - since > limit) { sessions.delete(k); continue; }
      // Past their window these would say something no longer true.
      if (s.handed && t - s.handed.at >= HANDED_TTL_MS) s.handed = null;
      if (s.undelivered && t - s.undelivered.at >= UNDELIVERED_TTL_MS) s.undelivered = null;
      if (s.subagents.some((a) => a.endedAt && t - a.endedAt > AGENT_DONE_MS)) {
        s.subagents = s.subagents.filter((a) => !a.endedAt || t - a.endedAt <= AGENT_DONE_MS);
      }
    }
    for (const [k, at] of modLastAt) {
      if (sessions.has(k) || t - at <= SESSION_STALE_MS) continue;
      modLastAt.delete(k); modVersions.delete(k); modCommandLists.delete(k); commandsAsked.delete(k);
    }
  }

  // Waiting for the end of the turn ('turn') or for the mod ('terminal'). A
  // message the mod already took counts until the turn starts: it is on its
  // way, and can no longer be cancelled.
  function queuedView(s, t) {
    if (s.queued) return { text: s.queued.text, ageMs: t - s.queued.at, via: s.queued.via };
    if (inFlight(s, t)) return { text: s.handed.text, ageMs: t - s.handed.at, via: 'terminal', handed: true };
    return null;
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
        plan: s.plan,
        planAt: s.planAt,
        subagents: s.subagents.map((a) => ({ ...a, ageMs: t - a.at, endedMs: a.endedAt ? t - a.endedAt : 0 })),
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
        // How long the turn has been working, not the session: a session open
        // for an hour showed "1h" a second into a new turn.
        runForMs: t - (s.turnAt || s.startedAt),
        ageMs: t - s.lastAt,
        ended: !!s.endedAt,
        endedReason: s.endedReason,
        // A session Xenon can see (its own registry file) but is not wired into,
        // because it started before Claude Code was linked. Its controls would
        // all fail, so the widget says so instead of offering them. Not while
        // the mod listens in it: a tile message then gets in through the mod,
        // and after a Xenon restart every open session looks unwired until its
        // next hook.
        unlinked: !!s.unlinked && !terminal(s.id),
        // The Xenon mod is listening in this session right now
        // (claude-inbox.js), so a message for it while idle goes into it.
        terminal: !s.endedAt && terminal(s.id),
        // That mod is new enough (0.4.0) to run /model, /effort and /compact.
        modCommands: modCommands(s.id),
        // When the mod last listed this session's slash commands (0: it never has).
        commandsAt: (modCommandLists.get(s.id) || { at: 0 }).at,
        queued: queuedView(s, t),
        // A tile message that did not get in, offered back once on the tile.
        undelivered: s.undelivered ? { text: s.undelivered.text, reason: s.undelivered.reason, at: s.undelivered.at } : null,
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
        // option, answers Claude. 'plan' → the plan dialog's rows (approve into
        // a mode, or send it back). The client renders a different card for
        // each and must never guess from the tool name.
        kind: p.kind,
        project: p.project,
        tool: p.tool,
        detail: p.kind === 'plan' ? '' : p.detail,
        questions: p.questions || null,
        plan: p.plan || '',
        choices: p.choices || null,
        risks: p.risks || [],
        task: p.task,
        model: p.model,
        waitedMs: t - p.createdAt,
        expiresInMs: Math.max(0, p.expiresAt - t),
        urgent: t >= p.urgentAt,
      }));

    return {
      // The server's clock when this was built: activity marks carry absolute
      // times, and the widget positions them against this, not its own clock.
      now: t,
      limits: limits ? { ...limits, ageMs: t - limits.at } : null,
      // The mod's last word, so the tile can say whether it is installed.
      mod: modStatus(),
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
        s.subagents.map(a => [a.id, a.status, a.model, a.effort, a.tools, a.tool, a.detail, Math.round(a.tokens / 1000), a.desc, a.last ? 1 : 0].join('~')).join('/'), s.activity.length,
        s.queued ? 'q' + s.queued.via + (s.queued.handed ? 'h' : '') : '', s.ended ? 'e' : '', s.resting ? 1 : 0,
        s.terminal ? 't' : '', s.undelivered ? 'u' + s.undelivered.at : '',
        s.contextPct == null ? '' : Math.round(s.contextPct), s.model || '', s.effort || '', s.planAt || 0,
        s.linesAdded || 0, s.linesRemoved || 0, s.commandsAt || 0,
      ].join(':')).join(',')
        + '|' + approvals.map(a => a.id + (a.urgent ? '!' : '')).join(',')
        + '|' + (limits ? `${limits.fiveHour && limits.fiveHour.pct}/${limits.sevenDay && limits.sevenDay.pct}` : '')
        + '|' + (modSeen ? 'm' : ''),
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
  // it; 'terminal' = idle with the mod listening, which starts a turn with it;
  // 'resume' = idle, so the caller continues the same conversation as a run;
  // 'none' = ended or never ours.
  function replyModeFor(id) {
    const s = sessions.get(str(id, 80));
    if (!s || s.endedAt) return 'none';
    if (s.queued || inFlight(s, now())) return 'queued';
    if (s.state === 'running' || s.state === 'waiting') return 'followup';
    return terminal(s.id) ? 'terminal' : 'resume';
  }

  return {
    applyStatus, applyHook, applyMod, modStatus, requestPermission, takeHandBack, askQuestion, answer, skipQuestion,
    decide, cancel, snapshot, stop, cwdFor, mergeRegistry, workingSessions, markInterrupted, commandListFor, wantsCommandList,
    queueFollowUp, cancelFollowUp, takeFollowUp, takeForTerminal, terminalGone, replyModeFor,
    get pendingCount() { return pending.size; },
  };
}

module.exports = {
  describeRisk,
  createBridge,
  describeTool,
  describeChange,
  describeTodos,
  buildAnswers,
  joinAnswer,
  planFeedbackMessage,
  followUpReason,
  isDestructive,
  isInjectedPrompt,
  APPROVAL_TTL_MS,
  URGENT_AFTER_MS,
  QUESTION_TTL_MS,
  FOLLOWUP_TTL_MS,
  HANDED_TTL_MS,
  UNDELIVERED_TTL_MS,
  SESSION_STALE_MS,
  SESSION_RESTING_MS,
};
