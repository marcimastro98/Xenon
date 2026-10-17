// Settings → Performance → "Sensor sources" and the SDK `sensors` stream:
// which hardware sensor feeds each headline reading (js/sensor-sources.js),
// the catalog the collectors enumerate, and where server.js applies the choice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const S = require('../js/sensor-sources.js');
const linux = require('../linux-collectors.js');
const { remotePathAllowed } = require('../remote-access.js');

test('a choice keeps only known metrics and ids that cannot be a path or an argument split', () => {
  assert.deepEqual(S.normalizeSensorSources(null), {});
  assert.deepEqual(S.normalizeSensorSources([]), {});
  const out = S.normalizeSensorSources({
    cpuTemp: '/amdcpu/0/temperature/2',
    gpuTemp: 'hwmon/amdgpu@0000:03:00.0/temp2',
    cpuWatts: 'a|b',
    gpuWatts: 'x'.repeat(161),
    ramTemp: '/ram/0/temperature/0',
    __proto__: { cpuTemp: 'polluted' },
  });
  assert.deepEqual(out, { cpuTemp: '/amdcpu/0/temperature/2', gpuTemp: 'hwmon/amdgpu@0000:03:00.0/temp2' });
  for (const bad of ['', ' ', 'C:\\Windows', '/a b', 'a;rm', 'a`b', 'a$b', 42, null]) {
    assert.equal(S.isSensorId(bad), false, String(bad));
  }
});

test('the catalog is rebuilt explicitly: typed, de-duplicated, bounded', () => {
  const out = S.normalizeSensorCatalog([
    { id: '/amdcpu/0/temperature/2', hw: ' AMD Ryzen 9 ', hwKind: 'cpu', type: 'temperature', name: 'Core (Tctl/Tdie)', value: 54.125 },
    { id: '/amdcpu/0/temperature/2', hw: 'dup', hwKind: 'cpu', type: 'temperature', name: 'dup', value: 1 },
    { id: '/x/0/voltage/0', type: 'voltage', name: 'Vcore', value: 1.2 },
    { id: 'bad id', type: 'fan', value: 900 },
    { id: '/lpc/nct/0/fan/1', hwKind: 'spaceship', type: 'fan', name: '', value: '' },
    null,
  ]);
  assert.deepEqual(out, [
    { id: '/amdcpu/0/temperature/2', hw: 'AMD Ryzen 9', hwKind: 'cpu', type: 'temperature', name: 'Core (Tctl/Tdie)', value: 54.1, unit: '°C' },
    { id: '/lpc/nct/0/fan/1', hw: '', hwKind: 'other', type: 'fan', name: '/lpc/nct/0/fan/1', value: null, unit: 'RPM' },
  ]);
  const many = Array.from({ length: 500 }, (_, i) => ({ id: '/s/' + i, type: 'load', value: i }));
  assert.equal(S.normalizeSensorCatalog(many).length, S.SENSOR_CATALOG_MAX);
});

test('the chosen sensors go over the automatic readings, and say where they came from', () => {
  const info = () => ({ cpuTemp: 61.5, gpuTemp: 48, power: { cpu: 80, gpu: 200, psu: null, total: 280 } });
  const readings = [
    { id: '/gpu-nvidia/0/temperature/2', hw: 'RTX 4080', hwKind: 'gpu', type: 'temperature', name: 'GPU Hot Spot', value: 58.6 },
    { id: '/amdcpu/0/power/0', hw: 'Ryzen', hwKind: 'cpu', type: 'power', name: 'Package', value: 72.25 },
  ];
  const out = S.applySensorSources(info(), { gpuTemp: '/gpu-nvidia/0/temperature/2', cpuWatts: '/amdcpu/0/power/0' }, readings, { cpuTemp: 'Core (Tctl/Tdie)' });
  assert.equal(out.gpuTemp, 59);
  assert.equal(out.power.cpu, 72.3);
  assert.equal(out.power.total, 272.3);
  assert.equal(out.cpuTemp, 61.5);
  assert.deepEqual(out.sensorSources.cpuTemp, { auto: true, name: 'Core (Tctl/Tdie)' });
  assert.deepEqual(out.sensorSources.gpuTemp, { auto: false, id: '/gpu-nvidia/0/temperature/2', name: 'GPU Hot Spot', hw: 'RTX 4080' });

  // Nothing chosen: the payload is untouched apart from saying "automatic".
  const plain = S.applySensorSources(info(), {}, [], {});
  assert.equal(plain.gpuTemp, 48);
  assert.equal(plain.power.total, 280);
  assert.deepEqual(plain.sensorSources.gpuWatts, { auto: true, name: '' });
});

test('a sensor that is gone falls back to automatic, flagged only when the answer is known', () => {
  const info = () => ({ cpuTemp: 61.5, gpuTemp: 48, power: { cpu: 80, gpu: 200 } });
  const gone = S.applySensorSources(info(), { gpuTemp: '/gpu-amd/0/temperature/0' }, [], {});
  assert.equal(gone.gpuTemp, 48);
  assert.equal(gone.sensorSources.gpuTemp.missing, true);
  // No answer (worker restarting, LHM not open yet) is not "the card is gone".
  const unknown = S.applySensorSources(info(), { gpuTemp: '/gpu-amd/0/temperature/0' }, null, {});
  assert.equal(unknown.gpuTemp, 48);
  assert.equal(unknown.sensorSources.gpuTemp.missing, undefined);
  // A fan picked for a temperature is not that temperature.
  const wrongType = S.applySensorSources(info(), { cpuTemp: '/lpc/0/fan/1' }, [{ id: '/lpc/0/fan/1', type: 'fan', value: 900 }], {});
  assert.equal(wrongType.cpuTemp, 61.5);
  assert.equal(wrongType.sensorSources.cpuTemp.missing, true);
  // A reading that is no temperature (unelevated LHM reads 0) shows nothing, not 0 °C.
  const zero = S.applySensorSources(info(), { cpuTemp: '/amdcpu/0/temperature/2' }, [{ id: '/amdcpu/0/temperature/2', type: 'temperature', value: 0 }], {});
  assert.equal(zero.cpuTemp, null);
});

