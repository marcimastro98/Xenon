// Saves the lighting set from a tile or a key into the settings, a moment after the last change
// and inside the settings lock.

const lighting = require('../lighting.js');
const { lightingPersist } = require('./persist-state.js');
const { LIGHTING_PERSIST_DEBOUNCE_MS } = require('./persist-timing.js');
const { hub } = require('../settings/current.js');
const { writeHubSettings } = require('../settings/write.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

async function _flushLightingPersist() {
  if (!lightingPersist.timer) return;
  clearTimeout(lightingPersist.timer);
  lightingPersist.timer = null;
  // Serialized with every other settings writer: the base is spread from
  // hub.settings, so a concurrent POST /settings could otherwise commit a
  // vitals refill that this flush then overwrites with its pre-refill copy.
  try { await withHubSettingsLock(async () => { hub.settings = await writeHubSettings({ ...hub.settings, lighting: lighting.getConfig() }); }); }
  catch (e) { console.error('Lighting persist failed:', e.message); }
}

async function _persistLighting() {
  if (lightingPersist.timer) return;   // a flush is already scheduled — it reads the latest config
  lightingPersist.timer = setTimeout(() => { _flushLightingPersist(); }, LIGHTING_PERSIST_DEBOUNCE_MS);
  lightingPersist.timer.unref();
}

module.exports = { _flushLightingPersist, _persistLighting };
