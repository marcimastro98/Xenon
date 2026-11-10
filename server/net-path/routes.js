'use strict';
// GET /api/net-path: the SDK `netPath` stream, pulled by js/custom-widget.js
// while a widget that holds the grant is on screen. A read with a cost: the
// first one starts echoes that run until IDLE_MS after the last, so it answers
// only while some package holds the grant, like devStorage. Numbers only: an
// error is a fixed word, never a message that could carry an address.

const netPath = require('./index.js');

function createRead(reader) {
  return async function read(req, res, { json, sdkStreamGranted }) {
    if (!sdkStreamGranted('netPath')) { json({ ok: false, error: 'not_granted' }); return; }
    try { json(await reader.read()); }
    catch { json({ ok: false, error: 'failed' }); }
  };
}

module.exports = { routes: { 'GET /api/net-path': createRead(netPath) }, stop: netPath.stop, createRead };
