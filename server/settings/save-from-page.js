// Saves the parts of the settings sent by pages that never send the whole of them: a tile's
// fields, the Vitals state, what was read of an update, and Performance Mode, each read,
// changed and written inside the lock.

const TileSettings = require('../grid/tile-settings.js');
const VitalsState = require('../vitals/vitals-state.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const winNotif = require('../winnotif.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { refreshWinNotifWatch } = require('../notification-open/watch-refresh.js');

// POST /settings/tile: the fields a tile keeps in the settings, saved from a
// layer page (which never writes the whole blob). Same lock, rev bump and
// broadcast as change_setting; the notifications reader follows its switch.
async function saveTileSettings(body) {
  const plan = TileSettings.plan(body);
  if (plan.error) return { ok: false, ...plan };
  let rev = null;
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const written = await writeHubSettings({ ...cur, ...TileSettings.apply(cur, plan.patch), rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    rev = written.rev;
    broadcastSSE('settings', { rev });
  });
  if (plan.patch.windowsNotifications) { refreshWinNotifWatch(); winNotif.applyExclusions(); }
  return { ok: true, rev };
}

// POST /api/vitals/state: the Vitals widget's state saved from a layer page,
// merged like the /settings save. Same lock, rev bump and broadcast.
async function saveVitalsState(body) {
  const plan = VitalsState.plan(body);
  if (plan.error) return { ok: false, ...plan };
  let rev = null;
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const vitals = cur.vitals && typeof cur.vitals === 'object' ? cur.vitals : {};
    const written = await writeHubSettings({ ...cur, vitals: { ...vitals, state: VitalsState.mergeState(vitals.state, plan.state) }, rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    rev = written.rev;
    broadcastSSE('settings', { rev });
  });
  return { ok: true, rev };
}

// What the person has read of an update, from any surface (POST /update/notice-seen).
async function saveNoticeSeen(seen) {
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const saved = await writeHubSettings({ ...cur, ...seen, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
  });
}

// Performance Mode's own block, saved by the "widgets only" driver page
// (js/performance/driver-perf.js), which has no POST /settings of its own. Already
// normalized (perf-screen.js stateFrom); the rest of the settings stay.
async function updatePerformanceSetting(performance) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const saved = await writeHubSettings({ ...cur, performance, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved;
  });
}

module.exports = { saveTileSettings, saveVitalsState, saveNoticeSeen, updatePerformanceSetting };
