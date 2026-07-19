import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const versionPing = require('../version-ping.js');
const { HUB_BASE } = require('../supporter-redeem.js');

// Transport stub: records every outbound call, answers from a script.
let calls;
let responder;
beforeEach(() => {
  calls = [];
  responder = () => ({ ok: true });
  versionPing._setTransport(async (url, body) => { calls.push({ url, body }); return responder(url, body); });
});

function tmpDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-vping-'));
}

const base = (over = {}) => ({ dataDir: tmpDataDir(), version: '4.6.1', enabled: true, ...over });

test('off by default: a disabled ping never touches the network or the disk', async () => {
  const dir = tmpDataDir();
  const out = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: false });
  assert.deepEqual(out, { ok: false, skipped: 'disabled' });
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'version-ping.json')), false);
});

test('a missing or non-true flag is treated as off', async () => {
  for (const enabled of [undefined, null, 0, '', 'true', 1]) {
    const out = await versionPing.maybePing({ dataDir: tmpDataDir(), version: '4.6.1', enabled });
    assert.equal(out.skipped, 'disabled', JSON.stringify(enabled));
  }
  assert.equal(calls.length, 0);
});

test('an enabled ping sends version + os to the hub and nothing else', async () => {
  const out = await versionPing.maybePing(base({ os: 'win32' }));
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, HUB_BASE + '/version/ping');
  // The exact payload shape is the privacy promise — assert it exhaustively so
  // adding a field (an install id above all) fails loudly here.
  assert.deepEqual(Object.keys(calls[0].body).sort(), ['os', 'version']);
  assert.deepEqual(calls[0].body, { version: '4.6.1', os: 'win32' });
});

test('the install id is never part of the payload', async () => {
  await versionPing.maybePing(base());
  const serialized = JSON.stringify(calls[0].body);
  assert.equal(/install/i.test(serialized), false, 'payload must carry no install identifier');
});

test('at most one ping per UTC day, across repeated calls', async () => {
  const dir = tmpDataDir();
  const first = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-18' });
  assert.deepEqual(first, { ok: true });

  for (let i = 0; i < 5; i++) {
    const again = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-18' });
    assert.deepEqual(again, { ok: false, skipped: 'already_sent' });
  }
  assert.equal(calls.length, 1);

  // A new day sends once more.
  await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-19' });
  assert.equal(calls.length, 2);
});

test('the day is recorded before sending, so a network failure costs one attempt not many', async () => {
  const dir = tmpDataDir();
  responder = () => ({ ok: false, error: 'network' });
  const out = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-18' });
  assert.deepEqual(out, { ok: false, error: 'network' });
  assert.equal(calls.length, 1);

  const again = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-18' });
  assert.equal(again.skipped, 'already_sent');
  assert.equal(calls.length, 1, 'a failed ping must not retry within the same day');
});

test('a malformed version is refused before any network', async () => {
  for (const version of ['', 'nightly', '../etc', '4.6.1; DROP', null, undefined, '1'.repeat(64)]) {
    const out = await versionPing.maybePing({ dataDir: tmpDataDir(), version, enabled: true });
    assert.equal(out.skipped, 'bad_version', JSON.stringify(version));
  }
  assert.equal(calls.length, 0);
});

test('a prerelease version is accepted', async () => {
  const out = await versionPing.maybePing(base({ version: '4.7.0-beta.2' }));
  assert.deepEqual(out, { ok: true });
  assert.equal(calls[0].body.version, '4.7.0-beta.2');
});

test('a corrupt state file is treated as never-sent rather than blocking forever', async () => {
  const dir = tmpDataDir();
  fs.writeFileSync(path.join(dir, 'version-ping.json'), '{not json', 'utf8');
  const out = await versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true });
  assert.deepEqual(out, { ok: true });
  assert.equal(calls.length, 1);
});

test('concurrent calls collapse to a single ping', async () => {
  const dir = tmpDataDir();
  const results = await Promise.all(
    Array.from({ length: 6 }, () => versionPing.maybePing({ dataDir: dir, version: '4.6.1', enabled: true, day: '2026-07-18' }))
  );
  assert.equal(calls.length, 1);
  assert.equal(results.filter((r) => r.ok).length, results.length, 'all callers observe the one shared attempt');
});

test('utcDay formats an epoch as YYYY-MM-DD', () => {
  assert.equal(versionPing.utcDay(Date.UTC(2026, 6, 18, 23, 59)), '2026-07-18');
});

// ── The opt-in → opt-out change (v4.8.0) ──────────────────────────────────────
// The default flipped to ON for FRESH installs only. Existing installs keep what
// their settings blob says, including "nothing", because those users were told in
// the release notes and on the privacy page that it was off unless they chose it.
// The mechanism is subtle — a default that only applies when there is no file,
// plus a strict `=== true` normalizer — so these pin both halves.

// Mirror of the normalizer's rule in server.js / js/settings.js. If that test is
// ever relaxed to `!== false`, this fails and says why.
const normalizeVersionPing = (blob) => blob.versionPing === true;

test('versionPing: a settings blob predating the key stays OFF after an update', () => {
  // A pre-v4.7.0 install that never saved settings has no key at all. An update
  // must not read that silence as consent.
  assert.equal(normalizeVersionPing({}), false);
  assert.equal(normalizeVersionPing({ versionPing: undefined }), false);
});

test('versionPing: an explicit choice is never overridden', () => {
  assert.equal(normalizeVersionPing({ versionPing: false }), false);
  assert.equal(normalizeVersionPing({ versionPing: true }), true);
});

test('versionPing: only a real boolean true counts as opted in', () => {
  // Guards against a truthy value from a hand-edited or migrated blob enabling it.
  for (const v of [1, 'true', 'yes', {}, []]) {
    assert.equal(normalizeVersionPing({ versionPing: v }), false, String(v));
  }
});
