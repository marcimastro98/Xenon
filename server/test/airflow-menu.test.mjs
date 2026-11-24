// The Fans section of the Xenon menu (server/menu/menu-airflow.js + menu-airflow-fans.js):
// the head says what the fans do and why, the first steps lead from the check to driving,
// and the four tabs hold only rows the menu already draws, each change an Airflow action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';
import { airflowView, newView, NOW } from './airflow-view-fixture.mjs';

const require = createRequire(import.meta.url);
const { airflowSection, stepOf, NIGHT_HOURS } = require('../menu/menu-airflow.js');
const { codeKey } = require('../menu/menu-airflow-fans.js');
const { validateAction } = require('../js/deck/deck-actions.js');
const Model = require('../js/airflow/airflow-model.js');

const dict = (() => {
  const src = appStringsSource();
  const ctx = {};
  vm.runInNewContext(src.slice(0, src.search(/^function /m)) + '\nthis.i18n = i18n;', ctx);
  return ctx.i18n;
})();
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];
const MIN = 60000;

const section = (v) => airflowSection({ airflow: v })[0];
const tab = (row, id) => row.tabs.find((t) => t.id === id);
const rowOf = (rows, id) => rows.find((r) => r.id === id);
const keyOf = (t) => t && t.key;
function walk(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === 'object') { visit(node); Object.values(node).forEach((v) => walk(v, visit)); }
}

// One of every state, phase, reason, problem and health line the section can draw.
function everyView() {
  const views = [airflowView(), newView(), airflowView({ state: 'pc', mode: 'pc' }), airflowView({ drive: 'shadow', state: 'watching', shadow: null })];
  for (const phase of ['starting', 'spin', 'pair', 'sweep', 'start']) views.push(newView({ state: 'checking', check: { phase, progress: 0.4 } }));
  for (const why of ['cancel', 'stop', 'timeout', 'no-reading', 'no-fans', 'save', 'hot', 'weird']) views.push(newView({ checkEnded: { at: NOW - MIN, ok: false, why } }));
  views.push(airflowView({ checkEnded: { at: NOW - MIN, ok: true } }));
  for (const why of ['no-service', 'outdated', 'access', 'no-control', 'no-mode', 'weird']) views.push(newView({ state: 'unavailable', unavailable: { lhm: why } }));
  for (const why of ['hot', 'stall', 'sensor', 'brain', 'impossible', 'game-prepare', 'heat-gpu', 'heat-cpu', 'call-quiet', 'night-quiet', 'spike-ignored', 'learning', 'idle']) views.push(airflowView({ why }));
  for (const mode of Model.MODES) views.push(airflowView({ mode }));
  views.push(airflowView({ drive: 'shadow', state: 'watching', shadow: { minutes: 42, quieterDb: 4.6, changesNow: 30, changesXenon: 4 } }));
  views.push(airflowView({ drive: 'shadow', state: 'watching', shadow: { minutes: 42, quieterDb: 0.2, changesNow: 3, changesXenon: 3 } }));
  const fans = airflowView().fans;
  views.push(airflowView({ fans: [
    ...Model.CHECK_PROBLEMS.map((p, i) => ({ ...fans[0], id: 'p' + i, problem: p })),
    ...['readonly', 'leave', 'unchecked', 'three-pin', 'blind', 'brain', 'sensor', 'stall'].map((why, i) => ({ ...fans[0], id: 'w' + i, why })),
  ] }));
  views.push(airflowView({ health: { slow: [{ id: 'lhm:chip0:0', ratio: 0.8 }], dust: { cpu: { warmer: 0.12, dusty: true }, gpu: { warmer: 0.01, dusty: false } }, cleaned: '2026-11-20', gain: { cpu: 3.2, gpu: 0.2 } } }));
  views.push(airflowView({ options: { night: { on: false, from: 23, to: 7 }, callQuiet: false, allowZero: true }, lastCheck: null }));
  views.push(airflowView({ unavailable: { link: 'link-off' } }), newView({ unavailable: { link: 'link-off' } }));
  for (const why of ['no-service', 'outdated']) views.push(airflowView({ unavailable: { lhm: why } }));
  views.push(airflowView({ unavailable: { hwmon: 'access' } }));
  views.push(newView({ fans: [...fans, { ...fans[3], id: 'lhm:gpu0:1' }, { ...fans[0], id: 'hub:1', source: 'hub' }, { ...fans[2], id: 'hub:2', source: 'hub' }] }));
  views.push(newView({ fans: [{ ...fans[0], id: 'hub:1', source: 'hub' }], unavailable: { link: null } }));
  views.push(newView({ fans: [], options: { ...airflowView().options, linkHub: true }, unavailable: { link: 'link-off' } }));
  for (const why of ['vendor-app', 'no-hub', 'weird']) views.push(airflowView({ unavailable: { link: why }, options: { ...airflowView().options, linkHub: true } }));
  views.push(airflowView({ fans: [...fans, { ...fans[2], id: 'pd', pumpBy: 'device' }, { ...fans[2], id: 'pn', pumpBy: 'name' }, { ...fans[0], id: 'hub:9', checked: false, why: 'unchecked' }] }));
  return views;
}

