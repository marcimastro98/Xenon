// Choosing which sensor a reading on the dashboard comes from when the assistant is asked to,
// or listing the sensors there are.

const { broadcastSSE } = require('../http/sse-clients.js');
const SensorSources = require('../js/sensor-sources.js');
const SensorSourceAi = require('../ai/sensor-source-ai.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { readHubSettingsForUpdate } = require('../settings/read.js');
const { hub } = require('../settings/current.js');
const { collectSensors } = require('./sensors-read.js');
const { writeHubSettings } = require('../settings/write.js');
const { withHubSettingsLock } = require('../settings/write-lock.js');

// sensor_source: the catalog is read only when a list or a choice needs it.
async function chooseSensorSource(args) {
  const current = () => SensorSources.normalizeSensorSources(hub.settings && hub.settings.sensorSources);
  const needsCatalog = args && args.metric && !/^(auto|automatic)$/i.test(String(args.sensor || '').trim());
  const cat = needsCatalog ? await collectSensors(null) : null;
  if (cat && !cat.known) return { ok: false, error: 'sensors_not_ready', hint: 'The sensor reader is still starting: try again in a minute.' };
  const plan = SensorSourceAi.plan(args, cat && cat.sensors);
  if (plan.error) return { ok: false, ...plan };
  if (plan.read) return { ok: true, sources: current(), metrics: SensorSourceAi.METRICS };
  if (plan.list) return { ok: true, metric: plan.list, chosen: current()[plan.list] || 'auto', sensors: SensorSourceAi.candidates(plan.list, cat.sensors) };
  await withHubSettingsLock(async () => {
    const cur = await readHubSettingsForUpdate();
    const written = await writeHubSettings({ ...cur, sensorSources: SensorSourceAi.nextSources(cur.sensorSources, plan), rev: nextSettingsRev(cur.rev) });
    hub.settings = written;
    broadcastSSE('settings', { rev: written.rev });
  });
  return { ok: true, metric: plan.metric, now: current()[plan.metric] || 'auto' };
}

module.exports = { chooseSensorSource };
