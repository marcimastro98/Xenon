'use strict';
// USB HID feature reports on Windows, through the system's own SetupAPI and
// hid.dll (koffi, no extra package). Only what an RGB controller needs: list the
// HID interfaces of a vendor, open one, send and read 64-byte feature reports.
// Every call that touches a device runs on koffi's worker thread (`.async`), so a
// slow or wedged USB device never blocks the event loop.

const { boundedCall: call } = require('./bounded-call');

const HID_GUID = { Data1: 0x4D1E55B2, Data2: 0xF16F, Data3: 0x11CF, Data4: [0x88, 0xCB, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30] };
const DIGCF_PRESENT = 0x02;
const DIGCF_DEVICEINTERFACE = 0x10;
const GENERIC_READ_WRITE = 0xC0000000;
const FILE_SHARE_READ_WRITE = 0x03;   // other RGB software keeps working while we look
const OPEN_EXISTING = 3;
const INVALID_HANDLE = -1;
const HIDP_STATUS_SUCCESS = 0x00110000;
const DETAIL_BUF_BYTES = 1024;
const PRODUCT_NAME_BYTES = 254;   // the USB limit for a string descriptor

let api = null;

function load() {
  if (api) return api;
  const koffi = require('koffi');
  koffi.struct('XGUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8[8]' });
  koffi.struct('XSP_DEVICE_INTERFACE_DATA', { cbSize: 'uint32', InterfaceClassGuid: 'XGUID', Flags: 'uint32', Reserved: 'uintptr' });
  koffi.struct('XHIDD_ATTRIBUTES', { Size: 'uint32', VendorID: 'uint16', ProductID: 'uint16', VersionNumber: 'uint16' });
  koffi.struct('XHIDP_CAPS', {
    Usage: 'uint16', UsagePage: 'uint16', InputReportByteLength: 'uint16', OutputReportByteLength: 'uint16',
    FeatureReportByteLength: 'uint16', Reserved: 'uint16[17]', rest: 'uint16[10]',
  });
  const setupapi = koffi.load('setupapi.dll');
  const hid = koffi.load('hid.dll');
  const kernel32 = koffi.load('kernel32.dll');
  api = {
    koffi,
    getClassDevs: setupapi.func('intptr __stdcall SetupDiGetClassDevsW(XGUID *, void *, void *, uint32)'),
    enumInterfaces: setupapi.func('bool __stdcall SetupDiEnumDeviceInterfaces(intptr, void *, XGUID *, uint32, _Inout_ XSP_DEVICE_INTERFACE_DATA *)'),
    interfaceDetail: setupapi.func('bool __stdcall SetupDiGetDeviceInterfaceDetailW(intptr, XSP_DEVICE_INTERFACE_DATA *, _Inout_ uint8_t *, uint32, void *, void *)'),
    destroyList: setupapi.func('bool __stdcall SetupDiDestroyDeviceInfoList(intptr)'),
    createFile: kernel32.func('intptr __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(intptr)'),
    getAttributes: hid.func('bool __stdcall HidD_GetAttributes(intptr, _Out_ XHIDD_ATTRIBUTES *)'),
    getPreparsed: hid.func('bool __stdcall HidD_GetPreparsedData(intptr, _Out_ void **)'),
    freePreparsed: hid.func('bool __stdcall HidD_FreePreparsedData(void *)'),
    getCaps: hid.func('uint32 __stdcall HidP_GetCaps(void *, _Out_ XHIDP_CAPS *)'),
    getProduct: hid.func('bool __stdcall HidD_GetProductString(intptr, _Inout_ uint8_t *, uint32)'),
    setFeature: hid.func('bool __stdcall HidD_SetFeature(intptr, uint8_t *, uint32)'),
    getFeature: hid.func('bool __stdcall HidD_GetFeature(intptr, _Inout_ uint8_t *, uint32)'),
  };
  return api;
}

