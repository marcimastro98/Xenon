// The fan check's last step for controls Xenon never tried on real hardware
// (server/airflow/calibrate-back.js): such a control counts as checked only once its
// fan was seen going back to the PC when let go. Unit rules, then the whole check on
// the pretend board (tools/airflow-sim/bench.mjs) with a beta card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBench, defaultBench } from '../../tools/airflow-sim/bench.mjs';

const require = createRequire(import.meta.url);
const { createBackStep, DROP, BACK_MS, MIN_TOP_RPM } = require('../airflow/calibrate-back.js');
const { createFanCheck } = require('../airflow/calibrate.js');
const { budgetMs, cleanChannels } = require('../airflow/calibrate-plan.js');
const { createSafety } = require('../airflow/safety.js');

const GPU = 'lhm:gpu:control-1';

test('back step: full until let go, then nothing held', () => {
  const b = createBackStep({ ids: ['a', 'b'] });
  assert.deepEqual(b.targets(), { a: 100, b: 100 });
  assert.equal(b.down, false);
  assert.equal(b.progress(), 0);
  b.letGo(1000, { a: 1500, b: 2000 });
  assert.deepEqual(b.targets(), {}, 'from now on the PC has them');
  assert.equal(b.down, true);
});

test('back step: a clear fall is proof, a small one or a still fan is not', () => {
  const b = createBackStep({ ids: ['fall', 'noise', 'still'] });
  b.letGo(0, { fall: 2000, noise: 2000, still: MIN_TOP_RPM - 1 });
  assert.equal(b.watch(1000, { fall: 2000 * (1 - DROP), noise: 1950, still: 0 }), false);
  assert.equal(b.proven('fall'), true);
  assert.equal(b.proven('noise'), false, 'a reading\'s wobble is not a hand-back');
  assert.equal(b.proven('still'), false, 'a fan not turning at full cannot show a fall');
  assert.equal(b.progress(), 0.5 + 0.5 / 3);
  assert.equal(b.watch(BACK_MS - 1, { noise: 1950, still: 0 }), false);
  assert.equal(b.watch(BACK_MS, { noise: 1950, still: 0 }), true, 'the wait is over');
  assert.equal(b.proven('noise'), false);
});

test('back step: done as soon as every fan is proven; a slow driver waits longer', () => {
  const quick = createBackStep({ ids: ['a'] });
  quick.letGo(0, { a: 1000 });
  assert.equal(quick.watch(2000, { a: 600 }), true);
  assert.equal(quick.progress(), 1);
  const slow = createBackStep({ ids: ['a'], waitMs: BACK_MS * 2 });
  slow.letGo(0, { a: 1000 });
  assert.equal(slow.watch(BACK_MS, { a: 1000 }), false);
  assert.equal(slow.watch(BACK_MS * 2, { a: 1000 }), true);
});

test('plan: a beta control is kept as such, and its last step has time in the budget', () => {
  const [beta, plain] = cleanChannels([{ id: GPU, beta: true }, { id: 'lhm:board:control-1', beta: 'yes' }]);
  assert.equal(beta.beta, true);
  assert.equal(plain.beta, false, 'only a real true counts');
  assert.ok(budgetMs([beta]) >= budgetMs([plain]) + BACK_MS);
});

/** The check through the real safety layer, as the engine runs it. */
function runCheck(bench) {
  const check = createFanCheck({ channels: bench.channels(), clock: bench.now });
  const safety = createSafety({ clock: bench.now });
  const phases = new Set();
  const progress = [];
  let view = check.view();
  let lastAsked = {};
  while (!view.done && bench.now() < 15 * 60000) {
    const reading = bench.read();
    view = check.step(reading);
    phases.add(view.phase);
    progress.push(view.progress);
    const v = safety.check({
      temps: { cpu: { value: 45, at: bench.now() } }, channels: check.safetyChannels(reading),
      plan: { at: bench.now(), targets: view.targets, allowZero: true },
    });
    lastAsked = Object.fromEntries(Object.entries(v.channels).filter(([, x]) => x.action === 'set').map(([id, x]) => [id, x.duty]));
    bench.apply(lastAsked);
    bench.advance(1000);
  }
  return { view, phases, progress, lastAsked };
}

function benchWithBetaCard(extra) {
  const spec = defaultBench();
  spec.controls = spec.controls.map((c) => (c.id === GPU ? { ...c, beta: true, ...extra } : c));
  return createBench(spec);
}

test('check: a beta card that slows down when let go is proven, the others untouched by the rule', () => {
  const { view, phases, progress } = runCheck(benchWithBetaCard());
  assert.equal(view.why, null);
  assert.ok(phases.has('back'));
  assert.equal(view.result.calibs[GPU].handBack, true);
  assert.equal(view.result.problems[GPU], undefined);
  assert.ok(view.result.calibs['lhm:board:control-1'], 'a tried control needs no proof');
  assert.equal(view.result.problems['lhm:board:control-1'], undefined);
  assert.ok(progress.every((p, i) => i === 0 || p >= progress[i - 1]), 'progress never goes back');
  assert.equal(progress.at(-1), 1);
});

test('check: a beta card that stays where Xenon left it is not driven, and says so', () => {
  const { view, lastAsked } = runCheck(benchWithBetaCard({ keepsLast: true }));
  assert.equal(view.why, null);
  assert.equal(view.result.calibs[GPU].handBack, false);
  assert.equal(view.result.problems[GPU], 'no-handback');
  assert.deepEqual(lastAsked, {}, 'every fan is handed back at the end');
});

test('check: with no beta control there is no last step', () => {
  const { view, phases } = runCheck(createBench(defaultBench()));
  assert.equal(view.why, null);
  assert.equal(phases.has('back'), false);
});
