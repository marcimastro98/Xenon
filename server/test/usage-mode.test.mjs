// How this PC uses Xenon: dashboard, widgets only, or both (js/usage-mode.js,
// capabilities/usage-mode.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync as readFileSyncRaw } from 'node:fs';

const readFileSync = (p) => readFileSyncRaw(p, 'utf8').replace(/\r\n/g, '\n');
const require = createRequire(import.meta.url);
const UsageMode = require('../js/usage-mode.js');
const { validateAction } = require('../js/deck-actions.js');
const { createCapabilities, aiFunctions, aiAction } = require('../capabilities/index.js');
const SERVER = readFileSync(new URL('../server.js', import.meta.url));
const CLIENT = readFileSync(new URL('../js/settings.js', import.meta.url));
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url));

const shellUp = { available: () => true };
const recorder = () => {
  const writes = [];
  return { writes, settings: { setUsageMode: async (m) => { writes.push(m); return m; } } };
};

test('only the three modes survive; anything else means "not asked yet"', () => {
  assert.deepEqual([...UsageMode.MODES], ['dashboard', 'widgets', 'both']);
  for (const m of UsageMode.MODES) assert.equal(UsageMode.normalize(m), m);
  for (const bad of [undefined, null, '', 'WIDGETS', 'phone', 3, {}]) assert.equal(UsageMode.normalize(bad), '');
});

test('"not asked yet" behaves like today: dashboard window, widgets still offered', () => {
  assert.equal(UsageMode.widgetsOnly(''), false);
  assert.equal(UsageMode.mainScreenOn(''), true);
  assert.equal(UsageMode.widgetsOnly('widgets'), true);
  assert.equal(UsageMode.mainScreenOn('dashboard'), false);
  assert.equal(UsageMode.mainScreenOn('both'), true);
});

test('"I only want the widgets": Bit switches the mode', async () => {
  const r = recorder();
  const caps = createCapabilities({ layersHost: shellUp, settings: r.settings });
  assert.equal(caps.probes().usageMode, true);
  const action = aiAction('set_usage_mode', { mode: 'widgets', extra: 1 });
  assert.deepEqual(action, { type: 'usageMode', mode: 'widgets' });
  assert.deepEqual(await caps.run(validateAction(action)), { ok: true, mode: 'widgets' });
  assert.deepEqual(r.writes, ['widgets']);
});

test('a wrong mode names the choices and writes nothing', async () => {
  const r = recorder();
  const caps = createCapabilities({ layersHost: shellUp, settings: r.settings });
  const out = await caps.run({ type: 'usageMode', mode: 'phone' });
  assert.equal(out.error, 'bad_mode');
  assert.deepEqual(out.choices, ['dashboard', 'widgets', 'both']);
  assert.deepEqual(r.writes, []);
});

test('without the native shell there is nothing to switch: not offered, not run', async () => {
  const r = recorder();
  const caps = createCapabilities({ settings: r.settings });
  assert.equal(caps.probes().usageMode, false);
  assert.ok(!aiFunctions(caps.probes()).some((f) => f.name === 'set_usage_mode'));
  assert.deepEqual(await caps.run({ type: 'usageMode', mode: 'both' }), { ok: false, error: 'unavailable' });
  assert.deepEqual(r.writes, []);
});

test('the setting is kept on both sides, in the defaults and under the settings lock', () => {
  assert.match(SERVER, /\n {2}usageMode: '',\n/);
  assert.ok(SERVER.includes('usageMode: UsageMode.normalize(source.usageMode),'));
  assert.match(SERVER, /async function updateUsageModeSetting\(mode\) \{\n {2}return withHubSettingsLock\(/);
  assert.match(CLIENT, /\n {2}usageMode: '',\n/);
  assert.ok(CLIENT.includes('usageMode: window.UsageMode ? window.UsageMode.normalize(value.usageMode) : \'\','));
});

test('the Deck key and its choices are named in all 11 languages', () => {
  for (const key of ['deck_act_usageMode', 'deck_opt_dashboard', 'deck_opt_widgets', 'deck_opt_both']) {
    const n = I18N.split(`\n    ${key}: `).length - 1;
    assert.equal(n, 11, key);
  }
});

test('Settings → General offers the three modes, only in the native app with widget layers', () => {
  const HTML = readFileSync(new URL('../index.html', import.meta.url));
  const at = HTML.indexOf('id="settings-usage-mode-group"');
  assert.ok(at > 0);
  const group = HTML.slice(HTML.lastIndexOf('<div', at), HTML.indexOf('</div>', at));
  assert.match(group, /data-settings-cat="general"/);
  assert.match(group, / hidden>/, 'hidden until the shell says it can draw layers');
  const values = [...group.matchAll(/<option value="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(values, [...UsageMode.MODES]);
  assert.match(CLIENT, /setSettingsCardAvailable\(group, window\.__XENON_NATIVE__ === true && caps\.layers === true\);/);
  assert.match(CLIENT, /syncNativeZoomControl\(\);\n\s+syncUsageModeControl\(\);/);
});

test('picking "widgets only" saves to the server before the window trades itself', () => {
  const body = CLIENT.slice(CLIENT.indexOf('async function updateUsageMode('));
  const flush = body.indexOf('await flushHubSettingsToServer()');
  const sync = body.indexOf('window.LayersShell.sync()');
  assert.ok(flush > 0 && sync > flush, 'the server decides the redirect, so the save lands first');
  for (const key of ['settings_usage_mode', 'settings_usage_mode_hint']) {
    assert.equal(I18N.split(`\n    ${key}: `).length - 1, 11, key);
  }
});
