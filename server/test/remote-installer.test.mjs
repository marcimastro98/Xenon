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

// ── Off Windows the offer is the same, the tool is not ───────────────────────
// pkexec IS what UAC is: a graphical prompt owned by the desktop. So Linux and
// macOS install too, and the tests below pin WHICH command runs — the whole
// risk of this path is a dashboard quietly running the wrong thing as root.
//
// `which` is `sh -c command -v X`, so a binary "exists" for these fakes only
// when the map says so. Nothing is assumed from the machine running the suite.
function posixRunner(present = [], extra = {}) {
  const map = {};
  for (const bin of present) {
    map[`command -v ${bin} `] = { code: 0, stdout: `/usr/bin/${bin}\n`, stderr: '' };
  }
  return fakeRunner({ ...map, ...extra });
}

test('linux: una sola elevazione installa il pacchetto E avvia il demone', async () => {
  const runner = posixRunner(['pkexec', 'dnf']);
  const inst = createInstaller({ runner, platform: 'linux' });

  const r = await inst.install('tailscale');
  assert.equal(r.code, 0);

  const elevated = runner.calls.filter((c) => c.elevated);
  assert.equal(elevated.length, 1, 'one prompt, not two — a second would be a chore');
  assert.equal(elevated[0].file, 'sh');
  const cmd = elevated[0].args[1];
  assert.ok(cmd.includes('dnf install -y tailscale'), cmd);
  // Without this the package is there, nothing listens, and the panel reports
  // `not_running` right after a successful install.
  assert.ok(cmd.includes('systemctl enable --now tailscaled'), cmd);
});

test('linux: senza pkexec non eleva nulla e chiede di farlo a mano', async () => {
  const runner = posixRunner(['dnf']);
  const inst = createInstaller({ runner, platform: 'linux' });

  assert.equal(await inst.canInstall('tailscale'), false);
  const r = await inst.install('tailscale');
  assert.equal(r.reason, 'manual_install_required');
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0, 'nothing ran as root');
});

test('linux: senza package manager riconosciuto non inventa un comando', async () => {
  const runner = posixRunner(['pkexec']);
  const inst = createInstaller({ runner, platform: 'linux' });

  assert.equal(await inst.canInstall('tailscale'), false);
  assert.equal((await inst.install('tailscale')).reason, 'manual_install_required');
});