test('every text key the Fans section can show exists in all 11 languages', () => {
  const keys = new Set();
  for (const v of everyView()) walk(section(v), (n) => { if (typeof n.key === 'string' && !n.type) keys.add(n.key); });
  assert.ok(keys.size > 120, 'the states above reach most of the strings: ' + keys.size);
  for (const lang of LANGS) for (const key of keys) assert.ok(typeof dict[lang][key] === 'string' && dict[lang][key], lang + ' ' + key);
});

test('every change the section makes is an action the registry accepts', () => {
  const acts = [];
  for (const v of everyView()) walk(section(v), (n) => { if (n.run) acts.push(n.run); });
  assert.ok(acts.length > 50);
  for (const a of acts) assert.ok(validateAction(a), 'rejected: ' + JSON.stringify(a));
  assert.ok(!acts.some((a) => /duty|pwm/i.test(JSON.stringify(a))), 'no action carries a raw speed');
});

test('nothing when Airflow is away or the state is malformed', () => {
  assert.deepEqual(airflowSection({}), []);
  assert.deepEqual(airflowSection({ airflow: null }), []);
  assert.deepEqual(airflowSection({ airflow: { state: 'off' } }), [], 'no fan list');
  assert.deepEqual(airflowSection({ airflow: { fans: [] } }), [], 'no state');
});

test('first steps: check, then watch or drive, then drive or stop watching', () => {
  const one = section(newView());
  assert.equal(stepOf(newView()), 1);
  assert.equal(one.head.title.key, 'airflow_state_off_new');
  assert.deepEqual(one.steps.list.map(keyOf), ['airflow_step_find', 'airflow_step_check', 'airflow_step_watch', 'airflow_step_drive']);
  assert.equal(one.steps.at, 1);
  assert.equal(one.steps.sub.key, 'airflow_step_check_sub');
  assert.deepEqual(one.head.actions.map((a) => a.act.run), [{ type: 'airflowCheck', do: 'start' }]);
  assert.deepEqual(one.head.line.map(keyOf), ['airflow_found_board', 'airflow_found_gpu_one'], 'what was found, place by place');
  assert.equal(one.how.open, true, 'how Airflow thinks is open before the first check');

  const checked = newView({ fans: airflowView().fans.map((f) => ({ ...f, xenon: false })) });
  const two = section(checked);
  assert.equal(two.steps.at, 2);
  assert.equal(two.head.title.key, 'airflow_state_off', 'checked once: not new any more');
  assert.deepEqual(two.head.actions.map((a) => JSON.parse(a.act.run.patch)), [{ drive: 'shadow' }, { drive: 'on' }]);
  assert.equal(two.head.actions[0].primary, true, 'watching first is the suggested way');

  const three = section(airflowView({ drive: 'shadow', state: 'watching' }));
  assert.equal(three.steps.at, 3);
  assert.deepEqual(three.head.actions.map((a) => JSON.parse(a.act.run.patch)), [{ drive: 'on' }, { drive: 'off' }]);

  assert.equal(section(airflowView()).steps, null, 'driving: no steps left');
  assert.equal(stepOf(newView({ state: 'unavailable' })), null);
});

