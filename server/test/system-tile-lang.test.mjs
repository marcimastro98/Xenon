// The system tile writes its words in script from the last /system reading
// ("Up for", "DISK C:", "free"), so a language change left them in the old
// language until the next reading arrived. setLang repaints the tile from the
// reading it already has. Here the real setLang and t() from i18n.js and the
// real system.js run in one vm, on the real English and Italian tables, with a
// stand-in tile whose fields are plain objects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LayerI18n = require('../layer-strings.js');
const { normalizeLangCode } = require('../shared/src/constants.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const I18N = read('../js/i18n.js').replace(/\r\n/g, '\n');
const slice = (head) => {
  const start = I18N.indexOf(head);
  assert.ok(start >= 0, head + ' not found');
  return I18N.slice(start, I18N.indexOf('\n}\n', start) + 3);
};

// One tile on the page: every [data-sf] field it is asked for, created on first use.
function tile() {
  const fields = new Map();
  return {
    fields,
    querySelector(selector) {
      const name = /data-sf="([^"]+)"/.exec(selector)[1];
      if (!fields.has(name)) fields.set(name, { textContent: '', style: {} });
      return fields.get(name);
    },
  };
}

async function page() {
  const root = tile();
  const ctx = vm.createContext({
    console, normalizeLangCode,
    localStorage: { setItem() {} },
    applyTranslations() {},
    queueWeatherSettingsRefresh() {},   // the weather refetch setLang also asks for
    setFill() {},
    resetStatSparkFor() {},
    formatBytes: (b) => Math.round(b / 1024 ** 3) + ' GB',
    formatUptime: () => '2h 5m',
    window: { DashboardGrid: { forEachInstance: (kind, fn) => { if (kind === 'system') fn(root); } } },
  });
  // state.js's globals, then the strings, then the tile's code.
  vm.runInContext("let lang = 'en'; let lastSystemData = null; let systemDisks = null; let diskIndex = 0; let gpuMetric = 'load';", ctx);
  vm.runInContext('const i18n = ' + await LayerI18n.tablesFor(['en', 'it']) + ';', ctx);
  vm.runInContext(slice('function t(key) {') + slice('function setLang(l) {'), ctx);
  vm.runInContext(read('../js/system.js'), ctx);
  return { ctx, field: (name) => root.fields.get(name)?.textContent };
}

const READING = {
  hostname: 'desk', uptime: 7500, cpu: 12, memory: { percent: 40, total: 16 * 1024 ** 3, used: 6 * 1024 ** 3 },
  gpu: 5, gpuName: 'GPU', disks: [{ drive: 'C:', percent: 50, free: 100 * 1024 ** 3, used: 100 * 1024 ** 3, total: 200 * 1024 ** 3 }],
};

test('a language change repaints the system tile at once, from the last reading', async () => {
  const { ctx, field } = await page();
  ctx.applySystem(READING);
  assert.equal(field('uptime-text'), 'Up for 2h 5m');
  assert.equal(field('disk-label'), 'DISK C:');
  assert.equal(field('disk-small'), '100 GB free');

  vm.runInContext("setLang('it')", ctx);
  assert.equal(field('uptime-text'), 'Acceso da 2h 5m', 'no wait for the next /system reading');
  assert.equal(field('disk-label'), 'DISCO C:');
  assert.equal(field('disk-small'), '100 GB liberi');
});

test('the disk on show stays the one on show', async () => {
  const { ctx, field } = await page();
  const two = { ...READING, disks: [READING.disks[0], { ...READING.disks[0], drive: 'D:' }] };
  ctx.applySystem(two);
  ctx.cycleDisk();
  assert.equal(field('disk-label'), 'DISK D:');
  vm.runInContext("setLang('it')", ctx);
  assert.equal(field('disk-label'), 'DISCO D:');
});

test('with no reading yet the language still changes, and nothing is drawn', async () => {
  const { ctx, field } = await page();
  vm.runInContext("setLang('it')", ctx);
  assert.equal(vm.runInContext('lang', ctx), 'it');
  assert.equal(field('uptime-text'), undefined);
});
