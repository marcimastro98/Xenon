import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lp = require('../linux-phone.js');

// Only the parsing and the choosing are testable off Linux, so that is where
// the weight goes — and it is the right place: the D-Bus calls are one line
// each, while WHICH device and WHICH modem get picked is the part that decides
// whether the feature talks to the user's phone or to something else.
//
// The busctl shapes below are what this was written against. They are also the
// thing most likely to differ on a distro nobody tried, which is why the value
// reader is deliberately tolerant and why its fallbacks are tested too.

const OBJECTS = JSON.stringify({
  type: 'a{oa{sa{sv}}}',
  data: [{
    '/org/bluez/hci0/dev_5C_13_CC_F1_8B_FF': {
      'org.bluez.Device1': {
        Address: { type: 's', data: '5C:13:CC:F1:8B:FF' },
        Alias: { type: 's', data: 'iPhone' },
        Connected: { type: 'b', data: true },
        UUIDs: { type: 'as', data: ['0000112f-0000-1000-8000-00805f9b34fb', '00001132-0000-1000-8000-00805f9b34fb'] },
      },
    },
    '/org/bluez/hci0/dev_84_D3_52_AF_16_04': {
      'org.bluez.Device1': {
        Address: { type: 's', data: '84:D3:52:AF:16:04' },
        Alias: { type: 's', data: 'SRS-XB100' },
        Connected: { type: 'b', data: true },
        UUIDs: { type: 'as', data: ['0000110b-0000-1000-8000-00805f9b34fb'] },
      },
    },
    '/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF': {
      'org.bluez.Device1': {
        Address: { type: 's', data: 'AA:BB:CC:DD:EE:FF' },
        Alias: { type: 's', data: 'Vecchio telefono' },
        Connected: { type: 'b', data: false },
        UUIDs: { type: 'as', data: ['0000112f-0000-1000-8000-00805f9b34fb'] },
      },
    },
  }],
});

const MODEMS = JSON.stringify({
  type: 'a(oa{sv})',
  data: [[
    ['/hfp/org/bluez/hci0/dev_5C_13_CC_F1_8B_FF', {
      Name: { type: 's', data: 'iPhone' },
      Type: { type: 's', data: 'hfp' },
      Online: { type: 'b', data: true },
      Powered: { type: 'b', data: true },
      Interfaces: { type: 'as', data: ['org.ofono.VoiceCallManager', 'org.ofono.Handsfree'] },
    }],
  ]],
});

const ringing = (state) => JSON.stringify({
  type: 'a(oa{sv})',
  data: [[
    ['/hfp/modem0/voicecall01', {
      State: { type: 's', data: state },
      LineIdentification: { type: 's', data: '+393463331166' },
      Name: { type: 's', data: 'Amore' },
    }],
  ]],
});

test('the phone is the connected device that publishes a phonebook', () => {
  const devices = lp.parseManagedObjects(OBJECTS);
  assert.equal(devices.length, 3);
  const phone = lp.pickPhone(devices, lp.PBAP_UUID);
  assert.equal(phone.name, 'iPhone');
  assert.equal(phone.address, '5C:13:CC:F1:8B:FF');
});

test('a speaker is never mistaken for a phone', () => {
  const devices = lp.parseManagedObjects(OBJECTS).filter(d => d.name === 'SRS-XB100');
  assert.equal(lp.pickPhone(devices, lp.PBAP_UUID), null);
});

test('a connected phone wins over a paired one that is out of range', () => {
  // Both publish the same UUIDs; only one can actually answer.
  const devices = lp.parseManagedObjects(OBJECTS);
  assert.equal(lp.pickPhone(devices, lp.PBAP_UUID).name, 'iPhone');
  const away = devices.filter(d => !d.connected);
  assert.equal(lp.pickPhone(away, lp.PBAP_UUID).name, 'Vecchio telefono',
    'with nothing connected, the paired one is still the right answer to try');
});

test('the handsfree modem is the paired phone, not a cellular card', () => {
  const modems = lp.parseModems(MODEMS);
  assert.equal(modems.length, 1);
  assert.equal(lp.pickModem(modems).path, '/hfp/org/bluez/hci0/dev_5C_13_CC_F1_8B_FF');
});

