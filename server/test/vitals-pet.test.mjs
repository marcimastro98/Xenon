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
const GENERIC_KINDS = ['gameover', 'alldead', 'welcomeback', 'minwarn', 'minimized', 'lockwarn', 'locked', 'praise', 'return', 'night', 'streak', 'stinger'];
// The dashboard's eleven UI languages — Bit speaks all of them; each bank must
// mirror EN's bucket shape and per-line tone tiers exactly.
const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl'];

test('phrase bank: all eleven languages cover every bucket, matching EN shape and tiers', () => {
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

test('awayCredit: shifts stale stamps forward by the frozen span, clamped to now', () => {
  const freezeStart = 1_000_000;
  const returnAt = freezeStart + 20 * 60000;   // 20 min frozen
  const now = returnAt + 1000;
  const last = {
    hydration: freezeStart - 5 * 60000,        // dead-ish before the freeze → shifted
    energy: freezeStart + 60000,               // reseeded DURING the away period → untouched
    stamina: 0,                                // never seeded → untouched
    focus: now - 60000,                        // fresh future-ish stamp ≥ freezeStart → untouched
  };
  const out = core.awayCredit({ last, ids: ['hydration', 'energy', 'stamina', 'focus'], freezeStart, returnAt, now, creditedAt: 0 });
  assert.ok(out, 'credit produced');
  assert.equal(out.awayCreditAt, freezeStart, 'period identity = freezeStart');
  assert.equal(out.patch.hydration, last.hydration + (returnAt - freezeStart), 'span credited');
  assert.ok(!('energy' in out.patch) && !('stamina' in out.patch) && !('focus' in out.patch), 'only pre-freeze stamps shift');
  // Clamp: a shift can never land in the future.
  const clamped = core.awayCredit({ last: { hydration: freezeStart - 1000 }, ids: ['hydration'], freezeStart, returnAt, now: freezeStart + 1000, creditedAt: 0 });
  assert.equal(clamped.patch.hydration, freezeStart + 1000, 'clamped to now');
});

test('awayCredit: the creditedAt guard makes re-applying the same period a no-op', () => {
  const freezeStart = 5_000_000;
  const args = { last: { hydration: freezeStart - 1000 }, ids: ['hydration'], freezeStart, returnAt: freezeStart + 60000, now: freezeStart + 61000 };
  const first = core.awayCredit({ ...args, creditedAt: 0 });
  assert.ok(first && first.patch.hydration, 'first application credits');
  // A second surface hydrates first's save (awayCreditAt = freezeStart) and
  // then observes the same transition — inside the epsilon → refused.
  assert.equal(core.awayCredit({ ...args, creditedAt: first.awayCreditAt }), null, 'same period refused');
  assert.equal(core.awayCredit({ ...args, creditedAt: freezeStart - core.AWAY_EPS_MS / 2 }), null, 'within epsilon refused');
  // A NEW later period is still credited.
  const later = core.awayCredit({ ...args, freezeStart: freezeStart + 10 * 60000, returnAt: freezeStart + 20 * 60000, now: freezeStart + 20 * 60000, creditedAt: first.awayCreditAt });
  assert.ok(later, 'a genuinely new period still credits');
});

test('awayCredit: degenerate inputs return null', () => {
  assert.equal(core.awayCredit({ last: {}, ids: [], freezeStart: 0, returnAt: 100, now: 100, creditedAt: 0 }), null, 'no freezeStart');
  assert.equal(core.awayCredit({ last: {}, ids: [], freezeStart: 100, returnAt: 100, now: 100, creditedAt: 0 }), null, 'span 0');
  assert.equal(core.awayCredit({ last: {}, ids: [], freezeStart: 200, returnAt: 100, now: 200, creditedAt: 0 }), null, 'negative span');
});

test('isNight: 23:00–07:00 local, boundaries exact', () => {
  assert.equal(core.isNight(22), false);
  assert.equal(core.isNight(23), true);
  assert.equal(core.isNight(0), true);
  assert.equal(core.isNight(6), true);
  assert.equal(core.isNight(7), false);
  assert.equal(core.isNight(12), false);
  assert.equal(core.isNight(NaN), false, 'unknown hour fails safe (day)');
});

test('mergePetBookkeeping: max/OR semantics, newer episode identity wins', () => {
  const a = { snoozeUntil: 100, muteDay: '2026-07-09', ep: { hydration: { z: 10, goAt: 50, ovAt: 0, min: true, lock: false }, focus: { z: 5, goAt: 1, ovAt: 1, min: false, lock: false } } };
  const b = { snoozeUntil: 200, muteDay: '2026-07-10', ep: { hydration: { z: 10, goAt: 40, ovAt: 60, min: false, lock: true }, energy: { z: 7, goAt: 0, ovAt: 0, min: false, lock: false } } };
  const m = core.mergePetBookkeeping(a, b);
  assert.equal(m.snoozeUntil, 200, 'snooze = max');
  assert.equal(m.muteDay, '2026-07-10', 'muteDay = lexicographic max');
  assert.deepEqual(m.ep.hydration, { z: 10, goAt: 50, ovAt: 60, min: true, lock: true }, 'same episode: OR flags, max stamps');
  assert.deepEqual(m.ep.focus, a.ep.focus, 'one-sided episode kept');
  assert.deepEqual(m.ep.energy, b.ep.energy, 'one-sided episode kept');
  // Different z → the newer episode wins outright (no flag bleed from the old one).
  const n = core.mergePetBookkeeping(
    { ep: { hydration: { z: 100, goAt: 0, ovAt: 0, min: true, lock: true } } },
    { ep: { hydration: { z: 200, goAt: 0, ovAt: 0, min: false, lock: false } } });
  assert.equal(n.ep.hydration.z, 200);
  assert.equal(n.ep.hydration.lock, false, 'old episode flags do not bleed into the new one');
});

test('mergeVitalsMem: grow-only counters, (streak, lastFillDay) travels as a pair', () => {
  const a = { streak: 5, bestStreak: 8, lastFillDay: '2026-07-09', locksTotal: 2, gameoversTotal: 4 };
  const b = { streak: 1, bestStreak: 6, lastFillDay: '2026-07-10', locksTotal: 3, gameoversTotal: 1 };
  const m = core.mergeVitalsMem(a, b);
  assert.equal(m.streak, 1, 'the newer day owns the streak — even if smaller');
  assert.equal(m.lastFillDay, '2026-07-10');
  assert.equal(m.bestStreak, 8, 'bestStreak = max');
  assert.equal(m.locksTotal, 3);
  assert.equal(m.gameoversTotal, 4);
  // Same day → the higher streak already counted today.
  assert.equal(core.mergeVitalsMem({ streak: 3, lastFillDay: '2026-07-10' }, { streak: 4, lastFillDay: '2026-07-10' }).streak, 4);
});

test('langOf: maps each supported code (and its region variant) to its bank, else en', () => {
  assert.equal(core.langOf('it'), 'it');
  assert.equal(core.langOf('it-IT'), 'it');
  assert.equal(core.langOf('de'), 'de');
  assert.equal(core.langOf('ko-KR'), 'ko');
  assert.equal(core.langOf('zh-CN'), 'zh');
  assert.equal(core.langOf('pt_BR'), 'pt');
  assert.equal(core.langOf('ru'), 'ru');
  assert.equal(core.langOf('nl'), 'nl');
  assert.equal(core.langOf('nl-BE'), 'nl');
  assert.equal(core.langOf('sv'), 'en');   // unsupported → English fallback
  assert.equal(core.langOf(''), 'en');
});
