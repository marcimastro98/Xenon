'use strict';
// A pump's Lights tab in the Xenon menu (menu-pump.js), the one place for the ring of LEDs around
// it (pump-screen/ring.js paints it through iCUE, or Xenon itself while it holds the hub): whose colours it shows, the person's own two,
// whether every other light takes them too, how it moves on the whole screen, then one fold per
// line of What it shows for how it moves while that line is on. While it follows the other
// lights, the way to Settings → Lighting, where those are chosen; that page says in turn when
// the pump holds the ring (js/lighting/lighting-device.js). Pure.

const Model = require('../js/pump/pump-model.js');
const Faces = require('../js/pump/pump-faces.js');
const { k, run } = require('./menu-rows.js');
const { COLOR_MARK } = require('./menu-pump-face-look.js');
const { whenLabel, showLabel } = require('./menu-pump-faces.js');
const { fxRows, moveLabel } = require('./menu-pump-fx.js');
const { pumpSet, flag, note, head } = require('./menu-pump-look.js');
const { tuneRows, paletteRow, cardLook } = require('./menu-pump-tune.js');

// The faces with a number of their own (a reading, the song's time): what follows a line's level.
const MEASURED = Object.freeze(['sensors', 'game', 'music']);
// Settings → Lighting, the page of every other light.
const LIGHTING = Object.freeze({ open: 'settings:lighting' });

// A move chosen for the whole ring is every line's move: a line keeping its own would leave the
// card tapped and the pump unchanged (seen 23 Nov 2026: Scanner on the base line beat every card).
// A line can be given its own again below, after.
function everyLine(v, move) {
  const own = (show) => !!show && show.leds != null && show.leds !== 'auto';
  const patch = { leds: { move } };
  if (own(v.base)) patch.base = { leds: 'auto' };
  if (v.moments.some((m) => own(m.show))) patch.moments = v.moments.map((m) => (own(m.show) ? { ...m, show: { ...m.show, leds: 'auto' } } : m));
  return patch;
}

// How the ring moves on every line, then how fast, which way round, how much and how lit its dark
// part (menu-pump-tune.js). Only what this PC can follow (can: the sound heard, the fans read).
function moveRows(v, can) {
  const { screen: id, leds } = v;
  return [
    ...fxRows({
      id: 'pump-leds-move', label: k('xmenu_pump_leds_move'), sub: k('xmenu_pump_leds_move_sub'), lead: 'style', on: leds.move, look: cardLook(leds),
      allow: (e) => can(e.needs), act: (m) => run(pumpSet(id, everyLine(v, m))),
    }),
    ...tuneRows(v),
  ];
}

// The ring's own two colours, one picker each (the client's): where it starts round and where it ends.
function ringColorsRow(id, colors) {
  return {
    kind: 'pumpkeys', id: 'pump-leds-colors', label: k('xmenu_pump_leds_colors'), options: [], mark: COLOR_MARK,
    slots: colors.map((c, i) => ({
      value: c, label: k(i ? 'xmenu_pump_leds_color_end' : 'xmenu_pump_leds_color_start'),
      act: run(pumpSet(id, { leds: { colors: colors.map((x, j) => (j === i ? COLOR_MARK : x)) } })),
    })),
  };
}

// Whose colours the ring shows, each a card with the ring drawn in it, then what that choice
// leads to: the person's two colours, and the switch that lights the whole PC with them (only
// with colours the ring has of its own), or the way to the page of the other lights.
function followRows(id, leds) {
  /** @type {any[]} */
  const rows = [{
    kind: 'pumpcards', id: 'pump-leds', label: k('xmenu_pump_leds'), sub: k('xmenu_pump_leds_sub'), value: leds.follow,
    cards: Model.LED_FOLLOW.map((f) => ({
      value: f, label: k('xmenu_pump_leds_' + f), sub: k('xmenu_pump_leds_' + f + '_sub'), art: 'leds-' + f,
      on: f === leds.follow, act: f === leds.follow ? null : run(pumpSet(id, { leds: { follow: f } })),
    })),
  }];
  if (leds.follow === 'own') rows.push(paletteRow(id, leds));
  if (leds.follow === 'own' && !leds.palette) rows.push(ringColorsRow(id, leds.colors || Model.LED_COLORS));
  if (leds.follow === 'screen' || leds.follow === 'own') {
    rows.push(flag('pump-leds-all', 'xmenu_pump_leds_all', leds.all, id, 'leds', 'all', leds.follow === 'own' ? 'xmenu_pump_leds_all_own_sub' : 'xmenu_pump_leds_all_sub'));
  }
  if (leds.follow === 'lights') {
    rows.push({
      kind: 'button', id: 'pump-leds-lighting', label: k('xmenu_pump_leds_lighting'), sub: k('xmenu_pump_leds_lighting_sub'),
      action: k('xmenu_pump_leds_lighting_open'), act: LIGHTING, closes: true,
    });
  }
  return rows;
}

// One line of What it shows, folded: closed it says how the ring moves while that line is on,
// opened the same cards as above, "as above" first. In the line's colours when the ring follows
// the screen (said under the cards). What follows the line's level only on a line with a number.
function lineFold({ id, label, show, v, st, can, save }) {
  const on = Faces.lookOf(show).leds ?? Faces.LOOK.leds;
  return {
    kind: 'pumpmoment', id, label, sub: showLabel(show, st), value: moveLabel(on), name: showLabel(show, st),
    art: Faces.drawnAs(v.style, show.face) === 'gauge' ? 'gauge' : show.face, show,
    rows: fxRows({
      id: id + '-fx', label: k('xmenu_pump_leds_move'), sub: k(v.leds.follow === 'screen' ? 'xmenu_pump_ring_sub' : 'xmenu_pump_ring_sub_plain'),
      lead: 'auto', on, look: cardLook(v.leds), act: (leds) => run(save({ ...show, leds })),
      allow: (e) => can(e.needs) && (e.needs !== 'level' || MEASURED.includes(show.face)),
    }),
  };
}

function lineRows(v, st, can) {
  const id = v.screen;
  const withShow = (i, show) => pumpSet(id, { moments: v.moments.map((x, j) => (j === i ? { ...x, show } : x)) });
  return [
    head('pump-leds-lines', 'xmenu_pump_leds_lines'),
    note('pump-leds-lines-sub', 'xmenu_pump_leds_lines_sub'),
    ...v.moments.map((m, i) => lineFold({ id: 'pump-ring-m-' + i, label: whenLabel(m.when), show: m.show, v, st, can, save: (show) => withShow(i, show) })),
    lineFold({ id: 'pump-ring-base', label: k('xmenu_pump_rest'), show: v.base, v, st, can, save: (show) => pumpSet(id, { base: show }) }),
  ];
}

// The tab, on the screen whose ring Xenon can paint (menu-pump.js says which). How it moves
// needs colours of the ring's own: none while it follows the other lights or is dark.
function ledsTab(v, st) {
  // What follows the sound only where this PC hears it, the fans only where it reads them.
  const cannot = Array.isArray(st.pump?.cannot) ? st.pump.cannot : [];
  const can = (need) => (need === 'sound' ? st.pump?.sound === true : !cannot.includes(need));
  const lit = v.leds.follow !== 'lights' && v.leds.follow !== 'off';
  return {
    id: 'leds', label: k('xmenu_pump_leds_tab'), value: null,
    rows: [...followRows(v.screen, v.leds), ...(lit ? [...moveRows(v, can), ...lineRows(v, st, can)] : [])],
  };
}

module.exports = { ledsTab };
