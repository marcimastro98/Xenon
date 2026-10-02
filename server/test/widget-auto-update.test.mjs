import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const wau = require('../widget-auto-update.js');
const sdk = require('../sdk-widgets.js');
const codec = require('../js/preset-share.js');
const CLIENT_SRC = fs.readFileSync(fileURLToPath(new URL('../js/custom-widget.js', import.meta.url)), 'utf8');

const NOW = Date.parse('2026-10-10T12:00:00Z');

// ── a real, valid widget package payload ─────────────────────────────────────
function payloadFor(id, version, extra = {}, files = {}) {
  const manifest = { api: 1, id, name: 'Widget ' + id, version, entry: 'index.html', ...extra };
  const all = { 'manifest.json': JSON.stringify(manifest), 'index.html': '<p>v' + version + '</p>', ...files };
  return { id, files: Object.entries(all).map(([p, d]) => ({ path: p, data: Buffer.from(d).toString('base64') })) };
}
const presetCode = (kind, payload) => Buffer.from(JSON.stringify({ xenonPreset: 1, kind, name: 'x', data: { payload } })).toString('base64url');

// ── exceedsGrants must agree with the dashboard's grantNeedsReview ───────────
function loadClientGrantNeedsReview(grants) {
  const start = CLIENT_SRC.indexOf('  function grantNeedsReview(pkg) {');
  assert.ok(start > 0, 'grantNeedsReview not found in custom-widget.js');
  const end = CLIENT_SRC.indexOf('\n  }', start);
  const g = { streams: [], actions: [], hosts: [], hooks: [], handlers: [], ...grants };
  const ctx = vm.createContext({ grantsFor: () => g });
  vm.runInContext(CLIENT_SRC.slice(start, end + 4) + '\nthis.fn = grantNeedsReview;', ctx);
  return ctx.fn;
}

test('exceedsGrants says the same as the dashboard on a matrix of manifests', () => {
  const grantSets = [
    {},
    { streams: ['media'], actions: ['media'], hosts: ['api.example.com'], hooks: ['ping'], handlers: ['h1'] },
    { storage: true, secrets: true, island: true, badge: true, clipboard: true, accent: true, expand: true },
  ];
  const manifests = [
    {},
    { streams: ['media'] },
    { streams: ['media', 'system'] },
    { actions: ['media'] },
    { hosts: ['api.example.com'] },
    { hosts: ['api.example.com', 'other.example.org'] },
    { hooks: ['ping'] },
    { hooks: ['ping', 'pong'] },
    { deck: { handlers: [{ id: 'h1' }] } },
    { deck: { handlers: [{ id: 'h1' }, { id: 'h2' }] } },
    { storage: true }, { secrets: true }, { island: true }, { islandDynamic: true }, { islandFull: true },
    { badge: true }, { badgeAction: true }, { mini: true }, { clipboard: true }, { accent: true }, { expand: true },
  ];
  for (const g of grantSets) {
    const client = loadClientGrantNeedsReview(g);
    for (const m of manifests) {
      assert.equal(wau.exceedsGrants(m, g, null) !== '', client(m), JSON.stringify({ g, m }));
    }
  }
});

test('exceedsGrants also refuses a new address slot and a changed surface', () => {
  const prev = { userHosts: [{ id: 'nas' }], surface: 'tile' };
  assert.equal(wau.exceedsGrants({ userHosts: [{ id: 'nas' }], surface: 'tile' }, {}, prev), '');
  assert.equal(wau.exceedsGrants({ userHosts: [{ id: 'nas' }, { id: 'cam' }], surface: 'tile' }, {}, prev), 'userHosts');
  assert.equal(wau.exceedsGrants({ surface: 'ambient' }, {}, prev), 'surface');
  assert.equal(wau.exceedsGrants({ streams: ['media'] }, { streams: ['media'] }, prev), '');
});

// ── which installed widgets are due ──────────────────────────────────────────
const entry = (o = {}) => ({ id: 'river', kind: 'widget', pkgId: 'river', version: '1.1.0', updatedAt: '2026-10-07', ...o });
function plan(entries, over = {}) {
  return wau.planUpdates({
    entries,
    installed: [{ id: 'river', version: '1.0.0' }],
    originOf: () => 'import',
    catalogVersionOf: () => '1.0.0',
    isSuspended: () => false,
    failed: {},
    appVersion: '4.11.11',
    now: NOW,
    ...over,
  });
}