test('the drive switch waits for the check, and can always be turned off', () => {
  const before = rowOf(tab(section(newView()), 'now').rows, 'airflow-drive');
  assert.equal(before.on, false);
  assert.equal(before.acts.on, undefined, 'nothing measured: nothing to drive yet');
  assert.equal(before.sub.key, 'airflow_drive_first');
  assert.equal(tab(section(newView()), 'now').rows.length, 1, 'off: no mode until Xenon drives or watches');
  const on = rowOf(tab(section(airflowView()), 'now').rows, 'airflow-drive');
  assert.equal(on.on, true);
  assert.deepEqual(JSON.parse(on.acts.off.run.patch), { drive: 'off' });
});

test('mode and the quiet-or-cool slider: the slider only in Automatic, on its nearest stop', () => {
  const rows = tab(section(airflowView({ slider: 62 })), 'now').rows;
  const mode = rowOf(rows, 'airflow-mode');
  assert.deepEqual(mode.options.map((o) => o.value), [...Model.MODES]);
  assert.deepEqual(mode.options[1].act.run, { type: 'airflowMode', mode: Model.MODES[1] });
  assert.equal(mode.sub.key, 'airflow_mode_auto_sub');
  const slider = rowOf(rows, 'airflow-slider');
  assert.equal(slider.value, '50');
  assert.deepEqual(slider.options.map((o) => o.value), ['0', '25', '50', '75', '100']);
  assert.equal(rowOf(tab(section(airflowView({ mode: 'quiet' })), 'now').rows, 'airflow-slider'), undefined);
});

test('the check: progress in percent, the phase in words, a way to stop', () => {
  const row = section(newView({ state: 'checking', check: { phase: 'sweep', progress: 0.456 } }));
  assert.equal(row.head.title.key, 'airflow_state_checking');
  assert.equal(row.head.line.key, 'airflow_check_sweep');
  assert.equal(row.head.progress, 46);
  assert.deepEqual(row.head.actions[0].act.run, { type: 'airflowCheck', do: 'cancel' });
  assert.equal(section(newView({ state: 'checking', check: null })).head.line.key, 'airflow_check_starting');
});

test('a check that ended says so for ten minutes, an unknown reason as "other"', () => {
  const done = section(airflowView({ checkEnded: { at: NOW - MIN, ok: true } })).head.ended;
  assert.deepEqual(done, { text: { key: 'airflow_check_done', vars: { n: 3 } }, tone: 'on' });
  assert.equal(section(newView({ checkEnded: { at: NOW - MIN, ok: false, why: 'no-reading' } })).head.ended.text.key, 'airflow_check_end_no_reading');
  assert.equal(section(newView({ checkEnded: { at: NOW - MIN, ok: false, why: 'x<y' } })).head.ended.text.key, 'airflow_check_end_other');
  assert.equal(section(newView({ checkEnded: { at: NOW - 11 * MIN, ok: true } })).head.ended, null, 'old news');
});

test('unavailable: the reason, the way out, and no tabs to play with', () => {
  const service = section(newView({ state: 'unavailable', unavailable: { lhm: 'no-service' } }));
  assert.equal(service.head.tone, 'warn');
  assert.equal(service.head.line.key, 'airflow_unavail_no_service');
  assert.deepEqual(service.head.actions[0].act, { open: 'settings:performance' });
  assert.deepEqual(service.tabs, []);
  const linux = section(newView({ state: 'unavailable', unavailable: { hwmon: 'access' } }));
  assert.match(linux.head.command, /udevadm control --reload-rules/);
  assert.deepEqual(linux.head.actions, [], 'the line is pasted by hand, never run for the person');
  const both = section(newView({ state: 'unavailable', unavailable: { hwmon: 'no-control', lhm: 'outdated' } }));
  assert.equal(both.head.line.key, 'airflow_unavail_outdated', 'a reason with a fix wins');
  assert.equal(section(newView({ state: 'unavailable', unavailable: { lhm: '../x' } })).head.line.key, 'airflow_unavail_other');
});

