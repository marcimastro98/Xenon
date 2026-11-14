'use strict';
// How long the live Claude Code bridge waits and how much it keeps: time limits and size caps
// for sessions, approvals, questions and follow-ups.

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
// A question waits as long as a permission does. Claude Code is blocked on it,
// and the terminal draws nothing while the hook holds it (PreToolUse runs
// before the prompt), so the tile is the only place it can be answered; "In
// the terminal" on the card hands it over sooner. When this runs out we return
// no decision, which lets the tool proceed and ask in the terminal exactly as it
// would have without us.
const QUESTION_TTL_MS = APPROVAL_TTL_MS;
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

// How much of a question or a plan the tile keeps.
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

module.exports = {
  SESSION_STALE_MS, SESSION_RESTING_MS, APPROVAL_TTL_MS, URGENT_AFTER_MS, QUESTION_TTL_MS,
  FOLLOWUP_TTL_MS, HANDED_TTL_MS, UNDELIVERED_TTL_MS, MAX_SESSIONS, MAX_PENDING, MAX_STR,
  MAX_INPUT_CHARS, MAX_TODOS, MAX_ACTIVITY, MAX_SUBAGENTS, AGENT_DONE_MS, MAX_AGENT_LAST,
  MAX_AGENT_TOKENS, MAX_FOLLOWUP_CHARS, MAX_QUESTIONS, MAX_OPTIONS, MAX_TYPED, MAX_PLAN_CHARS,
  QUESTION_KINDS, PLAN_MODES,
};
