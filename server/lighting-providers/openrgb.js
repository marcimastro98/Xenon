'use strict';
// OpenRGB provider — drives every controller exposed by an OpenRGB SDK server over
// its binary TCP protocol (default port 6742). This covers most non-Corsair PC RGB
// (ASUS Aura, MSI, Gigabyte, Razer, RAM, motherboards, …) through one app.
//
// No dependencies (Node's built-in `net`). One persistent connection per host is
// kept while painting and dropped on release, so idle cost is zero. A whole OpenRGB
// server is modelled as a single "device": one uniform colour is fanned to all of
// its controllers, matching the "light up all my PC RGB" use case.

const net = require('net');

const meta = {
  id: 'openrgb',
  name: 'OpenRGB',
  type: 'lan',
  maxHz: 20,
  needsPairing: false,
  download: 'https://openrgb.org/',
};

// Packet IDs (OpenRGB NetworkProtocol).
const PKT = {
  SET_CLIENT_NAME: 50,
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  REQUEST_PROTOCOL_VERSION: 40,
  RGBCONTROLLER_UPDATELEDS: 1050,
  RGBCONTROLLER_SETCUSTOMMODE: 1100,
};
const CLIENT_PROTOCOL = 4;
const DEFAULT_PORT = 6742;

function splitHostPort(host) {
  const s = String(host || '').trim();
  const m = s.match(/^(.+):(\d+)$/);
  return m ? { ip: m[1], port: Number(m[2]) } : { ip: s, port: DEFAULT_PORT };
}

function header(deviceId, packetId, dataLen) {
  const h = Buffer.alloc(16);
  h.write('ORGB', 0, 'ascii');
  h.writeUInt32LE(deviceId >>> 0, 4);
  h.writeUInt32LE(packetId >>> 0, 8);
  h.writeUInt32LE(dataLen >>> 0, 12);
  return h;
}

// One live SDK connection. Serialises request→response (we await each request,
// so the next inbound packet is always its reply).
class Client {
  constructor(ip, port) {
    this.ip = ip; this.port = port;
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.controllers = [];   // [{ index, numLeds }]
    this.proto = CLIENT_PROTOCOL;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.ip, port: this.port });
      sock.setNoDelay(true);
      const onErr = (e) => { sock.destroy(); reject(e); };
      sock.once('error', onErr);
      sock.setTimeout(2500, () => onErr(new Error('timeout')));
      sock.once('connect', () => {
        sock.setTimeout(0);
        sock.removeListener('error', onErr);
        sock.on('error', () => this.close());
        sock.on('close', () => this.close());
        sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this._drain(); });
        this.sock = sock;
        resolve();
      });
    });
  }

  _drain() {
    while (this.buf.length >= 16) {
      if (this.buf.toString('ascii', 0, 4) !== 'ORGB') { this.buf = Buffer.alloc(0); break; }
      const len = this.buf.readUInt32LE(12);
      if (this.buf.length < 16 + len) break;
      const data = this.buf.slice(16, 16 + len);
      this.buf = this.buf.slice(16 + len);
      const w = this.waiters.shift();
      if (w) w(data);
    }
  }

  _read(timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { const i = this.waiters.indexOf(res); if (i >= 0) this.waiters.splice(i, 1); reject(new Error('read timeout')); }, timeoutMs || 2500);
      const res = (data) => { clearTimeout(t); resolve(data); };
      this.waiters.push(res);
    });
  }

  _send(packetId, deviceId, data) {
    if (!this.sock) return;
    const body = data || Buffer.alloc(0);
    this.sock.write(Buffer.concat([header(deviceId, packetId, body.length), body]));
  }

  async enumerate() {
    this._send(PKT.SET_CLIENT_NAME, 0, Buffer.from('XenonEdge\0', 'ascii'));
    // Negotiate protocol version.
    const pv = Buffer.alloc(4); pv.writeUInt32LE(CLIENT_PROTOCOL, 0);
    this._send(PKT.REQUEST_PROTOCOL_VERSION, 0, pv);
    try { const r = await this._read(1500); this.proto = Math.min(CLIENT_PROTOCOL, r.readUInt32LE(0)); } catch { this.proto = 1; }
    // Controller count.
    this._send(PKT.REQUEST_CONTROLLER_COUNT, 0, Buffer.alloc(0));
    const cnt = await this._read(2000);
    const count = cnt.readUInt32LE(0);
    this.controllers = [];
    for (let i = 0; i < count; i++) {
      const req = Buffer.alloc(4); req.writeUInt32LE(this.proto, 0);
      this._send(PKT.REQUEST_CONTROLLER_DATA, i, req);
      const blob = await this._read(2500);
      const info = parseController(blob, this.proto);
      // Leave Corsair devices to iCUE — never claim or write them via OpenRGB.
      if (isCorsairController(info)) continue;
      this.controllers.push({ index: i, numLeds: info.numLeds });
      this._send(PKT.RGBCONTROLLER_SETCUSTOMMODE, i, Buffer.alloc(0)); // accept direct LED writes
    }
    return this.controllers;
  }

  paint(color) {
    if (!this.sock) return;
    for (const c of this.controllers) {
      if (!c.numLeds) continue;
      const body = Buffer.alloc(4 + 2 + c.numLeds * 4);
      body.writeUInt32LE(body.length, 0);
      body.writeUInt16LE(c.numLeds, 4);
      for (let i = 0; i < c.numLeds; i++) {
        const o = 6 + i * 4;
        body[o] = color.r; body[o + 1] = color.g; body[o + 2] = color.b; body[o + 3] = 0;
      }
      this._send(PKT.RGBCONTROLLER_UPDATELEDS, c.index, body);
    }
  }

  close() {
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } this.sock = null; }
    this.waiters.forEach(w => { try { w(Buffer.alloc(0)); } catch { /* ignore */ } });
    this.waiters = [];
    this.controllers = [];
  }
}

