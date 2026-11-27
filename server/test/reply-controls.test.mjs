// Live controls in Bit's replies (js/ai/reply-controls.js): the turn queues what Bit set, its
// reply takes it, and every copy of the chat follows the live state through the endpoints the
// Volume, Media and Smart Home tiles already use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom } from './mini-dom.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

const LAMP = { kind: 'light', entity: 'light.desk_lamp', name: 'Desk lamp', dimmable: true, on: true, pct: 60 };

function rig({ voice = false, respond = () => ({ ok: true }) } = {}) {
  const dom = makeDom();
  dom.document.visibilityState = 'visible';
  // Laid out nowhere until a test says a control is in sight.
  const make = dom.document.createElement;
  dom.document.createElement = (tag) => Object.assign(make(tag), { getClientRects: () => [] });
  if (voice) dom.document.body.classList.add('ai-voice-mode');
  const timers = [];
  const calls = [];
  const ctx = {
    document: dom.document, console, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    t: (k) => `t:${k}`,
    SERVER: 'http://pc',
    fetch: async (url, init = {}) => {
      const path = url.replace('http://pc', '');
      calls.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      const out = respond(path, init);
      return { ok: !(out && out.status >= 400), json: async () => out };
    },
  };
  ctx.window = ctx;
  vm.runInNewContext(read('../js/ai/reply-controls.js'), ctx);
  const bubble = () => {
    const b = dom.mkEl('div');
    b.className = 'ai-msg-bubble';
    dom.document.body.appendChild(b);
    return b;
  };
  // Run what is due now, in order; later timers stay for the test to run.
  const run = (max = 0) => {
    const due = timers.filter((x) => !x.done && x.ms <= max);
    due.forEach((x) => { x.done = true; x.fn(); });
    return due.length;
  };
  const rows = (kind) => dom.document.querySelectorAll(`.ai-ctl[data-ctl="${kind}"]`);
  const click = (target) => dom.document._handlers.click[0]({ target });
  const fire = (type, target) => dom.document._handlers[type][0]({ target });
  const seen = () => dom.document.querySelectorAll('.ai-ctl').forEach((r) => { r.getClientRects = () => [1]; });
  return { dom, C: ctx.BitControls, timers, calls, bubble, run, rows, click, fire, seen };
}

// A chat shown in a second tile is an HTML copy (mirrorChatCopies): attributes come along.
function mirror(dom, node) {
  const copy = Object.assign(dom.mkEl(node.tag), { getClientRects: () => [] });
  copy.className = node.className;
  Object.assign(copy.attrs, node.attrs);
  Object.assign(copy.dataset, node.dataset);
  copy._text = node._text;
  copy._html = node._html;
  node.children.forEach((c) => copy.appendChild(mirror(dom, c)));
  return copy;
}

test('a reply takes the controls its turn queued, each drawn whole', () => {
  const r = rig();
  for (const c of [{ kind: 'volume' }, LAMP, { kind: 'media' }, { kind: 'mic' }]) r.C.queue(c);
  const b = r.bubble();
  r.C.take(b);
  const set = b.querySelector('.ai-ctl-set');
  assert.ok(set, 'the controls sit inside the reply');
  assert.deepEqual(set.children.map((n) => n.dataset.ctl), ['volume', 'light', 'media', 'mic']);

  const [vol, lamp, media, mic] = set.children;
  assert.equal(vol.querySelector('.ai-ctl-main').getAttribute('aria-label'), 't:vol_mute_tip');
  assert.equal(vol.querySelector('.ai-ctl-range').getAttribute('aria-label'), 't:vol_title');
  assert.ok(vol.querySelector('.ai-ctl-val'));

  assert.equal(lamp.dataset.entity, 'light.desk_lamp');
  assert.equal(lamp.querySelector('.ai-ctl-name').textContent, 'Desk lamp');
  assert.equal(lamp.dataset.state, 'on');
  assert.equal(lamp.querySelector('.ai-ctl-main').getAttribute('aria-pressed'), 'true');
  const range = lamp.querySelector('.ai-ctl-range');
  assert.equal(range.getAttribute('value'), '60', 'the attribute too: a copy of the HTML keeps it');
  assert.equal(range.style.getPropertyValue('--fill'), '60%');
  assert.equal(lamp.querySelector('.ai-ctl-val').textContent, '60%');

  assert.deepEqual(media.querySelectorAll('button').map((n) => n.dataset.ctlDo), ['main', 'previous', 'next']);
  assert.ok(media.querySelector('.ai-ctl-sub'));
  assert.equal(media.querySelector('.ai-ctl-range'), null);
  assert.equal(mic.querySelector('.ai-ctl-range'), null);
  assert.equal(mic.querySelector('.ai-ctl-val'), null);

  const next = r.bubble();
  r.C.take(next);
  assert.equal(next.querySelector('.ai-ctl-set'), null, 'one reply takes them once');
});

