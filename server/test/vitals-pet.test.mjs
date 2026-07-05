// Bit (vitals pet) core — phrase bank shape, shuffle-bag no-repeat, tone
// filtering and the escalation ladder (vitals-pet-core.js is UMD-lite, so it
// loads under node:test via require).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../js/vitals-pet-core.js');

const VITALS = ['hydration', 'energy', 'stamina', 'focus', 'posture'];
const VITAL_KINDS = ['low', 'zero', 'nag'];
const GENERIC_KINDS = ['gameover', 'alldead', 'welcomeback', 'minwarn', 'minimized', 'lockwarn', 'praise', 'stinger'];

test('phrase bank: both languages cover every bucket with well-formed entries', () => {
  for (const lang of ['it', 'en']) {
    const b = core.BANK[lang];
    assert.ok(b, lang + ' bank exists');
    for (const vital of VITALS) {
      for (const kind of VITAL_KINDS) {
        const bucket = b.vital[vital][kind];
        assert.ok(Array.isArray(bucket) && bucket.length >= 3, `${lang}.${vital}.${kind} has phrases`);
        for (const e of bucket) {
          assert.ok([1, 2, 3].includes(e.t), 'tone tier is 1..3');
          assert.ok(typeof e.s === 'string' && e.s.length > 0, 'non-empty text');
        }
      }
      // The gentle tone must never go silent: at least one t1 line per bucket.
      assert.ok(b.vital[vital].zero.some(e => e.t === 1), `${lang}.${vital}.zero has a t1 line`);
    }
    for (const kind of GENERIC_KINDS) {
      const bucket = b.generic[kind];
      assert.ok(Array.isArray(bucket) && bucket.length >= 2, `${lang}.generic.${kind} has phrases`);
    }
  }
});

test('pick: soft tone never returns a spicy/savage line', () => {
  const bag = {};
  const texts = new Set();
  for (let i = 0; i < 200; i++) {
    texts.add(core.pick(bag, { kind: 'zero', vital: 'hydration', lang: 'it', tone: 'soft' }));
  }
  const t1Pool = core.BANK.it.vital.hydration.zero.filter(e => e.t === 1).map(e => e.s);
  for (const text of texts) {
    // Soft picks never get stingers appended, so exact membership must hold
    // (after placeholder fill — t1 hydration lines carry no placeholders).
    assert.ok(t1Pool.includes(text), 'soft-only line: ' + text);
  }
});

test('pick: shuffle-bag exhausts the whole allowed pool before repeating', () => {
  const bag = {};
  const poolSize = core.BANK.en.vital.focus.zero.length; // savage tone allows all
  const rng = () => 0.31;                                // deterministic, no stingers (0.31 > 0.22 needs < — 0.31 avoids them)
  const seen = new Set();
  for (let i = 0; i < poolSize; i++) {
    seen.add(core.pick(bag, { kind: 'zero', vital: 'focus', lang: 'en', tone: 'savage', vars: { min: 5, vital: 'Focus' }, rng }));
  }
  assert.equal(seen.size, poolSize, 'every phrase served once before any repeat');
});

test('pick: placeholders are substituted', () => {
  const bag = {};
  const rng = () => 0.5; // no stinger
  for (let i = 0; i < 40; i++) {
    const text = core.pick(bag, { kind: 'gameover', lang: 'it', tone: 'savage', vars: { vital: 'Idratazione', min: 12 }, rng });
    assert.ok(!text.includes('{vital}') && !text.includes('{min}'), 'no raw placeholder in: ' + text);
  }
});

test('pick: unknown bucket or empty tone selection degrades to empty string', () => {
  assert.equal(core.pick({}, { kind: 'nope', lang: 'it', tone: 'soft' }), '');
});

test('stagesFor: ladder unlocks in order and respects opt-in toggles', () => {
  const all = { effects: true, monitors: true, minimize: true, lock: true, present: true };
  assert.deepEqual(core.stagesFor(0, all), ['nag']);
  assert.deepEqual(core.stagesFor(5 * 60000, all), ['nag', 'decay']);
  assert.deepEqual(core.stagesFor(8 * 60000, all), ['nag', 'decay', 'gameover']);
  assert.deepEqual(core.stagesFor(10 * 60000, all), ['nag', 'decay', 'gameover', 'overlay']);
  assert.deepEqual(core.stagesFor(20 * 60000, all), ['nag', 'decay', 'gameover', 'overlay', 'minimize', 'lock']);
  // Toggles off → rungs vanish even deep into the episode.
  assert.deepEqual(core.stagesFor(30 * 60000, { effects: false, monitors: false, minimize: false, lock: false, present: true }), ['nag']);
  assert.deepEqual(core.stagesFor(30 * 60000, { effects: true, monitors: true, minimize: false, lock: false, present: true }),
    ['nag', 'decay', 'gameover', 'overlay']);
});

test('stagesFor: PC-invading rungs require presence — unknown/away fails safe', () => {
  const opts = { effects: true, monitors: true, minimize: true, lock: true, present: false };
  assert.deepEqual(core.stagesFor(30 * 60000, opts), ['nag', 'decay', 'gameover'],
    'no overlay/minimize/lock without fresh real input');
});

test('repeatDelay: repeating stages jitter inside their window, one-shots return 0', () => {
  for (const stage of ['nag', 'gameover', 'overlay']) {
    const [lo, hi] = core.REPEAT_MS[stage];
    assert.equal(core.repeatDelay(stage, () => 0), lo);
    assert.equal(core.repeatDelay(stage, () => 1), hi);
  }
  assert.equal(core.repeatDelay('minimize'), 0);
  assert.equal(core.repeatDelay('lock'), 0);
});

test('langOf: italian variants map to it, everything else to en', () => {
  assert.equal(core.langOf('it'), 'it');
  assert.equal(core.langOf('it-IT'), 'it');
  assert.equal(core.langOf('de'), 'en');
  assert.equal(core.langOf(''), 'en');
});
