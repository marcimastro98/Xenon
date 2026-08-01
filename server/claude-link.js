'use strict';

// ── Claude Code link — writes (and cleanly removes) the hub's own hooks and
// statusline in the user's Claude Code settings.json ─────────────────────────
//
// This is the only module in the codebase that edits a file owned by ANOTHER
// application, so it is deliberately conservative:
//
//   • It backs the original file up once, before the first write, and keeps that
//     backup until the user unlinks.
//   • It NEVER discards an existing statusline. Claude Code allows exactly one
//     `statusLine` per settings scope, so linking replaces it — we stash the
//     user's previous command and our own script execs it and prints its output,
//     so their status bar keeps working. Unlinking puts it back verbatim.
//   • Every entry we add is identifiable (our hook handlers all point at this
//     hub's /api/claude/ URLs, our statusline runs claude-statusline.js), so
//     unlink removes exactly ours and leaves the user's own hooks untouched.
//   • The settings file is written through writeFileAtomic, like every durable
//     store in this codebase — a half-written settings.json would break Claude
//     Code on next launch.
//
// The bridge token lives in DATA_DIR/claude-bridge.json, not on the hook command
// line, so it never shows up in a process list. Our statusline script reads it
// from that file relative to its own location.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./atomic-write');

const STATUSLINE_SCRIPT = path.join(__dirname, 'claude-statusline.js');
const STATE_FILE = 'claude-bridge.json';   // inside DATA_DIR
const BACKUP_SUFFIX = '.xenon-backup';

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

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

async function readJson(file) {
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}

// ── hub-side state (token + what we replaced) ────────────────────────────────
async function readState(dataDir) {
  const s = await readJson(path.join(dataDir, STATE_FILE));
  return s || {};
}
async function writeState(dataDir, state) {
  await writeFileAtomic(path.join(dataDir, STATE_FILE), JSON.stringify(state, null, 2));
}

// The token is created once and reused, so relinking (or changing port) doesn't
// invalidate a config the user already has on disk.
async function ensureToken(dataDir) {
  const state = await readState(dataDir);
  if (typeof state.token === 'string' && state.token.length >= 32) return state.token;
  const token = crypto.randomBytes(24).toString('hex');
  await writeState(dataDir, { ...state, token });
  return token;
}

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
async function status(dataDir, port) {
  const file = settingsPath();
  const settings = await readJson(file);
  const state = await readState(dataDir);
  const hooks = (settings && settings.hooks) || {};

  let ourHookCount = 0;
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    for (const g of groups) {
      const handlers = (g && Array.isArray(g.hooks)) ? g.hooks : [];
      ourHookCount += handlers.filter(h => isOurHandler(h, port)).length;
    }
  }
  const sl = settings && settings.statusLine;
  const ours = isOurStatusLine(sl);

  return {
    // "linked" means the pieces that make the widget work are actually present.
    linked: ourHookCount > 0 && ours,
    settingsPath: file,
    settingsExists: !!settings,
    hookCount: ourHookCount,
    // The lifecycle set, plus PermissionRequest, Stop and the AskUserQuestion
    // interceptor. Kept derived rather than written as a number so adding an
    // event cannot leave the widget reporting a partial link forever.
    expectedHooks: EVENT_HOOKS.length + 3,
    statusLine: ours ? 'ours' : (sl ? 'foreign' : 'none'),
    // A statusline of the user's own that we would chain (or already chained).
    chained: state.chained ? String(state.chained.command || '') : (sl && !ours ? String(sl.command || '') : ''),
    backupExists: fs.existsSync(file + BACKUP_SUFFIX),
    linkedAt: state.linkedAt || 0,
  };
}

