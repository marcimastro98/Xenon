import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { makeDom, settle } from './mini-dom.mjs';

// The rows of a pump's tabs as the Xenon menu draws them (js/menu/xenon-menu-pump-rows.js):
// a line that opens on the faces as cards, the cards of the ring and the examples, the line
// that adds a moment, and what the pump shows now over the tabs (js/menu/xenon-menu-pumps.js).
const require = createRequire(import.meta.url);
const PumpRows = require('../js/menu/xenon-menu-pump-rows.js');
const Pumps = require('../js/menu/xenon-menu-pumps.js');
const { pumpViews } = require('../menu/menu-pump.js');
const { FILE_MARK } = require('../menu/menu-pump-faces.js');
const Model = require('../js/pump/pump-model.js');

function screen(over = {}) {
  return { screen: 'pump', ...Model.screenFor({ screens: {}, seen: {} }, 'pump'), seen: { shape: 'round', w: 480, h: 480, via: 'icue' }, now: { show: { face: 'sensors', style: 'rings' }, why: 'base' }, ...over };
}
const viewOf = (over, pump = {}) => pumpViews({ probes: {}, pump: { icue: true, sound: true, detected: [], screens: [screen(over)], ...pump } })[0];
const rowsOf = (view, tabId) => view.tabs.find((t) => t.id === tabId).rows;

// Words come out as their key, so a test reads which word went where.
function say(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map(say).join(', ');
  if (x.pair) return x.pair.map(say).join(': ');
  return x.key || x.text || '';
}

function rig(upload, tryFace) {
  const { document } = makeDom();
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };
  const button = (cls, label) => el('button', cls, label);
  const icon = (name) => { const i = el('svg', 'xm-ic'); i.dataset.icon = name; return i; };
  const ran = [];
  const perform = async (row, act) => { ran.push([row, act]); return true; };
  const DRAW = { choice: (r) => { const n = el('div', 'xm-row'); n.dataset.row = r.id; return n; } };
  const { draw } = PumpRows.create({ el, button, say, perform, icon, DRAW, upload, types: Pumps.PICTURE_TYPES, tryFace });
  Object.assign(DRAW, draw);
  const put = (rows) => { document.body.replaceChildren(...rows.filter((r) => draw[r.kind]).map((r) => draw[r.kind](r))); return document.body.children; };
  return { document, el, button, icon, draw, ran, put, acts: () => ran.map(([, act]) => act) };
}

test('the address of the picture sent goes where the line\'s save left its mark', () => {
  assert.equal(PumpRows.FILE_MARK, FILE_MARK, 'the menu and the model agree on the mark');
  const act = { run: { type: 'pumpSet', screen: 'p', patch: JSON.stringify({ base: { face: 'picture', items: [FILE_MARK], fit: 'cover' } }) } };
  const sent = PumpRows.withFile(act, '/uploads/a "b".gif');
  assert.deepEqual(JSON.parse(sent.run.patch), { base: { face: 'picture', items: ['/uploads/a "b".gif'], fit: 'cover' } });
  assert.equal(JSON.parse(act.run.patch).base.items[0], FILE_MARK, 'the row keeps its own save');
  assert.equal(PumpRows.withFile({ open: 'chat' }, '/uploads/x.gif'), null);
  assert.equal(PumpRows.withFile(null, '/uploads/x.gif'), null);
});

