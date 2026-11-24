'use strict';
// Xenon drawing on a pump screen by itself, over USB (pump-screen/direct.js), in the Xenon
// menu: one switch that says what happens now (drawing, paused while the screen's own program
// is open, stopped and trying again) and, after a failure, a way to try again at once. On the
// card of a pump just found and in a pump's Look tab. Shown only where Xenon can do it
// (`st.pump.direct`, Windows and Linux) and a screen it has a driver for is plugged in. Pure.

const { k, run, toggleRow } = require('./menu-rows.js');

const SUBS = Object.freeze({
  off: 'xmenu_pump_direct_off_sub', none: 'xmenu_pump_direct_none_sub', busy: 'xmenu_pump_direct_busy_sub',
  drawing: 'xmenu_pump_direct_drawing_sub', failed: 'xmenu_pump_direct_failed_sub',
});
const set = (on) => ({ type: 'pumpDirect', on });

// Whether the switch belongs on the page: Xenon can draw here and one such screen is plugged in.
function directShown(st) {
  const d = st.pump?.direct;
  if (!d) return false;
  return d.state === 'drawing' || d.state === 'busy' || d.state === 'failed'
    || (Array.isArray(st.pump.detected) && st.pump.detected.some((p) => p?.direct));
}

/** @returns {any[]} the switch, and "Try again" after a failure */
function directRows(st) {
  if (!directShown(st)) return [];
  const d = st.pump.direct;
  const now = d.on ? (SUBS[d.state] && d.state !== 'off' ? d.state : 'none') : 'off';
  const sub = now === 'busy' ? k(SUBS.busy, { app: d.app || 'iCUE' }) : k(SUBS[now]);
  /** @type {any[]} */
  const rows = [toggleRow('pump-direct', k('xmenu_pump_direct'), d.on, set('on'), set('off'), sub)];
  if (d.on && now === 'failed') {
    rows.push({ kind: 'button', id: 'pump-direct-retry', label: k('xmenu_pump_direct_retry'), action: k('xmenu_pump_direct_retry'), act: run(set('on')) });
  }
  return rows;
}

module.exports = { directRows, directShown };
