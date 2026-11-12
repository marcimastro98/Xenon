// "How do you want to use Xenon?" (js/usage-ask.js): the one question of a new install,
// asked in the app that draws widgets. The rules behind it are in usage-ask-plan.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync as readFileSyncRaw } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const src = (p) => readFileSync(new URL('../' + p, import.meta.url));
const SRC = src('js/usage-ask.js');
const SCRIPTS = ['view-melt', 'usage-mode', 'screen-name', 'layer-drag', 'xenon-menu-map', 'usage-ask-plan', 'usage-ask-picture', 'usage-ask']
  .map((name) => src('js/' + name + '.js'));

const screen = (id, name, more = {}) => ({
  id, name, label: 'Display ' + id, width: 2560, height: 1440, x: 0, y: 0, primary: false, edge: false, ...more,
});
const MAIN = screen('A', 'DELL', { primary: true });
const SIDE = screen('B', 'LG', { x: 2560 });
const EDGE = screen('C', 'XENEON EDGE', { width: 2560, height: 720, y: 1440, edge: true });

function load({ native = true, caps = { layers: true, menu: true }, usageMode = '', remote = false, layerPage = false, displays = [MAIN], refuse = [], offline = [], search = '' } = {}) {
  const { document } = makeDom();
  const make = document.createElement;
  document.createElement = (t) => {
    const el = make(t);
    el.focus = () => { document.activeElement = el; };
    return el;
  };
  const keyHandlers = [];
  document.addEventListener = (type, fn) => { if (type === 'keydown') keyHandlers.push(fn); };
  document.removeEventListener = (_type, fn) => {
    const i = keyHandlers.indexOf(fn);
    if (i >= 0) keyHandlers.splice(i, 1);
  };
  const log = [];
  const placed = [];
  const surfaces = [];
  const chosen = [];
  const freezes = [];
  const rails = [];
  const timers = [];
  const state = { displays, dismissed: 0 };
  const ctx = {
    document, console: { ...console, warn() {} },
    hubSettings: { usageMode, layers: { menuKey: 'ctrl+alt+m' } },
    t: (k) => k,
    SERVER: 'http://x',
    updateUsageMode: async (v) => { log.push('usage:' + v); },
    setSurfaceChoice: (patch) => surfaces.push(patch),
    fetch: async (url, init) => {
      if (url.endsWith('/screen-menu')) {
        log.push('menu');
        assert.equal(init.body, '{"open":true,"section":"widgets"}', 'on the widgets just placed');
        return { ok: true };
      }
      const action = JSON.parse(init.body);
      placed.push(action);
      log.push('place:' + action.widget);
      if (offline.includes(action.widget)) throw new Error('no server');
      return { ok: true, json: async () => ({ ok: !refuse.includes(action.widget), error: 'full' }) };
    },
    isLayerPage: () => layerPage,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
  };
  ctx.location = { search };
  ctx.URLSearchParams = URLSearchParams;
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.top = ctx;
  ctx.__XENON_NATIVE__ = native;
  ctx.__XENON_NATIVE_CAPS__ = caps;
  ctx.__xenonRemote = remote;
  ctx.XenonNative = {
    displayState: () => ({ displays: state.displays, fullscreen: true }),
    chooseScreen: (id, full) => chosen.push([id, full]),
  };
  ctx.SurfacePicker = { setUpPhone: () => log.push('phone') };
  ctx.TopbarMinimal = { peekRails: (on) => rails.push(on) };
  ctx.XenonToast = { dismissAll: () => { state.dismissed += 1; } };
  ctx.ambientFreeze = (who, on) => freezes.push([who, on]);
  ctx.DeckShortcuts = { formatShortcut: (c) => c.toUpperCase() };
  vm.createContext(ctx);
  SCRIPTS.forEach((code) => vm.runInContext(code, ctx));
  const key = (k, more = {}) => keyHandlers.slice().forEach((fn) => fn({ key: k, preventDefault() {}, ...more }));
  return { ctx, document, log, placed, surfaces, chosen, freezes, rails, timers, state, key, keyHandlers, U: ctx.UsageAsk };
}

