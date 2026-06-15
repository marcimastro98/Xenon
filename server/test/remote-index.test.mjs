import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRemoteControl } = require('../remote-control/index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory settings store — mimics getSettings/saveSettings in server.js */
function makeStore(initial = {}) {
  let s = JSON.parse(JSON.stringify(initial));
  return {
    getSettings: () => s,
    saveSettings: (next) => { s = next; },
    current: () => s,
  };
}

/**
 * Build a complete fake deps bundle.
 * makeSunshine records the last credentials arg and returns fakeSunshine.
 */
function makeDeps({ configureElevatedResult = true, isRespondingResult = true } = {}) {
  let lastCreds;
  let pinSent;
  let configureCalled = false;

  const fakeSunshine = {
    configureElevated: async () => { configureCalled = true; return configureElevatedResult; },
    sendPin: async (p) => { pinSent = p; return { ok: true, status: 200 }; },
    unpairAll: async () => true,
    isResponding: async () => isRespondingResult,
    listClients: async () => [],
  };

  const fakeInstaller = {
    install: async () => ({ code: 0, stdout: '', stderr: '' }),
    isInstalled: async () => true,
    isWingetAvailable: async () => true,
  };

  const fakeTailscale = {
    getStatus: async () => ({ installed: true, connected: true, ip: '100.64.0.1' }),
    startLogin: async () => ({ code: 0 }),
  };

  const deps = {
    installer: fakeInstaller,
    tailscale: fakeTailscale,
    makeSunshine: (creds) => { lastCreds = creds; return fakeSunshine; },
    // Verifica post-config rapida nei test (niente attese reali).
    verifyTimeoutMs: 5,
    verifyIntervalMs: 1,
  };

  return { deps, fakeSunshine, fakeInstaller, getLastCreds: () => lastCreds, getPinSent: () => pinSent, wasConfigureCalled: () => configureCalled };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('enable() sets enabled=true and preserves other remoteControl fields', async () => {
  const store = makeStore({ remoteControl: { selectedMonitors: ['HDMI-1'], enabled: false } });
  const { deps } = makeDeps();
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await rc.enable();

  const rc2 = store.current().remoteControl;
  assert.equal(rc2.enabled, true, 'enabled deve essere true');
  assert.deepEqual(rc2.selectedMonitors, ['HDMI-1'], 'selectedMonitors deve essere preservato');
});

test('disable() sets enabled=false and preserves other remoteControl fields', async () => {
  const store = makeStore({ remoteControl: { selectedMonitors: ['DP-1'], enabled: true } });
  const { deps } = makeDeps();
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await rc.disable();

  const rc2 = store.current().remoteControl;
  assert.equal(rc2.enabled, false, 'enabled deve essere false');
  assert.deepEqual(rc2.selectedMonitors, ['DP-1'], 'selectedMonitors deve essere preservato');
});

test('setOnDemand(true) imposta i servizi e persiste onDemand=true', async () => {
  const store = makeStore({ remoteControl: { selectedMonitors: ['HDMI-1'] } });
  const calls = [];
  const { deps } = makeDeps();
  deps.service = { setStartup: async (v) => { calls.push(['setStartup', v]); return true; } };
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  assert.equal(await rc.setOnDemand(true), true);
  assert.deepEqual(calls, [['setStartup', true]]);
  assert.equal(store.current().remoteControl.onDemand, true);
  assert.deepEqual(store.current().remoteControl.selectedMonitors, ['HDMI-1'], 'preserva gli altri campi');
});

test('setOnDemand NON persiste se Set-Service fallisce (UAC rifiutato)', async () => {
  const store = makeStore({ remoteControl: { onDemand: false } });
  const { deps } = makeDeps();
  deps.service = { setStartup: async () => false };
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  assert.equal(await rc.setOnDemand(true), false);
  assert.equal(store.current().remoteControl.onDemand, false, 'il flag non cambia se l\'operazione elevata fallisce');
});

test('enable/disable avviano/fermano i servizi SOLO in modalita on-demand', async () => {
  // on-demand attivo: enable -> startManaged, disable -> stopManaged
  const onStore = makeStore({ remoteControl: { onDemand: true } });
  const onCalls = [];
  const on = makeDeps();
  on.deps.service = { startManaged: async () => { onCalls.push('start'); return true; }, stopManaged: async () => { onCalls.push('stop'); return true; } };
  const rcOn = createRemoteControl({ getSettings: onStore.getSettings, saveSettings: onStore.saveSettings, deps: on.deps });
  await rcOn.enable();
  await rcOn.disable();
  assert.deepEqual(onCalls, ['start', 'stop']);

  // on-demand spento: i servizi non vengono toccati
  const offStore = makeStore({ remoteControl: { onDemand: false } });
  const offCalls = [];
  const off = makeDeps();
  off.deps.service = { startManaged: async () => { offCalls.push('start'); return true; }, stopManaged: async () => { offCalls.push('stop'); return true; } };
  const rcOff = createRemoteControl({ getSettings: offStore.getSettings, saveSettings: offStore.saveSettings, deps: off.deps });
  await rcOff.enable();
  await rcOff.disable();
  assert.deepEqual(offCalls, [], 'fuori on-demand i servizi restano gestiti da Windows');
});

test('configureSunshine() on success persists sunshineUser, non-empty sunshinePass, and preserves existing fields', async () => {
  const store = makeStore({ remoteControl: { selectedMonitors: ['HDMI-1'], enabled: true } });
  const { deps } = makeDeps({ configureElevatedResult: true, isRespondingResult: true });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  const result = await rc.configureSunshine();

  assert.equal(result, true, 'deve restituire true');
  const rc2 = store.current().remoteControl;
  assert.equal(rc2.sunshineUser, 'xenonedge', 'sunshineUser deve essere xenonedge');
  assert.ok(rc2.sunshinePass && rc2.sunshinePass.length > 0, 'sunshinePass deve essere non vuota');
  // Existing fields must survive
  assert.equal(rc2.enabled, true, 'enabled deve essere preservato');
  assert.deepEqual(rc2.selectedMonitors, ['HDMI-1'], 'selectedMonitors deve essere preservato');
});

test('configureSunshine() runs the elevated configure step', async () => {
  const store = makeStore({});
  const { deps, wasConfigureCalled } = makeDeps({ configureElevatedResult: true, isRespondingResult: true });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await rc.configureSunshine();
  assert.equal(wasConfigureCalled(), true, 'deve eseguire la configurazione elevata (--creds + riavvio)');
});

test('configureSunshine() throws and does NOT modify settings when UAC/elevation fails', async () => {
  const store = makeStore({ remoteControl: { selectedMonitors: ['DP-1'] } });
  const stateBefore = JSON.stringify(store.current());
  const { deps } = makeDeps({ configureElevatedResult: false });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await assert.rejects(() => rc.configureSunshine(), /UAC|amministratore/, 'deve segnalare il rifiuto UAC');
  // Service was never touched, so nothing is persisted.
  assert.equal(JSON.stringify(store.current()), stateBefore, 'settings non deve essere modificato');
});

test('configureSunshine() does NOT overwrite working creds when verification fails', async () => {
  // Esistono gia' credenziali funzionanti; una riconfigurazione che non supera
  // la verifica NON deve sovrascriverle (verify-before-persist).
  const store = makeStore({ remoteControl: { sunshineUser: 'xenonedge', sunshinePass: 'GOODPASS' } });
  const { deps } = makeDeps({ configureElevatedResult: true, isRespondingResult: false });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await assert.rejects(() => rc.configureSunshine(), /non riuscita/, 'deve segnalare il fallimento');
  assert.equal(store.current().remoteControl.sunshinePass, 'GOODPASS', 'le credenziali funzionanti non vengono sovrascritte');
});

test('sendPin passes null to makeSunshine when credentials are missing', async () => {
  // No sunshineUser / sunshinePass in store → currentCreds() returns null
  const store = makeStore({ remoteControl: {} });
  const { deps, getLastCreds } = makeDeps();
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await rc.sendPin('9999');

  assert.equal(getLastCreds(), null, 'makeSunshine deve ricevere null quando mancano le credenziali');
});

test('sendPin passes {user, pass} to makeSunshine when credentials are present', async () => {
  const store = makeStore({ remoteControl: { sunshineUser: 'xenonedge', sunshinePass: 'abc123' } });
  const { deps, getLastCreds } = makeDeps();
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  await rc.sendPin('1234');

  const creds = getLastCreds();
  assert.ok(creds !== null, 'makeSunshine deve ricevere credenziali non-null');
  assert.equal(creds.user, 'xenonedge');
  assert.equal(creds.pass, 'abc123');
});

test('installTool returns the result of isInstalled after install', async () => {
  const store = makeStore({});
  const { deps } = makeDeps();
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });

  const result = await rc.installTool('sunshine');

  assert.equal(result, true, 'deve restituire il valore di isInstalled post-install');
});

