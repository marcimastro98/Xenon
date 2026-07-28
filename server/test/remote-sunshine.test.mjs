import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createSunshine } = require('../remote-control/sunshine.js');

function fakeFetch(handler) {
  return (url, opts) => Promise.resolve(handler(url, opts));
}
function jsonRes(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(obj), text: () => Promise.resolve(JSON.stringify(obj)) };
}

test('configureElevated lancia powershell elevato con --creds e Restart-Service via -EncodedCommand', async () => {
  let seen;
  const runner = {
    run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    runElevated: (file, args) => { seen = { file, args }; return Promise.resolve({ code: 0 }); },
  };
  const s = createSunshine({ runner, exe: 'C:/Sunshine/sunshine.exe', platform: 'win32' });
  const ok = await s.configureElevated('xenonedge', 'secretpass');
  assert.equal(ok, true);
  assert.equal(seen.file, 'powershell');
  const idx = seen.args.indexOf('-EncodedCommand');
  assert.ok(idx >= 0, 'deve usare -EncodedCommand');
  const decoded = Buffer.from(seen.args[idx + 1], 'base64').toString('utf16le');
  assert.ok(decoded.includes('--creds'), 'deve impostare le credenziali');
  assert.ok(decoded.includes('xenonedge'), 'deve includere lo username');
  assert.ok(decoded.includes('secretpass'), 'deve includere la password');
  assert.ok(decoded.includes('Restart-Service'), 'deve riavviare il servizio');
  assert.ok(decoded.includes('SunshineService'), 'deve riavviare SunshineService');
});

test('configureElevated ritorna false se il lancio elevato fallisce (UAC rifiutato)', async () => {
  const runner = {
    run: () => Promise.resolve({ code: 0 }),
    runElevated: () => Promise.resolve({ code: 1 }),
  };
  const s = createSunshine({ runner, platform: 'win32' });
  assert.equal(await s.configureElevated('a', 'b'), false);
});

test('sendPin POSTa il pin con basic auth', async () => {
  let seen;
  const fetchImpl = fakeFetch((url, opts) => { seen = { url, opts }; return jsonRes({ status: true }); });
  const s = createSunshine({ fetchImpl, credentials: { user: 'admin', pass: 'secret' } });
  const r = await s.sendPin('1234');
  assert.equal(r.ok, true);
  assert.ok(seen.url.includes('/api/pin'));
  assert.equal(seen.opts.method, 'POST');
  assert.ok(seen.opts.headers.Authorization.startsWith('Basic '));
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.pin, '1234');
  assert.ok(body.name, 'il body deve includere il campo name richiesto da Sunshine');
});

test('sendPin riporta lo status HTTP reale su rifiuto (es. 401)', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({}, 401));
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const r = await s.sendPin('1234');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
});

test('listClients ritorna array dei client', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({ named_certs: [{ name: 'phone' }] }));
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const list = await s.listClients();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'phone');
});

test('listClients ritorna [] se la risposta non e ok', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({}, 401));
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  assert.deepEqual(await s.listClients(), []);
});

test('isResponding false su errore di rete', async () => {
  const fetchImpl = () => Promise.reject(new Error('ECONNREFUSED'));
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  assert.equal(await s.isResponding(), false);
});

test('authHeaders senza credenziali lancia su chiamate API', async () => {
  const s = createSunshine({ credentials: null });
  await assert.rejects(() => s.sendPin('1'));
});

test('closeSession POSTa /api/apps/close', async () => {
  let seen;
  const fetchImpl = fakeFetch((url, opts) => { seen = { url, opts }; return jsonRes({ status: true }); });
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const ok = await s.closeSession();
  assert.equal(ok, true);
  assert.ok(seen.url.includes('/api/apps/close'));
  assert.equal(seen.opts.method, 'POST');
});

test('setScreen POSTa /api/config con output_name', async () => {
  let seen;
  const fetchImpl = fakeFetch((url, opts) => { seen = { url, opts }; return jsonRes({ status: true }); });
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const ok = await s.setScreen('DISPLAY-XYZ');
  assert.equal(ok, true);
  assert.ok(seen.url.includes('/api/config'));
  assert.equal(seen.opts.method, 'POST');
  assert.equal(JSON.parse(seen.opts.body).output_name, 'DISPLAY-XYZ');
});

