'use strict';
// The sessions Claude Code itself lists on disk merged into what the bridge heard, the ones
// still working, and the old ones dropped.

const {
  SESSION_STALE_MS, SESSION_RESTING_MS, HANDED_TTL_MS, UNDELIVERED_TTL_MS, AGENT_DONE_MS,
} = require('./bridge-limits.js');
const { str, projectName } = require('./bridge-clamp.js');

function makeRegistry({
  now, sessions, modVersions, modCommandLists, modLastAt, commandsAsked, touchSession,
  hasPendingFor, giveBack, emit,
}) {
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

  return { workingSessions, markInterrupted, mergeRegistry, prune };
}

module.exports = { makeRegistry };