test('a line is closed on what it shows, opens on the faces as cards, and one is open at a time', () => {
  const r = rig();
  const lines = r.put(rowsOf(viewOf(), 'shows'));
  const head = (i) => lines[i].querySelector('.xm-pumpline-head');
  assert.deepEqual([...lines].map((n) => n.className.split(' ')[0]), ['xm-pumpnote', 'xm-pumpline', 'xm-pumpline', 'xm-pumpline', 'xm-pumpadd', 'xm-pumpcards']);
  const game = lines[1];
  assert.equal(head(1).getAttribute('aria-expanded'), 'false');
  assert.equal(game.querySelector('.xm-label').textContent, 'xmenu_pump_when_game');
  assert.equal(game.querySelector('.xm-sub').textContent, 'pump_reading_fps, pump_reading_gpu_temp, pump_reading_cpu_temp');
  assert.equal(game.querySelector('.xm-pumpmini.xm-pumpmini--game').getAttribute('aria-hidden'), 'true');
  assert.equal(game.querySelector('.xm-pumpline-face').textContent, 'pump_face_game');
  assert.equal(game.querySelector('.xm-pumpfaces'), null, 'closed: no faces yet');
  head(1).click();
  const open = lines[1];
  assert.notEqual(open, game, 'drawn again in its place');
  assert.ok(open.classList.contains('is-open'));
  assert.equal(open.querySelector('.xm-pumpline-head').getAttribute('aria-expanded'), 'true');
  assert.equal(r.document.activeElement, open.querySelector('.xm-pumpline-head'), 'focus stays on the line');
  assert.equal(open.querySelector('.xm-pumpline-face'), null, 'open: the lit card says the face');
  assert.deepEqual(open.querySelectorAll('.xm-pumpface').map((b) => [b.dataset.keep, b.getAttribute('aria-pressed')]),
    [['pump-m-0:face:sensors', 'false'], ['pump-m-0:face:game', 'true'], ['pump-m-0:face:music', 'false'], ['pump-m-0:face:clock', 'false'], ['pump-m-0:face:picture', 'false']]);
  assert.equal(open.querySelector('.xm-pumpfaces').getAttribute('role'), 'group');
  assert.ok(open.querySelector('.xm-pumpownface'));
  assert.ok(open.querySelector('[data-row="pump-m-0-readings"]'), 'the face\'s own choices under the cards');
  assert.equal(open.querySelector('.xm-pumpline-remove').textContent, 'xmenu_pump_m_remove');
  // Another line opens, this one closes.
  head(2).click();
  assert.deepEqual([lines[1].classList.contains('is-open'), lines[2].classList.contains('is-open')], [false, true]);
  head(2).click();
  assert.equal(lines[2].classList.contains('is-open'), false, 'a second tap closes it');
  // The rest of the time never comes off.
  head(3).click();
  assert.equal(lines[3].querySelector('.xm-pumpline-remove'), null);
});

test('the open line stays open when the menu draws everything again after a change', () => {
  const r = rig();
  let lines = r.put(rowsOf(viewOf(), 'shows'));
  lines[2].querySelector('.xm-pumpline-head').click();
  lines = r.put(rowsOf(viewOf(), 'shows'));
  assert.deepEqual([...lines].slice(1, 4).map((n) => n.classList.contains('is-open')), [false, true, false]);
  // Taken off: the next line moves into its place (and its id) and is not opened by mistake.
  lines[1].querySelector('.xm-pumpline-head').click();
  lines[1].querySelector('.xm-pumpline-remove').click();
  assert.deepEqual(JSON.parse(r.acts()[0].run.patch), { removeMoment: 0 });
  lines = r.put(rowsOf(viewOf({ moments: [screen().moments[1]] }), 'shows'));
  assert.equal(lines.filter((n) => n.classList.contains('is-open')).length, 0);
});

test('the pump\'s picture shows the line open, and its own face again once none is', () => {
  const tried = [];
  const r = rig(undefined, (show, label) => tried.push(show && [show.face, say(label)]));
  let lines = r.put(rowsOf(viewOf(), 'shows'));
  assert.deepEqual(tried, [], 'all closed: nothing asked');
  lines[1].querySelector('.xm-pumpline-head').click();
  assert.deepEqual(tried, [['game', 'xmenu_pump_when_game']]);
  lines[3].querySelector('.xm-pumpline-head').click();
  assert.deepEqual(tried.at(-1), ['sensors', 'xmenu_pump_rest'], 'another line: that one');
  lines = r.put(rowsOf(viewOf(), 'shows'));
  assert.deepEqual(tried.at(-1), ['sensors', 'xmenu_pump_rest'], 'drawn again after a change: the line again, as it is now');
  lines[3].querySelector('.xm-pumpline-head').click();
  assert.equal(tried.at(-1), null, 'closed');
});

test('a face card runs its line\'s save; the face on and the ways to one of your own', () => {
  const r = rig();
  const lines = r.put(rowsOf(viewOf(), 'shows'));
  lines[2].querySelector('.xm-pumpline-head').click();
  const line = lines[2];
  line.querySelector('[data-keep="pump-m-1:face:music"]').click();
  assert.deepEqual(r.ran, [], 'the face on does nothing');
  line.querySelector('[data-keep="pump-m-1:face:clock"]').click();
  assert.deepEqual(JSON.parse(r.acts()[0].run.patch).moments.map((m) => m.show.face), ['game', 'clock']);
  const own = line.querySelectorAll('.xm-pumpownface button');
  assert.deepEqual(own.map((b) => b.textContent), ['xmenu_bit', 'xmenu_pump_in_maker', 'xmenu_pump_in_code', 'xmenu_pump_from_store']);
  assert.equal(own[0].querySelector('.xm-ic').dataset.icon, 'bit');
  own[0].click();
  own[1].click();
  assert.deepEqual(r.ran.slice(1).map(([row, act]) => [row.closes === true, act.open || act.run.type]), [[true, 'chat'], [false, 'openUrl']],
    'Bit leaves the menu for the chat, the Maker opens in the browser');
  // A widget of the person's own carries the word for it.
  const mine = rig();
  const withWidget = mine.put(rowsOf(viewOf({}, { widgets: [{ id: 'neon', name: 'Neon', shapes: ['round'] }] }), 'shows'));
  withWidget[3].querySelector('.xm-pumpline-head').click();
  const card = withWidget[3].querySelector('[data-keep="pump-base:face:widget:neon"]');
  assert.equal(card.querySelector('.xm-pumpface-tag').textContent, 'xmenu_pump_yours');
  assert.equal(card.querySelector('.xm-pumpmini--widget').textContent, 'N');
});