test('only our controls: unknown kinds, a light that is not one, past four, voice mode', () => {
  const r = rig();
  r.C.queue({ kind: 'lock' });
  r.C.queue({ kind: 'light', entity: 'lock.front_door' });
  r.C.queue({ kind: 'light', entity: 'light.Bad-Id' });
  r.C.queue({ kind: 'light', entity: 'light.hall', name: '<b>' + 'x'.repeat(100) });
  for (let i = 0; i < 5; i++) r.C.queue({ kind: 'volume' });
  const b = r.bubble();
  r.C.take(b);
  const set = b.querySelector('.ai-ctl-set');
  assert.equal(set.children.length, 4);
  const hall = set.children[0];
  assert.equal(hall.querySelector('.ai-ctl-name').textContent, '<b>' + 'x'.repeat(77), 'a name is text, cut at 80');
  assert.equal(hall.dataset.state, undefined, 'no state until the live one arrives');
  assert.equal(hall.querySelector('.ai-ctl-range'), null, 'not dimmable unless HA said so');

  const v = rig({ voice: true });
  v.C.queue({ kind: 'volume' });
  const vb = v.bubble();
  v.C.take(vb);
  assert.equal(vb.querySelector('.ai-ctl-set'), null, 'voice has no chat to hold it');
});

test('a control no reply took is gone by the next tick', () => {
  const r = rig();
  r.C.queue({ kind: 'volume' });
  r.run();
  const b = r.bubble();
  r.C.take(b);
  assert.equal(b.querySelector('.ai-ctl-set'), null);
});

test('reads only what the reply shows, and every copy follows', async () => {
  const r = rig({ respond: (p) => (p === '/audio' ? { speaker: { volume: 35, muted: true } } : { ok: true }) });
  r.C.queue({ kind: 'volume' });
  r.C.queue(LAMP);
  const b = r.bubble();
  r.C.take(b);
  const copy = r.bubble();
  copy.appendChild(mirror(r.dom, b.querySelector('.ai-ctl-set')));
  r.seen();
  r.run();
  await flush();
  assert.deepEqual(r.calls.map((c) => `${c.method} ${c.path}`), ['GET /audio', 'POST /ha/deck-watch']);
  const watch = r.calls[1].body;
  assert.match(watch.client, /^[a-z0-9]{4,24}$/, 'an id the watch route accepts');
  assert.deepEqual(watch.entities, ['light.desk_lamp']);
  for (const row of r.rows('volume')) {
    assert.equal(row.dataset.state, 'off');
    assert.equal(row.querySelector('.ai-ctl-main').getAttribute('aria-pressed'), 'true', 'pressed = muted');
    assert.equal(row.querySelector('.ai-ctl-val').textContent, '35%');
  }
  assert.equal(r.rows('volume').length, 2);
  assert.ok(r.timers.some((x) => x.ms === 25000), 'one slow tick keeps them live');
});

test('a tap acts on every copy at once, and says so when it fails', async () => {
  const r = rig({ respond: (p) => (p === '/speaker/mute' ? { status: 500, error: 'audio not ready' } : { ok: true }) });
  r.C.queue({ kind: 'volume' });
  r.C.queue(LAMP);
  const b = r.bubble();
  r.C.take(b);
  const copy = r.bubble();
  copy.appendChild(mirror(r.dom, b.querySelector('.ai-ctl-set')));
  r.rows('volume').forEach((row) => { row.dataset.state = 'on'; });

  r.click(copy.querySelector('.ai-ctl[data-ctl="volume"] .ai-ctl-main'));
  assert.deepEqual(r.rows('volume').map((row) => row.dataset.state), ['off', 'off'], 'at once, before the PC answers');
  await flush();
  assert.deepEqual(r.rows('volume').map((row) => row.dataset.state), ['on', 'on'], 'back to the truth');
  const failedRow = copy.querySelector('.ai-ctl[data-ctl="volume"]');
  assert.ok(failedRow.classList.contains('is-failed'));
  assert.equal(failedRow.querySelector('.ai-ctl-name').textContent, 't:ai_deck_failed');
  assert.ok(r.timers.some((x) => x.ms === 2500), 'the words go after a moment');

  r.click(b.querySelector('.ai-ctl[data-ctl="light"] .ai-ctl-main'));
  const ha = r.calls.find((c) => c.path === '/api/homeassistant/service');
  assert.deepEqual(ha.body, { domain: 'light', service: 'turn_off', entityId: 'light.desk_lamp', data: {} });
  assert.deepEqual(r.rows('light').map((row) => row.dataset.state), ['off', 'off']);
});

