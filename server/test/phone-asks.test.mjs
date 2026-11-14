// What the paired phone is asked to do, and what is refused before it is asked: a call is
// answered or ended only when the phone said it can, a number that is dialled is a number and
// nothing else, and the handle of a message is short and plain. Without a helper or a phone:
// the test seam stands in for the whole round trip and records what it was asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPhone } = require('../phone.js');

const BMSG = 'BEGIN:BMSG\r\nVERSION:1.0\r\nTYPE:SMS_GSM\r\n'
  + 'BEGIN:VCARD\r\nFN:Tester\r\nEND:VCARD\r\n'
  + 'BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:4\r\n'
  + 'BEGIN:MSG\r\nA whole message\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n';

function make({ can = {}, enabled = true, fail = '' } = {}) {
  const asked = [];
  const phone = createPhone({
    helperExe: null,
    platform: 'win32',
    broadcast: () => {},
    getSettings: () => ({ enabled, ring: true, hide: true }),
  });
  phone._setRunnerForTest(async (op, extra) => {
    asked.push([op, extra]);
    if (op === 'status') return { pbap: true, map: true, device: 'Phone', telephony: true, canDial: true, canAnswer: false, canHangUp: false, ...can };
    if (fail) throw new Error(fail);
    if (op === 'message') return { bmsg: BMSG };
    return {};
  });
  return { phone, asked };
}
const opsOf = (asked) => asked.map(([op]) => op);

test('a call is answered or ended only when the phone said it can', async () => {
  const no = make();
  await no.phone.status();
  assert.deepEqual([no.phone.canAnswer(), no.phone.canHangUp(), no.phone.canDial()], [false, false, true]);
  assert.deepEqual(await no.phone.answer(), { ok: false, error: 'unavailable' });
  assert.deepEqual(await no.phone.hangUp(), { ok: false, error: 'unavailable' });
  assert.deepEqual(opsOf(no.asked), ['status'], 'a refusal asks the phone nothing');

  const yes = make({ can: { canAnswer: true, canHangUp: true } });
  assert.deepEqual(await yes.phone.answer(), { ok: false, error: 'unavailable' }, 'before the phone was read, nothing is assumed');
  await yes.phone.status();
  assert.deepEqual([yes.phone.canAnswer(), yes.phone.canHangUp(), yes.phone.deviceName()], [true, true, 'Phone']);
  assert.deepEqual(await yes.phone.answer(), { ok: true });
  assert.deepEqual(await yes.phone.hangUp(), { ok: true });
  assert.deepEqual(yes.asked.slice(1), [['answer', {}], ['hangup', {}]]);
});

test('what is dialled is a number and nothing else', async () => {
  const { phone, asked } = make();
  for (const bad of ['', 'call me', '+39 333; rm', 'tel:+393331230166', '()', '1'.repeat(40)]) {
    assert.deepEqual(await phone.dial(bad), { ok: false, error: 'bad_number' }, bad);
  }
  assert.deepEqual(asked, [], 'a refused number never reaches the phone');
  assert.deepEqual(await phone.dial('+39 333 123-0166'), { ok: true, number: '+393331230166' });
  assert.deepEqual(asked, [['dial', { number: '+393331230166' }]]);
});

test('the handle of a message is short and plain, and the folder is one the phone has', async () => {
  const { phone, asked } = make();
  for (const bad of ['', '   ', null, 'a b', 'a"b', "a'b", 'a`b', 'a\\b', '../x', 'x'.repeat(257)]) {
    assert.deepEqual(await phone.message('inbox', bad), { ok: false, reason: 'bad_handle' }, String(bad));
  }
  assert.deepEqual(asked, [], 'a refused handle never reaches the phone');
  const read = await phone.message('somewhere', ' 1000000000000A1 ');
  assert.deepEqual([read.ok, read.folder, read.handle, read.message.name, read.message.body], [true, 'inbox', '1000000000000A1', 'Tester', 'A whole message']);
  assert.deepEqual(asked, [['message', { folder: 'inbox', handle: '1000000000000A1' }]]);
  assert.equal((await phone.message('sent', '1000000000000A1')).folder, 'sent');
});

test('switched off, nothing is asked; and what the phone refuses is said in its own word', async () => {
  const off = make({ enabled: false });
  assert.deepEqual(await off.phone.dial('+393331230166'), { ok: false, error: 'disabled' });
  assert.deepEqual(await off.phone.answer(), { ok: false, error: 'disabled' });
  assert.deepEqual(await off.phone.hangUp(), { ok: false, error: 'disabled' });
  assert.deepEqual(await off.phone.message('inbox', '1000000000000A1'), { ok: false, reason: 'disabled' });
  assert.deepEqual(off.asked, []);

  const broken = make({ can: { canAnswer: true, canHangUp: true }, fail: 'no_link' });
  await broken.phone.status();
  assert.deepEqual(await broken.phone.dial('+393331230166'), { ok: false, error: 'no_link' });
  assert.deepEqual(await broken.phone.answer(), { ok: false, error: 'no_link' });
  assert.deepEqual(await broken.phone.hangUp(), { ok: false, error: 'no_link' });
  assert.deepEqual(await broken.phone.message('inbox', '1000000000000A1'), { ok: false, reason: 'no_link' });
});

test('contacts come back by name, the ones without a name last', async () => {
  const { phone } = make();
  const vcf = ['Zeno', '', 'anna', 'Bruno'].map((name, at) => `BEGIN:VCARD\r\nVERSION:2.1\r\nFN:${name}\r\nTEL;CELL:333 123 01${60 + at}\r\nEND:VCARD\r\n`).join('');
  phone._setRunnerForTest(async (op) => (op === 'contacts' ? { vcf, total: 4 } : {}));
  const got = await phone.contacts(true);
  assert.equal(got.ok, true);
  assert.deepEqual(got.list.map((row) => row.name || ''), ['anna', 'Bruno', 'Zeno', '']);
});
