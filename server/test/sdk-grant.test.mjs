// Allow pressed on a widget that sits on the PC's screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const { FLAGS, grantFrom, plan, apply } = require('../sdk-grant.js');
const { remotePathAllowed } = require('../remote-access.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const PKG = {
  id: 'wide',
  streams: ['system'],
  actions: ['lighting'],
  hosts: ['api.example.com'],
  hooks: ['poke'],
  deck: { handlers: [{ id: 'ping', name: 'Ping' }] },
  storage: true,
  storageGroup: 'set',
  userHosts: [{ id: 'nas', scope: 'private' }],
};

test('the grant comes from the manifest, never from the page', () => {
  const out = plan({ id: 'wide', streams: ['sensors'], actions: ['url'], clipboard: true, grant: { ai: true } }, [PKG]);
  assert.deepEqual(out.grant.streams, ['system']);
  assert.deepEqual(out.grant.actions, ['lighting']);
  assert.deepEqual(out.grant.handlers, ['ping']);
  assert.equal(out.grant.clipboard, false);
  assert.equal(out.grant.ai, false);
  assert.equal(out.grant.storage, true);
  assert.equal(out.grant.storageGroup, 'set');
});

test('only addresses for declared slots are kept, in the stored shape', () => {
  const nas = { host: 'nas.local', port: 8123, scheme: 'https', extra: 'x' };
  const g = grantFrom(PKG, { nas, other: { host: 'evil.example' } });
  assert.deepEqual(g.userHosts, { nas: { host: 'nas.local', port: 8123, scheme: 'https' } });
  assert.deepEqual(grantFrom(PKG, { nas: { host: 'x'.repeat(254) } }).userHosts, {});
  assert.deepEqual(grantFrom(PKG, { nas: 'nas.local' }).userHosts, {});
  assert.deepEqual(grantFrom(PKG, 'nope').userHosts, {});
});

test('a widget that is not installed is refused', () => {
  assert.equal(plan({ id: 'nope' }, [PKG]).error, 'unknown_widget');
  assert.equal(plan(null, [PKG]).error, 'unknown_widget');
  assert.equal(plan({ id: 42 }, [PKG]).error, 'unknown_widget');
});

test('apply touches one grant and turns widgets on only when asked', () => {
  const cur = { sdkWidgets: { enabled: false, assign: { custom: 'a' }, grants: { a: { streams: [] } } } };
  const off = apply(cur, plan({ id: 'wide' }, [PKG])).sdkWidgets;
  assert.equal(off.enabled, false);
  assert.deepEqual(off.assign, { custom: 'a' });
  assert.ok(off.grants.a && off.grants.wide);
  assert.equal(apply(cur, plan({ id: 'wide', enabled: true }, [PKG])).sdkWidgets.enabled, true);
  assert.ok(apply({}, plan({ id: 'wide' }, [PKG])).sdkWidgets.grants.wide);
});

test('every consent flag the dialog grants is built here too', () => {
  const line = read('../js/custom-widget.js').split('\n').find((l) => l.includes('grants: { ...(cur.grants || {}), [pkg.id]:'));
  const named = [...line.matchAll(/\b([a-zA-Z]+): wants[A-Z][a-zA-Z]*[,\s}]/g)].map((m) => m[1]).filter((n) => n !== 'storageGroup');
  assert.deepEqual([...named].sort(), [...FLAGS].sort());
});

test('a phone and a foreign page cannot approve', () => {
  assert.equal(remotePathAllowed('/sdk/grant', 'POST'), false);
  assert.match(engineSource(), /CSRF_MUTATION_PATHS = new Set\(\[[\s\S]*?'\/sdk\/grant'/);
});

test('a screen page saves through the server and takes the approval back if refused', () => {
  const src = read('../js/custom-widget.js');
  assert.match(src, /isLayerPage\(\)\) approveFromScreen\(pkg, patch, uh\.values\);\s+else persist\(patch\);/);
  const fn = src.slice(src.indexOf('function approveFromScreen('));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.match(body, /api\('\/sdk\/grant'/);
  assert.match(body, /if \(saved && saved\.ok\) return;\s+hubSettings\.sdkWidgets = before;\s+paint\(\);/);
});
