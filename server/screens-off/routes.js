'use strict';
// POST /screens-off {off}: the kiosk page saying the PC's screens went off or came
// back (state.js says why the sensor reads wait). Closed to paired devices
// (refused-paths.js): a phone has no say on the PC's screens. In CSRF_MUTATION_PATHS.

const { setScreensOff } = require('./state.js');

const MAX_BODY_BYTES = 256;

async function report(req, _res, { json, readBody }) {
  let off;
  try { off = JSON.parse(await readBody(req, MAX_BODY_BYTES)).off; } catch { /* answered below */ }
  if (typeof off !== 'boolean') { json({ ok: false, error: 'bad_request' }); return; }
  setScreensOff(off);
  json({ ok: true });
}

module.exports = { routes: { 'POST /screens-off': report } };