test('plan: a newer catalog version of an installed, catalog-stamped widget is due', () => {
  assert.deepEqual(plan([entry()]).due.map((d) => d.entry.pkgId), ['river']);
});

test('plan: waits until a full day has passed after the day it was published', () => {
  // Published on the 9th at any hour: not before the 11th 00:00 UTC.
  assert.equal(plan([entry({ updatedAt: '2026-10-09' })], { now: Date.parse('2026-10-10T23:59:00Z') }).due.length, 0);
  assert.equal(plan([entry({ updatedAt: '2026-10-09' })], { now: Date.parse('2026-10-10T23:59:00Z') }).waiting, 1);
  assert.equal(plan([entry({ updatedAt: '2026-10-09' })], { now: Date.parse('2026-10-11T00:00:01Z') }).due.length, 1);
  // No date at all is no proof of age.
  assert.equal(plan([entry({ updatedAt: undefined, addedAt: undefined })]).due.length, 0);
  // The day it first shipped counts when there was no update yet.
  assert.equal(plan([entry({ updatedAt: undefined, addedAt: '2026-10-01' })]).due.length, 1);
});

test('plan: never touches what it cannot vouch for', () => {
  assert.equal(plan([entry()], { originOf: () => 'creator' }).due.length, 0, 'the user\'s own build');
  assert.equal(plan([entry()], { originOf: () => 'local' }).due.length, 0);
  assert.equal(plan([entry()], { originOf: () => 'unknown' }).due.length, 0);
  assert.equal(plan([entry()], { catalogVersionOf: () => '' }).due.length, 0, 'no catalog stamp: a bundle or pasted code');
  assert.equal(plan([entry()], { catalogVersionOf: () => '1.1.0' }).due.length, 0, 'already current');
  assert.equal(plan([entry()], { isSuspended: () => true }).due.length, 0, 'suspended by the user');
  assert.equal(plan([entry()], { installed: [] }).due.length, 0, 'not installed');
  assert.equal(plan([entry({ kind: 'theme' })]).due.length, 0, 'only widgets and scenes');
  assert.equal(plan([entry({ pkgId: '../evil' })]).due.length, 0, 'malformed id');
  assert.equal(plan([entry({ appVersionMin: '4.12.0' })]).due.length, 0, 'needs a newer Xenon');
  assert.equal(plan([entry({ appVersionMin: '4.11.10' })]).due.length, 1);
});

test('plan: a version that failed once is manual only', () => {
  assert.equal(plan([entry()], { failed: { 'river@1.1.0': 'x' } }).due.length, 0);
  assert.equal(plan([entry({ version: '1.2.0' })], { failed: { 'river@1.1.0': 'x' } }).due.length, 1, 'the next version gets its chance');
});

// ── decrypting a remote-locked code ──────────────────────────────────────────
async function lockRemote(inner, entryId, kind = 'widget', kv) {
  const cek = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const raw = Buffer.from(await webcrypto.subtle.exportKey('raw', cek)).toString('base64');
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = Buffer.from(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, cek, new TextEncoder().encode(inner)));
  const env = Buffer.from(JSON.stringify({ xenonLocked: 2, kind, name: 'x', enc: { iv: Buffer.from(iv).toString('base64'), ct: ct.toString('base64') }, redeem: kv ? { entryId, kv } : { entryId } })).toString('base64url');
  return { code: env, cek: raw };
}

test('decryptRemote opens what the dashboard\'s WebCrypto lock made, and nothing else', async () => {
  const { code, cek } = await lockRemote('hello inner code', 'river');
  const locked = codec.peekLocked(code);
  assert.equal(wau.decryptRemote(locked, cek), 'hello inner code');
  assert.equal(wau.decryptRemote(locked, Buffer.alloc(32, 1).toString('base64')), null, 'wrong key');
  assert.equal(wau.decryptRemote(locked, 'short'), null);
  assert.equal(wau.decryptRemote({ enc: { iv: 'AAAA', ct: 'AAAA' } }, cek), null);
});

