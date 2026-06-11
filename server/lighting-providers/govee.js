'use strict';
// Govee provider — drives Govee Wi-Fi lights over the official LAN API (UDP JSON).
// Requires "LAN Control" to be enabled per device in the Govee Home app.
// Discovery: a scan request multicast to 239.255.255.250:4001; devices answer to
// UDP port 4002 on our side. Control: JSON commands to the device on UDP 4003.
// Everything is fire-and-forget UDP — no dependencies, nothing can block.
// API reference: https://app-h5.govee.com/user-manual/wlan-guide

const dgram = require('dgram');

const SCAN_ADDR = '239.255.255.250';
const SCAN_PORT = 4001;   // devices listen for scan requests here
const REPLY_PORT = 4002;  // devices answer scan requests to this port on our side
const CTRL_PORT = 4003;   // devices listen for control commands here

const meta = {
  id: 'govee',
  name: 'Govee',
  type: 'udp',            // own discover() — not part of the HTTP subnet sweep
  maxHz: 15,
  needsPairing: false,
  download: 'https://app-h5.govee.com/user-manual/wlan-guide',
};

function normHost(host) {
  return String(host || '').trim().replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
}

// Parse a scan reply datagram into a device descriptor, or null if it isn't one.
function parseScanReply(buf, fromIp) {
  try {
    const msg = JSON.parse(buf.toString('utf8')).msg;
    if (!msg || msg.cmd !== 'scan' || !msg.data) return null;
    const ip = normHost(msg.data.ip) || fromIp;
    if (!ip) return null;
    const sku = String(msg.data.sku || '').slice(0, 40);
    return {
      id: 'govee:' + String(msg.data.device || ip).slice(0, 80),
      host: ip,
      name: sku ? `Govee ${sku}` : 'Govee',
      model: sku || 'Govee',
      ledCount: 0,
    };
  } catch { return null; }
}

// Run one scan round on a fresh socket bound to the reply port. `target` is the
// scan destination (multicast for discovery, a single IP for probe). Resolves
// with every device that answered within `timeoutMs`; [] on any socket failure
// (e.g. port 4002 already taken) — callers treat that as "nothing found".
function scanOnce(target, timeoutMs, filterIp) {
  return new Promise((resolve) => {
    let sock;
    try { sock = dgram.createSocket({ type: 'udp4', reuseAddr: true }); }
    catch { return resolve([]); }
    const found = new Map();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { sock.close(); } catch { /* already closed */ }
      resolve(Array.from(found.values()));
    };
    const timer = setTimeout(finish, timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('error', () => { clearTimeout(timer); finish(); });
    sock.on('message', (buf, rinfo) => {
      if (filterIp && rinfo.address !== filterIp) return;
      const dev = parseScanReply(buf, rinfo.address);
      if (dev) {
        found.set(dev.id, dev);
        if (filterIp) { clearTimeout(timer); finish(); } // probe: first answer wins
      }
    });
    sock.bind(REPLY_PORT, () => {
      const req = Buffer.from(JSON.stringify({ msg: { cmd: 'scan', data: { account_topic: 'reserve' } } }));
      try { sock.setBroadcast(true); sock.setMulticastTTL(2); } catch { /* best-effort */ }
      sock.send(req, SCAN_PORT, target, () => { /* errors surface as silence */ });
    });
  });
}

// LAN discovery (called from the manager's on-demand scan; no background scanning).
function discover() {
  return scanOnce(SCAN_ADDR, 2000, null);
}

// Probe a single host (manual add by IP): unicast scan request, first reply wins.
async function probe(host) {
  const h = normHost(host);
  if (!h) return null;
  const found = await scanOnce(h, 1500, h);
  return found[0] || null;
}

// Shared fire-and-forget control socket (lazy; unref'd so it never holds Node open).
let ctrlSock = null;
function sendCmd(host, cmd, data) {
  if (!ctrlSock) {
    try {
      ctrlSock = dgram.createSocket('udp4');
      ctrlSock.on('error', () => { try { ctrlSock.close(); } catch { /* ignore */ } ctrlSock = null; });
      ctrlSock.unref();
    } catch { ctrlSock = null; return; }
  }
  const buf = Buffer.from(JSON.stringify({ msg: { cmd, data } }));
  try { ctrlSock.send(buf, CTRL_PORT, host, () => { /* fire-and-forget */ }); } catch { /* ignore */ }
}

// Devices we already powered on this session — "turn on" is sent once per device,
// not with every colour frame (halves the packet rate during animations).
const poweredOn = new Set();

// Push a uniform colour (brightness is already baked in by the resolver).
async function write(device, color) {
  const h = normHost(device && device.host);
  if (!h) return;
  if (!poweredOn.has(device.id)) {
    poweredOn.add(device.id);
    sendCmd(h, 'turn', { value: 1 });
  }
  sendCmd(h, 'colorwc', { color: { r: color.r, g: color.g, b: color.b }, colorTemInKelvin: 0 });
}

// Hand control back: turn the device off (predictable neutral state, same as WLED).
async function release(device) {
  const h = normHost(device && device.host);
  if (!h) return;
  poweredOn.delete(device && device.id);
  sendCmd(h, 'turn', { value: 0 });
}

module.exports = { meta, discover, probe, write, release };