test('construction without getSettings/saveSettings throws TypeError', () => {
  assert.throws(
    () => createRemoteControl({ getSettings: () => ({}), saveSettings: 'not-a-function' }),
    TypeError,
    'deve lanciare TypeError se saveSettings non e una funzione',
  );

  assert.throws(
    () => createRemoteControl({ getSettings: null, saveSettings: async () => {} }),
    TypeError,
    'deve lanciare TypeError se getSettings non e una funzione',
  );

  assert.throws(
    () => createRemoteControl({}),
    TypeError,
    'deve lanciare TypeError se entrambi mancano',
  );
});

test('closeSession delega a sunshine.closeSession', async () => {
  const store = makeStore({ remoteControl: { sunshineUser: 'u', sunshinePass: 'p' } });
  const { deps } = makeDeps({});
  deps.makeSunshine = () => ({ closeSession: async () => true, isResponding: async () => true, listClients: async () => [] });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });
  assert.equal(await rc.closeSession(), true);
});

test('blockAccess ferma il servizio, unblockAccess lo avvia', async () => {
  const store = makeStore({});
  const calls = [];
  const { deps } = makeDeps({});
  deps.service = { isRunning: async () => true, stop: async () => { calls.push('stop'); return true; }, start: async () => { calls.push('start'); return true; } };
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });
  await rc.blockAccess();
  await rc.unblockAccess();
  assert.deepEqual(calls, ['stop', 'start']);
});

