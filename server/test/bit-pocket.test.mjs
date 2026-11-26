// Bit's pocket (plan §3): the quick keys it may hold on this PC (server/bit/pocket.js, GET /api/bit/pocket),
// what it has to tell (js/bit-companion/signals.js: Claude Code or Codex done or asking, an event soon, a timer
// that ended, a disk almost full) and the pocket a tap opens (js/bit-companion/pocket.js): the line of the
// moment with its one action, four keys run where the person is, its own choice of keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const Pocket = require('../bit/pocket.js');
const Menu = require('../menu/menu-functions.js');
const SIGNALS = readFileSync(new URL('../js/bit-companion/signals.js', import.meta.url), 'utf8');
const POCKET = readFileSync(new URL('../js/bit-companion/pocket.js', import.meta.url), 'utf8');
const EVERY_PROBE = new Proxy({}, { get: () => true });

test('its keys: the menu\'s one-tap tools and two of its own; the usual four are among them', () => {
  assert.ok(Pocket.IDS.includes('timer') && Pocket.IDS.includes('mic'));
  for (const id of Pocket.IDS.filter((x) => x !== 'timer' && x !== 'mic')) assert.ok(Menu.functionById(id), id);
  assert.ok(Pocket.USUAL.every((id) => Pocket.IDS.includes(id)));
  assert.equal(Pocket.USUAL.length, Pocket.MAX_KEYS);
});

test('saved keys: known ids only, once each, at most four', () => {
  assert.deepEqual(Pocket.normalizeKeys(['dnd', 'timer']), ['dnd', 'timer']);
  assert.deepEqual(Pocket.normalizeKeys(['timer', 'timer', 'nope', 7, 'mic']), ['timer', 'mic']);
  assert.deepEqual(Pocket.normalizeKeys(['timer', 'mic', 'area', 'dnd', 'shot']), ['timer', 'mic', 'area', 'dnd']);
  for (const bad of [null, 'timer', { 0: 'timer' }]) assert.deepEqual(Pocket.normalizeKeys(bad), []);
});

test('only what this PC can run is offered, each as a Deck action or a screen', () => {
  const none = Pocket.choices({});
  assert.ok(none.every((c) => !Menu.functionById(c.id)?.probe), 'nothing that needs a capability this PC lacks');
  assert.ok(none.some((c) => c.id === 'timer'));
  const all = Pocket.choices(EVERY_PROBE);
  assert.equal(all.length, Pocket.IDS.length);
  for (const c of all) {
    assert.ok(c.icon && c.label, c.id);
    assert.ok((c.act.run && typeof c.act.run.type === 'string') || typeof c.act.open === 'string', c.id);
  }
  assert.deepEqual(all.find((c) => c.id === 'gallery').act, { open: 'gallery' });
});

test('GET /api/bit/pocket answers the choices with the probes of this PC, and the usual four', async () => {
  const { routes, stop } = require('../bit/routes.js');
  try {
    let said = null;
    await routes['GET /api/bit/pocket']({}, {}, { json: (o) => { said = o; } }, { capabilityRunner: { probes: () => ({ captureRegion: true }) } });
    assert.equal(said.ok, true);
    assert.deepEqual(said.usual, [...Pocket.USUAL]);
    assert.ok(said.choices.some((c) => c.id === 'area') && !said.choices.some((c) => c.id === 'record'));
    assert.ok(!JSON.stringify(said).includes('\\'), 'never a path');
  } finally { stop(); }
});

// ── signals.js ──────────────────────────────────────────────────────────────

