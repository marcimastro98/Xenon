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

const {
  SESSION_STALE_MS, SESSION_RESTING_MS, APPROVAL_TTL_MS, URGENT_AFTER_MS, QUESTION_TTL_MS,
  FOLLOWUP_TTL_MS, HANDED_TTL_MS, UNDELIVERED_TTL_MS,
} = require('./bridge-limits.js');



const { str } = require('./bridge-clamp.js');

const { isInjectedPrompt, isDestructive, describeRisk } = require('./bridge-risk.js');

const { describeTool, describeChange, describeTodos } = require('./bridge-describe.js');


const {
  joinAnswer, buildAnswers, planFeedbackMessage, followUpReason,
} = require('./bridge-questions.js');



const { makeSessions } = require('./bridge-sessions.js');

const { makeStatusline } = require('./bridge-statusline.js');

const { makeModReports } = require('./bridge-mod-reports.js');

const { makeFollowUps } = require('./bridge-follow-ups.js');

const { makeHooks } = require('./bridge-hooks.js');

const { makeApprovals } = require('./bridge-approvals.js');

const { makeAsked } = require('./bridge-asked.js');

const { makeRegistry } = require('./bridge-registry.js');

const { makeSnapshot } = require('./bridge-snapshot.js');

function createBridge(opts) {
  const options = opts || {};
  const now = () => (typeof options.now === 'function' ? options.now() : Date.now());
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  // Is the Xenon mod listening in this session right now (claude-inbox.js)?
  // Then a message for it while it is idle goes into that session instead of a
  // background run.
  const terminal = (id) => {
    try { return typeof options.terminal === 'function' && options.terminal(id) === true; } catch { return false; }
  };

  const sessions = new Map();   // session_id → live session record
  const pending = new Map();    // approval id → { …, resolve, timer }
  const readings = {
    limits: null,            // latest rate-limit reading (account-wide)
    modSeen: null,           // { at, version } of the mod's last message
  };
  // The mod version each session last reported. Header commands need 0.4.0: an
  // older mod would submit "/effort high" as a message to Claude.
  const modVersions = new Map();
  // The slash commands each session's mod listed (0.5.0+): [{ name, desc }].
  const modCommandLists = new Map();
  // When each session's mod last spoke, so the two maps above are dropped with
  // the session; and the sessions already asked for their list since this boot.
  const modLastAt = new Map();
  const commandsAsked = new Set();
  const issued = {
    seq: 0,                  // approval id counter (ids are per-boot)
  };

  const {
    touchSession, setWait, hasPendingFor, clearWait, waitInTerminal, pushActivity, agentEntry,
    endAgent,
  } = makeSessions({ now, sessions, pending });


  const {
    requestPermission, decide, cancel, takeHandBack,
  } = makeApprovals({ options, now, sessions, pending, issued, setWait, clearWait, emit });

  const { applyStatus } = makeStatusline({ now, readings, touchSession, emit });

  const {
    modCommands, applyMod, modStatus, isTileCommand, wantsCommandList, commandListFor,
  } = makeModReports({ now, sessions, readings, modVersions, modCommandLists, modLastAt, commandsAsked, touchSession, agentEntry, endAgent, applyStatus, emit });

  const {
    inFlight, queueFollowUp, cancelFollowUp, takeFollowUp, takeForTerminal, giveBack, terminalGone,
  } = makeFollowUps({ now, terminal, sessions, modCommands, isTileCommand, emit });

  const {
    applyHook,
  } = makeHooks({ now, sessions, touchSession, setWait, hasPendingFor, clearWait, pushActivity, agentEntry, endAgent, giveBack, emit });

  const {
    askQuestion, answer, skipQuestion,
  } = makeAsked({ now, sessions, pending, issued, setWait, clearWait, waitInTerminal, emit });

  const {
    workingSessions, markInterrupted, mergeRegistry, prune,
  } = makeRegistry({ now, sessions, modVersions, modCommandLists, modLastAt, commandsAsked, touchSession, hasPendingFor, giveBack, emit });

  const {
    snapshot,
  } = makeSnapshot({ now, terminal, sessions, pending, readings, modCommandLists, modCommands, modStatus, inFlight, prune });

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
