'use strict';
// Guided setup: light part of one output so the user can see where a fan ends.
// done = LED counts of the parts already marked, lit = LEDs of the part being
// measured; whole = light the entire output (is anything plugged in?).

const PREVIEW_CURRENT = { r: 255, g: 255, b: 255 };
const PREVIEW_DONE = [{ r: 30, g: 90, b: 255 }, { r: 255, g: 110, b: 20 }];
const OFF = { r: 0, g: 0, b: 0 };
const MAX_LEDS = 256;

/** @param {{ done?: number[], lit?: number, whole?: boolean }} o */
function previewFrame({ done = [], lit = 0, whole = false }) {
  if (whole) return new Array(MAX_LEDS).fill(PREVIEW_CURRENT);
  const frame = [];
  done.forEach((count, k) => { for (let i = 0; i < count && frame.length < MAX_LEDS; i++) frame.push(PREVIEW_DONE[k % 2]); });
  for (let i = 0; i < lit && frame.length < MAX_LEDS; i++) frame.push(PREVIEW_CURRENT);
  while (frame.length < MAX_LEDS) frame.push(OFF);
  return frame;
}

module.exports = { previewFrame };
