// tools/airflow-live: one look at a running Airflow becomes one record and one line,
// and a line is printed only when something a person would notice changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { differs, line, summarize } from '../../tools/airflow-live/summary.mjs';
import { airflowView, newView, NOW } from './airflow-view-fixture.mjs';

const SVC = {
  v: 1, gen: 7, guard: null, hot: false,
  temps: { cpu: 46.04, gpu: 41.5, gpuMem: 50, liquid: null },
  controls: [{ k: 0, id: '/lpc/chip/0/control/2', held: 'set', duty: 31.6 }, { k: 1, id: '/lpc/chip/0/control/0', held: null }],
};

test('a look keeps the state, the hands and each fan, rounded', () => {
  const s = summarize(airflowView(), SVC, NOW);
  assert.equal(s.state, 'driving');
  assert.deepEqual(s.temps, { cpu: 46, gpu: 41.5, gpuMem: 50, liquid: null });
  assert.deepEqual(s.hands, { gen: 7, guard: null, hot: false, held: [{ id: '/lpc/chip/0/control/2', held: 'set', duty: 32 }] });
  assert.deepEqual(s.fans[0], { id: 'lhm:chip0:0', name: 'Front', rpm: 813, duty: 31, planned: 31, xenon: true, why: null, problem: null });
  assert.equal(s.fans.length, 4);
  assert.equal(summarize(airflowView(), { ...SVC, temps: { cpu: 52.8 } }, NOW).temps.cpu, 52.8, 'no float tail');
});

test('a failed answer and a missing service are said, not guessed', () => {
  const s = summarize({ ok: false, error: 'unavailable' }, null, NOW);
  assert.equal(s.ok, false);
  assert.equal(s.hands, null);
  assert.match(line(s), / unavailable$/);
  assert.equal(summarize(null, null, NOW).fans.length, 0);
});

test('the line names state, temperatures, held controls and which fans Xenon drives', () => {
  const text = line(summarize(airflowView({ check: { step: 'lower', progress: 0.42 } }), { ...SVC, hot: true, guard: 'hot' }, NOW));
  assert.match(text, /driving on auto idle check lower 42%/);
  assert.match(text, /cpu 46° gpu 41\.5°/);
  assert.match(text, /hands 1 held guard hot HOT/);
  assert.match(text, /Front 813rpm\/31%\*/);
  assert.match(text, /GPU 0rpm\/0%(,|$)/);
});

test('a line only when something noticeable changed', () => {
  const a = summarize(airflowView(), SVC, NOW);
  const wobble = summarize(airflowView({ fans: airflowView().fans.map((f) => ({ ...f, rpm: f.rpm + 20 })) }), SVC, NOW + 2000);
  assert.equal(differs(a, wobble), false, 'an RPM wobble is not news');
  assert.equal(differs(a, summarize(newView(), SVC, NOW)), true);
  assert.equal(differs(a, summarize(airflowView(), { ...SVC, guard: 'lease' }, NOW)), true, 'the hands taking over is news');
  assert.equal(differs(null, a), true);
});
