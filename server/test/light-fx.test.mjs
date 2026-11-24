// The one list of light effects (js/light-fx/): every effect draws on any number of LEDs and any
// shape, never flashes more than three times a second, gives the same frame for the same time,
// runs backwards as a mirror, and draws something sensible without what it follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const Fx = require('../js/light-fx/light-fx.js');
const C = require('../js/light-fx/light-fx-colour.js');

const T0 = new Date(2026, 5, 1, 9, 30).getTime();
const WHITE = [{ r: 255, g: 255, b: 255 }];
const TWO = [{ r: 255, g: 0, b: 0 }, { r: 0, g: 80, b: 255 }];
const INPUTS = { level: 0.6, sound: 0.5, load: 0.7, fans: 1800, sky: { rise: 400, set: 1100 }, weather: { kind: 'storm' }, timer: { left: 0.05 } };
const peak = (c) => Math.max(c.r, c.g, c.b);
const byte = (v) => Number.isInteger(v) && v >= 0 && v <= 255;

test('the list: unique ids in four groups, each with a line, what it needs and its amount named', () => {
  assert.equal(Fx.LIST.length, 33);
  assert.equal(new Set(Fx.EFFECTS).size, Fx.EFFECTS.length);
  assert.deepEqual(Fx.GROUPS, ['calm', 'moving', 'music', 'pc']);
  for (const g of Fx.GROUPS) assert.ok(Fx.LIST.some((e) => e.group === g), g);
  for (const e of Fx.LIST) {
    assert.ok(Fx.GROUPS.includes(e.group), e.id);
    assert.match(e.about, /^[A-Z].{10,90}\.$/, e.id);
    assert.doesNotMatch(e.about, /—/, e.id);
    assert.ok(e.needs === null || Fx.NEEDS.includes(e.needs), e.id);
    assert.ok(e.size === null || Fx.SIZES.includes(e.size), e.id);
  }
  for (const id of Fx.PALETTE_IDS) {
    assert.ok(Fx.PALETTES[id].length >= 2 && Fx.PALETTES[id].length <= 5, id);
    assert.ok(Fx.PALETTES[id].every((c) => byte(c.r) && byte(c.g) && byte(c.b)), id);
  }
});

test('every effect draws on 1, 8, 16, 24 and 60 LEDs of every shape, and lights something', () => {
  for (const effect of Fx.EFFECTS) {
    for (const shape of Fx.SHAPES) {
      for (const count of [1, 8, 16, 24, 60]) {
        let brightest = 0;
        for (const inputs of [undefined, INPUTS]) {
          for (let t = 0; t < 6000; t += 137) {   // an odd step meets every phase
            const f = Fx.frame(effect, { shape, count, colours: TWO, now: T0 + t, inputs });
            assert.equal(f.length, shape === 'one' ? 1 : count, `${effect} ${shape} ${count}`);
            assert.ok(f.every((c) => byte(c.r) && byte(c.g) && byte(c.b)), `${effect} ${shape} ${count}`);
            brightest = Math.max(brightest, ...f.map(peak));
          }
        }
        assert.ok(brightest > 40, `${effect} ${shape} ${count} stays dark`);
      }
    }
  }
  assert.deepEqual(Fx.frame('spin', { count: 0 }), []);
  assert.deepEqual(Fx.frame('nope', { count: 3, colours: WHITE }), Fx.frame('still', { count: 3, colours: WHITE }), 'an unknown one stands still');
});

// Flashes in a series of brightness: a rise of a quarter, then a fall of a quarter, counted
// in any one second.
function flashesInASecond(series, stepMs) {
  const rises = [];
  let high = false;
  let low = Infinity;
  let top = -Infinity;
  series.forEach((v, k) => {
    if (!high) {
      low = Math.min(low, v);
      if (v - low >= 64) { high = true; top = v; rises.push(k * stepMs); }
    } else {
      top = Math.max(top, v);
      if (top - v >= 64) { high = false; low = v; }
    }
  });
  let worst = 0;
  for (let a = 0, b = 0; a < rises.length; a++) {
    while (b < rises.length && rises[b] - rises[a] < 1000) b++;
    worst = Math.max(worst, b - a);
  }
  return worst;
}

test('no effect flashes the set, or one LED, more than three times a second, at any speed', () => {
  const step = 20;
  for (const effect of Fx.EFFECTS) {
    for (const [shape, count] of [['ring', 24], ['one', 1]]) {
      for (const speed of [50, 100]) {
        for (const size of [0.5, 1]) {
          const state = {};
          const whole = [];
          const each = Array.from({ length: count }, () => []);
          for (let t = 0; t < 8000; t += step) {
            const f = Fx.frame(effect, { shape, count, colours: WHITE, speed, size, now: T0 + t, inputs: INPUTS, state });
            whole.push(f.reduce((s, c) => s + peak(c), 0) / count);
            f.forEach((c, i) => each[i].push(peak(c)));
          }
          const said = `${effect} ${shape} speed ${speed} size ${size}`;
          assert.ok(flashesInASecond(whole, step) <= 3, said + ': the set');
          assert.ok(Math.max(...each.map((s) => flashesInASecond(s, step))) <= 3, said + ': one LED');
        }
      }
    }
  }
});

