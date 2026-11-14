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
import { readFileSync } from './browser-source.mjs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { appStringsSource, appStrings } from './i18n-source.mjs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const ra = require('../remote-actions.js');
const access = require('../remote-access.js');
const { ACTION_CATALOG } = require('../js/deck-actions.js');
const registry = require('../actions/registry.js');
const SERVER = engineSource();
const DECK = readFileSync(new URL('../js/deck.js', import.meta.url), 'utf8');
const MAIN = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const I18N = appStringsSource();
const SMART_HOME = readFileSync(new URL('../js/smart-home.js', import.meta.url), 'utf8');
const WIDGETS = readFileSync(new URL('../js/custom-widget.js', import.meta.url), 'utf8');
const CLAUDE_TILE = readFileSync(new URL('../js/claude-widget.js', import.meta.url), 'utf8');

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

test('Bit asked from a phone is held to what the phone can run', () => {
  assert.match(SERVER, /const phoneVerdict = remote && step\.mode && step\.mode !== 'client' \? remoteActions\.remoteMayRun\(step\.action, await readDeckStore\(\)\) : null;/, 'run_deck_action checks a paired device');
  assert.equal((SERVER.match(/surface: _aiSurface,\s+remote: isRemote,/g) || []).length, (SERVER.match(/surface: _aiSurface,/g) || []).length, 'every chat path says who asks');
  const route = SERVER.slice(SERVER.indexOf("reqPath === '/ai/deck-run'"), SERVER.indexOf("reqPath === '/ai/deck-cancel'"));
  assert.match(route, /if \(isRemote\) \{\s*const verdict = remoteActions\.remoteMayRun\(action, await readDeckStore\(\)\);/, 'the approved card is checked too');
});

test('no tool of Bit reaches the registry past the phone rules', () => {
  const start = SERVER.indexOf('async function runAiTool(');
  const body = SERVER.slice(start, SERVER.indexOf("} else if (fnName === 'run_deck_action') {", start));
  // The one call left is the gate's own: every other tool goes through runAction.
  assert.equal((body.match(/deckRegistry\.run\(/g) || []).length, 1, 'a tool calls the registry directly');
  assert.match(body, /const verdict = remote \? remoteActions\.remoteMayRun\(action, await readDeckStore\(\)\) : null;/);
  assert.ok((body.match(/await runAction\(|\? await runAction\(/g) || []).length >= 9, 'the tools lost the gate');
  assert.match(body, /if \(remote && remoteActions\.PC_ONLY_TOOLS\.has\(fnName\)\) \{\s*return \{ fnResult: phoneRefusal\('pc_only'\)/);
  assert.match(body, /remote && !remoteActions\.remoteMayLaunch\(rawTarget, /, 'open_application follows /windows/launch');
  for (const tool of ['phone_call', 'phone_message', 'run_pc_command']) assert.ok(ra.PC_ONLY_TOOLS.has(tool), tool);
  assert.equal(ra.PC_ONLY_TOOLS.has('phone_lookup'), false, 'reading the phonebook is the dashboard being the dashboard');
});

test('a phone starts no Claude run, and still answers one started at the PC', () => {
  assert.ok(access.REMOTE_DENY.has('/api/claude/run'));
  assert.equal(access.remotePathAllowed('/api/claude/run', 'POST'), false);
  for (const p of ['/api/claude/decide', '/api/claude/reply', '/api/claude/run/stop', '/api/codex/decide']) {
    assert.equal(access.remotePathAllowed(p, 'POST'), true, p);
  }
  assert.match(CLAUDE_TILE, /case 'remote_denied': return t\('claude_run_at_pc'/, 'the tile says why');
});

test('from the Smart Home tile a phone drives lights and comfort, not doors', () => {
  const may = ra.remoteMayCallHa;
  assert.equal(may('homeassistant', 'toggle', 'light.kitchen'), true, 'the tile sends every switch this way');
  assert.equal(may('light', 'turn_on', 'light.kitchen', { brightness: 120 }), true);
  assert.equal(may('climate', 'set_temperature', 'climate.home', { temperature: 21 }), true);
  assert.equal(may('media_player', 'media_play_pause', 'media_player.tv'), true);
  assert.equal(may('scene', 'turn_on', 'scene.movie'), true);

  assert.equal(may('lock', 'unlock', 'lock.front'), false);
  assert.equal(may('cover', 'open_cover', 'cover.garage'), false);
  assert.equal(may('alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.home'), false);
  assert.equal(may('script', 'turn_on', 'script.anything'), false);
  assert.equal(may('homeassistant', 'toggle', 'lock.front'), false, 'toggle maps onto unlock');
  assert.equal(may('homeassistant', 'restart', ''), false);
  assert.equal(may('homeassistant', 'restart', 'light.kitchen'), false, 'only the switch services');
  assert.equal(may('homeassistant', 'turn_on', ''), false, 'no entity, no target to judge');
  assert.equal(may('switch', 'turn_on', 'lock.front'), false);
  assert.equal(may('light', 'turn_on', 'light.kitchen', { entity_id: 'lock.front' }), false, 'a target hidden in the data');
  assert.equal(may('light', 'turn_on', '', { area_id: 'garage' }), false);

  const route = SERVER.slice(SERVER.indexOf("reqPath === '/api/homeassistant/service'"), SERVER.indexOf("reqPath === '/api/unifiprotect/state'"));
  assert.match(route, /if \(isRemote && !remoteActions\.remoteMayCallHa\(body\.domain, body\.service, body\.entityId, data\)\) \{\s*json\(\{ ok: false, error: 'needs_pc' \}\); return;/);
  assert.ok(route.indexOf('remoteMayCallHa') < route.indexOf('deckHa.callService'), 'checked before the call');
  assert.match(SMART_HOME, /out\.error === 'needs_pc'[\s\S]{0,160}smarthome_needs_pc/, 'the tile says why');
});

test('a phone can take a widget permission away, never give one', () => {
  const before = {
    enabled: true,
    grants: {
      clock: { streams: ['system'], actions: [], hosts: [] },
      door: { streams: [], actions: ['media'], hosts: [] },
    },
  };
  const widened = {
    enabled: true,
    assign: { 3: 'clock' },
    grants: {
      clock: { streams: ['system', 'media'], actions: ['haLock'], hosts: ['evil.example'] },
      fresh: { streams: [], actions: ['haLock'], hosts: ['evil.example'] },
    },
  };
  const out = ra.keepGrants(before, widened);
  assert.deepEqual(out.grants, { clock: before.grants.clock }, 'nothing new, and the kept one exactly as saved');
  assert.deepEqual(out.assign, widened.assign, 'placing a widget already approved stays open');
  assert.deepEqual(ra.keepGrants(null, widened).grants, {}, 'a PC with no grants gains none');
  assert.deepEqual(ra.keepGrants(before, { enabled: true }).grants, {}, 'a save without grants asks for none');
  assert.equal(ra.keepGrants(before, undefined), undefined, 'a save without the block is left alone');
  assert.ok(Object.hasOwn(ra.keepGrants(before, { grants: { door: {} } }).grants, 'door'));
  assert.equal(Object.hasOwn(ra.keepGrants(before, { grants: JSON.parse('{"__proto__":{"actions":["haLock"]}}') }).grants, '__proto__'), false);

  assert.match(SERVER, /incoming\.sdkWidgets = remoteActions\.keepGrants\(prev && prev\.sdkWidgets, incoming\.sdkWidgets\);/);
  assert.match(WIDGETS, /const atPc = !!window\.__xenonRemote;/);
  assert.match(WIDGETS, /\.main\.disabled = atPc \|\| /, 'Allow is not offered where it cannot work');
});

test('remote desktop, PC Control and backups are set up at the PC', () => {
  for (const p of ['/ai/pc-run', '/remote/pin', '/remote/enable', '/remote/unblock', '/remote/ondemand', '/remote/sunshine/configure', '/backup/import', '/backup/export', '/api/phone/dial', '/api/phone/send']) {
    assert.ok(access.REMOTE_DENY.has(p), p);
  }
});

test('a phone cannot sign the PC in to Tailscale, nor read the link that does', () => {
  assert.equal(access.remotePathAllowed('/remote/tailscale/login', 'POST'), false);
  assert.equal(access.remotePathAllowed('/remote/status', 'GET'), true, 'Deck keys still read the state');

  const state = { ready: false, tailscale: { connected: false, ip: '', authUrl: 'https://login.tailscale.com/a/abc' } };
  const seen = access.withoutLoginLink(state);
  assert.equal(seen.tailscale.authUrl, '');
  assert.equal(seen.ready, false);
  assert.equal(state.tailscale.authUrl, 'https://login.tailscale.com/a/abc', 'the shared status keeps it for the PC');
  assert.equal(access.withoutLoginLink(null), null);

  const server = engineSource();
  assert.match(server, /reqPath === '\/remote\/status'[\s\S]{0,200}isRemote \? remoteAccessLib\.withoutLoginLink\(state\) : state/);
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
  for (const ext of ['msc', 'chm', 'py', 'pyw', 'xll', 'application', 'appinstaller', 'msix', 'sct', 'wsc', 'settingcontent-ms', 'diagcab', 'rdp', 'iso', 'vhdx', 'theme', 'cab', 'psd1', 'wsb', 'msu', 'docm', 'xlsm', 'pptm', 'ppsm', 'sldm', 'pyzw', 'msh1xml']) {
    assert.equal(registry.isBlockedOpenPath('C:\\x\\a.' + ext, 'win32'), true, ext);
  }
  for (const ext of ['pdf', 'jpg', 'png', 'mp4', 'mp3', 'docx', 'xlsx', 'txt', 'zip']) {
    assert.equal(registry.isBlockedOpenPath('C:\\x\\a.' + ext, 'win32'), false, ext);
  }
});

test('a file from another device carries the internet mark on Windows', async () => {
  const ft = require('../file-transfer.js');
  assert.equal(ft.ZONE_IDENTIFIER, '[ZoneTransfer]\r\nZoneId=3\r\n');
  const src = engineSource('server/file-transfer.js');
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
    for (const key of ['deck_err_needs_pc', 'cw_perm_at_pc', 'smarthome_needs_pc', 'claude_run_at_pc', 'deck_err_pc_only', 'deck_needs_pc_title', 'deck_needs_pc', 'ra_paired_toast_title', 'ra_paired_toast_hint']) {
      assert.ok(appStrings()[lang][key], lang + '.' + key);
    }
  }
});
