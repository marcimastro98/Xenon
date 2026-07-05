'use strict';
// Home Assistant provider — drives HA `light.*` entities through the dashboard's
// EXISTING Home Assistant client (the Smart Home integration). No socket, token
// or URL of its own: server.js injects runtime hooks (`setRuntime`) backed by the
// shared HA singleton, so the HA token never enters the lighting provider config
// and the existing redact/preserve machinery is untouched. A "device" here is one
// rgb-capable light entity; its `host` is the entity_id (e.g. `light.desk_lamp`).

const fx = require('../lighting-effects');

const meta = {
  id: 'homeassistant',
  name: 'Home Assistant',
  type: 'runtime',        // no LAN probing — devices come from the HA entity list
  maxHz: 5,               // service calls fan out to real bulbs; keep the rate gentle
  needsPairing: false,
  download: 'https://www.home-assistant.io/',
};

// Injected by server.js at startup: { callService(domain, service, target, data),
// listLights() → compact light entities }. Absent (HA not wired) → every call
// degrades to a silent no-op / empty list.
let runtime = null;
function setRuntime(hooks) { runtime = hooks && typeof hooks === 'object' ? hooks : null; }

const ENTITY_RE = /^light\.[a-z0-9_]+$/;

// Colour-capable? HA lists the light's supported color modes; anything that can
// take an rgb_color (directly or via hs/xy conversion) qualifies.
const RGB_MODES = ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'];
function isRgbLight(entity) {
  if (!entity || entity.domain !== 'light') return false;
  const modes = Array.isArray(entity.colorModes) ? entity.colorModes : [];
  return modes.some(m => RGB_MODES.includes(String(m).toLowerCase()));
}

// Build the light.turn_on payload. Brightness arrives baked into the colour, but
// HA normalizes rgb_color to full brightness — fx.splitVivid separates them
// (full-vivid rgb + brightness 0-255). Pure — unit-tested.
function buildTurnOnData(color) {
  const s = fx.splitVivid(color);
  if (!s) return null;   // black → the caller turns the light off instead
  return { rgb_color: [s.vivid.r, s.vivid.g, s.vivid.b], brightness: s.level };
}

function entityDescriptor(e) {
  return {
    id: 'homeassistant:' + e.id,
    host: e.id,                    // entity_id doubles as the "address"
    name: e.name || e.id,
    model: 'Home Assistant',
    ledCount: 0,
  };
}

// Discovery = ask HA for its rgb-capable lights (runs inside the user-initiated
// scan, never in the background; returns [] when HA isn't configured).
async function discover() {
  if (!runtime || typeof runtime.listLights !== 'function') return [];
  const lights = await runtime.listLights().catch(() => []);
  return (Array.isArray(lights) ? lights : []).filter(isRgbLight).map(entityDescriptor);
}

// Manual add: validate the entity_id shape, then confirm HA actually has it.
async function probe(host) {
  const id = String(host || '').trim().toLowerCase();
  if (!ENTITY_RE.test(id)) return null;
  const found = await discover();
  return found.find(d => d.host === id) || null;
}

async function write(device, color) {
  if (!runtime || typeof runtime.callService !== 'function') return;
  const entity = String(device && device.host || '');
  if (!ENTITY_RE.test(entity)) return;
  const data = buildTurnOnData(color);
  if (!data) { await runtime.callService('light', 'turn_off', { entity_id: entity }, {}); return; }
  await runtime.callService('light', 'turn_on', { entity_id: entity }, data);
}

async function release(device) {
  if (!runtime || typeof runtime.callService !== 'function') return;
  const entity = String(device && device.host || '');
  if (!ENTITY_RE.test(entity)) return;
  await runtime.callService('light', 'turn_off', { entity_id: entity }, {});
}

module.exports = {
  meta, setRuntime, discover, probe, write, release,
  // Pure helpers exported for the unit tests only.
  _isRgbLight: isRgbLight,
  _buildTurnOnData: buildTurnOnData,
};
