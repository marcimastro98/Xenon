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
const { writeFileAtomic } = require('./atomic-write');

const STATUSLINE_SCRIPT = path.join(__dirname, 'claude-statusline.js');
const { readJson, readState, writeState, ensureToken } = require('./claude-code/link-record.js');
const BACKUP_SUFFIX = '.xenon-backup';

const { MOD_PLUGIN_ID, isPlainObject, addMod, removeMod } = require('./claude-code/link-mod.js');

const {
  EVENT_HOOKS, EVENT_TIMEOUT_SEC, PERMISSION_EVENT, PERMISSION_TIMEOUT_SEC, TURN_END_EVENT,
  TURN_END_TIMEOUT_SEC, QUESTION_EVENT, QUESTION_MATCHER, QUESTION_TIMEOUT_SEC, isOurHandler,
  isOurStatusLine, stripOurHooks, ourHandler, expectedHandlers, installedHandlers,
} = require('./claude-code/link-hook-events.js');

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
function settingsPath() {
  return path.join(configDir(), 'settings.json');
}

// The user's permissions.defaultMode in Claude Code's own settings. Read-only:
// the plan card uses it to decide whether auto mode is one of its choices.
async function defaultMode() {
  const cfg = await readJson(settingsPath());
  const m = cfg && cfg.permissions && cfg.permissions.defaultMode;
  return typeof m === 'string' ? m : '';
}



async function status(dataDir, port) {
  const file = settingsPath();
  const settings = await readJson(file);
  const state = await readState(dataDir);
  const hooks = (settings && settings.hooks) || {};

  const installed = installedHandlers(hooks);
  const ourHookCount = installed.length;
  const same = (a, b) => a.event === b.event && a.path === b.path && a.matcher === b.matcher;
  const current = (h) => h.port === Number(port) && !!state.token && h.token === state.token;
  const expected = expectedHandlers();
  const missing = expected.filter((e) => !installed.some((h) => same(h, e) && current(h)));
  const outdated = installed.filter((h) => !expected.some((e) => same(h, e)) || !current(h));
  const sl = settings && settings.statusLine;
  const ours = isOurStatusLine(sl);

  return {
    // "linked" means the user connected Claude Code: our entries are there.
    linked: ourHookCount > 0 && ours,
    // "complete" means every piece the widget relies on is there and current.
    // A linked-but-incomplete config is repaired by the server (repairLink).
    complete: ourHookCount > 0 && ours && missing.length === 0 && outdated.length === 0,
    missing: missing.map((e) => e.event + (e.matcher ? '(' + e.matcher + ')' : '') + ' ' + e.path),
    outdated: outdated.length,
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
    // Whether the settings ask Claude Code for the mod (not whether it is
    // running: the bridge's `mod` field says that).
    modEnabled: !!(settings && isPlainObject(settings.enabledPlugins) && settings.enabledPlugins[MOD_PLUGIN_ID] === true),
  };
}

// ── link ─────────────────────────────────────────────────────────────────────
// `opts.mod === false` leaves the mod alone (a repair must not add anything the
// user did not click); otherwise connecting also asks Claude Code for the mod.
async function link(dataDir, port, opts) {
  const withMod = !(opts && opts.mod === false);
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

  if (withMod) addMod(settings);

  await writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n');
  await writeState(dataDir, { ...state, token, chained, port, linkedAt: Date.now() });

  return status(dataDir, port);
}

// ── repair ───────────────────────────────────────────────────────────────────
// A link the user made that is now incomplete (written by an older Xenon, or
// rewritten since by something else) is brought back to the current set, once,
// through the same link() that made it: same backup rule, same statusline
// chaining, same precise entries. Only a link that EXISTS is repaired; this can
// never connect Claude Code on its own. Hooks are read by Claude Code when a
// session starts, so a repair reaches sessions opened after it, and the widget
// says so. The link must also be THIS data folder's (it has a linkedAt): a second
// Xenon on another port or data folder would otherwise take the user's hooks over
// with its own port and token.
async function repairLink(dataDir, port) {
  const st = await status(dataDir, port);
  if (!st.linked || st.complete || !st.linkedAt) return { ...st, repaired: false };
  const next = await link(dataDir, port, { mod: false });
  return { ...next, repaired: true, repairedMissing: st.missing, repairedOutdated: st.outdated };
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
    removeMod(next);
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
  repairLink,
  ensureToken,
  readState,
  defaultMode,
  settingsPath,
  configDir,
  // exported for tests
  stripOurHooks,
  isOurHandler,
  isOurStatusLine,
  EVENT_HOOKS,
  PERMISSION_EVENT,
  expectedHandlers,
  installedHandlers,
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
