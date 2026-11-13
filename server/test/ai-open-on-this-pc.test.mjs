// Bit's "open this" on every system (server/ai/open-on-this-pc.js). It used to start
// PowerShell wherever it ran, so on macOS and Linux nothing ever opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openOnThisPc, byName } = require('../ai/open-on-this-pc.js');

// A stand-in for execFile that notes what it was asked to start.
function recorder(fail = false) {
  const calls = [];
  const run = (file, argv, _options, done) => { calls.push([file, argv]); done(fail ? new Error('exit 1') : null); };
  return { calls, run };
}

test('on Windows the target goes to ShellExecute through PowerShell, quotes escaped', async () => {
  const { calls, run } = recorder();
  assert.deepEqual(await openOnThisPc({ target: "it's", kind: 'name' }, { platform: 'win32', run }), { ok: true });
  assert.equal(calls[0][0], 'powershell.exe');
  assert.deepEqual(calls[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(calls[0][1][3], /FileName='it''s';UseShellExecute=\$true/);
});

test('off Windows a website or an app link goes to the system opener, and PowerShell is never started', async () => {
  for (const platform of ['darwin', 'linux']) {
    for (const kind of ['url', 'protocol']) {
      const { calls, run } = recorder();
      const opened = [];
      const out = await openOnThisPc({ target: 'https://example.com/', kind }, { platform, run, open: async (target) => { opened.push(target); } });
      assert.deepEqual(out, { ok: true });
      assert.deepEqual(opened, ['https://example.com/']);
      assert.deepEqual(calls, []);
    }
  }
});

test('an app by name: open -a on macOS, the desktop entry on Linux', async () => {
  const mac = recorder();
  assert.deepEqual(await openOnThisPc({ target: 'Visual Studio Code', kind: 'name' }, { platform: 'darwin', run: mac.run }), { ok: true });
  assert.deepEqual(mac.calls, [['/usr/bin/open', ['-a', 'Visual Studio Code']]]);
  const linux = recorder();
  assert.deepEqual(await openOnThisPc({ target: 'Firefox', kind: 'name' }, { platform: 'linux', run: linux.run }), { ok: true });
  assert.deepEqual(linux.calls, [['gtk-launch', ['firefox']]]);
  assert.equal(byName('notepad', 'win32'), null);
});

test('a failed start is an answer, not a throw, and a Windows path off Windows says so', async () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { run } = recorder(true);
    assert.deepEqual(await openOnThisPc({ target: 'nothing', kind: 'name' }, { platform, run }), { ok: false, error: 'not_found' });
  }
  const { calls, run } = recorder();
  assert.deepEqual(await openOnThisPc({ target: 'C:\notes.txt', kind: 'path' }, { platform: 'linux', run }), { ok: false, error: 'not_on_this_system' });
  assert.deepEqual(calls, []);
  const failing = async () => { throw new Error('no handler'); };
  assert.deepEqual(await openOnThisPc({ target: 'slack://', kind: 'protocol' }, { platform: 'darwin', run, open: failing }), { ok: false, error: 'not_found' });
});