// ── the loop, with every effect faked ────────────────────────────────────────
function harness(over = {}) {
  const installed = [{ id: 'river', name: 'River', version: '1.0.0', surface: 'tile' }];
  const state = { stored: null, events: [], installs: [], redeems: [] };
  const catalog = over.entries || [entry()];
  const deps = {
    currentVersion: '4.11.11',
    isEnabled: () => true,
    safeMode: () => false,
    signals: async () => ({ blockers: [] }),
    fetchCatalog: async () => ({ ok: true, entries: catalog }),
    fetchCode: async () => ({ ok: true, code: presetCode('widget', payloadFor('river', '1.1.0')) }),
    redeem: async (id) => { state.redeems.push(id); return { ok: false, error: 'bad_request' }; },
    codec: { peekLocked: codec.peekLocked, decodePreset: codec.decodePreset },
    validatePayload: (p) => sdk.validateWidgetPayload(p),
    listInstalled: async () => installed,
    originOf: () => 'import',
    catalogVersionOf: () => '1.0.0',
    isSuspended: () => false,
    grantsOf: () => ({}),
    installStaged: async (v, cv) => { state.installs.push({ id: v.id, version: v.manifest.version, catalogVersion: cv }); return { ok: true }; },
    store: { read: async () => state.stored, write: async (o) => { state.stored = JSON.parse(JSON.stringify(o)); } },
    broadcast: (e, d) => state.events.push({ e, d }),
    log: () => {},
    now: () => NOW,
    ...over.deps,
  };
  return { up: wau.createWidgetAutoUpdater(deps), state, deps };
}

test('run: updates a due widget through the validated install and says so', async () => {
  const { up, state } = harness();
  const r = await up.runOnce();
  assert.equal(r.updated, 1);
  assert.deepEqual(state.installs, [{ id: 'river', version: '1.1.0', catalogVersion: '1.1.0' }]);
  assert.equal(state.events[0].e, 'widget_auto_updated');
  assert.deepEqual(state.events[0].d.updated.map((u) => [u.id, u.from, u.to]), [['river', '1.0.0', '1.1.0']]);
  assert.equal((await up.status()).last.updated[0].id, 'river');
});

test('run: a version asking for something new is NOT installed, and is announced once', async () => {
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: true, code: presetCode('widget', payloadFor('river', '1.1.0', { hosts: ['api.example.com'] })) }) } });
  let r = await up.runOnce();
  assert.equal(r.updated, 0);
  assert.equal(state.installs.length, 0);
  assert.equal(state.events[0].d.attention[0].reason, 'needs_approval:hosts');
  assert.equal((await up.status()).waitingForYou[0].id, 'river');
  state.events.length = 0;
  r = await up.runOnce();
  assert.equal(state.events.length, 0, 'the same sentence is not repeated every run');
  assert.equal(state.installs.length, 0);
});

test('run: a widget already approved for what it asks IS updated', async () => {
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code: presetCode('widget', payloadFor('river', '1.1.0', { hosts: ['api.example.com'] })) }),
    grantsOf: () => ({ hosts: ['api.example.com'] }),
  } });
  assert.equal((await up.runOnce()).updated, 1);
  assert.equal(state.installs.length, 1);
});

test('run: the entry\'s pkgId must be the id inside the package', async () => {
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: true, code: presetCode('widget', payloadFor('someone-else', '9.9.9')) }) } });
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.ok(state.stored.failed['river@1.1.0'], 'recorded as failed');
});

test('run: a package that does not validate is refused and never retried', async () => {
  const bad = { id: 'river', files: [{ path: 'manifest.json', data: Buffer.from('{not json').toString('base64') }] };
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: true, code: presetCode('widget', bad) }) } });
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.ok(state.stored.failed['river@1.1.0']);
  let calls = 0;
  const h2 = harness({ deps: { fetchCode: async () => { calls++; return { ok: true, code: 'x' }; } } });
  h2.state.stored = state.stored;
  await h2.up.runOnce();
  assert.equal(calls, 0, 'a failed version is not even fetched again');
});

test('run: an install that fails is recorded and not retried; the manual update stays', async () => {
  const { up, state } = harness({ deps: { installStaged: async () => ({ ok: false, error: 'verify_failed' }) } });
  await up.runOnce();
  assert.ok(state.stored.failed['river@1.1.0']);
  const r2 = await up.runOnce();
  assert.equal(r2.updated, 0);
});

test('run: a supporter widget is unlocked with the saved pass, and decrypted locally', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code, cek } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    redeem: async (id) => { state.redeems.push(id); return { ok: true, cek }; },
  } });
  assert.equal((await up.runOnce()).updated, 1);
  assert.deepEqual(state.redeems, ['river']);
  assert.equal(state.installs.length, 1);
});

test('run: a supporter widget with no usable pass waits for the user instead of failing', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: true, code }) } });   // default redeem: no pass
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.equal(state.events[0].d.attention[0].reason, 'needs_code');
  assert.equal(state.stored.failed['river@1.1.0'], undefined, 'not a failure: the next run may have a pass');
});

