// Changes one part of the settings for the assistant, a Deck key or a widget: read, changed and
// written inside the lock, and every open screen told the new save number.

const { broadcastSSE } = require('../http/sse-clients.js');
const PerfHud = require('../js/performance/perf-hud.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { readHubSettingsForUpdate } = require('./read.js');
const { hub } = require('./current.js');
const { writeHubSettings } = require('./write.js');
const { withHubSettingsLock } = require('./write-lock.js');

// Bit's Vitals tools write like a tap on the bar: one locked read-modify-write,
// a new rev, and every surface told to read the settings again.
async function updateVitalsSettings(change) {
  const saved = await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const next = change(cur);
    if (!next) return cur;
    hub.settings = await writeHubSettings({ ...next, rev: nextSettingsRev(cur.rev) });
    return hub.settings;
  });
  if (saved !== null) broadcastSSE('settings', { rev: saved.rev });
  return saved;
}

// The Xenon AI edge-glow screens, set by voice (capabilities/ai-glow.js): the
// main dashboard re-hydrates from the broadcast and re-sends the glow.
async function updateGameSessionsSetting(on) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const saved = await writeHubSettings({ ...cur, gameSessions: { enabled: !!on }, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved.gameSessions.enabled;
  });
}

// What the Game performance tile shows (js/performance/perf-hud.js), from the AI or a Deck
// key. Returns the saved parts.
async function updatePerfHudSetting(change) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const perfHud = PerfHud.applyPerfHudChange(cur.perfHud, change);
    const saved = await writeHubSettings({ ...cur, perfHud, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved.perfHud;
  });
}

// One top-level setting changed by a Deck key, Bit or an SDK action. `change`
// gets the stored value and returns the next one, inside the lock, so a toggle
// never reads a value another press is about to replace; the normalizer in
// writeHubSettings decides what survives. Nothing that changes nothing is written.
async function updateHubSettingKey(key, change) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const next = change(cur[key]);
    if (JSON.stringify(next) === JSON.stringify(cur[key])) return cur[key];
    const saved = await writeHubSettings({ ...cur, [key]: next, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved[key];
  });
}

async function updateAiEdgeGlowSetting(mode) {
  return withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const saved = await writeHubSettings({ ...cur, aiEdgeGlow: mode, rev: nextSettingsRev(cur.rev) });
    hub.settings = saved;
    broadcastSSE('settings', { rev: saved.rev });
    return saved.aiEdgeGlow;
  });
}

module.exports = {
  updateVitalsSettings, updateGameSessionsSetting, updatePerfHudSetting, updateHubSettingKey,
  updateAiEdgeGlowSetting,
};
