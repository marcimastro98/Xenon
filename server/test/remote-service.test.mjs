import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createService } = require('../remote-control/service.js');

test('isRunning true quando Get-Service riporta Running', async () => {
  const runner = { run: async () => ({ code: 0, stdout: 'Running\r\n', stderr: '' }), runElevated: async () => ({ code: 0 }) };
  const svc = createService({ runner });
  assert.equal(await svc.isRunning(), true);
});

test('isRunning false quando lo stato non e Running', async () => {
  const runner = { run: async () => ({ code: 0, stdout: 'Stopped\r\n', stderr: '' }), runElevated: async () => ({ code: 0 }) };
  const svc = createService({ runner });
  assert.equal(await svc.isRunning(), false);
});

test('stop usa runElevated con Stop-Service del servizio', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0, stdout: '' }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner });
  assert.equal(await svc.stop(), true);
  assert.equal(seen.f, 'powershell');
  const enc = seen.a[seen.a.indexOf('-EncodedCommand') + 1];
  const decoded = Buffer.from(enc, 'base64').toString('utf16le');
  assert.ok(decoded.includes('Stop-Service'));
  assert.ok(decoded.includes('SunshineService'));
  assert.ok(decoded.includes('-Force'), 'Stop-Service usa -Force per fermare anche i dipendenti');
});

test('start usa runElevated con Start-Service SENZA -Force', async () => {
  let seen;
  const runner = { run: async () => ({ code: 0 }), runElevated: async (f, a) => { seen = { f, a }; return { code: 0 }; } };
  const svc = createService({ runner });
  assert.equal(await svc.start(), true);
  const decoded = Buffer.from(seen.a[seen.a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.ok(decoded.includes('Start-Service'));
  assert.ok(decoded.includes('SunshineService'));
  // Start-Service NON ha -Force: includerlo farebbe fallire il comando a runtime.
  assert.ok(!decoded.includes('-Force'), 'Start-Service NON deve usare -Force');
});
