'use strict';
// The language of the CORSAIR iCUE LINK System Hub (USB 1B1C:0C3F, interface 0, vendor
// page 0xFF42), written from public observations of the hub and checked on a real one;
// no code taken from anyone. Pure: bytes in, bytes out. corsair-link-session.js talks.
//
// Every report is 512 bytes behind report id 0. A request is 00 01 then the command; a
// reply echoes the command's first byte at [2], its status at [3] (0 = done, 3 = the hub
// is not in software mode), the data type at [4..5] and the data from [6]. Data lives
// behind endpoints: close, open, read or write, close. Nothing here writes the hub's
// memory: software mode, hardware mode, reads, fan speeds and the colours of its lights.
//
// The colours go through a second handle (0) kept open on their own endpoint, a frame of
// RGB per LED slot at each change, as iCUE does (seen on a real hub's USB traffic). A frame
// covers every slot of the chain in channel order (corsair-link-lights.js lays them out).

const VENDOR_ID = 0x1b1c;
const HUB_PRODUCT_ID = 0x0c3f;
const USAGE_PAGE = 0xff42;
const REPORT_BYTES = 513;
const HANDLE = 0x01;
const COLOUR_HANDLE = 0x00;
const MAX_CHANNELS = 24;
const MAX_ID_CHARS = 64;

const STATUS = Object.freeze({ ok: 0x00, wrongMode: 0x03 });
const ENDPOINT = Object.freeze({ devices: 0x36, speeds: 0x17, temps: 0x21, setSpeeds: 0x18, colours: 0x22 });
const DATA = Object.freeze({ devices: [0x21, 0x00], speeds: [0x25, 0x00], temps: [0x10, 0x00], setSpeeds: [0x07, 0x00], colours: [0x12, 0x00] });
const PERCENT_MODE = 0x00;

/** The full output report for a command: report id 0, then 00 01, then the command. */
function packet(cmd) {
  if (cmd.length > REPORT_BYTES - 3) throw new RangeError('command too long');
  const buf = Buffer.alloc(REPORT_BYTES);
  buf[2] = 0x01;
  Buffer.from(cmd).copy(buf, 3);
  return buf;
}

// A write's payload: its length (data + 2) little-endian, two zeros, the data type, the data.
function frame(type, data) {
  const len = data.length + 2;
  return [len & 0xff, len >> 8, 0x00, 0x00, type[0], type[1], ...data];
}

const COMMAND = Object.freeze({
  software: () => [0x01, 0x03, 0x00, 0x02],
  hardware: () => [0x01, 0x03, 0x00, 0x01],
  firmware: () => [0x02, 0x13],
  /** @param {number} ep */
  open: (ep) => [0x0d, HANDLE, ep],
  /** @param {number} ep */
  close: (ep) => [0x05, 0x01, HANDLE, ep],
  read: () => [0x08, HANDLE],
  /** @param {number[]} type @param {number[]} data */
  write: (type, data) => [0x06, HANDLE, ...frame(type, data)],
  openColours: () => [0x0d, COLOUR_HANDLE, ENDPOINT.colours],
  closeColours: () => [0x05, 0x01, COLOUR_HANDLE],
  /** @param {number[]} data RGB per slot (colourData) */
  colours: (data) => [0x06, COLOUR_HANDLE, ...frame(DATA.colours, data)],
});

// The slots one report carries: what is left of it after the request and the write's header.
const MAX_COLOUR_SLOTS = Math.floor((REPORT_BYTES - 3 - 8) / 3);

/**
 * A colour frame's data: red, green, blue per slot, each a whole 0..255.
 * @param {{ r: number, g: number, b: number }[]} slots
 */
function colourData(slots) {
  if (slots.length > MAX_COLOUR_SLOTS) throw new RangeError(`${slots.length} LEDs do not fit one report`);
  const byte = (v) => Math.round(Math.min(255, Math.max(0, Number(v) || 0)));
  return slots.flatMap((c) => [byte(c?.r), byte(c?.g), byte(c?.b)]);
}

/**
 * One reply, its report id already taken off.
 * @param {Buffer} raw
 * @returns {{ op: number, status: number, type: number[], data: Buffer } | null}
 */