const rows = (d) => d.document.querySelectorAll('.ua-card');
const modes = (d) => rows(d).map((c) => c.dataset.mode);
const onRow = (d) => d.document.querySelector('.ua-card.is-on');
const bodyOf = (d, mode) => rows(d).find((c) => c.dataset.mode === mode).querySelector('.ua-body').textContent;
const pick = (d, mode) => rows(d).find((c) => c.dataset.mode === mode).click();
const monitor = (d, id) => d.document.querySelectorAll('.ua-screen').find((b) => b.dataset.id === id);
async function go(d) {
  d.document.querySelector('.ua-go').click();
  await settle(60);
}

test('someone updating is never asked: both is set, nothing opens, nothing is placed', () => {
  for (const displays of [[MAIN], [MAIN, SIDE]]) {
    const d = load({ displays });
    assert.equal(d.U.maybeStart({ returning: true }), false);
    assert.deepEqual(d.log, ['usage:both']);
    assert.equal(d.U.isOpen(), false);
    assert.deepEqual(d.placed, []);
  }
});

test('a mode already chosen is left alone when updating', () => {
  const d = load({ usageMode: 'dashboard' });
  assert.equal(d.U.maybeStart({ returning: true }), false);
  assert.deepEqual(d.log, []);
});

test('a shell that cannot draw widgets yet keeps the setting for the boot that can', () => {
  const d = load({ caps: {} });
  assert.equal(d.U.maybeStart({ returning: true }), false);
  assert.deepEqual(d.log, []);
});

test('a new install is always asked, on any number of screens', () => {
  for (const displays of [[], [MAIN], [MAIN, SIDE]]) {
    const d = load({ displays });
    assert.equal(d.U.maybeStart(), true);
    assert.deepEqual(d.log, [], 'nothing is chosen for them');
  }
});

test('the recommended row comes first, starts selected and says so', () => {
  const cases = [
    [[], ['widgets', 'dashboard', 'phone']],
    [[MAIN], ['widgets', 'dashboard', 'phone']],
    [[MAIN, SIDE], ['both', 'widgets', 'dashboard']],
    [[MAIN, SIDE, EDGE], ['both', 'widgets', 'dashboard']],
    [[{ ...EDGE, primary: true }], ['dashboard', 'widgets', 'phone']],
  ];
  for (const [displays, order] of cases) {
    const d = load({ displays });
    d.U.maybeStart();
    assert.deepEqual(modes(d), order);
    assert.equal(rows(d).indexOf(onRow(d)), 0);
    const marks = rows(d).map((c) => (c.querySelector('.ua-rec') || {}).textContent || '');
    assert.deepEqual(marks, ['Recommended', '', ''], 'one row only');
    rows(d)[1].click();
    assert.equal(rows(d)[0].querySelector('.ua-rec').textContent, 'Recommended', 'it stays when another is picked');
  }
});

test('asked only in the app that draws widgets, only once, never on a phone, a layer or a frame', () => {
  assert.equal(load().U.shouldAsk(), true);
  assert.equal(load({ native: false }).U.shouldAsk(), false, 'browser');
  assert.equal(load({ caps: {} }).U.shouldAsk(), false, 'a shell that cannot draw widgets');
  assert.equal(load({ usageMode: 'both' }).U.shouldAsk(), false, 'already answered');
  assert.equal(load({ usageMode: 'nonsense' }).U.shouldAsk(), true, 'a broken value counts as not asked');
  assert.equal(load({ remote: true }).U.shouldAsk(), false, 'paired device');
  assert.equal(load({ layerPage: true }).U.shouldAsk(), false, 'a layer window');
  const framed = load();
  framed.ctx.top = {};
  assert.equal(framed.U.shouldAsk(), false, 'inside a frame');
  assert.equal(load({ native: false }).U.maybeStart(), false);
});

