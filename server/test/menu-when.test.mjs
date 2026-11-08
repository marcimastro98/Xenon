// "When it shows" in the Xenon menu: the rows the server composes and the small drawer
// that edits them, run against a stand-in for the DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { widgetWhenRow, pageWhenRow, whenFact } = require('../menu-when.js');
const When = require('../js/xenon-menu-when.js');
const I18N = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const everything = { probes: { situationCall: true, situationFront: true }, power: { battery: { percent: 80 } } };
const box = (over = {}) => ({ id: 'lw_aaaa0001', show: 'always', ...over });
const codes = (row) => row.situations.map((s) => s.c);

function node(tag, cls = '', txt = '') {
  const n = {
    tag, cls, txt, kids: [], attrs: {}, dataset: {}, on: {}, disabled: false,
    classList: { add: (c) => { n.cls += ' ' + c; } },
    append(...xs) { n.kids.push(...xs); },
    prepend(x) { n.kids.unshift(x); },
    appendChild(x) { n.kids.push(x); return x; },
    setAttribute(k, v) { n.attrs[k] = v; },
    addEventListener(k, f) { n.on[k] = f; },
  };
  return n;
}
const all = (n) => [n, ...n.kids.flatMap(all)];
const byText = (root, txt) => all(root).find((n) => n.txt === txt);
const pressed = (root) => all(root).filter((n) => n.attrs['aria-pressed'] === 'true').map((n) => n.txt);

function drawer(over = {}) {
  const sent = [];
  let last = null;
  let row = null;
  const redraw = () => { last = api.draw(row); };
  const api = When.create({
    el: node,
    button: (cls, label) => node('button', cls, label),
    say: (x) => (x && x.key) || x,
    tt: (k) => k,
    fill: (s, vars) => `${s}:${Object.values(vars || {}).join(',')}`,
    rowShell: () => node('li', 'xm-row'),
    perform: async (_row, how) => { sent.push(how.run); return !over.fail; },
    post: over.post || (async () => ({ ok: true, apps: [{ app: 'Spotify.exe' }, { app: 'obs64.exe' }] })),
    showError: over.showError || (() => {}),
    redraw,
  });
  const open = (r) => { row = r; last = api.draw(r); };
  const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise((done) => setImmediate(done)); };
  const click = async (txt) => { byText(last, txt).on.click(); await settle(); };
  return { open, click, settle, sent, now: () => last };
}

test('every situation of the menu has its words, in all eleven languages', () => {
  const row = widgetWhenRow('when', box(), everything);
  const keys = [...codes(row).map((c) => `xmenu_sit_${c}`), 'xmenu_when_only', 'xmenu_when_hide', 'xmenu_when_any', 'xmenu_when_many',
    'xmenu_when_pick_app', 'xmenu_when_battery_below', 'xmenu_when_from', 'xmenu_when_to', 'xmenu_when_page_off', 'xmenu_when_page_on',
    'xmenu_when_why_call', 'xmenu_when_why_front', 'deck_err_bad_when'];
  for (const key of keys) assert.equal(I18N.match(new RegExp(`^\\s+${key}:`, 'gm'))?.length, 11, key);
});

test('a machine that can read everything offers every situation, the everyday ones first', () => {
  const row = widgetWhenRow('when', box(), everything);
  assert.deepEqual(codes(row).slice(0, 3), ['game', 'music', 'live']);
  assert.equal(row.situations.length, 13);
  assert.deepEqual(row.missing, []);
  assert.deepEqual(row.set, { type: 'layerMove', target: 'lw_aaaa0001' });
  assert.equal(row.rule, null);
});

test('what this PC cannot tell goes away, with one line each saying why', () => {
  const row = widgetWhenRow('when', box(), { probes: {} });
  for (const c of ['call', 'app', 'appOpen', 'battery']) assert.ok(!codes(row).includes(c), c);
  assert.deepEqual(row.missing.map((m) => m.key), ['xmenu_when_why_call', 'xmenu_when_why_front'], 'no line for a battery a desktop never had');
});

test('a rule brought from another PC stays in sight, or it could never be taken away', () => {
  const row = widgetWhenRow('when', box({ when: { any: [{ c: 'battery', below: 20 }] } }), { probes: {} });
  assert.ok(codes(row).includes('battery'));
});

test('the old show values read as rules', () => {
  assert.deepEqual(widgetWhenRow('when', box({ show: 'gaming' }), everything).rule, { any: [{ c: 'game' }] });
  assert.deepEqual(widgetWhenRow('when', box({ show: 'notGaming' }), everything).rule, { hide: true, any: [{ c: 'game' }] });
});

