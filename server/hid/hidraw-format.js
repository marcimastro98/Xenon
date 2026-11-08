'use strict';
// What Linux's hidraw interface says about a device, as plain data. Pure, so every
// rule is unit-tested; hid-linux.js does the I/O.

const ITEM_MASK = 0xFC;             // a short item's prefix without its size bits
const ITEM_TYPE_BITS = 0x0C;        // 0 = main item, which ends the local items before it
const ITEM_USAGE_PAGE = 0x04;
const ITEM_USAGE = 0x08;
const ITEM_PUSH = 0xA4;
const ITEM_POP = 0xB4;
const ITEM_COLLECTION = 0xA0;
const ITEM_END_COLLECTION = 0xC0;
const LONG_ITEM = 0xFE;
const ITEM_DATA_BYTES = [0, 1, 2, 4];

const IOC_READ_WRITE = 3;
const IOC_TYPE_HID = 0x48;          // 'H'
const HIDIOCSFEATURE = 0x06;
const HIDIOCGFEATURE = 0x07;

// The HID_ID line of a sysfs uevent: "HID_ID=0003:0000048D:00005711" (bus, vendor, product).
function parseHidId(uevent) {
  const m = /^HID_ID=[0-9A-Fa-f]+:([0-9A-Fa-f]+):([0-9A-Fa-f]+)\s*$/m.exec(String(uevent == null ? '' : uevent));
  if (!m) return null;
  return { vendorId: parseInt(m[1], 16) & 0xFFFF, productId: parseInt(m[2], 16) & 0xFFFF };
}

// The name the device gives itself, what the battery list shows; some give none.
function parseHidName(uevent) {
  const m = /^HID_NAME=(.*\S)\s*$/m.exec(String(uevent == null ? '' : uevent));
  return m ? m[1] : '';
}

function itemValue(bytes, start, size) {
  let value = 0;
  for (let k = size - 1; k >= 0; k--) value = value * 256 + bytes[start + k];
  return value;
}

// (usage page, usage) of each top-level collection of a report descriptor: what
// Windows reports per HID interface. A malformed tail ends the walk, it never throws.
function topCollections(descriptor) {
  const out = [];
  const saved = [];
  let page = 0;
  let usage = null;
  let usagePage = null;      // a 4-byte usage names its own page
  let depth = 0;
  for (let i = 0; i < descriptor.length;) {
    const prefix = descriptor[i];
    if (prefix === LONG_ITEM) { i += 3 + (descriptor[i + 1] || 0); continue; }
    const size = ITEM_DATA_BYTES[prefix & 0x03];
    if (i + 1 + size > descriptor.length) break;
    const value = itemValue(descriptor, i + 1, size);
    const item = prefix & ITEM_MASK;
    if (item === ITEM_USAGE_PAGE) page = value;
    else if (item === ITEM_PUSH) saved.push(page);
    else if (item === ITEM_POP && saved.length) page = saved.pop();
    else if (item === ITEM_USAGE) {
      usage = value & 0xFFFF;
      usagePage = size === 4 ? Math.floor(value / 0x10000) : null;
    } else if (item === ITEM_COLLECTION) {
      if (depth === 0 && usage !== null) out.push({ usagePage: usagePage === null ? page : usagePage, usage });
      depth++;
    } else if (item === ITEM_END_COLLECTION) depth = Math.max(0, depth - 1);
    if ((prefix & ITEM_TYPE_BITS) === 0) { usage = null; usagePage = null; }
    i += 1 + size;
  }
  return out;
}

// _IOC(_IOC_READ|_IOC_WRITE, 'H', nr, len) in the layout of x86 and ARM, the only
// ones Xenon ships on. Arithmetic, not shifts: the top bits overflow a signed 32-bit.
function featureRequest(nr, len) {
  return IOC_READ_WRITE * 2 ** 30 + len * 2 ** 16 + IOC_TYPE_HID * 2 ** 8 + nr;
}
const setFeatureRequest = (len) => featureRequest(HIDIOCSFEATURE, len);
const getFeatureRequest = (len) => featureRequest(HIDIOCGFEATURE, len);

module.exports = { parseHidId, parseHidName, topCollections, setFeatureRequest, getFeatureRequest };