test('one dialog: radio rows, the key under the title, nothing else speaking over it', () => {
  const d = load();
  assert.equal(d.U.maybeStart(), true);
  assert.equal(d.U.isOpen(), true);
  const overlay = d.document.querySelector('.ua-overlay');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.match(overlay.className, /\bsp-overlay\b/);
  assert.equal(d.document.querySelector('.ua-cards').getAttribute('role'), 'radiogroup');
  assert.deepEqual(rows(d).map((c) => c.getAttribute('aria-checked')), ['true', 'false', 'false']);
  assert.match(d.document.querySelector('.ua-sub').textContent, /\(CTRL\+ALT\+M\)/);
  assert.equal(d.document.activeElement, onRow(d), 'focus starts on the chosen row');
  assert.deepEqual(d.freezes, [['usage-ask', true]]);
  assert.ok(d.document.body.classList.contains('first-run-asking'), 'toasts hold back while it is open');
  assert.equal(d.state.dismissed, 1, 'and those already up leave');
  assert.equal(d.U.maybeStart(), true, 'a second call keeps the one dialog');
  assert.equal(d.document.querySelectorAll('.ua-overlay').length, 1);
});

test('a tap picks, Continue saves once and everything it opened closes', async () => {
  const d = load();
  d.U.maybeStart();
  pick(d, 'dashboard');
  assert.equal(onRow(d).dataset.mode, 'dashboard');
  assert.equal(d.document.activeElement, onRow(d), 'a tapped row keeps the focus for the arrows');
  assert.deepEqual(d.log, [], 'picking alone saves nothing');
  await go(d);
  assert.deepEqual(d.log, ['usage:dashboard']);
  assert.equal(d.U.isOpen(), false);
  assert.equal(d.document.querySelector('.ua-overlay'), null);
  assert.deepEqual(d.freezes.at(-1), ['usage-ask', false]);
  assert.equal(d.keyHandlers.length, 0, 'the key listener goes with it');
  assert.equal(d.document.body.classList.contains('first-run-asking'), false);
});

test('the rows say what goes where, by the name of each monitor', () => {
  const many = load({ displays: [MAIN, SIDE, EDGE] });
  many.U.maybeStart();
  assert.equal(bodyOf(many, 'both'), 'The dashboard on XENEON EDGE, the widgets on DELL.');
  assert.equal(bodyOf(many, 'widgets'), 'Widgets on DELL, over the desktop. No window.');
  assert.equal(bodyOf(many, 'dashboard'), 'The whole dashboard on XENEON EDGE.');
  const one = load();
  one.U.maybeStart();
  assert.equal(bodyOf(one, 'widgets'), 'Widgets on the desktop, over the wallpaper.');
  assert.equal(bodyOf(one, 'dashboard'), 'The dashboard in a window, like an app.');
  assert.match(bodyOf(one, 'phone'), /phone or tablet/);
});

test('tapping a monitor moves the dashboard, and the answer goes there', async () => {
  const d = load({ displays: [MAIN, SIDE, EDGE] });
  d.U.maybeStart();
  assert.equal(monitor(d, 'C').getAttribute('aria-pressed'), 'true');
  monitor(d, 'B').click();
  assert.equal(monitor(d, 'B').getAttribute('aria-pressed'), 'true');
  assert.equal(monitor(d, 'C').getAttribute('aria-pressed'), 'false');
  assert.equal(bodyOf(d, 'both'), 'The dashboard on LG, the widgets on DELL.');
  await go(d);
  assert.deepEqual(d.chosen, [['B', true]], 'full screen as the shell had it');
  assert.deepEqual({ ...d.surfaces[0] }, { kind: 'screen', monitor: 'B', label: 'Display B', asked: true });
});