test('a modem with no VoiceCallManager is not usable', () => {
  const bare = JSON.stringify({ data: [[['/modem0', { Powered: { data: true }, Interfaces: { data: ['org.ofono.SimManager'] } }]]] });
  assert.equal(lp.pickModem(lp.parseModems(bare)), null);
});

test('an unpowered modem is refused rather than dialled through', () => {
  const off = JSON.stringify({ data: [[['/modem0', { Powered: { data: false }, Interfaces: { data: ['org.ofono.VoiceCallManager'] } }]]] });
  assert.equal(lp.pickModem(lp.parseModems(off)), null);
});

test('incoming and waiting ring; dialling out does not', () => {
  // A call we placed ourselves must never raise the card at the user.
  for (const state of ['incoming', 'waiting']) {
    const s = lp.callState(lp.parseCalls(ringing(state)));
    assert.equal(s.incoming, true, state);
    assert.equal(s.ringingPath, '/hfp/modem0/voicecall01', state);
    assert.equal(s.caller, 'Amore', 'ofono knows who is calling, unlike the Windows signal');
  }
  for (const state of ['dialing', 'alerting', 'active', 'held']) {
    const s = lp.callState(lp.parseCalls(ringing(state)));
    assert.equal(s.incoming, false, state);
    assert.equal(s.active, true, state);
  }
});

test('no calls is a quiet state, not an error', () => {
  const s = lp.callState(lp.parseCalls(JSON.stringify({ data: [[]] })));
  assert.deepEqual(s, { incoming: false, active: false, ringingPath: '', caller: '' });
});

test('the caller falls back to the number when the phone sent no name', () => {
  const anon = JSON.stringify({ data: [[['/c1', { State: { data: 'incoming' }, LineIdentification: { data: '+393287248309' } }]]] });
  assert.equal(lp.callState(lp.parseCalls(anon)).caller, '+393287248309');
});

test('the value reader survives the shapes busctl has actually printed', () => {
  // One element unwrapped from its array…
  assert.equal(lp.dbusValue('{"type":"o","data":["/org/bluez/obex/client/session0"]}'), '/org/bluez/obex/client/session0');
  // …a scalar left alone…
  assert.equal(lp.dbusValue('{"type":"s","data":"complete"}'), 'complete');
  // …and the plain, non-JSON rendering busctl uses without --json at all.
  assert.equal(lp.dbusValue('o "/org/bluez/obex/client/session0"'), '/org/bluez/obex/client/session0');
  assert.equal(lp.dbusValue('s "complete"'), 'complete');
  assert.equal(lp.dbusValue(''), null);
  assert.equal(lp.dbusValue(null), null);
});

test('an object path is found wherever busctl put it', () => {
  assert.equal(lp.firstObjectPath('{"data":["/org/bluez/obex/session0/transfer0",{}]}'), '/org/bluez/obex/session0/transfer0');
  assert.equal(lp.firstObjectPath('o "/t1" a{sv} 0'), '/t1');
  assert.equal(lp.firstObjectPath('niente'), '');
});

test('a D-Bus error keeps its short name, which is the part a user can act on', () => {
  // Forbidden is the one that means "grant this pairing access on the phone",
  // which is a thing the user can go and do.
  assert.equal(lp.dbusErrorName('Call failed: org.bluez.obex.Error.Forbidden: not authorized'), 'forbidden');
  assert.equal(lp.dbusErrorName('org.freedesktop.DBus.Error.ServiceUnknown: no such service'), 'serviceunknown');
  assert.equal(lp.dbusErrorName('qualcosa di illeggibile'), 'dbus_failed');
  assert.equal(lp.dbusErrorName(''), 'dbus_failed');
});

test('junk from busctl produces empty lists, never a throw', () => {
  for (const junk of ['', 'not json', '{}', '{"data":null}', null, undefined]) {
    assert.deepEqual(lp.parseManagedObjects(junk), []);
    assert.deepEqual(lp.parseModems(junk), []);
    assert.deepEqual(lp.parseCalls(junk), []);
  }
});

