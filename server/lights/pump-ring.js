'use strict';
// The ring of lights around a pump screen, as the pump's settings ask (pump-screen/ring.js
// sets it): the colours of what the screen shows, the theme colour, dark, or nothing of its
// own (the ring then follows Xenon like every other light). The ring is the LEDs the
// lighting map draws as a pump (lighting-topology.js, kind 'pump'). With `all`, every other
// light takes the screen's colour too. Kept in memory only.

const fx = require('./lighting-effects.js');
const audioLevels = require('../audio/audio-levels.js');

const FOLLOWS = Object.freeze(['screen', 'theme', 'off']);
const MAX_COLOURS = 3;
const DARK = Object.freeze({ r: 0, g: 0, b: 0 });
// The look a ring LED gets in a device's per-LED frame (lighting-led-colors.js ledFrame).
const RING_LED = Object.freeze({ style: 'pump' });
// With `pulse` the ring breathes with the sound the PC plays: the loudest app's peak
// (audio/audio-levels.js, Windows), up at once and down slowly, never under the floor so
// its colours stay seen. With no reading at all it stays steady.
const PULSE_FLOOR = 0.4;
const PULSE_HALF_MS = 180;   // the time the level takes to fall by half
const PULSE_SILENT_MS = 2000;   // silent this long (a song ended): the ring is steady again

let ring = null;   // { follow, all, pulse, colours: [{r,g,b}] }
let pulse = { level: 0, at: 0, heard: 0 };

// The pulse holds only where this PC can read the sound: asked once here, on a change, so a
// pulse set by Bit or a backup on a PC with no reader never keeps the lights' ticker going.
function clean(state) {
  if (!state || typeof state !== 'object' || !FOLLOWS.includes(state.follow)) return null;
  const list = Array.isArray(state.colours) ? state.colours.slice(0, MAX_COLOURS) : [];
  const colours = list.map((c) => fx.parseColorName(c)).filter(Boolean);
  const pulse = state.pulse === true && state.follow !== 'off' && audioLevels.available();
  return { follow: state.follow, all: state.all === true && state.follow === 'screen', pulse, colours };
}

// state: { follow, all, pulse, colours: ['#rrggbb'] }, or null when the ring follows Xenon.
// Returns whether anything changed.
function set(state) {
  const next = clean(state);
  const changed = JSON.stringify(next) !== JSON.stringify(ring);
  ring = next;
  return changed;
}

// The ring's own colours, or null when it shows nothing of its own.
function ownColours(accent) {
  if (!ring) return null;
  if (ring.follow === 'off') return [DARK];
  if (ring.follow === 'theme') return accent ? [accent] : null;
  return ring.colours.length ? ring.colours : null;
}

// How loud the PC is now, 0..1, or null when the ring should stay steady: no reader, or
// nothing heard for a while. A short gap sinks it to the floor. Read by time, so every
// call of one frame gets about the same value.
function soundLevel(now = Date.now(), peaks = audioLevels.latest(), running = audioLevels.isRunning()) {
  const values = Object.values(peaks || {}).filter((v) => Number.isFinite(v));
  if (values.length) pulse.heard = now;
  else if (!running || now - pulse.heard > PULSE_SILENT_MS) return null;
  const peak = values.length ? Math.min(1, Math.max(0, ...values)) : 0;
  const fallen = pulse.level * 0.5 ** (Math.max(0, now - pulse.at) / PULSE_HALF_MS);
  pulse = { level: Math.max(peak, fallen), at: now, heard: pulse.heard };
  return pulse.level;
}

// The ring's colours now, brightness not applied, or null when it shows nothing of its own
// (following Xenon, or the screen has not said its colours yet). With pulse, dimmed by the sound.
function colours(accent) {
  const own = ownColours(accent);
  const level = own && ring.pulse ? soundLevel() : null;
  if (level == null) return own;
  const scale = PULSE_FLOOR + (1 - PULSE_FLOOR) * Math.sqrt(level);
  return own.map((c) => fx.applyBrightness(c, scale));
}

// Whether the ring moves with the sound: the lights' ticker runs for it (lights/upkeep.js),
// and the sound is read for it (audio/levels-wanted.js).
const pulsing = () => !!ring?.pulse;

// The colour every other light takes when the screen leads them all, or null.
const leadColour = () => (ring?.all && ring.colours.length ? ring.colours[0] : null);

// The ring LEDs of a device, each set to the ring's look, or null when it has none. Only an
// iCUE device has one: a controller Xenon drives itself never reports a pump.
function ledsOf(dev) {
  const out = {};
  if (!dev || dev.source === 'native') return null;
  for (const seg of Array.isArray(dev.segments) ? dev.segments : []) {
    if (seg.kind !== 'pump' || !Array.isArray(seg.ledIds)) continue;
    for (const luid of seg.ledIds) out[luid] = RING_LED;
  }
  return Object.keys(out).length ? out : null;
}

module.exports = { set, colours, leadColour, ledsOf, pulsing, soundLevel, RING_LED, PULSE_FLOOR };
