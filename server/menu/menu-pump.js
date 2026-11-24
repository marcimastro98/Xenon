'use strict';
// The pump screens in the Screens home of the Xenon menu: one card under the desk for each,
// and for the one tapped its tabs. What it shows: one line per moment, in the order that
// wins when two hold at once, then the rest of the time; each opens on the faces to pick and
// that face's choices. Then a face of the person's own, and the ready-made setups as examples.
// Alerts and Look: menu-pump-look.js; the ring of lights: menu-pump-leds.js. Every change is a pump action
// (js/capabilities/catalog-pump.js), the same Bit and a Deck key run. Pure.

const Model = require('../js/pump/pump-model.js');
const LayerWhen = require('../js/layers/layer-when.js');
const { faceFor } = require('../pump-screen/actions.js');
const { k, run } = require('./menu-rows.js');
const { momentRow, whenLabel, showLabel } = require('./menu-pump-faces.js');
const { alertsTab, lookTab, pumpSet } = require('./menu-pump-look.js');
const { ledsTab } = require('./menu-pump-leds.js');
const { directRows } = require('./menu-pump-direct.js');

// The face a new moment starts with: what that moment is usually for.
const MOMENT_FACE = Object.freeze({ game: 'game', music: 'music', busy: 'sensors', idle: 'picture' });

// A new line for the night: the hours "Darker at night" uses too.
const NIGHT_RULE = Object.freeze({ c: 'time', from: '23:00', to: '07:00' });
const WHY = Object.freeze({ pinned: 'xmenu_pump_why_pinned', screensOff: 'xmenu_pump_why_off', base: 'xmenu_pump_why_rest' });

// Why a line holds now: "because you are playing", or the line's own name for one about an
// app, an hour or several things.
function whyOf(when) {
  const r = when.any.length === 1 ? when.any[0] : null;
  return r && !r.app && LayerWhen.PLAIN.includes(r.c) ? k('xmenu_pump_why_' + r.c) : { pair: [k('xmenu_pump_why_row'), whenLabel(when)] };
}

// What the pump shows now and why, beside its picture; chosen by hand, a way back to automatic.
function nowOf(v, st) {
  const now = v.now;
  if (!now) return null;
  const moment = WHY[now.why] ? null : v.moments.find((m) => LayerWhen.format(m.when) === now.why);
  return {
    caption: k('xmenu_pump_now_is'), what: showLabel(now.show, st),
    why: WHY[now.why] ? k(WHY[now.why]) : moment ? whyOf(moment.when) : null,
    back: now.why === 'pinned' ? { label: k('xmenu_pump_back_auto'), act: run({ type: 'pumpFace', screen: v.screen, face: 'auto' }) } : null,
  };
}

// The lines that can still be added: a plain situation this PC can tell that no line uses
// yet, and the night while no line is about an hour.
function addable(v, st) {
  const used = new Set(v.moments.filter((m) => m.when.any.length === 1).map((m) => m.when.any[0].c));
  const plain = LayerWhen.PLAIN.filter((c) => !used.has(c) && (c !== 'call' || st.probes?.situationCall));
  return [...plain.map((c) => ({ c, rule: { c } })), ...(used.has('time') ? [] : [{ c: 'night', rule: NIGHT_RULE }])];
}

function addRow(v, st) {
  const free = addable(v, st);
  if (v.moments.length >= Model.MAX_MOMENTS || !free.length) return null;
  return {
    kind: 'pumpadd', id: 'pump-add', label: k('xmenu_pump_add'),
    options: free.map(({ c, rule }) => ({
      value: c, label: k('xmenu_pump_when_' + c),
      act: run(pumpSet(v.screen, { addMoment: { when: { any: [rule] }, show: faceFor(v, MOMENT_FACE[c] || 'clock') } })),
    })),
  };
}

// The ready-made setups: one tap fills every line above, then any of it can change. No tick:
// once a line changes, no example is "the one in use".
function examplesRow(v) {
  return {
    kind: 'pumpcards', id: 'pump-setup', plain: true, label: k('xmenu_pump_examples'), sub: k('xmenu_pump_examples_sub'),
    cards: Model.SETUP_NAMES.map((n) => ({
      value: n, label: k('pump_setup_' + n), sub: k('xmenu_pump_setup_' + n + '_sub'),
      act: run({ type: 'pumpSetup', screen: v.screen, setup: n }),
    })),
  };
}

