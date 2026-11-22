'use strict';
// One line of a pump's "What it shows" tab (menu-pump.js): a moment, or the rest of the time,
// and what opens under it: the faces to pick from as cards, then the face's own choices (its
// style, the readings it shows, what a clock adds), then its look (menu-pump-face-look.js). Pure.

const Faces = require('../js/pump/pump-faces.js');
const LayerWhen = require('../js/layers/layer-when.js');
const { faceFor } = require('../pump-screen/actions.js');
const { k, run, open, choiceRow } = require('./menu-rows.js');
const { lookRows, FILE_MARK } = require('./menu-pump-face-look.js');

const STYLES = Object.freeze({ sensors: Faces.SENSOR_STYLES, music: Faces.MUSIC_STYLES, clock: Faces.CLOCK_STYLES });
const CLOCK_PARTS = Object.freeze(['seconds', 'date', 'weather']);
// The Game face shows its first reading large and two more beside it.
const GAME_READINGS = 3;

// A face of the person's own: asked of Bit, made in the Maker or in code, or from the Store.
// Once it is there, it joins the faces of every line.
const GUIDE_URL = 'https://xenon-app.com/create/#sdk';
const MAKER_URL = 'https://xenon-app.com/maker/';
const OWN_FACE = Object.freeze({
  label: k('xmenu_pump_own_face'),
  actions: [
    { label: k('xmenu_bit'), icon: 'bit', act: open('chat'), closes: true },
    { label: k('xmenu_pump_in_maker'), act: run({ type: 'openUrl', url: MAKER_URL }) },
    { label: k('xmenu_pump_in_code'), act: run({ type: 'openUrl', url: GUIDE_URL }) },
    { label: k('xmenu_pump_from_store'), act: open('store:__pump'), closes: true },
  ],
});

const faceLabel = (f) => k('pump_face_' + f);
const readingLabel = (r) => k('pump_reading_' + r.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()));

// A widget made for a pump is one more face to pick ('widget:<id>').
const WIDGET_PICK = 'widget:';
const pickOf = (show) => (show.face === Faces.WIDGET ? WIDGET_PICK + show.id : show.face);
const showOf = (v, f) => (f.startsWith(WIDGET_PICK) ? { face: Faces.WIDGET, id: f.slice(WIDGET_PICK.length) } : faceFor(v, f));
const widgetsOf = (st) => (Array.isArray(st.pump?.widgets) ? st.pump.widgets : []);
// A widget the pump cannot show (Store widgets off, not approved, removed): the clock stands in, and the line says so.
const widgetOff = (show, st) => show.face === Faces.WIDGET && !widgetsOf(st).some((w) => w.id === show.id);
// A face's name: the widget's own name when it is one.
function showLabel(show, st) {
  const w = show.face === Faces.WIDGET && widgetsOf(st).find((x) => x.id === show.id);
  return w ? { text: w.name } : faceLabel(show.face);
}

// The faces to pick from: the built-in ones, then the widgets that fit a pump (the person's own,
// from Bit, the Maker or code, and the Store's), and one picked already that went away since.
function faceCards(st, picked, apply) {
  const card = (value, label, art, own) => ({ value, label, art, own, on: value === picked, act: value === picked ? null : run(apply(value)) });
  const gone = picked.startsWith(WIDGET_PICK) && !widgetsOf(st).some((w) => WIDGET_PICK + w.id === picked);
  return [
    ...Faces.FACES.map((f) => card(f, faceLabel(f), f, false)),
    ...widgetsOf(st).map((w) => card(WIDGET_PICK + w.id, { text: w.name }, Faces.WIDGET, true)),
    ...(gone ? [card(picked, faceLabel(Faces.WIDGET), Faces.WIDGET, true)] : []),
  ];
}

// What the face on a line shows, said under its name: its readings, its style, its picture.
function detailOf(show, st) {
  if (widgetOff(show, st)) return k('xmenu_pump_widget_off');
  if (Array.isArray(show.readings)) return show.readings.slice(0, show.face === 'game' ? GAME_READINGS : Faces.MAX_READINGS).map(readingLabel);
  const style = STYLES[show.face]?.includes(show.style) ? k('xmenu_pump_style_' + show.style) : null;
  if (show.face === 'clock') return [style, ...CLOCK_PARTS.filter((p) => show[p] === true).map((p) => k('xmenu_pump_clock_' + p))].filter(Boolean);
  if (style) return style;
  if (show.face === 'picture') {
    const art = Faces.OWN_ART.find((a) => a === show.items?.[0]);
    return k(art ? 'xmenu_pump_art_' + art.slice(4) : 'xmenu_pump_art_own');
  }
  return null;
}