function signalsRig({ stored = null } = {}) {
  let now = Date.UTC(2026, 10, 26, 10, 0);
  const box = new Map(stored ? [['xenon.bit.signals', stored]] : []);
  const handlers = {};
  let events = 0;
  class FakeDate extends Date {
    constructor(...a) { super(...(a.length ? a : [now])); }
    static now() { return now; }
  }
  const ctx = {
    Date: FakeDate, JSON, Math, Number, String, Array, Object,
    localStorage: { getItem: (k) => (box.has(k) ? box.get(k) : null), setItem: (k, v) => box.set(k, String(v)), removeItem: (k) => box.delete(k) },
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    dispatchEvent: (e) => { if (e.type === 'xenon-bit-signals') events++; return true; },
    CustomEvent: class { constructor(type) { this.type = type; } },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SIGNALS, ctx);
  const S = ctx.BitSignals;
  const kinds = () => S.all().map((s) => s.kind).join(',');
  const session = (id, state, more = {}) => ({ live: { sessions: [{ id, state, ...more }] } });
  return { S, kinds, session, box, handlers, events: () => events, later: (ms) => { now += ms; } };
}

test('Claude Code done: a running session that went idle; one killed is not done', () => {
  const r = signalsRig();
  r.S.heard('claude', JSON.stringify(r.session('a', 'running')));
  assert.equal(r.kinds(), '');
  r.S.heard('claude', r.session('a', 'idle'));
  assert.equal(r.kinds(), 'done');
  assert.equal(r.S.top().vars.who, 'Claude Code');
  const killed = signalsRig();
  killed.S.heard('codex', killed.session('b', 'running'));
  killed.S.heard('codex', killed.session('b', 'idle', { ended: true, endedReason: 'gone' }));
  assert.equal(killed.kinds(), '');
});

test('one asking comes first and stays after the pocket opened, until nobody asks', () => {
  const r = signalsRig();
  r.S.heard('timer_done', { id: 't1', label: 'Pasta' });
  r.S.heard('codex', r.session('s', 'running', { waitFor: 'permission' }));
  assert.equal(r.kinds(), 'ask,bell');
  assert.equal(r.S.top().vars.who, 'Codex');
  const writes = r.events();
  r.S.heard('codex', r.session('s', 'running', { waitFor: 'permission' }));
  assert.equal(r.events(), writes, 'still asking: nothing written again');
  r.S.seen();
  assert.equal(r.kinds(), 'ask');
  r.S.heard('codex', r.session('s', 'running'));
  assert.equal(r.kinds(), '');
});

test('an event soon and a timer that ended carry their words, short; each grows old unseen', () => {
  const r = signalsRig();
  r.S.heard('calendar_reminder', { title: `  Stand-up\n${'x'.repeat(200)}`, startsAt: 0 });
  assert.equal(r.S.top().kind, 'soon');
  assert.equal(r.S.top().vars.title.length, 80);
  assert.ok(!r.S.top().vars.title.includes('\n'));
  r.later(16 * 60000);
  assert.equal(r.kinds(), '', 'an event told 16 minutes ago is past');
  r.S.heard('timer_done', { label: 'Tea' });
  assert.equal(r.S.top().vars.label, 'Tea');
  r.later(11 * 60000);
  assert.equal(r.kinds(), '');
});

test('a disk almost full is told once a day, the fullest one', () => {
  const r = signalsRig();
  r.S.heard('system', { disks: [{ drive: 'C:', percent: 90 }] });
  assert.equal(r.kinds(), '', 'under 95%');
  r.S.heard('system', { disks: [{ drive: 'C:', percent: 96.4 }, { drive: 'D:', percent: 98.6 }] });
  assert.deepEqual({ ...r.S.top().vars }, { drive: 'D:', pct: '99' });
  r.S.seen();
  r.S.heard('system', { disks: [{ drive: 'D:', percent: 99 }] });
  assert.equal(r.kinds(), '', 'not again today');
  r.later(24 * 3600000);
  r.S.heard('system', { disks: [{ drive: 'D:', percent: 99 }] });
  assert.equal(r.kinds(), 'disk', 'the next day');
});

test('what another window kept is read back, and anything else in there is ignored', () => {
  const stored = JSON.stringify([{ kind: 'done', at: Date.UTC(2026, 10, 26, 9, 50), vars: { who: 'Codex' } }, { kind: 'run', at: 1 }, 'x', { kind: 'bell' }]);
  const r = signalsRig({ stored });
  assert.equal(r.kinds(), 'done');
  const broken = signalsRig({ stored: '{not json' });
  assert.equal(broken.kinds(), '');
  broken.box.set('xenon.bit.signals', JSON.stringify([{ kind: 'bell', at: Date.UTC(2026, 10, 26, 10, 0), vars: { label: 'Tea' } }]));
  broken.handlers.storage.forEach((fn) => fn({ key: 'xenon.bit.signals' }));
  assert.equal(broken.kinds(), 'bell', 'a change from the other window');
});

