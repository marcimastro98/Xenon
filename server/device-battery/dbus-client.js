'use strict';
// Just enough of the D-Bus wire protocol to call BlueZ on the system bus. The command-line
// tools will not do: `busctl --json` gives up on the whole reply as soon as any device nearby
// has ManufacturerData (a dictionary with number keys), and bluetoothctl changes between BlueZ
// releases and is a separate package on some distributions. Closing the socket also ends
// whatever the connection started, so a reader killed halfway leaves no scan behind.

const net = require('net');

const DEFAULT_SOCKET = '/run/dbus/system_bus_socket';
const ADDRESS_PREFIX = 'unix:path=';
const CALL_LIMIT_MS = 5000;
const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 64;
const FIXED_HEADER_BYTES = 16;
const TYPE_RETURN = 2;
const TYPE_ERROR = 3;
const FIELD = { path: 1, interface: 2, member: 3, error: 4, replySerial: 5, destination: 6, signature: 8 };
const ALIGNMENT = { y: 1, g: 1, v: 1, n: 2, q: 2, b: 4, i: 4, u: 4, h: 4, s: 4, o: 4, a: 4, x: 8, t: 8, d: 8, '(': 8, '{': 8 };

const alignUp = (value, to) => Math.ceil(value / to) * to;

function parseType(text, at) {
  const code = text[at.index];
  at.index += 1;
  if (code === 'a') return { code, item: parseType(text, at) };
  if (code !== '(' && code !== '{') return { code };
  const end = code === '(' ? ')' : '}';
  const fields = [];
  while (text[at.index] !== end) {
    if (at.index >= text.length) throw new Error('bad signature');
    fields.push(parseType(text, at));
  }
  at.index += 1;
  return { code, fields };
}

function parseSignature(text) {
  const at = { index: 0 };
  const types = [];
  while (at.index < text.length) types.push(parseType(text, at));
  return types;
}

class Reader {
  constructor(buffer, littleEndian) {
    this.buffer = buffer;
    this.littleEndian = littleEndian;
    this.position = 0;
  }

  number(method, bytes) {
    const value = this.buffer[`${method}${bytes > 1 ? (this.littleEndian ? 'LE' : 'BE') : ''}`](this.position);
    this.position += bytes;
    return value;
  }

  text(length) {
    const value = this.buffer.toString('utf8', this.position, this.position + length);
    this.position += length + 1;   // and its NUL
    return value;
  }

  array(type, depth) {
    const bytes = this.number('readUInt32', 4);
    this.position = alignUp(this.position, ALIGNMENT[type.item.code]);
    const end = this.position + bytes;
    if (end > this.buffer.length) throw new Error('array past the end');
    const isDictionary = type.item.code === '{';
    const result = isDictionary ? {} : [];
    while (this.position < end) {
      const item = this.value(type.item, depth + 1);
      if (isDictionary) result[item[0]] = item[1];
      else result.push(item);
    }
    return result;
  }

  variant(depth) {
    const [type] = parseSignature(this.text(this.number('readUInt8', 1)));
    return this.value(type, depth + 1);
  }

  value(type, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('nested too deep');
    this.position = alignUp(this.position, ALIGNMENT[type.code] ?? 1);
    switch (type.code) {
      case 'y': return this.number('readUInt8', 1);
      case 'b': return this.number('readUInt32', 4) !== 0;
      case 'n': return this.number('readInt16', 2);
      case 'q': return this.number('readUInt16', 2);
      case 'i': return this.number('readInt32', 4);
      case 'u': case 'h': return this.number('readUInt32', 4);
      case 'x': return Number(this.number('readBigInt64', 8));
      case 't': return Number(this.number('readBigUInt64', 8));
      case 'd': return this.number('readDouble', 8);
      case 's': case 'o': return this.text(this.number('readUInt32', 4));
      case 'g': return this.text(this.number('readUInt8', 1));
      case 'v': return this.variant(depth);
      case 'a': return this.array(type, depth);
      case '(': case '{': return type.fields.map((field) => this.value(field, depth + 1));
      default: throw new Error(`unknown type ${type.code}`);
    }
  }
}

// How long the message starting this buffer is, or null while its fixed header is not all here.
function messageLength(buffer) {
  if (buffer.length < FIXED_HEADER_BYTES) return null;
  const littleEndian = buffer[0] === 0x6c;
  const body = littleEndian ? buffer.readUInt32LE(4) : buffer.readUInt32BE(4);
  const fields = littleEndian ? buffer.readUInt32LE(12) : buffer.readUInt32BE(12);
  return alignUp(FIXED_HEADER_BYTES + fields, 8) + body;
}

function decodeMessage(buffer) {
  const reader = new Reader(buffer, buffer[0] === 0x6c);
  reader.position = 12;
  const list = reader.value({ code: 'a', item: { code: '(', fields: [{ code: 'y' }, { code: 'v' }] } });
  const fields = new Map(list);
  reader.position = alignUp(reader.position, 8);
  const body = parseSignature(fields.get(FIELD.signature) || '').map((type) => reader.value(type));
  return { type: buffer[1], replySerial: fields.get(FIELD.replySerial), error: fields.get(FIELD.error), body };
}

