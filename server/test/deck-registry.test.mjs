import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const reg = require('../actions/registry.js');

test('isHttpUrl / isAllowedAppPath', () => {
  assert.equal(reg.isHttpUrl('https://x.com'), true);
  assert.equal(reg.isHttpUrl('ftp://x'), false);
  assert.equal(reg.isHttpUrl('javascript:alert(1)'), false);
  assert.equal(reg.isAllowedAppPath('C:/a/b.exe'), true);
  assert.equal(reg.isAllowedAppPath('C:/a/b.LNK'), true);
  assert.equal(reg.isAllowedAppPath('C:/a/b.bat'), false);
});

test('run rejects unknown actions', async () => {
  const r = reg.createRegistry({});
  assert.deepEqual(await r.run({ type: 'bogus' }), { ok: false, error: 'unknown_action' });
  assert.deepEqual(await r.run(null), { ok: false, error: 'unknown_action' });
});

test('run openApp enforces extension + existence', async () => {
  const calls = [];
  const deps = { fileExists: () => true, openExternal: (p) => { calls.push(p); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openApp', path: 'C:/x/y.txt' }), { ok: false, error: 'bad_app_path' });
  const okDeps = { fileExists: () => false, openExternal: () => Promise.resolve() };
  assert.deepEqual(await reg.createRegistry(okDeps).run({ type: 'openApp', path: 'C:/x/y.exe' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openApp', path: 'C:/x/y.exe' }), { ok: true });
  assert.deepEqual(calls, ['C:/x/y.exe']);
});

test('run openApp resolves a folder target to an executable via resolveAppDir', async () => {
  const calls = [];
  // A folder path (no .exe/.lnk) is resolved to the exe inside it.
  const deps = {
    fileExists: () => true,
    openExternal: (p) => { calls.push(p); return Promise.resolve(); },
    resolveAppDir: (p) => (p === 'C:/Users/me/AppData/Local/Discord' ? 'C:/Users/me/AppData/Local/Discord/app-1.0.0/Discord.exe' : ''),
  };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openApp', path: 'C:/Users/me/AppData/Local/Discord' }), { ok: true });
  assert.deepEqual(calls, ['C:/Users/me/AppData/Local/Discord/app-1.0.0/Discord.exe']);
  // A folder the resolver can't map → still bad_app_path (no silent success).
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openApp', path: 'C:/some/empty/dir' }), { ok: false, error: 'bad_app_path' });
  // Without a resolver dep, a non-exe path is rejected as before.
  const noResolver = { fileExists: () => true, openExternal: () => Promise.resolve() };
  assert.deepEqual(await reg.createRegistry(noResolver).run({ type: 'openApp', path: 'C:/x/folder' }), { ok: false, error: 'bad_app_path' });
});

test('run openFile blocks executables/scripts, requires existence, opens documents', async () => {
  const calls = [];
  const existsDeps = { fileExists: () => true, openExternal: (p) => { calls.push(p); return Promise.resolve(); } };
  // Executable/script extensions are rejected before existence is even checked.
  for (const bad of ['C:/x/run.bat', 'C:/x/run.ps1', 'C:/x/run.vbs', 'C:/x/run.cmd', 'C:/x/run.exe']) {
    assert.deepEqual(await reg.createRegistry(existsDeps).run({ type: 'openFile', path: bad }), { ok: false, error: 'blocked_ext' });
  }
  // A safe path that does not exist → not_found.
  const missingDeps = { fileExists: () => false, openExternal: () => Promise.resolve() };
  assert.deepEqual(await reg.createRegistry(missingDeps).run({ type: 'openFile', path: 'C:/x/notes.txt' }), { ok: false, error: 'not_found' });
  // A safe, existing document (or a folder, which has no extension) opens.
  assert.deepEqual(await reg.createRegistry(existsDeps).run({ type: 'openFile', path: 'C:/x/notes.txt' }), { ok: true });
  assert.deepEqual(await reg.createRegistry(existsDeps).run({ type: 'openFile', path: 'C:/Users/me/Documents' }), { ok: true });
  assert.deepEqual(calls, ['C:/x/notes.txt', 'C:/Users/me/Documents']);
});

test('run returns {ok:false} when an injected effect throws (never propagates)', async () => {
  const deps = { fileExists: () => true, openExternal: () => Promise.reject(new Error('boom')) };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openApp', path: 'C:/x/y.exe' }), { ok: false, error: 'boom' });
});

test('run openUrl enforces http(s) and calls openExternal', async () => {
  const calls = [];
  const deps = { openExternal: (u) => { calls.push(u); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openUrl', url: 'file:///etc' }), { ok: false, error: 'bad_url' });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openUrl', url: 'https://ok.com' }), { ok: true });
  assert.deepEqual(calls, ['https://ok.com']);
});

test('normalizeUrl defaults a bare domain to https and rejects non-http schemes', () => {
  assert.equal(reg.normalizeUrl('www.google.com'), 'https://www.google.com');
  assert.equal(reg.normalizeUrl('https://x.com'), 'https://x.com');
  assert.equal(reg.normalizeUrl('http://x.com'), 'http://x.com');
  assert.equal(reg.normalizeUrl('javascript:alert(1)'), '');
  assert.equal(reg.normalizeUrl('file:///etc'), '');
  assert.equal(reg.normalizeUrl(''), '');
});

test('run openUrl opens a bare domain via https', async () => {
  const calls = [];
  const deps = { openExternal: (u) => { calls.push(u); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openUrl', url: 'www.google.com' }), { ok: true });
  assert.deepEqual(calls, ['https://www.google.com']);
});

test('run media/micMute/volume delegate to deps', async () => {
  const log = [];
  const deps = {
    mediaAction: (c) => { log.push('media:' + c); return Promise.resolve(); },
    micMute: (m) => { log.push('mic:' + m); return Promise.resolve({ muted: true }); },
    volume: (m) => { log.push('vol:' + m); return Promise.resolve(); },
  };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'media', cmd: 'next' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'micMute', mode: 'toggle' }), { ok: true, muted: true });
  assert.deepEqual(await r.run({ type: 'volume', mode: 'up' }), { ok: true });
  assert.deepEqual(log, ['media:next', 'mic:toggle', 'vol:up']);
});

test('run obs actions map + delegate to deps.obs', async () => {
  const calls = [];
  const deps = { obs: (rt, rd) => { calls.push([rt, rd]); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'obsScene', scene: 'Game' }), { ok: true });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'obsRecord', mode: 'toggle' }), { ok: true });
  assert.deepEqual(calls, [['SetCurrentProgramScene', { sceneName: 'Game' }], ['ToggleRecord', {}]]);
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'obsScene', scene: 'Game' }), { ok: false, error: 'obs_unavailable' });
});

