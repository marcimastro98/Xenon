// Settings → Ambient: three blocks (when it opens, which scene, my scenes), the
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

test('the section is three titled blocks in a fixed order', () => {
  assert.equal(sections.length, 3);
  const titles = sections.map(s => (s.match(/settings-ambient-sec-title" data-i18n="(\w+)"/) || [])[1]);
  assert.deepEqual(titles, ['ambient_sec_when', 'ambient_scene_label', 'ambient_my_scenes']);
});

test('every control keeps its id and the setting it writes', () => {
  const [when, scene, mine] = sections;
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
  assert.match(sections[1], /class="settings-ambient-classic" id="settings-ambient-builtin-widgets"/);
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
  const mine = sections[2];
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
