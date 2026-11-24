'use strict';
// Who drives each light on this PC now, in one list: Xenon itself over USB, Xenon through another
// program (iCUE, Razer Chroma, OpenRGB, Home Assistant), Xenon over the network, the pump screen,
// or nobody, with the one thing to do when nobody does. The Lighting page shows it on top of
// Devices, so a light that never flashes says why instead of staying quiet. Pure: status.js
// hands it what the lights already know.

// Providers Xenon reaches through a program running on the PC rather than the lights themselves.
const THROUGH_APP = new Set(['chroma', 'openrgb', 'homeassistant']);
// Programs that paint the motherboard themselves (lighting-native/board-apps.js), by process name.
const BOARD_APP_NAMES = Object.freeze({
  icue: 'iCUE', gcc: 'GIGABYTE Control Center', openrgb: 'OpenRGB', signalrgb: 'SignalRGB',
});

/**
 * @param {{
 *   devices?: Array<{ id: string, model?: string, source?: string, maker?: string }>,
 *   connected?: boolean, available?: boolean, wanted?: boolean, icueHere?: boolean, reason?: string|null,
 *   native?: { enabled?: boolean, idleBoards?: number, yieldedTo?: string[], controllers?: Array<{ id: string }> },
 *   providers?: Array<{ id: string, name: string, needsPairing?: boolean, reason?: string|null,
 *     devices?: Array<{ id: string, name?: string, host?: string, optedIn?: boolean, paired?: boolean }> }>,
 *   pumpRing?: { owns?: boolean },
 * }} s
 */
function driversOf(s) {
  const rows = [];
  const devices = Array.isArray(s.devices) ? s.devices : [];
  const other = boardAppsOf(s.native);
  const boards = new Set((s.native?.controllers || []).map((c) => c.id));
  for (const d of devices.filter((x) => x.source === 'native')) {
    const row = { id: d.id, name: d.model || d.id, brand: d.maker || '', who: 'xenon' };
    // Only the boards wait; lights another part of Xenon holds (the LINK hub) go on.
    rows.push(other && boards.has(d.id) ? { ...row, who: 'other', through: other, reasonKey: 'lighting_board_other' } : row);
  }
  rows.push(...corsairRows(s, devices.filter((x) => x.source !== 'native').length));
  const n = s.native || {};
  if (!n.enabled && !s.connected && n.idleBoards > 0) {
    rows.push({ id: 'board', nameKey: 'lighting_native_title', who: 'nobody', reasonKey: 'lighting_board_idle', fix: 'board' });
  }
  for (const p of Array.isArray(s.providers) ? s.providers : []) {
    const live = (p.devices || []).filter((d) => d.optedIn !== false && !(p.needsPairing && !d.paired));
    for (const d of live) rows.push(providerRow(p, d));
  }
  if (s.pumpRing?.owns) rows.push({ id: 'pump-ring', nameKey: 'lighting_who_pump_ring', who: 'pump' });
  return rows;
}

// The Corsair lights iCUE carries: one line for all of them, or why none arrive. Only where iCUE
// exists at all, so another system never hears about a component it cannot have.
function corsairRows(s, count) {
  if (s.connected && count > 0) return [{ id: 'icue', name: 'Corsair', count, who: 'via', through: 'iCUE' }];
  if (!s.icueHere || s.connected) return [];
  if (!s.available) return [{ id: 'icue', name: 'Corsair', who: 'nobody', reasonKey: 'lighting_sdk_missing', fix: 'connections' }];
  if (!s.wanted) return [];
  return [{ id: 'icue', name: 'Corsair', who: 'nobody', reasonKey: 'lighting_icue_off_hint', reason: s.reason || '', fix: 'connections' }];
}

function boardAppsOf(n) {
  const list = n && Array.isArray(n.yieldedTo) ? n.yieldedTo : [];
  return list.length ? list.map((a) => BOARD_APP_NAMES[a] || String(a)).join(', ') : '';
}

function providerRow(p, d) {
  const row = { id: p.id + ':' + d.id, name: d.name || d.host || d.id, brand: p.name };
  if (p.reason) return { ...row, who: 'error', reason: String(p.reason), fix: 'connections' };
  return THROUGH_APP.has(p.id) ? { ...row, who: 'via', through: p.name } : { ...row, who: 'network' };
}

module.exports = { driversOf };
