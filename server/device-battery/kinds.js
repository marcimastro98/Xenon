'use strict';
// What kind of device a battery belongs to, for widgets that would otherwise guess it from
// the name. Every kind here comes from what the hardware or the OS declares (a HID usage,
// a Bluetooth class, a protocol's own device type, a brand table keyed by product id),
// never from the name: a name says what the person called it, not what it is. When the
// hardware does not say, the kind is 'unknown'.

const KINDS = Object.freeze(['mouse', 'keyboard', 'headset', 'controller', 'system', 'ups', 'other', 'unknown']);
const KNOWN = new Set(KINDS);

const normalizeKind = (value) => (typeof value === 'string' && KNOWN.has(value) ? value : 'unknown');

// Generic Desktop application collections (HID Usage Tables, page 0x01).
const GENERIC_DESKTOP = 0x01;
const DESKTOP_KINDS = new Map([[0x02, 'mouse'], [0x04, 'controller'], [0x05, 'controller'], [0x06, 'keyboard'], [0x07, 'keyboard'], [0x08, 'controller']]);

const kindOfUsage = (page, usage) => (page === GENERIC_DESKTOP ? DESKTOP_KINDS.get(usage) || null : null);

// A device can declare several collections (a gaming mouse often adds a keyboard one for its
// macros), so only one kind among all of them counts. Collections of no kind (consumer keys,
// vendor pages) say nothing either way.
function kindOfUsages(pairs) {
  const kinds = new Set(pairs.map(([page, usage]) => kindOfUsage(page, usage)).filter(Boolean));
  return kinds.size === 1 ? [...kinds][0] : 'unknown';
}

// The top-level application collections of a HID report descriptor, as [page, usage] pairs.
function applicationUsages(descriptor) {
  const bytes = Buffer.isBuffer(descriptor) ? descriptor : Buffer.alloc(0);
  const pairs = [];
  const stack = [];
  let page = 0;
  let usage = null;
  let depth = 0;
  for (let i = 0; i < bytes.length;) {
    const prefix = bytes[i];
    if (prefix === 0xFE) { i += 3 + (bytes[i + 1] || 0); continue; }   // long item
    const size = [0, 1, 2, 4][prefix & 0x03];
    let value = 0;
    for (let b = 0; b < size && i + 1 + b < bytes.length; b++) value += bytes[i + 1 + b] * 2 ** (8 * b);
    const tag = prefix & 0xFC;
    if (tag === 0x04) page = value;                                    // Usage Page
    else if (tag === 0xA4) stack.push(page);                           // Push
    else if (tag === 0xB4) page = stack.length ? stack.pop() : page;   // Pop
    else if (tag === 0x08 && usage === null) usage = size === 4 ? [Math.floor(value / 0x10000), value % 0x10000] : [page, value];
    else if (tag === 0xA0) {                                           // Collection
      if (depth === 0 && value === 1 && usage) pairs.push(usage);
      depth += 1;
    }
    if (tag === 0xC0) depth = Math.max(0, depth - 1);                  // End Collection
    if (tag === 0x80 || tag === 0x90 || tag === 0xB0 || tag === 0xA0 || tag === 0xC0) usage = null;
    i += 1 + size;
  }
  return pairs;
}

// Bluetooth Class of Device (Assigned Numbers, Baseband): major class in bits 8-12.
const MAJOR_COMPUTER = 0x01;
const MAJOR_PHONE = 0x02;
const MAJOR_AUDIO = 0x04;
const MAJOR_PERIPHERAL = 0x05;
const MAJOR_IMAGING = 0x06;
const MAJOR_WEARABLE = 0x07;
const MAJOR_TOY = 0x08;
const MAJOR_HEALTH = 0x09;
const AUDIO_HEADSETS = new Set([0x01, 0x02, 0x06]);   // wearable headset, hands-free, headphones
const OTHER_MAJORS = new Set([MAJOR_COMPUTER, MAJOR_PHONE, MAJOR_IMAGING, MAJOR_WEARABLE, MAJOR_TOY, MAJOR_HEALTH]);

function kindOfPeripheral(minor) {
  const pointer = (minor >> 4) & 0x03;   // 1 keyboard, 2 pointing device, 3 both
  if (pointer === 1 || pointer === 3) return 'keyboard';
  if (pointer === 2) return 'mouse';
  const sub = minor & 0x0F;              // 1 joystick, 2 gamepad, 3 to 9 remote, sensor, tablet...
  if (sub === 1 || sub === 2) return 'controller';
  return sub ? 'other' : 'unknown';
}

function kindOfClass(cod) {
  if (!Number.isInteger(cod) || cod <= 0) return 'unknown';
  const major = (cod >> 8) & 0x1F;
  const minor = (cod >> 2) & 0x3F;
  if (major === MAJOR_PERIPHERAL) return kindOfPeripheral(minor);
  if (major === MAJOR_AUDIO) return AUDIO_HEADSETS.has(minor) ? 'headset' : (minor ? 'other' : 'unknown');
  return OTHER_MAJORS.has(major) ? 'other' : 'unknown';
}

