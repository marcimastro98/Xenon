// What the engine answers when the notifications tile starts: what is turned on and the
// notifications it holds.

const { normalizeWindowsNotifications } = require('../settings/normalize-notifications.js');
const { hub } = require('../settings/current.js');
const winNotif = require('../winnotif.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /notifications/windows': async (_req, _res, { json }) => {
    // Seed for the Notifications tile: feature flags + the bounded feed buffer.
    // New items then stream live over the `windows_notification` SSE event.
    // Notification text is private user data — loopback-only like every route,
    // and NEVER a JSONP candidate.
    const wn = normalizeWindowsNotifications(hub.settings && hub.settings.windowsNotifications);
    json({ ok: true, enabled: wn.enabled, hide: wn.hide, toast: wn.toast, excluded: wn.excluded, supported: winNotif.isSupported(), state: winNotif.reportedState(), items: winNotif.getFeed() });
  },
};

module.exports = { branches };
