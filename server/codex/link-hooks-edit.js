'use strict';
// Our handlers in Codex's hooks.json: the events they are wanted for, one handler built, a
// handler told ours from the user's own, where ours stand, the file with ours put in where they
// stood, and the file without them.

const { HOOK_SCRIPT } = require('./script-paths.js');
const { hookCommand } = require('./link-command.js');

const OURS_RE = /codex-hook\.(?:js|cmd)/;

// What each hook is for, so the next person can judge a removal. Every one is
// a node process started by Codex, so an event earns its place only when the
// tile SHOWS something it could not show without it. That is why there is no
// PreToolUse/PostToolUse here: a process per tool call is a real cost on a
// busy session, for a line of activity.
//   PermissionRequest  the approval card. The only one that waits for an answer.
//   SessionStart       a session appearing (its project, model)
//   UserPromptSubmit   the headline: what the user asked it to do
//   Stop               a turn finished: the session goes from running to idle
//   SessionEnd         the session closed
const PERMISSION = Object.freeze({ event: 'PermissionRequest', mode: 'permission', timeout: 600, statusMessage: 'Waiting for an answer on Xenon', async: false });
const LIFECYCLE = Object.freeze([
  Object.freeze({ event: 'SessionStart', mode: 'event', timeout: 10, async: true }),
  Object.freeze({ event: 'UserPromptSubmit', mode: 'event', timeout: 10, async: true }),
  Object.freeze({ event: 'Stop', mode: 'event', timeout: 10, async: true }),
  // SessionEnd is capped at 3 seconds by Codex, and never async: Codex runs it
  // synchronously anyway and flags an async one as "1 issue loading hooks" in
  // its hooks list (Discord, Oct 2026). The hook only posts to loopback, so
  // the wait is short.
  Object.freeze({ event: 'SessionEnd', mode: 'event', timeout: 3, async: false }),
]);
const EXPECTED = Object.freeze([PERMISSION].concat(LIFECYCLE));

function ourHandler(spec, platform = process.platform, nodePath = process.execPath, scriptPath = HOOK_SCRIPT, wrapper = null) {
  const h = { type: 'command', command: hookCommand(platform, nodePath, scriptPath, spec.mode, wrapper), timeout: spec.timeout };
  if (spec.statusMessage) h.statusMessage = spec.statusMessage;
  if (spec.async) h.async = true;
  return h;
}
function isOurHandler(h) {
  if (!h || typeof h !== 'object' || h.type !== 'command') return false;
  return OURS_RE.test(String(h.command || '')) || OURS_RE.test(String(h.commandWindows || ''));
}
function isOurCommand(cmd) { return OURS_RE.test(String(cmd || '')); }
function sameHandler(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── the edit itself (pure) ───────────────────────────────────────────────────
// Where each of our handlers currently sits: { event → [groupIndex, handlerIndex] }.
function locateOurs(hooks) {
  const at = {};
  for (const event of Object.keys(hooks || {})) {
    const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
    groups.forEach((g, gi) => {
      (g && Array.isArray(g.hooks) ? g.hooks : []).forEach((h, hi) => {
        if (isOurHandler(h) && !at[event]) at[event] = [gi, hi];
      });
    });
  }
  return at;
}
// Returns the new hooks.json object, or the same object when nothing changes.
function withOurHooks(file, handlerFor = ourHandler) {
  const next = { ...file };
  const hooks = next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks) ? { ...next.hooks } : {};
  let changed = !(next.hooks && typeof next.hooks === 'object' && !Array.isArray(next.hooks));
  const at = locateOurs(hooks);
  for (const spec of EXPECTED) {
    const want = handlerFor(spec);
    const groups = Array.isArray(hooks[spec.event]) ? hooks[spec.event].map((g) => ({ ...g, hooks: Array.isArray(g && g.hooks) ? g.hooks.slice() : [] })) : [];
    const pos = at[spec.event];
    if (pos) {
      const [gi, hi] = pos;
      if (!sameHandler(groups[gi].hooks[hi], want)) { groups[gi].hooks[hi] = want; changed = true; }
      // Any further copy of ours for the same event is a duplicate: drop it.
      for (let g = groups.length - 1; g >= 0; g--) {
        const kept = groups[g].hooks.filter((h, i) => !(isOurHandler(h) && !(g === gi && i === hi)));
        if (kept.length !== groups[g].hooks.length) { changed = true; if (kept.length) groups[g].hooks = kept; else groups.splice(g, 1); }
      }
    } else {
      groups.push({ hooks: [want] });
      changed = true;
    }
    hooks[spec.event] = groups;
  }
  if (!changed) return file;
  next.hooks = hooks;
  return next;
}
function withoutOurHooks(file) {
  if (!file.hooks || typeof file.hooks !== 'object') return file;
  const hooks = {};
  let changed = false;
  for (const event of Object.keys(file.hooks)) {
    const groups = Array.isArray(file.hooks[event]) ? file.hooks[event] : file.hooks[event];
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const kept = [];
    for (const g of groups) {
      const hs = g && Array.isArray(g.hooks) ? g.hooks : null;
      if (!hs) { kept.push(g); continue; }
      const rest = hs.filter((h) => !isOurHandler(h));
      if (rest.length !== hs.length) changed = true;
      if (rest.length) kept.push(rest.length === hs.length ? g : { ...g, hooks: rest });
    }
    if (kept.length) hooks[event] = kept; else changed = true;
  }
  if (!changed) return file;
  const next = { ...file };
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return next;
}

module.exports = {
  OURS_RE, PERMISSION, LIFECYCLE, EXPECTED, ourHandler, isOurHandler, isOurCommand, sameHandler,
  locateOurs, withOurHooks, withoutOurHooks,
};
