'use strict';
// How a pump screen draws its lines, the first row of its Look tab (menu-pump-look.js): Xenon's
// own faces, Strumento, and the Store widgets made to draw every line (manifest pumpStyle,
// pump-screen/widgets.js `style`) that fit this screen's shape. A widget style chosen before and
// gone since stays on show, saying the lines are drawn by Xenon meanwhile (face-widget.js).
// Strumento's own switches show only while it is the style. Pure.

const Faces = require('../js/pump/pump-faces.js');
const { k, run, open, toggleRow } = require('./menu-rows.js');

const pumpSet = (screen, patch) => ({ type: 'pumpSet', screen, patch: JSON.stringify(patch) });
const flag = (id, key, on, screen, name, sub) => toggleRow(id, k(key), on,
  pumpSet(screen, { gauge: { [name]: true } }), pumpSet(screen, { gauge: { [name]: false } }), sub ? k(sub) : undefined);

// The widget styles this screen can take: made to draw every line, and for its shape.
function widgetStyles(v, st) {
  return Faces.fitStyles(st?.pump?.widgets, v.seen?.shape || 'round');
}

/** @param {any} v the screen's view @param {any} st the menu's state */
function styleRows(v, st) {
  const id = v.screen;
  const style = v.style || 'xenon';
  // A widget style takes the ring's moves too (Lights → How they move): a ring set to one effect
  // would hide every light the style gives it. Xenon's own styles leave the ring as it is.
  const move = v.leds?.move;
  const patch = (value) => (Faces.styleWidget(value) && move && move !== 'style' ? { style: value, leds: { move: 'style' } } : { style: value });
  const card = (value, label, sub, art) => ({ value, label, sub, art, on: value === style, act: value === style ? null : run(pumpSet(id, patch(value))) });
  const widgets = widgetStyles(v, st);
  const gone = Faces.styleWidget(style) && !widgets.some((w) => Faces.STYLE_WIDGET + w.id === style);
  /** @type {any[]} rows of several kinds */
  const rows = [{
    kind: 'pumpcards', id: 'pump-style', label: k('xmenu_pump_drawn'), sub: k('xmenu_pump_drawn_sub'), value: style,
    cards: [
      ...Faces.SCREEN_STYLES.map((s) => card(s, k('xmenu_pump_drawn_' + s), k('xmenu_pump_drawn_' + s + '_sub'), 'style-' + s)),
      ...widgets.map((w) => card(Faces.STYLE_WIDGET + w.id, { text: w.name }, k('xmenu_pump_drawn_widget_sub'), 'style-widget')),
      ...(gone ? [card(style, k('xmenu_pump_drawn_widget_gone'), k('xmenu_pump_drawn_widget_gone_sub'), 'style-widget')] : []),
    ],
  }, {
    // More styles are found in the Store's pump screens view.
    kind: 'button', id: 'pump-style-store', label: k('xmenu_pump_style_more'), sub: k('xmenu_pump_style_more_sub'),
    action: k('xmenu_open'), act: open('store:__pump'), closes: true,
  }];
  if (style !== 'gauge') return rows;
  const gauge = v.gauge || {};
  rows.push(flag('pump-needle', 'xmenu_pump_gauge_needle', gauge.needle !== false, id, 'needle'),
    flag('pump-arc', 'xmenu_pump_gauge_arc', gauge.arc !== false, id, 'arc', 'xmenu_pump_gauge_arc_sub'));
  return rows;
}

module.exports = { styleRows, widgetStyles };
