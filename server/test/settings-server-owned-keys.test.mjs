import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `POST /settings` overwrites wholesale, and `normalizeHubSettings` rebuilds the
// blob from the INCOMING payload. So any settings key the browser's own
// normalizer does not emit is reset to its default on every save, from every
// surface, forever — silently, and only for the feature that owns it.
//
// That is not hypothetical. `remoteAccess` was exactly this: the client model
// has no such key, so every generic save arrived without it, the server rebuilt
// it as `{enabled:false}`, and paired-device access switched ITSELF off the
// first time the user changed any setting. Measured on the real install —
// `remoteAccess: {}` on disk with a phone still paired — after which every
// request from that phone got the plain 403 a build without the feature gives:
// the Deck did nothing, the lock key did nothing, Ambient showed "Forbidden".
//
// The codebase already had the answer for three other keys (`claude`, the News
// feeds, `lighting`, the vitals merge): keep the persisted value. This test
// makes that the RULE rather than four separate remembered decisions.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = fs.readFileSync(path.join(HERE, '..', 'server.js'), 'utf8');
const CLIENT = fs.readFileSync(path.join(HERE, '..', 'js', 'settings.js'), 'utf8');

/** Top-level keys of the server's authoritative defaults. */
function serverKeys() {
  const at = SERVER.indexOf('const DEFAULT_HUB_SETTINGS');
  assert.notEqual(at, -1, 'DEFAULT_HUB_SETTINGS must still exist');
  const end = SERVER.indexOf('});', at);
  assert.notEqual(end, -1);
  return [...SERVER.slice(at, end).matchAll(/^ {2}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]);
}

/** Keys the browser's normalizer emits, i.e. what a generic save carries. */
function clientEmittedKeys() {
  const at = CLIENT.indexOf('function normalizeSettings');
  assert.notEqual(at, -1, 'js/settings.js must still define normalizeSettings');
  const next = CLIENT.indexOf('\nfunction ', at + 10);
  const block = CLIENT.slice(at, next > 0 ? next : CLIENT.length);
  return new Set([...block.matchAll(/^ {2,4}([A-Za-z_]\w*)\s*:/gm)].map((m) => m[1]));
}

// Each entry says HOW the key survives a save. Adding one is the review step:
// if a key is server-owned, it needs a keep-prev guard, and the guard has to be
// findable in server.js — not assumed.
const SERVER_OWNED = {
  // Widget-owned; edited only through POST /api/claude/budget.
  claude: 'incoming.claude = prev.claude;',
  // Credentials are restored by preserveRemoteCreds (see the secrets invariant).
  remoteControl: 'preserveRemoteCreds(',
  // Server-owned security flag; POST /api/remote-access/enable is the only
  // writer, and it is loopback-only so a phone cannot switch itself on.
  remoteAccess: 'incoming.remoteAccess = prev.remoteAccess;',
  // File transfer. Server-owned for the same reason remoteAccess is, plus a
  // sharper one: `inboxDir` names a folder on THIS PC, and the settings blob is
  // mirrored to every browser surface and into the localStorage of every paired
  // phone. It is redacted on the wire like a credential, so the browser could
  // not send it back even if it modelled the rest — without the guard the
  // user's chosen folder would reset on every save from any surface and
  // arrivals would quietly start landing somewhere else.
  fileTransfer: 'incoming.fileTransfer = prev.fileTransfer;',
  // Identity of the settings store, minted once by writeHubSettings. The browser
  // never models it, and it must not: a surface still holding a mirror of a
  // PREVIOUS store would echo that store's id back and make this one answer with
  // the identity of the install it replaced, disarming the check for every other
  // surface. See settingsMirrorIsForeign in js/settings.js.
  storeId: 'incoming.storeId = prev.storeId;',
};

test('every settings key the browser does not send is kept from the persisted copy', () => {
  const dropped = serverKeys().filter((k) => !clientEmittedKeys().has(k));

  assert.deepEqual(dropped.sort(), Object.keys(SERVER_OWNED).sort(),
    'a settings key is server-owned that this test does not know about. It is reset to '
    + 'its default on EVERY save from EVERY surface until it gets a keep-prev guard. '
    + 'Add the guard in the keep-prev block of POST /settings, then list it here.');

  for (const [key, guard] of Object.entries(SERVER_OWNED)) {
    assert.ok(SERVER.includes(guard),
      'the keep-prev guard for `' + key + '` is gone from server.js (looked for: ' + guard + ')');
  }
});

// The specific regression, stated on its own so a future edit cannot quietly
// reintroduce "absent means the user turned it off".
test('an absent remoteAccess key never reads as the user turning it off', () => {
  assert.ok(SERVER.includes('incoming.remoteAccess = prev.remoteAccess;'),
    'a generic settings save must keep the persisted paired-device flag');

  // The old shape: hanging up on every device because a save "turned it off".
  // It ran on every save, since no surface has ever carried the flag.
  assert.ok(!/prev\.remoteAccess\.enabled === true[\s\S]{0,200}_dropRemoteSockets/.test(SERVER),
    'POST /settings must not drop remote sockets by comparing the flag it no longer reads');

  // The real switch still hangs up — that half was never wrong.
  const at = SERVER.indexOf("reqPath === '/api/remote-access/enable'");
  assert.notEqual(at, -1, 'the dedicated enable endpoint must still exist');
  assert.ok(SERVER.slice(at, at + 2000).includes('_dropRemoteSockets'),
    'turning it off through its own endpoint must still hang up on connected devices');
});
