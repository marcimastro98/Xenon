// Saves the notification switches changed by the assistant or a Deck key.

const { normalizeNotifications } = require('./normalize-notifications.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { nextSettingsRev } = require('./settings-rev.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { discordNotifWanted } = require('./notification-switches.js');
const { refreshWinNotifWatch } = require('../notification-open/watch-refresh.js');
const { refreshDiscordWatch } = require('../discord/watch-refresh.js');
const { stopDiscordWatch } = require('../discord/watch-stop.js');
const { discordMirror } = require('../discord/mirrored.js');

// The notification switches from Bit or the Do not disturb key. Nothing that
// changes nothing is written (no rev bump); the master switch starts or stops
// the Discord and Windows watchers the way POST /settings does.
async function updateNotificationsSetting(change) {
  let masterChanged = false;
  const saved = await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const before = normalizeNotifications(cur.notifications);
    const notifications = normalizeNotifications({ ...before, ...change });
    if (Object.keys(notifications).every((k) => notifications[k] === before[k])) return before;
    masterChanged = notifications.enabled !== before.enabled;
    const written = await writeHubSettings({ ...cur, notifications, rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    broadcastSSE('settings', { rev: written.rev });
    return written.notifications;
  });
  if (masterChanged) {
    if (!discordNotifWanted()) discordMirror.notifications = [];
    stopDiscordWatch();
    refreshDiscordWatch().catch(() => {});
    refreshWinNotifWatch();
  }
  return saved;
}

module.exports = { updateNotificationsSetting };