// On a real PC the LINK hub kept driving while the sensor service was out of date: the head
// said all was calm, the board's and the card's fans were gone from the list, and nothing
// said how to bring them back (23 Nov 2026).
test('some fans answer and some do not: the head says which stay with the PC and the way out', () => {
  const stale = section(airflowView({ unavailable: { lhm: 'outdated', link: null } })).head;
  assert.deepEqual(stale.part.map(keyOf), ['airflow_part_pc', 'airflow_unavail_outdated']);
  assert.deepEqual(stale.actions.map((a) => [a.act, a.primary]), [[{ open: 'settings:performance' }, true]]);
  assert.equal(stale.line.key, 'airflow_why_idle', 'what the fans Xenon drives do stays the line');
  const first = section(newView({ unavailable: { lhm: 'no-service' } })).head;
  assert.equal(first.part[1].key, 'airflow_unavail_no_service');
  assert.deepEqual(first.actions.filter((a) => a.primary).map((a) => a.label.key), ['airflow_btn_check'], 'the first step keeps the lead');
  assert.ok(first.actions.some((a) => a.act.open === 'settings:performance'));
  const linux = section(airflowView({ unavailable: { hwmon: 'access', link: null } })).head;
  assert.match(linux.command, /udevadm control --reload-rules/);
  assert.deepEqual(linux.actions, [], 'the line is pasted by hand, never run for the person');
  for (const calm of [{}, { lhm: 'no-control' }, { hwmon: 'no-mode' }, { link: 'link-off' }, { link: 'vendor-app' }, { lhm: '__proto__' }]) {
    const h = section(airflowView({ unavailable: calm })).head;
    assert.equal(h.part, null, JSON.stringify(calm));
    assert.equal(h.command, null, JSON.stringify(calm));
  }
});

test('while Xenon drives or watches, the line is the reason; trouble reads as a warning', () => {
  assert.equal(section(airflowView({ why: 'spike-ignored' })).head.line.key, 'airflow_why_spike_ignored');
  assert.equal(section(airflowView({ why: 'spike-ignored' })).head.tone, 'none');
  for (const why of ['hot', 'stall', 'sensor', 'brain', 'impossible']) assert.equal(section(airflowView({ why })).head.tone, 'warn', why);
  assert.equal(section(airflowView({ why: null })).head.line.key, 'airflow_why_idle');
  assert.equal(section(airflowView({ state: 'pc', mode: 'pc' })).head.line.key, 'airflow_pc_line');
});

test('watching: the estimated gain, or a wait line until there are minutes enough', () => {
  const watch = (shadow) => section(airflowView({ drive: 'shadow', state: 'watching', shadow })).head.score;
  assert.deepEqual(watch(null).map(keyOf), ['airflow_score_wait']);
  assert.deepEqual(watch({ minutes: 0, quieterDb: 3 }).map(keyOf), ['airflow_score_wait']);
  const s = watch({ minutes: 42, quieterDb: 4.6, changesNow: 30, changesXenon: 4 });
  assert.deepEqual(s.map(keyOf), ['airflow_score_quieter', 'airflow_score_changes', 'airflow_score_minutes']);
  assert.equal(s[0].vars.db, 5);
  assert.equal(watch({ minutes: 42, quieterDb: 0.4, changesNow: 2, changesXenon: 2 })[0].key, 'airflow_score_same');
  assert.equal(section(airflowView()).head.score, null, 'driving: no score');
});

