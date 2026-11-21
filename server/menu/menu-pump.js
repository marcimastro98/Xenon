'use strict';
// The pump screens in the Screens home of the Xenon menu: one card under the desk for
// each, and for the one tapped four tabs: what it shows (a ready-made setup, its usual
// face, a face now), its moments, its alerts and its look. Every change is a pump action
// (js/capabilities/catalog-pump.js), the same Bit and a Deck key run. Pure.

const Faces = require('../js/pump/pump-faces.js');
const Model = require('../js/pump/pump-model.js');
const LayerWhen = require('../js/layers/layer-when.js');
const { faceFor } = require('../pump-screen/actions.js');
const { k, run, open, choiceRow, toggleRow } = require('./menu-rows.js');

const STYLES = Object.freeze({ sensors: Faces.SENSOR_STYLES, music: Faces.MUSIC_STYLES, clock: Faces.CLOCK_STYLES });
// The face a new moment starts with: what that moment is usually for.
const MOMENT_FACE = Object.freeze({ game: 'game', music: 'music', busy: 'sensors', idle: 'picture' });
const NIGHT = Object.freeze({ from: '23:00', to: '07:00', dim: 30 });
const DIMS = Object.freeze([100, 75, 50, 25]);

const faceLabel = (f) => k('pump_face_' + f);
const faceOptions = () => Faces.FACES.map((f) => [f, faceLabel(f)]);
// A Store widget made for a pump is one more face to pick ('widget:<id>'), never for "now": a
// face shown now comes from the built-in ones a Deck key cycles through.
const WIDGET_PICK = 'widget:';
const pickOf = (show) => (show.face === Faces.WIDGET ? WIDGET_PICK + show.id : show.face);
const showOf = (v, f) => (f.startsWith(WIDGET_PICK) ? { face: Faces.WIDGET, id: f.slice(WIDGET_PICK.length) } : faceFor(v, f));
// The widgets a pump can show, and the one it shows already even if it went away since.
function widgetsFor(v, st) {
  const list = Array.isArray(st.pump?.widgets) ? st.pump.widgets : [];
  const shown = [v.base, ...v.moments.map((m) => m.show)].filter((f) => f.face === Faces.WIDGET && !list.some((w) => w.id === f.id));
  return [...list.map((w) => [WIDGET_PICK + w.id, { text: w.name }]), ...shown.map((f) => [WIDGET_PICK + f.id, faceLabel(Faces.WIDGET)])];
}
const allFaces = (v, st) => [...faceOptions(), ...widgetsFor(v, st)];
// A widget the pump cannot show (Store widgets off, not approved, removed): the clock stands in, and the row says so.
const widgetOff = (show, st) => show.face === Faces.WIDGET && !(st.pump?.widgets || []).some((w) => w.id === show.id);
// A face's name on the card and in "why": the widget's own name when it is one.
function showLabel(show, st) {
  const w = show.face === Faces.WIDGET && (st.pump?.widgets || []).find((x) => x.id === show.id);
  return w ? { text: w.name } : faceLabel(show.face);
}
const pumpSet = (screen, patch) => ({ type: 'pumpSet', screen, patch: JSON.stringify(patch) });

// The numbers a sensor or game face reads, the first one big: the chosen ones come first, in the
// order the face shows them, so "the first" is the one on the left. A fifth takes the fourth's
// place, and the last one stays: a face with no number is not a choice.
function readingsRow(key, on, apply) {
  const flip = (r) => (on.includes(r) ? on.filter((x) => x !== r) : [...on.slice(0, Faces.MAX_READINGS - 1), r]);
  return {
    kind: 'choice', id: key + '-readings', multi: true, label: k('xmenu_pump_readings'), sub: k('xmenu_pump_readings_sub'),
    options: [...on, ...Faces.READINGS.filter((r) => !on.includes(r))].map((r) => ({
      value: r, label: k('pump_reading_' + r.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())), on: on.includes(r),
      act: on.length === 1 && on[0] === r ? null : run(apply({ readings: flip(r) })),
    })),
  };
}

