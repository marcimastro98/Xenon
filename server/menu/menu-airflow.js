'use strict';
// The Fans section of the Xenon menu (Airflow, server/airflow/): what the fans do now and
// why (or what it found, menu-airflow-found.js), how Airflow thinks, the first steps
// (find the fans, check them, watch, drive), then four tabs: Now, Fans, Health, Options.
// One row of kind 'airflow' that js/menu/xenon-menu-airflow.js draws; the switches and choices inside it are the menu's usual rows. Every change is an
// Airflow action (js/capabilities/catalog-airflow.js), the same a Deck key, a paired phone
// and Bit run. Reason codes become keys with '_' for '-'. Pure.

const Model = require('../js/airflow/airflow-model.js');
const { k, run, open, choiceRow, toggleRow } = require('./menu-rows.js');
const { agoText } = require('./menu-now.js');
const { fansTab, healthTab, set, CHECK, codeKey } = require('./menu-airflow-fans.js');
const { accessCommand } = require('../airflow/linux-access.js');
const { foundLines, hubAction, howItThinks } = require('./menu-airflow-found.js');

const STOP = Object.freeze({ type: 'airflowCheck', do: 'cancel' });
const SLIDER_STOPS = Object.freeze([0, 25, 50, 75, 100]);
const NIGHT_HOURS = Object.freeze([[22, 7], [23, 7], [0, 8]]);
// A check that ended this recently is still worth a line at the top.
const ENDED_SHOWN_MS = 10 * 60 * 1000;
const CHECK_ENDS = Object.freeze(['cancel', 'stop', 'timeout', 'no-reading', 'no-fans', 'save', 'hot']);
// Reasons that mean something is wrong, not just what the fans are doing.
const WARN_WHYS = Object.freeze(['hot', 'stall', 'sensor', 'brain', 'impossible']);
// What the person can do about a part that does not answer: on Windows the sensor service
// (Settings, Performance installs or updates it), on Linux one line in a terminal.
const FIX = Object.freeze({
  'no-service': { label: 'airflow_btn_sensors', act: open('settings:performance') },
  outdated: { label: 'airflow_btn_update', act: open('settings:performance') },
});
const UNAVAILABLE_KNOWN = Object.freeze(['no-service', 'outdated', 'access', 'no-control', 'no-mode']);
// Why a LINK hub the person allowed is not driven, in their words.
const LINK_WHY = Object.freeze({ 'vendor-app': 'airflow_link_hub_busy', 'no-hub': 'airflow_link_hub_none' });

const checked = (v) => v.fans.some((f) => f.checked && !f.leave);
// Fans that came after the last check (a hub let go by its own app): Xenon needs one more.
const newFans = (v) => v.fans.filter((f) => f.why === 'unchecked' && !f.leave).length;
const hours = ([from, to]) => `${String(from).padStart(2, '0')}:00–${String(to).padStart(2, '0')}:00`;

// The step of the first run, or null once Xenon drives (or cannot).
function stepOf(v) {
  if (v.state === 'unavailable' || v.drive === 'on') return null;
  if (v.drive === 'shadow') return 3;
  return checked(v) ? 2 : 1;
}

function unavailableHead(v) {
  const whys = Object.values(v.unavailable || {});
  const why = whys.find((w) => FIX[w]) || whys.find((w) => UNAVAILABLE_KNOWN.includes(w)) || 'other';
  return {
    title: k('airflow_state_unavailable'), line: k(codeKey('airflow_unavail_', why)), tone: 'warn',
    command: why === 'access' ? accessCommand() : null,
    actions: FIX[why] ? [{ label: k(FIX[why].label), act: FIX[why].act, primary: true }] : [],
  };
}

// Some fans answer and some do not (the LINK hub drives, the sensor service is out of date):
// the head says the board's and the card's fans stay with the PC, and the way out.
function partOf(v) {
  const why = Object.values(v.unavailable || {}).find((w) => Object.hasOwn(FIX, w) || w === 'access');
  if (!why) return null;
  return {
    part: [k('airflow_part_pc'), k(codeKey('airflow_unavail_', why))],
    command: why === 'access' ? accessCommand() : null,
    actions: Object.hasOwn(FIX, why) ? [{ label: k(FIX[why].label), act: FIX[why].act }] : [],
  };
}

