// Bit picks a sensor source (sensor_source tool, server/sensor-source-ai.js):
// only from what this PC's collectors listed, of the type the reading needs,
// and "auto" goes back to Automatic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../sensor-source-ai.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const catalog = [
  { id: '/amdcpu/0/temperature/2', hw: 'AMD Ryzen 7 7800X3D', hwKind: 'cpu', type: 'temperature', name: 'Core (Tctl/Tdie)', value: 61.5, unit: '°C' },
  { id: '/amdcpu/0/power/0', hw: 'AMD Ryzen 7 7800X3D', hwKind: 'cpu', type: 'power', name: 'Package', value: 48, unit: 'W' },
  { id: '/lpc/nct6798d/0/fan/1', hw: 'Nuvoton', hwKind: 'board', type: 'fan', name: 'Fan #1', value: 900, unit: 'RPM' },
];

test('no metric reads, a metric lists the sensors of its type', () => {
  assert.deepEqual(S.plan({}), { read: true });
  assert.deepEqual(S.plan({ metric: 'cpuTemp' }), { list: 'cpuTemp' });
  assert.deepEqual(S.candidates('cpuTemp', catalog).map((c) => c.id), ['/amdcpu/0/temperature/2']);
  assert.deepEqual(S.candidates('cpuWatts', catalog)[0], { id: '/amdcpu/0/power/0', device: 'AMD Ryzen 7 7800X3D', name: 'Package', value: 48, unit: 'W' });
  assert.equal(S.plan({ metric: 'fanSpeed' }).error, 'unknown_metric');
});

test('a choice must be a listed sensor of the right type', () => {
  assert.deepEqual(S.plan({ metric: 'cpuTemp', sensor: '/amdcpu/0/temperature/2' }, catalog), { metric: 'cpuTemp', sensor: '/amdcpu/0/temperature/2' });
  assert.equal(S.plan({ metric: 'cpuTemp', sensor: '/amdcpu/0/power/0' }, catalog).error, 'unknown_sensor', 'a wattage is not a temperature');
  assert.equal(S.plan({ metric: 'cpuTemp', sensor: '/made/up' }, catalog).error, 'unknown_sensor');
  assert.equal(S.plan({ metric: 'cpuTemp', sensor: '/amdcpu/0/temperature/2' }, null).error, 'unknown_sensor');
  assert.deepEqual(S.plan({ metric: 'gpuTemp', sensor: 'Auto' }), { metric: 'gpuTemp', sensor: '' });
});

test('the saved field: a choice sets one key, Automatic removes it', () => {
  assert.deepEqual(S.nextSources({ gpuTemp: '/gpu/0/temperature/0' }, { metric: 'cpuTemp', sensor: '/amdcpu/0/temperature/2' }), { gpuTemp: '/gpu/0/temperature/0', cpuTemp: '/amdcpu/0/temperature/2' });
  assert.deepEqual(S.nextSources({ cpuTemp: '/amdcpu/0/temperature/2' }, { metric: 'cpuTemp', sensor: '' }), {});
  assert.deepEqual(S.nextSources('junk', { metric: 'cpuWatts', sensor: '' }), {});
});

test('wiring: the tool, the handler under the settings lock', () => {
  const server = read('../server.js');
  assert.ok(server.includes("{ name: 'sensor_source',"));
  assert.ok(server.includes("} else if (fnName === 'sensor_source') {\n      fnResult = await chooseSensorSource(fnArgs);"));
  assert.match(server, /async function chooseSensorSource\(args\) \{[\s\S]{0,1400}await withHubSettingsLock\(async \(\) => \{[\s\S]{0,300}sensorSources: SensorSourceAi\.nextSources\(cur\.sensorSources, plan\)/);
});
