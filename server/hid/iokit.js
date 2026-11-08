'use strict';
// The IOKit and CoreFoundation calls hid-darwin.js needs, behind plain functions so that
// file can be tested with a stand-in. Pointers are BigInt in koffi 3. CFRelease is left
// out on purpose for property values: the "Get" calls return objects IOKit still owns.

const COREFOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
const IOKIT = '/System/Library/Frameworks/IOKit.framework/IOKit';
const UTF8 = 0x08000100;
const NUMBER_SINT32 = 3;
const POINTER_BYTES = 8;
const NAME_BYTES = 256;
const OPTIONS_NONE = 0;
const NULL = 0n;
const IO_SUCCESS = 0;
const RUN_LOOP_MODE = 'kCFRunLoopDefaultMode';

function bindFunctions(koffi) {
  const cf = koffi.load(COREFOUNDATION);
  const io = koffi.load(IOKIT);
  const inputCallback = koffi.proto('void XenonHidInput(void *context, int result, void *sender, int type, uint32_t id, void *report, long length)');
  return {
    inputCallback,
    stringCreate: cf.func('void *CFStringCreateWithCString(void *, const char *, uint32_t)'),
    getTypeId: cf.func('unsigned long CFGetTypeID(void *)'),
    numberTypeId: cf.func('unsigned long CFNumberGetTypeID()'),
    stringTypeId: cf.func('unsigned long CFStringGetTypeID()'),
    numberValue: cf.func('bool CFNumberGetValue(void *, long, _Out_ int32_t *)'),
    stringValue: cf.func('bool CFStringGetCString(void *, _Out_ uint8_t *, long, uint32_t)'),
    setCount: cf.func('long CFSetGetCount(void *)'),
    setValues: cf.func('void CFSetGetValues(void *, _Out_ uint8_t *)'),
    arrayCount: cf.func('long CFArrayGetCount(void *)'),
    arrayValue: cf.func('void *CFArrayGetValueAtIndex(void *, long)'),
    dictionaryValue: cf.func('void *CFDictionaryGetValue(void *, void *)'),
    runLoopCurrent: cf.func('void *CFRunLoopGetCurrent()'),
    runLoopRun: cf.func('int CFRunLoopRunInMode(void *, double, bool)'),
    managerCreate: io.func('void *IOHIDManagerCreate(void *, uint32_t)'),
    managerMatch: io.func('void IOHIDManagerSetDeviceMatching(void *, void *)'),
    managerSchedule: io.func('void IOHIDManagerScheduleWithRunLoop(void *, void *, void *)'),
    managerCopy: io.func('void *IOHIDManagerCopyDevices(void *)'),
    deviceProperty: io.func('void *IOHIDDeviceGetProperty(void *, void *)'),
    deviceOpen: io.func('int IOHIDDeviceOpen(void *, uint32_t)'),
    deviceClose: io.func('int IOHIDDeviceClose(void *, uint32_t)'),
    setReport: io.func('int IOHIDDeviceSetReport(void *, int, long, const uint8_t *, long)'),
    getReport: io.func('int IOHIDDeviceGetReport(void *, int, long, _Inout_ uint8_t *, _Inout_ long *)'),
    registerInput: io.func('void IOHIDDeviceRegisterInputReportCallback(void *, void *, long, XenonHidInput *, void *)'),
    deviceSchedule: io.func('void IOHIDDeviceScheduleWithRunLoop(void *, void *, void *)'),
    deviceUnschedule: io.func('void IOHIDDeviceUnscheduleFromRunLoop(void *, void *, void *)'),
  };
}

function createIoKit(koffi, fn) {
  const strings = new Map();
  const cfString = (text) => {
    if (!strings.has(text)) strings.set(text, fn.stringCreate(NULL, text, UTF8));
    return strings.get(text);
  };
  const mode = () => cfString(RUN_LOOP_MODE);
  const loop = fn.runLoopCurrent();

  function numberOf(value) {
    if (!value || fn.getTypeId(value) !== fn.numberTypeId()) return null;
    const out = [0];
    return fn.numberValue(value, NUMBER_SINT32, out) ? out[0] : null;
  }

  function stringOf(value) {
    if (!value || fn.getTypeId(value) !== fn.stringTypeId()) return null;
    const bytes = Buffer.alloc(NAME_BYTES);
    if (!fn.stringValue(value, bytes, NAME_BYTES, UTF8)) return null;
    return bytes.toString('utf8', 0, Math.max(bytes.indexOf(0), 0));
  }

  const property = (device, name) => fn.deviceProperty(device, cfString(name));

  function usagePairs(device) {
    const pairs = property(device, 'DeviceUsagePairs');
    const primary = { usagePage: numberOf(property(device, 'PrimaryUsagePage')) ?? 0, usage: numberOf(property(device, 'PrimaryUsage')) ?? 0 };
    if (!pairs) return [primary];
    const found = [];
    for (let i = 0; i < fn.arrayCount(pairs); i++) {
      const pair = fn.arrayValue(pairs, i);
      const usagePage = numberOf(fn.dictionaryValue(pair, cfString('DeviceUsagePage')));
      const usage = numberOf(fn.dictionaryValue(pair, cfString('DeviceUsage')));
      if (usagePage != null && usage != null) found.push({ usagePage, usage });
    }
    return found.length ? found : [primary];
  }

  function copyDevices(manager) {
    const set = fn.managerCopy(manager);
    if (!set) return [];
    const count = fn.setCount(set);
    const values = Buffer.alloc(count * POINTER_BYTES);
    fn.setValues(set, values);
    return Array.from({ length: count }, (_, i) => values.readBigUInt64LE(i * POINTER_BYTES));
  }

  // The buffer belongs to IOKit until the listener stops, so it comes from koffi, not Node.
  function listen(device, bytes, onReport) {
    const buffer = koffi.alloc('uint8_t', bytes);
    const callback = koffi.register((context, result, sender, type, id, report, length) => {
      if (result === IO_SUCCESS && length > 0) onReport(Buffer.from(koffi.decode(report, 'uint8_t', length)));
    }, koffi.pointer(fn.inputCallback));
    fn.registerInput(device, buffer, bytes, callback, NULL);
    fn.deviceSchedule(device, loop, mode());
    return {
      stop() {
        fn.deviceUnschedule(device, loop, mode());
        fn.registerInput(device, buffer, bytes, null, NULL);
        koffi.unregister(callback);
        koffi.free(buffer);
      },
    };
  }

  return {
    managerCreate: () => fn.managerCreate(NULL, OPTIONS_NONE),
    setMatchingAll: (manager) => fn.managerMatch(manager, NULL),
    scheduleManager: (manager) => fn.managerSchedule(manager, loop, mode()),
    runLoop: (seconds) => fn.runLoopRun(mode(), seconds, true),
    copyDevices,
    numberProperty: (device, name) => numberOf(property(device, name)),
    stringProperty: (device, name) => stringOf(property(device, name)),
    usagePairs,
    deviceOpen: (device) => fn.deviceOpen(device, OPTIONS_NONE),
    deviceClose: (device) => fn.deviceClose(device, OPTIONS_NONE),
    setReport: (device, type, id, data) => fn.setReport(device, type, id, data, data.length),
    getReport(device, type, id, target) {
      return fn.getReport(device, type, id, target, [target.length]);
    },
    listen,
  };
}

function loadIoKit() {
  const koffi = require('koffi');
  return createIoKit(koffi, bindFunctions(koffi));
}

module.exports = { loadIoKit, createIoKit };
