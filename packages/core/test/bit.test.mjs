import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = require('../src/bit-clips.js');
const bit = require('../src/bit.js');
const phrases = require('../src/bit-phrases.js');

const BODY_KEY = JSON.stringify(data.BODY);
const seeded = (seed) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test('the body is the brand shape and never changes', () => {
  assert.equal(BODY_KEY, JSON.stringify([[6, 0], [6, 1], [3, 2, 6], [2, 3, 8, 6], [3, 9, 6], [3, 10, 2], [7, 10, 2]]));
  for (const c of bit.clips) {
    for (let i = 0; i < c.frames.length; i++) {
      const { layers } = bit.renderFrame(c, i);
      const body = layers.find((l) => l.clipFloor && l.rects.some((r) => r.o === 1 && !r.fill.startsWith('#')));
      const cells = body.rects.slice(0, data.BODY.length).map((r) => (r.w === 1 && r.h === 1 ? [r.x, r.y] : r.h === 1 ? [r.x, r.y, r.w] : [r.x, r.y, r.w, r.h]));
      assert.equal(JSON.stringify(cells), BODY_KEY, `${c.id} frame ${i}`);
    }
  }
});

test('every clip id is unique and every frame names known shapes and parts', () => {
  const ids = bit.clips.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const c of bit.clips) {
    assert.ok(['mood', 'fidget', 'react'].includes(c.kind), c.id);
    assert.ok(c.frames.length > 0, c.id);
    for (const f of c.frames) {
      assert.ok(Number.isFinite(f.ms) && f.ms >= 40 && f.ms <= 2000, `${c.id} ms ${f.ms}`);
      if (f.eyes) assert.ok(data.EYES[f.eyes], `${c.id} eyes ${f.eyes}`);
      if (f.mouth) assert.ok(data.MOUTHS[f.mouth], `${c.id} mouth ${f.mouth}`);
      if (f.brows) assert.ok(data.BROWS[f.brows], `${c.id} brows ${f.brows}`);
      if (f.tint) assert.ok(data.MOOD_RGB[f.tint], `${c.id} tint ${f.tint}`);
      for (const e of f.ex || []) {
        const name = Array.isArray(e) ? e[0] : e;
        assert.ok(data.PARTS[name], `${c.id} part ${name}`);
      }
    }
  }
});

test('a rich library: many fidgets, a few rare, moods and reactions', () => {
  const count = (pred) => bit.clips.filter(pred).length;
  assert.ok(count((c) => c.kind === 'fidget' && !c.when && !c.rare) >= 15);
  assert.ok(count((c) => c.rare) >= 3);
  assert.ok(count((c) => c.when) >= 10);
  for (const id of ['idle', 'listen', 'think', 'work', 'talk', 'worry', 'sleep']) assert.equal(bit.clip(id).kind, 'mood');
  for (const id of data.POKES) assert.ok(bit.clip(id), id);
});