test('a monitor is a button only when the answer puts the dashboard on one', () => {
  const d = load({ displays: [MAIN, SIDE] });
  d.U.maybeStart();
  const hint = d.document.querySelector('.ua-hint');
  assert.equal(monitor(d, 'A').disabled, false);
  assert.ok(hint.classList.contains('is-on'));
  pick(d, 'widgets');
  assert.equal(monitor(d, 'A').disabled, true);
  assert.equal(hint.classList.contains('is-on'), false);
  pick(d, 'dashboard');
  assert.equal(monitor(d, 'A').disabled, false);
  const one = load();
  one.U.maybeStart();
  pick(one, 'dashboard');
  assert.equal(monitor(one, 'A').disabled, true, 'one screen: the dashboard is a window, there is nowhere to tap');
});

test('the shell pushes its screens late: the advice follows until the person speaks', () => {
  const d = load({ displays: [] });
  d.U.maybeStart();
  assert.equal(onRow(d).dataset.mode, 'widgets');
  d.state.displays = [MAIN, SIDE];
  d.U.onDisplays();
  assert.deepEqual(modes(d), ['both', 'widgets', 'dashboard']);
  assert.equal(onRow(d).dataset.mode, 'both');
  assert.equal(d.document.activeElement, onRow(d));
});

test('a late list keeps a row they picked and a monitor they tapped', () => {
  const d = load({ displays: [MAIN, SIDE] });
  d.U.maybeStart();
  pick(d, 'dashboard');
  monitor(d, 'A').click();
  d.state.displays = [MAIN, SIDE, EDGE];
  d.U.onDisplays();
  assert.equal(onRow(d).dataset.mode, 'dashboard');
  assert.equal(monitor(d, 'A').getAttribute('aria-pressed'), 'true');
});

test('a tapped monitor that leaves gives the dashboard back to the default place', () => {
  const d = load({ displays: [MAIN, SIDE, EDGE] });
  d.U.maybeStart();
  monitor(d, 'B').click();
  d.state.displays = [MAIN, EDGE];
  d.U.onDisplays();
  assert.equal(monitor(d, 'C').getAttribute('aria-pressed'), 'true');
});

test('a row that leaves with its screens falls back to the advice', () => {
  const d = load({ displays: [MAIN] });
  d.U.maybeStart();
  pick(d, 'phone');
  d.state.displays = [MAIN, SIDE];
  d.U.onDisplays();
  assert.equal(onRow(d).dataset.mode, 'both');
});

test('widgets: three starters, then the answer, then the menu once', async () => {
  const d = load();
  d.U.maybeStart();
  await go(d);
  assert.deepEqual(d.log, ['place:weather', 'place:media', 'place:system', 'usage:widgets', 'menu']);
  assert.deepEqual({ ...d.placed[0] }, { type: 'layerPlace', widget: 'weather', surface: 'desktop', position: 'top-right', size: 'medium' });
  assert.deepEqual(d.rails, [], 'no rails where there is no dashboard');
});

test("widgets in the app's own window: no melt into the dashboard, the dialog waits for the window to go", async () => {
  const d = load({ search: '?shell=main' });
  d.U.maybeStart();
  await go(d);
  assert.deepEqual(d.log, ['place:weather', 'place:media', 'place:system', 'usage:widgets', 'menu']);
  assert.ok(rows(d).length > 0, 'still covering the dashboard while the window becomes the driver page');
  const stay = d.timers.find((t) => t.ms === 4000);
  assert.ok(stay, 'a window that did not leave closes the dialog anyway');
  stay.fn();
  assert.equal(rows(d).length, 0);
});

test("dashboard and both in the app's own window still melt into the dashboard", async () => {
  for (const mode of ['dashboard', 'both']) {
    const d = load({ search: '?shell=main', displays: [MAIN, SIDE] });
    d.U.maybeStart();
    pick(d, mode);
    await go(d);
    assert.equal(rows(d).length, 0, mode);
    assert.ok(!d.timers.some((t) => t.ms === 4000), mode);
  }
});

