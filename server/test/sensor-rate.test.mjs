import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// A widget author building a monitoring tile asked for a faster refresh. The
// answer was a user setting rather than a new default, because the cost is real
// and belongs to whoever accepts it: at 1 second the LibreHardwareMonitor reads
// underneath run five times as often, on a machine that is frequently also
// running the game being measured.
//
// These tests hold the two halves of that bargain — the setting does what it
// says, and nobody who never touches it pays anything.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

const SERVER = read('server/server.js');
const SETTINGS = read('server/js/settings.js');
const HTML = read('server/index.html');
const I18N = read('server/js/i18n.js');

const STEPS = [5000, 2000, 1000];

test('the default is the old cadence, so an untouched install is unchanged', () => {
  assert.match(SERVER, /return SENSOR_RATE_MS\.includes\(n\) \? n : 5000;/);
  assert.match(SETTINGS, /Math\.round\(Number\(value\.sensorRateMs\)\) : 5000/);
});

test('both sides clamp to the same three steps', () => {
  // Both persist the key, so both rebuild it — a save from one side must not
  // strip or widen what the other wrote.
  const server = SERVER.match(/const SENSOR_RATE_MS = Object\.freeze\(\[([^\]]+)\]\)/);
  const client = SETTINGS.match(/const SENSOR_RATE_MS = \[([^\]]+)\]/);
  assert.ok(server && client, 'both sides declare the allowed steps');
  const nums = (m) => m[1].split(',').map((x) => Number(x.trim()));
  assert.deepEqual(nums(server), STEPS);
  assert.deepEqual(nums(client), STEPS);
});

test('the caches follow the setting, not a hardcoded 5s', () => {
  // Broadcasting faster alone would only re-send readings up to five seconds
  // old: the caches ARE the expensive half, so they have to move together or
  // "1 second" is a lie told five times.
  assert.match(SERVER, /if \(age < sensorRateMs\(\)\) return cpuTempCache\.cpuTemp;/);
  assert.match(SERVER, /if \(age < sensorRateMs\(\)\) return gpuCache;/);
});

test('the tick reschedules itself so a change applies without a restart', () => {
  // A setInterval would hold whatever it was created with until the process
  // restarts, which is not what someone changing a setting expects.
  assert.ok(!/\}, 5000\)\.unref\(\);[\s\S]{0,40}Peripheral battery/.test(SERVER),
    'the system broadcast must not be a fixed interval any more');
  assert.match(SERVER, /async function _systemTick\(\)/);
  assert.match(SERVER, /setTimeout\(_systemTick, sensorRateMs\(\)\)/);
});

test('a slow read cannot stack ticks on top of each other', () => {
  // At 1 second a read that takes longer than the interval stops being
  // theoretical: the next tick is scheduled AFTER the await, never before.
  const start = SERVER.indexOf('async function _systemTick()');
  const body = SERVER.slice(start, SERVER.indexOf('\n}', start));
  assert.ok(body.indexOf('await getSystemInfo()') < body.indexOf('setTimeout(_systemTick'),
    'the next tick must be scheduled after the read, not alongside it');
});

test('the control offers exactly the three steps, and each says what it costs', () => {
  for (const ms of STEPS) {
    assert.ok(HTML.includes(`onclick="updateSensorRate(${ms})"`), `no button for ${ms}ms`);
    assert.ok(SETTINGS.includes('settings_sensorrate_note_') , 'the note key is built per step');
  }
  // The note is per-step on purpose: a single generic hint would let someone
  // pick 1 second without ever being told what it does.
  assert.match(SETTINGS, /'settings_sensorrate_note_' \+ rate/);
});

test('every string is translated in all eleven languages the app ships', () => {
  const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
  const KEYS = [
    'settings_sensorrate_title', 'settings_sensorrate_hint',
    'settings_sensorrate_5s', 'settings_sensorrate_2s', 'settings_sensorrate_1s',
    'settings_sensorrate_note_5000', 'settings_sensorrate_note_2000', 'settings_sensorrate_note_1000',
  ];
  // The nl block quotes its keys; a bare-key match would silently skip Dutch,
  // which is how a note once shipped showing Italian to Dutch users.
  const langsDefining = (key) => {
    const found = new Set();
    let current = null;
    for (const line of I18N.split('\n')) {
      const ns = line.match(/^ {2}([a-z]{2}): \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
      if (ns) current = ns[1];
      const t = line.trimStart();
      if (t.startsWith(key + ':') || t.startsWith(`"${key}":`)) found.add(current);
    }
    return found;
  };
  for (const key of KEYS) {
    const have = langsDefining(key);
    const missing = LANGS.filter((l) => !have.has(l));
    assert.equal(missing.length, 0, `${key} missing in: ${missing.join(', ')}`);
  }
});

test('the SDK guide tells widget authors not to assume the interval', () => {
  const doc = read('docs/WIDGET_SDK.md');
  assert.match(doc, /Sensor refresh rate/);
  assert.match(doc, /Never assume an interval/);
});
