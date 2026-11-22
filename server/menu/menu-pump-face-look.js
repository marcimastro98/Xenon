'use strict';
// How the face on one of a pump's lines looks (js/pump/pump-faces.js LOOK), under its own
// choices: its colours, what is behind it, how big its numbers are, the unit of its
// temperatures, whether a warm reading changes colour, and a line of the person's own. Only
// the rows that change something on that face, and how the ring of lights moves with it. Pure.

const Faces = require('../js/pump/pump-faces.js');
const { k, run, choiceRow } = require('./menu-rows.js');

// Where what the person types or picks goes in a line's save (js/menu/xenon-menu-pump-rows.js).
const COLOR_MARK = 'xenon:color';
const TEXT_MARK = 'xenon:text';
const FILE_MARK = 'xenon:file';

const PRESETS = Object.freeze(['xenon', 'theme', 'fire', 'ice', 'violet', 'mono']);
const TEMPS = Object.freeze(['cpuTemp', 'gpuTemp']);
// The faces drawn over a background with numbers of their own; music and pictures fill the screen.
const DRAWN = Object.freeze(['sensors', 'game', 'clock']);

const isWidget = (show) => show.face === Faces.WIDGET;
const hasPicture = (show) => show.face === 'music' || show.face === 'picture' || Faces.isPicture(show.bg);
const showsTemps = (show) => (show.readings || []).some((r) => TEMPS.includes(r)) || (show.face === 'clock' && show.weather === true);
const ownColor = (show) => (/^#/.test(show.colors || '') ? show.colors : '');

// The colour sets as swatches, and a colour of one's own (the client's colour picker).
function colorsRow(key, show, accent, apply) {
  const sets = [...PRESETS, ...(!isWidget(show) && hasPicture(show) ? ['picture'] : [])];
  const own = ownColor(show);
  return {
    kind: 'pumpkeys', id: key + '-colors', label: k('xmenu_pump_colors'),
    sub: isWidget(show) ? k('xmenu_pump_look_widget_sub') : undefined,
    options: sets.map((c) => ({
      value: c, label: k('xmenu_pump_colors_' + c), swatch: Faces.colorsOf(c, accent),
      on: show.colors === c, act: show.colors === c ? null : run(apply({ colors: c })),
    })),
    own: { label: k('xmenu_pump_colors_own'), value: own || Faces.colorsOf(show.colors, accent)?.[0] || Faces.COLOR_HEX.xenon[0], on: !!own, act: run(apply({ colors: COLOR_MARK })) },
    mark: COLOR_MARK,
  };
}

// Black, a soft light of the first colour, one of Xenon's pictures, or the person's own (its
// button sits right under this row). Keys of their own: six do not fit one segmented line.
function bgRows(key, show, apply) {
  const own = Faces.isPicture(show.bg) && !Faces.OWN_ART.includes(show.bg);
  const options = [['black', k('xmenu_pump_bg_black')], ['glow', k('xmenu_pump_bg_glow')], ...Faces.OWN_ART.map((a) => [a, k('xmenu_pump_art_' + a.slice(4))])];
  return [
    {
      kind: 'pumpkeys', id: key + '-bg', label: k('xmenu_pump_bg'), sub: own ? k('xmenu_pump_art_own') : undefined,
      options: options.map(([bg, label]) => ({ value: bg, label, on: show.bg === bg, act: show.bg === bg ? null : run(apply({ bg })) })),
    },
    { kind: 'pumpupload', id: key + '-bgown', label: k('xmenu_pump_bg_upload'), act: run(apply({ bg: FILE_MARK })) },
  ];
}

// How the ring of lights moves while this line shows, in the line's colours. 'auto' is what the
// Look tab says for the whole screen; with the beat only where this PC can hear the sound.
function ringRow(key, show, ring, apply) {
  const effects = Faces.LED_EFFECTS.filter((e) => e !== 'beat' || ring.sound);
  return {
    kind: 'pumpkeys', id: key + '-leds', label: k('xmenu_pump_ring'), sub: k('xmenu_pump_ring_sub'),
    options: effects.map((leds) => ({ value: leds, label: k('xmenu_pump_ring_' + leds), on: show.leds === leds, act: show.leds === leds ? null : run(apply({ leds })) })),
  };
}

// Keys of their own, as the long "as in Settings" leaves no room for a segmented line on a phone;
// it comes last so the two short ones share the first line.
function unitsRow(key, show, apply) {
  const options = [['c', { text: '°C' }], ['f', { text: '°F' }], ['auto', k('xmenu_pump_units_auto')]];
  return {
    kind: 'pumpkeys', id: key + '-units', label: k('xmenu_pump_units'),
    options: options.map(([units, label]) => ({ value: units, label, on: show.units === units, act: show.units === units ? null : run(apply({ units })) })),
  };
}

/**
 * The look rows of a line. `apply(patch)` → the action that saves it; `accent`: the theme's;
 * `ring`: { sound } when this screen's ring of lights has colours of its own, else null.
 * @param {string} key @param {any} saved @param {string} accent @param {(p: any) => any} apply @param {{ sound: boolean } | null} [ring]
 */
function lookRows(key, saved, accent, apply, ring = null) {
  const show = { ...saved, ...Faces.LOOK, ...Faces.lookOf(saved) };
  /** @type {any[]} */
  const rows = [{ kind: 'pumpcap', id: key + '-look', label: k('xmenu_pump_face_look') }, colorsRow(key, show, accent, apply)];
  if (ring) rows.push(ringRow(key, show, ring, apply));
  const drawn = DRAWN.includes(show.face);
  if (drawn) rows.push(...bgRows(key, show, apply));
  if (drawn || isWidget(show)) {
    rows.push(choiceRow(key + '-size', k('xmenu_pump_size'), show.size, Faces.SIZES.map((s) => [s, k('xmenu_pump_size_' + s)]), (size) => apply({ size })));
  }
  if (showsTemps(show) || isWidget(show)) rows.push(unitsRow(key, show, apply));
  if ((show.readings || []).some((r) => TEMPS.includes(r))) {
    rows.push(choiceRow(key + '-warn', k('xmenu_pump_warn'), show.warn !== false ? 'on' : 'off',
      [['on', k('xmenu_pump_warn_on')], ['off', k('xmenu_pump_warn_off')]], (w) => apply({ warn: w === 'on' })));
  }
  if (!isWidget(show)) {
    rows.push({ kind: 'pumptext', id: key + '-text', label: k('xmenu_pump_text'), hint: k('xmenu_pump_text_hint'), value: show.text || '', max: Faces.TEXT_MAX, act: run(apply({ text: TEXT_MARK })), mark: TEXT_MARK });
  }
  return rows;
}

module.exports = { lookRows, COLOR_MARK, TEXT_MARK, FILE_MARK };
