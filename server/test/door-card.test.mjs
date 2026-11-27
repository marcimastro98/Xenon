// The doorbell card (js/alerts/door-card.js) and the picture rule of the cards (js/alerts/toast.js):
// only the two loopback camera proxies become a picture, the buttons follow what the page can do,
// the card gets Bit and a picture kept fresh while it is up, and the bigger view closes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CAM = '/api/unifiprotect/snapshot/cam0001abcd';
const HA_CAM = '/api/ha/camera/snapshot/camera.front_door';

function rig() {
  const dom = makeDom();
  const timers = [];
  const ctx = {
    document: dom.document, console, Date,
    setInterval: (fn, ms) => { timers.push({ fn, ms, on: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].on = false; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, on: true, once: true }); return timers.length; },
    Image: class { set src(v) { this._src = v; if (this.onload) this.onload(); } get src() { return this._src; } },
    BitApp: { still: (clip, px) => `<svg data-clip="${clip}" width="${px}"></svg>` },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/alerts/door-card.js'), ctx);
  return { dom, D: ctx.DoorCard, timers };
}

const words = { door_kicker: 'Campanello', door_title: 'Suonano alla porta', door_who: 'Chi è?', door_who_ask: "Chi c'è alla porta?", door_view: 'Guarda più grande' };
const ctxT = { t: (k) => words[k] || k };

test('the card: words, the camera picture, both buttons on the dashboard', () => {
  const { D } = rig();
  const asked = [];
  const o = D.toast({ name: 'Ingresso', pic: CAM }, ctxT, { ask: (q) => asked.push(q), view: true });
  assert.equal(o.kicker, 'Campanello');
  assert.equal(o.title, 'Suonano alla porta');
  assert.equal(o.message, 'Ingresso');
  assert.match(o.image, /^\/api\/unifiprotect\/snapshot\/cam0001abcd\?ts=\d+$/);
  assert.equal(o.duration, 60000);
  assert.deepEqual([...o.actions.map((a) => a.label)], ['Chi è?', 'Guarda più grande']);
  o.actions[0].onClick();
  assert.deepEqual(asked, ["Chi c'è alla porta?"]);
});

test('the alerts window has no room for the bigger view; no chat means no "who is it"', () => {
  const { D } = rig();
  assert.deepEqual([...D.toast({ pic: CAM }, ctxT, { ask: () => {} }).actions.map((a) => a.label)], ['Chi è?']);
  assert.equal(D.toast({ pic: CAM }, ctxT, {}).actions.length, 0);
});

test('only the two camera proxies are a picture; anything else leaves the card without one', () => {
  const { D } = rig();
  assert.equal(D.picOf({ pic: HA_CAM }), HA_CAM);
  for (const pic of ['https://evil.example/x.jpg', '/api/unifiprotect/snapshot/../../settings', '/api/ha/camera/snapshot/lock.front', `${CAM}?x=1`, 42]) {
    assert.equal(D.picOf({ pic }), '', String(pic));
  }
  const o = D.toast({ pic: 'javascript:alert(1)' }, ctxT, { ask: () => {}, view: true });
  assert.equal(o.image, '');
  assert.deepEqual([...o.actions.map((a) => a.label)], ['Chi è?']);
});

test('a missing word falls back to English, never the key', () => {
  const { D } = rig();
  const o = D.toast({}, { t: (k) => k }, {});
  assert.equal(o.title, 'Someone rang the doorbell');
  assert.equal(o.kicker, 'Doorbell');
});

test('on the card: Bit, the door look, and a picture kept fresh only while it is in sight', () => {
  const { dom, D, timers } = rig();
  const card = dom.mkEl('div');
  const icon = dom.mkEl('span');
  icon.className = 'xtoast-icon xtoast-icon--shot';
  const img = dom.mkEl('img');
  img.src = CAM + '?ts=1';
  icon.appendChild(img);
  card.appendChild(icon);
  dom.document.body.appendChild(card);
  D.toast({ pic: CAM }, ctxT, {}).onMount(card);
  assert.ok(card.classList.contains('xtoast--door'));
  const bit = card.querySelector('.xtoast-door-bit');
  assert.ok(bit, 'Bit sits on the card');
  assert.equal(bit.getAttribute('aria-hidden'), 'true');
  const tick = timers.find((x) => x.ms === 2000);
  assert.ok(tick, 'refreshed every 2 s');
  tick.fn();
  assert.match(img.src, /\?ts=\d+$/);
  assert.notEqual(img.src, CAM + '?ts=1');
  img.src = 'kept';
  card.remove();
  tick.fn();
  assert.equal(img.src, 'kept', 'a card gone from the page fetches nothing');
});

test('a card with no picture is laid out bare', () => {
  const { dom, D, timers } = rig();
  const card = dom.mkEl('div');
  D.toast({ name: 'Ding' }, ctxT, {}).onMount(card);
  assert.ok(card.classList.contains('is-bare'));
  assert.equal(timers.length, 0);
});

test('the bigger view: one at a time, closed by a tap, with its refresh stopped', () => {
  const { dom, D, timers } = rig();
  D.view(CAM, 'Ingresso', ctxT);
  D.view(CAM, 'Ingresso', ctxT);
  const boxes = dom.document.querySelectorAll('.door-view');
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].getAttribute('aria-label'), 'Ingresso');
  const tick = timers.find((x) => x.ms === 1000);
  assert.ok(tick && tick.on);
  boxes[0]._handlers.click[0]({});
  assert.equal(dom.document.querySelectorAll('.door-view').length, 0);
  assert.equal(tick.on, false);
  D.view('https://evil.example/x', '', ctxT);
  assert.equal(dom.document.querySelectorAll('.door-view').length, 0);
});

test('the dashboard events: a ring shows its card, a Deck key opens the big view, a bad picture nothing', () => {
  const { dom, D } = rig();
  const shown = [];
  const can = { view: true, show: (o) => shown.push(o) };
  D.onEvent('home_ring', { name: 'Ingresso', pic: CAM }, ctxT, can);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Suonano alla porta');
  assert.equal(dom.document.querySelectorAll('.door-view').length, 0, 'a ring never opens the big view by itself');
  D.onEvent('home_camera', { name: 'Giardino', pic: HA_CAM }, ctxT, can);
  const box = dom.document.querySelectorAll('.door-view');
  assert.equal(box.length, 1);
  assert.equal(box[0].getAttribute('aria-label'), 'Giardino');
  assert.equal(shown.length, 1, 'the camera key is no pop-up');
  box[0]._handlers.click[0]({});
  D.onEvent('home_camera', { name: 'x', pic: '//evil.example/x' }, ctxT, can);
  D.onEvent('something_else', { pic: CAM }, ctxT, can);
  assert.equal(dom.document.querySelectorAll('.door-view').length, 0);
});

test('toast.js takes the camera proxies as a picture, and nothing else', () => {
  const src = read('../js/alerts/toast.js');
  const m = src.match(/const SHOT_PATH = (\/.*\/);\n/);
  assert.ok(m, 'SHOT_PATH found');
  const SHOT = vm.runInNewContext(m[1]);
  for (const ok of ['/captures/thumb?f=a.png', CAM, CAM + '?ts=1764180000000', HA_CAM, HA_CAM + '?ts=1']) assert.ok(SHOT.test(ok), ok);
  for (const bad of ['https://x.example/a.png', CAM + '?ts=1&x=2', '/api/ha/camera/snapshot/lock.front', '/api/unifiprotect/snapshot/a/b']) assert.ok(!SHOT.test(bad), bad);
});
