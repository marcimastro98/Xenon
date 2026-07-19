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
  for (const bad of ['C:/x/run.bat', 'C:/x/run.ps1', 'C:/x/run.vbs', 'C:/x/run.cmd', 'C:/x/run.exe',
    'C:/x/app.appref-ms', 'C:/x/launch.jnlp', 'C:/x/go.url', 'C:/x/x.scf', 'C:/x/q.search-ms']) {
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

test('run runScript accepts .bat/.cmd/.ps1, rejects other extensions + missing files', async () => {
  const calls = [];
  const okDeps = { fileExists: () => true, runScript: (p, hidden) => { calls.push([p, !!hidden]); return Promise.resolve(); } };
  // A real, existing script runs through the dedicated runScript dep (window
  // defaults to visible → hidden=false).
  for (const good of ['C:/Scripts/test.bat', 'C:/Scripts/test.cmd', 'C:/Scripts/deploy.ps1', 'C:/Scripts/tool.py']) {
    assert.deepEqual(await reg.createRegistry(okDeps).run({ type: 'runScript', path: good }), { ok: true });
  }
  assert.deepEqual(calls, [['C:/Scripts/test.bat', false], ['C:/Scripts/test.cmd', false], ['C:/Scripts/deploy.ps1', false], ['C:/Scripts/tool.py', false]]);
  // window: 'hidden' is passed through to the dep.
  const hidCalls = [];
  await reg.createRegistry({ fileExists: () => true, runScript: (_p, h) => { hidCalls.push(!!h); return Promise.resolve(); } })
    .run({ type: 'runScript', path: 'C:/x/s.bat', window: 'hidden' });
  assert.deepEqual(hidCalls, [true]);
  // Non-script extensions are rejected before existence is checked (.exe is an
  // app → openApp, not runScript).
  for (const bad of ['C:/x/notes.txt', 'C:/x/app.exe', 'C:/x/lib.psm1', 'C:/x/doc.docx']) {
    assert.deepEqual(await reg.createRegistry(okDeps).run({ type: 'runScript', path: bad }), { ok: false, error: 'bad_script_ext' });
  }
  // A script that doesn't exist → not_found.
  const missingDeps = { fileExists: () => false, runScript: () => Promise.resolve() };
  assert.deepEqual(await reg.createRegistry(missingDeps).run({ type: 'runScript', path: 'C:/x/gone.bat' }), { ok: false, error: 'not_found' });
  // Empty path → empty_path.
  assert.deepEqual(await reg.createRegistry(okDeps).run({ type: 'runScript', path: '   ' }), { ok: false, error: 'empty_path' });
  // No runScript dep wired → unavailable (never a silent success).
  assert.deepEqual(await reg.createRegistry({ fileExists: () => true }).run({ type: 'runScript', path: 'C:/x/y.bat' }), { ok: false, error: 'unavailable' });
});

test('isRunnableScriptPath', () => {
  assert.equal(reg.isRunnableScriptPath('C:/a/b.bat'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.CMD'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.ps1'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.py'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.js'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.rb'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.jar'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.vbs'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.sh'), true);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.psm1'), false);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.exe'), false);
  assert.equal(reg.isRunnableScriptPath('C:/a/b.txt'), false);
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

test('run sbSendMessage / sbCodeTrigger route through deps.streamerbot with the right request', async () => {
  const calls = [];
  const deps = { streamerbot: (r) => { calls.push(r); return Promise.resolve(); } };
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbSendMessage', platform: 'twitch', message: 'hi' }), { ok: true });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbCodeTrigger', trigger: 'My Trigger' }), { ok: true });
  assert.deepEqual(calls, [
    { request: 'SendMessage', platform: 'twitch', message: 'hi', bot: true, internal: false },
    { request: 'ExecuteCodeTrigger', triggerName: 'My Trigger' },
  ]);
  // Invalid params are rejected at the boundary, before any side-effect. (An unknown
  // platform can't reach here — it's a select, coerced to a valid option on validate —
  // so an empty message is the reachable rejection for SendMessage.)
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbSendMessage', platform: 'twitch', message: '' }), { ok: false, error: 'bad_sb_action' });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'sbCodeTrigger', trigger: '' }), { ok: false, error: 'bad_sb_action' });
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

