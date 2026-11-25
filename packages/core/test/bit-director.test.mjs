import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bit = require('../src/bit.js');
const D = require('../src/bit-director.js');
const genome = require('../src/bit-genome.js');

// A seeded stand-in for Math.random, so a run is the same every time.
function seeded(n = 7) {
  let s = n >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MIN = 60000;
const DAY = { hour: 14 };

test('every reaction has a clip this engine knows', () => {
  for (const [name, ev] of Object.entries(D.EVENTS)) {
    assert.ok(ev.clips.some((id) => bit.clip(id)), name);
    for (const id of ev.clips) assert.ok(bit.clip(id), `${name}: ${id} is drawn`);
    assert.ok(ev.priority >= 1 && ev.priority <= 3, name);
  }
});

test('every temperament and quirk of the genes has a rhythm', () => {
  const G = require('../src/bit-genes.js');
  for (const t of G.TEMPERAMENTS) assert.ok(D.TEMPERAMENTS[t.id], t.id);
  for (const q of G.QUIRKS) assert.ok(bit.clip(q.id) && bit.clip(q.id).kind === 'fidget', `quirk ${q.id} is a fidget`);
});

test('a personal Bit never repeats a fidget back to back, and never idles with hearts', () => {
  const dir = D.createDirector(genome.decode('0123456789abcdef'), { rand: seeded() });
  const recent = [];
  for (let i = 0; i < 500; i++) {
    const id = dir.nextFidget(DAY, recent);
    assert.notEqual(id, recent.at(-1));
    assert.notEqual(id, 'love');
    recent.push(id);
  }
});

test('its quirk comes up about twice as often as before', () => {
  const genes = { ...genome.decode('0123456789abcdef'), quirk: 'juggle' };
  const count = (favour) => {
    const rand = seeded(3);
    let n = 0;
    for (let i = 0; i < 6000; i++) if (D.pickFidget(DAY, [], rand, favour) === 'juggle') n++;
    return n;
  };
  const plain = count({});
  const boosted = count({ quirk: genes.quirk, personal: true });
  assert.ok(boosted > plain * 1.6 && boosted < plain * 2.4, `${plain} -> ${boosted}`);
});

test('reactions wait out their cooldown and the hourly cap', () => {
  const dir = D.createDirector({ temperament: 'curious' }, { cap: 3, rand: seeded() });
  let t = 0;
  assert.ok(dir.react('notification', DAY, t));
  assert.equal(dir.react('notification', DAY, t + 1 * MIN), null, 'cooling down');
  assert.ok(dir.react('download', DAY, (t += 2 * MIN)));
  assert.ok(dir.react('trackChange', DAY, (t += 2 * MIN)));
  assert.equal(dir.react('update', DAY, (t += 2 * MIN)), null, 'three this hour');
  assert.ok(dir.react('update', DAY, 61 * MIN), 'the hour moved on');
  assert.ok(dir.react('supporter', DAY, 61 * MIN + 1), 'what matters always passes');
  assert.equal(dir.react('nope', DAY, 0), null);
});

test('in a game only game reactions play; at night only the ones that matter', () => {
  const dir = D.createDirector({ temperament: 'lively' }, { rand: seeded() });
  const game = { hour: 21, gaming: true };
  assert.equal(dir.react('notification', game, 0), null);
  assert.ok(dir.react('fpsDrop', game, 0));
  assert.ok(dir.react('hello', game, 0));
  const night = { hour: 3 };
  assert.equal(dir.react('download', night, 0), null);
  assert.ok(dir.react('claudeDone', night, 0));
});

test('a calm Bit waits longer between fidgets than a lively one, longer still at night', () => {
  const gap = (temperament, ctx) => {
    const dir = D.createDirector({ temperament }, { rand: () => 0.5 });
    return dir.idleGapMs(ctx);
  };
  assert.ok(gap('calm', DAY) > gap('lively', DAY));
  assert.equal(gap('calm', { hour: 2 }), gap('calm', DAY) * 2);
  assert.equal(D.createDirector({ temperament: 'shy' }, { cap: 6 }).cap, 4);
  assert.equal(D.createDirector({}, { cap: 0 }).cap, 0, 'reactions off');
  const dir = D.createDirector({ temperament: 'curious' });
  dir.setCap(2);
  assert.equal(dir.cap, 2, 'the person chose fewer');
  dir.setCap(undefined);
  assert.equal(dir.cap, 2, 'nothing said, nothing changed');
});

test('a big temperament picks the bigger clip of a reaction', () => {
  const big = D.createDirector({ temperament: 'dramatic' }).react('gameEnd', DAY, 0);
  const small = D.createDirector({ temperament: 'shy' }).react('gameEnd', DAY, 0);
  const known = D.EVENTS.gameEnd.clips.filter((id) => bit.clip(id));
  assert.equal(big, known.at(-1));
  assert.equal(small, known[0]);
});

test('the birthday wins over every other season', () => {
  assert.equal(D.seasonOf(new Date(2026, 9, 31), { month: 10, day: 31 }), 'birthday');
  assert.equal(D.seasonOf(new Date(2026, 9, 31), { month: 5, day: 3 }), 'halloween');
});

test('the life pack keeps a personal Bit plain: no hearts, confetti or star eyes, jumps within two cells', () => {
  const LIFE = require('../src/bit-clips-life.js');
  const loud = /^(heart|confetti)/;
  for (const c of LIFE.CLIPS) {
    assert.ok(bit.clip(c.id), `${c.id} reached the engine`);
    for (const fr of c.frames) {
      assert.ok(!['hearts', 'stars'].includes(fr.eyes), c.id);
      for (const e of fr.ex || []) {
        const name = Array.isArray(e) ? e[0] : e;
        assert.ok(!loud.test(name), `${c.id}: ${name}`);
        assert.ok(bit.parts[name] || LIFE.PARTS[name], `${c.id}: unknown part ${name}`);
      }
      if (c.id !== 'hatch') assert.ok((fr.dy || 0) >= -2, `${c.id} jumps too high`);
    }
  }
});
