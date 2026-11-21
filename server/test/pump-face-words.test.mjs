// The words a pump face writes (js/pump/face-kit.js): put in the page in the saved language,
// they stay through every settings refresh, which only brings new units.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from './browser-source.mjs';

const KIT = new URL('../js/pump/face-kit.js', import.meta.url);
const PAGE = new URL('../js/pump/pump-face.js', import.meta.url);

function loadKit() {
  const context = vm.createContext({ window: {}, document: {}, Intl, Number, Math, Date, Object, String, Array });
  vm.runInContext(readFileSync(KIT, 'utf8'), context);
  return context.window.PumpFaceKit;
}

test('a settings refresh keeps the page\'s words and takes its new units', () => {
  const Kit = loadKit();
  Kit.setWords({ pump_reading_cpu_temp: 'Temp. CPU' }, { lang: 'it', tempUnit: 'c' });
  assert.equal(Kit.t('pump_reading_cpu_temp', 'CPU temp'), 'Temp. CPU');
  // What pump-face.js refresh() hands over: no words, the prefs read again.
  Kit.setWords(null, { lang: 'it', tempUnit: 'f' });
  assert.equal(Kit.t('pump_reading_cpu_temp', 'CPU temp'), 'Temp. CPU', 'still Italian after a refresh');
  assert.equal(Kit.prefs().tempUnit, 'f');
  assert.equal(Kit.t('missing_key', 'fallback'), 'fallback');
});

test('before the first reading a face writes nothing; a reading this PC lacks says so', () => {
  const Kit = loadKit();
  Kit.setWords({ pump_face_no_reading: 'Nessuna lettura', pump_reading_fps: 'FPS' }, { lang: 'it' });
  const waiting = Kit.reading('fps', null);
  assert.deepEqual([waiting.text, waiting.value, waiting.label], ['', null, 'FPS'], 'the page just opened: no claim yet');
  assert.equal(Kit.reading('fps', { cpuTemp: 50 }).text, 'Nessuna lettura', 'readings came, FPS not among them');
  assert.equal(Kit.reading('cpuTemp', { cpuTemp: 50 }).text, '50');
});

test('the face page refreshes with no words, and reloads on a new language', () => {
  const src = readFileSync(PAGE, 'utf8');
  assert.ok(src.includes('Kit.setWords(null, d.prefs)'), 'the refresh this test stands for');
  assert.ok(src.includes('d.prefs.lang !== pageLang) { location.reload()'), 'a new language reloads the page and its words');
});