test('isSteamAppId accepts digit-only ids and rejects anything else', () => {
  assert.equal(reg.isSteamAppId('1086940'), true);
  assert.equal(reg.isSteamAppId('730'), true);
  assert.equal(reg.isSteamAppId(' 400 '), true);              // trimmed
  assert.equal(reg.isSteamAppId(''), false);
  assert.equal(reg.isSteamAppId('12a'), false);
  assert.equal(reg.isSteamAppId('123456789012345'), false);  // over 12 digits
  assert.equal(reg.isSteamAppId('-1'), false);
  assert.equal(reg.isSteamAppId('1; calc'), false);
});

test('run launchSteamGame validates the AppID and launches via the steam:// deep link', async () => {
  const calls = [];
  const deps = { openExternal: (u) => { calls.push(u); return Promise.resolve(); } };
  // A non-numeric AppID is rejected before any launch (no injection reaches openExternal).
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'launchSteamGame', gameId: 'x"; calc' }), { ok: false, error: 'bad_app_id' });
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'launchSteamGame', gameId: '' }), { ok: false, error: 'bad_app_id' });
  // A valid AppID builds the canonical rungameid URL.
  assert.deepEqual(await reg.createRegistry(deps).run({ type: 'launchSteamGame', gameId: '1086940' }), { ok: true });
  assert.deepEqual(calls, ['steam://rungameid/1086940']);
});

test('run sdkMacro: resolves steps via deps, runs them in order, skips nested macros', async () => {
  const calls = [];
  const deps = {
    mediaAction: (cmd) => { calls.push('media:' + cmd); return Promise.resolve(); },
    volume: (mode) => { calls.push('volume:' + mode); return Promise.resolve(); },
    sdkMacro: async (pkg, id) => (pkg === 'demo' && id === 'quiet' ? [
      { action: { type: 'volume', mode: 'mute' }, delayMs: 0 },
      { action: { type: 'sdkMacro', macro: 'demo/quiet' }, delayMs: 0 },   // must be skipped
      { action: { type: 'media', cmd: 'playpause' }, delayMs: 0 },
    ] : null),
  };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'sdkMacro', macro: 'demo/quiet' }), { ok: true });
  assert.deepEqual(calls, ['volume:mute', 'media:playpause']);
  // Unknown package/macro (or a grant the dep refused) → clean failure.
  assert.deepEqual(await r.run({ type: 'sdkMacro', macro: 'demo/nope' }), { ok: false, error: 'macro_unavailable' });
  // Malformed refs never reach the dep.
  assert.deepEqual(await r.run({ type: 'sdkMacro', macro: 'noslash' }), { ok: false, error: 'bad_macro' });
  assert.deepEqual(await r.run({ type: 'sdkMacro', macro: 'trailing/' }), { ok: false, error: 'bad_macro' });
  // No dep wired → sdk_unavailable, never a throw.
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'sdkMacro', macro: 'a/b' }), { ok: false, error: 'sdk_unavailable' });
});

