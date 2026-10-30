// A shared Deck profile carries no personal data of its author: app and file
// paths, phone numbers, device ids, webhooks and alarm codes leave empty, the
// import preview counts the keys to finish, and pressing one says what to do.
// A package shared on 26 Oct 2026 carried E:\Adobe\… and C:\Users\<name>\… paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PresetShare = require('../js/preset-share.js');
const DeckModel = require('../js/deck-model.js');
const DeckActions = require('../js/deck-actions.js');
const DEPS = { model: DeckModel, actions: DeckActions };
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const key = (title, tap, extra) => Object.assign({ kind: 'action', title, icon: { type: 'emoji', value: '★' }, triggers: { tap } }, extra);
const profileOf = (keys) => ({ name: 'DESK', root: { pages: [{ keys }] } });
const sharedKeys = (keys) => {
  const out = PresetShare.sanitizeDeckProfile(profileOf(keys), DEPS);
  assert.ok(out, 'the profile survives');
  return out.root.pages[0].keys.filter(Boolean);
};
const tapOf = (k) => DeckActions.triggerSteps(k.triggers.tap).map((s) => s.action);

test('app and file paths leave empty, the key keeps its title and action', () => {
  const [app, file] = sharedKeys([
    key('Photoshop', { type: 'openApp', path: 'E:\\Adobe\\Adobe Photoshop 2025\\Photoshop.exe' }),
    key('Spotify', { type: 'openFile', path: 'C:\\Users\\hope_\\AppData\\Roaming\\Spotify' }),
  ]);
  assert.equal(app.title, 'Photoshop');
  assert.deepEqual(tapOf(app), [{ type: 'openApp', path: '' }]);
  assert.deepEqual(tapOf(file), [{ type: 'openFile', path: '' }]);
});

test('launch arguments travel unless one of them is a path', () => {
  const [plain, withPath, posix] = sharedKeys([
    key('a', { type: 'openApp', path: 'C:\\x.exe', args: '--incognito --new-window' }),
    key('b', { type: 'openApp', path: 'C:\\x.exe', args: '--user-data-dir="C:\\Users\\me\\Chrome"' }),
    key('c', { type: 'openApp', path: '/usr/bin/x', args: '--config /home/me/.x' }),
  ]);
  assert.equal(tapOf(plain)[0].args, '--incognito --new-window');
  assert.equal('args' in tapOf(withPath)[0], false);
  assert.equal('args' in tapOf(posix)[0], false);
});

test('numbers, webhooks, alarm codes and device ids leave empty; links and the rest stay', () => {
  const keys = sharedKeys([
    key('call', { type: 'phoneCall', number: '+39 333 1234567' }),
    key('sms', { type: 'phoneMessage', number: '+39 333 1234567', text: 'On my way' }),
    key('hook', { type: 'webhook', url: 'https://discord.com/api/webhooks/1/secret', method: 'POST', body: '{"token":"x"}' }),
    key('alarm', { type: 'haAlarm', entity: 'alarm_control_panel.home', mode: 'disarm', code: '1234' }),
    key('out', { type: 'audioDeviceToggle', deviceA: 'Realtek\\Device\\Speakers\\Render', deviceB: 'USB\\Device\\Headset\\Render' }),
    key('spot', { type: 'spotifyDevice', device: 'a1b2c3' }),
    key('claude', { type: 'claudeAsk', projectId: 'p_secret', prompt: 'Run the tests' }),
    key('web', { type: 'openUrl', url: 'https://www.youtube.com/' }),
    key('obs', { type: 'obsScene', scene: 'Gaming' }),
  ]);
  const [call, sms, hook, alarm, out, spot, claude, web, obs] = keys.map((k) => tapOf(k)[0]);
  assert.equal(call.number, '');
  assert.equal(sms.number, ''); assert.equal(sms.text, 'On my way');
  assert.equal(hook.url, ''); assert.equal(hook.body, ''); assert.equal(hook.method, 'POST');
  assert.equal(alarm.code, ''); assert.equal(alarm.entity, 'alarm_control_panel.home');
  assert.equal(out.deviceA, ''); assert.equal(out.deviceB, '');
  assert.equal(spot.device, '');
  assert.equal(claude.projectId, ''); assert.equal(claude.prompt, 'Run the tests');
  assert.equal(web.url, 'https://www.youtube.com/');
  assert.equal(obs.scene, 'Gaming');
});