test('Linux: hwmon readings in catalog units, with ids that survive a reboot', () => {
  assert.deepEqual(linux.parseHwmonReading('k10temp', '0000:00:18.3', 'temp1_input', '54125', 'Tctl'),
    { id: 'hwmon/k10temp@0000:00:18.3/temp1', hw: 'k10temp', hwKind: 'cpu', type: 'temperature', name: 'Tctl', value: 54.1 });
  assert.equal(linux.parseHwmonReading('amdgpu', '0000:03:00.0', 'power1_average', '45500000', 'PPT').value, 45.5);
  assert.equal(linux.parseHwmonReading('amdgpu', '0000:03:00.0', 'freq1_input', '2450000000', 'sclk').value, 2450);
  assert.equal(linux.parseHwmonReading('nct6798', 'nct6775.656', 'fan2_input', '1180', '').name, 'fan2');
  assert.equal(linux.parseHwmonReading('nvme', 'nvme0', 'temp1_input', '', 'Composite').value, null);
  assert.equal(linux.parseHwmonReading('x', 'y', 'temp1_average', '1', ''), null);
  assert.equal(linux.parseHwmonReading('x', 'y', 'in0_input', '1', ''), null);
  assert.equal(linux.hwmonDevKey('/sys/devices/pci0000:00/0000:00:18.3'), '0000:00:18.3');
  assert.equal(linux.hwmonDevKey(''), 'virtual');
  assert.equal(linux.hwmonDevKey('/sys/devices/a b$c'), 'a_b_c');
  assert.equal(linux.hwmonKind('nzxt-kraken3'), 'cooler');
  assert.equal(linux.hwmonKind('nct6798'), 'board');
  assert.equal(linux.hwmonKind('something'), 'other');
  for (const e of [linux.parseHwmonReading('k10temp', linux.hwmonDevKey('/x/0000:00:18.3'), 'temp3_input', '1', '')]) {
    assert.ok(S.isSensorId(e.id), e.id);
  }
});

test('Windows: sensors.ps1 is worker-only and opens no LHM session of its own', () => {
  const ps = read('server/sensors.ps1').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(ps, /Computer\]::new|\.Open\(\)|Add-Type|Get-Counter/i);
  assert.match(ps, /\$global:XenonCpuLhm/);
  assert.match(ps, /\$global:XenonGpuLhm/);
  const allowLine = read('server/pwsh-worker.ps1').split('\n').find((l) => l.startsWith('$allow'));
  assert.ok(allowLine.includes("'sensors.ps1'"));
  const server = read('server/server.js');
  assert.match(server, /runPowerShellWorker\(SENSORS_SCRIPT/);
  assert.doesNotMatch(server, /runCollector\(SENSORS_SCRIPT/);
});

test('the server applies the choice in getSystemInfo and persists it on both sides', () => {
  const server = read('server/server.js');
  const sys = server.slice(server.indexOf('async function getSystemInfo()'));
  assert.match(sys.slice(0, sys.indexOf('\n}\n') > 0 ? sys.indexOf('\n}\n') : 9000), /SensorSources\.applySensorSources\(info, sources, readings/);
  assert.match(server, /sensorSources: SensorSources\.normalizeSensorSources\(source\.sensorSources\)/);
  assert.match(read('server/js/settings.js'), /sensorSources: window\.SensorSources \? window\.SensorSources\.normalizeSensorSources\(value\.sensorSources\) : \{\}/);
  const html = read('server/index.html');
  const pos = (src) => html.indexOf('<script src="' + src + '"></script>');
  assert.ok(pos('js/sensor-sources.js') > 0 && pos('js/sensor-sources.js') < pos('js/settings.js'));
  assert.ok(pos('js/sensor-sources-settings.js') > pos('js/settings.js'));
});

test('the catalog endpoint reads only and a paired device may use it', () => {
  const server = read('server/server.js');
  const at = server.indexOf("reqPath === '/system/sensors'");
  assert.ok(at > 0);
  const route = server.slice(at, server.indexOf('} else if', at));
  assert.match(route, /req\.method === 'GET'/);
  assert.doesNotMatch(route, /e\.message/);
  assert.equal(remotePathAllowed('/system/sensors', 'GET'), true);
});

test('the `sensors` stream exists everywhere a stream is declared, and runs only when granted', () => {
  const sdk = require('../sdk-widgets.js');
  assert.ok(sdk.SDK_STREAMS.includes('sensors'));
  assert.match(read('server/js/settings.js'), /'processes', 'sensors', 'spotify'/);
  const cw = read('server/js/custom-widget.js');
  assert.match(cw, /sensors: \['cw_stream_sensors'/);
  assert.match(cw, /streams: \['status', 'system', 'sensors'/);
  assert.match(read('server/js/main.js'), /onData\('sensors'/);
  const server = read('server/server.js');
  const tick = server.slice(server.indexOf('const SENSORS_STREAM_POLL_MS'), server.indexOf('}, SENSORS_STREAM_POLL_MS).unref();'));
  assert.match(tick, /sseClients\.size === 0 \|\| _sensorsStreamBusy \|\| !sdkStreamGranted\('sensors'\)/);
  assert.match(tick, /finally \{\s*_sensorsStreamBusy = false;/);
});
