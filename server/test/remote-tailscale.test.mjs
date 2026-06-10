import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createTailscale } = require('../remote-control/tailscale.js');

function runnerWith(statusJson, { upCode = 0 } = {}) {
  return {
    run(file, args) {
      const key = args.join(' ');
      if (key.includes('status')) {
        return Promise.resolve({ code: 0, stdout: JSON.stringify(statusJson), stderr: '' });
      }
      if (key.includes('up')) {
        return Promise.resolve({ code: upCode, stdout: '', stderr: '' });
      }
      if (key.startsWith('ip')) {
        return Promise.resolve({ code: 0, stdout: '100.64.0.5\n', stderr: '' });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
  };
}

test('getStatus riporta connesso e IP quando BackendState=Running', async () => {
  const ts = createTailscale({ runner: runnerWith({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.5'] } }) });
  const s = await ts.getStatus();
  assert.equal(s.installed, true);
  assert.equal(s.connected, true);
  assert.equal(s.ip, '100.64.0.5');
});

test('getStatus connected=false quando BackendState=NeedsLogin', async () => {
  const ts = createTailscale({ runner: runnerWith({ BackendState: 'NeedsLogin', Self: {} }) });
  const s = await ts.getStatus();
  assert.equal(s.connected, false);
});

test('getStatus installed=false quando il comando non esiste', async () => {
  const ts = createTailscale({ runner: { run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'not found' }) } });
  const s = await ts.getStatus();
  assert.equal(s.installed, false);
});

test('getStatus non esplode su JSON malformato', async () => {
  const ts = createTailscale({ runner: { run: () => Promise.resolve({ code: 0, stdout: 'not json', stderr: '' }) } });
  const s = await ts.getStatus();
  assert.equal(s.installed, true);
  assert.equal(s.connected, false);
  assert.equal(s.ip, '');
});
