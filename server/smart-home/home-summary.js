'use strict';
// "How is the house?" for Bit, from the Home Assistant entities it already reads: the
// temperatures, what is open, what is unlocked and the lights left on. Read only: nothing here
// changes anything, and a lock or a door is only ever reported, never driven (tools.js).

const MAX_TEMPS = 6;
const MAX_OPEN = 8;
const MAX_LIGHTS = 12;
const OPENINGS = new Set(['door', 'window', 'garage_door', 'opening']);
const COVERS_THAT_OPEN = new Set(['door', 'garage', 'gate', 'window']);

const numberOf = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const minutesSince = (changed, now) => (Number.isFinite(changed) ? Math.max(0, Math.round((now - changed) / 60000)) : null);
const place = (e) => ({ name: String(e.name || e.id).slice(0, 80), area: e.area ? String(e.area).slice(0, 60) : null });

function temperatures(list) {
  const out = [];
  for (const e of list) {
    if (out.length >= MAX_TEMPS) break;
    if (e.domain === 'climate' && numberOf(e.current) !== null) {
      out.push({ ...place(e), value: numberOf(e.current), target: numberOf(e.target) });
    } else if (e.domain === 'sensor' && e.deviceClass === 'temperature' && numberOf(e.state) !== null) {
      out.push({ ...place(e), value: numberOf(e.state), unit: e.unit || undefined });
    }
  }
  return out;
}

function isOpen(e) {
  if (e.domain === 'binary_sensor') return OPENINGS.has(e.deviceClass) && e.state === 'on';
  if (e.domain === 'cover') return COVERS_THAT_OPEN.has(e.deviceClass) && (e.state === 'open' || e.state === 'opening');
  return false;
}

/**
 * @param {any[]} entities HA's compact entities (home-assistant-entity.js).
 * @param {number} now epoch ms
 */
function summarize(entities, now) {
  const list = Array.isArray(entities) ? entities.filter((e) => e && typeof e.id === 'string' && typeof e.domain === 'string') : [];
  const open = list.filter(isOpen).slice(0, MAX_OPEN).map((e) => ({ ...place(e), minutes: minutesSince(e.changed, now) }));
  const unlocked = list.filter((e) => e.domain === 'lock' && (e.state === 'unlocked' || e.state === 'open')).slice(0, MAX_OPEN).map(place);
  const lights = list.filter((e) => e.domain === 'light' && e.state === 'on');
  return {
    temperatures: temperatures(list),
    open,
    unlocked,
    lightsOn: lights.length,
    lights: lights.slice(0, MAX_LIGHTS).map((e) => ({ id: e.id, ...place(e) })),
    unavailable: list.filter((e) => e.state === 'unavailable').length,
  };
}

module.exports = { summarize, MAX_LIGHTS };
