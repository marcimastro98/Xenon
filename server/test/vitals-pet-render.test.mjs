// js/vitals-pet.js on the shared Bit engine (shared/src/bit*.js via
// js/bit-app.js): the pet and the topbar chip are live Bits whose mood follows
// the worst meter, they stand still with the rest of the dashboard (game mode,
// low power), a refill or a welcome back plays a move, the menu opens Bit's
// chat, and turning the pet off lets every player go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, '..', p), 'utf8');
const SCRIPTS = ['shared/src/bit-clips.js', 'shared/src/bit.js', 'shared/src/bit-player.js', 'js/bit-app.js', 'js/vitals-pet-core.js', 'js/vitals-pet.js'];
const LABELS = {
  vpet_talk: 'Talk to Bit', vpet_talk_prompt: 'How are my vitals doing?', vitals_level: 'Level {n}', vitals_hydration: 'Hydration',
  vpet_lock_in: 'Locking the computer in {s} s: {vital}!', vpet_streak_days: '{n} days in a row',
};

function mount({ position = 'floating', levels = { hydration: 1 }, pet = {}, zeroAt = {}, mem = {} } = {}) {
  const dom = makeDom();
  const { document, mkEl } = dom;
  const clock = mkEl('div');
  clock.id = 'clock-vitals';
  document.body.appendChild(clock);
  const input = mkEl('textarea');
  input.id = 'ai-text-input';
  document.body.appendChild(input);
  const intervals = new Map();
  let nextId = 0;
  const opened = [];
  const sandbox = {
    document,
    innerWidth: 1280,
    MutationObserver: dom.MutationObserver,
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (fn) => { intervals.set(++nextId, fn); return nextId; },
    clearInterval: (id) => { intervals.delete(id); },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    t: (k) => LABELS[k] || k,
    openAiPanel: () => opened.push(true),
    normalizeSettings: (s) => s,
    saveHubSettings() {},
    hubSettings: { vitals: { enabled: true, items: { hydration: { on: true, min: 45 } }, state: { mem }, pet: { enabled: true, position, sounds: false, ...pet } } },
    VitalsWidget: {
      snapshot: () => ({ enabled: true, ids: Object.keys(levels), levels, zeroAt, away: false }),
      bootSynced: () => true,
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const f of SCRIPTS) vm.runInContext(src(f), sandbox, { filename: f });
  sandbox.VitalsPet.sync();
  const sprite = () => document.querySelector('.vpet-sprite');
  const chipSprite = () => document.querySelector('.cb-sprite');
  return { sandbox, document, sprite, chipSprite, opened, input, tick: () => intervals.forEach((fn) => fn()), levels };
}

test('the floating pet is a live Bit, and its mood follows the worst meter', () => {
  const r = mount({ levels: { hydration: 1, energy: 1 } });
  const player = r.sandbox.BitApp.playerFor(r.sprite());
  assert.ok(player, 'BitApp mounted a player in the pet');
  assert.equal(r.sprite().querySelector('svg').getAttribute('class'), 'xbit');
  assert.equal(player.mood, 'happy');
  r.levels.hydration = 0;
  r.tick();
  assert.equal(player.mood, 'angry');
  r.levels.energy = 0;
  r.tick();
  assert.equal(player.mood, 'drowsy', 'every meter empty');
  r.levels.hydration = 0.2;
  r.levels.energy = 1;
  r.tick();
  assert.equal(player.mood, 'worry');
});

test('the pet stands still with the dashboard: game mode and low power hold it', () => {
  const r = mount();
  const player = r.sandbox.BitApp.playerFor(r.sprite());
  const holds = [];
  player.hold = (h) => holds.push(h);
  for (const cls of ['game-mode', 'low-power-gpu']) {
    r.document.body.classList.add(cls);
    r.sandbox.BitApp.sweep();
    assert.equal(holds.at(-1), true, cls);
    r.document.body.classList.remove(cls);
    r.sandbox.BitApp.sweep();
    assert.equal(holds.at(-1), false, cls + ' lifted');
  }
});

test('a refill plays a thank-you, a new streak a celebration, and the chip is a Bit too', () => {
  const r = mount({ position: 'both' });
  const pet = r.sandbox.BitApp.playerFor(r.sprite());
  const chip = r.sandbox.BitApp.playerFor(r.chipSprite());
  assert.ok(chip, 'the topbar chip carries its own player');
  const played = [];
  pet.play = (id) => played.push('pet:' + id);
  chip.play = (id) => played.push('chip:' + id);
  r.sandbox.VitalsPet.onRefill('hydration', {});
  r.sandbox.VitalsPet.onRefill('hydration', { streakUp: 3 });
  assert.deepEqual(played, ['pet:thanks', 'chip:thanks', 'pet:celebrate', 'chip:celebrate']);
});

test('the menu opens Bit\'s chat with a question ready, and the level reads in words', () => {
  const r = mount();
  r.sprite().click();
  const menu = r.document.querySelector('.vpet-menu');
  assert.ok(menu);
  assert.equal(menu.querySelector('.vpet-menu-lv').textContent, 'Level 1');
  const talk = menu.querySelectorAll('.vpet-menu-act').find((b) => b.textContent === 'Talk to Bit');
  assert.ok(talk, 'a Talk to Bit row');
  talk.click();
  assert.equal(r.opened.length, 1);
  assert.equal(r.input.value, 'How are my vitals doing?');
  assert.equal(r.document.querySelector('.vpet-menu'), null, 'the menu closes');
});

test('turning the pet off lets every Bit go', () => {
  const r = mount({ position: 'both' });
  const btn = r.sprite();
  const spr = r.chipSprite();
  r.sandbox.hubSettings.vitals.pet.enabled = false;
  r.sandbox.VitalsPet.sync();
  assert.equal(r.sandbox.BitApp.playerFor(btn), null);
  assert.equal(r.sandbox.BitApp.playerFor(spr), null);
});

test('with Bit only in the top bar, the lock countdown shows under the chip', () => {
  const now = Date.now();
  const r = mount({
    position: 'topbar',
    levels: { hydration: 0, energy: 1 },
    zeroAt: { hydration: now - 30 * 60000 },
    pet: { lock: true, nightQuiet: false, effects: false },
  });
  assert.equal(r.sprite(), null, 'no floating pet');
  r.sandbox.VitalsPet.onStatus({ idleSec: 0 });
  r.tick(); // the lock warning starts
  r.tick(); // the countdown's first second
  const bubble = r.document.querySelector('.vpet-chip-bubble');
  assert.ok(bubble, 'a bubble under the chip');
  assert.match(bubble.textContent, /^Locking the computer in \d+ s: Hydration!$/);
  assert.equal(bubble.hidden, false);
});

test('the streak reads in words, never an emoji', () => {
  const r = mount({ mem: { streak: 4 } });
  r.sprite().click();
  assert.equal(r.document.querySelector('.vpet-menu-streak').textContent, '4 days in a row');
});

test('the Vitals tile and the pet use no tracked capitals and no text under 11px', () => {
  for (const f of ['components/VitalsWidget/VitalsWidget.css', 'components/VitalsPet/VitalsPet.css']) {
    const css = src(f);
    assert.doesNotMatch(css, /text-transform:\s*uppercase/, f);
    assert.doesNotMatch(css, /letter-spacing:\s*0\.[1-9]\d*em/, f);
  }
  const tile = src('components/VitalsWidget/VitalsWidget.css');
  for (const m of tile.matchAll(/font-size:\s*(\d+)px/g)) assert.ok(Number(m[1]) >= 11, 'font-size ' + m[1] + 'px');
});
