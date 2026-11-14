import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { appAudioTarget, appSessions, sessionTargets, createAppSessions, FRESH_MS } = require('../app-audio/sessions.js');

const F = { NAME: 0, TYPE: 1, DIR: 2, DEVICE_NAME: 3, DEFAULT: 4, STATE: 7, MUTED: 8, VOL_PCT: 10, CLI_ID: 18, PROC_PATH: 19, PROC_ID: 20, WINDOW_TITLE: 21 };

// A SoundVolumeView row: an app on a headset whose output and microphone share
// one name, as the Command-Line Friendly ID shows them.
function row({ type = 'Application', dir, itemId = '', cliId = 'Headset\\Application\\Discord', proc = 'C:\\Apps\\Discord\\Discord.exe' }) {
  const r = new Array(22).fill('');
  r[F.TYPE] = type; r[F.DIR] = dir; r[17] = itemId; r[F.CLI_ID] = cliId; r[F.PROC_PATH] = proc;
  return r;
}

const WINDOWS_ROWS = [
  row({ dir: 'Render', itemId: '{0.0.0.00000000}.{out}|Discord.exe%b1' }),
  row({ dir: 'Render', itemId: '{0.0.0.00000000}.{out}|Discord.exe%b2' }),
  row({ dir: 'Capture', itemId: '{0.0.1.00000000}.{mic}|Discord.exe%b1' }),
  row({ type: 'Device', dir: 'Render', itemId: '{0.0.0.00000000}.{out}', proc: '' }),
];

test('appAudioTarget keeps a bare process name with .exe and refuses a blank one', () => {
  assert.equal(appAudioTarget('C:\\Apps\\Discord\\Discord.exe'), 'Discord.exe');
  assert.equal(appAudioTarget('spotify'), 'spotify.exe');
  assert.equal(appAudioTarget('   '), '');
  assert.equal(appAudioTarget(''), '');
});

test('the microphone of an app is reached alone, by its Item ID', () => {
  const s = appSessions(WINDOWS_ROWS, F);
  assert.deepEqual(sessionTargets(s, 'discord', 'capture'), ['{0.0.1.00000000}.{mic}|Discord.exe%b1']);
});

test('the output of an app is every output session and no microphone', () => {
  const s = appSessions(WINDOWS_ROWS, F);
  const out = sessionTargets(s, 'Discord.exe', 'render');
  assert.equal(out.length, 2);
  assert.ok(out.every((t) => t.startsWith('{0.0.0.')));
});

test('no direction named means the app output, as a Deck key or the music tile want', () => {
  const s = appSessions(WINDOWS_ROWS, F);
  assert.deepEqual(sessionTargets(s, 'Discord', ''), sessionTargets(s, 'Discord', 'render'));
});

test('an app with no output session falls back to its name only when no direction was named', () => {
  const s = appSessions([row({ dir: 'Capture', itemId: 'mic-only', proc: 'C:\\obs64.exe' })], F);
  assert.deepEqual(sessionTargets(s, 'obs64', ''), ['obs64.exe']);
  assert.deepEqual(sessionTargets(s, 'obs64', 'render'), []);
  assert.deepEqual(sessionTargets(s, '   ', ''), []);
});

test('a Linux row has no Item ID: its node id is the target', () => {
  const s = appSessions([row({ dir: 'Capture', itemId: '', cliId: '57', proc: 'discord' }), row({ dir: 'Render', cliId: '58', proc: 'discord' })], F);
  assert.deepEqual(sessionTargets(s, 'discord', 'capture'), ['57']);
  assert.deepEqual(sessionTargets(s, 'discord', ''), ['58']);
});

test('a stale or missing list is read again before use', async () => {
  let clock = 0;
  let reads = 0;
  const sessions = createAppSessions({ F, now: () => clock, readRows: async () => { reads++; return WINDOWS_ROWS; } });
  assert.equal((await sessions.targets('discord', 'capture')).length, 1);
  assert.equal(reads, 1);
  clock = 1000;
  await sessions.targets('discord', 'render');
  assert.equal(reads, 1, 'a fresh list is reused');
  clock = 1000 + FRESH_MS + 1;
  await sessions.targets('discord', 'render');
  assert.equal(reads, 2);
});

test('a session opened since the last read is found by one more read', async () => {
  let rows = [row({ dir: 'Render', itemId: 'out' })];
  let reads = 0;
  const sessions = createAppSessions({ F, now: () => 0, readRows: async () => { reads++; return rows; } });
  sessions.remember(rows);
  rows = [...rows, row({ dir: 'Capture', itemId: 'mic' })];
  assert.deepEqual(await sessions.targets('discord', 'capture'), ['mic']);
  assert.equal(reads, 1);
});

test('the mixer sends the direction of its row, and the server reads it', () => {
  const client = fs.readFileSync(new URL('../js/volume.js', import.meta.url), 'utf8');
  assert.match(client, /closest\('#mic-apps'\) \? 'capture' : 'render'/);
  assert.match(client, /JSON\.stringify\(\{ id, level, proc, dir \}\)/);
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.match(server, /_appSessions\.remember\(allRows\)/);
  assert.match(server, /\(\{ id, level, proc, dir \} = JSON\.parse/);
  assert.match(server, /\(\{ id, muted, proc, dir \} = JSON\.parse/);
});
