'use strict';
// Settings -> Lighting drawn with the one effect engine every light shares (js/light-fx/light-fx.js):
// the look of all the lights, of one device, of a group of LEDs. A look is { style, color, speed,
// palette, reverse, size, glow } (all the lights add `chain`). `style` is a LightFx effect or a
// name saved before it (LightFx.OLD_LIGHTING), read for ever as the effect it became.
// A device is drawn part by part in its own shape (js/light-fx/light-fx-device.js, shared with the
// page's map). With `chain` the parts run one after another instead of together.

const LightFx = require('../js/light-fx/light-fx.js');
const audioLevels = require('../audio/audio-levels.js');
const { applyBrightness } = require('./colour-basics.js');
const pumpRing = require('./pump-ring.js');
const PcInputs = require('./pc-inputs.js');
const { partsOf, piecesOf, drawPart, share } = require('../js/light-fx/light-fx-device.js');

const memory = new Map();   // `${device}#${part}` -> what an effect keeps between frames

// The effect and colours of a look, or null when it shows nothing. An effect that follows the
// sound stands still where this PC has no reader.
function effectOf(look) {
  const fx = LightFx.lightingLook(look);
  if (!fx) return null;
  if (LightFx.about(fx.effect).needs === 'sound' && !audioLevels.available()) fx.effect = 'still';
  return fx;
}

// What an effect follows now, read once for a whole frame.
function inputsFor(effect, now) {
  const need = LightFx.about(effect).needs;
  return need === 'sound' ? { sound: pumpRing.soundLevel(now) } : PcInputs.inputs(need, now);
}

/**
 * One frame of a look over `devices`: a function giving a device's colours now, one per
 * dev.ledIds, brightness applied; null when the look shows nothing. With `chain` each part of
 * each device, in the order given, runs that much later than the one before.
 */
function pass(look, devices, now = Date.now(), brightness = 1) {
  const fx = effectOf(look);
  if (!fx) return null;
  const inputs = inputsFor(fx.effect, now);
  const first = new Map();
  let total = 0;
  for (const dev of devices) { first.set(dev.id, total); total += partsOf(dev).length; }
  return (dev) => {
    const out = new Array(dev.ledIds.length).fill(null);
    partsOf(dev).forEach((part, k) => {
      const key = `${dev.id}#${k}`;
      if (!memory.has(key)) memory.set(key, {});
      const phase = look.chain === true && total > 1 ? ((first.get(dev.id) ?? 0) + k) / total : 0;
      const leds = drawPart(fx, look, part, { now, inputs, phase, state: memory.get(key) });
      part.at.forEach((i, j) => { out[i] = applyBrightness(leds[j], brightness); });
    });
    return out;
  };
}

/**
 * A look over some LEDs of a device (indexes into dev.ledIds), their colours in that order: each
 * part they fill whole drawn in its own shape, the rest as one line. Null when it shows nothing.
 */
function drawSome(look, dev, idx, now = Date.now()) {
  const fx = effectOf(look);
  if (!fx) return null;
  const inputs = inputsFor(fx.effect, now);
  const place = new Map(idx.map((i, j) => [i, j]));
  const out = new Array(idx.length).fill(null);
  for (const { part, k } of piecesOf(dev, idx)) {
    const key = `some:${dev ? dev.id : ''}#${k}`;
    if (!memory.has(key)) memory.set(key, {});
    const leds = drawPart(fx, look, part, { now, inputs, state: memory.get(key) });
    part.at.forEach((i, j) => { out[place.get(i)] = leds[j]; });
  }
  return out;
}

/** The look as one colour now (a light with a single colour: a bulb, a device with no LEDs of its own), or null. */
function colourAt(look, now = Date.now()) {
  const fx = effectOf(look);
  if (!fx) return null;
  if (!memory.has('one')) memory.set('one', {});
  return LightFx.frame(fx.effect, {
    shape: 'one', colours: fx.colours, speed: look.speed, reverse: look.reverse === true, size: share(look.size), glow: share(look.glow),
    now, inputs: inputsFor(fx.effect, now), state: memory.get('one'),
  })[0];
}

const moves = (look) => { const fx = effectOf(look); return !!fx && LightFx.moves(fx.effect); };
const hears = (look) => { const fx = LightFx.lightingLook(look); return !!fx && LightFx.about(fx.effect).needs === 'sound'; };

// What the effects that follow the PC cannot read here now: the sound with no reader of it, the fans
// with no speed (pc-inputs.js).
const cannot = (now = Date.now()) => [...(audioLevels.available() ? [] : ['sound']), ...PcInputs.cannot(now)];

module.exports = { pass, drawSome, colourAt, moves, hears, cannot, partsOf };
