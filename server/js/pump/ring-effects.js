'use strict';

// How the ring of lights around a pump screen moves: the light effects every light in Xenon
// has (js/light-fx/light-fx.js), drawn on a closed ring. Read by the lights (lights/pump-ring.js
// paints the LEDs iCUE or the LINK hub report as a pump), the pump's model, faces and menu, so
// what the menu shows is what the pump does. In a page, js/light-fx/ loads before this file.
//
// frame(effect, opts) is LightFx.frame on a ring: count, colours, now, speed, reverse, size,
// glow, phase, inputs and state as there; level and sound may also come at the top of opts.
((root, factory) => {
  const Fx = typeof module !== 'undefined' && module.exports ? require('../light-fx/light-fx.js') : root.LightFx;
  const api = factory(Fx);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PumpRingEffects = api;
})(typeof window !== 'undefined' ? window : globalThis, (Fx) => {
  // The three speeds the pump saved before the slider; still read, as places on it (Fx.SPEED_OF).
  const SPEEDS = Object.freeze(Object.keys(Fx.SPEED_OF));
  const frame = (effect, opts = {}) => Fx.frame(effect, { ...opts, shape: 'ring' });

  return Object.freeze({
    LIST: Fx.LIST, EFFECTS: Fx.EFFECTS, GROUPS: Fx.GROUPS, SPEEDS, PALETTE_IDS: Fx.PALETTE_IDS, PALETTES: Fx.PALETTES,
    isEffect: Fx.isEffect, about: Fx.about, moves: Fx.moves, speedOf: Fx.speedOf, frame,
  });
});
