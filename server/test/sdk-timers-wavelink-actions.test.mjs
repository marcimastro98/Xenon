// What a widget gained in 5.0.0 from the Deck's list: its own timers, the rest of
// the Wave Link mixer and SignalRGB. The point of these tests is what it did NOT
// gain: a widget can never name, restart or stop a timer of the user's, and an
// error never carries a folder of the user's home back into a third-party frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const sdk = require('../sdk-widgets.js');
const { createRegistry } = require('../actions/registry.js');
const { scopeTimerLabel, OWN_LABEL_MAX, OWNED_MAX, SCOPED_LABEL_MAX } = require('../actions/widget-timers.js');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const CW = read('../js/custom-widget.js');
const SERVER = engineSource();
const SETTINGS = read('../js/settings.js');
const I18N = appStringsSource();
const DOC = read('../../docs/WIDGET_SDK.md');

// The same name rules as the real list: names match without regard to case, and
// starting a name that exists restarts it.
function timerDeps(seed = []) {
  const list = seed.map((label) => ({ label, restarts: 0 }));
  const same = (label) => (t) => t.label.toLowerCase() === label.toLowerCase();
  const add = (label) => {
    const hit = list.find(same(label));
    if (hit) hit.restarts += 1; else list.push({ label, restarts: 0 });
    return { ok: true };
  };
  return {
    list,
    timers: {
      labels: () => list.map((t) => t.label),
      start: async (label) => add(label),
      stopwatch: async (label) => add(label),
      toggle: async (label) => (list.find(same(label)) ? { ok: true } : { ok: false, error: 'not_found' }),
      cancel: async (label) => {
        const at = list.findIndex(same(label));
        if (at < 0) return { ok: false, error: 'not_found' };
        list.splice(at, 1);
        return { ok: true };
      },
    },
  };
}

const OWNER = 'tea-clock';

test('a widget timer carries its package id, whatever label it asks for', () => {
  const { timers } = timerDeps();
  assert.deepEqual(scopeTimerLabel({ owner: OWNER }, ' Tea ', timers), { label: 'tea-clock: Tea' });
  assert.equal(scopeTimerLabel({ owner: OWNER }, 'x'.repeat(200), timers).label.length, OWNER.length + 2 + OWN_LABEL_MAX);
  assert.deepEqual(scopeTimerLabel({ owner: OWNER }, '   ', timers), { error: 'empty_label' });
});

test('an owner that is not a package id is refused, never used as a name', () => {
  const { timers } = timerDeps();
  for (const owner of ['', 'A', 'Tea', 'tea clock', '../x', 'a: b', 7, {}, ['tea-clock'], 'x'.repeat(42)]) {
    assert.deepEqual(scopeTimerLabel({ owner }, 'Tea', timers), { error: 'bad_owner' }, JSON.stringify(owner));
  }
});

test('without an owner the Deck and Bit keep the name they gave', () => {
  const { timers } = timerDeps();
  assert.deepEqual(scopeTimerLabel({}, ' Pasta ', timers), { label: 'Pasta' });
  assert.deepEqual(scopeTimerLabel({}, '  ', timers), { error: 'empty_label' });
});

test('the longest package id still fits the stored name, so a timer can be found again', () => {
  const longest = 'a'.repeat(41);
  const { timers } = timerDeps();
  const { label } = scopeTimerLabel({ owner: longest }, 'y'.repeat(OWN_LABEL_MAX), timers);
  assert.ok(label.length <= SCOPED_LABEL_MAX);
  assert.match(SERVER, /const label\s+= String\(item && item\.label \|\| 'Timer'\)\.trim\(\)\.slice\(0, SCOPED_LABEL_MAX\);/);
});

