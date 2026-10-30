// Settings → Ambient: four blocks (when it opens, on the PC, which scene, my scenes), the
// Classic scene's widgets under the picker they belong to, every control still
// wired to the same setting, and a Delete button whose label can be read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const INDEX = read('../index.html');
const CSS = read('../components/AmbientCanvas/AmbientCanvas.css');
const SETTINGS_CSS = read('../components/SettingsModal/SettingsModal.css');
const SETTINGS = read('../js/settings.js');
const I18N = read('../js/i18n.js');

const group = INDEX.slice(INDEX.indexOf('<div class="settings-group settings-lock-group"'), INDEX.indexOf('<div class="settings-group settings-weather-group"'));
const sections = group.split('<section class="settings-ambient-sec').slice(1);

test('the section is four titled blocks in a fixed order', () => {
  assert.equal(sections.length, 4);
  const titles = sections.map(s => (s.match(/settings-ambient-sec-title" data-i18n="(\w+)"/) || [])[1]);
  assert.deepEqual(titles, ['ambient_sec_when', 'ambient_sec_pc', 'ambient_scene_label', 'ambient_my_scenes']);
});

// The animated wallpaper and the PC screensaver are windows of the native app:
// hidden until it says it can draw them, like the edge glow row.
test('On the PC: the wallpaper switch and the screensaver delay, native only', () => {
  const pc = sections[1];
  assert.match(pc, /^" id="settings-ambient-pc" hidden>/);
  assert.match(pc, /id="settings-ambient-wallpaper"[^>]*updateAmbientSetting\('wallpaper', this\.checked\)/);
  assert.match(pc, /id="settings-ambient-saver"[^>]*updateAmbientSetting\('saverMinutes', this\.value\)/);
  const minutes = [...pc.matchAll(/<option value="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(minutes, [0, 5, 10, 15, 30, 60], 'the values normalizeAmbientMode keeps');
  const sync = SETTINGS.slice(SETTINGS.indexOf('function syncAmbientPcSettings('), SETTINGS.indexOf('const AMBIENT_SETTING_KEYS'));
  assert.match(sync, /sec\.hidden = !\(window\.__XENON_NATIVE__ === true && caps\.scene === true\)/);
  assert.match(SETTINGS, /const AMBIENT_SETTING_KEYS = Object\.freeze\(\['enabled', 'idleMinutes', 'sceneId', 'openOnStartup', 'wallpaper', 'saverMinutes'\]\)/);
  assert.match(SETTINGS, /if \(AMBIENT_SETTING_KEYS\.every\(\(k\) => next\[k\] === cur\[k\]\)\) return;/, 'an unchanged value is no save');
  for (const k of ['ambient_sec_pc', 'ambient_pc_hint', 'ambient_wallpaper', 'ambient_wallpaper_hint', 'ambient_saver_label']) {
    assert.equal((I18N.match(new RegExp(`\\b${k}:`, 'g')) || []).length, 11, k);
  }
});

// Linux stacks the wallpaper under the windows, not behind the icons: the line
// under the switch says so there, and only there.
test('On the PC: the wallpaper line is true on Linux too', () => {
  assert.match(sections[1], /id="settings-ambient-wallpaper-hint" data-i18n="ambient_wallpaper_hint"/);
  assert.equal((I18N.match(/\bambient_wallpaper_hint_under:/g) || []).length, 11);
  const src = SETTINGS.slice(SETTINGS.indexOf('function syncAmbientPcSettings('), SETTINGS.indexOf('const AMBIENT_SETTING_KEYS'));
  const run = (caps) => {
    const hint = { dataset: { i18n: 'ambient_wallpaper_hint' }, textContent: 'behind' };
    const els = { 'settings-ambient-wallpaper-hint': hint };
    const window = { __XENON_NATIVE__: true, __XENON_NATIVE_CAPS__: caps };
    new Function('$', 't', 'window', `${src}; syncAmbientPcSettings({ wallpaper: false, saverMinutes: 0 });`)(
      (id) => els[id] || null, (k) => `text:${k}`, window);
    return hint;
  };
  assert.deepEqual(run({ scene: true, wallpaperBehindIcons: false }), { dataset: { i18n: 'ambient_wallpaper_hint_under' }, textContent: 'text:ambient_wallpaper_hint_under' });
  assert.deepEqual(run({ scene: true, wallpaperBehindIcons: true }), { dataset: { i18n: 'ambient_wallpaper_hint' }, textContent: 'behind' });
  assert.deepEqual(run({ scene: true }), { dataset: { i18n: 'ambient_wallpaper_hint' }, textContent: 'behind' });
});

test('every control keeps its id and the setting it writes', () => {
  const [when, , scene, mine] = sections;
  assert.match(when, /id="settings-ambient-enabled"[^>]*updateAmbientSetting\('enabled'/);
  assert.match(when, /id="settings-ambient-startup"[^>]*updateAmbientSetting\('openOnStartup'/);
  assert.match(when, /id="settings-ambient-idle"[^>]*updateAmbientSetting\('idleMinutes'/);
  assert.match(scene, /id="settings-ambient-scene"[^>]*updateAmbientSetting\('sceneId'/);
  assert.match(scene, /id="settings-ambient-scene-note" hidden/);
  for (const k of ['clock', 'weather', 'media', 'calendar']) {
    assert.match(scene, new RegExp(`id="settings-lock-${k}"[^>]*updateLockWidgetSetting\\('${k}'`), k);
  }
  assert.match(mine, /id="settings-ambient-scenes"/);
  assert.match(mine, /CommunityGallery\.open\('ambient'\)/);
  assert.match(mine, /id="settings-ambient-scene-list"/);
});

test('the startup explanation sits under its own toggle', () => {
  assert.match(sections[0], /id="settings-ambient-startup"[^]*?<span class="settings-label-line">[^]*?data-i18n="ambient_startup_hint"[^]*?<\/label>/);
});

test('the Classic widgets live with the scene picker and can be hidden', () => {
  assert.match(sections[2], /class="settings-ambient-classic" id="settings-ambient-builtin-widgets"/);
  assert.match(CSS, /\.settings-ambient-classic\[hidden\] \{ display: none; \}/);
  assert.match(SETTINGS, /builtinWidgets\.hidden = cfg\.sceneId !== 'builtin';/);
});

test('Delete is a readable quiet button, never red text on the red fill', () => {
  assert.match(SETTINGS, /mk\(t\('ambient_scene_delete'\), 'settings-ambient-scene-del',/);
  assert.doesNotMatch(CSS, /\.settings-btn\.danger \{ color: var\(--color-danger\); \}/);
  assert.match(CSS, /\.settings-ambient-scene-acts \.settings-ambient-scene-del \{ color: var\(--color-danger\); \}/);
});

test('the blocks are not inset twice by the generic group padding', () => {
  assert.doesNotMatch(SETTINGS_CSS, /\.settings-group > \.settings-ambient-(row|scenes),/);
});

// "How do I make a scene?" was the question an empty list could not answer:
// scenes are made in Xenon Maker, imported as a code or installed from the
// gallery, and the three ways in sit right above the list.
test('My scenes says where scenes come from', () => {
  const mine = sections[3];
  assert.match(mine, /href="https:\/\/xenon-app\.com\/maker\/" target="_blank" rel="noopener noreferrer" data-i18n="ambient_create_maker"/);
  assert.match(mine, /PresetShare\.openImport\(\)" data-i18n="ambient_import_code"/);
  assert.match(mine, /CommunityGallery\.open\('ambient'\)" data-i18n="ambient_gallery"/);
  assert.match(CSS, /\.settings-ambient-scenes-acts a\.settings-btn \{[^}]*text-decoration: none;/);
});

test('gallery scenes are listed, named safely, with no Edit to offer', () => {
  const fn = SETTINGS.slice(SETTINGS.indexOf('function renderAmbientSceneManager()'), SETTINGS.indexOf('function ambientPackageRow('));
  assert.match(fn, /CustomWidget\.cachedPackages\(\)\.filter\(p => p && p\.surface === 'ambient'\)/);
  assert.match(fn, /if \(!scenes\.length && !packages\.length\)/, 'the empty text only when there is nothing at all');
  const row = SETTINGS.slice(SETTINGS.indexOf('function ambientPackageRow('));
  const body = row.slice(0, row.indexOf('\n}\n'));
  assert.match(body, /name\.textContent = pkg\.name \|\| pkg\.id;/);
  assert.match(body, /t\('ambient_pkg_note'\)/);
  assert.doesNotMatch(body, /innerHTML|mk\(/, 'no markup and no action buttons');
});

test('every new word exists in all 11 languages', () => {
  const keys = ['ambient_sec_when', 'ambient_classic_widgets', 'ambient_scene_active', 'ambient_editor_count', 'ambient_editor_count_one',
    'ambient_create_maker', 'ambient_import_code', 'ambient_gallery', 'ambient_scenes_empty', 'ambient_pkg_note'];
  const langs = [...I18N.matchAll(/Object\.assign\(i18n\.(\w+), \{\n  ambient_create_maker:/g)].map(m => m[1]);
  assert.equal(langs.length, 11);
  for (const k of keys) assert.equal((I18N.match(new RegExp('^  ' + k + ': ', 'gm')) || []).length >= 11, true, k);
  assert.match(SETTINGS, /count === 1 \? t\('ambient_editor_count_one'\)/);
});