test('an event of the stream that is not JSON, or not one it reads, changes nothing', () => {
  const r = signalsRig();
  r.S.heard('claude', '{broken');
  r.S.heard('weather', { temp: 3 });
  r.S.heard('timer_done', 'null');
  assert.equal(r.kinds(), '');
});

// ── pocket.js ───────────────────────────────────────────────────────────────

function pocketRig({ keys = [], signal = null, keysAnswer = null, prefsOk = true } = {}) {
  const { document } = makeDom();
  const posts = [];
  const asked = [];
  const opened = [];
  let seen = 0;
  const counted = [];
  let state = { ok: true, hatched: true, prefs: { keys } };
  const winHandlers = {};
  const ctx = {
    console, Math, Promise, Object, Array, String, Number, JSON, AbortController, document,
    innerWidth: 1280, innerHeight: 720,
    addEventListener: (type, fn) => { (winHandlers[type] ||= []).push(fn); },
    t: (key) => key,
    SERVER: '',
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    XenonMenuIcons: { make: (doc, name) => { const s = doc.createElement('svg'); s.className = 'xm-ic ic-' + name; return s; } },
    BitSignals: { top: () => signal, seen: () => { seen++; } },
    BitSigns: { svg: (kind) => { const s = document.createElement('svg'); s.className = 'bit-sign bit-sign-' + kind; return s; } },
    BitApp: { state: () => state, heard: (next) => { state = next; }, seen: (what) => counted.push(what) },
    BitSheet: { open: () => opened.push('room') },
    DashboardOpen: { run: (req) => opened.push(req.open), sheetAddress: (req) => '/?panel=sheet&open=' + req.open },
    aiAsk: (q) => asked.push(q),
    XenonToast: { show: (o) => opened.push('toast:' + o.message) },
    location: { href: '' },
    fetch: async (url, init) => {
      if (url === '/api/bit/pocket') {
        const out = keysAnswer || { ok: true, usual: [...Pocket.USUAL], choices: Pocket.choices(EVERY_PROBE) };
        return { json: async () => out };
      }
      const body = JSON.parse(init.body);
      posts.push({ url, body });
      if (url === '/api/bit/prefs') return { json: async () => (prefsOk ? { ok: true, bit: { ...state, prefs: { ...state.prefs, ...body } } } : { ok: false }) };
      return { json: async () => ({ ok: true }) };
    },
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(POCKET, ctx);
  const P = ctx.BitPocket;
  const all = (sel) => document.querySelectorAll(sel);
  const keyNamed = (label) => all('.bitp-key').find((b) => b.textContent === label);
  const btnNamed = (label) => all('.bitp-btn').find((b) => b.textContent === label);
  const press = (key) => (winHandlers.keydown || []).forEach((fn) => fn({ key, stopImmediatePropagation() {} }));
  return { ctx, P, all, keyNamed, btnNamed, press, posts, asked, opened, seen: () => seen, counted, location: ctx.location };
}

test('the pocket: nothing new, then the usual four keys; opening it is seeing its signs', async () => {
  const r = pocketRig();
  assert.equal(r.P.open(), true);
  assert.equal(r.all('.bitp-line')[0].textContent, 'mybit_pocket_nothing');
  assert.equal(r.all('.bitp-note')[0].textContent, 'mybit_pocket_loading');
  assert.equal(r.seen(), 1);
  await settle();
  assert.deepEqual(r.all('.bitp-key').map((b) => b.textContent), ['mybit_pocket_timer', 'deck_act_micMute', 'xmenu_shot', 'deck_act_dnd']);
  assert.ok(r.btnNamed('mybit_pocket_ask') && r.btnNamed('mybit_pocket_room') && r.btnNamed('mybit_pocket_edit'));
});

test('a key runs its Deck action on the dashboard, or through the menu\'s window alone in it', async () => {
  const r = pocketRig();
  r.P.open();
  await settle();
  r.keyNamed('mybit_pocket_timer').click();
  await settle();
  assert.deepEqual(r.posts, [{ url: '/actions/run', body: { type: 'timerStart', label: 'Bit', minutes: '25' } }]);
  assert.equal(r.P.isOpen(), false, 'closed before it runs');
  const s = pocketRig({ keys: ['gallery', 'dnd'] });
  s.P.open({ sheet: true });
  await settle();
  assert.deepEqual(s.all('.bitp-key').map((b) => b.textContent), ['xmenu_gallery', 'deck_act_dnd']);
  s.keyNamed('deck_act_dnd').click();
  await settle();
  assert.deepEqual(s.posts, [{ url: '/screen-menu', body: { run: { type: 'dnd', mode: 'toggle' } } }]);
  s.P.open({ sheet: true });
  await settle();
  s.keyNamed('xmenu_gallery').click();
  assert.equal(s.location.href, '/?panel=sheet&open=gallery', 'the window becomes the gallery');
});

test('the line of the moment and its one action: five more minutes, or a question for Bit', async () => {
  const bell = pocketRig({ signal: { kind: 'bell', vars: { label: 'Tea' } } });
  bell.P.open();
  assert.equal(bell.all('.bit-sign-bell').length, 1);
  assert.equal(bell.all('.bitp-line')[0].textContent, 'mybit_sig_bell');
  bell.btnNamed('mybit_sig_bell_more').click();
  await settle();
  assert.deepEqual(bell.posts, [{ url: '/actions/run', body: { type: 'timerStart', label: 'Tea', minutes: '5' } }]);
  const disk = pocketRig({ signal: { kind: 'disk', vars: { drive: 'C:', pct: '97' } } });
  disk.P.open();
  disk.all('.bitp-now')[0].children.find((c) => c.textContent === 'mybit_sig_disk_go').click();
  assert.deepEqual(disk.asked, ['mybit_sig_disk_q']);
  const sheet = pocketRig({ signal: { kind: 'disk', vars: { drive: 'C:', pct: '97' } } });
  sheet.P.open({ sheet: true });
  sheet.all('.bitp-now')[0].children.find((c) => c.textContent === 'mybit_sig_disk_go').click();
  await settle();
  assert.deepEqual(sheet.posts, [{ url: '/screen-menu', body: { sheet: { open: 'chat' }, ask: 'mybit_sig_disk_q' } }]);
  const done = pocketRig({ signal: { kind: 'done', vars: { who: 'Codex' } } });
  done.P.open();
  assert.equal(done.all('.bitp-now')[0].children.filter((c) => c.className.includes('bitp-btn')).length, 0, 'no action it could not take');
  const soon = pocketRig({ signal: { kind: 'soon', vars: { title: '' } } });
  soon.P.open();
  assert.equal(soon.all('.bitp-line')[0].textContent, 'mybit_sig_soon_plain', 'an event with no name');
});

test('its own choice of keys: four at most, saved in its prefs; a failed save says so', async () => {
  const r = pocketRig();
  r.P.open();
  await settle();
  r.btnNamed('mybit_pocket_edit').click();
  const keys = r.all('.bitp-key');
  assert.equal(keys.length, Pocket.IDS.length, 'every key this PC runs');
  assert.equal(keys.filter((b) => b.getAttribute('aria-pressed') === 'true').length, 4);
  assert.ok(keys.filter((b) => b.getAttribute('aria-pressed') === 'false').every((b) => b.disabled), 'full: the others wait');
  r.keyNamed('deck_act_micMute').click();
  await settle();
  assert.deepEqual(r.posts.at(-1), { url: '/api/bit/prefs', body: { keys: ['timer', 'area', 'dnd'] } });
  r.keyNamed('xmenu_gallery').click();
  await settle();
  assert.deepEqual(r.posts.at(-1).body, { keys: ['timer', 'area', 'dnd', 'gallery'] });
  r.btnNamed('mybit_pocket_edit_done').click();
  assert.deepEqual(r.all('.bitp-key').map((b) => b.textContent), ['mybit_pocket_timer', 'xmenu_shot', 'deck_act_dnd', 'xmenu_gallery']);
  const failing = pocketRig({ prefsOk: false });
  failing.P.open();
  await settle();
  failing.btnNamed('mybit_pocket_edit').click();
  failing.keyNamed('deck_act_micMute').click();
  await settle();
  assert.ok(failing.opened.includes('toast:mybit_pocket_failed'));
});

test('a key this PC can no longer run is left out; no keys from the server says so', async () => {
  const r = pocketRig({ keys: ['record', 'timer'], keysAnswer: { ok: true, usual: [...Pocket.USUAL], choices: Pocket.choices({}) } });
  r.P.open();
  await settle();
  assert.deepEqual(r.all('.bitp-key').map((b) => b.textContent), ['mybit_pocket_timer']);
  const down = pocketRig({ keysAnswer: { ok: false } });
  down.P.open();
  await settle();
  assert.equal(down.all('.bitp-note')[0].textContent, 'mybit_pocket_failed');
});

test('Esc, a tap outside or a second tap on Bit closes it; Ask Bit and its room go where they belong', async () => {
  const r = pocketRig();
  r.P.open();
  r.press('Escape');
  assert.equal(r.P.isOpen(), false);
  r.P.open();
  const root = r.all('.bitp')[0];
  root.dispatchEvent({ type: 'click' });
  assert.equal(r.P.isOpen(), false);
  r.P.open();
  r.P.open();
  assert.equal(r.P.isOpen(), false, 'a second tap closes it');
  r.P.open();
  r.btnNamed('mybit_pocket_room').click();
  r.P.open();
  r.btnNamed('mybit_pocket_ask').click();
  await settle();
  assert.deepEqual(r.opened, ['room', 'chat']);
  assert.equal(r.all('.bitp').length, 0);
});

// A Deck key or Bit in the chat opens the pocket by itself in the menu's window (open_xenon_screen
// pocket), where a tap on Bit on the desktop opens it too; with no window to open it in, the menu.
test('a key or Bit opens the pocket alone in the menu\'s window, the same list in the catalog', () => {
  const XenonMenu = require('../capabilities/xenon-menu.js');
  const { CAPABILITIES } = require('../js/capabilities/capability-catalog.js');
  const DashboardOpen = require('../js/grid/dashboard-open.js');
  const asked = [];
  const menu = { show: () => 'dashboard', showSheet: (req) => { asked.push(req); return 'screen'; } };
  assert.deepEqual(XenonMenu.openScreen({ menu }, { type: 'xenonScreen', screen: 'pocket' }), { ok: true, where: 'screen', screen: 'pocket' });
  assert.deepEqual(asked, [{ open: 'pocket' }]);
  assert.deepEqual(DashboardOpen.sheet({ open: 'pocket' }), { open: 'pocket' }, 'the window takes it');
  const noWindow = { show: () => 'dashboard', showSheet: () => 'closed' };
  assert.deepEqual(XenonMenu.openScreen({ menu: noWindow }, { screen: 'pocket' }), { ok: true, where: 'dashboard', screen: 'pocket' });
  const key = CAPABILITIES.find((c) => c.type === 'xenonScreen');
  assert.deepEqual(key.params[0].options, [...XenonMenu.SCREENS]);
  assert.ok(Object.keys(key.params[0].optionKeys).every((k) => XenonMenu.SCREENS.includes(k)) && key.params[0].optionKeys.pocket);
  assert.ok(key.capability.ai.params.screen.includes('pocket'));
});

test('opening the pocket is counted, with the kind of sign it showed and never what it was about', () => {
  const plain = pocketRig();
  plain.P.open();
  assert.deepEqual(plain.counted, ['pocket']);
  const r = pocketRig({ signal: { kind: 'disk', vars: { drive: 'C:', pct: 95 } } });
  r.P.open();
  assert.deepEqual(r.counted, ['pocket', 'sign.disk']);
});
