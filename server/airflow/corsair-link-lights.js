'use strict';
// Where each light of an iCUE LINK chain sits in the hub's colour frame
// (corsair-link-protocol.js), and the parts the lighting map draws from them. Measured on a
// real chain's USB traffic (23 Nov 2026, iCUE 5, hub firmware 4.1.656): the frame holds every
// device in channel order, each with a fixed number of slots for its type. A chain with a
// device whose slots were never measured gets no layout: its lights stay off rather than
// light the wrong LEDs. Pure.

const { linkDevice } = require('./corsair-link-devices.js');
const { MAX_COLOUR_SLOTS } = require('./corsair-link-protocol.js');

// slots: the device's room in the frame. lit: the slots with a light (the rest stay dark,
// as iCUE leaves them). start: the slot the map's first LED is on, the one iCUE starts the
// ring at, so an effect turns the same way from the same place with or without iCUE.
const SLOTS = new Map([
  [0x0f, { slots: 8, lit: 8, start: 0 }],      // RX RGB fan
  [0x11, { slots: 24, lit: 24, start: 10 }],   // TITAN AIO pump
  [0x06, { slots: 20, lit: 16, start: 11 }],   // LCD screen, on a pump's cap
]);
// A screen's ring belongs to the pump it sits on: one pump part, its own ring first.
const SCREEN = 0x06;
const OFF = Object.freeze({ r: 0, g: 0, b: 0 });

// A map id per LED that a device added to the chain never shifts: its channel, then the LED.
const ledId = (channel, led) => channel * 256 + led;

function partOf(d, at) {
  const t = /** @type {{ slots: number, lit: number, start: number }} */ (SLOTS.get(d.type));
  const ids = [];
  const slots = [];
  for (let k = 0; k < t.lit; k++) {
    const led = (t.start + k) % t.lit;
    ids.push(ledId(d.channel, led));
    slots.push(at + led);
  }
  const kind = d.type === SCREEN ? 'screen' : linkDevice(d.type, d.model).kind;
  return { kind, model: linkDevice(d.type, d.model).name, ids, slots };
}

// The parts the map draws: each fan, each pump with the ring of the screen on it. A pump's
// `rings` are the LEDs of each ring in ledIds order (its own, then the screen's), so an
// effect goes round each ring instead of running over both as one strip.
function segmentsOf(parts) {
  const out = parts.filter((p) => p.kind !== 'screen').map((p) => ({ kind: p.kind === 'pump' ? 'pump' : 'fan', model: p.model, ledIds: [...p.ids] }));
  const pump = out.find((s) => s.kind === 'pump');
  if (pump) pump.rings = [pump.ledIds.length];
  for (const screen of parts.filter((p) => p.kind === 'screen')) {
    if (pump) { pump.ledIds.push(...screen.ids); pump.rings.push(screen.ids.length); }
    else out.push({ kind: 'pump', model: screen.model, ledIds: [...screen.ids], rings: [screen.ids.length] });
  }
  return out.filter((s) => s.ledIds.length);
}

/**
 * The frame's layout for a chain (corsair-link-protocol.js parseDevices).
 * @param {{ channel: number, type: number, model: number }[]} chain
 * @returns {{ ok: true, slots: number, slotOf: Map<number, number>, segments: { kind: string, model: string, ledIds: number[], rings?: number[] }[] }
 *   | { ok: false, why: 'unknown-leds' | 'too-many-leds' }}
 */
function layoutOf(chain) {
  const sorted = [...chain].sort((a, b) => a.channel - b.channel);
  if (sorted.some((d) => !SLOTS.has(d.type))) return { ok: false, why: 'unknown-leds' };
  const parts = [];
  let at = 0;
  for (const d of sorted) {
    parts.push(partOf(d, at));
    at += /** @type {{ slots: number }} */ (SLOTS.get(d.type)).slots;
  }
  if (at > MAX_COLOUR_SLOTS) return { ok: false, why: 'too-many-leds' };
  const slotOf = new Map();
  for (const p of parts) p.ids.forEach((id, i) => { slotOf.set(id, p.slots[i]); });
  return { ok: true, slots: at, slotOf, segments: segmentsOf(parts) };
}

/**
 * The colour of every slot, from the map's colours (colors[i] is ledIds[i]'s); the rest dark.
 * @param {{ slots: number, slotOf: Map<number, number> }} layout
 * @param {number[]} ledIds
 * @param {({ r: number, g: number, b: number } | null)[]} colors
 */
function frameOf(layout, ledIds, colors) {
  const frame = new Array(layout.slots).fill(OFF);
  ledIds.forEach((id, i) => {
    const slot = layout.slotOf.get(id);
    if (slot != null) frame[slot] = colors[i] || OFF;
  });
  return frame;
}

module.exports = { layoutOf, frameOf, ledId, SLOTS };