const CLOCK_PARTS = Object.freeze(['seconds', 'date', 'weather']);
function clockRow(key, show, apply) {
  return {
    kind: 'choice', id: key + '-clock', multi: true, label: k('xmenu_pump_clock'),
    options: CLOCK_PARTS.map((p) => ({ value: p, label: k('xmenu_pump_clock_' + p), on: show[p] === true, act: run(apply({ [p]: show[p] !== true })) })),
  };
}

// What a face lets the person choose beyond its name, for the usual face and each moment's:
// its style, the numbers it reads, what a clock adds. `apply(patch)` → the action that saves it.
function faceRows(key, show, apply) {
  const rows = [];
  if (STYLES[show.face]) rows.push(choiceRow(key + '-style', k('xmenu_pump_style'), show.style, STYLES[show.face].map((s) => [s, k('xmenu_pump_style_' + s)]), (s) => apply({ style: s })));
  if (Array.isArray(show.readings)) rows.push(readingsRow(key, show.readings, apply));
  if (show.face === 'clock') rows.push(clockRow(key, show, apply));
  return rows;
}

// The setup this screen still matches, or '' once the person changed its faces.
function setupOf(screen) {
  const faces = (s) => JSON.stringify([s.base, s.moments]);
  return Model.SETUP_NAMES.find((n) => faces(Model.withSetup(screen, n)) === faces(screen)) || '';
}

const ruleName = (when) => (when.any.length > 1 ? k('xmenu_when_many', { n: when.any.length })
  : when.any[0].app ? { text: LayerWhen.appName(when.any[0].app) } : k('xmenu_sit_' + when.any[0].c));

// Why the pump shows what it shows: chosen by hand, the screens are off, a moment, or its usual face.
function whyText(now, screen, st = {}) {
  if (!now) return null;
  const said = { pinned: 'xmenu_pump_why_pinned', screensOff: 'xmenu_pump_why_off', base: 'xmenu_pump_why_base' }[now.why];
  const moment = said ? null : screen.moments.find((m) => LayerWhen.format(m.when) === now.why);
  return [{ pair: [k('xmenu_pump_now_is'), showLabel(now.show, st)] }, said ? k(said) : moment ? ruleName(moment.when) : null].filter(Boolean);
}

function showsTab(v, st) {
  const { screen: id, base } = v;
  /** @type {any[]} rows of several kinds, a button among them */
  const rows = [{
    kind: 'mode', id: 'pump-setup', label: k('xmenu_pump_setup'), value: setupOf(v),
    options: Model.SETUP_NAMES.map((n) => ({ value: n, label: k('pump_setup_' + n), sub: k('xmenu_pump_setup_' + n + '_sub'), act: run({ type: 'pumpSetup', screen: id, setup: n }) })),
  }, choiceRow('pump-base', k('xmenu_pump_base'), pickOf(base), allFaces(v, st), (f) => pumpSet(id, { base: showOf(v, f) }), k(widgetOff(base, st) ? 'xmenu_pump_widget_off' : 'xmenu_pump_base_sub')),
  ...faceRows('pump', base, (p) => pumpSet(id, { base: p }))];
  if (base.face === 'picture') {
    const art = Faces.OWN_ART.includes(base.items[0]) ? base.items[0] : '';
    // A picture of the person's own (the button above the tabs) lights none of Xenon's own.
    const own = art ? undefined : k('xmenu_pump_art_own');
    rows.push(choiceRow('pump-art', k('xmenu_pump_art'), art, Faces.OWN_ART.map((a) => [a, k('xmenu_pump_art_' + a.slice(4))]), (a) => pumpSet(id, { base: { items: [a] } }), own));
  }
  const pinned = v.now && v.now.why === 'pinned' ? v.now.show.face : 'auto';
  rows.push(choiceRow('pump-now', k('xmenu_pump_now'), pinned, [['auto', faceLabel('auto')], ...faceOptions()], (f) => ({ type: 'pumpFace', screen: id, face: f }), whyText(v.now, v, st)));
  // More faces: the Store's widgets made for pump screens, which join the list above once installed.
  rows.push({ kind: 'button', id: 'pump-store', label: k('xmenu_pump_store'), sub: k('xmenu_pump_store_sub'), action: k('xmenu_open'), act: open('store:__pump'), closes: true });
  return { id: 'shows', label: k('xmenu_scr_shows'), value: v.now ? showLabel(v.now.show, st) : null, rows };
}

