// Bit never freezes on its own screen: the player's paces (packages/core/src/bit-player.js), the
// pace the own Bit follows (js/bit-companion/moments.js), a moment that waits for a stopped Bit,
// and the stream events that now reach it (Claude Code, Codex, files from the phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { FakeEl, bootPlayer, read } from './bit-player-fake.mjs';

const require = createRequire(import.meta.url);
const frameTimers = (clock) => [...clock.pending.values()].filter((t) => t.ms < 30000);

test('asleep and game paces leave no timer; slow waits 40 to 90 seconds for a fidget', () => {
  const { clock, Xenon } = bootPlayer();
  const p = Xenon.bitPlayer.mount(new FakeEl('span'), { reducedMotion: false });
  assert.ok(frameTimers(clock).length > 0, 'live: the mood loops');
  for (const pace of ['asleep', 'game']) {
    p.setPace(pace);
    assert.equal(clock.pending.size, 0, `${pace}: nothing ticks`);
    assert.equal(p.running, true, `${pace} is not a stop: reactions still play`);
  }
  p.setPace('slow');
  const waits = [...clock.pending.values()];
  assert.equal(waits.length, 1, 'slow: only the next fidget waits');
  assert.ok(waits[0].ms >= 40000 && waits[0].ms <= 90000, String(waits[0].ms));
  p.setPace('nonsense');
  assert.equal(p.pace, 'live', 'an unknown pace is live');
  p.destroy();
});

test('a reaction asked while Bit is held waits, then plays and ends when it is let go', async () => {
  const { clock, Xenon } = bootPlayer();
  let woke = 0;
  const p = Xenon.bitPlayer.mount(new FakeEl('span'), { reducedMotion: false, fidgets: false, onWake: () => { woke += 1; } });
  p.hold(true);
  let done = false;
  const played = p.play('nod').then(() => { done = true; });
  assert.equal(clock.pending.size, 0, 'held: no frame runs');
  assert.equal(p.clip, 'nod', 'it waits as the clip to play');
  p.hold(false);
  assert.equal(woke, 1, 'the app is told it plays again');
  assert.ok(clock.pending.size > 0, 'let go: the reaction plays');
  for (let i = 0; i < 40 && !done; i += 1) { clock.runNext(); await Promise.resolve(); }
  await played;
  assert.equal(p.clip, 'idle', 'back to its mood');
  p.destroy();
});

test('a player with its own fidget list never plays the same one twice in a row', () => {
  const D = require('../../packages/core/src/bit-director.js');
  const recent = ['doubleBlink'];
  for (let i = 0; i < 20; i += 1) {
    const id = D.idleFidget(D.CLASSIC, {}, recent, ['doubleBlink', 'lookAround']);
    assert.equal(id, 'lookAround');
  }
  assert.equal(D.idleFidget(D.CLASSIC, {}, [], ['nope']), null, 'unknown clips are skipped');
  assert.equal(D.idleGap(D.CLASSIC, 'asleep'), 0);
  assert.equal(D.idleGap(D.CLASSIC, 'game'), 0);
  const calm = D.idleGap({ idleGapMs: () => 1000 }, 'live', {}, true);
  assert.equal(calm, 2500, 'a calm place waits longer');
});

// moments.js in a page with an own Bit: `players` stand for the own Bits' players.
function bootMoments({ classes = [], phone = false, players = [], hatched = true } = {}) {
  const body = new Set(classes);
  const reacted = [];
  const observers = [];
  const ctx = {
    Math, Date, Number, Array, Set, Map, String, Object, JSON,
    MutationObserver: class { constructor(cb) { observers.push(cb); } observe() {} },
    queueMicrotask: (fn) => fn(),
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      body: { classList: { contains: (c) => body.has(c) } },
      documentElement: { classList: { contains: (c) => phone && c === 'is-phone' } },
      querySelectorAll: () => players.map((p) => ({ p })),
    },
  };
  ctx.window = ctx;
  ctx.Xenon = { bitDirector: require('../../packages/core/src/bit-director.js') };
  ctx.BitApp = {
    state: () => ({ hatched }),
    sweep() {},
    playerFor: (host) => host.p,
    context: () => ({ hour: 14 }),
    director: () => ({ react: (name) => { reacted.push(name); return `clip:${name}`; } }),
  };
  vm.createContext(ctx);
  vm.runInContext(read('../js/bit-companion/moments.js'), ctx, { filename: 'moments.js' });
  const classChanged = (oldValue) => observers.forEach((cb) => cb([{ oldValue }]));
  return { M: ctx.BitMoments, ctx, body, reacted, classChanged };
}