function showsTab(v, st) {
  const id = v.screen;
  const withShow = (i, show) => pumpSet(id, { moments: v.moments.map((x, j) => (j === i ? { ...x, show } : x)) });
  /** @type {any[]} rows of several kinds */
  const rows = [{ kind: 'pumpnote', id: 'pump-intro', label: k('xmenu_pump_auto_intro') }];
  rows.push(...v.moments.map((m, i) => momentRow({
    id: 'pump-m-' + i, label: whenLabel(m.when), show: m.show, v, st, save: (show) => withShow(i, show), remove: pumpSet(id, { removeMoment: i }),
  })));
  rows.push(momentRow({ id: 'pump-base', label: k('xmenu_pump_rest'), show: v.base, v, st, save: (show) => pumpSet(id, { base: show }) }));
  rows.push(...[addRow(v, st), examplesRow(v)].filter(Boolean));
  return { id: 'shows', label: k('xmenu_scr_shows'), value: null, rows };
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

const HEX = /^#[0-9a-f]{6}$/i;
const CARD_COLOURS = 3;

// The ring drawn round the pump's card, as the ring shows it now (pump-screen/ring.js now): its
// effect, speed, way round and colours; the theme's colour where it follows the theme or the
// screen has said none yet. null with no ring to show: dark, or following the other lights.
function cardRing(st) {
  const r = st.pump.ring;
  if (!r || typeof r !== 'object' || r.follow === 'off' || typeof r.effect !== 'string') return null;
  const own = (Array.isArray(r.colours) ? r.colours : []).filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, CARD_COLOURS);
  const accent = typeof st.pump.accent === 'string' && HEX.test(st.pump.accent) ? [st.pump.accent] : [];
  const amounts = Object.fromEntries(['size', 'glow'].filter((key) => Number.isFinite(r[key])).map((key) => [key, r[key]]));
  return { effect: r.effect, speed: r.speed || 'normal', reverse: r.reverse === true, ...amounts, colours: own.length && r.follow !== 'theme' ? own : accent };
}

function pumpView(v, st, many, first) {
  const label = v.name ? { text: v.name } : many ? { text: v.screen } : k('xmenu_pump');
  // The ring of lights is painted through iCUE, or by Xenon itself when it holds the hub
  // (ringHeld), led by the first pump screen when there are several.
  const ring = first && (st.pump.icue === true || st.pump.ringHeld === true);
  return {
    key: 'pump:' + v.screen, pump: v.screen, label, ...drawnShape(v),
    chip: v.now ? showLabel(v.now.show, st) : null, now: nowOf(v, st), ring: ring ? cardRing(st) : null,
    tabs: [showsTab(v, st), alertsTab(v, st), ...(ring ? [ledsTab(v, st)] : []), lookTab(v, st, first)],
  };
}

// A pump plugged in that never showed Xenon: the one step that puts Xenon on it. Through
// iCUE, tapping the card already takes that step (`act`), and the button stays for a second go.
// One Xenon can draw on by itself (direct.js) leads with that switch, and iCUE stays a second
// way only where it is installed, so a pump on Linux never asks for iCUE.
function addView(pump, st) {
  const direct = pump.direct ? directRows(st) : [];
  const icue = pump.route === 'icue';
  const icueRow = { kind: 'button', id: 'pump-icue', label: k('xmenu_pump_icue'), sub: k('xmenu_pump_icue_sub'), action: k('xmenu_pump_icue_go'), act: run({ type: 'pumpIcue' }), primary: !direct.length, off: !st.pump.icue };
  const camRow = { kind: 'status', id: 'pump-cam', label: k('xmenu_pump_cam'), sub: k('xmenu_pump_cam_sub'), value: { text: st.pump.url } };
  const other = icue ? (direct.length && !st.pump.icue ? [] : [icueRow]) : [camRow];
  const open = !direct.length && icue && st.pump.icue ? run({ type: 'pumpIcue' }) : null;
  const chip = direct.length ? 'xmenu_pump_found_direct' : icue ? 'xmenu_pump_found_icue' : 'xmenu_pump_found_cam';
  return {
    key: 'pump-add', add: true, act: open, label: k('xmenu_pump_found'), shape: 'round', ratio: 1, turn: 0,
    chip: k(chip), tabs: [{ id: 'setup', label: k('xmenu_pump_found'), value: null, rows: [...direct, ...other] }],
  };
}

// → the cards under the desk: one per pump screen, or the step for a pump just found.
function pumpViews(st) {
  const p = st.pump;
  if (!p) return [];
  // Only the screens showing Xenon now: one whose widget was taken off in iCUE keeps its
  // settings for when it comes back, but is not drawn (presence.js).
  const screens = (Array.isArray(p.screens) ? p.screens : []).filter((v) => v.here !== false);
  if (screens.length) return screens.map((v, i) => pumpView(v, st, screens.length > 1, i === 0));
  const found = Array.isArray(p.detected) ? p.detected[0] : null;
  return found ? [addView(found, st)] : [];
}

module.exports = { pumpViews, nowOf };