// A plain situation this PC can tell that no moment uses yet.
function freeSituations(v, st) {
  const used = new Set(v.moments.filter((m) => m.when.any.length === 1).map((m) => m.when.any[0].c));
  return LayerWhen.PLAIN.filter((c) => !used.has(c) && (c !== 'call' || st.probes?.situationCall));
}

function momentsTab(v, st) {
  const id = v.screen;
  const withShow = (i, show) => pumpSet(id, { moments: v.moments.map((x, j) => (j === i ? { ...x, show } : x)) });
  const rows = v.moments.flatMap((m, i) => {
    const swap = (f) => (f === 'off' ? pumpSet(id, { removeMoment: i }) : withShow(i, showOf(v, f)));
    // The moment's name and the face it picks can be the same word (Game, Music): the line says which is which.
    const sub = m.when.any.length === 1 && m.when.any[0].c === 'time' ? { text: m.when.any[0].from + ' - ' + m.when.any[0].to } : k('xmenu_pump_m_sub');
    return [choiceRow('pump-m-' + i, ruleName(m.when), pickOf(m.show), [...allFaces(v, st), ['off', k('xmenu_pump_m_off')]], swap, sub),
      ...faceRows('pump-m-' + i, m.show, (p) => withShow(i, { ...m.show, ...p }))];
  });
  const free = freeSituations(v, st);
  if (v.moments.length < Model.MAX_MOMENTS && free.length) {
    rows.push(choiceRow('pump-add', k('xmenu_pump_add'), '', free.map((c) => [c, k('xmenu_sit_' + c)]),
      (c) => pumpSet(id, { addMoment: { when: { any: [{ c }] }, show: faceFor(v, MOMENT_FACE[c] || 'clock') } }), k('xmenu_pump_add_sub')));
  }
  return { id: 'moments', label: k('xmenu_pump_moments'), value: { text: String(v.moments.length) }, rows };
}

function alertsTab(v, st) {
  const id = v.screen;
  const a = v.alerts;
  const kinds = Model.ALERTS.filter((x) => x !== 'call' || st.probes?.situationCall);
  /** @type {any[]} */
  const rows = kinds.map((x) => toggleRow('pump-a-' + x, k('xmenu_pump_alert_' + x), a[x], pumpSet(id, { alerts: { [x]: true } }), pumpSet(id, { alerts: { [x]: false } })));
  rows.push(choiceRow('pump-secs', k('xmenu_pump_secs'), a.seconds, Model.ALERT_SECONDS.map((s) => [s, k('xmenu_pump_secs_n', { n: s })]), (s) => pumpSet(id, { alerts: { seconds: s } })));
  rows.push(toggleRow('pump-hide', k('xmenu_pump_hide_text'), a.hideText, pumpSet(id, { alerts: { hideText: true } }), pumpSet(id, { alerts: { hideText: false } }), k('xmenu_pump_hide_text_sub')));
  return { id: 'alerts', label: k('xmenu_pump_alerts'), value: { text: String(kinds.filter((x) => a[x]).length) }, rows };
}

// The ring of lights around the pump (pump-screen/ring.js): painted through iCUE, so only
// where iCUE runs, and led by the first pump screen when there are several.
function ledRows(v, sound) {
  const id = v.screen;
  const leds = v.leds;
  // "Every other light too" only when the ring follows the screen: there is no screen colour otherwise.
  const all = leds.follow === 'screen'
    ? [toggleRow('pump-leds-all', k('xmenu_pump_leds_all'), leds.all, pumpSet(id, { leds: { all: true } }), pumpSet(id, { leds: { all: false } }), k('xmenu_pump_leds_all_sub'))]
    : [];
  // The pulse needs colours of the ring's own, and a PC that can tell how loud it is (Windows).
  const pulse = sound && (leds.follow === 'screen' || leds.follow === 'theme')
    ? [toggleRow('pump-leds-pulse', k('xmenu_pump_leds_pulse'), leds.pulse, pumpSet(id, { leds: { pulse: true } }), pumpSet(id, { leds: { pulse: false } }), k('xmenu_pump_leds_pulse_sub'))]
    : [];
  return [choiceRow('pump-leds', k('xmenu_pump_leds'), leds.follow, Model.LED_FOLLOW.map((f) => [f, k('xmenu_pump_leds_' + f)]), (f) => pumpSet(id, { leds: { follow: f } }), k('xmenu_pump_leds_sub')), ...pulse, ...all];
}