test('setScreen scrive su sunshine e persiste selectedScreen', async () => {
  const store = makeStore({ remoteControl: { sunshineUser: 'u', sunshinePass: 'p' } });
  const { deps } = makeDeps({});
  deps.makeSunshine = () => ({ setScreen: async () => true, isResponding: async () => true, listClients: async () => [] });
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });
  assert.equal(await rc.setScreen('D2'), true);
  assert.equal(store.current().remoteControl.selectedScreen, 'D2');
});

test('cycleScreen calcola il prossimo e lo imposta', async () => {
  const store = makeStore({ remoteControl: { sunshineUser: 'u', sunshinePass: 'p', selectedScreen: 'D1' } });
  const { deps } = makeDeps({});
  let setTo;
  deps.makeSunshine = () => ({ setScreen: async (id) => { setTo = id; return true; }, isResponding: async () => true, listClients: async () => [] });
  deps.screens = { list: async () => [{ id: 'D1', active: true }, { id: 'D2', active: false }], nextId: async () => 'D2' };
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });
  assert.equal(await rc.cycleScreen(), 'D2');
  assert.equal(setTo, 'D2');
  assert.equal(store.current().remoteControl.selectedScreen, 'D2');
});

test('listScreens delega a screens.list', async () => {
  const store = makeStore({});
  const { deps } = makeDeps({});
  deps.screens = { list: async () => [{ id: 'D1' }], nextId: async () => 'D1' };
  const rc = createRemoteControl({ getSettings: store.getSettings, saveSettings: store.saveSettings, deps });
  assert.deepEqual(await rc.listScreens(), [{ id: 'D1' }]);
});
