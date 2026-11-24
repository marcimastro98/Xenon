// The ring of lights around a pump screen (js/pump/ring-effects.js): every effect gives one
// colour per LED, the same for the same time, turned the other way by reverse and slowed by
// speed, never flashing the whole ring more than three times a second; and a line's 'live'
// colours (js/pump/face-live.js) warm with its readings and follow the hour on a clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Fx = require('../js/pump/ring-effects.js');
const LightFx = require('../js/light-fx/light-fx.js');
const Faces = require('../js/pump/pump-faces.js');

const RED = { r: 255, g: 0, b: 0 };
const BLUE = { r: 0, g: 0, b: 255 };
const GREEN = { r: 0, g: 255, b: 0 };
const colours = [RED, BLUE, GREEN];
// What each effect follows besides the time, as the lights and the menu give it.
const inputs = (t) => ({ level: 0.6, sound: 0.5 + 0.5 * Math.sin(t / 300) });
const lum = (c) => (c.r + c.g + c.b) / 3;

test('every effect is listed once, in a group the menu draws, with what it follows', () => {
  assert.equal(new Set(Fx.EFFECTS).size, Fx.EFFECTS.length);
  assert.ok(Fx.EFFECTS.length >= 21, 'many ways to move');
  for (const e of Fx.LIST) {
    assert.ok(Fx.GROUPS.includes(e.group), e.id);
    assert.ok(e.needs === null || LightFx.NEEDS.includes(e.needs), e.id);
  }
  assert.deepEqual(Fx.LIST.filter((e) => e.needs === 'sound').map((e) => e.id), ['beat', 'meter'], 'only these read the sound');
  assert.equal(Fx.isEffect('confetti'), false);
  assert.equal(Fx.about('confetti').id, 'still', 'an unknown effect is still');
  assert.equal(Fx.moves('still'), false);
  assert.equal(Fx.moves('comet'), true);
  assert.deepEqual(Faces.LED_EFFECTS.filter((e) => e !== 'auto'), [...Fx.EFFECTS], 'a line can take every one');
});

