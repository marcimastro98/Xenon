'use strict';
// What a Claude Code hook tells the bridge: each event read into the session it belongs to.

const { MAX_STR, MAX_SUBAGENTS, MAX_PLAN_CHARS } = require('./bridge-limits.js');
const { str, num, projectName } = require('./bridge-clamp.js');
const { isInjectedPrompt } = require('./bridge-risk.js');
const { describeTool, describeChange, describeTodos } = require('./bridge-describe.js');

function makeHooks({
  now, sessions, touchSession, setWait, hasPendingFor, clearWait, pushActivity, agentEntry,
  endAgent, giveBack, emit,
}) {
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
        if (s.waitFor && s.waitFor.inTerminal) clearWait(s, 'question');
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
        if (tool === 'AskUserQuestion' && s.waitFor && s.waitFor.inTerminal) clearWait(s, 'question');
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
        if (s && s.waitFor && s.waitFor.inTerminal) break;
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

  return { applyHook };
}

module.exports = { makeHooks };
