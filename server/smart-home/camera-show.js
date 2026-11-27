'use strict';
// The Deck key "Show camera" (js/capabilities/catalog-home.js `homeCamera`): one camera, found
// the way Bit finds one (a name or part of it; empty = where someone last rang, else the first), live
// over every open dashboard for two minutes (SSE `home_camera`, js/alerts/door-card.js `view`).
// Only one of the two loopback proxy paths travels, never a URL.

const { broadcastSSE } = require('../http/sse-clients.js');
const { settingsReader } = require('../settings/read-cache.js');
const { cameraList, findCamera, picOf } = require('./camera-look.js');

/**
 * @param {{ camera?: string }} action
 * @param {{ engines?: { deckHa: any, deckUnifi: any }, settings?: () => Promise<any>, send?: (type: string, data: any) => void }} [deps]
 */
async function run(action, deps = {}) {
  const engines = deps.engines || require('./deck-clients.js');
  const s = (await (deps.settings || (() => settingsReader.read()))().catch(() => null)) || {};
  const list = await cameraList(engines, s);
  if (!list.length) return { ok: false, error: 'no_cameras' };
  const cam = findCamera(list, String(action?.camera || ''), Date.now()) || (action?.camera ? null : list[0]);
  if (!cam) return { ok: false, error: 'no_camera' };
  (deps.send || broadcastSSE)('home_camera', { name: String(cam.name || '').slice(0, 80), pic: picOf(cam.id) });
  return { ok: true, shown: cam.name };
}

module.exports = { run };
