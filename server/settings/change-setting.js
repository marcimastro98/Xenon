// Changes one setting by its name on behalf of the assistant or a Deck key: read, change and
// write inside the settings queue, then tell every dashboard.

const SettingsAi = require('../ai/settings-ai.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { normalizeHubSettings } = require('./normalize-hub-settings.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');
const { refreshAudioLevelsWatch } = require('../audio/levels-wanted.js');

// change_setting: one allowlisted field under the lock; nothing written when it
// already has that value. The rev bump makes open dashboards reload the settings.
async function changeSetting(args) {
  const plan = SettingsAi.plan(args);
  if (plan.error) return { ok: false, ...plan };
  if (plan.read) return { ok: true, settings: SettingsAi.current(hub.settings) };
  let before = null;
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const out = SettingsAi.apply(normalizeHubSettings(cur), plan);
    before = out.before;
    if (!out.patch) return;
    const written = await writeHubSettings({ ...cur, ...out.patch, rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    broadcastSSE('settings', { rev: written.rev });
  });
  if (plan.name === 'visualizer') refreshAudioLevelsWatch();
  const now = SettingsAi.current(hub.settings)[plan.name];
  return { ok: true, setting: plan.name, before, now, ...(before === now ? { unchanged: true } : {}) };
}

module.exports = { changeSetting };