class Writer {
  constructor() {
    this.bytes = [];
  }

  align(to) {
    while (this.bytes.length % to) this.bytes.push(0);
  }

  uint32(value) {
    this.align(4);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value);
    this.bytes.push(...buffer);
  }

  text(value) {
    const encoded = Buffer.from(value, 'utf8');
    this.uint32(encoded.length);
    this.bytes.push(...encoded, 0);
  }

  signature(value) {
    this.bytes.push(value.length, ...Buffer.from(value, 'ascii'), 0);
  }

  field(code, signature, value) {
    this.align(8);
    this.bytes.push(code);
    this.signature(signature);
    if (signature === 'g') this.signature(value);
    else this.text(value);
  }
}

// An a{sv} of strings: the only argument anything here sends.
function stringDictionary(entries) {
  const items = new Writer();
  for (const [key, value] of Object.entries(entries)) {
    items.align(8);
    items.text(key);
    items.signature('s');
    items.text(value);
  }
  const out = new Writer();
  out.uint32(items.bytes.length);
  out.align(8);
  out.bytes.push(...items.bytes);
  return Buffer.from(out.bytes);
}

function encodeCall(serial, { destination, path, iface, member, signature, body = Buffer.alloc(0) }) {
  const fields = new Writer();
  fields.field(FIELD.path, 'o', path);
  if (iface) fields.field(FIELD.interface, 's', iface);
  fields.field(FIELD.member, 's', member);
  fields.field(FIELD.destination, 's', destination);
  if (signature) fields.field(FIELD.signature, 'g', signature);
  const header = new Writer();
  header.bytes.push(0x6c, 1, 0, 1);
  header.uint32(body.length);
  header.uint32(serial);
  header.uint32(fields.bytes.length);
  header.bytes.push(...fields.bytes);
  header.align(8);
  return Buffer.concat([Buffer.from(header.bytes), body]);
}

function socketOptions(env = process.env) {
  const address = (env.DBUS_SYSTEM_BUS_ADDRESS || '').split(';').find((entry) => entry.startsWith(ADDRESS_PREFIX));
  return { path: address ? address.slice(ADDRESS_PREFIX.length).split(',')[0] : DEFAULT_SOCKET };
}

function connectSystemBus({ options = socketOptions(), uid = process.getuid?.() ?? 0, limitMs = CALL_LIMIT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(options);
    const pending = new Map();
    let received = Buffer.alloc(0);
    let authenticated = false;
    let serial = 0;

    const failAll = (error) => {
      for (const { fail } of pending.values()) fail(error);
      reject(error);
    };

    function call(request) {
      return new Promise((done, fail) => {
        serial += 1;
        const id = serial;
        const timer = setTimeout(() => {
          pending.delete(id);
          fail(new Error(`${request.member} timed out`));
        }, limitMs);
        pending.set(id, {
          done: (value) => { clearTimeout(timer); done(value); },
          fail: (error) => { clearTimeout(timer); fail(error); },
        });
        socket.write(encodeCall(id, request));
      });
    }

    function deliver(message) {
      const waiting = pending.get(message.replySerial);
      if (!waiting || (message.type !== TYPE_RETURN && message.type !== TYPE_ERROR)) return;
      pending.delete(message.replySerial);
      if (message.type === TYPE_ERROR) waiting.fail(new Error(message.error || 'D-Bus error'));
      else waiting.done(message.body[0]);
    }

    function readMessages() {
      for (;;) {
        const length = messageLength(received);
        if (length === null || received.length < length) return;
        if (length > MAX_MESSAGE_BYTES) throw new Error('message too long');
        deliver(decodeMessage(received.subarray(0, length)));
        received = received.subarray(length);
      }
    }

    function readAuthentication() {
      const end = received.indexOf('\r\n');
      if (end < 0) return;
      const line = received.toString('ascii', 0, end);
      received = received.subarray(end + 2);
      if (!line.startsWith('OK')) throw new Error('the bus refused this user');
      authenticated = true;
      socket.write('BEGIN\r\n');
      call({ destination: 'org.freedesktop.DBus', path: '/org/freedesktop/DBus', iface: 'org.freedesktop.DBus', member: 'Hello' })
        .then(() => resolve({ call, close: () => socket.destroy() }), reject);
    }

    socket.once('connect', () => {
      socket.write(`\0AUTH EXTERNAL ${Buffer.from(String(uid), 'ascii').toString('hex')}\r\n`);
    });
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      try {
        if (!authenticated) readAuthentication();
        if (authenticated) readMessages();
      } catch (error) {
        socket.destroy(error);
      }
    });
    socket.once('error', failAll);
    socket.once('close', () => failAll(new Error('the bus closed the connection')));
  });
}

module.exports = { connectSystemBus, stringDictionary, decodeMessage, socketOptions };