// Bluetooth LE Appearance (Assigned Numbers): category in bits 6-15.
const APPEARANCE = new Map([
  [0x03C1, 'keyboard'], [0x03C2, 'mouse'], [0x03C3, 'controller'], [0x03C4, 'controller'],
  [0x03C5, 'other'], [0x03C6, 'other'], [0x03C7, 'other'], [0x03C8, 'other'],   // tablet, card reader, pen, scanner
  [0x0941, 'headset'], [0x0942, 'headset'], [0x0943, 'headset'], [0x0944, 'headset'],
]);
const APPEARANCE_OTHER = new Set([0x01, 0x02, 0x03, 0x05, 0x21]);   // phone, computer, watch, display, speaker

function kindOfAppearance(appearance) {
  if (!Number.isInteger(appearance) || appearance <= 0) return 'unknown';
  if (APPEARANCE.has(appearance)) return APPEARANCE.get(appearance);
  return APPEARANCE_OTHER.has(appearance >> 6) ? 'other' : 'unknown';
}

// BlueZ's Icon, which it derives from the same class or appearance.
const ICONS = new Map([
  ['input-mouse', 'mouse'], ['input-keyboard', 'keyboard'], ['input-gaming', 'controller'],
  ['audio-headset', 'headset'], ['audio-headphones', 'headset'],
  ['input-tablet', 'other'], ['audio-card', 'other'], ['phone', 'other'], ['computer', 'other'],
]);

const kindOfIcon = (icon) => (typeof icon === 'string' && ICONS.get(icon)) || 'unknown';

// The first source that knows wins: a number the radio sent, then the icon made from it.
/** @param {{ cod?: number, appearance?: number, icon?: string }} [device] */
function kindOfBluetooth({ cod, appearance, icon } = {}) {
  for (const kind of [kindOfClass(cod), kindOfAppearance(appearance), kindOfIcon(icon)]) if (kind !== 'unknown') return kind;
  return 'unknown';
}

// battery.ps1 on Windows: the Class of Device of a classic device, else the Mouse and Keyboard
// nodes Windows made from an LE device's HID collections. A Win32_Battery entry says which bus
// listed it: ACPI only lists the PC's own pack, and a UPS on USB arrives through HID.
const INPUT_CLASSES = new Map([['Mouse', 'mouse'], ['Keyboard', 'keyboard']]);
const BATTERY_BUSES = new Map([['ACPI', 'system'], ['HID', 'ups'], ['USB', 'ups']]);

function kindOfInputs(inputs) {
  const list = (Array.isArray(inputs) ? inputs : [inputs]).map((name) => INPUT_CLASSES.get(name)).filter(Boolean);
  const kinds = new Set(list);
  return kinds.size === 1 ? list[0] : 'unknown';
}

function kindOfWindowsEntry(device) {
  if (!device || typeof device !== 'object') return 'unknown';
  if (device.type === 'system') return BATTERY_BUSES.get(device.bus) || 'unknown';
  const kind = kindOfClass(device.cod);
  return kind !== 'unknown' ? kind : kindOfInputs(device.inputs);
}

// HID++ 2.0 feature 0x0005, getDeviceType.
const HIDPP_TYPES = [
  'keyboard', 'other', 'keyboard', 'mouse', 'mouse', 'mouse', 'other', 'other', 'headset', 'other',
  'controller', 'controller', 'controller', 'other', 'other', 'other', 'other', 'other', 'controller', 'other',
];

const kindOfHidppType = (type) => (Number.isInteger(type) && HIDPP_TYPES[type]) || 'unknown';

// iCUE SDK v4 CorsairDeviceType. Only one bit is set for a real device.
const CORSAIR_TYPES = new Map([[0x0001, 'keyboard'], [0x0002, 'mouse'], [0x0008, 'headset'], [0x1000, 'controller']]);
const CORSAIR_OTHER = new Set([0x0004, 0x0010, 0x0020, 0x0040, 0x0080, 0x0100, 0x0200, 0x0400, 0x0800]);

function kindOfCorsairType(type) {
  const value = Number(type);
  if (CORSAIR_TYPES.has(value)) return CORSAIR_TYPES.get(value);
  return CORSAIR_OTHER.has(value) ? 'other' : 'unknown';
}

module.exports = {
  KINDS, normalizeKind, kindOfUsage, kindOfUsages, applicationUsages,
  kindOfClass, kindOfAppearance, kindOfIcon, kindOfBluetooth, kindOfInputs, kindOfWindowsEntry,
  kindOfHidppType, kindOfCorsairType,
};