test('run: a locked code that names another entry is not unlocked', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code } = await lockRemote(inner, 'a-different-entry');
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: true, code }) } });
  await up.runOnce();
  assert.deepEqual(state.redeems, [], 'the pass is never spent on an entry the catalog did not name');
});

test('run: a network trouble records nothing, so the next run tries again', async () => {
  const { up, state } = harness({ deps: { fetchCode: async () => ({ ok: false, error: 'timeout' }) } });
  await up.runOnce();
  assert.equal(state.stored, null);
  assert.equal(state.installs.length, 0);
});

test('run: off, safe mode and a busy PC all do nothing', async () => {
  for (const [over, why] of [
    [{ isEnabled: () => false }, 'off'],
    [{ safeMode: () => true }, 'safe_mode'],
    [{ signals: async () => ({ blockers: ['game'] }) }, 'busy:game'],
  ]) {
    const { up, state } = harness({ deps: over });
    const r = await up.runOnce();
    assert.equal(r.skipped, why);
    assert.equal(state.installs.length, 0);
  }
});

test('run: at most a few widgets per run, the rest next time', async () => {
  const entries = [];
  const installed = [];
  for (let i = 0; i < 9; i++) { entries.push(entry({ id: 'w' + i, pkgId: 'w' + i })); installed.push({ id: 'w' + i, name: 'W' + i, version: '1.0.0', surface: 'tile' }); }
  const { up, state } = harness({ entries, deps: {
    listInstalled: async () => installed,
    fetchCode: async () => ({ ok: true, code: presetCode('widget', payloadFor('w0', '1.1.0')) }),
  } });
  await up.runOnce();
  assert.ok(state.installs.length + Object.keys(state.stored.failed).length <= wau.MAX_PER_RUN);
});

// ── the swap, on a real folder ───────────────────────────────────────────────
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-wau-')); }
const validated = (id, version, files) => sdk.validateWidgetPayload(payloadFor(id, version, {}, files));
const read = (p) => fs.readFileSync(p, 'utf8');

test('staged install: replaces the package whole, and the files the new version dropped are gone', async () => {
  const root = tmp(); const widgets = path.join(root, 'widgets'); const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(widgets, 'river'), { recursive: true });
  fs.writeFileSync(path.join(widgets, 'river', 'manifest.json'), JSON.stringify({ api: 1, id: 'river', name: 'R', version: '1.0.0', entry: 'index.html' }));
  fs.writeFileSync(path.join(widgets, 'river', 'index.html'), 'old');
  fs.writeFileSync(path.join(widgets, 'river', 'stale.js'), 'dropped in 1.1.0');
  const res = await sdk.installPackageStaged(widgets, staging, validated('river', '1.1.0', { 'app.js': 'new' }), async () => true);
  assert.deepEqual(res, { ok: true });
  assert.match(read(path.join(widgets, 'river', 'manifest.json')), /1\.1\.0/);
  assert.equal(read(path.join(widgets, 'river', 'app.js')), 'new');
  assert.equal(fs.existsSync(path.join(widgets, 'river', 'stale.js')), false);
  assert.equal(fs.existsSync(path.join(staging, 'river.previous')), false, 'the old copy is cleaned up on success');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staged install: a failed check puts the OLD package back exactly', async () => {
  const root = tmp(); const widgets = path.join(root, 'widgets'); const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(widgets, 'river'), { recursive: true });
  fs.writeFileSync(path.join(widgets, 'river', 'manifest.json'), JSON.stringify({ api: 1, id: 'river', name: 'R', version: '1.0.0', entry: 'index.html' }));
  fs.writeFileSync(path.join(widgets, 'river', 'index.html'), 'old');
  const res = await sdk.installPackageStaged(widgets, staging, validated('river', '1.1.0'), async () => false);
  assert.deepEqual(res, { ok: false, error: 'verify_failed' });
  assert.match(read(path.join(widgets, 'river', 'manifest.json')), /1\.0\.0/);
  assert.equal(read(path.join(widgets, 'river', 'index.html')), 'old');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staged install: a check that throws also restores the old package', async () => {
  const root = tmp(); const widgets = path.join(root, 'widgets'); const staging = path.join(root, 'staging');
  fs.mkdirSync(path.join(widgets, 'river'), { recursive: true });
  fs.writeFileSync(path.join(widgets, 'river', 'index.html'), 'old');
  const res = await sdk.installPackageStaged(widgets, staging, validated('river', '1.1.0'), async () => { throw new Error('boom'); });
  assert.equal(res.ok, false);
  assert.equal(read(path.join(widgets, 'river', 'index.html')), 'old');
  fs.rmSync(root, { recursive: true, force: true });
});