test('fans: one card each with speed, who drives it and the line that matters most', () => {
  const v = airflowView({ fans: [
    { ...airflowView().fans[0], problem: 'no-start', why: 'leave' },
    { ...airflowView().fans[1], why: 'three-pin' },
    { ...airflowView().fans[3] },
  ] });
  const fans = tab(section(v), 'fans').fans;
  assert.deepEqual(fans.map((f) => [f.rpm, f.duty, f.by]), [[813, 31, 'xenon'], [760, 30, 'xenon'], [0, 0, 'pc']]);
  assert.deepEqual(fans.map((f) => [f.note.text.key, f.note.tone]), [
    ['airflow_problem_no_start', 'warn'], ['airflow_fan_why_three_pin', 'warn'], ['airflow_fan_why_readonly', 'none'],
  ]);
  const watching = tab(section(airflowView({ state: 'watching', drive: 'shadow' })), 'fans').fans;
  assert.deepEqual(watching[0].note.text, { key: 'airflow_would', vars: { n: 31 } });
  assert.equal(tab(section(airflowView({ fans: [{ ...airflowView().fans[0], why: '<script>' }] })), 'fans').fans[0].note, null, 'an unknown code shows nothing');
  const [front] = airflowView().fans;
  const beta = tab(section(airflowView({ fans: [{ ...front, beta: true }, { ...front, id: 'u1', beta: true, xenon: false, why: 'unproven' }, { ...front, id: 'h1', beta: true, problem: 'no-handback', xenon: false }] })), 'fans').fans;
  assert.deepEqual(beta.map((f) => [f.note.text.key, f.note.tone]), [['airflow_fan_beta', 'none'], ['airflow_fan_why_unproven', 'none'], ['airflow_problem_no_handback', 'warn']],
    'a model Xenon never tried says so: driven, waiting for its proof, or failed it');
});

test('fans: an empty header says so, a pump at full is no fault, a fan Xenon stopped says why', () => {
  const [front] = airflowView().fans;
  const v = airflowView({ fans: [
    { ...front, id: 'e1', why: 'blind', rpm: 0, duty: null, xenon: false },
    { ...front, id: 'e2', why: 'blind', rpm: 640, duty: null, xenon: false },
    { ...front, id: 'p1', kind: 'pump', why: 'three-pin', rpm: 2300, duty: null, xenon: false },
    { ...front, id: 'f1', why: 'three-pin', rpm: 1900, duty: null, xenon: false },
    { ...front, id: 'g1', rpm: 0, duty: 0 },
  ] });
  const fans = tab(section(v), 'fans').fans;
  assert.deepEqual(fans.map((f) => f.empty), [true, false, false, false, false], 'only a blind header that does not turn is empty');
  assert.deepEqual(fans.map((f) => [f.note.text.key, f.note.tone]), [
    ['airflow_fan_empty', 'none'], ['airflow_fan_why_blind', 'none'], ['airflow_fan_why_pump_full', 'none'],
    ['airflow_fan_why_three_pin', 'warn'], ['airflow_fan_resting', 'none'],
  ]);
});

test('fans: the tab says there is nothing to set only once the fans were checked', () => {
  assert.equal(tab(section(airflowView()), 'fans').intro.key, 'airflow_fans_intro');
  assert.equal(tab(section(newView()), 'fans').intro, null);
});

test('a fan card: leave it to the PC, a pump, and where it sits', () => {
  const [front, , pump] = tab(section(airflowView()), 'fans').fans;
  assert.deepEqual(front.rows.map((r) => r.id), ['airflow-leave-lhm:chip0:0', 'airflow-pump-lhm:chip0:0', 'airflow-place-lhm:chip0:0']);
  assert.deepEqual(JSON.parse(front.rows[0].acts.on.run.patch), { fan: { id: 'lhm:chip0:0', leave: true } });
  assert.equal(pump.kind, 'pump');
  assert.equal(pump.rows[1].on, true);
  const place = front.rows[2];
  assert.equal(place.value, 'front');
  assert.deepEqual(place.options.map((o) => o.value), [...Model.PLACES]);
  assert.deepEqual(JSON.parse(place.options[1].act.run.patch), { fan: { id: 'lhm:chip0:0', place: Model.PLACES[1] } });
});