test('dashboard: nothing placed, no menu, the side rails show themselves and go', async () => {
  const d = load();
  d.U.maybeStart();
  pick(d, 'dashboard');
  await go(d);
  assert.deepEqual(d.log, ['usage:dashboard']);
  assert.deepEqual(d.rails, [true]);
  const peek = d.timers.find((t) => t.ms === 3200);
  assert.ok(peek, 'closed again by a timer');
  peek.fn();
  assert.deepEqual(d.rails, [true, false]);
});

test('both: starters, menu and rails; the widgets follow when the dashboard takes the main screen', async () => {
  const d = load({ displays: [MAIN, SIDE] });
  d.U.maybeStart();
  monitor(d, 'A').click();
  await go(d);
  assert.deepEqual(d.log, ['place:weather', 'place:media', 'place:system', 'usage:both', 'menu']);
  assert.equal(d.placed[0].monitor, 'B');
  assert.deepEqual(d.chosen, [['A', true]]);
  assert.deepEqual(d.rails, [true]);
});

test('the dashboard on the main screen is the one case without a monitor on the widgets', async () => {
  const d = load({ displays: [MAIN, SIDE] });
  d.U.maybeStart();
  await go(d);
  assert.equal('monitor' in d.placed[0], false);
});

test('the phone row and the phone line both lead to pairing, with widgets here', async () => {
  const row = load();
  row.U.maybeStart();
  pick(row, 'phone');
  await go(row);
  const line = load({ displays: [MAIN, SIDE] });
  line.U.maybeStart();
  line.document.querySelector('.ua-phone-go').click();
  await settle(60);
  for (const d of [row, line]) {
    assert.deepEqual(d.log, ['phone', 'place:weather', 'place:media', 'place:system', 'usage:both']);
    assert.deepEqual(d.chosen, [], 'nothing on this PC moves');
    assert.deepEqual(d.surfaces, []);
    assert.deepEqual(d.rails, []);
  }
});

test('the phone line shows only where the rows have no phone', () => {
  const one = load();
  one.U.maybeStart();
  assert.equal(one.document.querySelector('.ua-phone').classList.contains('is-on'), false);
  const two = load({ displays: [MAIN, SIDE] });
  two.U.maybeStart();
  assert.ok(two.document.querySelector('.ua-phone').classList.contains('is-on'));
});

test('a widget that cannot be placed does not cost the answer', async () => {
  for (const opts of [{ refuse: ['weather'] }, { offline: ['weather'] }]) {
    const d = load(opts);
    d.U.maybeStart();
    await go(d);
    assert.deepEqual(d.log, ['place:weather', 'place:media', 'place:system', 'usage:widgets', 'menu']);
  }
});

test('arrows move the choice like a radio group and wrap; Esc does nothing', async () => {
  const d = load();
  d.U.maybeStart();
  d.key('ArrowRight');
  assert.equal(onRow(d).dataset.mode, 'dashboard');
  d.key('ArrowLeft');
  d.key('ArrowUp');
  assert.equal(onRow(d).dataset.mode, 'phone');
  d.key('ArrowDown');
  assert.equal(onRow(d).dataset.mode, 'widgets');
  assert.equal(d.document.activeElement, onRow(d));
  d.key('Escape');
  assert.equal(d.U.isOpen(), true, 'no "later": the question waits for an answer');
});

test('Enter confirms the chosen row; a held Enter, a monitor and the phone key do not', async () => {
  const d = load({ displays: [MAIN, SIDE] });
  d.U.maybeStart();
  d.key('Enter', { repeat: true });
  await settle(60);
  assert.equal(d.U.isOpen(), true, 'a repeat is not a press');
  d.key('Enter', { target: monitor(d, 'A') });
  await settle(60);
  assert.equal(d.U.isOpen(), true, 'a monitor has its own click');
  d.key('Enter', { target: d.document.querySelector('.ua-phone-go') });
  await settle(60);
  assert.equal(d.U.isOpen(), true, 'the phone key has its own click');
  d.key('Enter');
  await settle(60);
  assert.deepEqual(d.log.filter((l) => l.startsWith('usage:')), ['usage:both']);
  assert.equal(d.U.isOpen(), false);
});