test('the transport answers the ops it has and refuses the ones it does not', async () => {
  const seen = [];
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      seen.push(args.join(' '));
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: OBJECTS, err: '' };
      if (line.includes('GetModems')) return { ok: true, out: MODEMS, err: '' };
      if (line.includes('GetCalls')) return { ok: true, out: ringing('incoming'), err: '' };
      if (line.includes('VoiceCall Answer')) return { ok: true, out: '', err: '' };
      return { ok: true, out: '', err: '' };
    },
  });

  const st = await t.request('status', {});
  assert.equal(st.pbap, true);
  assert.equal(st.device, 'iPhone');
  assert.equal(st.canDial, true);
  // The reason this platform was worth doing first.
  assert.equal(st.canAnswer, true);
  // The fixture phone publishes MAP, and the capability is read off the device
  // rather than declared, so it follows what the phone actually offers.
  assert.equal(st.map, true);

  const answered = await t.request('answer', {});
  assert.equal(answered.ok, true);
  assert.ok(seen.some(s => s.includes('/hfp/modem0/voicecall01 org.ofono.VoiceCall Answer')),
    'Answer must be sent to the RINGING call object, not to the modem');

  await assert.rejects(() => t.request('nonsense', {}), /unknown_op/);
  t.stop();
});

test('a phone with no message server reports map:false rather than failing later', async () => {
  const noMap = JSON.stringify({
    data: [{
      '/org/bluez/hci0/dev_X': {
        'org.bluez.Device1': {
          Address: { data: '11:22:33:44:55:66' },
          Alias: { data: 'Telefono base' },
          Connected: { data: true },
          UUIDs: { data: [lp.PBAP_UUID] },
        },
      },
    }],
  });
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: noMap, err: '' };
      if (line.includes('GetModems')) return { ok: true, out: MODEMS, err: '' };
      return { ok: true, out: JSON.stringify({ data: [[]] }), err: '' };
    },
  });
  const st = await t.request('status', {});
  assert.equal(st.pbap, true, 'the phonebook still works');
  assert.equal(st.map, false, 'and the widget hides the tab instead of offering it');
  await assert.rejects(() => t.request('messages', {}), /no_paired_messages/);
  t.stop();
});

test('a message handle is re-resolved against a fresh listing, never trusted', async () => {
  const rows = JSON.stringify({ data: [[['/org/bluez/obex/client/session0/message0', {}]]] });
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: OBJECTS, err: '' };
      if (line.includes('CreateSession')) return { ok: true, out: '{"data":["/org/bluez/obex/client/session0"]}', err: '' };
      if (line.includes('ListMessages')) return { ok: true, out: rows, err: '' };
      return { ok: true, out: '', err: '' };
    },
    readFile: async () => 'BEGIN:BMSG\r\nEND:BMSG\r\n',
  });
  // An object path D-Bus would happily call a method on, that this listing did
  // not produce, is refused before it reaches the bus.
  await assert.rejects(
    () => t.request('message', { folder: 'inbox', handle: '/org/freedesktop/systemd1' }),
    /bad_handle/);
  const ok = await t.request('message', { folder: 'inbox', handle: '/org/bluez/obex/client/session0/message0' });
  assert.match(ok.bmsg, /BEGIN:BMSG/);
  t.stop();
});

test('an unknown message folder never becomes a SetFolder on the phone', async () => {
  const seen = [];
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      seen.push(args.join(' '));
      const line = args.join(' ');
      if (line.includes('GetManagedObjects')) return { ok: true, out: OBJECTS, err: '' };
      if (line.includes('CreateSession')) return { ok: true, out: '{"data":["/s0"]}', err: '' };
      if (line.includes('ListMessages')) return { ok: true, out: JSON.stringify({ data: [[]] }), err: '' };
      return { ok: true, out: '', err: '' };
    },
  });
  const r = await t.request('messages', { folder: '../../etc/passwd' });
  assert.equal(r.folder, 'inbox');
  assert.ok(!seen.some(s => s.includes('passwd')), 'a folder name from the wire never travels');
  assert.ok(seen.some(s => s.includes('SetFolder s inbox')), 'and the allowlisted path is walked instead');
  t.stop();
});

test('answering with nothing ringing says so instead of hanging up on somebody', async () => {
  const t = lp.createLinuxPhone({
    busctl: async (args) => {
      const line = args.join(' ');
      if (line.includes('GetModems')) return { ok: true, out: MODEMS, err: '' };
      if (line.includes('GetCalls')) return { ok: true, out: JSON.stringify({ data: [[]] }), err: '' };
      return { ok: true, out: '', err: '' };
    },
  });
  await assert.rejects(() => t.request('answer', {}), /nothing_ringing/);
  t.stop();
});