// ── link ─────────────────────────────────────────────────────────────────────
async function link(dataDir, port) {
  const file = settingsPath();
  await fs.promises.mkdir(configDir(), { recursive: true });

  const token = await ensureToken(dataDir);
  const state = await readState(dataDir);
  const existing = await readJson(file);

  // Back the untouched original up exactly once, so unlink always has a floor to
  // fall back to even if our own bookkeeping is lost.
  const backup = file + BACKUP_SUFFIX;
  if (existing && !fs.existsSync(backup)) {
    await writeFileAtomic(backup, JSON.stringify(existing, null, 2));
  }

  const settings = existing ? { ...existing } : {};
  const base = `http://127.0.0.1:${port}/api/claude`;

  // Hooks: drop any previous copy of ours first so relinking never duplicates.
  const hooks = stripOurHooks(settings.hooks, port);
  for (const event of EVENT_HOOKS) {
    const groups = Array.isArray(hooks[event]) ? hooks[event].slice() : [];
    // No matcher → fires on every occurrence of the event.
    groups.push({ hooks: [ourHandler(`${base}/event`, EVENT_TIMEOUT_SEC, token)] });
    hooks[event] = groups;
  }
  const permGroups = Array.isArray(hooks[PERMISSION_EVENT]) ? hooks[PERMISSION_EVENT].slice() : [];
  permGroups.push({ hooks: [ourHandler(`${base}/permission`, PERMISSION_TIMEOUT_SEC, token)] });
  hooks[PERMISSION_EVENT] = permGroups;
  // Stop: its own endpoint, because this is the one that may answer with a
  // decision (it delivers a follow-up typed on the dashboard).
  const stopGroups = Array.isArray(hooks[TURN_END_EVENT]) ? hooks[TURN_END_EVENT].slice() : [];
  stopGroups.push({ hooks: [ourHandler(`${base}/turn-end`, TURN_END_TIMEOUT_SEC, token)] });
  hooks[TURN_END_EVENT] = stopGroups;
  // A SECOND PreToolUse group, matched to AskUserQuestion alone. Both groups
  // fire for that tool — the unmatched one records it in 5 seconds like any
  // other, this one is allowed to block while the user picks an option — and no
  // other tool call ever touches the slow path.
  const qGroups = Array.isArray(hooks[QUESTION_EVENT]) ? hooks[QUESTION_EVENT].slice() : [];
  qGroups.push({ matcher: QUESTION_MATCHER, hooks: [ourHandler(`${base}/question`, QUESTION_TIMEOUT_SEC, token)] });
  hooks[QUESTION_EVENT] = qGroups;
  settings.hooks = hooks;

  // Statusline: preserve whatever the user had. Only capture it when it isn't
  // already ours, otherwise relinking would chain our own script to itself.
  const prev = settings.statusLine;
  const chained = (prev && !isOurStatusLine(prev)) ? prev : (state.chained || null);
  settings.statusLine = {
    type: 'command',
    command: `node "${STATUSLINE_SCRIPT}"`,
    ...(prev && typeof prev.padding === 'number' ? { padding: prev.padding } : {}),
  };

  await writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n');
  await writeState(dataDir, { ...state, token, chained, port, linkedAt: Date.now() });

  return status(dataDir, port);
}

// ── unlink ───────────────────────────────────────────────────────────────────
async function unlink(dataDir, port) {
  const file = settingsPath();
  const settings = await readJson(file);
  const state = await readState(dataDir);

  if (settings) {
    const next = { ...settings };
    const hooks = stripOurHooks(next.hooks, port);
    if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;

    if (isOurStatusLine(next.statusLine)) {
      if (state.chained) next.statusLine = state.chained;
      else delete next.statusLine;
    }
    await writeFileAtomic(file, JSON.stringify(next, null, 2) + '\n');
  }

  // Keep the token (relinking should not invalidate anything) but forget the
  // chained statusline — it has been handed back.
  await writeState(dataDir, { token: state.token, linkedAt: 0 });
  return status(dataDir, port);
}

module.exports = {
  link,
  unlink,
  status,
  ensureToken,
  readState,
  settingsPath,
  configDir,
  // exported for tests
  stripOurHooks,
  isOurHandler,
  isOurStatusLine,
  EVENT_HOOKS,
  PERMISSION_EVENT,
};

// ── CLI: `node server/claude-link.js unlink` ─────────────────────────────────
// Used by the uninstallers. This is the one place Xenon writes into ANOTHER
// application's configuration, so an uninstall that skips it leaves Claude Code
// running a statusline script that no longer exists and posting every hook at a
// port with nothing behind it - on every session, forever, with nothing to
// explain where it came from. The logic stays here, next to link()/unlink(),
// rather than being written a second time in PowerShell and a third in bash.
if (require.main === module) {
  if (process.argv[2] !== 'unlink') {
    console.error('usage: node claude-link.js unlink');
    process.exit(2);
  }
  const dataDir = path.join(__dirname, 'data');
  // Same rule server.js uses, so a hub moved off 3030 unlinks the hooks it
  // actually wrote (they carry the port in their URL).
  const rawPort = parseInt(process.env.XENON_PORT, 10);
  const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort <= 65535 ? rawPort : 3030;

  (async () => {
    const before = await status(dataDir, port);
    // Nothing of ours in there. Saying so and stopping matters: unlink() ends in
    // a write, so calling it anyway would reformat a settings.json we never
    // touched.
    if (!(before.hookCount > 0 || before.statusLine === 'ours')) {
      console.log('not-linked');
      return;
    }
    await unlink(dataDir, port);
    // The backup is ours: taken before our first write, named after us, and
    // sitting in someone else's config folder. Our changes have just been
    // reverted, so keeping it would be litter.
    try { fs.unlinkSync(before.settingsPath + BACKUP_SUFFIX); } catch { /* never existed */ }
    console.log('unlinked');
  })().catch((e) => {
    console.error(String((e && e.message) || e));
    process.exit(1);
  });
}