test('two taps on Continue answer once', async () => {
  const d = load();
  d.U.maybeStart();
  const key = d.document.querySelector('.ua-go');
  key.click();
  key.click();
  await settle(60);
  assert.deepEqual(d.log.filter((l) => l.startsWith('usage:')), ['usage:widgets']);
  assert.equal(d.placed.length, 3);
});

test('a double click on a row is the same as Continue', async () => {
  const d = load();
  d.U.maybeStart();
  const row = rows(d).find((c) => c.dataset.mode === 'dashboard');
  row.click();
  row._handlers.dblclick.forEach((fn) => fn({}));
  await settle(60);
  assert.deepEqual(d.log, ['usage:dashboard']);
});

test('wired in place of the second question: one or the other, never both in a row', () => {
  const settings = src('js/settings.js');
  const picker = src('js/surface-picker.js');
  assert.match(settings, /const asked = !!\(window\.UsageAsk && typeof window\.UsageAsk\.maybeStart === 'function'\n\s+&& window\.UsageAsk\.maybeStart\(\{ returning \}\)\);/);
  assert.match(settings, /if \(!asked && window\.SurfacePicker && typeof window\.SurfacePicker\.maybeStart === 'function'\) \{/);
  assert.ok(settings.indexOf('returningUser({') < settings.indexOf('SurfacePicker.maybeStart();'), 'read before the screen question answers it');
  assert.match(picker, /window\.UsageAsk\.onDisplays\(\)/, 'the question hears the late list of screens');
  assert.match(picker, /setUpPhone: choosePhone/);
  const js = new URL('../js/', import.meta.url);
  for (const file of readdirSync(js).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(new URL(file, js));
    assert.doesNotMatch(code, /surface-picker-done|remote-guide-closed/, file + ': nobody waits on the old chain');
  }
  const html = src('index.html');
  const at = (name) => html.indexOf('js/' + name + '.js');
  assert.ok(at('usage-ask') > at('surface-picker'));
  for (const before of ['screen-name', 'usage-ask-plan', 'usage-ask-picture', 'xenon-menu-map']) assert.ok(at(before) >= 0 && at(before) < at('usage-ask'), before);
  assert.doesNotMatch(SRC, /innerHTML/);
});

test('the picture shows a monitor name as text only', () => {
  const picture = src('js/usage-ask-picture.js');
  assert.match(picture, /chin\.textContent = name;/);
  assert.doesNotMatch(picture, /innerHTML/);
});

test('every text in all 11 languages, removed words gone', () => {
  const i18n = src('js/i18n.js');
  const ctx = {};
  vm.runInNewContext(i18n.slice(0, i18n.search(/^function /m)) + '\nthis.i18n = i18n;', ctx);
  const keys = ['usage_ask_title', 'usage_ask_sub', 'usage_ask_go', 'usage_ask_recommended', 'usage_ask_both_title', 'usage_ask_widgets_title', 'usage_ask_dash_title',
    'usage_ask_phone_title', 'usage_ask_widgets_one_body', 'usage_ask_dash_one_body', 'usage_ask_phone_body', 'usage_ask_phone_line', 'usage_ask_phone_go', 'usage_ask_screen_hint'];
  const holes = {
    usage_ask_both_body: ['{dash}', '{desk}'], usage_ask_widgets_body: ['{desk}'], usage_ask_dash_body: ['{dash}'],
    usage_ask_screen_aria: ['{name}'], usage_ask_sub: ['{key}'],
  };
  for (const lang of ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru', 'nl']) {
    const words = ctx.i18n[lang];
    for (const k of keys) assert.ok(words[k], lang + ' ' + k);
    for (const [k, marks] of Object.entries(holes)) marks.forEach((m) => assert.ok(words[k].includes(m), lang + ' ' + k + ' ' + m));
    for (const gone of ['usage_ask_pick', 'usage_ask_chosen']) assert.equal(words[gone], undefined, lang + ' ' + gone);
  }
});
