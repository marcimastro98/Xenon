'use strict';
// What the page is told about Claude Code: every session, what waits for an answer, the limits
// and the mod, with nothing the page has no need of.

const { SESSION_RESTING_MS } = require('./bridge-limits.js');

function makeSnapshot({
  now, terminal, sessions, pending, readings, modCommandLists, modCommands, modStatus, inFlight,
  prune,
}) {
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
        waitFor: s.waitFor ? { kind: s.waitFor.kind, text: s.waitFor.text, forMs: t - s.waitFor.at, inTerminal: s.waitFor.inTerminal === true } : null,
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
      limits: readings.limits ? { ...readings.limits, ageMs: t - readings.limits.at } : null,
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
        + '|' + (readings.limits ? `${readings.limits.fiveHour && readings.limits.fiveHour.pct}/${readings.limits.sevenDay && readings.limits.sevenDay.pct}` : '')
        + '|' + (readings.modSeen ? 'm' : ''),
    };
  }

  return { snapshot };
}

module.exports = { makeSnapshot };
