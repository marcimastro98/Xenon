#!/usr/bin/env node
// Steps an iCUE LINK hub through known colours while a capture runs (cli.mjs capture), so
// the bytes on the wire can be matched to what was asked. It goes through Xenon's lights
// and so through iCUE, the program whose language is being learned; it puts the hub's look
// back as it found it at the end, whatever happens.
//
//   node tools/link-capture/colours.mjs <port> [seconds per step]
//
// Steps: red, green, blue, white, half grey, then every LED its own colour (red = the part's
// number from 1 in steps of 16, green = the LED's number in the part in steps of 4, blue 0x55),
// so each colour on the wire names its part and LED. It prints when each step starts.

import { pathToFileURL } from 'node:url';

const HUB_MODEL = 'iCUE LINK System Hub';
const STEP_S_DEFAULT = 4;

const hex2 = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');

async function call(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
  return res.json();
}

/** Every LED of the hub its own colour, from its part (segment) and place in it. */
export function markerLeds(segments) {
  const leds = {};
  segments.forEach((seg, s) => {
    (seg.ledIds || []).forEach((id, i) => { leds[id] = `#${hex2(16 * (s + 1))}${hex2(4 * i)}55`; });
  });
  return leds;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(portArg, stepArg) {
  const port = Number(portArg);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('usage: colours.mjs <port> [seconds per step]');
  const stepMs = (Number(stepArg) || STEP_S_DEFAULT) * 1000;
  const status = await call(port, '/api/lighting/status');
  const hub = (status.devices || []).find((d) => d.model === HUB_MODEL);
  if (!hub) throw new Error('no iCUE LINK hub among the lights: is iCUE running?');
  const before = { mode: hub.mode, color: hub.modeColor, anim: hub.modeAnim || undefined, leds: hub.modeLeds || {} };
  const t0 = Date.now();
  const mark = (what) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${new Date().toISOString()}  ${what}`);
  try {
    for (const color of ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#808080']) {
      mark(`all ${color}`);
      await call(port, '/api/lighting/device-mode', { id: hub.id, mode: 'color', color });
      await sleep(stepMs);
    }
    mark('each LED its own colour (part, LED)');
    await call(port, '/api/lighting/device-mode', { id: hub.id, mode: 'custom', clearLeds: true, leds: markerLeds(hub.segments || []) });
    await sleep(stepMs * 2);
  } finally {
    mark('look put back');
    await call(port, '/api/lighting/device-mode', { id: hub.id, mode: before.mode, color: before.color, anim: before.anim, clearLeds: true, leds: before.leds });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(...process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
