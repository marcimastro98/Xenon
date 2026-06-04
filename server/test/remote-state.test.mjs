import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildState } = require('../remote-control/state.js');

test('aggrega correttamente uno stato pronto', async () => {
  const deps = {
    installer: { isInstalled: () => Promise.resolve(true) },
    tailscale: { getStatus: () => Promise.resolve({ installed: true, connected: true, ip: '100.64.0.5' }) },
    sunshine: { isResponding: () => Promise.resolve(true), listClients: () => Promise.resolve([{ name: 'phone' }]) },
  };
  const s = await buildState(deps);
  assert.equal(s.ready, true);
  assert.equal(s.tailscale.ip, '100.64.0.5');
  assert.equal(s.connectedClients.length, 1);
  assert.equal(s.installed.sunshine, true);
  assert.equal(s.installed.tailscale, true);
  assert.equal(s.sunshineResponding, true);
});

test('ready=false se Sunshine non risponde', async () => {
  const deps = {
    installer: { isInstalled: () => Promise.resolve(true) },
    tailscale: { getStatus: () => Promise.resolve({ installed: true, connected: true, ip: '1.2.3.4' }) },
    sunshine: { isResponding: () => Promise.resolve(false), listClients: () => Promise.resolve([]) },
  };
  const s = await buildState(deps);
  assert.equal(s.ready, false);
  assert.deepEqual(s.connectedClients, []);
});

test('ready=false se Tailscale non connesso', async () => {
  const deps = {
    installer: { isInstalled: () => Promise.resolve(true) },
    tailscale: { getStatus: () => Promise.resolve({ installed: true, connected: false, ip: '' }) },
    sunshine: { isResponding: () => Promise.resolve(true), listClients: () => Promise.resolve([]) },
  };
  const s = await buildState(deps);
  assert.equal(s.ready, false);
});

test('non esplode se un controllo rigetta', async () => {
  const deps = {
    installer: { isInstalled: () => Promise.reject(new Error('x')) },
    tailscale: { getStatus: () => Promise.resolve({ installed: false, connected: false, ip: '' }) },
    sunshine: { isResponding: () => Promise.resolve(false), listClients: () => Promise.resolve([]) },
  };
  const s = await buildState(deps);
  assert.equal(s.ready, false);
  assert.equal(s.installed.sunshine, false);
});

test('non chiama listClients se Sunshine non risponde', async () => {
  let called = false;
  const deps = {
    installer: { isInstalled: () => Promise.resolve(true) },
    tailscale: { getStatus: () => Promise.resolve({ installed: true, connected: true, ip: '1.2.3.4' }) },
    sunshine: { isResponding: () => Promise.resolve(false), listClients: () => { called = true; return Promise.resolve([]); } },
  };
  await buildState(deps);
  assert.equal(called, false);
});

test('include blocked quando il servizio e fermo e selectedScreen', async () => {
  const deps = {
    installer: { isInstalled: async () => true },
    tailscale: { getStatus: async () => ({ installed: true, connected: true, ip: '1.2.3.4' }) },
    sunshine: { isResponding: async () => true, listClients: async () => [] },
    service: { isRunning: async () => false },
    selectedScreen: 'D2',
  };
  const s = await buildState(deps);
  assert.equal(s.blocked, true);
  assert.equal(s.selectedScreen, 'D2');
});

test('blocked false quando il servizio gira', async () => {
  const deps = {
    installer: { isInstalled: async () => true },
    tailscale: { getStatus: async () => ({ installed: true, connected: true, ip: '1.2.3.4' }) },
    sunshine: { isResponding: async () => true, listClients: async () => [] },
    service: { isRunning: async () => true },
    selectedScreen: '',
  };
  const s = await buildState(deps);
  assert.equal(s.blocked, false);
});
