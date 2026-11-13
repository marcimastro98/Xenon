// What the engine answers about the PC: the system and network readings, the batteries of its
// devices and the history of its hardware health.

const { sensorCache } = require('./sensor-cache.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /system': async (_req, _res, { json, err500 }, { getSystemInfo }) => {
    try   { json(await getSystemInfo({ partialOk: true })); }
    catch (e) { err500(e.message); }
  },

  'GET /api/battery': async (_req, _res, { json, err500 }, { batteryMonitor }) => {
    // Read-only seed for the battery widget / deck editor (SSE 'battery'
    // pushes updates afterwards). Never a JSONP candidate.
    try   { json(await batteryMonitor.getDevices()); }
    catch (e) { err500(e.message); }
  },

  'GET /network': async (_req, _res, { json, err500 }, { getNetworkInfo }) => {
    try   { json(await getNetworkInfo()); }
    catch (e) { err500(e.message); }
  },

  'GET /api/guardian/history': async (_req, _res, { json }, { guardian }) => {
    // Guardian hardware-health history for the dashboard charts (same local data
    // the AI digest summarises). Read-only; harmless when Guardian is disabled —
    // it just returns whatever buckets were collected while it was last on.
    try { json(await guardian.getHistory()); }
    catch (e) { json({ enabled: false, hours: [], days: [], error: e.message }); }
  },

  'GET /system/sensors': async (_req, _res, { json }, { collectSensors }) => {
    // The whole catalog with live values, for the Sensor sources picker. Read
    // only while the picker is open (it polls this); nothing runs otherwise.
    try {
      const r = await collectSensors(null);
      json({ ok: r.known || r.sensors.length > 0, platform: process.platform, sensorAccess: sensorCache.reading.sensorAccess, auto: { cpuTemp: sensorCache.reading.cpuTempSource }, sensors: r.sensors });
    } catch {
      json({ ok: false, platform: process.platform, sensorAccess: sensorCache.reading.sensorAccess, sensors: [] });
    }
  },
};

module.exports = { branches };