function reply(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 6) return null;
  return { op: raw[2], status: raw[3], type: [raw[4], raw[5]], data: raw.subarray(6) };
}

const sameType = (a, b) => a[0] === b[0] && a[1] === b[1];

/** "major.minor.patch" from the reply to COMMAND.firmware(), or null. */
function firmwareOf(raw) {
  if (!Buffer.isBuffer(raw) || raw.length < 8) return null;
  return { major: raw[4], minor: raw[5], patch: raw.readUInt16LE(6), text: `${raw[4]}.${raw[5]}.${raw.readUInt16LE(6)}` };
}

// A device id is printable ASCII; anything else ends it.
function asciiId(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b < 0x20 || b > 0x7e) break;
    s += String.fromCharCode(b);
  }
  return s.slice(0, MAX_ID_CHARS);
}

/**
 * The devices on the chain from the device list's reply (its data from [6]) and, on newer
 * firmware, the second read that carries the rest (its data from [4]). Data starts with
 * the last channel number; each channel is an 8-byte header (type at 2, model at 3, id
 * length at 7) then its id. Channels count from 1; an empty one is 8 zero-length bytes.
 * @param {Buffer} first the first reply, report id off
 * @param {Buffer|null} [rest] the second reply, report id off
 * @returns {{ channel: number, type: number, model: number, id: string }[]}
 */
function parseDevices(first, rest = null) {
  const head = Buffer.isBuffer(first) && first.length > 6 ? first.subarray(6) : Buffer.alloc(0);
  const d = Buffer.concat([head, Buffer.isBuffer(rest) && rest.length > 4 ? rest.subarray(4) : Buffer.alloc(0)]);
  const out = [];
  if (!d.length) return out;
  const last = Math.min(d[0], MAX_CHANNELS);
  let i = 1;
  for (let channel = 1; channel <= last && i + 8 <= d.length; channel++) {
    const idLength = d[i + 7];
    if (idLength > 0) {
      const id = asciiId(d.subarray(i + 8, Math.min(d.length, i + 8 + idLength)));
      out.push({ channel, type: d[i + 2], model: d[i + 3], id });
    }
    i += 8 + idLength;
  }
  return out;
}

/**
 * Speeds (rpm, scale 1) or temperatures (°C, scale 10) from a reading's reply: a count
 * at [6], then 3 bytes per channel from [7]: status (0 = there is a value), int16 LE.
 * Entry i is channel i; entry 0 is the hub's own and has no device.
 * @param {Buffer} raw the reply, report id off
 * @param {number} scale
 * @returns {Map<number, number>} channel → value, only the channels with a value
 */
function parseReadings(raw, scale) {
  const out = new Map();
  if (!Buffer.isBuffer(raw) || raw.length < 7) return out;
  const count = Math.min(raw[6], MAX_CHANNELS + 1);
  for (let ch = 0; ch < count; ch++) {
    const at = 7 + ch * 3;
    if (at + 3 > raw.length) break;
    if (raw[at] === STATUS.ok) out.set(ch, raw.readInt16LE(at + 1) / scale);
  }
  return out;
}

/**
 * The data of a speed write: a count, then channel, percent mode, value (u16 LE).
 * @param {{ channel: number, percent: number }[]} entries
 */
function speedData(entries) {
  const data = [entries.length];
  for (const { channel, percent } of entries) {
    if (!Number.isInteger(channel) || channel < 1 || channel > MAX_CHANNELS) throw new RangeError(`bad channel ${channel}`);
    const value = Math.round(Math.min(100, Math.max(0, Number(percent) || 0)));
    data.push(channel, PERCENT_MODE, value & 0xff, value >> 8);
  }
  return data;
}

module.exports = {
  VENDOR_ID, HUB_PRODUCT_ID, USAGE_PAGE, REPORT_BYTES, MAX_CHANNELS, MAX_COLOUR_SLOTS, STATUS, ENDPOINT, DATA, COMMAND,
  packet, reply, sameType, firmwareOf, parseDevices, parseReadings, speedData, colourData,
};
