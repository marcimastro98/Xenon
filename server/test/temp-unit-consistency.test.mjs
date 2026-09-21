import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Settings calls it "Temperature unit", not "Weather temperature unit" — and it
// only ever reached the weather. Someone running Xenon in °F read the forecast
// in °F and the CPU/GPU headers, the Guardian toasts, the thermal warnings and
// the game-session recap in °C, all on the same screen. Reported alongside a
// batch of local customisations: "I extended the selected Celsius/Fahrenheit
// preference to CPU/GPU header temperatures and ambient notifications,
// including thermal warnings and session summaries."
//
// The invariant: Celsius is the ONLY unit that exists inside Xenon — the
// collectors, the stored history, Guardian's thresholds, briefing.js's rules.
// Conversion happens once, at render, and therefore has to happen everywhere a
// temperature is rendered. So no user-facing temperature may carry a hard "°C".

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const I18N = read('js', 'i18n.js');
const SYSTEM = read('js', 'system.js');
const AMBIENT = read('js', 'ambient.js');
const MAIN = read('js', 'main.js');
const INDEX = read('index.html');
const BRIEFING = read('briefing.js');

// Every translated string that interpolates a live temperature.
const TEMP_KEYS = [
  'guardian_alert_cpu', 'guardian_alert_gpu',
  'brief_recap_cpu', 'brief_recap_gpu',
  'brief_thermal_cpu', 'brief_thermal_gpu',
  'brief_anomaly_cpu', 'brief_anomaly_gpu',
  'settings_proactive_thermal_hint',
];

// Each definition of `key`, across every language block (nl quotes its keys).
function definitions(key) {
  const re = new RegExp(`("?)${key}\\1\\s*:\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2`, 'g');
  const out = [];
  for (const m of I18N.matchAll(re)) out.push(m[3]);
  return out;
}

test('every language defines the temperature strings the same way', () => {
  for (const key of TEMP_KEYS) {
    const defs = definitions(key);
    assert.ok(defs.length > 0, `${key} is not defined in any language`);
    for (const text of defs) {
      assert.ok(!/°C/.test(text), `${key} still prints a hard °C: ${text}`);
      assert.match(text, /\{u\}/, `${key} never names the unit: ${text}`);
      // A degree sign must be followed by the unit token, never left bare.
      assert.ok(!/°(?!\{u\})/.test(text), `${key} has a ° that is not °{u}: ${text}`);
    }
  }
});

test('a string with two temperatures names the unit twice', () => {
  // `.replace()` only replaces the first occurrence, which is why fillTemps
  // splits and joins. The anomaly line quotes a reading AND its baseline, and
  // the thermal hint quotes the CPU and the GPU threshold.
  for (const key of ['brief_anomaly_cpu', 'brief_anomaly_gpu', 'settings_proactive_thermal_hint']) {
    for (const text of definitions(key)) {
      assert.equal(
        (text.match(/\{u\}/g) || []).length, 2,
        `${key} interpolates two temperatures but names the unit ${(text.match(/\{u\}/g) || []).length} time(s): ${text}`,
      );
    }
  }
});

test('no temperature is rendered with a hard °C any more', () => {
  for (const [name, src] of [['system.js', SYSTEM], ['ambient.js', AMBIENT], ['main.js', MAIN]]) {
    for (const line of src.split(/\r?\n/)) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;       // prose may still say °C
      assert.ok(!/°C/.test(line), `${name} renders a hard °C: ${line.trim()}`);
    }
  }
});

test('the hardware headers convert like the weather does', () => {
  for (const id of ['cpu-head-temp', 'gpu-head-temp']) {
    const m = new RegExp(`set\\('${id}',[^\\n]*`).exec(SYSTEM);
    assert.ok(m, `the ${id} rule is gone`);
    assert.match(m[0], /toDisplayTemp\(/, `${id} does not convert`);
    assert.match(m[0], /tempUnitSuffix\(\)/, `${id} does not label the unit`);
  }
});

test('fillTemps replaces every occurrence, not just the first', () => {
  const m = /function fillTemps\(text, values\) \{([\s\S]*?)\n\}/.exec(SYSTEM);
  assert.ok(m, 'fillTemps is gone');
  assert.ok(!/\.replace\(/.test(m[1]), 'fillTemps is back on .replace(), which stops at the first match');
  assert.match(m[1], /\.split\('\{u\}'\)\.join\(tempUnitSuffix\(\)\)/);
});

test('the RAM alert keeps its percentage out of the conversion', () => {
  // guardian_alert_mem's {v} is a percentage. Converting it would print
  // "RAM nearly full (199%)" to anyone on °F.
  const m = /const key = d\.type === 'gpu'[\s\S]{0,400}?fillTemps/.exec(MAIN);
  assert.ok(m, 'the Guardian toast no longer converts at all');
  assert.match(m[0], /d\.type === 'mem'\s*\n?\s*\?\s*t\(key\)\.replace\('\{v\}'/,
    'the RAM alert is going through the temperature conversion');
});

test('the thermal hint quotes the thresholds briefing.js actually enforces', () => {
  // The hint's numbers live in the markup, beside the rule they describe. This
  // is the pin that keeps them from drifting away from the real thresholds.
  const attr = /data-i18n="settings_proactive_thermal_hint" data-i18n-temps="([^"]+)"/.exec(INDEX);
  assert.ok(attr, 'the thermal hint lost its data-i18n-temps');
  const quoted = Object.fromEntries(attr[1].split(',').map((p) => {
    const [k, v] = p.split('=');
    return [k.trim(), Number(v)];
  }));
  for (const [token, metric] of [['c', 'cpu'], ['g', 'gpu']]) {
    const re = new RegExp(`\\{ metric: '${metric}', key: '${metric}Temp', threshold: (\\d+) \\}`);
    const m = re.exec(BRIEFING);
    assert.ok(m, `briefing.js no longer declares a ${metric} thermal threshold`);
    assert.equal(
      quoted[token], Number(m[1]),
      `the hint says ${metric} ${quoted[token]}°C but briefing.js alerts at ${m[1]}°C`,
    );
  }
});

test('the generic translation pass can fill those placeholders', () => {
  assert.match(I18N, /function parseTempTokens\(spec\)/);
  assert.match(I18N, /temps \? fillTemps\(t\(key\), parseTempTokens\(temps\)\) : t\(key\)/);
});
