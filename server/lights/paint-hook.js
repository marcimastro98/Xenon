'use strict';
// How the steps that keep the iCUE session up (connect, list the devices, tick an animation) ask
// for a repaint without requiring the code that paints, which requires them. server/lights/paint.js puts
// its apply() here when the engine loads it.

/** @type {{ apply: () => (Promise<void> | void) }} */
const paint = {
  // Loud on purpose: a repaint asked before anyone said how to paint is a wiring fault, not a no-op.
  apply() { throw new Error('lights: a repaint was asked before lighting.js said how to paint'); },
};

module.exports = { paint };
