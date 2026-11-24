'use strict';
// What the Fans section says before Xenon drives (menu-airflow.js): what it found, place
// by place, in sentences a person checks against their own case (the motherboard's
// headers and how many have a fan turning, the graphics card's controls, the iCUE LINK
// hub), and how Airflow thinks, in a few plain points. A header with nothing plugged in
// and a card with three fans on two controls are why a single "fans found" number
// read wrong. Pure.

const { k, run } = require('./menu-rows.js');

const set = (patch) => ({ type: 'airflowSet', patch: JSON.stringify(patch) });
// The points of "How Airflow thinks": why not a curve first, then what it does, safety last.
const HOW = Object.freeze(['curve', 'learn', 'ahead', 'quiet', 'smooth', 'context', 'safe', 'watch']);

// A fan's place in the PC as a driver reports it; older views carry only `place`.
const sourceOf = (f) => f.source || (f.place === 'gpu' ? 'gpu' : 'mb');
const turning = (f) => Number.isFinite(f.rpm) && f.rpm > 0;

// The hub is asked for only while Airflow watches, drives or checks (drivers.js
// linkWanted), so an allowed hub reads 'link-off' too while Airflow is off.
function hubLine(v, hub) {
  const why = v.unavailable?.link;
  if (hub.length) {
    const fans = hub.filter((f) => f.kind !== 'pump').length;
    return k(hub.some((f) => f.kind === 'pump') ? 'airflow_found_hub_pump' : 'airflow_found_hub', { n: fans });
  }
  if (v.options?.linkHub !== true) return why === 'link-off' ? k('airflow_found_hub_off') : null;
  if (why === 'vendor-app') return k('airflow_link_hub_busy');
  return why === 'no-hub' ? null : k('airflow_found_hub_wait');
}

/** The lines under the title: one per place that has fans. */
function foundLines(v) {
  const lines = [];
  const board = v.fans.filter((f) => sourceOf(f) === 'mb');
  if (board.length) lines.push(k('airflow_found_board', { n: board.length, spin: board.filter(turning).length }));
  const gpu = v.fans.filter((f) => sourceOf(f) === 'gpu');
  if (gpu.length) lines.push(gpu.length === 1 ? k('airflow_found_gpu_one') : k('airflow_found_gpu', { n: gpu.length }));
  const hub = hubLine(v, v.fans.filter((f) => sourceOf(f) === 'hub'));
  if (hub) lines.push(hub);
  if (!lines.length) lines.push(k('airflow_no_fans'));
  return lines;
}

/** The button that lets Xenon use a LINK hub it found, offered where the hub is named. */
function hubAction(v) {
  return v.unavailable?.link === 'link-off' && v.options?.linkHub !== true ? [{ label: k('airflow_btn_link'), act: run(set({ linkHub: true })) }] : [];
}

/** How Airflow thinks: open on the first step, a tap away afterwards. */
function howItThinks(step) {
  return {
    open: step === 1,
    title: k('airflow_how_title'),
    points: HOW.map((id) => ({ id, title: k(`airflow_how_${id}_t`), text: k(`airflow_how_${id}`) })),
    foot: k('airflow_how_local'),
  };
}

module.exports = { foundLines, hubAction, howItThinks, HOW };
