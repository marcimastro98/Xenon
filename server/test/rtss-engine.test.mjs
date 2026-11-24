// server/rtss/index.js in the engine: where it exists, what it starts, and the two
// places it keeps the readings coming with no dashboard connected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { engineSource } from './engine-source.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Loads the module in a child that believes it runs on `platform`, starts and stops it.
function loadAs(platform) {
  const code = `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
const r = require('./server/rtss/index.js');
r.start();
const out = { state: r.state(), drawing: r.drawing(), supported: r.SUPPORTED };
r.stop();
process.stdout.write(JSON.stringify(out));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: ROOT, timeout: 30000, encoding: 'utf8' }));
}

test('off Windows it does not exist: no state for the menu or Settings, nothing drawn, and the engine still exits', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(loadAs(platform), { state: null, drawing: false, supported: false }, platform);
  }
});

test('on Windows the state names the download page and says nothing shows yet', () => {
  const out = loadAs('win32');
  assert.equal(out.supported, true);
  assert.equal(out.drawing, false);
  assert.equal(out.state.on, false, 'off until the person turns it on');
  assert.equal(out.state.showing, false);
  assert.match(out.state.url, /^https:\/\/www\.guru3d\.com\//);
});

test('with RivaTuner drawing, the system tick reads with no dashboard, and RivaTuner open asks for the frame reader', () => {
  const s = engineSource();
  const tick = s.slice(s.indexOf('async function _systemTick()'), s.indexOf('const t = setTimeout(_systemTick'));
  assert.match(tick, /\|\| require\('\.\/rtss\/index\.js'\)\.drawing\(\)\) \{/);
  const index = readFileSync(new URL('../rtss/index.js', import.meta.url), 'utf8');
  assert.match(index, /want: \(on\) => _fpsDemand\.overlay\(on\),/);
});

test('the last full system reading is handed out only while it is fresh', () => {
  const code = `const r = require('./server/system/latest-reading.js');
const real = Date.now;
const out = [r.latestSystemInfo(15000)];
r.rememberSystemInfo({ cpu: 1 });
out.push(r.latestSystemInfo(15000));
Date.now = () => real() + 16000;
out.push(r.latestSystemInfo(15000));
process.stdout.write(JSON.stringify(out));`;
  const out = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: ROOT, timeout: 30000, encoding: 'utf8' }));
  assert.deepEqual(out, [null, { cpu: 1 }, null], 'nothing before the first reading, nothing stale');
});
