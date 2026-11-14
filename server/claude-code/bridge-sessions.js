'use strict';
// One Claude Code session as the bridge keeps it: found or made when it speaks, what it is
// waiting for, its recent activity and its subagents.

const {
  MAX_SESSIONS, MAX_STR, MAX_ACTIVITY, MAX_SUBAGENTS, MAX_AGENT_LAST,
} = require('./bridge-limits.js');
const { str } = require('./bridge-clamp.js');
const { MAX_DIFFS_WITH_LINES } = require('./bridge-describe.js');

function makeSessions({ now, sessions, pending }) {
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
  // A question that left the tile unanswered (time ran out, or "In the
  // terminal") is now drawn in the terminal, and the session is still blocked
  // on it. Keep saying so, with the question, until the tool runs: the
  // Notification Claude Code raises next says only "needs your permission".
  function waitInTerminal(s, rec) {
    if (!s) return;
    const q = rec.questions && rec.questions[0];
    setWait(s, 'question', q && q.question);
    s.waitFor.inTerminal = true;
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

  return {
    touchSession, setWait, hasPendingFor, clearWait, waitInTerminal, pushActivity, agentEntry,
    endAgent,
  };
}

module.exports = { makeSessions };
