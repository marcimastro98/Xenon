// What the engine answers about the PC: the system and network readings, the batteries of its
// devices and the history of its hardware health.

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
};

module.exports = { branches };