function fakePlayer(running = true) {
  return { running, plays: [], play(id) { this.plays.push(id); } };
}

test('the own Bit slows down where the dashboard rests, sleeps when the person is away, never freezes', () => {
  const noon = new Date(2026, 10, 26, 12);
  const night = new Date(2026, 10, 26, 3);
  const { M, body, ctx } = bootMoments();
  assert.equal(M.pace(noon), 'live');
  for (const cls of ['ambient-idle', 'low-power-gpu', 'perf-mode']) {
    body.add(cls);
    assert.equal(M.pace(noon), 'slow', cls);
    body.delete(cls);
  }
  body.add('ambient-idle');
  ctx.BitStroll = { walking: () => true };
  assert.equal(M.pace(noon), 'live', 'out for a stroll it walks at full pace');
  delete ctx.BitStroll;
  body.delete('ambient-idle');
  body.add('game-mode');
  assert.equal(M.pace(noon), 'game');
  body.add('overlay-frozen');
  assert.equal(M.pace(noon), 'still', 'a frosted overlay still stops it');
  body.clear();
  M.onStatus({ idleSec: 90 });
  assert.equal(M.pace(noon), 'live', 'a minute and a half away by day');
  assert.equal(M.pace(night), 'asleep', 'the same at night: asleep');
  M.onStatus({ idleSec: 400 });
  assert.equal(M.pace(noon), 'asleep');
  assert.equal(bootMoments({ phone: true }).M.pace(night), 'live', 'a phone is in a hand, never asleep');
});

test('a moment for a stopped Bit waits, the last one only, and plays when it can', () => {
  const p = fakePlayer(false);
  const { M, reacted } = bootMoments({ players: [p] });
  assert.equal(M.react('download'), null);
  assert.equal(M.react('update'), null);
  assert.deepEqual(reacted, [], 'nothing reached the director: no cooldown or hourly cap spent');
  p.running = true;
  assert.equal(M.woke(), true);
  assert.deepEqual(reacted, ['update'], 'only the last one');
  assert.deepEqual(p.plays, ['clip:update']);
  assert.equal(M.woke(), false, 'played once');
});

test('asleep, only what matters wakes Bit; the rest waits for it', () => {
  const p = fakePlayer(true);
  const { M, reacted } = bootMoments({ players: [p] });
  M.onStatus({ idleSec: 400 });
  assert.equal(M.react('trackChange'), null);
  assert.equal(M.react('stage'), 'clip:stage', 'growing up wakes it');
  M.onStatus({ idleSec: 600 });
  M.onStatus({ idleSec: 1 });
  assert.ok(reacted.includes('trackChange'), 'back at the PC, the waiting moment plays');
});

test('Claude Code and Codex sessions, and files from the phone, reach Bit', () => {
  const p = fakePlayer(true);
  const { M, reacted } = bootMoments({ players: [p] });
  const handlers = {};
  // Like an EventSource: every listener of an event hears it (the signs listen to the same events).
  M.listen({ addEventListener: (name, fn) => { (handlers[name] ||= []).push(fn); } });
  const send = (name, data) => handlers[name].forEach((fn) => fn({ data: JSON.stringify(data) }));
  const sessions = (...list) => ({ live: { sessions: list } });
  send('claude', sessions({ id: 'a', state: 'idle' }));
  assert.deepEqual(reacted, [], 'what is there at load is no news');
  send('claude', sessions({ id: 'a', state: 'running' }));
  send('claude', sessions({ id: 'a', state: 'idle' }));
  send('claude', sessions({ id: 'a', state: 'running' }));
  send('claude', sessions({ id: 'a', state: 'running', waitFor: 'permission' }));
  send('codex', sessions({ id: 'x', state: 'running' }));
  send('codex', sessions({ id: 'x', state: 'idle', ended: true, endedReason: 'gone' }));
  assert.deepEqual(reacted, ['claudeWorking', 'claudeDone', 'claudeWorking', 'notification'], 'a killed session is no finish');
  reacted.length = 0;
  send('transfer', { items: [{ id: 'f1', direction: 'in' }] });
  send('transfer', { items: [{ id: 'f1', direction: 'in' }, { id: 'f2', direction: 'out' }] });
  assert.deepEqual(reacted, [], 'a file sent out is not a delivery');
  send('transfer', { items: [{ id: 'f1', direction: 'in' }, { id: 'f3', direction: 'in' }] });
  send('update_auto', { phase: 'downloading' });
  send('update_auto', { phase: 'countdown' });
  send('calendar_reminder', {});
  assert.deepEqual(reacted, ['download', 'update', 'calendarSoon']);
  send('claude', 'broken');
  handlers.transfer[0]({ data: '{not json' });
});