test('run sdkMacro: a failing step reports the first error but still runs the rest', async () => {
  const calls = [];
  const deps = {
    mediaAction: () => { calls.push('media'); return Promise.resolve(); },
    micMute: () => { throw new Error('mic_boom'); },
    sdkMacro: async () => [
      { action: { type: 'micMute', mode: 'mute' }, delayMs: 0 },
      { action: { type: 'media', cmd: 'next' }, delayMs: 0 },
    ],
  };
  const r = await reg.createRegistry(deps).run({ type: 'sdkMacro', macro: 'demo/x' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mic_boom');
  assert.deepEqual(calls, ['media']);
});

test('run timer actions: start clamps minutes, toggle/cancel address by label, errors surface', async () => {
  const calls = [];
  const deps = { timers: {
    start: async (label, secs) => { calls.push(['start', label, secs]); return { ok: true }; },
    toggle: async (label) => (label === 'Pasta' ? { ok: true } : { ok: false, error: 'not_found' }),
    cancel: async (label) => { calls.push(['cancel', label]); return { ok: true }; },
  } };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'timerStart', label: 'Pasta', minutes: '1,5' }), { ok: true });
  assert.deepEqual(calls[0], ['start', 'Pasta', 90]);                       // decimal comma accepted
  await r.run({ type: 'timerStart', label: 'Long', minutes: '99999' });
  assert.equal(calls[1][2], 86400);                                          // clamped to 24h
  await r.run({ type: 'timerStart', label: 'Blink', minutes: '0.01' });
  assert.equal(calls[2][2], 5);                                              // floor 5s
  assert.deepEqual(await r.run({ type: 'timerStart', label: '', minutes: '5' }), { ok: false, error: 'empty_label' });
  assert.deepEqual(await r.run({ type: 'timerStart', label: 'X', minutes: 'abc' }), { ok: false, error: 'bad_minutes' });
  assert.deepEqual(await r.run({ type: 'timerToggle', label: 'Pasta' }), { ok: true });
  assert.deepEqual(await r.run({ type: 'timerToggle', label: 'Nope' }), { ok: false, error: 'not_found' });
  assert.deepEqual(await r.run({ type: 'timerCancel', label: 'Pasta' }), { ok: true });
  // No dep wired → clean unavailable, never a throw.
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'timerStart', label: 'X', minutes: '5' }), { ok: false, error: 'unavailable' });
});

test('run typeText: strips CR, rejects empty, degrades without a dep', async () => {
  const sent = [];
  const r = reg.createRegistry({ typeText: async (text) => { sent.push(text); return { ok: true }; } });
  assert.deepEqual(await r.run({ type: 'typeText', text: 'ciao\r\nmondo 🚀' }), { ok: true });
  assert.equal(sent[0], 'ciao\nmondo 🚀');
  assert.deepEqual(await r.run({ type: 'typeText', text: '   ' }), { ok: false, error: 'empty_text' });
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'typeText', text: 'x' }), { ok: false, error: 'unavailable' });
});

test('run sdkHandler: splits the ref, passes args through, surfaces dep errors', async () => {
  const calls = [];
  const deps = { sdkHandler: async (pkg, id, args) => {
    calls.push([pkg, id, args]);
    if (pkg === 'demo' && id === 'ping') return { ok: true };
    return { ok: false, error: 'handler_unavailable' };
  } };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'sdkHandler', handler: 'demo/ping', args: '{"n":1}' }), { ok: true });
  assert.deepEqual(calls[0], ['demo', 'ping', '{"n":1}']);
  assert.deepEqual(await r.run({ type: 'sdkHandler', handler: 'demo/nope' }), { ok: false, error: 'handler_unavailable' });
  assert.deepEqual(await r.run({ type: 'sdkHandler', handler: 'noslash' }), { ok: false, error: 'bad_handler' });
  assert.deepEqual(await r.run({ type: 'sdkHandler', handler: 'trailing/' }), { ok: false, error: 'bad_handler' });
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'sdkHandler', handler: 'a/b' }), { ok: false, error: 'sdk_unavailable' });
});

test('run volume/appVolume set modes clamp and reject bad values', async () => {
  const calls = [];
  const r = reg.createRegistry({
    volume: async (mode, value) => calls.push(['volume', mode, value]),
    appVolume: async (app, mode, value) => { calls.push(['app', app, mode, value]); return { ok: true }; },
  });
  assert.deepEqual(await r.run({ type: 'volume', mode: 'set', value: '150' }), { ok: true });
  assert.deepEqual(calls[0], ['volume', 'set', 100]);                       // clamped
  assert.deepEqual(await r.run({ type: 'volume', mode: 'set', value: 'abc' }), { ok: false, error: 'bad_value' });
  assert.deepEqual(await r.run({ type: 'appVolume', app: 'spotify.exe', mode: 'set', value: '42,5' }), { ok: true });
  assert.deepEqual(calls[1], ['app', 'spotify.exe', 'set', 43]);            // decimal comma + round
  // Legacy modes still pass no value through.
  await r.run({ type: 'volume', mode: 'up' });
  assert.deepEqual(calls[2], ['volume', 'up', undefined]);
});

