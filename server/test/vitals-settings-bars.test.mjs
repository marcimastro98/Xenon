// Settings → Vitals (js/settings/vitals.js + vitals-controls.js): the bars in the top bar have their
// row again under "Abilita Vitals", switching the bar's own Vitals segment; "Dove vive Bit" shows and
// moves the place the person's own Bit has, since the Vitals' Bit stands there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from './browser-source.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, '..', p), 'utf8');

function mount({ island = true, own = null } = {}) {
  const { document, mkEl } = makeDom();
  const card = mkEl('div');
  const enabledRow = mkEl('label');
  const enabled = mkEl('input');
  enabled.id = 'settings-vitals-enabled';
  enabledRow.append(enabled);
  const reminders = mkEl('label');
  reminders.id = 'settings-vitals-reminders-row';
  const position = mkEl('select');
  position.id = 'settings-vpet-position';
  card.append(enabledRow, reminders, position);
  document.body.appendChild(card);
  const posts = [];
  const heard = [];
  const saves = [];
  const box = {
    document,
    hubSettings: {
      vitals: { enabled: true, topbar: false, items: {}, pet: { enabled: true, position: 'floating' } },
      topbarClock: { items: [{ id: 'time', hidden: false }, { id: 'vitals', hidden: island !== true }] },
    },
    VITALS_IDS: [], VITALS_PET_STAGES: [], VITALS_PET_DEFAULT_THR: {}, VITALS_DEFAULT_MIN: {},
    SERVER: 'http://127.0.0.1:3030',
    Event: class { constructor(type) { this.type = type; } },
    t: (k) => ({ settings_vitals_topbar: 'Mini indicators in the top bar' }[k] || k),
    normalizeSettings: (s) => s,
    saveHubSettings: () => saves.push(true),
    syncTopbarClockControls() {}, applyTopbarClockSettings() {}, setSettingsStatus() {},
    syncVitalsPcCaps() {}, syncVitalsAiBank() {},
    BitApp: { state: () => (own ? { ok: true, prefs: { place: own } } : null), heard: (b) => heard.push(b) },
    fetch: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { json: async () => ({ ok: true, bit: { ok: true, prefs: JSON.parse(init.body) } }) };
    },
  };
  box.window = box;
  vm.createContext(box);
  vm.runInContext(src('js/utils/page-and-text.js'), box); // makeEl and $, as the page has them
  for (const f of ['js/settings/topbar-order.js', 'js/vitals-pet/saved.js', 'js/settings/vitals.js', 'js/settings/vitals-controls.js']) {
    vm.runInContext(src(f), box, { filename: f });
    // vitals-pet.js hands Settings the place its Bit stands, from saved.js.
    if (f === 'js/vitals-pet/saved.js') box.VitalsPet = { position: box.VitalsPetSaved.position };
  }
  vm.runInContext('syncVitalsControls();', box);
  return { box, document, card, posts, heard, saves, position };
}

test('the bars have their row under "Abilita Vitals", once, and it switches the bar\'s Vitals segment', () => {
  const r = mount({ island: false });
  const bars = r.document.getElementById('settings-vitals-topbar');
  assert.ok(bars, 'the row is there');
  assert.equal(r.card.children[1].id, 'settings-vitals-topbar-row', 'right under the main switch');
  assert.equal(bars.checked, false, 'off, as the bar has it');
  assert.equal(r.card.children[1].querySelector('.settings-label-line').children[0].textContent, 'Mini indicators in the top bar');
  bars.checked = true;
  bars.dispatchEvent({ type: 'change' });
  const item = r.box.hubSettings.topbarClock.items.find((it) => it.id === 'vitals');
  assert.equal(item.hidden, false, 'the segment shows');
  assert.equal(r.box.hubSettings.vitals.topbar, true);
  vm.runInContext('syncVitalsControls();', r.box);
  assert.equal(r.card.children.filter((c) => c.id === 'settings-vitals-topbar-row').length, 1, 'not built twice');
  assert.equal(r.document.getElementById('settings-vitals-topbar').checked, true);
});

test('"Dove vive Bit" shows where the person\'s own Bit lives, and moving it moves that Bit', async () => {
  const r = mount({ own: 'both' });
  assert.equal(r.position.value, 'both', 'its room says both');
  vm.runInContext("updateVitalsPetSetting('position', 'both');", r.box);
  assert.equal(r.saves.length, 0, 'the place shown again is no save');
  vm.runInContext("updateVitalsPetSetting('position', 'topbar');", r.box);
  await new Promise((done) => setImmediate(done));
  assert.equal(r.box.hubSettings.vitals.pet.position, 'topbar');
  assert.deepEqual(r.posts, [{ url: 'http://127.0.0.1:3030/api/bit/prefs', body: { place: 'topbar' } }]);
  assert.equal(r.heard.length, 1, 'the dashboard hears the Bit moved');
});

test('with no Bit of its own yet, the Vitals keep their own place and nothing is sent', async () => {
  const r = mount({ own: null });
  vm.runInContext("updateVitalsPetSetting('position', 'both');", r.box);
  await new Promise((done) => setImmediate(done));
  assert.equal(r.box.hubSettings.vitals.pet.position, 'both');
  assert.equal(r.posts.length, 0);
});