function lookTab(v, ring, sound) {
  const id = v.screen;
  const look = v.look;
  const night = look.night ? { text: look.night.from + ' - ' + look.night.to } : k('xmenu_pump_night_sub');
  return {
    id: 'look', label: k('xmenu_pump_look'), value: null,
    rows: [
      ...(ring ? ledRows(v, sound) : []),
      choiceRow('pump-rotate', k('xmenu_pump_rotate'), look.rotate, Model.ROTATIONS.map((r) => [r, { text: r + '°' }]), (r) => pumpSet(id, { look: { rotate: r } }), k('xmenu_pump_rotate_sub')),
      choiceRow('pump-dim', k('xmenu_pump_dim'), look.dim, DIMS.map((d) => [d, { text: d + '%' }]), (d) => pumpSet(id, { look: { dim: d } })),
      toggleRow('pump-night', k('xmenu_pump_night'), !!look.night, pumpSet(id, { look: { night: NIGHT } }), pumpSet(id, { look: { night: null } }), night),
      toggleRow('pump-fade', k('xmenu_pump_fade'), look.fade, pumpSet(id, { look: { fade: true } }), pumpSet(id, { look: { fade: false } })),
    ],
  };
}

// How the screen looks on the desk: round, square, or a panel in the proportions the pump
// reported (seen w/h), turned as it is mounted, so a panel turned a quarter stands on its
// short side. `turn` is the mounting, which the menu's picture undoes so the face reads
// upright, as the person sees it on the pump.
const RATIO_MIN = 0.25;
const RATIO_MAX = 4;
function drawnShape(v) {
  const shape = v.seen?.shape || 'round';
  const turn = Number(v.look?.rotate) || 0;
  const w = Number(v.seen?.w);
  const h = Number(v.seen?.h);
  const panel = shape === 'wide' && w > 0 && h > 0 ? w / h : 1;
  const ratio = Math.min(RATIO_MAX, Math.max(RATIO_MIN, turn % 180 ? 1 / panel : panel));
  return { shape, ratio: Math.round(ratio * 1000) / 1000, turn };
}

function pumpView(v, st, many, first) {
  const label = v.name ? { text: v.name } : many ? { text: v.screen } : k('xmenu_pump');
  return {
    key: 'pump:' + v.screen, pump: v.screen, label, ...drawnShape(v),
    chip: v.now ? showLabel(v.now.show, st) : null,
    tabs: [showsTab(v, st), momentsTab(v, st), alertsTab(v, st), lookTab(v, first && st.pump.icue === true, st.pump.sound === true)],
  };
}

// A pump plugged in that never showed Xenon: the one step that puts Xenon on it.
function addView(pump, st) {
  const rows = pump.route === 'icue'
    ? [{ kind: 'button', id: 'pump-icue', label: k('xmenu_pump_icue'), sub: k('xmenu_pump_icue_sub'), action: k('xmenu_pump_icue_go'), act: run({ type: 'pumpIcue' }), primary: true, off: !st.pump.icue }]
    : [{ kind: 'status', id: 'pump-cam', label: k('xmenu_pump_cam'), sub: k('xmenu_pump_cam_sub'), value: { text: st.pump.url } }];
  return { key: 'pump-add', add: true, label: k('xmenu_pump_add_screen'), shape: 'round', ratio: 1, turn: 0, chip: null, tabs: [{ id: 'setup', label: k('xmenu_pump_add_screen'), value: null, rows }] };
}

// → the cards under the desk: one per pump screen, or the step for a pump just found.
function pumpViews(st) {
  const p = st.pump;
  if (!p) return [];
  const screens = Array.isArray(p.screens) ? p.screens : [];
  if (screens.length) return screens.map((v, i) => pumpView(v, st, screens.length > 1, i === 0));
  const found = Array.isArray(p.detected) ? p.detected[0] : null;
  return found ? [addView(found, st)] : [];
}

module.exports = { pumpViews, setupOf, whyText };