test('linux: per Sunshine preferisce flatpak, che non chiede la password', async () => {
  const runner = posixRunner(['pkexec', 'dnf', 'flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'fedora\nflathub\n', stderr: '' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });

  const r = await inst.install('sunshine');
  assert.equal(r.code, 0);
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0,
    'the whole point of the flatpak route: no elevation at all');
  const fp = runner.calls.find((c) => c.file === 'flatpak' && c.args[0] === 'install');
  assert.ok(fp, 'flatpak install was used');
  assert.ok(fp.args.includes('dev.lizardbyte.app.Sunshine'));
});

test('linux: se flatpak fallisce ripiega sul pacchetto della distro', async () => {
  // A filtered Flathub can list an app in search and still refuse to install
  // it. Giving up there would strand the user on a remote they did not choose.
  const runner = posixRunner(['pkexec', 'dnf', 'flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'flathub\n', stderr: '' },
    'install -y --noninteractive': { code: 1, stdout: '', stderr: 'ref not found' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });

  await inst.install('sunshine');
  const elevated = runner.calls.filter((c) => c.elevated);
  assert.equal(elevated.length, 1);
  assert.ok(elevated[0].args[1].includes('dnf install -y sunshine'), elevated[0].args[1]);
});

test('linux: flatpak senza remote flathub non viene nemmeno tentato', async () => {
  const runner = posixRunner(['pkexec', 'dnf', 'flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'fedora\n', stderr: '' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });

  await inst.install('sunshine');
  assert.equal(runner.calls.filter((c) => c.file === 'flatpak' && c.args[0] === 'install').length, 0,
    'no install against a remote that is not configured');
});

test('darwin: `brew install` non e\' elevato, il demone si', async () => {
  const runner = posixRunner(['brew']);
  const inst = createInstaller({ runner, platform: 'darwin' });

  assert.equal(await inst.canInstall('tailscale'), true);
  const r = await inst.install('tailscale');
  assert.equal(r.code, 0);

  // brew refuses to run under sudo and owns its own prefix, so the install
  // itself must NOT be elevated...
  const install = runner.calls.find((c) => c.file === 'brew' && c.args[0] === 'install');
  assert.ok(install && install.args.includes('tailscale'));
  assert.ok(!install.elevated, 'brew install under sudo is rejected by brew itself');

  // ...but a LaunchDaemon is written outside that prefix, so exactly one step is.
  const elevated = runner.calls.filter((c) => c.elevated);
  assert.equal(elevated.length, 1);
  assert.deepEqual(elevated[0].args, ['services', 'start', 'tailscale']);
});

test('darwin: Sunshine non e\' in homebrew-core, quindi il tap viene prima', async () => {
  // Checked against Homebrew's API rather than remembered: there is no
  // `sunshine` formula in core (404), it lives in LizardByte's tap. Without the
  // tap, `brew install sunshine` fails with "No available formula".
  const runner = posixRunner(['brew']);
  const inst = createInstaller({ runner, platform: 'darwin' });

  await inst.install('sunshine');
  const brewCalls = runner.calls.filter((c) => c.file === 'brew');
  assert.equal(brewCalls[0].args[0], 'tap', 'tapped first');
  assert.equal(brewCalls[0].args[1], 'LizardByte/homebrew');
  assert.ok(brewCalls.some((c) => c.args[0] === 'install' && c.args.includes('sunshine')));
  // Sunshine has no daemon of ours to start.
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0);
});

test('darwin: se brew install fallisce non prova ad avviare il demone', async () => {
  const runner = posixRunner(['brew'], {
    'install tailscale': { code: 1, stdout: '', stderr: 'Error: formula not found' },
  });
  const inst = createInstaller({ runner, platform: 'darwin' });

  const r = await inst.install('tailscale');
  assert.equal(r.code, 1);
  assert.equal(runner.calls.filter((c) => c.elevated).length, 0,
    'no admin dialog for a package that is not there');
});

test('darwin: senza Homebrew non installa un package manager di nascosto', async () => {
  const runner = posixRunner([]);
  const inst = createInstaller({ runner, platform: 'darwin' });

  assert.equal(await inst.canInstall('tailscale'), false);
  assert.equal((await inst.install('tailscale')).reason, 'manual_install_required');
});

test('posix: isInstalled guarda il binario su PATH, non il package manager', async () => {
  // What matters is what the rest of Xenon can actually call. Asking dnf would
  // report "not installed" for something the user compiled or dropped in ~/bin.
  const yes = createInstaller({ runner: posixRunner(['tailscale']), platform: 'linux' });
  assert.equal(await yes.isInstalled('tailscale'), true);

  const no = createInstaller({ runner: posixRunner([]), platform: 'linux' });
  assert.equal(await no.isInstalled('tailscale'), false);
});

test('posix: un flatpak non sta su PATH, quindi lo chiede a flatpak', async () => {
  const runner = posixRunner(['flatpak'], {
    'info dev.lizardbyte.app.Sunshine': { code: 0, stdout: 'Sunshine', stderr: '' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });
  assert.equal(await inst.isInstalled('sunshine'), true);
});

test('su Windows canInstall segue winget', async () => {
  assert.equal(await winInstaller({ runner: fakeRunner({}) }).canInstall(), true);
  const noWinget = fakeRunner({ '--version': { code: 1, stdout: '', stderr: 'not found' } });
  assert.equal(await winInstaller({ runner: noWinget }).canInstall(), false);
});

// ── Chromium: the one package that must NOT come from Flathub ────────────────
// Measured, not assumed. The Flathub Chromium launches and even prints
// "DevTools listening on ws://127.0.0.1:PORT" — but the sandbox remaps the
// filesystem, so `--user-data-dir` lands somewhere the host cannot see and
// DevToolsActivePort never appears at the path embedded-browser.js reads. The
// ad-blocker fails the same way: it passes --load-extension pointing into
// DATA_DIR. This widget hands Chromium paths OUTSIDE any sandbox, so a
// sandboxed Chromium cannot serve it — even though installing one succeeds and
// makes `available()` answer true, which is exactly the trap.

test('linux: Chromium viene dal pacchetto della distro, non da Flathub', async () => {
  const runner = posixRunner(['pkexec', 'dnf', 'flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'flathub\n' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });

  await inst.install('chromium');
  assert.equal(runner.calls.filter((c) => c.file === 'flatpak' && c.args[0] === 'install').length, 0,
    'a sandboxed Chromium cannot see the profile dir this widget gives it');
  const elevated = runner.calls.filter((c) => c.elevated);
  assert.equal(elevated.length, 1);
  assert.ok(elevated[0].args[1].includes('dnf install -y chromium'), elevated[0].args[1]);
});

test('linux: senza package manager, Chromium non ripiega sul flatpak', async () => {
  // The fallback would "work" and leave the user with a browser that cannot
  // drive the widget — worse than saying so.
  const runner = posixRunner(['flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'flathub\n' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });

  assert.equal(await inst.canInstall('chromium'), false);
  assert.equal((await inst.install('chromium')).reason, 'manual_install_required');
  assert.equal(runner.calls.filter((c) => c.file === 'flatpak' && c.args[0] === 'install').length, 0);
});

test('linux: Sunshine invece il flatpak lo usa eccome', async () => {
  // Guards the exception from spreading: preferNative is about one package.
  const runner = posixRunner(['pkexec', 'dnf', 'flatpak'], {
    'remotes --columns=name': { code: 0, stdout: 'flathub\n' },
  });
  const inst = createInstaller({ runner, platform: 'linux' });
  await inst.install('sunshine');
  assert.ok(runner.calls.some((c) => c.file === 'flatpak' && c.args[0] === 'install'));
});

test('darwin: Chromium e\' un cask, non una formula', async () => {
  const runner = posixRunner(['brew']);
  const inst = createInstaller({ runner, platform: 'darwin' });
  await inst.install('chromium');
  const call = runner.calls.find((c) => c.file === 'brew' && c.args[0] === 'install');
  assert.ok(call.args.includes('--cask'), 'without this it installs nothing into /Applications');
  assert.ok(call.args.includes('chromium'));
});