test('a light\'s slider sends its brightness when let go, and off at zero; the volume follows the drag', () => {
  const r = rig();
  r.C.queue({ kind: 'volume' });
  r.C.queue(LAMP);
  const b = r.bubble();
  r.C.take(b);
  r.run(); // the first read, out of the way
  r.calls.length = 0;
  const range = b.querySelector('.ai-ctl[data-ctl="light"] .ai-ctl-range');
  range.value = '40';
  r.fire('input', range);
  assert.equal(r.calls.length, 0, 'nothing sent while the finger moves');
  assert.equal(b.querySelector('.ai-ctl[data-ctl="light"] .ai-ctl-val').textContent, '40%');
  r.fire('change', range);
  assert.deepEqual(r.calls.at(-1).body, { domain: 'light', service: 'turn_on', entityId: 'light.desk_lamp', data: { brightness_pct: 40 } });
  range.value = '0';
  r.fire('change', range);
  assert.equal(r.calls.at(-1).body.service, 'turn_off');

  const vol = b.querySelector('.ai-ctl[data-ctl="volume"] .ai-ctl-range');
  vol.value = '72';
  r.fire('input', vol);
  const before = r.calls.length;
  r.run(120);
  assert.equal(r.calls.length, before + 1);
  assert.deepEqual(r.calls.at(-1), { path: '/volume/set', method: 'POST', body: { level: 72 } });
});

test('the live stream keeps them true, and costs nothing without controls', () => {
  const r = rig();
  const es = { on: {}, addEventListener(name, fn) { this.on[name] = fn; } };
  r.C.listen(es);
  let parsed = 0;
  es.on.ha_states({ get data() { parsed++; return '{}'; } });
  assert.equal(parsed, 0, 'no control on the page: not even a parse');

  for (const c of [{ kind: 'volume' }, LAMP, { kind: 'media' }, { kind: 'mic' }]) r.C.queue(c);
  const b = r.bubble();
  r.C.take(b);
  const row = (k) => b.querySelector(`.ai-ctl[data-ctl="${k}"]`);
  es.on.ha_states({ data: '{not json' });
  es.on.ha_states({ data: JSON.stringify({ states: { 'light.desk_lamp': { state: 'on', brightness: 128 } } }) });
  assert.equal(row('light').querySelector('.ai-ctl-val').textContent, '50%');
  es.on.ha_states({ data: JSON.stringify({ states: { 'light.desk_lamp': { state: 'unavailable' } } }) });
  assert.equal(row('light').dataset.state, 'na');
  r.click(row('light').querySelector('.ai-ctl-main'));
  assert.equal(r.calls.filter((c) => c.path === '/api/homeassistant/service').length, 0, 'an unavailable control does nothing');

  es.on.audio({ data: JSON.stringify({ unavailable: true }) });
  assert.equal(row('volume').dataset.state, 'na');
  assert.equal(row('volume').querySelector('.ai-ctl-name').textContent, 't:audio_unavailable_title');
  es.on.status({ data: JSON.stringify({ muted: true }) });
  assert.equal(row('mic').querySelector('.ai-ctl-name').textContent, 't:mic_muted');
  assert.equal(row('mic').dataset.state, 'off');
  es.on.media({ data: JSON.stringify({ active: true, title: 'Night Drive', artist: 'Lumen Arc', playbackStatus: 'Paused' }) });
  assert.equal(row('media').querySelector('.ai-ctl-name').textContent, 'Night Drive');
  assert.equal(row('media').querySelector('.ai-ctl-sub').textContent, 'Lumen Arc');
  assert.equal(row('media').dataset.state, 'off');
  es.on.media({ data: JSON.stringify({ active: false }) });
  assert.equal(row('media').querySelector('.ai-ctl-name').textContent, 't:media_empty_title');
});

test('the light watch is dropped once no light control is in sight, and only once', async () => {
  const r = rig();
  r.C.queue(LAMP);
  const b = r.bubble();
  r.C.take(b);
  r.seen();
  r.run();
  await flush();
  r.dom.document.querySelectorAll('.ai-ctl').forEach((row) => { row.getClientRects = () => []; });
  r.run(25000);
  r.run(25000);
  const watches = r.calls.filter((c) => c.path === '/ha/deck-watch').map((c) => c.body.entities);
  assert.deepEqual(watches, [['light.desk_lamp'], []], 'one empty watch, not one per tick');
});

test('the controls are wired where the turn, the reply and the stream are', () => {
  assert.match(read('../js/ai/client-actions.js'), /case 'reply_control':[^]*?BitControls\.queue\(args\)/);
  assert.match(read('../js/ai/bubbles.js'), /role === 'assistant' && window\.BitControls\) BitControls\.take\(bubble\)/);
  assert.match(read('../js/grid/data-stream.js'), /window\.BitControls\]\) if \(host\) host\.listen\(es\)/);
  const html = read('../index.html');
  assert.ok(html.indexOf('js/ai/reply-controls.js') > html.indexOf('js/ai/ai-reply-choices.js'));
  assert.match(read('../js/ai/screen-bit.js'), /'js\/ai\/reply-controls\.js'/, 'the search window has them too');
  const css = read('../components/AIPanel/AIPanelReplies.css');
  for (const sel of ['.ai-ctl-set', '.ai-ctl-main', '.ai-ctl-range', '[data-state="na"]', '.is-failed']) assert.ok(css.includes(sel), sel);
  assert.match(css, /\.ai-ctl button \{[^}]*width: 44px; height: 44px/, 'a finger-sized target');
});
