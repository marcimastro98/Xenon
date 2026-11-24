'use strict';
// The ring of lights around a pump screen: what the screen's settings say its lights follow
// (leds.follow, leds.all) and the colours its page last said (POST /pump/colors), handed to
// the lighting bridge (lights/pump-ring.js), which paints the LEDs iCUE reports as a pump.
// Each line moves the ring its own way (its look's `leds`; 'auto' = the screen's pulse or
// still), so the face on show now is told here too (live.js). The colours live in memory only. With several pump screens, the first one showing Xenon
// leads the ring; with none showing it (its widget taken off in iCUE), the ring is iCUE's again.
// A page says its colours again every half minute (js/pump/face-colors.js); colours not said
// for STALE_MS are dropped, so a page that is gone (iCUE closed, its widget removed) never
// leaves the ring in its last colours, nor holds the iCUE session for them. With the page's
// colours comes how far its line is (`level`, 0..1: its first reading, the song's time), which
// a ring lit up to the reading follows. With colours of the person's own (follow 'own') the
// ring takes those, and the page's only say the level. A Store widget drawing the line may
// say how it moves (`effect`, pump-faces.js WIDGET_RING), followed while the ring moves as the style.

const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const RingFx = require('../js/pump/ring-effects.js');
const { screenIds } = require('./moments.js');

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_COLOURS = 3;
const STALE_MS = 90_000;

// How far a line is, 0..1 in hundredths, or null when it has no number to show.
const cleanLevel = (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100 : null);
// How a widget drawing the line asked the ring to move (pump-faces.js WIDGET_RING), else null.
const cleanEffect = (raw) => (Faces.WIDGET_RING.includes(raw) ? raw : null);

// The ring's colours of the person's own: a palette ready made, or their two.
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');
const ownColours = (leds) => (leds.palette ? RingFx.PALETTES[leds.palette].map(hex) : leds.colors);

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
  const colours = new Map();   // screen id -> { list, level, at }
  let sent;
  let timer = null;
  let faces = {};   // screen id -> { show, why }, as live.js last decided

  // What the lights get now; said again only when it changed. `now`: the faces just decided.
  function refresh(now) {
    if (now && typeof now === 'object') faces = now;
    const model = store.peek();
    const id = model ? screenIds(model).find(here) || '' : '';
    const screen = id ? Model.screenFor(model, id) : null;
    const leds = screen?.leds;
    const said = colours.get(id);
    const effect = leds ? Faces.ringEffect(leds, faces[id]?.show, screen.style, said?.effect) : 'still';
    const state = !leds || leds.follow === 'lights' ? null : {
      follow: leds.follow, all: leds.all, effect, speed: leds.speed, reverse: leds.reverse,
      ...(leds.size != null ? { size: leds.size } : {}), ...(leds.glow != null ? { glow: leds.glow } : {}),
      colours: leds.follow === 'own' ? ownColours(leds) : said?.list || [],
      ...(RingFx.about(effect).needs === 'level' ? { level: said?.level ?? null } : {}),
    };
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

  // A page said the colours of what it shows, how far its line is, how the widget drawing it
  // moves the ring, or some of them (a ring in colours of its own needs only the level).
  // Returns false when it said none rightly.
  function report(id, raw, level, effect) {
    const lv = cleanLevel(level);
    const fx = cleanEffect(effect);
    const list = raw == null && (lv != null || fx) ? colours.get(id)?.list || [] : cleanColours(raw);
    if (!list) return false;
    colours.set(id, { list, level: lv, effect: fx, at: clock() });
    arm();
    refresh();
    return true;
  }

  function stop() {
    if (timer) cancel(timer);
    timer = null;
    colours.clear();
  }

  // What the ring was last told to show (the state above), for the menu's pump card; null when
  // the ring follows the other lights or no screen has a ring.
  const now = () => (sent ? JSON.parse(sent) : null);

  return { refresh, report, stop, now };
}

module.exports = { createPumpRing, cleanColours, cleanLevel, cleanEffect, effectOf: Faces.ringEffect, STALE_MS };
