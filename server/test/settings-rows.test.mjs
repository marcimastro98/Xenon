// What a Settings page decides by itself: a closed row says what is inside it, an option goes
// away with its switch, a step this PC cannot do stays dimmed, and a line or a key that has
// nothing to say is not drawn. settings.js is a browser file with no exports, so each function
// is cut from the source and run in a vm against test/mini-dom.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const SETTINGS = read('../js/settings.js');
const HTML = read('../index.html');
const CSS = read('../components/SettingsModal/SettingsPage.css');

function fn(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm').exec(SETTINGS);
  assert.ok(m, name);
  return m[0];
}

// Runs the named functions in a page of their own; `run` is the last one.
function page(names, globals) {
  const sandbox = { ...globals };
  vm.createContext(sandbox);
  vm.runInContext(`${names.map(fn).join('\n')}\nthis.run = ${names.at(-1)};`, sandbox);
  return sandbox;
}

// A few element ids, as $() finds them.
function ids(document, list) {
  const els = Object.fromEntries(list.map((id) => {
    const el = document.createElement('div');
    el.id = id;
    return [id, el];
  }));
  return { els, $: (id) => els[id] || null };
}

// What mini-dom leaves out and these functions read: an open <details>, a <select>'s choice.
function withForms(document) {
  const make = document.createElement;
  document.createElement = (tag) => {
    const el = make(tag);
    if (tag === 'details') {
      Object.defineProperty(el, 'open', {
        get: () => el.hasAttribute('open'),
        set: (on) => (on ? el.setAttribute('open', '') : el.removeAttribute('open')),
      });
    }
    if (tag === 'select') {
      Object.defineProperty(el, 'options', { get: () => el.children });
      Object.defineProperty(el, 'selectedIndex', { get: () => Math.max(0, el.children.findIndex((o) => o.selected)) });
      Object.defineProperty(el, 'value', { get: () => (el.children[el.selectedIndex] || {}).value || '' });
    }
    return el;
  };
  return document;
}

// controls.css draws every checkbox with a tick, hidden at scale(0) until it is checked, and a
// switch is one of those: all it does not restate it inherits. Seen 7 Nov 2026: no knob when off.
test('a switch is a knob at both ends, none of the tick it is built on', () => {
  const knob = /input\.settings-check\[type="checkbox"\]::after \{([^}]*)\}/.exec(CSS)[1];
  assert.match(knob, /transform: none/);
  assert.match(knob, /border: 0/);
  assert.match(knob, /margin: 0/);
});

test('a closed list of switches says which are on', () => {
  const { document } = makeDom();
  const details = document.createElement('details');
  const summary = details.appendChild(document.createElement('summary'));
  const line = summary.appendChild(document.createElement('span'));
  line.className = 'settings-hint';
  for (const [name, on] of [['CPU load', true], ['GPU load', false], ['RAM', true]]) {
    const label = details.appendChild(document.createElement('label'));
    const box = label.appendChild(document.createElement('input'));
    box.className = 'settings-check';
    box.checked = on;
    const word = label.appendChild(document.createElement('span'));
    word.setAttribute('data-i18n', 'x');
    word.textContent = name;
  }
  page(['syncExpanderSummary'], {}).run(details);
  assert.equal(line.textContent, 'CPU load, RAM');
});

function contextPage(map, deck = []) {
  const document = withForms(makeDom().document);
  const mount = document.createElement('div');
  const context = page(['contextExpander', 'contextRow', 'syncContextSummary', 'buildContextSelect', 'renderContextProfileRows'], {
    document,
    window: { Deck: { listProfiles: () => deck.map((name) => ({ name })) } },
    $: (id) => (id === 'settings-ctxprof-rows' ? mount : null),
    PERF_ACTIVITIES: ['gaming', 'coding'],
    hubSettings: { dashboardLayout: { pages: [{ id: 'p1', name: 'Racing' }] } },
    t: (k) => k,
    getCustomThemes: () => [],
    themeName: (th) => th.id,
    updateContextMap() {},
    initAllCustomSelects() {},
  });
  context.run({ map });
  return { mount, render: () => context.run({ map }) };
}

