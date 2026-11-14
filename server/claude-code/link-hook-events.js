'use strict';
// Our hooks in Claude Code's settings: the events they are wanted for with their waits, one
// handler built, a handler and a status line told ours from the user's own, the settings
// without ours, and the handlers wanted and found.

// Non-blocking lifecycle events. Kept to a short timeout: these must never slow
// a tool call down, and Claude Code treats a timeout as a non-blocking error and
// carries on regardless.
//
// THE RULE FOR ADDING ONE: every entry here is a synchronous HTTP POST inside
// the user's turn, so it is paid for in latency on somebody's machine, forever.
// An event earns its place only when the widget SHOWS something it could not
// show without it. That is why `FileChanged` and `MessageDisplay` are not here
// despite being useful-sounding: during a build they would be hundreds of posts
// per second in exchange for one line of UI.
//
// What each of these is for, so the next person can judge a removal:
//   SessionStart/SessionEnd  a session appearing and going, with its reason
//   UserPromptSubmit         the headline ("what did I ask it to do")
//   Pre/PostToolUse          the current action, and the activity history
//   PostToolUseFailure       a step that failed, told apart from one that worked
//   Notification             WHY a session is waiting, instead of a bare "waiting"
//   SubagentStart/Stop       fan-out, which otherwise looks like one stuck session
//   Pre/PostCompact          explains the context gauge collapsing
//   StopFailure              a turn that ended on an API error, not on an answer
const EVENT_HOOKS = Object.freeze([
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact', 'StopFailure',
]);
const EVENT_TIMEOUT_SEC = 5;
// The blocking one. Claude Code waits for our answer here, so the timeout is
// generous — the bridge resolves well before it (APPROVAL_TTL_MS) and hands the
// decision back to the terminal rather than letting this expire.
const PERMISSION_EVENT = 'PermissionRequest';
const PERMISSION_TIMEOUT_SEC = 600;
// Stop is a lifecycle event AND the delivery point for a follow-up typed on the
// dashboard, so it goes to its own endpoint: /api/claude/event answers 204 with
// no body on purpose, and the ability to influence a session must live in one
// named place rather than becoming a property of the generic ingest. Nobody is
// waited on here — the queued text is already in hand — so the timeout only has
// to cover a local round trip.
const TURN_END_EVENT = 'Stop';
const TURN_END_TIMEOUT_SEC = 10;
// AskUserQuestion, intercepted on PreToolUse so the user can answer it from the
// touchscreen before the terminal prompt is even drawn. Scoped with a matcher so
// it is the ONLY tool that can block on this path — every other PreToolUse keeps
// the 5-second lifecycle hook above and is never slowed down by it.
const QUESTION_EVENT = 'PreToolUse';
const QUESTION_MATCHER = 'AskUserQuestion';
const QUESTION_TIMEOUT_SEC = 600;

// ── identifying our own entries ──────────────────────────────────────────────
function isOurHandler(h, port) {
  if (!h || typeof h !== 'object' || h.type !== 'http') return false;
  const url = String(h.url || '');
  // Match any port: a stale entry from a previous port must still be removable.
  return /^http:\/\/127\.0\.0\.1:\d+\/api\/claude\//.test(url)
    || url.indexOf(`http://127.0.0.1:${port}/api/claude/`) === 0;
}
function isOurStatusLine(sl) {
  if (!sl || typeof sl !== 'object') return false;
  return String(sl.command || '').indexOf('claude-statusline.js') !== -1;
}

// Strip our handlers out of a hooks tree, dropping any group or event that ends
// up empty. Returns a NEW object — the caller's copy is never mutated in place.
function stripOurHooks(hooks, port) {
  if (!hooks || typeof hooks !== 'object') return {};
  const out = {};
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = [];
    for (const g of groups) {
      if (!g || typeof g !== 'object') continue;
      const handlers = Array.isArray(g.hooks) ? g.hooks.filter(h => !isOurHandler(h, port)) : [];
      if (handlers.length) kept.push({ ...g, hooks: handlers });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

function ourHandler(url, timeoutSec, token) {
  return {
    type: 'http',
    url,
    timeout: timeoutSec,
    headers: { 'X-Xenon-Bridge': token },
  };
}

// ── status ───────────────────────────────────────────────────────────────────
// One entry per handler link() installs. A link is COMPLETE only when every one
// of these is present with the current port and token, and nothing of ours is
// left over from an older set. Counting our handlers was not enough: a link made
// by an older Xenon (no AskUserQuestion interceptor, Stop still on /event) had 8
// of the 15 and was reported as linked, so questions never reached the tile and
// follow-ups were never delivered, with nothing on screen to say why.
function expectedHandlers() {
  const list = EVENT_HOOKS.map((event) => ({ event, path: '/event', matcher: '' }));
  list.push({ event: PERMISSION_EVENT, path: '/permission', matcher: '' });
  list.push({ event: TURN_END_EVENT, path: '/turn-end', matcher: '' });
  list.push({ event: QUESTION_EVENT, path: '/question', matcher: QUESTION_MATCHER });
  return list;
}

// Our handlers as installed: which event, which endpoint, which port, which token.
function installedHandlers(hooks) {
  const out = [];
  for (const event of Object.keys(hooks || {})) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const handlers = (g && Array.isArray(g.hooks)) ? g.hooks : [];
      for (const h of handlers) {
        if (!isOurHandler(h, 0)) continue;
        const m = /^http:\/\/127\.0\.0\.1:(\d+)\/api\/claude(\/[a-z-]+)/.exec(String(h.url || ''));
        out.push({
          event,
          matcher: String((g && g.matcher) || ''),
          path: m ? m[2] : '',
          port: m ? Number(m[1]) : 0,
          token: String((h.headers && h.headers['X-Xenon-Bridge']) || ''),
        });
      }
    }
  }
  return out;
}

module.exports = {
  EVENT_HOOKS, EVENT_TIMEOUT_SEC, PERMISSION_EVENT, PERMISSION_TIMEOUT_SEC, TURN_END_EVENT,
  TURN_END_TIMEOUT_SEC, QUESTION_EVENT, QUESTION_MATCHER, QUESTION_TIMEOUT_SEC, isOurHandler,
  isOurStatusLine, stripOurHooks, ourHandler, expectedHandlers, installedHandlers,
};