// Walk a controller-data blob to read its name, vendor and LED count. The layout
// is version-dependent; we also accumulate zone LED counts as a fallback. Name +
// vendor let us leave Corsair devices to iCUE (avoid fighting over them).
function parseController(buf, proto) {
  try {
    let o = 0;
    const u16 = () => { const v = buf.readUInt16LE(o); o += 2; return v; };
    const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
    const i32 = () => { const v = buf.readInt32LE(o); o += 4; return v; };
    const readStr = () => { const len = u16(); const s = buf.toString('utf8', o, o + len); o += len; return s.replace(/\0+$/, ''); };
    const skipStr = () => { const len = u16(); o += len; };

    u32();                       // data_size
    u32();                       // device type
    const name = readStr();      // name
    const vendor = proto >= 1 ? readStr() : ''; // vendor
    skipStr();                   // description
    skipStr();                   // version
    skipStr();                   // serial
    skipStr();                   // location

    const numModes = u16();
    i32();            // active mode
    for (let m = 0; m < numModes; m++) {
      skipStr();      // mode name
      i32();          // value
      u32();          // flags
      u32();          // speed_min
      u32();          // speed_max
      if (proto >= 3) { u32(); u32(); } // brightness_min/max
      u32();          // colors_min
      u32();          // colors_max
      u32();          // speed
      if (proto >= 3) u32();            // brightness
      u32();          // direction
      u32();          // color_mode
      const nc = u16(); o += nc * 4;    // mode colours
    }

    let zoneSum = 0;
    const numZones = u16();
    for (let z = 0; z < numZones; z++) {
      skipStr();      // zone name
      i32();          // zone type
      u32();          // leds_min
      u32();          // leds_max
      zoneSum += u32(); // leds_count
      const matrixLen = u16();
      if (matrixLen > 0) o += matrixLen;
      if (proto >= 4) {
        const numSeg = u16();
        for (let s = 0; s < numSeg; s++) { skipStr(); i32(); u32(); u32(); }
      }
    }

    const numLeds = u16();
    return { name, vendor, numLeds: numLeds > 0 ? numLeds : zoneSum };
  } catch {
    return { name: '', vendor: '', numLeds: 0 };
  }
}

// True for controllers that iCUE owns — the dashboard drives those through iCUE,
// so OpenRGB must leave them alone (writing both ways corrupts the profile).
function isCorsairController(info) {
  return /corsair/i.test(info.name || '') || /corsair/i.test(info.vendor || '');
}

// Back-compat shim for the unit test.
function parseLedCount(buf, proto) { return parseController(buf, proto).numLeds; }

// Probe: a working SDK handshake means OpenRGB is present. One server = one device.
async function probe(host) {
  const { ip, port } = splitHostPort(host);
  if (!ip) return null;
  const client = new Client(ip, port);
  try {
    await client.connect();
    const controllers = await client.enumerate();
    const totalLeds = controllers.reduce((a, c) => a + (c.numLeds || 0), 0);
    return {
      id: 'openrgb:' + ip + (port !== DEFAULT_PORT ? ':' + port : ''),
      host: port !== DEFAULT_PORT ? `${ip}:${port}` : ip,
      name: 'OpenRGB',
      model: `OpenRGB (${controllers.length} device${controllers.length === 1 ? '' : 's'})`,
      ledCount: totalLeds,
    };
  } catch {
    return null;
  } finally {
    client.close();
  }
}

// Persistent connections, keyed by host. Built on first write, dropped on release.
const conns = new Map();

async function write(device, color) {
  const host = String(device && device.host || '');
  if (!host) return;
  let c = conns.get(host);
  if (!c) {
    const { ip, port } = splitHostPort(host);
    c = new Client(ip, port);
    conns.set(host, c);
    try { await c.connect(); await c.enumerate(); }
    catch { c.close(); conns.delete(host); return; }
  }
  if (!c.sock) { conns.delete(host); return; }
  c.paint(color);
}

// Release: drop the connection (OpenRGB keeps the last frame; reconnect on resume).
async function release(device) {
  const host = String(device && device.host || '');
  const c = conns.get(host);
  if (c) { c.close(); conns.delete(host); }
}

module.exports = {
  meta, probe, write, release,
  // Internals exported for the unit test only.
  _parseLedCount: parseLedCount,
  _parseController: parseController,
  _isCorsairController: isCorsairController,
  _header: header,
  _splitHostPort: splitHostPort,
};
