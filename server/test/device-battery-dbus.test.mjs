// The small D-Bus client: a fake bus on TCP stands in for the system socket, speaking the wire
// format byte by byte. `start.mjs airpods` in tools/linux-rgb-vm runs it against a real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { connectSystemBus, stringDictionary, decodeMessage, socketOptions } = require('../device-battery/dbus-client.js');

const pad = (bytes, to) => { while (bytes.length % to) bytes.push(0); };
const u32 = (bytes, value) => { pad(bytes, 4); const b = Buffer.alloc(4); b.writeUInt32LE(value); bytes.push(...b); };

// A reply or error for `serial`, with a body already encoded.
function reply(serial, { type = 2, signature = '', body = [], error = '' } = {}) {
  const fields = [];
  pad(fields, 8);
  fields.push(5, 1, 0x75, 0);
  u32(fields, serial);
  if (signature) {
    pad(fields, 8);
    fields.push(8, 1, 0x67, 0, signature.length, ...Buffer.from(signature), 0);
  }
  if (error) {
    pad(fields, 8);
    fields.push(4, 1, 0x73, 0);
    u32(fields, error.length);
    fields.push(...Buffer.from(error), 0);
  }
  const header = [0x6c, type, 0, 1];
  u32(header, body.length);
  u32(header, 900 + serial);
  u32(header, fields.length);
  header.push(...fields);
  pad(header, 8);
  return Buffer.from([...header, ...body]);
}

// Answers Hello, then whatever `answer` says for each call, in order of serial.
async function fakeBus(answer, { authentication = 'OK 1234\r\n' } = {}) {
  const seen = [];
  const server = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    let begun = false;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!begun) {
        const text = buffered.toString('latin1');
        if (text.includes('AUTH EXTERNAL') && !text.includes('BEGIN\r\n')) {
          seen.push(text.trim());
          buffered = Buffer.alloc(0);
          socket.write(authentication);
          return;
        }
        const end = text.indexOf('BEGIN\r\n');
        if (end < 0) return;
        buffered = buffered.subarray(end + 7);
        begun = true;
      }
      while (buffered.length >= 16) {
        const size = Math.ceil((16 + buffered.readUInt32LE(12)) / 8) * 8 + buffered.readUInt32LE(4);
        if (buffered.length < size) return;
        const serial = buffered.readUInt32LE(8);
        seen.push(buffered.subarray(0, size));
        buffered = buffered.subarray(size);
        const answered = serial === 1 ? reply(1, { signature: 's', body: [2, 0, 0, 0, 0x3a, 0x31, 0] }) : answer(serial);
        if (answered) socket.write(answered);
      }
    });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  return { seen, options: { host: '127.0.0.1', port: server.address().port }, close: () => server.close() };
}

test('it says who it is, greets the bus, and a call gets its answer', async () => {
  const fake = await fakeBus((serial) => reply(serial, { signature: 'u', body: [7, 0, 0, 0] }));
  const bus = await connectSystemBus({ options: fake.options, uid: 1000 });
  assert.equal(await bus.call({ destination: 'org.bluez', path: '/', iface: 'x.y', member: 'Go' }), 7);
  assert.match(fake.seen[0], /AUTH EXTERNAL 31303030$/);   // "1000" in hex
  bus.close();
  fake.close();
});

test('an error from the bus rejects with its name', async () => {
  const fake = await fakeBus((serial) => reply(serial, { type: 3, error: 'org.bluez.Error.NotReady' }));
  const bus = await connectSystemBus({ options: fake.options, uid: 1000 });
  await assert.rejects(bus.call({ destination: 'd', path: '/', member: 'Go' }), /NotReady/);
  bus.close();
  fake.close();
});

test('no answer in time rejects, and a refused user never connects', async () => {
  const silent = await fakeBus(() => null);
  const bus = await connectSystemBus({ options: silent.options, uid: 1000, limitMs: 50 });
  await assert.rejects(bus.call({ destination: 'd', path: '/', member: 'Go' }), /timed out/);
  bus.close();
  silent.close();
  const refusing = await fakeBus(() => null, { authentication: 'REJECTED EXTERNAL\r\n' });
  await assert.rejects(connectSystemBus({ options: refusing.options, uid: 1000 }));
  refusing.close();
});

test('nothing listening rejects', async () => {
  await assert.rejects(connectSystemBus({ options: { host: '127.0.0.1', port: 1 } }));
});

test('a message split in two reads, and what is sent is well formed', async () => {
  const split = await fakeBus((serial) => reply(serial, { signature: 'u', body: [9, 0, 0, 0] }));
  const bus = await connectSystemBus({ options: split.options, uid: 1000 });
  const body = stringDictionary({ Transport: 'le' });
  await bus.call({ destination: 'org.bluez', path: '/org/bluez/hci0', iface: 'org.bluez.Adapter1', member: 'SetDiscoveryFilter', signature: 'a{sv}', body });
  const sent = decodeMessage(split.seen.at(-1));
  assert.deepEqual(sent.body, [{ Transport: 'le' }]);
  bus.close();
  split.close();
});

test('BlueZ shapes decode: a dictionary with number keys, variants, bytes and a negative RSSI', () => {
  const body = [];
  // a{sv} = { RSSI: n -50, ManufacturerData: a{qv} { 76: ay [7, 25] } }
  const dictionary = [];
  const entry = (key, write) => {
    pad(dictionary, 8);
    u32(dictionary, key.length);
    dictionary.push(...Buffer.from(key), 0);
    write();
  };
  entry('RSSI', () => {
    dictionary.push(1, 0x6e, 0);
    pad(dictionary, 2);
    dictionary.push(0xce, 0xff);
  });
  entry('ManufacturerData', () => {
    const signature = 'a{qv}';
    dictionary.push(signature.length, ...Buffer.from(signature), 0);
    // Inner array: length, then one entry at an 8 boundary.
    pad(dictionary, 4);
    const lengthAt = dictionary.length;
    dictionary.push(0, 0, 0, 0);
    pad(dictionary, 8);
    const start = dictionary.length;
    dictionary.push(76, 0, 2, 0x61, 0x79, 0);
    pad(dictionary, 4);
    dictionary.push(2, 0, 0, 0, 7, 25);
    dictionary[lengthAt] = dictionary.length - start;
  });
  u32(body, dictionary.length);
  pad(body, 8);
  const shift = body.length;
  assert.equal(shift % 8, 0);
  body.push(...dictionary);
  const [decoded] = decodeMessage(reply(1, { signature: 'a{sv}', body })).body;
  assert.deepEqual(decoded, { RSSI: -50, ManufacturerData: { 76: [7, 25] } });
});

test('nonsense from the bus throws instead of reading past the end', () => {
  const body = [255, 255, 255, 0];
  assert.throws(() => decodeMessage(reply(1, { signature: 'as', body })));
});

test('the socket comes from the environment when it names one', () => {
  assert.deepEqual(socketOptions({}), { path: '/run/dbus/system_bus_socket' });
  assert.deepEqual(socketOptions({ DBUS_SYSTEM_BUS_ADDRESS: 'unix:path=/tmp/bus,guid=1' }), { path: '/tmp/bus' });
  assert.deepEqual(socketOptions({ DBUS_SYSTEM_BUS_ADDRESS: 'tcp:host=x' }), { path: '/run/dbus/system_bus_socket' });
});
