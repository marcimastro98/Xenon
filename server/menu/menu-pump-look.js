'use strict';
// A pump's Alerts and Look tabs in the Xenon menu (menu-pump.js): what comes over its face and
// for how long, the ring of lights around it, and how the screen sits and dims. Pure.

const Model = require('../js/pump/pump-model.js');
const { k, run, choiceRow, toggleRow } = require('./menu-rows.js');

const NIGHT = Object.freeze({ from: '23:00', to: '07:00', dim: 30 });
const DIMS = Object.freeze([100, 75, 50, 25]);
// The alerts in the order people meet them: what arrives most often first.
const ALERT_ORDER = Object.freeze(['notify', 'discord', 'call', 'timer', 'hot']);
const pumpSet = (screen, patch) => ({ type: 'pumpSet', screen, patch: JSON.stringify(patch) });
const note = (id, key) => ({ kind: 'pumpnote', id, label: k(key) });
const head = (id, key) => ({ kind: 'tunehead', id, label: k(key) });
const flag = (id, key, on, screen, part, name, sub) => toggleRow(id, k(key), on,
  pumpSet(screen, { [part]: { [name]: true } }), pumpSet(screen, { [part]: { [name]: false } }), sub ? k(sub) : undefined);

function alertsTab(v, st) {
  const id = v.screen;
  const a = v.alerts;
  const kinds = [...ALERT_ORDER.filter((x) => Model.ALERTS.includes(x)), ...Model.ALERTS.filter((x) => !ALERT_ORDER.includes(x))]
    .filter((x) => x !== 'call' || st.probes?.situationCall);
  /** @type {any[]} */
  const rows = [note('pump-a-intro', 'xmenu_pump_alerts_intro'), head('pump-a-which', 'xmenu_pump_alerts_which')];
  rows.push(...kinds.map((x) => flag('pump-a-' + x, 'xmenu_pump_alert_' + x, a[x], id, 'alerts', x, 'xmenu_pump_alert_' + x + '_sub')));
  rows.push(choiceRow('pump-secs', k('xmenu_pump_secs'), a.seconds, Model.ALERT_SECONDS.map((s) => [s, k('xmenu_pump_secs_n', { n: s })]), (s) => pumpSet(id, { alerts: { seconds: s } })));
  rows.push(flag('pump-hide', 'xmenu_pump_hide_text', a.hideText, id, 'alerts', 'hideText', 'xmenu_pump_hide_text_sub'));
  return { id: 'alerts', label: k('xmenu_pump_alerts'), value: null, rows };
}

// The ring of lights around the pump (pump-screen/ring.js): painted through iCUE, so only where
// iCUE runs, and led by the first pump screen when there are several. Each choice is a card with
// the ring drawn in it; the two switches show only where they do something.
function ledRows(v, sound) {
  const id = v.screen;
  const leds = v.leds;
  /** @type {any[]} cards, then switches */
  const rows = [{
    kind: 'pumpcards', id: 'pump-leds', label: k('xmenu_pump_leds'), sub: k('xmenu_pump_leds_sub'), value: leds.follow,
    cards: Model.LED_FOLLOW.map((f) => ({
      value: f, label: k('xmenu_pump_leds_' + f), sub: k('xmenu_pump_leds_' + f + '_sub'), art: 'leds-' + f,
      on: f === leds.follow, act: f === leds.follow ? null : run(pumpSet(id, { leds: { follow: f } })),
    })),
  }];
  // The pulse needs colours of the ring's own, and a PC that can tell how loud it is (Windows).
  if (sound && (leds.follow === 'screen' || leds.follow === 'theme')) rows.push(flag('pump-leds-pulse', 'xmenu_pump_leds_pulse', leds.pulse, id, 'leds', 'pulse', 'xmenu_pump_leds_pulse_sub'));
  // Every other light too only when the ring follows the screen: there is no screen colour otherwise.
  if (leds.follow === 'screen') rows.push(flag('pump-leds-all', 'xmenu_pump_leds_all', leds.all, id, 'leds', 'all', 'xmenu_pump_leds_all_sub'));
  return rows;
}

function lookTab(v, ring, sound) {
  const id = v.screen;
  const look = v.look;
  return {
    id: 'look', label: k('xmenu_pump_look'), value: null,
    rows: [
      ...(ring ? [...ledRows(v, sound), head('pump-screen', 'xmenu_pump_screen')] : []),
      choiceRow('pump-rotate', k('xmenu_pump_rotate'), look.rotate, Model.ROTATIONS.map((r) => [r, { text: r + '°' }]), (r) => pumpSet(id, { look: { rotate: r } }), k('xmenu_pump_rotate_sub')),
      choiceRow('pump-dim', k('xmenu_pump_dim'), look.dim, DIMS.map((d) => [d, { text: d + '%' }]), (d) => pumpSet(id, { look: { dim: d } })),
      toggleRow('pump-night', k('xmenu_pump_night'), !!look.night, pumpSet(id, { look: { night: NIGHT } }), pumpSet(id, { look: { night: null } }),
        k('xmenu_pump_night_at', look.night || NIGHT)),
      flag('pump-fade', 'xmenu_pump_fade', look.fade, id, 'look', 'fade', 'xmenu_pump_fade_sub'),
    ],
  };
}

module.exports = { alertsTab, lookTab, pumpSet };
