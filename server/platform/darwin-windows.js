'use strict';
// The open apps on macOS and what Xenon can do to one: bring it forward, hide it, quit it.

const { runSoft } = require('./darwin-read.js');
const { runHelper } = require('./darwin-helper-run.js');
const {
  PROTECTED_APPS, LIST_APPS_SCRIPT, parseAppList, parseHelperWindows, osa, quitAppArgs,
  helperVerdict,
} = require('./darwin-apps.js');

async function listApps(includeProtected) {
  const helped = await runHelper(['windows', 'list'], 5000);
  if (helped !== null) {
    const parsed = parseHelperWindows(helped, includeProtected);
    if (parsed !== null) return parsed;
  }
  // A denied (or never granted) Automation prompt lands here as null. An empty
  // list is the honest answer -- the widget says "no open windows" rather than
  // claiming a failure the user cannot act on.
  const out = await osa(LIST_APPS_SCRIPT, 10000);
  return out === null ? [] : parseAppList(out, includeProtected);
}

async function windows(action, id) {
  if (action === 'focus') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const helped = helperVerdict(await runHelper(['windows', 'focus', String(Number(id))], 5000));
    if (helped) return { ok: helped.ok === true };
    const out = await osa(
      `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(id)}) to true`,
      8000);
    return { ok: out !== null };
  }
  if (action === 'close') {
    if (!/^\d{1,24}$/.test(String(id || ''))) return { ok: false, error: 'not_found' };
    const helped = helperVerdict(await runHelper(['windows', 'close', String(Number(id))], 8000));
    if (helped) {
      if (helped.ok === true) {
        return { ok: true, app: String(helped.app || ''), path: String(helped.path || '') };
      }
      const error = helped.error === 'protected' ? 'protected' : 'not_found';
      return { ok: false, error, app: String(helped.app || '') };
    }
    const list = await listApps(true);
    const hit = list.find((w) => w.id === String(Number(id)));
    if (!hit) return { ok: false, error: 'not_found' };
    if (PROTECTED_APPS.has(hit.app)) return { ok: false, error: 'protected', app: hit.app };
    // `quit` is the graceful close: the app gets to prompt about unsaved work,
    // which is what the Windows path's WM_CLOSE does too.
    const args = quitAppArgs(hit.app);
    if (!args) return { ok: false, error: 'not_found', app: hit.app };
    const out = await runSoft('osascript', args, 8000);
    return out === null
      ? { ok: false, error: 'not_found', app: hit.app }
      : { ok: true, app: hit.app, path: hit.path };
  }
  return { windows: await listApps() };
}

module.exports = { listApps, windows };