test('a pump by its device or its name says why and has no switch; one the person marked can be taken back', () => {
  const pump = airflowView().fans[2];
  const cards = tab(section(airflowView({ fans: [
    { ...pump, id: 'd', pumpBy: 'device' }, { ...pump, id: 'n', pumpBy: 'name' }, { ...pump, id: 'p', pumpBy: 'person' },
  ] })), 'fans').fans;
  const [byDevice, byName, byPerson] = cards.map((c) => c.rows[1]);
  assert.equal(byDevice.kind, 'status');
  assert.equal(keyOf(byDevice.sub), 'airflow_fan_pump_by_device');
  assert.equal(keyOf(byDevice.value), 'airflow_fan_pump_yes');
  assert.equal(byName.kind, 'status');
  assert.equal(keyOf(byName.sub), 'airflow_fan_pump_by_name');
  assert.equal(byPerson.kind, 'toggle');
  assert.equal(byPerson.on, true);
  assert.deepEqual(JSON.parse(byPerson.acts.off.run.patch), { fan: { id: 'p', pump: false } });
});

test('fans found after the check: the check at the top, and the Fans tab says so', () => {
  const fans = airflowView().fans;
  const hub = { ...fans[0], id: 'hub:link:13', source: 'hub', xenon: false, checked: false, why: 'unchecked' };
  const row = section(airflowView({ fans: [...fans, hub] }));
  const check = row.head.actions.find((a) => keyOf(a.label) === 'airflow_btn_check_new');
  assert.deepEqual(check.label.vars, { n: 1 });
  assert.deepEqual(check.act.run, { type: 'airflowCheck', do: 'start' });
  assert.equal(check.primary, true);
  assert.equal(keyOf(tab(row, 'fans').intro), 'airflow_fans_intro_new');
  // Left to the PC: nothing new to check, the usual line.
  const left = section(airflowView({ fans: [...fans, { ...hub, leave: true }] }));
  assert.ok(!left.head.actions.some((a) => keyOf(a.label) === 'airflow_btn_check_new'));
  assert.equal(keyOf(tab(left, 'fans').intro), 'airflow_fans_intro');
  // The first run already offers the check: never a second button for it.
  assert.equal(section(newView()).head.actions.filter((a) => a.act?.run?.type === 'airflowCheck').length, 1);
});

test('health: dust, a slower fan, what cleaning gained, the last check', () => {
  const rows = tab(section(airflowView({ health: {
    slow: [{ id: 'lhm:chip0:1', ratio: 0.82 }, { id: 'gone', ratio: 0.5 }],
    dust: { cpu: { warmer: 0.124, dusty: true }, gpu: { warmer: 0.01, dusty: false } },
    cleaned: '2026-11-20', gain: { cpu: 3.24, gpu: 0.3 },
  } })), 'health').rows;
  assert.deepEqual(rowOf(rows, 'airflow-dust-cpu').value, { key: 'airflow_dust_warmer', vars: { n: 12 } });
  assert.equal(rowOf(rows, 'airflow-dust-cpu').tone, 'warn');
  assert.equal(rowOf(rows, 'airflow-dust-gpu').value.key, 'airflow_dust_ok');
  assert.deepEqual(rowOf(rows, 'airflow-slow-lhm:chip0:1').value, { key: 'airflow_wear_slow', vars: { n: 18 } });
  assert.equal(rowOf(rows, 'airflow-slow-lhm:chip0:1').label.text, 'Rear');
  assert.equal(rowOf(rows, 'airflow-slow-gone'), undefined, 'a fan no longer there is not named');
  assert.deepEqual(rowOf(rows, 'airflow-gain-cpu').value, { key: 'airflow_gain', vars: { n: 3.2 } });
  assert.equal(rowOf(rows, 'airflow-gain-gpu').value.key, 'airflow_gain_none', 'half a degree is noise');
  assert.deepEqual(JSON.parse(rowOf(rows, 'airflow-cleaned').act.run.patch), { cleaned: true });
  assert.equal(rowOf(rows, 'airflow-cleaned').sub.pair[0].key, 'airflow_cleaned_on');
  const fresh = tab(section(newView()), 'health').rows;
  assert.equal(rowOf(fresh, 'airflow-dust-cpu').value.key, 'airflow_dust_learning');
  assert.equal(rowOf(fresh, 'airflow-last-check').value.key, 'airflow_never_checked');
});

