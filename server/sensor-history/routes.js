'use strict';
// GET /api/energy: the SDK `energy` stream, pulled by js/custom-widget.js
// while a widget that holds the grant is on screen. Watt-hours per hour and
// per day from the sensor history (sensor-history/energy.js), the last
// reading's watts and whether the history is on. It answers only while some
// package holds the grant, like devStorage: the dashboard's own views read the
// history through /api/guardian/history. Numbers only.

async function readEnergy(req, res, { json, sdkStreamGranted, history }) {
  if (!sdkStreamGranted('energy')) { json({ ok: false, error: 'not_granted' }); return; }
  if (!history || typeof history.getEnergy !== 'function') { json({ ok: false, error: 'unavailable' }); return; }
  try { json({ ok: true, ...(await history.getEnergy()) }); }
  catch { json({ ok: false, error: 'failed' }); }
}

module.exports = { routes: { 'GET /api/energy': readEnergy }, readEnergy };