test('run volume/appVolume set: an EMPTY value rejects loud instead of coercing to 0', async () => {
  const calls = [];
  const r = reg.createRegistry({
    volume: async (mode, value) => calls.push(['volume', mode, value]),
    appVolume: async (app, mode, value) => { calls.push(['app', app, mode, value]); return { ok: true }; },
  });
  // Number('') === 0 — without the guard a blank "set volume" key would mute the PC.
  assert.deepEqual(await r.run({ type: 'volume', mode: 'set', value: '' }), { ok: false, error: 'bad_value' });
  assert.deepEqual(await r.run({ type: 'volume', mode: 'set' }), { ok: false, error: 'bad_value' });        // optional param omitted
  assert.deepEqual(await r.run({ type: 'appVolume', app: 'x.exe', mode: 'set', value: '  ' }), { ok: false, error: 'bad_value' });
  assert.equal(calls.length, 0);
});

// ── Claude Code keys ─────────────────────────────────────────────────────────

test('claudeAsk passes the key config to the runner and reports its refusal', async () => {
  const seen = [];
  const deps = { claudeRun: (o) => { seen.push(o); return Promise.resolve({ ok: true }); } };
  const r = reg.createRegistry(deps);
  assert.deepEqual(await r.run({ type: 'claudeAsk', projectId: 'p1', prompt: 'run the tests', model: 'opus' }), { ok: true });
  assert.deepEqual(seen[0], { projectId: 'p1', prompt: 'run the tests', model: 'opus' });

  // The runner is the authority on whether the project still exists; the key
  // must surface that refusal rather than swallow it.
  const no = reg.createRegistry({ claudeRun: () => Promise.resolve({ ok: false, error: 'unknown_project' }) });
  assert.deepEqual(await no.run({ type: 'claudeAsk', projectId: 'gone', prompt: 'hi' }), { ok: false, error: 'unknown_project' });
});

test('claudeAsk refuses an empty prompt and a missing runner', async () => {
  const r = reg.createRegistry({ claudeRun: () => Promise.resolve({ ok: true }) });
  assert.deepEqual(await r.run({ type: 'claudeAsk', projectId: 'p1', prompt: '   ' }), { ok: false, error: 'empty_prompt' });
  const bare = reg.createRegistry({});
  assert.deepEqual(await bare.run({ type: 'claudeAsk', projectId: 'p1', prompt: 'x' }), { ok: false, error: 'claude_unavailable' });
});

test('claudeStop reports honestly when there was nothing to stop', async () => {
  assert.deepEqual(await reg.createRegistry({ claudeStop: () => true }).run({ type: 'claudeStop' }), { ok: true });
  assert.deepEqual(await reg.createRegistry({ claudeStop: () => false }).run({ type: 'claudeStop' }),
    { ok: false, error: 'nothing_running' });
  assert.deepEqual(await reg.createRegistry({}).run({ type: 'claudeStop' }), { ok: false, error: 'claude_unavailable' });
});

test('a Claude key can never carry a folder path, only a project id', async () => {
  const seen = [];
  const r = reg.createRegistry({ claudeRun: (o) => { seen.push(o); return Promise.resolve({ ok: true }); } });
  // Extra fields a hand-edited or imported key might smuggle in are dropped by
  // the shared validator before the registry ever sees them.
  await r.run({ type: 'claudeAsk', projectId: 'p1', prompt: 'x', cwd: 'C:/Windows', path: 'C:/secrets' });
  assert.equal('cwd' in seen[0], false);
  assert.equal('path' in seen[0], false);
});

test('there is no Deck action that answers a pending permission', () => {
  const { ACTION_CATALOG } = require('../js/deck-actions.js');
  const claude = ACTION_CATALOG.filter(a => a.group === 'claude').map(a => a.type);
  assert.deepEqual(claude.sort(), ['claudeAsk', 'claudeStop']);
});
