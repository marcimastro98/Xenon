'use strict';
// A message typed on the tile for a session that is busy: queued, cancelled, handed to the Stop
// hook or to the terminal, and given back when nobody took it.

const { FOLLOWUP_TTL_MS, HANDED_TTL_MS, MAX_FOLLOWUP_CHARS } = require('./bridge-limits.js');
const { str } = require('./bridge-clamp.js');
const { followUpReason } = require('./bridge-questions.js');

function makeFollowUps({ now, terminal, sessions, modCommands, isTileCommand, emit }) {
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

  return {
    inFlight, queueFollowUp, cancelFollowUp, takeFollowUp, takeForTerminal, giveBack, terminalGone,
  };
}

module.exports = { makeFollowUps };
