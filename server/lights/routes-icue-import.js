'use strict';
// Import from iCUE: the look each light had in iCUE, onto the lights Xenon drives itself that
// still follow Xenon (icue-import.js). A route of its own beside the tables that left server.js
// (routes.js, routes-control.js), which keep the bodies the move recorded.

const lighting = require('./lighting.js');
const { icueImport } = require('./icue-import.js');

/** The profile is read again now; what is taken is applied and saved. No body: nothing to trust. */
async function importLooks(_req, _res, { json, err500 }, { _persistLighting }) {
  try {
    await icueImport.refresh(true);
    const taken = icueImport.offer(lighting.getStatus().devices || []);
    for (const t of taken) lighting.setDeviceMode(t.id, t.look);
    if (taken.length) await _persistLighting();
    json({ ok: taken.length > 0, taken: taken.map((t) => t.name), status: lighting.getStatus() });
  } catch (e) { err500(e.message); }
}

module.exports = {
  routes: { 'POST /api/lighting/icue-import': importLooks },
};
