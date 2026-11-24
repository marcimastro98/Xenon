// The Fans tile's line about Airflow (js/fans-widget/airflow-line.js), on the small DOM: who
// drives the fans and why, a tap that opens the Fans section, nothing where Xenon cannot reach
// the fans, and the live event that keeps it current without a poll.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from './browser-source.mjs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const SRC = readFileSync(new URL('../js/fans-widget/airflow-line.js', import.meta.url), 'utf8');
const EN = readFileSync(new URL('../js/i18n/en.js', import.meta.url), 'utf8');
const { PRIORITY } = require('../airflow/reasons.js');

function rig({ answer = null, menu = true } = {}) {
  const { document } = makeDom();
  const opened = [];
  const listeners = [];
  const window = {
    t: (k) => `<${k}>`,
    addEventListener: (type, fn) => { if (type === 'xenon-menu-changed') listeners.push(fn); },
    XenonMenuPanel: menu ? { open: (s) => opened.push(s) } : undefined,
  };
  const fetched = [];
  const ctx = vm.createContext({
    window, document,
    makeEl: (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; },
    apiJson: async (url) => { fetched.push(url); return answer; },
  });
  vm.runInContext(SRC, ctx);
  const slot = document.createElement('div');
  slot.className = 'fanw-air-slot';
  document.body.appendChild(slot);
  const line = window.FansAirflowLine;
  const send = (name, data) => listeners.forEach((fn) => fn({ detail: { name, data } }));
  return { slot, line, opened, fetched, send };
}

const words = (slot) => ({
  title: slot.querySelector('.fanw-air-title')?.textContent ?? null,
  sub: slot.querySelector('.fanw-air-sub')?.textContent ?? null,
  cls: slot.children[0]?.className ?? null,
});

test('the reasons it can say are exactly the engine\'s, and every word it uses exists', () => {
  const whys = vm.runInNewContext(`${SRC.match(/const WHYS = Object\.freeze\((\[[\s\S]*?\])\);/)[1]}`);
  assert.deepEqual([...whys], [...PRIORITY]);
  const keys = [...['off', 'checking', 'watching', 'pc', 'driving'].map((s) => `airflow_state_${s}`), ...PRIORITY.map((w) => `airflow_why_${w.replace(/-/g, '_')}`)];
  for (const k of keys) assert.match(EN, new RegExp(`^  ${k}: '`, 'm'), k);
});

test('driving: who drives and why, read once, and a tap opens the Fans section', async () => {
  const r = rig({ answer: { ok: true, state: 'driving', why: 'heat-gpu', check: null, fans: [] } });
  await r.line.seed();
  assert.deepEqual(r.fetched, ['/airflow']);
  assert.deepEqual(words(r.slot), { title: '<airflow_state_driving>', sub: '<airflow_why_heat_gpu>', cls: 'fanw-air is-on' });
  const button = r.slot.children[0];
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.type, 'button');
  button.click();
  assert.deepEqual(r.opened, ['airflow']);
});

test('a warning reason is told as one, and an unknown reason is never shown raw', async () => {
  const r = rig({ answer: { ok: true, state: 'driving', why: 'stall' } });
  await r.line.seed();
  assert.equal(words(r.slot).cls, 'fanw-air is-warn');
  r.line.onSSE({ state: 'watching', why: 'Not-A-Code' });
  assert.deepEqual(words(r.slot), { title: '<airflow_state_watching>', sub: '<airflow_why_idle>', cls: 'fanw-air is-on' });
});

test('off and back to the PC: the state alone, quiet', async () => {
  const r = rig({ answer: { ok: true, state: 'off', why: null } });
  await r.line.seed();
  assert.deepEqual(words(r.slot), { title: '<airflow_state_off>', sub: null, cls: 'fanw-air is-idle' });
  r.line.onSSE({ state: 'pc', why: 'idle' });
  assert.deepEqual(words(r.slot), { title: '<airflow_state_pc>', sub: null, cls: 'fanw-air is-idle' });
});

test('the fan check shows how far it is', () => {
  const r = rig();
  r.line.onSSE({ state: 'checking', why: null, check: { phase: 'pair', progress: 0.416 } });
  assert.deepEqual(words(r.slot), { title: '<airflow_state_checking>', sub: '42%', cls: 'fanw-air is-on' });
  r.line.onSSE({ state: 'checking', check: { progress: 7 } });
  assert.equal(words(r.slot).sub, '100%');
});

test('where Xenon cannot reach the fans, or the read fails, there is no line', async () => {
  for (const answer of [{ ok: false, error: 'unavailable' }, { ok: true, state: 'unavailable' }, null, { ok: true, state: 'nonsense' }]) {
    const r = rig({ answer });
    await r.line.seed();
    assert.equal(r.slot.children.length, 0, JSON.stringify(answer));
  }
});

test('without the Xenon menu on this page the line still says the truth, without a dead button', async () => {
  const r = rig({ answer: { ok: true, state: 'driving', why: 'idle' }, menu: false });
  await r.line.seed();
  const line = r.slot.children[0];
  assert.notEqual(line.tagName, 'BUTTON');
  assert.equal(r.slot.querySelector('.fanw-air-go'), null);
});

test('the live event changes the line in place; other events and garbled data leave it alone', async () => {
  const r = rig({ answer: { ok: true, state: 'driving', why: 'idle' } });
  await r.line.seed();
  r.send('airflow', JSON.stringify({ state: 'driving', why: 'game-prepare', check: null }));
  await settle();
  assert.equal(words(r.slot).sub, '<airflow_why_game_prepare>');
  r.send('settings', JSON.stringify({ state: 'off' }));
  r.send('airflow', '{not json');
  assert.equal(words(r.slot).sub, '<airflow_why_game_prepare>');
  assert.deepEqual(r.fetched, ['/airflow'], 'no poll: one read, then events');
});

test('the Fans tile keeps a slot for the line and the dashboard passes the event on', () => {
  const tile = readFileSync(new URL('../js/fans-widget/fans-widget.js', import.meta.url), 'utf8');
  assert.match(tile, /el\('div', 'fanw-air-slot'\)/);
  assert.match(tile, /window\.FansAirflowLine\.seed\(\)/);
  const stream = readFileSync(new URL('../js/grid/data-stream.js', import.meta.url), 'utf8');
  assert.match(stream, /'deck', 'airflow'\]\.forEach[\s\S]{0,200}new CustomEvent\('xenon-menu-changed', \{ detail: \{ name, data: e\.data \} \}\)/);
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(page.indexOf('js/fans-widget/airflow-line.js') < page.indexOf('js/fans-widget/fans-widget.js'));
});