test('setScreen fonde output_name preservando la config esistente (read-modify-write)', async () => {
  const calls = [];
  const fetchImpl = (url, opts) => {
    calls.push({ url, method: opts.method, body: opts.body });
    if (opts.method === 'POST') return Promise.resolve(jsonRes({ status: true }));
    return Promise.resolve(jsonRes({ bitrate: 20000, resolution: '1080p' })); // GET /config
  };
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const ok = await s.setScreen('\\\\.\\DISPLAY6');
  assert.equal(ok, true);
  const post = calls.find((c) => c.method === 'POST');
  const body = JSON.parse(post.body);
  assert.equal(body.output_name, '\\\\.\\DISPLAY6');
  assert.equal(body.bitrate, 20000, 'deve preservare i campi esistenti');
  assert.equal(body.resolution, '1080p');
});

test('getConfig ritorna il JSON di /api/config', async () => {
  const fetchImpl = fakeFetch(() => jsonRes({ output_name: 'D1' }));
  const s = createSunshine({ fetchImpl, credentials: { user: 'a', pass: 'b' } });
  const cfg = await s.getConfig();
  assert.equal(cfg.output_name, 'D1');
});

// ── Off Windows, configuring Sunshine needs no password ──────────────────────
// That is the substantive difference, not a detail. On Windows Sunshine is a
// system service whose config lives under Program Files, so `--creds` must run
// elevated or it exits 0 without persisting. On Linux and macOS Sunshine is the
// USER's: config under ~/.config, unit under `systemctl --user`. Asking for a
// password there would be theatre.

test('linux: --creds NON e\' elevato, e riavvia l\'unita\' utente', async () => {
  const calls = [];
  const runner = {
    run: (file, args) => { calls.push({ file, args }); return Promise.resolve({ code: 0, stdout: '' }); },
    runElevated: (file, args) => { calls.push({ file, args, elevated: true }); return Promise.resolve({ code: 0 }); },
  };
  const s = createSunshine({ runner, platform: 'linux', exists: (p) => p === '/usr/bin/sunshine' });

  assert.equal(await s.configureElevated('xenonedge', 'segreto'), true);
  assert.equal(calls.filter((c) => c.elevated).length, 0, 'no password for the user\'s own service');

  const creds = calls.find((c) => c.args.includes('--creds'));
  assert.equal(creds.file, '/usr/bin/sunshine');
  assert.deepEqual(creds.args, ['--creds', 'xenonedge', 'segreto']);

  // Credentials are read at startup: without the restart the API keeps
  // rejecting them and the wizard reports a failure that is not one.
  const restart = calls.find((c) => c.file === 'systemctl');
  assert.deepEqual(restart.args, ['--user', 'restart', 'sunshine']);
});

test('linux: il build Flathub non sta su PATH, quindi passa da flatpak', async () => {
  const calls = [];
  const runner = {
    run: (file, args) => {
      calls.push({ file, args });
      // `flatpak info` succeeding is how the app is found when no binary is.
      return Promise.resolve({ code: 0, stdout: '' });
    },
    runElevated: async () => ({ code: 0 }),
  };
  const s = createSunshine({ runner, platform: 'linux', exists: () => false });

  const l = await s.launcher();
  assert.equal(l.file, 'flatpak');
  assert.ok(l.args.includes('dev.lizardbyte.app.Sunshine'));

  await s.configureElevated('u', 'p');
  const creds = calls.find((c) => c.args.includes('--creds'));
  assert.equal(creds.file, 'flatpak', 'the CLI is reached through flatpak, not spawned directly');
});

test('linux: senza Sunshine da nessuna parte non spawna --creds', async () => {
  const calls = [];
  const runner = {
    run: (file, args) => {
      calls.push({ file, args });
      return Promise.resolve({ code: 1, stdout: '', stderr: 'not installed' });
    },
    runElevated: async () => ({ code: 0 }),
  };
  const s = createSunshine({ runner, platform: 'linux', exists: () => false });

  assert.equal(await s.configureElevated('u', 'p'), false);
  assert.equal(calls.filter((c) => c.args.includes('--creds')).length, 0);
});

test('darwin: riavvia via brew services, non systemctl', async () => {
  const calls = [];
  const runner = {
    run: (file, args) => { calls.push({ file, args }); return Promise.resolve({ code: 0, stdout: '' }); },
    runElevated: async () => ({ code: 0 }),
  };
  const s = createSunshine({ runner, platform: 'darwin', exists: (p) => p === '/opt/homebrew/bin/sunshine' });

  assert.equal(await s.configureElevated('u', 'p'), true);
  assert.ok(!calls.some((c) => c.file === 'systemctl'), 'there is no systemd on a Mac');
  const restart = calls.find((c) => c.file === 'brew');
  assert.deepEqual(restart.args, ['services', 'restart', 'sunshine']);
});
