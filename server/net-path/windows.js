'use strict';
// Windows: echoes and the route through iphlpapi, the Wi-Fi level through
// wlanapi, all with koffi on its worker thread and ONE call at a time: an echo
// holds its thread for up to its timeout, and several at once would take the
// threads libuv also reads files with. No process and no PowerShell, so nothing
// here starts or wakes anything in a game.
//
// The Wi-Fi level is asked with wlan_intf_opcode_rssi only. The current-connection
// query names the network and its BSSID, and since the 2024 feature release Windows
// answers it only for apps the user let see their location, prompting once and
// showing the location icon (learn.microsoft.com, "Changes to API behavior for
// Wi-Fi access and location"). An ACCESS_DENIED on rssi too switches Wi-Fi reads
// off for the rest of the process, so nothing can ever prompt twice.

const P = require('./parse.js');
const { createSampler } = require('./sampler.js');

const INTERNET = '1.1.1.1';
const ECHO_TIMEOUT_MS = 1000;
const TRACE_TIMEOUT_MS = 500;
const CALL_CEILING_MS = 3000;
const PERIOD_MS = 1000;
const REPLY_SIZE = 256;
const PAYLOAD = Buffer.alloc(32, 0x61);
const IP_SUCCESS = 0;
const IP_TTL_EXPIRED_TRANSIT = 11013;
const WLAN_INTF_OPCODE_RSSI = 0x10000102;
const ERROR_ACCESS_DENIED = 5;
const WLAN_RETRY_MS = 60000;
const INVALID_HANDLE = 0xFFFFFFFFFFFFFFFFn;

let api = null;
function load() {
  if (api) return api;
  const koffi = require('koffi');
  koffi.struct('NP_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8[8]' });
  koffi.struct('NP_FWD_ROW', {
    dest: 'uint32', mask: 'uint32', policy: 'uint32', nextHop: 'uint32', ifIndex: 'uint32', type: 'uint32',
    proto: 'uint32', age: 'uint32', nextHopAS: 'uint32', m1: 'uint32', m2: 'uint32', m3: 'uint32', m4: 'uint32', m5: 'uint32',
  });
  koffi.struct('NP_IP_OPT', { Ttl: 'uint8', Tos: 'uint8', Flags: 'uint8', OptionsSize: 'uint8', OptionsData: 'void *' });
  koffi.struct('NP_IF_ROW2', ifRow2Layout());
  const ip = koffi.load('iphlpapi.dll');
  api = {
    koffi,
    bestRoute: ip.func('uint32 __stdcall GetBestRoute(uint32, uint32, _Out_ NP_FWD_ROW *)'),
    ifEntry: ip.func('uint32 __stdcall GetIfEntry2(void *)'),
    icmpOpen: ip.func('void * __stdcall IcmpCreateFile()'),
    icmpClose: ip.func('bool __stdcall IcmpCloseHandle(void *)'),
    echo: ip.func('uint32 __stdcall IcmpSendEcho(void *, uint32, void *, uint16, NP_IP_OPT *, void *, uint32, uint32)'),
    wlan: loadWlan(koffi),
  };
  return api;
}

// MIB_IF_ROW2 (netioapi.h). koffi lays it out with the C alignment; 1352 bytes on
// x64, pinned by the test. The flag bits after DirectionType are one byte.
function ifRow2Layout() {
  const counters = ['InOctets', 'InUcastPkts', 'InNUcastPkts', 'InDiscards', 'InErrors', 'InUnknownProtos',
    'InUcastOctets', 'InMulticastOctets', 'InBroadcastOctets', 'OutOctets', 'OutUcastPkts', 'OutNUcastPkts',
    'OutDiscards', 'OutErrors', 'OutUcastOctets', 'OutMulticastOctets', 'OutBroadcastOctets', 'OutQLen'];
  return {
    InterfaceLuid: 'uint64', InterfaceIndex: 'uint32', InterfaceGuid: 'NP_GUID',
    Alias: 'uint16[257]', Description: 'uint16[257]', PhysicalAddressLength: 'uint32',
    PhysicalAddress: 'uint8[32]', PermanentPhysicalAddress: 'uint8[32]', Mtu: 'uint32', Type: 'uint32',
    TunnelType: 'int32', MediaType: 'int32', PhysicalMediumType: 'int32', AccessType: 'int32', DirectionType: 'int32',
    StatusFlags: 'uint8', OperStatus: 'int32', AdminStatus: 'int32', MediaConnectState: 'int32', NetworkGuid: 'NP_GUID',
    ConnectionType: 'int32', TransmitLinkSpeed: 'uint64', ReceiveLinkSpeed: 'uint64',
    ...Object.fromEntries(counters.map((c) => [c, 'uint64'])),
  };
}

function loadWlan(koffi) {
  try {
    const wl = koffi.load('wlanapi.dll');
    return {
      open: wl.func('uint32 __stdcall WlanOpenHandle(uint32, void *, _Out_ uint32 *, _Out_ void **)'),
      close: wl.func('uint32 __stdcall WlanCloseHandle(void *, void *)'),
      query: wl.func('uint32 __stdcall WlanQueryInterface(void *, NP_GUID *, int, void *, _Out_ uint32 *, _Out_ void **, void *)'),
      free: wl.func('void __stdcall WlanFreeMemory(void *)'),
    };
  } catch {
    return null;   // Windows without the WLAN service (Server editions)
  }
}

// One koffi call at a time, each with a ceiling: a call that never returns
// keeps its worker thread but frees the queue.
let queue = Promise.resolve();
function serial(fn, ...args) {
  const run = queue.then(() => bounded(fn, args));
  queue = run.catch(() => {});
  return run;
}
function bounded(fn, args) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('net-path call timed out')), CALL_CEILING_MS);
    if (timer.unref) timer.unref();
  });
  const run = new Promise((resolve, reject) => fn.async(...args, (err, res) => (err ? reject(err) : resolve(res))));
  return Promise.race([run.finally(() => clearTimeout(timer)), guard]);
}