test('a notification opening on the island is news for Bit, once per opening', () => {
  const { body, reacted, classChanged } = bootMoments({ players: [fakePlayer(true)] });
  classChanged('topbar-minimal');
  assert.deepEqual(reacted, [], 'another class: nothing');
  body.add('xtoast-island');
  classChanged('topbar-minimal');
  assert.deepEqual(reacted, ['notification']);
  classChanged('topbar-minimal xtoast-island');
  assert.deepEqual(reacted, ['notification'], 'the next card on an island already open is no new opening');
  body.delete('xtoast-island');
  classChanged('topbar-minimal xtoast-island');
  assert.deepEqual(reacted, ['notification'], 'closing is nothing');
});

test('while Claude Code or Codex work, every resting own Bit sits at its laptop, and gets up when none runs', () => {
  const mood = (m) => ({ running: true, mood: m, plays: [], play() {}, setMood(id) { this.mood = id; } });
  const [rest, walking] = [mood('idle'), mood('walk')];
  const { M, ctx } = bootMoments({ players: [rest, walking] });
  ctx.Xenon.bit = { clip: (id) => (id === 'code' ? { id } : null) };
  const flips = [];
  ctx.dispatchEvent = (e) => flips.push(e.type);
  ctx.CustomEvent = class { constructor(type) { this.type = type; } };
  const handlers = {};
  M.listen({ addEventListener: (name, fn) => { (handlers[name] ||= []).push(fn); } });
  const send = (name, ...list) => handlers[name].forEach((fn) => fn({ data: JSON.stringify({ live: { sessions: list } }) }));
  send('claude', { id: 'a', state: 'running' });
  assert.equal(rest.mood, 'code', 'at work from the first word, a session already running included');
  assert.equal(walking.mood, 'walk', 'one out walking is left to its walk');
  assert.equal(M.rest(), 'code');
  assert.equal(M.working(), true);
  send('codex', { id: 'c', state: 'idle' });
  assert.equal(rest.mood, 'code', 'Codex resting: Claude Code still works');
  send('claude', { id: 'a', state: 'idle' });
  assert.equal(rest.mood, 'idle', 'none runs: back to its usual rest');
  assert.deepEqual(flips, ['xenon-bit-work', 'xenon-bit-work'], 'told on each change only, for the desktop Bit');
  send('codex', { id: 'c', state: 'running', waitFor: 'permission' });
  assert.equal(rest.mood, 'idle', 'one asking is not working');
});

test('the laptop loop is calm: it plays on the slow pace too, every other loop rests there', () => {
  const { clock, Xenon } = bootPlayer();
  const move = require('../../packages/core/src/bit-clips-move.js');
  Xenon.bit.addPack(move);
  const code = Xenon.bit.clip('code');
  assert.equal(code.kind, 'mood');
  assert.ok(code.frames.length <= 24, 'fits the desktop message (desk-frames.js MAX_FRAMES)');
  const avg = code.frames.reduce((a, f) => a + f.ms, 0) / code.frames.length;
  assert.ok(avg >= 300, `about three frames a second or fewer (${Math.round(avg)} ms)`);
  const p = Xenon.bitPlayer.mount(new FakeEl('span'), { reducedMotion: false });
  p.setPace('slow');
  p.setMood('code');
  assert.ok(frameTimers(clock).length > 0, 'slow: the laptop loop still plays');
  p.setMood('idle');
  assert.equal(frameTimers(clock).length, 0, 'slow: the usual rest is still');
  p.destroy();
});
