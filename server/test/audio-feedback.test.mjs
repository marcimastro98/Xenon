import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SRC = fs.readFileSync(new URL('../js/audio-feedback.js', import.meta.url), 'utf8');

// audio-feedback.js against a fake Web Audio and hand-driven timers.
function load({ webAudio = true } = {}) {
  const contexts = [];
  class FakeContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sleeps = 0; contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; this.sleeps += 1; return Promise.resolve(); }
    node() {
      const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return { connect() {}, start() {}, stop() {}, frequency: param, gain: param };
    }
    createOscillator() { return this.node(); }
    createGain() { return this.node(); }
    createBiquadFilter() { return this.node(); }
  }
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const add = (run, ms, every) => { timers.set(nextId, { at: now + ms, run, every }); return nextId++; };
  const clear = (id) => { timers.delete(id); };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at;
      if (timer.every) timer.at += timer.every; else timers.delete(id);
      timer.run();
    }
    now = end;
  };
  const listeners = {};
  const window = {
    addEventListener: (type, run) => { listeners[type] = run; },
    ...(webAudio ? { AudioContext: FakeContext } : {}),
  };
  const sandbox = {
    window, navigator: {}, setTimeout: (run, ms) => add(run, ms),
    clearTimeout: clear, setInterval: (run, ms) => add(run, ms, ms), clearInterval: clear,
  };
  vm.runInNewContext(SRC, sandbox);
  return { sound: window.XenonSound, contexts, listeners, advance };
}

test('loading the page opens no audio at all', () => {
  const h = load();
  assert.equal(h.contexts.length, 0);
  h.advance(60000);
  assert.equal(h.contexts.length, 0);
});

test('a sound wakes the context, and it sleeps again after the quiet', () => {
  const h = load();
  h.sound.play('notification');
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].state, 'running');
  h.advance(3900);
  assert.equal(h.contexts[0].state, 'running', 'the sound has time to finish');
  h.advance(200);
  assert.equal(h.contexts[0].state, 'suspended');
  h.sound.play('error');
  assert.equal(h.contexts.length, 1, 'the same context comes back');
  assert.equal(h.contexts[0].state, 'running');
});

test('a silent type opens nothing', () => {
  const h = load();
  h.sound.play('success');
  h.sound.play('info');
  assert.equal(h.contexts.length, 0);
});

test('the ring keeps it awake until it stops', () => {
  const h = load();
  h.sound.ring(true);
  h.advance(30000);
  assert.equal(h.contexts[0].sleeps, 0, 'each ring pushes the sleep back');
  h.sound.ring(false);
  h.advance(5000);
  assert.equal(h.contexts[0].state, 'suspended');
});

test('the first touch makes the context WebKit needs, then it sleeps too', () => {
  const h = load();
  h.listeners.pointerdown();
  assert.equal(h.contexts.length, 1);
  h.advance(5000);
  assert.equal(h.contexts[0].state, 'suspended');
});

test('without Web Audio the page stays silent and works', () => {
  const h = load({ webAudio: false });
  h.sound.play('notification');
  h.sound.ring(true);
  h.sound.ring(false);
  assert.equal(h.contexts.length, 0);
});