let icmp = null;
function icmpHandle(a) {
  if (icmp) return icmp;
  const h = a.icmpOpen();
  if (!h || a.koffi.address(h) === INVALID_HANDLE) throw new Error('IcmpCreateFile failed');
  icmp = h;
  return icmp;
}

// One echo. `ttl` set: toward the internet, answered by the router where it ran out.
async function echo(dest, ttl, timeoutMs) {
  const a = load();
  const reply = Buffer.alloc(REPLY_SIZE);
  const opt = ttl ? { Ttl: ttl, Tos: 0, Flags: 0, OptionsSize: 0, OptionsData: null } : null;
  await serial(a.echo, icmpHandle(a), P.ipv4ToInt(dest), PAYLOAD, PAYLOAD.length, opt, reply, REPLY_SIZE, timeoutMs);
  return { address: P.intToIpv4(reply.readUInt32LE(0)), status: reply.readUInt32LE(4), ms: reply.readUInt32LE(8) };
}

async function probe(target) {
  if (target.ttl) {
    const r = await echo(INTERNET, target.ttl, ECHO_TIMEOUT_MS);
    return r.status === IP_TTL_EXPIRED_TRANSIT ? r.ms : null;
  }
  const r = await echo(target.ip, 0, ECHO_TIMEOUT_MS);
  return r.status === IP_SUCCESS && r.address === target.ip ? r.ms : null;
}

async function ifRow(index) {
  const a = load();
  const buf = Buffer.alloc(a.koffi.sizeof('NP_IF_ROW2'));
  buf.writeUInt32LE(index >>> 0, a.koffi.offsetof('NP_IF_ROW2', 'InterfaceIndex'));
  if (await serial(a.ifEntry, buf) !== 0) return null;
  const off = (name) => a.koffi.offsetof('NP_IF_ROW2', name);
  const u64 = (name) => Number(buf.readBigUInt64LE(off(name)));
  const speed = Math.min(u64('ReceiveLinkSpeed'), u64('TransmitLinkSpeed'));
  return {
    type: buf.readUInt32LE(off('Type')),
    guid: a.koffi.decode(buf, off('InterfaceGuid'), 'NP_GUID'),
    linkMbps: speed > 0 && speed < 1e12 ? Math.round(speed / 1e6) : null,
    rx: u64('InOctets'),
    tx: u64('OutOctets'),
  };
}

async function route() {
  const a = load();
  const row = {};
  if (await serial(a.bestRoute, P.ipv4ToInt(INTERNET), 0, row) !== 0) return null;
  const info = await ifRow(row.ifIndex);
  const gateway = row.nextHop ? P.intToIpv4(row.nextHop) : null;
  return { iface: row.ifIndex, gateway: gateway === INTERNET ? null : gateway, link: info ? P.linkFromIfType(info.type) : null };
}

// Hops 1..maxTtl toward the internet, each asked up to twice.
async function trace(maxTtl) {
  const hops = [];
  for (let ttl = 1; ttl <= maxTtl; ttl += 1) {
    let hop = { ttl, ip: null, ms: null };
    for (let attempt = 0; attempt < 2 && !hop.ip; attempt += 1) {
      const r = await echo(INTERNET, ttl, TRACE_TIMEOUT_MS);
      if (r.status === IP_TTL_EXPIRED_TRANSIT || r.status === IP_SUCCESS) hop = { ttl, ip: r.address, ms: r.ms };
    }
    hops.push(hop);
    if (hop.ip === INTERNET) break;
  }
  return hops;
}

let wlanHandle = null;
let wifiDenied = false;
let wlanRetryAt = 0;
async function wifiDbm(a, guid) {
  if (!a.wlan || wifiDenied || Date.now() < wlanRetryAt) return null;
  if (!wlanHandle) {
    const version = [0];
    const out = [null];
    if (await serial(a.wlan.open, 2, null, version, out) !== 0 || !out[0]) {
      wlanRetryAt = Date.now() + WLAN_RETRY_MS;   // the WLAN service is off
      return null;
    }
    wlanHandle = out[0];
  }
  const size = [0];
  const data = [null];
  const rc = await serial(a.wlan.query, wlanHandle, guid, WLAN_INTF_OPCODE_RSSI, null, size, data, null);
  if (rc === ERROR_ACCESS_DENIED) wifiDenied = true;
  if (rc !== 0 || !data[0]) return null;
  try {
    const dbm = a.koffi.decode(data[0], 'int32');
    return dbm < 0 && dbm >= -110 ? dbm : null;
  } finally {
    a.wlan.free(data[0]);
  }
}

async function iface(r) {
  const a = load();
  const row = await ifRow(r.iface);
  if (!row) return null;
  const dbm = r.link === 'wifi' ? await wifiDbm(a, row.guid) : null;
  return { linkMbps: row.linkMbps, dbm, rx: row.rx, tx: row.tx };
}

function watch(target, onSample) {
  return createSampler(() => probe(target), onSample, { periodMs: PERIOD_MS });
}

function available() {
  try { load(); return true; } catch { return false; }
}

function close() {
  if (!api) return;
  try { if (icmp) api.icmpClose(icmp); } catch { /* already closed */ }
  try { if (wlanHandle && api.wlan) api.wlan.close(wlanHandle, null); } catch { /* already closed */ }
  icmp = null;
  wlanHandle = null;
}

module.exports = { available, route, trace, watch, iface, close, _ifRow2Layout: ifRow2Layout };
