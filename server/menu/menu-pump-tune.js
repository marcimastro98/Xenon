'use strict';
// The choices under how a pump's ring moves (menu-pump-leds.js), read from the light effects'
// own list (js/pump/ring-effects.js): how fast, how much of the effect (its tail, stars, drops:
// named as the effect calls it), how lit its dark part stays, which way round; and, with colours
// of the person's own, a palette ready made or their two. Only what the effects shown on this
// screen have: a row for an amount none of them has would change nothing. Pure.

const Faces = require('../js/pump/pump-faces.js');
const RingFx = require('../js/pump/ring-effects.js');
const { k, run, choiceRow } = require('./menu-rows.js');
const { pumpSet, flag } = require('./menu-pump-look.js');

// Places on the speed slider the menu offers, slowest first; the old names sit on three of them.
const SPEEDS = Object.freeze([[12, 'slowest'], [30, 'slow'], [50, 'normal'], [72, 'fast'], [92, 'fastest']]);
const SIZES = Object.freeze([[0.2, 'less'], [0.5, 'normal'], [0.8, 'more']]);
// The dark part: dark, as the effect is made (null), lit more.
const GLOWS = Object.freeze([['none', 0], ['auto', null], ['more', 0.3]]);
const GLOW_DARK_BELOW = 0.15;

const nearest = (list, v) => list.reduce((a, b) => (Math.abs(b[0] - v) < Math.abs(a[0] - v) ? b : a))[0];
const hex = (c) => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('');

// The effects the ring shows on this screen: each line's, as it moves while that line is on.
function inUse(v) {
  const shows = [v.base, ...v.moments.map((m) => m.show)];
  return [...new Set(shows.map((show) => Faces.ringEffect(v.leds, show, v.style)))].map(RingFx.about);
}

// The ring's own colours as the cards draw them: the palette's or the person's two; none (the
// cards keep Xenon's) while it takes the screen's or the theme's.
function ringColours(leds) {
  if (leds.follow !== 'own') return [];
  return leds.palette ? RingFx.PALETTES[leds.palette].map(hex) : leds.colors;
}

// How the cards of the effects draw them: as this ring is set, so a card shows what a tap gives.
const cardLook = (leds) => ({ colours: ringColours(leds), speed: leds.speed, size: leds.size, glow: leds.glow, reverse: leds.reverse });

function sizeRows(id, leds, used) {
  const names = [...new Set(used.map((e) => e.size).filter(Boolean))];
  if (!names.length) return [];
  const label = names.length === 1 ? k('light_fx_size_' + names[0]) : k('xmenu_pump_leds_size');
  return [choiceRow('pump-leds-size', label, nearest(SIZES, leds.size ?? 0.5), SIZES.map(([n, w]) => [n, k('xmenu_pump_leds_size_' + w)]),
    (size) => pumpSet(id, { leds: { size } }))];
}

function glowRows(id, leds, used) {
  if (!used.some((e) => e.glow != null)) return [];
  const on = leds.glow == null ? 'auto' : leds.glow < GLOW_DARK_BELOW ? 'none' : 'more';
  return [choiceRow('pump-leds-glow', k('xmenu_pump_leds_glow'), on, GLOWS.map(([w]) => [w, k('xmenu_pump_leds_glow_' + w)]),
    (w) => pumpSet(id, { leds: { glow: GLOWS.find((g) => g[0] === w)[1] } }), k('xmenu_pump_leds_glow_sub'))];
}

/** The rows under the effect cards: speed and way round for what moves, then amount and dark part. */
function tuneRows(v) {
  const id = v.screen;
  const used = inUse(v);
  const moving = used.some((e) => e.moves)
    ? [choiceRow('pump-leds-speed', k('xmenu_pump_leds_speed'), nearest(SPEEDS, RingFx.speedOf(v.leds.speed)),
      SPEEDS.map(([n, w]) => [n, k('xmenu_pump_leds_speed_' + w)]), (speed) => pumpSet(id, { leds: { speed } })),
    flag('pump-leds-reverse', 'xmenu_pump_leds_reverse', v.leds.reverse, id, 'leds', 'reverse', 'xmenu_pump_leds_reverse_sub')]
    : [];
  return [...moving, ...sizeRows(id, v.leds, used), ...glowRows(id, v.leds, used)];
}

/** The person's colours: their two, or a palette ready made, each a card with the ring in it. */
function paletteRow(id, leds) {
  const now = leds.palette || 'mine';
  const card = (value, label, colours) => ({
    value, label, art: 'fx-still', look: { effect: 'still', colours }, on: value === now,
    act: value === now ? null : run(pumpSet(id, { leds: { palette: value === 'mine' ? null : value } })),
  });
  return {
    kind: 'pumpcards', id: 'pump-leds-palette', fx: true, label: k('xmenu_pump_leds_palette'), value: now,
    cards: [card('mine', k('xmenu_pump_leds_palette_mine'), leds.colors),
      ...RingFx.PALETTE_IDS.map((p) => card(p, k('light_fx_palette_' + p), RingFx.PALETTES[p].map(hex)))],
  };
}

module.exports = { tuneRows, paletteRow, cardLook, SPEEDS, SIZES, GLOWS };
