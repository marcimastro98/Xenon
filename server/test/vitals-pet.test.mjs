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
const GENERIC_KINDS = ['gameover', 'alldead', 'welcomeback', 'minwarn', 'minimized', 'lockwarn', 'locked', 'praise', 'stinger'];
// The dashboard's ten UI languages — Bit speaks all of them; each bank must
// mirror EN's bucket shape and per-line tone tiers exactly.
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru'];

test('phrase bank: all ten languages cover every bucket, matching EN shape and tiers', () => {
  const en = core.BANK.en;
  for (const lang of LANGS) {
    const b = core.BANK[lang];
    assert.ok(b, lang + ' bank exists');
    for (const vital of VITALS) {
      for (const kind of VITAL_KINDS) {
        const bucket = b.vital[vital][kind];
        const ref = en.vital[vital][kind];
        assert.ok(Array.isArray(bucket) && bucket.length >= 3, `${lang}.${vital}.${kind} has phrases`);
        assert.equal(bucket.length, ref.length, `${lang}.${vital}.${kind} count matches EN`);
        bucket.forEach((e, i) => {
          assert.ok([1, 2, 3].includes(e.t), 'tone tier is 1..3');
          assert.ok(typeof e.s === 'string' && e.s.length > 0, 'non-empty text');
          assert.equal(e.t, ref[i].t, `${lang}.${vital}.${kind}[${i}] tier matches EN`);
        });
      }
      // The gentle tone must never go silent: at least one t1 line per bucket.
      assert.ok(b.vital[vital].zero.some(e => e.t === 1), `${lang}.${vital}.zero has a t1 line`);
    }
    for (const kind of GENERIC_KINDS) {
      const bucket = b.generic[kind];
      const ref = en.generic[kind];
      assert.ok(Array.isArray(bucket) && bucket.length >= 2, `${lang}.generic.${kind} has phrases`);
      assert.equal(bucket.length, ref.length, `${lang}.generic.${kind} count matches EN`);
      bucket.forEach((e, i) => assert.equal(e.t, ref[i].t, `${lang}.generic.${kind}[${i}] tier matches EN`));
    }
  }
});

test('phrase bank: no stray placeholders in any language (only {vital} / {min})', () => {
  for (const lang of LANGS) {
    const b = core.BANK[lang];
    const all = [];
    for (const v of VITALS) for (const k of VITAL_KINDS) all.push(...b.vital[v][k]);
    for (const k of GENERIC_KINDS) all.push(...b.generic[k]);
    for (const e of all) {
      for (const ph of e.s.match(/\{\w+\}/g) || []) {
        assert.ok(['{vital}', '{min}'].includes(ph), `${lang}: stray placeholder ${ph} in "${e.s}"`);
      }
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

test('stagesFor: user-tuned `at` thresholds override the defaults per stage', () => {
  const on = { effects: true, monitors: true, minimize: true, lock: true, present: true };
  // Push minimize/lock way out: at 20 min they must NOT fire anymore.
  const relaxed = { ...on, at: { minimize: 45 * 60000, lock: 60 * 60000 } };
  assert.deepEqual(core.stagesFor(20 * 60000, relaxed), ['nag', 'decay', 'gameover', 'overlay'],
    'minimize/lock held back by the raised thresholds');
  assert.deepEqual(core.stagesFor(60 * 60000, relaxed), ['nag', 'decay', 'gameover', 'overlay', 'minimize', 'lock'],
    'they still unlock once their custom delay is reached');
  // A missing/invalid entry falls back to the built-in default; nag stays fixed.
  assert.deepEqual(core.stagesFor(0, { ...on, at: { decay: -5, gameover: 'x' } }), ['nag']);
  assert.deepEqual(core.stagesFor(5 * 60000, { ...on, at: {} }), ['nag', 'decay']);
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

test('langOf: maps each supported code (and its region variant) to its bank, else en', () => {
  assert.equal(core.langOf('it'), 'it');
  assert.equal(core.langOf('it-IT'), 'it');
  assert.equal(core.langOf('de'), 'de');
  assert.equal(core.langOf('ko-KR'), 'ko');
  assert.equal(core.langOf('zh-CN'), 'zh');
  assert.equal(core.langOf('pt_BR'), 'pt');
  assert.equal(core.langOf('ru'), 'ru');
  assert.equal(core.langOf('nl'), 'en');   // unsupported → English fallback
  assert.equal(core.langOf(''), 'en');
});