test('run obsSceneNext delegates to deps.obsNext', async () => {
  let called = 0;
  const r = reg.createRegistry({ obsNext: () => { called++; return Promise.resolve(); } });
  assert.deepEqual(await r.run({ type: 'obsSceneNext' }), { ok: true });
  assert.equal(called, 1);
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'obsSceneNext' }), { ok: false, error: 'obs_unavailable' });
});

test('run sbDoAction maps to a DoAction request + delegates to deps.streamerbot', async () => {
  const calls = [];
  const deps = { streamerbot: (r) => { calls.push(r); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbDoAction', action: 'guid-1' }), { ok: true });
  assert.deepEqual(calls, [{ request: 'DoAction', action: { id: 'guid-1' } }]);
  // Empty action id is rejected before any side-effect.
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbDoAction', action: '' }), { ok: false, error: 'bad_sb_action' });
  // No dep configured → clean unavailable, never a throw.
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'sbDoAction', action: 'guid-1' }), { ok: false, error: 'streamerbot_unavailable' });
});

test('run lighting delegates the validated action to deps.lighting', async () => {
  const calls = [];
  const deps = { lighting: (a) => { calls.push(a); return Promise.resolve(true); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'lighting', mode: 'set', color: '#ff0000', style: 'breathing' }), { ok: true });
  assert.deepEqual(calls, [{ type: 'lighting', mode: 'set', color: '#ff0000', style: 'breathing' }]);
  // restore form
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'lighting', mode: 'restore' }), { ok: true });
  // not wired → clean failure
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'lighting', mode: 'set', color: '#fff' }), { ok: false, error: 'lighting_unavailable' });
});

test('run never executes the ai action server-side (it is client-only)', async () => {
  // Whether or not Plan A has added `ai` to the catalog, the server must refuse it:
  // 'unsupported' if it's a known-but-unhandled type, 'unknown_action' if absent.
  const r = await reg.createRegistry({}).run({ type: 'ai', mode: 'open' });
  assert.equal(r.ok, false);
});

test('isAppUserModelId accepts PackageFamilyName!AppId and rejects unsafe values', () => {
  assert.equal(reg.isAppUserModelId('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify'), true);
  assert.equal(reg.isAppUserModelId('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'), true);
  assert.equal(reg.isAppUserModelId('no-bang-here'), false);
  assert.equal(reg.isAppUserModelId('a!b!c'), false);
  assert.equal(reg.isAppUserModelId('bad space!App'), false);
  assert.equal(reg.isAppUserModelId('x"; calc !App'), false);
});

test('run openStoreApp validates the AUMID and launches via deps.openStoreApp', async () => {
  const calls = [];
  const deps = { openStoreApp: (id) => { calls.push(id); return Promise.resolve(); } };
  // A malformed AUMID is rejected before any launch.
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openStoreApp', appId: 'not a valid id' }), { ok: false, error: 'bad_app_id' });
  // Valid AUMID but no dep wired → clean failure.
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'openStoreApp', appId: 'A.B_hash!App' }), { ok: false, error: 'unavailable' });
  // Valid AUMID + dep → launched with the exact id.
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'openStoreApp', appId: 'A.B_hash!App' }), { ok: true });
  assert.deepEqual(calls, ['A.B_hash!App']);
});
