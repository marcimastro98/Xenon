// What a paired phone or tablet may do on the PC.
//
// A security review found that one device token (a lost phone, or a token
// read off a plain-HTTP Wi-Fi link) could run any program with any arguments
// through /actions/run, launch any file through the app switcher, add such a
// key to the Deck, switch PC Control on, pair remote desktop, or import a
// backup that replaced everything. These tests pin the limits now in place.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ra = require('../remote-actions.js');
const access = require('../remote-access.js');
const { ACTION_CATALOG } = require('../js/deck-actions.js');
const registry = require('../actions/registry.js');
const SERVER = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const DECK = fs.readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const MAIN = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const I18N = fs.readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');

const OBS = { type: 'openApp', path: 'C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe' };
const STORE = {
  configs: { main: { pages: [{ keys: [
    { label: 'OBS', tap: { steps: [{ ...OBS, label: 'ignored' }] } },
    { label: 'Mute', tap: { type: 'hotkey', keys: 'ctrl+shift+m' } },
    { label: 'Mum', tap: { type: 'phoneCall', number: '+390000000' } },
  ] }] } },
  presets: [],
};

test('every action type the Deck knows is classified, and the free list holds no stray names', () => {
  const types = ACTION_CATALOG.map((a) => a.type || a.id);
  for (const t of ra.FREE) assert.ok(types.includes(t), t + ' is not a Deck action');
  for (const t of ra.PC_ONLY) assert.ok(types.includes(t), t);
  // The powerful ones must not be free.
  for (const t of ['openApp', 'openFile', 'runScript', 'typeText', 'hotkey', 'webhook', 'openUrl', 'openStoreApp',
    'launchSteamGame', 'haLock', 'haAlarm', 'haCover', 'haCallService', 'haScript', 'haButton', 'obsStream',
    'obsRecord', 'twitchChat', 'ytBroadcast', 'sbDoAction', 'sdkHandler', 'sdkMacro', 'claudeAsk', 'windowMove',
    'remoteBlock', 'usageMode', 'desktopWallpaper', 'bugReport', 'sendCapture']) {
    assert.equal(ra.FREE.has(t), false, t + ' must only run as a key the user built');
  }
});

test('a phone runs free actions and the keys the user built, nothing else', () => {
  assert.deepEqual(ra.remoteMayRun({ type: 'media', command: 'next' }, STORE), { ok: true });
  assert.deepEqual(ra.remoteMayRun({ ...OBS, label: 'whatever' }, STORE), { ok: true }, 'labels do not matter');
  assert.deepEqual(ra.remoteMayRun({ type: 'hotkey', keys: 'ctrl+shift+m' }, STORE), { ok: true });
  assert.equal(ra.remoteMayRun({ ...OBS, args: '--startstreaming' }, STORE).error, 'needs_pc', 'a changed argument is a new action');
  assert.equal(ra.remoteMayRun({ type: 'openApp', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: '-c x' }, STORE).error, 'needs_pc');
  assert.equal(ra.remoteMayRun({ type: 'typeText', text: 'rm -rf ~' }, STORE).error, 'needs_pc');
  assert.equal(ra.remoteMayRun({ type: 'hotkey', keys: 'win+r' }, STORE).error, 'needs_pc');
});

test('calls and texts placed by the PC never run from a phone, even from a key', () => {
  assert.equal(ra.remoteMayRun({ type: 'phoneCall', number: '+390000000' }, STORE).error, 'pc_only');
  assert.equal(ra.remoteMayRun({ type: 'phoneMessage', number: '+390000000', text: 'hi' }, STORE).error, 'pc_only');
});

test('the Deck cannot be used to get round it', () => {
  const added = JSON.parse(JSON.stringify(STORE));
  added.configs.main.pages[0].keys.push({ label: 'x', tap: { type: 'runScript', path: 'C:\\x.bat' } });
  assert.equal(ra.introduces(STORE, added), true, 'adding a script key from a phone is refused');
  const edited = JSON.parse(JSON.stringify(STORE));
  edited.configs.main.pages[0].keys[0].tap.steps[0].args = '-evil';
  assert.equal(ra.introduces(STORE, edited), true, 'so is changing what an app key runs');
  const moved = JSON.parse(JSON.stringify(STORE));
  moved.configs.main.pages[0].keys.reverse();
  moved.configs.main.pages[0].keys[0].label = 'Renamed';
  assert.equal(ra.introduces(STORE, moved), false, 'rearranging and renaming still work');
  const removed = JSON.parse(JSON.stringify(STORE));
  removed.configs.main.pages[0].keys.splice(0, 1);
  assert.equal(ra.introduces(STORE, removed), false, 'deleting a key still works');
  const free = JSON.parse(JSON.stringify(STORE));
  free.configs.main.pages[0].keys.push({ label: 'Next', tap: { type: 'media', command: 'next' } });
  assert.equal(ra.introduces(STORE, free), false, 'adding a media key still works');
});