// The readings a sensors or game face shows. The keys stay where they are and each one on says
// its place on the face (`rank`), so a tap never moves the key under the finger. A fifth takes
// the last one's place, and the last one left stays: a face with no number is not a choice.
function readingsRow(key, show, apply) {
  const on = show.readings;
  const max = show.face === 'game' ? GAME_READINGS : Faces.MAX_READINGS;
  const flip = (r) => (on.includes(r) ? on.filter((x) => x !== r) : [...on.slice(0, max - 1), r]);
  return {
    kind: 'choice', id: key + '-readings', multi: true, label: k('xmenu_pump_readings'),
    sub: k(show.face === 'game' ? 'xmenu_pump_readings_game_sub' : 'xmenu_pump_readings_sub'),
    options: [...Faces.READINGS, ...on.filter((r) => !Faces.READINGS.includes(r))].map((r) => ({
      value: r, label: readingLabel(r), on: on.includes(r), rank: on.indexOf(r) + 1,
      act: on.length === 1 && on[0] === r ? null : run(apply({ readings: flip(r) })),
    })),
  };
}

function clockRow(key, show, apply) {
  return {
    kind: 'choice', id: key + '-clock', multi: true, label: k('xmenu_pump_clock'),
    options: CLOCK_PARTS.map((p) => ({ value: p, label: k('xmenu_pump_clock_' + p), on: show[p] === true, act: run(apply({ [p]: show[p] !== true })) })),
  };
}

// A picture of Xenon's own to show; one of the person's (the button over the tabs) lights none.
function artRow(key, show, apply) {
  const art = Faces.OWN_ART.includes(show.items?.[0]) ? show.items[0] : '';
  return choiceRow(key + '-art', k('xmenu_pump_art'), art, Faces.OWN_ART.map((a) => [a, k('xmenu_pump_art_' + a.slice(4))]),
    (a) => apply({ items: [a] }), art ? undefined : k('xmenu_pump_art_own'));
}

// What a face lets the person choose beyond its name. `apply(patch)` → the action that saves it.
function faceRows(key, show, apply) {
  const rows = [];
  if (STYLES[show.face]) rows.push(choiceRow(key + '-style', k('xmenu_pump_style'), show.style, STYLES[show.face].map((s) => [s, k('xmenu_pump_style_' + s)]), (s) => apply({ style: s })));
  if (Array.isArray(show.readings)) rows.push(readingsRow(key, show, apply));
  if (show.face === 'clock') rows.push(clockRow(key, show, apply));
  // Under Xenon's own pictures: or one of the person's (the file goes up first, in its place the mark).
  if (show.face === 'picture') rows.push(artRow(key, show, apply), { kind: 'pumpupload', id: key, label: k('xmenu_pump_own'), act: run(apply({ items: [FILE_MARK] })) });
  return rows;
}

// A moment's name as a line of the tab: "When you play", "From 22:00 to 07:00", an app's name.
function whenLabel(when) {
  if (when.any.length > 1) return k('xmenu_when_many', { n: when.any.length });
  const r = when.any[0];
  if (r.c === 'time') return k('xmenu_pump_when_time', { from: r.from, to: r.to });
  if (r.app) return { text: LayerWhen.appName(r.app) };
  return LayerWhen.PLAIN.includes(r.c) ? k('xmenu_pump_when_' + r.c) : k('xmenu_sit_' + r.c);
}

/**
 * One line: its name, what it shows, and under it the faces, the face's choices, and a way to
 * take the line off (`remove`, none for the rest of the time).
 * @param {{ id: string, label: any, show: any, v: any, st: any, save: (show: any) => any, remove?: any }} o
 */
function momentRow({ id, label, show, v, st, save, remove }) {
  return {
    kind: 'pumpmoment', id, label, sub: detailOf(show, st), value: showLabel(show, st), art: show.face, show,
    // Another face keeps the line's look: its colours, background and the rest.
    faces: faceCards(st, pickOf(show), (f) => save({ ...showOf(v, f), ...Faces.lookOf(show) })),
    facesLabel: k('xmenu_pump_faces'), yours: k('xmenu_pump_yours'), own: OWN_FACE,
    rows: [...faceRows(id, show, (p) => save({ ...show, ...p })), ...lookRows(id, show, st.pump?.accent, (p) => save({ ...show, ...p }))],
    remove: remove ? { label: k('xmenu_pump_m_remove'), act: run(remove) } : null,
  };
}

module.exports = { momentRow, whenLabel, showLabel, faceLabel, FILE_MARK };