function scoreOf(shadow) {
  if (!shadow || shadow.minutes < 1 || shadow.quieterDb == null) return [k('airflow_score_wait')];
  return [
    shadow.quieterDb >= 1 ? k('airflow_score_quieter', { db: Math.round(shadow.quieterDb) }) : k('airflow_score_same'),
    k('airflow_score_changes', { now: shadow.changesNow, xenon: shadow.changesXenon }),
    k('airflow_score_minutes', { n: shadow.minutes }),
  ];
}

// What the first steps offer at the top: the check, then watching, then driving.
function stepActions(step) {
  if (step === 1) return [{ label: k('airflow_btn_check'), act: run(CHECK), primary: true }];
  if (step === 2) return [{ label: k('airflow_btn_watch'), act: run(set({ drive: 'shadow' })), primary: true }, { label: k('airflow_btn_drive_now'), act: run(set({ drive: 'on' })) }];
  if (step === 3) return [{ label: k('airflow_btn_drive'), act: run(set({ drive: 'on' })), primary: true }, { label: k('airflow_btn_off'), act: run(set({ drive: 'off' })) }];
  return [];
}

// A check that ended a moment ago: done, or why it stopped.
function endedLine(v) {
  const e = v.checkEnded;
  if (!e || v.state === 'checking' || !(v.at - e.at < ENDED_SHOWN_MS)) return null;
  if (e.ok) return { text: k('airflow_check_done', { n: v.fans.filter((f) => f.checked).length }), tone: 'on' };
  return { text: k(codeKey('airflow_check_end_', CHECK_ENDS.includes(e.why) ? e.why : 'other')), tone: 'warn' };
}

function headOf(v, step) {
  if (v.state === 'unavailable') return unavailableHead(v);
  if (v.state === 'checking') {
    const phase = v.check?.phase || 'starting';
    return {
      title: k('airflow_state_checking'), line: k(codeKey('airflow_check_', phase)), tone: 'none',
      progress: Math.round((v.check?.progress || 0) * 100), actions: [{ label: k('airflow_btn_stop'), act: run(STOP) }],
    };
  }
  const live = v.state === 'driving' || v.state === 'watching';
  const title = v.state === 'off' && step === 1 ? 'airflow_state_off_new' : 'airflow_state_' + v.state;
  // The first step already offers the check; later, fans found since then get it at the top.
  const recheck = step !== 1 && newFans(v) ? [{ label: k('airflow_btn_check_new', { n: newFans(v) }), act: run(CHECK), primary: !step }] : [];
  const part = partOf(v);
  const actions = [...recheck, ...stepActions(step), ...(live ? [] : hubAction(v))];
  // The way out leads only when nothing else does.
  const fix = (part?.actions || []).map((a) => ({ ...a, primary: !actions.some((b) => b.primary) }));
  return {
    title: k(title),
    line: live ? k(codeKey('airflow_why_', v.why || 'idle')) : v.state === 'pc' ? k('airflow_pc_line') : foundLines(v),
    tone: live && WARN_WHYS.includes(v.why) ? 'warn' : 'none',
    score: v.state === 'watching' ? scoreOf(v.shadow) : null,
    ended: endedLine(v),
    part: part?.part || null,
    command: part?.command || null,
    actions: [...fix, ...actions],
  };
}

function nowTab(v) {
  const can = checked(v);
  /** @type {any[]} rows of several kinds */
  const rows = [toggleRow('airflow-drive', k('airflow_drive'), v.drive === 'on', set({ drive: 'on' }), set({ drive: 'off' }), k(can ? 'airflow_drive_sub' : 'airflow_drive_first'))];
  // Before any fan was checked there is nothing to drive: the switch waits for the check.
  if (!can && v.drive !== 'on') rows[0].acts = { off: run(set({ drive: 'off' })) };
  if (v.drive === 'off') return rows;
  rows.push(choiceRow('airflow-mode', k('airflow_mode'), v.mode, Model.MODES.map((m) => [m, k('airflow_mode_' + m)]), (m) => ({ type: 'airflowMode', mode: m }), k('airflow_mode_' + v.mode + '_sub')));
  if (v.mode === 'auto') {
    const near = SLIDER_STOPS.reduce((a, b) => (Math.abs(b - v.slider) < Math.abs(a - v.slider) ? b : a));
    rows.push(choiceRow('airflow-slider', k('airflow_slider'), near, SLIDER_STOPS.map((n, i) => [n, k('airflow_slider_' + i)]), (n) => set({ slider: n })));
  }
  return rows;
}

