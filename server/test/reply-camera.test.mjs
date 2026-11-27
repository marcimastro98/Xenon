// A home camera in Bit's reply (js/ai/reply-camera.js): only the two loopback picture paths, the
// name as text, the picture kept fresh while it is in sight and only for five minutes, and the
// question before Bit's first look: where the picture would go, three answers, and only the
// person's tap reaching the consent route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));
const CAM = '/api/ha/camera/snapshot/camera.giardino';

function rig({ voice = false, respond = () => ({ ok: true }) } = {}) {
  const dom = makeDom();
  if (voice) dom.document.body.classList.add('ai-voice-mode');
  const timers = [];
  const calls = [];
  const asked = [];
  const viewed = [];
  let clock = Date.parse('2026-11-26T18:00:00Z');
  const ctx = {
    document: dom.document, console, innerHeight: 800,
    Date: class extends Date { static now() { return clock; } },
    setTimeout: (fn) => { timers.push({ fn, once: true }); return timers.length; },
    setInterval: (fn, ms) => { timers.push({ fn, ms, on: true }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].on = false; },
    Image: class { set src(v) { this._src = v; if (this.onload) this.onload(); } get src() { return this._src; } },
    t: (k) => ({ cam_ask_text: 'Bit manderebbe la foto a {service}.', cam_go: 'Sì, guarda {name}' }[k] || `t:${k}`),
    SERVER: 'http://pc',
    aiAsk: (text) => asked.push(text),
    DoorCard: { view: (pic, name) => viewed.push({ pic, name }) },
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      const out = respond();
      return { ok: !(out && out.status >= 400), json: async () => out };
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/ai/reply-camera.js'), ctx);
  const bubble = () => {
    const b = dom.mkEl('div');
    dom.document.body.appendChild(b);
    return b;
  };
  const ticks = () => timers.filter((x) => x.on && x.ms);
  const later = (ms) => { clock += ms; ticks().forEach((x) => x.fn()); };
  const click = (target) => dom.document._handlers.click[0]({ target });
  return { dom, R: ctx.BitCamera, timers, calls, asked, viewed, bubble, later, ticks, click };
}

test('a reply takes the picture its turn queued: the proxy path, the name as text, no question', () => {
  const { dom, R, bubble } = rig();
  R.queue({ pic: CAM, name: '<b>Giardino</b>' });
  const b = bubble();
  R.take(b);
  const box = b.querySelector('.ai-cam');
  assert.equal(box.dataset.pic, CAM);
  assert.match(box.querySelector('.ai-cam-shot img').src, /^http:\/\/pc\/api\/ha\/camera\/snapshot\/camera\.giardino\?ts=\d+$/);
  assert.equal(box.querySelector('.ai-cam-name').textContent, '<b>Giardino</b>');
  assert.equal(box.querySelector('.ai-cam-ask'), null);
  assert.equal(dom.document.querySelectorAll('.ai-cam').length, 1);
});

test('anything but the two camera paths is dropped, and voice has no chat to hold it', () => {
  const { R, bubble } = rig();
  for (const pic of ['https://example.com/x.jpg', '/api/ha/camera/snapshot/light.x', '/api/unifiprotect/snapshot/../x', null]) R.queue({ pic, name: 'x' });
  const b = bubble();
  R.take(b);
  assert.equal(b.querySelector('.ai-cam'), null);
  const v = rig({ voice: true });
  v.R.queue({ pic: CAM, name: 'Giardino' });
  const vb = v.bubble();
  v.R.take(vb);
  assert.equal(vb.querySelector('.ai-cam'), null);
});

test('the picture refreshes while in sight, skips when off screen, and stops after five minutes', () => {
  const { R, bubble, later, ticks } = rig();
  R.queue({ pic: CAM, name: 'Giardino' });
  const b = bubble();
  R.take(b);
  const img = b.querySelector('.ai-cam-shot img');
  const first = img.src;
  later(2000);
  assert.equal(img.src, first, 'not laid out: nothing fetched');
  img._rect = { width: 300, height: 170 };
  later(2000);
  assert.notEqual(img.src, first);
  later(5 * 60 * 1000);
  assert.equal(ticks().length, 0, 'the timer stops when no picture is live');
});

test('the question names where the picture goes; a local model keeps it on the PC', () => {
  const { R, bubble } = rig();
  R.queue({ pic: CAM, name: 'Giardino', ask: { provider: 'gemini' } });
  const b = bubble();
  R.take(b);
  assert.equal(b.querySelector('.ai-cam-ask-text').textContent, 'Bit manderebbe la foto a Google Gemini.');
  const answers = b.querySelectorAll('.ai-cam-ask-btn').map((x) => x.dataset.camConsent);
  assert.deepEqual(answers, ['yes', 'once', 'no']);
  R.queue({ pic: '/api/unifiprotect/snapshot/cam0001abcd', name: 'Ingresso', ask: { provider: 'ollama' } });
  const b2 = bubble();
  R.take(b2);
  assert.equal(b2.querySelector('.ai-cam-ask-text').textContent, 't:cam_ask_local');
});

test('a yes is sent by the tap, every copy of the question goes, and Bit is asked to look', async () => {
  const { R, bubble, calls, asked, click, dom } = rig();
  R.queue({ pic: CAM, name: 'Giardino', ask: { provider: 'xenon' } });
  const b = bubble();
  R.take(b);
  click(b.querySelector('[data-cam-consent="once"]'));
  await flush();
  assert.deepEqual(calls, [{ url: 'http://pc/api/home/cameras/consent', method: 'POST', body: { choice: 'once', pic: CAM, local: false } }]);
  assert.equal(dom.document.querySelector('.ai-cam-ask'), null);
  assert.ok(b.querySelector('.ai-cam-shot'), 'the picture stays');
  assert.deepEqual(asked, ['Sì, guarda Giardino']);
});

test('"no" sends nothing; a failed save keeps the question and says so', async () => {
  const ok = rig();
  ok.R.queue({ pic: CAM, name: 'Giardino', ask: { provider: 'gemini' } });
  const b = ok.bubble();
  ok.R.take(b);
  ok.click(b.querySelector('[data-cam-consent="no"]'));
  await flush();
  assert.equal(ok.calls.length, 0);
  assert.equal(ok.asked.length, 0);
  assert.equal(b.querySelector('.ai-cam-ask'), null);

  const bad = rig({ respond: () => ({ ok: false, error: 'bad_request' }) });
  bad.R.queue({ pic: CAM, name: 'Giardino', ask: { provider: 'gemini' } });
  const b2 = bad.bubble();
  bad.R.take(b2);
  bad.click(b2.querySelector('[data-cam-consent="yes"]'));
  await flush();
  assert.equal(bad.asked.length, 0);
  assert.equal(b2.querySelector('.ai-cam-ask-text').textContent, 't:cam_ask_failed');
  assert.ok(b2.querySelectorAll('.ai-cam-ask-btn').every((x) => !x.disabled));
});

test('a tap on the picture opens it bigger', () => {
  const { R, bubble, click, viewed } = rig();
  R.queue({ pic: CAM, name: 'Giardino' });
  const b = bubble();
  R.take(b);
  click(b.querySelector('.ai-cam-shot img'));
  assert.deepEqual(viewed, [{ pic: CAM, name: 'Giardino' }]);
});
