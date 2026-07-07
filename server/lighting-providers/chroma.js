'use strict';
// Razer Chroma provider — drives ALL the user's Razer devices through the SHARED
// local Chroma SDK client (the same session the direct Deck/SDK actions use). No
// host/IP of its own: Chroma is a single logical target, so it exposes ONE
// synthetic device. server.js injects runtime hooks (setRuntime) backed by the
// deckChroma singleton and gated on the chroma.enabled opt-in — absent/disabled →
// every call degrades to a silent no-op. Chroma has no separate brightness
// channel, so the resolver's baked-in colour is used directly (black arrives as
// {0,0,0}, which the client renders as CHROMA_STATIC black ≈ off).

const meta = {
  id: 'chroma',
  name: 'Razer Chroma',
  type: 'runtime',        // no LAN probing — one local SDK session, not a network device
  maxHz: 10,              // REST PUTs to a local server; keep the fan-out rate modest
  needsPairing: false,
  download: 'https://www.razer.com/synapse-4',
};

// Injected by server.js: { applyColor({r,g,b})->Promise, release()->Promise,
// available()->bool }. Absent (Chroma not wired) → no-op / offline.
let runtime = null;
function setRuntime(hooks) { runtime = hooks && typeof hooks === 'object' ? hooks : null; }

// The single synthetic device standing in for every Razer Chroma device at once.
const DEVICE = Object.freeze({ id: 'chroma:all', host: 'all', name: 'Razer Chroma', model: 'Razer Chroma', ledCount: 0 });

// Discovery = offer the one Chroma target when the integration is wired (runs
// inside the user-initiated scan, never in the background). write() no-ops until
// Chroma is actually reachable, so offering it before Synapse is up is harmless.
async function discover() {
  if (!runtime || typeof runtime.applyColor !== 'function') return [];
  return [{ ...DEVICE }];
}

// Manual add: only the single synthetic host is valid.
async function probe(host) {
  const h = String(host || '').trim().toLowerCase();
  return (h === 'all' || h === 'chroma:all') ? { ...DEVICE } : null;
}

async function write(device, color) {
  if (!runtime || typeof runtime.applyColor !== 'function') return;
  if (!color || typeof color !== 'object') return;
  await runtime.applyColor({ r: color.r | 0, g: color.g | 0, b: color.b | 0 });
}

async function release(device) {
  if (!runtime || typeof runtime.release !== 'function') return;
  await runtime.release();
}

module.exports = { meta, setRuntime, discover, probe, write, release };