test('options: night hours only when night is on, an hour set elsewhere kept among the choices', () => {
  const rows = tab(section(airflowView({ options: { night: { on: true, from: 21, to: 6 }, callQuiet: true, allowZero: false, riseAlert: true } })), 'options').rows;
  const hours = rowOf(rows, 'airflow-night-hours');
  assert.equal(hours.value, '21-6');
  assert.deepEqual(hours.options.map((o) => o.value), ['21-6', ...NIGHT_HOURS.map(([f, t]) => `${f}-${t}`)]);
  assert.equal(hours.options[0].label.text, '21:00–06:00');
  assert.deepEqual(JSON.parse(hours.options[1].act.run.patch), { night: { from: 22, to: 7 } });
  const off = tab(section(airflowView({ options: { night: { on: false, from: 23, to: 7 }, callQuiet: false, allowZero: true, riseAlert: false } })), 'options').rows;
  assert.equal(rowOf(off, 'airflow-night-hours'), undefined);
  assert.equal(rowOf(off, 'airflow-zero').on, true);
  const rise = rowOf(off, 'airflow-rise');
  assert.equal(rise.on, false);
  assert.equal(keyOf(rise.sub), 'airflow_rise_alert_sub');
  assert.deepEqual(JSON.parse(rise.acts.on.run.patch), { riseAlert: true });
  assert.equal(rowOf(rows, 'airflow-rise').on, true, 'the notice is on unless switched off');
  assert.deepEqual(rowOf(off, 'airflow-recheck').act.run, { type: 'airflowCheck', do: 'start' });
});

test('the LINK hub switch: only on a PC with one or once allowed, saying why it waits', () => {
  const linkRow = (unavailable, linkHub) => rowOf(tab(section(airflowView({ unavailable, options: { ...airflowView().options, linkHub } })), 'options').rows, 'airflow-link');
  assert.equal(linkRow({}, false), undefined);
  assert.equal(linkRow({ link: 'no-hub' }, false), undefined);
  const off = linkRow({ link: 'link-off' }, false);
  assert.equal(off.on, false);
  assert.equal(keyOf(off.sub), 'airflow_link_hub_sub');
  assert.deepEqual(JSON.parse(off.acts.on.run.patch), { linkHub: true });
  assert.equal(keyOf(linkRow({ link: 'vendor-app' }, true).sub), 'airflow_link_hub_busy');
  assert.equal(keyOf(linkRow({ link: 'no-hub' }, true).sub), 'airflow_link_hub_none');
  const held = linkRow({}, true);
  assert.equal(held.on, true);
  assert.equal(keyOf(held.sub), 'airflow_link_hub_sub');
  assert.deepEqual(JSON.parse(held.acts.off.run.patch), { linkHub: false });
  // Held, with a device whose lights Xenon cannot lay out yet: it says they stay off.
  const dark = rowOf(tab(section(airflowView({ unavailable: {}, hubLights: 'unknown-leds', options: { ...airflowView().options, linkHub: true } })), 'options').rows, 'airflow-link');
  assert.equal(keyOf(dark.sub), 'airflow_link_hub_dark');
  const waiting = rowOf(tab(section(airflowView({ unavailable: { link: 'vendor-app' }, hubLights: 'unknown-leds', options: { ...airflowView().options, linkHub: true } })), 'options').rows, 'airflow-link');
  assert.equal(keyOf(waiting.sub), 'airflow_link_hub_busy', 'not held: why it waits comes first');
});

test('codes become keys with underscores, never anything else', () => {
  assert.equal(codeKey('airflow_why_', 'spike-ignored'), 'airflow_why_spike_ignored');
  assert.equal(codeKey('airflow_problem_', 'pump-stopped'), 'airflow_problem_pump_stopped');
});