test('a page row writes through its own action, and a games page reads as a rule', () => {
  const row = pageWhenRow({ id: 'lp_aaaa0001', gaming: true }, everything);
  assert.equal(row.page, true);
  assert.equal(row.id, 'pageWhen');
  assert.deepEqual(row.set, { type: 'layerPageEdit', mode: 'when', page: 'lp_aaaa0001' });
  assert.deepEqual(row.rule, { any: [{ c: 'game' }] });
});

test('the widget line says nothing for always, and names the rule otherwise', () => {
  assert.deepEqual(whenFact(box()), []);
  assert.equal(whenFact(box({ show: 'gaming' }))[0].key, 'xmenu_when_gaming');
  const music = whenFact(box({ when: { any: [{ c: 'music' }] } }))[0].pair;
  assert.equal(music[0].key, 'xmenu_when_only');
  assert.equal(music[1].key, 'xmenu_sit_music');
  const app = whenFact(box({ when: { hide: true, any: [{ c: 'app', app: 'obs64' }] } }))[0].pair;
  assert.equal(app[0].key, 'xmenu_when_hide');
  assert.deepEqual(app[1], { text: 'Obs64' });
  const many = whenFact(box({ when: { any: [{ c: 'music' }, { c: 'call' }] } }))[0].pair;
  assert.equal(many[1].key, 'xmenu_when_many');
  assert.equal(many[1].vars.n, 2);
});

const row = (rule = null) => ({ ...widgetWhenRow('when', box(), everything), rule });

test('always shows three plain choices and no list; only when opens the list', async () => {
  const d = drawer();
  d.open(row());
  assert.deepEqual(pressed(d.now()), ['xmenu_when_always']);
  assert.ok(!byText(d.now(), 'xmenu_sit_music'));
  await d.click('xmenu_when_only');
  assert.deepEqual(d.sent, [], 'nothing chosen yet: nothing to save');
  assert.ok(byText(d.now(), 'xmenu_sit_music'));
});

test('one tap on a situation saves it as a rule; a second tap takes it away and keeps the list open', async () => {
  const d = drawer();
  d.open(row());
  await d.click('xmenu_when_only');
  await d.click('xmenu_sit_music');
  assert.deepEqual(d.sent.at(-1), { type: 'layerMove', target: 'lw_aaaa0001', when: 'music' });
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_sit_music');
  assert.equal(d.sent.at(-1).when, 'always');
  assert.ok(byText(d.now(), 'xmenu_sit_music'), 'still open to pick another one');
});

test('three situations show first, Altre opens the rest and the reasons, one in the rule stays in sight', async () => {
  const d = drawer();
  const open = { ...row(), missing: [{ key: 'xmenu_when_no_game' }] };
  d.open(open);
  await d.click('xmenu_when_only');
  const sits = () => all(d.now()).filter((n) => /^xmenu_sit_/.test(n.txt)).map((n) => n.txt);
  assert.deepEqual(sits(), ['xmenu_sit_game', 'xmenu_sit_music', 'xmenu_sit_app']);
  assert.ok(!byText(d.now(), 'xmenu_when_no_game'), 'the reason waits with the rest');
  assert.ok(!byText(d.now(), 'xmenu_when_any'), 'one choice needs no rule about many');
  await d.click('xmenu_when_more');
  assert.ok(sits().length > 3);
  assert.ok(byText(d.now(), 'xmenu_when_no_game'));
  assert.ok(!byText(d.now(), 'xmenu_when_more'), 'nothing left to open');
  const again = drawer();
  again.open(row({ any: [{ c: 'call' }, { c: 'music' }] }));
  assert.ok(byText(again.now(), 'xmenu_sit_call'), 'what the rule holds is never hidden');
  assert.ok(byText(again.now(), 'xmenu_when_any'), 'with two chosen it says any of them counts');
});

test('two quick taps both arrive, the last one winning', async () => {
  const d = drawer();
  d.open(row());
  await d.click('xmenu_when_only');
  await d.click('xmenu_when_more');
  byText(d.now(), 'xmenu_sit_music').on.click();
  byText(d.now(), 'xmenu_sit_call').on.click();
  await d.settle();
  assert.deepEqual(d.sent.map((r) => r.when), ['music', 'music,call']);
});

