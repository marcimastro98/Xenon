'use strict';
// What a Deck key (or the AI) asked the lights to show: a colour, an effect, one
// part of a device in its own colour. It wins over the music and temperature
// colours, which would otherwise hide it, and lasts until the lights are switched
// off from a key. Kept in memory only: the parts a key colours are a moment's
// look, not the map the user builds in the Lighting page (that one is saved).
// "Lights off" from a key is a look too: every light dark, over everything else,
// until the lights are switched back on, or a key sets a colour or an effect.

let held = false;
let out = false;
const parts = new Map();   // deviceId -> { [luid]: colour value }

// A colour or an effect for the whole rig: parts coloured by an earlier key go.
function hold({ wholeRig = false } = {}) {
  held = true;
  out = false;
  if (wholeRig) parts.clear();
}

// value: a normalized LED value, or null to give those LEDs back.
function setPart(deviceId, ledIds, value) {
  const leds = { ...(parts.get(deviceId) || {}) };
  for (const luid of ledIds) {
    if (value === null) delete leds[luid];
    else leds[luid] = value;
  }
  if (Object.keys(leds).length) parts.set(deviceId, leds);
  else parts.delete(deviceId);
  held = true;
  out = false;
}

function release() {
  const was = held || out || parts.size > 0;
  held = false;
  out = false;
  parts.clear();
  return was;
}

// Every light dark (true) or back to what it showed (false). Returns whether it changed.
function setOut(on) {
  const was = out;
  out = !!on;
  return was !== out;
}

const isHeld = () => held;
const isOut = () => out;
const partsOf = (deviceId) => parts.get(deviceId) || null;

module.exports = { hold, setPart, release, setOut, isHeld, isOut, partsOf };
