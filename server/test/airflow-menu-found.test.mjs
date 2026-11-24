// What the Fans section says it found (server/menu/menu-airflow-found.js): place by place,
// empty headers told apart from turning ones, a graphics card's controls not counted as
// its fans, an iCUE LINK hub named even before Xenon may use it, and "How Airflow
// thinks" in every language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { newView, airflowView } from './airflow-view-fixture.mjs';

const require = createRequire(import.meta.url);
const { foundLines, hubAction, howItThinks, HOW } = require('../menu/menu-airflow-found.js');
const { airflowSection } = require('../menu/menu-airflow.js');
const { fansTab } = require('../menu/menu-airflow-fans.js');

const fan = (id, source, rpm, kind = 'fan') => ({ id, name: id, kind, source, place: source === 'gpu' ? 'gpu' : 'case', rpm, duty: null, xenon: false, checked: false, leave: false, why: 'unchecked', problem: null });
// A board with six headers (four empty), a graphics card whose fans hang on two controls,
// and a LINK hub left alone: the PC that read "8 fans found".
const BOARD = [fan('mb:0', 'mb', 0, 'pump'), fan('mb:1', 'mb', 2184, 'pump'), fan('mb:2', 'mb', 1131), fan('mb:3', 'mb', 0), fan('mb:4', 'mb', 0), fan('mb:5', 'mb', 0)];
const GPU = [fan('gpu:1', 'gpu', 0), fan('gpu:2', 'gpu', 0)];
const view = (over) => newView({ fans: [...BOARD, ...GPU], ...over });
const lines = (v) => foundLines(v).map((l) => [l.key, l.vars || null]);

test('the board says its headers and how many turn; the card says controls, not fans', () => {
  assert.deepEqual(lines(view()), [
    ['airflow_found_board', { n: 6, spin: 2 }],
    ['airflow_found_gpu', { n: 2 }],
  ]);
  assert.deepEqual(lines(view({ fans: [...BOARD, GPU[0]] }))[1], ['airflow_found_gpu_one', null]);
});

// A card with three fans can show two channels (one control moves two fans): the rows say
// "control", so two rows are not read as two fans (asked 23 Nov 2026).
test('the channels of a card are named as controls, a single one as its fans, a given name kept', () => {
  const named = (fans) => fansTab(view({ fans })).filter((f) => f.id.startsWith('gpu')).map((f) => f.name);
  const driver = (id, n) => ({ ...fan(id, 'gpu', 0), name: `GPU Fan ${n}` });
  assert.deepEqual(named([...BOARD, driver('gpu:1', 1), driver('gpu:2', 2)]), [
    { key: 'airflow_gpu_control', vars: { n: 1 } }, { key: 'airflow_gpu_control', vars: { n: 2 } },
  ]);
  assert.deepEqual(named([...BOARD, driver('gpu:1', 1)]), [{ key: 'airflow_gpu_fans' }]);
  assert.deepEqual(named([...BOARD, { ...driver('gpu:1', 1), named: true, name: 'Card' }, driver('gpu:2', 2)])[0], { text: 'Card' });
  assert.deepEqual(fansTab(view()).find((f) => f.id === 'mb:2').name, { text: 'mb:2' }, 'board headers keep their names');
});

test('a LINK hub Xenon may not use yet is named, with the button that allows it', () => {
  const v = view({ unavailable: { link: 'link-off' } });
  assert.deepEqual(lines(v).at(-1), ['airflow_found_hub_off', null]);
  assert.deepEqual(hubAction(v).map((a) => JSON.parse(a.act.run.patch)), [{ linkHub: true }]);
  const head = airflowSection({ airflow: v })[0].head;
  assert.deepEqual(head.actions.map((a) => a.label.key), ['airflow_btn_check', 'airflow_btn_link'], 'the check first, the hub beside it');
});

test('an allowed hub is never offered again: it waits for Airflow, or names who holds it', () => {
  const allowed = (link) => view({ unavailable: { link }, options: { ...newView().options, linkHub: true } });
  // Airflow off: the engine does not ask for the hub, so it reads link-off although allowed.
  assert.deepEqual(lines(allowed('link-off')).at(-1), ['airflow_found_hub_wait', null]);
  assert.deepEqual(hubAction(allowed('link-off')), []);
  assert.deepEqual(lines(allowed('vendor-app')).at(-1), ['airflow_link_hub_busy', null]);
  assert.equal(lines(allowed('no-hub')).length, 2, 'no hub on this PC: no hub line');
  assert.equal(lines(view()).length, 2, 'no hub and never allowed: no hub line');
});

test('a hub Xenon uses is counted: its fans, and its pump apart', () => {
  const hub = [fan('hub:1', 'hub', 900), fan('hub:2', 'hub', 900), fan('hub:3', 'hub', 2400, 'pump')];
  assert.deepEqual(lines(view({ fans: [...BOARD, ...hub] })).at(-1), ['airflow_found_hub_pump', { n: 2 }]);
  assert.deepEqual(lines(view({ fans: hub.slice(0, 2) })), [['airflow_found_hub', { n: 2 }]]);
});

test('older views without a source fall back on the place; nothing found says so', () => {
  const old = BOARD.slice(0, 2).map(({ source, ...f }) => f).concat({ ...GPU[0], source: undefined });
  assert.deepEqual(lines(view({ fans: old })).map((l) => l[0]), ['airflow_found_board', 'airflow_found_gpu_one']);
  assert.deepEqual(lines(view({ fans: [] })), [['airflow_no_fans', null]]);
});

test('how Airflow thinks: every point a name and a text, open only at the first step', () => {
  const h = howItThinks(1);
  assert.equal(h.open, true);
  assert.equal(howItThinks(2).open, false);
  assert.equal(howItThinks(null).open, false);
  assert.deepEqual(h.points.map((p) => p.id), [...HOW]);
  for (const p of h.points) assert.deepEqual([p.title.key, p.text.key], [`airflow_how_${p.id}_t`, `airflow_how_${p.id}`]);
  assert.equal(HOW[0], 'curve', 'why it is not a curve comes first');
  assert.equal(airflowSection({ airflow: airflowView() })[0].how.open, false, 'while driving it is a tap away');
  assert.equal(airflowSection({ airflow: newView({ state: 'unavailable', unavailable: { lhm: 'no-service' } }) })[0].how, null);
});

test('while Xenon drives or watches the line is the reason, and the hub button stays away', () => {
  const head = airflowSection({ airflow: airflowView({ unavailable: { link: 'link-off' } }) })[0].head;
  assert.equal(head.line.key, 'airflow_why_idle');
  assert.deepEqual(head.actions, []);
});
