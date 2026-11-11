'use strict';
// GET /api/sensor-service: whether the elevated sensor service is running and
// whether its scripts are older than this engine's, so Settings can offer the
// one prompt that brings it level. A read of two booleans; it starts nothing.

const { instance } = require('./reader.js');

async function readState(req, res, { json }) {
  try { json({ ok: true, service: await instance().state() }); }
  catch { json({ ok: false, service: null }); }
}

module.exports = { routes: { 'GET /api/sensor-service': readState }, readState };
