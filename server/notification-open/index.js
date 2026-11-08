'use strict';
// Tap a notification, get its app: the window of the app that posted it comes
// to the front, or, when it has none open, the app starts. Asked for by users
// who see a message on the side screen and want to answer it.
//
// Only a notification the server itself holds can be opened: the caller names
// a feed id (or "latest"), never an app, a path or an AUMID. What gets started
// is the AUMID Windows reported for that toast, and only when it is one of the
// apps in the Start menu's Apps folder; on Linux, the .desktop entry the
// notification named, found among the installed apps.
//
// deps (injected, per platform; a missing one is a step this OS cannot take):
//   feed()                → the feed items, newest first ({ id, app, aumid, desktopEntry })
//   listWindows()         → Promise<[{ id, app, title }]>
//   focusWindow(id)       → Promise<{ ok }>
//   startAppIds()         → Promise<Set<string>>   Windows: the Apps-folder ids
//   launchAumid(aumid)    → Promise                Windows: shell:AppsFolder\<aumid>
//   desktopApps()         → Promise<[{ name, target }]>  Linux: .desktop entries
//   launchDesktop(target) → Promise                Linux: gio launch

const { matchWindow, isLaunchableAumid, isDesktopEntryId, norm } = require('./match.js');
const { createStartAppIds, readStartApps, launchAumid } = require('./start-apps.js');

function findItem(feed, which) {
  const items = Array.isArray(feed) ? feed : [];
  if (which == null || which === '' || which === 'latest') return items[0] || null;
  const id = Number(which);
  if (!Number.isInteger(id) || id <= 0) return null;
  return items.find((it) => it && it.id === id) || null;
}

async function focusOwnWindow(d, item) {
  if (typeof d.listWindows !== 'function' || typeof d.focusWindow !== 'function') return false;
  let windows = [];
  try {
    const res = await d.listWindows();
    windows = Array.isArray(res) ? res : (res && Array.isArray(res.windows) ? res.windows : []);
  } catch { return false; }
  const win = matchWindow(windows, item);
  if (!win) return false;
  try { return !!((await d.focusWindow(win.id)) || {}).ok; } catch { return false; }
}

async function startByAumid(d, item) {
  if (!isLaunchableAumid(item.aumid) || typeof d.launchAumid !== 'function' || typeof d.startAppIds !== 'function') return false;
  let ids;
  try { ids = await d.startAppIds(); } catch { return false; }
  // Asked of the Apps folder first: explorer answers an unknown id with an
  // error dialog on the user's screen, never with an exit code.
  if (!ids || !ids.has(item.aumid)) return false;
  await d.launchAumid(item.aumid);
  return true;
}

async function startDesktopEntry(d, item) {
  if (typeof d.desktopApps !== 'function' || typeof d.launchDesktop !== 'function') return false;
  let apps = [];
  try { apps = await d.desktopApps(); } catch { return false; }
  const entry = isDesktopEntryId(item.desktopEntry) ? item.desktopEntry.toLowerCase() + '.desktop' : '';
  const name = norm(item.app);
  const app = (Array.isArray(apps) ? apps : []).find((a) => a && typeof a.target === 'string' && /\.desktop$/.test(a.target)
    && ((entry && a.target.toLowerCase().endsWith('/' + entry)) || (name && norm(a.name) === name)));
  if (!app) return false;
  await d.launchDesktop(app.target);
  return true;
}

// The steps each OS can take, from what server.js already has. macOS has no
// notification reader, so there is nothing to open there.
function platformDeps(o) {
  const base = { feed: o.feed, listWindows: o.listWindows, focusWindow: o.focusWindow };
  if (o.platform === 'win32') {
    return {
      ...base,
      startAppIds: createStartAppIds(() => readStartApps(o.execFile)),
      launchAumid: (aumid) => launchAumid(o.execFile, aumid),
    };
  }
  if (o.platform === 'linux') {
    return {
      ...base,
      desktopApps: async () => (await o.getInstalledApps()).filter((a) => a && a.kind === 'desktop'),
      launchDesktop: (target) => o.launchLinuxApp(target),
    };
  }
  return { feed: () => [] };
}

function createNotificationOpener(deps) {
  const d = deps || {};
  async function open(which) {
    const item = findItem(typeof d.feed === 'function' ? d.feed() : [], which);
    if (!item) return { ok: false, error: 'no_notification' };
    const app = String(item.app || '');
    if (await focusOwnWindow(d, item)) return { ok: true, how: 'focused', app };
    try {
      if (await startByAumid(d, item)) return { ok: true, how: 'opened', app };
      if (await startDesktopEntry(d, item)) return { ok: true, how: 'opened', app };
    } catch {
      return { ok: false, error: 'launch_failed', app };
    }
    return { ok: false, error: 'not_launchable', app };
  }
  // Only where notifications are read at all (Windows, Linux).
  const available = () => typeof d.focusWindow === 'function' || typeof d.launchDesktop === 'function';
  return { open, available };
}

module.exports = { createNotificationOpener, platformDeps, findItem };