test('each effect gives one bounded colour per LED, the same for the same time', () => {
  for (const effect of Fx.EFFECTS) {
    for (const count of [1, 8, 24, 37]) {
      for (const now of [0, 333, 12_345, 86_399_000]) {
        const opts = { count, colours, now, ...inputs(now) };
        const out = Fx.frame(effect, opts);
        assert.equal(out.length, count, `${effect} ${count}`);
        for (const c of out) {
          for (const v of [c.r, c.g, c.b]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${effect}: ${JSON.stringify(c)}`);
        }
        assert.deepEqual(Fx.frame(effect, opts), out, `${effect} at ${now} again`);
      }
    }
  }
  assert.deepEqual(Fx.frame('comet', { count: 0, colours }), [], 'no LEDs, no frame');
  assert.deepEqual(Fx.frame('still', { count: 2 }), [{ r: 255, g: 255, b: 255 }, { r: 255, g: 255, b: 255 }], 'no colours: white');
  assert.deepEqual(Fx.frame('confetti', { count: 3, colours, now: 900 }), Fx.frame('still', { count: 3, colours, now: 900 }));
});

test('the other way round mirrors the ring, and slow takes longer to get to the same place', () => {
  const n = 12;
  for (const effect of Fx.EFFECTS) {
    const opts = { count: n, colours, now: 4_321, ...inputs(4_321) };
    const ahead = Fx.frame(effect, opts);
    const back = Fx.frame(effect, { ...opts, reverse: true });
    assert.deepEqual(back, ahead.map((_c, i) => ahead[(n - i) % n]), effect);
  }
  for (const effect of ['spin', 'comet', 'bands', 'chase']) {
    const now = 1_000;
    const normal = Fx.frame(effect, { count: n, colours, now });
    for (const speed of ['slow', 'fast', 1, 100]) {
      // A chase steps no faster than three times a second for each LED, whatever the speed.
      if (effect === 'chase' && 170 * LightFx.paceOf(speed) < 340 / 3) continue;
      const same = Fx.frame(effect, { count: n, colours, now: now * LightFx.paceOf(speed), speed });
      assert.ok(same.every((c, i) => ['r', 'g', 'b'].every((k) => Math.abs(c[k] - normal[i][k]) <= 1)), `${effect} ${speed}`);
    }
    assert.notDeepEqual(Fx.frame(effect, { count: n, colours, now, speed: 'slow' }), normal, `${effect}: slow is another frame`);
  }
});

// A flash: the whole ring's light rising and falling by more than a third of full, as photosensitive
// guidance counts them. Sampled at 60 frames a second over four seconds.
test('no effect flashes the whole ring more than three times a second', () => {
  const FPS = 60;
  const SECONDS = 4;
  for (const effect of Fx.EFFECTS) {
    for (const speed of Fx.SPEEDS) {
      const mean = [];
      for (let f = 0; f < FPS * SECONDS; f++) {
        const now = 10_000 + (f * 1000) / FPS;
        const out = Fx.frame(effect, { count: 24, colours: [{ r: 255, g: 255, b: 255 }], now, speed, ...inputs(now) });
        mean.push(out.reduce((s, c) => s + lum(c), 0) / out.length);
      }
      let flashes = 0;
      let low = mean[0];
      let high = mean[0];
      let rising = true;
      for (const v of mean) {
        if (rising) {
          high = Math.max(high, v);
          if (high - v > 85) { flashes++; rising = false; low = v; }
        } else {
          low = Math.min(low, v);
          if (v - low > 85) { rising = true; high = v; }
        }
      }
      assert.ok(flashes / SECONDS <= 3, `${effect} ${speed}: ${flashes} flashes in ${SECONDS} s`);
    }
  }
});

test('the ones that follow the line show how far it is, how hot, or the time', () => {
  const n = 10;
  const lit = (out) => out.filter((c) => lum(c) > 40).length;
  assert.equal(lit(Fx.frame('level', { count: n, colours: [RED], level: 0.3 })), 3, 'lit up to the reading');
  assert.equal(lit(Fx.frame('level', { count: n, colours: [RED], level: 1 })), n);
  assert.equal(lit(Fx.frame('level', { count: n, colours: [RED], level: null })), n, 'no reading: whole');
  const cool = Fx.frame('heat', { count: 4, colours: [BLUE], level: 0, now: 0 })[0];
  const hot = Fx.frame('heat', { count: 4, colours: [BLUE], level: 1, now: 0 })[0];
  assert.ok(cool.b > cool.r, 'calm: the line\'s own colour');
  assert.ok(hot.r > hot.b && hot.r > hot.g, 'hard at work: red');
  // 03:15:00 local: the hour hand a quarter round plus, the minutes and seconds on their marks.
  const at = new Date(2026, 10, 23, 3, 15, 0).getTime();
  const clock = Fx.frame('clock', { count: 60, colours: [RED, GREEN, BLUE], now: at });
  const brightest = clock.reduce((best, c, i) => (lum(c) > lum(clock[best]) ? i : best), 0);
  assert.equal(brightest, 0, 'the second hand, white, at the top');
  assert.ok(clock[15].g > clock[15].r, 'the minute hand at a quarter past');
});

// face-live.js on a page of its own, as the face page loads it.
function livePage() {
  const { document } = makeDom();
  /** @type {any} */
  const window = { PumpFaces: Faces };
  const ctx = vm.createContext({ window, document, Intl, Number, Math, Date, Object, String, Array, JSON });
  vm.runInContext(readFileSync(new URL('../js/pump/face-kit.js', import.meta.url), 'utf8'), ctx);
  window.PumpFaceKit.setWords({ locale: 'en-US' }, { lang: 'en', tempUnit: 'c' });
  vm.runInContext(readFileSync(new URL('../js/pump/face-live.js', import.meta.url), 'utf8'), ctx);
  return window.PumpFaceKit.get('part', 'live');
}

test('live colours: each reading from cool to hot, a clock by the hour, a song and a picture their own', () => {
  const live = livePage();
  const base = Faces.colorsOf('xenon');
  const sensors = live({ face: 'sensors', readings: ['cpuTemp', 'cpu'] });
  assert.equal(sensors({}), null, 'nothing read yet');
  const calm = sensors({ system: { cpuTemp: 30, cpu: 0 } });
  assert.deepEqual(calm.slice(0, 2), [Faces.LIVE_RAMP[0], Faces.LIVE_RAMP[0]], 'calm readings: the cool end');
  assert.deepEqual(calm.slice(2), base.slice(2), 'a colour with no reading stays Xenon\'s');
  const hot = sensors({ system: { cpuTemp: 95, cpu: 100 } });
  assert.deepEqual(hot.slice(0, 2), [Faces.LIVE_RAMP[3], Faces.LIVE_RAMP[3]], 'working hard: the hot end');
  const half = sensors({ system: { cpuTemp: 30, cpu: 40 } });
  assert.equal(half[1], Faces.LIVE_RAMP[1], 'at 40% the second point of the ramp');
  // Steps of a twentieth: a reading that moves by a hair keeps its colour, so the ring is not retold.
  assert.equal(sensors({ system: { cpu: 41 } })[1], sensors({ system: { cpu: 42 } })[1]);
  const game = live({ face: 'game', readings: ['fps'] });
  assert.equal(game({ system: { fps: 144 } })[0], Faces.LIVE_RAMP[0], 'a high frame rate is calm');
  assert.equal(game({ system: { fps: 0 } })[0], Faces.LIVE_RAMP[3], 'no frames is the strain');
  const clock = live({ face: 'clock' })();
  assert.equal(clock.length, 4);
  assert.ok(clock.every((c) => /^#[0-9a-f]{6}$/.test(c)), 'four colours of the hour');
  assert.equal(live({ face: 'music' })({ system: { cpu: 99 } }), null, 'a song keeps its cover');
  assert.equal(live({ face: 'picture' })({}), null);
  assert.equal(live({ face: 'widget' })({}), null);
});
