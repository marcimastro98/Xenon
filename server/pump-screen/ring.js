'use strict';
// The ring of lights around a pump screen: what the screen's settings say its lights follow
// (leds.follow, leds.all) and the colours its page last said (POST /pump/colors), handed to
// the lighting bridge (lights/pump-ring.js), which paints the LEDs iCUE reports as a pump.
// The colours live in memory only. With several pump screens, the first one showing Xenon
// leads the ring; with none showing it (its widget taken off in iCUE), the ring is iCUE's again.
// A page says its colours again every half minute (js/pump/face-colors.js); colours not said
// for STALE_MS are dropped, so a page that is gone (iCUE closed, its widget removed) never
// leaves the ring in its last colours, nor holds the iCUE session for them.

const Model = require('../js/pump/pump-model.js');
const { screenIds } = require('./moments.js');

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_COLOURS = 3;
const STALE_MS = 90_000;

// The colours a page sent, or null when they are not a short list of #rrggbb.
function cleanColours(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_COLOURS) return null;
  if (!raw.every((c) => typeof c === 'string' && HEX.test(c))) return null;
  return raw.map((c) => c.toLowerCase());
}

/**
 * @param {{ store: { peek: () => any }, setRing: (state: any) => void, here?: (id: string) => boolean, clock?: () => number,
 *   later?: (fn: () => void, ms: number) => any, cancel?: (timer: any) => void }} opts
 */
function createPumpRing({ store, setRing, here = (_id) => true, clock = Date.now, later = setTimeout, cancel = clearTimeout }) {
  const colours = new Map();   // screen id -> { list, at }
  let sent;
  let timer = null;

  // What the lights get now; said again only when it changed.
  function refresh() {
    const model = store.peek();
    const id = model ? screenIds(model).find(here) || '' : '';
    const leds = id ? Model.screenFor(model, id).leds : null;
    const state = !leds || leds.follow === 'lights' ? null : { follow: leds.follow, all: leds.all, pulse: leds.pulse, colours: colours.get(id)?.list || [] };
    const json = JSON.stringify(state);
    if (json === sent) return;
    sent = json;
    setRing(state);
  }

  // Drops the colours no page said for a while; checks again while some are left.
  function sweep() {
    timer = null;
    const now = clock();
    for (const [id, c] of colours) if (now - c.at >= STALE_MS) colours.delete(id);
    refresh();
    arm();
  }

  function arm() {
    if (timer || !colours.size) return;
    timer = later(sweep, STALE_MS);
    timer?.unref?.();
  }

  // A page said the colours of what it shows. Returns false when they are not colours.
  function report(id, raw) {
    const list = cleanColours(raw);
    if (!list) return false;
    colours.set(id, { list, at: clock() });
    arm();
    refresh();
    return true;
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
    colours.clear();
  }

  return { refresh, report, stop };
}

module.exports = { createPumpRing, cleanColours, STALE_MS };
