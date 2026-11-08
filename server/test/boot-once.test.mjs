import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const server =readFileSync(new URL('../server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// The whole body of the listen callback, up to the point where it closes.
function listenBody() {
  const start = server.indexOf('function _startListen(host) {');
  const end = server.indexOf("server.on('error', err => {", start);
  assert.ok(start > 0 && end > start);
  return server.slice(start, end);
}

test('the start-up runs once per process, not once per listener', () => {
  const body = listenBody();
  const logged = body.indexOf("startupLog.write('listening on http://'");
  const guard = body.indexOf('if (_bootStarted) return;');
  const mark = body.indexOf('_bootStarted = true;');
  const firstJob = body.indexOf('ensureHelperUpToDate');
  assert.ok(logged > 0 && logged < guard, 'every listener still says where it is');
  assert.ok(guard < mark && mark < firstJob, 'nothing one-time may sit above the guard');
  assert.match(server, /let _bootStarted = false;/);
});

test('moving the listener goes through _startListen, so the guard is what stops a second start', () => {
  assert.match(server, /function applyBindHost\(\) \{[\s\S]{0,500}_startListen\(want\)/);
});

test('the slow readings start at listen, without waiting for a page', () => {
  const body = listenBody();
  assert.ok(body.indexOf('getSystemInfo().catch(() => {});') > body.indexOf('_bootStarted = true;'));
});

test('the microphone is looked for after the start, once', () => {
  const body = listenBody();
  assert.doesNotMatch(body, /_initSttDevice\(\)/);
  assert.match(body, /setTimeout\(_startSttDevice, STT_DEVICE_DELAY_MS\)\.unref\(\);/);
  assert.match(server, /function _startSttDevice\(\) \{\n\s+if \(_sttDeviceStarted\) return;\n\s+_sttDeviceStarted = true;\n\s+_initSttDevice\(\);\n\}/);
});

test('whoever wants voice before the delay starts the look', () => {
  assert.match(server, /function _sttDeviceWhenReady\(\) \{\n\s+_startSttDevice\(\);/);
  assert.match(server, /getInputArgs: \(\) => \{\n\s+if \(_sttDeviceReady\) return _sttInputArgs\(\);\n\s+_startSttDevice\(\);\n\s+return null;/);
});

test('a change of default mic still looks again', () => {
  assert.match(server, /function _maybeRebindSttDevice\(\) \{[\s\S]{0,700}await _initSttDevice\(\);/);
});

test('scheduled tasks that only matter at the next sign-in wait for the start to settle', () => {
  const body = listenBody();
  assert.match(body, /setTimeout\(tidyLeftoverTasks, LEFTOVER_TASKS_DELAY_MS\)\.unref\(\);/);
  assert.doesNotMatch(body.slice(body.indexOf('_bootStarted = true;')), /schtasks|reconcileBrowserAutoOpenTask\(\)/);
  assert.match(server, /function tidyLeftoverTasks\(\) \{[\s\S]{0,600}reconcileBrowserAutoOpenTask\(\)[\s\S]{0,500}'XenonEdge OpenRGB'/);
});

test('a shortcut another app holds is looked at less and less often', () => {
  assert.match(server, /const pause = Math\.min\(HOTKEY_RETRY_MS \* \(2 \*\* _hotkey\.failures\), HOTKEY_RETRY_MAX_MS\);/);
  assert.match(server, /Math\.max\(1000, ms \|\| pause\)/);
  assert.match(server, /_hotkey\.diedAt = Date\.now\(\);\n\s+_hotkey\.failures\+\+;\n\s+\/\/ 'taken' means another app owns the combo/);
  assert.match(server, /if \(ev\.event === 'ready'\) \{\n\s+_hotkey\.state = 'listening';\n\s+_hotkey\.failures = 0;/);
  assert.match(server, /if \(changed\) _hotkey\.failures = 0;/, 'a new shortcut starts from the short pause');
});

test('through a game the background steps back when Game Mode or a Performance session asks for it', () => {
  assert.match(server, /function backgroundHeld\(\) \{\n\s+const wanted = _serverHubSettings\?\.gameMode !== false \|\| _serverHubSettings\?\.performance\?\.active === true;\n\s+return wanted && gameDetect\.isGameRunning\(\);/);
  assert.match(server, /MEDIA_BLIND_STREAK\) return out;\n(?:\s*\/\/[^\n]*\n)*\s+if \(backgroundHeld\(\)\) return out;/);
  assert.match(server, /if \(!audioPollWanted\(\)\) return;\n\s+if \(backgroundHeld\(\) && Date\.now\(\) - _audioPolledAt < AUDIO_POLL_GAME_MS\) return;\n\s+_audioPolledAt = Date\.now\(\);/);
});

test('through a game notifications are read less often, unless a call could ring', () => {
  assert.match(server, /function syncBackgroundHold\(\) \{[\s\S]{0,300}winNotif\.setPace\(on && !_serverHubSettings\?\.calls\?\.enabled\);/);
});

test('through a game the list of busy apps follows more slowly', () => {
  assert.match(server, /if \(_processesBusy\) return;\n\s+if \(backgroundHeld\(\) && Date\.now\(\) - _processesPolledAt < PROCESSES_POLL_GAME_MS\) return;\n\s+_processesPolledAt = Date\.now\(\);\n\s+_processesBusy = true;/);
  assert.match(server, /const PROCESSES_POLL_GAME_MS = 6000;/);
  const doc = readFileSync(new URL('../../docs/WIDGET_SDK.md', import.meta.url), 'utf8');
  assert.match(doc, /One payload every 2 seconds, every 6 while a game runs:/, 'the SDK says what a widget will get');
});

test('readings of the network are shared by whoever asks within the window, and the System tile still gets new ones', () => {
  const fresh = Number(/const NETWORK_FRESH_MS = (\d+);/.exec(server)[1]);
  assert.ok(fresh < 3000, 'the tile polls every 3 s and must not be handed its own last reading');
  assert.match(server, /async function getNetworkInfo\(\) \{\n\s+if \(_netLast && Date\.now\(\) - _netLast\.at < NETWORK_FRESH_MS\) return _netLast\.reading;/);
  assert.match(server, /\.then\(\(reading\) => \{ _netLast = \{ at: Date\.now\(\), reading \}; return reading; \}\)\n\s+\.finally\(\(\) => \{ _netPending = null; \}\);/);
  const tile = readFileSync(new URL('../js/network.js', import.meta.url), 'utf8');
  assert.match(tile, /setInterval\(fetchNetwork, 3000\)/);
});

test('the sensor worker keeps a small young generation, in hex, on its own process only', () => {
  assert.match(server, /const PWSH_WORKER_GC_BUDGET = '1000000';/);
  assert.match(server, /'-File', PWSH_WORKER_SCRIPT\],\n\s+\{ windowsHide: true, env: \{ \.\.\.process\.env, COMPlus_GCgen0MaxBudget: PWSH_WORKER_GC_BUDGET \} \}\);/);
  assert.equal(server.split('COMPlus_GCgen0MaxBudget').length - 1, 1, 'never for the whole server, its children would inherit it');
});

test('through a game batteries are read every five minutes, before a device would count as gone', async () => {
  assert.match(server, /if \(backgroundHeld\(\) && Date\.now\(\) - _batteryPolledAt < BATTERY_POLL_GAME_MS\) return;\n\s+try \{\n\s+if \(!\(await batteryWanted\(\)\)\) return;\n\s+_batteryPolledAt = Date\.now\(\);\n\s+const payload = await batteryMonitor\.getDevices\(\);/);
  const pause = Number(/const BATTERY_POLL_GAME_MS = (\d+) \* 60 \* 1000;/.exec(server)[1]) * 60 * 1000;
  const { STALE_MS } = createRequire(import.meta.url)('../battery.js');
  assert.ok(pause < STALE_MS, 'a slower read would drop Bluetooth devices from the widget');
});
