import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createInstaller } = require('../remote-control/installer.js');

// winget is Windows', and off Windows this installer deliberately does nothing
// (see installer.js). Every test below is about the winget path, so it says so
// rather than inheriting the answer from whichever machine runs the suite —
// otherwise the whole file fails on a Mac or Linux checkout and blames the code.
const winInstaller = (over = {}) => createInstaller({ platform: 'win32', ...over });

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
  const inst = winInstaller({ runner });
  assert.equal(await inst.isInstalled('sunshine'), true);
});

test('isInstalled false quando winget esce con codice non-zero', async () => {
  const runner = fakeRunner({
    'list -e --id Tailscale.Tailscale': { code: 1, stdout: 'No installed package found', stderr: '' },
  });
  const inst = winInstaller({ runner });
  assert.equal(await inst.isInstalled('tailscale'), false);
});

test('install usa elevazione e i flag silent corretti', async () => {
  const runner = fakeRunner({});
  const inst = winInstaller({ runner });
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

// ── Off Windows this installer installs nothing, on purpose ──────────────────
// There is no winget, and driving Homebrew or apt under sudo from a dashboard
// toggle is not something Xenon should do behind the user's back. Callers ask
// `canInstall()` and explain the one manual step instead.
for (const platform of ['linux', 'darwin']) {
  test(`su ${platform} non installa e non spawna nulla`, async () => {
    const runner = fakeRunner({});
    const inst = createInstaller({ runner, platform });

    assert.equal(await inst.canInstall(), false);
    assert.equal(await inst.isWingetAvailable(), false);
    assert.equal(await inst.isInstalled('tailscale'), false);

    const r = await inst.install('tailscale');
    assert.notEqual(r.code, 0, 'it reports a non-success');
    assert.equal(r.reason, 'manual_install_required');
    assert.equal(runner.calls.length, 0, 'winget was never invoked, elevated or otherwise');
  });
}

test('su Windows canInstall segue winget', async () => {
  assert.equal(await winInstaller({ runner: fakeRunner({}) }).canInstall(), true);
  const noWinget = fakeRunner({ '--version': { code: 1, stdout: '', stderr: 'not found' } });
  assert.equal(await winInstaller({ runner: noWinget }).canInstall(), false);
});