test('except when turns the same rule around', async () => {
  const d = drawer();
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_when_hide');
  assert.equal(d.sent.at(-1).when, 'hide:music');
});

test('a refused save goes back to what the server has', async () => {
  const d = drawer({ fail: true });
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_when_more');
  await d.click('xmenu_sit_call');
  assert.deepEqual(pressed(d.now()), ['xmenu_when_only', 'xmenu_sit_music']);
});

test('an app is picked from the ones open now', async () => {
  const d = drawer();
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_sit_app');
  assert.ok(all(d.now()).some((n) => n.txt === 'xmenu_when_pick_app'));
  await d.click('Spotify.exe');
  assert.equal(d.sent.at(-1).when, 'music,app:spotify');
});

test('an app in the list reads as a name and shows its picture when the system gives one', async () => {
  const asked = [];
  const icon = 'data:image/png;base64,AAAA';
  const post = async (_url, body) => { asked.push(body); return { ok: true, apps: [{ app: 'spotify', icon }, { app: 'krita' }] }; };
  const d = drawer({ post });
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_sit_app');
  assert.deepEqual(asked, [{ type: 'layerAnchor', mode: 'apps', pictures: 'on' }]);
  const pics = all(d.now()).filter((n) => n.tag === 'img');
  assert.deepEqual(pics.map((n) => n.src), [icon]);
  assert.ok(byText(d.now(), 'Spotify').kids.includes(pics[0]));
  assert.equal(byText(d.now(), 'Krita').kids.length, 0, 'no picture: the name alone');
});

test('an app list that cannot be read closes the line and says so', async () => {
  const errors = [];
  const d = drawer({ post: async () => ({ ok: false, error: 'unavailable' }), showError: (e) => errors.push(e) });
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_sit_app');
  assert.deepEqual(errors, ['unavailable']);
  assert.ok(!all(d.now()).some((n) => n.txt === 'xmenu_when_pick_app'));
});

test('battery starts at 20 percent and the level is one tap', async () => {
  const d = drawer();
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_when_more');
  await d.click('xmenu_sit_battery');
  assert.equal(d.sent.at(-1).when, 'music,battery:20');
  d.open(row({ any: [{ c: 'battery', below: 20 }] }));
  await d.click('xmenu_when_battery_below:30');
  assert.equal(d.sent.at(-1).when, 'battery:30');
});

test('a time span starts at office hours, a day comes off with a tap, the last day stays', async () => {
  const d = drawer();
  d.open(row({ any: [{ c: 'music' }] }));
  await d.click('xmenu_when_more');
  await d.click('xmenu_sit_time');
  assert.equal(d.sent.at(-1).when, 'music,time:09:00-18:00');
  d.open(row({ any: [{ c: 'time', from: '09:00', to: '18:00' }] }));
  const sunday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(2026, 10, 1));
  await d.click(sunday);
  assert.match(d.sent.at(-1).when, /^time:09:00-18:00:[1-6]{6}$/);
  const sent = d.sent.length;
  d.open(row({ any: [{ c: 'time', from: '09:00', to: '18:00', days: [0] }] }));
  await d.click(sunday);
  assert.equal(d.sent.length, sent, 'a rule with no days would never show');
});

test('from and to the same hour is not a span: nothing is saved', async () => {
  const d = drawer();
  d.open(row({ any: [{ c: 'time', from: '09:00', to: '18:00' }] }));
  await d.click('xmenu_sit_time: 09:00-18:00');
  const input = all(d.now()).filter((n) => n.tag === 'input')[1];
  input.value = '09:00';
  input.on.blur();
  await d.settle();
  assert.deepEqual(d.sent, []);
});

test('the eighth situation is the last: the other chips stop', async () => {
  const d = drawer();
  const any = ['game', 'music', 'live', 'recording', 'call', 'timer', 'dnd', 'busy'].map((c) => ({ c }));
  d.open(row({ any }));
  await d.click('xmenu_when_more');
  assert.equal(byText(d.now(), 'xmenu_sit_idle').disabled, true);
  assert.equal(byText(d.now(), 'xmenu_sit_music').disabled, false, 'one already in can still come off');
});

test('a page offers two choices: by hand, or by itself', () => {
  const d = drawer();
  d.open(pageWhenRow({ id: 'lp_aaaa0001' }, everything));
  assert.deepEqual(pressed(d.now()), ['xmenu_when_page_off']);
  assert.ok(byText(d.now(), 'xmenu_when_page_on'));
  assert.ok(!byText(d.now(), 'xmenu_when_hide'));
});
