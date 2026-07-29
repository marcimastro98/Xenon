import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhone, SUPPORTED_PLATFORMS, platformAllowed } = require('../phone.js');

// The module's contract, exercised without a helper or a phone. The weight is
// on the answers it gives when it CANNOT do something, because those are the
// ones a user reads and acts on.

const VCF_CALLS = [
  'BEGIN:VCARD', 'VERSION:2.1', 'FN:Gabriele Ponzio', 'TEL;TYPE=CELL:+393203465082',
  'X-IRMC-CALL-DATETIME;RECEIVED:20260729T121505', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:2.1', 'FN:', 'TEL:+393463331166',
  'X-IRMC-CALL-DATETIME;MISSED:20260728T213634', 'END:VCARD', '',
].join('\r\n');

const VCF_CONTACTS = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN:Amore\r\nTEL;CELL:346 333 1166\r\nEND:VCARD\r\n';

function make(overrides) {
  const o = overrides || {};
  const sent = [];
  const phone = createPhone({
    helperExe: null,
    platform: o.platform || 'win32',
    broadcast: (evt, payload) => sent.push({ evt, payload }),
    getSettings: () => (o.settings || { enabled: true, ring: true, hide: true }),
    onCallState: o.onCallState,
  });
  if (o.runner !== null) {
    phone._setRunnerForTest(o.runner || (async (op) => {
      if (op === 'status') return { pbap: true, map: true, device: 'iPhone', telephony: true, canDial: true, canAnswer: false, canHangUp: false };
      if (op === 'contacts') return { vcf: VCF_CONTACTS, total: 233 };
      if (op === 'calls') return { vcf: VCF_CALLS, total: 100 };
      throw new Error('unknown_op');
    }));
  }
  return { phone, sent };
}

test('the platform is declared, not discovered', () => {
  // macOS ships a helper binary with a different set of modes, so "is the
  // helper there" answers yes and the feature would fail as though the phone
  // were unreachable. It has to say which of the two is actually missing.
  for (const platform of ['darwin', 'linux', 'freebsd']) {
    assert.ok(!SUPPORTED_PLATFORMS.has(platform), platform);
  }
  assert.ok(SUPPORTED_PLATFORMS.has('win32'));
});

test('a platform can be opened for testing without being declared shipped', () => {
  // Writing a transport and saying the platform is supported are two acts, and
  // the second belongs after somebody has watched the first work. The override
  // is what lets a Mac or a Linux box exercise the code while the shipped
  // answer everywhere else stays "not on this system yet".
  const before = process.env.XENON_PHONE_PLATFORMS;
  try {
    delete process.env.XENON_PHONE_PLATFORMS;
    assert.equal(platformAllowed('darwin'), false);
    process.env.XENON_PHONE_PLATFORMS = ' Darwin , linux ';
    assert.equal(platformAllowed('darwin'), true, 'case and spacing must not matter');
    assert.equal(platformAllowed('linux'), true);
    assert.equal(platformAllowed('freebsd'), false, 'only what was named is opened');
    process.env.XENON_PHONE_PLATFORMS = '';
    assert.equal(platformAllowed('darwin'), false);
    // Windows never depends on the override.
    assert.equal(platformAllowed('win32'), true);
  } finally {
    if (before === undefined) delete process.env.XENON_PHONE_PLATFORMS;
    else process.env.XENON_PHONE_PLATFORMS = before;
  }
});

test('off Windows it says the platform is missing, not the phone', async () => {
  for (const platform of ['darwin', 'linux']) {
    const { phone } = make({ platform });
    const st = await phone.status();
    assert.equal(st.ok, false, platform);
    assert.equal(st.reason, 'platform_unsupported', platform);
    assert.equal(st.supported, false, platform);
    phone.stop();
  }
});

test('switched off, nothing answers and nothing is read', async () => {
  const { phone } = make({ settings: { enabled: false } });
  assert.equal((await phone.status()).reason, 'disabled');
  assert.deepEqual((await phone.contacts()).list, []);
  assert.deepEqual((await phone.calls()).list, []);
  assert.equal((await phone.dial('+393331112222')).error, 'disabled');
  assert.equal((await phone.sendMessage('+393331112222', 'ciao')).error, 'disabled');
  phone.stop();
});