async function interfacePaths(a) {
  const list = await call(a.getClassDevs, HID_GUID, null, null, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
  if (list === INVALID_HANDLE) throw new Error('SetupDiGetClassDevs failed');
  const paths = [];
  try {
    for (let i = 0; i < 512; i++) {
      const data = { cbSize: a.koffi.sizeof('XSP_DEVICE_INTERFACE_DATA'), InterfaceClassGuid: HID_GUID, Flags: 0, Reserved: 0 };
      if (!(await call(a.enumInterfaces, list, null, HID_GUID, i, data))) break;
      const detail = Buffer.alloc(DETAIL_BUF_BYTES);
      detail.writeUInt32LE(8, 0);   // cbSize of SP_DEVICE_INTERFACE_DETAIL_DATA_W on 64-bit
      if (!(await call(a.interfaceDetail, list, data, detail, DETAIL_BUF_BYTES, null, null))) continue;
      const end = detail.indexOf(Buffer.from([0, 0]), 4);
      let stop = end < 0 ? DETAIL_BUF_BYTES : end;
      if ((stop - 4) % 2) stop += 1;
      paths.push(detail.toString('utf16le', 4, stop));
    }
  } finally {
    await call(a.destroyList, list).catch(() => {});
  }
  return paths;
}

// The name the device gives itself, '' when it gives none.
async function productName(a, handle) {
  const buf = Buffer.alloc(PRODUCT_NAME_BYTES);
  if (!(await call(a.getProduct, handle, buf, PRODUCT_NAME_BYTES))) return '';
  return buf.toString('utf16le').replace(/\0.*$/s, '').trim();
}

// What one interface is, read without asking for read/write access.
async function describe(a, path) {
  const handle = await call(a.createFile, path, 0, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE) return null;
  try {
    const attrs = {};
    if (!(await call(a.getAttributes, handle, attrs))) return null;
    const out = {
      path, vendorId: attrs.VendorID, productId: attrs.ProductID, usagePage: 0, usage: 0,
      featureLength: 0, inputLength: 0, outputLength: 0, product: await productName(a, handle),
    };
    const pre = [null];
    if (await call(a.getPreparsed, handle, pre)) {
      const caps = {};
      try {
        if ((await call(a.getCaps, pre[0], caps)) === HIDP_STATUS_SUCCESS) {
          out.usagePage = caps.UsagePage;
          out.usage = caps.Usage;
          out.featureLength = caps.FeatureReportByteLength;
          out.inputLength = caps.InputReportByteLength;
          out.outputLength = caps.OutputReportByteLength;
        }
      } finally {
        await call(a.freePreparsed, pre[0]).catch(() => {});
      }
    }
    return out;
  } finally {
    await call(a.closeHandle, handle).catch(() => {});
  }
}

// How a vendor id reads in a device path: USB, Bluetooth, Bluetooth LE.
const pathMarks = (vendorId) => {
  const vid = vendorId.toString(16).padStart(4, '0');
  return ['vid_' + vid, 'vid&0001' + vid, 'vid&0002' + vid, 'vid&02' + vid];
};

// filter: { vendorId | vendorIds, productIds?, usagePage? } → matching interfaces.
async function list(filter) {
  const a = load();
  const vendorIds = filter.vendorIds || [filter.vendorId];
  const marks = vendorIds.flatMap(pathMarks);
  // Paths carry the vendor id: skip opening every other HID device on the PC.
  const paths = (await interfacePaths(a)).filter((p) => {
    const lower = p.toLowerCase();
    return marks.some((mark) => lower.includes(mark));
  });
  const out = [];
  for (const p of paths) {
    const d = await describe(a, p).catch(() => null);
    if (!d || !vendorIds.includes(d.vendorId)) continue;
    if (filter.productIds && !filter.productIds.includes(d.productId)) continue;
    if (filter.usagePage != null && d.usagePage !== filter.usagePage) continue;
    out.push(d);
  }
  return out;
}

// Every interface on the PC, for a reader that goes by what a device declares.
async function listAll() {
  const a = load();
  const found = [];
  for (const p of await interfacePaths(a)) {
    const d = await describe(a, p).catch(() => null);
    if (d) found.push(d);
  }
  return found;
}

async function open(info) {
  const a = load();
  const handle = await call(a.createFile, info.path, GENERIC_READ_WRITE, FILE_SHARE_READ_WRITE, null, OPEN_EXISTING, 0, null);
  if (handle === INVALID_HANDLE) throw new Error('could not open the USB device');
  const len = info.featureLength || 64;
  let closed = false;
  // Windows wants exactly the report length the device declares, report id first.
  const sized = (bytes) => {
    const buf = Buffer.alloc(len);
    Buffer.from(bytes).copy(buf, 0, 0, len);
    return buf;
  };
  return {
    async setFeature(bytes) {
      if (closed) throw new Error('device closed');
      if (!(await call(a.setFeature, handle, sized(bytes), len))) throw new Error('feature report refused');
    },
    async getFeature(reportId) {
      if (closed) throw new Error('device closed');
      const buf = Buffer.alloc(len);
      buf[0] = reportId;
      if (!(await call(a.getFeature, handle, buf, len))) throw new Error('feature report read failed');
      return buf;
    },
    async close() {
      if (closed) return;
      closed = true;
      await call(a.closeHandle, handle).catch(() => {});
    },
  };
}

module.exports = { list, listAll, open };