test('the app switcher on a phone starts only a favourite or a Deck app', () => {
  const favs = [{ app: 'Spotify', path: 'C:\\Users\\me\\AppData\\Roaming\\Spotify\\Spotify.exe' }];
  assert.equal(ra.remoteMayLaunch('c:\\users\\me\\appdata\\roaming\\spotify\\spotify.exe', favs, STORE), true);
  assert.equal(ra.remoteMayLaunch(OBS.path, favs, STORE), true);
  assert.equal(ra.remoteMayLaunch('C:\\Users\\me\\Downloads\\holiday.exe', favs, STORE), false, 'a file just sent from the phone');
});

test('the server applies all of it on the paired-device door', () => {
  const run = SERVER.indexOf("reqPath === '/actions/run' && req.method === 'POST'");
  const runBody = SERVER.slice(run, SERVER.indexOf('deckRegistry.run(action)', run));
  assert.match(runBody, /if \(isRemote\) \{\s*const verdict = remoteActions\.remoteMayRun\(action, await readDeckStore\(\)\);/);
  const launch = SERVER.slice(SERVER.indexOf("reqPath === '/windows/launch'"), SERVER.indexOf("reqPath === '/volume/set'"));
  assert.match(launch, /isRemote && !remoteActions\.remoteMayLaunch\(/);
  const deck = SERVER.slice(SERVER.indexOf("reqPath === '/deck-config' && req.method === 'POST'"), SERVER.indexOf("reqPath === '/events' && req.method === 'GET'"));
  assert.equal((deck.match(/isRemote && remoteActions\.introduces\(current, applied\.store\)/g) || []).length, 2, 'both the ops and the legacy save');
  assert.match(SERVER, /if \(isRemote\) \{\s*const was = !!\(prev && prev\.aiFeatures && prev\.aiFeatures\.pcControl === true\);/, 'a phone cannot switch PC Control on');
});

test('remote desktop, PC Control and backups are set up at the PC', () => {
  for (const p of ['/ai/pc-run', '/remote/pin', '/remote/enable', '/remote/unblock', '/remote/ondemand', '/remote/sunshine/configure', '/backup/import', '/backup/export', '/api/phone/dial', '/api/phone/send']) {
    assert.ok(access.REMOTE_DENY.has(p), p);
  }
});

test('a device left unused for 90 days stops working', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-ra-idle-'));
  let clock = 1_000_000;
  const api = access.createRemoteAccess({ dir, now: () => clock });
  await api.load();
  const { code } = api.startPairing();
  const r = await api.redeem(code, { name: 'Pixel' });
  assert.ok(api.authenticate(r.token));
  clock += access.IDLE_EXPIRY_MS - 1000;
  assert.ok(api.authenticate(r.token), 'still fine just before');
  clock += 2000;
  assert.equal(api.authenticate(r.token), null, 'and refused after');
});

test('dangerous file types are not opened, documents and media are', () => {
  for (const ext of ['msc', 'chm', 'py', 'pyw', 'xll', 'application', 'appinstaller', 'msix', 'sct', 'wsc', 'settingcontent-ms', 'diagcab', 'rdp', 'iso', 'vhdx', 'theme', 'cab', 'psd1']) {
    assert.equal(registry.isBlockedOpenPath('C:\\x\\a.' + ext, 'win32'), true, ext);
  }
  for (const ext of ['pdf', 'jpg', 'png', 'mp4', 'mp3', 'docx', 'xlsx', 'txt', 'zip']) {
    assert.equal(registry.isBlockedOpenPath('C:\\x\\a.' + ext, 'win32'), false, ext);
  }
});

test('a file from another device carries the internet mark on Windows', async () => {
  const ft = require('../file-transfer.js');
  assert.equal(ft.ZONE_IDENTIFIER, '[ZoneTransfer]\r\nZoneId=3\r\n');
  const src = fs.readFileSync(new URL('../file-transfer.js', import.meta.url), 'utf8');
  assert.equal((src.match(/await markFromInternet\(dest, o\.platform\);/g) || []).length, 2, 'both delivery paths');
  // Off Windows it writes nothing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-motw-'));
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'x');
  await ft.markFromInternet(f, 'linux');
  assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
});

test('the phone explains a refusal and the PC sees every new pairing, in every language', () => {
  assert.match(DECK, /data\.ok === false && data\.error === 'needs_pc'/);
  assert.match(DECK, /hydrateDeckFromServer\(\);\s*return;/, 'the Deck goes back to what is saved');
  assert.match(SERVER, /broadcastSSE\('remote_paired', \{ name: r\.device\.name \}\)/);
  assert.match(MAIN, /es\.addEventListener\('remote_paired'/);
  const text = require('../js/deck-error-text.js');
  assert.ok(text);
  for (const lang of ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh']) {
    for (const key of ['deck_err_needs_pc', 'deck_err_pc_only', 'deck_needs_pc_title', 'deck_needs_pc', 'ra_paired_toast_title', 'ra_paired_toast_hint']) {
      const re = new RegExp(`Object\\.assign\\(i18n\\.${lang}, \\{[^}]*\\b${key}:`);
      assert.match(I18N, re, `${lang}.${key}`);
    }
  }
});