test('frameSvg is well formed and carries only numbers and palette colors', () => {
  for (const c of bit.clips) {
    const svg = bit.frameSvg(c, 0);
    assert.match(svg, /^<svg [^>]+>.*<\/svg>$/);
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    for (const f of fills) assert.match(f, /^(#[0-9a-f]{6}|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/i, `${c.id} ${f}`);
  }
});

test('tints: mood colors, raw rgb, and junk falls back to idle', () => {
  assert.equal(bit.rgb('think'), '180,160,255');
  assert.equal(bit.rgb('1,2,3'), '1,2,3');
  assert.equal(bit.rgb('red;x'), bit.rgb('idle'));
  const svg = bit.frameSvg('idle', 0, { tint: 'sleep' });
  assert.ok(svg.includes('rgb(138,180,248)'));
});

test('transforms squash from the feet and leave the floor where it is', () => {
  assert.equal(bit.transformAttr(null), '');
  assert.equal(bit.transformAttr({ dx: 0, dy: 0, sx: 1, sy: 0.5, px: 6, py: 11 }), 'translate(0 5.5) scale(1 0.5)');
  assert.equal(bit.transformAttr({ dx: 0, dy: 0, sx: -1, sy: 1, px: 6, py: 11 }), 'translate(12 0) scale(-1 1)');
});

test('fits: hours wrap past midnight, flags and lists must match', () => {
  const night = bit.clip('stargaze');
  assert.ok(bit.fits(night, { hour: 23 }));
  assert.ok(bit.fits(night, { hour: 2 }));
  assert.ok(!bit.fits(night, { hour: 14 }));
  assert.ok(!bit.fits(night, {}));
  assert.ok(bit.fits(bit.clip('umbrella'), { weather: 'drizzle' }));
  assert.ok(!bit.fits(bit.clip('umbrella'), { weather: 'clear' }));
  assert.ok(!bit.fits(bit.clip('gaming'), { gaming: false }));
  assert.ok(bit.fits(bit.clip('party'), { season: 'newyear' }));
  assert.ok(bit.fits(bit.clip('hop'), {}));
});

test('pickFidget never repeats recent ones and only picks what fits', () => {
  const rand = seeded(7);
  const recent = [];
  for (let i = 0; i < 400; i++) {
    const id = bit.pickFidget({ hour: 14 }, recent, rand);
    assert.ok(!recent.slice(-6).includes(id), `repeat ${id}`);
    assert.ok(!bit.clip(id).when, `context clip ${id} without its moment`);
    recent.push(id);
  }
  const seen = new Set(recent);
  assert.ok(seen.size >= 15, `only ${seen.size} different fidgets`);
  const rare = recent.filter((id) => bit.clip(id).rare).length;
  assert.ok(rare > 0 && rare < 400 * 0.12, `rare share ${rare}`);
});

test('pickFidget favors the moment when the context fits', () => {
  const rand = seeded(3);
  const recent = [];
  for (let i = 0; i < 200; i++) recent.push(bit.pickFidget({ hour: 9, weather: 'rain', music: true }, recent, rand));
  for (const id of ['coffee', 'umbrella', 'headbang']) assert.ok(recent.includes(id), id);
});

test('seasonOf finds the holidays and a birthday', () => {
  assert.equal(bit.seasonOf(new Date(2026, 9, 31)), 'halloween');
  assert.equal(bit.seasonOf(new Date(2026, 11, 25)), 'christmas');
  assert.equal(bit.seasonOf(new Date(2027, 0, 1)), 'newyear');
  assert.equal(bit.seasonOf(new Date(2026, 4, 3), { month: 5, day: 3 }), 'birthday');
  assert.equal(bit.seasonOf(new Date(2026, 6, 10)), null);
});

test('phrases: every language has every English moment, no em-dashes', () => {
  const en = phrases.LINES.en;
  for (const moment of Object.keys(phrases.MOMENTS)) assert.ok(en[moment] && en[moment].length, `en ${moment}`);
  for (const [lang, set] of Object.entries(phrases.LINES)) {
    assert.deepEqual(Object.keys(set).sort(), Object.keys(en).sort(), lang);
    for (const [moment, lines] of Object.entries(set)) {
      for (const l of lines) {
        assert.ok(!/[—–]/.test(l), `${lang}.${moment}: ${l}`);
        assert.ok(l.length <= 90, `${lang}.${moment} too long for one breath: ${l}`);
      }
    }
  }
});

test('phrases: every moment points at clips that exist', () => {
  for (const [moment, m] of Object.entries(phrases.MOMENTS)) {
    for (const id of m.clips) assert.ok(bit.clip(id), `${moment} -> ${id}`);
  }
});

test('say fills placeholders, falls back to English, and does not repeat', () => {
  const r = phrases.say('it', 'lowSparks', { sparks: 3 }, [], () => 0);
  assert.ok(r.text.includes('3') && !r.text.includes('{'));
  assert.ok(phrases.say('xx', 'done'));
  assert.equal(phrases.say('it', 'nope'), null);
  const recent = [];
  const rand = seeded(11);
  for (let i = 0; i < 50; i++) {
    const { raw } = phrases.say('en', 'poke', {}, recent, rand);
    assert.notEqual(raw, recent[recent.length - 1]);
    recent.push(raw);
  }
});

test('greetingFor covers the whole day', () => {
  assert.equal(phrases.greetingFor(7), 'morning');
  assert.equal(phrases.greetingFor(15), 'afternoon');
  assert.equal(phrases.greetingFor(20), 'evening');
  assert.equal(phrases.greetingFor(2), 'night');
});

test('a still frame takes a safe clip id, never arbitrary markup', () => {
  assert.match(bit.frameSvg('idle', 0, { clipId: 'bitfloor-still' }), /clipPath id="bitfloor-still"/);
  const bad = bit.frameSvg('idle', 0, { clipId: '"><script>x</script>' });
  assert.doesNotMatch(bad, /script/);
  assert.match(bad, /clipPath id="bitfloor"/);
});