test('five timers per widget, and restarting one of them adds nothing', async () => {
  const deps = timerDeps(['Pasta']);
  const { run } = createRegistry({ timers: deps.timers });
  for (let i = 0; i < OWNED_MAX; i += 1) {
    assert.deepEqual(await run({ type: 'timerStart', label: `t${i}`, minutes: '1', owner: OWNER }), { ok: true });
  }
  assert.deepEqual(await run({ type: 'timerStart', label: 'one more', minutes: '1', owner: OWNER }), { ok: false, error: 'max_timers' });
  assert.deepEqual(await run({ type: 'stopwatchStart', label: 'one more', owner: OWNER }), { ok: false, error: 'max_timers' });
  assert.deepEqual(await run({ type: 'timerStart', label: 'T0', minutes: '2', owner: OWNER }), { ok: true });
  assert.equal(deps.list.length, OWNED_MAX + 1);
  assert.deepEqual(await run({ type: 'timerStart', label: 'mine', minutes: '1', owner: 'other-widget' }), { ok: true }, 'the cap is per widget');
});

test("a widget cannot touch the user's timer, even by asking for its exact name", async () => {
  const deps = timerDeps(['Pasta']);
  const { run } = createRegistry({ timers: deps.timers });
  assert.deepEqual(await run({ type: 'timerToggle', label: 'Pasta', owner: OWNER }), { ok: false, error: 'not_found' });
  assert.deepEqual(await run({ type: 'timerCancel', label: 'Pasta', owner: OWNER }), { ok: false, error: 'not_found' });
  await run({ type: 'timerStart', label: 'Pasta', minutes: '1', owner: OWNER });
  assert.deepEqual(deps.list, [{ label: 'Pasta', restarts: 0 }, { label: 'tea-clock: Pasta', restarts: 0 }]);
});

test("a widget cannot reach another widget's timer by writing its prefix", async () => {
  const deps = timerDeps(['other-widget: Tea']);
  const { run } = createRegistry({ timers: deps.timers });
  assert.deepEqual(await run({ type: 'timerCancel', label: 'other-widget: Tea', owner: OWNER }), { ok: false, error: 'not_found' });
  assert.equal(deps.list.length, 1);
});

test('the Deck still reaches a timer by its plain name', async () => {
  const deps = timerDeps(['Pasta']);
  const { run } = createRegistry({ timers: deps.timers });
  assert.deepEqual(await run({ type: 'timerCancel', label: 'pasta' }), { ok: true });
  assert.equal(deps.list.length, 0);
});

// The two bridge helpers, run as written.
function bridge() {
  const grab = (re) => { const m = CW.match(re); assert.ok(m, String(re)); return m[0]; };
  const box = {};
  vm.createContext(box);
  vm.runInContext([
    grab(/const ACTION_CATEGORIES = \{[\s\S]*?\n {2}\};/),
    grab(/const ACTION_LIMITS = \{[\s\S]*?\n {2}\};/),
    grab(/function actionAllowed\(grant, action\) \{[\s\S]*?\n {2}\}/),
    grab(/function widgetRunAction\(entry, action\) \{[\s\S]*?\n {2}\}/),
    grab(/const ACTION_ERROR_CODE = .*/),
    grab(/const widgetActionError = \(d\) => \{[\s\S]*?\n {2}\};/),
    'this.stamp = widgetRunAction; this.errorOf = widgetActionError; this.allowed = actionAllowed; this.cats = ACTION_CATEGORIES;',
  ].join('\n'), box);
  return box;
}

test('bridge: the owner is the host\'s, over anything the widget sent', () => {
  const { stamp } = bridge();
  const entry = { pkgId: OWNER };
  for (const type of ['timerStart', 'stopwatchStart', 'timerToggle', 'timerCancel']) {
    assert.equal(stamp(entry, { type, label: 'x', owner: 'other-widget' }).owner, OWNER, type);
    assert.equal(stamp(entry, { type, label: 'x' }).owner, OWNER, type);
  }
  assert.equal('owner' in stamp(entry, { type: 'wlMixMute', mixId: 'm' }), false, 'nothing else is stamped');
});

