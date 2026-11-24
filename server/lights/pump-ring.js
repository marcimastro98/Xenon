'use strict';
// The ring of lights around a pump screen, as the pump's settings ask (pump-screen/ring.js
// sets it): the colours of what the screen shows, the theme colour, two colours of the person's,
// dark, or nothing of its own (the ring then follows Xenon like every other light). The ring is the LEDs the
// lighting map draws as a pump (lighting-topology.js, kind 'pump'). With `all`, every other
// light takes the ring's colour too. `effect` is how the line on show moves it, drawn LED by LED
// by js/pump/ring-effects.js (the same maths the menu draws its rings with): `level` is how far
// the line is (0..1: its reading, the song's time) for the effects that follow it, `speed` and
// `reverse` how fast and which way round, `size` and `glow` the effect's amount and how lit its
// dark part stays (null: as made). What the PC's own effects follow (load, fans, sky, weather, a
// timer) is read for each frame by pc-inputs.js. Kept in memory only.

const fx = require('./lighting-effects.js');
const audioLevels = require('../audio/audio-levels.js');
const RingFx = require('../js/pump/ring-effects.js');
const held = require('../lighting-native/held.js');
const PcInputs = require('./pc-inputs.js');
const { ringSizes } = require('../js/light-fx/light-fx-device.js');

const FOLLOWS = Object.freeze(['screen', 'theme', 'own', 'off']);
const EFFECTS = RingFx.EFFECTS;
const MAX_COLOURS = 3;
const DARK = Object.freeze({ r: 0, g: 0, b: 0 });
// The look a ring LED gets in a device's per-LED frame (lighting-led-colors.js ledFrame); the
// LEDs of a second ring on the same device carry its number (ringLed).
const RING_LED = Object.freeze({ style: 'pump' });
// With the sound ('beat', 'meter') the ring follows what the PC plays: the loudest app's peak
// (audio/audio-levels.js, Windows), up at once and down slowly. With no reading at all the beat
// stays steady and the meter empty.
const PULSE_HALF_MS = 180;   // the time the level takes to fall by half
const PULSE_SILENT_MS = 2000;   // silent this long (a song ended): the ring is steady again

let ring = null;   // { follow, all, effect, colours: [{r,g,b}], level, speed, reverse, size, glow }
// What the effects that turn smoothly remember between frames, one per ring size (two rings of
// one size turn alike); forgotten on every change.
let memory = new Map();
let pulse = { level: 0, at: 0, heard: 0 };

// What follows the sound holds only where this PC can read it: asked once here, on a change, so
// a beat set by Bit or a backup on a PC with no reader never keeps the lights' ticker going.
// A dark ring never moves.
function effectOf(state) {
  const want = RingFx.isEffect(state.effect) ? state.effect : 'still';
  if (state.follow === 'off' || (RingFx.about(want).needs === 'sound' && !audioLevels.available())) return 'still';
  return want;
}

const share = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);

function clean(state) {
  if (!state || typeof state !== 'object' || !FOLLOWS.includes(state.follow)) return null;
  const list = Array.isArray(state.colours) ? state.colours.slice(0, MAX_COLOURS) : [];
  const colours = list.map((c) => fx.parseColorName(c)).filter(Boolean);
  const effect = effectOf(state);
  // With no level said yet (the page has not measured the line), the ring stays lit whole.
  const level = RingFx.about(effect).needs === 'level' && Number.isFinite(state.level) ? Math.max(0, Math.min(1, state.level)) : null;
  const speed = RingFx.SPEEDS.includes(state.speed) || Number.isInteger(state.speed) ? state.speed : 'normal';
  return {
    follow: state.follow, all: state.all === true && (state.follow === 'screen' || state.follow === 'own'), effect, colours, level, speed,
    reverse: state.reverse === true, size: share(state.size), glow: share(state.glow),
  };
}

// state: { follow, all, effect, colours: ['#rrggbb'], level, speed, reverse, size, glow }, or null when the ring follows Xenon.
// Returns whether anything changed.
function set(state) {
  const next = clean(state);
  const changed = JSON.stringify(next) !== JSON.stringify(ring);
  ring = next;
  if (changed) memory = new Map();
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

// The ring's colours, brightness not applied, or null when it shows nothing of its own
// (following Xenon, or the screen has not said its colours yet).
const colours = (accent) => ownColours(accent);

// Each of `count` ring LEDs now, in order round the ring, or null as colours().
function frame(accent, count, now = Date.now()) {
  const own = ownColours(accent);
  if (!own) return null;
  const need = RingFx.about(ring.effect).needs;
  const sound = need === 'sound' ? soundLevel(now) : null;
  if (!memory.has(count)) memory.set(count, {});
  return RingFx.frame(ring.effect, {
    count, colours: own, now, level: ring.level, sound, inputs: PcInputs.inputs(need, now), speed: ring.speed, reverse: ring.reverse,
    size: ring.size ?? undefined, glow: ring.glow ?? undefined, state: memory.get(count),
  });
}

// Whether the ring moves with the sound: the sound is read for it (audio/levels-wanted.js).
const pulsing = () => !!ring && RingFx.about(ring.effect).needs === 'sound';
// Whether the ring moves at all: the lights' ticker runs for it (lights/upkeep.js). Lit up to the
// level it changes only when the page says a new one (set), which paints it then.
const moving = () => !!ring && RingFx.moves(ring.effect);

// The colour every other light takes when the screen leads them all, or null.
const leadColour = () => (ring?.all && ring.colours.length ? ring.colours[0] : null);

// Who decides the ring now, as Settings → Lighting says it (lights/status.js): `owns` while the
// pump screen holds it (lit, dark or waiting for its colours), `all` while it leads every light.
const state = () => ({ owns: !!ring, all: !!ring?.all, follow: ring ? ring.follow : 'lights' });

// The ring LEDs of a device, each set to the ring's look, or null when it has none: an iCUE
// device, or a LINK hub another part of Xenon holds (lighting-native/held.js, Airflow), which
// lists the pump's LEDs in iCUE's order. A board Xenon drives itself may name a header "pump",
// but that is no screen's ring.
function ledsOf(dev) {
  const out = {};
  if (!dev || (dev.source === 'native' && !held.owns(dev.id))) return null;
  let ring = 0;
  for (const seg of Array.isArray(dev.segments) ? dev.segments : []) {
    if (seg.kind !== 'pump' || !Array.isArray(seg.ledIds)) continue;
    for (const size of ringSizes(seg)) {
      for (const luid of seg.ledIds.slice(size.from, size.from + size.n)) out[luid] = ringLed(ring);
      ring++;
    }
  }
  return Object.keys(out).length ? out : null;
}

const RING_LEDS = [RING_LED];
function ringLed(k) {
  if (!RING_LEDS[k]) RING_LEDS[k] = Object.freeze({ style: 'pump', ring: k });
  return RING_LEDS[k];
}

module.exports = { set, colours, frame, leadColour, state, ledsOf, ringSizes, pulsing, moving, soundLevel, EFFECTS, RING_LED };