test('staged install: a first install that fails its check leaves nothing behind', async () => {
  const root = tmp(); const widgets = path.join(root, 'widgets'); const staging = path.join(root, 'staging');
  fs.mkdirSync(widgets, { recursive: true });
  const res = await sdk.installPackageStaged(widgets, staging, validated('river', '1.0.0'), async () => false);
  assert.equal(res.ok, false);
  assert.equal(fs.existsSync(path.join(widgets, 'river')), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('staged install: refuses an invalid package before touching the disk', async () => {
  const root = tmp(); const widgets = path.join(root, 'widgets'); const staging = path.join(root, 'staging');
  fs.mkdirSync(widgets, { recursive: true });
  assert.deepEqual(await sdk.installPackageStaged(widgets, staging, { ok: false }, null), { ok: false, error: 'bad_payload' });
  assert.deepEqual(await sdk.installPackageStaged(widgets, staging, { ok: true, id: '../x', files: [] }, null), { ok: false, error: 'bad_payload' });
  assert.equal(fs.existsSync(staging), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: the setting is on by default, normalized on both sides, and never an SDK grant', () => {
  const server = fs.readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
  const settings = fs.readFileSync(fileURLToPath(new URL('../js/settings.js', import.meta.url)), 'utf8');
  assert.match(server, /autoUpdateWidgets: true,/);
  assert.match(server, /autoUpdateWidgets: source\.autoUpdateWidgets !== false/);
  assert.match(settings, /autoUpdateWidgets: value\.autoUpdateWidgets !== false/);
  assert.match(settings, /autoUpdateWidgets: true,/);
  // the updater has no way to write a grant: nothing in the module touches the grants store
  const mod = fs.readFileSync(fileURLToPath(new URL('../widget-auto-update.js', import.meta.url)), 'utf8');
  assert.doesNotMatch(mod.replace(/\/\/.*$/gm, ''), /grants\s*\[|setGrant|writeGrant|persist\(/);
});

// ── locked widgets and the owner update ──────────────────────────────────────
test('run: an install the hub knows as an owner updates with NO pass at all', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code, cek } = await lockRemote(inner, 'river', 'widget', 2);
  const asked = [];
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    update: async (id, opts) => { asked.push([id, opts]); return { ok: true, cek, version: '1.1.0', kv: 2 }; },
  } });
  assert.equal((await up.runOnce()).updated, 1);
  assert.deepEqual(state.redeems, [], 'the pass was never needed, so never spent');
  assert.deepEqual(asked, [['river', { have: '1.0.0', kv: 2 }]], 'it names what is installed and the key version the file was sealed with');
  assert.equal(state.installs.length, 1);
});

test('run: not_owner falls back to the saved pass, exactly as before', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code, cek } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    update: async () => ({ ok: false, error: 'not_owner' }),
    redeem: async (id, kv) => { state.redeems.push([id, kv]); return { ok: true, cek }; },
  } });
  assert.equal((await up.runOnce()).updated, 1);
  assert.deepEqual(state.redeems, [['river', null]]);
});

test('run: no pass AND not an owner waits for the user, it does not fail', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    update: async () => ({ ok: false, error: 'not_owner' }),
  } });
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.equal(state.events[0].d.attention[0].reason, 'needs_code');
  assert.equal(state.stored.failed['river@1.1.0'], undefined);
});

test('run: a network failure of the owner update is retried next run, not recorded', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    update: async () => ({ ok: false, error: 'network' }),
  } });
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.deepEqual(state.redeems, [], 'it does not turn into a pass redeem');
  assert.equal(state.stored, null, 'nothing recorded: the next run simply tries again');
});

test('run: a key that does not open the file is a recorded failure, never an install', async () => {
  const inner = presetCode('widget', payloadFor('river', '1.1.0'));
  const { code } = await lockRemote(inner, 'river');
  const { up, state } = harness({ deps: {
    fetchCode: async () => ({ ok: true, code }),
    update: async () => ({ ok: true, cek: Buffer.alloc(32, 7).toString('base64'), version: '1.1.0', kv: 2 }),
  } });
  await up.runOnce();
  assert.equal(state.installs.length, 0);
  assert.ok(state.stored.failed['river@1.1.0']);
});