test('every step of a multi-action and every key inside a folder is cleaned', () => {
  const [multi, folder] = sharedKeys([
    key('multi', { steps: [
      { action: { type: 'openApp', path: 'E:\\Blender\\blender.exe' } },
      { action: { type: 'openUrl', url: 'https://example.com/' }, delayMs: 500 },
    ] }),
    { kind: 'folder', title: 'Apps', folder: { pages: [{ keys: [key('inner', { type: 'openApp', path: 'D:\\Games\\x.exe' })] }] } },
  ]);
  assert.deepEqual(tapOf(multi).map((a) => (a.type === 'openApp' ? a.path : a.url)), ['', 'https://example.com/']);
  const inner = folder.folder.pages[0].keys.filter(Boolean)[0];
  assert.equal(tapOf(inner)[0].path, '');
});

test('a sound keeps only a sound-pack clip, as before', () => {
  const [pack, local] = sharedKeys([
    key('pack', { type: 'playSound', file: 'packs/arcade/coin.mp3', mode: 'play' }),
    key('local', { type: 'playSound', file: 'C:\\Users\\me\\Music\\coin.mp3', mode: 'play' }),
  ]);
  assert.equal(tapOf(pack)[0].file, 'packs/arcade/coin.mp3');
  assert.equal(tapOf(local)[0].file, '');
});

test('the import preview counts the keys that need finishing', () => {
  const prof = PresetShare.sanitizeDeckProfile(profileOf([
    key('ps', { type: 'openApp', path: 'E:\\Adobe\\Photoshop.exe' }),
    key('blender', { type: 'openApp', path: 'E:\\Blender\\blender.exe' }),
    key('web', { type: 'openUrl', url: 'https://www.youtube.com/' }),
    key('hook', { type: 'webhook', url: 'https://example.com/h', method: 'GET', body: '' }),
    key('vol', { type: 'volume', mode: 'up' }),
  ]), DEPS);
  assert.equal(PresetShare.keysToFinish(prof, DEPS), 3);
  assert.equal(PresetShare.keysToFinish(profileOf([key('vol', { type: 'volume', mode: 'up' })]), DEPS), 0);
});

test('needsSetup: an empty required param, never an optional extra', () => {
  const v = (a) => DeckActions.needsSetup(DeckActions.validateAction(a));
  assert.equal(v({ type: 'openApp', path: '' }), true);
  assert.equal(v({ type: 'openApp', path: 'C:\\x.exe' }), false);
  assert.equal(v({ type: 'webhook', url: 'https://example.com/', method: 'GET', body: '' }), false);
  assert.equal(v({ type: 'audioDeviceFirst', device1: 'a', device2: 'b' }), false);
  assert.equal(v({ type: 'playSound', file: '' }), true);
  assert.equal(v({ type: 'openUrl', url: '' }), false, 'not a personal param');
  assert.equal(DeckActions.needsSetup(null), false);
});

test('every personal param names a real param of its action', () => {
  for (const [type, names] of Object.entries(DeckActions.PERSONAL_PARAMS)) {
    const spec = DeckActions.actionSpec(type);
    assert.ok(spec, type + ' is in the catalog');
    for (const name of names) assert.ok(spec.params.some((p) => p.name === name), type + '.' + name);
  }
});

test('blob: icons on the second face and on cycle faces do not travel', () => {
  const [k] = sharedKeys([key('cyc', { type: 'volume', mode: 'up' }, {
    mode: 'cycle', cycle: [{ icon: { type: 'image', value: 'blob:http://127.0.0.1:3030/abc' }, label: 'B' }],
  })]);
  for (const face of k.cycle || []) assert.ok(!face.icon || !/^blob:/.test(face.icon.value));
});

test('a key waiting for setup says so when pressed, in every language', () => {
  const deck = read('js/deck.js');
  assert.match(deck, /needsSetup\(action\)\) \{\s*reportActionError\('not_set_up'\)/);
  assert.match(read('js/deck-error-text.js'), /not_set_up: \['deck_err_not_set_up'/);
  const i18n = read('js/i18n.js');
  for (const k of ['deck_err_not_set_up', 'preset_deck_finish', 'preset_deck_finish_meta']) {
    const n = (i18n.match(new RegExp('\\b' + k + ':', 'g')) || []).length;
    assert.ok(n >= 11, k + ' in 11 languages (found ' + n + ')');
  }
  const share = read('js/preset-share.js');
  assert.equal((share.match(/appendKeysToFinish\(body, (?!profiles)/g) || []).length, 2, 'deck import and package import');
});