test('each activity is a row that opens, and closed it says what it switches to', () => {
  const { mount } = contextPage({ gaming: { page: 'p1', lighting: 'solid', deck: '', style: '' } });
  const rows = mount.children;
  assert.deepEqual(rows.map((d) => d.dataset.activity), ['gaming', 'coding']);
  assert.ok(rows.every((d) => d.tag === 'details' && d.classList.contains('settings-expander')));
  assert.equal(rows[0].querySelector('summary .settings-hint').textContent, 'Racing, context_light_solid');
  assert.equal(rows[1].querySelector('summary .settings-hint').textContent, '', 'nothing picked, nothing said');
});

test('a choice that no longer exists stays listed, so it can be seen and cleared', () => {
  const { mount } = contextPage({ gaming: { page: '', lighting: '', deck: 'Gone', style: '' } }, ['Streaming']);
  assert.equal(mount.children[0].querySelector('summary .settings-hint').textContent, 'Gone');
});

test('a row left open stays open when the list is drawn again', () => {
  const { mount, render } = contextPage({});
  mount.children[1].open = true;
  render();
  assert.deepEqual(mount.children.map((d) => d.open), [false, true]);
});

test('an option goes away with its switch, a step the PC cannot do stays dimmed', () => {
  assert.match(CSS, /#settings-overlay :is\(\.settings-toggle-row, \.settings-row, \.settings-vitals-row, \.settings-expander\)\.is-disabled \{ display: none; \}/);
  assert.match(CSS, /#settings-overlay \.settings-toggle-row\.is-blocked \{ opacity: 0\.42; pointer-events: none; \}/);
  const { document } = makeDom();
  const { els, $ } = ids(document, ['step', 'step-row']);
  const block = page(['blockVitalsStep'], { $ }).run;
  block('step', false);
  assert.equal(els.step.disabled, true);
  assert.ok(els['step-row'].classList.contains('is-blocked'));
  assert.ok(!els['step-row'].classList.contains('is-disabled'), 'it stays on the page: the line under it says why');
  els.step.disabled = false;
  block('step', true);
  assert.equal(els.step.disabled, false);
  assert.ok(!els['step-row'].classList.contains('is-blocked'));
});

test('a group left with no row in view goes too, its title with it', () => {
  assert.match(CSS, /\.settings-group:not\(:has\(> :not\(\.settings-group-head\):not\(\[hidden\]\):not\(\[style\*="display: none"\]\):not\(\.is-disabled\)\)\) \{ display: none; \}/);
});

test('the City row is there only for a place typed by hand', () => {
  assert.match(fn('syncWeatherSettingsControls'), /cityInput\.closest\('\.settings-row'\)\.hidden = weather\.mode !== 'manual';/);
});

async function cliAfter(status) {
  const { document } = makeDom();
  const { els, $ } = ids(document, ['settings-cli-intro', 'settings-cli-guide', 'settings-cli-status', 'settings-cli-detail']);
  const sandbox = {
    $,
    t: (k) => k,
    AI_CLI_INFO: { claude: { guide: 'https://example.test/' } },
    _aiCliSeq: 0,
    _aiCliText: (k) => k,
    _aiCliRenderModels() {},
    fetch: async (url) => ({ ok: true, json: async () => (url.includes('/models') ? { models: [] } : status) }),
  };
  vm.createContext(sandbox);
  vm.runInContext(`var _aiCliSeq = 0;\n${fn('aiCliRefresh')}\nthis.run = aiCliRefresh;`, sandbox);
  await sandbox.run('claude', false);
  return els;
}

test('How to install is there until the program is ready', async () => {
  assert.equal((await cliAfter({ installed: false }))['settings-cli-guide'].hidden, false);
  assert.equal((await cliAfter({ installed: true, loggedIn: false }))['settings-cli-guide'].hidden, false);
  const ready = await cliAfter({ installed: true, loggedIn: true });
  assert.equal(ready['settings-cli-guide'].hidden, true);
  assert.equal(ready['settings-cli-status'].dataset.state, 'ok');
});

async function memoryAfter(facts) {
  const { document } = makeDom();
  const { els, $ } = ids(document, ['settings-ai-memory-list', 'settings-ai-memory-empty', 'settings-ai-memory-clear']);
  await page(['renderAiMemoryList'], {
    $, document, t: (k) => k, forgetAiMemoryFact() {},
    fetch: async () => ({ json: async () => ({ facts }) }),
  }).run();
  return els;
}

test('Clear memory shows only when something is remembered', async () => {
  const none = await memoryAfter([]);
  assert.equal(none['settings-ai-memory-clear'].hidden, true);
  assert.equal(none['settings-ai-memory-empty'].hidden, false);
  const some = await memoryAfter([{ id: 'a', text: 'Likes tea' }]);
  assert.equal(some['settings-ai-memory-clear'].hidden, false);
  assert.equal(some['settings-ai-memory-empty'].hidden, true);
});

async function supporterAfter(answer) {
  const { document } = makeDom();
  const { els, $ } = ids(document, ['settings-supporter-state', 'settings-supporter-forget', 'settings-supporter-code',
    'settings-supporter-save', 'settings-supporter-saved', 'settings-supporter-lead', 'settings-supporter-sparks-note']);
  await page(['syncSupporterCodeBox'], { $, t: (k) => k, fetch: async () => ({ json: async () => answer }) }).run();
  return els;
}

test('a saved code is said once: what the box is for goes with the box', async () => {
  const saved = await supporterAfter({ pass: true, wallet: true });
  assert.equal(saved['settings-supporter-state'].textContent, 'settings_supporter_saved');
  for (const id of ['code', 'save', 'lead', 'sparks-note']) assert.equal(saved['settings-supporter-' + id].hidden, true, id);
  for (const id of ['saved', 'forget']) assert.equal(saved['settings-supporter-' + id].hidden, false, id);
  // A pass alone keeps the field, asking only for a Sparks code bought with another email.
  const pass = await supporterAfter({ pass: true });
  for (const id of ['code', 'save', 'sparks-note', 'saved', 'forget']) assert.equal(pass['settings-supporter-' + id].hidden, false, id);
  assert.equal(pass['settings-supporter-lead'].hidden, true);
  assert.equal(pass['settings-supporter-sparks-note'].textContent, 'settings_sparks_add_note');
  const wallet = await supporterAfter({ wallet: true });
  assert.equal(wallet['settings-supporter-state'].textContent, 'settings_sparks_code_saved');
});

test('no code: the field and what it is for, and no line about what is missing', async () => {
  const empty = await supporterAfter({});
  assert.equal(empty['settings-supporter-state'].textContent, '');
  for (const id of ['code', 'save', 'lead', 'sparks-note']) assert.equal(empty['settings-supporter-' + id].hidden, false, id);
  for (const id of ['saved', 'forget']) assert.equal(empty['settings-supporter-' + id].hidden, true, id);
});

test('Download model sits in the row of the model it downloads', () => {
  const at = HTML.indexOf('id="ai-model-select"');
  const row = HTML.slice(HTML.lastIndexOf('<div class="settings-row full">', at), HTML.indexOf('id="ai-pull-progress"'));
  assert.ok(row.includes('id="ai-pull-model"'));
});

test('"I have a code" shows only to someone with no code', () => {
  assert.match(read('../js/ai-xenon-settings.js'), /show\('xai-no-code', st\.status === 'no_code'\);/);
  assert.ok(HTML.indexOf('id="settings-xenon-credits"') < HTML.indexOf('id="xai-no-code"'));
});

test('Ollama at sign-in is offered only where Xenon can set it', async (t) => {
  const aiLocal = require('../ai-local.js');
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', real));
  Object.defineProperty(process, 'platform', { ...real, value: 'linux' });
  assert.equal(aiLocal.ollamaAutostartSupported(), false);
  assert.equal(await aiLocal.getOllamaAutostart(), false);
  assert.deepEqual(await aiLocal.setOllamaAutostart(true), { ok: false, error: 'unsupported' });
  for (const platform of ['win32', 'darwin']) {
    Object.defineProperty(process, 'platform', { ...real, value: platform });
    assert.equal(aiLocal.ollamaAutostartSupported(), true, platform);
  }
});

test('the row goes when the server says Xenon cannot switch it', async () => {
  const { document } = makeDom();
  const row = document.createElement('label');
  row.className = 'ai-autostart-row';
  const box = row.appendChild(document.createElement('input'));
  const sync = (answer) => page(['aiLocalSyncAutostart'], {
    $: (id) => (id === 'ai-ollama-autostart' ? box : null),
    fetch: async () => ({ json: async () => answer }),
  }).run();
  await sync({ enabled: false, supported: false });
  assert.equal(row.hidden, true);
  await sync({ enabled: true, supported: true });
  assert.equal(row.hidden, false);
  assert.equal(box.checked, true);
});

test('the levers only Windows has are off the page and out of the sheet elsewhere', () => {
  for (const id of ['settings-perf-powerplan', 'settings-perf-manageapps', 'settings-perf-priority']) {
    const row = HTML.slice(HTML.lastIndexOf('<label', HTML.indexOf(`id="${id}"`)), HTML.indexOf(`id="${id}"`));
    assert.match(row, /data-settings-win-only/, id);
  }
  const perf = read('../js/performance.js');
  assert.match(perf, /const windowsLevers = \(\) => !window\.XenonPlatform \|\| window\.XenonPlatform === 'win32';/);
  assert.match(perf, /const closesApps = \(p\) => p\.opts\.manageApps && windowsLevers\(\);/);
  assert.match(perf, /eff\.powerPlan && eff\.powerPlan !== 'none' && windowsLevers\(\)/);
  assert.match(perf, /eff\.priorityBoost && target && windowsLevers\(\)/);
  const sheet = perf.slice(perf.indexOf('function buildSheet'));
  assert.ok(sheet.indexOf('if (windowsLevers()) {') < sheet.indexOf("_optRow('powerPlan'"), 'the sheet offers them only on Windows');
});

test('Delete games shows only with games to delete', async (t) => {
  const pane = require('../js/game-sessions-pane.js');
  const { document } = makeDom();
  const { els } = ids(document, ['settings-gamesess-list', 'settings-gamesess-empty', 'settings-gamesess-actions']);
  const previous = { document: globalThis.document, apiJson: globalThis.apiJson, t: globalThis.t };
  t.after(() => Object.assign(globalThis, previous));
  document.getElementById = (id) => els[id] || null;
  let sessions = [];
  Object.assign(globalThis, { document, apiJson: async () => ({ enabled: true, sessions }), t: (k) => k });
  await pane.render();
  await settle();
  assert.equal(els['settings-gamesess-actions'].hidden, true);
  sessions = [{ id: 'gs_a', game: 'ok', start: 1, end: 600001, durationS: 600, avgFps: 50 }];
  await pane.render();
  await settle();
  assert.equal(els['settings-gamesess-actions'].hidden, false);
});

test('the mirror rows go only where the system has no notification reader', async () => {
  const rows = ['settings-winnotif-row', 'settings-winnotif-hide-row'];
  const check = async (answer) => {
    const { document } = makeDom();
    const { els, $ } = ids(document, rows);
    const { run } = page(['syncNotifMirrorSupport'], { $, apiJson: async () => answer });
    await run();
    return rows.map((id) => els[id].hidden === true);
  };
  assert.deepEqual(await check({ ok: true, supported: false }), [true, true]);
  assert.deepEqual(await check({ ok: true, supported: true }), [false, false]);
  assert.deepEqual(await check(null), [false, false], 'no answer is no reason to take them away');
});

test('hiding during Remote Desktop is offered on Windows only', () => {
  const at = HTML.indexOf('id="settings-hide-rdp-row"');
  assert.match(HTML.slice(at, HTML.indexOf('>', at)), /data-settings-win-only/);
});

test('the sensors repair is a row with the page key, and only when there is something to repair', async () => {
  const run = async (sensorAccess) => {
    const { document } = makeDom();
    const host = document.createElement('div');
    host.id = 'settings-sensors-hub';
    document.body.appendChild(host);
    const window = {};
    const makeEl = (tag, cls, text) => {
      const el = document.createElement(tag);
      if (cls) el.className = cls;
      if (text != null) el.textContent = text;
      return el;
    };
    const sandbox = { window, document, makeEl, apiJson: async () => ({ sensorAccess }), setTimeout };
    vm.createContext(sandbox);
    vm.runInContext(read('../js/sensor-access.js'), sandbox);
    await window.SensorAccess.initSettings();
    return host;
  };
  assert.equal((await run('ok')).children.length, 0);
  // Missing parts get the same row, with the key that installs them.
  assert.ok((await run('missing')).querySelector('button'));
  const host = await run('needs_admin');
  assert.ok(host.querySelector('.settings-group-head'));
  assert.equal(host.querySelector('button').className, 'settings-btn primary');
  // The tiles keep their own key: only this page swaps it.
  assert.match(read('../js/sensor-access.js'), /el\('button', 'sa-btn'\)/);
  assert.match(CSS, /#settings-overlay \.sa-hint \{\s+display: grid;/);
});

// 5.1.0: the sensors read through the "Xenon Sensors" service. An update that
// changes its scripts cannot reach Program Files, so the page offers the same
// prompt as "Update sensors"; a 'service' answer waits for real readings.
function loadSensorAccess(answers, fetchAnswer) {
  const { document } = makeDom();
  const host = document.createElement('div');
  host.id = 'settings-sensors-hub';
  document.body.appendChild(host);
  const window = {};
  const makeEl = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };
  const asked = [];
  const apiJson = async (url) => { asked.push(url); return typeof answers[url] === 'function' ? answers[url]() : answers[url]; };
  const fetch = async () => ({ json: async () => fetchAnswer });
  const fastTimeout = (fn) => setTimeout(fn, 0);
  const sandbox = { window, document, makeEl, apiJson, fetch, setTimeout: fastTimeout };
  vm.createContext(sandbox);
  vm.runInContext(read('../js/sensor-access.js'), sandbox);
  return { window, host, asked };
}

test('sensors that read through an outdated service get an Update sensors key', async () => {
  const outdated = loadSensorAccess({ '/system': { sensorAccess: 'ok' }, '/api/sensor-service': { ok: true, service: { running: true, outdated: true } } });
  await outdated.window.SensorAccess.initSettings();
  const btn = outdated.host.querySelector('button');
  assert.ok(btn);
  assert.equal(btn.textContent, 'Update sensors');
  assert.equal(btn.className, 'settings-btn primary');

  for (const service of [{ running: true, outdated: false }, null]) {
    const current = loadSensorAccess({ '/system': { sensorAccess: 'ok' }, '/api/sensor-service': { ok: true, service } });
    await current.window.SensorAccess.initSettings();
    assert.equal(current.host.children.length, 0);
  }
  // A paired phone may be refused the read: no answer, no card.
  const refused = loadSensorAccess({ '/system': { sensorAccess: 'ok' }, '/api/sensor-service': null });
  await refused.window.SensorAccess.initSettings();
  assert.equal(refused.host.children.length, 0);
});

test('a service answer is done only once the sensors really read', async () => {
  let polls = 0;
  const access = () => ({ sensorAccess: ++polls < 3 ? 'needs_admin' : 'ok' });
  const s = loadSensorAccess({ '/system': access }, { ok: true, status: 'service' });
  const node = s.window.SensorAccess.hintNode('text', '', false);
  s.host.appendChild(node);
  node.querySelector('button').click();
  for (let i = 0; i < 50 && !/is-ok/.test(node.querySelector('.sa-status').className); i++) await new Promise((r) => setTimeout(r, 5));
  assert.match(node.querySelector('.sa-status').textContent, /^Done! Fan speeds/);
  assert.ok(polls >= 3, 'the stale needs_admin was not taken as the answer');
});