test('a picture of your own goes up, then becomes that line\'s picture; a refusal is said beside the button', async () => {
  const sent = [];
  let answer = { ok: true, url: '/uploads/pump-1-ab.gif' };
  const r = rig(async (file) => { sent.push(file.name); if (answer instanceof Error) throw answer; return answer; });
  const pictureBase = { face: 'picture', items: ['art:tide'], every: 10, fit: 'cover' };
  const lines = r.put(rowsOf(viewOf({ base: pictureBase }), 'shows'));
  lines[3].querySelector('.xm-pumpline-head').click();
  const line = lines[3];
  const input = line.querySelector('input');
  const note = line.querySelector('.xm-pumpown-note');
  assert.equal(input.accept, Pumps.PICTURE_TYPES);
  assert.equal(line.querySelector('[data-keep="pump-base:upload"]').textContent, 'xmenu_pump_own');
  const order = [...line.children].map((n) => n.dataset.row || n.className);
  assert.equal(order.indexOf('xm-pumpown'), order.indexOf('pump-base-art') + 1, 'the person\'s own picture is offered right under Xenon\'s');
  const pick =async (name) => { input.files = [{ name }]; input._handlers.change[0](); await settle(); };
  await pick('cat.gif');
  assert.deepEqual(sent, ['cat.gif']);
  assert.deepEqual(JSON.parse(r.acts()[0].run.patch), { base: { ...pictureBase, items: ['/uploads/pump-1-ab.gif'] } });
  assert.equal(note.textContent, '');
  answer = { ok: false, bad: true };
  await pick('tool.exe');
  assert.equal(note.textContent, 'xmenu_pump_own_bad');
  answer = { ok: false };
  await pick('cat.gif');
  assert.equal(note.textContent, 'xmenu_pump_own_failed');
  answer = new Error('offline');
  await pick('cat.gif');
  assert.equal(note.textContent, 'xmenu_pump_own_failed');
  assert.equal(r.ran.length, 1, 'nothing changes on the pump after a refusal');
  assert.equal(line.querySelector('[data-keep="pump-base:upload"]').disabled, false);
  // No way to send a file (a menu that cannot upload): no button.
  const none = rig(undefined);
  const plain = none.put(rowsOf(viewOf({ base: pictureBase }), 'shows'));
  plain[3].querySelector('.xm-pumpline-head').click();
  assert.equal(plain[3].querySelector('input'), null);
});

test('"add" opens on the moments still free, and one tap adds that line', () => {
  const r = rig();
  let lines = r.put(rowsOf(viewOf(), 'shows'));
  const add = () => lines[4];
  assert.equal(add().querySelector('.xm-pumpadd-head').getAttribute('aria-expanded'), 'false');
  assert.equal(add().querySelector('.xm-pumpadd-list'), null);
  assert.equal(add().querySelector('.xm-sub'), null, 'one line, as drawn');
  assert.equal(add().querySelector('.xm-ic').dataset.icon, 'plus');
  add().querySelector('.xm-pumpadd-head').click();
  const options = add().querySelectorAll('.xm-pumpadd-list .xm-choice');
  assert.equal(options[0].textContent, 'xmenu_pump_when_live');
  assert.equal(options.at(-1).textContent, 'xmenu_pump_when_night');
  options[0].click();
  assert.equal(JSON.parse(r.acts()[0].run.patch).addMoment.when.any[0].c, 'live');
  lines = r.put(rowsOf(viewOf(), 'shows'));
  assert.equal(add().querySelector('.xm-pumpadd-list'), null, 'closed again once a line is added');
});

