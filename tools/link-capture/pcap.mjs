// Reads a capture written by USBPcap (pcap, link type 249): every USB transfer as a plain
// record, with the payload that went to or came from the device. Pure: bytes in, records out.
//
// Each packet starts with USBPcap's own header (27 bytes; 28 for a control transfer, whose
// extra byte is the stage). `info` bit 0 says the packet is the device's answer (a completed
// transfer); data sent to the device sits in the request. Device descriptors injected at the
// start of a capture (USBPcapCMD --inject-descriptors) say which address is which device.

const PCAP_MAGIC = 0xa1b2c3d4;
const LINKTYPE_USBPCAP = 249;
const GLOBAL_HEADER = 24;
const RECORD_HEADER = 16;
const TRANSFER = Object.freeze({ 0: 'iso', 1: 'interrupt', 2: 'control', 3: 'bulk' });
const STAGE = Object.freeze({ 0: 'setup', 1: 'data', 2: 'status', 3: 'complete' });
const DEVICE_DESCRIPTOR = 0x01;

/**
 * @param {Buffer} buf a whole .pcap file
 * @returns {{ t: number, bus: number, device: number, endpoint: number, transfer: string,
 *   stage: string|null, fromDevice: boolean, status: number, data: Buffer }[]}
 */
export function readCapture(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < GLOBAL_HEADER) throw new Error('not a capture: too short');
  const le = buf.readUInt32LE(0) === PCAP_MAGIC;
  if (!le && buf.readUInt32BE(0) !== PCAP_MAGIC) throw new Error('not a pcap file');
  const u32 = (at) => (le ? buf.readUInt32LE(at) : buf.readUInt32BE(at));
  if (u32(20) !== LINKTYPE_USBPCAP) throw new Error(`not a USBPcap capture (link type ${u32(20)})`);
  const out = [];
  let at = GLOBAL_HEADER;
  let t0 = null;
  while (at + RECORD_HEADER <= buf.length) {
    const t = u32(at) + u32(at + 4) / 1e6;
    const len = u32(at + 8);
    const body = buf.subarray(at + RECORD_HEADER, Math.min(buf.length, at + RECORD_HEADER + len));
    at += RECORD_HEADER + len;
    const rec = packet(body);
    if (!rec) continue;
    if (t0 === null) t0 = t;
    out.push({ t: Math.round((t - t0) * 1000) / 1000, ...rec });
  }
  return out;
}

// USBPcap's header is always little-endian, whatever the file's byte order.
function packet(p) {
  if (p.length < 27) return null;
  const headerLen = p.readUInt16LE(0);
  if (headerLen < 27 || headerLen > p.length) return null;
  const transfer = TRANSFER[p[22]] ?? `type ${p[22]}`;
  const dataLength = p.readUInt32LE(23);
  return {
    bus: p.readUInt16LE(17),
    device: p.readUInt16LE(19),
    endpoint: p[21],
    transfer,
    stage: transfer === 'control' && headerLen >= 28 ? STAGE[p[27]] ?? null : null,
    fromDevice: (p[16] & 1) === 1,
    status: p.readUInt32LE(10),
    data: p.subarray(headerLen, Math.min(p.length, headerLen + dataLength)),
  };
}

/**
 * Which device sits at each address, from the device descriptors in the capture.
 * @param {ReturnType<typeof readCapture>} records
 * @returns {Map<string, { vid: number, pid: number }>} "bus.device" → ids
 */
export function devicesOf(records) {
  const map = new Map();
  for (const r of records) {
    const d = r.data;
    if (r.transfer !== 'control' || !r.fromDevice || d.length !== 18 || d[1] !== DEVICE_DESCRIPTOR) continue;
    map.set(`${r.bus}.${r.device}`, { vid: d.readUInt16LE(8), pid: d.readUInt16LE(10) });
  }
  return map;
}

/**
 * The address of the first device with these ids, or null.
 * @param {ReturnType<typeof readCapture>} records @param {number} vid @param {number} pid
 */
export function addressOf(records, vid, pid) {
  for (const [key, ids] of devicesOf(records)) if (ids.vid === vid && ids.pid === pid) return key;
  return null;
}

/**
 * The reports one device exchanged: interrupt data both ways, and the data of control
 * transfers (SET_REPORT and the like), in order.
 * @param {ReturnType<typeof readCapture>} records @param {string} address "bus.device"
 * @returns {{ t: number, out: boolean, endpoint: number, data: Buffer }[]}
 */
export function reportsOf(records, address) {
  const out = [];
  for (const r of records) {
    if (`${r.bus}.${r.device}` !== address || !r.data.length) continue;
    const toDevice = r.transfer === 'interrupt' ? (r.endpoint & 0x80) === 0 && !r.fromDevice
      : r.transfer === 'control' ? r.stage === 'data' && !r.fromDevice : false;
    const fromDevice = r.transfer === 'interrupt' && (r.endpoint & 0x80) !== 0 && r.fromDevice;
    if (toDevice || fromDevice) out.push({ t: r.t, out: toDevice, endpoint: r.endpoint, data: r.data });
  }
  return out;
}