test('the same time gives the same frame, with nothing left to chance', () => {
  for (const effect of Fx.EFFECTS) {
    const opts = { count: 24, colours: TWO, now: T0 + 12345, inputs: INPUTS, size: 0.7 };
    assert.deepEqual(Fx.frame(effect, opts), Fx.frame(effect, { ...opts }), effect);
  }
  for (const file of ['light-fx', 'light-fx-colour', 'light-fx-calm', 'light-fx-moving', 'light-fx-pc']) {
    const src = readFileSync(new URL(`../js/light-fx/${file}.js`, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /Math\.random|Date\.now|performance\.now/, file);
  }
});

test('backwards is the mirror: round the other way on a ring, from the other end on a strip', () => {
  for (const effect of Fx.EFFECTS) {
    const opts = { count: 16, colours: TWO, now: T0 + 777, inputs: INPUTS };
    const ring = Fx.frame(effect, { ...opts, shape: 'ring' });
    const ringBack = Fx.frame(effect, { ...opts, shape: 'ring', reverse: true });
    assert.deepEqual(ringBack, ring.map((_c, i) => ring[(16 - i) % 16]), effect + ' ring');
    const line = Fx.frame(effect, { ...opts, shape: 'line' });
    const lineBack = Fx.frame(effect, { ...opts, shape: 'line', reverse: true });
    assert.deepEqual(lineBack, [...line].reverse(), effect + ' line');
  }
});

test('two colours blend as light does: the same LED both ways, full and with no colour they lack', () => {
  const red = { r: 255, g: 0, b: 0 };
  const blue = { r: 0, g: 0, b: 255 };
  const amber = { r: 255, g: 176, b: 32 };
  for (const f of Array.from({ length: 61 }, (_v, k) => k / 60)) {   // as LEDs fall on a ring of 24 or 60
    assert.deepEqual(C.mix(red, blue, f), C.mix(blue, red, 1 - f), String(f));
    assert.deepEqual(C.mix(amber, blue, f), C.mix(blue, amber, 1 - f), String(f));
    assert.equal(C.mix(red, blue, f).g, 0, 'no green between red and blue');
  }
  assert.deepEqual(C.mix(red, blue, 0.5), { r: 255, g: 0, b: 255 }, 'a full magenta, not a dim one');
});

test('speed: 50 as made, every 26 steps twice or half as fast, the old names at their old pace', () => {
  assert.equal(Fx.paceOf(50), 1);
  assert.equal(Fx.paceOf(24), 2);
  assert.equal(Fx.paceOf(76), 0.5);
  assert.deepEqual(['slow', 'normal', 'fast'].map(Fx.paceOf), [1.7, 1, 0.55]);
  assert.deepEqual([Fx.speedOf(0), Fx.speedOf(500), Fx.speedOf('x'), Fx.speedOf(NaN), Fx.speedOf(33.4)], [1, 100, 50, 50, 33]);
  // The same moment comes twice as late at half the speed.
  assert.deepEqual(Fx.frame('comet', { count: 24, colours: TWO, now: 900, speed: 24 }), Fx.frame('comet', { count: 24, colours: TWO, now: 450 }));
});

test('a light behind another by a phase shows what it will show later: one light after another', () => {
  const opts = { count: 24, colours: TWO };
  assert.deepEqual(Fx.frame('spin', { ...opts, now: 0, phase: 0.25 }), Fx.frame('spin', { ...opts, now: 600 }));
});

test('what an effect follows, missing or wrong, draws as if missing; known, it shows', () => {
  const bad = { level: 'x', sound: NaN, load: -3, fans: -1, sky: { rise: 3000, set: 'a' }, weather: { kind: 'hail' }, timer: { left: 'soon' } };
  for (const e of Fx.LIST.filter((x) => x.needs)) {
    const opts = { count: 24, colours: TWO, now: T0 + 4321 };
    assert.deepEqual(Fx.frame(e.id, { ...opts, inputs: bad }), Fx.frame(e.id, opts), e.id);
  }
  const lit = (f) => f.filter((c) => peak(c) > 200).length;
  assert.equal(lit(Fx.frame('level', { count: 24, colours: WHITE, inputs: { level: 0.5 } })), 12, 'half a reading: half the LEDs');
  assert.equal(lit(Fx.frame('timer', { count: 24, colours: WHITE, inputs: { timer: { left: 0.25 } } })), 6, 'a quarter left: a quarter lit');
  const noon = new Date(2026, 5, 1, 13, 0).getTime();
  const midnight = new Date(2026, 5, 1, 0, 30).getTime();
  const sum = (f) => f.reduce((s, c) => s + c.r + c.g + c.b, 0);
  const sky = (now) => sum(Fx.frame('sky', { count: 24, now, inputs: { sky: { rise: 360, set: 1200 } } }));
  assert.ok(sky(noon) > 2 * sky(midnight), 'day is brighter than night');
  // A day said from anywhere on the clock reads the same: sunrise near midnight (far north, or
  // a day played fast on a menu card) shifts the sky with it.
  const at = (h, m) => new Date(2026, 5, 1, h, m).getTime();
  const skyOf = (now, rise, set) => Fx.frame('sky', { count: 24, now, inputs: { sky: { rise, set } } });
  for (const [h, m] of [[6, 15], [8, 0], [13, 0], [19, 50], [20, 30]]) {   // no stars: they twinkle with the clock
    const shift = 17 * 60;   // the same day, seventeen hours later on the clock
    const later = ((h * 60 + m + shift) % 1440);
    assert.deepEqual(skyOf(at(Math.floor(later / 60), later % 60), (360 + shift) % 1440, (1200 + shift) % 1440), skyOf(at(h, m), 360, 1200), h + ':' + m);
  }
  const weather = (kind, night) => Fx.frame('weather', { count: 24, now: T0, inputs: { weather: { kind, night } } });
  assert.notDeepEqual(weather('rain'), weather('clear'));
  assert.notDeepEqual(weather('clear', true), weather('clear'), 'a clear night has its stars');
  let flash = 0;
  for (let t = 0; t < 30000; t += 20) flash = Math.max(flash, Math.min(...Fx.frame('weather', { count: 24, now: T0 + t, inputs: { weather: { kind: 'storm' } } }).map((c) => c.r)));
  assert.ok(flash > 150, 'a storm has its lightning');
});

test('the clock: an arc up to the hour, a dot for the minutes', () => {
  const three = new Date(2026, 5, 1, 3, 0, 5).getTime();
  const f = Fx.frame('clock', { count: 24, colours: [{ r: 0, g: 0, b: 255 }, { r: 0, g: 255, b: 0 }], now: three, glow: 0 });
  assert.ok(f.slice(1, 6).every((c) => c.b > 40), 'a quarter of the ring for three o\'clock');
  assert.ok(f.slice(8, 20).every((c) => c.b === 0), 'nothing past the hour');
  assert.ok(f[0].g > 200, 'the minute dot at the top');
});

test('a speed that changes (load, fans) turns on smoothly when the light keeps its state', () => {
  const state = {};
  const headOf = (f) => f.reduce((best, c, i) => (peak(c) > peak(f[best]) ? i : best), 0);
  let last = null;
  for (let t = 0; t < 8000; t += 40) {
    const load = t < 4000 ? 0.1 : 1;
    const head = headOf(Fx.frame('load', { count: 24, colours: WHITE, now: T0 + t, inputs: { load }, state }));
    if (last != null) {
      const moved = Math.min((head - last + 24) % 24, (last - head + 24) % 24);
      assert.ok(moved <= 3, `jumped ${moved} LEDs at ${t} ms`);
    }
    last = head;
  }
  const fans = (now, st) => Fx.frame('fans', { count: 24, colours: WHITE, now, inputs: { fans: 1000 }, state: st });
  fans(T0, state);
  const copy = structuredClone(state);
  assert.deepEqual(fans(T0 + 3_600_000, state), fans(T0 + 250, copy), 'an hour away moves it as a quarter of a second does');
});

test('effects with their own colours ignore the ones given; a single light is one LED', () => {
  for (const e of Fx.LIST.filter((x) => x.colours === false)) {
    const opts = { count: 12, now: T0 + 999, inputs: INPUTS };
    assert.deepEqual(Fx.frame(e.id, { ...opts, colours: WHITE }), Fx.frame(e.id, { ...opts, colours: TWO }), e.id);
  }
  assert.equal(Fx.frame('rainbow', { shape: 'one', count: 40 }).length, 1);
});

test('every effect that moves shows it moving in a few seconds, with one colour or two alike', () => {
  const ONE = [{ r: 255, g: 106, b: 0 }];
  const ALIKE = [{ r: 255, g: 90, b: 31 }, { r: 255, g: 147, b: 41 }];
  const apart = (a, b) => Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
  // No timer running: the timer waits full, breathing.
  const inputs = { ...INPUTS, timer: null };
  for (const e of Fx.LIST.filter((x) => x.moves && x.needs !== 'sound')) {
    for (const colours of [ONE, ALIKE]) {
      for (const [shape, count] of [['ring', 8], ['ring', 24], ['line', 20]]) {
        const state = {};
        const first = Fx.frame(e.id, { shape, count, colours, now: T0, inputs, state });
        let most = 0;
        for (let t = 66; t <= 6000; t += 66) {
          const f = Fx.frame(e.id, { shape, count, colours, now: T0 + t, inputs, state });
          most = Math.max(most, ...f.map((c, i) => apart(c, first[i])));
        }
        assert.ok(most >= 120, `${e.id} ${shape} ${count} in ${colours.length} colour(s) barely moves (${most})`);
      }
    }
  }
});