test('the ring\'s cards are drawn in their colours and say which is on; the examples are words only', () => {
  const r = rig();
  const look = r.put(rowsOf(viewOf(), 'look'));
  const leds = look[0];
  const cards = leds.querySelectorAll('.xm-pumpcard');
  assert.deepEqual(cards.map((c) => c.querySelector('.xm-pumpring').className), Model.LED_FOLLOW.map((f) => 'xm-pumpring xm-pumpring--' + f));
  assert.equal(cards.filter((c) => c.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(leds.querySelector('.xm-pumpcards-grid').getAttribute('aria-label'), 'xmenu_pump_leds');
  cards.find((c) => c.getAttribute('aria-pressed') === 'false').click();
  assert.ok(JSON.parse(r.acts()[0].run.patch).leds.follow);
  const shows = r.put(rowsOf(viewOf(), 'shows'));
  const examples = shows.at(-1);
  assert.ok(examples.classList.contains('is-plain'));
  const ex = examples.querySelectorAll('.xm-pumpcard');
  assert.deepEqual(ex.map((c) => c.getAttribute('aria-pressed')), Model.SETUP_NAMES.map(() => null), 'no example is "the one in use"');
  assert.equal(examples.querySelector('.xm-pumpring'), null);
  assert.deepEqual(ex.map((c) => c.querySelector('.xm-pumpcard-name').textContent), Model.SETUP_NAMES.map((n) => 'pump_setup_' + n));
  ex[4].click();
  assert.deepEqual(r.acts()[1], { run: { type: 'pumpSetup', screen: 'pump', setup: Model.SETUP_NAMES[4] } });
});

test('over the tabs: what the pump shows now and why, from a phone too, and the way back to automatic', () => {
  const { document } = makeDom();
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const ran = [];
  const view = Pumps.create({ el, button: (cls, label) => el('button', cls, label), say, icon: () => null, server: 'http://192.168.1.10:3030', doc: document, host: '192.168.1.20', perform: (_row, act) => ran.push(act) });
  const head = view.slot(viewOf({ now: { show: { face: 'music', style: 'cover' }, why: 'music' } }));
  assert.equal(head.querySelector('.xm-pumppreview'), null, 'no picture on a phone');
  assert.deepEqual(['cap', 'what', 'why'].map((p) => head.querySelector('.xm-pumpnow-' + p).textContent), ['xmenu_pump_now_is', 'pump_face_music', 'xmenu_pump_why_music']);
  assert.equal(head.querySelector('button'), null, 'automatic: nothing to go back to');
  const pinned = view.slot(viewOf({ now: { show: { face: 'clock' }, why: 'pinned' } }));
  const back = pinned.querySelector('button');
  assert.equal(back.textContent, 'xmenu_pump_back_auto');
  back.click();
  assert.deepEqual(ran, [{ run: { type: 'pumpFace', screen: 'pump', face: 'auto' } }]);
  assert.equal(view.slot(viewOf({ now: null })), null, 'nothing to say, no box');
});

test('every class the pump rows draw has its rule in the menu\'s sheet', () => {
  const css = readFileSync(new URL('../components/XenonMenu/XenonMenuScreens.css', import.meta.url), 'utf8');
  const src = ['xenon-menu-pump-rows.js', 'xenon-menu-pumps.js'].map((f) => readFileSync(new URL('../js/menu/' + f, import.meta.url), 'utf8')).join('\n');
  const names = new Set(src.match(/(?<![\w-])xm-pump[a-z-]*[a-z]/g)); // classes, not the --xm-pump-* sizes
  // Built from a face or a colour name: each one that has a look is checked below.
  for (const n of [...names]) if (/--$/.test(n) || /^xm-pump(ring|mini)--/.test(n)) names.delete(n);
  const missing = [...names].filter((n) => !new RegExp('\\.' + n + '(?![\\w-])').test(css));
  assert.deepEqual(missing, []);
  // The drawn faces and rings that have a look of their own.
  for (const n of ['xm-pumpmini--sensors', 'xm-pumpmini--music', 'xm-pumpmini--picture', 'xm-pumpmini--clock', 'xm-pumpmini--widget', 'xm-pumpring--screen', 'xm-pumpring--theme', 'xm-pumpring--lights']) {
    assert.ok(css.includes('.' + n), n);
  }
});

// "These boxes have no padding against the background under them": a screen's tab is no grey
// well holding cards that touch its edges; every line is a card of its own on the page.
test('a screen\'s tab holds its lines as cards on the page, and a reading on says its place', () => {
  const css = readFileSync(new URL('../components/XenonMenu/XenonMenuScreens.css', import.meta.url), 'utf8');
  const choices = readFileSync(new URL('../components/XenonMenu/XenonMenuChoices.css', import.meta.url), 'utf8');
  assert.match(css, /\.xm-scrrows \{ width: 100%; background: none; border-radius: 0; \}/);
  assert.match(css, /\.xm-scrrows > \.xm-row:not\(\.xm-row--modes\) \{ background: var\(--cst-well\); border-radius: 10px; \}/);
  assert.match(choices, /\.xm-choices--multi > \.xm-choice\[data-rank\]\[aria-pressed="true"\]::before \{\n\s+content: attr\(data-rank\);/);
  assert.match(css, /\.xm-pumpnow\.is-trying \.xm-pumpnow-tried \{ display: flex; \}/);
});
