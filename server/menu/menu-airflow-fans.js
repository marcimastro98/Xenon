'use strict';
// The Fans and Health tabs of the Xenon menu's Fans section (menu-airflow.js): every fan
// and pump with its speed, who drives it and why, and its choices (left to the PC, where it
// sits, a pump); then how the cooling holds up over the weeks (dust, a fan slower than when
// it was checked, what cleaning gained) and the last fan check. Pure.

const Model = require('../js/airflow/airflow-model.js');
const { k, run, choiceRow, toggleRow } = require('./menu-rows.js');
const { agoText } = require('./menu-now.js');

const set = (patch) => ({ type: 'airflowSet', patch: JSON.stringify(patch) });
const CHECK = Object.freeze({ type: 'airflowCheck', do: 'start' });
// Codes are kebab-case, i18n keys snake_case: 'no-speed' is airflow_problem_no_speed.
const codeKey = (prefix, code) => prefix + String(code).replace(/-/g, '_');

const GAIN_FELT = 0.5;
const FAN_WHYS = Object.freeze(['readonly', 'leave', 'unchecked', 'three-pin', 'blind', 'unproven', 'brain', 'sensor', 'stall']);

// A header that gave no speed and shows none: most likely nothing is plugged in.
const isEmpty = (f) => f.why === 'blind' && !(Number(f.rpm) > 0);

// One line under a fan's name: what went wrong at the check, why the PC has it, why it
// stands still, or what Xenon would set while it only watches.
function noteOf(f, v) {
  if (f.problem && Model.CHECK_PROBLEMS.includes(f.problem)) return { text: k(codeKey('airflow_problem_', f.problem)), tone: 'warn' };
  if (isEmpty(f)) return { text: k('airflow_fan_empty'), tone: 'none' };
  // A pump the board runs at full speed is normal, not a 3-pin fan to fix in the BIOS.
  if (f.kind === 'pump' && f.why === 'three-pin') return { text: k('airflow_fan_why_pump_full'), tone: 'none' };
  if (f.why && FAN_WHYS.includes(f.why)) return { text: k(codeKey('airflow_fan_why_', f.why)), tone: ['stall', 'sensor', 'three-pin'].includes(f.why) ? 'warn' : 'none' };
  if (f.xenon && Number(f.rpm) === 0 && Number(f.duty) === 0) return { text: k('airflow_fan_resting'), tone: 'none' };
  if (v.state === 'watching' && Number.isFinite(f.planned)) return { text: k('airflow_would', { n: Math.round(f.planned) }), tone: 'none' };
  // Driven, on a control Xenon never tried on real hardware: the person knows it is new ground.
  if (f.beta) return { text: k('airflow_fan_beta'), tone: 'none' };
  return null;
}

// A card's channels are controls, not fans: one control can move two of its fans (an RTX 5080
// with three fans has two), so a control is named as one unless the person renamed it.
function nameOf(f, gpuControls) {
  if (f.source !== 'gpu' || f.named) return { text: f.name || f.id };
  const n = /(\d+)\s*$/.exec(String(f.name || ''));
  if (gpuControls === 1) return k('airflow_gpu_fans');
  return n ? k('airflow_gpu_control', { n: Number(n[1]) }) : { text: f.name || f.id };
}

// A pump by the device or by its name stays one whatever the mark says (never stopped), so
// only a pump the person marked themselves gets a switch; the others say why they are one.
function pumpRow(f, fan) {
  const id = 'airflow-pump-' + f.id;
  if (f.kind === 'pump' && (f.pumpBy === 'device' || f.pumpBy === 'name')) {
    return { kind: 'status', id, label: k('airflow_fan_pump'), sub: k('airflow_fan_pump_by_' + f.pumpBy), value: k('airflow_fan_pump_yes'), tone: 'none' };
  }
  return toggleRow(id, k('airflow_fan_pump'), f.kind === 'pump', fan({ pump: true }), fan({ pump: false }), k('airflow_fan_pump_sub'));
}

/** One card per fan and pump (empty headers flagged, drawn apart); the drawer keeps their speeds current. */
function fansTab(v) {
  const gpuControls = v.fans.filter((f) => f.source === 'gpu').length;
  return v.fans.map((f) => {
    const fan = (patch) => set({ fan: { id: f.id, ...patch } });
    return {
      id: f.id, name: nameOf(f, gpuControls), kind: f.kind === 'pump' ? 'pump' : 'fan',
      rpm: Number.isFinite(f.rpm) ? Math.round(f.rpm) : null,
      duty: Number.isFinite(f.duty) ? Math.round(f.duty) : null,
      by: f.xenon ? 'xenon' : 'pc',
      note: noteOf(f, v),
      empty: isEmpty(f),
      rows: [
        toggleRow('airflow-leave-' + f.id, k('airflow_fan_leave'), f.leave, fan({ leave: true }), fan({ leave: false }), k('airflow_fan_leave_sub')),
        pumpRow(f, fan),
        choiceRow('airflow-place-' + f.id, k('airflow_fan_place'), f.place || 'case', Model.PLACES.map((p) => [p, k('airflow_place_' + p)]), (p) => fan({ place: p })),
      ],
    };
  });
}

// How much warmer than when clean a part runs, once there are weeks enough to say.
function dustRow(id, label, dust) {
  if (!dust) return { kind: 'status', id, label: k(label), value: k('airflow_dust_learning'), tone: 'none' };
  if (dust.dusty) return { kind: 'status', id, label: k(label), value: k('airflow_dust_warmer', { n: Math.round(dust.warmer * 100) }), tone: 'warn' };
  return { kind: 'status', id, label: k(label), value: k('airflow_dust_ok'), tone: 'on' };
}

function healthTab(v) {
  const h = v.health || {};
  const names = new Map(v.fans.map((f) => [f.id, f.name || f.id]));
  /** @type {any[]} rows of several kinds */
  const rows = [
    dustRow('airflow-dust-cpu', 'airflow_dust_cpu', h.dust?.cpu),
    dustRow('airflow-dust-gpu', 'airflow_dust_gpu', h.dust?.gpu),
  ];
  for (const s of h.slow || []) {
    if (!names.has(s.id)) continue;
    rows.push({ kind: 'status', id: 'airflow-slow-' + s.id, label: { text: names.get(s.id) }, value: k('airflow_wear_slow', { n: Math.round((1 - s.ratio) * 100) }), tone: 'warn' });
  }
  for (const node of ['cpu', 'gpu']) {
    const gain = h.gain?.[node];
    if (!Number.isFinite(gain)) continue;
    // Half a degree is within a day's noise: below it the cleaning made no difference yet.
    const felt = gain >= GAIN_FELT;
    rows.push({ kind: 'status', id: 'airflow-gain-' + node, label: k('airflow_gain_' + node), value: felt ? k('airflow_gain', { n: Math.round(gain * 10) / 10 }) : k('airflow_gain_none'), tone: felt ? 'on' : 'none' });
  }
  rows.push(
    { kind: 'button', id: 'airflow-cleaned', label: k('airflow_cleaned'), sub: h.cleaned ? { pair: [k('airflow_cleaned_on'), agoText(v.at - Date.parse(h.cleaned + 'T12:00'))] } : k('airflow_cleaned_sub'), action: k('airflow_btn_cleaned'), act: run(set({ cleaned: true })) },
    { kind: 'status', id: 'airflow-last-check', label: k('airflow_last_check'), value: v.lastCheck ? agoText(v.at - v.lastCheck.at) : k('airflow_never_checked'), tone: 'none' },
  );
  return rows;
}

module.exports = { fansTab, healthTab, set, CHECK, codeKey };