// Only on a PC with an iCUE LINK hub, or once allowed (so it can be turned off again).
function linkHubRow(v) {
  const on = v.options.linkHub === true;
  const why = v.unavailable?.link;
  if (!on && why !== 'link-off') return null;
  // Held, but a device on it has lights Xenon cannot lay out yet: they stay off, and it says so.
  const dark = on && !why && v.hubLights;
  const sub = on && LINK_WHY[why] ? LINK_WHY[why] : dark ? 'airflow_link_hub_dark' : 'airflow_link_hub_sub';
  return toggleRow('airflow-link', k('airflow_link_hub'), on, set({ linkHub: true }), set({ linkHub: false }), k(sub));
}

function optionsTab(v) {
  const night = v.options.night;
  /** @type {any[]} rows of several kinds */
  const rows = [toggleRow('airflow-night', k('airflow_night'), night.on, set({ night: { on: true } }), set({ night: { on: false } }), k('airflow_night_sub'))];
  if (night.on) {
    const value = `${night.from}-${night.to}`;
    const options = NIGHT_HOURS.map(([from, to]) => [`${from}-${to}`, { text: hours([from, to]) }]);
    if (!options.some(([id]) => id === value)) options.unshift([value, { text: hours([night.from, night.to]) }]);
    rows.push(choiceRow('airflow-night-hours', k('airflow_night_hours'), value, options, (id) => {
      const [from, to] = String(id).split('-').map(Number);
      return set({ night: { from, to } });
    }));
  }
  rows.push(
    toggleRow('airflow-call', k('airflow_call_quiet'), v.options.callQuiet, set({ callQuiet: true }), set({ callQuiet: false }), k('airflow_call_quiet_sub')),
    toggleRow('airflow-zero', k('airflow_allow_zero'), v.options.allowZero, set({ allowZero: true }), set({ allowZero: false }), k('airflow_allow_zero_sub')),
    toggleRow('airflow-rise', k('airflow_rise_alert'), v.options.riseAlert, set({ riseAlert: true }), set({ riseAlert: false }), k('airflow_rise_alert_sub')),
  );
  const link = linkHubRow(v);
  if (link) rows.push(link);
  rows.push(
    {
      kind: 'button', id: 'airflow-recheck', label: k('airflow_recheck'),
      sub: v.lastCheck ? { pair: [k('airflow_last_check'), agoText(v.at - v.lastCheck.at)] } : k('airflow_never_checked'),
      action: k('airflow_btn_recheck'), act: run(CHECK),
    },
    // After a new cooler, case or fans: the fan checks and the choices above stay.
    { kind: 'button', id: 'airflow-relearn', label: k('airflow_relearn'), sub: k('airflow_relearn_sub'), action: k('airflow_btn_relearn'), act: run(set({ relearn: true })) },
  );
  return rows;
}

// Over the fan cards: nothing to set once checked, unless fans came after the check.
function introOf(v) {
  if (!checked(v)) return null;
  const n = newFans(v);
  return n ? k('airflow_fans_intro_new', { n }) : k('airflow_fans_intro');
}

/** The Fans section's rows from the menu state's `airflow` (actions.view()), or none. */
function airflowSection(st) {
  const v = st.airflow;
  if (!v?.state || !Array.isArray(v.fans)) return [];
  const step = stepOf(v);
  const tabs = v.state === 'unavailable' ? [] : [
    { id: 'now', label: k('airflow_tab_now'), rows: nowTab(v) },
    // Once checked there is nothing to set: the tab says so before the cards.
    { id: 'fans', label: k('airflow_tab_fans'), fans: fansTab(v), intro: introOf(v) },
    { id: 'health', label: k('airflow_tab_health'), rows: healthTab(v) },
    { id: 'options', label: k('airflow_tab_options'), rows: optionsTab(v) },
  ];
  return [{
    kind: 'airflow', id: 'airflow', state: v.state, head: headOf(v, step),
    how: v.state === 'unavailable' ? null : howItThinks(step),
    steps: step ? { at: step, list: ['find', 'check', 'watch', 'drive'].map((s) => k('airflow_step_' + s)), sub: k('airflow_step_' + ['find', 'check', 'watch', 'drive'][step] + '_sub') } : null,
    tabs,
  }];
}

module.exports = { airflowSection, stepOf, NIGHT_HOURS, SLIDER_STOPS };
