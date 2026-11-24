// Settings → Performance → "Show over exclusive full screen" (js/settings/perf-hud-rtss.js)
// on the small DOM: made only where the engine sends a state, the line under the switch
// says what is true now, the switch saves perfHud.rtss, Download opens the page on the PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { makeDom, settle } from './mini-dom.mjs';

const require = createRequire(import.meta.url);
const PerfHud = require('../js/performance/perf-hud.js');
const SRC = readFileSync(new URL('../js/settings/perf-hud-rtss.js', import.meta.url), 'utf8');
const URL_GET = 'https://www.guru3d.com/download/rtss-rivatuner-statistics-server-download';

function rig({ group = true, answer = { ok: true } } = {}) {
  const { document } = makeDom();
  if (group) {
    const g = document.createElement('div');
    g.id = 'settings-perfhud-group';
    const grid = document.createElement('div');
    grid.className = 'settings-grid';
    g.appendChild(grid);
    document.body.appendChild(g);
  }
  /** @type {Record<string, any>} */
  const env = {
    document,
    t: (key) => `«${key}»`,
    $: (id) => document.getElementById(id),
    hubSettings: { perfHud: PerfHud.normalizePerfHud({}) },
    normalizeSettings: (s) => ({ ...s, perfHud: PerfHud.normalizePerfHud(s.perfHud) }),
    saves: 0,
    statuses: [],
    posts: [],
  };
  env.saveHubSettings = () => { env.saves += 1; };
  env.setSettingsStatus = (key, kind) => env.statuses.push([key, kind]);
  env.apiJson = async (path, opts) => { env.posts.push([path, JSON.parse(opts.body)]); return answer; };
  env.window = env;
  env.window.PerfHud = PerfHud;
  vm.runInNewContext(SRC, env);
  const $ = env.$;
  const row = () => $('settings-perfhud-rtss-row');
  const hint = () => $('settings-perfhud-rtss-hint');
  const get = () => $('settings-perfhud-rtss-get');
  const box = () => $('settings-perfhud-rtss');
  return { env, sync: env.PerfHudRtss.sync, row, hint, get, box, document };
}

const state = (on, running, showing = false) => ({ on, running, showing, url: URL_GET });

test('one window name, and no row where the engine sends no state (macOS, Linux)', () => {
  const { env, sync, row } = rig();
  assert.deepEqual(Object.keys(env.PerfHudRtss), ['sync']);
  sync(null);
  sync(undefined);
  sync('nonsense');
  assert.equal(row(), null, 'off Windows the row is never made');
});

test('off: the switch is off, the line says why it exists, no download offered', () => {
  const { sync, row, hint, get, box, document } = rig();
  sync(state(false, false));
  assert.equal(row().hidden, false);
  assert.equal(row().parentNode, document.querySelector('#settings-perfhud-group .settings-grid'));
  assert.equal(box().checked, false);
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_sub', 'a language switch redraws it');
  assert.equal(hint().textContent, '«xmenu_rtss_sub»');
  assert.equal(get().hidden, true);
});

test('on: the line follows RivaTuner closed, open and drawing; Download only while it is closed', () => {
  const { sync, hint, get, box, document } = rig();
  sync(state(true, false));
  assert.equal(box().checked, true);
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_closed');
  assert.equal(get().hidden, false);
  sync(state(true, true));
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_ready');
  assert.equal(get().hidden, true);
  sync(state(true, true, true));
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_showing');
  assert.equal(document.querySelectorAll('#settings-perfhud-rtss-row').length, 1, 'a status poll never adds a second row');
});

test('a state that goes away hides the row instead of leaving a stale one', () => {
  const { sync, row } = rig();
  sync(state(true, true));
  sync(null);
  assert.equal(row().hidden, true);
  sync(state(false, false));
  assert.equal(row().hidden, false);
});

test('the switch saves perfHud.rtss and says so at once, without claiming it already shows', () => {
  const { env, sync, box, hint, get } = rig();
  sync(state(false, false));
  box().checked = true;
  box()._handlers.change.forEach((fn) => fn({ target: box() }));
  assert.equal(env.hubSettings.perfHud.rtss, true);
  assert.equal(env.saves, 1);
  assert.deepEqual(env.statuses.at(-1), ['settings_saved', 'ok']);
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_closed');
  assert.equal(get().hidden, false, 'RivaTuner is not open: the download is right there');
  sync(state(true, true, true));
  box().checked = false;
  box()._handlers.change.forEach((fn) => fn({ target: box() }));
  assert.equal(env.hubSettings.perfHud.rtss, false);
  assert.equal(hint().getAttribute('data-i18n'), 'xmenu_rtss_sub', 'off is never "showing"');
  const parts = PerfHud.normalizePerfHud({});
  for (const k of Object.keys(parts)) if (k !== 'rtss') assert.deepEqual(env.hubSettings.perfHud[k], parts[k], `${k} untouched`);
});

test('Download asks the PC to open the page, and says when it could not', async () => {
  const { env, sync, get } = rig();
  sync(state(true, false));
  get().querySelector('button').click();
  await settle();
  assert.deepEqual(env.posts, [['/actions/run', { type: 'openUrl', url: URL_GET }]]);
  assert.equal(env.statuses.length, 0);

  const failed = rig({ answer: { ok: false } });
  failed.sync(state(true, false));
  failed.get().querySelector('button').click();
  await settle();
  assert.deepEqual(failed.env.statuses, [['spot_open_failed', 'error']]);

  const offline = rig({ answer: null });
  offline.sync(state(true, false));
  offline.get().querySelector('button').click();
  await settle();
  assert.deepEqual(offline.env.statuses, [['spot_open_failed', 'error']]);
});

test('with Settings not drawn yet nothing is made, and the next sync makes it', () => {
  const { sync, row, document } = rig({ group: false });
  sync(state(true, false));
  assert.equal(row(), null);
  const g = document.createElement('div');
  g.id = 'settings-perfhud-group';
  const grid = document.createElement('div');
  grid.className = 'settings-grid';
  g.appendChild(grid);
  document.body.appendChild(g);
  sync(state(true, false));
  assert.equal(row().hidden, false);
});
