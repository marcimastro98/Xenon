import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInstaller } = require('../remote-control/installer.js');

function fakeRunner(map) {
  return {
    calls: [],
    run(file, args) {
      this.calls.push({ file, args });
      const key = args.join(' ');
      for (const k of Object.keys(map)) {
        if (key.includes(k)) return Promise.resolve(map[k]);
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
    },
    runElevated(file, args) {
      this.calls.push({ file, args, elevated: true });
      return Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false });
    },
  };
}

test('isInstalled true quando winget list trova il pacchetto', async () => {
  const runner = fakeRunner({
    'list -e --id LizardByte.Sunshine': { code: 0, stdout: 'LizardByte.Sunshine 0.23.1', stderr: '' },
  });
  const inst = createInstaller({ runner });
  assert.equal(await inst.isInstalled('sunshine'), true);
});

test('isInstalled false quando winget esce con codice non-zero', async () => {
  const runner = fakeRunner({
    'list -e --id Tailscale.Tailscale': { code: 1, stdout: 'No installed package found', stderr: '' },
  });
  const inst = createInstaller({ runner });
  assert.equal(await inst.isInstalled('tailscale'), false);
});

test('install usa elevazione e i flag silent corretti', async () => {
  const runner = fakeRunner({});
  const inst = createInstaller({ runner });
  await inst.install('sunshine');
  const call = runner.calls.find((c) => c.elevated);
  assert.ok(call, 'deve usare runElevated');
  const a = call.args.join(' ');
  assert.ok(a.includes('install'));
  assert.ok(a.includes('-e'));
  assert.ok(a.includes('LizardByte.Sunshine'));
  assert.ok(a.includes('--silent'));
  assert.ok(a.includes('--accept-package-agreements'));
  assert.ok(a.includes('--accept-source-agreements'));
});

test('id sconosciuto rigetta', async () => {
  const inst = createInstaller({ runner: fakeRunner({}) });
  await assert.rejects(() => inst.install('boom'));
});
