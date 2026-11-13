'use strict';
// GET /api/sensor-service: whether the elevated sensor service is running and
// whether its scripts are older than this engine's, so Settings can offer the
// one prompt that brings it level; and, where PresentMon is installed, whether
// Windows lets it read frame rates (fps-access.js). Reads only; it starts nothing.

const { instance } = require('./reader.js');
const fpsAccess = require('./fps-access.js');
const fpsMonitor = require('../fps-monitor.js');

async function fpsAccessState() {
  try { return fpsMonitor.backend === 'presentmon' && fpsMonitor.isAvailable() ? await fpsAccess.instance().refresh() : null; }
  catch { return null; }
}

async function readState(req, res, { json }) {
  try { json({ ok: true, service: await instance().state(), fpsAccess: await fpsAccessState() }); }
  catch { json({ ok: false, service: null, fpsAccess: null }); }
}

module.exports = { routes: { 'GET /api/sensor-service': readState }, readState };