test('a failed refresh keeps the last good list rather than emptying the tile', async () => {
  let fail = false;
  const { phone } = make({
    runner: async (op) => {
      if (op === 'status') return { pbap: true, canDial: true };
      if (fail) throw new Error('channel_busy');
      if (op === 'calls') return { vcf: VCF_CALLS, total: 100 };
      if (op === 'contacts') return { vcf: VCF_CONTACTS, total: 233 };
      throw new Error('unknown_op');
    },
  });
  const first = await phone.calls();
  assert.equal(first.list.length, 2);
  fail = true;
  // Age the cache past the refresh floor, or the throttle (correctly) answers
  // from the cache and no read is attempted at all.
  phone._cacheForTest.calls.at = 1;
  const second = await phone.calls(true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'channel_busy');
  // An empty list would read as "you have never been called", which is a
  // different and much worse statement than "I could not reach the phone".
  assert.equal(second.list.length, 2, 'the last good list must survive a failure');
  phone.stop();
});

test('a forced refresh has a floor, so a read endpoint cannot pump the channel', async () => {
  let pulls = 0;
  const { phone } = make({
    runner: async (op) => {
      if (op === 'status') return { pbap: true };
      if (op === 'calls') { pulls++; return { vcf: VCF_CALLS, total: 100 }; }
      throw new Error('unknown_op');
    },
  });
  await phone.calls(true);
  for (let i = 0; i < 25; i++) await phone.calls(true);
  assert.equal(pulls, 1, 'a refresh loop must degrade to the cache, not to 26 Bluetooth reads');
  phone.stop();
});

test('the call log takes names from the phonebook once it is there', async () => {
  const { phone } = make();
  const before = await phone.calls();
  assert.equal(before.list[1].name, '', 'nameless before the phonebook is read');
  await phone.contacts();
  const after = await phone.calls();
  assert.equal(after.list[1].name, 'Amore', 'and named after, without waiting for the TTL');
  assert.equal(phone.resolve('+393463331166').name, 'Amore');
  phone.stop();
});

test('capabilities are reported from the helper, never assumed', async () => {
  const { phone } = make();
  assert.equal(phone.canAnswer(), false, 'before any status read');
  await phone.status();
  assert.equal(phone.canAnswer(), false);
  assert.equal(phone.canHangUp(), false);
  assert.equal(phone.deviceName(), 'iPhone');
  phone.stop();
});

test('call state is pushed on change only, and reaches the ring', async () => {
  const rings = [];
  const { phone, sent } = make({ onCallState: (s) => rings.push(s.incoming) });
  phone._setRunnerForTest(async () => ({ pbap: true, incoming: true, active: false }));
  await phone.status();
  await phone.status();          // the cache answers; no second push
  assert.deepEqual(rings, [true]);
  assert.equal(sent.filter(s => s.evt === 'phone').length, 1);
  phone.stop();
});

test('turning it off clears the live state so no card is left ringing', async () => {
  let on = true;
  const { phone, sent } = make({ settings: { get enabled() { return on; } } });
  phone._setRunnerForTest(async () => ({ pbap: true, incoming: true, active: false }));
  await phone.status();
  on = false;
  phone.applySettings();
  assert.equal(sent.at(-1).payload.incoming, false);
  phone.stop();
});

test('an unknown message folder falls back instead of reaching the phone', async () => {
  const asked = [];
  const { phone } = make({
    runner: async (op, extra) => {
      asked.push(extra && extra.folder);
      if (op === 'status') return { pbap: true, map: true };
      if (op === 'messages') return { xml: '', total: 0 };
      throw new Error('unknown_op');
    },
  });
  const r = await phone.messages('../../etc/passwd');
  assert.equal(r.folder, 'inbox');
  assert.ok(!asked.includes('../../etc/passwd'), 'a folder name from the wire never travels');
  phone.stop();
});

test('sending validates the number and the length before the phone sees either', async () => {
  let sends = 0;
  const { phone } = make({
    runner: async (op) => {
      if (op === 'status') return { pbap: true, map: true };
      if (op === 'send') { sends++; return { ok: true }; }
      throw new Error('unknown_op');
    },
  });
  assert.equal((await phone.sendMessage('chiama la mamma', 'ciao')).error, 'bad_number');
  assert.equal((await phone.sendMessage('+393331112222', '   ')).error, 'empty_message');
  assert.equal((await phone.sendMessage('+393331112222', 'x'.repeat(2000))).error, 'message_too_long');
  assert.equal(sends, 0, 'none of those should have reached the phone');
  assert.equal((await phone.sendMessage('+39 333 111 2222', 'ciao')).ok, true);
  assert.equal(sends, 1);
  phone.stop();
});