test('bridge: a widget reads error codes, never the text of an exception', () => {
  const { errorOf } = bridge();
  assert.equal(errorOf(null), 'offline');
  assert.equal(errorOf({ ok: true }), undefined);
  for (const code of ['not_allowed', 'max_timers', 'wl_unsupported', 'bad_page', 'timeout']) assert.equal(errorOf({ ok: false, error: code }), code);
  for (const text of ['C:\\Users\\someone\\AppData\\SignalRGB.exe failed', "ENOENT: no such file '/home/me/x'", 'Not Found', 'x'.repeat(41), {}]) {
    assert.equal(errorOf({ ok: false, error: text }), 'failed', String(text));
  }
});

const CASES = {
  wavelink: {
    allowed: [{ type: 'wlMixVolume', mixId: 'm', value: 40 }, { type: 'wlMixMute', mixId: 'm' }, { type: 'wlEffect', mixId: 'm', effectId: 'e', mode: 'on' }],
  },
  wavelinkOutput: { allowed: [{ type: 'wlOutputDevice', deviceId: 'd' }] },
  lighting: { allowed: [{ type: 'signalRgbEffect', effect: 'Rain' }] },
  timers: {
    allowed: [{ type: 'timerStart', label: 'Tea', minutes: '5' }, { type: 'stopwatchStart', label: 'Run' }, { type: 'timerToggle', label: 'Tea' }, { type: 'timerCancel', label: 'Tea' }],
  },
};

test('server and bridge agree, and each category asks for itself', () => {
  const box = bridge();
  for (const [cat, { allowed }] of Object.entries(CASES)) {
    assert.deepEqual([...box.cats[cat]], [...sdk.SDK_ACTION_CATEGORIES[cat]], cat);
    for (const a of allowed) {
      assert.equal(sdk.sdkActionWithinLimits(a), true, JSON.stringify(a));
      assert.equal(box.allowed({ actions: [cat] }, a), true, JSON.stringify(a));
      assert.equal(box.allowed({ actions: ['media'] }, a), false, JSON.stringify(a));
    }
  }
  // Moving the sound to other hardware is not implied by moving a fader.
  assert.equal(box.allowed({ actions: ['wavelink'] }, { type: 'wlOutputDevice', deviceId: 'd' }), false);
});

test('a widget stopwatch cannot chime', () => {
  const box = bridge();
  const a = { type: 'stopwatchStart', label: 'Run', everyMinutes: '1' };
  assert.equal(sdk.sdkActionWithinLimits(a), false);
  assert.equal(box.allowed({ actions: ['timers'] }, a), false);
});

test('a manifest macro cannot name a timer: nothing on the server would stamp it', () => {
  assert.equal(sdk.SDK_ACTION_TYPES.includes('timerCancel'), true);
  for (const action of CASES.timers.allowed) {
    assert.equal(sdk.SDK_MACRO_ACTION_TYPES.includes(action.type), false, action.type);
    const manifest = { api: 1, name: 'Tea', actions: ['timers'], deck: { actions: [{ id: 'go', name: 'Go', steps: [{ action }] }] } };
    assert.equal(sdk.normalizeManifest(manifest, 'tea-clock').ok, false, action.type);
  }
  assert.match(SERVER, /macro\.steps\.filter\(s => sdkWidgets\.SDK_MACRO_ACTION_TYPES\.includes\(s\.action\.type\)\)/);
});

test('the five places move together', () => {
  assert.match(SETTINGS, /SDK_WIDGET_ACTION_CATS = Object\.freeze\(\[[^\]]*'wavelinkOutput'[^\]]*'timers'/);
  for (const key of ['cw_act_wavelinkOutput', 'cw_act_timers']) {
    assert.equal((I18N.match(new RegExp(`\\b${key}:`, 'g')) || []).length, 11, key);
  }
  for (const name of ['`wavelinkOutput`', '`timers`', 'wlMixVolume', 'wlEffect', 'signalRgbEffect']) assert.ok(DOC.includes(name), name);
});
